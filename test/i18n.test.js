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
  ...files(path.join(ROOT, 'tools'), /\.(js|py)$/),
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

// Вторая, независимая проверка: кириллица внутри самих строковых литералов. Она ловит строку,
// в которой после «//» или «#» стоит русский текст (первая проверка приняла бы его за комментарий).
test('в строковых литералах кода нет кириллицы', () => {
  const found = [];
  const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  for (const file of CODE.filter((f) => /\.(js|py)$/.test(f))) {
    let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (file.endsWith('.py')) text = text.replace(/"""[\s\S]*?"""/g, '');
    // Целые строки-комментарии убираем: в них бывают апострофы, которые сбили бы разбор литералов.
    text = text.split('\n').map((l) => (/^\s*(\/\/|#|\*|\/\*)/.test(l) ? '' : l)).join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(LITERAL)) {
      if (/[Ѐ-ӿ]/.test(m[0].replace(/Русский/g, ''))) {
        const line = text.slice(0, m.index).split('\n').length;
        found.push(`${path.relative(ROOT, file)}:${line}: ${m[0].slice(0, 80)}`);
      }
    }
  }
  assert.deepStrictEqual(found, []);
});

test('в английском словаре нет кириллицы (кроме названия языка «Русский»)', () => {
  const bad = Object.entries(en).filter(([k, v]) => k !== 'lang.ru' && /[Ѐ-ӿ]/.test(v));
  assert.deepStrictEqual(bad, []);
});

// Вызов t('ключ', { a, b }) должен передать все подстановки, которые есть в строке словаря,
// иначе пользователь увидит «?» вместо значения.
test('вызовы t() передают все подстановки из словаря', () => {
  const problems = [];
  const CALL = /\bt\(\s*'([\w.]+)'\s*,\s*\{([^{}]*)\}/g;
  for (const file of CODE.filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(CALL)) {
      if (!(m[1] in ru)) continue;
      const given = m[2].split(',').map((part) => part.split(':')[0].trim()).filter(Boolean);
      const missing = placeholders(ru[m[1]]).filter((p) => !given.includes(p));
      if (missing.length) problems.push(`${path.relative(ROOT, file)}: ${m[1]} без {${missing.join('}, {')}}`);
    }
  }
  assert.deepStrictEqual(problems, []);
});

// Серверный скрипт печатает @E:код|арг0|арг1 — число аргументов должно совпадать со словарём.
test('коды @E в серверных скриптах печатаются с нужным числом аргументов', () => {
  const problems = [];
  for (const file of CODE.filter((f) => /\.(py|sh|js)$/.test(f))) {
    const text = fs.readFileSync(file, 'utf8');
    // Аргумент может быть подстановкой shell вида $(команда с пробелами).
    for (const m of text.matchAll(/@E:([a-z0-9_]+)((?:\|(?:\$\([^)]*\)|[^'"\s|])*)*)/g)) {
      const key = `srv.${m[1]}`;
      if (!(key in ru)) continue;
      const want = new Set(placeholders(ru[key])).size;
      const got = m[2] ? m[2].split('|').length - 1 : 0;
      // В JS-шаблонах коды встречаются и без аргументов (например, в описании формата) — проверяем только явные.
      if (got !== want && !(got === 0 && file.endsWith('.js'))) problems.push(`${path.relative(ROOT, file)}: @E:${m[1]} — ${got} арг., нужно ${want}`);
    }
  }
  assert.deepStrictEqual(problems, []);
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
