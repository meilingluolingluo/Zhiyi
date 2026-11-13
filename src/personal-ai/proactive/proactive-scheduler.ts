/**
 * 轻量持久化调度器：基于 proactive_schedule_state 按用户轮询到期扫描，
 * 服务重启后从数据库恢复调度状态，避免重复打扰。
 */
import type { Logger } from '../../logger';
import type { ProactiveEngine, ProactiveEvaluationResult } from './proactive-engine';
import type { ProactiveStore } from './proactive-store';

export interface ProactiveSchedulerDeps {
  store: ProactiveStore;
  engine: ProactiveEngine;
  logger: Logger;
  tickIntervalMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 60_000;

export class ProactiveScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly deps: ProactiveSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = Math.max(500, this.deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
    this.timer = setInterval((): void => {
      void this.tick();
    }, interval);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(now: Date = new Date()): ProactiveEvaluationResult[] {
    if (this.busy) return [];
    this.busy = true;
    const results: ProactiveEvaluationResult[] = [];
    try {
      const dueUsers = this.deps.store.listDueUserIds(now.toISOString(), 100);
      for (const userId of dueUsers) {
        try {
          const outcome = this.deps.engine.evaluateUser(userId, { now, respectCooldown: true });
          results.push(outcome);
          if (outcome.created.length > 0) {
            this.deps.logger.info(
              `[proactive] user=${userId} 新增 ${outcome.created.length} 条主动提醒`,
            );
          }
        } catch (error) {
          this.deps.logger.warn(
            `[proactive] 评估用户 ${userId} 异常: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return results;
    } finally {
      this.busy = false;
    }
  }
}
