'use strict';
// Публикация сайта подписок на сервер, установка Caddy, проверка DNS и кэш ключей входа.

const i18n = require('../i18n');
const dns = require('node:dns');
const fs = require('node:fs');
const { validPort, RESERVED_PORTS } = require('./subs-config');
const path = require('node:path');

const DEPLOY = fs.readFileSync(path.join(__dirname, '../../server/subsite/deploy.py'));
const INSTALL = fs.readFileSync(path.join(__dirname, '../../server/subsite/install.sh'));
const b64 = (buf) => Buffer.from(buf).toString('base64');

// Скрипт кладётся во временный файл, а данные сайта идут в stdin python3.
// Так коды ссылок не попадают в командную строку (её видно в списке процессов).
function deployCommand() {
  return `umask 077; echo ${b64(DEPLOY)} | base64 -d > /run/vpsmon-deploy.py && python3 /run/vpsmon-deploy.py; rm -f /run/vpsmon-deploy.py`;
}

function deployPayload(built) {
  return JSON.stringify({ files: built.files, caddyfile: built.caddyfile, port: built.port });
}

function parseReply(text) {
  const line = text.trim().split('\n').pop();
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Error(i18n.t('srvmsg.badReply'));
  }
  // Коды ссылок (43 символа) вырезаем: путь к файлу в ошибке ОС раскрыл бы чужую ссылку.
  if (!reply.ok) throw new Error(String(reply.error || i18n.t('srvmsg.error')).replace(/[A-Za-z0-9_-]{43}/g, '…'));
  return reply;
}

async function publish(transport, built) {
  const reply = parseReply(await transport.exec(deployCommand(), 60000, deployPayload(built)));
  return { release: reply.release };
}

function installCommand(port) {
  if (!validPort(port)) {
    throw new Error(i18n.t('subs.badPort', { ports: RESERVED_PORTS.join(', ') }));
  }
  return `umask 077; echo ${b64(INSTALL)} | base64 -d > /run/vpsmon-install.sh && bash /run/vpsmon-install.sh ${port}`;
}

async function install(transport, port) {
  // Установка пакетов может идти пару минут.
  parseReply(await transport.exec(installCommand(port), 300000));
}

// Let's Encrypt выдаст сертификат, только если домен уже указывает на этот сервер.
async function checkDns(domain, host, lookup = dns.promises.lookup) {
  const addrs = await lookup(domain, { all: true, family: 4 });
  const ips = addrs.map((a) => a.address);
  if (!ips.includes(host)) {
    throw new Error(i18n.t('subs.dnsMismatch', { domain, ips: ips.join(', ') || i18n.t('subs.nothing'), host }));
  }
}

function loadInventoryCache(file, entryId) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))[entryId] ?? null;
  } catch {
    return null;
  }
}

function saveInventoryCache(file, entryId, inventory, now = Date.now()) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* кэша ещё нет */ }
  all[entryId] = { inventory, savedAt: now };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(all));
  fs.renameSync(`${file}.tmp`, file);
}

// Ключи читаются со входа; если вход не отвечает — берём последний удачный снимок.
async function readInventory({ read, cacheFile, entryId, now = Date.now() }) {
  try {
    const inventory = await read();
    saveInventoryCache(cacheFile, entryId, inventory, now);
    return { inventory, cachedAt: null };
  } catch {
    const cached = loadInventoryCache(cacheFile, entryId);
    if (!cached) throw new Error(i18n.t('subs.noCache'));
    return { inventory: cached.inventory, cachedAt: cached.savedAt };
  }
}

module.exports = {
  deployCommand, deployPayload, publish, installCommand, install, checkDns,
  loadInventoryCache, saveInventoryCache, readInventory,
};
