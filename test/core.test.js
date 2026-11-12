'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { parseSnapshot, computeRates } = require('../src/core/parser');
const { TrafficStore } = require('../src/core/traffic-store');
const { computeHealth } = require('../src/core/health');
const { isKnownKey } = require('../src/core/known-hosts');
const { buildScript } = require('../src/core/remote-script');
const { ServerMonitor } = require('../src/core/monitor');

const SAMPLE = `@@hostname
msk
@@uptime
1000.5 900.1
@@loadavg
0.10 0.20 0.30 1/100 5
@@nproc
2
@@meminfo
MemTotal:       1000 kB
MemAvailable:    250 kB
@@df
Filesystem 1-blocks Used Available Capacity Mounted on
/dev/vda1 1000 300 700 30% /
@@stat
cpu  100 0 100 700 100 0 0 0 0 0
@@netdev
    lo: 5 0 0 0 0 0 0 0 7 0 0 0 0 0 0 0
  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
@@route
default via 1.1.1.1 dev eth0 proto static
@@conns
37
@@ports
LISTEN 0 128 0.0.0.0:22 0.0.0.0:*
LISTEN 0 4096 *:443 *:*
LISTEN 0 4096 [::]:8443 [::]:*
@@xray_show
NRestarts=1
ActiveEnterTimestamp=Mon 2026-11-02 10:24:57 UTC
@@xray_version
Xray 26.10.21 (Xray, Penetrates Everything.) 1b1647c
@@service:xray
active
@@stats
{"stat":[{"name":"user>>>k1>>>traffic>>>uplink","value":"10"},{"name":"user>>>k1>>>traffic>>>downlink"},{"name":"inbound>>>x>>>traffic>>>uplink","value":"99"}]}
@@link
ok 42
`;

const SERVER = { id: 'a', name: 'A', role: 'r', host: 'h', services: ['xray'], ports: [443], statsPort: 10085, exitHost: '1.2.3.4' };

test('разбирает снимок сервера', () => {
  const s = parseSnapshot(SAMPLE);
  assert.equal(s.iface, 'eth0');
  assert.deepEqual(s.net, { rx: 1000, tx: 2000 });
  assert.deepEqual(s.mem, { total: 1024000, available: 256000 });
  assert.deepEqual(s.disk, { total: 1000, used: 300, available: 700 });
  assert.deepEqual(s.listening, [22, 443, 8443]);
  assert.equal(s.xray.version, '26.10.21');
  assert.equal(s.xray.restarts, 1);
  assert.deepEqual(s.stats, { k1: { up: 10, down: 0 } });
  assert.deepEqual(s.link, { ok: true, ms: 42 });
});

test('неответивший API статистики это null, а секции нет вообще — тоже null', () => {
  assert.equal(parseSnapshot(SAMPLE.replace(/\{"stat.*\}/, '')).stats, null);
  assert.equal(parseSnapshot('@@hostname\nx\n').stats, null);
});

test('неполный ответ вызывает ошибку', () => {
  assert.throws(() => parseSnapshot('Connection reset'));
});

test('скорость и CPU считаются по разнице, сброс счётчика даёт null', () => {
  const a = { cpu: { idle: 800, total: 1000 }, net: { rx: 100, tx: 100 } };
  const b = { cpu: { idle: 850, total: 1100 }, net: { rx: 1100, tx: 50 } };
  const r = computeRates(a, b, 10);
  assert.equal(r.cpu, 50);
  assert.equal(r.rxBps, 100);
  assert.equal(r.txBps, null);
});

test('трафик: первый замер — база, рестарт Xray не теряет итог', () => {
  const store = new TrafficStore();
  const now = new Date(2026, 10, 8, 12);
  const snap = (up, down) => ({ net: null, stats: { k1: { up, down } } });
  store.update('a', snap(1000, 5000), now);
  store.update('a', snap(1100, 5300), now);
  store.update('a', snap(50, 70), now); // рестарт: счётчики стали меньше
  const [today] = store.summary('a', 1, now).users;
  assert.deepEqual([today.up, today.down, today.before], [150, 370, 6000]);
  const [all] = store.summary('a', 0, now).users;
  assert.deepEqual([all.up, all.down], [1150, 5370]);
});

test('трафик: ключ, появившийся позже, считается сразу', () => {
  const store = new TrafficStore();
  const now = new Date(2026, 10, 8, 12);
  store.update('a', { net: null, stats: { k1: { up: 100, down: 100 } } }, now);
  store.update('a', { net: null, stats: { k1: { up: 100, down: 100 }, k2: { up: 7, down: 9 } } }, now);
  const k2 = store.summary('a', 1, now).users.find((u) => u.name === 'k2');
  assert.deepEqual([k2.up, k2.down, k2.before], [7, 9, 0]);
});

test('трафик: старый файл получает объём до учёта при загрузке', () => {
  const store = new TrafficStore({ servers: { a: {
    counters: { __server__: { up: 500, down: 900 }, k1: { up: 60, down: 40 } },
    days: { '2026-11-08': { __server__: { up: 100, down: 100 }, k1: { up: 10, down: 10 } } },
  } } });
  const now = new Date(2026, 10, 8, 12);
  const s = store.summary('a', 0, now);
  assert.deepEqual(s.before, { up: 400, down: 800 });
  assert.deepEqual(s.total, { up: 500, down: 900 });
  assert.equal(s.since, '2026-11-08');
  assert.equal(s.users[0].before, 80);
  assert.deepEqual([s.users[0].up, s.users[0].down], [60, 40]);
  assert.deepEqual(s.range, ['2026-11-08']);
  assert.equal(store.summary('a', 7, now).range.length, 7);
  assert.deepEqual(store.summary('a', 7, now).users[0].days, { '2026-11-08': { up: 10, down: 10 } });
});

test('трафик: два входа одного ключа складываются', () => {
  const store = new TrafficStore();
  const now = new Date(2026, 10, 8, 12);
  store.update('a', { net: null, stats: { 'u1-xhttp': { up: 0, down: 0 }, 'u1-vision': { up: 0, down: 0 } } }, now);
  store.update('a', { net: null, stats: { 'u1-xhttp': { up: 5, down: 10 }, 'u1-vision': { up: 1, down: 2 } } }, now);
  const [u] = store.summary('a', 1, now).users;
  assert.deepEqual([store.summary('a', 1, now).users.length, u.name, u.up, u.down], [1, 'u1', 6, 12]);
});

test('сборщик на Python считает так же, как приложение', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const key = (up, down) => ({ up, down });
  const steps = [
    ['2026-11-08', { rx: 1000, tx: 500 }, { 'u1-xhttp': key(100, 200) }],
    ['2026-11-08', { rx: 1500, tx: 700 }, { 'u1-xhttp': key(150, 300), k2: key(7, 9) }],
    ['2026-11-09', { rx: 40, tx: 30 }, { 'u1-xhttp': key(5, 6), k2: key(7, 9) }], // рестарт
    ['2026-11-09', { rx: 90, tx: 50 }, null], // API не ответил
    ['2026-11-10', { rx: 90, tx: 50 }, { 'u1-xhttp': key(5, 6), k2: key(7, 19) }],
  ];
  const code = 'import importlib.util as u,sys,json\n'
    + 's=u.spec_from_file_location("c",sys.argv[1]);m=u.module_from_spec(s);s.loader.exec_module(m)\n'
    + 'r=m.new_state()\n'
    + 'for x in json.load(sys.stdin): m.update(r,*x)\n'
    + 'print(json.dumps(r))';
  const py = spawnSync('python', ['-c', code, path.join(__dirname, '../server/collector.py')], { input: JSON.stringify(steps), encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const store = new TrafficStore();
  for (const [day, net, stats] of steps) {
    store.update('a', { net, stats }, new Date(`${day}T12:00:00`));
  }
  assert.deepEqual(JSON.parse(py.stdout), JSON.parse(JSON.stringify(store.server('a'))));
});

test('монитор: со сборщиком берёт историю с сервера и сам не считает', async () => {
  const remote = {
    counters: { __server__: { up: 10, down: 20 } },
    days: { '2026-11-08': { __server__: { up: 5, down: 6 } } },
    baseline: { __server__: { up: 1, down: 2 } },
    since: '2026-11-08',
  };
  const store = new TrafficStore();
  const m = new ServerMonitor(SERVER, {
    connect: async () => ({ exec: async () => `${SAMPLE}@@traffic_store\n${JSON.stringify(remote)}\n`, close() {} }),
    store,
    onUpdate() {},
    pollMs: 1000,
    slowEvery: 6,
  });
  await m.pollOnce(1000);
  const s = m.trafficSummary(1, new Date(2026, 10, 8, 12));
  assert.equal(s.collector, true);
  assert.deepEqual(s.total, { up: 5, down: 6 });
  assert.deepEqual(store.data.servers, {});
  assert.equal(m.state.snapshot.trafficStore, undefined);
});

test('ключи: проверка имени и сборка ссылок', () => {
  const { validName, linksFor } = require('../src/core/xray-keys');
  assert.ok(validName('key08'));
  for (const bad of ['', 'a b', 'x;id', "a'b", 'u1-xhttp', 'k'.repeat(33), 5]) assert.ok(!validName(bad));
  const inv = {
    inbounds: [
      { tag: 'a', port: 443, net: 'xhttp', sni: 's.com', pbk: 'P', sid: 'S', path: '/', mode: 'auto', flow: null },
      { tag: 'b', port: 8443, net: 'tcp', sni: 's.com', pbk: 'P', sid: 'S', path: null, mode: null, flow: 'xtls-rprx-vision' },
    ],
    keys: [{ name: 'k', entries: [{ tag: 'a', id: 'U' }, { tag: 'b', id: 'U' }] }],
  };
  const links = linksFor({ host: '1.1.1.1' }, inv, 'k');
  assert.equal(links[0].url, 'vless://U@1.1.1.1:443?encryption=none&security=reality&type=xhttp&sni=s.com&fp=firefox&pbk=P&sid=S&path=%2F&mode=auto#k-xhttp');
  assert.equal(links[1].url, 'vless://U@1.1.1.1:8443?encryption=none&security=reality&type=tcp&sni=s.com&fp=firefox&pbk=P&sid=S&flow=xtls-rprx-vision#k-vision');
  assert.deepEqual(linksFor({ host: 'h' }, inv, 'нет'), []);
});

test('инвентарь: email клиента сохраняется', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  // Подставляем запрос в шаблон серверного скрипта и обрезаем перед main(), чтобы он не запускался.
  const code = fs.readFileSync(path.join(__dirname, '../src/core/xray-keys.py'), 'utf8')
    .replace('__REQUEST__', Buffer.from(JSON.stringify({ action: 'list' })).toString('base64'));
  const config = { inbounds: [{
    tag: 'x', port: 443, protocol: 'vless',
    settings: { clients: [{ id: 'U1', email: 'user1-xhttp' }, { id: 'U2', email: 'user2' }] },
    streamSettings: { network: 'xhttp', realitySettings: { serverNames: ['s'], shortIds: ['a'] } },
  }] };
  const wrapper = `import json,sys,types
sys.modules.setdefault('fcntl',types.ModuleType('fcntl'))
src=sys.stdin.read()
src=src.split("try:\\n    print(json.dumps({'ok'")[0]
g={}
exec(src,g)
print(json.dumps(g['inventory'](json.loads(${JSON.stringify(JSON.stringify(config))}))))
`;
  const r = spawnSync('python', ['-c', wrapper], { input: code, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const keys = JSON.parse(r.stdout).keys;
  assert.equal(keys[0].entries[0].email, 'user1-xhttp');
  assert.equal(keys[1].entries[0].email, 'user2');
});

test('трафик: фильтр по периоду', () => {
  const store = new TrafficStore();
  const day1 = new Date(2026, 10, 1, 12);
  const day8 = new Date(2026, 10, 8, 12);
  const snap = (n) => ({ net: { tx: n, rx: n }, stats: null });
  store.update('a', snap(0), day1);
  store.update('a', snap(100), day1);
  store.update('a', snap(130), day8);
  assert.deepEqual(store.summary('a', 7, day8).total, { up: 30, down: 30 });
  assert.deepEqual(store.summary('a', 0, day8).total, { up: 130, down: 130 });
});

test('здоровье: всё хорошо', () => {
  const snapshot = parseSnapshot(SAMPLE);
  const h = computeHealth(SERVER, { connection: 'online', snapshot, link: snapshot.link });
  assert.equal(h.level, 'ok');
});

test('здоровье: упавший Xray, порт и связка — проблема, диск — предупреждение', () => {
  const snapshot = parseSnapshot(SAMPLE);
  const bad = { ...snapshot, services: { xray: 'inactive' }, listening: [22] };
  const h = computeHealth(SERVER, { connection: 'online', snapshot: bad, link: { ok: false, ms: null } });
  assert.equal(h.level, 'down');
  assert.deepEqual(h.problems.map((p) => p.key), ['service:xray', 'port:443', 'link']);
  const full = { ...snapshot, disk: { total: 100, used: 95, available: 5 } };
  assert.equal(computeHealth(SERVER, { connection: 'online', snapshot: full, link: null }).level, 'warn');
});

test('known_hosts: совпадение, чужой ключ, хеш, отозванный', () => {
  const key = Buffer.from('real-key');
  const b64 = key.toString('base64');
  const other = Buffer.from('fake-key');
  const plain = `# comment\n1.1.1.1,example.com ssh-ed25519 ${b64}\n`;
  assert.ok(isKnownKey(plain, '1.1.1.1', key));
  assert.ok(!isKnownKey(plain, '1.1.1.1', other));
  assert.ok(!isKnownKey(plain, '2.2.2.2', key));
  const salt = crypto.randomBytes(20);
  const hash = crypto.createHmac('sha1', salt).update('9.9.9.9').digest('base64');
  assert.ok(isKnownKey(`|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${b64}\n`, '9.9.9.9', key));
  assert.ok(!isKnownKey(`${plain}@revoked 1.1.1.1 ssh-ed25519 ${b64}\n`, '1.1.1.1', key));
});

test('скрипт: отклоняет опасные значения, связка только в медленном опросе', () => {
  assert.throws(() => buildScript({ ...SERVER, services: ['x; rm -rf /'] }));
  assert.throws(() => buildScript({ ...SERVER, exitHost: '1.1.1.1;id' }));
  assert.ok(!buildScript(SERVER).includes('@@link'));
  assert.ok(buildScript(SERVER, { slow: true }).includes('/dev/tcp/1.2.3.4/443'));
  assert.ok(!buildScript(SERVER).includes('-reset'));
});

test('монитор: одновременные опросы идут по очереди', async () => {
  let active = 0;
  let peak = 0;
  const m = new ServerMonitor(SERVER, {
    connect: async () => ({
      exec: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return SAMPLE;
      },
      close() {},
    }),
    store: new TrafficStore(),
    onUpdate() {},
    pollMs: 1000,
    slowEvery: 6,
  });
  await Promise.all([m.pollNow(), m.pollNow(), m.pollNow()]);
  assert.equal(peak, 1);
  assert.equal(m.round, 3);
});

test('перезапуск Xray: команда отвязана от сессии, ждём active, падение сообщается', async () => {
  const { restartXray, rebootServer } = require('../src/core/server-actions');
  const timing = { firstCheckMs: 1, retryMs: 1, deadlineMs: 30 };
  const commands = [];
  const replies = [null, 'activating\n', 'active\n0\n', 'active\n0\n', 'active\n0\n'];
  const fakeConnect = (next) => async () => ({
    exec: async (cmd) => {
      commands.push(cmd);
      if (cmd.includes('is-active')) {
        const r = next();
        if (r === null) throw new Error('нет связи');
        return r;
      }
      return '';
    },
    close() {},
  });
  await restartXray(fakeConnect(() => replies.shift()), SERVER, timing);
  assert.match(commands[0], /setsid nohup .*systemctl restart xray/);
  await assert.rejects(restartXray(fakeConnect(() => 'failed\n'), SERVER, timing), /не запустился \(состояние: failed/);
  // Цикл падений: каждый раз active, но счётчик перезапусков растёт — это не успех.
  let n = 0;
  await assert.rejects(restartXray(fakeConnect(() => `active\n${n++}\n`), SERVER, timing), /не запустился/);
  commands.length = 0;
  await rebootServer(fakeConnect(() => ''), SERVER);
  assert.match(commands[0], /setsid nohup .*systemctl reboot/);
});

test('монитор: один сбой не offline, два — offline, затем восстановление', async () => {
  let fail = false;
  let connects = 0;
  const updates = [];
  const m = new ServerMonitor(SERVER, {
    connect: async () => {
      connects += 1;
      return { exec: async () => { if (fail) throw new Error('boom'); return SAMPLE; }, close() {} };
    },
    store: new TrafficStore(),
    onUpdate: (s) => updates.push(s),
    pollMs: 1000,
    slowEvery: 6,
  });
  await m.pollOnce(1000);
  assert.equal(m.state.connection, 'online');
  fail = true;
  await m.pollOnce(2000);
  assert.equal(m.state.connection, 'online');
  await m.pollOnce(3000);
  assert.equal(m.state.connection, 'offline');
  assert.equal(updates.at(-1).health.level, 'down');
  fail = false;
  await m.pollOnce(4000);
  assert.equal(m.state.connection, 'online');
  assert.equal(connects, 3);
});
