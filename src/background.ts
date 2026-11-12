/** 后台任务追踪器：异步保存轨迹 / 触发提取，不阻塞模型响应，并支持测试等待。 */
import type { Logger } from './logger';

export type BackgroundTask = () => Promise<void> | void;

export class BackgroundTracker {
  private readonly logger: Logger;
  private pending = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** 同步登记任务（pending 立即 +1），实际执行放到下一个事件循环。 */
  run(task: BackgroundTask): void {
    this.pending += 1;
    setImmediate((): void => {
      void Promise.resolve()
        .then(task)
        .catch((error: unknown): void => {
          this.logger.error('后台任务失败（不影响模型请求）', error);
        })
        .finally((): void => {
          this.pending -= 1;
          if (this.pending === 0) {
            const waiters: Array<() => void> = this.waiters.splice(0);
            for (const resolve of waiters) resolve();
          }
        });
    });
  }

  /** 等待当前已登记的所有后台任务执行完毕。 */
  wait(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise<void>((resolve): void => {
      this.waiters.push(resolve);
    });
  }
}
