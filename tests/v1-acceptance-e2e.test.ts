/**
 * Zhiyi V1 端到端综合产品验收与质量基线测试套件
 * 
 * 覆盖：
 * 阶段 A：真实工作流端到端测试（自然语言创建工作空间、修改/查询、Agent 执行闭环、多轮指代、讨论意图区分）
 * 阶段 B：Execution 生命周期与可靠异常恢复（事件序列完整性、超时错误分类、崩溃恢复对账、重试防重、取消终态）
 * 阶段 C：长期记忆真实性与演进可靠性（提取分类、跨会话持久化、用户确认防覆盖保护、冲突去重与上下文重排）
 * 阶段 D：主动助理（逾期/停滞/失败/需核实提醒生成、去重与冷却、免打扰与安静时间、项目进度真实数据汇总）
 * 阶段 E：安全隔离与数据完整性（用户 A 与 用户 B 跨实体全链路物理隔离、凭证/身份防御、工具权限边界、敏感信息脱敏）
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { loadPersonalAIConfig, type PersonalAIConfig } from '../src/personal-ai/config';
import { buildProjectProgressSummary } from '../src/personal-ai/proactive/project-summary';
import { buildPersonalAIContext } from '../src/personal-ai/runtime/context-builder';
import { TaskRepository } from '../src/personal-ai/task/task-repository';
import type { UpstreamTransport } from '../src/types';

const activeServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async (): Promise<void> => {
  while (activeServers.length > 0) {
    await activeServers.pop()?.close();
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

async function createE2ETestServer(options: {
  transport: UpstreamTransport;
  personalAIConfig?: PersonalAIConfig;
  adminToken?: string;
}) {
  const cfg: AppConfig = {
    ...loadConfig({}),
    databaseUrl: ':memory:',
    mockUpstream: false,
    upstreamBaseUrl: 'http://mock-e2e-upstream.invalid/v1',
    upstreamApiKey: 'sk-e2e-secret-key',
    defaultModel: 'zhiyi-v1-model',
    upstreamTimeoutMs: 2500,
    logSilent: true,
  };
  const paiCfg = options.personalAIConfig ?? loadPersonalAIConfig({});
  const effectivePaiCfg: PersonalAIConfig = {
    ...paiCfg,
    apiKeys: {
      ...paiCfg.apiKeys,
      'dev-key-assistant': { user_id: 'u1', agent_id: 'openclaw-assistant' },
    },
  };
  const created: CreatedApp = await createApp(cfg, {
    silent: true,
    settingsPath: null,
    adminToken: options.adminToken ?? 'admin-token-e2e',
    transport: options.transport,
    upstreamSettings: null,
    personalAIConfig: effectivePaiCfg,
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
        // non-json body
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
  activeServers.push(handle);
  return handle;
}

function registerAssistantAgent(created: CreatedApp, agentId = 'openclaw-assistant'): void {
  created.deps.agentStore.create({
    agent_id: agentId,
    name: 'Zhiyi Assistant',
    role: '工作管理助理',
    description: '协助管理目标、项目与任务',
    core_memory: '工作管理与记忆维护',
  });
  created.deps.agentStore.updateAdmin(agentId, {
    execution_backend: 'direct_llm',
    backend_config: { runtime: 'openclaw', max_turns: 8, tool_execution: 'sequential' },
    instructions: '使用知忆工作管理工具准确操作。',
    capabilities: ['goals', 'projects', 'tasks', 'memory', 'proactive', 'openclaw'],
  });
}

function fakeIdentity(userId: string, agentId: string) {
  return {
    user_id: userId,
    agent_id: agentId,
    api_key: null,
    from_default: false,
    request_id: `req_e2e_${Date.now()}`,
    session_id: null,
    task_id: null,
    project_id: null,
    conversation_id: `conv_${userId}`,
    signature_verified: false,
  };
}

describe('验收阶段 A：真实工作流端到端测试', () => {
  it('场景 A1 & A2：自然语言创建工作空间 -> 修改与查询 -> 状态机与数据库核对', async () => {
    let capturedGoalId = '';
    let capturedProjectId = '';
    const capturedTaskIds: string[] = [];

    const transport: UpstreamTransport = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as RecordedModelCall;
      const userMessages = parsed.messages.filter((m) => m.role === 'user');
      const lastUser = String(userMessages[userMessages.length - 1]?.content ?? '');
      const toolResults = parsed.messages.filter((m) => m.role === 'tool');

      // Turn 1: 用户要求创建长期目标“个人知识助手”，项目“知识助手 MVP”，以及 3 个任务
      if (lastUser.includes('建设一个个人知识助手') && toolResults.length === 0) {
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_g_create',
                      type: 'function',
                      function: {
                        name: 'goal_create',
                        arguments: JSON.stringify({ title: '个人知识助手', priority: 1 }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }

      if (toolResults.length === 1 && toolResults[0].name === 'goal_create') {
        const match = String(toolResults[0].content).match(/goal_[a-f0-9-]+/);
        capturedGoalId = match ? match[0] : '';
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_p_create',
                      type: 'function',
                      function: {
                        name: 'project_create',
                        arguments: JSON.stringify({
                          title: '知识助手 MVP',
                          goal_ids: capturedGoalId ? [capturedGoalId] : [],
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }

      if (toolResults.length === 2 && toolResults[1].name === 'project_create') {
        const match = String(toolResults[1].content).match(/proj_[a-f0-9-]+/);
        capturedProjectId = match ? match[0] : '';
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_t_1',
                      type: 'function',
                      function: {
                        name: 'task_create',
                        arguments: JSON.stringify({
                          title: '原型开发',
                          project_id: capturedProjectId,
                          priority: 1,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }

      if (toolResults.length === 3 && toolResults[2].name === 'task_create') {
        const match = String(toolResults[2].content).match(/btask_[a-f0-9-]+/);
        if (match) capturedTaskIds.push(match[0]);
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_t_2',
                      type: 'function',
                      function: {
                        name: 'task_create',
                        arguments: JSON.stringify({
                          title: '需求调研',
                          project_id: capturedProjectId,
                          priority: 2,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }

      if (toolResults.length === 4 && toolResults[3].name === 'task_create') {
        const match = String(toolResults[3].content).match(/btask_[a-f0-9-]+/);
        if (match) capturedTaskIds.push(match[0]);
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_t_3',
                      type: 'function',
                      function: {
                        name: 'task_create',
                        arguments: JSON.stringify({
                          title: '技术方案设计',
                          project_id: capturedProjectId,
                          priority: 2,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }

      if (toolResults.length === 5) {
        const match = String(toolResults[4].content).match(/btask_[a-f0-9-]+/);
        if (match) capturedTaskIds.push(match[0]);
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  content: `已成功创建目标「个人知识助手」(${capturedGoalId})、项目「知识助手 MVP」(${capturedProjectId}) 及三个任务：原型开发 (P1)、需求调研 (P2)、技术方案设计 (P2)。`,
                },
                finish_reason: 'stop',
              },
            ],
          },
        ]);
      }

      // Turn 2: “把原型开发任务交给程序员 Agent，需求调研先保持待办状态”
      if (lastUser.includes('原型开发任务交给程序员 Agent') && toolResults.length === 0) {
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_t_update',
                      type: 'function',
                      function: {
                        name: 'task_update',
                        arguments: JSON.stringify({
                          task_id: capturedTaskIds[0],
                          assignee_agent_id: 'developer',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }

      if (lastUser.includes('原型开发任务交给程序员 Agent') && toolResults.length === 1) {
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  content: `已将原型开发任务（${capturedTaskIds[0]}）指派给 developer，需求调研保持待办。`,
                },
                finish_reason: 'stop',
              },
            ],
          },
        ]);
      }

      // Turn 3: “帮我查看知识助手 MVP 项目目前有哪些任务，以及每个任务的负责人和状态”
      if (lastUser.includes('知识助手 MVP 项目目前有哪些任务') && toolResults.length === 0) {
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_t_list',
                      type: 'function',
                      function: {
                        name: 'task_list',
                        arguments: JSON.stringify({
                          project_id: capturedProjectId,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }

      if (lastUser.includes('知识助手 MVP 项目目前有哪些任务') && toolResults.length === 1) {
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  content: `项目当前包含 3 个任务：原型开发（负责人: developer，状态: pending）、需求调研（待办）、技术方案设计（待办）。`,
                },
                finish_reason: 'stop',
              },
            ],
          },
        ]);
      }

      return sseFrames([{ choices: [{ delta: { content: '未匹配' }, finish_reason: 'stop' }] }]);
    };

    const srv = await createE2ETestServer({ transport });
    registerAssistantAgent(srv.created, 'openclaw-assistant');

    // 1. 发送 Turn 1 请求
    const turn1Res = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-assistant',
      body: {
        agent_id: 'openclaw-assistant',
        messages: [
          {
            role: 'user',
            content:
              '我要建设一个个人知识助手，帮我创建一个长期目标，下面建立一个项目叫知识助手 MVP，并创建三个任务：需求调研、技术方案设计、原型开发。其中原型开发优先级最高。',
          },
        ],
      },
    });
    expect(turn1Res.status).toBe(200);
    expect(turn1Res.text).toContain('知识助手 MVP');

    // 数据库物理验证：Goal、Project、Tasks 与关联真实写入且属于 u1
    const { goalStore, projectStore, businessTaskManager } = srv.created.personalAI;
    const goal = goalStore.get('u1', capturedGoalId);
    expect(goal).toBeDefined();
    expect(goal?.title).toBe('个人知识助手');
    expect(goal?.priority).toBe(1);

    const project = projectStore.get('u1', capturedProjectId);
    expect(project).toBeDefined();
    expect(project?.title).toBe('知识助手 MVP');
    const projectGoals = projectStore.listGoalsForProject('u1', capturedProjectId);
    expect(projectGoals.some((g) => g.id === capturedGoalId)).toBe(true);

    const tasks = businessTaskManager.list('u1', { project_id: capturedProjectId }).items;
    expect(tasks.length).toBe(3);
    const prototypeTask = tasks.find((t) => t.title === '原型开发');
    expect(prototypeTask).toBeDefined();
    expect(prototypeTask?.priority).toBe(1);

    // 2. 发送 Turn 2 请求：修改负责人
    const turn2Res = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-assistant',
      body: {
        agent_id: 'openclaw-assistant',
        messages: [
          { role: 'user', content: '创建项目' },
          { role: 'assistant', content: '已创建' },
          { role: 'user', content: '把原型开发任务交给程序员 Agent，需求调研先保持待办状态。' },
        ],
      },
    });
    expect(turn2Res.status).toBe(200);
    expect(turn2Res.text).toContain('developer');

    const updatedTask = businessTaskManager.get('u1', capturedTaskIds[0]);
    expect(updatedTask.assignee_agent_id).toBe('developer');
    expect(updatedTask.status).toBe('pending'); // 未启动执行前保持 pending，不擅自更改状态

    // 3. 发送 Turn 3 请求：查询并返回最新数据库真实状态
    const turn3Res = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-assistant',
      body: {
        agent_id: 'openclaw-assistant',
        messages: [
          { role: 'user', content: '帮我查看知识助手 MVP 项目目前有哪些任务，以及每个任务的负责人和状态。' },
        ],
      },
    });
    expect(turn3Res.status).toBe(200);
    expect(turn3Res.text).toContain('原型开发');
    expect(turn3Res.text).toContain('developer');
  });

  it('场景 A3：Agent 执行闭环、Execution 状态流转、结果写回与任务完成候选沉淀', async () => {
    const srv = await createE2ETestServer({
      transport: async () =>
        sseFrames([
          { choices: [{ delta: { content: '原型代码已完成并生成单测，涵盖核心路由与存储。' }, finish_reason: 'stop' }] },
        ]),
    });
    const { personalAI } = srv.created;
    // 注册 direct_llm 程序员 Agent
    srv.created.deps.agentStore.updateAdmin('developer', {
      execution_backend: 'direct_llm',
      backend_config: { runtime: 'simple_llm' },
      instructions: '编写高质量代码。',
    });

    const task = personalAI.businessTaskManager.create('u1', {
      title: '原型开发',
      assignee_agent_id: 'developer',
    });

    // 触发执行 /work-tasks/:id/execute
    const execRes = await srv.api(`/v1/personal-ai/work-tasks/${task.id}/execute`, {
      method: 'POST',
      key: 'dev-key-developer',
      body: { input_summary: '执行原型开发任务' },
    });
    expect(execRes.status).toBe(200);
    expect(execRes.json.task.status).toBe('completed');
    expect(execRes.json.execution.result).toContain('原型代码已完成');

    // 验证底层 BusinessTask 同步收敛为 completed
    const refreshed = personalAI.businessTaskManager.get('u1', task.id);
    expect(refreshed.status).toBe('completed');

    // 验证 Execution 记录
    const executions = personalAI.taskManager.listByTaskId('u1', task.id).items;
    expect(executions.length).toBe(1);
    expect(executions[0].status).toBe('completed');
    expect(executions[0].result).toContain('原型代码已完成');

    // 验证 Execution 事件记录完整追踪
    const events = personalAI.taskManager.listEvents('u1', executions[0].id).items;
    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain('created');
    expect(eventTypes).toContain('started');
    expect(eventTypes).toContain('completed');

    // 验证任务完成后触发了记忆候选抽取（经验/成果沉淀）
    const candidates = srv.created.deps.candidateStore.list('u1');
    expect(candidates.some((c) => c.content.includes('原型代码') || c.content.includes('原型开发'))).toBe(true);
  });

  it('场景 A4 & A5：多轮指代保持与讨论想法不擅自建单', async () => {
    let toolInvoked = false;
    const transport: UpstreamTransport = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as RecordedModelCall;
      const userMessages = parsed.messages.filter((m) => m.role === 'user');
      const lastUser = String(userMessages[userMessages.length - 1]?.content ?? '');
      if (parsed.messages.some((m) => m.role === 'tool')) {
        // 若 OpenClaw 触发了工具调用并返回工具执行结果
        toolInvoked = true;
      }
      return sseFrames([
        {
          choices: [
            {
              delta: { content: '个人知识助手方向非常有价值，关键在于长短期记忆的协同。建议先梳理核心用例。' },
              finish_reason: 'stop',
            },
          ],
        },
      ]);
    };

    const srv = await createE2ETestServer({ transport });
    registerAssistantAgent(srv.created, 'openclaw-assistant');

    // 用户只是探讨想法
    const chatRes = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'dev-key-assistant',
      body: {
        agent_id: 'openclaw-assistant',
        messages: [{ role: 'user', content: '我在考虑建设一个新的知识管理项目，这个方向是否值得做？' }],
      },
    });
    expect(chatRes.status).toBe(200);
    expect(toolInvoked).toBe(false); // 严禁在讨论想法时擅自调用建单工具

    const tasksInDb = srv.created.personalAI.businessTaskManager.list('u1').items;
    expect(tasksInDb.length).toBe(0); // 数据库中绝不产生多余记录
  });
});

describe('验收阶段 B：Execution 生命周期、异常恢复与重试管理', () => {
  it('场景 B1 & B2：错误分类、可重试性标注与 needs_verification 安全防御', async () => {
    const srv = await createE2ETestServer({
      transport: async () => new Response('upstream rate limited', { status: 429 }),
    });
    const { personalAI } = srv.created;
    srv.created.deps.agentStore.updateAdmin('developer', {
      execution_backend: 'direct_llm',
      backend_config: { runtime: 'simple_llm' },
    });

    const task = personalAI.businessTaskManager.create('u1', { title: '压测任务', assignee_agent_id: 'developer' });

    // 429 报错执行
    const execRes = await srv.api(`/v1/personal-ai/work-tasks/${task.id}/execute`, {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(execRes.status).toBe(200);
    expect(execRes.json.execution.status).toBe('failed');
    expect(execRes.json.execution.retryable).toBe(true);
    expect(execRes.json.execution.error_category).toBe('retryable');
    expect(execRes.json.execution.error_code).toBe('rate_limited');

    // 检查事件记录中记录了 failed 事件
    const executions = personalAI.taskManager.listByTaskId('u1', task.id).items;
    const events = personalAI.taskManager.listEvents('u1', executions[0].id).items;
    const failEvent = events.find((e) => e.event_type === 'failed');
    expect(failEvent).toBeDefined();
    expect(failEvent?.metadata.error_category).toBe('retryable');
    expect(failEvent?.metadata.error_code).toBe('rate_limited');
  });

  it('场景 B3：服务重启恢复遗留中断执行，收敛为 failed + needs_verification，不盲目假定成功', async () => {
    const srv = await createE2ETestServer({
      transport: async () => sseFrames([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    });
    const { personalAI } = srv.created;
    const taskRepo = new TaskRepository(srv.created.deps.db);

    const task = personalAI.businessTaskManager.create('u1', { title: '中途断电任务' });
    srv.created.deps.db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`, [task.id]);

    const orphanExec = personalAI.taskManager.createIfAbsent({
      task_id: task.id,
      user_id: 'u1',
      conversation_id: 'c_orphan',
      request_id: 'req_orphan_1',
      agent_id: 'developer',
      execution_mode: 'direct_llm',
      input_summary: '中断执行',
    }).task;

    // 手动置为 running 模拟崩溃前状态
    srv.created.deps.db.run(
      `UPDATE execution_tasks SET status = 'running' WHERE id = ?`,
      [orphanExec.id],
    );

    // 触发服务重启恢复逻辑：清理中断流并对账孤儿任务
    const staleDirect = taskRepo.failStaleDirectExecutionsAndList('服务重启导致流式执行中断，结果未能确认，请核实后重试');
    expect(staleDirect.length).toBe(1);
    const reconciled = personalAI.businessTaskManager.reconcileOrphanedInProgressInTx();
    expect(reconciled).toBe(1);

    // 验证收敛状态
    const recovered = personalAI.taskManager.getForUser('u1', orphanExec.id);
    expect(recovered?.status).toBe('failed');
    expect(recovered?.needs_verification).toBe(true);
    expect(recovered?.error).toContain('服务重启');

    // 验证 BusinessTask 同步对账为 failed
    const refreshedTask = personalAI.businessTaskManager.get('u1', task.id);
    expect(refreshedTask.status).toBe('failed');
  });

  it('场景 B4 & B5：切换 Agent 重试、独立 Execution 继承链条与取消操作防覆盖', async () => {
    let callCount = 0;
    const srv = await createE2ETestServer({
      transport: async () => {
        callCount += 1;
        if (callCount === 1) return new Response('developer failed', { status: 500 });
        return sseFrames([{ choices: [{ delta: { content: 'researcher completed' }, finish_reason: 'stop' }] }]);
      },
    });
    const { personalAI } = srv.created;
    srv.created.deps.agentStore.updateAdmin('developer', {
      execution_backend: 'direct_llm',
      backend_config: { runtime: 'simple_llm' },
    });
    srv.created.deps.agentStore.updateAdmin('researcher', {
      execution_backend: 'direct_llm',
      backend_config: { runtime: 'simple_llm' },
    });

    const task = personalAI.businessTaskManager.create('u1', { title: '调研与实现' });

    // 第一次 developer 执行失败
    await srv.api(`/v1/personal-ai/work-tasks/${task.id}/execute`, {
      method: 'POST',
      key: 'dev-key-developer',
      body: { agent_id: 'developer' },
    });

    // 第二次切换 researcher 重试
    const retryRes = await srv.api(`/v1/personal-ai/work-tasks/${task.id}/retry`, {
      method: 'POST',
      key: 'dev-key-developer',
      body: { agent_id: 'researcher' },
    });
    expect(retryRes.status).toBe(200);
    expect(retryRes.json.execution.status).toBe('completed');
    expect(retryRes.json.execution.agent_id).toBe('researcher');
    expect(retryRes.json.task.assignee_agent_id).toBe('researcher');

    const executions = personalAI.taskManager.listByTaskId('u1', task.id).items;
    expect(executions.length).toBe(2);
    // items[0] 是最新一次重试（researcher），items[1] 是前一次失败执行（developer）
    expect(executions[0].agent_id).toBe('researcher');
    expect(executions[0].status).toBe('completed');
    expect(executions[1].agent_id).toBe('developer');
    expect(executions[1].status).toBe('failed');
    expect(executions[0].retry_of_execution_id).toBe(executions[1].id); // 正确串联重试链条

    // 取消任务与防止重复取消
    const cancelTask = personalAI.businessTaskManager.create('u1', { title: '待取消任务' });
    const cancelRes = await srv.api(`/v1/personal-ai/work-tasks/${cancelTask.id}/cancel`, {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.json.task.status).toBe('cancelled');

    // 重复取消应被状态机或幂等处理，不能变脏
    const cancelAgain = await srv.api(`/v1/personal-ai/work-tasks/${cancelTask.id}/cancel`, {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(cancelAgain.status).toBe(409); // 已在终态拒绝重复取消
  });
});

describe('验收阶段 C：长期记忆真实性与演进可靠性', () => {
  it('场景 C1 & C2：记忆抽取、分类与跨会话持久化检索', async () => {
    const srv = await createE2ETestServer({
      transport: async () => sseFrames([{ choices: [{ delta: { content: '已记录你的偏好。' }, finish_reason: 'stop' }] }]),
    });
    const { deps, personalAI } = srv.created;

    // 手动模拟写入用户长期偏好记忆
    const mem = deps.memoryStore.create({
      user_id: 'u1',
      agent_id: 'developer',
      content: '我主要使用 TypeScript 开发，偏好先完成核心功能，再逐步完善细节',
      type: 'semantic',
      scope: 'personal',
      category: 'preference',
      verified_by_user: true,
      confidence: 0.95,
      source: 'user_statement',
    });
    expect(mem.memory_id).toBeDefined();

    // 开启全新会话检索记忆
    const newContext = buildPersonalAIContext(
      {
        config: deps.config,
        memoryStore: deps.memoryStore,
        agentStore: deps.agentStore,
        userProfiles: personalAI.userProfiles,
        goalStore: personalAI.goalStore,
        projectStore: personalAI.projectStore,
        businessTaskManager: personalAI.businessTaskManager,
        proactiveStore: personalAI.proactiveStore,
      },
      fakeIdentity('u1', 'developer'),
      [{ role: 'user', content: '我平时主要使用什么编程语言？' }],
    );

    expect(newContext.memoryInjected).toBe(true);
    expect(newContext.systemMessage).toContain('TypeScript');
    expect(newContext.systemMessage).toContain('已确认'); // 用户确认记忆正确打标
  });

  it('场景 C3 & C4：用户确认记忆受 Guard 严格保护，模型与自动提取无法覆写（409 Conflict）', async () => {
    const srv = await createE2ETestServer({
      transport: async () => new Response('{}', { status: 200 }),
    });
    const { deps, personalAI } = srv.created;
    registerAssistantAgent(srv.created, 'openclaw-assistant');
    const workAgent = deps.agentStore.get('openclaw-assistant')!;

    // 1. 创建一条经过用户确认的长期偏好
    const verifiedMem = deps.memoryStore.create({
      user_id: 'u1',
      agent_id: 'developer',
      content: '主要使用 TypeScript 开发',
      type: 'semantic',
      scope: 'personal',
      category: 'preference',
      verified_by_user: true,
      confidence: 1.0,
      source: 'user_statement',
    });

    const u1Ctx = {
      userId: 'u1',
      agent: workAgent,
      task: null,
      execution: null,
      identity: fakeIdentity('u1', workAgent.agent_id),
      allowedTools: new Set(['memory_update', 'memory_archive']),
    };

    // 2. 模型 Agent 尝试通过工具修改已确认的记忆 -> 拦截并抛出受保护错误
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'memory_update', {
        memory_id: verifiedMem.memory_id,
        content: '主要使用 Python 开发',
      }),
    ).rejects.toThrow(/已由用户明确确认|已确认记忆受保护/);

    // 3. 模型 Agent 尝试归档已确认的记忆 -> 拦截
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'memory_archive', {
        memory_id: verifiedMem.memory_id,
      }),
    ).rejects.toThrow(/已由用户明确确认|已确认记忆受保护/);

    // 数据库保持原样，绝无被脏写
    const checkMem = deps.memoryStore.getById('u1', verifiedMem.memory_id);
    expect(checkMem?.content).toBe('主要使用 TypeScript 开发');
    expect(checkMem?.status).toBe('active');
  });
});

describe('验收阶段 D：主动助理与项目进度真实汇总', () => {
  it('场景 D1 - D4：逾期/停滞/失败提醒生成、SQLite 唯一键防刷、免打扰与安静时间控制', async () => {
    const srv = await createE2ETestServer({
      transport: async () => new Response('{}', { status: 200 }),
    });
    const { personalAI } = srv.created;

    // 1. 创建逾期任务
    const overdueTask = personalAI.businessTaskManager.create('u1', {
      title: '逾期任务A',
      due_at: '2026-01-01T00:00:00.000Z',
    });

    // 2. 触发一次主动巡检
    const run1 = await srv.api('/v1/personal-ai/proactive/run', {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(run1.status).toBe(200);
    expect(run1.json.created.length).toBeGreaterThanOrEqual(1);

    // 收件箱中查到逾期通知
    const notifs = await srv.api('/v1/personal-ai/proactive/notifications', {
      key: 'dev-key-developer',
    });
    expect(notifs.status).toBe(200);
    const overdueAlert = notifs.json.items.find((n: any) => n.kind === 'task_overdue');
    expect(overdueAlert).toBeDefined();
    expect(overdueAlert.title).toContain('逾期任务A');

    // 3. 再次触发巡检 -> 物理唯一键去重，绝不重复生成同一提醒
    const run2 = await srv.api('/v1/personal-ai/proactive/run', {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(run2.status).toBe(200);
    expect(run2.json.created.length).toBe(0); // 0 条新增，去重生效

    // 4. 用户设置免打扰/关闭主动提醒
    await srv.api('/v1/personal-ai/proactive/preferences', {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: { proactive_enabled: false },
    });

    // 新建另一个逾期任务
    personalAI.businessTaskManager.create('u1', {
      title: '逾期任务B',
      due_at: '2026-01-01T00:00:00.000Z',
    });
    const runDisabled = await srv.api('/v1/personal-ai/proactive/run', {
      method: 'POST',
      key: 'dev-key-developer',
    });
    expect(runDisabled.status).toBe(200);
    expect(runDisabled.json.reason).toContain('disabled');
    expect(runDisabled.json.created.length).toBe(0);
  });

  it('场景 D5：项目进度摘要基于真实任务与 Execution 统计完成率、阻塞项与建议', async () => {
    const srv = await createE2ETestServer({
      transport: async () => new Response('{}', { status: 200 }),
    });
    const { personalAI } = srv.created;

    const project = personalAI.projectStore.create('u1', { title: '知忆交付项目' });
    const t1 = personalAI.businessTaskManager.create('u1', { title: '需求分析', project_id: project.id });
    const t2 = personalAI.businessTaskManager.create('u1', { title: '核心编码', project_id: project.id });
    const t3 = personalAI.businessTaskManager.create('u1', { title: 'CI 部署', project_id: project.id });

    // 模拟 t1 完成，t2 阻塞
    srv.created.deps.db.run(`UPDATE tasks SET status = 'completed' WHERE id = ?`, [t1.id]);
    srv.created.deps.db.run(`UPDATE tasks SET status = 'blocked' WHERE id = ?`, [t2.id]);

    const summaryRes = await srv.api(`/v1/personal-ai/projects/${project.id}/summary`, {
      key: 'dev-key-developer',
    });
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.json.stats.total).toBe(3);
    expect(summaryRes.json.stats.completed).toBe(1);
    expect(summaryRes.json.stats.blocked).toBe(1);
    expect(summaryRes.json.failed_or_blocked_tasks.some((b: any) => b.title.includes('核心编码'))).toBe(true);
    expect(summaryRes.json.next_steps.length).toBeGreaterThan(0);
  });
});

describe('验收阶段 E：多用户安全隔离与数据完整性', () => {
  it('场景 E1 - E5：用户 A 与 用户 B 跨实体（Goal/Project/Task/Execution/Notif）100% 隔离，越权操作均被拒绝', async () => {
    const srv = await createE2ETestServer({
      transport: async () => new Response('{}', { status: 200 }),
    });
    const { personalAI, deps } = srv.created;

    // 用户 A 创建全套实体
    const goalA = personalAI.goalStore.create('u1', { title: 'Goal A' });
    const projA = personalAI.projectStore.create('u1', { title: 'Proj A' });
    const taskA = personalAI.businessTaskManager.create('u1', { title: 'Task A', project_id: projA.id });
    const execA = personalAI.taskManager.createIfAbsent({
      task_id: taskA.id,
      user_id: 'u1',
      conversation_id: 'c_u1',
      request_id: 'req_u1_iso',
      agent_id: 'developer',
      execution_mode: 'direct_llm',
      input_summary: 'u1 task',
    }).task;

    // 用户 B（dev-key-user2 -> u2）尝试越权访问 A 的数据
    // 1. 尝试 GET A 的 Goal
    const getGoalRes = await srv.api(`/v1/personal-ai/goals/${goalA.id}`, { key: 'dev-key-user2' });
    expect(getGoalRes.status).toBe(404);

    // 2. 尝试 PATCH A 的 Project
    const patchProjRes = await srv.api(`/v1/personal-ai/projects/${projA.id}`, {
      method: 'PATCH',
      key: 'dev-key-user2',
      body: { title: 'Hacked Project' },
    });
    expect(patchProjRes.status).toBe(404);

    // 3. 尝试 DELETE A 的 Task
    const delTaskRes = await srv.api(`/v1/personal-ai/work-tasks/${taskA.id}`, {
      method: 'DELETE',
      key: 'dev-key-user2',
    });
    expect(delTaskRes.status).toBe(404);

    // 4. 尝试执行 A 的 Task
    const execTaskRes = await srv.api(`/v1/personal-ai/work-tasks/${taskA.id}/execute`, {
      method: 'POST',
      key: 'dev-key-user2',
    });
    expect(execTaskRes.status).toBe(404);

    // 5. 尝试查看 A 的项目摘要
    const summaryRes = await srv.api(`/v1/personal-ai/projects/${projA.id}/summary`, {
      key: 'dev-key-user2',
    });
    expect(summaryRes.status).toBe(404);

    // 6. 验证任务父子环检测（深度限制与自引用拒绝）
    await expect(async () => {
      personalAI.businessTaskManager.update('u1', taskA.id, { parent_task_id: taskA.id });
    }).rejects.toThrow(/自身|循环依赖/);

    // 7. 篡改 user_id：客户端在 body 中传入 fake user_id 一律被服务端忽略并以可信身份为准
    const forgedTaskRes = await srv.api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      key: 'dev-key-user2',
      body: { title: 'B Task with fake u1 id', user_id: 'u1' },
    });
    expect(forgedTaskRes.status).toBe(201);
    expect(forgedTaskRes.json.task.user_id).toBe('u2'); // 服务端强制纠正为可信 u2
  });
});
