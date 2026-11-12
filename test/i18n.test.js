'use strict';
// Тесты переводов: словари совпадают, все ключи из кода есть, кириллицы в коде не осталось.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const i18n = require('../src/i18n');
const { loadSettings, saveSettings } = require('../src/core/settings');
const cfg = require('../src/core/subs-config');
const site = require('../src/core/subs-site');

const ROOT = path.join(__dirname, '..');
const { ru, en } = i18n.dicts;

function files(dir, re) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...files(p, re));
    else if (re.test(name)) out.push(p);
  }
  return out;
}

// Весь код, который видит пользователь: программа, окно и серверные скрипты (без словарей).
const CODE = [
  ...files(path.join(ROOT, 'src'), /\.(js|py|html)$/),
  ...files(path.join(ROOT, 'server'), /\.(py|sh)$/),
].filter((p) => !p.includes(`${path.sep}i18n${path.sep}`));

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('в ru и en одинаковые ключи и подстановки', () => {
  assert.deepStrictEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  for (const key of Object.keys(ru)) {
    assert.deepStrictEqual(placeholders(en[key]), placeholders(ru[key]), `подстановки в ${key}`);
    assert.ok(en[key].trim(), `пустой перевод ${key}`);
  }
});

test('t(): подстановки, откат на английский, неизвестный ключ виден как есть', () => {
  try {
    i18n.setLang('ru');
    assert.strictEqual(i18n.t('keys.added', { name: 'a' }), 'Ключ a добавлен');
    i18n.setLang('en');
    assert.strictEqual(i18n.t('keys.added', { name: 'a' }), 'Key a added');
    assert.strictEqual(i18n.t('no.such.key'), 'no.such.key');
    assert.strictEqual(i18n.tr('ru', 'site.copy'), 'Скопировать');
    assert.strictEqual(i18n.setLang('de'), 'en');
  } finally {
    i18n.setLang('ru');
  }
});

test('язык по системе: русская Windows → ru, остальные → en', () => {
  assert.strictEqual(i18n.fromSystem('ru-RU'), 'ru');
  assert.strictEqual(i18n.fromSystem('en-US'), 'en');
  assert.strictEqual(i18n.fromSystem('de'), 'en');
  assert.strictEqual(i18n.fromSystem(undefined), 'en');
});

test('коды серверных скриптов переводятся, неизвестные остаются как есть', () => {
  try {
    i18n.setLang('en');
    // Код занимает конец строки: аргументы могут содержать пробелы (например, текст ошибки Caddy).
    assert.strictEqual(i18n.translateServer('x @E:site_port_busy|8443'), 'x Port 8443 is already in use');
    assert.strictEqual(i18n.translateServer('@E:col_timer|active|success'), 'timer: active, last run: success');
    assert.strictEqual(i18n.translateServer('@E:nope|1'), '@E:nope|1');
  } finally {
    i18n.setLang('ru');
  }
});

test('все ключи и коды, которые встречаются в коде, есть в словарях', () => {
  const NS = /^(common|nav|status|unit|ov|act|keys|links|term|setup|pass|remove|replace|admin|limit|lang|subs|sipc|site|main|ssh|ipc|role|cfg|health|srvmsg|val|step|prov|repl)\.[A-Za-z0-9_.]+$/;
  const missing = [];
  for (const file of CODE) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/['"]([a-z]+\.[A-Za-z0-9_.]+)['"]/g)) {
      const key = m[1];
      if (NS.test(key) && !/\.(js|json|py|sh|html|css)$/.test(key) && !(key in ru)) missing.push(`${path.relative(ROOT, file)}: ${key}`);
    }
    for (const m of text.matchAll(/@E:([a-z0-9_]+)/g)) {
      if (!(`srv.${m[1]}` in ru)) missing.push(`${path.relative(ROOT, file)}: @E:${m[1]}`);
    }
  }
  assert.deepStrictEqual(missing, []);
});

// Кириллица допустима только в комментариях, документации функций и в названии языка «Русский».
// Переносы строк приводим к \n: в Windows файл может прийти с \r\n, а «.» в регулярке не видит \r.
function codeWithoutComments(file, raw) {
  const text = raw.replace(/\r\n/g, '\n');
  if (/\.(py|sh)$/.test(file)) {
    return text
      .replace(/"""[\s\S]*?"""/g, '')
      .split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n')
    .replace(/Русский/g, '');
}

test('в коде не осталось русских строк вне словаря', () => {
  const found = [];
  for (const file of CODE) {
    const lines = codeWithoutComments(file, fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (/[Ѐ-ӿ]/.test(line)) found.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepStrictEqual(found, []);
});

test('настройки: язык сохраняется, мусор в файле не мешает', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpsmon-set-'));
  const file = path.join(dir, 'settings.json');
  assert.strictEqual(loadSettings(file, 'ru-RU').lang, 'ru');
  assert.strictEqual(loadSettings(file, 'en-GB').lang, 'en');
  saveSettings(file, { lang: 'en' });
  assert.strictEqual(loadSettings(file, 'ru-RU').lang, 'en');
  fs.writeFileSync(file, '{oops');
  assert.strictEqual(loadSettings(file, 'ru-RU').lang, 'ru');
  fs.writeFileSync(file, JSON.stringify({ lang: 'xx' }));
  assert.strictEqual(loadSettings(file, 'ru-RU').lang, 'ru');
});

test('сайт подписок: язык сайта не зависит от языка программы', async () => {
  const inv = { keys: [{ name: 'u1', entries: [{ tag: 'inbound-443', id: '00000000-1111-2222-3333-444444444444' }] }], inbounds: [] };
  const subs = { ...cfg.addPerson(cfg.defaultSubs('en'), 'Bob', 'u1') };
  subs.site.domain = 'sub.example.com';
  const { files: out } = await site.buildSite(subs, inv, { host: '203.0.113.10' });
  const stub = out['index.html'];
  assert.match(stub, /lang="en"/);
  assert.match(stub, /Nothing here yet/);
  assert.doesNotMatch(stub, /[Ѐ-ӿ]/);
});

test('смена языка сайта переводит тексты по умолчанию, но не правки пользователя', () => {
  const s = cfg.defaultSubs('ru');
  s.apps.windows = { ...s.apps.windows, steps: ['Мой шаг'] };
  const next = cfg.switchSiteLang(s, 'en');
  assert.strictEqual(next.site.lang, 'en');
  assert.strictEqual(next.site.title, 'Access');
  assert.deepStrictEqual(next.apps.android, cfg.defaultApps('en').android);
  assert.deepStrictEqual(next.apps.windows.steps, ['Мой шаг']);
  cfg.validateSubs(next);
  // Свой заголовок не трогаем.
  const custom = cfg.switchSiteLang({ ...s, site: { ...s.site, title: 'Мой VPN' } }, 'en');
  assert.strictEqual(custom.site.title, 'Мой VPN');
  // Старые файлы без site.lang считаются русскими.
  const legacy = { ...s, site: { ...s.site } };
  delete legacy.site.lang;
  cfg.validateSubs(legacy);
  assert.strictEqual(cfg.switchSiteLang(legacy, 'en').site.title, 'Access');
});
