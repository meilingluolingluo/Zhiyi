/**
 * 后台记忆提取：进程内串行队列（setImmediate），不阻塞主链路。
 * 提取结果只写候选表，低置信度不自动进入正式记忆，必须人工 approve。
 */
import type { AppConfig } from './config';
import { messageText } from './context';
import { ruleBasedExtract } from './extraction-rules';
import type { MockUpstream } from './mock-upstream';
import type { Logger } from './logger';
import type { CandidateStore } from './candidates';
import type { MemoryStore } from './memories';
import { searchMemories } from './search';
import {
  buildUpstreamRequestForRoute,
  resolveOneApiRoute,
  translateUpstreamResponse,
} from './upstream/oneapi-protocol';
import type { UpstreamService } from './upstream/service';
import type {
  ChatMessage,
  ExtractedCandidate,
  Memory,
  Trajectory,
  UpstreamTransport,
} from './types';

/** 构建融合已有记忆索引与演化事件的提取提示词（Mem0 V3 架构）。 */
function buildExtractSystemPrompt(existingListPrompt: string[]): string {
  return [
    '你是专业的长期记忆提取与演化分析器（Memory Extractor & Evolution Analyzer）。',
    '请从对话中识别具有长期价值的信息：用户偏好、稳定个人属性、常用技术/工具、长期目标、项目关键决策、已验证工作经验。',
    '',
    '【已有记忆清单（引用时必须使用方括号内的数字索引，严禁编造任何 UUID 或假 ID）】：',
    existingListPrompt.length > 0 ? existingListPrompt.join('\n') : '(当前暂无相关已有记忆)',
    '',
    '【提取与演化规则】：',
    '1. 普通闲聊、一次性临时安排（如“今天先这样/临时试一下”）或纯提问不要保存。',
    '2. 区分事件类型 event：',
    '   - "ADD": 全新事实，已有记忆列表中无相关条目（old_memory_index 设为 null）；',
    '   - "UPDATE": 与已有记忆冲突或更新变更（old_memory_index 设为对应记忆的数字索引）；',
    '   - "SUPPLEMENT": 对已有记忆的补充或扩展细节（old_memory_index 设为对应记忆的数字索引）；',
    '   - "DELETE": 已有记忆中的方案/约定已被用户明确声明废弃或下线（old_memory_index 设为对应记忆的数字索引）；',
    '   - "NONE": 无长期保存价值。',
    '3. 提取实体 entities 列表（如技术栈名称、库名、工具、模块名等）。',
    '4. 输出格式必须为严格合法的 JSON 对象：',
    '{"memories": [',
    '  {',
    '    "event": "ADD" | "UPDATE" | "SUPPLEMENT" | "DELETE",',
    '    "old_memory_index": number | null,',
    '    "type": "semantic" | "episodic" | "procedural" | "identity",',
    '    "scope": "personal" | "project" | "agent",',
    '    "category": "preference" | "profile_fact" | "goal" | "project_fact" | "experience",',
    '    "content": "精确、客观的事实表述",',
    '    "confidence": 0.85,',
    '    "entities": ["entity1", "entity2"],',
    '    "reason": "判断依据与原因"',
    '  }',
    ']}',
    '如果没有需要记录的长期记忆，请输出 {"memories": []}。',
  ].join('\n');
}

export interface ExtractionJob {
  trajectory: Trajectory;
  messages: ChatMessage[];
  assistantText: string;
  source: string;
  goal_id?: string | null;
  task_id?: string | null;
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

/**
 * 校验清洗模型或规则输出，将 old_memory_index 映射为真实的已有 memory_id（防 ID 幻觉）。
 */
function sanitizeWithIndexMap(
  items: unknown,
  indexMap: Map<number, Memory>,
): ExtractedCandidate[] {
  if (!Array.isArray(items)) return [];
  const result: ExtractedCandidate[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.content !== 'string' || item.content.trim().length < 6) continue;
    const confidence: number = Number(item.confidence);
    if (!Number.isFinite(confidence)) continue;

    let oldMemoryId: string | null = null;
    if (typeof item.old_memory_id === 'string' && item.old_memory_id.trim()) {
      oldMemoryId = item.old_memory_id.trim();
    } else {
      const rawIdx =
        typeof item.old_memory_index === 'number'
          ? item.old_memory_index
          : typeof item.old_memory_index === 'string' && /^\d+$/.test(item.old_memory_index)
            ? Number(item.old_memory_index)
            : null;
      if (rawIdx !== null && indexMap.has(rawIdx)) {
        oldMemoryId = indexMap.get(rawIdx)!.memory_id;
      }
    }

    let event: ExtractedCandidate['event'] = 'ADD';
    if (
      item.event === 'UPDATE' ||
      item.event === 'SUPPLEMENT' ||
      item.event === 'DELETE' ||
      item.event === 'NONE'
    ) {
      event = item.event;
    }

    const entities: string[] = Array.isArray(item.entities)
      ? item.entities
          .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
          .map((e) => e.trim())
      : [];

    result.push({
      type: (typeof item.type === 'string' ? item.type : 'semantic') as ExtractedCandidate['type'],
      scope: (typeof item.scope === 'string' ? item.scope : 'personal') as ExtractedCandidate['scope'],
      category: (typeof item.category === 'string' ? item.category : 'general') as ExtractedCandidate['category'],
      content: item.content.trim(),
      confidence: Math.min(1, Math.max(0, confidence)),
      reason: typeof item.reason === 'string' ? item.reason : 'model-extract',
      event,
      old_memory_id: oldMemoryId,
      entities,
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
    const userText = job.messages
      .filter((m) => m.role === 'user')
      .map(messageText)
      .join(' ');
    const queryText = (userText + ' ' + (job.assistantText || '')).trim().slice(0, 500);

    const existingHits = searchMemories(this.deps.memoryStore, {
      user_id: job.trajectory.user_id,
      query: queryText || '偏好 规则 技术栈',
      limit: 8,
    });
    const existingMemories = existingHits.map((h) => h.memory);
    const indexMap = new Map<number, Memory>();
    const existingListPrompt: string[] = [];
    existingMemories.forEach((m, idx) => {
      indexMap.set(idx, m);
      existingListPrompt.push(
        `[${idx}] (类型:${m.type}, 作用域:${m.scope}, 分类:${m.category}) ${m.content}`,
      );
    });

    if (this.deps.config.mockUpstream && this.deps.mock) {
      try {
        const mockResult = await this.deps.mock.extract(job.messages, job.assistantText);
        return sanitizeWithIndexMap(mockResult, indexMap);
      } catch (error) {
        this.deps.logger.warn('Mock 提取模型不可用，回退规则提取', error);
        return sanitizeWithIndexMap(ruleBasedExtract(job.messages, job.assistantText), indexMap);
      }
    }

    // 与主链路共用运行期设置与多协议路由，避免切换 API 后提取器仍打旧地址或不支持 OneAPI。
    const payload: Record<string, unknown> = {
      model: this.deps.config.defaultModel,
      temperature: 0,
      stream: false,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildExtractSystemPrompt(existingListPrompt) },
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
        return (await this.deps.upstream.sendChat(body, { forMemory: true })).response;
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
      if (Array.isArray(parsed.memories) && parsed.memories.length === 0) {
        return [];
      }
      const extracted: ExtractedCandidate[] = sanitizeWithIndexMap(parsed.memories, indexMap);
      if (extracted.length === 0) {
        this.deps.logger.info('模型提取未产出可用候选，回退规则提取');
        return sanitizeWithIndexMap(ruleBasedExtract(job.messages, job.assistantText), indexMap);
      }
      return extracted;
    } catch (error) {
      this.deps.logger.warn('提取模型调用失败，回退规则提取', error);
      return sanitizeWithIndexMap(ruleBasedExtract(job.messages, job.assistantText), indexMap);
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
        goal_id: job.goal_id ?? null,
        task_id: job.task_id ?? job.trajectory.task_id,
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
