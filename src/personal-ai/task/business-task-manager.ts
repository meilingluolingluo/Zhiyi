/**
 * 业务任务门面：协调 tasks 与 execution_tasks 的生命周期、并发防重、重试与事务级取消。
 */
import { randomUUID } from 'node:crypto';
import type { AgentStore } from '../../agents';
import type { Database } from '../../db';
import type { AgentProfile } from '../../types';
import {
  DomainError,
  type BusinessTask,
  type BusinessTaskFilters,
  type BusinessTaskPatch,
  type EnsureUserOptions,
  type NewBusinessTaskInput,
  type PageResult,
  type SubtaskStats,
} from '../domain/types';
import type { BusinessTaskRepository } from './business-task-repository';
import type { ExecutionTask, TaskRepository } from './task-repository';

export interface PrepareExecutionOptions {
  agentId?: string;
  conversationId?: string;
  inputSummary?: string;
  multicaEnabled: boolean;
  defaultAgentId?: string;
}

export interface PrepareAdhocDelegationOptions {
  userId: string;
  conversationId: string;
  requestId: string;
  title: string;
  description: string;
  agentId: string | null;
  projectId: string | null;
  multicaEnabled: boolean;
  userOptions?: EnsureUserOptions;
}

export interface PreparedAdhocDelegation {
  task: BusinessTask | null;
  execution: ExecutionTask;
  agent: AgentProfile | null;
  created: boolean;
}

export interface PreparedExecution {
  task: BusinessTask;
  execution: ExecutionTask;
  agent: AgentProfile;
}

export interface BusinessTaskDetail {
  task: BusinessTask;
  subtasks: BusinessTask[];
  subtask_stats: SubtaskStats;
  latest_execution: ExecutionTask | null;
}

export interface CancelBusinessTaskResult {
  task: BusinessTask;
  cancelled_executions: ExecutionTask[];
}

const EXECUTABLE_TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'ready',
  'assigned',
  'failed',
  'blocked',
]);

export class BusinessTaskManager {
  constructor(
    private readonly db: Database,
    private readonly businessRepo: BusinessTaskRepository,
    private readonly taskRepo: TaskRepository,
    private readonly agentStore: AgentStore,
  ) {}

  create(
    userId: string,
    input: NewBusinessTaskInput,
    userOptions?: EnsureUserOptions,
  ): BusinessTask {
    return this.businessRepo.create(userId, input, userOptions);
  }

  get(userId: string, taskId: string): BusinessTask | undefined {
    return this.businessRepo.getActive(userId, taskId);
  }

  getDetail(userId: string, taskId: string): BusinessTaskDetail | undefined {
    const task = this.businessRepo.getActive(userId, taskId);
    if (!task) return undefined;
    const subtasks = this.businessRepo.listSubtasks(userId, taskId);
    const latestExecution = this.taskRepo.getLatestByTaskId(userId, taskId) ?? null;
    return {
      task,
      subtasks,
      subtask_stats: this.businessRepo.subtaskStats(subtasks),
      latest_execution: latestExecution,
    };
  }

  list(userId: string, filters?: BusinessTaskFilters): PageResult<BusinessTask> {
    return this.businessRepo.list(userId, filters);
  }

  update(userId: string, taskId: string, patch: BusinessTaskPatch): BusinessTask | undefined {
    return this.businessRepo.update(userId, taskId, patch);
  }

  softDelete(userId: string, taskId: string, cascade = false): boolean {
    return this.businessRepo.softDelete(userId, taskId, cascade);
  }

  listExecutions(
    userId: string,
    taskId: string,
    limit?: number,
    offset?: number,
  ): { items: ExecutionTask[]; total: number } | undefined {
    const task = this.businessRepo.getActive(userId, taskId);
    if (!task) return undefined;
    return this.taskRepo.listByTaskId(userId, taskId, limit, offset);
  }

  /**
   * 原子抢占执行权并创建一条新的 execution_tasks 记录（用于首次执行、失败重试或换 Agent 重试）。
   * 依赖 BEGIN IMMEDIATE 事务 + idx_execution_tasks_one_active_per_task 双重防并发。
   */
  prepareExecution(
    userId: string,
    taskId: string,
    options: PrepareExecutionOptions,
  ): PreparedExecution {
    return this.db.transaction((): PreparedExecution => {
      const task = this.businessRepo.getActive(userId, taskId);
      if (!task) {
        throw new DomainError(404, 'not_found', '业务任务不存在或无权访问');
      }
      if (!EXECUTABLE_TASK_STATUSES.has(task.status)) {
        throw new DomainError(
          409,
          'invalid_status_for_execute',
          `任务当前状态 ${task.status} 不允许执行`,
          'conflict',
        );
      }
      if (this.taskRepo.hasActiveByTaskId(task.id)) {
        throw new DomainError(
          409,
          'active_execution_exists',
          '该任务已有正在执行的 Execution',
          'conflict',
        );
      }

      const targetAgentId: string =
        (options.agentId && options.agentId.trim()) ||
        task.assignee_agent_id ||
        options.defaultAgentId ||
        'developer';

      const agent = this.agentStore.get(targetAgentId);
      if (!agent) {
        throw new DomainError(404, 'agent_not_found', `Agent ${targetAgentId} 不存在`);
      }
      if (agent.status !== 'active') {
        throw new DomainError(409, 'agent_disabled', `Agent ${targetAgentId} 已禁用`, 'conflict');
      }
      if (agent.execution_backend === 'multica' && !options.multicaEnabled) {
        throw new DomainError(
          503,
          'multica_disabled',
          'MultiCA 未启用（MULTICA_ENABLED=false）',
          'service_unavailable',
        );
      }
      const activeCount: number = this.taskRepo.countActiveByAgent(agent.agent_id);
      if (activeCount >= agent.concurrency_limit) {
        throw new DomainError(
          409,
          'agent_concurrency_limit',
          `Agent ${agent.agent_id} 已达到并发上限（${agent.concurrency_limit}）`,
          'conflict',
        );
      }

      if (options.agentId && agent.agent_id !== task.assignee_agent_id) {
        this.businessRepo.setAssigneeInTx(userId, task.id, agent.agent_id);
      }

      const summary: string =
        options.inputSummary ??
        ([task.title, task.description].filter(Boolean).join('\n\n') || task.title);

      const { task: execution, created } = this.taskRepo.create({
        task_id: task.id,
        user_id: userId,
        conversation_id: options.conversationId ?? `task_conv_${task.id}`,
        // 每次执行/重试生成独立 request_id，绝不覆盖历史 execution_tasks
        request_id: `exec_${randomUUID()}`,
        agent_id: agent.agent_id,
        project_id: task.project_id,
        execution_mode:
          agent.execution_backend === 'direct_llm' ? 'direct_llm' : 'agent_delegation',
        input_summary: summary,
        initial_status: agent.execution_backend === 'direct_llm' ? 'running' : 'pending',
      });
      if (!created) {
        throw new DomainError(409, 'execution_create_conflict', '创建 Execution 冲突', 'conflict');
      }

      const transitioned: boolean = this.businessRepo.casStatusInTx(
        userId,
        task.id,
        task.status,
        'in_progress',
      );
      if (!transitioned) {
        throw new DomainError(409, 'status_conflict', '任务状态已被并发变更', 'conflict');
      }

      return {
        task: this.businessRepo.getActive(userId, task.id) as BusinessTask,
        execution,
        agent,
      };
    });
  }

  /**
   * 供 PersonalAIRuntime 对话路由调用：按 (user_id, request_id) 幂等创建业务 Task 与关联 Execution。
   * 对不归属当前用户或仅为 V1 兼容占位字符串（非 projects 表记录）的 projectId 自动脱敏为 null。
   */
  prepareAdhocDelegation(options: PrepareAdhocDelegationOptions): PreparedAdhocDelegation {
    return this.db.transaction((): PreparedAdhocDelegation => {
      const existingExec = this.taskRepo.getByRequestId(options.userId, options.requestId);
      if (existingExec) {
        const existingTask = existingExec.task_id
          ? (this.businessRepo.getActive(options.userId, existingExec.task_id) ?? null)
          : null;
        const existingAgent = existingExec.agent_id
          ? (this.agentStore.get(existingExec.agent_id) ?? null)
          : null;
        return {
          task: existingTask,
          execution: existingExec,
          agent: existingAgent,
          created: false,
        };
      }

      let agent: AgentProfile | null = null;
      if (options.agentId && options.agentId.trim() !== '') {
        const found = this.agentStore.get(options.agentId.trim());
        if (!found) {
          throw new DomainError(404, 'agent_not_found', `Agent ${options.agentId} 不存在`);
        }
        if (found.status !== 'active') {
          throw new DomainError(409, 'agent_disabled', `Agent ${found.agent_id} 已禁用`, 'conflict');
        }
        if (found.execution_backend === 'multica' && !options.multicaEnabled) {
          throw new DomainError(
            503,
            'multica_disabled',
            'MultiCA 未启用（MULTICA_ENABLED=false）',
            'service_unavailable',
          );
        }
        if (this.taskRepo.countActiveByAgent(found.agent_id) >= found.concurrency_limit) {
          throw new DomainError(
            409,
            'agent_concurrency_limit',
            `Agent ${found.agent_id} 已达到并发上限（${found.concurrency_limit}）`,
            'conflict',
          );
        }
        agent = found;
      }

      const validProjectId: string | null =
        options.projectId &&
        options.projectId.trim() !== '' &&
        this.businessRepo.hasOwnedActiveProjectInTx(options.userId, options.projectId.trim())
          ? options.projectId.trim()
          : null;

      const safeTitle: string = (options.title || '').trim().slice(0, 200) || '知忆委派任务';
      const businessTask: BusinessTask = this.businessRepo.createInTx(
        options.userId,
        {
          title: safeTitle,
          description: options.description,
          project_id: validProjectId,
          assignee_agent_id: agent?.agent_id ?? null,
          status: agent ? 'assigned' : 'pending',
        },
        options.userOptions,
      );

      const isDirectAgent: boolean = agent?.execution_backend === 'direct_llm';
      const { task: execution, created } = this.taskRepo.create({
        task_id: businessTask.id,
        user_id: options.userId,
        conversation_id: options.conversationId,
        request_id: options.requestId,
        agent_id: agent?.agent_id ?? null,
        project_id: options.projectId,
        execution_mode: isDirectAgent ? 'direct_llm' : 'agent_delegation',
        input_summary: options.description,
        initial_status: isDirectAgent ? 'running' : 'pending',
      });
      if (!created) {
        throw new DomainError(409, 'execution_create_conflict', '创建 Execution 冲突', 'conflict');
      }

      const transitioned: boolean = this.businessRepo.casStatusInTx(
        options.userId,
        businessTask.id,
        businessTask.status,
        'in_progress',
      );
      if (!transitioned) {
        throw new DomainError(409, 'status_conflict', '任务状态已被并发变更', 'conflict');
      }

      return {
        task: this.businessRepo.getActive(options.userId, businessTask.id) as BusinessTask,
        execution,
        agent,
        created: true,
      };
    });
  }

  /** direct_llm 执行完成/失败/取消时，在同事务内更新 execution_tasks 与 tasks。 */
  finishDirectExecution(
    executionId: string,
    outcome:
      | { status: 'completed'; result: string }
      | { status: 'failed'; error: string }
      | { status: 'cancelled'; error?: string },
  ): boolean {
    return this.db.transaction((): boolean => {
      const exec = this.taskRepo.getById(executionId);
      if (!exec) return false;
      const now: string = new Date().toISOString();
      const applied: boolean =
        outcome.status === 'completed'
          ? this.taskRepo.updateIfActive(executionId, {
              status: 'completed',
              result: outcome.result,
              completed_at: now,
            })
          : this.taskRepo.updateIfActive(executionId, {
              status: outcome.status,
              error: outcome.error ?? (outcome.status === 'cancelled' ? '用户取消任务' : '执行失败'),
              completed_at: now,
            });
      if (applied && exec.task_id) {
        this.businessRepo.casSyncTerminalInTx(exec.task_id, outcome.status);
      }
      return applied;
    });
  }

  /**
   * 原子取消业务 Task 与所有关联活跃 Execution（外部载体中止由调用方在事务外尽力执行）。
   */
  cancelTask(userId: string, taskId: string): CancelBusinessTaskResult {
    return this.db.transaction((): CancelBusinessTaskResult => {
      const task = this.businessRepo.getActive(userId, taskId);
      if (!task) {
        throw new DomainError(404, 'not_found', '业务任务不存在或无权访问');
      }
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        throw new DomainError(
          409,
          `already_${task.status}`,
          `任务已是终态 ${task.status}，无法取消`,
          'conflict',
        );
      }

      const activeExecs = this.taskRepo.listActiveByTaskId(userId, taskId);
      const now: string = new Date().toISOString();
      const cancelledExecs: ExecutionTask[] = [];
      for (const exec of activeExecs) {
        const applied: boolean = this.taskRepo.updateIfActive(exec.id, {
          status: 'cancelled',
          error: '用户取消任务',
          completed_at: now,
        });
        if (applied) {
          cancelledExecs.push(this.taskRepo.getById(exec.id) ?? exec);
        }
      }

      const ok: boolean = this.businessRepo.casStatusInTx(userId, taskId, task.status, 'cancelled');
      if (!ok) {
        throw new DomainError(409, 'status_conflict', '并发状态变更导致取消失败', 'conflict');
      }

      return {
        task: this.businessRepo.getActive(userId, taskId) as BusinessTask,
        cancelled_executions: cancelledExecs,
      };
    });
  }

  /** 供 TaskWorker 终态回写同事务调用。 */
  onExecutionTerminalInTx(taskId: string, status: 'completed' | 'failed'): void {
    this.businessRepo.casSyncTerminalInTx(taskId, status);
  }

  /** 供 TaskManager 取消单条 execution_tasks 时同事务同步对应业务任务。 */
  onExecutionCancelledInTx(taskId: string): void {
    this.businessRepo.casSyncTerminalInTx(taskId, 'cancelled');
  }

  /** 供 TaskWorker.start() 启动对账调用。 */
  reconcileOrphanedInProgressInTx(): number {
    return this.businessRepo.reconcileOrphanedInProgressInTx();
  }
}
