'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { loadServers, addServers, removeServer } = require('../src/core/app-config');
const { computeLimit } = require('../src/core/limits');
const { fingerprint, trustLine } = require('../src/core/host-trust');
const { isKnownKey, hasHost } = require('../src/core/known-hosts');
const { buildEntryConfig, buildExitConfig } = require('../src/core/provision/xray-config');
const { rankSni } = require('../src/core/provision/sni');
const { runSteps, sanitize } = require('../src/core/provision/runner');
const { parsePrecheck, buildSteps } = require('../src/core/provision/steps');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vpsmon-'));

test('установщик не содержит личных серверов', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(!pkg.build.files.includes('config/servers.json') && !pkg.build.files.some((f) => f.startsWith('config/**')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '../config/servers.default.json'), 'utf8')).servers, []);
});

// --- Конфиг и лимиты ---

test('конфиг: первый запуск копирует seed как есть, без чужих лимитов', () => {
  const d = tmp();
  const seed = path.join(d, 'seed.json');
  fs.writeFileSync(seed, JSON.stringify({ pollSeconds: 10, servers: [{ id: 'a', host: '1' }, { id: 'b', host: '2', limit: { tb: 5, resetDay: 1, mode: 'both' } }] }));
  const file = path.join(d, 'a', 'servers.json');
  const c = loadServers(file, seed);
  assert.equal(c.servers[0].limit, undefined);
  assert.equal(c.servers[1].limit.tb, 5);
  assert.ok(fs.existsSync(file));
  fs.writeFileSync(file, JSON.stringify({ pollSeconds: 5, servers: [] }));
  assert.equal(loadServers(file, seed).pollSeconds, 5);
});

test('конфиг: дубликат отклоняется, удаление работает', () => {
  const c = { servers: [{ id: 'a', host: '1' }] };
  assert.throws(() => addServers(c, [{ id: 'b', host: '1' }]));
  const c2 = addServers(c, [{ id: 'b', host: '2' }]);
  assert.equal(c2.servers.length, 2);
  assert.equal(removeServer(c2, 'a').servers.length, 1);
});

const rec = (days) => ({ days: Object.fromEntries(Object.entries(days).map(([d, [up, down]]) => [d, { __server__: { up, down } }])) });

test('лимит: период и режимы подсчёта', () => {
  const r = rec({ '2026-10-31': [100, 100], '2026-11-01': [1e11, 2e11], '2026-11-08': [1e11, 0] });
  const now = new Date(2026, 10, 8, 12);
  const both = computeLimit(r, { tb: 1, resetDay: 1, mode: 'both' }, now);
  assert.equal(both.usedBytes, 4e11);
  assert.equal(both.remainingBytes, 6e11);
  assert.equal(both.periodStart, '2026-11-01');
  assert.equal(computeLimit(r, { tb: 1, resetDay: 1, mode: 'down' }, now).usedBytes, 2e11);
});

test('лимит: день сброса 31 в коротком месяце и переход через месяц', () => {
  assert.equal(computeLimit(rec({}), { tb: 1, resetDay: 31, mode: 'both' }, new Date(2026, 1, 28, 12)).periodStart, '2026-02-28');
  assert.equal(computeLimit(rec({}), { tb: 1, resetDay: 15, mode: 'both' }, new Date(2026, 10, 8, 12)).periodStart, '2026-10-15');
});

test('лимит: пороги предупреждений', () => {
  const level = (used) => computeLimit(rec({ '2026-11-02': [used, 0] }), { tb: 1, resetDay: 1, mode: 'both' }, new Date(2026, 10, 8)).level;
  assert.equal(level(7.99e11), 'ok');
  assert.equal(level(8e11), 'warn80');
  assert.equal(level(9.5e11), 'warn95');
});

// --- Доверие к серверу ---

test('отпечаток совпадает с форматом ssh-keygen и строка принимается known_hosts', () => {
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 3, 1, 2, 3])]);
  const expected = `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  assert.equal(fingerprint(blob), expected);
  const line = trustLine('9.9.9.9', blob);
  assert.ok(line.startsWith('9.9.9.9 ssh-ed25519 '));
  assert.ok(isKnownKey(line, '9.9.9.9', blob));
  assert.ok(hasHost(line, '9.9.9.9'));
  assert.ok(!hasHost(line, '8.8.8.8'));
});

// --- Конфиги Xray ---

const profile = (mode, a, b) => ({ mode, xhttpPort: a, visionPort: b, xhttpPath: '/p', sni: 's.com', shortId: 'ab', privateKey: 'K', clients: [{ name: `${mode}01`, uuid: 'U' }] });
const exit = { host: '5.5.5.5', port: 443, uuid: 'E', publicKey: 'PB', sni: 'x.com', shortId: 'cd' };
const ruleFor = (cfg, pred) => cfg.routing.rules.findIndex(pred);

test('конфиг xray: одиночный выходит напрямую', () => {
  const c = buildEntryConfig({ profiles: [profile('single', 443, 8443)], statsPort: 10085 });
  assert.equal(c.outbounds[0].tag, 'direct');
  assert.deepEqual(c.inbounds.map((i) => i.tag), ['single-xhttp', 'single-vision']);
  assert.equal(c.inbounds[1].settings.clients[0].flow, 'xtls-rprx-vision');
  assert.equal(c.inbounds[0].settings.clients[0].flow, undefined);
});

test('конфиг xray: каскад, российское напрямую только для каскада', () => {
  const c = buildEntryConfig({ profiles: [profile('single', 443, 8443), profile('cascade', 2053, 2083)], statsPort: 10085, exit });
  assert.equal(c.inbounds.length, 4);
  const toExit = c.routing.rules.find((r) => r.outboundTag === 'exit');
  assert.deepEqual(toExit.inboundTag, ['cascade-xhttp', 'cascade-vision']);
  const ru = c.routing.rules.find((r) => r.domain);
  assert.deepEqual(ru.inboundTag, ['cascade-xhttp', 'cascade-vision']);
  assert.equal(ru.outboundTag, 'direct');
  const out = c.outbounds.find((o) => o.tag === 'exit');
  assert.equal(out.streamSettings.network, 'tcp');
  assert.equal(out.streamSettings.realitySettings.publicKey, 'PB');
  assert.equal(out.settings.vnext[0].users[0].flow, '');
});

test('конфиг xray: блокировка внутренних адресов и торрентов стоит раньше остальных', () => {
  const c = buildEntryConfig({ profiles: [profile('cascade', 443, 8443)], statsPort: 10085, exit });
  const priv = ruleFor(c, (r) => r.ip?.includes('geoip:private') && r.outboundTag === 'block');
  const bt = ruleFor(c, (r) => r.protocol?.includes('bittorrent') && r.outboundTag === 'block');
  const go = ruleFor(c, (r) => r.outboundTag === 'exit');
  assert.ok(priv >= 0 && bt >= 0 && priv < go && bt < go);
});

test('конфиг xray: одинаковый порт дважды это ошибка', () => {
  assert.throws(() => buildEntryConfig({ profiles: [profile('single', 443, 443)], statsPort: 10085 }), /порт/i);
  assert.throws(() => buildEntryConfig({ profiles: [profile('single', 443, 8443), profile('cascade', 8443, 2083)], statsPort: 10085, exit }), /порт/i);
  assert.throws(() => buildEntryConfig({ profiles: [profile('cascade', 443, 8443)], statsPort: 10085 }), /выход/i);
});

test('конфиг xray: выход принимает вход без flow', () => {
  const c = buildExitConfig({ port: 443, uuid: 'E', sni: 'x.com', shortId: 'cd', privateKey: 'K' });
  assert.equal(c.inbounds[0].tag, 'from-entry');
  assert.equal(c.inbounds[0].settings.clients[0].flow, '');
  assert.ok(c.routing.rules.some((r) => r.ip?.includes('geoip:private') && r.outboundTag === 'block'));
});

// --- SNI ---

test('SNI: отсев и сортировка', () => {
  const ok = { tls13: true, h2: true, x25519: true, redirect: false };
  const list = rankSni([
    { domain: 'slow.com', ms: 90, ...ok },
    { domain: 'fast.com', ms: 10, ...ok },
    { domain: 'no13.com', ms: 1, ...ok, tls13: false },
    { domain: 'noh2.com', ms: 1, ...ok, h2: false },
    { domain: 'nox.com', ms: 1, ...ok, x25519: false },
    { domain: 'red.com', ms: 1, ...ok, redirect: true },
  ]);
  assert.deepEqual(list.map((x) => x.domain), ['fast.com', 'slow.com']);
  assert.deepEqual(rankSni([]), []);
  assert.equal(rankSni(Array.from({ length: 9 }, (_, i) => ({ domain: `d${i}`, ms: i, ...ok }))).length, 5);
});

// --- Движок ---

test('движок: сбой откатывает сделанное в обратном порядке', async () => {
  const log = [];
  const s = (id, fail) => ({ id, title: id, run: async () => { log.push(`run:${id}`); if (fail) throw new Error('x'); }, undo: async () => log.push(`undo:${id}`) });
  const r = await runSteps([s('a'), s('b'), s('c', true), s('d')], {}, () => {});
  assert.deepEqual(log, ['run:a', 'run:b', 'run:c', 'undo:b', 'undo:a']);
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, 'c');
});

test('движок: упавший откат не мешает остальным', async () => {
  const log = [];
  const r = await runSteps([
    { id: 'a', title: 'a', run: async () => {}, undo: async () => log.push('a') },
    { id: 'b', title: 'b', run: async () => {}, undo: async () => { throw new Error('u'); } },
    { id: 'c', title: 'c', run: async () => { throw new Error('x'); } },
  ], {}, () => {});
  assert.deepEqual(log, ['a']);
  assert.equal(r.ok, false);
});

test('sanitize вычищает пароль со спецсимволами и кириллицей', () => {
  const p = 'a"b$c d~@Ъ';
  assert.equal(sanitize(`ошибка ${p} конец`, [p]), 'ошибка *** конец');
});

test('движок: пароль не попадает в прогресс и ошибку', async () => {
  const p = 'S3cret"$';
  const seen = [];
  const r = await runSteps([{ id: 'a', title: 'a', run: async () => { throw new Error(`auth ${p}`); } }], { secrets: [p] }, (e) => seen.push(JSON.stringify(e)));
  assert.ok(!r.error.includes(p));
  assert.ok(seen.every((x) => !x.includes(p)));
});

// --- Предпроверка и шаги ---

const clean = 'os=ubuntu\nver=24.04\narch=x86_64\nxray=no\nbusy=\ndisk_mb=9000\nmanifest=none\n';

test('предпроверка: чистый сервер проходит', () => {
  assert.deepEqual(parsePrecheck(clean, [443]).problems, []);
});

test('предпроверка: сообщает о конфликтах', () => {
  const p = (text) => parsePrecheck(text, [443]).problems.join(' ');
  assert.match(p(clean.replace('os=ubuntu', 'os=centos')), /ОС/);
  assert.match(p(clean.replace('xray=no', 'xray=yes')), /Xray/);
  assert.match(p(clean.replace('busy=', 'busy=443')), /443/);
  assert.match(p(clean.replace('arch=x86_64', 'arch=mips')), /архитектур/i);
  assert.match(p(clean.replace('manifest=none', 'manifest=incomplete')), /не завершена/);
});

function fakeWorld({ precheck = clean, failOn = null, failKeyConnect = false, killOnFail = false, sniRecheckEmpty = false } = {}) {
  const log = [];
  let generation = 0;
  let sniCalls = 0;
  const connect = async (target, auth) => {
    log.push({ host: target.host, kind: 'connect', auth: auth.password ? 'password' : 'key' });
    if (failKeyConnect && auth.keyPath) throw new Error('ключ не принят');
    const born = generation;
    return {
      exec: async (cmd) => {
        if (born !== generation) throw new Error('соединение оборвано');
        const m = cmd.match(/echo (\S+) \| base64 -d/);
        const script = m ? Buffer.from(m[1], 'base64').toString() : cmd;
        log.push({ host: target.host, kind: 'exec', script, raw: cmd });
        if (failOn && script.includes(failOn)) {
          if (killOnFail) generation += 1;
          return 'контрольная сумма не сошлась\n@@rc=1\n';
        }
        if (script.includes('# step:precheck')) return `${typeof precheck === 'function' ? precheck() : precheck}@@rc=0\n`;
        if (script.includes('# step:keygen')) return 'PrivateKey: PRIV\nPassword (PublicKey): PUB\n@@rc=0\n';
        if (script.includes('# step:sni-probe')) {
          sniCalls += 1;
          const list = sniRecheckEmpty && sniCalls > 1 ? [] : [{ domain: 'near.com', ms: 5, tls13: true, h2: true, x25519: true, redirect: false }];
          return `${JSON.stringify(list)}\n@@rc=0\n`;
        }
        return 'ok\n@@rc=0\n';
      },
      close() {},
    };
  };
  const ctx = {
    connect,
    makeKey: () => ({ private: 'APPPRIV', public: 'ssh-ed25519 AAAA vpsmon' }),
    saveKey: (id) => `/k/${id}`,
    chooseSni: async (_t, list) => list[0].domain,
    uuid: () => 'UUID',
    randomHex: () => 'abcd',
    secrets: [],
  };
  return { log, ctx };
}

const singlePlan = () => ({ targets: [{ id: 'n1', name: 'N', host: '1.1.1.1', password: 'pw', role: 'single', modes: ['single'], ports: { single: { xhttp: 443, vision: 8443 } }, limit: { tb: 1, resetDay: 1, mode: 'both' } }] });
const cascadePlan = () => ({ targets: [
  { id: 'in', name: 'I', host: '1.1.1.1', password: 'a', role: 'entry', modes: ['cascade'], ports: { cascade: { xhttp: 443, vision: 8443 } }, limit: { tb: 1, resetDay: 1, mode: 'both' } },
  { id: 'out', name: 'O', host: '2.2.2.2', password: 'b', role: 'exit', modes: [], ports: { exit: 443 }, limit: { tb: 1, resetDay: 1, mode: 'both' } },
] });
const scripts = (log, host) => log.filter((x) => x.kind === 'exec' && (!host || x.host === host)).map((x) => x.script);

test('шаги: порядок id', () => {
  const ids = buildSteps(singlePlan()).map((s) => s.id);
  assert.deepEqual(ids, ['connect', 'precheck', 'app-key', 'fail2ban', 'xray', 'sni', 'config', 'sysctl', 'firewall', 'collector', 'verify', 'finish']);
});

test('шаги: занятый сервер останавливается без единой записи', async () => {
  const { log, ctx } = fakeWorld({ precheck: clean.replace('xray=no', 'xray=yes') });
  const r = await runSteps(buildSteps(singlePlan()), ctx, () => {});
  assert.equal(r.failedStep, 'precheck');
  assert.equal(scripts(log).length, 1);
});

test('шаги: при сбое скачивания xray идёт откат по манифесту', async () => {
  const { log, ctx } = fakeWorld({ failOn: '# step:xray' });
  const r = await runSteps(buildSteps(singlePlan()), ctx, () => {});
  assert.equal(r.failedStep, 'xray');
  assert.match(r.error, /контрольная сумма/);
  assert.ok(scripts(log).some((s) => s.includes('# step:remove')));
});

test('шаги: сервер целиком, пароль и sshd не трогаются', async () => {
  const { log, ctx } = fakeWorld();
  const r = await runSteps(buildSteps(singlePlan()), ctx, () => {});
  assert.equal(r.ok, true, r.error);
  const all = scripts(log).join('\n');
  assert.ok(!/sshd_config|PasswordAuthentication/.test(all));
  const key = scripts(log).find((s) => s.includes('# step:app-key'));
  assert.match(key, />> ?"?\/root\/\.ssh\/authorized_keys/);
  assert.ok(log.some((x) => x.kind === 'connect' && x.auth === 'key'));
  assert.equal(ctx.result.servers[0].statsPort, 10085);
  assert.equal(ctx.result.servers[0].managed, true);
});

test('шаги: файрвол с защитным таймером до включения', async () => {
  const { log, ctx } = fakeWorld();
  await runSteps(buildSteps(singlePlan()), ctx, () => {});
  const fw = scripts(log).find((s) => s.includes('# step:firewall'));
  const guard = fw.indexOf('systemd-run --on-active=180');
  assert.ok(guard >= 0 && guard < fw.indexOf('ufw --force enable'));
  const idx = log.findIndex((x) => x.kind === 'exec' && x.script.includes('# step:firewall'));
  const after = log.slice(idx + 1);
  const reconnect = after.findIndex((x) => x.kind === 'connect' && x.auth === 'key');
  const release = after.findIndex((x) => x.kind === 'exec' && x.script.includes('vpsmon-ufw-guard') && x.script.includes('stop'));
  assert.ok(reconnect >= 0 && release > reconnect);
});

test('шаги: каскад, выход настраивается раньше и открыт только для входа', async () => {
  const { log, ctx } = fakeWorld();
  const r = await runSteps(buildSteps(cascadePlan()), ctx, () => {});
  assert.equal(r.ok, true, r.error);
  const fw = scripts(log, '2.2.2.2').find((s) => s.includes('# step:firewall'));
  assert.match(fw, /ufw allow from 1\.1\.1\.1 to any port 443/);
  const order = log.filter((x) => x.kind === 'exec' && x.script.includes('# step:config')).map((x) => x.host);
  assert.deepEqual(order, ['2.2.2.2', '1.1.1.1']);
  const entry = ctx.result.servers.find((s) => s.id === 'in');
  assert.equal(entry.exitHost, '2.2.2.2');
  assert.equal(ctx.result.servers.find((s) => s.id === 'out').statsPort, null);
});

// --- Смена пароля и скорость ключей ---

test('новый пароль: требования', () => {
  const { validateNewPassword } = require('../src/core/server-actions');
  assert.doesNotThrow(() => validateNewPassword('a"b$c d~@Ъ:12345'));
  assert.throws(() => validateNewPassword('short'), /12/);
  assert.throws(() => validateNewPassword(`abcdefghijkl\nroot:x`), /символ/);
  assert.throws(() => validateNewPassword('x'.repeat(129)), /128/);
  assert.throws(() => validateNewPassword(undefined), /12/);
});

function fakePasswd({ rc = 0, loginFails = false } = {}) {
  const calls = [];
  const logins = [];
  const connect = async (server, opts = {}) => {
    if (opts.password !== undefined) {
      logins.push(opts.password);
      if (loginFails) throw new Error('нет');
    }
    return { exec: async (cmd, _t, input) => { calls.push({ cmd, input }); return `вывод\n@@rc=${rc}\n`; }, close() {} };
  };
  return { calls, logins, connect };
}

test('смена пароля: пароль идёт только через stdin', async () => {
  const { changeRootPassword } = require('../src/core/server-actions');
  const pw = 'a"b$c d~@Ъ:12345';
  const f = fakePasswd();
  await changeRootPassword(f.connect, { host: 'h' }, pw, { verify: false });
  assert.match(f.calls[0].cmd, /chpasswd/);
  assert.ok(!f.calls[0].cmd.includes(pw));
  assert.equal(f.calls[0].input, `root:${pw}\n`);
  assert.deepEqual(f.logins, []);
});

test('смена пароля: при включённом входе проверяется новым паролем', async () => {
  const { changeRootPassword } = require('../src/core/server-actions');
  const f = fakePasswd();
  await changeRootPassword(f.connect, { host: 'h' }, 'abcdefghijkl', { verify: true });
  assert.deepEqual(f.logins, ['abcdefghijkl']);
  const bad = fakePasswd({ loginFails: true });
  await assert.rejects(changeRootPassword(bad.connect, { host: 'h' }, 'abcdefghijkl', { verify: true }), /проверить/);
});

test('смена пароля: ошибка сервера не раскрывает пароль', async () => {
  const { changeRootPassword } = require('../src/core/server-actions');
  const connect = async () => ({ exec: async () => 'chpasswd: bad abcdefghijkl\n@@rc=1\n', close() {} });
  await assert.rejects(changeRootPassword(connect, { host: 'h' }, 'abcdefghijkl', { verify: false }), (e) => !e.message.includes('abcdefghijkl'));
});

test('скорость ключей: разница счётчиков, два входа складываются', () => {
  const { computeKeyRates } = require('../src/core/parser');
  const prev = { 'u1-xhttp': { up: 100, down: 1000 }, 'u1-vision': { up: 0, down: 0 }, k2: { up: 50, down: 50 } };
  const cur = { 'u1-xhttp': { up: 200, down: 2000 }, 'u1-vision': { up: 100, down: 1000 }, k2: { up: 50, down: 50 } };
  assert.deepEqual(computeKeyRates(prev, cur, 10), { u1: { upBps: 20, downBps: 200 }, k2: { upBps: 0, downBps: 0 } });
});

test('скорость ключей: рестарт и новый ключ не дают ложных всплесков', () => {
  const { computeKeyRates } = require('../src/core/parser');
  assert.deepEqual(computeKeyRates({ k: { up: 1000, down: 1000 } }, { k: { up: 10, down: 10 } }, 10), {});
  assert.deepEqual(computeKeyRates({}, { k: { up: 10, down: 10 } }, 10), {});
  assert.deepEqual(computeKeyRates(null, { k: { up: 10, down: 10 } }, 10), {});
  assert.deepEqual(computeKeyRates({ k: { up: 1, down: 1 } }, null, 10), {});
});

test('монитор: скорость ключей попадает в состояние', async () => {
  let n = 0;
  const stats = () => `{"stat":[{"name":"user>>>k>>>traffic>>>downlink","value":"${(n += 1) * 1000}"}]}`;
  const { parseSections } = require('../src/core/parser');
  void parseSections;
  const body = () => `@@hostname\nx\n@@meminfo\n@@stats\n${stats()}\n`;
  const { ServerMonitor: M } = require('../src/core/monitor');
  const { TrafficStore: T } = require('../src/core/traffic-store');
  const m = new M({ id: 'a', name: 'A', role: 'r', host: 'h', services: [], ports: [], statsPort: 10085, exitHost: null }, { connect: async () => ({ exec: async () => body(), close() {} }), store: new T(), onUpdate() {}, pollMs: 1000, slowEvery: 6 });
  await m.pollOnce(1000);
  await m.pollOnce(11000);
  assert.equal(m.publicState().keyRates.k.downBps, 100);
});

// --- Вход по паролю и закрытие внутренних адресов ---

test('статус входа по паролю читается из sshd -T', () => {
  const { parseSnapshot } = require('../src/core/parser');
  const of = (a, b) => parseSnapshot(`@@hostname\nx\n@@ssh_auth\npasswordauthentication ${a}\npermitrootlogin ${b}\n`).passwordAuth;
  assert.equal(of('yes', 'yes'), true);
  assert.equal(of('no', 'yes'), false);
  assert.equal(of('yes', 'without-password'), false);
  assert.equal(parseSnapshot('@@hostname\nx\n').passwordAuth, undefined);
  const { buildScript } = require('../src/core/remote-script');
  const srv = { services: [], statsPort: null, exitHost: null };
  assert.ok(buildScript(srv, { slow: true }).includes('@@ssh_auth'));
  assert.ok(!buildScript(srv).includes('@@ssh_auth'));
});

function fakeSsh({ keyLoginFails = false } = {}) {
  const log = [];
  let connects = 0;
  const connect = async () => {
    connects += 1;
    if (keyLoginFails && connects > 1) throw new Error('нет входа');
    return {
      exec: async (cmd) => {
        const m = cmd.match(/echo (\S+) \| base64 -d/);
        log.push(m ? Buffer.from(m[1], 'base64').toString() : cmd);
        return 'ok\n@@rc=0\n';
      },
      close() {},
    };
  };
  return { log, connect };
}

test('вход по паролю: включение и выключение меняют только свой файл', async () => {
  const { setPasswordLogin } = require('../src/core/server-actions');
  const on = fakeSsh();
  await setPasswordLogin(on.connect, { host: 'h' }, true);
  assert.match(on.log[0], /PasswordAuthentication yes/);
  assert.match(on.log[0], /PermitRootLogin yes/);
  assert.match(on.log[0], /sshd_config\.d\/00-vpsmon-auth\.conf/);
  assert.ok(!/>\s*\/etc\/ssh\/sshd_config\s/.test(on.log[0]));
  const off = fakeSsh();
  await setPasswordLogin(off.connect, { host: 'h' }, false);
  assert.match(off.log[0], /PasswordAuthentication no/);
  assert.match(off.log[0], /PermitRootLogin prohibit-password/);
  assert.match(off.log[0], /KbdInteractiveAuthentication no/);
});

test('вход по паролю: защитный таймер снимается только после нового входа', async () => {
  const { setPasswordLogin } = require('../src/core/server-actions');
  const ok = fakeSsh();
  await setPasswordLogin(ok.connect, { host: 'h' }, false);
  assert.ok(ok.log[0].indexOf('systemd-run --on-active=120') < ok.log[0].indexOf('> "$F"'));
  assert.match(ok.log[1], /systemctl stop vpsmon-ssh-guard\.timer/);
  const bad = fakeSsh({ keyLoginFails: true });
  await assert.rejects(setPasswordLogin(bad.connect, { host: 'h' }, false), /вернётся/);
  assert.equal(bad.log.length, 1);
});

test('нельзя лишиться доступа: ключ приложения не удаляется при выключенном пароле', () => {
  const { assertCanDropAppKey } = require('../src/core/server-actions');
  assert.doesNotThrow(() => assertCanDropAppKey({ passwordAuth: true }));
  assert.throws(() => assertCanDropAppKey({ passwordAuth: false }), /вход по паролю/i);
  assert.throws(() => assertCanDropAppKey({}), /вход по паролю/i);
});

// --- Доработки ---

test('лимит: объём до учёта входит в период, в котором начат учёт', () => {
  const { computeLimit: cl } = require('../src/core/limits');
  const r = { since: '2026-11-08', baseline: { __server__: { up: 1e11, down: 2e11 } }, days: { '2026-11-08': { __server__: { up: 1e10, down: 0 } } } };
  const nov = new Date(2026, 10, 9);
  const got = cl(r, { tb: 1, resetDay: 1, mode: 'both' }, nov);
  assert.equal(got.usedBytes, 3.1e11);
  assert.equal(got.includesBaseline, true);
  assert.equal(cl(r, { tb: 1, resetDay: 1, mode: 'down' }, nov).usedBytes, 2e11);
  const dec = cl(r, { tb: 1, resetDay: 1, mode: 'both' }, new Date(2026, 11, 2));
  assert.equal(dec.usedBytes, 0);
  assert.equal(dec.includesBaseline, false);
});

test('лимит: значение из панели хостера действует только в своём периоде', () => {
  const { computeLimit: cl, withPanelUsage } = require('../src/core/limits');
  const r = { since: '2026-11-08', baseline: {}, days: { '2026-11-08': { __server__: { up: 1e11, down: 0 } } } };
  const now = new Date(2026, 10, 9);
  const limit = withPanelUsage({ tb: 1, resetDay: 1, mode: 'both' }, r, 0.4, now);
  assert.equal(cl(r, limit, now).usedBytes, 4e11);
  assert.equal(cl(r, limit, new Date(2026, 11, 2)).usedBytes, 0);
  const lower = withPanelUsage({ tb: 1, resetDay: 1, mode: 'both' }, r, 0.05, now);
  assert.equal(cl(r, lower, now).usedBytes, 5e10);
});

test('план: только IPv4, без дублей портов и служебного порта', () => {
  const { validatePlan, serverIdFor } = require('../src/core/provision/validate');
  const bad = (fn) => { const p = singlePlan(); fn(p.targets[0]); return () => validatePlan(p); };
  assert.throws(bad((t) => { t.host = 'example.com'; }), /адрес/i);
  assert.throws(bad((t) => { t.host = '999.1.1.1'; }), /адрес/i);
  assert.throws(bad((t) => { t.ports.single.vision = 443; }), /дважды/i);
  assert.throws(bad((t) => { t.ports.single.vision = 10085; }), /служебн/i);
  assert.notEqual(serverIdFor('1.2.3.45'), serverIdFor('12.3.4.5'));
});

test('предпроверка: без ss занятые порты определить нельзя', () => {
  assert.match(parsePrecheck(`${clean}ss=no\n`, [443]).problems.join(), /ss/);
});

test('шаги: разрешены все порты SSH, сбой fail2ban не прерывает установку', async () => {
  const { log, ctx } = fakeWorld();
  await runSteps(buildSteps(singlePlan()), ctx, () => {});
  const fw = scripts(log).find((s) => s.includes('# step:firewall'));
  assert.match(fw, /for p in \$\(sshd -T[^)]*\) 22; do ufw allow "\$p\/tcp"/);
  const f2b = scripts(log).find((s) => s.includes('# step:fail2ban'));
  assert.match(f2b, /systemctl enable --now fail2ban \|\|/);
  assert.match(f2b, /systemctl restart fail2ban \|\|/);
});

// --- Находки ревью ---

const stuck = clean.replace('xray=no', 'xray=yes').replace('busy=', 'busy=443').replace('manifest=none', 'manifest=incomplete');

test('незавершённая установка: сообщается одна причина, с очисткой проблем нет', () => {
  const p = parsePrecheck(stuck, [443]).problems;
  assert.equal(p.length, 1);
  assert.match(p[0], /не завершена/);
  assert.deepEqual(parsePrecheck(stuck, [443], { ignoreIncomplete: true }).problems, []);
});

test('незавершённая установка: очистка и новая предпроверка, затем установка', async () => {
  const answers = [stuck, clean];
  const { log, ctx } = fakeWorld({ precheck: () => answers.shift() });
  const r = await runSteps(buildSteps({ ...singlePlan(), cleanIncomplete: true }), ctx, () => {});
  assert.equal(r.ok, true, r.error);
  const s = scripts(log);
  const removeAt = s.findIndex((x) => x.includes('# step:remove'));
  assert.ok(removeAt > 0 && removeAt < s.findIndex((x) => x.includes('# step:app-key')));
  assert.equal(s.filter((x) => x.includes('# step:precheck')).length, 2);
});

test('незавершённая установка: занятый после очистки сервер останавливается', async () => {
  const answers = [stuck, clean.replace('busy=', 'busy=443')];
  const { ctx } = fakeWorld({ precheck: () => answers.shift() });
  const r = await runSteps(buildSteps({ ...singlePlan(), cleanIncomplete: true }), ctx, () => {});
  assert.equal(r.failedStep, 'precheck');
});

test('откат: упавший шаг ключа убирает за собой и удаляет локальный файл', async () => {
  const { log, ctx } = fakeWorld({ failKeyConnect: true });
  const deleted = [];
  ctx.deleteKey = (id) => deleted.push(id);
  const r = await runSteps(buildSteps(singlePlan()), ctx, () => {});
  assert.equal(r.failedStep, 'app-key');
  assert.ok(scripts(log).some((s) => s.includes('# step:remove')));
  assert.deepEqual(deleted, ['n1']);
});

test('откат: при оборванном соединении подключается заново и проходит по всем серверам', async () => {
  const { log, ctx } = fakeWorld({ failOn: '# step:xray', killOnFail: true });
  const r = await runSteps(buildSteps(cascadePlan()), ctx, () => {});
  assert.equal(r.failedStep, 'xray');
  const removed = log.filter((x) => x.kind === 'exec' && x.script.includes('# step:remove')).map((x) => x.host).sort();
  assert.deepEqual(removed, ['1.1.1.1', '2.2.2.2']);
});

test('скрипт шага ограничен таймаутом меньше таймаута приложения', async () => {
  const { log, ctx } = fakeWorld();
  await runSteps(buildSteps(singlePlan()), ctx, () => {});
  const xray = log.find((x) => x.kind === 'exec' && x.script.includes('# step:xray'));
  assert.match(xray.raw, /\| timeout 290 bash/);
  const script = fs.readFileSync(path.join(__dirname, '../server/provision/install-xray.sh'), 'utf8');
  const budget = [...script.matchAll(/--retry (\d+) --max-time (\d+)/g)].reduce((sum, m) => sum + (Number(m[1]) + 1) * Number(m[2]), 0);
  assert.ok(budget < 290, `curl может занять ${budget} с`);
});

test('SNI: выбранный домен проверяется повторно', async () => {
  const { ctx } = fakeWorld({ sniRecheckEmpty: true });
  const r = await runSteps(buildSteps(singlePlan()), ctx, () => {});
  assert.equal(r.failedStep, 'sni');
  assert.match(r.error, /near\.com/);
});

test('файрвол: защитный таймер снимается перед повтором и взводится первым', async () => {
  const { log, ctx } = fakeWorld();
  await runSteps(buildSteps(singlePlan()), ctx, () => {});
  const fw = scripts(log).find((s) => s.includes('# step:firewall'));
  assert.ok(fw.indexOf('systemctl stop vpsmon-ufw-guard.timer') < fw.indexOf('systemd-run'));
  assert.ok(fw.indexOf('systemd-run') < fw.indexOf('ufw default deny'));
});

test('отвязанный запуск: переживает обрыв и читает результат', async () => {
  const { runDetached } = require('../src/core/provision/remote-run');
  let connects = 0;
  const commands = [];
  const connect = async () => {
    connects += 1;
    if (connects === 2) throw new Error('нет связи');
    return {
      exec: async (cmd) => { commands.push(cmd); return cmd.startsWith('cat ') ? (connects >= 3 ? '{"removed":[]}\n' : '') : ''; },
      close() {},
    };
  };
  let first = true;
  const wrapped = async (...a) => { const t = await connect(...a); if (first) { first = false; const e = t.exec; let n = 0; t.exec = async (c) => { n += 1; if (n === 2) throw new Error('обрыв'); return e(c); }; } return t; };
  const out = await runDetached(wrapped, { host: 'h' }, 'print(1)', '--x', { pollMs: 1, deadlineMs: 500 });
  assert.equal(out.assumed, false);
  assert.match(out.text, /removed/);
  assert.match(commands[0], /setsid nohup/);
});

test('отвязанный запуск: отказ по ключу после удаления ключа считается успехом', async () => {
  const { runDetached } = require('../src/core/provision/remote-run');
  let n = 0;
  const connect = async () => {
    n += 1;
    if (n > 1) throw Object.assign(new Error('auth'), { level: 'client-authentication' });
    return { exec: async (cmd) => { if (cmd.startsWith('cat ')) throw new Error('обрыв'); return ''; }, close() {} };
  };
  const out = await runDetached(connect, { host: 'h' }, 'x', '--drop-app-key', { pollMs: 1, deadlineMs: 500, keyRemoved: true });
  assert.equal(out.assumed, true);
  n = 0;
  await assert.rejects(runDetached(connect, { host: 'h' }, 'x', '', { pollMs: 1, deadlineMs: 60 }));
});

// --- Проверка плана и монитор ---

test('план: проверка ввода', () => {
  const { validatePlan } = require('../src/core/provision/validate');
  const good = singlePlan();
  assert.doesNotThrow(() => validatePlan(good));
  const bad = (fn) => { const p = singlePlan(); fn(p.targets[0]); return () => validatePlan(p); };
  assert.throws(bad((t) => { t.host = '1.1.1.1;id'; }), /адрес/i);
  assert.throws(bad((t) => { t.ports.single.xhttp = 22; }), /порт/i);
  assert.throws(bad((t) => { t.ports.single.xhttp = 70000; }), /порт/i);
  assert.throws(bad((t) => { t.limit.tb = 0; }), /лимит/i);
  assert.throws(bad((t) => { t.limit.resetDay = 32; }), /день/i);
  assert.throws(bad((t) => { t.password = ''; }), /пароль/i);
  const c = cascadePlan();
  c.targets[1].host = c.targets[0].host;
  assert.throws(() => validatePlan(c), /разные/i);
});

test('монитор: лимит виден и добавляет предупреждение', () => {
  const { ServerMonitor } = require('../src/core/monitor');
  const { TrafficStore, dateKey } = require('../src/core/traffic-store');
  const day = dateKey(new Date());
  const m = new ServerMonitor({ id: 'a', name: 'A', role: 'r', host: 'h', services: [], ports: [], statsPort: null, exitHost: null, managed: true, modes: ['single'], limit: { tb: 1, resetDay: 1, mode: 'both' } }, { connect: async () => ({}), store: new TrafficStore(), onUpdate() {}, pollMs: 1000, slowEvery: 6 });
  m.remoteTraffic = { counters: {}, baseline: {}, since: day, days: { [day]: { __server__: { up: 5e11, down: 4.6e11 } } } };
  m.state.connection = 'online';
  m.state.snapshot = { services: {}, listening: [], stats: null, disk: null, mem: { total: null } };
  const s = m.publicState();
  assert.equal(s.limit.level, 'warn95');
  assert.equal(s.managed, true);
  assert.ok(s.health.problems.some((p) => p.key === 'limit95'));
  assert.equal(s.health.level, 'warn');
});

// --- Скрипты на Python ---

function py(file, env, input) {
  return spawnSync('python', [path.join(__dirname, '..', file), ...(input ?? [])], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('remove.py: без манифеста удаляется только сборщик', () => {
  const root = tmp();
  const f = (p, t = 'x') => { const full = path.join(root, p); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, t); return full; };
  const conf = f('usr/local/etc/xray/config.json');
  const coll = f('usr/local/lib/vpsmon/collector.py');
  const data = f('var/lib/vpsmon/traffic.json');
  const r = py('server/provision/remove.py', { VPSMON_ROOT: root, VPSMON_NO_SYSTEM: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(conf));
  assert.ok(!fs.existsSync(coll));
  assert.ok(!fs.existsSync(data));
});

test('remove.py: удаляет только перечисленное и не выходит за разрешённые пути', () => {
  const root = tmp();
  const f = (p, t = 'x') => { const full = path.join(root, p); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, t); return full; };
  const conf = f('usr/local/etc/xray/config.json');
  const other = f('usr/local/etc/other.conf');
  const evil = f('etc/passwd');
  const auth = f('root/.ssh/authorized_keys', 'ssh-ed25519 MINE me\nssh-ed25519 APP vpsmon\n');
  f('var/lib/vpsmon/manifest.json', JSON.stringify({ status: 'complete', files: ['/usr/local/etc/xray/config.json', '/etc/passwd'], ufwRules: [], units: [], appKey: 'ssh-ed25519 APP vpsmon' }));
  const r = py('server/provision/remove.py', { VPSMON_ROOT: root, VPSMON_NO_SYSTEM: '1' }, ['--drop-app-key']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(conf));
  assert.ok(fs.existsSync(other));
  assert.ok(fs.existsSync(evil));
  assert.equal(fs.readFileSync(auth, 'utf8'), 'ssh-ed25519 MINE me\n');
});

test('remove.py: только ключ доступа, остальное на месте', () => {
  const root = tmp();
  const f = (p, t = 'x') => { const full = path.join(root, p); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, t); return full; };
  const conf = f('usr/local/etc/xray/config.json');
  const auth = f('root/.ssh/authorized_keys', 'ssh-ed25519 APP vpsmon\nssh-ed25519 MINE me\n');
  f('var/lib/vpsmon/manifest.json', JSON.stringify({ status: 'complete', files: ['/usr/local/etc/xray/config.json'], ufwRules: [], units: [], appKey: 'ssh-ed25519 APP vpsmon' }));
  const r = py('server/provision/remove.py', { VPSMON_ROOT: root, VPSMON_NO_SYSTEM: '1' }, ['--only-app-key']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(conf));
  assert.equal(fs.readFileSync(auth, 'utf8'), 'ssh-ed25519 MINE me\n');
});

function keysScript(request, config) {
  const code = fs.readFileSync(path.join(__dirname, '../src/core/xray-keys.py'), 'utf8')
    .replace('__REQUEST__', Buffer.from(JSON.stringify(request)).toString('base64'));
  const wrapper = `import json,sys,types
sys.modules.setdefault('fcntl',types.ModuleType('fcntl'))
src=sys.stdin.read()
src=src.split("try:\\n    print(json.dumps({'ok'")[0]
g={}
exec(src,g)
c=json.loads(${JSON.stringify(JSON.stringify(config))})
g['public_key']=lambda p:'PB'
req=g['REQUEST']
if req['action']=='add': g['add_key'](c,req['name'],req['uuid'],req.get('profile'))
if req['action']=='delete': g['delete_key'](c,req['name'])
print(json.dumps(g['inventory'](c)))
`;
  const r = spawnSync('python', ['-c', wrapper], { input: code, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const inbound = (tag, net, clients) => ({ tag, port: 1, protocol: 'vless', settings: { clients }, streamSettings: { network: net, realitySettings: { privateKey: 'K', serverNames: ['s'], shortIds: ['a'] } } });

test('ключи: старый формат без режимов работает как раньше', () => {
  const inv = keysScript({ action: 'add', name: 'k2', uuid: 'N' }, { inbounds: [inbound('i1', 'xhttp', [{ id: 'A', email: 'u1-xhttp' }]), inbound('i2', 'tcp', [{ id: 'A', email: 'u1-vision', flow: 'f' }])] });
  assert.deepEqual(inv.keys.map((k) => k.name), ['k2', 'u1']);
  assert.equal(inv.keys[0].entries.length, 2);
});

test('ключи: ключ режима не попадает в другой режим, вход от входного не клиентский', () => {
  const cfg = { inbounds: [inbound('single-xhttp', 'xhttp', [{ id: 'A', email: 's1' }]), inbound('cascade-xhttp', 'xhttp', [{ id: 'B', email: 'c1' }]), inbound('from-entry', 'tcp', [{ id: 'E', email: 'entry' }])] };
  const inv = keysScript({ action: 'add', name: 'n', uuid: 'N', profile: 'single' }, cfg);
  const n = inv.keys.find((k) => k.name === 'n');
  assert.deepEqual(n.entries.map((e) => e.tag), ['single-xhttp']);
  assert.ok(!inv.keys.some((k) => k.name === 'entry'));
});
