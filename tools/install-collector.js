'use strict';
// Ставит сборщик трафика на один сервер и переносит туда историю из приложения.
// Запуск: node tools/install-collector.js <id сервера>
// Уже существующую историю на сервере не перезаписывает, поэтому запускать повторно безопасно.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TrafficStore } = require('../src/core/traffic-store');
const { collectorInstallScript } = require('../src/core/provision/collector-script');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/servers.json'), 'utf8'));
const server = config.servers.find((s) => s.id === process.argv[2]);
if (!server) {
  console.error(`Укажи сервер: ${config.servers.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

function localHistory() {
  try {
    const raw = fs.readFileSync(path.join(process.env.APPDATA, 'vps-monitor', 'traffic.json'), 'utf8');
    // Конструктор заодно досчитает объём "до начала учёта" для старых файлов.
    return new TrafficStore(JSON.parse(raw)).data.servers[server.id] ?? null;
  } catch {
    return null;
  }
}

const result = spawnSync('ssh', [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-i', server.keyPath.replace('~', os.homedir()),
  `${server.user}@${server.host}`, 'bash -s',
], { input: collectorInstallScript(server, localHistory()), encoding: 'utf8', timeout: 60000 });

console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
console.log(result.status === 0 ? `Готово: ${server.name}` : `Ошибка установки: ${server.name}`);
process.exit(result.status === 0 ? 0 : 1);
