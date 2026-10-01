#!/usr/bin/env bash
# 首次 Linux 部署；配置与加密密钥由部署者预先准备，更新不重建用户数据。
set -euo pipefail
umask 077
PROJECT="${1:-$(cd -- "$(dirname -- "$0")/.." && pwd)}"
PROJECT="$(realpath -- "$PROJECT")"
ENGINE="$PROJECT/ooapi-binance"
CONFIG="${OD_BINANCE_ENV_FILE:-$ENGINE/.env}"
BRIDGE="$PROJECT/ooapi-server/data/binance-bridge.key"
PYTHON="${OD_BINANCE_PYTHON:-$ENGINE/.venv/bin/python}"
if [[ $EUID -ne 0 ]]; then echo 'Run as root to install the local systemd service.' >&2; exit 1; fi
if [[ ! -f "$CONFIG" ]]; then echo 'Prepare the trading engine .env with DATABASE_URL and a private SECRET_KEY first.' >&2; exit 1; fi
if [[ ! -x "$PYTHON" ]]; then
  python3 -m venv "$ENGINE/.venv"
  PYTHON="$ENGINE/.venv/bin/python"
fi
"$PYTHON" -m pip install --disable-pip-version-check -r "$ENGINE/requirements.txt"
mkdir -p -- "$(dirname -- "$BRIDGE")"
if [[ ! -f "$BRIDGE" ]]; then
  "$PYTHON" -c 'import secrets; print(secrets.token_urlsafe(48))' > "$BRIDGE"
fi
chmod 600 -- "$BRIDGE" "$CONFIG"
cat > /etc/systemd/system/ooapi-binance.service <<EOF
[Unit]
Description=OD Binance local trading engine
After=network.target mysql.service
Wants=mysql.service

[Service]
Type=simple
WorkingDirectory=$ENGINE
Environment="OD_BINANCE_ENV_FILE=$CONFIG"
Environment="OOAPI_MODE=true"
Environment="OOAPI_BRIDGE_KEY_FILE=$BRIDGE"
Environment="OOAPI_LEGACY_OWNER_ID=0"
ExecStart=$PYTHON -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --no-access-log
Restart=on-failure
RestartSec=3
TimeoutStopSec=120
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ooapi-binance.service
for attempt in $(seq 1 40); do
  if "$PYTHON" -c 'import json,urllib.request; data=json.load(urllib.request.urlopen("http://127.0.0.1:8001/health",timeout=2)); assert data.get("service")=="od-binance" and data.get("database")=="connected"' 2>/dev/null; then
    echo 'OD Binance is ready on 127.0.0.1:8001.'
    exit 0
  fi
  sleep 1
done
echo 'Trading engine did not become ready. Inspect the private systemd journal.' >&2
exit 1
