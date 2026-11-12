#!/usr/bin/env bash
# 本地一键启动：复制默认配置 → 安装依赖 → 编译 → 启动服务。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "已生成 .env（默认值可直接运行，内置 Mock 上游）"
fi

# 把 .env 中的配置导出为环境变量（跳过注释与空行）
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# Personal AI 独立配置（不改动原有 .env.example 的 16 变量契约）
if [ ! -f .env.personal-ai ]; then
  cp .env.personal-ai.example .env.personal-ai
  echo "已生成 .env.personal-ai（Personal AI 默认配置；MultiCA 默认关闭）"
fi
set -a
# shellcheck disable=SC1091
. ./.env.personal-ai
set +a

if [ ! -d node_modules ]; then
  npm install
fi

npm run build
npm start
