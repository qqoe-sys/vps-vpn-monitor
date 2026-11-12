'use strict';
// Проверка ключа сервера по файлу ~/.ssh/known_hosts (та же защита, что у ssh.exe).
// Она не даёт подключиться к подменённому серверу и отдать ему управление.

const crypto = require('node:crypto');

function matchesPattern(pattern, host) {
  if (pattern.startsWith('|1|')) {
    // Хешированная запись: |1|соль|HMAC-SHA1(имя хоста)
    const [, , salt, hash] = pattern.split('|');
    const actual = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest('base64');
    return actual === hash;
  }
  return pattern.split(',').includes(host);
}

// keyBlob — ключ в том виде, в каком его прислал сервер (Buffer).
function isKnownKey(knownHostsText, host, keyBlob) {
  const presented = keyBlob.toString('base64');
  let trusted = false;
  for (const raw of knownHostsText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === '@revoked') {
      if (parts[1] && matchesPattern(parts[1], host) && parts[3] === presented) return false;
      continue;
    }
    if (parts[0].startsWith('@')) continue; // @cert-authority не поддерживаем
    if (matchesPattern(parts[0], host) && parts[2] === presented) trusted = true;
  }
  return trusted;
}

// Есть ли запись об этом сервере. Если запись есть, а ключ другой, это возможная подмена.
function hasHost(knownHostsText, host) {
  return knownHostsText.split(/\r?\n/).some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('@')) return false;
    return matchesPattern(line.split(/\s+/)[0], host);
  });
}

module.exports = { isKnownKey, hasHost };
