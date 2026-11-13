/**
 * 记忆提取的规则兜底实现。
 *
 * 从对话中提取具有长期价值的信号（偏好、稳定属性、长期目标、项目决策、可复用经验），
 * 严格过滤普通寒暄、纯疑问句及一次性临时表述，且不把模型自身猜测记录为用户事实。
 */
import { messageText } from './context';
import type {
  ChatMessage,
  ExtractedCandidate,
  MemoryCategory,
  MemoryScope,
  MemoryType,
} from './types';

interface SignalRule {
  keywords: string[];
  type: MemoryType;
  scope: MemoryScope;
  category: MemoryCategory;
  confidence: number;
  reason: string;
}

const USER_SIGNAL_RULES: readonly SignalRule[] = [
  {
    keywords: ['偏好', '喜欢', '倾向于', '优先', '习惯', '讨厌', '避免', '不要使用', '更喜欢', '工作方式', '风格'],
    type: 'semantic',
    scope: 'personal',
    category: 'preference',
    confidence: 0.88,
    reason: '用户偏好或工作方式',
  },
  {
    keywords: ['长期目标', '今年目标', '年度目标', '职业目标', '打算长期', '规划目标是'],
    type: 'semantic',
    scope: 'personal',
    category: 'goal',
    confidence: 0.85,
    reason: '用户长期目标',
  },
  {
    keywords: ['我们决定', '决定采用', '决定使用', '最终选定', '架构决策', '技术选型', '采用', '选定方案'],
    type: 'semantic',
    scope: 'project',
    category: 'project_fact',
    confidence: 0.82,
    reason: '项目关键决策',
  },
  {
    keywords: ['项目使用', '项目采用', '项目背景', '我们的项目', '该项目', '技术栈'],
    type: 'semantic',
    scope: 'project',
    category: 'project_fact',
    confidence: 0.8,
    reason: '项目背景 / 技术栈',
  },
  {
    keywords: ['记得', '记住', '以后', '下次', '请始终', '请一直', '务必', '从今往后', '我常用', '我主要用', '经常使用', '我是'],
    type: 'identity',
    scope: 'personal',
    category: 'profile_fact',
    confidence: 0.86,
    reason: '用户稳定属性、常用工具或长期约定',
  },
  {
    keywords: ['可复用', '复盘', '踩坑', '经验', '流程', '步骤', '最佳实践', '已经验证'],
    type: 'procedural',
    scope: 'personal',
    category: 'experience',
    confidence: 0.78,
    reason: '可复用经验方法',
  },
];

const ASSISTANT_EXPERIENCE_RULE: SignalRule = {
  keywords: ['复盘结论', '踩坑记录', '已验证', '最佳实践', '经验总结'],
  type: 'procedural',
  scope: 'project',
  category: 'experience',
  confidence: 0.72,
  reason: '工作经验总结（非用户直述）',
};

const CHITCHAT_ONLY: RegExp =
  /^(你好|您好|hi|hello|谢谢|多谢|请问|在吗|好的|嗯|ok|okay|明白|收到|帮我|帮我看|继续)[。！？!?\s，,]*$/i;

const TRANSIENT_NOISE_RE: RegExp =
  /(^|[，,\s])(今天先|这次先|临时|暂时先|待会儿|等一下|刚才|刚刚|试一下|测试一下|随便看看|顺便问下|今天天气)/;

const EXPLICIT_REMEMBER_PREFIX_RE: RegExp = /^(请)?(记住|记得|以后|从今往后)/;

/** 归一化内容，用于候选去重与正式记忆查重。 */
export function normalizeContent(content: string): string {
  return String(content ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function isTransientOrQuestionOnly(sentence: string): boolean {
  if (CHITCHAT_ONLY.test(sentence)) return true;
  if (TRANSIENT_NOISE_RE.test(sentence) && !EXPLICIT_REMEMBER_PREFIX_RE.test(sentence)) {
    return true;
  }
  if (/[？?]$/.test(sentence) && !EXPLICIT_REMEMBER_PREFIX_RE.test(sentence)) {
    return true;
  }
  return false;
}

function bestUserRule(sentence: string): SignalRule | undefined {
  let best: SignalRule | undefined;
  let bestHits = 0;
  for (const rule of USER_SIGNAL_RULES) {
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
 * 从一轮对话中抽取候选记忆。
 * 用户轮抽取偏好/属性/目标/项目事实/经验；助手输出仅抽取明确总结性经验，避免模型推测冒充用户事实。
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

  const results: ExtractedCandidate[] = [];
  const seen = new Set<string>();

  for (const userBlock of userTexts) {
    for (const sentence of splitSentences(userBlock)) {
      if (sentence.length < 6 || sentence.length > 220) continue;
      if (isTransientOrQuestionOnly(sentence)) continue;
      const rule: SignalRule | undefined = bestUserRule(sentence);
      if (!rule) continue;
      const content: string = sentence.replace(/^(用户|user)\s*[:：]\s*/i, '').trim();
      const key: string = normalizeContent(content);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push({
        type: rule.type,
        scope: rule.scope,
        category: rule.category,
        content,
        confidence: rule.confidence,
        reason: rule.reason,
      });
      if (results.length >= 5) return results;
    }
  }

  for (const sentence of splitSentences(assistantText)) {
    if (sentence.length < 10 || sentence.length > 220) continue;
    if (isTransientOrQuestionOnly(sentence)) continue;
    if (!ASSISTANT_EXPERIENCE_RULE.keywords.some((kw) => sentence.includes(kw))) continue;
    const key: string = normalizeContent(sentence);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push({
      type: ASSISTANT_EXPERIENCE_RULE.type,
      scope: ASSISTANT_EXPERIENCE_RULE.scope,
      category: ASSISTANT_EXPERIENCE_RULE.category,
      content: sentence,
      confidence: ASSISTANT_EXPERIENCE_RULE.confidence,
      reason: ASSISTANT_EXPERIENCE_RULE.reason,
    });
    if (results.length >= 5) break;
  }

  return results;
}
