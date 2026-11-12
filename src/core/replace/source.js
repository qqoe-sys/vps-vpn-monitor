'use strict';
// Выбор источника списка клиентов для нового входа: живой старый вход, иначе снимок из кэша.

const DAY_MS = 24 * 3600 * 1000;

// live — инвентарь со старого входа по SSH или null; cache — { inventory, savedAt } или null,
// savedAt — миллисекунды (так пишет кэш) или строка ISO.
// stale: снимок старше maxAgeDays — мастер обязан показать дату и спросить подтверждение.
function pickClients({ live, cache, now = Date.now(), maxAgeDays = 7 }) {
  if (live) return { inventory: live, from: 'live', stale: false };
  if (cache && cache.inventory) {
    // saveInventoryCache пишет savedAt числом (мс), но принимаем и строку ISO.
    const at = typeof cache.savedAt === 'number' ? cache.savedAt : Date.parse(cache.savedAt);
    const age = now - at;
    // Нечитаемая дата считается устаревшей — осторожнее молча не использовать.
    const stale = !Number.isFinite(age) || age > maxAgeDays * DAY_MS;
    return { inventory: cache.inventory, from: 'cache', savedAt: cache.savedAt, stale };
  }
  throw new Error('Нет ни связи со старым входом, ни сохранённой копии клиентов');
}

module.exports = { pickClients };
