/** 模型服务设置 API + 轻量设置页：自填 API、自选模型、DUCX 认证管理。 */
import express, {
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
  type Router,
} from 'express';
import type { Logger } from '../logger';
import type { UpstreamService } from './service';
import { SETTINGS_PAGE_HTML } from './settings-page';

export interface SettingsRouterOptions {
  upstream: UpstreamService;
  /** 设置接口的管理令牌；为空时仅允许 loopback 访问。 */
  adminToken: string;
  logger: Logger;
}

function fail(res: ExpressResponse, status: number, message: string, code: string): void {
  res.status(status).json({ error: { message, code, type: code } });
}

function isLoopback(req: ExpressRequest): boolean {
  const address: string = req.ip ?? req.socket.remoteAddress ?? '';
  return /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1|0:0:0:0:0:0:0:1)$/.test(address);
}

export function createSettingsRouter(options: SettingsRouterOptions): Router {
  const router: Router = express.Router();
  const { upstream, adminToken, logger } = options;

  // 设置页本身只含掩码信息，可直接打开；写操作与明细查询需要鉴权。
  router.get('/settings', (_req: ExpressRequest, res: ExpressResponse): void => {
    res.type('html').send(SETTINGS_PAGE_HTML);
  });

  const guard = (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
    const bearer: string = req.headers.authorization ?? '';
    if (adminToken !== '' && bearer === `Bearer ${adminToken}`) {
      next();
      return;
    }
    if (adminToken === '' && isLoopback(req)) {
      next();
      return;
    }
    fail(
      res,
      401,
      adminToken === ''
        ? '模型服务设置仅允许本机访问（可配置 ZHIYI_SETTINGS_TOKEN 开放远程）'
        : '需要有效的管理令牌（Authorization: Bearer <ZHIYI_SETTINGS_TOKEN>）',
      'settings_unauthorized',
    );
  };

  router.use('/v1/zhiyi', guard);
  router.use('/v1/models', guard);

  router.get('/v1/zhiyi/settings', (_req: ExpressRequest, res: ExpressResponse): void => {
    res.json(upstream.view());
  });

  router.put('/v1/zhiyi/settings', (req: ExpressRequest, res: ExpressResponse): void => {
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      fail(res, 400, '请求体必须是对象', 'bad_request');
      return;
    }
    try {
      res.json(
        upstream.update(body as Parameters<UpstreamService['update']>[0]),
      );
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : String(error), 'invalid_settings');
    }
  });

  router.post('/v1/zhiyi/settings/reset', (_req: ExpressRequest, res: ExpressResponse): void => {
    res.json(upstream.reset());
  });

  router.get('/v1/zhiyi/models', async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    try {
      const refresh: boolean = req.query.refresh === '1' || req.query.refresh === 'true';
      const models = await upstream.listModels(refresh);
      const sources: string[] = upstream.modelSources();
      res.json({
        object: 'list',
        data: models,
        source: upstream.view().effectiveBaseUrl,
        sources,
        merged: sources.length > 1,
      });
    } catch (error) {
      fail(res, 502, error instanceof Error ? error.message : String(error), 'models_error');
    }
  });

  router.post('/v1/zhiyi/settings/test', async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    const withChat: boolean = Boolean((req.body as { chat?: unknown } | undefined)?.chat);
    const result = await upstream.testConnection(withChat);
    res.status(result.ok ? 200 : 502).json(result);
  });

  router.post(
    '/v1/zhiyi/settings/ducx/refresh',
    async (_req: ExpressRequest, res: ExpressResponse): Promise<void> => {
      try {
        res.json(await upstream.refreshDucx());
      } catch (error) {
        fail(res, 502, error instanceof Error ? error.message : String(error), 'ducx_error');
      }
    },
  );

  router.post(
    '/v1/zhiyi/settings/ducx/report/test',
    async (_req: ExpressRequest, res: ExpressResponse): Promise<void> => {
      const result = await upstream.testDucxReport();
      res.status(result.ok ? 200 : 502).json(result);
    },
  );

  // OpenAI 兼容：客户端（含 ADP）可直接查询可用模型。
  router.get('/v1/models', async (_req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    try {
      const models = await upstream.listModels(false);
      res.json({
        object: 'list',
        data: models.map((item) => ({
          id: item.id,
          object: 'model',
          owned_by: item.owned_by ?? 'zhiyi',
        })),
      });
    } catch (error) {
      logger.warn('模型列表查询失败', error);
      fail(res, 502, error instanceof Error ? error.message : String(error), 'models_error');
    }
  });

  return router;
}
