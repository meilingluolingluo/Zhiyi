/**
 * Step 3 测试：GoalStore、ProjectStore、BusinessTaskRepository/Manager、
 * 父子环检测（深度 10）、状态机 PATCH 守卫、1:N 重试、同时间戳崩溃对账与并发取消竞态。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStore } from '../src/agents';
import { Database } from '../src/db';
import { createLogger } from '../src/logger';
import {
  createCliRunner,
  MulticaAdapter,
} from '../src/personal-ai/adapters/agent/multica-adapter';
import type { AgentExecutionAdapter, TaskStatus } from '../src/personal-ai/adapters/agent/agent-adapter';
import { loadPersonalAIConfig } from '../src/personal-ai/config';
import { GoalStore } from '../src/personal-ai/domain/goal-store';
import { ProjectStore } from '../src/personal-ai/domain/project-store';
import { DomainError } from '../src/personal-ai/domain/types';
import { UserProfileStore } from '../src/personal-ai/domain/user-profile-store';
import { BusinessTaskManager } from '../src/personal-ai/task/business-task-manager';
import { BusinessTaskRepository, MAX_TASK_DEPTH } from '../src/personal-ai/task/business-task-repository';
import { TaskManager } from '../src/personal-ai/task/task-manager';
import { TaskRepository } from '../src/personal-ai/task/task-repository';
import { TaskWorker } from '../src/personal-ai/worker/task-worker';

const STUB_CLI: string = path.resolve(process.cwd(), 'scripts/mock-multica-cli.mjs');

const dbs: Database[] = [];
const workers: TaskWorker[] = [];
const tempFiles: string[] = [];

afterEach((): void => {
  while (workers.length > 0) {
    workers.pop()?.stop();
  }
  while (dbs.length > 0) {
    try {
      dbs.pop()?.close();
    } catch {
      // ignore
    }
  }
  while (tempFiles.length > 0) {
    try {
      fs.unlinkSync(tempFiles.pop() as string);
    } catch {
      // ignore
    }
  }
});

function setupHarness() {
  const db = Database.open(':memory:');
  dbs.push(db);
  db.migrate();

  const agentStore = new AgentStore(db);
  agentStore.seed();

  const userProfiles = new UserProfileStore(db);
  const goalStore = new GoalStore(db, userProfiles);
  const projectStore = new ProjectStore(db, userProfiles);
  const taskRepo = new TaskRepository(db);
  const businessRepo = new BusinessTaskRepository(db, userProfiles, taskRepo);
  const businessManager = new BusinessTaskManager(db, businessRepo, taskRepo, agentStore);
  const taskManager = new TaskManager(taskRepo, (taskId) =>
    businessManager.onExecutionCancelledInTx(taskId),
  );

  return {
    db,
    agentStore,
    userProfiles,
    goalStore,
    projectStore,
    taskRepo,
    businessRepo,
    businessManager,
    taskManager,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = (): void => undefined;
  const promise = new Promise<T>((done): void => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Step 3.1: GoalStore & ProjectStore（CRUD、M:N、隔离与软删除）', () => {
  it('支持 Goal/Project 生命周期、同用户 M:N 关联，并严格阻止跨用户与软删除关联', () => {
    const { goalStore, projectStore, businessManager } = setupHarness();

    const p1 = projectStore.create('u1', { title: 'Gateway V1.5', description: 'Phase 1' });
    const g1 = goalStore.create('u1', { title: '打造私人助理', project_ids: [p1.id] });
    const g2 = goalStore.create('u1', { title: '提升工程效率' });
    goalStore.linkProject('u1', g2.id, p1.id);

    expect(goalStore.listProjectsForGoal('u1', g1.id).map((p) => p.id)).toEqual([p1.id]);
    expect(projectStore.listGoalsForProject('u1', p1.id).map((g) => g.id)).toEqual(
      expect.arrayContaining([g1.id, g2.id]),
    );
    expect(projectStore.list('u1', { goal_id: g2.id }).items.map((p) => p.id)).toEqual([p1.id]);

    // 用户 u2 不可见且不能关联 u1 的实体
    expect(goalStore.get('u2', g1.id)).toBeUndefined();
    expect(() => goalStore.linkProject('u2', g1.id, p1.id)).toThrow(DomainError);
    const p2 = projectStore.create('u2', { title: 'U2 Project' });
    expect(() => goalStore.linkProject('u1', g1.id, p2.id)).toThrow(DomainError);

    // 软删除 Project 后列表过滤，但关联其下的历史业务 Task 仍可查
    const t1 = businessManager.create('u1', { title: 'Task in P1', project_id: p1.id });
    expect(projectStore.softDelete('u1', p1.id)).toBe(true);
    expect(projectStore.get('u1', p1.id)).toBeUndefined();
    expect(businessManager.get('u1', t1.id)?.project_id).toBe(p1.id);
    // 已软删除的 Project 不可再用于新建关联
    expect(() => goalStore.linkProject('u1', g2.id, p1.id)).toThrow(DomainError);
    expect(() => businessManager.create('u1', { title: 'New task', project_id: p1.id })).toThrow(DomainError);
  });
});

describe('Step 3.2: BusinessTask 环检测、初始状态与 PATCH 守卫、软删除', () => {
  it('创建与修改父子关系均执行同事务环检测与 MAX_TASK_DEPTH=10 深度限制', () => {
    const { businessManager } = setupHarness();

    // 构造 10 层合法链：L1 -> L2 -> ... -> L10
    let prevId: string | null = null;
    const chain: string[] = [];
    for (let i = 1; i <= MAX_TASK_DEPTH; i += 1) {
      const created = businessManager.create('u1', {
        title: `L${i}`,
        parent_task_id: prevId,
      });
      chain.push(created.id);
      prevId = created.id;
    }

    // 第 11 层创建被拒绝（超过 MAX_TASK_DEPTH）
    try {
      businessManager.create('u1', { title: 'L11', parent_task_id: prevId });
      expect.unreachable('should throw task_depth_exceeded');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('task_depth_exceeded');
    }

    // 直接环（A -> A）与间接环（L1 -> L3）在 PATCH 时均被拦截
    try {
      businessManager.update('u1', chain[0], { parent_task_id: chain[0] });
      expect.unreachable('should throw self cycle');
    } catch (err) {
      expect((err as DomainError).code).toBe('task_cycle_detected');
    }

    try {
      businessManager.update('u1', chain[0], { parent_task_id: chain[2] });
      expect.unreachable('should throw indirect cycle');
    } catch (err) {
      expect((err as DomainError).code).toBe('task_cycle_detected');
    }

    // 修改父节点导致子树总深度超限也被拒绝：将 3 层子树（S1->S2->S3）挂到 8 层链末尾（8+3=11 > 10）
    const s1 = businessManager.create('u1', { title: 'S1' });
    const s2 = businessManager.create('u1', { title: 'S2', parent_task_id: s1.id });
    businessManager.create('u1', { title: 'S3', parent_task_id: s2.id });
    try {
      businessManager.update('u1', s1.id, { parent_task_id: chain[7] }); // chain[7] 为第 8 层
      expect.unreachable('should throw subtree depth exceeded');
    } catch (err) {
      expect((err as DomainError).code).toBe('task_depth_exceeded');
    }

    // 跨用户父任务不可见
    expect(() =>
      businessManager.create('u2', { title: 'Cross', parent_task_id: chain[0] }),
    ).toThrow(DomainError);
  });

  it('创建严格限制初始状态，PATCH 禁止设置终态/在活跃 Execution 时改状态，软删除保护历史 Execution', () => {
    const { agentStore, businessManager, taskRepo } = setupHarness();
    agentStore.create({ agent_id: 'helper', name: 'Helper' }); // 默认 direct_llm

    // 创建时禁止直接指定 in_progress / blocked / completed / failed / cancelled
    for (const forbidden of ['in_progress', 'blocked', 'completed', 'failed', 'cancelled']) {
      expect(() =>
        businessManager.create('u1', { title: 'Bad init', status: forbidden }),
      ).toThrow(DomainError);
    }
    expect(() =>
      businessManager.create('u1', { title: 'Assigned no agent', status: 'assigned' }),
    ).toThrow(DomainError);

    const t = businessManager.create('u1', {
      title: 'Valid task',
      status: 'assigned',
      assignee_agent_id: 'helper',
    });

    // PATCH 永远禁止设为 cancelled / in_progress / completed / failed
    for (const badTarget of ['cancelled', 'in_progress', 'completed', 'failed']) {
      try {
        businessManager.update('u1', t.id, { status: badTarget });
        expect.unreachable(`should block PATCH to ${badTarget}`);
      } catch (err) {
        expect((err as DomainError).status).toBe(409);
      }
    }

    // 正常流转 pending -> ready -> assigned 允许
    businessManager.update('u1', t.id, { status: 'ready' });
    expect(businessManager.get('u1', t.id)?.status).toBe('ready');

    // 创建活跃 Execution 后，PATCH 修改任何状态均返回 409
    const prepared = businessManager.prepareExecution('u1', t.id, { multicaEnabled: false });
    try {
      businessManager.update('u1', t.id, { status: 'ready' });
      expect.unreachable('should reject PATCH when execution is active');
    } catch (err) {
      expect((err as DomainError).code).toBe('active_execution_exists');
    }

    // 活跃状态不可软删除
    expect(() => businessManager.softDelete('u1', t.id)).toThrow(DomainError);

    // 完成后软删除任务：tasks 软删除，但 execution_tasks 历史完整保留
    businessManager.finishDirectExecution(prepared.execution.id, {
      status: 'completed',
      result: 'done',
    });
    const child = businessManager.create('u1', { title: 'Subtask', parent_task_id: t.id });
    expect(() => businessManager.softDelete('u1', t.id, false)).toThrow(DomainError);
    expect(businessManager.softDelete('u1', t.id, true)).toBe(true);
    expect(businessManager.get('u1', t.id)).toBeUndefined();
    expect(businessManager.get('u1', child.id)).toBeUndefined();
    expect(taskRepo.getById(prepared.execution.id)?.result).toBe('done');
  });
});

describe('Step 3.3: 1:N Execution、换 Agent 重试、并发防重、崩溃恢复与取消竞态', () => {
  it('支持 direct_llm 与 multica 统一记账、失败后换 Agent 重试保留历史，以及并发 409 防重', async () => {
    const { agentStore, businessManager, taskRepo } = setupHarness();
    agentStore.create({ agent_id: 'llm_analyst', name: 'LLM Analyst' }); // 默认 direct_llm
    agentStore.updateAdmin('developer', { backend_config: { assignee: 'Codex' } });

    const task = businessManager.create('u1', {
      title: 'Refactor module',
      assignee_agent_id: 'llm_analyst',
    });

    // 1. 第 1 次执行（direct_llm）失败
    const attempt1 = businessManager.prepareExecution('u1', task.id, { multicaEnabled: true });
    expect(attempt1.execution.execution_mode).toBe('direct_llm');
    expect(attempt1.execution.status).toBe('running');
    expect(attempt1.task.status).toBe('in_progress');

    // 活跃期间并发抢占必报 409
    try {
      businessManager.prepareExecution('u1', task.id, { multicaEnabled: true });
      expect.unreachable('concurrent execute must fail');
    } catch (err) {
      expect((err as DomainError).status).toBe(409);
    }

    businessManager.finishDirectExecution(attempt1.execution.id, {
      status: 'failed',
      error: 'Upstream timeout',
    });
    expect(businessManager.get('u1', task.id)?.status).toBe('failed');

    // 2. 第 2 次换用 multica Agent (developer) 重试，不覆盖旧记录
    const attempt2 = businessManager.prepareExecution('u1', task.id, {
      agentId: 'developer',
      multicaEnabled: true,
    });
    expect(attempt2.execution.id).not.toBe(attempt1.execution.id);
    expect(attempt2.execution.execution_mode).toBe('agent_delegation');
    expect(attempt2.execution.status).toBe('pending');
    expect(businessManager.get('u1', task.id)?.assignee_agent_id).toBe('developer');

    const history = businessManager.listExecutions('u1', task.id)!;
    expect(history.total).toBe(2);
    expect(history.items.map((e) => e.id)).toEqual(
      expect.arrayContaining([attempt1.execution.id, attempt2.execution.id]),
    );

    // 3. 使用 mock-multica-cli 验证 TaskWorker.dispatch() 读取 backend_config.assignee 并同事务完成同步
    const stubStatePath = path.resolve(
      process.cwd(),
      `data/test-stub-step3-${process.pid}-${Date.now()}.json`,
    );
    tempFiles.push(stubStatePath);
    process.env.MULTICA_STUB_STATE = stubStatePath;
    delete process.env.MULTICA_STUB_STUCK;

    const cfg = loadPersonalAIConfig({});
    const multicaCfg = {
      ...cfg.multica,
      enabled: true,
      cliPath: STUB_CLI,
      pollIntervalMs: 30,
      maxPolls: 20,
      defaultAgent: 'FallbackAgent',
    };
    const logger = createLogger(true);
    const adapter = new MulticaAdapter(multicaCfg, createCliRunner(multicaCfg, logger), logger);
    const worker = new TaskWorker({
      config: cfg,
      multica: multicaCfg,
      repo: taskRepo,
      adapter,
      logger,
      agentStore,
      onExecutionTerminalInTx: (tId, status) => businessManager.onExecutionTerminalInTx(tId, status),
      onStartupRecoverInTx: () => {
        businessManager.reconcileOrphanedInProgressInTx();
      },
    });
    workers.push(worker);
    worker.start();

    await new Promise<void>((resolve): void => {
      const deadline = Date.now() + 4000;
      const check = (): void => {
        const current = businessManager.get('u1', task.id);
        if (current?.status === 'completed' || Date.now() > deadline) {
          resolve();
          return;
        }
        setTimeout(check, 30);
      };
      check();
    });

    const detail = businessManager.getDetail('u1', task.id)!;
    expect(detail.task.status).toBe('completed');
    expect(detail.latest_execution?.id).toBe(attempt2.execution.id);
    expect(detail.latest_execution?.status).toBe('completed');
  });

  it('崩溃恢复：同时间戳平局按 id DESC 决胜，且遗留 direct_llm running 重启收敛为 failed', () => {
    const { db, agentStore, taskRepo, businessManager } = setupHarness();
    agentStore.create({ agent_id: 'llm_only', name: 'LLM' });

    const now = '2026-11-12T00:00:00.000Z';
    db.run(`INSERT INTO users (user_id, created_at, updated_at) VALUES ('u1', ?, ?)`, [now, now]);

    // 场景 A：孤儿 in_progress 任务，两条历史 execution 时间戳完全相同，task_b > task_a
    db.run(
      `INSERT INTO tasks (id, user_id, title, status, created_at, updated_at)
       VALUES ('btask_tie', 'u1', 'Tie recovery', 'in_progress', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO execution_tasks (id, task_id, user_id, conversation_id, request_id, idempotency_key, execution_mode, status, created_at, updated_at)
       VALUES
         ('task_a', 'btask_tie', 'u1', 'c1', 'r_a', 'u1:r_a', 'agent_delegation', 'failed', ?, ?),
         ('task_b', 'btask_tie', 'u1', 'c1', 'r_b', 'u1:r_b', 'agent_delegation', 'completed', ?, ?)`,
      [now, now, now, now],
    );

    // 场景 B：direct_llm 流式执行到一半进程重启（execution 停在 running，task 停在 in_progress）
    const directTask = businessManager.create('u1', {
      title: 'Direct crash',
      assignee_agent_id: 'llm_only',
    });
    const prep = businessManager.prepareExecution('u1', directTask.id, { multicaEnabled: false });

    const worker = new TaskWorker({
      config: loadPersonalAIConfig({}),
      multica: { ...loadPersonalAIConfig({}).multica, enabled: false, pollIntervalMs: 5000 },
      repo: taskRepo,
      adapter: null,
      logger: createLogger(true),
      onStartupRecoverInTx: () => {
        businessManager.reconcileOrphanedInProgressInTx();
      },
    });
    workers.push(worker);
    worker.start();

    // 场景 A：确定性选中 task_b -> completed
    expect(businessManager.get('u1', 'btask_tie')?.status).toBe('completed');
    // 场景 B：direct_llm 遗留 running 收敛为 failed，连带推进 businessTask 为 failed
    expect(taskRepo.getById(prep.execution.id)?.status).toBe('failed');
    expect(businessManager.get('u1', directTask.id)?.status).toBe('failed');
  });

  it('取消并发竞态：轮询在途窗口内取消业务 Task 后，晚到轮询不得复活状态', async () => {
    const { agentStore, taskRepo, taskManager, businessManager } = setupHarness();
    const t = businessManager.create('u1', { title: 'Cancel race', assignee_agent_id: 'developer' });
    const prep = businessManager.prepareExecution('u1', t.id, { multicaEnabled: true });

    taskRepo.update(prep.execution.id, { status: 'running', external_task_id: 'MUL-RACE' });

    const gate = deferred<TaskStatus>();
    let cancelledExternal = false;
    const fakeAdapter: AgentExecutionAdapter = {
      createTask: async () => ({ externalTaskId: 'MUL-RACE', status: 'running' }),
      assignAgent: async () => undefined,
      getTaskStatus: async () => gate.promise,
      getTaskResult: async () => ({ status: 'completed', content: 'late' }),
      cancelTask: async () => {
        cancelledExternal = true;
        return true;
      },
    };

    const cfg = loadPersonalAIConfig({});
    const worker = new TaskWorker({
      config: cfg,
      multica: { ...cfg.multica, enabled: true, pollIntervalMs: 5000 },
      repo: taskRepo,
      adapter: fakeAdapter,
      logger: createLogger(true),
      agentStore,
      onExecutionTerminalInTx: (tId, status) => businessManager.onExecutionTerminalInTx(tId, status),
    });
    workers.push(worker);

    // 触发一次轮询，卡在 getTaskStatus
    const tickPromise = worker.tick();
    await new Promise((r) => setTimeout(r, 20));

    // 在途窗口取消业务 Task
    const cancelRes = businessManager.cancelTask('u1', t.id);
    expect(cancelRes.task.status).toBe('cancelled');
    expect(cancelRes.cancelled_executions.map((e) => e.id)).toEqual([prep.execution.id]);
    if (cancelRes.cancelled_executions[0]?.external_task_id && fakeAdapter.cancelTask) {
      await fakeAdapter.cancelTask(cancelRes.cancelled_executions[0].external_task_id);
    }
    expect(cancelledExternal).toBe(true);

    // 放行晚到的 completed 轮询结果
    gate.resolve({ status: 'completed', rawStatus: 'done', externalRunId: 'run-1' });
    await tickPromise;

    expect(taskRepo.getById(prep.execution.id)?.status).toBe('cancelled');
    expect(businessManager.get('u1', t.id)?.status).toBe('cancelled');

    // 验证 V1 TaskManager.cancelForUser 也能同事务同步关联的业务 Task
    const t2 = businessManager.create('u1', { title: 'V1 cancel sync', assignee_agent_id: 'developer' });
    const prep2 = businessManager.prepareExecution('u1', t2.id, { multicaEnabled: true });
    const v1Cancel = taskManager.cancelForUser('u1', prep2.execution.id);
    expect(v1Cancel.ok).toBe(true);
    expect(businessManager.get('u1', t2.id)?.status).toBe('cancelled');
  });
});
