/**
 * 知忆阶段 2：Agent 自动委派与任务执行闭环完整测试。
 *
 * 覆盖：
 * 1. AgentSelector 基于 capabilities / description / role / execution_backend / status 选人及显式点名诊断
 * 2. OpenClaw 执行后端在 MULTICA_ENABLED=false 下的自动委派、BusinessTask+Execution 联动与真实工具进度
 * 3. 普通 direct_llm Agent 执行时不伪造中间进度，真实返回结果并落库终态
 * 4. 用户显式指定 Agent（命中 / 不存在 / 已禁用 / MultiCA 未启用）的准确响应与防错派
 * 5. 普通问答与讨论不误触发任务创建与 Agent 委派
 * 6. MultiCA 后端自动委派闭环（CLI stub）、取消收敛、失败处理与跨用户严格数据隔离
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { loadPersonalAIConfig, type PersonalAIConfig } from '../src/personal-ai/config';
import type { PersonalAIEvent } from '../src/personal-ai/events/event-types';
import type { UpstreamTransport } from '../src/types';

const MULTICA_STUB: string = path.resolve(process.cwd(), 'scripts/mock-multica-cli.mjs');
fs.chmodSync(MULTICA_STUB, 0o755);

const activeCleanup: Array<() => Promise<void>> = [];

afterEach(async (): Promise<void> => {
  delete process.env.MULTICA_STUB_STATE;
  delete process.env.MULTICA_STUB_SLEEP_MS;
  delete process.env.MULTICA_STUB_STUCK;
  while (activeCleanup.length > 0) {
    const fn = activeCleanup.pop();
    if (fn) await fn();
  }
});

function sseFrames(frames: Array<Record<string, unknown>>): Response {
  const body =
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function multicaStubConfig(extraEnv: Record<string, string> = {}): PersonalAIConfig {
  const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiyi-stage2-multica-'));
  const statePath: string = path.join(dir, 'stub-state.json');
  process.env.MULTICA_STUB_STATE = statePath;
  activeCleanup.push(async (): Promise<void> => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = loadPersonalAIConfig({ MULTICA_ENABLED: 'true', ...extraEnv });
  return {
    ...base,
    multica: {
      ...base.multica,
      enabled: true,
      cliPath: MULTICA_STUB,
      pollIntervalMs: 40,
      commandTimeoutMs: 4000,
      maxPolls: 20,
      defaultAgent: 'Codex',
    },
  };
}

async function createDelegationServer(options: {
  transport: UpstreamTransport;
  personalAIConfig?: PersonalAIConfig;
}) {
  const cfg: AppConfig = {
    ...loadConfig({}),
    databaseUrl: ':memory:',
    mockUpstream: false,
    upstreamBaseUrl: 'http://mock-delegation.invalid/v1',
    upstreamApiKey: 'sk-stage2-test',
    defaultModel: 'zhiyi-stage2-model',
    upstreamTimeoutMs: 3000,
    logSilent: true,
  };

  const basePersonal = options.personalAIConfig ?? loadPersonalAIConfig({});
  const effectivePersonal: PersonalAIConfig = {
    ...basePersonal,
    apiKeys: {
      ...basePersonal.apiKeys,
      'chat-u1': { user_id: 'u1', agent_id: 'default' },
      'chat-u2': { user_id: 'u2', agent_id: 'default' },
    },
  };

  const created: CreatedApp = await createApp(cfg, {
    silent: true,
    settingsPath: null,
    adminToken: 'admin-stage2-token',
    transport: options.transport,
    upstreamSettings: null,
    personalAIConfig: effectivePersonal,
  });

  const server = http.createServer(created.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  activeCleanup.push(async (): Promise<void> => {
    await created.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  return {
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
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // SSE 流或非 JSON 文本忽略
      }
      return { status: res.status, text, json };
    },
  };
}

describe('阶段 2：Agent 自动委派与任务执行闭环', () => {
  it('AgentSelector 能结合 description / capabilities / role / backend / 并发与显式点名选出或拒绝 Agent', async () => {
    const srv = await createDelegationServer({
      transport: async () => sseFrames([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
      personalAIConfig: loadPersonalAIConfig({ MULTICA_ENABLED: 'false' }),
    });

    srv.created.deps.agentStore.updateAdmin('researcher', {
      execution_backend: 'direct_llm',
      description: '专注研究个人 AI 助手架构、技术选型与竞品调研评估报告',
      capabilities: ['research', 'analysis'],
      backend_config: { runtime: 'openclaw', allowed_tools: ['task_list'], max_turns: 4 },
    });
    srv.created.deps.agentStore.updateAdmin('developer', {
      execution_backend: 'multica',
      role: '程序员',
      description: '负责后端代码重构、Bug 修复与数据库迁移',
      capabilities: ['coding', 'refactor'],
    });

    srv.created.deps.agentStore.create({
      agent_id: 'disabled-auditor',
      name: 'Security Auditor',
      role: '安全审计',
      description: '安全漏洞扫描',
      core_memory: '审计',
    });
    srv.created.deps.agentStore.updateAdmin('disabled-auditor', {
      status: 'disabled',
      execution_backend: 'direct_llm',
    });

    const selector = srv.created.personalAI.agentSelector;

    // 1. 即使 MULTICA_ENABLED=false，也能基于 description 命中 OpenClaw researcher
    const researchOutcome = selector.selectWithDiagnostics({
      taskText: '帮我研究一下目前主流的个人 AI 助手架构并做选型评估',
      multicaEnabled: false,
    });
    expect(researchOutcome.selected?.agent.agent_id).toBe('researcher');
    expect(researchOutcome.unavailable).toBeUndefined();

    // 2. MULTICA_ENABLED=true 时，代码重构任务优先匹配 developer
    const devOutcome = selector.selectWithDiagnostics({
      taskText: '请重构用户认证模块并修复并发 Bug',
      multicaEnabled: true,
    });
    expect(devOutcome.selected?.agent.agent_id).toBe('developer');

    // 3. 显式点名 + allowFallback=false：不可用或不存在时给出精确原因
    const missingOutcome = selector.selectWithDiagnostics({
      taskText: '交给 nonexistent-bot 处理',
      preferredAgentId: 'nonexistent-bot',
      multicaEnabled: true,
      allowFallback: false,
    });
    expect(missingOutcome.selected).toBeUndefined();
    expect(missingOutcome.unavailable?.code).toBe('not_found');

    const disabledOutcome = selector.selectWithDiagnostics({
      taskText: '让 disabled-auditor 检查一遍',
      preferredAgentId: 'disabled-auditor',
      multicaEnabled: true,
      allowFallback: false,
    });
    expect(disabledOutcome.selected).toBeUndefined();
    expect(disabledOutcome.unavailable?.code).toBe('disabled');

    const multicaOffOutcome = selector.selectWithDiagnostics({
      taskText: '交给程序员 Agent',
      preferredAgentId: 'developer',
      multicaEnabled: false,
      allowFallback: false,
    });
    expect(multicaOffOutcome.selected).toBeUndefined();
    expect(multicaOffOutcome.unavailable?.code).toBe('multica_disabled');
  });

  it('MULTICA_ENABLED=false 时自动委派 OpenClaw 与普通 direct_llm Agent，关联 BusinessTask+Execution 且不伪造进度', async () => {
    let modelCalls = 0;
    const transport: UpstreamTransport = async (_url, init) => {
      modelCalls += 1;
      const body = JSON.parse(String(init.body ?? '{}')) as {
        messages?: Array<{ role: string; content: unknown; tool_calls?: unknown }>;
        tools?: Array<{ function: { name: string } }>;
      };
      const msgs = body.messages ?? [];
      const hasToolResult = msgs.some((m) => m.role === 'tool');
      const hasTaskListTool = (body.tools ?? []).some((t) => t.function.name === 'task_list');

      // OpenClaw researcher 先调用 task_list 获取真实进度，再给出研究结论
      if (hasTaskListTool && !hasToolResult && msgs.some((m) => String(m.content).includes('研究'))) {
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_list_${modelCalls}`,
                      type: 'function',
                      function: { name: 'task_list', arguments: '{}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }

      if (hasToolResult) {
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  content: '【调研结果】主流个人 AI 助手核心架构包括记忆层、规划层、工具网关与执行后端。',
                },
                finish_reason: 'stop',
              },
            ],
          },
        ]);
      }

      if (msgs.some((m) => String(m.content).includes('周报'))) {
        return sseFrames([
          {
            choices: [
              {
                delta: { content: '【direct_llm 产出】本周技术总结已完成。' },
                finish_reason: 'stop',
              },
            ],
          },
        ]);
      }

      return sseFrames([
        {
          choices: [
            {
              delta: { content: '这是普通问答的直接回复：CAP 定理指一致性、可用性与分区容错性。' },
              finish_reason: 'stop',
            },
          ],
        },
      ]);
    };

    const srv = await createDelegationServer({
      transport,
      personalAIConfig: loadPersonalAIConfig({ MULTICA_ENABLED: 'false' }),
    });

    // 注册研究型 OpenClaw Agent 与纯 direct_llm Agent
    srv.created.deps.agentStore.create({
      agent_id: 'research-claw',
      name: 'Research Claw',
      role: '研究助手',
      description: '调研个人 AI 助手架构与业界方案',
      core_memory: '架构调研',
    });
    srv.created.deps.agentStore.updateAdmin('research-claw', {
      execution_backend: 'direct_llm',
      capabilities: ['研究', '调研', '个人 AI 助手'],
      backend_config: { runtime: 'openclaw', allowed_tools: ['task_list'], max_turns: 4 },
    });

    srv.created.deps.agentStore.create({
      agent_id: 'plain-writer',
      name: 'Plain Writer',
      role: '周报助手',
      description: '撰写开发周报与总结文档',
      core_memory: '周报',
    });
    srv.created.deps.agentStore.updateAdmin('plain-writer', {
      execution_backend: 'direct_llm',
      capabilities: ['周报', '总结'],
      backend_config: { runtime: 'simple_llm' },
    });

    // 1. 普通聊天与概念问答不误触发委派或创建业务任务
    const chatRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'chat-u1',
      headers: { 'x-request-id': 'req-chat-only' },
      body: {
        messages: [{ role: 'user', content: '什么是 CAP 定理？' }],
        stream: false,
      },
    });
    expect(chatRes.status).toBe(200);
    expect(srv.created.personalAI.businessTaskManager.list('u1').items).toHaveLength(0);
    const execTasksAfterChat = await srv.api('/v1/personal-ai/tasks', { key: 'chat-u1' });
    expect((execTasksAfterChat.json as { items: unknown[] }).items).toHaveLength(0);

    // 2. 自动委派给 OpenClaw research-claw，验证真实工具进度与任务状态持久化
    const researchEvents: PersonalAIEvent[] = [];
    for await (const ev of srv.created.personalAI.runtime.run({
      identity: {
        user_id: 'u1',
        agent_id: 'default',
        api_key: null,
        from_default: false,
        request_id: 'req-openclaw-delegate-1',
        session_id: null,
        task_id: null,
        project_id: null,
        conversation_id: 'conv-openclaw-delegate-1',
      },
      messages: [{ role: 'user', content: '帮我研究一下目前主流的个人 AI 助手架构' }],
    })) {
      researchEvents.push(ev);
    }

    const startedEv = researchEvents.find((e) => e.type === 'task_started');
    expect(startedEv).toBeDefined();
    if (startedEv?.type === 'task_started') {
      expect(startedEv.mode).toBe('openclaw');
      expect(startedEv.agentId).toBe('research-claw');
    }
    expect(researchEvents.some((e) => e.type === 'task_progress')).toBe(true);
    expect(researchEvents.some((e) => e.type === 'agent_completed')).toBe(true);

    const tasksAfterResearch = srv.created.personalAI.businessTaskManager.list('u1');
    expect(tasksAfterResearch.items).toHaveLength(1);
    expect(tasksAfterResearch.items[0].assignee_agent_id).toBe('research-claw');
    expect(tasksAfterResearch.items[0].status).toBe('completed');
    const execs1 = srv.created.personalAI.businessTaskManager.listExecutions('u1', tasksAfterResearch.items[0].id);
    expect(execs1?.items).toHaveLength(1);
    expect(execs1?.items[0].execution_mode).toBe('direct_llm');
    expect(execs1?.items[0].status).toBe('completed');

    // 3. 显式点名 plain-writer（simple_llm direct_llm）：绝不伪造 task_progress
    const directEvents: PersonalAIEvent[] = [];
    for await (const ev of srv.created.personalAI.runtime.run({
      identity: {
        user_id: 'u1',
        agent_id: 'default',
        api_key: null,
        from_default: false,
        request_id: 'req-direct-delegate-1',
        session_id: null,
        task_id: null,
        project_id: null,
        conversation_id: 'conv-direct-delegate-1',
      },
      messages: [{ role: 'user', content: '交给 plain-writer 撰写本周技术周报' }],
    })) {
      directEvents.push(ev);
    }

    const plainStart = directEvents.find((e) => e.type === 'task_started');
    expect(plainStart?.type === 'task_started' ? plainStart.mode : undefined).toBe('direct_llm');
    expect(directEvents.some((e) => e.type === 'task_progress')).toBe(false);
    expect(directEvents.some((e) => e.type === 'agent_completed')).toBe(true);

    const tasksAfterDirect = srv.created.personalAI.businessTaskManager.list('u1');
    expect(tasksAfterDirect.items).toHaveLength(2);
    const writerTask = tasksAfterDirect.items.find((t) => t.assignee_agent_id === 'plain-writer');
    expect(writerTask?.status).toBe('completed');
    const writerExecs = srv.created.personalAI.businessTaskManager.listExecutions('u1', writerTask!.id);
    expect(writerExecs?.items).toHaveLength(1);
    expect(writerExecs?.items[0].status).toBe('completed');
    expect(writerExecs?.items[0].result).toContain('本周技术总结已完成');
  });

  it('显式指定不存在或已禁用 Agent 时明确提示用户且不误创建任务；用户数据严格隔离', async () => {
    const transport: UpstreamTransport = async () =>
      sseFrames([{ choices: [{ delta: { content: '不应被调用' }, finish_reason: 'stop' }] }]);

    const srv = await createDelegationServer({
      transport,
      personalAIConfig: loadPersonalAIConfig({ MULTICA_ENABLED: 'false' }),
    });

    srv.created.deps.agentStore.create({
      agent_id: 'disabled-researcher',
      name: 'Disabled Researcher',
      role: '研究分析师',
      description: '调研分析',
      core_memory: '调研',
    });
    srv.created.deps.agentStore.updateAdmin('disabled-researcher', {
      status: 'disabled',
      execution_backend: 'direct_llm',
    });

    srv.created.deps.agentStore.create({
      agent_id: 'backup-openclaw',
      name: 'Backup OpenClaw',
      role: '开发助手',
      description: '普通代码任务',
      core_memory: '开发',
    });
    srv.created.deps.agentStore.updateAdmin('backup-openclaw', {
      execution_backend: 'direct_llm',
      backend_config: { runtime: 'openclaw', allowed_tools: ['task_list'], max_turns: 3 },
    });

    // 1. 指定不存在的 Agent -> 明确报错且不静默降级给 backup-openclaw
    const missingRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'chat-u1',
      headers: { 'x-request-id': 'req-missing-agent' },
      body: {
        messages: [{ role: 'user', content: '把这个调研任务交给 phantom Agent 处理' }],
        stream: false,
      },
    });
    expect(missingRes.status).toBe(200);
    const missingText = (missingRes.json as { choices: Array<{ message: { content: string } }> })
      .choices[0].message.content;
    expect(missingText).toContain('无法委派任务');
    expect(missingText).toContain('不存在');
    expect(srv.created.personalAI.businessTaskManager.list('u1').items).toHaveLength(0);

    // 2. 指定已禁用的 Agent -> 明确提示已禁用且不静默转派
    const disabledRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'chat-u1',
      headers: { 'x-request-id': 'req-disabled-agent' },
      body: {
        messages: [{ role: 'user', content: '让 disabled-researcher 先调研市场竞品' }],
        stream: false,
      },
    });
    expect(disabledRes.status).toBe(200);
    const disabledText = (disabledRes.json as { choices: Array<{ message: { content: string } }> })
      .choices[0].message.content;
    expect(disabledText).toContain('已禁用');
    expect(srv.created.personalAI.businessTaskManager.list('u1').items).toHaveLength(0);
  });

  it('MultiCA 后端自动委派、模型企图伪造特权身份拦截、取消/失败终态反馈及跨用户隔离', async () => {
    let forceFail = false;
    let slowStreamDelayMs = 0;

    const transport: UpstreamTransport = async (_url, init) => {
      const bodyText = String(init.body ?? '{}');
      const body = JSON.parse(bodyText) as {
        messages?: Array<{ role: string; content: unknown }>;
      };
      const prompt = String(body.messages?.[0]?.content ?? '');

      // 模拟意图分类 LLM：测试安全边界（模型试图指定不存在/高权 Agent 时被拦截）
      if (prompt.includes('意图分类')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: 'delegate_task',
                    title: '分析个人助手项目',
                    description: '分析项目并给出建议',
                    preferred_agent_id: 'unauthorized-admin-agent',
                    reason: 'llm_suggested',
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (forceFail) {
        return new Response(JSON.stringify({ error: { message: 'upstream_502_bad_gateway' } }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (slowStreamDelayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, slowStreamDelayMs);
          init.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('用户取消任务'));
            },
            { once: true },
          );
        });
      }

      return sseFrames([{ choices: [{ delta: { content: '直连产出内容' }, finish_reason: 'stop' }] }]);
    };

    const srv = await createDelegationServer({
      transport,
      personalAIConfig: multicaStubConfig({ PERSONAL_AI_INTENT_LLM_ENABLED: 'true' }),
    });

    // 创建被禁用的高权测试 Agent，验证 LLM 返回 unauthorized-admin-agent 时不会绕过权限
    srv.created.deps.agentStore.create({
      agent_id: 'unauthorized-admin-agent',
      name: 'Admin Only',
      role: '管理员',
      description: '内部运维',
      core_memory: '运维',
    });
    srv.created.deps.agentStore.updateAdmin('unauthorized-admin-agent', { status: 'disabled' });

    // 1. MultiCA 委派执行：即使 LLM 建议了 disabled Agent，AgentSelector 仍只选用 active 合法 Agent 完成 MultiCA 执行
    const multicaRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'chat-u1',
      headers: { 'x-request-id': 'req-multica-auto-1' },
      body: {
        messages: [{ role: 'user', content: '帮我分析这个项目，并整理出改进建议。' }],
        stream: true,
      },
    });
    expect(multicaRes.status).toBe(200);
    expect(multicaRes.text).toContain('Agent 已完成分析');

    const u1Tasks = srv.created.personalAI.businessTaskManager.list('u1');
    expect(u1Tasks.items).toHaveLength(1);
    const multicaTask = u1Tasks.items[0];
    expect(multicaTask.status).toBe('completed');
    expect(multicaTask.assignee_agent_id).not.toBe('unauthorized-admin-agent');
    const multicaExecs = srv.created.personalAI.businessTaskManager.listExecutions('u1', multicaTask.id);
    expect(multicaExecs?.items[0].execution_mode).toBe('agent_delegation');
    expect(multicaExecs?.items[0].external_task_id).toMatch(/^MUL-/);

    // 跨用户隔离：u2 无法读取 u1 的 BusinessTask 或 Execution
    expect((await srv.api(`/v1/personal-ai/work-tasks/${multicaTask.id}`, { key: 'chat-u2' })).status).toBe(404);
    expect((await srv.api('/v1/personal-ai/work-tasks', { key: 'chat-u2' })).json).toMatchObject({
      items: [],
    });

    // 2. 验证失败与取消事件真实回传及 BusinessTask 终态持久化
    const srvDirect = await createDelegationServer({
      transport,
      personalAIConfig: loadPersonalAIConfig({ MULTICA_ENABLED: 'false' }),
    });
    srvDirect.created.deps.agentStore.create({
      agent_id: 'coder-claw',
      name: 'Coder Claw',
      role: '程序员',
      description: '执行代码分析与重构任务',
      core_memory: '代码重构',
    });
    srvDirect.created.deps.agentStore.updateAdmin('coder-claw', {
      execution_backend: 'direct_llm',
      capabilities: ['代码', '重构'],
      backend_config: { runtime: 'openclaw', allowed_tools: ['task_list'], max_turns: 3 },
    });

    // 2a) 后端执行失败 -> 发出 task_failed 且任务落库为 failed
    forceFail = true;
    const failEvents: PersonalAIEvent[] = [];
    for await (const ev of srvDirect.created.personalAI.runtime.run({
      identity: {
        user_id: 'u1',
        agent_id: 'default',
        api_key: null,
        from_default: false,
        request_id: 'req-fail-1',
        session_id: null,
        task_id: null,
        project_id: null,
        conversation_id: 'conv-fail-1',
      },
      messages: [{ role: 'user', content: '交给 coder-claw 重构日志模块' }],
    })) {
      failEvents.push(ev);
    }
    expect(failEvents.some((e) => e.type === 'task_failed')).toBe(true);
    const failedTask = srvDirect.created.personalAI.businessTaskManager.list('u1').items[0];
    expect(failedTask.status).toBe('failed');

    // 2b) 执行中取消 -> 发出 task_cancelled 且任务状态收敛为 cancelled
    forceFail = false;
    slowStreamDelayMs = 400;
    const abortCtrl = new AbortController();
    setTimeout(() => abortCtrl.abort(), 40);
    const cancelEvents: PersonalAIEvent[] = [];
    for await (const ev of srvDirect.created.personalAI.runtime.run({
      identity: {
        user_id: 'u1',
        agent_id: 'default',
        api_key: null,
        from_default: false,
        request_id: 'req-cancel-1',
        session_id: null,
        task_id: null,
        project_id: null,
        conversation_id: 'conv-cancel-1',
      },
      messages: [{ role: 'user', content: '让 coder-claw 分析登录代码问题' }],
      signal: abortCtrl.signal,
    })) {
      cancelEvents.push(ev);
    }
    expect(cancelEvents.some((e) => e.type === 'task_cancelled')).toBe(true);
    const cancelledTask = srvDirect.created.personalAI.businessTaskManager
      .list('u1')
      .items.find((t) => t.id !== failedTask.id);
    expect(cancelledTask?.status).toBe('cancelled');
  });
});
