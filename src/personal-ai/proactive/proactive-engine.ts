/**
 * 主动跟进规则引擎：先使用确定性业务规则筛选真实工作异常与重要节点，
 * 再结合用户时区、安静时间、提醒频率与去重策略克制地生成通知，绝不编造无依据推断。
 */
import type { CandidateStore } from '../../candidates';
import type { GoalStore } from '../domain/goal-store';
import type { ProjectStore } from '../domain/project-store';
import type {
  ProactiveFrequency,
  ProactiveNotificationKind,
  QuietHoursWindow,
  UserProfile,
} from '../domain/types';
import type { UserProfileStore } from '../domain/user-profile-store';
import type { BusinessTaskManager } from '../task/business-task-manager';
import type { TaskRepository } from '../task/task-repository';
import { buildProjectProgressSummary } from './project-summary';
import type { ProactiveNotification, ProactiveStore } from './proactive-store';

export interface ProactiveThresholds {
  dueSoonWindowMs: number;
  stalledTaskMs: number;
  stalledGoalMs: number;
  completedSummaryWindowMs: number;
  projectProgressOpenThreshold: number;
}

const DEFAULT_THRESHOLDS: ProactiveThresholds = {
  dueSoonWindowMs: 24 * 3600_000,
  stalledTaskMs: 48 * 3600_000,
  stalledGoalMs: 7 * 24 * 3600_000,
  completedSummaryWindowMs: 24 * 3600_000,
  projectProgressOpenThreshold: 2,
};

const FREQUENCY_COOLDOWN_MS: Readonly<Record<ProactiveFrequency, number>> = {
  balanced: 6 * 3600_000,
  daily: 24 * 3600_000,
  minimal: 48 * 3600_000,
};

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export interface ProactiveEngineDeps {
  userProfiles: UserProfileStore;
  goalStore: GoalStore;
  projectStore: ProjectStore;
  businessTaskManager: BusinessTaskManager;
  taskRepo: TaskRepository;
  proactiveStore: ProactiveStore;
  candidateStore?: CandidateStore;
  thresholds?: Partial<ProactiveThresholds>;
  onNotificationCreated?: (notification: ProactiveNotification) => void;
}

export interface ProactiveEvaluationResult {
  user_id: string;
  skipped: boolean;
  reason?: 'disabled_by_user' | 'paused_by_user' | 'quiet_hours' | 'cooldown';
  created: ProactiveNotification[];
  evaluated_at: string;
  next_run_at: string;
}

function parseMinutesHHMM(hhmm: string): number {
  const [hStr, mStr] = hhmm.split(':');
  return Number(hStr) * 60 + Number(mStr);
}

/** 根据用户 IANA 时区判断当前时刻是否处于安静时间窗口内（支持跨午夜窗口如 22:00-08:00）。 */
export function isWithinQuietHours(
  now: Date,
  timezone: string,
  quietHours?: QuietHoursWindow | null,
): boolean {
  if (!quietHours) return false;
  let hhmm = '';
  try {
    hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
  }
  const [hPart, mPart] = hhmm.split(':');
  const currentMinutes = (Number(hPart) % 24) * 60 + Number(mPart);
  const startMinutes = parseMinutesHHMM(quietHours.start);
  const endMinutes = parseMinutesHHMM(quietHours.end);

  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export class ProactiveEngine {
  private readonly thresholds: ProactiveThresholds;

  constructor(private readonly deps: ProactiveEngineDeps) {
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...(deps.thresholds ?? {}),
    };
  }

  private resolveCooldownMs(profile: UserProfile): number {
    const freq = profile.preferences.proactive_frequency ?? 'balanced';
    return FREQUENCY_COOLDOWN_MS[freq] ?? FREQUENCY_COOLDOWN_MS.balanced;
  }

  evaluateUser(
    userId: string,
    options: { now?: Date; respectCooldown?: boolean; ignoreQuietHours?: boolean } = {},
  ): ProactiveEvaluationResult {
    const now = options.now ?? new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const profile = this.deps.userProfiles.ensureUser(userId);
    const prefs = profile.preferences;
    const cooldownMs = this.resolveCooldownMs(profile);
    const defaultNextRun = new Date(nowMs + cooldownMs).toISOString();

    if (prefs.proactive_enabled === false) {
      this.deps.proactiveStore.upsertScheduleState(userId, {
        last_run_at: nowIso,
        next_run_at: defaultNextRun,
        last_status: 'skipped:disabled_by_user',
        last_summary: '用户已关闭主动提醒',
      });
      return {
        user_id: userId,
        skipped: true,
        reason: 'disabled_by_user',
        created: [],
        evaluated_at: nowIso,
        next_run_at: defaultNextRun,
      };
    }

    if (prefs.proactive_paused_until && Date.parse(prefs.proactive_paused_until) > nowMs) {
      const nextRunAt = prefs.proactive_paused_until;
      this.deps.proactiveStore.upsertScheduleState(userId, {
        last_run_at: nowIso,
        next_run_at: nextRunAt,
        last_status: 'skipped:paused_by_user',
        last_summary: `用户已暂停主动跟进至 ${nextRunAt}`,
      });
      return {
        user_id: userId,
        skipped: true,
        reason: 'paused_by_user',
        created: [],
        evaluated_at: nowIso,
        next_run_at: nextRunAt,
      };
    }

    if (
      !options.ignoreQuietHours &&
      isWithinQuietHours(now, profile.timezone, prefs.proactive_quiet_hours)
    ) {
      const quietNext = new Date(nowMs + Math.min(cooldownMs, 3600_000)).toISOString();
      this.deps.proactiveStore.upsertScheduleState(userId, {
        last_run_at: nowIso,
        next_run_at: quietNext,
        last_status: 'skipped:quiet_hours',
        last_summary: '处于用户设置的安静时间窗口，延迟打扰',
      });
      return {
        user_id: userId,
        skipped: true,
        reason: 'quiet_hours',
        created: [],
        evaluated_at: nowIso,
        next_run_at: quietNext,
      };
    }

    const scheduleState = this.deps.proactiveStore.getScheduleState(userId);
    if (
      options.respectCooldown !== false &&
      scheduleState?.next_run_at &&
      Date.parse(scheduleState.next_run_at) > nowMs
    ) {
      return {
        user_id: userId,
        skipped: true,
        reason: 'cooldown',
        created: [],
        evaluated_at: nowIso,
        next_run_at: scheduleState.next_run_at,
      };
    }

    const allowedTypes: ReadonlySet<ProactiveNotificationKind> | null =
      Array.isArray(prefs.proactive_types) && prefs.proactive_types.length > 0
        ? new Set(prefs.proactive_types)
        : null;

    const candidates: Array<{
      kind: ProactiveNotificationKind;
      entityType: ProactiveNotification['entity_type'];
      entityId: string;
      dedupeKey: string;
      title: string;
      summary: string;
      evidence: Record<string, unknown>;
    }> = [];

    const tasks = this.deps.businessTaskManager.list(userId, { limit: 200 }).items;
    const projects = this.deps.projectStore.list(userId, { status: 'active', limit: 100 }).items;
    const goals = this.deps.goalStore.list(userId, { status: 'active', limit: 100 }).items;

    // 1. 业务任务规则检查：逾期、临期、停滞、阻塞待决策、失败/需核实、近期完成待汇总
    for (const task of tasks) {
      const latestExec = this.deps.taskRepo.getLatestByTaskId(userId, task.id);
      const isOpen = !TERMINAL_TASK_STATUSES.has(task.status);

      if (isOpen && task.due_at) {
        const dueMs = Date.parse(task.due_at);
        if (Number.isFinite(dueMs)) {
          if (dueMs <= nowMs) {
            candidates.push({
              kind: 'task_overdue',
              entityType: 'task',
              entityId: task.id,
              dedupeKey: `task_overdue:${task.id}:${task.due_at}`,
              title: `任务已逾期：${task.title}`,
              summary: `任务「${task.title}」原定截止时间为 ${task.due_at}，当前状态为 ${task.status}，建议尽快推进或调整计划。`,
              evidence: { task_id: task.id, due_at: task.due_at, status: task.status },
            });
          } else if (dueMs - nowMs <= this.thresholds.dueSoonWindowMs) {
            candidates.push({
              kind: 'task_due_soon',
              entityType: 'task',
              entityId: task.id,
              dedupeKey: `task_due_soon:${task.id}:${task.due_at}`,
              title: `任务即将到期：${task.title}`,
              summary: `任务「${task.title}」将于 ${task.due_at} 到期，当前状态为 ${task.status}。`,
              evidence: { task_id: task.id, due_at: task.due_at, status: task.status },
            });
          }
        }
      }

      if (isOpen) {
        const updatedMs = Date.parse(task.updated_at);
        if (
          Number.isFinite(updatedMs) &&
          nowMs - updatedMs >= this.thresholds.stalledTaskMs
        ) {
          candidates.push({
            kind: 'task_stalled',
            entityType: 'task',
            entityId: task.id,
            dedupeKey: `task_stalled:${task.id}:${task.updated_at}`,
            title: `任务长期无进展：${task.title}`,
            summary: `任务「${task.title}」自 ${task.updated_at.slice(0, 10)} 以来一直停留在 ${task.status} 状态，建议确认是否受阻、委派 Agent 执行或重新排期。`,
            evidence: { task_id: task.id, updated_at: task.updated_at, status: task.status },
          });
        }
      }

      if (task.status === 'blocked') {
        candidates.push({
          kind: 'decision_needed',
          entityType: 'task',
          entityId: task.id,
          dedupeKey: `decision_blocked:${task.id}:${task.updated_at}`,
          title: `任务受阻待决策：${task.title}`,
          summary: `任务「${task.title}」当前处于 blocked 状态，需要你确认前置条件或变更方案。`,
          evidence: { task_id: task.id, status: task.status },
        });
      }

      if (task.status === 'failed' || latestExec?.status === 'failed') {
        if (latestExec?.needs_verification) {
          candidates.push({
            kind: 'task_verification',
            entityType: 'task',
            entityId: task.id,
            dedupeKey: `task_verification:${task.id}:${latestExec.id}`,
            title: `任务执行中断待核实：${task.title}`,
            summary: `任务「${task.title}」最近一次执行（${latestExec.id}）因中断/超时未能确认结果（${latestExec.error ?? '需核实'}），请核实实际产出后决定是否重试。`,
            evidence: {
              task_id: task.id,
              execution_id: latestExec.id,
              agent_id: latestExec.agent_id,
              error: latestExec.error,
              needs_verification: true,
            },
          });
        } else {
          const execId = latestExec?.id ?? 'none';
          const reason = latestExec?.error ?? '执行失败';
          const advice = latestExec?.retryable
            ? '可直接重试或更换其他 Agent 重新执行。'
            : '请修正参数/权限或更换 Agent 后重试。';
          candidates.push({
            kind: 'execution_failed',
            entityType: 'task',
            entityId: task.id,
            dedupeKey: `execution_failed:${task.id}:${execId}`,
            title: `Agent 执行失败：${task.title}`,
            summary: `任务「${task.title}」${latestExec?.agent_id ? `（Agent=${latestExec.agent_id}）` : ''}执行失败：${reason}。${advice}`,
            evidence: {
              task_id: task.id,
              execution_id: execId,
              agent_id: latestExec?.agent_id ?? task.assignee_agent_id,
              error: reason,
              retryable: latestExec?.retryable ?? true,
            },
          });
        }
      }

      if (
        task.status === 'completed' &&
        latestExec?.status === 'completed' &&
        latestExec.completed_at
      ) {
        const completedMs = Date.parse(latestExec.completed_at);
        if (
          Number.isFinite(completedMs) &&
          nowMs - completedMs <= this.thresholds.completedSummaryWindowMs
        ) {
          const preview = (latestExec.result ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
          candidates.push({
            kind: 'task_completed_summary',
            entityType: 'task',
            entityId: task.id,
            dedupeKey: `task_completed:${task.id}:${latestExec.id}`,
            title: `任务已完成：${task.title}`,
            summary: `任务「${task.title}」已由 ${latestExec.agent_id ?? 'Agent'} 执行完成${preview ? `，成果摘要：${preview}` : ''}。可查看结果并决定下一步动作。`,
            evidence: {
              task_id: task.id,
              execution_id: latestExec.id,
              agent_id: latestExec.agent_id,
              completed_at: latestExec.completed_at,
            },
          });
        }
      }
    }

    // 2. 冲突候选记忆待用户确认决策
    if (this.deps.candidateStore) {
      const pendingCandidates = this.deps.candidateStore.list(userId, {
        status: 'pending',
        limit: 50,
      });
      for (const cand of pendingCandidates) {
        if (!cand.conflict_memory_id) continue;
        candidates.push({
          kind: 'decision_needed',
          entityType: 'memory_candidate',
          entityId: cand.id,
          dedupeKey: `decision_memory_conflict:${cand.id}`,
          title: '存在冲突记忆等待确认',
          summary: `候选记忆「${cand.content.slice(0, 80)}」与已确认记忆（${cand.conflict_memory_id}）存在冲突，需要你审批决定是否采纳覆盖。`,
          evidence: { candidate_id: cand.id, conflict_memory_id: cand.conflict_memory_id },
        });
      }
    }

    // 3. 活跃项目有多个未完成任务时主动汇总真实进度
    const digestBucket = Math.floor(nowMs / cooldownMs);
    for (const proj of projects) {
      const projTasks = tasks.filter((t) => t.project_id === proj.id);
      const openTasks = projTasks.filter((t) => !TERMINAL_TASK_STATUSES.has(t.status));
      if (openTasks.length >= this.thresholds.projectProgressOpenThreshold) {
        const summaryObj = buildProjectProgressSummary(
          {
            projectStore: this.deps.projectStore,
            businessTaskManager: this.deps.businessTaskManager,
            taskRepo: this.deps.taskRepo,
          },
          userId,
          proj.id,
        );
        if (summaryObj) {
          candidates.push({
            kind: 'project_progress',
            entityType: 'project',
            entityId: proj.id,
            dedupeKey: `project_progress:${proj.id}:${digestBucket}`,
            title: `项目进度汇总：${proj.title}`,
            summary: summaryObj.narrative,
            evidence: {
              project_id: proj.id,
              stats: summaryObj.stats,
              next_steps: summaryObj.next_steps,
            },
          });
        }
      }
    }

    // 4. 长期未推进的活跃目标
    for (const goal of goals) {
      const linkedProjects = this.deps.goalStore.listProjectsForGoal(userId, goal.id);
      const linkedProjectIds = new Set(linkedProjects.map((p) => p.id));
      const relatedTasks = tasks.filter(
        (t) => t.project_id && linkedProjectIds.has(t.project_id),
      );
      const latestActivityMs = Math.max(
        Date.parse(goal.updated_at) || 0,
        ...linkedProjects.map((p) => Date.parse(p.updated_at) || 0),
        ...relatedTasks.map((t) => Date.parse(t.updated_at) || 0),
      );
      if (latestActivityMs > 0 && nowMs - latestActivityMs >= this.thresholds.stalledGoalMs) {
        candidates.push({
          kind: 'goal_stalled',
          entityType: 'goal',
          entityId: goal.id,
          dedupeKey: `goal_stalled:${goal.id}:${Math.floor(latestActivityMs / 86_400_000)}`,
          title: `长期目标近期未推进：${goal.title}`,
          summary: `目标「${goal.title}」已超过 ${Math.floor((nowMs - latestActivityMs) / 86_400_000)} 天没有关联推进记录，是否需要拆解新任务或调整计划？`,
          evidence: {
            goal_id: goal.id,
            last_activity_at: new Date(latestActivityMs).toISOString(),
          },
        });
      }
    }

    const created: ProactiveNotification[] = [];
    for (const item of candidates) {
      if (allowedTypes && !allowedTypes.has(item.kind)) continue;
      const inserted = this.deps.proactiveStore.createIfNew({
        userId,
        kind: item.kind,
        entityType: item.entityType,
        entityId: item.entityId,
        dedupeKey: item.dedupeKey,
        title: item.title,
        summary: item.summary,
        evidence: item.evidence,
        channel: 'inbox',
        createdAt: nowIso,
      });
      if (inserted.created) {
        created.push(inserted.notification);
        this.deps.onNotificationCreated?.(inserted.notification);
      }
    }

    this.deps.proactiveStore.upsertScheduleState(userId, {
      last_run_at: nowIso,
      next_run_at: defaultNextRun,
      last_status: created.length > 0 ? `notified:${created.length}` : 'ok:no_new_alerts',
      last_summary:
        created.length > 0
          ? `生成 ${created.length} 条新主动提醒`
          : '本次巡检无新增待提醒事项',
    });

    return {
      user_id: userId,
      skipped: false,
      created,
      evaluated_at: nowIso,
      next_run_at: defaultNextRun,
    };
  }
}
