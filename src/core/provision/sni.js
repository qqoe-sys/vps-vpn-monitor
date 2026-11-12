'use strict';
// Выбор домена, под который будет маскироваться сервер.

const DEFAULT_SNI_CANDIDATES = [
  'www.amd.com', 'www.nvidia.com', 'www.mozilla.org', 'addons.mozilla.org',
  'www.samsung.com', 'www.asus.com', 'www.logitech.com', 'www.intel.com', 'www.oracle.com',
];

const MAX_RESULTS = 5;

function rankSni(results) {
  return results
    .filter((r) => r.tls13 && r.h2 && r.x25519 && !r.redirect)
    .sort((a, b) => a.ms - b.ms)
    .slice(0, MAX_RESULTS)
    .map(({ domain, ms }) => ({ domain, ms }));
}

module.exports = { rankSni, DEFAULT_SNI_CANDIDATES };
