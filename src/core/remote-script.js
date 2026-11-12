'use strict';
// Собирает shell-скрипт, который приложение запускает на сервере при каждом опросе.
// Скрипт только ЧИТАЕТ состояние. Каждая секция начинается с маркера "@@имя",
// чтобы парсер мог разрезать общий вывод на части.

const HOST_RE = /^[a-zA-Z0-9.-]+$/;
const SERVICE_RE = /^[a-zA-Z0-9_.@-]+$/;

function buildScript(server, { slow = false } = {}) {
  // Значения из конфига попадают в команду, поэтому сначала проверяем их формат:
  // так случайный символ в конфиге не превратится в чужую команду на сервере.
  for (const s of server.services) {
    if (!SERVICE_RE.test(s)) throw new Error(`Некорректное имя службы: ${s}`);
  }
  if (server.exitHost && !HOST_RE.test(server.exitHost)) {
    throw new Error(`Некорректный exitHost: ${server.exitHost}`);
  }
  if (server.statsPort !== null && !Number.isInteger(server.statsPort)) {
    throw new Error(`Некорректный statsPort: ${server.statsPort}`);
  }

  const lines = [
    'export LC_ALL=C',
    "echo '@@hostname'; hostname",
    "echo '@@uptime'; cat /proc/uptime",
    "echo '@@loadavg'; cat /proc/loadavg",
    "echo '@@nproc'; nproc",
    "echo '@@meminfo'; cat /proc/meminfo",
    "echo '@@df'; df -B1 -P /",
    "echo '@@stat'; head -1 /proc/stat",
    "echo '@@netdev'; tail -n +3 /proc/net/dev",
    "echo '@@route'; ip route show default",
    "echo '@@conns'; ss -tnH state established | wc -l",
    "echo '@@ports'; ss -tlnH",
    "echo '@@xray_show'; systemctl show xray -p ActiveEnterTimestamp -p NRestarts",
    "echo '@@xray_version'; xray version 2>/dev/null | head -1",
  ];
  for (const s of server.services) {
    lines.push(`echo '@@service:${s}'; systemctl is-active ${s}`);
  }
  if (server.statsPort) {
    // Без флага -reset: счётчики на сервере не обнуляются.
    lines.push(`echo '@@stats'; timeout 5 xray api statsquery --server=127.0.0.1:${server.statsPort} 2>/dev/null`);
  }
  if (slow) {
    // История трафика со сборщика. Если сборщик не установлен, секция будет пустой.
    lines.push("echo '@@traffic_store'; cat /var/lib/vpsmon/traffic.json 2>/dev/null; echo");
    lines.push("echo '@@ssh_auth'; sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin) '");
  }
  if (slow && server.exitHost) {
    // Раз в минуту проверяем, открывается ли TCP с входного сервера на выходной.
    // С ПК это не проверить: выход пускает на 443 только свои входы.
    lines.push(
      "echo '@@link'",
      's=$(date +%s%N)',
      `if timeout 4 bash -c '</dev/tcp/${server.exitHost}/443' 2>/dev/null; then e=$(date +%s%N); echo ok $(( (e-s)/1000000 )); else echo fail; fi`,
    );
  }
  return lines.join('\n') + '\n';
}

module.exports = { buildScript };
