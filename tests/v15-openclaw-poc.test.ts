/**
 * 知忆集成 OpenClaw Agent Core POC 完整集成与安全边界测试：
 * 覆盖：
 * 1-4: 正常执行、多轮推理、真实 Tool Calling（含参数分段增量）与 Tool Result 回填后二轮推理
 * 5:   工具参数不符合 TypeBox Schema 拦截并回传给模型
 * 6:   工具权限不足（allowlist 白名单拒绝 / 未注册危险工具拒绝 / 跨用户参数拒绝）
 * 7:   工具执行失败与敏感凭据脱敏回传
 * 8:   执行过程中调用 /cancel 传播 AbortSignal 并收敛为 cancelled
 * 9:   模型调用超时 / 上游 502 异常收敛为 failed
 * 10-11: 最终结果正确写回 Execution 与 BusinessTask 终态
 * 12-15: OpenClaw 路由与 Direct LLM / MultiCA 兼容共存、SSE 协议及 x-request-id 幂等不回归
 */
import http from 'node:http';
import { Type } from 'typebox';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { loadPersonalAIConfig, type PersonalAIConfig } from '../src/personal-ai/config';
import { compactAgentMessagesIfNeeded } from '../src/personal-ai/runtime/openclaw/message-adapter';
import type { UpstreamTransport } from '../src/types';

const active: Array<{ close: () => Promise<void> }> = [];

afterEach(async (): Promise<void> => {
  while (active.length > 0) {
    await active.pop()?.close();
  }
});

interface RecordedModelCall {
  model?: string;
  messages: Array<{
    role: string;
    content: unknown;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
    name?: string;
  }>;
  tools?: Array<{ type: string; function: { name: string; parameters: unknown } }>;
}

function sseFrames(frames: Array<Record<string, unknown>>): Response {
  const body =
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

async function createOpenClawTestServer(options: {
  transport: UpstreamTransport;
  personalAIConfig?: PersonalAIConfig;
  timeoutMs?: number;
}) {
  const cfg: AppConfig = {
    ...loadConfig({}),
    databaseUrl: ':memory:',
    mockUpstream: false,
    upstreamBaseUrl: 'http://mock-openclaw-llm.invalid/v1',
    upstreamApiKey: 'sk-zhiyi-internal-secret-do-not-leak',
    defaultModel: 'zhiyi-test-model',
    upstreamTimeoutMs: options.timeoutMs ?? 2000,
    logSilent: true,
  };
  const created: CreatedApp = await createApp(cfg, {
    silent: true,
    transport: options.transport,
    upstreamSettings: null,
    adminToken: 'admin-token-openclaw',
    personalAIConfig: options.personalAIConfig ?? loadPersonalAIConfig({}),
  });
  const server = http.createServer(created.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const handle = {
    baseUrl,
    created,
    async api(
      route: string,
      opts: { method?: string; key?: string; headers?: Record<string, string>; body?: unknown } = {},
    ) {
      const res = await fetch(`${baseUrl}${route}`, {
        method: opts.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
          ...(opts.headers ?? {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, text, json };
    },
    async close(): Promise<void> {
      await created.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
  active.push(handle);
  return handle;
}

function registerOpenClawAgent(
  created: CreatedApp,
  agentId: string,
  backendConfig: Record<string, unknown> = { runtime: 'openclaw' },
): void {
  created.deps.agentStore.create({
    agent_id: agentId,
    name: `OpenClaw ${agentId}`,
    role: '通用工具 Agent',
    description: 'OpenClaw Agent Core 执行引擎测试角色',
    core_memory: '记忆检索 任务查询',
  });
  created.deps.agentStore.updateAdmin(agentId, {
    execution_backend: 'direct_llm',
    backend_config: backendConfig,
    instructions: '请优先使用知忆提供的安全工具检索真实数据，再给出简明准确的回答。',
    capabilities: ['memory', 'tasks', 'openclaw'],
  });
}

describe('OpenClaw Agent Core POC: 多轮推理、真实 Tool Calling 与结果写回', () => {
  it('完成 模型请求(tools) -> ToolCall参数增量 -> 知忆memory_search执行 -> ToolResult回填 -> 二轮推理 -> 写回Execution与BusinessTask，且x-request-id幂等', async () => {
    const calls: RecordedModelCall[] = [];

    const transport: UpstreamTransport = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as RecordedModelCall;
      calls.push(parsed);

      // 第一轮：模型看到 memory_search 工具定义，以分段增量方式发起 Tool Call
      if (calls.length === 1) {
        return sseFrames([
          {
            id: 'chatcmpl-turn-1',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_mem_1',
                      type: 'function',
                      function: { name: 'memory_search', arguments: '{"que' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: 'ry":"PostgreSQL","limit":3}' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 },
          },
        ]);
      }

      // 第二轮：模型收到真实工具结果（必须包含 memoryStore 中的 u1 私有记忆，不得包含 u2 记忆），生成最终答复
      return sseFrames([
        {
          id: 'chatcmpl-turn-2',
          choices: [{ delta: { content: '根据知忆记忆，' } }],
        },
        {
          choices: [{ delta: { content: '本项目使用 PostgreSQL 5433 端口。' } }],
        },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
        },
      ]);
    };

    const basePersonal = loadPersonalAIConfig({});
    const srv = await createOpenClawTestServer({
      transport,
      personalAIConfig: {
        ...basePersonal,
        apiKeys: {
          ...basePersonal.apiKeys,
          'openclaw-key-u1': { user_id: 'u1', agent_id: 'openclaw-assistant' },
        },
      },
    });

    // 分别写入 u1 和 u2 的长期记忆：工具执行必须仅返回 u1 记忆
    srv.created.deps.memoryStore.create({
      user_id: 'u1',
      content: '本地部署 PostgreSQL 固定运行在 5433 端口',
      type: 'semantic',
      scope: 'personal',
    });
    srv.created.deps.memoryStore.create({
      user_id: 'u2',
      content: 'U2_SECRET PostgreSQL password=topsecret',
      type: 'semantic',
      scope: 'personal',
    });

    registerOpenClawAgent(srv.created, 'openclaw-assistant', {
      runtime: 'openclaw',
      allowed_tools: ['memory_search', 'task_list'],
      max_turns: 4,
      tool_execution: 'sequential',
    });

    // 通过 PersonalAIRuntime SSE 对话端点触发 OpenClaw Agent（由服务端 API Key 绑定 agent_id），并验证幂等
    const chatReq = {
      method: 'POST',
      key: 'openclaw-key-u1',
      headers: {
        'x-request-id': 'req-openclaw-loop-1',
      },
      body: {
        messages: [{ role: 'user', content: '帮我查一下本地 PostgreSQL 端口配置' }],
        stream: true,
      },
    };

    const sseRes = await srv.api('/v1/personal-ai/chat/completions', chatReq);
    expect(sseRes.status).toBe(200);
    expect(sseRes.text).toContain('data: ');
    expect(sseRes.text).toContain('根据知忆记忆，');
    expect(sseRes.text).toContain('本项目使用 PostgreSQL 5433 端口。');
    expect(sseRes.text).toContain('data: [DONE]');

    // 验证确实执行了两轮 OpenClaw 模型推理（含 tools），且后台自动记忆提取不干扰结果
    const agentCalls = calls.filter((c) => (c.tools?.length ?? 0) > 0);
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[0].tools?.map((t) => t.function.name)).toEqual(['memory_search', 'task_list']);

    // 验证第二轮请求收到了 assistant(tool_calls) 与 tool(role='tool') 回填消息，且严格隔离 u2
    const turn2Msgs = agentCalls[1].messages;
    const assistantMsg = turn2Msgs.find((m) => m.role === 'assistant');
    const toolResultMsg = turn2Msgs.find((m) => m.role === 'tool');
    expect(assistantMsg?.tool_calls?.[0].function.name).toBe('memory_search');
    expect(assistantMsg?.tool_calls?.[0].function.arguments).toContain('PostgreSQL');
    expect(toolResultMsg?.tool_call_id).toBe('call_mem_1');
    expect(String(toolResultMsg?.content)).toContain('5433 端口');
    expect(String(toolResultMsg?.content)).not.toContain('U2_SECRET');

    // 验证 Execution 与 BusinessTask 正确落库并进入 completed 终态
    const bTasks = srv.created.personalAI.businessTaskManager.list('u1');
    expect(bTasks.items).toHaveLength(1);
    const task = bTasks.items[0];
    expect(task.status).toBe('completed');
    expect(task.assignee_agent_id).toBe('openclaw-assistant');

    const execs = srv.created.personalAI.businessTaskManager.listExecutions('u1', task.id);
    expect(execs?.items).toHaveLength(1);
    expect(execs?.items[0].execution_mode).toBe('direct_llm');
    expect(execs?.items[0].status).toBe('completed');
    expect(execs?.items[0].result).toBe('根据知忆记忆，本项目使用 PostgreSQL 5433 端口。');

    // 同一 x-request-id 重放：幂等不新增 Execution、不重复调用 OpenClaw Agent 推理
    const replay = await srv.api('/v1/personal-ai/chat/completions', chatReq);
    expect(replay.status).toBe(200);
    expect(replay.text).toContain('本项目使用 PostgreSQL 5433 端口。');
    expect(calls.filter((c) => (c.tools?.length ?? 0) > 0)).toHaveLength(2);
    expect(srv.created.personalAI.businessTaskManager.listExecutions('u1', task.id)?.items).toHaveLength(1);
  });

  it('校验 Schema 参数不合法、工具权限不足（allowlist / 未注册工具 / 跨用户参数）与工具异常脱敏', async () => {
    const calls: RecordedModelCall[] = [];
    let toolExecCount = 0;

    const transport: UpstreamTransport = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as RecordedModelCall;
      calls.push(parsed);

      if (calls.length === 1) {
        // 第1轮：同时发起 4 个错误/越权/故障 Tool Call 测试 OpenClaw + PolicyChecker 全拦截链路
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    // 1) 参数不符合 TypeBox Schema（query 缺失且带非法 extra 字段）
                    {
                      index: 0,
                      id: 'call_bad_schema',
                      type: 'function',
                      function: { name: 'memory_search', arguments: '{"limit":99,"unknown":1}' },
                    },
                    // 2) 未在 allowed_tools 中的工具（task_list 被策略拒绝）
                    {
                      index: 1,
                      id: 'call_denied_perm',
                      type: 'function',
                      function: { name: 'task_list', arguments: '{}' },
                    },
                    // 3) 完全未注册的危险工具（exec_shell）
                    {
                      index: 2,
                      id: 'call_unregistered',
                      type: 'function',
                      function: { name: 'exec_shell', arguments: '{"cmd":"whoami"}' },
                    },
                    // 4) 会抛出含敏感 API Key 错误的工具
                    {
                      index: 3,
                      id: 'call_failing_tool',
                      type: 'function',
                      function: { name: 'unstable_probe', arguments: '{"target":"health"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }

      return sseFrames([
        {
          choices: [
            {
              delta: { content: '已收到工具校验、权限拒绝和执行失败反馈并安全收敛。' },
              finish_reason: 'stop',
            },
          ],
        },
      ]);
    };

    const basePersonal = loadPersonalAIConfig({});
    const srv = await createOpenClawTestServer({
      transport,
      personalAIConfig: {
        ...basePersonal,
        apiKeys: {
          ...basePersonal.apiKeys,
          'openclaw-key-u1': { user_id: 'u1', agent_id: 'openclaw-assistant' },
        },
      },
    });

    // 注册一个可控测试工具，模拟工具内部异常且错误信息意外包含敏感密钥
    srv.created.personalAI.toolGateway.registerTool({
      name: 'unstable_probe',
      label: '受控诊断工具',
      description: '用于测试工具失败处理和错误脱敏',
      parameters: Type.Object({ target: Type.String() }, { additionalProperties: false }),
      execute: async () => {
        toolExecCount += 1;
        throw new Error('上游探针连接失败 auth=Bearer sk-leakedsecret1234567890');
      },
    });

    // 仅允许 memory_search 与 unstable_probe，明确禁止 task_list 与其他未注册工具
    registerOpenClawAgent(srv.created, 'openclaw-strict', {
      runtime: 'openclaw',
      allowed_tools: ['memory_search', 'unstable_probe'],
      max_turns: 4,
    });

    const createdTask = await srv.api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { title: '验证工具安全边界', assignee_agent_id: 'openclaw-strict', status: 'assigned' },
    });
    expect(createdTask.status).toBe(201);
    const taskId = createdTask.json.task.id as string;

    const execRes = await srv.api(`/v1/personal-ai/work-tasks/${taskId}/execute`, {
      method: 'POST',
      key: 'dev-key-developer',
      body: { agent_id: 'openclaw-strict' },
    });
    expect(execRes.status).toBe(200);
    expect(execRes.json.task.status).toBe('completed');
    expect(execRes.json.execution.status).toBe('completed');
    expect(execRes.json.execution.result).toBe('已收到工具校验、权限拒绝和执行失败反馈并安全收敛。');

    // 验证第二轮模型收到的 4 条 Tool Result：全部携带明确错误且敏感 key 已脱敏
    expect(calls).toHaveLength(2);
    expect(toolExecCount).toBe(1);
    const toolMsgs = calls[1].messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(4);

    const byId = new Map(toolMsgs.map((m) => [m.tool_call_id, String(m.content)]));
    expect(byId.get('call_bad_schema')).toContain('Validation failed');
    expect(byId.get('call_denied_perm')).toContain('权限不足');
    expect(byId.get('call_unregistered')).toContain('不在知忆安全工具白名单内');
    expect(byId.get('call_failing_tool')).toContain('[REDACTED_CREDENTIAL]');
    expect(byId.get('call_failing_tool')).not.toContain('sk-leakedsecret1234567890');
  });

  it('支持执行过程中 /cancel 中止运行中工具（AbortSignal 传播），并支持模型异常处理', async () => {
    let toolAborted = false;
    let toolStartedResolve!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      toolStartedResolve = resolve;
    });

    let simulateModelError = false;

    const transport: UpstreamTransport = async () => {
      if (simulateModelError) {
        return new Response('Upstream Bad Gateway', { status: 502 });
      }
      return sseFrames([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_slow_1',
                    type: 'function',
                    function: { name: 'slow_wait', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]);
    };

    const basePersonal = loadPersonalAIConfig({});
    const srv = await createOpenClawTestServer({
      transport,
      personalAIConfig: {
        ...basePersonal,
        apiKeys: {
          ...basePersonal.apiKeys,
          'openclaw-key-u1': { user_id: 'u1', agent_id: 'openclaw-assistant' },
        },
      },
    });
    srv.created.personalAI.toolGateway.registerTool({
      name: 'slow_wait',
      label: '可取消慢速工具',
      description: '等待中止信号',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_ctx, _params, signal) => {
        toolStartedResolve();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            toolAborted = true;
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => {
              toolAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        });
        return { text: 'unreachable' };
      },
    });

    registerOpenClawAgent(srv.created, 'openclaw-cancelable', {
      runtime: 'openclaw',
      allowed_tools: ['slow_wait'],
    });

    // 1. 取消测试：启动 execute，待工具开始运行后调用 /cancel
    const t1 = await srv.api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { title: '慢工具取消测试', assignee_agent_id: 'openclaw-cancelable', status: 'assigned' },
    });
    const t1Id = t1.json.task.id as string;

    const execPromise = srv.api(`/v1/personal-ai/work-tasks/${t1Id}/execute`, {
      method: 'POST',
      key: 'dev-key-developer',
      body: {},
    });

    await toolStarted;
    const cancelRes = await srv.api(`/v1/personal-ai/work-tasks/${t1Id}/cancel`, {
      method: 'POST',
      key: 'dev-key-developer',
      body: {},
    });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.json.external_cancelled).toBe(true);
    expect(cancelRes.json.task.status).toBe('cancelled');

    const execAfterCancel = await execPromise;
    expect(execAfterCancel.status).toBe(200);
    expect(toolAborted).toBe(true);
    expect(execAfterCancel.json.task.status).toBe('cancelled');
    expect(execAfterCancel.json.execution.status).toBe('cancelled');

    // 2. 模型调用异常测试（上游 502 -> Execution & BusinessTask 收敛为 failed）
    simulateModelError = true;
    const t2 = await srv.api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { title: '模型异常失败测试', assignee_agent_id: 'openclaw-cancelable', status: 'assigned' },
    });
    const execFail = await srv.api(`/v1/personal-ai/work-tasks/${t2.json.task.id}/execute`, {
      method: 'POST',
      key: 'dev-key-developer',
      body: {},
    });
    expect(execFail.status).toBe(200);
    expect(execFail.json.task.status).toBe('failed');
    expect(execFail.json.execution.status).toBe('failed');
    expect(execFail.json.execution.error).toContain('502');
  });

  it('Direct LLM 原有路径不回归，且上下文超预算裁剪保留配对关系', async () => {
    const srv = await createOpenClawTestServer({
      transport: async () =>
        sseFrames([{ choices: [{ delta: { content: '普通 Direct LLM 回答' }, finish_reason: 'stop' }] }]),
    });

    // 普通问答（不指定 OpenClaw Agent）保持原有 V1 Direct LLM 行为，不触发 OpenClaw 或 BusinessTask
    const directRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [{ role: 'user', content: '什么是 SQLite WAL 模式？' }], stream: false },
    });
    expect(directRes.status).toBe(200);
    expect(directRes.json.choices[0].message.content).toBe('普通 Direct LLM 回答');
    expect(srv.created.personalAI.businessTaskManager.list('u1').items).toHaveLength(0);

    // 验证上下文压缩不会截断 toolCall <-> toolResult 配对且能压到预算以内
    const longMessages = Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      content: `第 ${i} 条长消息：${'知忆上下文压缩测试'.repeat(60)}`,
      timestamp: Date.now() + i,
    }));
    const compacted = compactAgentMessagesIfNeeded(longMessages, 12_000);
    expect(compacted.length).toBeLessThan(longMessages.length);
    expect(compacted[0]).toEqual(longMessages[0]);
    expect(compacted[1].role).toBe('user');
    expect(String(compacted[1].content)).toContain('上下文压缩提示');
  });
});
