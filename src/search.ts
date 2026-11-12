/**
 * 简单本地记忆检索：关键词加权打分，不依赖向量库。
 * 优先级：当前用户个人记忆 > 当前 Agent 专属 > 当前 Project >
 *         关键词相关性 > 置信度 > 更新时间。
 */
import type { MemoryStore } from './memories';
import type { Memory, MemoryScope, SearchHit } from './types';

export interface SearchOptions {
  query: string;
  user_id: string;
  agent_id?: string | null;
  project_id?: string | null;
  scopes?: MemoryScope[];
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

function isVisible(memory: Memory, options: SearchOptions): boolean {
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
  return true;
}

export function searchMemories(store: MemoryStore, options: SearchOptions): SearchHit[] {
  const queryTokens: string[] = tokenize(options.query);
  const limit: number = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const hits: SearchHit[] = [];

  for (const memory of store.allForUser(options.user_id)) {
    if (!isVisible(memory, options)) continue;

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
    let score: number = relevance * 10 + scopeWeight(memory.scope);
    reasons.push(`scope:${memory.scope}(+${scopeWeight(memory.scope)})`);

    if (memory.agent_id && memory.agent_id === options.agent_id) {
      score += 30;
      reasons.push('agent-match(+30)');
    }
    if (memory.project_id && memory.project_id === options.project_id) {
      score += 25;
      reasons.push('project-match(+25)');
    }
    score += Number(memory.confidence) * 10;
    const ageDays: number = Math.max(
      0,
      (Date.now() - Date.parse(memory.updated_at || new Date().toISOString())) / 86_400_000,
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
