# 知忆（Zhiyi）· 真实环境联调报告（macOS 本机 · 无 Docker）

- 执行日期：2026-11-11
- 主机：macOS 26.6.2（arm64）
- 结论：**主链路（ADP UI → Personal AI → 真实模型 → SQLite / 记忆）PASS**；
  **真实 MultiCA Agent 执行 BLOCKED**（需浏览器 OAuth 登录，未由自动化代替）。

---

## 一、总览

| 项 | 结果 | 证据 |
|---|---|---|
| Build | **PASS** | `tsc -p tsconfig.json` 零错误 |
| 自动化测试 | **PASS** | 7 文件 / **71 用例**全通过 |
| Gateway 健康 | **PASS** | `/health` status=ok、db=ok、upstream.mode=remote |
| Personal AI Runtime | **PASS** | `/health/personal-ai` enabled=true、protocol=openai |
| SQLite | **PASS** | 迁移 001/002/003；memories/contexts/trajectories 有真实数据 |
| 真实模型 | **PASS** | `DeepSeek-V4-Flash-baidu-oneapi` 返回真实内容（非 Mock） |
| ADP 后端 | **PASS** | `/application/list` 返回「知忆」（品牌名；内部 ApplicationId 仍为 `personal-ai`） |
| ADP UI | **PASS** | <http://127.0.0.1:5174/> 真实浏览器对话 3 轮 |
| 记忆 | **PASS** | 回答主动引用 Rust / local-first / Bluebird / 禁 K8s；日志 `memory=on` |
| MultiCA CLI | **BLOCKED** | `multica auth status` = Not authenticated；daemon = stopped |
| 真实 Agent 执行 | **BLOCKED** | 需 `multica setup cloud` 浏览器 OAuth + `multica daemon start` |
| Docker 使用 | **None** | 全流程本机进程 |

---

## 二、运行中的服务（本机进程）

| 服务 | 地址 | 进程 |
|---|---|---|
| Personal AI Gateway | http://127.0.0.1:8790 | `node dist/src/server.js` |
| ADP 后端（Sanic） | http://127.0.0.1:8000 | `.venv/bin/python` + `app_factory` |
| ADP 前端（Vite） | http://127.0.0.1:5174 | `vite` |
| PostgreSQL | 127.0.0.1:5433 | embedded-postgres（数据目录 `data/pgdata`） |
| 模型代理（外部依赖） | http://127.0.0.1:8787 | 本机既有进程，未被本项目占用/修改 |

日志位置：`data/logs/{gateway,adp-server,adp-client,postgres}.log`。

---

## 三、逐场景结果（用户验收 A–G）

### 场景 A：普通问答 — **PASS**

浏览器实测（ADP UI）：

- 用户：`你好，请用两句话介绍你能做什么。`
- 回复：`我能帮你理解技术需求、检索长期记忆，并在需要时委派专业研发 Agent 执行具体任务……结合你 Rust 与本地优先的偏好，我会优先给出符合 Bluebird 方向且不引入 Kubernetes 的方案。`

说明：UI 渲染、SSE 流式展示、真实模型调用、记忆注入同时生效。

### 场景 B：多轮对话 — **PASS**

同一会话连续三轮：

1. `你好，请用两句话介绍你能做什么。`
2. `我目前正在开发一个 Personal AI Gateway 项目。`
3. `我目前正在开发什么项目？`

第三轮回复：`你正在开发 Personal AI Gateway 项目。结合你的偏好，方向是 Rust + 本地优先（local-first），代号 Bluebird，且不引入 Kubernetes。`

说明：ADP 把历史消息带入 Gateway，Gateway 按 `X-Conversation-Id` 维护 `conversation_contexts`（本次实测 8 条会话上下文）。

### 场景 C：长期记忆 — **PASS**

1. 通过 `POST /v1/memories` 写入：
   `用户偏好：技术方案优先选择 Rust 语言与本地优先（local-first）架构，项目代号 Bluebird，禁止引入 Kubernetes。`
2. Gateway 日志出现 `memory=on`（无相关记忆的请求为 `memory=off`）。
3. 真实模型回答主动引用该记忆。
4. 对照实验：`dev-key-user2` 同一问题得到完全不同的通用架构建议，未出现 Rust/Bluebird/K8s。

### 场景 D：Agent 委派 — **BLOCKED**

- `multica auth status` → `Not authenticated. Run 'multica login'`
- `multica daemon status` → `Daemon: stopped`
- `MULTICA_ENABLED=false`（避免产生必然失败的任务）

未使用 Stub 冒充真实执行。启用步骤见 `docs/LOCAL-DEPLOYMENT.md` §7.6。

### 场景 E：任务失败 — **BLOCKED**

原因同上：无法创建真实 MultiCA 任务。失败状态机已由 71 个自动化用例覆盖（maxPolls→failed、dispatch 失败、取消优先于失败），但**不代表真实环境已验证**。

### 场景 F：用户隔离 — **PASS**

| 检查 | 结果 |
|---|---|
| u2 检索 u1 的 Rust/Bluebird 记忆 | `count=0` |
| u2 读取 u1 记忆详情 | HTTP `404` |
| u2 任务列表 | `items=0` |
| 请求 body 伪造 `user_id=u1` 创建记忆 | 落库 `user_id=u2`（伪造被忽略） |

### 场景 G：服务重启 — **PASS（内部）/ BLOCKED（外部 Agent）**

- 停止并重启 Gateway 后：`/health` ok、`upstream.mode=remote`
- 数据保留（**重启当时快照**，后续对话会继续增长，最新值以数据库为准）：memories=3、conversation_contexts=8、trajectories=10
- 重启后真实模型对话正常（`model=DeepSeek-V4-Flash-baidu-oneapi`，回复「服务正常」）
- **外部 Agent 恢复未验证**：当前无真实 MultiCA 任务，`execution_tasks=0`。
  内部任务恢复逻辑（`recover()` + `claimForDispatch`）已有自动化用例，但不等于外部进程可恢复。

---

## 四、健康检查与冒烟

`bash scripts/local/check-health.sh` → **PASS=7 FAIL=0**

`bash scripts/local/smoke-e2e.sh` → **PASS=11 FAIL=0**，覆盖：

1. 模型上游为真实模式（mode=remote）
2. 记忆创建 / u1 检索命中 / u2 检索 0
3. 非流式真实模型返回内容，model 非 mock
4. 流式 SSE 收到 `delta.content` 与 `[DONE]`
5. ADP 应用注册 + UI HTTP 200
6. SQLite 落盘校验

---

## 五、本次部署中发现并修复的代码问题

真实模型联调暴露了两个此前 Mock 环境无法发现的问题，均已在 `src/extractor.ts` 最小修复：

1. **提取器未携带 `Authorization`**：原先只发 `content-type`，对需要鉴权的真实上游会直接 401/403。
   已改为当 `upstreamApiKey` 存在时附带 `Bearer`。
2. **上游不支持 `response_format: json_object`**：本机模型代理返回 `400 unsupported response_format`。
   已改为遇到 400 自动重试一次「纯提示词」模式，并增强 JSON 解析（兼容 ```json 围栏与前后说明文字）。
   修复后日志：`上游不支持 response_format=json_object，改用纯提示词模式重试提取` → `提取到 1 条候选记忆`。
3. **非流式 `usage` 恒为 0**：原先硬编码 `{0,0,0}`。已改为请求上游时带 `stream_options.include_usage`，
   读取流末尾的 `usage` 并回填到非流式响应（实测 `prompt=199 / completion=13 / total=212`）。
4. **上游错误以 HTTP 200 返回**：非流式路径原先把错误文本拼进 `choices[0].message.content`。
   已改为返回上游对应的 4xx/5xx 状态码 + OpenAI 风格错误体
   （实测非法模型 → `HTTP 400`，`error.code=upstream_error`）。

修复后全量测试仍为 **71/71**（并新增 1 条「非流式上游错误→4xx」回归用例，扩展 1 条 usage 断言）。

---

## 六、未验证 / 限制

| 项 | 状态 | 原因 |
|---|---|---|
| ADP UI 与真实 MultiCA 的联合链路 | BLOCKED | MultiCA 未登录、daemon 未启动 |
| 真实 Agent（Codex/Claude Code）执行 | BLOCKED | 同上；CLI 已安装但 MultiCA 未注册执行器 |
| 任务进度/取消/重启恢复（真实任务） | BLOCKED | 无真实任务可创建 |
| Docker 部署 | NOT TESTED | 本次明确不使用 Docker |
| OnePAI 官方端点 | NOT TESTED | 使用本机 OpenAI 兼容代理（模型名 `*-baidu-oneapi`） |
| 本会话的 Node 注入 shim | 环境相关 | 本会话注入了 `NODE_OPTIONS` shim，构建/测试需 `env -u NODE_OPTIONS`；普通终端不受影响，脚本未做特殊处理 |

---

## 七、可复现步骤

```bash
# 1) 环境自检
bash scripts/local/check-env.sh

# 2) PostgreSQL（首次需 npm install --prefix data/pg-node embedded-postgres）
node scripts/local/start-postgres.mjs

# 3) Gateway（另开终端）
bash scripts/local/start-gateway.sh

# 4) ADP（另开终端，首次需 uv sync / npm install / 组件构建）
bash scripts/local/start-adp.sh

# 5) 健康检查与冒烟
bash scripts/local/check-health.sh
bash scripts/local/smoke-e2e.sh

# 6) 浏览器
open http://127.0.0.1:5174/
```

停止：`bash scripts/local/stop-local.sh`。
