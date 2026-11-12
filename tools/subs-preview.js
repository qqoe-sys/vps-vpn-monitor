'use strict';
// Локальный просмотр сайта подписок без сервера: node tools/subs-preview.js
// Данные вымышленные. Сервер повторяет правила Caddy через classifyRequest:
// браузер получает страницу, VPN-клиент (по User-Agent) — подписку.

const http = require('node:http');
const { defaultSubs, addPerson } = require('../src/core/subs-config');
const { buildSite, classifyRequest } = require('../src/core/subs-site');

const PORT = Number(process.env.PORT) || 8787;

const inventory = {
  inbounds: [{ tag: 'inbound-443', port: 443, net: 'xhttp', sni: 'www.example.com', pbk: 'TestPublicKeyTestPublicKeyTestPublicKey1234', sid: 'abcd1234', path: '/demo', mode: 'auto', flow: null }],
  keys: [{ name: 'demo1', entries: [{ tag: 'inbound-443', id: '00000000-1111-2222-3333-444444444444' }] }],
};

async function main() {
  let subs = defaultSubs();
  subs.site.domain = 'example.org';
  subs = addPerson(subs, 'Alice', 'demo1');
  subs = addPerson(subs, 'No key', 'nokey');
  const { files } = await buildSite(subs, inventory, { host: '203.0.113.10' });

  http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    const r = classifyRequest(pathname, req.headers);
    const file = r.kind === 'stub' ? 'index.html' : `s/${r.token}/${r.kind === 'sub' ? 'sub' : 'index.html'}`;
    const body = files[file];
    if (body === undefined) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': r.kind === 'sub' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8' });
    res.end(body);
  }).listen(PORT, '127.0.0.1', () => {
    console.log(`Stub: http://127.0.0.1:${PORT}/`);
    for (const p of subs.people) console.log(`${p.name}: http://127.0.0.1:${PORT}/s/${p.token}/`);
  });
}

main();
