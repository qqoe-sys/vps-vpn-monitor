'use strict';
// Цикл опроса одного сервера. SSH приходит снаружи (параметр connect),
// поэтому тесты подставляют подделку, а Android сможет подставить свой транспорт.

const i18n = require('../i18n');
const { buildScript } = require('./remote-script');
const { parseSnapshot, computeRates, computeKeyRates } = require('./parser');
const { computeHealth } = require('./health');
const { TrafficStore } = require('./traffic-store');
const { computeLimit } = require('./limits');

const HISTORY_POINTS = 360;
const FAILS_BEFORE_OFFLINE = 2; // один сбой подряд ещё не считаем падением

class ServerMonitor {
  constructor(server, { connect, store, onUpdate, pollMs, slowEvery }) {
    Object.assign(this, { server, connect, store, onUpdate, pollMs, slowEvery });
    this.transport = null;
    this.timer = null;
    this.stopped = false;
    this.round = 0;
    this.fails = 0;
    this.prev = null;
    this.prevAt = 0;
    this.state = { connection: 'connecting', error: null, snapshot: null, rates: {}, link: null, history: [], lastOk: null };
  }

  start() {
    this.loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.dropTransport();
  }

  dropTransport() {
    try { this.transport?.close(); } catch { /* соединение уже закрыто */ }
    this.transport = null;
  }

  async loop() {
    await this.pollNow();
    if (!this.stopped) this.timer = setTimeout(() => this.loop(), this.pollMs);
  }

  // Опросы идут строго по очереди. Если два ответа придут в обратном порядке,
  // счётчик "уменьшится" и будет ошибочно принят за сброс.
  pollNow() {
    this.queue = (this.queue ?? Promise.resolve()).then(() => this.pollOnce());
    return this.queue;
  }

  async pollOnce(now = Date.now()) {
    try {
      this.transport ??= await this.connect(this.server);
      const slow = this.round % this.slowEvery === 0;
      this.round += 1;
      const output = await this.transport.exec(buildScript(this.server, { slow }), 20000);
      this.accept(parseSnapshot(output), now);
    } catch (err) {
      this.dropTransport();
      this.fails += 1;
      this.state.error = err.message;
      // Сбрасываем базу для скорости: после простоя разница двух замеров неточна.
      this.prev = null;
      if (this.fails >= FAILS_BEFORE_OFFLINE) this.state.connection = 'offline';
    }
    if (!this.stopped) this.onUpdate(this.publicState());
  }

  // Историю берём с сервера, если там стоит сборщик, иначе из файла приложения.
  trafficSummary(days, now = new Date()) {
    if (!this.remoteTraffic) return { collector: false, ...this.store.summary(this.server.id, days, now) };
    const remote = new TrafficStore({ servers: { [this.server.id]: this.remoteTraffic } });
    return { collector: true, ...remote.summary(this.server.id, days, now) };
  }

  // Перед рестартом просим сборщик снять показания и сразу их забираем.
  async flushCounters() {
    if (this.remoteTraffic && this.transport) {
      try {
        await this.transport.exec('systemctl start vpsmon-collector.service', 15000);
      } catch { /* не помешает рестарту: потеряется максимум интервал таймера */ }
    }
    this.round = 0; // следующий опрос будет полным, вместе с историей
    await this.pollNow();
  }

  accept(snapshot, now) {
    if (snapshot.trafficStore !== undefined) this.remoteTraffic = snapshot.trafficStore;
    delete snapshot.trafficStore; // большой объект, в интерфейс его не отправляем
    const rates = computeRates(this.prev, snapshot, (now - this.prevAt) / 1000);
    this.state.keyRates = computeKeyRates(this.prev?.stats, snapshot.stats, (now - this.prevAt) / 1000);
    this.prev = snapshot;
    this.prevAt = now;
    this.fails = 0;
    Object.assign(this.state, { connection: 'online', error: null, snapshot, rates, lastOk: now });
    if (snapshot.link !== undefined) this.state.link = snapshot.link;
    if (snapshot.passwordAuth !== undefined) this.state.passwordAuth = snapshot.passwordAuth;
    this.state.history.push({ t: now, cpu: rates.cpu, rx: rates.rxBps, tx: rates.txBps });
    if (this.state.history.length > HISTORY_POINTS) this.state.history.shift();
    // Со сборщиком приложение ничего не считает: иначе учёт раздвоился бы.
    if (!this.remoteTraffic) this.store.update(this.server.id, snapshot, new Date(now));
  }

  publicState() {
    const { id, name, role, host, exitHost } = this.server;
    const health = computeHealth(this.server, this.state);
    const limit = this.limitInfo();
    if (limit && limit.level !== 'ok' && this.state.connection === 'online') {
      const pct = limit.level === 'warn95' ? 95 : 80;
      health.problems.push({ key: `limit${pct}`, text: i18n.t('health.limit', { pct: limit.percent.toFixed(0) }) });
      if (health.level === 'ok') health.level = 'warn';
    }
    return {
      id,
      name,
      role,
      host,
      exitHost,
      hasKeyStats: Boolean(this.server.statsPort),
      managed: Boolean(this.server.managed),
      noAccess: Boolean(this.server.noAccess),
      replacedBy: this.server.replacedBy ?? null, // вход заменён другим (мастер замены входа)
      modes: this.server.modes ?? [],
      limit,
      ...this.state,
      health,
    };
  }

  limitInfo() {
    if (!this.server.limit) return null;
    return computeLimit(this.remoteTraffic ?? this.store.data.servers[this.server.id], this.server.limit);
  }
}

module.exports = { ServerMonitor, FAILS_BEFORE_OFFLINE };
