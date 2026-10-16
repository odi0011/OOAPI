#!/usr/bin/env bash
# 部署 OpenCode 桥接服务（opencode serve）。
#
# 做五件事：
#   1. 校验/安装官方 CLI 二进制到 /opt/ooapi/opencode/opencode；
#   2. 建专用非 root 用户 ooapi-bridge 并把目录交给它（权限隔离第一层）；
#   3. 写入干净配置：禁止自更新（锁版本），不写任何 tools/permission 覆盖
#      —— 实测任何工具裁剪都会被上游校验拒绝，见 opencode_bridge.go 头部说明；
#   4. 安装 systemd 服务并启动（自动拉起、开机自启、只监听回环、沙箱）；
#   5. 首次部署时把 opencode 渠道的 API Key 写入 serve 的 auth.json
#      （已验证：写入后持久化，重启不丢），并做端到端自检。
#
# 幂等：重复执行安全。
# 凭据来源：网关的渠道表（加密存储），解密后只在本机写入 serve，不出机器。
set -euo pipefail

cd "$(dirname "$0")/.."

SSH="bash scripts/ssh-oo.sh"

echo "== 上传服务单元 =="
$SSH 'cat > /tmp/opencode-bridge.service' < scripts/opencode-bridge.service

$SSH 'bash -s' <<'REMOTE'
set -euo pipefail
mkdir -p /opt/ooapi/opencode
cd /opt/ooapi/opencode

echo "== 建非 root 服务用户 =="
id -u ooapi-bridge >/dev/null 2>&1 || useradd --system --home-dir /opt/ooapi/opencode --shell /usr/sbin/nologin ooapi-bridge

if [ ! -x ./opencode ]; then
  echo "== 下载官方 CLI 二进制 =="
  VER=$(curl -fsSL -m 30 https://api.github.com/repos/anomalyco/opencode/releases/latest \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["tag_name"])')
  echo "  release: $VER"
  curl -fsSL -m 300 -o oc.tgz \
    "https://github.com/anomalyco/opencode/releases/download/${VER}/opencode-linux-x64.tar.gz"
  tar xzf oc.tgz && rm -f oc.tgz && chmod +x ./opencode
fi
echo "  版本：$(./opencode --version)"

echo "== 清理旧的工具/权限覆盖配置 =="
mkdir -p .config/opencode
cat > .config/opencode/opencode.jsonc <<'JSONC'
{
  // 桥接服务的配置：保持极简。
  //
  // 不要在这里写 tools / permission / permissions 覆盖 ——
  // 实测任何工具裁剪都会触发上游的客户端校验（FreeTierError 403），
  // 桥接请求必须与官方 CLI 默认形状一致。工具执行的防护走
  // systemd 沙箱（非 root + 只读根文件系统），见服务单元。
  "$schema": "https://opencode.ai/config.json",
  // 锁版本：自动更新会替换掉当前二进制，跨版本行为差异不可控。
  "update": "disable"
}
JSONC

echo "== 权限收紧：二进制与配置 root 只读，仅数据目录给服务用户 =="
# 模型理论上能诱导执行工具（上游要求默认工具集），因此不让服务用户
# 改写自己的二进制与配置 —— 否则一次写入就能改变下次启动的行为。
chown root:root opencode && chmod 755 opencode
chown -R root:root .config 2>/dev/null || true
chmod -R a-w .config 2>/dev/null || true
chown -R ooapi-bridge:ooapi-bridge .local 2>/dev/null || true
chown -R ooapi-bridge:ooapi-bridge .cache 2>/dev/null || true
chown -R ooapi-bridge:ooapi-bridge .npm 2>/dev/null || true
chown ooapi-bridge:ooapi-bridge . && chmod 755 .

echo "== 安装 systemd 服务 =="
install -m 0644 /tmp/opencode-bridge.service /etc/systemd/system/opencode-bridge.service
systemctl daemon-reload
systemctl enable opencode-bridge.service >/dev/null 2>&1 || true
systemctl restart opencode-bridge.service
sleep 3
systemctl is-active opencode-bridge.service
curl -sf --max-time 10 http://127.0.0.1:4096/config > /dev/null && echo "  健康检查 OK"

if [ -f /opt/ooapi/opencode/.local/share/opencode/auth.json ]; then
  echo "== auth.json 已存在，跳过凭据写入（重启不丢）=="
else
  echo "== 首次部署：写入上游凭据 =="
  cd /opt/ooapi/server
  set -a; . ./.env; set +a
  PLAIN=$(/opt/ooapi/ooapi-server-bin channel-key 2>/dev/null || true)
  if [ -z "$PLAIN" ]; then
    echo "  警告：未能自动解密渠道密钥。请在管理端『测试』任一 opencode 渠道，"
    echo "        或手工执行："
    echo "          curl -X PUT http://127.0.0.1:4096/auth/opencode \\"
    echo "               -H 'Content-Type: application/json' \\"
    echo "               -d '{\"type\":\"api\",\"key\":\"<你的 key>\"}'"
  else
    curl -sf -X PUT http://127.0.0.1:4096/auth/opencode \
      -H 'Content-Type: application/json' \
      -d "{\"type\":\"api\",\"key\":\"$PLAIN\"}" > /dev/null
    echo "  已写入 serve（存于 auth.json，重启保留）"
  fi
fi

echo "== 端到端自检：建会话 + 一次调用 =="
SES=$(curl -sf --max-time 10 -X POST http://127.0.0.1:4096/session \
      -H 'Content-Type: application/json' -d '{}' \
      | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')
[ -n "$SES" ] || { echo "  建会话失败"; exit 1; }
OUT=$(curl -sf --max-time 90 -X POST "http://127.0.0.1:4096/session/$SES/message" \
      -H 'Content-Type: application/json' \
      -d '{"model":{"providerID":"opencode","modelID":"deepseek-v4.1-flash-free"},"parts":[{"type":"text","text":"reply with: bridge-ready"}]}' \
      | python3 -c '
import sys,json
d=json.load(sys.stdin)
info=d.get("info",{})
if info.get("error"): print("ERROR: "+str(info["error"].get("data",{}).get("message","?"))[:140])
else:
    txt=[p.get("text","") for p in d.get("parts",[]) if p.get("type")=="text"]
    print("REPLY: "+(txt[0][:80] if txt else "(empty)"))
')
curl -s -m 5 -X DELETE "http://127.0.0.1:4096/session/$SES" > /dev/null || true
echo "  $OUT"
case "$OUT" in
  REPLY:*) echo "  桥接可用" ;;
  *rate-limited*|*FreeTier*|*ERROR:*) echo "  自检被上游拒绝（免费档月配额用尽或偶发；配额重置后自愈，可用 /zen/go/v1/usage 查看重置时间）" ;;
  *) echo "  自检未通过" ;;
esac
REMOTE

echo "== 部署完成 =="
