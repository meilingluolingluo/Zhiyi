/**
 * 长期记忆进化治理：重复合并、新旧冲突识别、用户确认保护与显式纠偏。
 *
 * 核心安全约束：模型推断或自动提取（actor='model'）绝不可直接覆盖、篡改或归档
 * 已经由用户明确确认（verified_by_user=true）的记忆。
 */
import { normalizeContent } from './extraction-rules';
import type { MemoryStore } from './memories';
import { isMemoryExpired, tokenize } from './search';
import type { Memory, MemoryCategory, MemoryPatch, MemoryScope, NewMemory } from './types';

export type MemoryWriteActor = 'user' | 'model';

export interface EvolveWriteOptions {
  actor: MemoryWriteActor;
  supersedeConflicts?: boolean;
}

export type EvolveWriteResult =
  | { action: 'created'; memory: Memory }
  | { action: 'merged'; memory: Memory; note: string }
  | { action: 'superseded'; memory: Memory; superseded: Memory[] }
  | { action: 'conflict_blocked'; conflictWith: Memory; reason: string };

export class MemoryConflictError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly conflictMemoryId?: string,
  ) {
    super(message);
    this.name = 'MemoryConflictError';
  }
}

const CHOICE_SLOTS: ReadonlyArray<{
  slot: string;
  slotTerms: readonly string[];
  candidates: readonly string[];
}> = [
  {
    slot: 'language',
    slotTerms: ['语言', '开发', '编程', '后端', '前端', '首选', '主要使用', '技术栈', '写代码'],
    candidates: ['typescript', 'javascript', 'python', 'go', 'golang', 'rust', 'java', 'cpp'],
  },
  {
    slot: 'database',
    slotTerms: ['数据库', '存储', 'db', '迁移'],
    candidates: ['postgresql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'tidb'],
  },
  {
    slot: 'package_manager',
    slotTerms: ['包管理', '依赖', '安装'],
    candidates: ['pnpm', 'npm', 'yarn', 'bun', 'uv', 'pip'],
  },
  {
    slot: 'reply_style',
    slotTerms: ['回答', '回复', '风格', '解释', '输出'],
    candidates: ['简洁', '精简', '简短', '详细', '详尽', '展开'],
  },
  {
    slot: 'framework',
    slotTerms: ['框架', 'web', '后端', '前端', 'ui'],
    candidates: ['react', 'vue', 'svelte', 'express', 'fastify', 'nextjs', 'django', 'fastapi'],
  },
];

const POSITIVE_MARKERS: readonly string[] = ['偏好', '喜欢', '倾向', '采用', '使用', '首选', '优先', '坚持'];
const NEGATIVE_MARKERS: readonly string[] = ['不要', '避免', '禁止', '不再使用', '放弃', '讨厌', '不用'];

function jaccardSimilarity(aTokens: readonly string[], bTokens: readonly string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function sameIsolationBucket(
  a: Pick<Memory, 'scope' | 'agent_id' | 'project_id'>,
  b: Pick<Memory, 'scope' | 'agent_id' | 'project_id'>,
): boolean {
  if (a.scope !== b.scope) return false;
  if (a.scope === 'agent' && a.agent_id !== b.agent_id) return false;
  if (a.scope === 'project' && a.project_id !== b.project_id) return false;
  return true;
}

export function isDuplicateContent(aText: string, bText: string): boolean {
  const normA = normalizeContent(aText);
  const normB = normalizeContent(bText);
  if (!normA || !normB) return false;
  if (normA === normB || normA.includes(normB) || normB.includes(normA)) return true;
  const tokensA = tokenize(aText).filter((t) => t.length >= 2);
  const tokensB = tokenize(bText).filter((t) => t.length >= 2);
  return tokensA.length >= 3 && tokensB.length >= 3 && jaccardSimilarity(tokensA, tokensB) >= 0.85;
}

function polarityOf(text: string): 'positive' | 'negative' | 'neutral' {
  const neg = NEGATIVE_MARKERS.some((m) => text.includes(m));
  if (neg) return 'negative';
  const pos = POSITIVE_MARKERS.some((m) => text.includes(m));
  return pos ? 'positive' : 'neutral';
}

function extractSlotChoice(text: string, slot: (typeof CHOICE_SLOTS)[number]): string | null {
  const lower = text.toLowerCase();
  for (const c of slot.candidates) {
    if (lower.includes(c)) return c;
  }
  return null;
}

/** 识别同域内与新记忆直接冲突的已有记忆（例如同主题正反立场相反，或同类技术选型变更）。 */
export function findConflictingMemory(
  candidateText: string,
  bucket: { scope: MemoryScope; agent_id?: string | null; project_id?: string | null; category?: MemoryCategory },
  existingMemories: readonly Memory[],
  ignoreMemoryId?: string,
): { memory: Memory; reason: string } | undefined {
  const nowMs = Date.now();
  const candTokens = tokenize(candidateText).filter((t) => t.length >= 2);
  const candPolarity = polarityOf(candidateText);

  for (const existing of existingMemories) {
    if (ignoreMemoryId && existing.memory_id === ignoreMemoryId) continue;
    if (existing.status !== 'active' || isMemoryExpired(existing, nowMs)) continue;
    if (
      !sameIsolationBucket(existing, {
        scope: bucket.scope,
        agent_id: bucket.agent_id ?? null,
        project_id: bucket.project_id ?? null,
      })
    ) {
      continue;
    }
    if (isDuplicateContent(candidateText, existing.content)) continue;

    // 1. 同一技术/风格选择槽位选择了不同实体
    for (const slot of CHOICE_SLOTS) {
      const candHasContext = slot.slotTerms.some((t) => candidateText.toLowerCase().includes(t));
      const existHasContext = slot.slotTerms.some((t) => existing.content.toLowerCase().includes(t));
      const candChoice = extractSlotChoice(candidateText, slot);
      const existChoice = extractSlotChoice(existing.content, slot);
      if (candChoice && existChoice && candChoice !== existChoice && (candHasContext || existHasContext)) {
        return {
          memory: existing,
          reason: `与已有记忆(${existing.memory_id})在 ${slot.slot} 选项上存在冲突：${existChoice} -> ${candChoice}`,
        };
      }
    }

    // 2. 相同主题词高重叠但肯定/否定倾向反转
    const existTokens = tokenize(existing.content).filter((t) => t.length >= 2);
    const overlap = jaccardSimilarity(candTokens, existTokens);
    const existPolarity = polarityOf(existing.content);
    if (
      overlap >= 0.35 &&
      ((candPolarity === 'negative' && existPolarity === 'positive') ||
        (candPolarity === 'positive' && existPolarity === 'negative'))
    ) {
      return {
        memory: existing,
        reason: `与已有记忆(${existing.memory_id})立场冲突（确认倾向相反）`,
      };
    }
  }
  return undefined;
}

/** 在调用方已持有的事务内执行记忆进化写入，避免 SQLite 嵌套 BEGIN IMMEDIATE。 */
export function evolveMemoryWriteInTx(
  store: MemoryStore,
  input: NewMemory,
  options: EvolveWriteOptions,
): EvolveWriteResult {
  const scope: MemoryScope = input.scope ?? 'personal';
  const existingAll = store.allForUser(input.user_id, false);
  const nowMs = Date.now();
  const activeBucket = existingAll.filter(
    (m) =>
      m.status === 'active' &&
      !isMemoryExpired(m, nowMs) &&
      sameIsolationBucket(m, {
        scope,
        agent_id: input.agent_id ?? null,
        project_id: input.project_id ?? null,
      }),
  );

  const duplicate = activeBucket.find((m) => isDuplicateContent(input.content, m.content));
  if (duplicate) {
    if (options.actor === 'model' && duplicate.verified_by_user) {
      return {
        action: 'merged',
        memory: duplicate,
        note: '命中已由用户确认的记忆，保留原表述',
      };
    }
    const nextConfidence = Math.min(
      1,
      Math.max(duplicate.confidence, input.confidence ?? duplicate.confidence) + 0.05,
    );
    const existingEvidences = duplicate.evidence_trajectory_ids ?? [];
    const newEvidences = input.evidence_trajectory_ids ?? [];
    const mergedEvidences = Array.from(new Set([...existingEvidences, ...newEvidences]));
    const updated = store.update(input.user_id, duplicate.memory_id, {
      confidence: nextConfidence,
      evidence_trajectory_ids: mergedEvidences,
      project_id: duplicate.project_id ?? input.project_id ?? null,
      goal_id: duplicate.goal_id ?? input.goal_id ?? null,
      task_id: duplicate.task_id ?? input.task_id ?? null,
      expires_at: input.expires_at !== undefined ? input.expires_at : duplicate.expires_at,
      ...(options.actor === 'user' ? { verified_by_user: true } : {}),
    }) as Memory;
    return {
      action: 'merged',
      memory: updated,
      note: `与已有记忆 ${duplicate.memory_id} 语义重复，已合并更新`,
    };
  }

  const conflict = findConflictingMemory(
    input.content,
    {
      scope,
      agent_id: input.agent_id ?? null,
      project_id: input.project_id ?? null,
      category: input.category,
    },
    activeBucket,
  );

  if (conflict) {
    if (options.actor === 'model' && conflict.memory.verified_by_user) {
      return {
        action: 'conflict_blocked',
        conflictWith: conflict.memory,
        reason: `检测到与用户已确认记忆 ${conflict.memory.memory_id} 冲突，模型推断不能直接覆盖`,
      };
    }
    if (options.supersedeConflicts !== false) {
      const created = store.create({
        ...input,
        verified_by_user: options.actor === 'user' ? (input.verified_by_user ?? true) : false,
      });
      const oldArchived = store.archive(
        input.user_id,
        conflict.memory.memory_id,
        created.memory_id,
      ) as Memory;
      return {
        action: 'superseded',
        memory: created,
        superseded: [oldArchived],
      };
    }
  }

  const created = store.create({
    ...input,
    verified_by_user: options.actor === 'user' ? (input.verified_by_user ?? true) : false,
  });
  return { action: 'created', memory: created };
}

/**
 * 安全写入或进化长期记忆：
 * - 重复记忆就地合并刷新置信度/时间/关联；
 * - 冲突时保护 verified_by_user 不被模型覆盖；用户确认写入则自动标记旧记录为 superseded。
 */
export function evolveMemoryWrite(
  store: MemoryStore,
  input: NewMemory,
  options: EvolveWriteOptions,
): EvolveWriteResult {
  return store.runInTransaction((): EvolveWriteResult =>
    evolveMemoryWriteInTx(store, input, options),
  );
}

/** 用户主动纠正已有记忆：生成新版本确认记忆并把旧版本标记为 superseded，完整留痕。 */
export function correctMemory(
  store: MemoryStore,
  userId: string,
  memoryId: string,
  correction: {
    content: string;
    category?: MemoryCategory;
    expires_at?: string | null;
  },
  options: { actor: MemoryWriteActor; userConfirmedCorrection?: boolean },
): { corrected: Memory; superseded: Memory } {
  return store.runInTransaction(() => {
    const existing = store.getById(userId, memoryId);
    if (!existing) {
      throw new MemoryConflictError('记忆不存在或无权访问', 404, 'not_found');
    }
    if (
      existing.verified_by_user &&
      options.actor === 'model' &&
      !options.userConfirmedCorrection
    ) {
      throw new MemoryConflictError(
        `记忆 ${memoryId} 已由用户明确确认，模型推断不能直接覆盖，请向用户核实后再纠正`,
        409,
        'verified_memory_protected',
        memoryId,
      );
    }
    const created = store.create({
      user_id: userId,
      agent_id: existing.agent_id,
      project_id: existing.project_id,
      goal_id: existing.goal_id,
      task_id: existing.task_id,
      type: existing.type,
      scope: existing.scope,
      category: correction.category ?? existing.category,
      content: correction.content.trim(),
      source: 'user-correction',
      confidence: 1,
      evidence_trajectory_ids: existing.evidence_trajectory_ids,
      verified_by_user: true,
      expires_at:
        correction.expires_at !== undefined ? correction.expires_at : existing.expires_at,
    });
    const oldArchived = store.archive(userId, memoryId, created.memory_id) as Memory;
    return { corrected: created, superseded: oldArchived };
  });
}

/** 受权限和用户确认保护约束的通用更新/归档门面。 */
export function mutateMemoryWithGuard(
  store: MemoryStore,
  userId: string,
  memoryId: string,
  action: { kind: 'update'; patch: MemoryPatch } | { kind: 'archive'; reason?: string },
  options: { actor: MemoryWriteActor; userConfirmedCorrection?: boolean },
): Memory {
  const existing = store.getById(userId, memoryId);
  if (!existing) {
    throw new MemoryConflictError('记忆不存在或无权访问', 404, 'not_found');
  }
  if (
    existing.verified_by_user &&
    options.actor === 'model' &&
    !options.userConfirmedCorrection
  ) {
    throw new MemoryConflictError(
      `记忆 ${memoryId} 已由用户明确确认，模型推断禁止直接修改或归档`,
      409,
      'verified_memory_protected',
      memoryId,
    );
  }
  if (action.kind === 'archive') {
    return store.archive(userId, memoryId) as Memory;
  }
  const safePatch: MemoryPatch = {
    ...action.patch,
    ...(options.actor === 'user' || options.userConfirmedCorrection
      ? { verified_by_user: true }
      : {}),
  };
  return store.update(userId, memoryId, safePatch) as Memory;
}
