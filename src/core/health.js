'use strict';
// Решает, всё ли в порядке с сервером. level: ok | warn | down.

const LIMIT_PERCENT = 90;

function computeHealth(server, state) {
  if (state.connection === 'connecting') return { level: 'connecting', problems: [] };
  if (state.connection === 'offline') {
    return { level: 'down', problems: [{ key: 'offline', text: `Нет связи: ${state.error ?? 'неизвестная ошибка'}` }] };
  }

  const snap = state.snapshot;
  const down = [];
  const warn = [];
  for (const name of server.services) {
    if (snap.services[name] !== 'active') {
      (name === 'xray' ? down : warn).push({ key: `service:${name}`, text: `Служба ${name}: ${snap.services[name] || 'нет ответа'}` });
    }
  }
  for (const port of server.ports) {
    if (!snap.listening.includes(port)) down.push({ key: `port:${port}`, text: `Порт ${port} не слушается` });
  }
  if (server.exitHost && state.link && !state.link.ok) {
    down.push({ key: 'link', text: `Нет связи с выходом ${server.exitHost}` });
  }
  if (server.statsPort && snap.stats === null) warn.push({ key: 'stats', text: 'API статистики Xray не отвечает' });

  if (snap.disk && snap.disk.used + snap.disk.available > 0) {
    const pct = (100 * snap.disk.used) / (snap.disk.used + snap.disk.available);
    if (pct >= LIMIT_PERCENT) warn.push({ key: 'disk', text: `Диск заполнен на ${pct.toFixed(0)}%` });
  }
  if (snap.mem.total && snap.mem.available !== null) {
    const pct = 100 * (1 - snap.mem.available / snap.mem.total);
    if (pct >= LIMIT_PERCENT) warn.push({ key: 'mem', text: `Память занята на ${pct.toFixed(0)}%` });
  }

  const problems = [...down, ...warn];
  return { level: down.length ? 'down' : warn.length ? 'warn' : 'ok', problems };
}

module.exports = { computeHealth };
