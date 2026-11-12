'use strict';
// Хранилище подписок: люди, их личные коды ссылок, настройки сайта.
// Лежит в %APPDATA%\vps-monitor\subscriptions.json только на ПК владельца.
// Коды ссылок — секреты: их нельзя писать в логи и сообщения об ошибках.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 32 случайных байта в base64url = ровно 43 символа. Подобрать такой код перебором нереально.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const SERVER_ID_RE = /^[a-z0-9_-]{1,32}$/i;

const HAPP_URL = 'https://happ.su/';
const OS_LIST = ['android', 'ios', 'windows', 'linux'];
// Нельзя: SSH, порт для сертификата, Xray, админка Caddy. Тот же список — в deploy.py.
const RESERVED_PORTS = [22, 80, 443, 2019];

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535 && !RESERVED_PORTS.includes(port);
}

function defaultSubs() {
  return {
    // Вход и выход не заданы: их подставит resolveCascade по списку серверов пользователя.
    site: { domain: null, host: null, port: 8443, title: 'Доступ', updateHours: 12 },
    cascade: { entry: null, exit: null },
    apps: {
      android: {
        name: 'Happ', url: HAPP_URL,
        steps: ['Скачай Happ для Android с сайта по кнопке и установи APK.', 'Нажми «Добавить в Happ» выше или скопируй ссылку и вставь её в Happ (кнопка «+»).', 'Включи подключение большой кнопкой.'],
      },
      ios: {
        name: 'Happ', url: HAPP_URL,
        steps: ['Установи Happ из App Store (ссылка на сайте Happ).', 'Нажми «Добавить в Happ» выше или отсканируй QR-код камерой Happ.', 'Разреши добавить VPN-профиль и включи подключение.'],
      },
      windows: {
        name: 'Happ', url: HAPP_URL,
        steps: ['Скачай Happ для Windows с сайта и установи.', 'Скопируй ссылку выше и вставь её в Happ (кнопка «+» → из буфера обмена).', 'Включи подключение.'],
      },
      linux: {
        name: 'Happ', url: HAPP_URL,
        steps: ['Скачай Happ для Linux с сайта (пакет под свой дистрибутив) и установи.', 'Скопируй ссылку выше и вставь её в Happ.', 'Включи подключение.'],
      },
    },
    people: [],
    pending: false, // есть изменения, которые ещё не опубликованы на сервере
  };
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Ссылка «Скачать» попадает в href на странице: разрешаем только https://,
// иначе адрес вида javascript:... выполнил бы код у посетителя.
function validateApps(apps) {
  for (const os of OS_LIST) {
    const app = apps?.[os];
    if (!app) throw new Error(`Нет инструкции для ${os}`);
    if (typeof app.name !== 'string' || !app.name.trim() || app.name.length > 40) throw new Error(`Название приложения для ${os}: от 1 до 40 символов`);
    if (typeof app.url !== 'string' || !/^https:\/\/[^\s"'<>]+$/.test(app.url) || app.url.length > 300) {
      throw new Error(`Ссылка на приложение для ${os} должна начинаться с https://`);
    }
    if (!Array.isArray(app.steps) || app.steps.length > 10
      || !app.steps.every((s) => typeof s === 'string' && s.length <= 300)) {
      throw new Error(`Шаги для ${os}: до 10 строк по 300 символов`);
    }
  }
}

function validateSubs(subs) {
  const { site, cascade, people } = subs;
  if (!site || !cascade || !Array.isArray(people)) throw new Error('Файл подписок повреждён');
  if (subs.pending !== undefined && typeof subs.pending !== 'boolean') throw new Error('Файл подписок повреждён');
  if (!validPort(site.port)) {
    throw new Error(`Порт сайта: число от 1 до 65535, кроме ${RESERVED_PORTS.join(', ')}`);
  }
  if (site.domain !== null && !(typeof site.domain === 'string' && DOMAIN_RE.test(site.domain))) {
    throw new Error('Некорректный домен');
  }
  if (!Number.isInteger(site.updateHours) || site.updateHours < 1 || site.updateHours > 168) {
    throw new Error('Интервал обновления: от 1 до 168 часов');
  }
  if (typeof site.title !== 'string' || !site.title.trim() || site.title.length > 40) {
    throw new Error('Название: от 1 до 40 символов');
  }
  // null — каскад ещё не выбран (новая установка без серверов). Иначе это id сервера из программы.
  for (const id of [site.host, cascade.entry, cascade.exit]) {
    if (id !== null && !SERVER_ID_RE.test(String(id))) throw new Error('Некорректный id сервера в настройках подписок');
  }
  validateApps(subs.apps);
  const tokens = new Set();
  const keys = new Set();
  for (const p of people) {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40) throw new Error('Имя человека: от 1 до 40 символов');
    if (!TOKEN_RE.test(String(p.token))) throw new Error(`Некорректный код ссылки у «${p.name}»`);
    if (tokens.has(p.token)) throw new Error('Повторяющийся код ссылки');
    if (!KEY_RE.test(String(p.key))) throw new Error(`Некорректное имя ключа у «${p.name}»`);
    if (keys.has(p.key)) throw new Error(`Ключ ${p.key} уже привязан к другому человеку`);
    tokens.add(p.token);
    keys.add(p.key);
  }
}

function loadSubs(file) {
  if (!fs.existsSync(file)) return defaultSubs();
  const subs = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateSubs(subs);
  return subs;
}

function saveSubs(file, subs) {
  validateSubs(subs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(subs, null, 2));
  fs.renameSync(tmp, file);
}

function withPeople(subs, people) {
  const next = { ...subs, people };
  validateSubs(next);
  return next;
}

function addPerson(subs, name, key) {
  const person = { id: crypto.randomUUID(), name: String(name).trim(), token: newToken(), key };
  return withPeople(subs, [...subs.people, person]);
}

function reissue(subs, id) {
  if (!subs.people.some((p) => p.id === id)) throw new Error('Человек не найден');
  return withPeople(subs, subs.people.map((p) => (p.id === id ? { ...p, token: newToken() } : p)));
}

function removePerson(subs, id) {
  return withPeople(subs, subs.people.filter((p) => p.id !== id));
}

// Входы, которые можно выбрать для каскада: только те, что ведут на выход, где стоит сайт.
// Заменённые входы (replacedBy) не предлагаются: их клиенты уже на новом входе.
// exitId = null (сайт ещё не привязан к выходу): годится любой вход, чей выход есть в программе.
function entryChoices(servers, exitId) {
  if (exitId === null) {
    return servers.filter((s) => s.exitHost && !s.replacedBy && servers.some((x) => x.host === s.exitHost));
  }
  const exit = servers.find((s) => s.id === exitId);
  return exit ? servers.filter((s) => s.exitHost === exit.host && !s.replacedBy) : [];
}

// Выход, на который ведёт вход (сервер с IP = exitHost входа), или undefined.
function exitOf(servers, entry) {
  return entry?.exitHost ? servers.find((s) => s.host === entry.exitHost) : undefined;
}

// Если каскад для подписок ещё не выбран, берём первый действующий вход и его выход.
// Ничего не сохраняет: значения попадут в файл при первом сохранении настроек.
function resolveCascade(subs, servers) {
  if (subs.site.host !== null && subs.cascade.entry !== null) return subs;
  const entry = entryChoices(servers, subs.site.host)[0];
  if (!entry) return subs;
  const exit = exitOf(servers, entry);
  return { ...subs, site: { ...subs.site, host: exit.id }, cascade: { entry: entry.id, exit: exit.id } };
}

function freeKeys(keyNames, subs) {
  const used = new Set(subs.people.map((p) => p.key));
  return keyNames.filter((k) => !used.has(k));
}

module.exports = {
  TOKEN_RE, KEY_RE, OS_LIST, RESERVED_PORTS, validPort, defaultSubs, newToken, validateSubs, loadSubs, saveSubs,
  addPerson, reissue, removePerson, freeKeys, entryChoices, exitOf, resolveCascade,
};
