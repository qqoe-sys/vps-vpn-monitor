# step:xray
# Ставит официальный релиз Xray и проверяет его контрольную сумму.
set -e
case "$(uname -m)" in
  x86_64) ZIP=Xray-linux-64.zip ;;
  aarch64) ZIP=Xray-linux-arm64-v8a.zip ;;
  *) echo "@E:arch_unsupported"; exit 1 ;;
esac
M=/usr/local/lib/vpsmon/manifest.py
python3 $M add files /usr/local/bin/xray /usr/local/share/xray /usr/local/etc/xray /etc/systemd/system/xray.service
python3 $M add units xray.service
python3 $M add users xray

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
BASE=https://github.com/XTLS/Xray-core/releases/latest/download
curl -fsSL --retry 1 --max-time 120 -o "$WORK/x.zip" "$BASE/$ZIP" || { echo "@E:xray_download"; exit 1; }
curl -fsSL --retry 1 --max-time 20 -o "$WORK/x.dgst" "$BASE/$ZIP.dgst" || { echo "@E:xray_digest_download"; exit 1; }
WANT=$(awk -F'= *' 'tolower($1) ~ /sha2-256|sha256/ {print $2; exit}' "$WORK/x.dgst")
GOT=$(sha256sum "$WORK/x.zip" | awk '{print $1}')
if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then echo "@E:xray_digest_mismatch"; exit 1; fi

unzip -q -o "$WORK/x.zip" -d "$WORK/x"
install -m 755 "$WORK/x/xray" /usr/local/bin/xray
install -d -m 755 /usr/local/share/xray /usr/local/etc/xray
install -m 644 "$WORK/x/geoip.dat" "$WORK/x/geosite.dat" /usr/local/share/xray/
id xray >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin xray

cat > /etc/systemd/system/xray.service <<'UNIT'
[Unit]
Description=Xray Service
After=network-online.target
Wants=network-online.target

[Service]
User=xray
Group=xray
Environment=XRAY_LOCATION_ASSET=/usr/local/share/xray
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
/usr/local/bin/xray version | head -1
