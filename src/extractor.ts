/**
 * 后台记忆提取：进程内串行队列（setImmediate），不阻塞主链路。
 * 提取结果只写候选表，低置信度不自动进入正式记忆，必须人工 approve。
 */
import type { AppConfig } from './config';
import { ruleBasedExtract } from './extraction-rules';
import type { MockUpstream } from './mock-upstream';
import type { Logger } from './logger';
import type { CandidateStore } from './candidates';
import type { MemoryStore } from './memories';
import {
  buildUpstreamRequestForRoute,
  resolveOneApiRoute,
  translateUpstreamResponse,
} from './upstream/oneapi-protocol';
import type { UpstreamService } from './upstream/service';
import type {
  ChatMessage,
  ExtractedCandidate,
  Trajectory,
  UpstreamTransport,
} from './types';

const EXTRACT_SYSTEM_PROMPT = [
  '你是记忆抽取器。请从对话中识别具有长期价值的信息：用户偏好、项目背景、重要技术决策、稳定事实、可复用经验方法。',
  '规则：明显无价值的普通闲聊不保存；无法确定时不要编造；重复内容合并；每条必须能追溯到原对话。',
  '只返回 JSON 对象，格式为 {"memories":[{"type":"semantic","scope":"personal","content":"原文摘录","confidence":0.8,"reason":"原因"}]}。',
  'type 取值 identity|episodic|semantic|procedural|working；scope 取值 personal|agent|project|organization。',
].join('\n');

export interface ExtractionJob {
  trajectory: Trajectory;
  messages: ChatMessage[];
  assistantText: string;
  source: string;
}

export interface ExtractionDeps {
  config: AppConfig;
  candidateStore: CandidateStore;
  memoryStore: MemoryStore;
  mock: MockUpstream | null;
  transport: UpstreamTransport;
  logger: Logger;
  /** 运行期模型服务设置；候选记忆提取与主链路共用同一个上游。 */
  upstream?: UpstreamService;
}

interface ModelEnvelope {
  choices?: Array<{ message?: { content?: string } }>;
}

/** 解析模型返回的 JSON：兼容 ```json 围栏与前后夹带说明文字的真实模型输出。 */
function parseExtractionJson(content: string): { memories?: unknown } {
  const text: string = content.trim();
  const fenced: RegExpMatchArray | null = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate: string = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate) as { memories?: unknown };
  } catch {
    const start: number = candidate.indexOf('{');
    const end: number = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as { memories?: unknown };
    }
    throw new Error('提取结果不是合法 JSON');
  }
}

function sanitize(items: unknown): ExtractedCandidate[] {
  if (!Array.isArray(items)) return [];
  const result: ExtractedCandidate[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.content !== 'string' || item.content.trim().length < 6) continue;
    const confidence: number = Number(item.confidence);
    if (!Number.isFinite(confidence)) continue;
    result.push({
      type: (typeof item.type === 'string' ? item.type : 'semantic') as ExtractedCandidate['type'],
      scope: (typeof item.scope === 'string' ? item.scope : 'personal') as ExtractedCandidate['scope'],
      content: item.content.trim(),
      confidence: Math.min(1, Math.max(0, confidence)),
      reason: typeof item.reason === 'string' ? item.reason : 'model-extract',
    });
  }
  return result.slice(0, 5);
}

export class ExtractionQueue {
  private readonly deps: ExtractionDeps;
  private readonly jobs: ExtractionJob[] = [];
  private active = false;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(deps: ExtractionDeps) {
    this.deps = deps;
  }

  enqueue(job: ExtractionJob): void {
    this.jobs.push(job);
    this.schedule();
  }

  /** 供测试等待后台提取完成。 */
  whenIdle(): Promise<void> {
    if (!this.active && this.jobs.length === 0) return Promise.resolve();
    return new Promise<void>((resolve): void => {
      this.idleWaiters.push(resolve);
    });
  }

  private schedule(): void {
    if (this.active) return;
    this.active = true;
    setImmediate((): void => {
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (this.jobs.length > 0) {
      const job: ExtractionJob | undefined = this.jobs.shift();
      if (!job) break;
      try {
        await this.process(job);
      } catch (error) {
        this.deps.logger.error('后台记忆提取失败（不影响模型请求）', error);
      }
    }
    this.active = false;
    const waiters: Array<() => void> = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private async extractWithModel(job: ExtractionJob): Promise<ExtractedCandidate[]> {
    if (this.deps.config.mockUpstream && this.deps.mock) {
      try {
        return sanitize(await this.deps.mock.extract(job.messages, job.assistantText));
      } catch (error) {
        this.deps.logger.warn('Mock 提取模型不可用，回退规则提取', error);
        return sanitize(ruleBasedExtract(job.messages, job.assistantText));
      }
    }

    // 与主链路共用运行期设置与多协议路由，避免切换 API 后提取器仍打旧地址或不支持 OneAPI。
    const payload: Record<string, unknown> = {
      model: this.deps.config.defaultModel,
      temperature: 0,
      stream: false,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            messages: job.messages,
            assistant_response: job.assistantText,
          }).slice(0, 8000),
        },
      ],
    };
    const send = async (body: Record<string, unknown>): Promise<Response> => {
      if (this.deps.upstream) {
        return (await this.deps.upstream.sendChat(body)).response;
      }
      const route = resolveOneApiRoute(
        this.deps.config.upstreamBaseUrl,
        String(body.model ?? this.deps.config.defaultModel),
        'auto',
      );
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.deps.config.upstreamApiKey) {
        headers.authorization = `Bearer ${this.deps.config.upstreamApiKey}`;
      }
      const built = buildUpstreamRequestForRoute(route, body, headers);
      const raw = await this.deps.transport(built.url, {
        method: 'POST',
        headers: built.headers,
        body: built.body,
      });
      return translateUpstreamResponse(route.protocol, raw, {
        requestedModel: route.upstreamModel,
        wantsStream: false,
      });
    };
    try {
      let response: Response = await send(payload);
      // 部分 OpenAI 兼容端点不支持 response_format（实测会返回 400），
      // 此时退回纯提示词模式重试一次，而不是直接降级为规则提取。
      if (response.status === 400) {
        const { response_format: _ignored, ...withoutFormat } = payload;
        this.deps.logger.info('上游不支持 response_format=json_object，改用纯提示词模式重试提取');
        response = await send(withoutFormat);
      }
      if (!response.ok) throw new Error(`提取模型返回 ${response.status}`);
      const envelope = (await response.json()) as ModelEnvelope;
      const content: string = envelope.choices?.[0]?.message?.content ?? '{}';
      const parsed = parseExtractionJson(content);
      const extracted: ExtractedCandidate[] = sanitize(parsed.memories);
      if (extracted.length === 0) {
        this.deps.logger.info('模型提取未产出可用候选，回退规则提取');
        return sanitize(ruleBasedExtract(job.messages, job.assistantText));
      }
      return extracted;
    } catch (error) {
      this.deps.logger.warn('提取模型调用失败，回退规则提取', error);
      return sanitize(ruleBasedExtract(job.messages, job.assistantText));
    }
  }

  private async process(job: ExtractionJob): Promise<void> {
    if (!this.deps.config.memoryAutoExtract) return;
    const extracted: ExtractedCandidate[] = await this.extractWithModel(job);
    if (extracted.length === 0) return;
    const created: number = this.deps.candidateStore.createFromExtraction(
      extracted,
      {
        user_id: job.trajectory.user_id,
        agent_id: job.trajectory.agent_id,
        project_id: job.trajectory.project_id,
        trajectory_id: job.trajectory.id,
        source: job.source,
        minConfidence: this.deps.config.extractMinConfidence,
      },
      this.deps.memoryStore,
    );
    if (created > 0) {
      this.deps.logger.info(
        `轨迹 ${job.trajectory.request_id} 提取到 ${created} 条候选记忆`,
      );
    }
  }
}
