'use strict';
// Превращает текстовый вывод remote-script.js в обычный объект с числами.
// Здесь нет ни SSH, ни Electron, поэтому модуль легко тестировать.

function parseSections(text) {
  const sections = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      current = line.slice(2).trim();
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  return sections;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstLine(lines) {
  return (lines || []).find((l) => l.trim() !== '')?.trim() ?? '';
}

function parseMeminfo(lines = []) {
  const values = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) values[m[1]] = Number(m[2]) * 1024; // в /proc/meminfo значения в КиБ
  }
  return { total: values.MemTotal ?? null, available: values.MemAvailable ?? null };
}

function parseDf(lines = []) {
  const row = lines.filter((l) => l.trim())[1];
  if (!row) return null;
  const p = row.trim().split(/\s+/);
  return { total: num(p[1]), used: num(p[2]), available: num(p[3]) };
}

function parseCpu(lines = []) {
  // Строка: "cpu user nice system idle iowait irq softirq steal ..."
  const f = firstLine(lines).split(/\s+/).slice(1, 9).map(Number);
  if (f.length < 5 || f.some(Number.isNaN)) return null;
  return { idle: f[3] + f[4], total: f.reduce((a, b) => a + b, 0) };
}

function parseNetdev(lines = []) {
  const ifaces = {};
  for (const line of lines) {
    const m = line.match(/^\s*([^:\s]+):\s*(.*)$/);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    ifaces[m[1]] = { rx: f[0], tx: f[8] };
  }
  return ifaces;
}

function pickIface(routeLines, ifaces) {
  const m = (routeLines || []).join(' ').match(/\bdev\s+(\S+)/);
  if (m && ifaces[m[1]]) return m[1];
  // Запасной вариант: интерфейс с наибольшим трафиком, кроме loopback.
  return Object.keys(ifaces).filter((n) => n !== 'lo')
    .sort((a, b) => ifaces[b].rx - ifaces[a].rx)[0] ?? null;
}

function parsePorts(lines = []) {
  const ports = new Set();
  for (const line of lines) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (Number.isInteger(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function parseShowProps(lines = []) {
  const props = {};
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return props;
}

// Возвращает null, если API не ответил. Важно отличать это от "трафика нет".
function parseStats(lines) {
  if (!lines) return null;
  let payload;
  try {
    payload = JSON.parse(lines.join('\n'));
  } catch {
    return null;
  }
  if (!Array.isArray(payload.stat)) return null;
  const users = {};
  for (const entry of payload.stat) {
    const p = String(entry.name).split('>>>');
    if (p.length !== 4 || p[0] !== 'user' || p[2] !== 'traffic') continue;
    const u = (users[p[1]] ??= { up: 0, down: 0 });
    // Xray не присылает поле value, когда счётчик равен нулю.
    const value = Number(entry.value ?? 0);
    if (p[3] === 'uplink') u.up = value;
    if (p[3] === 'downlink') u.down = value;
  }
  return users;
}

function parseLink(lines) {
  if (!lines) return undefined; // в этом опросе проверка связки не выполнялась
  const [state, ms] = firstLine(lines).split(/\s+/);
  return { ok: state === 'ok', ms: state === 'ok' ? num(ms) : null };
}

// undefined — в этом опросе не запрашивали, null — сборщика на сервере нет.
function parseTrafficStore(lines) {
  if (!lines) return undefined;
  try {
    const data = JSON.parse(lines.join('\n'));
    return data && data.counters && data.days ? data : null;
  } catch {
    return null;
  }
}

// Для входа под root по паролю должны быть разрешены оба параметра.
function parseSshAuth(lines) {
  if (!lines) return undefined;
  const text = lines.join('\n').toLowerCase();
  return /^passwordauthentication yes/m.test(text) && /^permitrootlogin yes/m.test(text);
}

function parseSnapshot(text) {
  const s = parseSections(text);
  if (!s.hostname) throw new Error('Сервер вернул неполный ответ');

  const ifaces = parseNetdev(s.netdev);
  const iface = pickIface(s.route, ifaces);
  const show = parseShowProps(s.xray_show);
  const services = {};
  for (const [key, lines] of Object.entries(s)) {
    if (key.startsWith('service:')) services[key.slice(8)] = firstLine(lines);
  }

  return {
    hostname: firstLine(s.hostname),
    uptimeSec: num(firstLine(s.uptime).split(/\s+/)[0]),
    load: firstLine(s.loadavg).split(/\s+/).slice(0, 3).map(Number),
    cores: num(firstLine(s.nproc)),
    mem: parseMeminfo(s.meminfo),
    disk: parseDf(s.df),
    cpu: parseCpu(s.stat),
    iface,
    net: iface ? ifaces[iface] : null,
    connections: num(firstLine(s.conns)),
    listening: parsePorts(s.ports),
    services,
    xray: {
      version: (firstLine(s.xray_version).match(/^Xray\s+(\S+)/) || [])[1] ?? null,
      since: show.ActiveEnterTimestamp || null,
      restarts: num(show.NRestarts),
    },
    stats: parseStats(s.stats),
    link: parseLink(s.link),
    trafficStore: parseTrafficStore(s.traffic_store),
    passwordAuth: parseSshAuth(s.ssh_auth),
  };
}

// CPU и скорость считаются как разница двух соседних замеров.
function computeRates(prev, cur, dtSec) {
  if (!prev || dtSec <= 0) return { cpu: null, rxBps: null, txBps: null };
  let cpu = null;
  if (prev.cpu && cur.cpu && cur.cpu.total > prev.cpu.total) {
    const total = cur.cpu.total - prev.cpu.total;
    cpu = Math.min(100, Math.max(0, 100 * (1 - (cur.cpu.idle - prev.cpu.idle) / total)));
  }
  // Если счётчик уменьшился, сервер перезагружался: скорость за этот интервал неизвестна.
  const rate = (a, b) => (a === undefined || b === undefined || b < a ? null : (b - a) / dtSec);
  return { cpu, rxBps: rate(prev.net?.rx, cur.net?.rx), txBps: rate(prev.net?.tx, cur.net?.tx) };
}

// Скорость каждого ключа: разница счётчиков Xray между двумя опросами.
// Ключ без прошлого значения или со сброшенным счётчиком пропускаем, чтобы не было ложных всплесков.
function computeKeyRates(prev, cur, dtSec) {
  const out = {};
  if (!prev || !cur || dtSec <= 0) return out;
  for (const [email, c] of Object.entries(cur)) {
    const last = prev[email];
    if (!last || c.up < last.up || c.down < last.down) continue;
    const key = email.replace(/-(xhttp|vision)$/, ''); // два входа одного ключа
    const rate = (out[key] ??= { upBps: 0, downBps: 0 });
    rate.upBps += (c.up - last.up) / dtSec;
    rate.downBps += (c.down - last.down) / dtSec;
  }
  return out;
}

module.exports = { parseSections, parseSnapshot, computeRates, computeKeyRates };
