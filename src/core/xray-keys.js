'use strict';
// Управление ключами Xray: отправка xray-keys.py на сервер и сборка vless-ссылок.

const i18n = require('../i18n');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'xray-keys.py'), 'utf8');
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RESULT_WAIT_MS = 45000;
const RESULT_POLL_MS = 1500;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !/-(xhttp|vision)$/.test(name);
}

function encodedScript(request) {
  const req = Buffer.from(JSON.stringify(request)).toString('base64');
  return Buffer.from(TEMPLATE.replace('__REQUEST__', req)).toString('base64');
}

function directCommand(request) {
  return `echo ${encodedScript(request)} | base64 -d | python3 -`;
}

// Правка перезапускает Xray. Если твой ПК ходит через этот же VPN, SSH оборвётся,
// поэтому скрипт отвязан от сессии (setsid nohup) и пишет результат в файл.
function detachedCommand(request, opId) {
  const f = `/run/vpsmon-${opId}`;
  return `umask 077; echo ${encodedScript(request)} | base64 -d > ${f}.py && `
    + `(setsid nohup sh -c 'python3 ${f}.py > ${f}.tmp 2>&1; mv ${f}.tmp ${f}.res; rm -f ${f}.py' </dev/null >/dev/null 2>&1 &)`;
}

function parseResult(text) {
  let result;
  try {
    result = JSON.parse(text.trim());
  } catch {
    throw new Error(i18n.t('srvmsg.badReply'));
  }
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

async function readKeys(transport) {
  return parseResult(await transport.exec(directCommand({ action: 'list' }), 20000));
}

async function changeKeys(connect, server, request) {
  const opId = crypto.randomBytes(8).toString('hex');
  let transport = await connect(server);
  await transport.exec(detachedCommand(request, opId), 15000);

  const deadline = Date.now() + RESULT_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      await delay(RESULT_POLL_MS);
      let text = '';
      try {
        transport ??= await connect(server);
        text = await transport.exec(`cat /run/vpsmon-${opId}.res 2>/dev/null && rm -f /run/vpsmon-${opId}.res`, 8000);
      } catch {
        try { transport?.close(); } catch { /* уже закрыт */ }
        transport = null; // связь пропала при перезапуске Xray, подключимся снова
      }
      // Разбор вне try: отказ сервера это итог операции, а не повод повторять запрос.
      if (text.trim()) return parseResult(text);
    }
  } finally {
    try { transport?.close(); } catch { /* уже закрыт */ }
  }
  throw new Error(i18n.t('srvmsg.noResultKeys'));
}

function linksFor(server, inv, name, fp = 'firefox') {
  const key = inv.keys.find((k) => k.name === name);
  if (!key) return [];
  return key.entries.flatMap(({ tag, id }) => {
    const ib = inv.inbounds.find((i) => i.tag === tag);
    if (!ib || !ib.pbk) return [];
    const q = new URLSearchParams({
      encryption: 'none', security: 'reality', type: ib.net, sni: ib.sni, fp, pbk: ib.pbk, sid: ib.sid,
    });
    if (ib.net === 'xhttp') {
      q.set('path', ib.path);
      q.set('mode', ib.mode);
    }
    if (ib.flow) q.set('flow', ib.flow);
    const kind = ib.net === 'xhttp' ? 'xhttp' : 'vision';
    const label = `${name}-${kind}`;
    return [{ label: kind, url: `vless://${id}@${server.host}:${ib.port}?${q}#${encodeURIComponent(label)}` }];
  });
}

const FINGERPRINTS = ['firefox', 'chrome', 'safari', 'edge', 'ios', 'android', 'random'];

module.exports = { validName, readKeys, changeKeys, linksFor, directCommand, FINGERPRINTS };
