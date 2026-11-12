/**
 * QA 独立回归用例：任务状态机终态保护。
 *
 * 背景：`TaskWorker.pollOne()` 会先快照任务列表，再发起异步 CLI 调用，最后
 * 无条件用 `patch.status = 'running'` 回写（src/personal-ai/worker/task-worker.ts:120-133）。
 * 若用户在这段异步窗口内取消任务，`cancelled` 会被覆盖回 `running`，
 * 与 ARCHITECTURE.md §9「cancelled 是终态」矛盾，并且使重复取消不再返回 409。
 *
 * 本用例用「可控的 getTaskStatus Promise」把竞态窗口固定住，100% 可复现，
 * 不依赖 sleep 计时。修复方向（源码侧，由工程师处理）：
 * - 回写前重新读取任务，终态（completed/failed/cancelled）直接放弃回写；
 * - 或 update 加 `WHERE id = ? AND status IN ('pending','dispatching','running')` 条件。
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/db';
import { createLogger } from '../src/logger';
import type { AgentExecutionAdapter, TaskStatus } from '../src/personal-ai/adapters/agent/agent-adapter';
import { loadPersonalAIConfig } from '../src/personal-ai/config';
import { TaskManager } from '../src/personal-ai/task/task-manager';
import { TaskRepository } from '../src/personal-ai/task/task-repository';
import { TaskWorker } from '../src/personal-ai/worker/task-worker';

describe('QA 回归：终态保护', () => {
  it('取消后，正在进行的轮询结果不得把任务状态写回 running', async () => {
    const db: Database = Database.open(':memory:');
    db.migrate();
    try {
      const repo = new TaskRepository(db);
      const manager = new TaskManager(repo);
      const created = repo.create({
        user_id: 'u1',
        conversation_id: 'conv_race',
        request_id: 'req_race',
        execution_mode: 'agent_delegation',
        input_summary: 'QA 竞态任务',
      });
      // 模拟已完成派发、正在被轮询的任务
      repo.update(created.task.id, { status: 'running', external_task_id: 'MUL-RACE-1' });

      let releaseStatus: (value: TaskStatus) => void = (): void => undefined;
      let enterStatus: () => void = (): void => undefined;
      const statusGate = new Promise<TaskStatus>((resolve): void => {
        releaseStatus = resolve;
      });
      const entered = new Promise<void>((resolve): void => {
        enterStatus = resolve;
      });
      const adapter: AgentExecutionAdapter = {
        createTask: async () => ({ externalTaskId: 'MUL-RACE-1', status: 'created' }),
        assignAgent: async () => undefined,
        getTaskStatus: async (): Promise<TaskStatus> => {
          enterStatus();
          return statusGate;
        },
        getTaskResult: async () => ({ status: 'completed', content: 'ok' }),
      };

      const base = loadPersonalAIConfig({});
      const worker = new TaskWorker({
        config: base,
        multica: { ...base.multica, maxConcurrentTasks: 3, maxPolls: 50 },
        repo,
        adapter,
        logger: createLogger(true),
      });

      // 让 Worker 进入「已快照任务、正等待 CLI 返回」的窗口
      const ticking = worker.tick();
      await entered;

      // 用户此刻取消
      const cancelled = manager.cancelForUser('u1', created.task.id);
      expect(cancelled.ok).toBe(true);
      expect(repo.get('u1', created.task.id)?.status).toBe('cancelled');

      // CLI 返回 running，Worker 回写
      releaseStatus({ status: 'running', rawStatus: 'running', message: 'run running' });
      await ticking;

      expect(repo.get('u1', created.task.id)?.status).toBe('cancelled');
    } finally {
      db.close();
    }
  });

  it('派发窗口内被取消：不得改回 running，且保留外部 id 并尝试回收外部 run', async () => {
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
        input_summary: 'QA 派发竞态任务',
      });

      let releaseCreate: (value: { externalTaskId: string; status: string }) => void = (): void => undefined;
      let enterCreate: () => void = (): void => undefined;
      const createGate = new Promise<{ externalTaskId: string; status: string }>((resolve): void => {
        releaseCreate = resolve;
      });
      const entered = new Promise<void>((resolve): void => {
        enterCreate = resolve;
      });
      const reclaimed: string[] = [];
      const adapter: AgentExecutionAdapter = {
        createTask: async (): Promise<{ externalTaskId: string; status: string }> => {
          enterCreate();
          return createGate;
        },
        assignAgent: async () => undefined,
        getTaskStatus: async (): Promise<TaskStatus> => ({ status: 'running' }),
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

      // Worker 已抢占 dispatching 并阻塞在 issue create
      const dispatching = worker.dispatch(created.task.id);
      await entered;
      expect(repo.get('u1', created.task.id)?.status).toBe('dispatching');

      // 用户在派发窗口内取消
      const cancelled = manager.cancelForUser('u1', created.task.id);
      expect(cancelled.ok).toBe(true);

      releaseCreate({ externalTaskId: 'MUL-RACE-2', status: 'todo' });
      await dispatching;

      const final = repo.get('u1', created.task.id);
      expect(final?.status).toBe('cancelled');
      expect(final?.external_task_id).toBe('MUL-RACE-2');
      expect(reclaimed).toEqual(['MUL-RACE-2']);
    } finally {
      db.close();
    }
  });

  it('取消与 maxPolls 交叉：达到轮询上限的失败判定也不得覆盖 cancelled', async () => {
    const db: Database = Database.open(':memory:');
    db.migrate();
    try {
      const repo = new TaskRepository(db);
      const manager = new TaskManager(repo);
      const created = repo.create({
        user_id: 'u1',
        conversation_id: 'conv_maxpolls_race',
        request_id: 'req_maxpolls_race',
        execution_mode: 'agent_delegation',
        input_summary: 'QA maxPolls 交叉任务',
      });
      repo.update(created.task.id, { status: 'running', external_task_id: 'MUL-MAXPOLL-9' });
      // 下一次轮询即触发 maxPolls 超限（maxPolls=1 且 poll_count 已为 5）
      db.run('UPDATE execution_tasks SET poll_count = 5 WHERE id = ?', [created.task.id]);

      let releaseStatus: (value: TaskStatus) => void = (): void => undefined;
      let enterStatus: () => void = (): void => undefined;
      const statusGate = new Promise<TaskStatus>((resolve): void => {
        releaseStatus = resolve;
      });
      const entered = new Promise<void>((resolve): void => {
        enterStatus = resolve;
      });
      const adapter: AgentExecutionAdapter = {
        createTask: async () => ({ externalTaskId: 'MUL-MAXPOLL-9', status: 'created' }),
        assignAgent: async () => undefined,
        getTaskStatus: async (): Promise<TaskStatus> => {
          enterStatus();
          return statusGate;
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

      const ticking = worker.tick();
      await entered;

      expect(manager.cancelForUser('u1', created.task.id).ok).toBe(true);

      releaseStatus({ status: 'running', rawStatus: 'running' });
      await ticking;

      const final = repo.get('u1', created.task.id);
      expect(final?.status).toBe('cancelled');
      expect(final?.error).toBe('用户取消任务');
    } finally {
      db.close();
    }
  });
});
