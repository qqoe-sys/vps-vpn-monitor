#!/bin/bash
# Установка сайта подписок на выходной сервер. Запускает VPS-VPN Monitor после подтверждения.
# Аргумент: порт сайта. Порт 443 и правила Xray не трогаются.
# Любая ошибка возвращается в программу одной строкой JSON с названием шага.
set -euo pipefail
rm -f "$0"     # скрипт одноразовый
umask 022      # Caddy работает от своего пользователя и должен читать конфиг и файлы
PORT="${1:-}"
STEP="prepare"
export DEBIAN_FRONTEND=noninteractive

fail() { printf '{"ok":false,"error":"%s"}\n' "$1"; exit 0; }
trap 'fail "@E:site_step_failed|${STEP}"' ERR

case "$PORT" in ''|*[!0-9]*) fail "@E:site_bad_port" ;; esac
case "$PORT" in 22|80|443|2019) fail "@E:site_port_reserved|${PORT}" ;; esac
command -v ufw >/dev/null 2>&1 || fail "@E:site_no_ufw"

APT="apt-get -q -y -o DPkg::Lock::Timeout=180"

if ! command -v caddy >/dev/null 2>&1; then
  STEP="ports"
  if ss -ltnH | awk '{print $4}' | grep -Eq "[:.]${PORT}\$"; then fail "@E:site_port_busy|${PORT}"; fi
  if ss -ltnH | awk '{print $4}' | grep -Eq '[:.]80$'; then fail "@E:site_port_busy|80"; fi
  STEP="dependencies"
  $APT update </dev/null >/dev/null
  $APT install debian-keyring debian-archive-keyring apt-transport-https curl gpg </dev/null >/dev/null
  STEP="caddy-repo"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  STEP="caddy-install"
  $APT update </dev/null >/dev/null
  $APT install caddy </dev/null >/dev/null
  STEP="caddy-config"
  # Стандартная страница Caddy на порту 80 не нужна: до первой публикации конфиг пустой.
  echo '# Empty until the first VPS-VPN Monitor publish' > /etc/caddy/Caddyfile
  chmod 644 /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
fi

STEP="site-dir"
mkdir -p /var/www/vpsmon-sub/releases
chmod 755 /var/www /var/www/vpsmon-sub /var/www/vpsmon-sub/releases

STEP="ufw"
# 80 — только для получения сертификата Let's Encrypt; PORT — сам сайт.
ufw allow 80/tcp >/dev/null
ufw allow "${PORT}/tcp" >/dev/null
echo "$PORT" > /var/www/vpsmon-sub/port

echo '{"ok":true}'
