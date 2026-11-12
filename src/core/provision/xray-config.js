'use strict';
// Собирает конфиг Xray для нового сервера. Здесь нет ни SSH, ни файлов: только данные.

const VISION_FLOW = 'xtls-rprx-vision';
const PRIVATE_NETS = ['geoip:private', '0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'];

function checkPorts(profiles) {
  const ports = profiles.flatMap((p) => [p.xhttpPort, p.visionPort]);
  if (new Set(ports).size !== ports.length) throw new Error('Один и тот же порт указан дважды');
}

function reality(profile) {
  return {
    show: false,
    dest: `${profile.sni}:443`,
    xver: 0,
    serverNames: [profile.sni],
    privateKey: profile.privateKey,
    shortIds: [profile.shortId],
  };
}

function clientInbounds(profile) {
  const clients = (extra) => ({
    decryption: 'none',
    clients: profile.clients.map((c) => ({ id: c.uuid, email: c.name, ...extra })),
  });
  const sniffing = { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true };
  return [
    {
      tag: `${profile.mode}-xhttp`,
      port: profile.xhttpPort,
      protocol: 'vless',
      settings: clients({}),
      sniffing,
      streamSettings: {
        network: 'xhttp',
        security: 'reality',
        realitySettings: reality(profile),
        xhttpSettings: { path: profile.xhttpPath, mode: 'auto' },
      },
    },
    {
      tag: `${profile.mode}-vision`,
      port: profile.visionPort,
      protocol: 'vless',
      settings: clients({ flow: VISION_FLOW }),
      sniffing,
      streamSettings: { network: 'tcp', security: 'reality', realitySettings: reality(profile) },
    },
  ];
}

// Эти правила стоят первыми: клиент VPN не должен достать до служб самого сервера.
const blockRules = () => [
  { type: 'field', protocol: ['bittorrent'], outboundTag: 'block' },
  { type: 'field', ip: PRIVATE_NETS, outboundTag: 'block' },
];

const common = (statsPort) => ({
  log: { loglevel: 'warning', access: 'none' },
  stats: {},
  ...(statsPort ? { api: { tag: 'api', listen: `127.0.0.1:${statsPort}`, services: ['StatsService'] } } : {}),
  policy: {
    levels: { 0: { statsUserUplink: true, statsUserDownlink: true } },
    system: { statsInboundUplink: true, statsInboundDownlink: true, statsOutboundUplink: true, statsOutboundDownlink: true },
  },
});

function exitOutbound(exit) {
  return {
    tag: 'exit',
    protocol: 'vless',
    settings: { vnext: [{ address: exit.host, port: exit.port, users: [{ id: exit.uuid, encryption: 'none', flow: '' }] }] },
    streamSettings: {
      network: 'tcp',
      security: 'reality',
      realitySettings: { show: false, fingerprint: 'firefox', serverName: exit.sni, publicKey: exit.publicKey, shortId: exit.shortId },
    },
  };
}

function buildEntryConfig({ profiles, statsPort, exit }) {
  checkPorts(profiles);
  const cascade = profiles.find((p) => p.mode === 'cascade');
  if (cascade && !exit) throw new Error('Для каскада нужен выходной сервер');
  const rules = blockRules();
  const outbounds = [{ tag: 'direct', protocol: 'freedom' }, { tag: 'block', protocol: 'blackhole' }];
  if (cascade) {
    const tags = ['cascade-xhttp', 'cascade-vision'];
    outbounds.push(exitOutbound(exit));
    rules.push(
      { type: 'field', inboundTag: tags, domain: ['geosite:category-ru'], outboundTag: 'direct' },
      { type: 'field', inboundTag: tags, ip: ['geoip:ru'], outboundTag: 'direct' },
      { type: 'field', inboundTag: tags, outboundTag: 'exit' },
    );
  }
  return {
    ...common(statsPort),
    inbounds: profiles.flatMap(clientInbounds),
    outbounds,
    routing: { domainStrategy: 'IPIfNonMatch', rules },
  };
}

function buildExitConfig({ port, uuid, sni, shortId, privateKey }) {
  return {
    ...common(null),
    inbounds: [{
      tag: 'from-entry',
      port,
      protocol: 'vless',
      settings: { decryption: 'none', clients: [{ id: uuid, email: 'entry', flow: '' }] },
      streamSettings: { network: 'tcp', security: 'reality', realitySettings: reality({ sni, shortId, privateKey }) },
    }],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'block', protocol: 'blackhole' }],
    routing: { domainStrategy: 'IPIfNonMatch', rules: blockRules() },
  };
}

module.exports = { buildEntryConfig, buildExitConfig, common, blockRules };
