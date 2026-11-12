# 知忆（Zhiyi）Personal AI V1.5 · 开源项目调研报告

> 本文档面向知忆（Zhiyi）Personal AI V1.5 架构设计，系统调研 5 个关联开源项目（**OpenMuse**、**Letta**、**Suparagent**、**OpenClaw**、**Thoth**），评估其核心架构、与 V1 已有能力的重叠度、可借鉴的设计模式、跨技术栈代码复用可行性，以及对 V1.5 目标模块的精确映射。
>
> **验证范围声明**：本文档中关于 5 个外部开源仓库的事实均基于已核实的 GitHub/Web 仓库信息；对尚未核实精确 commit SHA 的仓库及存在同名歧义的 **Thoth**，已在第 1 章明确标注待产品负责人确认，**不作任何猜测或编造内部文件名**。知忆 V1 能力对照均直接核实自本仓库源码与 [`ARCHITECTURE.md`](../../ARCHITECTURE.md)。

---

## 目录

1. [待确认事项与歧义清单（Confirmation Check & Ambiguity List）](#1-待确认事项与歧义清单confirmation-check--ambiguity-list)
2. [横向对比总览表](#2-横向对比总览表)
3. [分项目深度分析](#3-分项目深度分析)
   - [3.1 OpenMuse (`CopilotKit/openmuse`)](#31-openmuse-copilotkitopenmuse)
   - [3.2 Letta (`letta-ai/letta`, 原 MemGPT)](#32-letta-letta-ailietta-原-memgpt)
   - [3.3 Suparagent (`Anil-matcha/suparagent`)](#33-suparagent-anil-matchasuparagent)
   - [3.4 OpenClaw (`openclaw/openclaw`)](#34-openclaw-openclawopenclaw)
   - [3.5 Thoth（存在同名歧义 — 需产品负责人确认）](#35-thoth存在同名歧义--需产品负责人确认)
4. [综合映射：到知忆 V1.5 模块的直接落地建议](#4-综合映射到知忆-v15-模块的直接落地建议)

---

## 1. 待确认事项与歧义清单（Confirmation Check & Ambiguity List）

在开展任何源码级引用或细节对齐前，以下事项需由产品负责人 / 技术负责人明确确认：

| 编号 | 项目 | 歧义 / 待确认项 | 当前发现的客观事实 | 处理策略（本文档） |
| --- | --- | --- | --- | --- |
| **C-01** | **Thoth** | **同名仓库歧义（3 个独立 GitHub 仓库）** | 本地工作区无任何记录指明此前选型的是哪一个 `Thoth` 仓库。GitHub 上存在三个不同定位的项目：<br>1. `siddsachar/Thoth`（已演进为 `siddsachar/row-bot`，Apache-2.0）<br>2. `acertainKnight/project-thoth`（Apache-2.0）<br>3. `S1LV4/th0th`（MIT） | **不猜测、不合并混写**。在 §3.5 中分别独立分析三个候选仓库，提炼 PKM 与知识组织的共性可借鉴模式，待产品负责人指明具体目标仓库后，再决定是否做深层源码对照。 |
| **C-02** | **OpenMuse** | **目标分支 / Commit SHA 未锁定** | 已核实为 `CopilotKit/openmuse`（MIT，2026 发布，monorepo 含 `apps/server`、`apps/worker`、`apps/computer`、`apps/mobile`）。由于 V1.5 **不直接引入其代码**（仅借鉴任务生命周期与 HITL 语义），暂无需锁定 commit；若后续计划做组件或协议级代码借鉴，需先确认基线 commit / tag。 | 仅基于已核实的架构设计做模式借鉴；明确标注为“若需代码复用需先锁定 commit”。 |
| **C-03** | **Suparagent** | **目标版本 / Commit SHA 未锁定** | 已核实为 `Anil-matcha/suparagent`（Apache-2.0，v0.8.x 更新至 2026 年末），且其为 **Python FastAPI** 技术栈，与知忆 TypeScript/Node.js 技术栈不匹配。 | 仅借鉴“AI Employee”元数据结构与“Ask first”审批门禁模型；若未来需对齐其某版具体 schema，需先确认目标 tag/commit。 |

---

## 2. 横向对比总览表

| 项目 | GitHub 仓库 | 开源协议 | 技术栈 | Star / 维护状态（已核实） | 对知忆 V1.5 的核心参考价值 | 代码直接复用可行性 |
| --- | --- | --- | --- | --- | --- | --- |
| **OpenMuse** | `CopilotKit/openmuse` | MIT | TypeScript / React / React Native (Expo) / Hono (`apps/server`, `apps/worker`, `apps/computer`, `apps/mobile`), AG-UI 协议 | 活跃（2026 年 CopilotKit 发布，~6.3k stars） | **后台任务持久化生命周期**（pause/resume/cancel/retry）、**HITL 人工接管与审批检查点**、结构化任务计划进度展示 | **不直接引入**（协议为 AG-UI，且含浏览器/Docker Computer Worker，与 V1 现有架构重度重叠） |
| **Letta** | `letta-ai/letta` (原 MemGPT) | Apache-2.0 | Python / FastAPI / SQLAlchemy (SQLite/PostgreSQL) + TypeScript SDK + Letta Code (`letta-ai/letta-code`) + Context Repositories ("MemFS") | 非常活跃（~25.4k+ stars，2025–2026 持续发布） | **分级记忆体系**：Core Memory Blocks（常驻 system prompt 的结构化块）vs Archival / Recall 记忆分层、异步“sleep-time”记忆整理 | **不直接引入**（Python 主服务、工具自编辑 DB 模式绕过 V1 候选审批安全边界；仅借鉴数据结构与分层语义） |
| **Suparagent** | `Anil-matcha/suparagent` | Apache-2.0 | Python FastAPI + SQLAlchemy + Alembic (SQLite/PostgreSQL) + Telegram bot + Web/Desktop UI + Docker/云沙箱 (Boat/Muapi) | 活跃（~7k stars，v0.8.x 更新至 2026 年末） | **“AI 员工”元数据模型**（instructions、权限、并发、例行任务）与 **“Ask first” 高风险动作审批工作流** | **不可复用代码**（Python 栈不匹配，且沙箱执行已由 V1 MultiCA 外部承担） |
| **OpenClaw** | `openclaw/openclaw` | MIT | TypeScript / Node.js 常驻 Gateway 守护进程 + Control UI + `SKILL.md` (`openclaw/agent-skills`) + 多渠道连接器 | 非常活跃（2025–2026 高速增长，每日提交） | **Heartbeat vs Cron 双主动机制**（轻量感知检查 + `HEARTBEAT_OK` 静默无操作 vs 隔离定时汇总任务）、**`SKILL.md` 声明式能力描述** | **不替换网关**（V1 本身已是本地优先 Node.js TS Gateway）；高度契合模式借鉴 |
| **Thoth** *(歧义待确认)* | A: `siddsachar/Thoth` (→ `row-bot`)<br>B: `acertainKnight/project-thoth`<br>C: `S1LV4/th0th` | A: Apache-2.0<br>B: Apache-2.0<br>C: MIT | A: 本地优先 + Ollama + 知识图谱<br>B: Python/FastAPI/TS MCP + Letta + pgvector<br>C: TypeScript monorepo (`apps/`, `packages/core`) | 待产品负责人确认具体目标仓库后再核实精确活跃度 | **PKM 与知识组织模式**：实体/知识图谱关联（对应 `memory_links`）、上下文压缩、原始轨迹与精选知识分离 | 视确认结果而定；V1.5 保持零新增运行时依赖与无向量库原则，仅借鉴设计模式 |

---

## 3. 分项目深度分析

### 3.1 OpenMuse (`CopilotKit/openmuse`)

#### 1) 仓库基本信息
- **仓库**：`CopilotKit/openmuse`
- **协议**：MIT
- **技术栈**：TypeScript 全栈 Monorepo，包含 `apps/server`（Hono）、`apps/worker`、持久化计算机/浏览器执行端 `apps/computer`、移动端 `apps/mobile`（React / React Native Expo），前后端通信采用 **AG-UI 协议**。
- **维护状态**：活跃（CopilotKit 于 2026 年发布，~6.3k stars）。

#### 2) 核心架构、模块、数据模型与关键流程
OpenMuse 面向“持久后台异步 Agent”场景，将对话控制面与长任务执行面彻底解耦：
- **控制面与执行面分离（`apps/server` ↔ `apps/worker` ↔ `apps/computer`）**：任务状态持久化落库，不绑定前端 HTTP/WebSocket 连接；客户端断开重连后可恢复实时状态流与历史计划进度。
- **可控任务生命周期**：任务不仅支持创建与取消，还一等支持 **pause / resume / cancel / retry** 状态转换，用户可在运行中途介入。
- **HITL（Human-in-the-Loop）检查点与“接管控制（Take Control）”**：在敏感操作或需要人工确认的步骤触发中断/挂起状态，将控制权移交用户审批或操作后，再恢复任务执行。
- **AG-UI 实时状态流**：通过 AG-UI 事件协议向前端流式推送任务计划步骤、工具执行状态、审批提示及持久终端/浏览器画面。

#### 3) 对知忆 V1.5 值得借鉴的设计
1. **持久任务计划与步骤级进度模型**：V1 的 `execution_tasks` 只有单一字符串 `progress_message`；V1.5 拆出业务 `tasks`（`btask_`）与 `execution_plans` 后，可借鉴 OpenMuse“结构化计划步骤 + 当前步状态 + 可重试/恢复”的抽象，让前端（以及日志审计）能清晰看到“计划分几步、卡在哪一步、为何挂起”。
2. **HITL 审批检查点语义（Pause → Approve/Reject → Resume）**：OpenMuse 将“需人工确认”设计为任务状态机内的一等挂起态，而非事后报错。这直接启发知忆 V1.5 的 `ApprovalManager` 与 `ExecutionController`：当 `PolicyChecker` 判定某一步需要确认时，执行挂起并创建 `approval_requests` 记录，审批通过后从断点继续，拒绝或超时则安全收敛为 `blocked` / `cancelled` / `failed`。
3. **暂停/恢复（Pause/Resume）状态管理思路**：在保留 V1 终态保护（`updateIfActive` 条件更新）的前提下，为业务层 `tasks`（`blocked` 状态）和计划步骤提供可恢复语义。

#### 4) 代码复用评估
- **建议：不复用源码，仅借鉴架构模式。**
- 尽管技术栈同为 TypeScript（MIT 协议兼容），但 OpenMuse 深度绑定 Hono、AG-UI 事件协议以及 `apps/computer` 持久浏览器/Linux 容器运行时。
- 知忆 V1.5 明确要求**零新增 npm 运行时依赖**、保留 `node:sqlite` 与原生 HTTP 服务架构，且前端通道锁定为 OpenAI 兼容 SSE / `adp-v2` 11 事件白名单（[`src/personal-ai/adapters/protocol/adp-protocol-adapter.ts`](../../src/personal-ai/adapters/protocol/adp-protocol-adapter.ts)）。直接引入 OpenMuse 代码会带来协议冲突与沉重的沙箱依赖。

#### 5) 与 V1 已有能力的重叠 & 明确不引入的部分
- **V1 已有重叠能力**：
  - 后台解耦执行与客户端断连容忍：[`TaskWorker`](../../src/personal-ai/worker/task-worker.ts) 已独立于 HTTP 生命周期运行，启动时通过 `recover()` 恢复遗留 `dispatching` 任务；
  - 异步事件与 SSE 流：[`PersonalAIRuntime`](../../src/personal-ai/runtime/personal-ai-runtime.ts) 产出 `PersonalAIEvent`，经 `AdpProtocolAdapter` 转换为标准 SSE 流。
- **明确不引入 V1.5 的部分**：
  - ❌ **不引入 AG-UI 协议**（知忆必须保持 OpenAI 兼容 SSE 及 `adp-v2` 11 个固定 `EventType` 契约）；
  - ❌ **不引入浏览器 / Playwright Worker 或 Docker Linux 桌面环境**（`apps/computer`）；外部代码/终端执行继续由 MultiCA CLI 适配器承担。

---

### 3.2 Letta (`letta-ai/letta`, 原 MemGPT)

#### 1) 仓库基本信息
- **仓库**：`letta-ai/letta`（原 MemGPT）；生态含 `letta-ai/letta-code`（Letta Code）
- **协议**：Apache-2.0
- **技术栈**：Python / FastAPI / SQLAlchemy（支持 SQLite / PostgreSQL），附带 TypeScript SDK；支持 Context Repositories（"MemFS"，基于 Git 的上下文记忆文件系统）。
- **维护状态**：非常活跃（~25.4k+ stars，2025–2026 持续高频迭代）。

#### 2) 核心架构、模块、数据模型与关键流程
Letta 将 OS 虚拟内存理念引入 LLM 上下文管理，核心设计包括：
- **OS 式分层记忆（Memory Hierarchy）**：
  - **Core Memory Blocks**：一组带明确标签的结构化文本块（如默认 `persona`、`human` 及自定义块），**始终固定编译进 system prompt**，代表 Agent 对自身角色与当前用户的“工作级热记忆”，有严格字符/Token 预算；
  - **Archival Memory**：外部长期存储库，通过显式检索按需召回，不常驻上下文；
  - **Recall / Episodic Memory**：历史交互流水与情景记录，用于回溯对话历史。
- **Agent 自编辑记忆工具（Self-Editing Memory Tools）**：Agent 可在推理过程中调用 `core_memory_append` / `core_memory_replace` / `archival_memory_insert` 主动修改自身记忆。
- **异步 Sleep-time 记忆整理**：在非同步对话间隙，由后台任务对近期交互进行摘要、去重、提炼与块整理，降低主对话延迟。
- **Context Repositories（"MemFS"）**：将记忆与知识组织成版本化、可读可审的仓库结构，提升长期记忆的可解释性与可回滚性。

#### 3) 对知忆 V1.5 值得借鉴的设计
1. **结构化 Core Memory Blocks（热记忆块 vs 归档检索记忆）**：
   - 知忆 V1 的 `agents.core_memory` 目前是一个纯文本字段（如 [`src/agents.ts`](../../src/agents.ts) 中种子数据的 `'关注：技术栈、架构决策…'`），且只在搜索加权与 prompt 拼接中粗粒度使用；用户画像则完全缺失。
   - 借鉴 Letta 的 Block 思想，V1.5 可将**“常驻工作记忆块”**与**“按需检索的长期记忆库（`memories`）”**明确区分：
     - **User Profile 块**（`users` 表中的 `display_name`、`preferences`、`timezone`、`work_style`）：作为稳定个人约束注入；
     - **Agent Persona / Instructions 块**（扩展 `agents` 表的 `core_memory` + `instructions`）：稳定定义 Agent 角色与边界；
     - **活跃项目/目标摘要块**：只注入与当前会话相关的活跃 Goal/Project 摘要，避免把全量历史塞入 prompt。
2. **记忆语义分层（工作热记忆 vs 事实/偏好/经验/临时上下文）**：
   - 与 V1 已有的 5 类 `MemoryType`（`identity | episodic | semantic | procedural | working`，见 [`src/types.ts`](../../src/types.ts)）天然对齐。借鉴 Letta 对“热块 vs 归档 vs 情景”的清晰边界，V1.5 应在 `Memory Integration` 中进一步约束：哪些记忆适合长期沉淀（事实、偏好、项目经验），哪些属于临时上下文（`working`）应定期衰减或仅绑定特定 `task_id` / `project_id`。
3. **异步“Sleep-time”巩固思路（受控版）**：
   - V1 已在后台通过 `ExtractionQueue`（`setImmediate` 串行队列）从 `trajectories` 异步提取 `memory_candidates`。V1.5 可沿用此异步机制，扩展为从**业务事件**（如任务完成复盘、Goal/Milestone 达成）异步生成候选或合并冗余/过期记忆建议——**但必须经过候选审批或置信度门控**，不可让模型无审核覆盖正式记忆。

#### 4) 代码复用评估
- **建议：跨栈不可复用代码，仅借鉴记忆分层与块模型。**
- **技术栈不匹配**：Letta 核心服务端为 **Python / FastAPI / SQLAlchemy**，而知忆网关为 **TypeScript / Node.js (`node:sqlite`)**。虽然 Letta 提供 TypeScript SDK，但该 SDK 仅是连接 Letta 独立 Python Server 的客户端；知忆 V1.5 架构原则明确规定单进程本地优先、零外部服务依赖、不引入 Python 侧车进程，因此不能通过 SDK 接入 Letta Server。

#### 5) 与 V1 已有能力的重叠 & 明确不引入的部分
- **V1 已有重叠能力**：
  - 长期记忆存储与 5 类分类：[`MemoryStore`](../../src/memories.ts) + `memories` 表（[`migrations/001_init.sql`](../../migrations/001_init.sql)）；
  - 记忆检索与上下文注入：[`searchMemories()`](../../src/search.ts) 与 [`buildPersonalAIContext()`](../../src/personal-ai/runtime/context-builder.ts)；
  - 异步提取与候选库：[`CandidateStore`](../../src/candidates.ts) + `memory_candidates` 表 + 人工 `/approve` 幂等落库机制；
  - 轨迹记录：`trajectories` 表（复合唯一键 `(user_id, request_id)`）。
- **明确不引入 V1.5 的部分**：
  - ❌ **不引入 Letta Python Server 或独立向量数据库**（V1.5 继续基于 SQLite + 关键词/关联加权检索，避免引入 pgvector/Chroma/Qdrant 运维复杂度）；
  - ❌ **不引入“Agent 无审核直接写正式记忆库”机制**：Letta 允许 Agent 直接通过 tool 改写 DB，在个人记忆多 Agent 共享场景下存在记忆投毒与幻觉污染风险；知忆必须保留 V1 `memory_candidates` 的审批安全阀或受控策略（低风险临时工作上下文除外）。

---

### 3.3 Suparagent (`Anil-matcha/suparagent`)

#### 1) 仓库基本信息
- **仓库**：`Anil-matcha/suparagent`
- **协议**：Apache-2.0
- **技术栈**：Python FastAPI + SQLAlchemy + Alembic（SQLite / PostgreSQL）+ Telegram Bot + Web/Desktop UI + Docker / 云沙箱（Boat / Muapi）。
- **维护状态**：活跃（~7k stars，v0.8.x 版本持续更新至 2026 年末）。

#### 2) 核心架构、模块、数据模型与关键流程
Suparagent 围绕“雇佣和管理一组数字员工（AI Employees）”设计：
- **AI Employee 模型**：每个 Agent 不只是名称和提示词，而是一个完整“员工实体”，包含：
  - 职责与行为指令（Instructions）
  - 持久专属记忆与偏好
  - 工具/权限边界与可执行动作范围
  - 例行工作（Routines / 周期任务）
  - 所属协作空间（Shared Project Rooms）与隔离计算环境（Agent Computers）。
- **“Ask First” 人工审批流**：当 AI Employee 拟执行高风险或不可逆操作（如外部发送、敏感写操作、高权限工具调用）时，先暂停并向人类发起结构化请求，展示意图、目标对象与风险理由，等待人类批准后方可执行。
- **独立 Agent 沙箱（Boat / Muapi）**：为每个员工分配独立的 Docker 或云端虚拟电脑环境执行命令。

#### 3) 对知忆 V1.5 值得借鉴的设计
1. **“AI Employee” 结构化注册表模型**：
   - 知忆 V1 的 `agents` 表仅含 `agent_id, name, role, description, core_memory`（见 [`migrations/001_init.sql`](../../migrations/001_init.sql)），缺少能力标签、权限策略、执行后端与状态管理。
   - 借鉴 Suparagent 的员工元数据建模，可直接指导知忆 V1.5 扩展 `agents` 表字段：
     - `capabilities`（JSON 能力标签，供 Planner 做确定性筛选）
     - `execution_backend`（如 `multica` / `direct_llm` 等适配器路由）
     - `permission_policy`（该 Agent 允许自动执行 vs 必须审批的操作级别）
     - `status`（可用 / 维护 / 禁用）与 `concurrency_limit`（并发上限）
     - `instructions`（结构化行为准则）。
2. **“Ask First” 风险分层审批门禁**：
   - 将审批判定从“执行失败后人工补救”前移为“**规划/派发前策略检查**”。
   - 知忆 V1.5 的 `PolicyChecker` + `ApprovalManager`（`approval_requests` 表）可采用类似语义：在请求体中明确记录 `risk_level`、涉及的资源/操作摘要、触发策略原因、过期时间（timeout）以及审批后的作用域/可撤销性（revocation）。

#### 4) 代码复用评估
- **建议：技术栈完全不匹配，禁止直接复用代码，仅借鉴领域模型与交互语义。**
- Suparagent 基于 **Python FastAPI + SQLAlchemy + Alembic**，与知忆的 **TypeScript / Node.js / 原生 `node:sqlite` + 手写 SQL 迁移**无任何代码层面可移植性。

#### 5) 与 V1 已有能力的重叠 & 明确不引入的部分
- **V1 已有重叠能力**：
  - Agent 基础档案：`agents` 表与 [`AgentStore`](../../src/agents.ts)（内置 `developer`、`researcher`）；
  - 外部沙箱/编码执行委托：V1 已通过 `MultiCAAdapter` 调用宿主机的 MultiCA CLI 派发给 Codex / Claude Code 等外部执行器，无需再造一套容器沙箱调度器。
- **明确不引入 V1.5 的部分**：
  - ❌ **不引入 Python FastAPI / SQLAlchemy / Alembic 技术栈**；
  - ❌ **不引入 Docker / Boat / Muapi Agent 虚拟电脑沙箱**；
  - ❌ **不引入 Telegram Bot 与重型多房间群聊架构**（V1.5 聚焦统一个人助理网关，通知以应用内 `notifications` + 可选 Webhook 为主）。

---

### 3.4 OpenClaw (`openclaw/openclaw`)

#### 1) 仓库基本信息
- **仓库**：`openclaw/openclaw`（配套技能仓库 `openclaw/agent-skills`）
- **协议**：MIT
- **技术栈**：TypeScript / Node.js 常驻 Gateway 守护进程 + Control UI + `SKILL.md` 声明式技能体系 + 多渠道连接器（WhatsApp、Telegram、Discord、Slack）。
- **维护状态**：非常活跃（2025–2026 现象级开源增长，保持高频日更）。

#### 2) 核心架构、模块、数据模型与关键流程
OpenClaw 是本地优先（Local-first）个人 AI 网关的代表架构：
- **单点本地 Gateway 控制面**：单一 Node.js 常驻进程承载认证、会话、工具路由、技能加载与后台定时调度，无需复杂分布式基础设施。
- **`SKILL.md` 声明式技能规范**：通过标准化的 Markdown + 元数据描述文件定义“什么时候触发该能力、前置条件、输入约束与操作指南”，使能力扩展无需硬编码进核心路由器。
- **Heartbeat vs Cron 双主动引擎机制**：
  - **Heartbeat（心跳感知检查）**：周期性在主上下文中做轻量“环境巡检”（检查是否有待办超期、异常提醒、未读状态）；若一切正常，返回 **`HEARTBEAT_OK` 静默无操作（silent no-op）**，不打扰用户、不产生冗余消息；
  - **Cron（隔离定时任务）**：用于明确约定时间与内容的重型或周期性作业（如每日晨报、每周复盘汇总），在隔离会话上下文中执行并投递结果。

#### 3) 对知忆 V1.5 值得借鉴的设计
1. **Heartbeat vs Cron 分离模型（对 V1.5 Proactive Engine 价值最高）**：
   - 知忆 V1.5 主动引擎必须**有界、可控、防打扰**（绝不能变成失控的自主循环）。OpenClaw 的双轨机制完美契合 V1.5 范围：
     - **轻量检查类触发器（Heartbeat 模式）**：任务到期提醒、停滞任务（stale progress）提醒、Agent 执行失败告警、待审批超时提醒——定时扫描 SQLite 状态表（无需每次盲目调大模型），无命中或命中冷却/去重规则即静默 `no-op`；只有真正满足条件时才生成 `notifications` 记录并推送；
     - **定时汇总类任务（Cron 模式）**：每日/每周工作与目标进度汇总，持久化在 `scheduled_jobs` 表中，绑定用户 `timezone`、去重键（dedup key）、冷却窗口（cooldown）与用户暂停开关（user pause）。
2. **`SKILL.md` 风格的声明式能力描述**：
   - 在知忆 V1.5 `Agent Registry` 中，除结构化数据库列（`capabilities`、`permission_policy`）外，可借鉴 `SKILL.md` 思想在 `agents.instructions` 中规范定义“适用场景 / 禁止动作 / 输入要求 / 输出格式”，既便于 `AssistantPlanner`（LLM 规划器）准确选人，也方便人类阅读与维护。
3. **本地优先单进程演进哲学**：
   - 验证了知忆 V1 选择“单进程 Node.js Gateway + 本地持久化”路线的正确性——无需引入 Redis/Kafka/微服务拆分，通过进程内定时器 + 持久化任务/作业表即可支撑个人 AI 完整主动能力。

#### 4) 代码复用评估
- **建议：同栈（TypeScript / Node.js，MIT），但无需整包引入；采用精确的模式复刻。**
- OpenClaw 代码库重点围绕多聊天软件通道网关（WhatsApp/Telegram/Discord/Slack）与自主工具执行循环；知忆已具备完整的 HTTP/SSE 网关（[`src/app.ts`](../../src/app.ts)、[`src/personal-ai/routes.ts`](../../src/personal-ai/routes.ts)）、`IdentityManager` 与 `TaskWorker`。直接复刻其 Heartbeat 静默检查契约、Cron 元数据模型与 `SKILL.md` 指令结构，只需百行级轻量 TypeScript 代码，零外部依赖且完全可控。

#### 5) 与 V1 已有能力的重叠 & 明确不引入的部分
- **V1 已有重叠能力**：
  - 知忆 V1 **本身就已经是一个本地优先的 TypeScript / Node.js Gateway**（含模型代理、记忆核心、Personal AI Runtime、后台 Worker 与 SSE 协议适配器）；
  - 进程内定时轮询基础设施已在 [`TaskWorker`](../../src/personal-ai/worker/task-worker.ts) 中验证（`setInterval` + `unref()` + `recover()`）。
- **明确不引入 V1.5 的部分**：
  - ❌ **不替换现有 Gateway 架构**；
  - ❌ **不引入 WhatsApp / Telegram / Discord / Slack 多端 IM 机器人连接器**（V1.5 通过 `/v1/personal-ai/notifications` 与应用内通知提供异步触达，Webhook 仅作为可选边界）；
  - ❌ **不引入无约束自主 Agent 循环**（Proactive Engine 严格受限于已定义的 5 类有限触发器与用户暂停/冷却控制）。

---

### 3.5 Thoth（存在同名歧义 — 需产品负责人确认）

> ⚠️ **关键提醒**：GitHub 上存在多个名为 `Thoth` / `th0th` 的独立开源项目，且本地工作区无历史选型记录。**本文档不擅自指定某一个作为唯一目标**，而是将已核实的三个候选项目分别列出，待产品负责人确认后再决定是否展开源码级对照。

#### 1) 三个候选仓库核实信息

| 候选标识 | GitHub 仓库 | 协议 | 技术栈与定位（已核实） | 与知忆 V1.5 的潜在交集 |
| --- | --- | --- | --- | --- |
| **候选 A** | `siddsachar/Thoth` *(已演进为 `siddsachar/row-bot`)* | Apache-2.0 | 本地优先主权 AI 助手（Local-first Sovereign AI），集成 Ollama、**知识图谱（Knowledge Graph）**、自定义工具构建器 | 本地隐私优先、实体/知识图谱关系建模、用户完全掌控数据 |
| **候选 B** | `acertainKnight/project-thoth` | Apache-2.0 | Python / FastAPI / TypeScript 研究助手 **MCP Server**，底层构建于 **Letta + PostgreSQL / pgvector** | MCP 协议暴露记忆能力、基于 Letta 的研究辅助工作流（但强依赖 Python + Postgres/pgvector） |
| **候选 C** | `S1LV4/th0th` | MIT | **TypeScript Monorepo**（`apps/`、`packages/core`），主打语义检索、**上下文压缩（Context Compression）**、持久记忆与 Synapse 认知层 | 与知忆同为 TypeScript 栈；上下文 Token 预算压缩、结构化记忆检索优化 |

#### 2) 核心设计模式与对知忆 V1.5 值得借鉴之处
尽管三个候选仓库实现路径不同，但围绕“个人知识管理（PKM）与长期记忆组织”，以下三类模式对知忆 V1.5 具有明确价值：
1. **知识图谱 / 实体关联（`memory_links`）**：
   - 知忆 V1 的 `memories` 表是扁平记录，仅靠 `agent_id`、`project_id` 两个弱字段关联；无法表达“这条技术决策记忆支撑哪个 Goal / Project / Milestone / Task”，也无法表达记忆之间的演化或冲突关系。
   - 借鉴 PKM 知识关联思路，V1.5 引入 **`memory_links` 联结表**，显式建立 `Memory ↔ Goal / Project / Milestone / Task` 的双向可追踪关系，并支持按业务实体上下文精准召回关联记忆。
2. **上下文压缩与 Token 预算控制（借鉴 `S1LV4/th0th` 方向）**：
   - 当 V1.5 在 [`ContextBuilder`](../../src/personal-ai/runtime/context-builder.ts) 中同时注入 `User Profile`、`Agent Persona`、活跃 `Goal/Project/Task` 上下文和检索命中的 `Memories` 时，system prompt 极易膨胀。
   - 需要借鉴上下文压缩思想：**分层配额 + 结构化摘要注入**（例如仅注入活跃 Goal 标题/进度摘要、Top-K 高相关记忆及去重后的关联经验），确保不超过模型有效上下文窗口且不稀释核心指令。
3. **原始轨迹（Raw Trajectories）与精选知识（Curated Knowledge）分离**：
   - 将不可变的对话/执行原始流水（`trajectories`、`execution_tasks`）与经过提炼、去重、核验的长期知识（`memories`、`memory_links`）严格分层，避免原始噪声直接污染规划上下文。

#### 3) 代码复用评估
- **在产品负责人确认具体 `Thoth` 仓库之前，暂不建议做任何代码级移植评估。**
- 若确认指向 **候选 B (`acertainKnight/project-thoth`)**：因依赖 Python + Letta + PostgreSQL/pgvector，与知忆 V1.5（Node.js + SQLite、不引入向量库）栈不匹配，不复用代码。
- 若确认指向 **候选 A (`siddsachar/Thoth` / `row-bot`)** 或 **候选 C (`S1LV4/th0th`)**：需先由产品负责人确认具体仓库与目标 commit 后，再评估 `packages/core`（候选 C，MIT）中是否有纯 TypeScript 的上下文压缩算法可局部参考。

#### 4) 与 V1 已有能力的重叠 & 明确不引入的部分
- **V1 已有重叠能力**：
  - 原始轨迹与正式知识分离在 V1 已具雏形（`trajectories` → `memory_candidates` → `memories`）；
  - 本地数据主权与严格用户隔离（`user_id` 强制过滤）已是 V1 基线设计。
- **明确不引入 V1.5 的部分**：
  - ❌ 不引入独立图数据库（Neo4j 等）或 PostgreSQL / pgvector（用 SQLite `memory_links` 关系表即可满足 V1.5 实体关联需求）；
  - ❌ 不强绑 Ollama 本地模型运行假设（保持 V1 标准 OpenAI 兼容上游接口与 `UpstreamService` 配置能力）。

---

## 4. 综合映射：到知忆 V1.5 模块的直接落地建议

本节严格遵循 V1.5 跨文档标准化约束（保留 `execution_tasks` 表名并扩展 `task_id`/`timeout_at`/`timeout` 状态；新增 `tasks` 业务表使用 `btask_` 前缀；迁移脚本为 `migrations/004_v1_5.sql`；API 统一挂载于 `/v1/personal-ai/*` 与 `/v1/agents/:id`；`adp-v2` 新事件统一降级为 `text.delta`；零新增 npm 运行时依赖），将调研成果直接映射到 V1.5 五大核心演进领域：

### 4.1 规划与任务编排（Planner & Task Orchestration）
- **借鉴来源**：**OpenMuse**（持久任务计划与步骤级恢复/暂停语义）+ **OpenClaw**（单点本地网关控制平面）。
- **知忆 V1.5 落地方案**：
  - 保留 [`PersonalAIRuntime`](../../src/personal-ai/runtime/personal-ai-runtime.ts) 作为**唯一决策中心**，由 `AssistantPlanner`（LLM 辅助意图识别与结构化计划生成，支持置信度阈值澄清/确认）+ `ExecutionController`（多步计划执行、步骤状态持久化至 `execution_plans`）替代 V1 纯正则 [`understandIntent()`](../../src/personal-ai/runtime/intent-understanding.ts) 与单步 [`planExecution()`](../../src/personal-ai/runtime/execution-planner.ts)。
  - **双层任务分离（Scheme B）**：
    - 业务层 `tasks`（`btask_`）：承载用户视角生命周期（`draft | pending | ready | assigned | in_progress | blocked | completed | failed | cancelled`）与子任务树（`parent_task_id`），暴露于 `/v1/personal-ai/work-tasks`；
    - 执行层 `execution_tasks`（`task_`）：**保留原表名与 V1 状态机**（`completed` 不改名，仅追加 `task_id` 外键、`timeout_at` 及 `timeout` 状态），确保 V1 `/v1/personal-ai/tasks/*` 接口、[`TaskWorker`](../../src/personal-ai/worker/task-worker.ts) 终态保护与现有 104 项测试 100% 兼容。
  - **协议兼容约束**：新增运行时事件（如计划提议、等待审批、澄清提示）在 [`AdpProtocolAdapter`](../../src/personal-ai/adapters/protocol/adp-protocol-adapter.ts) 中严格遵循 `openai` → `delta.content`、`adp-v2` → `text.delta` 降级规则，不突破 11 个固定 `EventType`。

### 4.2 Agent 注册表（Agent Registry）
- **借鉴来源**：**Suparagent**（“AI 员工”完整元数据模型）+ **OpenClaw**（`SKILL.md` 声明式能力与边界描述）+ **Letta**（结构化 Persona Block）。
- **知忆 V1.5 落地方案**：
  - 在 `migrations/004_v1_5.sql` 中扩展现有 `agents` 表，新增：
    - `capabilities`（能力标签 JSON，供 Planner 做确定性初筛）；
    - `execution_backend`（执行后端标识，如 `multica`、`direct_llm`）；
    - `permission_policy`（权限与风险策略配置）；
    - `status`（在线/停用等可用状态）与 `concurrency_limit`（并发配额）；
    - `instructions`（采用 `SKILL.md` 风格的清晰指令规范：适用场景、输入要求、禁止行为）。
  - 保留 `core_memory`（支持检索加权与热记忆注入），通过 `/v1/agents/:id`（`PATCH` 与状态 `GET`）支持运行期可管理。

### 4.3 记忆集成与知识组织（Memory Integration & User Profile）
- **借鉴来源**：**Letta**（Core Memory Blocks 热记忆 vs Archival 检索分层、受控异步整理）+ **Thoth**（实体关联 / 知识图谱化链接、上下文压缩、轨迹与知识分离）。
- **知忆 V1.5 落地方案**：
  - **保留 V1 Memory Core 与候选安全阀**：[`MemoryStore`](../../src/memories.ts)、[`CandidateStore`](../../src/candidates.ts)（必须 `approve` 才进正式库）、[`searchMemories()`](../../src/search.ts)（无向量库、SQLite 本地检索）保持核心不变。
  - **结构化热记忆块**：新增 `users`（或 `user_profiles`）表记录 `display_name`、`preferences`、`timezone`、`work_style`，与 `agents.core_memory` / `instructions` 以及当前活跃 Goal/Project 摘要共同构成类似 Letta Core Blocks 的精简前置上下文（配合配额裁剪与压缩，控制 Token 膨胀）。
  - **实体关联（`memory_links`）**：新增 `memory_links` 表连接 `memories` 与 `goals` / `projects` / `milestones` / `tasks`，支持按当前业务上下文精准加权检索，并区分**事实（facts）/ 偏好（preferences）/ 经验（experiences）/ 临时上下文（working）**，强化按 `agent_id` 与 `scope` 的访问控制（ACL）。
  - **业务事件异步提取**：复刻“sleep-time”异步梳理思路，在业务任务完成、Milestone 达成等节点复用 `ExtractionQueue` 生成记忆候选或过期提醒，仍走人工/受控确认入库。

### 4.4 审批管理（Approval Manager & Policy Checker）
- **借鉴来源**：**Suparagent**（“Ask First” 高风险操作前置确认）+ **OpenMuse**（HITL 检查点挂起与恢复生命周期）。
- **知忆 V1.5 落地方案**：
  - 在 `PersonalAIRuntime` 规划与派发之间插入服务端 **`PolicyChecker`**（不依赖 LLM 自律，由服务端策略硬拦截）。
  - 新增 `approval_requests` 表，记录 `user_id`、关联 `task_id` / `execution_task_id`、风险等级（`risk_level`）、操作描述、审批状态（含待审、已批准、已拒绝、超时、`revoked` 撤销态）、作用域与超时时间。
  - 命中高风险或低置信度需确认步骤时，业务任务转入 `blocked`（等待审批），前端通过 `/v1/personal-ai/approvals` 查询与决策；审批通过后由 `ExecutionController` 从挂起点恢复派发。

### 4.5 主动引擎与通知中心（Proactive Engine & Notification Manager）
- **借鉴来源**：**OpenClaw**（**Heartbeat vs Cron** 双轨机制、`HEARTBEAT_OK` 静默无操作原则、本地单进程常驻调度）+ **Suparagent**（Routines 周期例行任务）。
- **知忆 V1.5 落地方案**：
  - **有界且可控的 V1.5 触发器范围**（绝不引入无边界自主循环）：仅覆盖 5 类明确场景——① 任务到期提醒、② 任务停滞（stale progress）提醒、③ Agent 执行失败告警、④ 待处理审批提醒、⑤ 每日/每周周期汇总。
  - **调度器与持久化（`scheduled_jobs`）**：复用 V1 [`TaskWorker`](../../src/personal-ai/worker/task-worker.ts) 的 `setInterval` + `unref()` + 启动 `recover()` 模式，不引入 Redis/BullMQ。`scheduled_jobs` 持久化调度定义，内建 **时区（`timezone`）、去重键（dedup）、冷却时间（cooldown）、用户暂停开关（user pause）**，管理端点为 `/v1/personal-ai/schedules`。
  - **Heartbeat 静默准则**：状态扫描类作业优先执行纯 SQL 条件检查，无符合条件项或处于冷却/静默期时直接静默 `no-op`，严禁制造垃圾打扰。
  - **异步通知落地（`notifications`）**：补充 V1 仅在 SSE 连接存活期能推消息的短板；所有主动触发与后台任务完成事件统一写入 `notifications` 表并经 `EventBus` 广播，支持已读/未读管理与去重（`/v1/personal-ai/notifications`），以应用内通知为主、Webhook 为可选扩展。

---

### 附：V1.5 架构红线对照表（研后决策确认）

| 外部项目中的常见做法 | 知忆 V1.5 决策 | 核心依据 |
| --- | --- | --- |
| 引入独立 Python 服务 / 侧车（Letta / Suparagent / Thoth-B） | **拒绝** | 保持单进程 Node.js TypeScript 网关与本地优先零外部依赖原则 |
| 引入向量数据库 / 图数据库（pgvector / Neo4j） | **拒绝** | V1.5 坚持 SQLite（`node:sqlite`）+ 关键词加权 + `memory_links` 关系表 |
| Agent 工具直接写正式记忆表（Letta） | **拒绝** | 保留 `memory_candidates` 审批安全门，防止幻觉污染长期记忆 |
| 替换 SSE 为 AG-UI 或自定义事件（OpenMuse） | **拒绝** | 严守 OpenAI 兼容 SSE 与 `adp-v2` 11 事件白名单契约 |
| 引入浏览器/Linux 容器沙箱（OpenMuse / Suparagent） | **拒绝** | 外部编码/环境执行已由 MultiCA CLI 适配器承担 |
| 引入 Redis / Kafka 任务队列 | **拒绝** | 进程内 `TaskWorker` + SQLite 状态机 + `scheduled_jobs` 足以支撑个人规模 |
