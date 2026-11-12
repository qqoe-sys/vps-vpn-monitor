'use strict';
// Отпечаток ключа сервера и строка для файла доверенных серверов.

const crypto = require('node:crypto');

function fingerprint(keyBlob) {
  return `SHA256:${crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;
}

// В начале ключа SSH записан его тип: 4 байта длины, затем название.
function keyType(keyBlob) {
  return keyBlob.subarray(4, 4 + keyBlob.readUInt32BE(0)).toString();
}

function trustLine(host, keyBlob) {
  return `${host} ${keyType(keyBlob)} ${keyBlob.toString('base64')}`;
}

module.exports = { fingerprint, trustLine };
