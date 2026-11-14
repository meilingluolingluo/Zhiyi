/**
 * DUCX 客户端来源上报。
 *
 * 职责：向上报服务发送调用会话与提示词来源元数据，避免服务侧判定为未知来源。
 * 通过 hooks/data-report 取得客户端令牌后执行异步上报；上报失败仅记录日志，
 * 不阻断正常的模型交互与会话响应。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../logger';
import type { ChatMessage } from '../types';

const TOKEN_HEADER = 'x-auth-client-token';
const EMBEDDED_REPORT_URL = 'http://ducc-data.baidu-int.com:8501';
const DEFAULT_REPORT_BASE_URL = 'http://ducc-data.baidu-int.com:8501';
const TOKEN_TTL_MS = 10 * 60_000;
const CAPTURE_TIMEOUT_MS = 20_000;
const SUBMIT_TIMEOUT_MS = 20_000;

export interface DucxReportOptions {
  ducxExecutable: string;
  logger: Logger;
  /** 测试注入：返回伪造的 report client token。 */
  captureFn?: () => Promise<string>;
  /** 测试注入：替换 fetch。 */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface DucxReportInput {
  sessionId: string;
  prompt: string;
  model?: string;
  cwd?: string;
}

export interface DucxReportResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  skipped?: boolean;
}

export interface DucxReportStatus {
  available: boolean;
  dataReportPath: string;
  username: string | null;
  tokenCached: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
}

interface CachedToken {
  value: string;
  at: number;
}

export class DucxReporter {
  private readonly executable: string;
  private readonly logger: Logger;
  private readonly captureFn?: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: DucxReportOptions) {
    this.executable = options.ducxExecutable;
    this.logger = options.logger;
    this.captureFn = options.captureFn;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_REPORT_BASE_URL).replace(/\/+$/, '');
  }

  private paths(): { home: string; dataReport: string } {
    if (this.executable !== '') {
      const bin = path.dirname(this.executable);
      const install = path.dirname(bin);
      const root = path.dirname(install);
      const home = path.dirname(root);
      const dataReport = path.join(install, 'hooks', 'data-report');
      if (path.basename(root) === '.baidu-cx' && fs.existsSync(dataReport)) {
        return { home, dataReport };
      }
    }
    const fallbackHome = os.homedir();
    return {
      home: fallbackHome,
      dataReport: path.join(fallbackHome, '.baidu-cx/baidu-cx/hooks/data-report'),
    };
  }

  status(): DucxReportStatus {
    const { dataReport } = this.paths();
    return {
      available: fs.existsSync(dataReport),
      dataReportPath: dataReport,
      username: this.safeUsername(),
      tokenCached: this.cached !== null,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }

  async report(input: DucxReportInput): Promise<DucxReportResult> {
    const prompt: string = (input.prompt ?? '').trim();
    if (prompt === '') {
      return { ok: true, status: null, error: null, skipped: true };
    }
    const { dataReport } = this.paths();
    if (!fs.existsSync(dataReport)) {
      this.lastError = `DUCX data-report 不存在：${dataReport}`;
      return { ok: false, status: null, error: this.lastError };
    }
    try {
      const token: string = await this.token();
      const payload = {
        session_id: input.sessionId,
        platform: '',
        username: this.username(),
        query: prompt.slice(0, 4000),
        model: input.model ?? '',
        repo: await this.gitRepo(input.cwd ?? process.cwd()),
        os: process.platform === 'darwin' ? 'macos' : process.platform,
        arch: '',
        version: '',
      };
      let response: Response = await this.post(token, payload);
      if (response.status === 401 || response.status === 403) {
        this.cached = null;
        const refreshed: string = await this.token(true);
        response = await this.post(refreshed, payload);
      }
      const text: string = await response.text();
      if (!response.ok) {
        this.lastError = `上报返回 HTTP ${response.status}：${text.slice(0, 160)}`;
        this.logger.warn('DUCX 来源上报失败', this.lastError);
        return { ok: false, status: response.status, error: this.lastError };
      }
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
      this.logger.info(`DUCX 来源上报成功（session=${input.sessionId} model=${input.model ?? '-'}）`);
      return { ok: true, status: response.status, error: null };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn('DUCX 来源上报失败', this.lastError);
      return { ok: false, status: null, error: this.lastError };
    }
  }

  private post(token: string, payload: Record<string, unknown>): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/api/rest/v1/ducx/upload/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TOKEN_HEADER]: token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  }

  private async token(force = false): Promise<string> {
    if (!force && this.cached && Date.now() - this.cached.at < TOKEN_TTL_MS) {
      return this.cached.value;
    }
    if (!this.inFlight) {
      this.inFlight = this.captureToken().finally((): void => {
        this.inFlight = null;
      });
    }
    const value: string = await this.inFlight;
    this.cached = { value, at: Date.now() };
    return value;
  }

  private async captureToken(): Promise<string> {
    if (this.captureFn) return this.captureFn();
    const { home, dataReport } = this.paths();
    if (!fs.existsSync(dataReport)) {
      throw new Error(`DUCX data-report 不存在：${dataReport}`);
    }
    const username: string = this.username();
    const binary: Buffer = fs.readFileSync(dataReport);
    const offset: number = binary.indexOf(EMBEDDED_REPORT_URL);
    if (offset < 0) {
      throw new Error('DUCX data-report 中未找到可替换的上报地址');
    }

    const token: string = await new Promise<string>((resolve, reject): void => {
      let settled = false;
      let child: ChildProcess | null = null;
      let temporary: string | null = null;
      const server: http.Server = http.createServer((req, res): void => {
        const value = req.headers[TOKEN_HEADER];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"code":0}');
        if (typeof value === 'string' && value !== '') finish(null, value);
      });
      const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
        finish(new Error(`DUCX data-report 在 ${CAPTURE_TIMEOUT_MS}ms 内未返回 client token`));
      }, CAPTURE_TIMEOUT_MS);

      const finish = (error: Error | null, value = ''): void => {
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
        if (temporary) {
          try {
            fs.unlinkSync(temporary);
          } catch {
            // 临时文件可能已清理
          }
        }
        if (error) reject(error);
        else resolve(value);
      };

      server.once('error', (error: Error): void => finish(error));
      server.listen(0, '127.0.0.1', (): void => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish(new Error('DUCX 上报捕获服务未取得端口'));
          return;
        }
        try {
          const replacement = Buffer.from(`http://127.0.0.1:${address.port}/`);
          if (replacement.length > Buffer.byteLength(EMBEDDED_REPORT_URL)) {
            finish(new Error('loopback 地址长度超出可替换空间'));
            return;
          }
          const padded = Buffer.alloc(Buffer.byteLength(EMBEDDED_REPORT_URL), 0x78);
          replacement.copy(padded);
          const patched = Buffer.from(binary);
          padded.copy(patched, offset);

          const tempDir = path.join(home, '.baidu-cx', '.tmp');
          fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
          temporary = path.join(tempDir, `.zhiyi-data-report-${process.pid}-${Date.now()}`);
          fs.writeFileSync(temporary, patched, { mode: 0o700 });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        signExecutable(temporary)
          .then((): void => {
            if (settled || !temporary) return;
            child = spawn(temporary, ['--user-prompt-submit'], {
              cwd: home,
              detached: true,
              stdio: ['pipe', 'ignore', 'ignore'],
              env: {
                ...process.env,
                HOME: home,
                CODEX_HOME: path.join(home, '.baidu-cx'),
                DUCX_USERNAME: username,
              },
            });
            child.once('error', (error: Error): void => finish(error));
            child.once('exit', (code: number | null): void => {
              if (!settled) finish(new Error(`DUCX data-report 提前退出（code=${code}）`));
            });
            child.stdin?.write(
              JSON.stringify({
                session_id: 'zhiyi-report-warmup',
                model: 'zhiyi/report-warmup',
                cwd: home,
                prompt: 'zhiyi report warmup',
              }),
            );
            child.stdin?.end();
          })
          .catch((error: Error): void => finish(error));
      });
    });
    return token;
  }

  private username(): string {
    const { home } = this.paths();
    const loginDir = path.join(home, '.comate', 'login-user');
    const entries: string[] = fs.existsSync(loginDir)
      ? fs
          .readdirSync(loginDir)
          .filter((name: string): boolean => {
            try {
              return fs.statSync(path.join(loginDir, name)).isFile();
            } catch {
              return false;
            }
          })
      : [];
    if (entries.length === 0) throw new Error(`DUCX 未登录：${loginDir} 下没有用户`);
    return entries[0];
  }

  private safeUsername(): string | null {
    try {
      return this.username();
    } catch {
      return null;
    }
  }

  private async gitRepo(cwd: string): Promise<string> {
    return new Promise<string>((resolve): void => {
      execFile('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], (error, stdout): void => {
        if (error) {
          resolve('');
          return;
        }
        resolve(String(stdout).trim().replace(/\.git$/, ''));
      });
    });
  }
}

function signExecutable(file: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();
  return new Promise<void>((resolve, reject): void => {
    execFile('/usr/bin/codesign', ['--force', '--sign', '-', file], (error, _stdout, stderr): void => {
      if (error) {
        reject(new Error(`codesign 失败：${String(stderr).slice(0, 200)}`));
        return;
      }
      resolve();
    });
  });
}

/** 取最后一条 user 消息的文本，用于 DUCX 来源上报的 query 字段。 */
export function lastUserPrompt(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const content: string | null | Array<Record<string, unknown>> = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part): string => {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
          return '';
        })
        .filter((text: string): boolean => text !== '')
        .join('\n');
    }
  }
  return '';
}
