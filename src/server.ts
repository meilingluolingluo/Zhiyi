/** 服务入口：启动 HTTP 服务并支持优雅关闭。 */
import { createApp } from './app';
import { loadConfig } from './config';

async function main(): Promise<void> {
  // 直接 `npm start` 时也能读取两份 env 配置（start.sh 已 source 的情况下不覆盖）。
  const loadEnvFile = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (loadEnvFile) {
    for (const file of ['.env', '.env.personal-ai']) {
      try {
        loadEnvFile.call(process, file);
      } catch {
        // 文件不存在时忽略，环境变量仍可来自宿主进程。
      }
    }
  }
  const config = loadConfig();
  const created = await createApp(config);
  const server = created.app.listen(config.port, (): void => {
    created.deps.logger.info(`服务已启动：http://127.0.0.1:${config.port}/health`);
    created.deps.logger.info(
      `上游模式：${config.mockUpstream ? '内置 Mock（无需外部凭证）' : config.upstreamBaseUrl}`,
    );
    created.deps.logger.info(`数据库：${config.databaseUrl}`);
    created.deps.logger.info(
      `记忆注入：${config.memoryEnabled ? '开启' : '关闭'}；自动提取：${config.memoryAutoExtract ? '开启' : '关闭'}`,
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    created.deps.logger.info(`收到 ${signal}，等待后台任务完成后关闭`);
    const forceTimer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      process.exit(1);
    }, 5000);
    forceTimer.unref();
    server.close((): void => {
      void created.close().then((): void => {
        clearTimeout(forceTimer);
        process.exit(0);
      });
    });
  };
  process.on('SIGINT', (): void => shutdown('SIGINT'));
  process.on('SIGTERM', (): void => shutdown('SIGTERM'));
}

void main().catch((error: unknown): void => {
  console.error('[memory-gateway] 启动失败', error);
  process.exit(1);
});
