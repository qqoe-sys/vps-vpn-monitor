# Сторонние компоненты / Third-party components

VPS-VPN Monitor распространяется под лицензией MIT (см. [LICENSE](LICENSE)).
Ниже перечислены сторонние компоненты, их авторы и лицензии. Права на них принадлежат их авторам.

*VPS-VPN Monitor is MIT-licensed. Below are the third-party components it ships with or uses, and their licenses.
All rights belong to their respective authors.*

## Входят в установщик (.exe) / Shipped in the installer

| Компонент | Версия | Лицензия | Назначение |
|---|---|---|---|
| [Electron](https://github.com/electron/electron) | 45.2.3 | MIT | оболочка приложения (включает Chromium и Node.js; их лицензии лежат рядом с программой: `LICENSE.electron.txt`, `LICENSES.chromium.html`) |
| FFmpeg (`ffmpeg.dll`, сборка Chromium) | из Electron 45.2.3 | LGPL-2.1+ | воспроизведение медиа в Chromium; динамическая библиотека, её можно заменить своей сборкой. Исходники: https://chromium.googlesource.com/chromium/third_party/ffmpeg, текст лицензии — в `LICENSES.chromium.html` |
| [ssh2](https://github.com/mscdex/ssh2) | 1.17.0 | MIT | SSH-подключения к серверам |
| [@xterm/xterm](https://github.com/xtermjs/xterm.js) | 6.0.0 | MIT | встроенный терминал |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js) | 0.11.0 | MIT | подгонка терминала под окно |
| [qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | MIT | QR-коды ссылок |
| [NSIS](https://nsis.sourceforge.io/) | 3.0.4.1 | zlib/libpng (модуль LZMA — CPL-1.0 с исключением для линковки) | сам установщик и деинсталлятор |

Зависимости второго уровня (подтягиваются npm) / Transitive dependencies:
- MIT: asn1, safer-buffer, dijkstrajs, pngjs, yargs, string-width, emoji-regex, is-fullwidth-code-point,
  strip-ansi, ansi-regex, wrap-ansi, ansi-styles, color-convert, color-name, decamelize, find-up,
  locate-path, p-locate, p-limit, p-try, path-exists, require-directory, camelcase;
- ISC: cliui, get-caller-file, require-main-filename, set-blocking, which-module, y18n, yargs-parser;
- BSD-3-Clause: bcrypt-pbkdf;
- Unlicense: tweetnacl.

Тексты лицензий npm-модулей лежат внутри программы (`resources\app.asar` → `node_modules\<модуль>\LICENSE`),
лицензия самой программы и этот файл — рядом с `VPS-VPN Monitor.exe` (`LICENSE.txt`, `THIRD-PARTY-NOTICES.md`).

Необязательный модуль ssh2 `cpu-features` (вместе с `buildcheck`, `nan`) в установщик **не входит** с версии 0.2.1:
под Electron он не загружается, ssh2 работает без него.

## Только для сборки (в установщик не входят) / Build-time only

| Компонент | Лицензия |
|---|---|
| [electron-builder](https://github.com/electron-userland/electron-builder) | MIT |

## Ставятся на ваши серверы (не входят в репозиторий и установщик) / Installed on your servers

Программа скачивает их на сервер из официальных источников во время настройки:

| Компонент | Лицензия | Откуда |
|---|---|---|
| [Xray-core](https://github.com/XTLS/Xray-core) (Project X / XTLS) | MPL-2.0 | официальные релизы GitHub, с проверкой контрольной суммы |
| [Caddy](https://github.com/caddyserver/caddy) | Apache-2.0 | официальный apt-репозиторий Caddy (только если включён сайт подписок) |
| UFW, fail2ban, unzip, curl, openssl, iproute2, python3; для Caddy — gpg, debian-keyring, debian-archive-keyring, apt-transport-https | свободные лицензии дистрибутива | apt-репозиторий Ubuntu/Debian |

## Упоминаемые приложения / Mentioned apps

[Happ](https://happ.su/) — сторонний VPN-клиент; на странице подписок дана ссылка на его сайт.
Проект не связан с авторами Happ, Xray, Caddy и хостинг-провайдерами.
Названия продуктов — товарные знаки их владельцев.

*Happ is a third-party VPN client linked from the subscription page. This project is not affiliated with the authors
of Happ, Xray, Caddy or any hosting provider. Product names are trademarks of their respective owners.*
