/** 应用装配：把配置、数据库、各 Store、Mock 上游与路由组合成一个 Express 应用。 */
import express, { type Express } from 'express';
import path from 'node:path';
import { AgentStore } from './agents';
import { BackgroundTracker } from './background';
import { CandidateStore } from './candidates';
import type { AppConfig } from './config';
import { Database } from './db';
import { ExtractionQueue } from './extractor';
import { createLogger, type Logger } from './logger';
import { MemoryStore } from './memories';
import { MockUpstream } from './mock-upstream';
import { createPersonalAI, type PersonalAIAssembly } from './personal-ai';
import type { PersonalAIConfig } from './personal-ai/config';
import { createMemoryDeskRouter } from './memory-desk';
import { createRouter, errorMiddleware } from './routes';
import { TrajectoryStore } from './trajectories';
import { createSettingsRouter } from './upstream/routes';
import { MediaStore } from './upstream/media-store';
import { SettingsStore } from './upstream/model-settings';
import { initialSettings, UpstreamService } from './upstream/service';
import type { UpstreamTransport } from './types';

export interface AppDeps {
  config: AppConfig;
  db: Database;
  agentStore: AgentStore;
  memoryStore: MemoryStore;
  candidateStore: CandidateStore;
  trajectoryStore: TrajectoryStore;
  queue: ExtractionQueue;
  background: BackgroundTracker;
  mock: MockUpstream | null;
  transport: UpstreamTransport;
  logger: Logger;
  /** 生成图片的读写存储（测试纯内存，运行期写 data/generated-images）。 */
  mediaStore: MediaStore;
  /** 运行期模型服务设置（自填 API / 自选模型 / DUCX）。 */
  upstream?: UpstreamService;
  /** 管理员接口令牌（来源于 options.adminToken ?? config.settingsToken）。 */
  adminToken?: string;
}

export interface CreatedApp {
  app: Express;
  deps: AppDeps;
  /** Personal AI Runtime 装配结果（测试可注入配置、关闭 Worker）。 */
  personalAI: PersonalAIAssembly;
  upstream: UpstreamService | null;
  /** 等待所有后台任务（轨迹保存 + 候选提取）完成，主要供测试与优雅退出使用。 */
  waitForBackground(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateAppOptions {
  silent?: boolean;
  /** 显式注入 Personal AI 配置，避免测试受宿主环境变量干扰。 */
  personalAIConfig?: PersonalAIConfig;
  /** 显式注入设置服务；传 null 可完全关闭运行期设置（测试隔离）。 */
  upstreamSettings?: UpstreamService | null;
  /** 设置持久化路径；null = 纯内存。默认读取 ZHIYI_SETTINGS_PATH。 */
  settingsPath?: string | null;
  /** 设置接口管理令牌；默认读取 ZHIYI_SETTINGS_TOKEN。 */
  adminToken?: string;
  /** 测试注入：跳过真实 DUCX 子进程。 */
  ducxCaptureFn?: () => Promise<Record<string, string>>;
  /** 测试注入：自定义上游传输层。 */
  transport?: UpstreamTransport;
}

/** 真实模式：使用 Node 内置 fetch 转发到 MultiCA 模型上游。 */
export const fetchTransport: UpstreamTransport = (url: string, init: RequestInit): Promise<Response> =>
  fetch(url, init);

export async function createApp(
  config: AppConfig,
  options: CreateAppOptions = {},
): Promise<CreatedApp> {
  const db: Database = Database.open(config.databaseUrl);
  db.migrate();
  const logger: Logger = createLogger(options.silent ?? config.logSilent);

  const agentStore = new AgentStore(db);
  agentStore.seed();
  const memoryStore = new MemoryStore(db);
  const candidateStore = new CandidateStore(db);
  const trajectoryStore = new TrajectoryStore(db);
  const background = new BackgroundTracker(logger);

  const mock: MockUpstream | null = config.mockUpstream ? new MockUpstream() : null;
  const transport: UpstreamTransport =
    options.transport ?? (mock ? mock.createTransport() : fetchTransport);

  // 运行期设置：Mock / 测试模式使用纯内存且默认停用，保证既有测试行为不变。
  const settingsPath: string | null =
    options.settingsPath === undefined
      ? config.mockUpstream
        ? null
        : config.settingsPath
      : options.settingsPath;
  const initial = initialSettings(config, !config.mockUpstream, {
    baseUrl: config.mockUpstream ? undefined : process.env.MODEL_BASE_URL || undefined,
    apiKey: config.mockUpstream ? undefined : process.env.MODEL_API_KEY || undefined,
  });
  const mediaStore = new MediaStore(
    settingsPath ? path.join(path.dirname(settingsPath), 'generated-images') : null,
  );
  const upstream: UpstreamService | null =
    options.upstreamSettings === null
      ? null
      : (options.upstreamSettings ??
        new UpstreamService({
          store: new SettingsStore(settingsPath, initial),
          initial,
          config,
          transport,
          logger,
          ducxCaptureFn: options.ducxCaptureFn,
          mediaStore,
        }));

  const queue = new ExtractionQueue({
    config,
    candidateStore,
    memoryStore,
    mock,
    transport,
    logger,
    upstream: upstream ?? undefined,
  });
  const adminToken: string = options.adminToken ?? config.settingsToken;
  const deps: AppDeps = {
    config,
    db,
    agentStore,
    memoryStore,
    candidateStore,
    trajectoryStore,
    queue,
    background,
    mock,
    transport,
    logger,
    mediaStore,
    upstream: upstream ?? undefined,
    adminToken,
  };

  const personalAI: PersonalAIAssembly = createPersonalAI(deps, options.personalAIConfig);

  const app: Express = express();
  app.disable('x-powered-by');
  app.use(
    express.json({
      limit: '2mb',
      // 保留原始请求体，供 Personal AI 的 HMAC 签名校验使用。
      verify: (req, _res, buf): void => {
        (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );
  // 设置页与设置 API 优先于其它路由；自带 loopback / 令牌鉴权。
  if (upstream) {
    app.use(
      createSettingsRouter({
        upstream,
        adminToken,
        logger,
      }),
    );
  }
  // Personal AI 路由：它有自己的可信身份解析（含可选签名校验）。
  app.use(personalAI.router);
  app.use(createMemoryDeskRouter(deps));
  app.use(createRouter(deps));
  app.use(errorMiddleware);

  return {
    app,
    deps,
    personalAI,
    upstream,
    waitForBackground: async (): Promise<void> => {
      await background.wait();
      await deps.queue.whenIdle();
    },
    close: async (): Promise<void> => {
      personalAI.directRunner.abortAll();
      personalAI.openClawRunner.abortAll();
      personalAI.worker.stop();
      personalAI.proactiveScheduler.stop();
      await background.wait();
      await deps.queue.whenIdle();
      db.close();
    },
  };
}
