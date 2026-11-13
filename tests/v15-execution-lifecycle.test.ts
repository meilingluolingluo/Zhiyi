/**
 * 阶段 3：Execution 生命周期与可靠执行管理测试。
 *
 * 覆盖：
 * 1. 正常执行 + 完整 execution_events 时间线（created / started / tool_call / completed）+ OpenClaw task_executions 只读查询
 * 2. 失败分类（retryable vs non_retryable）、重复/更换 Agent 重试（保留历史与 retry_of_execution_id）、防已完成重复执行
 * 3. 并发防重（409 active_execution_exists）
 * 4. 服务重启中断恢复：direct_llm 标记 failed+needs_verification（不假定成功）、dispatching 按是否有 external_task_id 安全恢复、长时间无进展僵死收敛
 * 5. 取消终态事件与严格跨用户隔离（work-tasks/:id/events、tasks/:id/events、/retry 与 OpenClaw 工具）
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { createLogger } from '../src/logger';
import type { AgentExecutionAdapter } from '../src/personal-ai/adapters/agent/agent-adapter';
import { loadPersonalAIConfig, type PersonalAIConfig } from '../src/personal-ai/config';
import { TaskWorker } from '../src/personal-ai/worker/task-worker';
import type { UpstreamTransport } from '../src/types';

const cleanupCallbacks: Array<() => Promise<void>> = [];

afterEach(async (): Promise<void> => {
  while (cleanupCallbacks.length > 0) {
    const fn = cleanupCallbacks.pop();
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

async function startLifecycleServer(options: {
  transport: UpstreamTransport;
  personalAIConfig?: PersonalAIConfig;
  upstreamTimeoutMs?: number;
}) {
  const cfg: AppConfig = {
    ...loadConfig({}),
    databaseUrl: ':memory:',
    mockUpstream: false,
    upstreamBaseUrl: 'http://mock-stage3.invalid/v1',
    upstreamApiKey: 'sk-stage3-secret',
    defaultModel: 'zhiyi-stage3-model',
    upstreamTimeoutMs: options.upstreamTimeoutMs ?? 3000,
    logSilent: true,
  };

  const basePersonal = options.personalAIConfig ?? loadPersonalAIConfig({ MULTICA_ENABLED: 'false' });
  const effectivePersonal: PersonalAIConfig = {
    ...basePersonal,
    apiKeys: {
      ...basePersonal.apiKeys,
      'u1-default': { user_id: 'u1', agent_id: 'default' },
      'u2-default': { user_id: 'u2', agent_id: 'default' },
    },
  };

  const created: CreatedApp = await createApp(cfg, {
    silent: true,
    settingsPath: null,
    adminToken: 'admin-stage3-token',
    transport: options.transport,
    upstreamSettings: null,
    personalAIConfig: effectivePersonal,
  });

  const server = http.createServer(created.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  cleanupCallbacks.push(async (): Promise<void> => {
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
        // 非 JSON 忽略
      }
      return { status: res.status, text, json };
    },
  };
}

describe('阶段 3：Execution 生命周期与可靠执行管理', () => {
  it('正常执行追踪完整生命周期事件（含 Tool Calling），禁止重复执行已完成任务', async () => {
    let callSeq = 0;
    const transport: UpstreamTransport = async (_url, init) => {
      callSeq += 1;
      const body = JSON.parse(String(init.body ?? '{}')) as {
        messages?: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function: { name: string } }>;
      };
      const msgs = body.messages ?? [];
      const hasToolResult = msgs.some((m) => m.role === 'tool');

      if (!hasToolResult && (body.tools ?? []).some((t) => t.function.name === 'task_list')) {
        return sseFrames([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_tl_${callSeq}`,
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

      return sseFrames([
        { choices: [{ delta: { content: '已完成任务清单核查并产出方案。' }, finish_reason: 'stop' }] },
      ]);
    };

    const srv = await startLifecycleServer({ transport });
    srv.created.deps.agentStore.create({
      agent_id: 'openclaw-planner',
      name: 'OpenClaw Planner',
      role: '任务规划师',
      description: '规划与执行用户工作任务',
      core_memory: '规划',
    });
    srv.created.deps.agentStore.updateAdmin('openclaw-planner', {
      execution_backend: 'direct_llm',
      backend_config: { runtime: 'openclaw', allowed_tools: ['task_list', 'task_detail', 'task_executions'], max_turns: 4 },
    });

    const createRes = await srv.api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      key: 'u1-default',
      body: { title: '梳理发布检查清单', assignee_agent_id: 'openclaw-planner' },
    });
    expect(createRes.status).toBe(201);
    const taskId = (createRes.json as { task: { id: string } }).task.id;

    const execRes = await srv.api(`/v1/personal-ai/work-tasks/${taskId}/execute`, {
      method: 'POST',
      key: 'u1-default',
      body: {},
    });
    expect(execRes.status).toBe(200);
    const execPayload = execRes.json as {
      task: { status: string; assignee_agent_id: string };
      execution: { id: string; status: string; result: string };
    };
    expect(execPayload.task.status).toBe('completed');
    expect(execPayload.task.assignee_agent_id).toBe('openclaw-planner');
    expect(execPayload.execution.status).toBe('completed');
    expect(execPayload.execution.result).toContain('已完成任务清单核查');

    // 验证 task_detail & /events 完整保留生命周期事件
    const detailRes = await srv.api(`/v1/personal-ai/work-tasks/${taskId}`, { key: 'u1-default' });
    expect(detailRes.status).toBe(200);
    const detail = detailRes.json as {
      execution_count: number;
      lifecycle_summary: string;
      recent_events: Array<{ event_type: string }>;
    };
    expect(detail.execution_count).toBe(1);
    expect(detail.lifecycle_summary).toContain('openclaw-planner');
    const eventTypes = detail.recent_events.map((e) => e.event_type);
    expect(eventTypes).toEqual(
      expect.arrayContaining(['created', 'started', 'tool_call', 'completed']),
    );

    const execEventsRes = await srv.api(`/v1/personal-ai/tasks/${execPayload.execution.id}/events`, {
      key: 'u1-default',
    });
    expect(execEventsRes.status).toBe(200);
    expect((execEventsRes.json as { total: number }).total).toBeGreaterThanOrEqual(4);

    // 通过 OpenClaw task_executions 只读工具也能查询到完整历史与事件
    const toolResult = await srv.created.personalAI.toolGateway.executeTool(
      {
        userId: 'u1',
        agent: srv.created.deps.agentStore.get('openclaw-planner')!,
        task: srv.created.personalAI.businessTaskManager.get('u1', taskId)!,
        execution: srv.created.personalAI.taskManager.getForUser('u1', execPayload.execution.id)!,
        identity: {
          user_id: 'u1',
          agent_id: 'openclaw-planner',
          api_key: null,
          from_default: false,
          request_id: 'req-tool-inspect',
          session_id: null,
          task_id: null,
          project_id: null,
          conversation_id: 'conv-inspect',
        },
        allowedTools: new Set(['task_executions']),
      },
      'task_executions',
      { task_id: taskId },
    );
    expect(toolResult.text).toContain(execPayload.execution.id);
    expect(toolResult.text).toContain('tool_call');

    // OpenClaw 工具侧同样严格执行跨用户隔离
    await expect(
      srv.created.personalAI.toolGateway.executeTool(
        {
          userId: 'u2',
          agent: srv.created.deps.agentStore.get('openclaw-planner')!,
          task: srv.created.personalAI.businessTaskManager.get('u1', taskId)!,
          execution: srv.created.personalAI.taskManager.getForUser('u1', execPayload.execution.id)!,
          identity: {
            user_id: 'u2',
            agent_id: 'openclaw-planner',
            api_key: null,
            from_default: false,
            request_id: 'req-tool-inspect-u2',
            session_id: null,
            task_id: null,
            project_id: null,
            conversation_id: 'conv-inspect-u2',
          },
          allowedTools: new Set(['task_executions']),
        },
        'task_executions',
        { task_id: taskId },
      ),
    ).rejects.toThrow();

    // 已完成任务禁止直接重跑（防止重复执行已完成工作）
    const rerunCompleted = await srv.api(`/v1/personal-ai/work-tasks/${taskId}/retry`, {
      method: 'POST',
      key: 'u1-default',
      body: {},
    });
    expect(rerunCompleted.status).toBe(409);

    // 跨用户访问事件与重试均被严格拒绝（404）
    expect(
      (await srv.api(`/v1/personal-ai/work-tasks/${taskId}/events`, { key: 'u2-default' })).status,
    ).toBe(404);
    expect(
      (await srv.api(`/v1/personal-ai/tasks/${execPayload.execution.id}/events`, { key: 'u2-default' }))
        .status,
    ).toBe(404);
    expect(
      (await srv.api(`/v1/personal-ai/work-tasks/${taskId}/retry`, {
        method: 'POST',
        key: 'u2-default',
        body: {},
      })).status,
    ).toBe(404);
  });

  it('区分可重试/不可重试失败、更换 Agent 重试保留历史与 retry_of_execution_id，且防并发重复执行', async () => {
    let scenario: 'fail_400' | 'fail_503' | 'ok' | 'slow' = 'fail_400';

    const transport: UpstreamTransport = async (_url, init) => {
      if (scenario === 'fail_400') {
        return new Response(JSON.stringify({ error: { message: 'invalid prompt schema' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (scenario === 'fail_503') {
        return new Response(JSON.stringify({ error: { message: 'service unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (scenario === 'slow') {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 400);
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
      return sseFrames([{ choices: [{ delta: { content: '重试后执行成功！' }, finish_reason: 'stop' }] }]);
    };

    const srv = await startLifecycleServer({ transport });
    srv.created.deps.agentStore.create({
      agent_id: 'agent-a',
      name: 'Agent A',
      role: '执行器 A',
      description: '第一执行者',
      core_memory: '',
    });
    srv.created.deps.agentStore.updateAdmin('agent-a', { execution_backend: 'direct_llm' });

    srv.created.deps.agentStore.create({
      agent_id: 'agent-b',
      name: 'Agent B',
      role: '备选执行器 B',
      description: '备选执行者',
      core_memory: '',
    });
    srv.created.deps.agentStore.updateAdmin('agent-b', { execution_backend: 'direct_llm' });

    // 1. 不可重试失败（400）：同类重试拒绝，更换 Agent 允许并保留历史
    const t1Res = await srv.api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      key: 'u1-default',
      body: { title: '不可重试再换 Agent 任务', assignee_agent_id: 'agent-a' },
    });
    const t1Id = (t1Res.json as { task: { id: string } }).task.id;

    scenario = 'fail_400';
    const attempt1 = await srv.api(`/v1/personal-ai/work-tasks/${t1Id}/execute`, {
      method: 'POST',
      key: 'u1-default',
      body: {},
    });
    expect(attempt1.status).toBe(200);
    const exec1 = (attempt1.json as {
      execution: { id: string; status: string; error_category: string; retryable: boolean };
    }).execution;
    expect(exec1.status).toBe('failed');
    expect(exec1.error_category).toBe('non_retryable');
    expect(exec1.retryable).toBe(false);

    // 原 Agent 无 force_retry 重试被拦截（409 non_retryable_failure）
    const blockedSameRetry = await srv.api(`/v1/personal-ai/work-tasks/${t1Id}/retry`, {
      method: 'POST',
      key: 'u1-default',
      body: {},
    });
    expect(blockedSameRetry.status).toBe(409);
    expect(blockedSameRetry.text).toContain('non_retryable_failure');

    // 更换 agent-b 重试成功，创建独立第 2 条 Execution 且关联 retry_of_execution_id
    scenario = 'ok';
    const switchedRetry = await srv.api(`/v1/personal-ai/work-tasks/${t1Id}/retry`, {
      method: 'POST',
      key: 'u1-default',
      body: { agent_id: 'agent-b' },
    });
    expect(switchedRetry.status).toBe(200);
    const exec2 = (switchedRetry.json as {
      task: { status: string; assignee_agent_id: string };
      execution: { id: string; status: string; retry_of_execution_id: string; agent_id: string };
    }).execution;
    expect(exec2.id).not.toBe(exec1.id);
    expect(exec2.retry_of_execution_id).toBe(exec1.id);
    expect(exec2.agent_id).toBe('agent-b');
    expect(exec2.status).toBe('completed');

    const history1 = await srv.api(`/v1/personal-ai/work-tasks/${t1Id}/executions`, {
      key: 'u1-default',
    });
    expect((history1.json as { total: number }).total).toBe(2);

    const events1 = await srv.api(`/v1/personal-ai/work-tasks/${t1Id}/events`, { key: 'u1-default' });
    const eventTypes1 = (events1.json as { items: Array<{ event_type: string }> }).items.map(
      (i) => i.event_type,
    );
    expect(eventTypes1).toEqual(expect.arrayContaining(['failed', 'retried', 'completed']));

    // 2. 可重试失败（503）：允许同 Agent 直接重试，并在活跃窗口内拦截并发重复执行
    const t2Res = await srv.api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      key: 'u1-default',
      body: { title: '可重试与并发测试任务', assignee_agent_id: 'agent-a' },
    });
    const t2Id = (t2Res.json as { task: { id: string } }).task.id;

    scenario = 'fail_503';
    const transientFail = await srv.api(`/v1/personal-ai/work-tasks/${t2Id}/execute`, {
      method: 'POST',
      key: 'u1-default',
      body: {},
    });
    expect((transientFail.json as { execution: { retryable: boolean; error_category: string } }).execution).toMatchObject({
      error_category: 'retryable',
      retryable: true,
    });

    scenario = 'slow';
    const slowPromise = srv.api(`/v1/personal-ai/work-tasks/${t2Id}/retry`, {
      method: 'POST',
      key: 'u1-default',
      body: {},
    });
    await new Promise((r) => setTimeout(r, 40));

    // 执行中再次触发 execute -> 409 防并发重复执行
    const dupRes = await srv.api(`/v1/personal-ai/work-tasks/${t2Id}/execute`, {
      method: 'POST',
      key: 'u1-default',
      body: {},
    });
    expect(dupRes.status).toBe(409);

    // 取消执行中的任务 -> cancelled + 记录 cancelled 事件
    const cancelRes = await srv.api(`/v1/personal-ai/work-tasks/${t2Id}/cancel`, {
      method: 'POST',
      key: 'u1-default',
      body: {},
    });
    expect(cancelRes.status).toBe(200);
    await slowPromise;

    const cancelledEvents = await srv.api(`/v1/personal-ai/work-tasks/${t2Id}/events`, {
      key: 'u1-default',
    });
    expect(
      (cancelledEvents.json as { items: Array<{ event_type: string }> }).items.some(
        (e) => e.event_type === 'cancelled',
      ),
    ).toBe(true);
  });

  it('服务重启恢复（绝不假定未确认结果成功）及长时间无进展 Execution 僵死检测', async () => {
    const srv = await startLifecycleServer({
      transport: async () => sseFrames([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
      personalAIConfig: loadPersonalAIConfig({ MULTICA_ENABLED: 'true' }),
    });

    // 关闭默认 Worker，精准模拟跨进程重启恢复与外部 adapter
    srv.created.personalAI.worker.stop();

    srv.created.deps.agentStore.create({
      agent_id: 'direct-bot',
      name: 'Direct Bot',
      role: '直连助手',
      description: '直连执行',
      core_memory: '',
    });
    srv.created.deps.agentStore.updateAdmin('direct-bot', { execution_backend: 'direct_llm' });

    const bm = srv.created.personalAI.businessTaskManager;
    const db = srv.created.deps.db;
    const repo = new (await import('../src/personal-ai/task/task-repository')).TaskRepository(db);

    // 1. 准备 4 种跨重启状态：
    //   a) direct_llm 遗留 running -> 重启收敛为 failed + needs_verification=true（绝不标 completed）
    const tDirect = bm.create('u1', { title: '直连中断任务', assignee_agent_id: 'direct-bot' });
    const prepDirect = bm.prepareExecution('u1', tDirect.id, { multicaEnabled: true });

    //   b) agent_delegation 已建外部单但停在 dispatching -> 恢复为 running 续轮询，不重复调用 createTask
    const tHasExternal = bm.create('u1', { title: '已建外部单重启恢复', assignee_agent_id: 'developer' });
    const prepHasExternal = bm.prepareExecution('u1', tHasExternal.id, { multicaEnabled: true });
    repo.update(prepHasExternal.execution.id, {
      status: 'dispatching',
      external_task_id: 'MUL-EXIST-1',
    });

    //   c) agent_delegation 未建外部单停在 dispatching -> 安全回退 pending 重新派发
    const tPendingReset = bm.create('u1', { title: '未建外部单安全重派', assignee_agent_id: 'developer' });
    const prepPendingReset = bm.prepareExecution('u1', tPendingReset.id, { multicaEnabled: true });
    repo.claimForDispatch(prepPendingReset.execution.id, new Date().toISOString());

    //   d) 已 completed 任务 -> 重启后保持 completed，绝不重复执行
    const tAlreadyDone = bm.create('u1', { title: '已完成任务不重跑', assignee_agent_id: 'developer' });
    const prepDone = bm.prepareExecution('u1', tAlreadyDone.id, { multicaEnabled: true });
    repo.update(prepDone.execution.id, {
      status: 'completed',
      external_task_id: 'MUL-DONE-99',
      result: '历史已完成产物',
      completed_at: new Date().toISOString(),
    });
    db.run(`UPDATE tasks SET status = 'completed' WHERE id = ?`, [tAlreadyDone.id]);

    let createTaskCalls = 0;
    let pollExistCalls = 0;
    const fakeAdapter: AgentExecutionAdapter = {
      createTask: async (input) => {
        createTaskCalls += 1;
        return { externalTaskId: `MUL-NEW-${input.taskId.slice(-6)}`, status: 'running' };
      },
      assignAgent: async () => undefined,
      getTaskStatus: async (externalId) => {
        if (externalId === 'MUL-EXIST-1') {
          pollExistCalls += 1;
          return { status: 'completed', rawStatus: 'done' };
        }
        return { status: 'running', rawStatus: 'in_progress' };
      },
      getTaskResult: async () => ({ status: 'completed', content: '外部单恢复后完成' }),
    };

    const recoveryWorker = new TaskWorker({
      config: srv.created.personalAI.config,
      multica: { ...srv.created.personalAI.config.multica, enabled: true, pollIntervalMs: 3000 },
      repo,
      adapter: fakeAdapter,
      logger: createLogger(true),
      agentStore: srv.created.deps.agentStore,
      eventStore: srv.created.personalAI.executionEventStore,
      staleExecutionMs: 80,
      onExecutionTerminalInTx: (taskId, status) => bm.onExecutionTerminalInTx(taskId, status),
      onStartupRecoverInTx: () => bm.reconcileOrphanedInProgressInTx(),
    });
    cleanupCallbacks.push(async () => recoveryWorker.stop());

    recoveryWorker.start();
    // 等待异步 start()->tick() 完成本轮轮询
    await new Promise((r) => setTimeout(r, 120));

    // a) direct_llm 标记 failed + needs_verification，且记录 verification_required 事件
    const directAfter = repo.getById(prepDirect.execution.id)!;
    expect(directAfter.status).toBe('failed');
    expect(directAfter.needs_verification).toBe(true);
    expect(directAfter.error_category).toBe('needs_verification');
    expect(bm.get('u1', tDirect.id)?.status).toBe('failed');
    const directEvents = bm.listExecutionEvents('u1', tDirect.id)!;
    expect(directEvents.items.some((e) => e.event_type === 'verification_required')).toBe(true);

    // b) 已有 external_task_id 的任务直接续轮询完成，未重复 createTask
    expect(pollExistCalls).toBe(1);
    expect(repo.getById(prepHasExternal.execution.id)?.status).toBe('completed');
    expect(bm.get('u1', tHasExternal.id)?.status).toBe('completed');
    const existEvents = bm.listExecutionEvents('u1', tHasExternal.id)!;
    expect(existEvents.items.some((e) => e.event_type === 'recovered')).toBe(true);

    // c) 未建外部单的任务仅派发 1 次（不会波及 MUL-EXIST-1 或已完成任务）
    expect(createTaskCalls).toBe(1);

    // d) 已完成任务纹丝不动
    expect(repo.getById(prepDone.execution.id)?.status).toBe('completed');
    expect(repo.getById(prepDone.execution.id)?.result).toBe('历史已完成产物');

    // 2. 等待超过 staleExecutionMs（80ms）后再触发一次 tick -> 仍在 running 且无新进展的 tPendingReset 收敛为 failed + needs_verification
    const oldTime = new Date(Date.now() - 5000).toISOString();
    db.run(`UPDATE execution_tasks SET last_progress_at = ?, updated_at = ? WHERE id = ?`, [
      oldTime,
      oldTime,
      prepPendingReset.execution.id,
    ]);
    await recoveryWorker.tick();

    const stalledExec = repo.getById(prepPendingReset.execution.id)!;
    expect(stalledExec.status).toBe('failed');
    expect(stalledExec.needs_verification).toBe(true);
    expect(stalledExec.error_code).toBe('execution_stalled');
    expect(bm.get('u1', tPendingReset.id)?.status).toBe('failed');
  });
});
