/**
 * 业务任务门面：协调 tasks 与 execution_tasks 的生命周期、并发防重、失败分类、重试与事务级事件追踪。
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
import type {
  ExecutionEventRecord,
  ExecutionEventStore,
  NewExecutionEventInput,
} from './execution-event-store';
import {
  classifyExecutionFailure,
  formatTaskLifecycleSummary,
  type ExecutionFailureCategory,
} from './execution-lifecycle';
import type { TaskAcceptanceManager } from './task-acceptance-manager';
import type { TaskDependencyRepository } from './task-dependency-repository';
import type { ExecutionTask, TaskRepository } from './task-repository';

export interface PrepareExecutionOptions {
  agentId?: string;
  conversationId?: string;
  inputSummary?: string;
  multicaEnabled: boolean;
  defaultAgentId?: string;
  forceRetry?: boolean;
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
  dependencies: string[];
  dependents: string[];
  latest_execution: ExecutionTask | null;
  execution_count: number;
  recent_events: ExecutionEventRecord[];
  lifecycle_summary: string;
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
    private readonly eventStore?: ExecutionEventStore,
    private readonly onTaskCompleted?: (params: {
      userId: string;
      taskId: string;
      agentId: string | null;
      result: string;
    }) => void,
    private readonly dependencyRepo?: TaskDependencyRepository,
    private readonly acceptanceManager?: TaskAcceptanceManager,
  ) {}

  private validateExecutableAgent(agentId: string, multicaEnabled: boolean): AgentProfile {
    const agent = this.agentStore.get(agentId);
    if (!agent) {
      throw new DomainError(404, 'agent_not_found', `Agent ${agentId} 不存在`);
    }
    if (agent.status !== 'active') {
      throw new DomainError(409, 'agent_disabled', `Agent ${agentId} 已禁用`, 'conflict');
    }
    if (agent.execution_backend === 'multica' && !multicaEnabled) {
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
    return agent;
  }

  private recordLifecycleCreationEvents(
    execution: ExecutionTask,
    previousExecution?: ExecutionTask,
  ): void {
    if (!this.eventStore) return;
    if (previousExecution) {
      const switchedAgent =
        Boolean(execution.agent_id) && execution.agent_id !== previousExecution.agent_id;
      this.eventStore.record({
        executionId: execution.id,
        taskId: execution.task_id,
        userId: execution.user_id,
        eventType: 'retried',
        agentId: execution.agent_id,
        status: execution.status,
        message: switchedAgent
          ? `更换 Agent 为 ${execution.agent_id} 重新执行（前次 ${previousExecution.id}）`
          : `重试执行（前次 ${previousExecution.id}）`,
        metadata: {
          retry_of_execution_id: previousExecution.id,
          previous_agent_id: previousExecution.agent_id,
          new_agent_id: execution.agent_id,
          switched_agent: switchedAgent,
        },
      });
    }
    this.eventStore.record({
      executionId: execution.id,
      taskId: execution.task_id,
      userId: execution.user_id,
      eventType: 'created',
      agentId: execution.agent_id,
      status: execution.status,
      message: `创建 Execution（${execution.execution_mode}）`,
      metadata: { execution_mode: execution.execution_mode },
    });
    if (execution.status === 'running') {
      this.eventStore.record({
        executionId: execution.id,
        taskId: execution.task_id,
        userId: execution.user_id,
        eventType: 'started',
        agentId: execution.agent_id,
        status: 'running',
        message: `Agent ${execution.agent_id ?? 'default'} 开始执行`,
      });
    }
  }

  create(
    userId: string,
    input: NewBusinessTaskInput,
    userOptions?: EnsureUserOptions,
  ): BusinessTask {
    return this.db.transaction((): BusinessTask => {
      const task = this.businessRepo.createInTx(userId, input, userOptions);
      if (input.depends_on_task_ids && input.depends_on_task_ids.length > 0) {
        this.dependencyRepo?.setDependencies(userId, task.id, input.depends_on_task_ids);
        if (!this.dependencyRepo?.areDependenciesSatisfied(userId, task.id)) {
          this.businessRepo.casStatusInTx(userId, task.id, task.status, 'blocked');
        }
      }
      const refreshed = this.businessRepo.getActive(userId, task.id) || task;
      return {
        ...refreshed,
        depends_on_task_ids: this.dependencyRepo?.listDependencies(userId, task.id) ?? [],
      };
    });
  }

  get(userId: string, taskId: string): BusinessTask | undefined {
    const task = this.businessRepo.getActive(userId, taskId);
    if (!task) return undefined;
    return {
      ...task,
      depends_on_task_ids: this.dependencyRepo?.listDependencies(userId, taskId) ?? [],
    };
  }

  getDetail(userId: string, taskId: string): BusinessTaskDetail | undefined {
    const task = this.get(userId, taskId);
    if (!task) return undefined;
    const subtasks = this.businessRepo.listSubtasks(userId, taskId);
    const execPage = this.taskRepo.listByTaskId(userId, taskId, 1, 0);
    const latestExecution = execPage.items[0] ?? null;
    const recentEvents = this.eventStore
      ? this.eventStore.listByTask(userId, taskId, 30, 0).items
      : [];
    const dependencies = this.dependencyRepo?.listDependencies(userId, taskId) ?? [];
    const dependents = this.dependencyRepo?.listDependents(userId, taskId) ?? [];
    return {
      task,
      subtasks,
      subtask_stats: this.businessRepo.subtaskStats(subtasks),
      dependencies,
      dependents,
      latest_execution: latestExecution,
      execution_count: execPage.total,
      recent_events: recentEvents,
      lifecycle_summary: formatTaskLifecycleSummary(task, latestExecution, execPage.total),
    };
  }

  list(userId: string, filters?: BusinessTaskFilters): PageResult<BusinessTask> {
    return this.businessRepo.list(userId, filters);
  }

  update(userId: string, taskId: string, patch: BusinessTaskPatch): BusinessTask | undefined {
    return this.db.transaction((): BusinessTask | undefined => {
      if (patch.depends_on_task_ids) {
        this.dependencyRepo?.setDependencies(userId, taskId, patch.depends_on_task_ids);
      }
      const updated = this.businessRepo.updateInTx(userId, taskId, patch);
      if (!updated) return undefined;
      return {
        ...updated,
        depends_on_task_ids: this.dependencyRepo?.listDependencies(userId, taskId) ?? [],
      };
    });
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

  listExecutionEvents(
    userId: string,
    taskId: string,
    limit = 100,
    offset = 0,
  ): { items: ExecutionEventRecord[]; total: number } | undefined {
    const task = this.businessRepo.getActive(userId, taskId);
    if (!task) return undefined;
    if (!this.eventStore) return { items: [], total: 0 };
    return this.eventStore.listByTask(userId, taskId, limit, offset);
  }

  recordEvent(input: NewExecutionEventInput): ExecutionEventRecord | undefined {
    return this.eventStore?.record(input);
  }

  /** 为正在运行的直连/OpenClaw 执行记录心跳进度与事件，避免误判为僵死。 */
  recordExecutionProgress(
    executionId: string,
    message: string,
    options: { eventType?: 'progress' | 'tool_call'; metadata?: Record<string, unknown> } = {},
  ): void {
    const exec = this.taskRepo.getById(executionId);
    if (!exec) return;
    const now: string = new Date().toISOString();
    this.taskRepo.updateIfActive(executionId, {
      progress_message: message.slice(0, 500),
      last_progress_at: now,
    });
    this.eventStore?.record({
      executionId,
      taskId: exec.task_id,
      userId: exec.user_id,
      eventType: options.eventType ?? 'progress',
      agentId: exec.agent_id,
      status: exec.status,
      message,
      metadata: options.metadata,
    });
  }

  /**
   * 原子抢占执行权并创建独立 execution_tasks 记录（首次执行 / 重试 / 换 Agent 重试）。
   * 禁止重跑已完成任务；对不可重试失败且未更换 Agent 的调用需显式传入 forceRetry。
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

      if (this.dependencyRepo) {
        const unfinished = this.dependencyRepo.getUnfinishedDependencies(userId, task.id);
        if (unfinished.length > 0) {
          const names = unfinished.map((u) => `${u.title}(${u.id})[${u.status}]`).join(', ');
          throw new DomainError(
            409,
            'dependencies_not_satisfied',
            `前置依赖任务尚未完成，无法开始执行：${names}`,
            'conflict',
          );
        }
      }

      const targetAgentId: string =
        (options.agentId && options.agentId.trim()) ||
        task.assignee_agent_id ||
        options.defaultAgentId ||
        'developer';
      const agent = this.validateExecutableAgent(targetAgentId, options.multicaEnabled);

      const previousExec = this.taskRepo.getLatestByTaskId(userId, task.id);
      if (
        previousExec &&
        previousExec.status === 'failed' &&
        !previousExec.retryable &&
        agent.agent_id === previousExec.agent_id &&
        !options.forceRetry
      ) {
        throw new DomainError(
          409,
          'non_retryable_failure',
          `最近一次执行（${previousExec.id}）属于不可重试失败：${previousExec.error ?? '配置或权限异常'}；请先修正问题、更换其他 Agent 或显式启用强制重试`,
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
        request_id: `exec_${randomUUID()}`,
        agent_id: agent.agent_id,
        project_id: task.project_id,
        execution_mode:
          agent.execution_backend === 'direct_llm' ? 'direct_llm' : 'agent_delegation',
        input_summary: summary,
        initial_status: agent.execution_backend === 'direct_llm' ? 'running' : 'pending',
        retry_of_execution_id: previousExec?.id ?? null,
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

      this.recordLifecycleCreationEvents(execution, previousExec);

      return {
        task: this.businessRepo.getActive(userId, task.id) as BusinessTask,
        execution,
        agent,
      };
    });
  }

  /**
   * 供 PersonalAIRuntime 对话路由调用：按 (user_id, request_id) 幂等创建业务 Task 与关联 Execution。
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
        agent = this.validateExecutableAgent(options.agentId.trim(), options.multicaEnabled);
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

      this.recordLifecycleCreationEvents(execution);

      return {
        task: this.businessRepo.getActive(options.userId, businessTask.id) as BusinessTask,
        execution,
        agent,
        created: true,
      };
    });
  }

  /** 统一完成/推进执行的接口别名（代理至 finishDirectExecution） */
  completeExecution(
    executionId: string,
    outcome:
      | { status: 'completed'; result: string }
      | {
          status: 'failed';
          error: string;
          statusCode?: number;
          errorCode?: string;
          categoryOverride?: ExecutionFailureCategory;
        }
      | { status: 'cancelled'; error?: string },
  ): boolean {
    return this.finishDirectExecution(executionId, outcome);
  }

  /** direct_llm 执行完成/失败/取消时，在同事务内写入分类结果、事件与任务终态。 */
  finishDirectExecution(
    executionId: string,
    outcome:
      | { status: 'completed'; result: string }
      | {
          status: 'failed';
          error: string;
          statusCode?: number;
          errorCode?: string;
          categoryOverride?: ExecutionFailureCategory;
        }
      | { status: 'cancelled'; error?: string },
  ): boolean {
    const exec = this.taskRepo.getById(executionId);
    if (!exec) return false;
    const applied = this.db.transaction((): boolean => {
      const current = this.taskRepo.getById(executionId);
      if (!current) return false;
      const now: string = new Date().toISOString();

      if (outcome.status === 'completed') {
        const task = current.task_id ? this.businessRepo.getActive(current.user_id, current.task_id) : undefined;
        const requiresReview = Boolean(task && this.acceptanceManager?.shouldRequireReview(task));

        if (requiresReview && task && this.acceptanceManager) {
          const acceptResult = this.acceptanceManager.processAcceptance({
            userId: current.user_id,
            taskId: task.id,
            executionId,
            result: outcome.result,
          });
          if (acceptResult.status !== 'approved') {
            this.taskRepo.updateIfActive(executionId, {
              status: 'completed',
              result: outcome.result,
              error_category: null,
              error_code: null,
              retryable: false,
              needs_verification: acceptResult.status === 'escalated_to_user',
              completed_at: now,
            });
            return true;
          }
        }

        const updated = this.taskRepo.updateIfActive(executionId, {
          status: 'completed',
          result: outcome.result,
          error_category: null,
          error_code: null,
          retryable: false,
          needs_verification: false,
          completed_at: now,
        });
        if (updated) {
          this.eventStore?.record({
            executionId,
            taskId: current.task_id,
            userId: current.user_id,
            eventType: 'completed',
            agentId: current.agent_id,
            status: 'completed',
            message: '执行成功完成',
          });
          if (current.task_id) {
            this.businessRepo.casSyncTerminalInTx(current.task_id, 'completed');
            if (this.dependencyRepo) {
              const dependents = this.dependencyRepo.listDependents(current.user_id, current.task_id);
              for (const depId of dependents) {
                if (this.dependencyRepo.areDependenciesSatisfied(current.user_id, depId)) {
                  const depTask = this.businessRepo.getActive(current.user_id, depId);
                  if (depTask && depTask.status === 'blocked') {
                    this.businessRepo.updateInTx(current.user_id, depId, { status: 'ready' });
                  }
                }
              }
            }
          }
        }
        return updated;
      }

      if (outcome.status === 'cancelled') {
        const reason = outcome.error ?? '用户取消任务';
        const updated = this.taskRepo.updateIfActive(executionId, {
          status: 'cancelled',
          error: reason,
          error_category: 'cancelled',
          error_code: 'cancelled_by_user',
          retryable: false,
          needs_verification: false,
          completed_at: now,
        });
        if (updated) {
          this.eventStore?.record({
            executionId,
            taskId: current.task_id,
            userId: current.user_id,
            eventType: 'cancelled',
            agentId: current.agent_id,
            status: 'cancelled',
            message: reason,
          });
          if (current.task_id) this.businessRepo.casSyncTerminalInTx(current.task_id, 'cancelled');
        }
        return updated;
      }

      const classified = classifyExecutionFailure({
        message: outcome.error,
        statusCode: outcome.statusCode,
        codeOverride: outcome.errorCode,
        categoryOverride: outcome.categoryOverride,
      });
      const updated = this.taskRepo.updateIfActive(executionId, {
        status: 'failed',
        error: classified.message,
        error_category: classified.category,
        error_code: classified.code,
        retryable: classified.retryable,
        needs_verification: classified.needsVerification,
        completed_at: now,
      });
      if (updated) {
        this.eventStore?.record({
          executionId,
          taskId: current.task_id,
          userId: current.user_id,
          eventType: classified.needsVerification ? 'verification_required' : 'failed',
          agentId: current.agent_id,
          status: 'failed',
          message: classified.message,
          metadata: {
            error_category: classified.category,
            error_code: classified.code,
            retryable: classified.retryable,
            needs_verification: classified.needsVerification,
          },
        });
        if (current.task_id) {
          this.businessRepo.casSyncTerminalInTx(current.task_id, 'failed');
          if (this.dependencyRepo) {
            const dependents = this.dependencyRepo.listDependents(current.user_id, current.task_id);
            for (const depId of dependents) {
              const depTask = this.businessRepo.getActive(current.user_id, depId);
              if (depTask && (depTask.status === 'pending' || depTask.status === 'ready')) {
                this.businessRepo.updateInTx(current.user_id, depId, { status: 'blocked' });
              }
            }
          }
        }
      }
      return updated;
    });

    if (applied && outcome.status === 'completed' && exec.task_id) {
      this.onTaskCompleted?.({
        userId: exec.user_id,
        taskId: exec.task_id,
        agentId: exec.agent_id,
        result: outcome.result,
      });
    }
    return applied;
  }

  /** 原子取消业务 Task 与所有关联活跃 Execution，并同步记录 cancelled 事件。 */
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
          error_category: 'cancelled',
          error_code: 'cancelled_by_user',
          retryable: false,
          needs_verification: false,
          completed_at: now,
        });
        if (applied) {
          this.eventStore?.record({
            executionId: exec.id,
            taskId: exec.task_id,
            userId,
            eventType: 'cancelled',
            agentId: exec.agent_id,
            status: 'cancelled',
            message: '用户取消任务',
          });
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
  onExecutionTerminalInTx(taskId: string, status: 'completed' | 'failed' | 'cancelled'): void {
    this.businessRepo.casSyncTerminalInTx(taskId, status);
    const task = this.db.get<{ user_id: string }>('SELECT user_id FROM tasks WHERE id = ?', [taskId]);
    if (!task || !this.dependencyRepo) return;

    if (status === 'completed') {
      const dependents = this.dependencyRepo.listDependents(task.user_id, taskId);
      for (const depId of dependents) {
        if (this.dependencyRepo.areDependenciesSatisfied(task.user_id, depId)) {
          const depTask = this.businessRepo.getActive(task.user_id, depId);
          if (depTask && depTask.status === 'blocked') {
            this.businessRepo.updateInTx(task.user_id, depId, { status: 'ready' });
          }
        }
      }
    } else if (status === 'failed') {
      const dependents = this.dependencyRepo.listDependents(task.user_id, taskId);
      for (const depId of dependents) {
        const depTask = this.businessRepo.getActive(task.user_id, depId);
        if (depTask && (depTask.status === 'pending' || depTask.status === 'ready')) {
          this.businessRepo.updateInTx(task.user_id, depId, { status: 'blocked' });
        }
      }
    }
  }

  getDependencyRepo(): TaskDependencyRepository | undefined {
    return this.dependencyRepo;
  }

  getAcceptanceManager(): TaskAcceptanceManager | undefined {
    return this.acceptanceManager;
  }

  /** 所有子任务完成时，推进父任务收敛为 completed。 */
  advanceParentCompleted(userId: string, parentTaskId: string): boolean {
    const parent = this.businessRepo.getActive(userId, parentTaskId);
    if (!parent) return false;
    return this.businessRepo.casStatusInTx(userId, parentTaskId, parent.status, 'completed');
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
