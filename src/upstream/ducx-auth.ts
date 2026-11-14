/**
 * DUCX 本机认证桥。
 *
 * 职责：捕获本机 DUCX 登录态（包含 comate_custom_header 与 authorization），
 * 注入至出站请求。认证头在内存中缓存 60 秒，并在 401/403 异常时主动失效并重新铸造；
 * 认证头明文绝不记入日志。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../logger';

const CAPTURABLE_HEADERS: readonly string[] = [
  'comate_custom_header',
  'authorization',
  'x-api-key',
  'x-auth-client-token',
];
const HEADER_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const DUCX_PLATFORM = 'AIIDE-terminal';

export interface DucxOptions {
  executable: string;
  home?: string;
  timeoutMs?: number;
  logger: Logger;
  /** 测试注入：跳过真实 DUCX 子进程，直接返回伪造的认证头。 */
  captureFn?: () => Promise<Record<string, string>>;
}

export interface DucxStatus {
  available: boolean;
  executable: string;
  cached: boolean;
  cachedAt: string | null;
  cachedKeys: string[];
  ttlMs: number;
  lastError: string | null;
}

interface CachedHeaders {
  headers: Record<string, string>;
  at: number;
}

export class DucxAuth {
  private readonly executable: string;
  private readonly home: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly captureFn?: () => Promise<Record<string, string>>;
  private cached: CachedHeaders | null = null;
  private lastError: string | null = null;
  private inFlight: Promise<Record<string, string>> | null = null;

  constructor(options: DucxOptions) {
    this.executable = options.executable;
    this.home = options.home ?? os.homedir();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
    this.captureFn = options.captureFn;
  }

  /** 取得可注入上游请求的认证头；命中缓存时不会启动 DUCX。 */
  async headers(force = false): Promise<Record<string, string>> {
    if (!force && this.cached && Date.now() - this.cached.at < HEADER_TTL_MS) {
      return { ...this.cached.headers };
    }
    // 并发请求共享同一次铸造，避免同时拉起多个 DUCX 进程。
    if (!this.inFlight) {
      this.inFlight = this.mint().finally((): void => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  invalidate(): void {
    this.cached = null;
  }

  status(): DucxStatus {
    return {
      available: this.captureFn !== undefined || fs.existsSync(this.executable),
      executable: this.executable,
      cached: this.cached !== null,
      cachedAt: this.cached ? new Date(this.cached.at).toISOString() : null,
      cachedKeys: this.cached ? Object.keys(this.cached.headers) : [],
      ttlMs: HEADER_TTL_MS,
      lastError: this.lastError,
    };
  }

  private async mint(): Promise<Record<string, string>> {
    try {
      const headers: Record<string, string> = this.captureFn
        ? await this.captureFn()
        : await this.captureFromDucx();
      const keys: string[] = Object.keys(headers);
      if (!keys.includes('comate_custom_header') && !keys.includes('authorization')) {
        throw new Error('DUCX 握手未返回可用的认证头（缺少 comate_custom_header / authorization）');
      }
      this.cached = { headers, at: Date.now() };
      this.lastError = null;
      this.logger.info(`DUCX 认证头已铸造（${keys.join(', ')}），缓存 ${HEADER_TTL_MS / 1000}s`);
      return { ...headers };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn('DUCX 认证头铸造失败', this.lastError);
      throw error;
    }
  }

  private captureFromDucx(): Promise<Record<string, string>> {
    if (!fs.existsSync(this.executable)) {
      return Promise.reject(new Error(`DUCX 可执行文件不存在：${this.executable}`));
    }
    return new Promise<Record<string, string>>((resolve, reject): void => {
      let child: ChildProcess | null = null;
      let settled = false;

      const finish = (result: Record<string, string> | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          server.close();
        } catch {
          // 忽略重复关闭
        }
        if (child?.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // 进程可能已退出
          }
        }
        try {
          child?.kill('SIGKILL');
        } catch {
          // 同上
        }
        if (result instanceof Error) reject(result);
        else resolve(result);
      };

      const server: http.Server = http.createServer((req, res): void => {
        const found: Record<string, string> = {};
        for (const key of CAPTURABLE_HEADERS) {
          const value: string | string[] | undefined = req.headers[key];
          if (typeof value === 'string' && value !== '') found[key] = value;
        }
        // 只作为 header 生成器，不转发、不消耗上游额度。
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'zhiyi-ducx-warmup',
            object: 'response',
            status: 'completed',
            output: [],
          }),
        );
        if (Object.keys(found).length > 0) finish(found);
      });

      const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
        finish(new Error(`DUCX 在 ${this.timeoutMs}ms 内未发出认证握手请求`));
      }, this.timeoutMs);

      server.once('error', (error: Error): void => finish(error));
      server.listen(0, '127.0.0.1', (): void => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish(new Error('DUCX 捕获服务未取得监听端口'));
          return;
        }
        const port: number = address.port;
        const codexHome: string = path.join(this.home, '.baidu-cx');
        child = spawn(
          this.executable,
          [
            '-c',
            `model_providers.oneapi.base_url="http://127.0.0.1:${port}/v1"`,
            '--disable',
            'hooks',
            '--disable',
            'plugins',
            'exec',
            '--skip-git-repo-check',
            '--dangerously-bypass-approvals-and-sandbox',
            'zhiyi auth warmup, reply ok',
          ],
          {
            detached: true,
            cwd: this.home,
            stdio: ['ignore', 'ignore', 'ignore'],
            env: {
              ...process.env,
              HOME: this.home,
              CODEX_HOME: codexHome,
              BAIDU_CX_PLATFORM: DUCX_PLATFORM,
              DISABLE_DUCX_CLI_UPDATE: '1',
              DISABLE_BAIDU_CLAUDE_UPDATE: '1',
            },
          },
        );
        child.once('error', (error: Error): void => finish(error));
        child.once('exit', (code: number | null): void => {
          if (!settled) finish(new Error(`DUCX 在发出认证请求前退出（code=${code}）`));
        });
      });
    });
  }
}
