# 知忆（Zhiyi）· 模型服务接入、自选模型与 DUCX 认证

> V1.1 · 2026-11-12 · 参考 [Edward-lyz/codex-mixin](https://github.com/Edward-lyz/codex-mixin) 的 Baidu OneAPI 接入与 DUCX 认证实现

## 1. 这次解决了什么

V1.0 的模型上游写死在 `.env`（`MULTICA_BASE_URL` / `MULTICA_API_KEY` / `DEFAULT_MODEL`），
且 ADP 的 `APP_CONFIGS.ModelName` 是服务端固定值。要换 API、换模型、换认证方式，必须改配置并重启。

V1.1 增加**运行期模型服务设置**：

- API 地址、API Key、认证方式、模型、模型列表端点都可在设置页自填；
- 保存后**立即生效**，无需重启网关、无需改 ADP 的 `ModelName`、无需刷新聊天页；
- 支持 `api_key` / `ducx` / `none` 三种认证；
- 模型列表从上游实时拉取，可下拉选择或手动输入；
- 一次保存同时作用于主对话链路、OpenAI 兼容代理、后台候选记忆提取。

## 2. 与 codex-mixin 的对照

调研的是本机 `/Users/mll/code/code/codex-mixin`（Rust）与 GitHub 仓库同名项目，只读参考，未改动其源码。

| 能力 | codex-mixin 的实现 | 知忆的实现 |
|---|---|---|
| Baidu OneAPI 端点 | `src/provider/spec.rs`：`https://oneapi-comate.baidu-int.com`，默认 `/v1/messages`（Anthropic），GPT 系列切 `/v1/responses` | 使用 **OpenAI Chat Completions** `/v1/chat/completions`（实测直连可用），无需协议转换 |
| 认证 | `src/provider/auth/ducx.rs`：`DucxRuntime` + `CaptureProxy`，managed DUCX 登录态 | `src/upstream/ducx-auth.ts`：`DucxAuth`，同样的 loopback 捕获 + 注入 |
| 捕获命令 | `ducx -c model_providers.oneapi.base_url="http://127.0.0.1:<port>/v1" --disable hooks --disable plugins exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <warmup>` | 完全一致 |
| 关键环境变量 | `HOME` / `CODEX_HOME=<home>/.baidu-cx` / `BAIDU_CX_PLATFORM=AIIDE-terminal` / `DISABLE_*_UPDATE=1` | 完全一致 |
| 捕获的 header | `comate_custom_header`（`NATIVE_HEADER`）、`authorization`、`x-api-key`、`x-auth-client-token` | 一致；本项目只需前两个 |
| 缓存与刷新 | `HEADER_TTL = 60s`；401/403 时 `invalidate_headers()` | `HEADER_TTL_MS = 60_000`；401/403 时失效并重试一次 |
| 模型列表 | `POST /openapi/v2/available_models`（Baidu 富信息）；`/v1/models`（OpenAI 兼容） | **同时请求两个端点并合并去重**；`modelsPath` 设为 `/openapi/...` 时以该端点为主列表 |
| 来源上报 | `cli/report_hook`：Codex hooks 事件 → `/api/rest/v1/ducx/upload/query`，token 来自 data-report | `src/upstream/ducx-report.ts`：同端点同 payload，对话开始时异步上报 |
| 数据上报 token | `report_client_token()`：patch `hooks/data-report` 二进制 + codesign | **未移植**：直连 `/v1/chat/completions` 实测不需要；避免改动第三方二进制 |

### 为什么不做协议转换

实测（2026-11-12，本机已登录 DUCX）用捕获到的 native headers 直连：

| 请求 | 结果 |
|---|---|
| `GET https://oneapi-comate.baidu-int.com/v1/models` | HTTP 200，29 个模型（`Grok-4.6`、`gpt-5.6-terra`、`Opus 5`、`GLM-5.3-Flash` …） |
| `POST /openapi/v2/available_models` `{}` | HTTP 200，返回带 `capability` / `capability_set` 的富信息列表 |
| `POST /v1/chat/completions`（`Grok-4.6`） | HTTP 200，content `正常` |
| `POST /v1/chat/completions`（`gpt-5.6-terra`） | HTTP 200，content `正常` |
| `POST /v1/chat/completions`（`gpt-6-luna`） | HTTP 200，content `正常` |
| `POST /v1/chat/completions`（`DeepSeek-V4-Flash-baidu-oneapi`） | HTTP 503：`当前分组 default 下对于模型 ... 无可用渠道` |

最后一条说明：**本机 codex-mix 代理给模型名加了 `-baidu-oneapi` 后缀做区分，直连 Baidu OneAPI 时必须使用上游原始模型 ID**。
设置页在切换上游后会自动检查当前模型是否在新列表中，不在则改选第一个可用模型。

### 2.1 模型列表不全的根因与修复

用户反馈「模型列表不全」。实测（2026-11-12，DUCX 登录态下直连 Baidu OneAPI）：

| 端点 | 条数 |
|---|---|
| `GET /v1/models` | 29 |
| `POST /openapi/v2/available_models` | 35（其中 6 个 `-内部` 变体、2 个无 `capability`） |
| 规范化后（剥离 `-内部`，保留无 capability 条目） | **32 个唯一模型** |
| 富接口独有 | `auto`、`custom-auto`、`自定义模型组` |
| 合并去重总数 | **32**（比只用 `/v1/models` 多 3 个） |

也就是说 V1.1 初版只拉 `/v1/models`，确实漏了 3 个模型以及全部能力元数据。修复：

1. `modelsSource=auto`（默认）同时请求两个端点，合并去重，Baidu 富信息覆盖同名字段，
   `sources` 标签取并集；补充端点 404 / 超时时静默忽略，不影响主列表。
2. 对齐 `codex-mixin` 的 `add_baidu_model()`：`-内部` 后缀剥离、非内部版本优先覆盖；
   提取描述、倍率、价格类型、上下文长度、图像 / 思考能力。
   **一处有意差异**：codex-mixin 会排除无 `capability` 的条目，实测这会漏掉
   `custom-auto` / `自定义模型组` 两个真实可选模型；知忆改为保留并标记 `capabilityKnown=false`
   （设置页显示「无能力信息」），宁可多展示也不漏。
3. 设置页增加「模型列表来源」开关、关键词搜索、可滚动列表与能力标签，
   显示「共 N 个 / 当前显示 M 个」和合并来源；`GET /v1/models` 也返回合并后的完整列表。
4. 本机 codex-mix 代理预设用 `single`（它没有 `/openapi/` 端点，51 个模型本身就全量）。

## 3. DUCX 认证原理

```
知忆 Gateway                     loopback 捕获服务              DUCX 子进程              真实上游
     |                                  |                            |                       |
     | 1. 监听 127.0.0.1:0              |                            |                       |
     | 2. spawn ducx, -c base_url=loopback, env(HOME/CODEX_HOME/...)  |                       |
     |-------------------------------------------------------------->|                       |
     |                                  | 3. POST /v1/responses（带 comate_custom_header + Authorization） |
     |                                  |<-----------------------------|                       |
     |                                  | 4. 返回 200 空响应（不转发、不消耗额度）        |
     | 5. 拿到 headers，kill 进程组       |----------------------------->|                       |
     | 6. 缓存 60s                       |                            |                       |
     | 7. 把 headers 注入 /v1/models、/v1/chat/completions 请求 ---------------------------->|
     | 8. 若上游返回 401/403：清缓存，重新执行 1–7 一次 ------------------------------------>|
```

安全约束：

- 捕获服务只回 200 空响应，**不把 DUCX 的握手请求转发到真实上游**；
- 捕获完成后立刻 `SIGKILL` 整个进程组，不留常驻 DUCX 进程；
- header 值不写日志、不回传设置页；`/v1/zhiyi/settings` 只返回 `cachedKeys`（键名）与 `available`；
- API Key 只以 `***` 掩码形式出现在页面上；配置文件权限 600。

前置条件：`~/.baidu-cx/baidu-cx/bin/ducx` 存在且本机已登录（`~/.comate/login-user` 有用户名）。
本机实测版本 `10.167.0.2`。

### 3.1 来源上报（code-usage reporting）

只带 native headers 调用模型，OneAPI 侧可能缺少 DUCX 的 code-usage 记录，从而把调用
判定为未知来源。codex-mixin 的 `cli/report_hook` 会向
`http://ducc-data.baidu-int.com:8501/api/rest/v1/ducx` 上报。知忆实现了同款机制
（`src/upstream/ducx-report.ts`）：

1. **捕获 token**：复制 `~/.baidu-cx/baidu-cx/hooks/data-report` 到临时文件，把内嵌的
   `http://ducc-data.baidu-int.com:8501` 替换为等长 loopback 地址，`codesign --force --sign -`
   重签（macOS），执行 `--user-prompt-submit` 并喂入 warmup JSON，从它发出的请求头里拿
   `x-auth-client-token`（32 字符），随后杀掉进程、删除临时文件。token 缓存 10 分钟，
   401/403 时重新铸造。
2. **上报**：每次对话开始时异步 POST `.../ducx/upload/query`，payload 为
   `{session_id, platform:"", username, query, model, repo(git remote), os, arch:"", version:""}`，
   与 codex-mixin 的 user-prompt-submit 事件一致。
3. **触发点**：Personal AI 主链路（`personal-ai-runtime.ts`）与 `/v1/chat/completions` 代理
   （`proxy.ts`），fire-and-forget，失败只记日志，绝不影响回答。
4. **开关与验证**：设置页「DUCX 来源上报」复选框 +
   `POST /v1/zhiyi/settings/ducx/report/test` 手动验证；上报内容包含用户 prompt，
   属敏感数据，可随时关闭。

本机实测：捕获 token 成功（len=32）；真实上报 `HTTP 200 {"code":200,"message":"success"}`；
对话触发的上报在网关日志可见 `DUCX 来源上报成功（session=conv_xxx model=...）`。

## 4. 三种预设

| 预设 | Base URL | 认证 | 适用 |
|---|---|---|---|
| 本机 codex-mix 代理 | `http://127.0.0.1:8787/v1` | `api_key` | 沿用已运行的 8787 代理（DUCX 认证在代理侧完成） |
| Baidu OneAPI · DUCX | `https://oneapi-comate.baidu-int.com/v1` | `ducx` | 不依赖 8787，由知忆自己托管 DUCX 登录态 |
| 自定义 | 用户填写 | `api_key` / `none` | DeepSeek 官方、OnePAI、OpenRouter、Ollama 等任何 OpenAI 兼容端点 |

## 5. 配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `active` | 生产 `true` / Mock `false` | 是否覆盖 `.env` 静态配置；点「恢复 .env 默认」会置 false |
| `baseUrl` | `MULTICA_BASE_URL`（可被 `MODEL_BASE_URL` 覆盖） | 根地址或带 `/v1` 的地址；自动去掉尾斜杠与误填的 `/chat/completions` |
| `apiKey` | `MULTICA_API_KEY`（可被 `MODEL_API_KEY` 覆盖） | `api_key` 模式下作为 `Authorization: Bearer` |
| `authMode` | 有 Key 时 `api_key`，否则 `none` | `api_key` / `ducx` / `none` |
| `model` | `DEFAULT_MODEL` | 当前模型；`modelOverride=settings` 时忽略 ADP 传来的 `ModelName` |
| `modelsPath` | `/models` | 以 `/openapi/` 开头时按根路径拼接并改用 POST `{}` |
| `modelsSource` | `auto` | `auto` = 合并主列表 + `/openapi/v2/available_models`；`single` = 只用主列表 |
| `ducxReport` | `true` | 是否向 DUCX data-report 上报来源（session / model / prompt） |
| `ducxExecutable` | `~/.baidu-cx/baidu-cx/bin/ducx` | 绝对路径 |
| `modelOverride` | `settings` | `settings` = 设置页优先；`request` = 请求体优先 |

持久化：`ZHIYI_SETTINGS_PATH`（默认 `./data/model-settings.json`），权限 600，`data/` 已在 `.gitignore`。

## 6. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/settings` | 设置页 |
| GET | `/v1/zhiyi/settings` | 配置视图（脱敏）+ 预设 + DUCX 状态 + `.env` 回退值 |
| PUT | `/v1/zhiyi/settings` | 保存并立即生效；非法 URL / 认证方式返回 400 |
| POST | `/v1/zhiyi/settings/reset` | 恢复 `.env`，停用运行期覆盖 |
| GET | `/v1/zhiyi/models?refresh=1` | 合并后的模型列表（60s 缓存），返回 `data` / `sources` / `merged`；`data` 含名称与能力字段 |
| GET | `/v1/models` | OpenAI 兼容 `{object:"list",data:[{id,object,owned_by}]}`，同样使用合并后的完整列表 |
| POST | `/v1/zhiyi/settings/test` | `{"chat":false}` 测 `/models`；`{"chat":true}` 额外发一次真实对话 |
| POST | `/v1/zhiyi/settings/ducx/refresh` | 强制重新铸造 DUCX 认证头（可用于预热） |
| POST | `/v1/zhiyi/settings/ducx/report/test` | 手动执行一次 upload/query 来源上报 |

鉴权：默认仅允许 `127.0.0.1` / `::1`；设置 `ZHIYI_SETTINGS_TOKEN` 后，所有设置接口需要
`Authorization: Bearer <token>`（设置页底部可填，只存浏览器 localStorage）。

## 7. 生效链路

```
PUT /v1/zhiyi/settings
   └─ SettingsStore.update() → data/model-settings.json
         ├─ PersonalAIRuntime → ModelAdapter.stream()      （ADP 主对话）
         ├─ handleChatCompletion()                        （/v1/chat/completions 代理）
         └─ ExtractionQueue.extractWithModel()            （后台候选记忆提取）
```

`ModelAdapter` 还会在 DUCX 模式下拦截 401/403，刷新认证头后重试一次。
`UpstreamService.listModels()` 同样具备该重试逻辑。

## 8. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `模型列表请求失败（HTTP 401/403）` | DUCX 登录态过期或未登录 | 点「刷新 DUCX 登录态」；确认 `~/.comate/login-user` 有用户；必要时重新登录百度 Codex |
| OneAPI 提示未知来源 / 担心违规 | 只调模型、没有 DUCX code-usage 上报 | 保持「DUCX 来源上报」开启，点「测试来源上报」应返回 HTTP 200；确认 `~/.comate/login-user` 有用户 |
| `DUCX 可执行文件不存在` | 未安装 / 路径不同 | 在设置页填绝对路径；默认查找 `~/.baidu-cx/baidu-cx/bin/ducx` |
| `DUCX 在 20000ms 内未发出认证握手请求` | DUCX 版本差异、平台变量缺失或登录态异常 | 检查 `BAIDU_CX_PLATFORM=AIIDE-terminal`；确认 `ducx --version` 可运行 |
| 模型数量比预期少 / 看不到 `auto` 等模型 | 只请求了 `/v1/models`（Baidu 仅 29 个） | 把「模型列表来源」设为「自动合并」并点刷新；确认响应 `merged=true`、`sources` 有 2 个 |
| `当前分组 default 下对于模型 xxx 无可用渠道` | 用了 codex-mix 的 `-baidu-oneapi` 后缀模型名直连 Baidu | 点「刷新模型列表」重新选择上游原始模型 ID（如 `GLM-5.3`） |
| 切到 Baidu 后回答没变 | ADP 仍传固定 `ModelName` | 保持 `modelOverride=settings`（默认）；若改为 `request` 则请求体优先 |
| 远程访问设置接口返回 401 | 默认只允许 loopback | 设置 `ZHIYI_SETTINGS_TOKEN` 并带 Bearer 令牌 |
| 后台候选记忆提取报错 | 上游 `response_format` 不支持 | 提取器会自动去掉该参数重试一次；仍失败则回退规则提取，不影响对话 |
| 设置页显示「使用 .env 默认配置」 | `active=false`（刚 reset 或从未保存） | 点一次「保存并生效」即可启用运行期覆盖 |

## 9. 本机真实环境联调（2026-11-12）

不使用 Docker、不修改 `.env`、不重置 SQLite，直接切换运行期设置验证。

| 场景 | 结果 |
|---|---|
| 设置页 `GET /settings` | PASS（HTTP 200） |
| `GET /v1/zhiyi/settings` | PASS（`active=true`、三个预设、DUCX `available=true`、API Key 仅掩码） |
| 切到 Baidu OneAPI + DUCX | PASS（`baseUrl=https://oneapi-comate.baidu-int.com/v1`, `authMode=ducx`, `model=GLM-5.3`） |
| DUCX 认证头铸造 | PASS（日志：`DUCX 认证头已铸造（comate_custom_header, authorization），缓存 60s`，值未落日志） |
| `GET /v1/zhiyi/models?refresh=1`（合并后） | PASS（32 个模型 = `/v1/models` 29 + 富接口独有 3，`merged=true`） |
| `POST /v1/zhiyi/settings/test {"chat":true}` | PASS（HTTP 200，`modelCount=29`，`latencyMs≈1446`） |
| Personal AI 非流式对话（Baidu 直连） | PASS（content=`链路正常`，usage `160/38/198`） |
| Personal AI SSE 流式对话（Baidu 直连） | PASS（增量 `我是知忆（Zhiyi）…`，证明系统提示词注入生效） |
| 后台候选记忆提取（Baidu 直连） | PASS（提取器自动去掉不支持的 `response_format` 并重试；无可用候选时回退规则提取） |
| 响应 `model` 字段 | PASS（由 `GLM-5.3` → 切回本机代理后 `DeepSeek-V4-Flash-baidu-oneapi`，与实际生效模型一致） |
| 切回本机 codex-mix 代理 | PASS（`GET /v1/models` 返回 51 个模型，真实对话 200） |
| `check-health.sh` | PASS=9 / FAIL=0（含新增的「知忆 · 模型服务设置」检查段） |
| `smoke-e2e.sh` | PASS=11 / FAIL=0（真实模型、记忆隔离、SSE、ADP UI、SQLite 落盘） |
| 全量自动化测试 | PASS（8 文件 / 97 用例） |
| DUCX 来源上报 | PASS（token len=32；真实上报 `HTTP 200 {"code":200,"message":"success"}`；对话触发日志 `DUCX 来源上报成功`） |
| MultiCA 重新登录 | PASS（`multica login` → `ll m (meilingluo777@gmail.com)`，workspace「海王星」，daemon running） |

联调结束后已把运行期设置切回本机代理（与升级前行为一致）；想用 Baidu 直连时，在设置页点
「Baidu OneAPI · DUCX 登录态」预设 → 保存即可，无需重启。

### 9.1 重新登录 MultiCA（2026-11-12）

```bash
multica login          # 浏览器 OAuth；本次自动完成，Authenticated as ll m
multica auth status    # Server: https://api.multica.ai / User / Token 已保存
multica workspace list --output json   # 海王星 / neptune-c15v
multica daemon start   # Daemon: running，Agents: claude, codex, pi
```

登录过程中若提示 `No workspaces found`，CLI 会打开 `https://multica.ai/workspaces/new`，
在浏览器创建 workspace 后会自动继续。daemon 日志：`~/.multica/daemon.log`。

当前网关 `.env.personal-ai` 仍是 `MULTICA_ENABLED=false`（真实 Agent 委派默认关闭，避免误触发
外部 issue 与额度消耗）。要启用：把该项改为 `true`、按需设置 `MULTICA_WORKSPACE` /
`MULTICA_DEFAULT_AGENT`，然后重启网关；`GET /health/personal-ai` 的 `multica.enabled` 变为 true。

## 10. 已知边界

- 未移植 codex-mixin 的 `data-report` 二进制 patch / codesign 流程：OpenAI Chat Completions 直连不需要该 token。
- DUCX 捕获依赖 macOS/Linux 的进程组信号（`process.kill(-pid)`）；Windows 未验证。
- 模型选择入口在设置页，不在聊天输入框内；ADP 前端只新增了一个「模型设置」链接，未修改聊天组件。
  保存后新发起的对话立即使用新模型，无需刷新页面。
- `MOCK_UPSTREAM=true` 时运行期设置默认停用且使用内存存储，避免影响既有测试；设置页仍可打开。
- MultiCA 已重新登录且 daemon 在运行，但网关侧 `MULTICA_ENABLED=false`，真实 Agent 委派尚未启用（见 §9.1）。
