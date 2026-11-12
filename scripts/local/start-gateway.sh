#!/usr/bin/env bash
# 启动 Personal AI Gateway（本机进程，无 Docker）
# 用法：bash scripts/local/start-gateway.sh [--no-build]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "缺少 .env：请先 cp .env.example .env 并按 docs/LOCAL-DEPLOYMENT.md 填写真实模型配置" >&2
  exit 1
fi
if [ ! -f .env.personal-ai ]; then
  echo "缺少 .env.personal-ai：请先 cp .env.personal-ai.example .env.personal-ai" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
# shellcheck disable=SC1091
. ./.env.personal-ai
set +a

PORT="${PORT:-8790}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用：$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | awk 'NR==2{print $1" pid="$2}')" >&2
  echo "请先停止占用进程，或在 .env 中修改 PORT" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "安装 npm 依赖…"
  npm install
fi

if [ "${1:-}" != "--no-build" ]; then
  npm run build
fi

echo "Personal AI Gateway 启动：http://127.0.0.1:${PORT}"
echo "健康检查：curl --noproxy '*' http://127.0.0.1:${PORT}/health"
exec node dist/src/server.js
