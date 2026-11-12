/**
 * Personal AI Gateway V1 测试：单元 + API 集成 + 真实 HTTP E2E。
 *
 * 真实环境限制（已在交付文档标注）：
 * - 无 Docker / Go，ADP Chat Client UI 未实际启动 → 用协议级 E2E 代替；
 * - MultiCA CLI 已安装但未连接 server（No server configured）且 daemon stopped
 *   → 用 scripts/mock-multica-cli.mjs 验证 spawn / JSON / 轮询 / 取消全链路。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../src/db';
import { createLogger } from '../src/logger';
import {
  ADP_V2_EVENT_TYPES,
  createProtocolContext,
  encodeEvent,
} from '../src/personal-ai/adapters/protocol/adp-protocol-adapter';
import {
  createCliRunner,
  mapExternalStatus,
  MultiCAError,
  MulticaAdapter,
} from '../src/personal-ai/adapters/agent/multica-adapter';
import type { AgentExecutionAdapter, TaskStatus } from '../src/personal-ai/adapters/agent/agent-adapter';
import { loadPersonalAIConfig } from '../src/personal-ai/config';
import type { PersonalAIEvent } from '../src/personal-ai/events/event-types';
import {
  deriveConversationId,
  resolvePersonalAIIdentity,
} from '../src/personal-ai/identity/identity-manager';
import { planExecution } from '../src/personal-ai/runtime/execution-planner';
import { understandIntent } from '../src/personal-ai/runtime/intent-understanding';
import { TaskManager } from '../src/personal-ai/task/task-manager';
import { TaskRepository } from '../src/personal-ai/task/task-repository';
import { TaskWorker } from '../src/personal-ai/worker/task-worker';
import { createHarness, type Harness } from './helpers';

const STUB: string = path.resolve(process.cwd(), 'scripts/mock-multica-cli.mjs');
fs.chmodSync(STUB, 0o755);

const active: Harness[] = [];
let seq = 0;

function stubOptions(extra: Record<string, unknown> = {}) {
  seq += 1;
  // 文件名带 pid + 随机串：多个 vitest 进程并行跑同一文件时不会互相覆盖 stub 状态。
  const unique: string = `${process.pid}-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
  process.env.MULTICA_STUB_STATE = path.resolve(process.cwd(), `data/test-stub-${unique}.json`);
  return {
    personalAI: {
      multica: {
        enabled: true,
        cliPath: STUB,
        pollIntervalMs: 40,
        commandTimeoutMs: 4000,
        maxConcurrentTasks: 3,
        maxPolls: 20,
        defaultAgent: 'Codex',
        ...extra,
      },
    },
  };
}

/**
 * 「任务永远不完成」的 stub 场景：`issue runs` 恒返回 queued，
 * 任务会停在 running，用于验证取消/终态保护。
 */
function stuckOptions(streamMaxMs = 600): Record<string, unknown> {
  process.env.MULTICA_STUB_STUCK = '1';
  const base: { personalAI: Record<string, unknown> } = stubOptions({ pollIntervalMs: 60, maxPolls: 60 });
  return { personalAI: { ...base.personalAI, streamMaxMs } };
}

/** 可控 Promise：把异步窗口固定住，使竞态用例 100% 可复现（不依赖 sleep 计时）。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = (): void => undefined;
  const promise: Promise<T> = new Promise<T>((done): void => {
    resolve = done;
  });
  return { promise, resolve };
}

async function harness(
  overrides: Record<string, unknown> = {},
  personalAI: Record<string, unknown> = {},
): Promise<Harness> {
  const h: Harness = await createHarness(overrides, personalAI);
  active.push(h);
  return h;
}

afterEach(async (): Promise<void> => {
  delete process.env.MULTICA_STUB_SLEEP_MS;
  delete process.env.MULTICA_STUB_STUCK;
  for (const h of active.splice(0)) await h.close();
});

const USER_MESSAGE = { role: 'user', content: '解释一下 CAP 定理' };

describe('单元：协议适配、决策与安全', () => {
  it('openai 模式输出标准 chunk，进度降级为文本，结束为 [DONE]', () => {
    const ctx = createProtocolContext('openai', 'mock-gpt', 'conv_1');
    const events: PersonalAIEvent[] = [
      { type: 'message_start', conversationId: 'conv_1' },
      { type: 'text_delta', content: '你好' },
      { type: 'task_started', taskId: 'task_1' },
      { type: 'task_progress', taskId: 'task_1', status: 'running', message: 'daemon 已领取' },
      { type: 'agent_completed', taskId: 'task_1', agentId: 'Codex' },
      { type: 'message_end' },
    ];
    const text: string = events.flatMap((event) => encodeEvent(event, ctx)).join('');
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"你好"');
    expect(text).toContain('任务进度 running');
    expect(text).toContain('data: [DONE]');
    expect(text).not.toContain('"Type":"task_progress"'); // 不发未验证的自定义事件
    expect(ctx.accumulated).toContain('你好');
  });

  it('adp-v2 模式只输出源码枚举内的事件类型', () => {
    const ctx = createProtocolContext('adp-v2', 'mock-gpt', 'conv_1');
    const events: PersonalAIEvent[] = [
      { type: 'message_start', conversationId: 'conv_1' },
      { type: 'text_delta', content: '内容' },
      { type: 'task_progress', taskId: 't1', status: 'running' },
      { type: 'error', message: '示例错误' },
      { type: 'message_end' },
    ];
    const frames: string[] = events.flatMap((event) => encodeEvent(event, ctx));
    const types: string[] = frames
      .map((frame): string => frame.match(/"Type":"([^"]+)"/)?.[1] ?? '')
      .filter(Boolean);
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) expect(ADP_V2_EVENT_TYPES).toContain(type);
    expect(types).toContain('request_ack');
    expect(types).toContain('response.completed');
    expect(types).toContain('text.delta');
    expect(types).toContain('error');
    expect(frames.join('')).not.toContain('[DONE]'); // V2 以 response.completed 结束
  });

  it('意图识别与执行计划：可执行任务委派，普通问答直连，未启用 MultiCA 时降级', () => {
    const keywords = loadPersonalAIConfig({}).agentKeywords;
    const agent = understandIntent('帮我分析这个 Java 代码仓库的架构实现', keywords);
    expect(agent.mode).toBe('agent_delegation');
    expect(agent.matched.length).toBeGreaterThan(0);
    expect(understandIntent('解释一下 CAP 定理', keywords).mode).toBe('direct_llm');
    expect(understandIntent('你好', keywords).mode).toBe('direct_llm');

    const context = { messages: [], taskText: '分析代码仓库', hits: [], memoryInjected: false, systemMessage: '' };
    const off = loadPersonalAIConfig({});
    expect(planExecution(agent, context, off).mode).toBe('direct_llm');
    expect(planExecution(agent, context, off).reason).toContain('降级');
    const on = loadPersonalAIConfig({});
    on.multica.enabled = true;
    on.multica.defaultAgent = 'Codex';
    expect(planExecution(agent, context, on).mode).toBe('agent_delegation');
    expect(planExecution(agent, context, on).agentId).toBe('Codex');
  });

  it('MultiCA 状态映射覆盖 running / completed / failed / cancelled', () => {
    expect(mapExternalStatus('queued')).toBe('dispatching');
    expect(mapExternalStatus('running')).toBe('running');
    expect(mapExternalStatus('completed')).toBe('completed');
    expect(mapExternalStatus('failed')).toBe('failed');
    expect(mapExternalStatus('cancelled')).toBe('cancelled');
    expect(mapExternalStatus('unknown', 'done')).toBe('completed');
    // in_review = Agent 已交付、等待人工验收；对自动化委派视为完成。
    expect(mapExternalStatus('in_review')).toBe('completed');
    expect(mapExternalStatus('unknown', 'in_review')).toBe('completed');
  });

  it('getTaskStatus 在 --active 无活跃 run 时回退全量 runs，并把 in_review 视为完成', async () => {
    const calls: string[][] = [];
    const runner: CliRunner = {
      run: async (args: string[]): Promise<unknown> => {
        calls.push(args);
        if (args[1] === 'runs' && args.includes('--active')) return [];
        if (args[1] === 'runs') {
          return [{ id: 'run-1', status: 'completed', agent_id: 'agent-1' }];
        }
        if (args[1] === 'get') return { id: 'issue-1', status: 'in_review' };
        return {};
      },
    };
    const adapter = new MulticaAdapter(loadPersonalAIConfig({}).multica, runner, createLogger(true));
    const status: TaskStatus = await adapter.getTaskStatus('01JISSUE0000000000000000XX');
    expect(status.status).toBe('completed');
    expect(status.externalRunId).toBe('run-1');
    expect(calls.some((args) => args.includes('--active'))).toBe(true);
    expect(calls.some((args) => args[1] === 'runs' && !args.includes('--active'))).toBe(true);
  });

  it('conversation_id 由可信 user_id + 首条 user 文本稳定推导，且跨用户隔离', () => {
    const messages = [{ role: 'user', content: '帮我设计一个服务' }];
    const a = deriveConversationId('u1', messages);
    const b = deriveConversationId('u1', [...messages, { role: 'assistant', content: '好的' }, { role: 'user', content: '继续' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(deriveConversationId('u2', messages));
  });

  it('共享密钥启用后强制校验 HMAC 签名；身份不信任客户端字段', () => {
    const raw = JSON.stringify({ messages: [USER_MESSAGE], user_id: 'attacker', agent_id: 'admin' });
    const config = loadPersonalAIConfig({});
    config.sharedSecret = 'test-secret';
    const ts: string = String(Date.now());
    const signature: string = createHmac('sha256', 'test-secret').update(`${ts}.${raw}`).digest('hex');
    const ok = resolvePersonalAIIdentity(
      config,
      { authorization: 'Bearer dev-key-researcher', 'x-personalai-timestamp': ts, 'x-personalai-signature': signature },
      JSON.parse(raw),
      raw,
    );
    expect(ok.ok).toBe(true);
    expect(ok.identity?.user_id).toBe('u1');
    expect(ok.identity?.agent_id).toBe('researcher'); // 来自服务端 Key，而非 body
    expect(ok.identity?.signature_verified).toBe(true);

    const bad = resolvePersonalAIIdentity(config, { authorization: 'Bearer dev-key-developer' }, JSON.parse(raw), raw);
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(401);
  });

  it('任务仓储幂等 + 重启恢复 + 并发限制', async () => {
    const db: Database = Database.open(':memory:');
    db.migrate();
    const repo = new TaskRepository(db);
    const input = {
      user_id: 'u1',
      conversation_id: 'conv_1',
      request_id: 'req_same',
      execution_mode: 'agent_delegation' as const,
      input_summary: '任务',
    };
    const first = repo.create(input);
    const second = repo.create(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);

    for (let i = 0; i < 3; i += 1) {
      repo.create({ ...input, request_id: `req_${i}` });
    }
    repo.update(first.task.id, { status: 'dispatching' });
    expect(repo.recover()).toBeGreaterThan(0);

    const config = loadPersonalAIConfig({});
    const adapter: AgentExecutionAdapter = {
      createTask: async () => ({ externalTaskId: 'MUL-EXT', status: 'created' }),
      assignAgent: async () => undefined,
      getTaskStatus: async () => ({ status: 'running' }),
      getTaskResult: async () => ({ status: 'completed', content: 'ok' }),
    };
    const worker = new TaskWorker({
      config,
      multica: { ...config.multica, maxConcurrentTasks: 1 },
      repo,
      adapter,
      logger: createLogger(true),
    });
    await worker.tick();
    expect(repo.listActive(20).filter((task) => task.external_task_id)).toHaveLength(1);
    db.close();
  });

  it('CLI runner 使用 spawn 参数数组，能解析 JSON、处理异常退出与超时', async () => {
    const config = loadPersonalAIConfig({});
    const runner = createCliRunner(
      { ...config.multica, cliPath: STUB, cwd: process.cwd(), commandTimeoutMs: 4000 },
      createLogger(true),
    );
    const parsed = (await runner.run(['issue', 'create', '--title', 't', '--description', 'd', '--output', 'json'])) as { id: string };
    expect(parsed.id).toMatch(/^MUL-/);

    const failing = createCliRunner(
      { ...config.multica, cliPath: '/bin/false', commandTimeoutMs: 2000 },
      createLogger(true),
    );
    await expect(failing.run(['issue', 'list'])).rejects.toBeInstanceOf(MultiCAError);

    process.env.MULTICA_STUB_SLEEP_MS = '400';
    const slow = createCliRunner(
      { ...config.multica, cliPath: STUB, cwd: process.cwd(), commandTimeoutMs: 80 },
      createLogger(true),
    );
    await expect(slow.run(['daemon', 'status'])).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('API 集成 / E2E：Direct LLM 与记忆', () => {
  it('普通问答走 Direct LLM，SSE 流式可解析且以 [DONE] 结束', async () => {
    const h = await harness();
    const r = await h.stream('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [USER_MESSAGE], stream: true },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(r.text).toContain('data: {');
    expect(r.text).toContain('data: [DONE]');
    expect(r.text).toContain('"object":"chat.completion.chunk"');
  });

  it('stream:false 返回 OpenAI 兼容非流式 JSON', async () => {
    const h = await harness();
    const r = await h.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [USER_MESSAGE], stream: false },
    });
    expect(r.status).toBe(200);
    expect(r.json.object).toBe('chat.completion');
    expect(typeof r.json.choices[0].message.content).toBe('string');
    // usage 必须来自上游（stream_options.include_usage），不能是硬编码 0。
    expect(r.json.usage).toBeDefined();
    expect(r.json.usage.total_tokens).toBeGreaterThan(0);
    expect(r.json.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('stream:false 时上游错误返回对应 4xx/5xx 与错误体，而不是 200 + 正文', async () => {
    const h = await harness();
    await h.mockConfigure({ mode: 'error', status: 503, errorBody: { error: 'upstream down' } });
    const r = await h.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [USER_MESSAGE], stream: false },
    });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('upstream_error');
    expect(r.json.error.message).toContain('上游');
    expect(r.json.choices).toBeUndefined();
  });

  it('多轮对话（ADP 会带历史 messages）复用同一 conversation_id 并累计轮次', async () => {
    const h = await harness();
    const first = { role: 'user', content: '帮我设计一个服务' };
    await h.api('/v1/personal-ai/chat/completions', {
      method: 'POST', key: 'dev-key-developer', body: { messages: [first], stream: false },
    });
    await h.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [first, { role: 'assistant', content: '好的' }, { role: 'user', content: '继续说明' }], stream: false },
    });
    const rows = h.deps.db.all<{ turn_count: number }>(
      'SELECT turn_count FROM conversation_contexts WHERE user_id = ?',
      ['u1'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].turn_count).toBe(2);
  });

  it('ADP V2 直连端点输出的事件全部在源码枚举内', async () => {
    const h = await harness();
    const r = await h.stream('/v1/personal-ai/messages', {
      method: 'POST', key: 'dev-key-developer', body: { messages: [USER_MESSAGE] },
    });
    expect(r.status).toBe(200);
    // 只校验 SSE 帧「顶层」的 Type：payload 里还有合法的嵌套取值
    // （Message.Type = MessageType.REPLY = 'reply'，
    //   Contents[].Type = ContentType.TEXT = 'text'，见 interface.py:55-84），
    // 它们不是事件类型，不能被当成事件枚举校验。
    const payloads: unknown[] = r.text
      .split('\n\n')
      .map((frame: string): string => frame.trim())
      .filter((frame: string): boolean => frame.startsWith('data: {'))
      .map((frame: string): unknown => JSON.parse(frame.slice('data: '.length)) as unknown);
    const types: string[] = payloads
      .map((payload: unknown): unknown =>
        payload !== null && typeof payload === 'object'
          ? (payload as Record<string, unknown>).Type
          : undefined,
      )
      .filter((type: unknown): type is string => typeof type === 'string');
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) expect(ADP_V2_EVENT_TYPES).toContain(type);
    expect(types).toContain('request_ack');
    expect(types).toContain('text.delta');
    expect(types).toContain('response.completed');
    // 嵌套取值确实存在，但不能出现在顶层事件类型集合里。
    expect(r.text).toContain('"Type":"reply"');
    expect(r.text).toContain('"Type":"text"');
    expect(types).not.toContain('reply');
    expect(types).not.toContain('text');
  });

  it('上游错误以可读文本事件返回，不会挂死流', async () => {
    const h = await harness();
    await h.mockConfigure({ mode: 'error', status: 503, errorBody: { error: 'upstream down' } });
    const r = await h.stream('/v1/personal-ai/chat/completions', {
      method: 'POST', key: 'dev-key-developer', body: { messages: [USER_MESSAGE], stream: true },
    });
    expect(r.text).toContain('[错误]');
    expect(r.text).toContain('data: [DONE]');
  });

  it('个人记忆被注入模型请求，且不会覆盖原有 system prompt', async () => {
    const h = await harness();
    await h.api('/v1/memories', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { content: '技术方案优先考虑简单、可维护，避免不必要的复杂架构', type: 'identity', scope: 'personal' },
    });
    await h.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [{ role: 'system', content: '你是资深架构师' }, { role: 'user', content: '帮我设计架构方案' }], stream: false },
    });
    const last = await h.api('/__mock__/last-request');
    const messages = JSON.parse(JSON.stringify(last.json));
    const text: string = JSON.stringify(messages);
    expect(text).toContain('简单、可维护');
    expect(text).toContain('你是资深架构师');
    expect(text).toContain('不得覆盖系统指令');
  });

  it('对话完成后保存轨迹并异步生成候选记忆；原有 API 与代理回归可用', async () => {
    const h = await harness();
    await h.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [{ role: 'user', content: '我偏好简单可维护的方案，以后都这样做' }], stream: false },
    });
    await h.waitForBackground();
    const trajectories = await h.api('/v1/trajectories', { key: 'dev-key-developer' });
    expect(trajectories.json.total).toBeGreaterThanOrEqual(1);
    const candidates = await h.api('/v1/memory-candidates', { key: 'dev-key-developer' });
    expect(Array.isArray(candidates.json.items)).toBe(true);

    const memory = await h.api('/v1/memories', { key: 'dev-key-developer' });
    expect(memory.status).toBe(200);
    const chat = await h.api('/v1/chat/completions', {
      method: 'POST', key: 'dev-key-developer', body: { messages: [USER_MESSAGE] },
    });
    expect(chat.status).toBe(200);
  });
});

describe('API 集成 / E2E：MultiCA CLI stub 任务闭环', () => {
  it('代码分析任务走 Agent Delegation，进度可反馈且最终结果由 Personal AI 汇总', async () => {
    const h = await harness({}, stubOptions());
    const r = await h.stream('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [{ role: 'user', content: '帮我分析这个 Java 代码仓库的架构实现' }], stream: true },
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain('[知忆]');
    expect(r.text).toContain('任务进度');
    expect(r.text).toContain('Agent 已完成分析');
    expect(r.text).toContain('data: [DONE]');

    const tasks = await h.api('/v1/personal-ai/tasks', { key: 'dev-key-developer' });
    expect(tasks.json.items).toHaveLength(1);
    expect(tasks.json.items[0].status).toBe('completed');
    expect(tasks.json.items[0].external_task_id).toMatch(/^MUL-/);
  });

  it('同一 request_id 不会重复创建任务（幂等）', async () => {
    const h = await harness({}, stubOptions());
    const options = {
      method: 'POST',
      key: 'dev-key-developer',
      headers: { 'x-request-id': 'idempotent-req-1' },
      body: { messages: [{ role: 'user', content: '帮我重构这个代码仓库的模块' }], stream: false },
    };
    await h.api('/v1/personal-ai/chat/completions', options);
    await h.api('/v1/personal-ai/chat/completions', options);
    const tasks = await h.api('/v1/personal-ai/tasks', { key: 'dev-key-developer' });
    expect(tasks.json.items.filter((item: { request_id: string }) => item.request_id === 'idempotent-req-1')).toHaveLength(1);
  });

  it('不同用户的任务严格隔离，且可以取消未完成任务', async () => {
    const h = await harness({}, stubOptions());
    const created = h.personalAI.taskManager.createIfAbsent({
      user_id: 'u1',
      conversation_id: 'conv_a',
      request_id: 'req_a',
      agent_id: 'Codex',
      project_id: null,
      execution_mode: 'agent_delegation',
      input_summary: 'u1 的私有任务',
    });
    const u2read = await h.api(`/v1/personal-ai/tasks/${created.task.id}`, { key: 'dev-key-user2' });
    expect(u2read.status).toBe(404);
    const u2list = await h.api('/v1/personal-ai/tasks', { key: 'dev-key-user2' });
    expect(u2list.json.items).toHaveLength(0);

    const cancel = await h.api(`/v1/personal-ai/tasks/${created.task.id}/cancel`, {
      method: 'POST', key: 'dev-key-developer', body: {},
    });
    expect(cancel.status).toBe(200);
    expect(cancel.json.task.status).toBe('cancelled');
  });

  it('客户端断开后服务仍可用，后台任务继续持久化', async () => {
    process.env.MULTICA_STUB_SLEEP_MS = '150';
    const h = await harness({}, stubOptions({ pollIntervalMs: 60, commandTimeoutMs: 4000 }));
    const controller = new AbortController();
    const pending = fetch(`${h.baseUrl}/v1/personal-ai/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-key-developer' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '帮我排查代码仓库的故障' }], stream: true }),
      signal: controller.signal,
    }).catch((): undefined => undefined);
    setTimeout((): void => controller.abort(), 20);
    await pending;
    await new Promise((resolve): void => setTimeout(resolve, 500));
    const health = await h.api('/health');
    expect(health.status).toBe(200);
    const tasks = await h.api('/v1/personal-ai/tasks', { key: 'dev-key-developer' });
    expect(tasks.json.items.length).toBeGreaterThan(0);
  });

  it('PERSONAL_AI_ENABLED=false 时两个对话端点都返回 503（含 /messages 直连端点）', async () => {
    const h = await harness({}, { personalAI: { enabled: false } });
    const chat = await h.api('/v1/personal-ai/chat/completions', {
      method: 'POST', key: 'dev-key-developer', body: { messages: [USER_MESSAGE], stream: false },
    });
    expect(chat.status).toBe(503);
    expect(chat.json.error.message).toContain('PERSONAL_AI_ENABLED');
    const v2 = await h.api('/v1/personal-ai/messages', {
      method: 'POST', key: 'dev-key-developer', body: { messages: [USER_MESSAGE] },
    });
    expect(v2.status).toBe(503);
    expect(v2.json.error.message).toContain('PERSONAL_AI_ENABLED');
  });

  it('健康端点报告 Personal AI / Memory / MultiCA daemon 状态', async () => {
    const h = await harness({}, stubOptions());
    const r = await h.api('/health/personal-ai');
    expect(r.status).toBe(200);
    expect(r.json.personal_ai.enabled).toBe(true);
    expect(r.json.personal_ai.protocol).toBe('openai');
    expect(r.json.memory_core.db).toBe('ok');
    expect(r.json.multica.daemon.status).toBe('running');
    expect(r.json.multica.enabled).toBe(true);
  });
});

/**
 * 取消终态保护回归（P1）。
 *
 * 缺陷：Worker 的 pollOne()/dispatch() 在异步窗口之后无条件回写 status，
 * 会把用户写入的 cancelled 覆盖回 running（或改成 failed），导致取消不持久、
 * 重复取消返回 200 而非 409。修复方式见 ARCHITECTURE.md §9「终态保护」：
 * 所有回写走 `updateIfActive()`（`WHERE status IN (活动态)`），
 * 派发抢占走 `claimForDispatch()`（`WHERE status='pending'`）。
 */
describe('回归：取消终态保护（P1 竞态）', () => {
  it('取消后跨过至少 2 个轮询周期，REST 与数据库仍为 cancelled（含轮询在途窗口）', async () => {
    // 让每次 CLI 调用慢 1s：Worker 的 200ms 轮询几乎总处于
    // 「已快照 → 等 CLI 返回」的在途状态，这正是缺陷发生的时间窗
    //（旧实现会在 CLI 返回后把 cancelled 覆盖回 running）。
    process.env.MULTICA_STUB_SLEEP_MS = '1000';
    const h = await harness({}, stuckOptions(1500));
    const chat: Promise<{ status: number }> = h.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [{ role: 'user', content: '帮我分析这个 Java 代码仓库的架构实现' }], stream: false },
    });

    // 等 dispatch（issue create 1s）+ 至少一轮轮询进入在途状态
    await new Promise((resolve): void => setTimeout(resolve, 1300));
    const list = await h.api('/v1/personal-ai/tasks', { key: 'dev-key-developer' });
    const task = list.json.items[0];
    expect(['pending', 'dispatching', 'running']).toContain(task.status);

    const cancelled = await h.api(`/v1/personal-ai/tasks/${task.id}/cancel`, {
      method: 'POST', key: 'dev-key-developer', body: {},
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.task.status).toBe('cancelled');

    // 覆盖「在途轮询返回」的时刻（≥2 个轮询周期）：任何回写把状态改回 running 都会被这里抓到
    for (let i = 0; i < 14; i += 1) {
      await new Promise((resolve): void => setTimeout(resolve, 100));
      const current = await h.api(`/v1/personal-ai/tasks/${task.id}`, { key: 'dev-key-developer' });
      expect(current.json.status).toBe('cancelled');
    }

    const row = h.deps.db.get<{ status: string }>(
      'SELECT status FROM execution_tasks WHERE id = ?',
      [task.id],
    );
    expect(row?.status).toBe('cancelled');
    await chat; // 确保并发请求已收尾，避免影响后续用例
  });

  it('重复取消已取消的任务返回 409（原子流转，只有一次成功）', async () => {
    const h = await harness({}, stuckOptions(600));
    await h.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [{ role: 'user', content: '帮我重构这个代码仓库的日志模块' }], stream: false },
    });
    const list = await h.api('/v1/personal-ai/tasks', { key: 'dev-key-developer' });
    const taskId: string = list.json.items[0].id;

    const first = await h.api(`/v1/personal-ai/tasks/${taskId}/cancel`, {
      method: 'POST', key: 'dev-key-developer', body: {},
    });
    expect(first.status).toBe(200);
    const second = await h.api(`/v1/personal-ai/tasks/${taskId}/cancel`, {
      method: 'POST', key: 'dev-key-developer', body: {},
    });
    expect(second.status).toBe(409);
    expect(second.json.error.message).toContain('already_cancelled');
  });

  it('派发窗口内取消：createTask 返回后不得改回 running，并尽力回收外部 run', async () => {
    const db: Database = Database.open(':memory:');
    db.migrate();
    try {
      const repo = new TaskRepository(db);
      const manager = new TaskManager(repo);
      const created = repo.create({
        user_id: 'u1',
        conversation_id: 'conv_dispatch_race',
        request_id: 'req_dispatch_race',
        execution_mode: 'agent_delegation',
        input_summary: '派发窗口内被取消的任务',
      });

      const gate = deferred<{ externalTaskId: string; status: string }>();
      const entered = deferred<void>();
      const reclaimed: string[] = [];
      const adapter: AgentExecutionAdapter = {
        createTask: async () => {
          entered.resolve();
          return gate.promise;
        },
        assignAgent: async () => undefined,
        getTaskStatus: async () => ({ status: 'running' }),
        getTaskResult: async () => ({ status: 'completed', content: 'ok' }),
        cancelTask: async (externalTaskId: string): Promise<boolean> => {
          reclaimed.push(externalTaskId);
          return true;
        },
      };
      const base = loadPersonalAIConfig({});
      const worker = new TaskWorker({
        config: base,
        multica: { ...base.multica, maxConcurrentTasks: 3, maxPolls: 50 },
        repo,
        adapter,
        logger: createLogger(true),
      });

      const dispatching: Promise<void> = worker.dispatch(created.task.id);
      await entered.promise;
      expect(repo.get('u1', created.task.id)?.status).toBe('dispatching');

      // 用户此刻取消（createTask 还挂在 await 上）
      expect(manager.cancelForUser('u1', created.task.id).ok).toBe(true);
      expect(repo.get('u1', created.task.id)?.status).toBe('cancelled');

      gate.resolve({ externalTaskId: 'MUL-RACE-DISPATCH', status: 'created' });
      await dispatching;

      const after = repo.get('u1', created.task.id);
      expect(after?.status).toBe('cancelled'); // 未被改回 running
      expect(after?.external_task_id).toBe('MUL-RACE-DISPATCH'); // 仍记录外部 id 便于审计
      expect(reclaimed).toEqual(['MUL-RACE-DISPATCH']); // 尽力回收外部 run
    } finally {
      db.close();
    }
  });

  it('取消后即使达到轮询上限也不会被改成 failed', async () => {
    const db: Database = Database.open(':memory:');
    db.migrate();
    try {
      const repo = new TaskRepository(db);
      const manager = new TaskManager(repo);
      const created = repo.create({
        user_id: 'u1',
        conversation_id: 'conv_maxpoll_race',
        request_id: 'req_maxpoll_race',
        execution_mode: 'agent_delegation',
        input_summary: '轮询上限窗口内被取消的任务',
      });
      repo.update(created.task.id, { status: 'running', external_task_id: 'MUL-MAXPOLL-1' });
      // 先让 poll_count 达到上限（maxPolls = 1），使下一次轮询必走 failed 分支
      db.run('UPDATE execution_tasks SET poll_count = 5 WHERE id = ?', [created.task.id]);

      const gate = deferred<TaskStatus>();
      const entered = deferred<void>();
      const adapter: AgentExecutionAdapter = {
        createTask: async () => ({ externalTaskId: 'MUL-MAXPOLL-1', status: 'created' }),
        assignAgent: async () => undefined,
        getTaskStatus: async (): Promise<TaskStatus> => {
          entered.resolve();
          return gate.promise;
        },
        getTaskResult: async () => ({ status: 'completed', content: 'ok' }),
      };
      const base = loadPersonalAIConfig({});
      const worker = new TaskWorker({
        config: base,
        multica: { ...base.multica, maxConcurrentTasks: 3, maxPolls: 1 },
        repo,
        adapter,
        logger: createLogger(true),
      });

      const ticking: Promise<void> = worker.tick();
      await entered.promise;
      expect(manager.cancelForUser('u1', created.task.id).ok).toBe(true);

      gate.resolve({ status: 'running', rawStatus: 'running' });
      await ticking;

      expect(repo.get('u1', created.task.id)?.status).toBe('cancelled');
    } finally {
      db.close();
    }
  });
});
