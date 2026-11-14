/**
 * Step 5 测试：AgentSelector 选人与负载/Backend过滤、ContextBuilder 只读上下文增强、
 * PersonalAIRuntime（V1 规则默认兼容 + 可选单步 LLM 结构化意图 + 跨用户防护 + 降级回退）。
 */
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { loadPersonalAIConfig, type PersonalAIConfig } from '../src/personal-ai/config';
import { resolveMulticaAssignee } from '../src/personal-ai/runtime/agent-selector';
import { buildPersonalAIContext } from '../src/personal-ai/runtime/context-builder';
import type { UpstreamTransport } from '../src/types';
import { createHarness, type Harness } from './helpers';

const STUB_CLI: string = path.resolve(process.cwd(), 'scripts/mock-multica-cli.mjs');
const active: Array<{ close: () => Promise<void> }> = [];

afterEach(async (): Promise<void> => {
  while (active.length > 0) {
    await active.pop()?.close();
  }
});

function sseResponse(chunks: string[]): Response {
  const body =
    chunks
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
      .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface CustomServer {
  baseUrl: string;
  created: CreatedApp;
  api(
    route: string,
    opts?: { method?: string; key?: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<{ status: number; text: string; json: any }>;
  close(): Promise<void>;
}

async function createCustomAppServer(options: {
  transport: UpstreamTransport;
  personalAIConfig: PersonalAIConfig;
}): Promise<CustomServer> {
  const cfg: AppConfig = {
    ...loadConfig({}),
    databaseUrl: ':memory:',
    mockUpstream: false,
    upstreamBaseUrl: 'http://custom-llm.invalid/v1',
    upstreamApiKey: 'test-key',
    defaultModel: 'default-m',
    logSilent: true,
  };
  const created = await createApp(cfg, {
    silent: true,
    transport: options.transport,
    upstreamSettings: null,
    personalAIConfig: options.personalAIConfig,
  });
  const server = http.createServer(created.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    created,
    async api(route, opts = {}) {
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
}

describe('Step 5.1: AgentSelector 与 resolveMulticaAssignee', () => {
  it('按能力关键词、状态、Backend 可用性与并发上限选择 Agent，并正确解析 MultiCA assignee', async () => {
    const h: Harness = await createHarness();
    active.push(h);

    h.deps.agentStore.create({
      agent_id: 'writer',
      name: 'Writer',
      role: '写作助手',
      description: '负责日常周报与文档润色',
      core_memory: '周报 润色 写作',
    });
    h.deps.agentStore.updateAdmin('writer', {
      capabilities: ['writing', 'weekly-report', '周报'],
      execution_backend: 'direct_llm',
      concurrency_limit: 1,
    });

    const selector = h.personalAI.agentSelector;
    expect(resolveMulticaAssignee(h.deps.agentStore.get('developer'), 'Codex')).toBe('Codex');

    h.deps.agentStore.updateAdmin('researcher', {
      backend_config: { assignee: 'ResearchBot' },
    });
    expect(resolveMulticaAssignee(h.deps.agentStore.get('researcher'), 'Codex')).toBe('ResearchBot');

    // multicaEnabled=false 时应排除 developer/researcher，只选中 direct_llm 的 writer
    const directPick = selector.select({
      taskText: '帮我调研竞品并写一份周报',
      multicaEnabled: false,
    });
    expect(directPick?.agent.agent_id).toBe('writer');

    // multicaEnabled=true 时按能力匹配调研关键词应选中 researcher
    const researchPick = selector.select({
      taskText: '请帮我进行技术方案调研和 benchmark 评估对比',
      multicaEnabled: true,
    });
    expect(researchPick?.agent.agent_id).toBe('researcher');

    // writer 占满并发上限后，不再被选中；全部禁用/不可用时返回 undefined
    h.personalAI.taskManager.createIfAbsent({
      user_id: 'u1',
      conversation_id: 'c1',
      request_id: 'busy_writer_1',
      agent_id: 'writer',
      project_id: null,
      execution_mode: 'direct_llm',
      input_summary: '写周报中',
    });
    const noEligible = selector.select({
      taskText: '帮我写周报',
      multicaEnabled: false,
    });
    expect(noEligible).toBeUndefined();

    // disabled agent 即使被 preferredAgentId 指定也不可选中
    h.deps.agentStore.updateAdmin('developer', { status: 'disabled' });
    const disabledPreferred = selector.select({
      taskText: '重构代码',
      preferredAgentId: 'developer',
      multicaEnabled: true,
      allowFallback: false,
    });
    expect(disabledPreferred).toBeUndefined();
  });
});

describe('Step 5.2: ContextBuilder 只读增强用户档案与个人事务上下文', () => {
  it('注入时区/工作风格/活跃Goal/Project/Task摘要且保留安全系统指令与记忆开关', async () => {
    const h: Harness = await createHarness();
    active.push(h);

    h.personalAI.userProfiles.ensureUser('u1', { headerTimezone: 'Asia/Shanghai' });
    h.personalAI.userProfiles.update('u1', {
      display_name: '林深',
      work_style: { response_style: 'concise', language: 'zh-CN' },
    });
    const goal = h.personalAI.goalStore.create('u1', { title: '完成知忆 V1.5 交付', priority: 1 });
    const proj = h.personalAI.projectStore.create('u1', {
      title: 'Personal AI Runtime',
      goal_ids: [goal.id],
    });
    h.personalAI.businessTaskManager.create('u1', {
      title: '联调意图路由',
      project_id: proj.id,
      status: 'ready',
    });

    // u2 的数据绝对不得进入 u1 上下文
    h.personalAI.goalStore.create('u2', { title: 'U2 Secret Goal' });

    h.deps.memoryStore.create({
      user_id: 'u1',
      content: '用户习惯使用 TypeScript 严格模式',
      type: 'semantic',
      scope: 'personal',
    });

    const ctx = buildPersonalAIContext(
      {
        config: h.deps.config,
        memoryStore: h.deps.memoryStore,
        agentStore: h.deps.agentStore,
        userProfiles: h.personalAI.userProfiles,
        goalStore: h.personalAI.goalStore,
        projectStore: h.personalAI.projectStore,
        businessTaskManager: h.personalAI.businessTaskManager,
      },
      {
        user_id: 'u1',
        agent_id: 'default',
        project_id: proj.id,
        session_id: 'sess-1',
        conversation_id: 'conv-1',
        request_id: 'req-ctx-1',
        task_id: null,
        raw_user_id: 'u1',
        source: 'api-key',
      },
      [{ role: 'user', content: '请按照我的 TypeScript 偏好查看当前任务进度' }],
    );

    expect(ctx.systemMessage).toContain('[知忆 Zhiyi]');
    expect(ctx.systemMessage).toContain('【当前时间与环境】');
    expect(ctx.systemMessage).toContain('当前时间：');
    expect(ctx.systemMessage).toContain('林深');
    expect(ctx.systemMessage).toContain('Asia/Shanghai');
    expect(ctx.systemMessage).toContain('完成知忆 V1.5 交付');
    expect(ctx.systemMessage).toContain('Personal AI Runtime');
    expect(ctx.systemMessage).toContain('联调意图路由');
    expect(ctx.systemMessage).not.toContain('U2 Secret Goal');
    expect(ctx.memoryInjected).toBe(true);

    // 当用户显式关闭 memory_injection_enabled 时，不再注入记忆，但事务摘要仍在
    h.personalAI.userProfiles.update('u1', {
      preferences: { memory_injection_enabled: false },
    });
    const ctxNoMem = buildPersonalAIContext(
      {
        config: h.deps.config,
        memoryStore: h.deps.memoryStore,
        agentStore: h.deps.agentStore,
        userProfiles: h.personalAI.userProfiles,
        goalStore: h.personalAI.goalStore,
        projectStore: h.personalAI.projectStore,
        businessTaskManager: h.personalAI.businessTaskManager,
      },
      {
        user_id: 'u1',
        agent_id: 'default',
        project_id: proj.id,
        session_id: 'sess-1',
        conversation_id: 'conv-1',
        request_id: 'req-ctx-2',
        task_id: null,
        raw_user_id: 'u1',
        source: 'api-key',
      },
      [{ role: 'user', content: 'TypeScript 风格是什么' }],
    );
    expect(ctxNoMem.memoryInjected).toBe(false);
    expect(ctxNoMem.hits).toHaveLength(0);
    expect(ctxNoMem.systemMessage).toContain('完成知忆 V1.5 交付');
  });
});

describe('Step 5.3: PersonalAIRuntime V1.5 意图分类、任务编排与安全回退', () => {
  it('GREETING_ONLY 走快路径，llmIntentEnabled 时能创建 Goal/Project/Task 并过滤跨用户 ID', async () => {
    const capturedPrompts: string[] = [];
    let mode: 'greeting' | 'goal' | 'project' | 'task' | 'bad_json' = 'greeting';
    let foreignGoalId = '';
    let foreignProjId = '';

    const mockTransport: UpstreamTransport = async (_url, init) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const userContent: string = payload.messages?.[payload.messages.length - 1]?.content ?? '';
      capturedPrompts.push(userContent);

      if (userContent.includes('你是知忆（Zhiyi）的意图路由器')) {
        if (mode === 'goal') {
          return sseResponse([
            JSON.stringify({
              action: 'create_goal',
              confidence: 0.92,
              reason: '明确要求新建目标',
              title: '季度减脂 5 公斤',
              priority: 1,
            }),
          ]);
        }
        if (mode === 'project') {
          return sseResponse([
            JSON.stringify({
              action: 'create_project',
              confidence: 0.91,
              reason: '明确新建项目且混入外部 Goal ID',
              title: '健康管理专项',
              goal_ids: [foreignGoalId],
            }),
          ]);
        }
        if (mode === 'task') {
          return sseResponse([
            JSON.stringify({
              action: 'create_task',
              confidence: 0.9,
              reason: '明确记录待办且携带外部项目引用',
              title: '整理体检报告',
              project_id: foreignProjId,
            }),
          ]);
        }
        if (mode === 'bad_json') {
          return sseResponse(['这不是 JSON，随意回复']);
        }
      }

      return sseResponse(['普通直答结果']);
    };

    const srv = await createCustomAppServer({
      transport: mockTransport,
      personalAIConfig: {
        ...loadPersonalAIConfig({}),
        enabled: true,
        llmIntentEnabled: true,
      },
    });
    active.push(srv);

    // 预置 u2 私有数据，验证 LLM 输出跨用户 ID 时会被剥离
    const u2Goal = srv.created.personalAI.goalStore.create('u2', { title: 'U2 Private Goal' });
    const u2Proj = srv.created.personalAI.projectStore.create('u2', { title: 'U2 Private Project' });
    foreignGoalId = u2Goal.id;
    foreignProjId = u2Proj.id;

    // 1. 问候快路径：不触发额外分类模型调用，同时按 X-Timezone 懒建档
    const greet = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      headers: { 'x-timezone': 'Asia/Shanghai' },
      body: { messages: [{ role: 'user', content: '你好！' }], stream: false },
    });
    expect(greet.status).toBe(200);
    expect(greet.json.choices[0].message.content).toBe('普通直答结果');
    expect(capturedPrompts).toHaveLength(1);
    expect(srv.created.personalAI.userProfiles.get('u1')?.timezone).toBe('Asia/Shanghai');

    // 2. create_goal
    mode = 'goal';
    const gRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [{ role: 'user', content: '帮我立个季度减脂 5 公斤的目标' }], stream: false },
    });
    expect(gRes.status).toBe(200);
    expect(gRes.json.choices[0].message.content).toContain('季度减脂 5 公斤');
    const goals = srv.created.personalAI.goalStore.list('u1');
    expect(goals.items).toHaveLength(1);
    expect(goals.items[0].priority).toBe(1);

    // 3. create_project（跨用户 goal_ids 自动过滤，不得关联 u2Goal）
    mode = 'project';
    const pRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [{ role: 'user', content: '建一个健康管理专项项目' }], stream: false },
    });
    expect(pRes.status).toBe(200);
    expect(pRes.json.choices[0].message.content).toContain('健康管理专项');
    const u1Projects = srv.created.personalAI.projectStore.list('u1');
    expect(u1Projects.items).toHaveLength(1);
    expect(srv.created.personalAI.projectStore.list('u1', { goal_id: foreignGoalId }).items).toHaveLength(0);

    // 4. create_task + 跨用户 project_id 剥离
    mode = 'task';
    const tRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [{ role: 'user', content: '记一下整理体检报告' }], stream: false },
    });
    expect(tRes.status).toBe(200);
    expect(tRes.json.choices[0].message.content).toContain('整理体检报告');
    const u1Tasks = srv.created.personalAI.businessTaskManager.list('u1');
    expect(u1Tasks.items).toHaveLength(1);
    expect(u1Tasks.items[0].project_id).toBeNull();

    // 5. 非法 JSON 意图安全回退到 V1 规则直答
    mode = 'bad_json';
    const fallbackRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { messages: [{ role: 'user', content: '解释一下什么是 CAP 定理' }], stream: false },
    });
    expect(fallbackRes.status).toBe(200);
    expect(fallbackRes.json.choices[0].message.content).toBe('普通直答结果');
  });

  it('delegate_task 分别路由到 direct_llm 定制 Agent 与 multica Agent，并持久化 BusinessTask + Execution', async () => {
    const transportCalls: string[][] = [];
    let intentTarget: 'direct' | 'multica' = 'direct';

    const mockTransport: UpstreamTransport = async (_url, init) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>;
      };
      transportCalls.push((payload.messages ?? []).map((m) => `${m.role}:${m.content}`));
      const last: string = payload.messages?.[payload.messages.length - 1]?.content ?? '';
      if (last.includes('你是知忆（Zhiyi）的意图路由器')) {
        if (intentTarget === 'direct') {
          return sseResponse([
            JSON.stringify({
              action: 'delegate_task',
              confidence: 0.94,
              reason: '需要由写作专家执行',
              title: '撰写本周研发周报',
              description: '总结本周进度与下周计划',
              preferred_agent_id: 'weekly-writer',
            }),
          ]);
        }
        return sseResponse([
          JSON.stringify({
            action: 'delegate_task',
            confidence: 0.95,
            reason: '需要研发 Agent 排查代码仓库',
            title: '排查认证模块',
            description: '检查认证中间件并修复边界问题',
            preferred_agent_id: 'developer',
          }),
        ]);
      }
      return sseResponse(['【周报成稿】本周完成 Phase 1 Step 5。']);
    };

    const basePersonal = loadPersonalAIConfig({});
    const srv = await createCustomAppServer({
      transport: mockTransport,
      personalAIConfig: {
        ...basePersonal,
        enabled: true,
        llmIntentEnabled: true,
        multica: {
          ...basePersonal.multica,
          enabled: true,
          cliPath: STUB_CLI,
          daemonRequired: false,
          pollIntervalMs: 30,
          maxPolls: 20,
          defaultAgent: 'Codex',
        },
      },
    });
    active.push(srv);

    srv.created.deps.agentStore.create({
      agent_id: 'weekly-writer',
      name: 'Weekly Writer',
      role: '周报专家',
      description: '撰写工程周报',
      core_memory: '周报 总结',
    });
    srv.created.deps.agentStore.updateAdmin('weekly-writer', {
      capabilities: ['weekly-report', '周报'],
      execution_backend: 'direct_llm',
      instructions: '你是严谨的工程周报助手。',
    });

    // A. direct_llm 委派：流式输出 direct_llm Agent 结果并持久化 completed 业务 Task + Execution
    intentTarget = 'direct';
    const directRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      headers: { 'x-request-id': 'req-step5-direct-1' },
      body: { messages: [{ role: 'user', content: '帮我撰写本周研发周报' }], stream: true },
    });
    expect(directRes.status).toBe(200);
    expect(directRes.text).toContain('【周报成稿】本周完成 Phase 1 Step 5。');

    const tasksAfterDirect = srv.created.personalAI.businessTaskManager.list('u1');
    expect(tasksAfterDirect.items).toHaveLength(1);
    const directTask = tasksAfterDirect.items[0];
    expect(directTask.status).toBe('completed');
    expect(directTask.assignee_agent_id).toBe('weekly-writer');

    const directExecs = srv.created.personalAI.businessTaskManager.listExecutions('u1', directTask.id);
    expect(directExecs?.items).toHaveLength(1);
    expect(directExecs?.items[0].execution_mode).toBe('direct_llm');
    expect(directExecs?.items[0].status).toBe('completed');
    expect(
      transportCalls.some((msgs) => msgs.some((m) => m.includes('你是严谨的工程周报助手。'))),
    ).toBe(true);

    // B. multica 委派：经由 MultiCA CLI stub 完成并同步 BusinessTask 终态
    intentTarget = 'multica';
    const multicaRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-developer',
      headers: { 'x-request-id': 'req-step5-multica-1' },
      body: { messages: [{ role: 'user', content: '请让研发 Agent 排查认证模块' }], stream: true },
    });
    expect(multicaRes.status).toBe(200);
    expect(multicaRes.text).toContain('[知忆]');
    expect(multicaRes.text).toContain('Agent 已完成分析');

    const tasksAfterMultica = srv.created.personalAI.businessTaskManager.list('u1');
    expect(tasksAfterMultica.items).toHaveLength(2);
    const multicaTask = tasksAfterMultica.items.find((t) => t.title === '排查认证模块');
    expect(multicaTask).toBeDefined();
    expect(multicaTask?.status).toBe('completed');
    expect(multicaTask?.assignee_agent_id).toBe('developer');
    const multicaExecs = srv.created.personalAI.businessTaskManager.listExecutions(
      'u1',
      multicaTask!.id,
    );
    expect(multicaExecs?.items).toHaveLength(1);
    expect(multicaExecs?.items[0].execution_mode).toBe('agent_delegation');
    expect(multicaExecs?.items[0].status).toBe('completed');
    expect(multicaExecs?.items[0].external_task_id).toMatch(/^MUL-/);
  });
});
