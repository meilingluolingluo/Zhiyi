#!/usr/bin/env bash
# 真实环境端到端冒烟（不依赖 Docker、不使用 Mock）。
# 前置：Gateway 8790、ADP 8000、UI 5174、PostgreSQL 5433 已启动。
# 用法：bash scripts/local/smoke-e2e.sh
set -uo pipefail

GATEWAY="${GATEWAY:-http://127.0.0.1:8790}"
ADP_API="${ADP_API:-http://127.0.0.1:8000}"
ADP_UI="${ADP_UI:-http://127.0.0.1:5174}"
DEV_KEY="${DEV_KEY:-dev-key-developer}"
U2_KEY="${U2_KEY:-dev-key-user2}"

pass=0
fail=0
ok() { printf '%-46s %s\n' "$1" "PASS  $2"; pass=$((pass + 1)); }
no() { printf '%-46s %s\n' "$1" "FAIL  $2"; fail=$((fail + 1)); }
json_get() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1],{'d':d}))" "$1" 2>/dev/null; }

MARK="SMOKE-$(date +%s)"
CONTENT="冒烟标记 ${MARK}：用户偏好本地优先架构，技术栈优先 Rust，项目代号 Bluebird。"

echo "== 1. Gateway =="
h="$(curl -sS --noproxy '*' --max-time 5 "$GATEWAY/health" 2>/dev/null || true)"
mode="$(printf '%s' "$h" | json_get "d.get('upstream',{}).get('mode')")"
[ "$mode" = "remote" ] && ok "模型上游为真实模式" "mode=remote" || no "模型上游为真实模式" "mode=${mode:-unknown}"

echo
echo "== 2. 记忆写入与检索 =="
created="$(curl -sS --noproxy '*' -X POST "$GATEWAY/v1/memories" \
  -H "Authorization: Bearer $DEV_KEY" -H 'Content-Type: application/json' \
  -d "{\"content\":\"$CONTENT\",\"type\":\"identity\",\"scope\":\"personal\",\"confidence\":0.95}" 2>/dev/null || true)"
mid="$(printf '%s' "$created" | json_get "d.get('memory',{}).get('memory_id') or d.get('memory_id')")"
[ -n "$mid" ] && ok "创建记忆" "memory_id=$mid" || no "创建记忆" "无 memory_id"

found="$(curl -sS --noproxy '*' -X POST "$GATEWAY/v1/memories/search" \
  -H "Authorization: Bearer $DEV_KEY" -H 'Content-Type: application/json' \
  -d "{\"query\":\"$MARK\",\"limit\":3}" 2>/dev/null || true)"
count="$(printf '%s' "$found" | json_get "d.get('count', 0)")"
[ "${count:-0}" -ge 1 ] && ok "u1 检索命中" "count=$count" || no "u1 检索命中" "count=${count:-0}"

foreign="$(curl -sS --noproxy '*' -X POST "$GATEWAY/v1/memories/search" \
  -H "Authorization: Bearer $U2_KEY" -H 'Content-Type: application/json' \
  -d "{\"query\":\"$MARK\",\"limit\":3}" 2>/dev/null || true)"
fcount="$(printf '%s' "$foreign" | json_get "d.get('count', 0)")"
[ "${fcount:-0}" -eq 0 ] && ok "u2 无法检索 u1 记忆" "count=0" || no "u2 无法检索 u1 记忆" "count=${fcount:-?}"

echo
echo "== 3. 真实模型（非流式） =="
chat="$(curl -sS --noproxy '*' --max-time 120 -X POST "$GATEWAY/v1/personal-ai/chat/completions" \
  -H "Authorization: Bearer $DEV_KEY" -H 'Content-Type: application/json' \
  -H "X-Conversation-Id: smoke-$(date +%s)" \
  -d '{"messages":[{"role":"user","content":"只回复四个字：链路正常"}],"stream":false}' 2>/dev/null || true)"
text="$(printf '%s' "$chat" | json_get "(d.get('choices') or [{}])[0].get('message',{}).get('content','')")"
model="$(printf '%s' "$chat" | json_get "d.get('model','')")"
if [ -n "$text" ]; then
  ok "模型返回内容" "model=$model len=${#text}"
else
  no "模型返回内容" "空响应"
fi
case "$model" in
  *mock*) no "未使用 Mock 模型" "model=$model" ;;
  "") no "未使用 Mock 模型" "缺少 model 字段" ;;
  *) ok "未使用 Mock 模型" "model=$model" ;;
esac

echo
echo "== 4. 真实模型（流式） =="
stream_file="$(mktemp "${TMPDIR:-/tmp}/smoke-stream.XXXXXX")"
curl -sS --noproxy '*' --max-time 120 -N -X POST "$GATEWAY/v1/personal-ai/chat/completions" \
  -H "Authorization: Bearer $DEV_KEY" -H 'Content-Type: application/json' \
  -H "X-Conversation-Id: smoke-stream-$(date +%s)" \
  -d '{"messages":[{"role":"user","content":"用一句话说明流式输出。"}],"stream":true}' >"$stream_file" 2>/dev/null || true
if grep -q 'data: \[DONE\]' "$stream_file"; then
  ok "SSE 正常结束" "收到 [DONE]"
else
  no "SSE 正常结束" "未收到 [DONE]"
fi
if grep -q '"delta":{"content"' "$stream_file"; then
  ok "SSE 文本增量" "收到 delta.content"
else
  no "SSE 文本增量" "无 delta.content"
fi
rm -f "$stream_file" 2>/dev/null || true

echo
echo "== 5. ADP 前后端 =="
apps="$(curl -sS --noproxy '*' --max-time 5 "$ADP_API/application/list" 2>/dev/null || true)"
name="$(printf '%s' "$apps" | json_get "(d.get('Applications') or [{}])[0].get('Name')")"
case "$name" in
  知忆|"Personal AI") ok "ADP 应用注册" "${name}" ;;
  *) no "ADP 应用注册" "name=${name:-none}" ;;
esac
code="$(curl -sS --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' "$ADP_UI/" 2>/dev/null || echo 000)"
[ "$code" = "200" ] && ok "ADP UI 可访问" "HTTP 200" || no "ADP UI 可访问" "HTTP $code"

echo
echo "== 6. 数据库 =="
if command -v sqlite3 >/dev/null 2>&1; then
  rows="$(sqlite3 "$(cd "$(dirname "$0")/../.." && pwd)/data/memory.db" "SELECT COUNT(*) FROM memories WHERE content LIKE '%${MARK}%';" 2>/dev/null || echo 0)"
  [ "${rows:-0}" -ge 1 ] && ok "SQLite 落盘" "匹配 $rows 行" || no "SQLite 落盘" "未查到标记"
fi

echo
printf 'PASS=%d  FAIL=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
