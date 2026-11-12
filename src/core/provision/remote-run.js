'use strict';
// Запускает Python-скрипт на сервере отдельно от SSH-сессии и забирает результат из файла.
// Нужно для действий, которые могут оборвать связь: если ПК ходит через этот же VPN,
// остановка Xray разорвёт соединение, но скрипт всё равно доработает.

const i18n = require('../../i18n');
const crypto = require('node:crypto');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function runDetached(connect, server, code, args, { pollMs = 1500, deadlineMs = 60000, keyRemoved = false } = {}) {
  const file = `/run/vpsmon-${crypto.randomBytes(8).toString('hex')}`;
  const body = Buffer.from(code).toString('base64');
  let transport = await connect(server);
  try {
    await transport.exec(`umask 077; echo ${body} | base64 -d > ${file}.py && `
      + `(setsid nohup sh -c 'python3 ${file}.py ${args} > ${file}.tmp 2>&1; mv ${file}.tmp ${file}.res; rm -f ${file}.py' </dev/null >/dev/null 2>&1 &)`, 15000);

    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      await delay(pollMs);
      try {
        transport ??= await connect(server);
        const text = await transport.exec(`cat ${file}.res 2>/dev/null && rm -f ${file}.res`, 8000);
        if (text.trim()) return { text, assumed: false };
      } catch (err) {
        try { transport?.close(); } catch { /* уже закрыт */ }
        transport = null;
        // Скрипт удаляет ключ приложения: отказ по ключу значит, что он дошёл до конца.
        if (keyRemoved && err.level === 'client-authentication') return { text: '', assumed: true };
      }
    }
  } finally {
    try { transport?.close(); } catch { /* уже закрыт */ }
  }
  throw new Error(i18n.t('srvmsg.noResult'));
}

module.exports = { runDetached };
