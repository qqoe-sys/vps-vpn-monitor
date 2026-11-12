'use strict';
// Список серверов хранится в данных приложения, чтобы его можно было менять из программы.
// При первом запуске он создаётся из config/servers.json.

const fs = require('node:fs');
const path = require('node:path');
const { isIpv4 } = require('./provision/validate');

function saveServers(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
}

function loadServers(file, seedFile) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  saveServers(file, seed);
  return seed;
}

function addServers(config, servers) {
  for (const s of servers) {
    if (config.servers.some((x) => x.id === s.id || x.host === s.host)) {
      throw new Error(`Сервер ${s.host} уже есть в программе`);
    }
  }
  return { ...config, servers: [...config.servers, ...servers] };
}

function removeServer(config, id) {
  return { ...config, servers: config.servers.filter((s) => s.id !== id) };
}

// Замена входа: новый вход добавляется, старый остаётся в списке с пометкой replacedBy.
// Отказ, если старого нет, это не вход (выход) или он уже заменён — мастер не стартует.
function markReplaced(config, oldId, newRecord) {
  const old = config.servers.find((s) => s.id === oldId);
  if (!old) throw new Error('Неизвестный сервер');
  if (!old.exitHost) throw new Error(`${old.name} не вход каскада: заменить можно только вход`);
  if (old.replacedBy) throw new Error(`${old.name} уже заменён`);
  const added = addServers(config, [newRecord]); // отказывает, если такой сервер уже есть
  return { ...added, servers: added.servers.map((s) => (s.id === oldId ? { ...s, replacedBy: newRecord.id } : s)) };
}

// Запись без пометки replacedBy (сам ключ убираем, а не ставим undefined: так чище в servers.json).
function withoutReplacedBy(server) {
  const { replacedBy, ...rest } = server;
  void replacedBy;
  return rest;
}

// Новый вход removedId убран из программы: со старого входа снимаем пометку «заменён»,
// иначе он навсегда остался бы заменённым на несуществующий сервер.
function clearReplacedBy(config, removedId) {
  return { ...config, servers: config.servers.map((s) => (s.replacedBy === removedId ? withoutReplacedBy(s) : s)) };
}

// «Отменить замену»: старый вход снова обычный вход, новый остаётся в списке как обычный вход.
// Возвращает новый конфиг и id нового входа (по нему main решает, переключать ли подписки обратно).
function undoReplace(config, oldId) {
  const old = config.servers.find((s) => s.id === oldId);
  if (!old) throw new Error('Неизвестный сервер');
  if (!old.replacedBy) throw new Error(`${old.name} не заменён: отменять нечего`);
  return {
    config: { ...config, servers: config.servers.map((s) => (s.id === oldId ? withoutReplacedBy(s) : s)) },
    newId: old.replacedBy,
  };
}

// Можно ли закрыть заменённому входу доступ на выходе. Пока подписки ведут на старый вход
// или их новый вход ещё не опубликован, у людей в Happ старый адрес — закрытие оставит их без VPN.
// subsInUse=false: сайт подписок не настроен (нет домена) — людям ссылки не раздаются,
// поэтому подписки закрытию доступа не мешают.
function canCloseExitAccess({ server, subsEntry, subsPending, subsInUse = true }) {
  if (!server?.replacedBy) return { ok: false, reason: 'Закрыть доступ можно только для заменённого входа' };
  if (!subsInUse) return { ok: true };
  if (subsEntry === server.id) {
    return { ok: false, reason: `Подписки всё ещё ведут на ${server.name}. Сначала переключи их на новый вход во вкладке «Подписки».` };
  }
  if (subsPending) {
    return { ok: false, reason: 'В подписках есть неопубликованные изменения: сначала опубликуй сайт, чтобы люди получили новый вход.' };
  }
  return { ok: true };
}

// Действующий вход для выхода: заменённые входы не считаются.
function activeEntryForExit(config, exitHost) {
  return config.servers.find((s) => s.exitHost === exitHost && !s.replacedBy);
}

// Команда для выхода, которая закрывает доступ старому входу. Адрес и порт попадают в shell,
// поэтому проверяются строго.
function exitAccessDeleteCommand(host, port) {
  if (!isIpv4(host)) throw new Error('Адрес старого входа должен быть IPv4');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный порт звена');
  return `ufw delete allow from ${host} to any port ${port} proto tcp`;
}

module.exports = {
  loadServers, saveServers, addServers, removeServer, markReplaced, activeEntryForExit, exitAccessDeleteCommand,
  clearReplacedBy, undoReplace, canCloseExitAccess,
};
