'use strict';
// Конфиг Xray для НОВОГО входа, собранный из снимка старого (результат readKeys).
// Здесь нет ни SSH, ни файлов: только данные.
const { common, blockRules } = require('../provision/xray-config');
const { checkPorts } = require('../provision/validate');
const i18n = require('../../i18n');

// Снимок клиентов приходит со СТАРОГО входа (или из кэша на ПК), а его обычно меняют, когда с ним беда.
// Взломанный старый вход не должен через этот снимок выполнить команду на новом сервере
// (порты идут в команды ufw/bash) или подсунуть свои значения в конфиг Xray. Поэтому пропускаем
// только ожидаемые значения: числа портов, простые теги, известные режимы, настоящие UUID.
const TAG_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[A-Za-z0-9_.@-]{0,64}$/;
const KEY_NAME_RE = /^[A-Za-z0-9_-]{0,64}$/;
const NETS = new Set([undefined, null, '', 'tcp', 'raw', 'xhttp']);
const MODES = new Set([undefined, null, '', 'auto', 'packet-up', 'stream-up', 'stream-one']);
const FLOWS = new Set([undefined, null, '', 'xtls-rprx-vision']);

function validateInventory(inventory) {
  const bad = (what) => { throw new Error(i18n.t('repl.badInventory', { what })); };
  if (!inventory || !Array.isArray(inventory.inbounds) || !Array.isArray(inventory.keys)) bad('structure');
  for (const ib of inventory.inbounds) {
    if (!ib || !TAG_RE.test(String(ib.tag))) bad('tag');
    if (!NETS.has(ib.net)) bad(`net ${ib.tag}`);
    if (!MODES.has(ib.mode)) bad(`mode ${ib.tag}`);
    if (!FLOWS.has(ib.flow)) bad(`flow ${ib.tag}`);
  }
  for (const k of inventory.keys) {
    if (!k || !KEY_NAME_RE.test(String(k.name ?? '')) || !Array.isArray(k.entries)) bad('key');
    for (const e of k.entries) {
      if (!e || !TAG_RE.test(String(e.tag)) || !UUID_RE.test(String(e.id)) || !EMAIL_RE.test(String(e.email ?? ''))) bad(`key ${k.name}`);
    }
  }
  // Порты — только у inbound с клиентами: именно они уходят в правила ufw и проверки на новом сервере.
  checkPorts(usedInbounds(inventory).map((ib) => ib.port));
}


// Клиенты одного inbound по тегу: у одного имени ключа на разных inbound могут быть разные UUID,
// а если ключа на этом inbound не было — записи просто нет (пустых не создаём).
const clientsOf = (inventory, ib) => inventory.keys.flatMap((k) =>
  k.entries
    .filter((e) => e.tag === ib.tag)
    .map((e) => ({ id: e.id, email: e.email, ...(ib.flow ? { flow: ib.flow } : {}) })));

// Inbound, на которых есть хотя бы один клиент. Пустые не переносим: ими никто не пользуется,
// а проверка пути (cascade-tune.py probe) берёт первого клиента каждого inbound и на пустом упала бы.
// По этому же списку считаются порты нового входа.
function usedInbounds(inventory) {
  return inventory.inbounds.filter((ib) => clientsOf(inventory, ib).length > 0);
}

function buildReplacementConfig({ inventory, link, exitHost, reality, xhttpPath, statsPort }) {
  const sniffing = { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true };

  const inbounds = usedInbounds(inventory).map((ib) => {
    const clients = clientsOf(inventory, ib);
    const streamSettings = {
      // Без network Xray работает по tcp: так и записываем явно.
      network: ib.net || 'tcp',
      security: 'reality',
      // Новые: ключ Reality, shortId, SNI (старые не переносим).
      realitySettings: {
        show: false,
        dest: `${reality.sni}:443`,
        xver: 0,
        serverNames: [reality.sni],
        privateKey: reality.privateKey,
        shortIds: [reality.shortId],
      },
    };
    if (ib.net === 'xhttp') streamSettings.xhttpSettings = { path: xhttpPath, mode: ib.mode || 'auto' };
    return {
      tag: ib.tag,
      port: ib.port,
      protocol: 'vless',
      settings: { decryption: 'none', clients },
      sniffing,
      streamSettings,
    };
  });

  const tags = inbounds.map((i) => i.tag);
  return {
    ...common(statsPort),
    inbounds,
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
      {
        tag: 'exit',
        protocol: 'vless',
        // Все параметры звена прочитаны с выхода (link), ничего не придумано.
        settings: { vnext: [{ address: exitHost, port: link.port, users: [{ id: link.uuid, encryption: 'none', flow: link.flow }] }] },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: { show: false, fingerprint: 'firefox', serverName: link.sni, publicKey: link.publicKey, shortId: link.shortId },
        },
      },
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        ...blockRules(),
        { type: 'field', inboundTag: tags, domain: ['geosite:category-ru'], outboundTag: 'direct' },
        { type: 'field', inboundTag: tags, ip: ['geoip:ru'], outboundTag: 'direct' },
        { type: 'field', inboundTag: tags, outboundTag: 'exit' },
      ],
    },
  };
}

module.exports = { buildReplacementConfig, usedInbounds, validateInventory };
