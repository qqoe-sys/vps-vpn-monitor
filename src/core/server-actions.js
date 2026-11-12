'use strict';
// Перезапуск Xray и перезагрузка сервера.
// Команда отвязана от SSH-сессии (setsid nohup): если твой ПК ходит через этот же VPN,
// соединение оборвётся, но команда всё равно выполнится.

const DEFAULT_TIMING = { firstCheckMs: 4000, retryMs: 2000, deadlineMs: 30000 };

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const detached = (command) => `(setsid nohup sh -c '${command}' </dev/null >/dev/null 2>&1 &)`;

async function sendOnce(connect, server, command) {
  const transport = await connect(server);
  try {
    await transport.exec(command, 10000);
  } finally {
    transport.close();
  }
}

async function xrayState(connect, server) {
  let transport;
  try {
    transport = await connect(server);
    return (await transport.exec('systemctl is-active xray', 8000)).trim();
  } catch {
    return null; // связи пока нет, это нормально сразу после перезапуска
  } finally {
    try { transport?.close(); } catch { /* уже закрыт */ }
  }
}

async function restartXray(connect, server, timing = DEFAULT_TIMING) {
  await sendOnce(connect, server, detached('sleep 1; systemctl restart xray'));
  await delay(timing.firstCheckMs);
  const deadline = Date.now() + timing.deadlineMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await xrayState(connect, server);
    if (state === 'active') return;
    await delay(timing.retryMs);
  }
  throw new Error(`Xray не запустился (состояние: ${state ?? 'нет связи'}). Посмотри журнал в терминале: journalctl -u xray -n 30`);
}

async function rebootServer(connect, server) {
  await sendOnce(connect, server, detached('sleep 2; systemctl reboot'));
}

const AUTH_FILE = '/etc/ssh/sshd_config.d/00-vpsmon-auth.conf';

function passwordScript(enabled) {
  const lines = enabled
    ? ['PasswordAuthentication yes', 'PermitRootLogin yes']
    : ['PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PermitRootLogin prohibit-password'];
  const reload = 'systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true';
  const backup = '/run/vpsmon-auth.bak';
  const restore = `if [ -f ${backup} ]; then cp ${backup} ${AUTH_FILE}; else rm -f ${AUTH_FILE}; fi`;
  return `set -e
F=${AUTH_FILE}
install -d -m 755 /etc/ssh/sshd_config.d /run/sshd
rm -f ${backup}
if [ -f "$F" ]; then cp "$F" ${backup}; fi
systemctl stop vpsmon-ssh-guard.timer 2>/dev/null || true
systemctl reset-failed vpsmon-ssh-guard.service 2>/dev/null || true
systemd-run --on-active=120 --unit=vpsmon-ssh-guard /bin/sh -c '${restore}; ${reload}'
printf '${lines.join('\\n')}\\n' > "$F"
chmod 644 "$F"
if ! sshd -t; then ${restore}; echo 'sshd отверг настройку'; exit 1; fi
GOT=$(sshd -T 2>/dev/null | awk '/^passwordauthentication /{print $2}')
if [ "$GOT" != "${enabled ? 'yes' : 'no'}" ]; then ${restore}; echo 'Настройка не применилась: другой файл sshd её перекрывает'; exit 1; fi
${reload}
`;
}

// Включает или выключает вход по паролю. Защитный таймер вернёт всё назад,
// если после изменения не удастся войти новым соединением.
async function setPasswordLogin(connect, server, enabled) {
  const first = await connect(server);
  try {
    const script = Buffer.from(passwordScript(enabled)).toString('base64');
    const out = await first.exec(`echo ${script} | base64 -d | bash 2>&1; echo "@@rc=$?"`, 30000);
    if (!/@@rc=0\s*$/.test(out)) throw new Error(out.replace(/@@rc=\d+\s*$/, '').trim().slice(-300) || 'Не удалось изменить настройку');
  } finally {
    first.close();
  }
  let check;
  try {
    check = await connect(server);
  } catch {
    throw new Error('После изменения не удалось войти заново. Настройка сама вернётся через 2 минуты');
  }
  try {
    await check.exec('systemctl stop vpsmon-ssh-guard.timer', 15000);
  } finally {
    check.close();
  }
}

const MIN_PASSWORD = 12;
const MAX_PASSWORD = 128;

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error(`Пароль должен быть не короче ${MIN_PASSWORD} символов`);
  if (password.length > MAX_PASSWORD) throw new Error(`Пароль должен быть не длиннее ${MAX_PASSWORD} символов`);
  // Перевод строки позволил бы дописать в chpasswd вторую запись.
  if (/[\r\n\0]/.test(password)) throw new Error('В пароле есть недопустимый символ');
}

// Пароль уходит только в стандартный ввод chpasswd: в командной строке его не видно.
async function changeRootPassword(connect, server, password, { verify }) {
  validateNewPassword(password);
  const transport = await connect(server);
  try {
    const out = await transport.exec('chpasswd 2>&1; echo "@@rc=$?"', 20000, `root:${password}\n`);
    if (!/@@rc=0\s*$/.test(out)) {
      const reason = out.replace(/@@rc=\d+\s*$/, '').split(password).join('***').trim().slice(-200);
      throw new Error(`Сервер не принял пароль: ${reason}`);
    }
  } finally {
    transport.close();
  }
  if (!verify) return;
  try {
    const check = await connect({ host: server.host, user: 'root' }, { password });
    check.close();
  } catch {
    throw new Error('Пароль изменён, но проверить вход новым паролем не удалось');
  }
}

// Ключ приложения нельзя убирать, если вход по паролю выключен: в сервер будет не войти.
function assertCanDropAppKey(state) {
  if (state?.passwordAuth !== true) {
    throw new Error('Сначала включи вход по паролю: иначе после удаления ключа на сервер будет не зайти');
  }
}

module.exports = { restartXray, rebootServer, setPasswordLogin, assertCanDropAppKey, validateNewPassword, changeRootPassword };
