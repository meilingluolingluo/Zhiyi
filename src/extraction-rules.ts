/**
 * 记忆提取的规则兜底实现。
 * 只从对话原文中摘录含明确信号的句子，绝不编造事实；
 * Mock 模式下模型不可用或真实模式模型调用失败时使用。
 */
import { messageText } from './context';
import type { ChatMessage, ExtractedCandidate, MemoryScope, MemoryType } from './types';

interface SignalRule {
  keywords: string[];
  type: MemoryType;
  scope: MemoryScope;
  confidence: number;
  reason: string;
}

const SIGNAL_RULES: readonly SignalRule[] = [
  {
    keywords: ['偏好', '喜欢', '倾向于', '优先', '习惯', '讨厌', '避免', '不要使用', '更喜欢'],
    type: 'semantic',
    scope: 'personal',
    confidence: 0.88,
    reason: '用户偏好',
  },
  {
    keywords: ['我们决定', '决定采用', '决定使用', '最终选定', '架构决策', '技术选型', '采用', '选定方案'],
    type: 'semantic',
    scope: 'project',
    confidence: 0.82,
    reason: '重要技术决策',
  },
  {
    keywords: ['项目使用', '项目采用', '项目背景', '我们的项目', '该项目', '技术栈'],
    type: 'semantic',
    scope: 'project',
    confidence: 0.8,
    reason: '项目背景 / 技术栈',
  },
  {
    keywords: ['记得', '记住', '以后', '下次', '请始终', '请一直', '务必', '从今往后'],
    type: 'identity',
    scope: 'personal',
    confidence: 0.86,
    reason: '需要长期记住的稳定事实或约定',
  },
  {
    keywords: ['可复用', '复盘', '踩坑', '经验', '流程', '步骤', '最佳实践'],
    type: 'procedural',
    scope: 'personal',
    confidence: 0.74,
    reason: '可复用经验方法',
  },
];

const CHITCHAT_ONLY: RegExp = /^(你好|您好|hi|hello|谢谢|多谢|请问|在吗|好的|嗯|ok|okay|明白|收到|帮我|帮我看|继续)[。！？!?\s，,]*$/i;

/** 归一化内容，用于候选去重与正式记忆查重。 */
export function normalizeContent(content: string): string {
  return String(content ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function bestRule(sentence: string): SignalRule | undefined {
  let best: SignalRule | undefined;
  let bestHits = 0;
  for (const rule of SIGNAL_RULES) {
    const hits: number = rule.keywords.filter((keyword: string): boolean =>
      sentence.includes(keyword),
    ).length;
    if (hits === 0) continue;
    if (!best || hits > bestHits || (hits === bestHits && rule.confidence > best.confidence)) {
      best = rule;
      bestHits = hits;
    }
  }
  return best;
}

function splitSentences(text: string): string[] {
  return String(text ?? '')
    .split(/[。！？!?；;\n]+/)
    .map((part: string): string => part.trim())
    .filter((part: string): boolean => part.length > 0);
}

/**
 * 从一轮对话中抽取候选记忆。明显无价值的闲聊不产生候选。
 */
export function ruleBasedExtract(
  messages: ChatMessage[],
  assistantText: string,
): ExtractedCandidate[] {
  const userTexts: string[] = messages
    .filter((message: ChatMessage): boolean => message.role === 'user')
    .slice(-3)
    .map(messageText)
    .filter(Boolean);
  const combined: string = [...userTexts, assistantText].filter(Boolean).join('\n');
  const results: ExtractedCandidate[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(combined)) {
    if (sentence.length < 6 || sentence.length > 220) continue;
    if (CHITCHAT_ONLY.test(sentence)) continue;
    const rule: SignalRule | undefined = bestRule(sentence);
    if (!rule) continue;
    const content: string = sentence.replace(/^(用户|user)\s*[:：]\s*/i, '').trim();
    const key: string = normalizeContent(content);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push({
      type: rule.type,
      scope: rule.scope,
      content,
      confidence: rule.confidence,
      reason: rule.reason,
    });
    if (results.length >= 5) break;
  }
  return results;
}
