/**
 * 任务验收管理器：参考 Team Mesh 的 Dev -> QA/Review 闭环，
 * 对不同类型任务实行轻量验收机制，支持代码/结果检查、返工次数限制与人工决策上报。
 */
import type { Database } from '../../db';
import { DomainError, type BusinessTask } from '../domain/types';
import type { BusinessTaskRepository } from './business-task-repository';
import type { ExecutionEventStore } from './execution-event-store';
import type { TaskRepository } from './task-repository';

export interface AcceptanceEvaluation {
  passed: boolean;
  reason: string;
  feedback?: string;
  needsHumanDecision?: boolean;
}

export interface TaskAcceptanceDeps {
  db: Database;
  businessRepo: BusinessTaskRepository;
  taskRepo: TaskRepository;
  eventStore?: ExecutionEventStore;
  onDecisionNeeded?: (params: {
    userId: string;
    taskId: string;
    reason: string;
    reworkCount: number;
  }) => void;
  onReworkNeeded?: (params: {
    userId: string;
    taskId: string;
    feedback: string;
    reworkCount: number;
  }) => void;
}

export class TaskAcceptanceManager {
  constructor(private readonly deps: TaskAcceptanceDeps) {}

  /** 判断任务是否需要进入验收流程。仅在明确指定验收准则或显式进入评审状态时执行验收，避免给普通任务增加无谓负担。 */
  shouldRequireReview(task: BusinessTask): boolean {
    if (task.acceptance_criteria && task.acceptance_criteria.trim() !== '') {
      return true;
    }
    if (task.review_status && task.review_status !== 'none') {
      return true;
    }
    return false;
  }

  /** 基于真实产出对任务结果进行轻量验收评估。 */
  evaluateResult(task: BusinessTask, resultText: string): AcceptanceEvaluation {
    const text = (resultText ?? '').trim();
    if (!text) {
      return {
        passed: false,
        reason: 'Worker 未返回有效产出内容',
        feedback: '请提供完整的交付成果，不能只返回空结果。',
      };
    }

    // 检查是否包含敷衍性质的未完成占位符
    if (/(TODO:?|FIXME:?|未完待续|此处省略|暂未实现)/i.test(text)) {
      return {
        passed: false,
        reason: '产出中存在未实现的 TODO / 占位符',
        feedback: '交付物包含未完成的占位符（如 TODO / 暂未实现），请完整实现所有逻辑。',
      };
    }

    // 若属于研发任务，验证是否有有效的代码块呈现
    const isDevTask = /(实现|开发|编写|重构|算法|typescript|javascript|python|代码)/i.test(
      `${task.title} ${task.description}`,
    );
    if (isDevTask) {
      const hasCodeBlock = /```[\s\S]*?```/.test(text);
      if (!hasCodeBlock) {
        return {
          passed: false,
          reason: '研发任务未提供有效代码块交付',
          feedback: '本任务属于开发类任务，验收要求必须包含完整可运行的代码块（Markdown ``` 格式）。',
        };
      }
    }

    // 若显式设定了验收准则，进行关键词或规则匹配
    if (task.acceptance_criteria) {
      const criteria = task.acceptance_criteria.toLowerCase();
      // 常见准则检查：例如要求复杂度分析、单测用例等
      if (criteria.includes('复杂度') && !text.includes('复杂度')) {
        return {
          passed: false,
          reason: '未满足验收准则：缺少时间/空间复杂度分析',
          feedback: '验收准则明确要求包含复杂度分析，请补充时间与空间复杂度评估。',
        };
      }
      if ((criteria.includes('测试') || criteria.includes('test')) && !/(test|it\(|describe\(|测试|示例)/i.test(text)) {
        return {
          passed: false,
          reason: '未满足验收准则：缺少测试用例或验证示例',
          feedback: '验收准则明确要求包含测试用例或使用示例，请补充。',
        };
      }
    }

    return {
      passed: true,
      reason: '验收通过：产出完整且符合既定标准',
    };
  }

  /**
   * 处理 Execution 产出验收：通过则归档为 completed；
   * 未通过但在最大返工次数内则触发返工；超过最大次数则转为 blocked 并请求用户决策。
   */
  processAcceptance(params: {
    userId: string;
    taskId: string;
    executionId: string;
    result: string;
  }): {
    status: 'approved' | 'rejected' | 'escalated_to_user';
    task: BusinessTask;
    evaluation: AcceptanceEvaluation;
  } {
    return this.deps.db.transaction(() => {
      const task = this.deps.businessRepo.getActive(params.userId, params.taskId);
      if (!task) {
        throw new DomainError(404, 'task_not_found', `任务不存在：${params.taskId}`);
      }

      const evaluation = this.evaluateResult(task, params.result);

      if (evaluation.passed) {
        const updated = this.deps.businessRepo.updateAcceptanceReviewInTx(params.userId, task.id, {
          review_status: 'approved',
          status: 'completed',
        })!;
        this.deps.eventStore?.record({
          executionId: params.executionId,
          taskId: task.id,
          userId: params.userId,
          eventType: 'completed',
          agentId: task.assignee_agent_id,
          status: 'completed',
          message: evaluation.reason,
          metadata: { review_status: 'approved' },
        });
        return { status: 'approved', task: updated, evaluation };
      }

      // 未通过验收：检查是否达到返工次数上限
      const nextRework = (task.rework_count ?? 0) + 1;
      const maxRework = task.max_rework ?? 2;

      if (nextRework >= maxRework) {
        // 达到返工上限，必须交由用户决策，绝不盲目假定成功
        const updated = this.deps.businessRepo.updateAcceptanceReviewInTx(params.userId, task.id, {
          review_status: 'rejected',
          status: 'blocked',
          rework_count: nextRework,
        })!;
        this.deps.eventStore?.record({
          executionId: params.executionId,
          taskId: task.id,
          userId: params.userId,
          eventType: 'verification_required',
          agentId: task.assignee_agent_id,
          status: 'blocked',
          message: `验收未通过且已超过最大返工次数 (${maxRework} 次)，已转由用户决策。原因：${evaluation.reason}`,
          metadata: {
            review_status: 'rejected',
            rework_count: nextRework,
            max_rework: maxRework,
            needs_user_decision: true,
          },
        });
        this.deps.onDecisionNeeded?.({
          userId: params.userId,
          taskId: task.id,
          reason: evaluation.reason,
          reworkCount: nextRework,
        });
        return { status: 'escalated_to_user', task: updated, evaluation };
      }

      // 在返工限额内：记录 rejected 并触发重新执行
      const updated = this.deps.businessRepo.updateAcceptanceReviewInTx(params.userId, task.id, {
        review_status: 'rejected',
        status: 'ready',
        rework_count: nextRework,
      })!;
      this.deps.eventStore?.record({
        executionId: params.executionId,
        taskId: task.id,
        userId: params.userId,
        eventType: 'retried',
        agentId: task.assignee_agent_id,
        status: 'ready',
        message: `验收未通过，开始第 ${nextRework} 次返工修改。原因：${evaluation.reason}`,
        metadata: {
          review_status: 'rejected',
          rework_count: nextRework,
          feedback: evaluation.feedback,
        },
      });
      this.deps.onReworkNeeded?.({
        userId: params.userId,
        taskId: task.id,
        feedback: evaluation.feedback ?? evaluation.reason,
        reworkCount: nextRework,
      });
      return { status: 'rejected', task: updated, evaluation };
    });
  }

  /** 人工强行通过验收（如用户审核认为满意）。 */
  manualApprove(userId: string, taskId: string, note?: string): BusinessTask {
    return this.deps.db.transaction(() => {
      const task = this.deps.businessRepo.getActive(userId, taskId);
      if (!task) throw new DomainError(404, 'task_not_found', `任务不存在：${taskId}`);
      const updated = this.deps.businessRepo.updateAcceptanceReviewInTx(userId, taskId, {
        review_status: 'approved',
        status: 'completed',
      })!;
      const latestExec = this.deps.taskRepo.getLatestByTaskId(userId, taskId);
      if (latestExec) {
        this.deps.eventStore?.record({
          executionId: latestExec.id,
          taskId,
          userId,
          eventType: 'completed',
          status: 'completed',
          message: note ? `人工审批通过：${note}` : '用户人工审批通过验收',
          metadata: { review_status: 'approved', manual: true },
        });
      }
      return updated;
    });
  }
}
