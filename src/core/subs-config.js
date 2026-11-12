'use strict';
// Хранилище подписок: люди, их личные коды ссылок, настройки сайта.
// Лежит в %APPDATA%\vps-monitor\subscriptions.json только на ПК владельца.
// Коды ссылок — секреты: их нельзя писать в логи и сообщения об ошибках.

const i18n = require('../i18n');
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

// Инструкции и название по умолчанию — на языке сайта (site.lang).
function defaultApps(lang) {
  return Object.fromEntries(OS_LIST.map((os) => [os, {
    name: 'Happ', url: HAPP_URL, steps: i18n.tr(lang, `site.steps.${os}`).split('\n'),
  }]));
}

function defaultSubs(lang = 'ru') {
  return {
    // Вход и выход не заданы: их подставит resolveCascade по списку серверов пользователя.
    site: { domain: null, host: null, port: 8443, title: i18n.tr(lang, 'site.defaultTitle'), updateHours: 12, lang },
    cascade: { entry: null, exit: null },
    apps: defaultApps(lang),
    people: [],
    pending: false, // есть изменения, которые ещё не опубликованы на сервере
  };
}

// Смена языка сайта: тексты по умолчанию переводим, а то, что пользователь правил сам, не трогаем.
function switchSiteLang(subs, lang) {
  const old = subs.site.lang ?? 'ru';
  if (!i18n.LANGS.includes(lang) || old === lang) return subs;
  const was = defaultApps(old);
  const now = defaultApps(lang);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const apps = Object.fromEntries(OS_LIST.map((os) => [os, same(subs.apps[os], was[os]) ? now[os] : subs.apps[os]]));
  const title = subs.site.title === i18n.tr(old, 'site.defaultTitle') ? i18n.tr(lang, 'site.defaultTitle') : subs.site.title;
  return { ...subs, apps, site: { ...subs.site, lang, title } };
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Ссылка «Скачать» попадает в href на странице: разрешаем только https://,
// иначе адрес вида javascript:... выполнил бы код у посетителя.
function validateApps(apps) {
  for (const os of OS_LIST) {
    const app = apps?.[os];
    if (!app) throw new Error(i18n.t('subs.noApp', { os }));
    if (typeof app.name !== 'string' || !app.name.trim() || app.name.length > 40) throw new Error(i18n.t('subs.badAppName', { os }));
    if (typeof app.url !== 'string' || !/^https:\/\/[^\s"'<>]+$/.test(app.url) || app.url.length > 300) {
      throw new Error(i18n.t('subs.badAppUrl', { os }));
    }
    if (!Array.isArray(app.steps) || app.steps.length > 10
      || !app.steps.every((s) => typeof s === 'string' && s.length <= 300)) {
      throw new Error(i18n.t('subs.badSteps', { os }));
    }
  }
}

function validateSubs(subs) {
  const { site, cascade, people } = subs;
  if (!site || !cascade || !Array.isArray(people)) throw new Error(i18n.t('subs.corrupt'));
  if (subs.pending !== undefined && typeof subs.pending !== 'boolean') throw new Error(i18n.t('subs.corrupt'));
  if (site.lang !== undefined && !i18n.LANGS.includes(site.lang)) throw new Error(i18n.t('subs.corrupt'));
  if (!validPort(site.port)) {
    throw new Error(i18n.t('subs.badPort', { ports: RESERVED_PORTS.join(', ') }));
  }
  if (site.domain !== null && !(typeof site.domain === 'string' && DOMAIN_RE.test(site.domain))) {
    throw new Error(i18n.t('subs.badDomain'));
  }
  if (!Number.isInteger(site.updateHours) || site.updateHours < 1 || site.updateHours > 168) {
    throw new Error(i18n.t('subs.badHours'));
  }
  if (typeof site.title !== 'string' || !site.title.trim() || site.title.length > 40) {
    throw new Error(i18n.t('subs.badTitle'));
  }
  // null — каскад ещё не выбран (новая установка без серверов). Иначе это id сервера из программы.
  for (const id of [site.host, cascade.entry, cascade.exit]) {
    if (id !== null && !SERVER_ID_RE.test(String(id))) throw new Error(i18n.t('subs.badServerId'));
  }
  validateApps(subs.apps);
  const tokens = new Set();
  const keys = new Set();
  for (const p of people) {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40) throw new Error(i18n.t('subs.badPersonName'));
    if (!TOKEN_RE.test(String(p.token))) throw new Error(i18n.t('subs.badToken', { name: p.name }));
    if (tokens.has(p.token)) throw new Error(i18n.t('subs.dupToken'));
    if (!KEY_RE.test(String(p.key))) throw new Error(i18n.t('subs.badKeyName', { name: p.name }));
    if (keys.has(p.key)) throw new Error(i18n.t('subs.keyTaken', { key: p.key }));
    tokens.add(p.token);
    keys.add(p.key);
  }
}

function loadSubs(file, lang = 'ru') {
  if (!fs.existsSync(file)) return defaultSubs(lang);
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
  if (!subs.people.some((p) => p.id === id)) throw new Error(i18n.t('sipc.personNotFound'));
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
  addPerson, reissue, removePerson, freeKeys, entryChoices, exitOf, resolveCascade, defaultApps, switchSiteLang,
};
