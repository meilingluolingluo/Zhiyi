#!/usr/bin/env bash
# 启动 ADP Chat Client（后端 8000 + 前端 5174），本机进程，无 Docker。
# 依赖：PostgreSQL 已在 5433 运行（bash scripts/local/start-postgres.mjs 或你自己的实例）。
# 用法：ADP_DIR=../adp-chat-client bash scripts/local/start-adp.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADP_DIR="${ADP_DIR:-$ROOT/../adp-chat-client}"

if [ ! -d "$ADP_DIR/server" ]; then
  echo "未找到 ADP Chat Client：$ADP_DIR（可用 ADP_DIR 指定路径）" >&2
  exit 1
fi
if [ ! -f "$ADP_DIR/server/.env" ]; then
  echo "缺少 $ADP_DIR/server/.env：请参考 server/.env.example 配置 APP_CONFIGS / PGSQL_*" >&2
  exit 1
fi

if ! lsof -nP -iTCP:5433 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "PostgreSQL 5433 未监听：请先运行 node scripts/local/start-postgres.mjs" >&2
  exit 1
fi
if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 8000 已被占用，停止后再试" >&2
  exit 1
fi
if lsof -nP -iTCP:5174 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 5174 已被占用，停止后再试" >&2
  exit 1
fi

if [ ! -d "$ADP_DIR/server/.venv" ]; then
  echo "安装 ADP Python 依赖（uv sync）…"
  (cd "$ADP_DIR/server" && uv sync)
fi
if [ ! -d "$ADP_DIR/client/node_modules" ]; then
  echo "安装 ADP 前端依赖（npm install）…"
  (cd "$ADP_DIR/client" && npm install)
fi
if [ ! -f "$ADP_DIR/client/packages/adp-chat-component/dist/es/adp-chat-component.css" ]; then
  echo "构建 ADP 组件库…"
  (cd "$ADP_DIR/client/packages/adp-chat-component" && npm run build)
fi

# 读取 ADP 自身 .env（APP_CONFIGS 等）
set -a
# shellcheck disable=SC1091
. "$ADP_DIR/server/.env"
set +a

echo "启动 ADP 后端：http://127.0.0.1:8000"
(
  cd "$ADP_DIR/server"
  # -u PYTHONPATH：绕开宿主注入的 sitecustomize shim（否则 logs 目录 mkdir 会误报 EEXIST）。
  exec env -u PYTHONPATH -u NODE_OPTIONS DEV_MODE=true \
    PGSQL_HOST="${PGSQL_HOST:-127.0.0.1}" \
    PGSQL_PORT="${PGSQL_PORT:-5433}" \
    PGSQL_USER="${PGSQL_USER:-$USER}" \
    PGSQL_PASSWORD="${PGSQL_PASSWORD:-localdev}" \
    PGSQL_DB="${PGSQL_DB:-adp_chat}" \
    .venv/bin/python -c "from app_factory import create_app; app=create_app(); app.run(host='127.0.0.1', port=8000, single_process=True, access_log=True)"
) &
BACKEND_PID=$!

echo "启动 ADP 前端：http://127.0.0.1:5174"
(
  cd "$ADP_DIR/client/packages/app"
  exec node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174
) &
FRONTEND_PID=$!

cleanup() {
  echo
  echo "停止 ADP（backend=$BACKEND_PID frontend=$FRONTEND_PID）…"
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup INT TERM

echo
echo "打开浏览器访问：http://127.0.0.1:5174/"
echo "（Ctrl+C 同时停止前后端）"
wait
