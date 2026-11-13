/**
 * 阶段 5：Proactive Assistant 主动助理能力完整测试。
 *
 * 覆盖：
 * 1. 逾期/临期/停滞任务、停滞目标、执行失败/待核实、待决策与近期完成汇总规则
 * 2. 重复通知抑制（dedupe_key）、已读/忽略管理与严格跨用户隔离
 * 3. 用户偏好控制（proactive_enabled / paused_until / frequency / types / 时区安静时间）
 * 4. 基于真实 BusinessTask + Execution 数据的项目进度汇总（HTTP + OpenClaw 只读工具 + ContextBuilder）
 * 5. 定时调度与服务重启后的持久化调度状态恢复（冷却窗口延续且不重复打扰）
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { loadPersonalAIConfig } from '../src/personal-ai/config';
import { isWithinQuietHours } from '../src/personal-ai/proactive/proactive-engine';
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

async function startProactiveServer(options: {
  databaseUrl?: string;
  transport?: UpstreamTransport;
} = {}) {
  const cfg: AppConfig = {
    ...loadConfig({}),
    databaseUrl: options.databaseUrl ?? ':memory:',
    mockUpstream: false,
    upstreamBaseUrl: 'http://mock-stage5.invalid/v1',
    upstreamApiKey: 'sk-stage5-test',
    defaultModel: 'zhiyi-stage5-model',
    upstreamTimeoutMs: 3000,
    logSilent: true,
  };
  const personalCfg = loadPersonalAIConfig({ MULTICA_ENABLED: 'false' });
  const created: CreatedApp = await createApp(cfg, {
    silent: true,
    settingsPath: null,
    adminToken: 'admin-stage5-token',
    transport:
      options.transport ??
      (async () => sseFrames([{ choices: [{ delta: { content: '已完成处理。' }, finish_reason: 'stop' }] }])),
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

  let closed = false;
  const closeServer = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await created.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  };
  cleanupCallbacks.push(closeServer);

  return {
    baseUrl,
    created,
    closeServer,
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

describe('阶段 5：Proactive Assistant 主动助理能力', () => {
  it('识别逾期/临期/停滞任务、执行失败、停滞目标与待决策事项，并严格抑制重复通知', async () => {
    const srv = await startProactiveServer();
    const { goalStore, projectStore, businessTaskManager, proactiveEngine, proactiveStore } =
      srv.created.personalAI;
    const db = srv.created.deps.db;

    const now = new Date('2026-11-12T10:00:00.000Z');
    const goal = goalStore.create('u1', { title: '打造高可靠个人工作台', priority: 3 });
    const proj = projectStore.create('u1', { title: '网关稳定性建设', goal_ids: [goal.id] });

    // 1. 逾期任务 + 2. 临期任务 + 3. 停滞任务 + 4. 阻塞任务
    const overdueTask = businessTaskManager.create('u1', {
      title: '修复连接池泄漏',
      project_id: proj.id,
      due_at: '2026-11-11T10:00:00.000Z',
    });
    const dueSoonTask = businessTaskManager.create('u1', {
      title: '提交周度巡检报告',
      project_id: proj.id,
      due_at: '2026-11-12T18:00:00.000Z',
    });
    const stalledTask = businessTaskManager.create('u1', {
      title: '梳理监控告警阈值',
      project_id: proj.id,
    });
    const blockedTask = businessTaskManager.create('u1', {
      title: '申请生产发布窗口',
      project_id: proj.id,
      status: 'pending',
    });
    db.run(`UPDATE tasks SET status = 'blocked' WHERE id = ?`, [blockedTask.id]);

    // 手工将停滞任务与停滞目标的 updated_at 拨回过去
    db.run(`UPDATE tasks SET updated_at = ? WHERE id = ?`, [
      '2026-11-08T10:00:00.000Z',
      stalledTask.id,
    ]);
    const oldGoal = goalStore.create('u1', { title: '长期技术架构演进' });
    db.run(`UPDATE goals SET updated_at = ? WHERE id = ?`, [
      '2026-11-01T10:00:00.000Z',
      oldGoal.id,
    ]);

    // 5. 执行失败任务 & 6. 最近已完成任务
    srv.created.deps.agentStore.create({
      agent_id: 'ops-bot',
      name: 'Ops Bot',
      role: '运维助手',
      description: '运维与巡检',
      core_memory: '',
    });
    srv.created.deps.agentStore.updateAdmin('ops-bot', { execution_backend: 'direct_llm' });

    const failedTask = businessTaskManager.create('u1', {
      title: '分析慢查询日志',
      assignee_agent_id: 'ops-bot',
    });
    const failPrep = businessTaskManager.prepareExecution('u1', failedTask.id, {
      agentId: 'ops-bot',
      multicaEnabled: false,
    });
    businessTaskManager.finishDirectExecution(failPrep.execution.id, {
      status: 'failed',
      error: '模型上游返回 503',
      statusCode: 503,
    });

    const completedTask = businessTaskManager.create('u1', {
      title: '校验配置文件格式',
      assignee_agent_id: 'ops-bot',
    });
    const okPrep = businessTaskManager.prepareExecution('u1', completedTask.id, {
      agentId: 'ops-bot',
      multicaEnabled: false,
    });
    businessTaskManager.finishDirectExecution(okPrep.execution.id, {
      status: 'completed',
      result: '全部配置项均符合最新 Schema 规范。',
    });

    // 首次评估 -> 生成对应各类提醒
    const run1 = proactiveEngine.evaluateUser('u1', { now, respectCooldown: false });
    expect(run1.skipped).toBe(false);
    const kinds1 = run1.created.map((n) => n.kind);
    expect(kinds1).toEqual(
      expect.arrayContaining([
        'task_overdue',
        'task_due_soon',
        'task_stalled',
        'decision_needed',
        'execution_failed',
        'task_completed_summary',
        'project_progress',
        'goal_stalled',
      ]),
    );
    expect(run1.created.find((n) => n.entity_id === overdueTask.id)?.kind).toBe('task_overdue');
    expect(run1.created.find((n) => n.entity_id === dueSoonTask.id)?.kind).toBe('task_due_soon');
    expect(run1.created.find((n) => n.entity_id === blockedTask.id)?.kind).toBe('decision_needed');

    // 同一状态下再次评估 -> dedupe_key 严格去重，不生成重复提醒
    const run2 = proactiveEngine.evaluateUser('u1', { now, respectCooldown: false });
    expect(run2.skipped).toBe(false);
    expect(run2.created).toHaveLength(0);

    // HTTP 收件箱查询、标记已读、忽略及跨用户 404 隔离
    const listRes = await srv.api('/v1/personal-ai/proactive/notifications?status=unread', {
      key: 'u1-key',
    });
    expect(listRes.status).toBe(200);
    const firstId = (listRes.json as { items: Array<{ id: string }>; unread_count: number }).items[0].id;
    const initialUnread = (listRes.json as { unread_count: number }).unread_count;
    expect(initialUnread).toBe(run1.created.length);

    expect(
      (await srv.api(`/v1/personal-ai/proactive/notifications/${firstId}/read`, { method: 'POST', key: 'u2-key' })).status,
    ).toBe(404);
    expect(
      (await srv.api(`/v1/personal-ai/proactive/notifications/${firstId}/read`, { method: 'POST', key: 'u1-key' })).status,
    ).toBe(200);
    expect(
      proactiveStore.list('u1', { status: 'unread' }).unread_count,
    ).toBe(initialUnread - 1);

    const dismissRes = await srv.api(`/v1/personal-ai/proactive/notifications/${firstId}/dismiss`, {
      method: 'POST',
      key: 'u1-key',
    });
    expect((dismissRes.json as { notification: { status: string } }).notification.status).toBe('dismissed');
  });

  it('严格遵循用户偏好控制：安静时间、关闭提醒、暂停跟进与提醒类型白名单', async () => {
    const srv = await startProactiveServer();
    const { businessTaskManager, proactiveEngine } = srv.created.personalAI;

    businessTaskManager.create('u1', {
      title: '待确认的逾期事项',
      due_at: '2026-11-10T00:00:00.000Z',
    });
    const blockedPrefTask = businessTaskManager.create('u1', {
      title: '阻塞事项',
      status: 'pending',
    });
    srv.created.deps.db.run(`UPDATE tasks SET status = 'blocked' WHERE id = ?`, [
      blockedPrefTask.id,
    ]);

    // 非法安静时间格式拒绝（400）
    const badPref = await srv.api('/v1/personal-ai/proactive/preferences', {
      method: 'PATCH',
      key: 'u1-key',
      body: { proactive_quiet_hours: { start: '25:99', end: '08:00' } },
    });
    expect(badPref.status).toBe(400);

    // 1. 设置上海时区与跨午夜安静时间 22:00 - 08:00
    await srv.api('/v1/personal-ai/profile', {
      method: 'PATCH',
      key: 'u1-key',
      body: {
        timezone: 'Asia/Shanghai',
        preferences: {
          proactive_quiet_hours: { start: '22:00', end: '08:00' },
          proactive_frequency: 'daily',
        },
      },
    });
    // 2026-11-12T15:00:00Z = 23:00 Asia/Shanghai（安静时间内）
    expect(
      isWithinQuietHours(new Date('2026-11-12T15:00:00.000Z'), 'Asia/Shanghai', {
        start: '22:00',
        end: '08:00',
      }),
    ).toBe(true);
    const quietSkip = proactiveEngine.evaluateUser('u1', {
      now: new Date('2026-11-12T15:00:00.000Z'),
      respectCooldown: false,
    });
    expect(quietSkip.skipped).toBe(true);
    expect(quietSkip.reason).toBe('quiet_hours');
    expect(quietSkip.created).toHaveLength(0);

    // 2. 暂停主动跟进至未来时间
    await srv.api('/v1/personal-ai/proactive/preferences', {
      method: 'PATCH',
      key: 'u1-key',
      body: { proactive_paused_until: '2026-11-20T00:00:00.000Z' },
    });
    const pauseSkip = proactiveEngine.evaluateUser('u1', {
      now: new Date('2026-11-12T03:00:00.000Z'),
      respectCooldown: false,
    });
    expect(pauseSkip.skipped).toBe(true);
    expect(pauseSkip.reason).toBe('paused_by_user');

    // 3. 彻底关闭提醒
    await srv.api('/v1/personal-ai/proactive/preferences', {
      method: 'PATCH',
      key: 'u1-key',
      body: { proactive_paused_until: null, proactive_enabled: false },
    });
    const disabledSkip = proactiveEngine.evaluateUser('u1', {
      now: new Date('2026-11-12T03:00:00.000Z'),
      respectCooldown: false,
    });
    expect(disabledSkip.skipped).toBe(true);
    expect(disabledSkip.reason).toBe('disabled_by_user');

    // 4. 重新开启并仅允许 decision_needed，在非安静时间触发 -> 只发出 decision_needed
    await srv.api('/v1/personal-ai/proactive/preferences', {
      method: 'PATCH',
      key: 'u1-key',
      body: {
        proactive_enabled: true,
        proactive_types: ['decision_needed'],
      },
    });
    const filteredRun = proactiveEngine.evaluateUser('u1', {
      now: new Date('2026-11-12T03:00:00.000Z'),
      respectCooldown: false,
    });
    expect(filteredRun.skipped).toBe(false);
    expect(filteredRun.created).toHaveLength(1);
    expect(filteredRun.created[0].kind).toBe('decision_needed');
  });

  it('基于真实任务与 Execution 生成项目进度汇总，OpenClaw 工具与 ContextBuilder 均可安全消费', async () => {
    const srv = await startProactiveServer();
    const { goalStore, projectStore, businessTaskManager, proactiveStore, userProfiles } =
      srv.created.personalAI;

    srv.created.deps.agentStore.create({
      agent_id: 'summary-claw',
      name: 'Summary Claw',
      role: '项目助理',
      description: '项目进度分析',
      core_memory: '',
    });
    srv.created.deps.agentStore.updateAdmin('summary-claw', {
      execution_backend: 'direct_llm',
      backend_config: { runtime: 'openclaw', allowed_tools: ['project_summary', 'proactive_notifications'] },
    });

    const goal = goalStore.create('u1', { title: '上线知忆 2.0' });
    const proj = projectStore.create('u1', { title: '主动助理模块', goal_ids: [goal.id] });
    const tDone = businessTaskManager.create('u1', {
      title: '设计数据库 Schema',
      project_id: proj.id,
      assignee_agent_id: 'summary-claw',
    });
    const donePrep = businessTaskManager.prepareExecution('u1', tDone.id, {
      agentId: 'summary-claw',
      multicaEnabled: false,
    });
    businessTaskManager.finishDirectExecution(donePrep.execution.id, {
      status: 'completed',
      result: '已完成 007 迁移表结构设计。',
    });

    const tFail = businessTaskManager.create('u1', {
      title: '联调定时通知测试',
      project_id: proj.id,
      assignee_agent_id: 'summary-claw',
    });
    const failPrep = businessTaskManager.prepareExecution('u1', tFail.id, {
      agentId: 'summary-claw',
      multicaEnabled: false,
    });
    businessTaskManager.finishDirectExecution(failPrep.execution.id, {
      status: 'failed',
      error: '测试端口被占用',
    });

    businessTaskManager.create('u1', {
      title: '编写主动助理文档',
      project_id: proj.id,
      priority: 4,
    });

    // 1. HTTP /projects/:id/summary 与跨用户隔离
    const sumRes = await srv.api(`/v1/personal-ai/projects/${proj.id}/summary`, { key: 'u1-key' });
    expect(sumRes.status).toBe(200);
    const sumJson = sumRes.json as {
      stats: { total: number; completed: number; failed: number; pending: number };
      narrative: string;
      next_steps: string[];
    };
    expect(sumJson.stats).toMatchObject({ total: 3, completed: 1, failed: 1, pending: 1 });
    expect(sumJson.narrative).toContain('设计数据库 Schema');
    expect(sumJson.narrative).toContain('联调定时通知测试');
    expect(sumJson.next_steps[0]).toContain('联调定时通知测试');
    expect((await srv.api(`/v1/personal-ai/projects/${proj.id}/summary`, { key: 'u2-key' })).status).toBe(404);

    // 2. 通过手动主动巡检产生提醒并验证 OpenClaw 工具与 ContextBuilder 消费
    const runRes = await srv.api('/v1/personal-ai/proactive/run', {
      method: 'POST',
      key: 'u1-key',
      body: { ignore_quiet_hours: true },
    });
    expect(runRes.status).toBe(200);

    const toolRes = await srv.created.personalAI.toolGateway.executeTool(
      {
        userId: 'u1',
        agent: srv.created.deps.agentStore.get('summary-claw')!,
        task: tDone,
        execution: donePrep.execution,
        identity: {
          user_id: 'u1',
          agent_id: 'summary-claw',
          api_key: null,
          from_default: false,
          request_id: 'req-sum-tool',
          session_id: null,
          task_id: null,
          project_id: proj.id,
          conversation_id: 'conv-sum-tool',
        },
        allowedTools: new Set(['project_summary', 'proactive_notifications']),
      },
      'project_summary',
      { project_id: proj.id },
    );
    expect(toolRes.text).toContain('主动助理模块');
    expect(toolRes.text).toContain('建议下一步');

    const ctx = buildPersonalAIContext(
      {
        config: srv.created.deps.config,
        memoryStore: srv.created.deps.memoryStore,
        agentStore: srv.created.deps.agentStore,
        userProfiles,
        goalStore,
        projectStore,
        businessTaskManager,
        proactiveStore,
      },
      {
        user_id: 'u1',
        agent_id: 'default',
        project_id: proj.id,
        session_id: 's-proactive',
        conversation_id: 'c-proactive',
        request_id: 'r-proactive',
        task_id: null,
        raw_user_id: 'u1',
        source: 'api-key',
      },
      [{ role: 'user', content: '主动助理模块目前有什么进展或风险？' }],
    );
    expect(ctx.systemMessage).toContain('待关注主动提醒');
  });

  it('定时调度支持重启恢复持久化调度状态（冷却期内不重复触发，到期后正常巡检且不发重）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiyi-stage5-db-'));
    const dbPath = path.join(tmpDir, 'proactive.db');
    cleanupCallbacks.push(async () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // 第一次启动进程：构造逾期任务并触发一次定时巡检
    const srv1 = await startProactiveServer({ databaseUrl: dbPath });
    srv1.created.personalAI.proactiveScheduler.stop();
    srv1.created.personalAI.userProfiles.ensureUser('u1');
    srv1.created.personalAI.businessTaskManager.create('u1', {
      title: '持久化调度验证任务',
      due_at: '2026-11-10T00:00:00.000Z',
    });

    const t0 = new Date();
    const tick1 = srv1.created.personalAI.proactiveScheduler.tick(t0);
    expect(tick1.length).toBeGreaterThanOrEqual(1);
    const u1Run1 = tick1.find((r) => r.user_id === 'u1')!;
    expect(u1Run1.skipped).toBe(false);
    expect(u1Run1.created.some((n) => n.kind === 'task_overdue')).toBe(true);
    const persistedState1 = srv1.created.personalAI.proactiveStore.getScheduleState('u1')!;
    expect(persistedState1.last_run_at).toBe(t0.toISOString());
    expect(Date.parse(persistedState1.next_run_at!)).toBeGreaterThan(t0.getTime());

    // 模拟进程关闭重启
    await srv1.closeServer();

    // 第二次启动进程（加载同一 SQLite 文件）
    const srv2 = await startProactiveServer({ databaseUrl: dbPath });
    srv2.created.personalAI.proactiveScheduler.stop();

    // 1 小时后仍处于持久化冷却窗口内（next_run_at = t0 + 6h）：listDueUserIds 不命中 u1，不重复扫描
    const tPlus1h = new Date(t0.getTime() + 1 * 3600_000);
    const tickEarly = srv2.created.personalAI.proactiveScheduler.tick(tPlus1h);
    expect(tickEarly.some((r) => r.user_id === 'u1')).toBe(false);

    // 7 小时后超过 next_run_at：调度自动恢复扫描，但相同逾期任务仍被 dedupe_key 抑制，总提醒数不变
    const tPlus7h = new Date(t0.getTime() + 7 * 3600_000);
    const tickDue = srv2.created.personalAI.proactiveScheduler.tick(tPlus7h);
    const u1RunAfterRestart = tickDue.find((r) => r.user_id === 'u1')!;
    expect(u1RunAfterRestart.skipped).toBe(false);
    expect(u1RunAfterRestart.created).toHaveLength(0);
    expect(srv2.created.personalAI.proactiveStore.list('u1').total).toBe(u1Run1.created.length);
  });
});
