'use strict';
// Единственный файл, который знает про библиотеку ssh2.
// Ключи читаются только здесь и никогда не попадают в интерфейс.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('ssh2');
const { isKnownKey, hasHost } = require('../core/known-hosts');
const { fingerprint, trustLine } = require('../core/host-trust');

let trustFile = null;
function configureTrust(file) {
  trustFile = file;
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// opts.password — вход по паролю; opts.onHostKey(fp) — решить судьбу нового сервера.
function connect(server, opts = {}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let hostKeyRejected = false;

    client.once('ready', () => {
      resolve({
        exec: (cmd, timeoutMs, input) => exec(client, cmd, timeoutMs, input),
        shell: (size) => new Promise((ok, fail) => {
          client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (e, s) => (e ? fail(e) : ok(s)));
        }),
        close: () => client.end(),
        onClose: (fn) => client.once('close', fn),
      });
    });
    // on, а не once: вторая сетевая ошибка без обработчика уронила бы всё приложение.
    client.on('error', (err) => {
      reject(hostKeyRejected ? new Error('Ключ сервера не совпал с доверенным') : err);
    });

    const auth = {};
    try {
      if (opts.password !== undefined) {
        // Пароль уходит только в библиотеку SSH: не в командную строку и не в лог.
        auth.password = opts.password;
        auth.tryKeyboard = true;
        client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => opts.password)));
      } else {
        auth.privateKey = fs.readFileSync(expandHome(server.keyPath));
      }
    } catch (err) {
      reject(new Error(`Не удалось прочитать SSH-файл: ${err.message}`));
      return;
    }

    client.connect({
      host: server.host,
      port: 22,
      username: server.user,
      ...auth,
      readyTimeout: 15000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key, verify) => {
        const known = `${readText(path.join(os.homedir(), '.ssh', 'known_hosts'))}\n${trustFile ? readText(trustFile) : ''}`;
        if (isKnownKey(known, server.host, key)) {
          verify(true);
          return;
        }
        // Запись есть, а ключ другой: возможная подмена сервера, спрашивать нельзя.
        if (hasHost(known, server.host) || !opts.onHostKey) {
          hostKeyRejected = true;
          verify(false);
          return;
        }
        Promise.resolve(opts.onHostKey(fingerprint(key))).then((accepted) => {
          if (accepted && trustFile) {
            fs.mkdirSync(path.dirname(trustFile), { recursive: true });
            fs.appendFileSync(trustFile, `${trustLine(server.host, key)}\n`);
          }
          if (!accepted) hostKeyRejected = true;
          verify(Boolean(accepted));
        }, () => verify(false));
      },
    });
  });
}

// input — данные для стандартного ввода команды (например, новый пароль).
function exec(client, command, timeoutMs, input) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Сервер не ответил вовремя')), timeoutMs);
    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      if (input !== undefined) stream.end(input);
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.stderr.resume(); // stderr не нужен, но его надо вычитывать
      stream.on('close', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  });
}

module.exports = { connect, configureTrust };
