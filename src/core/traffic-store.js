'use strict';
// Накопительный учёт трафика по дням.
// Счётчики Xray и интерфейса обнуляются при рестарте, поэтому храним не сами
// значения, а прирост между замерами: так итог переживает любые перезапуски.

const fs = require('node:fs');
const path = require('node:path');
const { parseSafe } = require('./safe-json');

const SERVER_KEY = '__server__'; // запись для общего трафика сетевого интерфейса
const KEEP_DAYS = 400;

function dateKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function shiftDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

const MAX_CHART_DAYS = 30;
const stripSuffix = (name) => name.replace(/-(xhttp|vision)$/, '');

class TrafficStore {
  constructor(data = {}) {
    this.data = { servers: data.servers ?? {} };
    for (const rec of Object.values(this.data.servers)) this.migrate(rec);
  }

  // Файлы старой версии не хранили объём до начала учёта. Его можно вычислить:
  // текущий счётчик минус всё, что уже учтено по дням.
  migrate(rec) {
    if (rec.baseline) return;
    rec.baseline = {};
    const days = Object.keys(rec.days).sort();
    rec.since = days[0] ?? null;
    for (const [name, c] of Object.entries(rec.counters)) {
      let up = 0;
      let down = 0;
      for (const d of days) {
        up += rec.days[d][name]?.up ?? 0;
        down += rec.days[d][name]?.down ?? 0;
      }
      rec.baseline[name] = { up: Math.max(0, c.up - up), down: Math.max(0, c.down - down) };
    }
  }

  server(id) {
    return (this.data.servers[id] ??= { counters: {}, days: {}, baseline: {}, since: null });
  }

  addSample(rec, day, name, up, down, isFirstPoll) {
    let last = rec.counters[name];
    rec.counters[name] = { up, down };
    if (!last && isFirstPoll) {
      // Первый замер: всё, что уже есть в счётчике, накоплено до начала учёта.
      rec.baseline[name] = { up, down };
      return;
    }
    // Счётчик появился позже первого опроса (новый ключ): его трафик уже сегодняшний.
    last ??= { up: 0, down: 0 };
    // Меньше прошлого значения = счётчик обнулился, весь текущий объём новый.
    const dUp = up >= last.up ? up - last.up : up;
    const dDown = down >= last.down ? down - last.down : down;
    if (dUp === 0 && dDown === 0) return;
    const bucket = ((rec.days[day] ??= {})[name] ??= { up: 0, down: 0 });
    bucket.up += dUp;
    bucket.down += dDown;
  }

  update(serverId, snapshot, now = new Date()) {
    const rec = this.server(serverId);
    const day = dateKey(now);
    rec.since ??= day;
    if (snapshot.net) this.addSample(rec, day, SERVER_KEY, snapshot.net.tx, snapshot.net.rx, !rec.counters[SERVER_KEY]);
    if (snapshot.stats) {
      const firstKeyPoll = !Object.keys(rec.counters).some((n) => n !== SERVER_KEY);
      for (const [name, c] of Object.entries(snapshot.stats)) {
        this.addSample(rec, day, name, c.up, c.down, firstKeyPoll);
      }
    }
    const oldest = dateKey(shiftDays(now, -KEEP_DAYS));
    for (const d of Object.keys(rec.days)) if (d < oldest) delete rec.days[d];
  }

  // days = 0 означает "за всё время".
  summary(serverId, days, now = new Date()) {
    const rec = this.server(serverId);
    const from = days > 0 ? dateKey(shiftDays(now, -(days - 1))) : '';
    const users = {};
    // user1-xhttp и user1-vision это один ключ на двух входах.
    const userFor = (name) => (users[stripSuffix(name)] ??= { name: stripSuffix(name), up: 0, down: 0, before: 0, days: {} });
    const total = { up: 0, down: 0 };
    const daily = {};
    for (const day of Object.keys(rec.days).sort()) {
      if (day < from) continue;
      for (const [name, v] of Object.entries(rec.days[day])) {
        if (name === SERVER_KEY) {
          total.up += v.up;
          total.down += v.down;
          daily[day] = { up: v.up, down: v.down };
        } else {
          const u = userFor(name);
          u.up += v.up;
          u.down += v.down;
          const d = (u.days[day] ??= { up: 0, down: 0 });
          d.up += v.up;
          d.down += v.down;
        }
      }
    }

    // Объём до начала учёта датам не привязан, поэтому входит только в "всё время".
    const before = { up: 0, down: 0 };
    for (const [name, b] of Object.entries(rec.baseline)) {
      const target = name === SERVER_KEY ? before : userFor(name);
      if (name === SERVER_KEY) {
        target.up += b.up;
        target.down += b.down;
      } else {
        target.before += b.up + b.down;
        if (days === 0) {
          target.up += b.up;
          target.down += b.down;
        }
      }
    }
    if (days === 0) {
      total.up += before.up;
      total.down += before.down;
    }

    return {
      total,
      before,
      since: rec.since,
      range: dayRange(days, now, rec.since),
      daily,
      users: Object.values(users)
        .filter((u) => u.up + u.down + u.before > 0)
        .sort((a, b) => b.up + b.down - (a.up + a.down)),
    };
  }
}

// Какие дни показать на графике, от старого к новому.
function dayRange(days, now, since) {
  const out = [];
  for (let i = Math.min(days > 0 ? days : MAX_CHART_DAYS, MAX_CHART_DAYS) - 1; i >= 0; i -= 1) {
    const key = dateKey(shiftDays(now, -i));
    if (days > 0 || (since && key >= since)) out.push(key);
  }
  return out;
}

function loadStore(file) {
  try {
    return new TrafficStore(parseSafe(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Битый файл не затираем, а откладываем в сторону.
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* файла уже нет */ }
    }
    return new TrafficStore();
  }
}

function saveStore(store, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Пишем во временный файл и подменяем: сбой посреди записи не испортит историю.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store.data));
  fs.renameSync(tmp, file);
}

module.exports = { TrafficStore, loadStore, saveStore, dateKey };
