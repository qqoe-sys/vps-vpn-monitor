# step:precheck
# Только читает состояние сервера. Переменная PORTS задаёт нужные порты через пробел.
. /etc/os-release
echo "os=$ID"
echo "ver=$VERSION_ID"
echo "arch=$(uname -m)"
if command -v xray >/dev/null 2>&1 || [ -e /usr/local/etc/xray ] || [ -e /etc/xray ] || systemctl cat xray >/dev/null 2>&1; then
  echo "xray=yes"
else
  echo "xray=no"
fi
command -v ss >/dev/null 2>&1 || echo "ss=no"
busy=""
for p in $PORTS; do
  if ss -tlnH | awk '{print $4}' | grep -qE ":$p\$"; then busy="$busy $p"; fi
done
echo "busy=${busy# }"
echo "disk_mb=$(df -Pm / | awk 'NR==2 {print $4}')"
if [ -f /var/lib/vpsmon/manifest.json ]; then
  if grep -q '"status": *"incomplete"' /var/lib/vpsmon/manifest.json; then echo "manifest=incomplete"; else echo "manifest=complete"; fi
else
  echo "manifest=none"
fi
