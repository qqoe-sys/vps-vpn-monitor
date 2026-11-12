'use strict';
// Шаги настройки сервера. SSH приходит снаружи (ctx.connect), поэтому всё проверяется подделкой.
// План: { targets: [{ id, name, host, password, role: 'single'|'entry'|'exit', modes, ports, limit, sni? }] }

const fs = require('node:fs');
const path = require('node:path');
const { buildEntryConfig, buildExitConfig } = require('./xray-config');
const { rankSni, DEFAULT_SNI_CANDIDATES } = require('./sni');
const { collectorInstallScript } = require('./collector-script');

const SERVER_DIR = path.join(__dirname, '../../../server/provision');
const readServerFile = (name) => fs.readFileSync(path.join(SERVER_DIR, name), 'utf8');
const b64 = (text) => Buffer.from(text).toString('base64');
const MANIFEST = '/usr/local/lib/vpsmon/manifest.py';
const STATS_PORT = 10085;
const MIN_DISK_MB = 1000;
const SUPPORTED = { ubuntu: ['22.04', '24.04'], debian: ['12'] };
const APT = 'DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=180';

// Выполняет скрипт на сервере. Код завершения передаётся маркером @@rc в выводе.
async function runOn(transport, command, timeoutMs) {
  const output = await transport.exec(`${command} 2>&1; echo "@@rc=$?"`, timeoutMs);
  const m = output.match(/@@rc=(\d+)\s*$/);
  if (!m) throw new Error('Связь с сервером оборвалась во время шага');
  const text = output.slice(0, m.index).trim();
  if (m[1] !== '0') throw new Error(text.slice(-400) || `Команда завершилась с кодом ${m[1]}`);
  return text;
}

// timeout на сервере короче ожидания приложения: зависший скрипт не продолжит работать во время отката.
const sh = (t, script, timeoutMs = 120000) => runOn(
  t.transport,
  `echo ${b64(script)} | base64 -d | timeout ${Math.floor(timeoutMs / 1000) - 10} bash`,
  timeoutMs,
);

function py(t, code, args = [], timeoutMs = 120000) {
  return runOn(t.transport, `echo ${b64(code)} | base64 -d | python3 - ${args.join(' ')}`, timeoutMs);
}

function parsePrecheck(text, ports, { ignoreIncomplete = false } = {}) {
  const v = Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
  const problems = [];
  if (!SUPPORTED[v.os]?.includes(v.ver)) problems.push(`ОС ${v.os} ${v.ver} не поддерживается`);
  if (!['x86_64', 'aarch64'].includes(v.arch)) problems.push(`Неподдерживаемая архитектура: ${v.arch}`);
  // Xray и занятые порты от незавершённой установки — наши собственные следы, а не конфликт.
  const incomplete = v.manifest === 'incomplete';
  if (v.xray === 'yes' && !incomplete) problems.push('На сервере уже есть Xray: настройка поверх него отключена');
  if (v.busy && !incomplete) problems.push(`Порты уже заняты: ${v.busy}`);
  if (v.ss === 'no') problems.push('На сервере нет утилиты ss (пакет iproute2): нельзя проверить порты');
  if (Number(v.disk_mb) < MIN_DISK_MB) problems.push('Мало места на диске');
  if (incomplete && !ignoreIncomplete) problems.push('Прошлая установка не завершена');
  if (v.manifest === 'complete') problems.push('Сервер уже настроен этой программой');
  return { ...v, problems };
}

// У входа мастера замены порты уже списком (из снимка старого входа), у остальных — по режимам.
const portsOf = (t) => {
  if (Array.isArray(t.ports)) return t.ports;
  return t.role === 'exit' ? [t.ports.exit] : t.modes.flatMap((m) => [t.ports[m].xhttp, t.ports[m].vision]);
};
const exitOf = (plan) => plan.targets.find((t) => t.role === 'exit');

function firewallScript(t, plan) {
  const entry = plan.targets.find((x) => x.role === 'entry');
  const rules = t.role === 'exit'
    ? [`allow from ${entry.host} to any port ${t.ports.exit} proto tcp`]
    : portsOf(t).map((p) => `allow ${p}/tcp`);
  return `# step:firewall
set -e
python3 ${MANIFEST} add ufwRules ${rules.map((r) => `'${r}'`).join(' ')}
systemctl stop vpsmon-ufw-guard.timer 2>/dev/null || true
systemctl reset-failed vpsmon-ufw-guard.service 2>/dev/null || true
systemd-run --on-active=180 --unit=vpsmon-ufw-guard /usr/sbin/ufw --force disable
ufw default deny incoming
ufw default allow outgoing
for p in $(sshd -T 2>/dev/null | awk '/^port /{print $2}') 22; do ufw allow "$p/tcp"; done
${rules.map((r) => `ufw ${r}`).join('\n')}
ufw --force enable
`;
}

function configFor(t, plan, ctx) {
  if (t.role === 'exit') {
    const uuid = ctx.uuid();
    const shortId = ctx.randomHex(8);
    ctx.exit = { host: t.host, port: t.ports.exit, uuid, publicKey: t.xrayKeys.publicKey, sni: t.sni, shortId };
    return buildExitConfig({ port: t.ports.exit, uuid, sni: t.sni, shortId, privateKey: t.xrayKeys.privateKey });
  }
  const profiles = t.modes.map((mode) => ({
    mode,
    xhttpPort: t.ports[mode].xhttp,
    visionPort: t.ports[mode].vision,
    xhttpPath: `/${ctx.randomHex(4)}`,
    sni: t.sni,
    shortId: ctx.randomHex(8),
    privateKey: t.xrayKeys.privateKey,
    clients: [{ name: `${mode}01`, uuid: ctx.uuid() }],
  }));
  return buildEntryConfig({ profiles, statsPort: STATS_PORT, exit: ctx.exit });
}

function serverRecord(t, plan) {
  const exit = exitOf(plan);
  const ROLE = { single: 'Одиночный VPN', exit: 'Выход', entry: `Вход → ${exit?.name}` };
  const isExit = t.role === 'exit';
  return {
    id: t.id,
    name: t.name,
    role: ROLE[t.role],
    host: t.host,
    user: 'root',
    keyPath: t.keyPath,
    services: ['xray'],
    ports: portsOf(t),
    statsPort: isExit ? null : STATS_PORT,
    exitHost: t.role === 'entry' ? exit.host : null,
    modes: t.modes,
    limit: t.limit,
    managed: true,
  };
}

function closeAll(plan) {
  for (const t of plan.targets) {
    try { t.transport?.close(); } catch { /* соединение уже закрыто */ }
    t.transport = null;
  }
}

// Откат идёт по живому соединению; если оно оборвалось, подключаемся заново.
async function rollbackTarget(t, ctx) {
  const ways = [
    async () => t.transport,
    async () => ctx.connect(t, { keyPath: t.keyPath }),
    async () => ctx.connect(t, { password: t.password }),
  ];
  let last;
  for (const open of ways) {
    try {
      t.transport = await open();
      await py(t, readServerFile('remove.py'), ['--drop-app-key']);
      return;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}


// --- Шаговые фабрики ---
// Каждая принимает список серверов (targets) и возвращает шаг { id, title, run, undo? }.
// Ими пользуются мастер добавления (buildSteps) и мастер замены входа (replace/steps.js).

// Выполняет fn по очереди для каждого сервера списка.
const eachOf = (targets) => (fn) => async (ctx) => {
  for (const t of targets) await fn(t, ctx);
};

const stepConnect = (targets) => ({
  id: 'connect',
  title: 'Подключение по паролю',
  run: eachOf(targets)(async (t, ctx) => { t.transport = await ctx.connect(t, { password: t.password }); }),
});

function stepPrecheck(targets, { cleanIncomplete = false } = {}) {
  return {
    id: 'precheck',
    title: 'Проверка сервера',
    run: async () => {
      // Сначала проверяем все серверы, чтобы при конфликте ни один не был изменён.
      const check = async (ignoreIncomplete) => {
        const problems = [];
        for (const t of targets) {
          const out = await sh(t, `export PORTS='${portsOf(t).join(' ')}'\n${readServerFile('precheck.sh')}`);
          const res = parsePrecheck(out, portsOf(t), { ignoreIncomplete });
          problems.push(...res.problems.map((p) => `${t.host}: ${p}`));
          t.incomplete = res.manifest === 'incomplete';
        }
        if (problems.length) throw new Error(problems.join('; '));
      };
      await check(Boolean(cleanIncomplete));
      const dirty = targets.filter((t) => t.incomplete);
      for (const t of dirty) await py(t, readServerFile('remove.py'), ['--drop-app-key']);
      // После очистки смотрим заново: занятым порт мог быть не только из-за нас.
      if (dirty.length) await check(false);
    },
  };
}

const stepAppKey = (targets) => ({
  id: 'app-key',
  title: 'Ключ доступа приложения',
  undoOnFail: true,
  run: eachOf(targets)(async (t, ctx) => {
    const key = ctx.makeKey();
    t.keyPath = ctx.saveKey(t.id, key.private);
    t.keyStarted = true;
    await sh(t, `# step:app-key
set -e
command -v python3 >/dev/null || { ${APT} update; ${APT} install -y python3; }
install -d -m 700 /root/.ssh /var/lib/vpsmon
install -d -m 755 /usr/local/lib/vpsmon
echo ${b64(readServerFile('manifest.py'))} | base64 -d > ${MANIFEST}
python3 ${MANIFEST} init '${key.public}'
python3 ${MANIFEST} add files /usr/local/lib/vpsmon /var/lib/vpsmon
touch /root/.ssh/authorized_keys
[ -z "$(tail -c1 /root/.ssh/authorized_keys)" ] || echo >> /root/.ssh/authorized_keys
echo '${key.public}' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
`);
    const check = await ctx.connect(t, { keyPath: t.keyPath });
    check.close();
  }),
  undo: async (ctx) => {
    // Каждый сервер в своём try: сбой на одном не должен оставить второй неубранным.
    const errors = [];
    for (const t of targets.filter((x) => x.keyStarted)) {
      try {
        await rollbackTarget(t, ctx);
        ctx.deleteKey?.(t.id);
      } catch (err) {
        errors.push(`${t.host}: ${err.message}`);
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
  },
});

const stepFail2ban = (targets) => ({
  id: 'fail2ban',
  title: 'Защита от подбора пароля',
  run: eachOf(targets)((t) => sh(t, `# step:fail2ban
set -e
${APT} update
${APT} install -y ufw fail2ban unzip curl openssl iproute2
cat > /etc/fail2ban/jail.d/vpsmon.local <<'JAIL'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
JAIL
systemctl enable --now fail2ban || echo 'fail2ban не запустился, установка продолжается'
systemctl restart fail2ban || echo 'fail2ban не перезапустился'
`, 300000)),
});

const stepXray = (targets) => ({
  id: 'xray',
  title: 'Установка Xray',
  run: eachOf(targets)((t) => sh(t, readServerFile('install-xray.sh'), 300000)),
});

const stepSni = (targets) => ({
  id: 'sni',
  title: 'Подбор SNI',
  run: eachOf(targets)(async (t, ctx) => {
    if (t.sni) return;
    const request = b64(JSON.stringify({ candidates: DEFAULT_SNI_CANDIDATES, subnetScan: true }));
    const out = await py(t, readServerFile('sni-probe.py'), [request], 180000);
    const picked = await ctx.chooseSni(t, rankSni(JSON.parse(out)));
    if (!picked) throw new Error('SNI не выбран');
    // Домен могли ввести вручную, поэтому проверяем его теми же критериями.
    const recheck = b64(JSON.stringify({ candidates: [picked], subnetScan: false }));
    if (!rankSni(JSON.parse(await py(t, readServerFile('sni-probe.py'), [recheck], 60000))).length) {
      throw new Error(`Домен ${picked} не подходит для маскировки`);
    }
    t.sni = picked;
  }),
});

// configOf(t, ctx) возвращает объект конфига Xray; ключи Reality к этому моменту уже в t.xrayKeys.
const stepConfig = (targets, configOf) => ({
  id: 'config',
  title: 'Настройка Xray',
  run: eachOf(targets)(async (t, ctx) => {
    const keys = await sh(t, '# step:keygen\n/usr/local/bin/xray x25519');
    t.xrayKeys = {
      privateKey: keys.match(/^Private ?key:\s*(\S+)/im)?.[1],
      publicKey: keys.match(/^(?:Public key|Password(?: \(PublicKey\))?):\s*(\S+)/im)?.[1],
    };
    if (!t.xrayKeys.privateKey || !t.xrayKeys.publicKey) throw new Error('Не удалось создать ключи Xray');
    const config = JSON.stringify(configOf(t, ctx), null, 2);
    // Владелец root:xray, права 640, и xray run -test до того, как конфиг станет рабочим.
    await sh(t, `# step:config
set -e
TMP=/usr/local/etc/xray/.new.json
echo ${b64(config)} | base64 -d > "$TMP"
chgrp xray "$TMP"
chmod 640 "$TMP"
XRAY_LOCATION_ASSET=/usr/local/share/xray /usr/local/bin/xray run -test -config "$TMP" >/dev/null
mv "$TMP" /usr/local/etc/xray/config.json
systemctl enable xray
systemctl restart xray
`);
  }),
});

const stepSysctl = (targets) => ({
  id: 'sysctl',
  title: 'Ускорение сети (BBR)',
  run: eachOf(targets)((t) => sh(t, `# step:sysctl
set -e
python3 ${MANIFEST} add files /etc/sysctl.d/99-vpsmon.conf
printf 'net.core.default_qdisc=fq\\nnet.ipv4.tcp_congestion_control=bbr\\n' > /etc/sysctl.d/99-vpsmon.conf
sysctl -p /etc/sysctl.d/99-vpsmon.conf || true
`)),
});

const stepFirewall = (targets, plan) => ({
  id: 'firewall',
  title: 'Закрытие файрвола',
  run: eachOf(targets)(async (t, ctx) => {
    await sh(t, firewallScript(t, plan));
    // Новый вход доказывает, что файрвол нас не отрезал. Только потом снимаем защитный таймер.
    const check = await ctx.connect(t, { keyPath: t.keyPath });
    check.close();
    await sh(t, '# step:firewall-release\nsystemctl stop vpsmon-ufw-guard.timer');
  }),
});

// recordOf(t) — запись сервера для приложения: из неё сборщик берёт порт статистики.
const stepCollector = (targets, recordOf) => ({
  id: 'collector',
  title: 'Учёт трафика',
  run: eachOf(targets)((t) => sh(t, `python3 ${MANIFEST} add files /etc/systemd/system/vpsmon-collector.service /etc/systemd/system/vpsmon-collector.timer
python3 ${MANIFEST} add units vpsmon-collector.timer vpsmon-collector.service
${collectorInstallScript(recordOf(t), null)}`)),
});

// Проверка «Xray здоров» (логика xray_stable из server/cascade-tune.py): 5 опросов подряд раз в секунду
// ActiveState=active, а NRestarts не растёт. Одиночный «active» в цикле падений здоровьем не считается.
const XRAY_STABLE_PY = `# Xray здоров: need опросов подряд active и счётчик перезапусков не растёт.
import subprocess
import sys
import time


def show():
    out = subprocess.run(['systemctl', 'show', 'xray', '-p', 'ActiveState', '-p', 'NRestarts'],
                         capture_output=True, text=True).stdout
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


def stable(show=show, sleep=time.sleep, polls=20, need=5):
    streak, restarts = 0, None
    for _ in range(polls):
        sleep(1)
        s = show()
        if s.get('ActiveState') == 'active' and (restarts is None or s.get('NRestarts') == restarts):
            streak += 1
            restarts = s.get('NRestarts')
            if streak >= need:
                return True
        else:
            streak, restarts = 0, None
    return False


if __name__ == '__main__':
    sys.exit(0 if stable() else 1)
`;

// exitFor(t, ctx) → { host, port } выхода, который вход должен видеть по TCP, или null (не проверять).
const stepVerify = (targets, exitFor = () => null) => ({
  id: 'verify',
  title: 'Итоговая проверка',
  run: eachOf(targets)((t, ctx) => {
    const exit = exitFor(t, ctx);
    return sh(t, `# step:verify
set -e
echo ${b64(XRAY_STABLE_PY)} | base64 -d | python3 - || { echo 'Xray не держится запущенным: служба перезапускается или не стартует'; exit 1; }
for p in ${portsOf(t).join(' ')}; do
  ss -tlnH | awk '{print $4}' | grep -qE ":$p$" || { echo "Порт $p не слушается"; exit 1; }
done
${exit ? `timeout 6 bash -c '</dev/tcp/${exit.host}/${exit.port}' || { echo 'Вход не видит выходной сервер'; exit 1; }` : ''}
`);
  }),
});

function buildSteps(plan) {
  // Выход настраивается раньше: входу нужны его ключи.
  const targets = [...plan.targets].sort((a, b) => (b.role === 'exit') - (a.role === 'exit'));

  return [
    stepConnect(targets),
    stepPrecheck(targets, { cleanIncomplete: plan.cleanIncomplete }),
    stepAppKey(targets),
    stepFail2ban(targets),
    stepXray(targets),
    stepSni(targets),
    stepConfig(targets, (t, ctx) => configFor(t, plan, ctx)),
    stepSysctl(targets),
    stepFirewall(targets, plan),
    stepCollector(targets, (t) => serverRecord(t, plan)),
    stepVerify(targets, (t) => {
      if (t.role !== 'entry') return null;
      const exit = exitOf(plan);
      return { host: exit.host, port: exit.ports.exit };
    }),
    {
      id: 'finish',
      title: 'Завершение',
      run: async (ctx) => {
        for (const t of targets) await sh(t, `python3 ${MANIFEST} status complete`);
        ctx.result = { servers: plan.targets.map((t) => serverRecord(t, plan)) };
        closeAll(plan);
      },
    },
  ];
}

module.exports = {
  buildSteps, parsePrecheck, closeAll, portsOf,
  // Общее с мастером замены входа.
  sh, py, b64, runOn, readServerFile, firewallScript, rollbackTarget, serverRecord,
  APT, MANIFEST, STATS_PORT, XRAY_STABLE_PY,
  stepConnect, stepPrecheck, stepAppKey, stepFail2ban, stepXray, stepSni, stepConfig,
  stepSysctl, stepFirewall, stepCollector, stepVerify,
};
