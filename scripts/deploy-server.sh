#!/bin/bash
# 本地交叉编译后端并部署到服务器（154.36.184.56）。
#
# 为什么改成本地编译：新服务器没有 Go 工具链，而旧服是「上传源码 + 服务器编译」。
# 本地 Go 可交叉编译 linux/amd64 静态二进制（CGO_ENABLED=0），
# 省掉在服务器装一整套工具链 —— 服务器只负责跑，环境越干净越好。
#
# 重要：绝不能动 /opt/ooapi/server 目录本身。
# 它里面是 .env 与 .jwt-secret —— 数据库密码和 JWT 签名密钥。
# 早先的版本用 mv 整体替换该目录，把这两个文件连同旧源码一起删了，
# 直接导致服务起不来、所有登录态失效。现在的做法是：
#   1. 编译到临时文件，成功且是 ELF 才上传
#   2. 配置缺失就中止（不动正在跑的服务）
#   3. 原子替换 + 重启 + 健康检查，不通过自动回滚
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH="$ROOT/scripts/ssh-oo.sh"

# 本地 Go 工具链不在 PATH 里，显式指定（可用 GO_BIN 覆盖）。
GO="${GO_BIN:-C:/Users/yd/AppData/Local/go-toolchain/go/bin/go}"
export PATH="$(dirname "$GO"):$PATH"
export GOPROXY=https://goproxy.cn,direct

cd "$ROOT/ooapi-server"

echo "== 本地交叉编译（linux/amd64）=="
BUILD_OUT="$(mktemp -t ooapi-bin-XXXXXX)"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  "$GO" build -trimpath -ldflags='-s -w' -o "$BUILD_OUT" .
echo "  编译成功: $(ls -la "$BUILD_OUT" | awk '{print $5}') 字节"

# 校验产物确实是 linux 可执行文件（避免把 windows 二进制传上去）。
if [ "$(head -c 4 "$BUILD_OUT" | od -An -tx1 | tr -d ' \n')" != "7f454c46" ]; then
  echo "错误：产物不是 ELF 二进制，中止部署" >&2
  rm -f "$BUILD_OUT"
  exit 1
fi

echo "== 上传 =="
SCP_DEST=/root/ bash "$SSH" scp "$BUILD_OUT"
REMOTE_BIN="/root/$(basename "$BUILD_OUT")"

echo "== 就位并重启 =="
bash "$SSH" "
set -e
chmod +x $REMOTE_BIN

# 配置必须在：不在就别动正在跑的服务
test -f /opt/ooapi/server/.env || { echo '错误：.env 丢失，中止'; exit 1; }
test -s /opt/ooapi/server/.jwt-secret || { echo '错误：.jwt-secret 丢失，中止'; exit 1; }

# Google 订阅登录的客户端凭据只从 .env 读（源码里不内置，见 upstream_login.go）。
# 缺失不阻止部署 —— 只是 Google 一键登录不可用，报错会明确点名缺哪个变量。
grep -q '^GOOGLE_OAUTH_CLIENT_ID=' /opt/ooapi/server/.env   || echo '提示：.env 未配置 GOOGLE_OAUTH_CLIENT_ID，Google 订阅登录（Antigravity）将不可用' 

# 原子替换：先留一份旧二进制，重启后健康检查不过就回滚
cp -f /opt/ooapi/ooapi-server-bin /opt/ooapi/ooapi-server-bin.prev 2>/dev/null || true
mv -f $REMOTE_BIN /opt/ooapi/ooapi-server-bin
chmod +x /opt/ooapi/ooapi-server-bin

systemctl restart ooapi.service
sleep 4
systemctl is-active ooapi.service

if ! curl -sf --max-time 10 http://127.0.0.1:3001/api/health > /dev/null; then
  echo '健康检查失败，回滚上一版'
  if [ -f /opt/ooapi/ooapi-server-bin.prev ]; then
    cp -f /opt/ooapi/ooapi-server-bin.prev /opt/ooapi/ooapi-server-bin
    systemctl restart ooapi.service
    sleep 3
  fi
  exit 1
fi
echo '健康检查通过'
"

rm -f "$BUILD_OUT"
echo "== 部署完成 =="
