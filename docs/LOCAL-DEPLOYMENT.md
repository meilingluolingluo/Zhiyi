# 知忆（Zhiyi）· macOS 本机部署指南（无 Docker）

> 知忆 = 本仓库的 Personal AI Gateway V1 的对外品牌名；`personal-ai` 目录与 `/v1/personal-ai` 路由为内部命名，保持不变。

本文描述如何在一台 macOS 机器上，用**本机进程**运行完整的 Personal AI 链路：

```text
浏览器
  → ADP Chat Client（Vite 5174 + Sanic 8000）
  → Personal AI Gateway（Node 8790）
      ├─ 真实模型（本机 OpenAI 兼容代理 8787）
      ├─ SQLite（./data/memory.db）
      └─ MultiCA CLI（可选，需 OAuth 登录 + daemon）
```

> 本机实测环境：macOS 26.6.2 / arm64、Node v22.22.2、Python 3.12.14、PostgreSQL 18.6（embedded-postgres 18.6.0-beta.19）。

---

## 1. 前置条件

| 组件 | 要求 | 检查命令 |
|---|---|---|
| Node.js | ≥ 22 | `node -v` |
| npm | ≥ 10 | `npm -v` |
| Python | 3.12（ADP 精确要求） | `python3 --version` |
| uv | 任意较新版本 | `uv --version` |
| sqlite3 | 任意 | `sqlite3 --version` |
| PostgreSQL | 18.x（本机无 Docker 时用 embedded-postgres） | `lsof -nP -iTCP:5433 -sTCP:LISTEN` |
| 模型端点 | 任意 OpenAI 兼容 `/v1/chat/completions` | `curl $BASE/v1/models` |
| ADP Chat Client | 独立目录，未复制进本项目 | `ls ../adp-chat-client` |
| MultiCA CLI | 可选；真实 Agent 执行必需 | `multica --version` |

一键自检：

```bash
bash scripts/local/check-env.sh
```

---

## 2. 目录约定

```text
agent/
├── universal-memory-gateway/     # 本项目
│   ├── data/memory.db            # SQLite（真实数据，勿删）
│   ├── data/pgdata/              # 内嵌 PostgreSQL 数据目录
│   ├── data/pg-node/             # embedded-postgres npm 依赖
│   └── scripts/local/            # 本机启动/健康检查脚本
└── adp-chat-client/              # ADP 官方仓库（独立部署，不改源码）
```

---

## 3. 配置真实模型

本项目把模型配置与 MultiCA CLI 配置**分开**：

- `.env` 中的 `MULTICA_BASE_URL` / `MULTICA_API_KEY` 是**模型上游**地址（历史命名，容易误解），不是 MultiCA 服务地址。
- `.env.personal-ai` 中的 `MODEL_BASE_URL` / `MODEL_API_KEY` 可覆盖同名字段。
- `MULTICA_ENABLED` / `MULTICA_CLI_PATH` 等才是 MultiCA CLI 配置。

本机模型代理示例（任何 OpenAI 兼容端点同理）：

```env
MOCK_UPSTREAM=false
MULTICA_BASE_URL=http://127.0.0.1:8787/v1
MULTICA_API_KEY=<本机模型代理的 key；若代理免鉴权可留空>
DEFAULT_MODEL=DeepSeek-V4-Flash-baidu-oneapi
```

验证模型（不经过 Gateway）：

```bash
curl -sS $MULTICA_BASE_URL/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"$DEFAULT_MODEL"'","messages":[{"role":"user","content":"回复：OK"}],"max_tokens":16}'
```

> 若使用公司 OnePAI / DeepSeek 官方端点，把 `MULTICA_BASE_URL` 换成其 `/v1` 地址、
> `MULTICA_API_KEY` 换成真实 Key 即可。**Key 只写入本机 `.env`（权限 600），不要提交。**

---

## 4. 启动顺序

### 4.1 PostgreSQL（ADP 必需）

ADP 只支持 PostgreSQL。本机无 Docker 时使用项目内嵌二进制：

```bash
# 一次性安装（约 1 分钟，仅装到 data/pg-node）
npm install --prefix data/pg-node embedded-postgres

# 启动（前台常驻，数据目录 data/pgdata，端口 5433）
node scripts/local/start-postgres.mjs
```

首次启动会自动 `initdb`；脚本还会创建 `adp_chat` 数据库。
ADP 迁移会先连默认库（即用户名同名库）再 `CREATE DATABASE`，因此脚本/文档约定：

- `PGSQL_USER` 使用当前系统用户（如 `mll`）
- 额外创建同名引导库（首次执行一次）：

```bash
# 若日志出现 database "<用户名>" does not exist，执行：
python3 - <<'PY'
import asyncio, asyncpg
async def main():
    c = await asyncpg.connect('postgresql://<用户名>:localdev@127.0.0.1:5433/postgres')
    await c.execute('CREATE DATABASE "<用户名>"')
    await c.close()
asyncio.run(main())
PY
```

### 4.2 Personal AI Gateway

```bash
cp .env.example .env
cp .env.personal-ai.example .env.personal-ai
# 按第 3 节填写真实模型配置
bash scripts/local/start-gateway.sh
```

- 默认端口 `8790`（`8787` 常被本机模型代理占用，勿冲突）
- 健康检查：`curl --noproxy '*' http://127.0.0.1:8790/health`
- 数据库迁移 001/002/003 在启动时幂等执行

### 4.3 ADP Chat Client

ADP 是独立仓库，**不要复制进本项目**。首次准备：

```bash
cd ../adp-chat-client

# 后端依赖（uv 会自动准备 Python 3.12）
cd server && uv sync && cd ..

# 前端依赖
cd client && npm install && cd ..

# 组件库（必须，否则 UI 白屏）
cd client/packages/adp-chat-component && npm run build && cd ../../../..

# Vite 代理目标（本机联调）
cat > client/packages/app/.env.local <<'EOF'
SERVICE_API_URL=http://127.0.0.1:8000
EOF
```

`server/.env` 关键配置：

```env
APP_CONFIGS='[{
  "Vendor":"OpenAICompatible",
  "ApplicationId":"personal-ai",
  "DisplayName":"知忆",
  "Avatar":"http://127.0.0.1:8000/static/brand/zhiyi-256.png",
  "Greeting":"你好，我是 Personal AI。",
  "OpeningQuestions":["你能做什么？"],
  "ApiKey":"dev-key-developer",
  "BaseUrl":"http://127.0.0.1:8790/v1/personal-ai",
  "ModelName":"DeepSeek-V4-Flash-baidu-oneapi"
}]'

AUTO_CREATE_ACCOUNT=true
SECRET_KEY=<随机 64 位 hex>
SERVICE_API_URL=http://127.0.0.1:8000
SERVER_HTTP_PORT=8000
CORS_ORIGINS=http://127.0.0.1:5174,http://localhost:5174

PGSQL_HOST=127.0.0.1
PGSQL_PORT=5433
PGSQL_DB=adp_chat
PGSQL_USER=<当前系统用户>
PGSQL_PASSWORD=localdev
```

启动：

```bash
bash scripts/local/start-adp.sh      # 同时拉起 8000 + 5174
```

浏览器访问 <http://127.0.0.1:5174/>。

> `BaseUrl` 必须包含 `/v1/` 且**不以 `/v1` 结尾**：ADP 会在缺少 `/v1/` 时自动追加 `/v1`。
> `ApiKey` 填 **Gateway 的开发 Key**（如 `dev-key-developer`），不是模型 Key。

**品牌头像**：`APP_CONFIGS.Avatar` 指向 `http://127.0.0.1:8000/static/brand/zhiyi-256.png`，
文件位于 ADP 的 `server/static/brand/zhiyi-256.png`（源图同时归档在本仓库 `docs/assets/`）。
替换头像时覆盖该文件，或把 `Avatar` 改成新的可访问 URL；改完重启 ADP 后端即可生效。

---

## 5. 健康检查

```bash
bash scripts/local/check-health.sh
bash scripts/local/smoke-e2e.sh
```

覆盖：Gateway、SQLite、真实模型、Personal AI Runtime、ADP 应用注册、ADP UI、PostgreSQL、MultiCA 状态。

---

## 6. 停止服务

```bash
bash scripts/local/stop-local.sh
```

`stop-local.sh` 只停止 **cwd 位于本项目或 ADP 目录**、且监听 8790/8000/5174/5433 的进程，
不会按端口盲杀其它程序。

---

## 7. 故障排查

### 7.1 ADP 打不开 / 白屏

1. `curl --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:5174/` 应为 200。
2. 若 `/src/main.ts` 返回 500，检查是否漏了组件库构建：
   `client/packages/adp-chat-component` 下执行 `npm run build`，确认存在
   `dist/es/adp-chat-component.css`。
3. 查看 Vite 日志：`data/logs/adp-client.log`。

### 7.2 ADP 后端启动即退出 / 报 `database "xxx" does not exist`

ADP 迁移会先连「用户名同名库」再建 `adp_chat`。按 4.1 节创建引导库后重启。

### 7.3 ADP 能打开但发消息报错

1. `curl --noproxy '*' -X POST http://127.0.0.1:8790/v1/personal-ai/chat/completions ...` 直连 Gateway 是否正常。
2. 检查 `APP_CONFIGS.BaseUrl` 是否写成 `http://127.0.0.1:8790/v1/personal-ai`（含 `/v1/`）。
3. 检查 `ApiKey` 是否为 Gateway Key（`dev-key-developer`），不是模型 Key。
4. 查看 `data/logs/adp-server.log` 中的上游 HTTP 状态。

### 7.4 Gateway 无法调用模型

1. `curl` 直连模型端点（第 3 节）验证 Base URL/Key/模型名。
2. 确认 `MOCK_UPSTREAM=false`，`/health` 的 `upstream.mode` 为 `remote`。
3. 若上游不支持 `response_format: json_object`，提取器会自动重试纯提示词模式（日志可见），不影响主对话。

### 7.5 记忆没有注入

1. 确认记忆存在：`sqlite3 data/memory.db "SELECT memory_id,user_id,substr(content,1,40) FROM memories;"`
2. 查看 Gateway 日志中该请求是否 `memory=on`（`memory=off` 表示未命中相关记忆）。
3. 用不同 user 做对照：另一个 user 不应看到同一记忆。

### 7.6 MultiCA 无法创建任务

1. `multica auth status` 必须为已登录（`multica setup cloud` 会打开浏览器 OAuth）。
2. `multica daemon status` 必须为 running（`multica daemon start`）。
3. `MULTICA_ENABLED=true`、`MULTICA_CLI_PATH=multica`，重启 Gateway。
4. 先手动验证：`multica issue create --title "smoke" --description "test" --output json`。

### 7.7 端口冲突

| 端口 | 用途 | 处理 |
|---|---|---|
| 8790 | Gateway | 改 `.env` 的 `PORT` |
| 8000 | ADP 后端 | 改 `SERVER_HTTP_PORT` 与 `SERVICE_API_URL` |
| 5174 | ADP 前端 | Vite `--port` |
| 5433 | PostgreSQL | `PG_PORT` |
| 8787 | 本机模型代理 | **不要占用**，Gateway 用 8790 |

---

## 8. 本机部署的已知限制

1. **Gateway 默认监听所有网卡**（`app.listen(port)`），仅建议在本机/可信网络使用；如需收紧请加防火墙规则。
2. 内嵌 PostgreSQL 为单机单实例，无备份策略；生产请换正式 PostgreSQL。
3. ADP 要求 `AUTO_CREATE_ACCOUNT=true` 才能免登录体验，这会允许匿名创建账号，**仅限本机**。
4. MultiCA 真实执行需要浏览器 OAuth 登录，无法在纯命令行内自动完成。
5. `data/pg-node`、`data/pgdata`、`.env`、ADP 的 `server/.env` 均不应提交到版本库。
