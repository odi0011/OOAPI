#!/bin/bash
# x11vnc 需要 Xvfb 的 Xauthority；xvfb-run 的 auth 路径是动态的，从进程命令行里取
set -e
cat > /etc/systemd/system/ooapi-vnc.service <<'EOF'
[Unit]
Description=OOAPI VNC bridge (x11vnc + noVNC/websockify)
After=network.target ooapi.service
Wants=ooapi.service
PartOf=ooapi.service

[Service]
Type=simple
ExecStart=/bin/bash -c 'while true; do AUTH=$$(ps -eo args | grep "[X]vfb" | grep -oE "/[^ ]*Xauthority" | head -1); if [ -z "$$AUTH" ]; then sleep 2; continue; fi; x11vnc -display :99 -auth "$$AUTH" -forever -shared -nopw -localhost -rfbport 5900 -quiet -o /tmp/x11vnc.log; sleep 2; done & exec websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900'
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl restart ooapi-vnc
sleep 4
systemctl is-active ooapi-vnc
ss -tlnp | grep -E ':(5900|6080)' | awk '{print $4}' | sort -u
tail -3 /tmp/x11vnc.log 2>/dev/null || true
