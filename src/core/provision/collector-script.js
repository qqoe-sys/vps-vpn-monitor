'use strict';
// Скрипт установки сборщика трафика. Используется и мастером, и tools/install-collector.js.

const fs = require('node:fs');
const path = require('node:path');

const COLLECTOR = path.join(__dirname, '../../../server/collector.py');
const b64 = (text) => Buffer.from(text).toString('base64');

function collectorInstallScript(server, history) {
  const statsArg = server.statsPort ? ` --stats-port ${server.statsPort}` : '';
  return `# step:collector
set -e
install -d -m 755 /usr/local/lib/vpsmon
install -d -m 700 /var/lib/vpsmon
echo ${b64(fs.readFileSync(COLLECTOR, 'utf8'))} | base64 -d > /usr/local/lib/vpsmon/collector.py
chmod 755 /usr/local/lib/vpsmon/collector.py
${history ? `if [ ! -f /var/lib/vpsmon/traffic.json ]; then
  echo ${b64(JSON.stringify(history))} | base64 -d > /var/lib/vpsmon/traffic.json
  chmod 600 /var/lib/vpsmon/traffic.json
  echo '@E:col_history_moved'
fi` : "echo '@E:col_history_none'"}
cat > /etc/systemd/system/vpsmon-collector.service <<'UNIT'
[Unit]
Description=VPS-VPN Monitor traffic collector

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/lib/vpsmon/collector.py${statsArg}
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/vpsmon /run
UNIT
cat > /etc/systemd/system/vpsmon-collector.timer <<'UNIT'
[Unit]
Description=Run VPS-VPN Monitor traffic collector

[Timer]
OnBootSec=20
OnUnitActiveSec=30
AccuracySec=5

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now vpsmon-collector.timer
systemctl start vpsmon-collector.service
echo "@E:col_timer|$(systemctl is-active vpsmon-collector.timer)|$(systemctl show vpsmon-collector.service -p Result --value)"
ls -l /var/lib/vpsmon/traffic.json
`;
}

module.exports = { collectorInstallScript };
