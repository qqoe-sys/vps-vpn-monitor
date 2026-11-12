'use strict';
// Конфиг Xray для НОВОГО входа, собранный из снимка старого (результат readKeys).
// Здесь нет ни SSH, ни файлов: только данные.
const { common, blockRules } = require('../provision/xray-config');

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

module.exports = { buildReplacementConfig, usedInbounds };
