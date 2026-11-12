# Сторонние компоненты

VPS-VPN Monitor распространяется под лицензией MIT (см. [LICENSE](LICENSE)).
Ниже перечислены сторонние компоненты, их авторы и лицензии. Права на них принадлежат их авторам.

## Входят в установщик (.exe)

| Компонент | Версия | Лицензия | Назначение |
|---|---|---|---|
| [Electron](https://github.com/electron/electron) | 45.2.3 | MIT | оболочка приложения (включает Chromium и Node.js; их лицензии лежат рядом с программой: `LICENSE.electron.txt`, `LICENSES.chromium.html`) |
| [ssh2](https://github.com/mscdex/ssh2) | 1.17.0 | MIT | SSH-подключения к серверам |
| [@xterm/xterm](https://github.com/xtermjs/xterm.js) | 6.0.0 | MIT | встроенный терминал |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js) | 0.11.0 | MIT | подгонка терминала под окно |
| [qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | MIT | QR-коды ссылок |

Зависимости второго уровня (подтягиваются npm):
- MIT: asn1, safer-buffer, dijkstrajs, pngjs, yargs, string-width, emoji-regex, is-fullwidth-code-point,
  strip-ansi, ansi-regex, wrap-ansi, ansi-styles, color-convert, color-name, decamelize, find-up,
  locate-path, p-locate, p-limit, p-try, path-exists, require-directory, camelcase;
- ISC: cliui, get-caller-file, require-main-filename, set-blocking, which-module, y18n, yargs-parser;
- BSD-3-Clause: bcrypt-pbkdf;
- Unlicense: tweetnacl.

## Только для сборки (в установщик не входят)

| Компонент | Лицензия |
|---|---|
| [electron-builder](https://github.com/electron-userland/electron-builder) | MIT |
| NSIS (используется electron-builder) | zlib/libpng |

## Ставятся на ваши серверы (не входят в репозиторий и установщик)

Программа скачивает их на сервер из официальных источников во время настройки:

| Компонент | Лицензия | Откуда |
|---|---|---|
| [Xray-core](https://github.com/XTLS/Xray-core) (Project X / XTLS) | MPL-2.0 | официальные релизы GitHub, с проверкой контрольной суммы |
| [Caddy](https://github.com/caddyserver/caddy) | Apache-2.0 | официальный apt-репозиторий Caddy (только если включён сайт подписок) |
| UFW, fail2ban, unzip, curl, openssl, iproute2 | свободные лицензии дистрибутива | apt-репозиторий Ubuntu/Debian |

## Упоминаемые приложения

[Happ](https://happ.su/) — сторонний VPN-клиент; на странице подписок дана ссылка на его сайт.
Проект не связан с авторами Happ, Xray, Caddy и хостинг-провайдерами.
Названия продуктов — товарные знаки их владельцев.
