#!/usr/bin/env bash
# 统一健康检查（本机进程）。只读，不修改任何状态。
# 用法：bash scripts/local/check-health.sh
set -uo pipefail

GATEWAY="${GATEWAY:-http://127.0.0.1:8790}"
ADP_API="${ADP_API:-http://127.0.0.1:8000}"
ADP_UI="${ADP_UI:-http://127.0.0.1:5174}"
PG_PORT="${PG_PORT:-5433}"

pass=0
fail=0

line() { printf '%-34s %s\n' "$1" "$2"; }
ok() { line "$1" "PASS  $2"; pass=$((pass + 1)); }
no() { line "$1" "FAIL  $2"; fail=$((fail + 1)); }

json_get() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1],{'d':d}))" "$1" 2>/dev/null; }

echo "== Personal AI Gateway =="
health="$(curl -sS --noproxy '*' --max-time 5 "$GATEWAY/health" 2>/dev/null || true)"
if [ -z "$health" ]; then
  no "Gateway /health" "无响应"
else
  status="$(printf '%s' "$health" | json_get "d.get('status')")"
  db="$(printf '%s' "$health" | json_get "d.get('db')")"
  mode="$(printf '%s' "$health" | json_get "d.get('upstream',{}).get('mode')")"
  model="$(printf '%s' "$health" | json_get "d.get('upstream',{}).get('default_model')")"
  [ "$status" = "ok" ] && ok "Gateway /health" "status=ok" || no "Gateway /health" "status=$status"
  [ "$db" = "ok" ] && ok "SQLite" "db=ok" || no "SQLite" "db=$db"
  [ "$mode" = "remote" ] && ok "模型上游" "remote / $model" || line "模型上游" "WARN  mode=$mode（Mock 模式，非真实模型）"
fi

pai="$(curl -sS --noproxy '*' --max-time 5 "$GATEWAY/health/personal-ai" 2>/dev/null || true)"
if [ -z "$pai" ]; then
  no "Personal AI Runtime" "无响应"
else
  enabled="$(printf '%s' "$pai" | json_get "d.get('personal_ai',{}).get('enabled')")"
  protocol="$(printf '%s' "$pai" | json_get "d.get('personal_ai',{}).get('protocol')")"
  daemon="$(printf '%s' "$pai" | json_get "d.get('multica',{}).get('daemon',{}).get('status')")"
  [ "$enabled" = "True" ] && ok "Personal AI Runtime" "enabled=true protocol=$protocol" || no "Personal AI Runtime" "enabled=$enabled"
  line "MultiCA daemon" "INFO  ${daemon}（真实执行需 setup + daemon）"
fi

echo
echo "== 知忆 · 模型服务设置 =="
settings="$(curl -sS --noproxy '*' --max-time 5 "$GATEWAY/v1/zhiyi/settings" 2>/dev/null || true)"
if [ -z "$settings" ]; then
  no "设置接口 /v1/zhiyi/settings" "无响应"
else
  active="$(printf '%s' "$settings" | json_get "d.get('active')")"
  base="$(printf '%s' "$settings" | json_get "d.get('effectiveBaseUrl')")"
  cur_model="$(printf '%s' "$settings" | json_get "d.get('model')")"
  auth="$(printf '%s' "$settings" | json_get "d.get('authMode')")"
  ok "设置接口" "active=${active} base=${base} model=${cur_model} auth=${auth}"
  ducx="$(printf '%s' "$settings" | json_get "d.get('ducx',{}).get('available')")"
  line "DUCX 可执行文件" "INFO  ${ducx}（ducx 认证模式需要）"
fi
page_code="$(curl -sS --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' "$GATEWAY/settings" 2>/dev/null || echo 000)"
[ "$page_code" = "200" ] && ok "设置页 /settings" "HTTP 200" || no "设置页 /settings" "HTTP $page_code"

echo
echo "== ADP Chat Client =="
apps="$(curl -sS --noproxy '*' --max-time 5 "$ADP_API/application/list" 2>/dev/null || true)"
if [ -z "$apps" ]; then
  no "ADP 后端 /application/list" "无响应"
else
  name="$(printf '%s' "$apps" | json_get "(d.get('Applications') or [{}])[0].get('Name')")"
  case "$name" in
    知忆|"Personal AI") ok "ADP 应用配置" "${name} 已注册" ;;
    *) no "ADP 应用配置" "未找到知忆（当前 name=${name:-none}）" ;;
  esac
fi
ui_code="$(curl -sS --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' "$ADP_UI/" 2>/dev/null || echo 000)"
[ "$ui_code" = "200" ] && ok "ADP UI" "HTTP 200 $ADP_UI" || no "ADP UI" "HTTP $ui_code"

echo
echo "== PostgreSQL =="
if lsof -nP -iTCP:"$PG_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  ok "PostgreSQL" "监听 127.0.0.1:$PG_PORT"
else
  no "PostgreSQL" "端口 $PG_PORT 未监听"
fi

echo
echo "== MultiCA CLI =="
if command -v multica >/dev/null 2>&1; then
  line "MultiCA 版本" "$(multica --version 2>/dev/null | head -1)"
  line "MultiCA 认证" "$(multica auth status 2>&1 | head -1)"
  line "MultiCA daemon" "$(multica daemon status 2>&1 | head -1)"
else
  line "MultiCA CLI" "MISS  未安装"
fi

echo
printf 'PASS=%d  FAIL=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
