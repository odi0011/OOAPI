#!/bin/bash
# OOAPI noVNC 实时浏览器：安装依赖 + 固定 X display + 启 VNC 桥 + nginx 代理
set -e

export DEBIAN_FRONTEND=noninteractive
apt-get install -y x11vnc websockify novnc >/tmp/vnc-apt.log 2>&1 || { tail -20 /tmp/vnc-apt.log; exit 1; }
echo "APT ok"

# 1) 固定 X display 为 :99（xvfb-run -a 每次拿的 display 不固定，VNC 无法稳定挂载）
if grep -q 'xvfb-run -a' /etc/systemd/system/ooapi.service; then
  sed -i 's/xvfb-run -a /xvfb-run -n 99 /' /etc/systemd/system/ooapi.service
  systemctl daemon-reload
  systemctl restart ooapi
  echo "display fixed to :99"
fi

# 2) VNC 桥服务（x11vnc 仅本机 + websockify 提供 noVNC 页面）
cat > /etc/systemd/system/ooapi-vnc.service <<'EOF'
[Unit]
Description=OOAPI VNC bridge (x11vnc + noVNC/websockify)
After=network.target ooapi.service
Wants=ooapi.service

[Service]
ExecStart=/bin/bash -c 'x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -quiet -bg -o /tmp/x11vnc.log; exec websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900'
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ooapi-vnc
sleep 2
systemctl is-active ooapi-vnc

# 3) 生成一次性访问路径令牌（不存在才生成，重启保持稳定）
ENVF=/opt/ooapi/ooapi-server/.env
if ! grep -q '^VNC_PUBLIC_PATH=' "$ENVF"; then
  TOKEN="/vnc-$(openssl rand -hex 16)/"
  echo "VNC_PUBLIC_PATH=$TOKEN" >> "$ENVF"
fi
TOKEN=$(grep '^VNC_PUBLIC_PATH=' "$ENVF" | cut -d= -f2-)

# 4) nginx：把令牌路径反代到 noVNC（含 WebSocket 升级），两个 server 块都要加
mkdir -p /etc/nginx/snippets
cat > /etc/nginx/snippets/ooapi-vnc.conf <<EOF
location ^~ $TOKEN {
    proxy_pass http://127.0.0.1:6080/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
EOF
F=/etc/nginx/sites-available/ooapi
if ! grep -q 'ooapi-vnc.conf' "$F"; then
  # 在文件里前两个 server { 之后各插一行 include（位置必须在 server 块内）
  awk '/^server \{/{n++; print; if(n==1||n==2) print "    include /etc/nginx/snippets/ooapi-vnc.conf;"; next} {print}' "$F" > "$F.tmp" && mv "$F.tmp" "$F"
fi
nginx -t && systemctl reload nginx
echo "NGINX ok"

# 5) 本机验证
curl -s -o /dev/null -w "novnc page: %{http_code}\n" "http://127.0.0.1:6080/vnc.html"
echo "VNC_PUBLIC_PATH=$TOKEN"
