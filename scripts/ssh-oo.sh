#!/bin/bash
# 非交互式 SSH/SCP 到 ooapi 服务器。
#
# 环境里没有 sshpass，而 ssh 只从「终端」读密码 —— 管道喂进去会被忽略。
# 因此用 SSH_ASKPASS + setsid 伪装一个终端来提供密码。
# 密码不写在这个文件里，从 ~/.ooapi-server-pass 读取（git 忽略）。
#
# 用法：
#   bash scripts/ssh-oo.sh "<远程命令>"
#   bash scripts/ssh-oo.sh scp <本地路径> [<远程路径>]
#   bash scripts/ssh-oo.sh < 多行脚本.sh          # 多行脚本这样喂
#
# 换服务器只需改这里的 HOST，并把新密码写进 ~/.ooapi-server-pass。
# 当前：新服 154.36.184.56（2026-10 从 210.126.235.109 迁过来；
# 旧服已下线，连 22 端口都不通）。新服无 Go 工具链，
# 因此后端改为本地交叉编译后再上传（见 deploy-server.sh）。
set -u

HOST="154.36.184.56"
USER="root"
PASS_FILE="$HOME/.ooapi-server-pass"

if [ ! -f "$PASS_FILE" ]; then
  echo "缺少密码文件 $PASS_FILE" >&2
  exit 1
fi

ASKPASS="$(mktemp)"
cat > "$ASKPASS" <<'EOF'
#!/bin/bash
cat "$HOME/.ooapi-server-pass"
EOF
chmod +x "$ASKPASS"

export SSH_ASKPASS="$ASKPASS"
export SSH_ASKPASS_REQUIRE=force
export DISPLAY=:0

cleanup() { rm -f "$ASKPASS"; }
trap cleanup EXIT

case "${1:-ssh}" in
  scp)
    shift
    # SSH_ASKPASS_REQUIRE=force 让 ssh 在无终端时也走 askpass，
    # 因此不需要 setsid 伪装终端（Git Bash 里也没有 setsid）。
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1 \
      -o LogLevel=ERROR "$@" "$USER@$HOST:${SCP_DEST:-/root/}"
    ;;
  *)
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1 \
      -o LogLevel=ERROR -o ServerAliveInterval=15 \
      "$USER@$HOST" "$@"
    ;;
esac
