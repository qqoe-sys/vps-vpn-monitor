'use strict';
// Сколько трафика осталось до лимита тарифа в текущем расчётном периоде.

const { dateKey } = require('./traffic-store');

const BYTES_PER_TB = 1e12; // хостеры считают терабайт десятичным

// День сброса может не существовать в коротком месяце: берём последний день.
function resetDate(year, month, resetDay) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(resetDay, lastDay));
}

function periodStart(now, resetDay) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisMonth = resetDate(now.getFullYear(), now.getMonth(), resetDay);
  return thisMonth <= today ? thisMonth : resetDate(now.getFullYear(), now.getMonth() - 1, resetDay);
}

function bytesFor(limit, { up, down }) {
  return limit.mode === 'down' ? down : limit.mode === 'up' ? up : up + down;
}

function computeLimit(rec, limit, now = new Date()) {
  const start = dateKey(periodStart(now, limit.resetDay));
  let usedBytes = 0;
  for (const [day, entries] of Object.entries(rec?.days ?? {})) {
    if (day >= start && entries.__server__) usedBytes += bytesFor(limit, entries.__server__);
  }
  // Объём "до учёта" не имеет дат. Относим его к периоду, в котором учёт начался:
  // это оценка с запасом, лучше показать меньше остатка, чем неожиданно упереться в лимит.
  const includesBaseline = Boolean(rec?.since >= start && rec?.baseline?.__server__);
  if (includesBaseline) usedBytes += bytesFor(limit, rec.baseline.__server__);
  // Поправка по панели хостера действует только в своём расчётном периоде.
  if (limit.adjustPeriod === start) usedBytes = Math.max(0, usedBytes + limit.adjustBytes);
  const totalBytes = limit.tb * BYTES_PER_TB;
  const percent = (100 * usedBytes) / totalBytes;
  return {
    usedBytes,
    totalBytes,
    remainingBytes: Math.max(0, totalBytes - usedBytes),
    percent,
    level: percent >= 95 ? 'warn95' : percent >= 80 ? 'warn80' : 'ok',
    periodStart: start,
    includesBaseline,
    config: { tb: limit.tb, resetDay: limit.resetDay, mode: limit.mode },
  };
}

// Подгоняет учёт под цифру из панели хостера: запоминается разница, а не сама цифра.
function withPanelUsage(limit, rec, usedTb, now = new Date()) {
  const clean = { tb: limit.tb, resetDay: limit.resetDay, mode: limit.mode };
  const base = computeLimit(rec, clean, now);
  return { ...clean, adjustBytes: Math.round(usedTb * BYTES_PER_TB) - base.usedBytes, adjustPeriod: base.periodStart };
}

module.exports = { computeLimit, withPanelUsage };
