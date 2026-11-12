'use strict';
const i18n = require('../i18n');
// Решает, всё ли в порядке с сервером. level: ok | warn | down.

const LIMIT_PERCENT = 90;

function computeHealth(server, state) {
  if (state.connection === 'connecting') return { level: 'connecting', problems: [] };
  if (state.connection === 'offline') {
    return { level: 'down', problems: [{ key: 'offline', text: i18n.t('health.offline', { err: state.error ?? i18n.t('health.unknownErr') }) }] };
  }

  const snap = state.snapshot;
  const down = [];
  const warn = [];
  for (const name of server.services) {
    if (snap.services[name] !== 'active') {
      (name === 'xray' ? down : warn).push({ key: `service:${name}`, text: i18n.t('health.service', { name, state: snap.services[name] || i18n.t('health.noAnswer') }) });
    }
  }
  for (const port of server.ports) {
    if (!snap.listening.includes(port)) down.push({ key: `port:${port}`, text: i18n.t('health.port', { port }) });
  }
  if (server.exitHost && state.link && !state.link.ok) {
    down.push({ key: 'link', text: i18n.t('health.link', { host: server.exitHost }) });
  }
  if (server.statsPort && snap.stats === null) warn.push({ key: 'stats', text: i18n.t('health.stats') });

  if (snap.disk && snap.disk.used + snap.disk.available > 0) {
    const pct = (100 * snap.disk.used) / (snap.disk.used + snap.disk.available);
    if (pct >= LIMIT_PERCENT) warn.push({ key: 'disk', text: i18n.t('health.disk', { pct: pct.toFixed(0) }) });
  }
  if (snap.mem.total && snap.mem.available !== null) {
    const pct = 100 * (1 - snap.mem.available / snap.mem.total);
    if (pct >= LIMIT_PERCENT) warn.push({ key: 'mem', text: i18n.t('health.mem', { pct: pct.toFixed(0) }) });
  }

  const problems = [...down, ...warn];
  return { level: down.length ? 'down' : warn.length ? 'warn' : 'ok', problems };
}

module.exports = { computeHealth };
