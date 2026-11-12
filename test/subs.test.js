'use strict';
// Тесты подписок: хранилище людей и ссылок, генератор сайта, публикация.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cfg = require('../src/core/subs-config');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'subs-')), 'subscriptions.json');

// --- Хранилище ---

test('newToken: 43 символа base64url и каждый раз новый', () => {
  const a = cfg.newToken();
  assert.match(a, cfg.TOKEN_RE);
  assert.notStrictEqual(a, cfg.newToken());
});

test('addPerson добавляет человека с кодом, второй человек на тот же ключ запрещён', () => {
  const s = cfg.addPerson(cfg.defaultSubs(), 'Вася', 'user1');
  assert.strictEqual(s.people.length, 1);
  assert.match(s.people[0].token, cfg.TOKEN_RE);
  assert.strictEqual(s.people[0].key, 'user1');
  assert.throws(() => cfg.addPerson(s, 'Петя', 'user1'), /уже/);
});

test('reissue меняет только код ссылки', () => {
  const s = cfg.addPerson(cfg.defaultSubs(), 'Вася', 'user1');
  const p = s.people[0];
  const r = cfg.reissue(s, p.id).people[0];
  assert.notStrictEqual(r.token, p.token);
  assert.deepStrictEqual([r.id, r.name, r.key], [p.id, p.name, p.key]);
});

test('removePerson удаляет человека', () => {
  const s = cfg.addPerson(cfg.defaultSubs(), 'Вася', 'user1');
  assert.strictEqual(cfg.removePerson(s, s.people[0].id).people.length, 0);
});

test('freeKeys возвращает незанятые ключи', () => {
  const s = cfg.addPerson(cfg.defaultSubs(), 'Вася', 'user1');
  assert.deepStrictEqual(cfg.freeKeys(['user1', 'user2', 'fb1'], s), ['user2', 'fb1']);
});

test('validateSubs отклоняет кривой код, порт 443 и кривой домен', () => {
  const base = cfg.addPerson(cfg.defaultSubs(), 'Вася', 'user1');
  const bad = (patch) => () => cfg.validateSubs(patch(structuredClone(base)));
  assert.throws(bad((s) => { s.people[0].token = '../../etc'; return s; }));
  assert.throws(bad((s) => { s.site.port = 443; return s; }));
  assert.throws(bad((s) => { s.site.domain = 'bad domain'; return s; }));
  assert.throws(bad((s) => { s.people[0].name = ''; return s; }));
  assert.throws(bad((s) => { s.people[0].key = 'a b'; return s; }));
});

test('validateSubs отклоняет повтор кода', () => {
  let s = cfg.addPerson(cfg.defaultSubs(), 'Вася', 'user1');
  s = cfg.addPerson(s, 'Петя', 'user2');
  s.people[1].token = s.people[0].token;
  assert.throws(() => cfg.validateSubs(s), /код/i);
});

test('loadSubs без файла даёт настройки по умолчанию, save/load сохраняет всё', () => {
  const f = tmpFile();
  assert.deepStrictEqual(cfg.loadSubs(f), cfg.defaultSubs());
  const s = cfg.addPerson(cfg.defaultSubs(), 'Вася', 'user1');
  cfg.saveSubs(f, s);
  assert.deepStrictEqual(cfg.loadSubs(f), s);
});

test('loadSubs падает с понятной ошибкой на испорченном файле', () => {
  const f = tmpFile();
  const s = cfg.addPerson(cfg.defaultSubs(), 'Вася', 'user1');
  s.people[0].token = '../x';
  fs.writeFileSync(f, JSON.stringify(s));
  assert.throws(() => cfg.loadSubs(f), /код/i);
});

test('в настройках по умолчанию нет чужих серверов, Happ везде', () => {
  const d = cfg.defaultSubs();
  for (const os of ['android', 'ios', 'windows', 'linux']) assert.strictEqual(d.apps[os].name, 'Happ');
  assert.deepStrictEqual(d.cascade, { entry: null, exit: null });
  assert.strictEqual(d.site.host, null);
  assert.strictEqual(d.site.port, 8443);
  assert.strictEqual(d.site.updateHours, 12);
});

// --- Генератор сайта ---

const site = require('../src/core/subs-site');

const INV = {
  inbounds: [
    { tag: 'inbound-443', port: 443, net: 'xhttp', sni: 'ex.com', pbk: 'PBK', sid: 'ab', path: '/p', mode: 'auto', flow: null },
    { tag: 'inbound-8443', port: 8443, net: 'tcp', sni: 'ex.com', pbk: 'PBK', sid: 'ab', path: null, mode: null, flow: 'xtls-rprx-vision' },
  ],
  keys: [
    { name: 'fb1', entries: [{ tag: 'inbound-443', id: 'FB1X' }] },
    { name: 'user1', entries: [{ tag: 'inbound-443', id: 'U1X' }, { tag: 'inbound-8443', id: 'U1V' }] },
    { name: 'user2', entries: [{ tag: 'inbound-8443', id: 'U2V' }] },
  ],
};
const ENTRY = { host: '203.0.113.10' };

function twoPeople() {
  let s = cfg.defaultSubs();
  s.site.domain = 'example.org';
  s = cfg.addPerson(s, 'Вася', 'user1');
  return cfg.addPerson(s, 'Петя', 'fb1');
}
const decode = (b64) => Buffer.from(b64, 'base64').toString('utf8');

test('personLink: только XHTTP-ссылка своего ключа', () => {
  const s = twoPeople();
  const link = site.personLink(s, INV, ENTRY, s.people[0]);
  assert.ok(link.startsWith('vless://U1X@203.0.113.10:443?'));
  assert.match(link, /type=xhttp/);
  assert.doesNotMatch(link, /U1V/);
  assert.ok(link.endsWith(`#${encodeURIComponent('Доступ')}`));
});

test('personLink: ключ только с Vision или удалённый ключ → null', () => {
  const s = twoPeople();
  assert.strictEqual(site.personLink(s, INV, ENTRY, { ...s.people[0], key: 'user2' }), null);
  assert.strictEqual(site.personLink(s, INV, ENTRY, { ...s.people[0], key: 'ghost' }), null);
});

test('buildSite: подписка — base64 ровно одной XHTTP-ссылки', async () => {
  const s = twoPeople();
  const { files } = await site.buildSite(s, INV, ENTRY);
  const lines = decode(files[`s/${s.people[0].token}/sub`]).trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].startsWith('vless://U1X@'));
});

test('buildSite: без XHTTP-ключа — «Ключей нет» и пустая подписка', async () => {
  let s = cfg.defaultSubs();
  s.site.domain = 'example.org';
  s = cfg.addPerson(s, 'Коля', 'user2');
  const t = s.people[0].token;
  const { files } = await site.buildSite(s, INV, ENTRY);
  assert.strictEqual(files[`s/${t}/sub`], '');
  assert.match(files[`s/${t}/index.html`], /Ключей нет/);
  assert.doesNotMatch(files[`s/${t}/index.html`], /vless:\/\//);
});

test('buildSite: страница одного человека не содержит данных другого', async () => {
  const s = twoPeople();
  const [a, b] = s.people;
  const { files } = await site.buildSite(s, INV, ENTRY);
  const pageA = files[`s/${a.token}/index.html`] + files[`s/${a.token}/sub`];
  assert.ok(!pageA.includes(b.token));
  assert.ok(!pageA.includes('FB1X'));
  assert.ok(!pageA.includes('Петя'));
});

test('buildSite: имя с HTML экранируется', async () => {
  let s = cfg.defaultSubs();
  s.site.domain = 'example.org';
  s = cfg.addPerson(s, '<script>alert(1)</script>"&', 'user1');
  const { files } = await site.buildSite(s, INV, ENTRY);
  const html = files[`s/${s.people[0].token}/index.html`];
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('страница: noindex, подсказка, ссылка-подписка, без имени владельца, < 30 КБ', async () => {
  const s = twoPeople();
  const p = s.people[0];
  const { files } = await site.buildSite(s, INV, ENTRY);
  const html = files[`s/${p.token}/index.html`];
  assert.match(html, /noindex/);
  assert.ok(html.includes('Не подключается? Обнови подписку в Happ'));
  assert.ok(html.includes(site.subUrl(s, p.token)));
  assert.ok(Buffer.byteLength(html) < 30000, `размер ${Buffer.byteLength(html)}`);
});

test('заглушка не выдаёт, что это VPN', async () => {
  const { files } = await site.buildSite(twoPeople(), INV, ENTRY);
  assert.doesNotMatch(files['index.html'], /vpn|ключ|подписк|happ/i);
});

test('после перевыпуска старого кода нет нигде', async () => {
  let s = twoPeople();
  const old = s.people[0].token;
  s = cfg.reissue(s, s.people[0].id);
  const built = await site.buildSite(s, INV, ENTRY);
  assert.ok(!JSON.stringify(built).includes(old));
});

test('subUrl и profileTitleHeader', () => {
  const s = twoPeople();
  assert.strictEqual(site.subUrl(s, 'T'), 'https://example.org:8443/s/T/');
  const h = site.profileTitleHeader('Доступ');
  assert.ok(h.startsWith('base64:'));
  assert.match(h, /^[\x20-\x7e]+$/);
  assert.strictEqual(decode(h.slice(7)), 'Доступ');
});

test('classifyRequest: браузер, клиент, /sub, плохой код, корень', () => {
  const t = cfg.newToken();
  const browser = { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0' };
  assert.deepStrictEqual(site.classifyRequest(`/s/${t}/`, browser), { kind: 'page', token: t });
  assert.deepStrictEqual(site.classifyRequest(`/s/${t}`, browser), { kind: 'page', token: t });
  assert.deepStrictEqual(site.classifyRequest(`/s/${t}/`, { accept: 'text/html', 'user-agent': 'Happ/3.2' }), { kind: 'sub', token: t });
  assert.deepStrictEqual(site.classifyRequest(`/s/${t}/`, { 'user-agent': 'okhttp' }), { kind: 'sub', token: t });
  assert.deepStrictEqual(site.classifyRequest(`/s/${t}/sub`, browser), { kind: 'sub', token: t });
  assert.strictEqual(site.classifyRequest('/s/bad/', browser).kind, 'stub');
  assert.strictEqual(site.classifyRequest('/', browser).kind, 'stub');
});

test('buildCaddyfile: домен:порт, заголовки, без журнала и листинга', () => {
  const c = site.buildCaddyfile(twoPeople());
  assert.ok(c.includes('example.org:8443 {'));
  assert.match(c, /profile-update-interval 12/);
  assert.match(c, /base64:/);
  assert.match(c, /file_server/);
  assert.match(c, /disable_tlsalpn_challenge/); // 443 занят Xray: сертификат только через порт 80
  assert.doesNotMatch(c, /\blog\b|browse|admin off/);
});

// --- Публикация, установка, кэш инвентаря ---

const pub = require('../src/core/subs-publish');

test('deployPayload — JSON с теми же файлами и Caddyfile', () => {
  const built = { files: { 'index.html': 'x', 's/a/sub': '' }, caddyfile: 'c' };
  assert.deepStrictEqual(JSON.parse(pub.deployPayload(built)), built);
});

test('deployCommand запускает python3 и не содержит данных сайта', () => {
  const cmd = pub.deployCommand();
  assert.match(cmd, /python3/);
  assert.match(cmd, /^[A-Za-z0-9+/=|\s;&>._-]+$/); // только base64 и безопасные символы оболочки
});

test('installCommand проверяет порт', () => {
  assert.throws(() => pub.installCommand(443));
  assert.throws(() => pub.installCommand('1;rm -rf /'));
  assert.throws(() => pub.installCommand(70000));
  assert.match(pub.installCommand(8443), /8443$/);
});

test('checkDns: чужой IP — ошибка, свой — ок', async () => {
  const lookup = (ip) => async () => [{ address: ip, family: 4 }];
  await assert.rejects(pub.checkDns('example.org', '198.51.100.20', lookup('1.2.3.4')), /1\.2\.3\.4/);
  await pub.checkDns('example.org', '198.51.100.20', lookup('198.51.100.20'));
});

test('readInventory: удачное чтение сохраняет кэш, при ошибке берётся кэш', async () => {
  const cacheFile = tmpFile();
  const ok = await pub.readInventory({ read: async () => INV, cacheFile, entryId: 'vpsr', now: 1000 });
  assert.deepStrictEqual(ok, { inventory: INV, cachedAt: null });
  const fallback = await pub.readInventory({ read: async () => { throw new Error('timeout'); }, cacheFile, entryId: 'vpsr' });
  assert.deepStrictEqual(fallback, { inventory: INV, cachedAt: 1000 });
});

test('readInventory: ошибка без кэша — понятная ошибка', async () => {
  await assert.rejects(
    pub.readInventory({ read: async () => { throw new Error('timeout'); }, cacheFile: tmpFile(), entryId: 'vpsr' }),
    /сохранённых ключей нет/,
  );
});

test('publish: отказ сервера превращается в ошибку, успех возвращает релиз', async () => {
  const built = { files: { 'index.html': 'x' }, caddyfile: 'c' };
  const fail = { exec: async () => '{"ok":false,"error":"caddy validate: bad"}\n' };
  await assert.rejects(pub.publish(fail, built), /caddy validate/);
  let got;
  const good = { exec: async (cmd, ms, input) => { got = input; return '{"ok":true,"release":"20261110T120000"}\n'; } };
  assert.deepStrictEqual(await pub.publish(good, built), { release: '20261110T120000' });
  assert.deepStrictEqual(JSON.parse(got), built);
});

test('validateSubs: ссылки приложений только https, шаги — строки', () => {
  const bad = (patch) => () => { const s = cfg.defaultSubs(); patch(s); cfg.validateSubs(s); };
  assert.throws(bad((s) => { s.apps.android.url = 'javascript:alert(1)'; }), /https/);
  assert.throws(bad((s) => { s.apps.ios.steps = [1, 2]; }));
  assert.throws(bad((s) => { delete s.apps.linux; }));
  assert.throws(bad((s) => { s.apps.windows.name = ''; }));
});

test('xhttpKeys: только ключи, у которых есть XHTTP-запись', () => {
  assert.deepStrictEqual(site.xhttpKeys(INV), ['fb1', 'user1']);
});

// --- Исправления по итоговому ревью ---

test('entryChoices: только входы, ведущие на выход сайта (второй каскад не попадает)', () => {
  const servers = [
    { id: 'msk1', host: '203.0.113.40', exitHost: '198.51.100.30' },
    { id: 'fra', host: '198.51.100.30', exitHost: null },
    { id: 'vpsr', host: '203.0.113.10', exitHost: '198.51.100.20' },
    { id: 'vpsg', host: '198.51.100.20', exitHost: null },
  ];
  assert.deepStrictEqual(cfg.entryChoices(servers, 'vpsg').map((s) => s.id), ['vpsr']);
});

test('entryChoices: заменённый вход (replacedBy) не предлагается', () => {
  const servers = [
    { id: 'vpsr', host: '203.0.113.10', exitHost: '198.51.100.20', replacedBy: 's5_6_7_8' },
    { id: 'vpsg', host: '198.51.100.20', exitHost: null },
    { id: 's5_6_7_8', host: '5.6.7.8', exitHost: '198.51.100.20' },
  ];
  assert.deepStrictEqual(cfg.entryChoices(servers, 'vpsg').map((s) => s.id), ['s5_6_7_8']);
});

test('entryChoices(null): входы всех каскадов, чей выход есть в программе', () => {
  const servers = [
    { id: 'a', host: '203.0.113.40', exitHost: '198.51.100.30' },
    { id: 'b', host: '198.51.100.30', exitHost: null },
    { id: 'c', host: '203.0.113.10', exitHost: '198.51.100.99' }, // выхода нет в программе
    { id: 'd', host: '203.0.113.11', exitHost: '198.51.100.30', replacedBy: 'a' },
  ];
  assert.deepStrictEqual(cfg.entryChoices(servers, null).map((s) => s.id), ['a']);
});

test('resolveCascade: подставляет первый каскад, не трогает уже выбранный', () => {
  const servers = [
    { id: 'solo', host: '203.0.113.5', exitHost: null },
    { id: 'in', host: '203.0.113.10', exitHost: '198.51.100.20' },
    { id: 'out', host: '198.51.100.20', exitHost: null },
  ];
  const d = cfg.resolveCascade(cfg.defaultSubs(), servers);
  assert.deepStrictEqual(d.cascade, { entry: 'in', exit: 'out' });
  assert.strictEqual(d.site.host, 'out');
  cfg.validateSubs(d);
  // Без каскадов остаётся null и файл всё равно валиден.
  const empty = cfg.resolveCascade(cfg.defaultSubs(), [servers[0]]);
  assert.strictEqual(empty.cascade.entry, null);
  cfg.validateSubs(empty);
  // Уже выбранный каскад не меняется.
  const fixed = { ...d, cascade: { entry: 'x', exit: 'y' }, site: { ...d.site, host: 'y' } };
  assert.strictEqual(cfg.resolveCascade(fixed, servers), fixed);
});

test('pending сохраняется в файле между запусками', () => {
  const f = tmpFile();
  const s = { ...cfg.addPerson(cfg.defaultSubs(), 'Вася', 'user1'), pending: true };
  cfg.saveSubs(f, s);
  assert.strictEqual(cfg.loadSubs(f).pending, true);
  assert.strictEqual(cfg.defaultSubs().pending, false);
});

test('deployPayload передаёт порт сайта (для UFW)', () => {
  const built = { files: { 'index.html': 'x' }, caddyfile: 'c', port: 8443 };
  assert.strictEqual(JSON.parse(pub.deployPayload(built)).port, 8443);
});

test('buildSite возвращает порт сайта', async () => {
  const built = await site.buildSite(twoPeople(), INV, ENTRY);
  assert.strictEqual(built.port, 8443);
});

test('ошибка сервера не раскрывает код ссылки', async () => {
  const t = cfg.newToken();
  const tr = { exec: async () => `{"ok":false,"error":"No space: /var/www/vpsmon-sub/releases/x/s/${t}/index.html"}\n` };
  await assert.rejects(pub.publish(tr, { files: {}, caddyfile: '' }), (err) => !err.message.includes(t) && /No space/.test(err.message));
});

test('порты 22, 80, 2019 запрещены и в настройках, и в установке', () => {
  for (const port of [22, 80, 2019]) {
    const s = cfg.defaultSubs();
    s.site.port = port;
    assert.throws(() => cfg.validateSubs(s), String(port));
    assert.throws(() => pub.installCommand(port), String(port));
  }
});

test('страница даёт Happ адрес /sub: копирование, QR и кнопка', async () => {
  const s = twoPeople();
  const p = s.people[0];
  const { files } = await site.buildSite(s, INV, ENTRY);
  const html = files[`s/${p.token}/index.html`];
  const happUrl = `${site.subUrl(s, p.token)}sub`;
  assert.strictEqual(site.happUrl(s, p.token), happUrl);
  assert.ok(html.includes(`<code id="sub-url">${happUrl}</code>`));
  assert.ok(html.includes(`happ://add/${happUrl}`));
  const qrSub = await require('qrcode').toString(happUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  assert.ok(html.includes(qrSub), 'QR должен кодировать адрес /sub');
});
