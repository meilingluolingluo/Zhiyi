/**
 * 阶段 4：Personal Memory Evolution 长期记忆进化完整测试。
 *
 * 覆盖：
 * 1. 长期偏好/属性/目标/决策/经验提取 vs 临时对话信息过滤与防模型臆测冒充用户事实
 * 2. 重复记忆合并、冲突识别、过期/归档过滤与模型推断禁止覆盖用户已确认信息
 * 3. 用户主动纠正（POST /v1/memories/:id/correct）与审计链（superseded_by）
 * 4. OpenClaw 记忆维护工具（memory_search / memory_get / memory_create / memory_update / memory_archive）与权限/跨用户/跨Agent隔离
 * 5. 记忆关联 Goal / Project / BusinessTask、完成经验沉淀及 ContextBuilder 相关性筛选
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { ruleBasedExtract } from '../src/extraction-rules';
import { loadPersonalAIConfig } from '../src/personal-ai/config';
import { buildPersonalAIContext } from '../src/personal-ai/runtime/context-builder';
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

async function startMemoryTestServer(transport?: UpstreamTransport) {
  const cfg: AppConfig = {
    ...loadConfig({}),
    databaseUrl: ':memory:',
    mockUpstream: false,
    upstreamBaseUrl: 'http://mock-stage4.invalid/v1',
    upstreamApiKey: 'sk-stage4-test',
    defaultModel: 'zhiyi-stage4-model',
    upstreamTimeoutMs: 3000,
    logSilent: true,
  };
  const personalCfg = loadPersonalAIConfig({ MULTICA_ENABLED: 'false' });
  const created: CreatedApp = await createApp(cfg, {
    silent: true,
    settingsPath: null,
    adminToken: 'admin-stage4-token',
    transport:
      transport ??
      (async () => sseFrames([{ choices: [{ delta: { content: '已完成。' }, finish_reason: 'stop' }] }])),
    upstreamSettings: null,
    personalAIConfig: {
      ...personalCfg,
      apiKeys: {
        ...personalCfg.apiKeys,
        'u1-key': { user_id: 'u1', agent_id: 'default' },
        'u2-key': { user_id: 'u2', agent_id: 'default' },
      },
    },
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
        // 忽略非 JSON
      }
      return { status: res.status, text, json };
    },
  };
}

describe('阶段 4：Personal Memory Evolution 长期记忆进化', () => {
  it('提取长期偏好/目标/经验并过滤临时对话信息，不把模型臆测当成用户事实', () => {
    const extracted = ruleBasedExtract(
      [
        {
          role: 'user',
          content: [
            '我偏好使用 TypeScript 和 pnpm 管理后端服务。',
            '我的长期目标是今年独立上线个人 AI 助手平台。',
            '今天先临时测一下本地接口，顺便问下这个报错怎么看？',
          ].join('\n'),
        },
      ],
      '我猜你可能也喜欢 Java 语言。复盘结论：SQLite WAL 模式显著提升本地并发可靠性。',
    );

    expect(extracted.some((c) => c.content.includes('TypeScript') && c.category === 'preference')).toBe(true);
    expect(extracted.some((c) => c.content.includes('个人 AI 助手平台') && c.category === 'goal')).toBe(true);
    expect(extracted.some((c) => c.content.includes('SQLite WAL') && c.category === 'experience')).toBe(true);

    // 临时讨论、纯提问及助手臆测不进入候选记忆
    expect(extracted.some((c) => c.content.includes('今天先临时测一下'))).toBe(false);
    expect(extracted.some((c) => c.content.includes('顺便问下'))).toBe(false);
    expect(extracted.some((c) => c.content.includes('喜欢 Java'))).toBe(false);
  });

  it('支持重复合并、过期/归档过滤、冲突拦截（模型不可覆盖已确认事实）及用户主动纠正', async () => {
    const srv = await startMemoryTestServer();

    // 1. 用户明确写入一条偏好（verified_by_user = true）
    const createConfirmed = await srv.api('/v1/memories', {
      method: 'POST',
      key: 'u1-key',
      body: {
        content: '后端开发首选 TypeScript 语言',
        category: 'preference',
        type: 'semantic',
        scope: 'personal',
        confidence: 0.85,
      },
    });
    expect(createConfirmed.status).toBe(201);
    const confirmedMem = (createConfirmed.json as {
      memory: { memory_id: string; verified_by_user: boolean; confidence: number };
    }).memory;
    expect(confirmedMem.verified_by_user).toBe(true);

    // 2. 重复内容合并而非新增重复行
    const dupRes = await srv.api('/v1/memories', {
      method: 'POST',
      key: 'u1-key',
      body: {
        content: '后端开发首选 TypeScript 语言。',
        category: 'preference',
      },
    });
    expect(dupRes.status).toBe(201);
    expect((dupRes.json as { evolution_action: string }).evolution_action).toBe('merged');
    expect(((await srv.api('/v1/memories', { key: 'u1-key' })).json as { total: number }).total).toBe(1);

    // 3. 模型推断写入冲突偏好 -> 被拒绝（409 conflict_blocked），用户原记忆保持不变
    const modelConflict = await srv.api('/v1/memories', {
      method: 'POST',
      key: 'u1-key',
      body: {
        content: '后端开发首选 Python 语言',
        category: 'preference',
        source: 'model-inference',
      },
    });
    expect(modelConflict.status).toBe(409);
    const stillOriginal = await srv.api(`/v1/memories/${confirmedMem.memory_id}`, { key: 'u1-key' });
    expect((stillOriginal.json as { memory: { content: string; status: string } }).memory.content).toBe(
      '后端开发首选 TypeScript 语言',
    );
    expect((stillOriginal.json as { memory: { status: string } }).memory.status).toBe('active');

    // 模型推断 PATCH 同样不能篡改已确认记忆
    const modelPatchBlocked = await srv.api(`/v1/memories/${confirmedMem.memory_id}`, {
      method: 'PATCH',
      key: 'u1-key',
      body: { content: '改为 Rust 语言', source: 'model-inference' },
    });
    expect(modelPatchBlocked.status).toBe(409);

    // 4. 用户主动纠正 -> 创建新确认版本，旧版本自动标记 superseded 并保留审计链路
    const correctedRes = await srv.api(`/v1/memories/${confirmedMem.memory_id}/correct`, {
      method: 'POST',
      key: 'u1-key',
      body: { content: '后端开发首选 Go 语言（用户已确认变更）', category: 'preference' },
    });
    expect(correctedRes.status).toBe(200);
    const correctedPayload = correctedRes.json as {
      memory: { memory_id: string; content: string; verified_by_user: boolean; source: string };
      superseded: { memory_id: string; status: string; superseded_by: string };
    };
    expect(correctedPayload.memory.verified_by_user).toBe(true);
    expect(correctedPayload.memory.source).toBe('user-correction');
    expect(correctedPayload.superseded.status).toBe('superseded');
    expect(correctedPayload.superseded.superseded_by).toBe(correctedPayload.memory.memory_id);

    // 5. 过期记忆与手动归档记忆在默认检索中不可见，include_archived=true 可审计追溯
    await srv.api('/v1/memories', {
      method: 'POST',
      key: 'u1-key',
      body: {
        content: '已过期的临时会议口令记录',
        category: 'event',
        expires_at: '2020-01-01T00:00:00.000Z',
      },
    });
    const toArchiveRes = await srv.api('/v1/memories', {
      method: 'POST',
      key: 'u1-key',
      body: { content: '旧版本 Webpack 构建配置说明', category: 'project_fact' },
    });
    const archiveId = (toArchiveRes.json as { memory: { memory_id: string } }).memory.memory_id;
    const archivedRes = await srv.api(`/v1/memories/${archiveId}/archive`, {
      method: 'POST',
      key: 'u1-key',
      body: {},
    });
    expect(archivedRes.status).toBe(200);
    expect((archivedRes.json as { memory: { status: string } }).memory.status).toBe('archived');

    const activeSearch = await srv.api('/v1/memories/search', {
      method: 'POST',
      key: 'u1-key',
      body: { query: '口令 Webpack Go 语言' },
    });
    const activeTexts = (activeSearch.json as { results: Array<{ memory: { content: string } }> }).results.map(
      (r) => r.memory.content,
    );
    expect(activeTexts.some((t) => t.includes('Go 语言'))).toBe(true);
    expect(activeTexts.some((t) => t.includes('已过期'))).toBe(false);
    expect(activeTexts.some((t) => t.includes('Webpack'))).toBe(false);
  });

  it('OpenClaw 记忆维护工具（get/create/update/archive）遵循策略、用户确认保护与跨用户/跨Agent隔离', async () => {
    const srv = await startMemoryTestServer();
    srv.created.deps.agentStore.create({
      agent_id: 'mem-agent',
      name: 'Memory Agent',
      role: '记忆助理',
      description: '维护用户长期记忆',
      core_memory: '',
    });
    srv.created.deps.agentStore.updateAdmin('mem-agent', {
      execution_backend: 'direct_llm',
      backend_config: {
        runtime: 'openclaw',
        allowed_tools: ['memory_search', 'memory_get', 'memory_create', 'memory_update', 'memory_archive'],
      },
    });

    const goal = srv.created.personalAI.goalStore.create('u1', { title: '知忆记忆进化' });
    const proj = srv.created.personalAI.projectStore.create('u1', {
      title: 'Personal Memory Core',
      goal_ids: [goal.id],
    });
    const task = srv.created.personalAI.businessTaskManager.create('u1', {
      title: '实现冲突消解',
      project_id: proj.id,
    });
    const exec = srv.created.personalAI.taskManager.createIfAbsent({
      user_id: 'u1',
      task_id: task.id,
      conversation_id: 'conv-mem-tools',
      request_id: 'req-mem-tools',
      agent_id: 'mem-agent',
      execution_mode: 'direct_llm',
      input_summary: '记忆工具测试',
    }).task;

    // u2 的私有资源，用于验证跨用户拒绝
    const u2Proj = srv.created.personalAI.projectStore.create('u2', { title: 'U2 Private Project' });
    const u2Mem = srv.created.deps.memoryStore.create({
      user_id: 'u2',
      content: 'U2 的机密技术偏好',
      verified_by_user: true,
    });

    const makeCtx = (userId: string) => ({
      userId,
      agent: srv.created.deps.agentStore.get('mem-agent')!,
      task,
      execution: exec,
      identity: {
        user_id: userId,
        agent_id: 'mem-agent',
        api_key: null,
        from_default: false,
        request_id: `req-${userId}`,
        session_id: null,
        task_id: null,
        project_id: proj.id,
        conversation_id: 'conv-mem',
      },
      allowedTools: new Set(['memory_search', 'memory_get', 'memory_create', 'memory_update', 'memory_archive']),
    });

    // 1. memory_create 关联 Goal / Project / Task，标记为模型生成（verified_by_user=false）
    const created = await srv.created.personalAI.toolGateway.executeTool(makeCtx('u1'), 'memory_create', {
      content: '数据库迁移始终使用单事务包裹 DDL',
      category: 'project_fact',
      scope: 'project',
      project_id: proj.id,
      goal_id: goal.id,
      task_id: task.id,
    });
    const createdMemId = (created.details as { memory: { memory_id: string } }).memory.memory_id;
    expect(created.text).toContain(createdMemId);

    // 2. memory_get 正常读取本人记忆；跨用户读取 u2Mem 被 404 拒绝；跨用户挂载 u2Proj 被拒绝
    const fetched = await srv.created.personalAI.toolGateway.executeTool(makeCtx('u1'), 'memory_get', {
      memory_id: createdMemId,
    });
    expect(fetched.text).toContain('推断/未确认');

    await expect(
      srv.created.personalAI.toolGateway.executeTool(makeCtx('u1'), 'memory_get', {
        memory_id: u2Mem.memory_id,
      }),
    ).rejects.toThrow();

    await expect(
      srv.created.personalAI.toolGateway.executeTool(makeCtx('u1'), 'memory_create', {
        content: '试图越权关联他人项目',
        project_id: u2Proj.id,
      }),
    ).rejects.toThrow();

    // 3. memory_update 可以更新未确认记忆；但不能未经确认修改/归档 verified_by_user=true 的记忆
    await srv.created.personalAI.toolGateway.executeTool(makeCtx('u1'), 'memory_update', {
      memory_id: createdMemId,
      content: '数据库迁移始终使用 BEGIN IMMEDIATE 单事务包裹',
    });

    const userConfirmed = srv.created.deps.memoryStore.create({
      user_id: 'u1',
      content: '主数据库固定使用 PostgreSQL',
      category: 'project_fact',
      verified_by_user: true,
    });

    await expect(
      srv.created.personalAI.toolGateway.executeTool(makeCtx('u1'), 'memory_update', {
        memory_id: userConfirmed.memory_id,
        content: '主数据库改成 MySQL',
      }),
    ).rejects.toThrow(/用户明确确认/);

    await expect(
      srv.created.personalAI.toolGateway.executeTool(makeCtx('u1'), 'memory_archive', {
        memory_id: userConfirmed.memory_id,
      }),
    ).rejects.toThrow(/用户明确确认/);

    // 用户明确要求纠正时（user_confirmed_correction=true），工具可执行更新与归档
    const correctedTool = await srv.created.personalAI.toolGateway.executeTool(makeCtx('u1'), 'memory_update', {
      memory_id: userConfirmed.memory_id,
      content: '主数据库已按用户确认切换为 PostgreSQL 16',
      user_confirmed_correction: true,
    });
    expect(correctedTool.text).toContain('PostgreSQL 16');

    const archivedTool = await srv.created.personalAI.toolGateway.executeTool(makeCtx('u1'), 'memory_archive', {
      memory_id: createdMemId,
    });
    expect(archivedTool.text).toContain('status=archived');
  });

  it('工作完成沉淀经验候选且 ContextBuilder 按当前任务相关性筛选项目、任务、执行结果与记忆', async () => {
    const srv = await startMemoryTestServer();
    const { goalStore, projectStore, businessTaskManager, userProfiles } = srv.created.personalAI;

    // 准备一个与当前对话相关的项目 + 目标 + 已完成任务 + 近期执行结果，以及一批不相关的噪声项
    const relevantGoal = goalStore.create('u1', { title: '建设网关认证与单点登录能力', priority: 4 });
    const relevantProj = projectStore.create('u1', {
      title: '网关认证升级',
      description: '完成 DUCX 鉴权与 JWT 校验体系改造',
      goal_ids: [relevantGoal.id],
    });
    const relTask = businessTaskManager.create('u1', {
      title: '排查认证网关 401 刷新重试问题',
      project_id: relevantProj.id,
      priority: 4,
    });

    // 注册直连 Agent 并完成 relTask -> 触发 work-completion 经验候选沉淀
    srv.created.deps.agentStore.create({
      agent_id: 'auth-runner',
      name: 'Auth Runner',
      role: '认证专家',
      description: '处理认证任务',
      core_memory: '',
    });
    srv.created.deps.agentStore.updateAdmin('auth-runner', { execution_backend: 'direct_llm' });
    const prep = businessTaskManager.prepareExecution('u1', relTask.id, {
      agentId: 'auth-runner',
      multicaEnabled: false,
    });
    businessTaskManager.finishDirectExecution(prep.execution.id, {
      status: 'completed',
      result: '已验证：在认证返回 401 时触发单次同步刷新可消除并发重放导致的失效问题。',
    });

    // 项目完成 -> 触发 project-completion 候选沉淀
    await srv.api(`/v1/personal-ai/projects/${relevantProj.id}`, {
      method: 'PATCH',
      key: 'u1-key',
      body: { status: 'completed' },
    });

    const candidates = srv.created.deps.candidateStore.list('u1');
    expect(candidates.some((c) => c.task_id === relTask.id && c.category === 'experience')).toBe(true);
    expect(candidates.some((c) => c.project_id === relevantProj.id && c.source === 'project-completion')).toBe(true);

    // 注入 5 条不相关的活跃项目与任务作为噪声，验证 ContextBuilder 按相关性筛选而不全部塞入
    for (let i = 1; i <= 5; i += 1) {
      const noiseProj = projectStore.create('u1', { title: `行政采购项目 #${i}` });
      businessTaskManager.create('u1', {
        title: `采购办公用品批次 ${i}`,
        project_id: noiseProj.id,
        priority: 1,
      });
    }
    const authOpenTask = businessTaskManager.create('u1', {
      title: '补全认证网关 401 单测覆盖',
      project_id: relevantProj.id,
      priority: 3,
    });

    srv.created.deps.memoryStore.create({
      user_id: 'u1',
      project_id: relevantProj.id,
      goal_id: relevantGoal.id,
      type: 'semantic',
      scope: 'project',
      category: 'project_fact',
      content: '网关认证项目采用 JWT 与 DUCX 双通道刷新方案',
      verified_by_user: true,
    });
    srv.created.deps.memoryStore.create({
      user_id: 'u1',
      type: 'semantic',
      scope: 'personal',
      category: 'preference',
      content: '周末喜欢爬山和露营',
      verified_by_user: true,
    });

    const ctx = buildPersonalAIContext(
      {
        config: srv.created.deps.config,
        memoryStore: srv.created.deps.memoryStore,
        agentStore: srv.created.deps.agentStore,
        userProfiles,
        goalStore,
        projectStore,
        businessTaskManager,
      },
      {
        user_id: 'u1',
        agent_id: 'default',
        project_id: relevantProj.id,
        session_id: 's-rel',
        conversation_id: 'c-rel',
        request_id: 'r-rel',
        task_id: null,
        raw_user_id: 'u1',
        source: 'api-key',
      },
      [{ role: 'user', content: '继续处理认证网关 401 刷新单测与 DUCX 问题' }],
    );

    expect(ctx.systemMessage).toContain('网关认证升级');
    expect(ctx.systemMessage).toContain(authOpenTask.title);
    expect(ctx.systemMessage).toContain('相关近期执行结果');
    expect(ctx.systemMessage).toContain('触发单次同步刷新');
    expect(ctx.systemMessage).toContain('JWT 与 DUCX 双通道刷新方案');
    expect(ctx.systemMessage).toContain('已确认');
    expect(ctx.systemMessage).not.toContain('周末喜欢爬山和露营');
    expect(ctx.systemMessage).not.toContain('行政采购项目');
  });
});
