/**
 * 简单本地记忆检索：关键词加权打分，不依赖向量库。
 * 自动过滤已归档/已替代/已过期记忆（除非显式 include_archived），
 * 并结合用户确认标识、工作空间归属（Goal / Project / Task）、知识分类、置信度与新鲜度排序。
 */
import type { MemoryStore } from './memories';
import type { Memory, MemoryCategory, MemoryScope, SearchHit } from './types';

export interface SearchOptions {
  query: string;
  user_id: string;
  agent_id?: string | null;
  project_id?: string | null;
  goal_id?: string | null;
  task_id?: string | null;
  scopes?: MemoryScope[];
  categories?: MemoryCategory[];
  include_archived?: boolean;
  limit?: number;
}

/**
 * 中英文混合分词：英文按词、中文按单字 + 二元组，兼顾「架构」这类常见词。
 */
export function tokenize(text: string): string[] {
  const normalized: string = String(text ?? '').toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9_+#.\-]{2,}/g)) {
    tokens.add(match[0]);
  }
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]+/g)) {
    const segment: string = match[0];
    for (const char of segment) tokens.add(char);
    for (let i = 0; i < segment.length - 1; i += 1) {
      tokens.add(segment.slice(i, i + 2));
    }
  }
  return [...tokens];
}

function tokenWeight(token: string): number {
  if (/[\u4e00-\u9fff]/.test(token)) return token.length >= 2 ? 1.6 : 0.5;
  return token.length >= 5 ? 2.2 : 1.2;
}

function scopeWeight(scope: string): number {
  switch (scope) {
    case 'personal':
      return 200;
    case 'agent':
      return 140;
    case 'project':
      return 110;
    default:
      return 40;
  }
}

function categoryWeight(category: MemoryCategory): number {
  switch (category) {
    case 'profile_fact':
    case 'preference':
    case 'goal':
      return 14;
    case 'project_fact':
    case 'experience':
      return 10;
    case 'event':
      return 2;
    default:
      return 5;
  }
}

export function isMemoryExpired(memory: Pick<Memory, 'expires_at'>, nowMs = Date.now()): boolean {
  if (!memory.expires_at) return false;
  const parsed = Date.parse(memory.expires_at);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

function isVisible(memory: Memory, options: SearchOptions, nowMs: number): boolean {
  if (!options.include_archived) {
    if (memory.status !== 'active') return false;
    if (isMemoryExpired(memory, nowMs)) return false;
  }
  // 其它 Agent 的专属记忆不可见；personal 记忆对所有 Agent 可见。
  if (memory.scope === 'agent' && memory.agent_id && memory.agent_id !== options.agent_id) {
    return false;
  }
  // 其它项目的专属记忆不可见。
  if (memory.scope === 'project' && memory.project_id && memory.project_id !== options.project_id) {
    return false;
  }
  if (options.scopes && options.scopes.length > 0 && !options.scopes.includes(memory.scope)) {
    return false;
  }
  if (
    options.categories &&
    options.categories.length > 0 &&
    !options.categories.includes(memory.category)
  ) {
    return false;
  }
  return true;
}

export function searchMemories(store: MemoryStore, options: SearchOptions): SearchHit[] {
  const queryTokens: string[] = tokenize(options.query);
  const limit: number = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const nowMs: number = Date.now();
  const hits: SearchHit[] = [];

  for (const memory of store.allForUser(options.user_id, Boolean(options.include_archived))) {
    if (!isVisible(memory, options, nowMs)) continue;

    const contentTokens = new Set(tokenize(memory.content));
    const matched: string[] = [];
    let relevance = 0;
    for (const token of queryTokens) {
      if (contentTokens.has(token)) {
        matched.push(token);
        relevance += tokenWeight(token);
      }
    }
    // 有查询词但完全不相关时跳过；空查询退化为按权重罗列。
    if (queryTokens.length > 0 && matched.length === 0) continue;

    const reasons: string[] = [];
    let score: number = relevance * 10 + scopeWeight(memory.scope) + categoryWeight(memory.category);
    reasons.push(`scope:${memory.scope}(+${scopeWeight(memory.scope)})`);

    if (memory.verified_by_user) {
      score += 15;
      reasons.push('user-verified(+15)');
    }
    if (memory.agent_id && memory.agent_id === options.agent_id) {
      score += 30;
      reasons.push('agent-match(+30)');
    }
    if (memory.project_id && memory.project_id === options.project_id) {
      score += 25;
      reasons.push('project-match(+25)');
    }
    if (options.goal_id && memory.goal_id === options.goal_id) {
      score += 20;
      reasons.push('goal-match(+20)');
    }
    if (options.task_id && memory.task_id === options.task_id) {
      score += 20;
      reasons.push('task-match(+20)');
    }
    score += Number(memory.confidence) * 10;
    const ageDays: number = Math.max(
      0,
      (nowMs - Date.parse(memory.updated_at || new Date(nowMs).toISOString())) / 86_400_000,
    );
    const recency: number = Number.isFinite(ageDays) ? Math.max(0, 6 - ageDays / 30) : 0;
    score += recency;
    reasons.push(`relevance(+${(relevance * 10).toFixed(1)})`);

    hits.push({
      memory,
      score: Number(score.toFixed(2)),
      matched_keywords: [...new Set(matched)].slice(0, 10),
      reasons,
    });
  }

  hits.sort((a: SearchHit, b: SearchHit): number => {
    if (b.score !== a.score) return b.score - a.score;
    return b.memory.updated_at.localeCompare(a.memory.updated_at);
  });
  return hits.slice(0, limit);
}
