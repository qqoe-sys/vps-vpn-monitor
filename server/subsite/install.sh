#!/bin/bash
# Установка сайта подписок на выходной сервер. Запускает VPS-VPN Monitor после подтверждения.
# Аргумент: порт сайта. Порт 443 и правила Xray не трогаются.
# Любая ошибка возвращается в программу одной строкой JSON с названием шага.
set -euo pipefail
rm -f "$0"     # скрипт одноразовый
umask 022      # Caddy работает от своего пользователя и должен читать конфиг и файлы
PORT="${1:-}"
STEP="подготовка"
export DEBIAN_FRONTEND=noninteractive

fail() { printf '{"ok":false,"error":"%s"}\n' "$1"; exit 0; }
trap 'fail "Ошибка на шаге: ${STEP}"' ERR

case "$PORT" in ''|*[!0-9]*) fail "Некорректный порт" ;; esac
case "$PORT" in 22|80|443|2019) fail "Порт ${PORT} занят под другое" ;; esac
command -v ufw >/dev/null 2>&1 || fail "На сервере нет ufw"

APT="apt-get -q -y -o DPkg::Lock::Timeout=180"

if ! command -v caddy >/dev/null 2>&1; then
  STEP="проверка портов"
  if ss -ltnH | awk '{print $4}' | grep -Eq "[:.]${PORT}\$"; then fail "Порт ${PORT} уже занят"; fi
  if ss -ltnH | awk '{print $4}' | grep -Eq '[:.]80$'; then fail "Порт 80 уже занят"; fi
  STEP="установка зависимостей"
  $APT update </dev/null >/dev/null
  $APT install debian-keyring debian-archive-keyring apt-transport-https curl gpg </dev/null >/dev/null
  STEP="подключение репозитория Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  STEP="установка Caddy"
  $APT update </dev/null >/dev/null
  $APT install caddy </dev/null >/dev/null
  STEP="пустой конфиг Caddy"
  # Стандартная страница Caddy на порту 80 не нужна: до первой публикации конфиг пустой.
  echo '# Пусто до первой публикации VPS-VPN Monitor' > /etc/caddy/Caddyfile
  chmod 644 /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
fi

STEP="папка сайта"
mkdir -p /var/www/vpsmon-sub/releases
chmod 755 /var/www /var/www/vpsmon-sub /var/www/vpsmon-sub/releases

STEP="открытие портов в UFW"
# 80 — только для получения сертификата Let's Encrypt; PORT — сам сайт.
ufw allow 80/tcp >/dev/null
ufw allow "${PORT}/tcp" >/dev/null
echo "$PORT" > /var/www/vpsmon-sub/port

echo '{"ok":true}'
