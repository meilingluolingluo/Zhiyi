/**
 * Watchdog 执行监督守护器：定期检查运行态任务、检测超时与死循环、
 * 级联处理依赖阻塞、推进子任务完成后的父任务收敛，并结合主动通知防重复告警。
 */
import type { Database } from '../../db';
import type { Logger } from '../../logger';
import type { BusinessTask, BusinessTaskStatus, SubtaskStats } from '../domain/types';
import type { ProactiveStore } from '../proactive/proactive-store';
import type { BusinessTaskManager } from '../task/business-task-manager';
import type { BusinessTaskRepository } from '../task/business-task-repository';
import type { ExecutionEventRecord, ExecutionEventStore } from '../task/execution-event-store';
import type { TaskDependencyRepository } from '../task/task-dependency-repository';
import type { ExecutionTask, TaskRepository } from '../task/task-repository';

export interface WatchdogThresholds {
  directStallMs: number;
  externalStallMs: number;
  repetitionThreshold: number;
}

const DEFAULT_THRESHOLDS: WatchdogThresholds = {
  directStallMs: 5 * 60_000,
  externalStallMs: 30 * 60_000,
  repetitionThreshold: 3,
};

export interface WatchdogDeps {
  db: Database;
  taskRepo: TaskRepository;
  businessRepo: BusinessTaskRepository;
  businessTaskManager: BusinessTaskManager;
  proactiveStore: ProactiveStore;
  logger: Logger;
  dependencyRepo?: TaskDependencyRepository;
  eventStore?: ExecutionEventStore;
  thresholds?: Partial<WatchdogThresholds>;
  onAdvanceParentTask?: (userId: string, parentTaskId: string) => Promise<void> | void;
}

export interface WatchdogScanResult {
  stalledExecutionsCount: number;
  loopsDetectedCount: number;
  desyncedTasksFixedCount: number;
  parentTasksAdvancedCount: number;
  cascadedBlocksCount: number;
}

export class Watchdog {
  private readonly thresholds: WatchdogThresholds;

  constructor(private readonly deps: WatchdogDeps) {
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...deps.thresholds,
    };
  }

  /**
   * 检查单一执行是否存在工具调用或动作死循环：
   * 若最近若干条事件均为相同工具或相同入参调用，则判定为疑似死循环。
   */
  checkRepetitionLoop(events: ExecutionEventRecord[]): boolean {
    if (events.length < this.thresholds.repetitionThreshold) return false;
    const recent = events.slice(0, this.thresholds.repetitionThreshold);

    // 检查连续工具调用是否完全一致
    const toolCalls = recent.filter((e) => e.event_type === 'tool_call');
    if (toolCalls.length >= this.thresholds.repetitionThreshold) {
      const firstPayload = JSON.stringify(toolCalls[0].metadata);
      const allIdentical = toolCalls.every(
        (e) => JSON.stringify(e.metadata) === firstPayload,
      );
      if (allIdentical) return true;
    }

    // 检查连续相同报错重试循环
    const progressCalls = recent.filter((e) => e.event_type === 'progress');
    if (progressCalls.length >= this.thresholds.repetitionThreshold) {
      const firstMsg = progressCalls[0].message;
      const allIdentical = progressCalls.every((e) => e.message === firstMsg);
      if (allIdentical && firstMsg) return true;
    }

    return false;
  }

  /** 执行一次全局巡检与异常收敛。 */
  async tick(): Promise<WatchdogScanResult> {
    const result: WatchdogScanResult = {
      stalledExecutionsCount: 0,
      loopsDetectedCount: 0,
      desyncedTasksFixedCount: 0,
      parentTasksAdvancedCount: 0,
      cascadedBlocksCount: 0,
    };

    try {
      // 1. 检查运行中 Execution 的死循环与停滞
      const activeExecutions = this.deps.taskRepo.listAllActive
        ? this.deps.taskRepo.listAllActive(100)
        : this.deps.taskRepo.listActive(100);
      const now = Date.now();

      for (const exec of activeExecutions) {
        // A. 死循环判定
        if (this.deps.eventStore) {
          const events = this.deps.eventStore.listRecentByExecution
            ? this.deps.eventStore.listRecentByExecution(exec.user_id, exec.id, 10)
            : this.deps.eventStore.listByExecution(exec.user_id, exec.id, 10).items;
          if (this.checkRepetitionLoop(events)) {
            this.deps.logger.warn(`[watchdog] 检测到 Execution ${exec.id} 存在死循环/重复动作，实施保护性熔断`);
            this.deps.taskRepo.updateIfActive(exec.id, {
              status: 'failed',
              error: '检测到 Worker 重复执行疑似死循环，已主动中止保护',
              error_category: 'non_retryable',
              error_code: 'repetition_loop_detected',
              retryable: false,
              needs_verification: false,
              completed_at: new Date().toISOString(),
            });
            this.deps.eventStore.record({
              executionId: exec.id,
              taskId: exec.task_id,
              userId: exec.user_id,
              eventType: 'failed',
              agentId: exec.agent_id,
              status: 'failed',
              message: '检测到 Worker 重复执行疑似死循环，已中止执行并标记为不可重试',
              metadata: { error_code: 'repetition_loop_detected' },
            });
            if (exec.task_id) {
              const currentTask = this.deps.businessRepo.getActive(exec.user_id, exec.task_id);
              if (currentTask) {
                this.deps.businessRepo.casStatusInTx(exec.user_id, exec.task_id, currentTask.status, 'blocked');
              }
            }
            this.deps.proactiveStore.createIfNew({
              userId: exec.user_id,
              kind: 'decision_needed',
              entityType: 'task',
              entityId: exec.task_id ?? exec.id,
              dedupeKey: `watchdog:loop:${exec.id}`,
              title: '任务疑似死循环已被中止',
              summary: `任务执行（${exec.id}）触发死循环保护熔断，已停止自动推进，等待人工复核。`,
              evidence: { execution_id: exec.id, task_id: exec.task_id },
            });
            result.loopsDetectedCount += 1;
            continue;
          }
        }

        // B. 超时与进度停滞判定
        const lastActivity = exec.last_progress_at || exec.started_at || exec.created_at;
        const lastActivityMs = new Date(lastActivity).getTime();
        const stallThreshold =
          exec.execution_mode === 'direct_llm'
            ? this.thresholds.directStallMs
            : this.thresholds.externalStallMs;

        if (now - lastActivityMs > stallThreshold) {
          this.deps.logger.warn(`[watchdog] Execution ${exec.id} 超过 ${stallThreshold}ms 无进展，收敛为 failed + 需核实`);
          this.deps.taskRepo.updateIfActive(exec.id, {
            status: 'failed',
            error: `执行停滞超时（超过 ${Math.round(stallThreshold / 60000)} 分钟无心跳或进展），外部状态未能确认`,
            error_category: 'transient',
            error_code: 'watchdog_stalled_timeout',
            retryable: true,
            needs_verification: true,
            completed_at: new Date().toISOString(),
          });
          this.deps.eventStore?.record({
            executionId: exec.id,
            taskId: exec.task_id,
            userId: exec.user_id,
            eventType: 'verification_required',
            agentId: exec.agent_id,
            status: 'failed',
            message: '执行停滞超时，结果未能确认，需人工核实后重试',
            metadata: {
              error_code: 'watchdog_stalled_timeout',
              needs_verification: true,
            },
          });
          if (exec.task_id) {
            this.deps.businessRepo.casSyncTerminalInTx(exec.task_id, 'failed');
          }
          this.deps.proactiveStore.createIfNew({
            userId: exec.user_id,
            kind: 'task_verification',
            entityType: 'task',
            entityId: exec.task_id ?? exec.id,
            dedupeKey: `watchdog:stall:${exec.id}`,
            title: '任务执行停滞需人工核实',
            summary: `执行（${exec.id}）长时间未收到心跳或进度回报，已安全收敛为失败并标记需核实，未盲目假定成功。`,
            evidence: { execution_id: exec.id, task_id: exec.task_id },
          });
          result.stalledExecutionsCount += 1;
        }
      }

      // 2. 检查 Execution 终态与 Task 状态不同步的孤儿对账
      const inProgressTasks = this.deps.db.all<{ id: string; user_id: string }>(
        "SELECT id, user_id FROM tasks WHERE status = 'in_progress' AND deleted_at IS NULL",
      );
      for (const t of inProgressTasks) {
        const latestExec = this.deps.taskRepo.getLatestByTaskId(t.user_id, t.id);
        if (latestExec && (latestExec.status === 'completed' || latestExec.status === 'failed' || latestExec.status === 'cancelled')) {
          this.deps.businessRepo.casSyncTerminalInTx(t.id, latestExec.status);
          result.desyncedTasksFixedCount += 1;
        }
      }

      // 3. 检查子任务已全部完成但父任务滞留的情况
      const parentCandidateRows = this.deps.db.all<{ id: string; user_id: string; title: string; status: BusinessTaskStatus }>(
        `SELECT DISTINCT p.id, p.user_id, p.title, p.status
         FROM tasks p
         JOIN tasks c ON c.parent_task_id = p.id AND c.user_id = p.user_id
         WHERE p.status IN ('pending', 'ready', 'in_progress') AND p.deleted_at IS NULL`,
      );
      for (const parent of parentCandidateRows) {
        const subtasks = this.deps.businessRepo.listSubtasks(parent.user_id, parent.id);
        if (subtasks.length > 0) {
          const stats: SubtaskStats = this.deps.businessRepo.subtaskStats(subtasks);
          if (stats.completed === stats.total && stats.total > 0) {
            // 所有子任务全部完成！推进父任务
            this.deps.businessTaskManager.advanceParentCompleted(parent.user_id, parent.id);
            this.deps.proactiveStore.createIfNew({
              userId: parent.user_id,
              kind: 'task_completed_summary',
              entityType: 'task',
              entityId: parent.id,
              dedupeKey: `watchdog:parent_done:${parent.id}`,
              title: `父任务全部子任务已完成：${parent.title}`,
              summary: `父任务【${parent.title}】的全部 ${stats.total} 个子任务均已执行完成，父任务已自动收敛为完成状态。`,
              evidence: { parent_task_id: parent.id, subtask_count: stats.total },
            });
            await this.deps.onAdvanceParentTask?.(parent.user_id, parent.id);
            result.parentTasksAdvancedCount += 1;
          }
        }
      }

      // 4. 前置任务失败引发的级联阻塞检查
      if (this.deps.dependencyRepo) {
        const pendingTasks = this.deps.db.all<{ id: string; user_id: string }>(
          "SELECT id, user_id FROM tasks WHERE status IN ('pending', 'ready') AND deleted_at IS NULL",
        );
        for (const pt of pendingTasks) {
          const failedPrereqs = this.deps.dependencyRepo.getFailedDependencies(pt.user_id, pt.id);
          if (failedPrereqs.length > 0) {
            this.deps.businessRepo.update(pt.user_id, pt.id, { status: 'blocked' });
            const failedNames = failedPrereqs.map((f) => `${f.title}(${f.id})`).join('、');
            this.deps.proactiveStore.createIfNew({
              userId: pt.user_id,
              kind: 'decision_needed',
              entityType: 'task',
              entityId: pt.id,
              dedupeKey: `watchdog:cascade_fail:${pt.id}`,
              title: '前置依赖失败导致下游任务阻塞',
              summary: `任务【${pt.id}】的前置依赖任务（${failedNames}）已失败，下游任务已自动置为阻塞，请人工决策是否重试或调整计划。`,
              evidence: { task_id: pt.id, failed_dependencies: failedPrereqs },
            });
            result.cascadedBlocksCount += 1;
          }
        }
      }
    } catch (error) {
      this.deps.logger.error('[watchdog] 巡检出现异常', error);
    }

    return result;
  }
}
