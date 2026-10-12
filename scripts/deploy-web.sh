#!/bin/bash
# 把前端构建产物同步到服务器（154.36.184.56）。
#
# 上传目录是 /opt/ooapi/web/dist。目录由 **nginx 直接托管**
# （location / 里 root 指向它），Go 服务只提供 /api 与 /v1。
# 因此更新前端不需要重启后端进程。
#
# 上传的图标等放在 /opt/ooapi/server/uploads（在前端产物之外，
# 否则下次构建清空 dist 时会被连带删掉）。
#
# 用「先传临时目录再原子替换」的顺序：直接覆盖 dist 会让访问中的页面
# 拿到半新半旧的 index.html 与 assets，报 404。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH="$ROOT/scripts/ssh-oo.sh"

cd "$ROOT/ooapi-web"

if [ ! -f dist/index.html ]; then
  echo "dist/index.html 不存在，请先执行 npm run build" >&2
  exit 1
fi

TARBALL="$(mktemp -t ooapi-web-XXXXXX.tar.gz)"
tar -czf "$TARBALL" -C dist .

echo "== 上传构建产物 =="
SCP_DEST=/root/ bash "$SSH" scp "$TARBALL"
REMOTE_TAR="/root/$(basename "$TARBALL")"

echo "== 替换并生效 =="
bash "$SSH" "
set -e
rm -rf /opt/ooapi/web/dist-new
mkdir -p /opt/ooapi/web/dist-new
tar -xzf $REMOTE_TAR -C /opt/ooapi/web/dist-new
rm -f $REMOTE_TAR

# 保留上一版以便回滚
rm -rf /opt/ooapi/web/dist-prev
mv /opt/ooapi/web/dist /opt/ooapi/web/dist-prev 2>/dev/null || true
mv /opt/ooapi/web/dist-new /opt/ooapi/web/dist

# 静态文件由 Go 服务直接托管，无需重启进程
ls /opt/ooapi/web/dist | head -3
echo '前端已更新'
"

rm -f "$TARBALL"
echo "== 完成 =="
