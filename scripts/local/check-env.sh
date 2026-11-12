#!/usr/bin/env bash
# 本机环境自检（macOS，无 Docker）：只检查、不安装、不修改任何配置。
# 用法：bash scripts/local/check-env.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADP_DIR="${ADP_DIR:-$ROOT/../adp-chat-client}"

pass=0
fail=0
warn=0

say() { printf '%-38s %s\n' "$1" "$2"; }
ok() { say "$1" "PASS  $2"; pass=$((pass + 1)); }
no() { say "$1" "MISS  $2"; fail=$((fail + 1)); }
wk() { say "$1" "WARN  $2"; warn=$((warn + 1)); }

check_cmd() {
  local name="$1" cmd="$2" optional="${3:-}"
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$name" "$(command -v "$cmd")"
  elif [ "$optional" = "optional" ]; then
    wk "$name" "未安装（可选）"
  else
    no "$name" "未安装"
  fi
}

port_state() {
  local port="$1" label="$2"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    say "$label (:${port})" "BUSY  $(lsof -nP -iTCP:"$port" -sTCP:LISTEN | awk 'NR==2{print $1" pid="$2}')"
    return 1
  fi
  say "$label (:${port})" "FREE"
  return 0
}

echo "== 系统 =="
say "macOS" "$(sw_vers -productVersion 2>/dev/null || echo unknown)"
say "架构" "$(uname -m)"

echo
echo "== 运行时 =="
check_cmd "Node.js" node
check_cmd "npm" npm
check_cmd "Python 3" python3
check_cmd "uv" uv
check_cmd "sqlite3" sqlite3
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 22 ] && ok "Node 版本要求" "v$(node -p 'process.versions.node')（>=22）" || no "Node 版本要求" "需要 >=22，当前 $(node -v)"
fi
if command -v python3 >/dev/null 2>&1; then
  py_bin="python3"
  # 若 ADP venv 已存在，优先检查 ADP 实际使用的解释器。
  if [ -x "$ADP_DIR/server/.venv/bin/python" ]; then
    py_bin="$ADP_DIR/server/.venv/bin/python"
  fi
  py_minor="$("$py_bin" -c 'import sys;print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo unknown)"
  case "$py_minor" in
    3.12) ok "ADP Python 版本" "3.12（${py_bin}）" ;;
    *) wk "ADP Python 版本" "当前 ${py_minor}；ADP 要求 3.12，脚本会用 uv 自动准备" ;;
  esac
fi

echo
echo "== Agent CLI（MultiCA 可选执行器） =="
check_cmd "MultiCA CLI" multica
check_cmd "Codex CLI" codex optional
check_cmd "Claude Code CLI" claude optional

if command -v multica >/dev/null 2>&1; then
  echo
  echo "== MultiCA 状态 =="
  multica auth status 2>&1 | sed 's/^/  auth:    /' || true
  multica daemon status 2>&1 | sed 's/^/  daemon:  /' || true
fi

echo
echo "== 端口 =="
port_state 8790 "Personal AI Gateway"
port_state 8000 "ADP 后端"
port_state 5174 "ADP 前端"
port_state 5433 "PostgreSQL"
port_state 8787 "本机模型代理（不要占用）"

echo
echo "== 配置文件（只检查存在性，不打印密钥） =="
for f in "$ROOT/.env" "$ROOT/.env.personal-ai"; do
  if [ -f "$f" ]; then ok "$(basename "$f")" "存在"; else wk "$(basename "$f")" "不存在（参考 .env.example / .env.personal-ai.example）"; fi
done
if [ -f "$ADP_DIR/server/.env" ]; then ok "ADP server/.env" "存在"; else wk "ADP server/.env" "不存在（参考 server/.env.example）"; fi
if [ -d "$ADP_DIR/server/.venv" ]; then ok "ADP Python venv" "存在"; else wk "ADP Python venv" "不存在，需 cd server && uv sync"; fi
if [ -d "$ADP_DIR/client/node_modules" ]; then ok "ADP 前端依赖" "存在"; else wk "ADP 前端依赖" "不存在，需 cd client && npm install"; fi
if [ -d "$ROOT/data/pg-node/node_modules/embedded-postgres" ]; then ok "内嵌 PostgreSQL" "已安装"; else wk "内嵌 PostgreSQL" "未安装，见 docs/LOCAL-DEPLOYMENT.md"; fi

echo
echo "== 汇总 =="
printf 'PASS=%d  MISS=%d  WARN=%d\n' "$pass" "$fail" "$warn"
[ "$fail" -eq 0 ]
