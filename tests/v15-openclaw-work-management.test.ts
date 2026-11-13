/**
 * 知忆下一阶段：Personal AI 自然语言工作管理（OpenClaw Tool Gateway + 统一业务层 + 实时权限校验）完整测试。
 *
 * 覆盖：
 * 1. task_create 正常创建任务（默认 pending，不自动执行）
 * 2. task_detail 正常查询任务详情（状态、优先级、负责人、所属项目、子任务、最近 Execution）
 * 3. task_update 正常修改任务标题/描述/优先级/项目/合法状态
 * 4. project_list（状态过滤与分页）、project_create/update、goal_create/update
 * 5. 不同用户之间严格数据隔离（跨用户查询/修改/关联/参数伪造 user_id 均被拒绝）
 * 6. Agent 无权调用工具时拒绝执行（含运行中管理员动态收权）
 * 7. Agent 被禁用后无法继续使用工具（含运行中 Turn 1 后管理员禁用，Turn 2 立即拦截）
 * 8. 不存在或非活跃的项目 / Agent 被正确拒绝
 * 9. 非法任务状态转换（直连 completed/failed/in_progress/cancelled 或修改终态）被状态机拒绝
 * 10. 用户仅讨论想法时模型不擅自创建任务
 * 11-12. 工具结果正确回填 OpenClaw Agent，且多轮对话中连续查询和修改工作事项
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { loadPersonalAIConfig, type PersonalAIConfig } from '../src/personal-ai/config';
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

async function createWorkTestServer(options: {
  transport: UpstreamTransport;
  personalAIConfig?: PersonalAIConfig;
}) {
  const cfg: AppConfig = {
    ...loadConfig({}),
    databaseUrl: ':memory:',
    mockUpstream: false,
    upstreamBaseUrl: 'http://mock-openclaw-work.invalid/v1',
    upstreamApiKey: 'sk-work-secret-key',
    defaultModel: 'zhiyi-work-model',
    upstreamTimeoutMs: 2500,
    logSilent: true,
  };
  const created: CreatedApp = await createApp(cfg, {
    silent: true,
    settingsPath: null,
    adminToken: 'admin-token-work',
    transport: options.transport,
    upstreamSettings: null,
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
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // 非 JSON 响应忽略
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

function registerWorkAgent(
  created: CreatedApp,
  agentId = 'openclaw-work',
  allowedTools?: string[],
): void {
  created.deps.agentStore.create({
    agent_id: agentId,
    name: `Work Assistant ${agentId}`,
    role: '个人工作助理',
    description: '协助查询、创建与维护用户的目标、项目和业务任务',
    core_memory: '工作管理',
  });
  created.deps.agentStore.updateAdmin(agentId, {
    execution_backend: 'direct_llm',
    backend_config: allowedTools
      ? { runtime: 'openclaw', allowed_tools: allowedTools, max_turns: 8, tool_execution: 'sequential' }
      : { runtime: 'openclaw', max_turns: 8, tool_execution: 'sequential' },
    instructions: '严格按工作管理工具准则操作用户的工作事项。',
    capabilities: ['tasks', 'projects', 'goals', 'openclaw'],
  });
}

function fakeIdentity(userId: string, agentId: string) {
  return {
    user_id: userId,
    agent_id: agentId,
    api_key: null,
    from_default: false,
    request_id: `req_${Date.now()}_${Math.random()}`,
    session_id: null,
    task_id: null,
    project_id: null,
    conversation_id: 'conv_test',
    signature_verified: false,
  };
}

describe('Personal AI 工作管理：Tool Gateway、统一业务层与实时权限', () => {
  it('直接验证 project_list/create/update、goal_create/update、task_create/detail/update 与数据隔离/参数校验/状态机/权限边界', async () => {
    const srv = await createWorkTestServer({
      transport: async () => new Response('{}', { status: 200 }),
    });
    const { personalAI, deps } = srv.created;
    registerWorkAgent(srv.created, 'openclaw-work');
    registerWorkAgent(srv.created, 'openclaw-readonly', ['task_list', 'project_list', 'task_detail']);

    const workAgent = deps.agentStore.get('openclaw-work')!;
    const roAgent = deps.agentStore.get('openclaw-readonly')!;
    const dummyTask = personalAI.businessTaskManager.create('u1', { title: '追踪会话上下文' });
    const dummyExec = personalAI.taskManager.createIfAbsent({
      task_id: dummyTask.id,
      user_id: 'u1',
      conversation_id: 'c1',
      request_id: 'r_ctx',
      agent_id: workAgent.agent_id,
      execution_mode: 'direct_llm',
      input_summary: 'ctx',
    }).task;

    const u1Ctx = {
      userId: 'u1',
      agent: workAgent,
      task: dummyTask,
      execution: dummyExec,
      identity: fakeIdentity('u1', workAgent.agent_id),
      allowedTools: new Set(personalAI.toolGateway.listRegisteredTools().map((t) => t.name)),
    };

    // 1. goal_create + goal_update
    const goalCreated = await personalAI.toolGateway.executeTool(u1Ctx, 'goal_create', {
      title: '完成个人 AI 工作台',
      priority: 1,
    });
    const createdGoalId = (goalCreated.details?.goal as { id: string }).id;
    expect(goalCreated.text).toContain(createdGoalId);

    const goalUpdated = await personalAI.toolGateway.executeTool(u1Ctx, 'goal_update', {
      goal_id: createdGoalId,
      priority: 3,
      status: 'active',
    });
    expect(goalUpdated.text).toContain('P3');

    // 2. project_create + project_list（支持状态过滤与分页）+ project_update
    const proj1Res = await personalAI.toolGateway.executeTool(u1Ctx, 'project_create', {
      title: '个人 AI 助手',
      description: '整合记忆与 OpenClaw',
      goal_ids: [createdGoalId],
    });
    const proj1Id = (proj1Res.details?.project as { id: string }).id;
    await personalAI.toolGateway.executeTool(u1Ctx, 'project_create', {
      title: '已暂停项目',
      status: 'paused',
    });

    // u2 创建同名隐私项目，u1 绝不能看到
    const u2Proj = personalAI.projectStore.create('u2', { title: 'U2 机密项目' });
    const u2Task = personalAI.businessTaskManager.create('u2', {
      title: 'U2 机密任务',
      project_id: u2Proj.id,
    });

    const activeProjList = await personalAI.toolGateway.executeTool(u1Ctx, 'project_list', {
      status: 'active',
      limit: 1,
      offset: 0,
    });
    expect((activeProjList.details as { total: number }).total).toBe(1);
    expect(activeProjList.text).toContain('个人 AI 助手');
    expect(activeProjList.text).not.toContain('U2 机密项目');

    await personalAI.toolGateway.executeTool(u1Ctx, 'project_update', {
      project_id: proj1Id,
      description: '已更新项目描述',
    });

    // 3. task_create（默认 pending，不自动执行）+ 子任务 + 执行记录 + task_detail
    const taskCreated = await personalAI.toolGateway.executeTool(u1Ctx, 'task_create', {
      title: 'OpenClaw 集成',
      description: '补齐工作管理工具',
      priority: 2,
      project_id: proj1Id,
      assignee_agent_id: 'openclaw-work',
    });
    const mainTask = taskCreated.details?.task as { id: string; status: string };
    expect(mainTask.status).toBe('pending');
    expect(personalAI.businessTaskManager.listExecutions('u1', mainTask.id)?.items ?? []).toHaveLength(0);

    await personalAI.toolGateway.executeTool(u1Ctx, 'task_create', {
      title: '编写集成测试',
      parent_task_id: mainTask.id,
      project_id: proj1Id,
    });

    // 触发一次真实 Execution 记录，验证 task_detail 返回最新 Execution 信息
    const prepExec = personalAI.businessTaskManager.prepareExecution('u1', mainTask.id, {
      agentId: 'openclaw-work',
      multicaEnabled: false,
    });
    personalAI.businessTaskManager.finishDirectExecution(prepExec.execution.id, {
      status: 'completed',
      result: '第一阶段联调已完成',
    });

    const detailRes = await personalAI.toolGateway.executeTool(u1Ctx, 'task_detail', {
      task_id: mainTask.id,
    });
    expect(detailRes.text).toContain('OpenClaw 集成');
    expect(detailRes.text).toContain('个人 AI 助手');
    expect(detailRes.text).toContain('openclaw-work');
    expect(detailRes.text).toContain('编写集成测试');
    expect(detailRes.text).toContain(prepExec.execution.id);
    expect(detailRes.text).toContain('第一阶段联调已完成');

    // 4. task_update 正常修改允许字段与合法状态
    const editableTask = personalAI.businessTaskManager.create('u1', {
      title: '数据库迁移',
      priority: 1,
      project_id: proj1Id,
    });
    const updatedTask = await personalAI.toolGateway.executeTool(u1Ctx, 'task_update', {
      task_id: editableTask.id,
      priority: 4,
      status: 'ready',
      title: '数据库迁移与索引校验',
    });
    expect((updatedTask.details?.task as { priority: number; status: string; title: string })).toMatchObject({
      priority: 4,
      status: 'ready',
      title: '数据库迁移与索引校验',
    });

    // 5. 数据隔离与跨用户越权拒绝
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_detail', { task_id: u2Task.id }),
    ).rejects.toThrow(/不存在或无权访问/);
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_update', { task_id: u2Task.id, priority: 4 }),
    ).rejects.toThrow(/不存在或无权访问/);
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'project_update', { project_id: u2Proj.id, title: '篡改' }),
    ).rejects.toThrow(/不存在或无权访问/);
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_create', {
        title: '跨用户挂载项目',
        project_id: u2Proj.id,
      }),
    ).rejects.toThrow(/不存在或无权访问/);
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_list', { user_id: 'u2' }),
    ).rejects.toThrow(/禁止跨用户访问/);

    // 6. 不存在的项目或不存在/已禁用 Agent 被拒绝
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_create', {
        title: '坏项目任务',
        project_id: 'proj_non_existent',
      }),
    ).rejects.toThrow(/关联项目不存在或无权访问/);
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_create', {
        title: '坏负责人任务',
        assignee_agent_id: 'ghost-agent',
      }),
    ).rejects.toThrow(/Agent.*不存在/);

    deps.agentStore.create({
      agent_id: 'disabled-worker',
      name: 'Disabled',
      role: 'r',
      description: 'd',
      core_memory: 'm',
    });
    deps.agentStore.updateAdmin('disabled-worker', { status: 'disabled' });
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_create', {
        title: '指派给禁用Agent',
        assignee_agent_id: 'disabled-worker',
      }),
    ).rejects.toThrow(/已禁用/);

    // 7. 非法任务状态转换被现有状态机拒绝
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_update', {
        task_id: editableTask.id,
        status: 'completed',
      }),
    ).rejects.toThrow(/Execution 终态/);
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_update', {
        task_id: editableTask.id,
        status: 'in_progress',
      }),
    ).rejects.toThrow(/执行接口/);
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_update', {
        task_id: editableTask.id,
        status: 'cancelled',
      }),
    ).rejects.toThrow(/取消接口/);
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_update', {
        task_id: mainTask.id,
        status: 'ready',
      }),
    ).rejects.toThrow(/不允许从 completed/);

    // 8. 只读 Agent 无权调用 task_create
    const roCtx = {
      ...u1Ctx,
      agent: roAgent,
      allowedTools: new Set(['task_list', 'project_list', 'task_detail']),
    };
    await expect(
      personalAI.toolGateway.executeTool(roCtx, 'task_create', { title: '越权创建' }),
    ).rejects.toThrow(/无权调用工具 task_create/);

    // 9. 运行期管理员动态收权与禁用 Agent，立即生效（不依赖旧初始化快照）
    deps.agentStore.updateAdmin('openclaw-work', {
      backend_config: { runtime: 'openclaw', allowed_tools: ['task_list'] },
    });
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_create', { title: '收权后尝试创建' }),
    ).rejects.toThrow(/无权调用工具 task_create/);

    deps.agentStore.updateAdmin('openclaw-work', { status: 'disabled' });
    await expect(
      personalAI.toolGateway.executeTool(u1Ctx, 'task_list', {}),
    ).rejects.toThrow(/已禁用/);
  });

  it('OpenClaw 多轮对话：Turn 1 创建项目 -> Turn 2 连续查询并提升任务优先级，且讨论想法时不擅自建单', async () => {
    const calls: RecordedModelCall[] = [];
    let createdProjectIdForCheck = '';
    let createdTaskIdForCheck = '';

    const transport: UpstreamTransport = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as RecordedModelCall;
      calls.push(parsed);

      const userMessages = parsed.messages.filter((m) => m.role === 'user');
      const lastUser = String(userMessages[userMessages.length - 1]?.content ?? '');
      const hasToolResult = parsed.messages.some((m) => m.role === 'tool');
      const toolResults = parsed.messages.filter((m) => m.role === 'tool');

      // 场景 A：用户仅讨论想法 -> 不调用写入工具，直接给建议
      if (lastUser.includes('怎么看') && !hasToolResult) {
        return sseFrames([
          { choices: [{ delta: { content: '插件化是个不错的方向，建议先梳理扩展点契约。如需正式立项请告诉我。' }, finish_reason: 'stop' }] },
        ]);
      }

      // 场景 B（对话轮次 1）：创建项目“个人 AI 助手”，然后新建任务“OpenClaw 集成”与“数据库迁移”
      if (lastUser.includes('创建项目') && toolResults.length === 0) {
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
                        arguments: JSON.stringify({ title: '个人 AI 助手', description: '核心工作台' }),
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

      if (toolResults.length === 1 && toolResults[0].name === 'project_create') {
        const match = String(toolResults[0].content).match(/proj_[a-f0-9-]+/);
        createdProjectIdForCheck = match ? match[0] : '';
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_t_create',
                      type: 'function',
                      function: {
                        name: 'task_create',
                        arguments: JSON.stringify({
                          title: '数据库迁移',
                          project_id: createdProjectIdForCheck,
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

      if (toolResults.length === 2 && toolResults[1].name === 'task_create') {
        const match = String(toolResults[1].content).match(/btask_[a-f0-9-]+/);
        createdTaskIdForCheck = match ? match[0] : '';
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  content: `已创建项目「个人 AI 助手」(${createdProjectIdForCheck})，并记录任务「数据库迁移」(${createdTaskIdForCheck})。`,
                },
                finish_reason: 'stop',
              },
            ],
          },
        ]);
      }

      // 场景 C（对话轮次 2，带多轮历史）：查询未完成任务与详情，并把优先级提高到 P4
      if (lastUser.includes('优先级提高') && toolResults.length === 0) {
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
                        arguments: JSON.stringify({ project_id: createdProjectIdForCheck }),
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

      if (toolResults.length === 1 && toolResults[0].name === 'task_list') {
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
                        arguments: JSON.stringify({ task_id: createdTaskIdForCheck, priority: 4 }),
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

      if (toolResults.length === 2 && toolResults[1].name === 'task_update') {
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  content: `已将任务「数据库迁移」(${createdTaskIdForCheck}) 的优先级提升为 P4。`,
                },
                finish_reason: 'stop',
              },
            ],
          },
        ]);
      }

      return sseFrames([{ choices: [{ delta: { content: '已完成处理。' }, finish_reason: 'stop' }] }]);
    };

    const basePersonal = loadPersonalAIConfig({});
    const srv = await createWorkTestServer({
      transport,
      personalAIConfig: {
        ...basePersonal,
        apiKeys: {
          ...basePersonal.apiKeys,
          'openclaw-work-u1': { user_id: 'u1', agent_id: 'openclaw-work' },
        },
      },
    });
    registerWorkAgent(srv.created, 'openclaw-work', [
      'project_list',
      'project_create',
      'task_list',
      'task_detail',
      'task_create',
      'task_update',
    ]);

    // 1. 用户仅探讨想法 -> 模型未擅自创建任何业务项目或额外任务
    const chatIdea = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'openclaw-work-u1',
      headers: { 'x-request-id': 'req-idea-1' },
      body: {
        messages: [{ role: 'user', content: '我在想要不要以后做个插件系统，你怎么看？' }],
        stream: false,
      },
    });
    expect(chatIdea.status).toBe(200);
    expect((chatIdea.json as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toContain('不错的方向');
    expect(srv.created.personalAI.projectStore.list('u1').items).toHaveLength(0);

    // 2. 第一轮对话：明确要求创建项目“个人 AI 助手”及任务“数据库迁移”
    const turn1Msg = { role: 'user' as const, content: '帮我创建项目「个人 AI 助手」，并在下面建一个「数据库迁移」任务。' };
    const turn1Res = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'openclaw-work-u1',
      headers: { 'x-request-id': 'req-multi-1' },
      body: {
        messages: [turn1Msg],
        stream: false,
      },
    });
    expect(turn1Res.status).toBe(200);
    const turn1Reply = (turn1Res.json as { choices: Array<{ message: { content: string } }> }).choices[0].message.content;
    expect(turn1Reply).toContain('个人 AI 助手');
    expect(turn1Reply).toContain(createdTaskIdForCheck);

    // 验证真实落库且未自动执行该业务任务
    const dbProj = srv.created.personalAI.projectStore.get('u1', createdProjectIdForCheck);
    const dbTask = srv.created.personalAI.businessTaskManager.get('u1', createdTaskIdForCheck);
    expect(dbProj?.title).toBe('个人 AI 助手');
    expect(dbTask?.status).toBe('pending');
    expect(dbTask?.priority).toBe(1);

    // 3. 第二轮对话（携带上一轮历史 messages）：连续查询并把“数据库迁移”优先级提升到 P4
    const turn2Res = await srv.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'openclaw-work-u1',
      headers: { 'x-request-id': 'req-multi-2' },
      body: {
        messages: [
          turn1Msg,
          { role: 'assistant', content: turn1Reply },
          { role: 'user', content: '查一下这个项目的任务，把数据库迁移任务的优先级提高到 P4。' },
        ],
        stream: false,
      },
    });
    expect(turn2Res.status).toBe(200);
    const turn2Reply = (turn2Res.json as { choices: Array<{ message: { content: string } }> }).choices[0].message.content;
    expect(turn2Reply).toContain('P4');

    // 验证 OpenClaw 系统提示中包含工作管理工具使用准则，且 Turn 2 真正收到了 Turn 1 历史对话
    const turn2ModelCall = calls[calls.length - 1];
    expect(String(turn2ModelCall.messages[0].content)).toContain('[工作管理工具使用准则]');
    expect(
      turn2ModelCall.messages.some(
        (m) => m.role === 'user' && String(m.content).includes('创建项目「个人 AI 助手」'),
      ),
    ).toBe(true);

    const dbTaskAfter = srv.created.personalAI.businessTaskManager.get('u1', createdTaskIdForCheck);
    expect(dbTaskAfter?.priority).toBe(4);
  });

  it('运行中（Turn 1 后、Turn 2 前）管理员禁用 Agent 或撤回工具权限，第二轮工具调用立即被实时策略拦截', async () => {
    let srvHandle!: Awaited<ReturnType<typeof createWorkTestServer>>;
    let step = 0;

    const transport: UpstreamTransport = async () => {
      step += 1;
      if (step === 1) {
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c1', type: 'function', function: { name: 'task_list', arguments: '{}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }
      if (step === 2) {
        // Turn 1 工具刚执行完，在 Turn 2 发起前，模拟管理员实时禁用 Agent！
        srvHandle.created.deps.agentStore.updateAdmin('openclaw-dynamic', { status: 'disabled' });
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'c2',
                      type: 'function',
                      function: { name: 'task_create', arguments: '{"title":"禁用后不该建成的任务"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }
      return sseFrames([{ choices: [{ delta: { content: '工具调用被拦截。' }, finish_reason: 'stop' }] }]);
    };

    const basePersonal = loadPersonalAIConfig({});
    srvHandle = await createWorkTestServer({
      transport,
      personalAIConfig: {
        ...basePersonal,
        apiKeys: {
          ...basePersonal.apiKeys,
          'openclaw-dyn-key': { user_id: 'u1', agent_id: 'openclaw-dynamic' },
        },
      },
    });
    registerWorkAgent(srvHandle.created, 'openclaw-dynamic', ['task_list', 'task_create']);

    const res = await srvHandle.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'openclaw-dyn-key',
      headers: { 'x-request-id': 'req-dyn-revoke' },
      body: {
        messages: [{ role: 'user', content: '先查任务，然后创建一个新任务' }],
        stream: false,
      },
    });
    expect(res.status).toBe(200);
    // 被禁用后 task_create 不得落库
    const tasks = srvHandle.created.personalAI.businessTaskManager.list('u1').items;
    expect(tasks.some((t) => t.title === '禁用后不该建成的任务')).toBe(false);

    // 禁用后再次发起请求直接被运行时拒绝
    const blockedAfter = await srvHandle.api('/v1/personal-ai/chat/completions', {
      method: 'POST',
      key: 'openclaw-dyn-key',
      headers: { 'x-request-id': 'req-dyn-after' },
      body: {
        messages: [{ role: 'user', content: '帮我查任务' }],
        stream: false,
      },
    });
    expect(blockedAfter.status).toBe(502);
    expect(blockedAfter.text).toContain('已禁用');
  });
});
