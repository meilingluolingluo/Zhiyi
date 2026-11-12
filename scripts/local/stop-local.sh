#!/usr/bin/env bash
# 停止本机服务：只停止 cwd 位于本 Gateway 或 ADP 项目内的进程，绝不按端口盲杀。
# 用法：bash scripts/local/stop-local.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADP_DIR="${ADP_DIR:-$ROOT/../adp-chat-client}"
PORTS="${PORTS:-8790 8000 5174 5433}"

cwd_of() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

for port in $PORTS; do
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    printf '端口 %-5s 空闲\n' "$port"
    continue
  fi
  for pid in $pids; do
    cwd="$(cwd_of "$pid")"
    case "$cwd" in
      "$ROOT"|"$ROOT"/*|"$ADP_DIR"|"$ADP_DIR"/*)
        echo "停止端口 $port 的进程 pid=$pid（cwd=$cwd）"
        kill -TERM "$pid" 2>/dev/null || true
        ;;
      *)
        echo "跳过端口 $port 的进程 pid=$pid（cwd=${cwd:-unknown} 不属于本项目）"
        ;;
    esac
  done
done

echo "完成。可用 bash scripts/local/check-health.sh 确认状态。"
