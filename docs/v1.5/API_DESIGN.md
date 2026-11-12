# 知忆（Zhiyi）Personal AI V1.5 · API 接口设计文档

> **状态**：Draft · **适用范围**：Universal Memory Gateway / Personal AI V1 → V1.5 演进
>
> 本文档定义 V1.5 全部 HTTP/SSE 接口契约、鉴权与用户隔离规则、V1 向后兼容策略、请求/响应 TypeScript 类型与 JSON 示例、错误码体系、SSE 事件扩展规范及版本演进策略。
> 配套文档：`docs/v1.5/DATA_MODEL.md`、`docs/v1.5/RUNTIME_DESIGN.md`、`docs/v1.5/ARCHITECTURE_GAP_ANALYSIS.md`。

---

## 目录

1. [API 设计原则](#1-api-设计原则)
2. [认证与授权（Authentication & Authorization）](#2-认证与授权authentication--authorization)
3. [向后兼容策略（Backward Compatibility Strategy）](#3-向后兼容策略backward-compatibility-strategy)
4. [API 全量目录（API Catalog）](#4-api-全量目录api-catalog)
5. [新增接口详细规范（Detailed Endpoint Specifications）](#5-新增接口详细规范detailed-endpoint-specifications)
   - [5.1 Goal Management（目标管理）](#51-goal-management目标管理)
   - [5.2 Project Management（项目管理）](#52-project-management项目管理)
   - [5.3 Milestone Management（里程碑管理）](#53-milestone-management里程碑管理)
   - [5.4 Business Task Management（业务任务管理 `/v1/personal-ai/work-tasks`）](#54-business-task-management业务任务管理-v1personal-aiwork-tasks)
   - [5.5 Agent Registry Extensions（Agent 注册表扩展）](#55-agent-registry-extensionsagent-注册表扩展)
   - [5.6 Approval Management（高风险审批管理）](#56-approval-management高风险审批管理)
   - [5.7 User Profile（用户画像与偏好）](#57-user-profile用户画像与偏好)
   - [5.8 Proactive Schedules（定时任务调度）](#58-proactive-schedules定时任务调度)
   - [5.9 Notifications（异步通知管理）](#59-notifications异步通知管理)
   - [5.10 Memory Links（记忆与业务实体关联）](#510-memory-links记忆与业务实体关联)
6. [错误码参考（Error Code Reference）](#6-错误码参考error-code-reference)
7. [SSE 事件扩展规范（SSE Event Extensions）](#7-sse-事件扩展规范sse-event-extensions)
8. [版本控制策略（Versioning Strategy）](#8-版本控制策略versioning-strategy)

---

## 1. API 设计原则

1. **统一路径前缀**：所有 Personal AI V1.5 新增业务接口统一挂载于 `/v1/personal-ai/*`；Agent 注册表扩展沿用现有 `/v1/agents/*`。**不引入 `/v1.5/*` 路径分裂**。
2. **字段命名规范（`snake_case`）**：与现有 `src/types.ts`、`src/personal-ai/task/task-repository.ts` 及 SQLite Schema 保持一致，所有 JSON 请求体、响应体及查询参数均采用 `snake_case`。
3. **ID 前缀规范**：所有主实体 ID 均带有显式语义前缀 + UUIDv4（`randomUUID()`），便于日志排查与排障定位：
   - User Profile：`user_id`（来自服务端 API Key 映射，如 `u1`）
   - Goal：`goal_<uuid>`
   - Project：`proj_<uuid>`
   - Milestone：`ms_<uuid>`
   - Business Task（`tasks` 表）：`btask_<uuid>`
   - Execution Task（`execution_tasks` 表）：`task_<uuid>`（沿用 V1）
   - Approval Request：`apr_<uuid>`
   - Scheduled Job：`sj_<uuid>`
   - Notification：`ntf_<uuid>`
   - Memory Link：`mlink_<uuid>`
4. **严格用户隔离（Server-side Identity）**：客户端不可指定或覆盖 `user_id`。任何属于其他用户的资源在 `GET`/`PATCH`/`POST`/`DELETE` 中一律返回 `404 not_found`（不泄露资源存在性）。
5. **统一错误响应体**：所有错误（含参数校验失败、认证失败、状态冲突、资源不存在、内部异常）严格复用 `src/errors.ts` 的 `errorBody(message, code, type)`：
   ```typescript
   export interface ErrorEnvelope {
     error: {
       message: string;
       type: string;
       code: string;
     };
   }
   ```
6. **一致的分页与过滤模式**：
   - 新增列表接口统一支持 `limit`（默认 `50`，有效范围 `1..200`，超出钳制）与 `offset`（默认 `0`，`>= 0`）。
   - 新增列表接口统一返回 `{ items: T[], total: number, limit: number, offset: number }`（与现有 `src/trajectories.ts` `TrajectoryPage` 一致）。
   - 既有 V1 列表接口（如 `GET /v1/personal-ai/tasks` 返回 `{ items }`、`GET /v1/memories` 返回 `{ items, count, total }`）保持原响应结构不变。
7. **时间戳格式**：所有日期时间字段采用 ISO 8601 UTC 字符串（`new Date().toISOString()`，如 `2026-11-12T08:30:00.000Z`）；纯日期字段（如 `target_date`）支持 `YYYY-MM-DD` 或完整 ISO 8601 字符串。
8. **幂等性保障**：触发执行等会产生副作用的写操作支持可选 `idempotency_key` 或复用 `(user_id, request_id)` 唯一约束，防止网络重试产生重复执行记录。

---

## 2. 认证与授权（Authentication & Authorization）

### 2.1 三类路由的鉴权机制（对齐现有源码）

| 路由组 | 源码位置 | 鉴权方式 | 身份来源 |
|---|---|---|---|
| **MVP Memory / Agent / Proxy** | `src/routes.ts`、`src/identity.ts` | `Authorization: Bearer <api_key>` 或 `X-API-Key: <api_key>` | 查 `config.apiKeys[apiKey]`，未命中时回落到 `config.defaultIdentity`（本地 PoC）；客户端 body 中的 `user_id`/`agent_id` 忽略 |
| **Personal AI Runtime & V1.5 业务接口** | `src/personal-ai/routes.ts`、`src/personal-ai/identity/identity-manager.ts` | 1. `Authorization: Bearer <api_key>` 或 `X-API-Key: <api_key>`<br>2. 可选 HMAC-SHA256 签名校验（配置 `PERSONAL_AI_SHARED_SECRET` 时强制） | 查 `config.apiKeys[apiKey]` -> `{ user_id, agent_id }`（未配置时回落 `'u1'` / `'developer'`） |
| **模型服务设置与模型列表** | `src/upstream/routes.ts` | `ZHIYI_SETTINGS_TOKEN` 非空时校验 `Authorization: Bearer <ZHIYI_SETTINGS_TOKEN>`；为空时仅允许 loopback IP（`127.0.0.1` / `::1`） | 管理员级局部配置，不绑定用户业务数据 |

### 2.2 Personal AI HMAC-SHA256 签名校验规则

当环境变量 `PERSONAL_AI_SHARED_SECRET` 非空时，所有 `/v1/personal-ai/*` 请求必须携带以下请求头：
- `X-PersonalAI-Timestamp`：毫秒级 Unix 时间戳（字符串），与服务端时钟差不得超过 `PERSONAL_AI_SIGNATURE_MAX_AGE_MS`（默认 `300000` ms = 5 分钟）。
- `X-PersonalAI-Signature`：`hex(HMAC_SHA256(secret, "${timestamp}.${rawBody}"))`。

> **实现注意（针对 `GET` / `DELETE` 等无 Body 请求）**：
> 现有 `src/personal-ai/routes.ts:87` 使用 `(req as RawBodyRequest).rawBody ?? JSON.stringify(body)`。对于 `GET`/`DELETE` 请求，`express.json()` 不解析空 body，`rawBody` 为 `undefined` 且 `body` 为 `{}`，导致签名原文实际为 `"{}"`。V1.5 建议统一约定：无请求体方法（`GET`、`HEAD`、`DELETE`）或 `Content-Length === 0` 时 `rawBody` 统一视作空字符串 `""`（同时在兼容期允许 `""` 或 `"{}"` 二选一通过），并在客户端 SDK 文档中明确说明。

### 2.3 上下文请求头（可选透传）

所有路由均支持通过 Header（或部分 POST body 字段）传入以下非鉴权上下文标识（长度截断至 200 字符）：
- `X-Request-Id`：请求幂等与轨迹关联标识（缺失时自动生成 `req_<uuid>`）。
- `X-Session-Id`：会话标识。
- `X-Conversation-Id`：对话标识（缺失时在对话接口由 `sha256(user_id + "\0" + firstUserMsg)` 自动推导为 `conv_<24hex>`）。
- `X-Project-Id`：当前关联项目上下文（用于记忆检索加权与执行归属）。
- `X-Task-Id`：当前关联任务上下文。

### 2.4 资源级授权矩阵

| 资源 / 操作 | 所有权检查 | 特殊授权规则 |
|---|---|---|
| `goals`、`projects`、`milestones`、`work-tasks`、`approvals`、`schedules`、`notifications`、`profile`、`memory_links` | 强制 `WHERE user_id = identity.user_id` | 仅资源所有者可读写；跨用户访问统一返回 `404 not_found` |
| `execution_tasks`（`/v1/personal-ai/tasks*`） | 强制 `WHERE user_id = identity.user_id` | 仅任务发起用户可查询或取消 |
| `GET /v1/agents`、`GET /v1/agents/:id/profile`、`GET /v1/agents/:id/status` | 全局共享的 Agent 定义（与 V1 `src/routes.ts:244-255` 一致） | 所有已认证用户可读 |
| `POST /v1/agents`、`PATCH /v1/agents/:id` | V1 本地单租户下允许已认证调用方维护；多租户 / 生产模式建议要求管理权限（`ZHIYI_SETTINGS_TOKEN` 或 `identity.role === 'admin'`） | 当 Agent 的 `permission_policy` 限制操作时，运行时由 `PolicyChecker` 拦截，不依赖客户端声明 |
| `approval_requests` 决议（`approve` / `reject` / `revoke`） | 必须校验 `approval.user_id === identity.user_id` | 若审批请求对应高风险操作，Agent 自身不得代用户调用 `/approve`（需有效用户上下文） |

---

## 3. 向后兼容策略（Backward Compatibility Strategy）

### 3.1 核心兼容原则（Scheme B：双表分离 + 原路径冻结）

在 V1 中，`execution_tasks` 表承担了「Agent 异步执行追踪」职责，`src/personal-ai/routes.ts` 暴露了三个任务端点：
- `GET /v1/personal-ai/tasks`
- `GET /v1/personal-ai/tasks/:id`
- `POST /v1/personal-ai/tasks/:id/cancel`

同时，V1 的既有测试（`tests/personal-ai.test.ts`、`tests/qa-regression.test.ts`）及 `GET /health/personal-ai` 直接依赖 `execution_tasks` 表名、`status = 'completed'` 枚举值以及上述三个接口的精确返回格式。

为此，V1.5 采用 **Scheme B 渐进演进策略**：
1. **数据层保留 `execution_tasks`**：不重命名、不删除 `execution_tasks` 表，仅在 `migrations/004_v1_5.sql` 中追加 `task_id TEXT REFERENCES tasks(id)`（可空）和 `timeout_at TEXT`，并将合法状态扩展为 `('pending','dispatching','running','completed','failed','cancelled','timeout')`（**保留 `'completed'` 而非改为 `'succeeded'`**，确保 V1 `TaskRepository`、`TaskWorker`、`routes.ts:334` 零修改通过全量 104 项回归测试）。
2. **V1 `/v1/personal-ai/tasks*` 契约完全冻结**：
   - `GET /v1/personal-ai/tasks` 继续查询 `execution_tasks`，返回 `{ items: ExecutionTask[] }`（`task_id` 与 `timeout_at` 作为新增可空字段附带返回，不破坏既有字段类型）。
   - `GET /v1/personal-ai/tasks/:id` 继续直接返回 `ExecutionTask` 顶层对象（`res.json(task)`，**不包装在 `{ task }` 中**，保持与 `src/personal-ai/routes.ts:250` 完全一致）。
   - `POST /v1/personal-ai/tasks/:id/cancel` 继续对 `execution_tasks` 执行 `updateIfActive()` CAS 取消并返回 `{ ok, task, external_cancelled, note }`；若该 `execution_task` 关联了 `task_id`，后台同步更新对应业务任务状态（不改变本接口返回体）。
3. **业务任务启用独立资源路径 `/v1/personal-ai/work-tasks`**：
   - 所有业务任务（`tasks` 表，ID 前缀 `btask_`）的 CRUD、子任务拆分、手动触发执行（`POST /:id/execute`）及执行历史查询（`GET /:id/executions`）均挂载于 `/v1/personal-ai/work-tasks*`。
   - 相比在 `/v1/personal-ai/tasks` 上复用 `?view=business` 参数，独立路径 `/work-tasks` 可彻底避免旧客户端把 `btask_` ID 传给 `GET /tasks/:id` 时的语义混乱与静态类型冲突。

### 3.2 V1 → V1.5 客户端迁移路径

| 阶段 | 兼容状态 | 客户端指引 |
|---|---|---|
| **Phase 1（V1.5 上线）** | `/v1/personal-ai/tasks*` 与 `/v1/personal-ai/work-tasks*` 并行提供；对话接口 `/v1/personal-ai/chat/completions` 与 `/v1/personal-ai/messages` 在 `PLANNER_V15_ENABLED=false` 时 100% 保持 V1 行为 | 现有 ADP Chat Client 与脚本无需任何改动；新前端工作台接入 `/work-tasks`、`/goals`、`/projects`、`/milestones`、`/approvals`、`/profile` |
| **Phase 2（功能切换）** | 开启 `PLANNER_V15_ENABLED=true`；Runtime 自动创建业务任务（`btask_`）并关联 `execution_tasks.task_id` | 对话流返回的进度文本与 `GET /v1/personal-ai/tasks` 仍可读到全部 `task_` 执行记录；工作台通过 `GET /work-tasks/:id/executions` 查看完整业务-执行树 |
| **Phase 3（V2 规划）** | 标记 `/v1/personal-ai/tasks*` 为 `Deprecation: true`（响应头提示迁移至 `/v1/personal-ai/executions*` 或 `/work-tasks/:id/executions`），保留整个 V1.x 周期不停服 | 新调用方统一使用业务任务与执行关联模型 |

---

## 4. API 全量目录（API Catalog）

### 4.1 既有接口（V1 — 保持兼容）

| 分组 | Method & Path | 说明 | 鉴权 | 状态 |
|---|---|---|---|---|
| **健康检查** | `GET /health` | 基础健康、DB 与模型上游模式 | 无 / 默认身份 | V1 保持 |
| | `GET /health/personal-ai` | ADP / Personal AI / Memory / MultiCA daemon / 活跃任务数 | 无 | V1 保持 |
| **记忆管理** | `POST /v1/memories` | 创建记忆 | Bearer / API Key | V1 保持 |
| | `GET /v1/memories` | 列表查询（`agent_id`, `project_id`, `type`, `scope`, `limit`, `offset`） | Bearer / API Key | V1 保持 |
| | `POST /v1/memories/search` | 关键词检索记忆（V1.5 内部可扩展关联实体加权） | Bearer / API Key | V1 保持 |
| | `GET /v1/memories/:id` | 获取单条记忆 | Bearer / API Key | V1 保持 |
| | `PATCH /v1/memories/:id` | 更新记忆 | Bearer / API Key | V1 保持 |
| | `DELETE /v1/memories/:id` | 删除记忆 | Bearer / API Key | V1 保持 |
| **Agent 基础** | `POST /v1/agents` | 创建/覆盖 Agent Profile | Bearer / API Key | V1 保持 |
| | `GET /v1/agents` | 列出所有 Agent（V1.5 返回扩展字段） | Bearer / API Key | V1 扩展字段 |
| | `GET /v1/agents/:id/profile` | 获取 Agent 详情（V1.5 返回扩展字段） | Bearer / API Key | V1 扩展字段 |
| **轨迹与候选** | `POST /v1/trajectories` | 保存对话轨迹（按 `(user_id, request_id)` 去重） | Bearer / API Key | V1 保持 |
| | `GET /v1/trajectories` | 分页查询轨迹（`TrajectoryPage`） | Bearer / API Key | V1 保持 |
| | `GET /v1/memory-candidates` | 列出候选记忆 | Bearer / API Key | V1 保持 |
| | `POST /v1/memory-candidates/:id/approve` | 批准候选转为正式记忆 | Bearer / API Key | V1 保持 |
| | `POST /v1/memory-candidates/:id/reject` | 拒绝候选记忆 | Bearer / API Key | V1 保持 |
| **模型代理** | `POST /v1/chat/completions` | OpenAI 兼容透传代理（含记忆注入与轨迹提取） | Bearer / API Key | V1 保持 |
| **Personal AI 对话** | `POST /v1/personal-ai/chat/completions` | Personal AI 主对话入口（支持 `stream: true/false`、`openai`/`adp-v2`） | Bearer + 可选 HMAC | V1 保持 |
| | `POST /v1/personal-ai/messages` | ADP V2 SSE 直连入口（严格 11 事件白名单） | Bearer + 可选 HMAC | V1 保持 |
| **V1 执行任务** | `GET /v1/personal-ai/tasks` | 列出 `execution_tasks`（支持新增可选过滤参数，默认返回完全不变） | Bearer + 可选 HMAC | V1 兼容 |
| | `GET /v1/personal-ai/tasks/:id` | 获取单条 `execution_tasks` | Bearer + 可选 HMAC | V1 兼容 |
| | `POST /v1/personal-ai/tasks/:id/cancel` | 取消执行任务（CAS + MultiCA 取消） | Bearer + 可选 HMAC | V1 兼容 |
| **上游设置** | `GET /settings` | 本地模型配置页面（HTML，仅掩码） | 无（掩码） | V1 保持 |
| | `GET /v1/zhiyi/settings` | 读取当前模型上游配置视图 | Loopback / Settings Token | V1 保持 |
| | `PUT /v1/zhiyi/settings` | 更新模型上游配置 | Loopback / Settings Token | V1 保持 |
| | `POST /v1/zhiyi/settings/reset` | 重置上游配置 | Loopback / Settings Token | V1 保持 |
| | `GET /v1/zhiyi/models` | 查询上游可用模型 | Loopback / Settings Token | V1 保持 |
| | `POST /v1/zhiyi/settings/test` | 连通性测试 | Loopback / Settings Token | V1 保持 |
| | `POST /v1/zhiyi/settings/ducx/refresh` | 刷新 DUCX 凭证 | Loopback / Settings Token | V1 保持 |
| | `POST /v1/zhiyi/settings/ducx/report/test` | DUCX 上报测试 | Loopback / Settings Token | V1 保持 |
| | `GET /v1/models` | OpenAI 兼容模型列表 | Loopback / Settings Token | V1 保持 |
| **Mock 调试** | `GET /__mock__/last-request`、`POST /__mock__/configure`、`POST /__mock__/reset`、`POST /mock/v1/chat/completions` | 仅 `MOCK_UPSTREAM=true` 时挂载 | 同 MVP | V1 保持 |

### 4.2 新增接口（V1.5）

| 分组 | Method & Path | 说明 | 鉴权 |
|---|---|---|---|
| **Goal Management** | `POST /v1/personal-ai/goals` | 创建长期目标 | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/goals` | 列出目标（支持 `status`, `priority`, `limit`, `offset`） | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/goals/:id` | 获取目标详情（含关联项目/里程碑摘要） | Bearer + 可选 HMAC |
| | `PATCH /v1/personal-ai/goals/:id` | 更新目标（标题、描述、状态、优先级、目标日期、关联项目） | Bearer + 可选 HMAC |
| | `POST /v1/personal-ai/goals/:id/archive` | 归档/关闭目标（标记为 `achieved` 或 `abandoned`） | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/goals/:id/progress` | 聚合目标进度（关联里程碑、项目与任务统计） | Bearer + 可选 HMAC |
| | `POST /v1/personal-ai/goals/:id/projects` | 关联 Goal 与 Project（`goal_projects` M:N） | Bearer + 可选 HMAC |
| | `DELETE /v1/personal-ai/goals/:id/projects/:projectId` | 解除 Goal 与 Project 关联 | Bearer + 可选 HMAC |
| **Project Management** | `POST /v1/personal-ai/projects` | 创建项目（可选直接绑定 `goal_ids`） | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/projects` | 列出项目（支持 `status`, `goal_id`, `limit`, `offset`） | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/projects/:id` | 获取项目详情 | Bearer + 可选 HMAC |
| | `PATCH /v1/personal-ai/projects/:id` | 更新项目 | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/projects/:id/tasks` | 列出项目下的业务任务 | Bearer + 可选 HMAC |
| **Milestone Management** | `POST /v1/personal-ai/milestones` | 创建里程碑（需绑定 `goal_id` 或 `project_id`） | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/milestones` | 列出里程碑（`goal_id`, `project_id`, `status`, `limit`, `offset`） | Bearer + 可选 HMAC |
| | `PATCH /v1/personal-ai/milestones/:id` | 更新里程碑状态或信息 | Bearer + 可选 HMAC |
| **Business Task Management** | `POST /v1/personal-ai/work-tasks` | 创建业务任务（支持子任务 `parent_task_id`） | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/work-tasks` | 列出业务任务（支持多维过滤与分页） | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/work-tasks/:id` | 获取业务任务详情（含子任务与最近执行摘要） | Bearer + 可选 HMAC |
| | `PATCH /v1/personal-ai/work-tasks/:id` | 更新业务任务属性或状态 | Bearer + 可选 HMAC |
| | `POST /v1/personal-ai/work-tasks/:id/cancel` | 取消业务任务（级联取消活跃 `execution_tasks`） | Bearer + 可选 HMAC |
| | `POST /v1/personal-ai/work-tasks/:id/execute` | 触发业务任务执行（Policy 校验 + 创建 `execution_tasks`） | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/work-tasks/:id/executions` | 列出该业务任务的全部执行记录 | Bearer + 可选 HMAC |
| **Agent Registry** | `PATCH /v1/agents/:id` | 更新 Agent 能力、权限策略、执行后端、状态与并发限制 | Bearer / API Key |
| | `GET /v1/agents/:id/status` | 查询 Agent 实时可用状态、并发槽位与执行后端状态 | Bearer / API Key |
| **Approval Management** | `GET /v1/personal-ai/approvals` | 列出待审批/历史审批请求 | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/approvals/:id` | 获取单条审批请求详情 | Bearer + 可选 HMAC |
| | `POST /v1/personal-ai/approvals/:id/approve` | 批准高风险操作（触发续跑或放行） | Bearer + 可选 HMAC |
| | `POST /v1/personal-ai/approvals/:id/reject` | 拒绝高风险操作（终止或阻塞对应执行） | Bearer + 可选 HMAC |
| | `POST /v1/personal-ai/approvals/:id/revoke` | 撤销已批准但尚未完成/作用域内授权 | Bearer + 可选 HMAC |
| **User Profile** | `GET /v1/personal-ai/profile` | 获取当前用户画像与偏好 | Bearer + 可选 HMAC |
| | `PATCH /v1/personal-ai/profile` | 更新用户昵称、时区、工作风格与偏好 | Bearer + 可选 HMAC |
| **Proactive Schedules** | `POST /v1/personal-ai/schedules` | 创建定时任务（cron + 时区 + 任务模板） | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/schedules` | 列出定时任务 | Bearer + 可选 HMAC |
| | `PATCH /v1/personal-ai/schedules/:id` | 更新定时任务（含暂停/恢复/停用） | Bearer + 可选 HMAC |
| | `DELETE /v1/personal-ai/schedules/:id` | 删除定时任务 | Bearer + 可选 HMAC |
| **Notifications** | `GET /v1/personal-ai/notifications` | 列出用户异步通知 | Bearer + 可选 HMAC |
| | `POST /v1/personal-ai/notifications/:id/read` | 标记单条通知已读 | Bearer + 可选 HMAC |
| | `POST /v1/personal-ai/notifications/read-all` | 全部未读通知标记已读 | Bearer + 可选 HMAC |
| **Memory Links** | `POST /v1/personal-ai/memories/links` | 建立记忆与 Goal/Project/Task 的显式关联 | Bearer + 可选 HMAC |
| | `GET /v1/personal-ai/memories/links` | 查询实体关联的记忆 | Bearer + 可选 HMAC |
| | `DELETE /v1/personal-ai/memories/links/:id` | 解除记忆关联 | Bearer + 可选 HMAC |

---

## 5. 新增接口详细规范（Detailed Endpoint Specifications）

> **通用声明**：以下所有 `/v1/personal-ai/*` 接口均强制通过 `resolvePersonalAIIdentity` 校验：
> - 当 `PERSONAL_AI_SHARED_SECRET` 非空时校验 HMAC-SHA256 签名（失败返回 `401 unauthorized`）。
> - 客户端请求体中的 `user_id` 一律忽略，服务端强制注入 `identity.user_id`。
> - 所有资源按 `user_id` 隔离，越权或不存在的资源统一返回 `404 not_found`。

---

### 5.1 Goal Management（目标管理）

#### 共享类型定义

```typescript
export type GoalStatus = 'draft' | 'active' | 'achieved' | 'abandoned' | 'paused';
export type PriorityLevel = 0 | 1 | 2 | 3 | 4; // 0=none, 1=low, 2=medium, 3=high, 4=urgent

export interface Goal {
  id: string;                 // "goal_<uuid>"
  user_id: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: PriorityLevel;
  target_date: string | null; // ISO 8601 date or datetime
  created_at: string;
  updated_at: string;
}
```

#### 5.1.1 `POST /v1/personal-ai/goals` — 创建目标

- **Authorization**: 已认证用户（`identity.user_id` 作为 `goals.user_id`）。
- **Request Body**:
```typescript
export interface CreateGoalRequest {
  title: string;                // 必填，非空，trim 后 1..200 字符
  description?: string;         // 默认 ""
  status?: 'draft' | 'active';  // 创建时仅允许 draft | active，默认 "active"
  priority?: PriorityLevel;     // 默认 0
  target_date?: string | null;  // ISO 8601 日期，如 "2026-12-31"
  project_ids?: string[];       // 可选，初始关联的当前用户项目 ID 列表
}
```
- **Response (`201 Created`)**:
```json
{
  "goal": {
    "id": "goal_7b2d9a10-4c11-4b88-9b30-2a1e5f9c0001",
    "user_id": "u1",
    "title": "在 Q4 完成知忆 V1.5 架构落地",
    "description": "完成个人目标、项目、任务与多 Agent 协同能力设计及实施",
    "status": "active",
    "priority": 3,
    "target_date": "2026-12-31",
    "created_at": "2026-11-12T08:00:00.000Z",
    "updated_at": "2026-11-12T08:00:00.000Z"
  },
  "linked_project_ids": ["proj_001"]
}
```
- **Error Responses**:
  - `400 bad_request`: `title` 为空、`status` 非法、`priority` 不在 `0..4`、`target_date` 格式无效。
  - `404 not_found`: `project_ids` 中存在不属于当前用户或不存在的项目 ID（`project_not_found`）。
  - `401 unauthorized`: 签名校验失败。

#### 5.1.2 `GET /v1/personal-ai/goals` — 列出目标

- **Query Parameters**:
  - `status?: GoalStatus`（支持逗号分隔多值，如 `active,paused`）
  - `priority?: PriorityLevel`
  - `limit?: number`（默认 `50`，`1..200`）
  - `offset?: number`（默认 `0`）
- **Response (`200 OK`)**:
```json
{
  "items": [
    {
      "id": "goal_7b2d9a10-4c11-4b88-9b30-2a1e5f9c0001",
      "user_id": "u1",
      "title": "在 Q4 完成知忆 V1.5 架构落地",
      "description": "完成个人目标、项目、任务与多 Agent 协同能力设计及实施",
      "status": "active",
      "priority": 3,
      "target_date": "2026-12-31",
      "created_at": "2026-11-12T08:00:00.000Z",
      "updated_at": "2026-11-12T08:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```
- **Error Responses**:
  - `400 invalid_status` / `400 bad_request`: 非法查询参数。
  - `401 unauthorized`: 签名校验失败。

#### 5.1.3 `GET /v1/personal-ai/goals/:id` — 获取目标详情

- **Response (`200 OK`)**:
```json
{
  "goal": {
    "id": "goal_7b2d9a10-4c11-4b88-9b30-2a1e5f9c0001",
    "user_id": "u1",
    "title": "在 Q4 完成知忆 V1.5 架构落地",
    "description": "完成个人目标、项目、任务与多 Agent 协同能力设计及实施",
    "status": "active",
    "priority": 3,
    "target_date": "2026-12-31",
    "created_at": "2026-11-12T08:00:00.000Z",
    "updated_at": "2026-11-12T08:00:00.000Z"
  },
  "projects": [
    { "id": "proj_001", "title": "universal-memory-gateway", "status": "active" }
  ],
  "milestones": [
    { "id": "ms_001", "title": "完成 V1.5 架构设计文档", "status": "in_progress", "target_date": "2026-11-15" }
  ]
}
```
- **Error Responses**: `404 not_found`（目标不存在或属于其他用户）、`401 unauthorized`。

#### 5.1.4 `PATCH /v1/personal-ai/goals/:id` — 更新目标

- **Request Body**:
```typescript
export interface UpdateGoalRequest {
  title?: string;
  description?: string;
  status?: GoalStatus;
  priority?: PriorityLevel;
  target_date?: string | null;
}
```
- **Response (`200 OK`)**: `{ "goal": { ... } }`
- **Error Responses**:
  - `400 bad_request`: 空更新体、`title` 为空串或枚举值非法。
  - `404 not_found`: 目标不存在或无权访问。
  - `409 invalid_state_transition`: 已达终态（`achieved` / `abandoned`）若策略不允许直接回到 `draft` 等非法转换时返回 `409`。

#### 5.1.5 `POST /v1/personal-ai/goals/:id/archive` — 归档/关闭目标

- **Request Body**:
```typescript
export interface ArchiveGoalRequest {
  resolution?: 'achieved' | 'abandoned'; // 默认 "achieved"
  note?: string;                         // 可选归档总结，写入审计/记忆候选
}
```
- **Response (`200 OK`)**:
```json
{
  "goal": {
    "id": "goal_7b2d9a10-4c11-4b88-9b30-2a1e5f9c0001",
    "user_id": "u1",
    "title": "在 Q4 完成知忆 V1.5 架构落地",
    "description": "完成个人目标、项目、任务与多 Agent 协同能力设计及实施",
    "status": "achieved",
    "priority": 3,
    "target_date": "2026-12-31",
    "created_at": "2026-11-12T08:00:00.000Z",
    "updated_at": "2026-11-20T10:00:00.000Z"
  },
  "archived": true
}
```
- **Error Responses**:
  - `400 bad_request`: `resolution` 不是 `achieved` 或 `abandoned`。
  - `404 not_found`: 目标不存在或无权访问。
  - `409 already_terminal`: 目标已处于终态（`achieved` / `abandoned`）。

#### 5.1.6 `GET /v1/personal-ai/goals/:id/progress` — 获取目标聚合进度

- **说明**：聚合目标直接关联的 `milestones`、通过 `goal_projects` 关联的 `projects`，以及这些项目/里程碑下挂接的 `tasks` 统计数据。
- **Response (`200 OK`)**:
```json
{
  "goal": {
    "id": "goal_7b2d9a10-4c11-4b88-9b30-2a1e5f9c0001",
    "title": "在 Q4 完成知忆 V1.5 架构落地",
    "status": "active",
    "target_date": "2026-12-31"
  },
  "summary": {
    "completion_rate": 0.4,
    "milestones": { "total": 2, "completed": 1, "in_progress": 1, "pending": 0, "missed": 0 },
    "projects": { "total": 1, "active": 1, "completed": 0, "paused": 0, "archived": 0 },
    "tasks": { "total": 5, "completed": 2, "in_progress": 2, "blocked": 0, "pending": 1, "failed": 0, "cancelled": 0 }
  },
  "milestones": [
    {
      "id": "ms_001",
      "project_id": "proj_001",
      "title": "完成 V1.5 架构设计文档",
      "status": "completed",
      "target_date": "2026-11-15",
      "completed_at": "2026-11-12T09:00:00.000Z",
      "task_counts": { "total": 3, "completed": 2 }
    }
  ],
  "projects": [
    {
      "id": "proj_001",
      "title": "universal-memory-gateway",
      "status": "active",
      "task_counts": { "total": 5, "completed": 2, "in_progress": 2 }
    }
  ]
}
```
- **Error Responses**: `404 not_found`、`401 unauthorized`。

#### 5.1.7 `POST /v1/personal-ai/goals/:id/projects` & `DELETE /v1/personal-ai/goals/:id/projects/:projectId` — 管理 Goal-Project M:N 关联

- **Request Body (`POST`)**:
```typescript
export interface LinkGoalProjectRequest {
  project_id: string;
}
```
- **Response (`POST 200 OK` / `201 Created`)**: `{ "goal_id": "goal_...", "project_id": "proj_...", "linked": true }`
- **Response (`DELETE 200 OK`)**: `{ "goal_id": "goal_...", "project_id": "proj_...", "unlinked": true }`
- **Error Responses**: `404 not_found`（任一实体不存在或不属于当前用户）。

---

### 5.2 Project Management（项目管理）

#### 共享类型定义

```typescript
export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

export interface Project {
  id: string;           // "proj_<uuid>"
  user_id: string;
  title: string;
  description: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}
```

#### 5.2.1 `POST /v1/personal-ai/projects` — 创建项目

- **Request Body**:
```typescript
export interface CreateProjectRequest {
  title: string;                         // 必填，非空
  description?: string;                  // 默认 ""
  status?: 'active' | 'paused';          // 默认 "active"
  goal_ids?: string[];                   // 可选，绑定到已有 Goal
}
```
- **Response (`201 Created`)**:
```json
{
  "project": {
    "id": "proj_8c112233-4455-6677-8899-aabbccddeeff",
    "user_id": "u1",
    "title": "universal-memory-gateway",
    "description": "知忆后端核心网关与运行时",
    "status": "active",
    "created_at": "2026-11-12T08:05:00.000Z",
    "updated_at": "2026-11-12T08:05:00.000Z"
  },
  "linked_goal_ids": ["goal_7b2d9a10-4c11-4b88-9b30-2a1e5f9c0001"]
}
```
- **Error Responses**: `400 bad_request`、`404 not_found`（`goal_ids` 中含无效/越权目标）、`401 unauthorized`。

#### 5.2.2 `GET /v1/personal-ai/projects` — 列出项目

- **Query Parameters**:
  - `status?: ProjectStatus`
  - `goal_id?: string`（按 `goal_projects` 关联过滤）
  - `limit?: number`（默认 `50`，`1..200`）
  - `offset?: number`（默认 `0`）
- **Response (`200 OK`)**:
```json
{
  "items": [
    {
      "id": "proj_8c112233-4455-6677-8899-aabbccddeeff",
      "user_id": "u1",
      "title": "universal-memory-gateway",
      "description": "知忆后端核心网关与运行时",
      "status": "active",
      "created_at": "2026-11-12T08:05:00.000Z",
      "updated_at": "2026-11-12T08:05:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```
- **Error Responses**: `400 bad_request`、`401 unauthorized`。

#### 5.2.3 `GET /v1/personal-ai/projects/:id` — 获取项目详情

- **Response (`200 OK`)**:
```json
{
  "project": {
    "id": "proj_8c112233-4455-6677-8899-aabbccddeeff",
    "user_id": "u1",
    "title": "universal-memory-gateway",
    "description": "知忆后端核心网关与运行时",
    "status": "active",
    "created_at": "2026-11-12T08:05:00.000Z",
    "updated_at": "2026-11-12T08:05:00.000Z"
  },
  "goal_ids": ["goal_7b2d9a10-4c11-4b88-9b30-2a1e5f9c0001"],
  "milestones_count": 2,
  "tasks_summary": {
    "total": 5,
    "in_progress": 2,
    "completed": 2,
    "pending": 1
  }
}
```
- **Error Responses**: `404 not_found`、`401 unauthorized`。

#### 5.2.4 `PATCH /v1/personal-ai/projects/:id` — 更新项目

- **Request Body**:
```typescript
export interface UpdateProjectRequest {
  title?: string;
  description?: string;
  status?: ProjectStatus;
}
```
- **Response (`200 OK`)**: `{ "project": { ... } }`
- **Error Responses**: `400 bad_request`、`404 not_found`、`401 unauthorized`。

#### 5.2.5 `GET /v1/personal-ai/projects/:id/tasks` — 列出项目下的业务任务

- **说明**：查询 `tasks` 表中 `user_id = identity.user_id AND project_id = :id` 的记录。
- **Query Parameters**:
  - `status?: BusinessTaskStatus`
  - `milestone_id?: string`
  - `parent_task_id?: string`（传 `"null"` 仅返回顶层任务）
  - `limit?: number`（默认 `50`，`1..200`）
  - `offset?: number`（默认 `0`）
- **Response (`200 OK`)**:
```json
{
  "project_id": "proj_8c112233-4455-6677-8899-aabbccddeeff",
  "items": [
    {
      "id": "btask_11112222-3333-4444-5555-666677778888",
      "user_id": "u1",
      "project_id": "proj_8c112233-4455-6677-8899-aabbccddeeff",
      "milestone_id": "ms_001",
      "parent_task_id": null,
      "title": "编写 V1.5 API 设计文档",
      "description": "输出 docs/v1.5/API_DESIGN.md",
      "status": "in_progress",
      "priority": 3,
      "assignee_agent_id": "developer",
      "created_at": "2026-11-12T08:10:00.000Z",
      "updated_at": "2026-11-12T08:12:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```
- **Error Responses**: `404 not_found`（项目不存在或无权访问）、`400 bad_request`、`401 unauthorized`。

---

### 5.3 Milestone Management（里程碑管理）

#### 共享类型定义

```typescript
export type MilestoneStatus = 'pending' | 'in_progress' | 'completed' | 'missed';

export interface Milestone {
  id: string;                 // "ms_<uuid>"
  goal_id: string | null;
  project_id: string | null;
  user_id: string;
  title: string;
  description: string;
  status: MilestoneStatus;
  target_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
```

#### 5.3.1 `POST /v1/personal-ai/milestones` — 创建里程碑

- **约束**：`goal_id` 与 `project_id` 至少提供一个（匹配数据库约束 `CHECK (goal_id IS NOT NULL OR project_id IS NOT NULL)`），且归属实体必须属于当前 `user_id`。
- **Request Body**:
```typescript
export interface CreateMilestoneRequest {
  goal_id?: string | null;
  project_id?: string | null;
  title: string;                         // 必填，非空
  description?: string;
  status?: 'pending' | 'in_progress';    // 默认 "pending"
  target_date?: string | null;
}
```
- **Response (`201 Created`)**:
```json
{
  "milestone": {
    "id": "ms_9a001122-3344-5566-7788-99aabbccddee",
    "goal_id": "goal_7b2d9a10-4c11-4b88-9b30-2a1e5f9c0001",
    "project_id": "proj_8c112233-4455-6677-8899-aabbccddeeff",
    "user_id": "u1",
    "title": "M1: 完成 V1.5 全部架构与接口设计",
    "description": "完成 6 份核心设计文档定稿",
    "status": "in_progress",
    "target_date": "2026-11-15",
    "completed_at": null,
    "created_at": "2026-11-12T08:15:00.000Z",
    "updated_at": "2026-11-12T08:15:00.000Z"
  }
}
```
- **Error Responses**:
  - `400 missing_parent`: `goal_id` 与 `project_id` 均未提供。
  - `400 bad_request`: `title` 为空或日期/状态非法。
  - `404 not_found`: 指定的 `goal_id` 或 `project_id` 不存在或不属于当前用户。

#### 5.3.2 `GET /v1/personal-ai/milestones` — 列出里程碑

- **Query Parameters**:
  - `goal_id?: string`
  - `project_id?: string`
  - `status?: MilestoneStatus`
  - `limit?: number`（默认 `50`，`1..200`）
  - `offset?: number`（默认 `0`）
- **Response (`200 OK`)**:
```json
{
  "items": [
    {
      "id": "ms_9a001122-3344-5566-7788-99aabbccddee",
      "goal_id": "goal_7b2d9a10-4c11-4b88-9b30-2a1e5f9c0001",
      "project_id": "proj_8c112233-4455-6677-8899-aabbccddeeff",
      "user_id": "u1",
      "title": "M1: 完成 V1.5 全部架构与接口设计",
      "description": "完成 6 份核心设计文档定稿",
      "status": "in_progress",
      "target_date": "2026-11-15",
      "completed_at": null,
      "created_at": "2026-11-12T08:15:00.000Z",
      "updated_at": "2026-11-12T08:15:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```
- **Error Responses**: `400 bad_request`、`401 unauthorized`。

#### 5.3.3 `PATCH /v1/personal-ai/milestones/:id` — 更新里程碑

- **Request Body**:
```typescript
export interface UpdateMilestoneRequest {
  title?: string;
  description?: string;
  status?: MilestoneStatus;
  target_date?: string | null;
  goal_id?: string | null;     // 若更新后二者均为空，返回 400
  project_id?: string | null;
}
```
- **副作用**：当 `status` 变为 `completed` 时，若未提供 `completed_at`，服务端自动填充当前 ISO 时间戳；若从 `completed` 回退为 `in_progress` / `pending`，则清空 `completed_at`。
- **Response (`200 OK`)**: `{ "milestone": { ... } }`
- **Error Responses**: `400 missing_parent` / `400 bad_request`、`404 not_found`、`401 unauthorized`。

---

### 5.4 Business Task Management（业务任务管理 `/v1/personal-ai/work-tasks`）

> **与 V1 `/v1/personal-ai/tasks*` 的关系**：
> - `GET /v1/personal-ai/tasks`、`GET /v1/personal-ai/tasks/:id`、`POST /v1/personal-ai/tasks/:id/cancel` 保持对 `execution_tasks` 表（`task_<uuid>`）的 100% 向后兼容；
> - 本节定义的 `/v1/personal-ai/work-tasks*` 管理 `tasks` 业务任务表（`btask_<uuid>`），并通过 `execution_tasks.task_id` 与多次执行记录关联（1:N）。

#### 共享类型定义

```typescript
export type BusinessTaskStatus =
  | 'draft'
  | 'pending'
  | 'ready'
  | 'assigned'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ExecutionStatusV15 =
  | 'pending'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface BusinessTask {
  id: string;                         // "btask_<uuid>"
  user_id: string;
  project_id: string | null;
  milestone_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: BusinessTaskStatus;
  priority: PriorityLevel;
  assignee_agent_id: string | null;
  due_at: string | null;              // ISO 8601 timestamp, nullable
  created_at: string;
  updated_at: string;
}
```

#### 5.4.1 `POST /v1/personal-ai/work-tasks` — 创建业务任务

- **Request Body**:
```typescript
export interface CreateWorkTaskRequest {
  title: string;                       // 必填，非空
  description?: string;                // 默认 ""
  project_id?: string | null;          // 可选；若传则校验属于当前用户
  milestone_id?: string | null;        // 可选；若传则校验属于当前用户
  parent_task_id?: string | null;      // 可选；若传则校验属于当前用户且非环
  status?: 'draft' | 'pending' | 'ready'; // 默认 "pending"
  priority?: PriorityLevel;            // 默认 0
  assignee_agent_id?: string | null;   // 可选；若传则校验 agents 表存在且 active
  due_at?: string | null;              // 可选；ISO 8601 截止时间
  auto_execute?: boolean;              // 默认 false；为 true 时创建后立即触发一次 execute 流程
}
```
- **Response (`201 Created`)**:
```json
{
  "task": {
    "id": "btask_11112222-3333-4444-5555-666677778888",
    "user_id": "u1",
    "project_id": "proj_8c112233-4455-6677-8899-aabbccddeeff",
    "milestone_id": "ms_9a001122-3344-5566-7788-99aabbccddee",
    "parent_task_id": null,
    "title": "重构鉴权中间件并补充单测",
    "description": "统一空 body 的 HMAC 验签逻辑并覆盖 401 用例",
    "status": "pending",
    "priority": 3,
    "assignee_agent_id": "developer",
    "due_at": "2026-11-14T18:00:00.000Z",
    "created_at": "2026-11-12T08:20:00.000Z",
    "updated_at": "2026-11-12T08:20:00.000Z"
  },
  "execution": null
}
```
- **Error Responses**:
  - `400 bad_request`: `title` 为空、非法 `status` 或 `priority`。
  - `404 not_found`: `project_id`、`milestone_id`、`parent_task_id` 不存在/越权，或 `assignee_agent_id` 不存在（`agent_not_found`）。
  - `409 agent_disabled`: 指定的 `assignee_agent_id` 当前为 `disabled`。

#### 5.4.2 `GET /v1/personal-ai/work-tasks` — 列出业务任务

- **Query Parameters**:
  - `status?: BusinessTaskStatus`（支持逗号分隔多值）
  - `project_id?: string`
  - `milestone_id?: string`
  - `parent_task_id?: string`（传 `"null"` 查根任务）
  - `assignee_agent_id?: string`
  - `priority?: PriorityLevel`
  - `limit?: number`（默认 `50`，`1..200`）
  - `offset?: number`（默认 `0`）
- **Response (`200 OK`)**:
```json
{
  "items": [
    {
      "id": "btask_11112222-3333-4444-5555-666677778888",
      "user_id": "u1",
      "project_id": "proj_8c112233-4455-6677-8899-aabbccddeeff",
      "milestone_id": "ms_9a001122-3344-5566-7788-99aabbccddee",
      "parent_task_id": null,
      "title": "重构鉴权中间件并补充单测",
      "description": "统一空 body 的 HMAC 验签逻辑并覆盖 401 用例",
      "status": "pending",
      "priority": 3,
      "assignee_agent_id": "developer",
      "created_at": "2026-11-12T08:20:00.000Z",
      "updated_at": "2026-11-12T08:20:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

#### 5.4.3 `GET /v1/personal-ai/work-tasks/:id` — 获取业务任务详情

- **Response (`200 OK`)**:
```json
{
  "task": {
    "id": "btask_11112222-3333-4444-5555-666677778888",
    "user_id": "u1",
    "project_id": "proj_8c112233-4455-6677-8899-aabbccddeeff",
    "milestone_id": "ms_9a001122-3344-5566-7788-99aabbccddee",
    "parent_task_id": null,
    "title": "重构鉴权中间件并补充单测",
    "description": "统一空 body 的 HMAC 验签逻辑并覆盖 401 用例",
    "status": "in_progress",
    "priority": 3,
    "assignee_agent_id": "developer",
    "created_at": "2026-11-12T08:20:00.000Z",
    "updated_at": "2026-11-12T08:25:00.000Z"
  },
  "subtasks": [],
  "latest_execution": {
    "id": "task_a9b8c7d6-0001-4000-8000-000000000001",
    "task_id": "btask_11112222-3333-4444-5555-666677778888",
    "status": "running",
    "agent_id": "developer",
    "execution_mode": "agent_delegation",
    "created_at": "2026-11-12T08:24:00.000Z"
  }
}
```
- **Error Responses**: `404 not_found`、`401 unauthorized`。

#### 5.4.4 `PATCH /v1/personal-ai/work-tasks/:id` — 更新业务任务

- **Request Body**:
```typescript
export interface UpdateWorkTaskRequest {
  title?: string;
  description?: string;
  project_id?: string | null;
  milestone_id?: string | null;
  status?: BusinessTaskStatus;
  priority?: PriorityLevel;
  assignee_agent_id?: string | null;
  due_at?: string | null;
}
```
- **状态机校验**：禁止从终态（`completed` / `cancelled`）直接改回非终态；`failed` 状态仅可通过显式 `POST /:id/execute`（或重置为 `ready`/`pending` 重试）重新进入执行。若试图手动改为 `completed` 但尚有活跃 `execution_tasks`，返回 `409 conflict`。
- **Response (`200 OK`)**: `{ "task": { ... } }`
- **Error Responses**: `400 bad_request`、`404 not_found`、`409 invalid_state_transition`。

#### 5.4.5 `POST /v1/personal-ai/work-tasks/:id/cancel` — 取消业务任务

- **行为**：使用事务与 CAS 更新将业务任务置为 `cancelled`，并**级联取消**所有 `task_id = :id AND status IN ('pending','dispatching','running')` 的活跃 `execution_tasks`（同时尝试调用 `adapter.cancelTask`）。
- **Request Body**:
```typescript
export interface CancelWorkTaskRequest {
  reason?: string;
}
```
- **Response (`200 OK`)**:
```json
{
  "ok": true,
  "task": {
    "id": "btask_11112222-3333-4444-5555-666677778888",
    "status": "cancelled",
    "updated_at": "2026-11-12T08:30:00.000Z"
  },
  "cancelled_executions": [
    { "id": "task_a9b8c7d6-0001-4000-8000-000000000001", "external_cancelled": true }
  ]
}
```
- **Error Responses**:
  - `404 not_found`: 任务不存在或无权访问。
  - `409 already_terminal`: 任务已处于 `completed`、`failed` 或 `cancelled`。

#### 5.4.6 `POST /v1/personal-ai/work-tasks/:id/execute` — 触发业务任务执行

- **行为**：
  1. 校验任务属于当前 `user_id` 且状态允许执行（`draft`、`pending`、`ready`、`assigned`、`failed`；若已有活跃执行返回 `409 execution_already_active`）。
  2. 确定执行 Agent（`body.agent_id ?? task.assignee_agent_id ?? identity.agent_id`），校验 Agent 存在且为 `active`。
  3. 经 `PolicyChecker` 检查高风险策略：若命中 `require_approval`（且未附带有效 `approval_id`），则创建 `approval_requests` 记录、将任务置为 `blocked`，返回 `202 Accepted` 及审批信息；否则创建 `execution_tasks`（关联 `task_id`），推进任务状态为 `in_progress`，由 `TaskWorker` 异步调度。
  4. **幂等性**：支持请求头 `X-Request-Id` 或 body `idempotency_key`，避免重复创建执行记录。
- **Request Body**:
```typescript
export interface ExecuteWorkTaskRequest {
  agent_id?: string;
  execution_mode?: 'agent_delegation' | 'direct_llm'; // 默认根据 agent.execution_backend 决定
  input_override?: string;                            // 可选补充指令，默认拼接 task.title + task.description
  approval_id?: string;                               // 已批准的审批单 ID（用于解除高风险拦截）
  idempotency_key?: string;
}
```
- **Response (`201 Created` — 已创建执行任务)**:
```json
{
  "status": "dispatched",
  "task": {
    "id": "btask_11112222-3333-4444-5555-666677778888",
    "status": "in_progress",
    "assignee_agent_id": "developer"
  },
  "execution": {
    "id": "task_a9b8c7d6-0001-4000-8000-000000000002",
    "task_id": "btask_11112222-3333-4444-5555-666677778888",
    "user_id": "u1",
    "agent_id": "developer",
    "execution_mode": "agent_delegation",
    "status": "pending",
    "created_at": "2026-11-12T08:32:00.000Z"
  }
}
```
- **Response (`202 Accepted` — 需要用户审批)**:
```json
{
  "status": "approval_required",
  "task": {
    "id": "btask_11112222-3333-4444-5555-666677778888",
    "status": "blocked"
  },
  "approval": {
    "id": "apr_44556677-8899-0011-2233-445566778899",
    "operation_type": "deploy",
    "risk_level": "high",
    "status": "pending",
    "timeout_at": "2026-11-12T09:32:00.000Z"
  }
}
```
- **Error Responses**:
  - `404 not_found` / `404 agent_not_found`
  - `409 execution_already_active` / `409 already_terminal` / `409 agent_disabled` / `409 agent_concurrency_exceeded`
  - `403 approval_rejected`: 传入的 `approval_id` 已被拒绝、撤销或超时。

#### 5.4.7 `GET /v1/personal-ai/work-tasks/:id/executions` — 列出业务任务的执行历史

- **Query Parameters**: `limit?: number`（默认 `50`）、`offset?: number`（默认 `0`）、`status?: ExecutionStatusV15`
- **Response (`200 OK`)**:
```json
{
  "task_id": "btask_11112222-3333-4444-5555-666677778888",
  "items": [
    {
      "id": "task_a9b8c7d6-0001-4000-8000-000000000002",
      "task_id": "btask_11112222-3333-4444-5555-666677778888",
      "user_id": "u1",
      "conversation_id": "",
      "request_id": "req_0192...",
      "idempotency_key": "u1:req_0192...",
      "agent_id": "developer",
      "project_id": "proj_8c112233-4455-6677-8899-aabbccddeeff",
      "execution_mode": "agent_delegation",
      "external_task_id": "ISS-42",
      "external_run_id": "run_99",
      "status": "completed",
      "input_summary": "重构鉴权中间件并补充单测",
      "result": "已完成鉴权中间件重构并通过 108 项测试。",
      "error": null,
      "progress_message": "done",
      "poll_count": 4,
      "attempt_count": 1,
      "timeout_at": "2026-11-12T08:42:00.000Z",
      "created_at": "2026-11-12T08:32:00.000Z",
      "started_at": "2026-11-12T08:32:03.000Z",
      "completed_at": "2026-11-12T08:33:15.000Z",
      "updated_at": "2026-11-12T08:33:15.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```
- **Error Responses**: `404 not_found`、`401 unauthorized`。

---

### 5.5 Agent Registry Extensions（Agent 注册表扩展）

#### 共享类型定义（向后兼容扩展 `AgentProfile`）

```typescript
export type ExecutionBackend = 'multica' | 'direct_llm' | 'custom';
export type AgentStatus = 'active' | 'disabled';

export interface AgentPermissionPolicy {
  require_approval?: string[]; // 需要人工审批的操作类型，如 ["deploy", "file_delete"]
  allowed_tools?: string[];
  denied_tools?: string[];
  max_risk_auto?: 'low' | 'medium';
}

export interface AgentProfileV15 {
  agent_id: string;
  name: string;
  role: string;
  description: string;
  core_memory: string;
  // V1.5 新增字段（均带默认值，不破坏 V1 GET /v1/agents 与 GET /v1/agents/:id/profile）
  capabilities: string[];
  execution_backend: ExecutionBackend;
  permission_policy: AgentPermissionPolicy;
  status: AgentStatus;
  concurrency_limit: number;
  instructions: string;
  created_at: string;
  updated_at: string;
}
```

#### 5.5.1 `PATCH /v1/agents/:id` — 更新 Agent 配置与能力声明

- **Authorization**: Bearer / API Key（沿用 `src/routes.ts` 身份解析；生产/多租户部署建议要求管理员令牌）。
- **Request Body**:
```typescript
export interface UpdateAgentRequest {
  name?: string;
  role?: string;
  description?: string;
  core_memory?: string;
  capabilities?: string[];
  execution_backend?: ExecutionBackend;
  permission_policy?: AgentPermissionPolicy;
  status?: AgentStatus;
  concurrency_limit?: number; // >= 1 且 <= 20
  instructions?: string;
}
```
- **Response (`200 OK`)**:
```json
{
  "profile": {
    "agent_id": "developer",
    "name": "Developer",
    "role": "后端研发工程师",
    "description": "负责服务设计与编码实现，侧重技术栈、架构决策与历史 Bug 复盘",
    "core_memory": "关注：技术栈、架构决策、可维护性、历史 Bug、故障复盘、代码规范。",
    "capabilities": ["code_edit", "code_review", "unit_test", "bug_fix"],
    "execution_backend": "multica",
    "permission_policy": {
      "require_approval": ["deploy", "file_delete", "db_drop"],
      "max_risk_auto": "medium"
    },
    "status": "active",
    "concurrency_limit": 2,
    "instructions": "始终遵守项目现有 TypeScript 严格模式与测试覆盖要求。",
    "created_at": "2026-11-12T07:00:00.000Z",
    "updated_at": "2026-11-12T08:40:00.000Z"
  }
}
```
- **Error Responses**:
  - `400 bad_request`: 空更新体、`concurrency_limit < 1`、`execution_backend` 非法或 `capabilities` 非字符串数组。
  - `404 not_found`: Agent 不存在。

#### 5.5.2 `GET /v1/agents/:id/status` — 查询 Agent 实时可用状态

- **Authorization**: Bearer / API Key。
- **说明**：结合 `agents` 配置、当前 `execution_tasks` 活跃执行数（`status IN ('pending','dispatching','running')`）及底层执行后端健康状态（如 MultiCA daemon 是否在线）计算可用性。
- **Response (`200 OK`)**:
```json
{
  "agent_id": "developer",
  "status": "active",
  "available": true,
  "execution_backend": "multica",
  "backend_health": {
    "reachable": true,
    "status": "online"
  },
  "concurrency": {
    "limit": 2,
    "active": 1,
    "available_slots": 1
  },
  "capabilities": ["code_edit", "code_review", "unit_test", "bug_fix"],
  "checked_at": "2026-11-12T08:41:00.000Z"
}
```
- **Error Responses**: `404 not_found`（Agent 不存在）。

---

### 5.6 Approval Management（高风险审批管理）

#### 共享类型定义

```typescript
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'timeout'
  | 'auto_approved'
  | 'revoked';

export interface ApprovalRequest {
  id: string;                 // "apr_<uuid>"
  user_id: string;
  task_id: string | null;     // 关联 tasks.id (btask_...)
  execution_id: string | null;// 关联 execution_tasks.id (task_...)
  operation_type: string;     // e.g. "deploy", "file_delete", "external_api_write"
  scope: Record<string, unknown>; // 授权范围约束，如 { target_env: "staging", max_uses: 1 }
  description: string;
  risk_level: RiskLevel;
  status: ApprovalStatus;
  requested_at: string;
  resolved_at: string | null;
  resolver: string | null;    // "user" | "auto_policy" | agent_id
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  timeout_at: string | null;
  created_at: string;
  updated_at: string;
}
```

#### 5.6.1 `GET /v1/personal-ai/approvals` — 列出审批请求

- **Query Parameters**:
  - `status?: ApprovalStatus`（默认返回所有，常用 `?status=pending`）
  - `task_id?: string`
  - `execution_id?: string`
  - `risk_level?: RiskLevel`
  - `limit?: number`（默认 `50`，`1..200`）
  - `offset?: number`（默认 `0`）
- **Response (`200 OK`)**:
```json
{
  "items": [
    {
      "id": "apr_44556677-8899-0011-2233-445566778899",
      "user_id": "u1",
      "task_id": "btask_11112222-3333-4444-5555-666677778888",
      "execution_id": null,
      "operation_type": "deploy",
      "scope": { "environment": "staging", "one_shot": true },
      "description": "将 gateway 服务部署至 staging 环境",
      "risk_level": "high",
      "status": "pending",
      "requested_at": "2026-11-12T08:32:00.000Z",
      "resolved_at": null,
      "resolver": null,
      "revoked_at": null,
      "revoked_by": null,
      "revoke_reason": null,
      "timeout_at": "2026-11-12T09:32:00.000Z",
      "created_at": "2026-11-12T08:32:00.000Z",
      "updated_at": "2026-11-12T08:32:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

#### 5.6.2 `GET /v1/personal-ai/approvals/:id` — 获取单条审批请求详情

- **Response (`200 OK`)**: `{ "approval": { ... } }`
- **Error Responses**: `404 not_found`、`401 unauthorized`。

#### 5.6.3 `POST /v1/personal-ai/approvals/:id/approve` — 批准审批请求

- **行为**：
  1. 使用 CAS 更新（`WHERE id = ? AND user_id = ? AND status = 'pending'`，且校验 `timeout_at` 未过期；若已过期则先转为 `timeout` 并返回 `409 approval_expired`）。
  2. 若关联的业务任务处于 `blocked`，自动将其恢复并（当 `resume_execution !== false` 时）创建对应的 `execution_tasks` 进入调度队列。
- **Request Body**:
```typescript
export interface ApproveRequestBody {
  scope?: Record<string, unknown>; // 可选收窄授权范围
  resume_execution?: boolean;      // 默认 true：若存在等待中的 task/plan，批准后自动恢复执行
}
```
- **Response (`200 OK`)**:
```json
{
  "approval": {
    "id": "apr_44556677-8899-0011-2233-445566778899",
    "status": "approved",
    "resolved_at": "2026-11-12T08:45:00.000Z",
    "resolver": "u1"
  },
  "resumed_execution_id": "task_a9b8c7d6-0001-4000-8000-000000000003"
}
```
- **Error Responses**:
  - `404 not_found`: 审批单不存在或无权访问。
  - `409 already_resolved`: 审批单已被处理（`approved`/`rejected`/`revoked`）。
  - `409 approval_expired`: 已超过 `timeout_at`。

#### 5.6.4 `POST /v1/personal-ai/approvals/:id/reject` — 拒绝审批请求

- **Request Body**:
```typescript
export interface RejectRequestBody {
  reason?: string;
}
```
- **副作用**：若关联业务任务处于 `blocked`，将其状态推进为 `cancelled` 或 `failed`（默认 `cancelled`，可在 `reason` 中说明拒绝原因），并发出通知/事件。
- **Response (`200 OK`)**:
```json
{
  "approval": {
    "id": "apr_44556677-8899-0011-2233-445566778899",
    "status": "rejected",
    "resolved_at": "2026-11-12T08:45:00.000Z",
    "resolver": "u1"
  }
}
```
- **Error Responses**: `404 not_found`、`409 already_resolved`、`409 approval_expired`。

#### 5.6.5 `POST /v1/personal-ai/approvals/:id/revoke` — 撤销已批准的授权

- **说明**：用于安全撤回此前已批准但仍在执行或作用域内的授权（对应 `revoked` 状态，记录 `revoked_at`、`revoked_by`、`revoke_reason`）。若关联的 `execution_tasks` 仍处于活跃态，级联触发 CAS 取消。
- **Request Body**: `{ "reason"?: string }`
- **Response (`200 OK`)**: `{ "approval": { "id": "apr_...", "status": "revoked", "revoked_at": "...", "revoked_by": "u1", "revoke_reason": "..." }, "cancelled_execution_id": "task_..." | null }`
- **Error Responses**: `404 not_found`、`409 invalid_state_transition`（仅 `approved` / `auto_approved` 可撤销）。

---

### 5.7 User Profile（用户画像与偏好）

#### 共享类型定义

```typescript
export interface UserPreferences {
  language?: string;              // e.g. "zh-CN", "en-US"
  proactive_paused?: boolean;     // 一键暂停主动提醒
  quiet_hours?: {
    enabled: boolean;
    start: string;                // "22:00"
    end: string;                  // "08:00"
  };
  default_agent_id?: string;
  notification_channels?: Array<'in_app' | 'webhook'>;
  webhook_url?: string;
  [key: string]: unknown;
}

export interface UserWorkStyle {
  summary_cadence?: 'daily' | 'weekly' | 'off';
  detail_level?: 'concise' | 'balanced' | 'detailed';
  auto_approve_low_risk?: boolean;
  [key: string]: unknown;
}

export interface UserProfile {
  user_id: string;
  display_name: string;
  timezone: string;               // IANA timezone, default "Asia/Shanghai"
  work_style: UserWorkStyle;
  preferences: UserPreferences;
  created_at: string;
  updated_at: string;
}
```

#### 5.7.1 `GET /v1/personal-ai/profile` — 获取当前用户画像

- **行为**：根据 `identity.user_id` 查询 `users` 表；若尚无记录（如 V1 既有用户首次调用），服务端按幂等 `INSERT OR IGNORE` 自动初始化默认 Profile 后返回 `200 OK`。
- **Response (`200 OK`)**:
```json
{
  "profile": {
    "user_id": "u1",
    "display_name": "开发者 u1",
    "timezone": "Asia/Shanghai",
    "work_style": {
      "summary_cadence": "daily",
      "detail_level": "concise",
      "auto_approve_low_risk": true
    },
    "preferences": {
      "language": "zh-CN",
      "proactive_paused": false,
      "quiet_hours": {
        "enabled": true,
        "start": "22:30",
        "end": "08:00"
      },
      "notification_channels": ["in_app"]
    },
    "created_at": "2026-11-12T07:00:00.000Z",
    "updated_at": "2026-11-12T08:50:00.000Z"
  }
}
```
- **Error Responses**: `401 unauthorized`。

#### 5.7.2 `PATCH /v1/personal-ai/profile` — 更新用户偏好与画像

- **Request Body**:
```typescript
export interface UpdateUserProfileRequest {
  display_name?: string;
  timezone?: string;              // 校验合法 IANA 时区（Intl.DateTimeFormat）
  work_style?: Partial<UserWorkStyle>;   // 顶层 key 浅合并（传 null 删除指定 key）
  preferences?: Partial<UserPreferences>; // 顶层 key 浅合并
}
```
- **Response (`200 OK`)**: `{ "profile": { ... } }`
- **Error Responses**:
  - `400 invalid_timezone`: 非法 IANA 时区名称。
  - `400 bad_request`: 空更新体或字段类型不合法（如 `preferences` 非对象）。
  - `401 unauthorized`。

---

### 5.8 Proactive Schedules（定时任务调度）

> 支撑 V1.5 受控主动引擎（Proactive Engine）：仅限明确配置与受控触发（任务到期提醒、停滞提醒、Agent 失败告警、待审批提醒、每日/每周总结），支持用户时区、冷却窗口、去重与暂停开关。

#### 共享类型定义

```typescript
export type ScheduleStatus = 'active' | 'paused' | 'disabled';
export type ScheduleTriggerType =
  | 'cron'
  | 'task_due'
  | 'stale_progress'
  | 'agent_failure'
  | 'pending_approval'
  | 'summary';

export interface ScheduledJob {
  id: string;                     // "sj_<uuid>"
  user_id: string;
  title: string;
  description: string;
  trigger_type: ScheduleTriggerType;
  cron_expression: string;        // 5 段标准 cron，如 "0 9 * * 1-5"
  timezone: string;               // 默认取用户 profile.timezone
  task_template: Record<string, unknown>;
  agent_id: string | null;
  status: ScheduleStatus;
  paused_until: string | null;    // 用户临时静默截止时间（ISO 8601）
  cooldown_seconds: number;       // 默认 3600
  dedup_key: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}
```

#### 5.8.1 `POST /v1/personal-ai/schedules` — 创建定时任务

- **Request Body**:
```typescript
export interface CreateScheduleRequest {
  title: string;
  description?: string;
  trigger_type?: ScheduleTriggerType; // 默认 "cron"
  cron_expression: string;            // 5 段 cron 表达式
  timezone?: string;                  // 缺省使用用户 Profile 时区
  task_template?: Record<string, unknown>;
  agent_id?: string | null;
  paused_until?: string | null;
  cooldown_seconds?: number;          // 默认 3600
  dedup_key?: string | null;
}
```
- **Response (`201 Created`)**: `{ "schedule": { ... } }`
- **Error Responses**: `400 invalid_cron`、`400 invalid_timezone`、`404 agent_not_found`。

#### 5.8.2 `GET /v1/personal-ai/schedules` — 列出定时任务

- **Query Parameters**: `status?: ScheduleStatus`, `trigger_type?: ScheduleTriggerType`, `limit?: number`, `offset?: number`
- **Response (`200 OK`)**: `{ "items": [ ... ], "total": 1, "limit": 50, "offset": 0 }`

#### 5.8.3 `PATCH /v1/personal-ai/schedules/:id` — 更新/暂停/恢复定时任务

- **Request Body**:
```typescript
export interface UpdateScheduleRequest {
  title?: string;
  description?: string;
  trigger_type?: ScheduleTriggerType;
  cron_expression?: string;
  timezone?: string;
  task_template?: Record<string, unknown>;
  agent_id?: string | null;
  status?: ScheduleStatus;
  paused_until?: string | null;
  cooldown_seconds?: number;
  dedup_key?: string | null;
}
```
- **Response (`200 OK`)**: `{ "schedule": { ... } }`
- **Error Responses**: `400 invalid_cron`、`400 invalid_timezone`、`404 not_found`。

#### 5.8.4 `DELETE /v1/personal-ai/schedules/:id` — 删除定时任务

- **Response (`200 OK`)**: `{ "deleted": true, "schedule_id": "sj_..." }`
- **Error Responses**: `404 not_found`。

---

### 5.9 Notifications（异步通知管理）

#### 共享类型定义

```typescript
export type NotificationStatus = 'unread' | 'read' | 'dismissed' | 'delivered' | 'failed';
export type NotificationSourceType = 'task' | 'execution' | 'approval' | 'schedule' | 'system';
export type NotificationChannel = 'in_app' | 'webhook';
export type NotificationSeverity = 'info' | 'warning' | 'urgent';

export interface Notification {
  id: string;                 // "ntf_<uuid>"
  user_id: string;
  source_type: NotificationSourceType;
  source_id: string | null;
  channel: NotificationChannel;
  title: string;
  body: string;
  severity: NotificationSeverity;
  dedup_key: string | null;
  status: NotificationStatus;
  delivery_attempts: number;
  delivered_at: string | null;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}
```

#### 5.9.1 `GET /v1/personal-ai/notifications` — 列出通知

- **Query Parameters**:
  - `status?: NotificationStatus`（如 `unread`）
  - `source_type?: NotificationSourceType`
  - `severity?: NotificationSeverity`
  - `limit?: number`（默认 `50`，`1..200`）
  - `offset?: number`（默认 `0`）
- **Response (`200 OK`)**:
```json
{
  "items": [
    {
      "id": "ntf_aa11bb22-cc33-dd44-ee55-ff6677889900",
      "user_id": "u1",
      "source_type": "approval",
      "source_id": "apr_44556677-8899-0011-2233-445566778899",
      "channel": "in_app",
      "title": "待审批操作：deploy",
      "body": "任务「部署 gateway 至 staging」包含高风险操作，请及时确认。",
      "severity": "warning",
      "dedup_key": "approval_pending:apr_44556677-8899-0011-2233-445566778899",
      "status": "unread",
      "delivery_attempts": 1,
      "delivered_at": "2026-11-12T08:32:01.000Z",
      "read_at": null,
      "created_at": "2026-11-12T08:32:01.000Z",
      "updated_at": "2026-11-12T08:32:01.000Z"
    }
  ],
  "unread_count": 1,
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

#### 5.9.2 `POST /v1/personal-ai/notifications/:id/read` — 标记单条已读

- **Response (`200 OK`)**: `{ "notification": { "id": "ntf_...", "status": "read", "read_at": "..." } }`
- **Error Responses**: `404 not_found`。

#### 5.9.3 `POST /v1/personal-ai/notifications/read-all` — 全部标记已读

- **Request Body**: `{ "source_type"?: NotificationSourceType }`（可选仅将某类来源通知全部标为已读）
- **Response (`200 OK`)**: `{ "updated": 3 }`

---

### 5.10 Memory Links（记忆与业务实体关联）

#### 5.10.1 `POST /v1/personal-ai/memories/links` — 关联记忆与业务实体

- **Request Body**:
```typescript
export type MemoryLinkEntityType = 'goal' | 'project' | 'milestone' | 'task';
export type MemoryLinkRelationType = 'context' | 'outcome' | 'preference' | 'constraint';

export interface CreateMemoryLinkRequest {
  memory_id: string;
  entity_type: MemoryLinkEntityType;
  entity_id: string;
  relation_type?: MemoryLinkRelationType; // 默认 "context"
}
```
- **Response (`201 Created`)**:
```json
{
  "link": {
    "id": "mlink_001",
    "user_id": "u1",
    "memory_id": "mem_123",
    "entity_type": "goal",
    "entity_id": "goal_7b2d9a10-4c11-4b88-9b30-2a1e5f9c0001",
    "relation_type": "constraint",
    "created_at": "2026-11-12T09:00:00.000Z"
  }
}
```
- **Error Responses**: `404 not_found`（`memory_id` 或目标实体不存在/不属于当前用户）、`409 duplicate_link`。

#### 5.10.2 `GET /v1/personal-ai/memories/links` — 查询实体关联记忆

- **Query Parameters**: `entity_type?: MemoryLinkEntityType`, `entity_id?: string`, `memory_id?: string`, `limit?: number`, `offset?: number`
- **Response (`200 OK`)**: `{ "items": [ ... ], "total": 1, "limit": 50, "offset": 0 }`

#### 5.10.3 `DELETE /v1/personal-ai/memories/links/:id` — 解除记忆关联

- **Response (`200 OK`)**: `{ "deleted": true, "link_id": "mlink_001" }`

---

## 6. 错误码参考（Error Code Reference）

所有 HTTP 非 2xx 响应均遵循 `src/errors.ts` 的 `ErrorEnvelope` 结构：

```json
{
  "error": {
    "message": "任务无法取消：already_completed",
    "type": "invalid_request_error",
    "code": "conflict"
  }
}
```

### 6.1 标准错误码表

| HTTP 状态码 | `error.code` | `error.type` | 触发场景与典型端点 |
|---|---|---|---|
| `400` | `bad_request` | `invalid_request_error` | 必填字段缺失、空字符串、长度超限、分页参数无效、空 PATCH 请求体 |
| `400` | `invalid_json` | `invalid_request_error` | 请求体不是合法 JSON（`src/routes.ts` `errorMiddleware`） |
| `400` | `invalid_status` | `invalid_request_error` | 状态枚举值不在允许集合内 |
| `400` | `missing_parent` | `invalid_request_error` | 创建/更新 Milestone 时 `goal_id` 与 `project_id` 同时为空 |
| `400` | `invalid_cron` | `invalid_request_error` | `cron_expression` 不符合 5 段标准 cron 语法 |
| `400` | `invalid_timezone` | `invalid_request_error` | `timezone` 不是合法 IANA 时区字符串 |
| `400` | `cycle_detected` | `invalid_request_error` | 设置 `parent_task_id` 导致任务树形成环 |
| `401` | `unauthorized` | `invalid_request_error` | 缺少/错误 HMAC 签名、时间戳过期、或生产模式 API Key 无效 |
| `401` | `settings_unauthorized` | `settings_unauthorized` | 访问 `/v1/zhiyi/*` 或 `/v1/models` 未通过 loopback/令牌校验 |
| `403` | `approval_rejected` | `permission_error` | 尝试使用已拒绝/撤销/超时的 `approval_id` 执行高风险任务 |
| `403` | `policy_denied` | `permission_error` | 请求的操作被 `PolicyChecker` 显式禁止（如 Agent `denied_tools`） |
| `404` | `not_found` | `invalid_request_error` | 路径不存在，或 Goal / Project / Milestone / Task / Approval / Schedule / Notification / Memory 不存在或不属于当前用户 |
| `404` | `agent_not_found` | `invalid_request_error` | 指定的 `agent_id` / `assignee_agent_id` 在 `agents` 表中不存在 |
| `404` | `project_not_found` | `invalid_request_error` | 关联的 `project_id` 不存在或无权访问 |
| `409` | `conflict` | `invalid_request_error` | 通用并发/状态冲突（含 V1 `POST /v1/personal-ai/tasks/:id/cancel` 已终态） |
| `409` | `already_terminal` | `invalid_request_error` | Goal / WorkTask 已处于终态，不可重复归档或取消 |
| `409` | `invalid_state_transition` | `invalid_request_error` | 不允许的状态机跳转（如 `completed` → `in_progress`） |
| `409` | `execution_already_active` | `invalid_request_error` | 该业务任务已有 `pending`/`dispatching`/`running` 的执行记录，禁止重复并发触发 |
| `409` | `agent_disabled` | `invalid_request_error` | 目标 Agent 当前处于 `disabled` 状态 |
| `409` | `agent_concurrency_exceeded` | `invalid_request_error` | 目标 Agent 活跃执行数已达 `concurrency_limit` |
| `409` | `already_resolved` | `invalid_request_error` | 审批单已被批准、拒绝或撤销 |
| `409` | `approval_expired` | `invalid_request_error` | 审批单已超过 `timeout_at` |
| `409` | `duplicate_link` | `invalid_request_error` | `memory_links` 相同关联已存在 |
| `500` | `internal_error` | `server_error` | 未捕获服务端内部异常（`errorMiddleware`） |
| `502` | `upstream_error` | `upstream_error` | 模型上游返回非 2xx 或网络超时（非流式 `/chat/completions`） |
| `503` | `service_unavailable` | `server_error` | `PERSONAL_AI_ENABLED=false` 时调用 Personal AI 对话接口（注：现有 `src/personal-ai/routes.ts:110` 复用 `authFailure(res, 503, ...)` 返回 `code: 'bad_request'`，V1.5 建议统一为 `service_unavailable`） |

---

## 7. SSE 事件扩展规范（SSE Event Extensions）

### 7.1 核心协议约束（不可违背的不变量）

依据 `src/personal-ai/adapters/protocol/adp-protocol-adapter.ts` 的源码核实与运行期校验（`src/personal-ai/routes.ts:219-220`）：
- **ADP V2 协议（`adp-v2`）仅允许以下 11 种顶层 wire 事件类型**（`ADP_V2_EVENT_TYPES`）：
  `request_ack`、`response.created`、`response.processing`、`response.completed`、`message.added`、`message.processing`、`message.done`、`content.added`、`text.delta`、`error`、`conversation`。
- **绝对禁止向前端发送未在枚举内的自定义顶层 `Type` 帧**，否则 `adp-chat-client` 的 `to_event()` 会直接抛出 `ValueError`。
- **OpenAI 兼容协议（`openai`）** 仅输出标准 `chat.completion.chunk`（`choices[0].delta.content`）及末尾 `data: [DONE]\n\n`。

### 7.2 内部 `PersonalAIEvent` 扩展与降级映射表

V1.5 Runtime 在 `src/personal-ai/events/event-types.ts` 中新增以下内部事件类型，全部经由 `ADPProtocolAdapter` 的 `progressText(event)` 统一降级为可读纯文本输出：

| 内部事件类型 (`PersonalAIEvent.type`) | 触发阶段 | `openai` 协议输出 | `adp-v2` 协议输出 |
|---|---|---|---|
| `planning_start` | AssistantPlanner 开始规划 | 静默（不输出） | 静默（不输出） |
| `planning_complete` | 规划完成（含 `intent`, `stepCount`） | 静默（或调试模式下文本摘要） | 静默 |
| `clarification_needed` | 置信度 `< 0.4`，需用户澄清 | `delta.content`: `\n[知忆] 需要进一步确认：${question}\n` | `text.delta`: 同左 |
| `plan_proposed` | 置信度 `< 0.7` 且需确认 | `delta.content`: `\n[知忆] ${prompt}\n` | `text.delta`: 同左 |
| `plan_rejected` | 被 `PolicyChecker` 拦截 | `delta.content`: `\n[知忆] 计划被策略拦截：${reason}\n` | `text.delta`: 同左 |
| `approval_needed` | 命中高风险操作，生成 `apr_...` | `delta.content`: `\n[知忆] 需要审批（${approvalId}）：${prompt}\n` | `text.delta`: 同左 |
| `step_started` | `ExecutionController` 启动某步骤 | `delta.content`: `\n[知忆] 开始执行步骤 ${stepId}（${stepType}）...\n` | `text.delta`: 同左 |
| `step_completed` | 某步骤执行完成 | 静默或简短文本进度 | 静默或 `text.delta` |
| `step_failed` | 某步骤执行失败 | `delta.content`: `\n[知忆] 步骤 ${stepId} 失败：${error}\n` | `text.delta`: 同左 |
| `step_skipped` | 上游依赖失败导致跳过 | 静默（仅写入汇总） | 静默 |
| `entity_created` | 创建 Goal/Project/Task 成功 | `delta.content`: `\n[知忆] 已创建 ${entityType}（${entityId}）\n` | `text.delta`: 同左 |
| `entity_updated` | 更新 Goal/Project/Task 成功 | `delta.content`: `\n[知忆] 已更新 ${entityType}（${entityId}）\n` | `text.delta`: 同左 |

> **扩展说明**：若未来接入非 ADP 的自研富客户端（需要结构化 JSON 事件而非纯文本进度），可通过显式请求头 `X-PersonalAI-Protocol: zhiyi-v1.5`（需新增独立协议分支）提供结构化 SSE 事件，**绝不污染 `openai` 与 `adp-v2` 通道**。

---

## 8. 版本控制策略（Versioning Strategy）

1. **URL 主版本（`/v1/*`）保持稳定**：
   - 所有 V1.5 接口均属于 `/v1` 语义化大版本的向后兼容演进（挂载于 `/v1/personal-ai/*` 与 `/v1/agents/*`）。
   - 不在 URL 中引入 `/v1.5/`，避免与 OpenAI 兼容层 `/v1/chat/completions`、`/v1/models` 产生多套前缀维护成本。
2. **向后兼容变更规则（允许在 `/v1` 内直接发布）**：
   - 新增独立端点（如 `/goals`、`/projects`、`/milestones`、`/work-tasks`、`/approvals`、`/schedules`、`/notifications`、`/profile`）。
   - 响应对象新增可空/默认字段（如 `agents` 返回新增 `capabilities`、`execution_tasks` 返回新增 `task_id` / `timeout_at`）。
   - 请求体新增可选参数（带安全默认值）。
   - 列表接口新增可选过滤 Query 参数。
3. **破坏性变更控制（何时必须升级到 `/v2`）**：
   - 删除或重命名现有响应字段。
   - 改变现有字段数据类型或枚举含义（例如绝不将 `execution_tasks.status` 的 `'completed'` 改为 `'succeeded'`）。
   - 收紧现有必填参数校验导致合法 V1 请求失败。
   - 修改 `ErrorEnvelope`（`{ error: { message, type, code } }`）结构。
4. **废弃（Deprecation）流程**：
   - 任何计划在 `/v2` 替换的 `/v1` 端点（如未来整合 `/v1/personal-ai/tasks`），提前至少一个次版本在响应头返回：
     - `Deprecation: true`
     - `Sunset: <HTTP-date>`
     - `Link: </v1/personal-ai/work-tasks>; rel="successor-version"`
   - 并在 `GET /health/personal-ai` 中可选暴露当前启用的特性开关（`features: { planner_v15, policy_approval, proactive_engine }`），便于客户端与控制台进行能力探测（Capability Discovery）。
