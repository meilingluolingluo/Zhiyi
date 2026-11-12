/**
 * Step 4 测试：HTTP 领域路由（/profile, /goals, /projects, /work-tasks）、
 * 跨用户 404 隔离、HMAC 鉴权、DirectExecutionRunner（含并发流取消）、
 * MultiCA 重试闭环与 V1 /v1/personal-ai/tasks* 兼容验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UpstreamTransport } from '../src/types';
import { createHarness, type Harness } from './helpers';

const STUB_CLI: string = path.resolve(process.cwd(), 'scripts/mock-multica-cli.mjs');
const active: Harness[] = [];
const tempFiles: string[] = [];

afterEach(async (): Promise<void> => {
  while (active.length > 0) {
    await active.pop()?.close();
  }
  while (tempFiles.length > 0) {
    try {
      fs.unlinkSync(tempFiles.pop() as string);
    } catch {
      // ignore
    }
  }
});

function sseResponse(chunks: string[]): Response {
  const body =
    chunks
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
      .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('Step 4.1: Profile / Goals / Projects / Work-Tasks HTTP CRUD 与用户隔离', () => {
  it('完成 Profile 时区优先级、Goal/Project M:N、Task CRUD 与跨用户 404 隔离', async () => {
    const h = await createHarness();
    active.push(h);

    // 1. Profile: 首次带合法 X-Timezone -> header；用户保存 -> user；后续 header 不覆盖
    const p1 = await h.api('/v1/personal-ai/profile', {
      key: 'dev-key-developer',
      headers: { 'x-timezone': 'America/New_York' },
    });
    expect(p1.status).toBe(200);
    expect(p1.json.profile.user_id).toBe('u1');
    expect(p1.json.profile.timezone).toBe('America/New_York');
    expect(p1.json.profile.timezone_source).toBe('header');

    const p2 = await h.api('/v1/personal-ai/profile', {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: { display_name: 'Alice', timezone: 'Europe/London', work_style: { response_style: 'concise' } },
    });
    expect(p2.status).toBe(200);
    expect(p2.json.profile.timezone).toBe('Europe/London');
    expect(p2.json.profile.timezone_source).toBe('user');

    const p3 = await h.api('/v1/personal-ai/profile', {
      key: 'dev-key-developer',
      headers: { 'x-timezone': 'Asia/Tokyo' },
    });
    expect(p3.json.profile.timezone).toBe('Europe/London');

    // 2. Goal + Project + M:N 关联（body 伪造 user_id 被忽略）
    const proj = await h.api('/v1/personal-ai/projects', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { user_id: 'u2', title: 'Zhiyi V1.5', description: 'Phase 1' },
    });
    expect(proj.status).toBe(201);
    expect(proj.json.project.user_id).toBe('u1');
    const projId: string = proj.json.project.id;

    const goal = await h.api('/v1/personal-ai/goals', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { title: 'Deliver Personal AI', project_ids: [projId] },
    });
    expect(goal.status).toBe(201);
    const goalId: string = goal.json.goal.id;

    // 3. Work Task CRUD + 父子环检测 + PATCH 守卫
    const t1 = await h.api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { title: 'Root Task', project_id: projId },
    });
    expect(t1.status).toBe(201);
    const t1Id: string = t1.json.task.id;

    const t2 = await h.api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { title: 'Child Task', project_id: projId, parent_task_id: t1Id },
    });
    expect(t2.status).toBe(201);

    // 间接环被拦截返回 409
    const cycleRes = await h.api(`/v1/personal-ai/work-tasks/${t1Id}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: { parent_task_id: t2.json.task.id },
    });
    expect(cycleRes.status).toBe(409);

    // 创建时禁止直接传 completed / cancelled / in_progress
    const badCreate = await h.api('/v1/personal-ai/work-tasks', {
      method: 'POST',
      key: 'dev-key-developer',
      body: { title: 'Illegal', status: 'completed' },
    });
    expect(badCreate.status).toBe(400);

    // PATCH 禁止直接设 cancelled
    const badPatch = await h.api(`/v1/personal-ai/work-tasks/${t1Id}`, {
      method: 'PATCH',
      key: 'dev-key-developer',
      body: { status: 'cancelled' },
    });
    expect(badPatch.status).toBe(409);

    // Goal/Project 详情包含 task_stats
    const gDetail = await h.api(`/v1/personal-ai/goals/${goalId}`, { key: 'dev-key-developer' });
    expect(gDetail.status).toBe(200);
    expect(gDetail.json.projects).toHaveLength(1);
    expect(gDetail.json.task_stats.total).toBe(2);

    // 4. u2 跨用户访问 u1 所有资源全部返回 404
    expect((await h.api(`/v1/personal-ai/goals/${goalId}`, { key: 'dev-key-user2' })).status).toBe(404);
    expect((await h.api(`/v1/personal-ai/projects/${projId}`, { key: 'dev-key-user2' })).status).toBe(404);
    expect((await h.api(`/v1/personal-ai/work-tasks/${t1Id}`, { key: 'dev-key-user2' })).status).toBe(404);
    expect((await h.api(`/v1/personal-ai/work-tasks/${t1Id}/execute`, { method: 'POST', key: 'dev-key-user2', body: {} })).status).toBe(404);
    expect((await h.api(`/v1/personal-ai/work-tasks/${t1Id}/cancel`, { method: 'POST', key: 'dev-key-user2' })).status).toBe(404);
  });
});

describe('Step 4.2: DirectExecutionRunner、重试与 MultiCA 闭环', () => {
  it('direct_llm 注入指令与记忆并同步返回 200；失败后可切换 multica Agent 重试并保留全部执行历史', async () => {
    const stubStatePath = path.resolve(
      process.cwd(),
      `data/test-stub-step4-${process.pid}-${Date.now()}.json`,
    );
    tempFiles.push(stubStatePath);
    process.env.MULTICA_STUB_STATE = stubStatePath;
    delete process.env.MULTICA_STUB_STUCK;

    let failDirectOnce = false;
    let capturedBody: Record<string, unknown> | null = null;
    const customTransport: UpstreamTransport = async (_url, init) => {
      capturedBody = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      if (failDirectOnce) {
        return new Response(JSON.stringify({ error: { message: 'upstream down' } }), { status: 502 });
      }
      return sseResponse(['Direct ', 'Answer']);
    };

    const h = await createHarness(
      { upstreamBaseUrl: 'http://mock-upstream.local/v1', mockUpstream: false },
      {
        personalAI: {
          multica: {
            enabled: true,
            cliPath: STUB_CLI,
            pollIntervalMs: 30,
            maxPolls: 20,
            defaultAgent: 'Codex',
          },
        },
      },
    );
    // 重新用自定义 transport 创建干净实例以捕获请求体
    await h.close();

    const { createApp } = await import('../src/app');
    const { loadConfig } = await import('../src/config');
    const { loadPersonalAIConfig } = await import('../src/personal-ai/config');
    const http = await import('node:http');
    const cfg = {
      ...loadConfig({}),
      databaseUrl: ':memory:',
      mockUpstream: false,
      upstreamBaseUrl: 'http://custom-llm.invalid/v1',
      upstreamApiKey: 'k',
      defaultModel: 'default-m',
      logSilent: true,
    };
    const pCfg = {
      ...loadPersonalAIConfig({}),
      multica: {
        ...loadPersonalAIConfig({}).multica,
        enabled: true,
        cliPath: STUB_CLI,
        pollIntervalMs: 30,
        maxPolls: 20,
        defaultAgent: 'Codex',
      },
    };
    const created = await createApp(cfg, {
      silent: true,
      transport: customTransport,
      upstreamSettings: null,
      personalAIConfig: pCfg,
    });
    const server = http.createServer(created.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const api = async (route: string, opts: { method?: string; body?: unknown } = {}) => {
      const res = await fetch(`${baseUrl}${route}`, {
        method: opts.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer dev-key-developer',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      return { status: res.status, json: (await res.json()) as any };
    };

    try {
      // 注册 direct_llm Agent 并配置 instructions 与 model_preference
      await api('/v1/agents', {
        method: 'POST',
        body: { agent_id: 'fast_llm', name: 'Fast LLM', role: 'Assistant' },
      });
      await api('/v1/agents/fast_llm', {
        method: 'PATCH',
        body: {
          execution_backend: 'direct_llm',
          model_preference: 'preferred-model-x',
          instructions: 'Be concise and factual.',
        },
      });
      // 写入一条用户记忆验证 DirectExecutionRunner 会复用 Memory Core 注入
      await api('/v1/memories', {
        method: 'POST',
        body: { content: '用户偏好 TypeScript 严格模式', type: 'semantic', scope: 'personal' },
      });

      const taskRes = await api('/v1/personal-ai/work-tasks', {
        method: 'POST',
        body: {
          title: '总结 TypeScript 规范',
          description: '请结合个人偏好给出规范建议',
          assignee_agent_id: 'fast_llm',
        },
      });
      expect(taskRes.status).toBe(201);
      const taskId: string = taskRes.json.task.id;

      // 1. direct_llm 成功执行
      const exec1 = await api(`/v1/personal-ai/work-tasks/${taskId}/execute`, {
        method: 'POST',
        body: {},
      });
      expect(exec1.status).toBe(200);
      expect(exec1.json.task.status).toBe('completed');
      expect(exec1.json.execution.status).toBe('completed');
      expect(exec1.json.execution.result).toBe('Direct Answer');
      expect((capturedBody as any).model).toBe('preferred-model-x');
      const sentMessages = (capturedBody as any).messages as Array<{ role: string; content: string }>;
      expect(sentMessages.some((m) => m.role === 'system' && m.content.includes('Be concise and factual.'))).toBe(true);
      expect(sentMessages.some((m) => m.role === 'system' && m.content.includes('TypeScript 严格模式'))).toBe(true);

      // 2. 新建第二个任务：先 direct_llm 失败，再换 multica developer 重试成功
      failDirectOnce = true;
      const t2 = await api('/v1/personal-ai/work-tasks', {
        method: 'POST',
        body: { title: 'Analyze repo architecture', assignee_agent_id: 'fast_llm' },
      });
      const t2Id: string = t2.json.task.id;

      const failRun = await api(`/v1/personal-ai/work-tasks/${t2Id}/execute`, {
        method: 'POST',
        body: {},
      });
      expect(failRun.status).toBe(200);
      expect(failRun.json.task.status).toBe('failed');
      expect(failRun.json.execution.status).toBe('failed');

      const retryRun = await api(`/v1/personal-ai/work-tasks/${t2Id}/execute`, {
        method: 'POST',
        body: { agent_id: 'developer' },
      });
      expect(retryRun.status).toBe(202);
      expect(retryRun.json.execution.execution_mode).toBe('agent_delegation');

      // 等待 Worker 完成 MultiCA stub 执行
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const check = await api(`/v1/personal-ai/work-tasks/${t2Id}`);
        if (check.json.task.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 30));
      }

      const finalDetail = await api(`/v1/personal-ai/work-tasks/${t2Id}`);
      expect(finalDetail.json.task.status).toBe('completed');

      const history = await api(`/v1/personal-ai/work-tasks/${t2Id}/executions`);
      expect(history.status).toBe(200);
      expect(history.json.total).toBe(2);
      expect(history.json.items[0].status).toBe('completed');
      expect(history.json.items[1].status).toBe('failed');

      // V1 兼容接口 GET /v1/personal-ai/tasks 依然正常返回 execution_tasks
      const v1List = await api('/v1/personal-ai/tasks');
      expect(v1List.status).toBe(200);
      expect(v1List.json.items.length).toBeGreaterThanOrEqual(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await created.close();
    }
  });

  it('在途 direct_llm 流式执行时调用 /cancel 能立即中止流并收敛为 cancelled', async () => {
    const { createApp } = await import('../src/app');
    const { loadConfig } = await import('../src/config');
    const { loadPersonalAIConfig } = await import('../src/personal-ai/config');
    const http = await import('node:http');

    let streamStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    let signalAborted = false;

    const hangingTransport: UpstreamTransport = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        streamStarted();
        init.signal?.addEventListener('abort', () => {
          signalAborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    const created = await createApp(
      {
        ...loadConfig({}),
        databaseUrl: ':memory:',
        mockUpstream: false,
        upstreamBaseUrl: 'http://slow-llm.invalid/v1',
        upstreamTimeoutMs: 10000,
        logSilent: true,
      },
      {
        silent: true,
        transport: hangingTransport,
        upstreamSettings: null,
        personalAIConfig: loadPersonalAIConfig({}),
      },
    );
    const server = http.createServer(created.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const api = async (route: string, opts: { method?: string; body?: unknown } = {}) => {
      const res = await fetch(`${baseUrl}${route}`, {
        method: opts.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer dev-key-developer',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      return { status: res.status, json: (await res.json()) as any };
    };

    try {
      await api('/v1/agents', {
        method: 'POST',
        body: { agent_id: 'slow_llm', name: 'Slow LLM' },
      });
      const t = await api('/v1/personal-ai/work-tasks', {
        method: 'POST',
        body: { title: 'Long stream task', assignee_agent_id: 'slow_llm' },
      });
      const taskId: string = t.json.task.id;

      // 发起 execute（将在 hangingTransport 处阻塞等待）
      const execPromise = api(`/v1/personal-ai/work-tasks/${taskId}/execute`, {
        method: 'POST',
        body: {},
      });
      await startedPromise;

      // 并发调用 /cancel
      const cancelRes = await api(`/v1/personal-ai/work-tasks/${taskId}/cancel`, {
        method: 'POST',
      });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.json.task.status).toBe('cancelled');
      expect(cancelRes.json.external_cancelled).toBe(true);
      expect(signalAborted).toBe(true);

      const execRes = await execPromise;
      expect(execRes.status).toBe(200);
      expect(execRes.json.task.status).toBe('cancelled');
      expect(execRes.json.execution.status).toBe('cancelled');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await created.close();
    }
  });
});
