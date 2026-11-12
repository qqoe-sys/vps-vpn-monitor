'use strict';
// Защита от prototype pollution: имена ключей и счётчиков приходят с серверов, и имя вроде
// "__proto__" при записи obj[name] = ... испортило бы Object.prototype всей программы.

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isSafeKey = (key) => !UNSAFE_KEYS.has(String(key));

// JSON.parse, который выбрасывает опасные ключи на любой глубине.
function parseSafe(text) {
  return JSON.parse(text, (key, value) => (isSafeKey(key) ? value : undefined));
}

module.exports = { isSafeKey, parseSafe };
