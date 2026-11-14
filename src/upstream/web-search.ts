/**
 * 网页搜索（Search）与网页抓取（Fetch）服务。
 * 兼容 DeepSeek 官方 Tools Search / Fetch 协议：
 * - POST /v1/tools/search：输入 query，返回按 rerank 排序的结构化搜索结果。
 * - POST /v1/tools/fetch：输入 url，抓取并以 Markdown 文本返回网页正文。
 */
import type { UpstreamTransport } from '../types';

export interface WebSearchItem {
  rerank_score: number;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
  authority: number;
}

export interface WebSearchParams {
  query: string;
  count?: number;
  ori_question?: string | null;
  localization?: string;
  need_content?: boolean;
}

export interface WebSearchResult {
  results: WebSearchItem[];
  [key: string]: unknown;
}

export interface WebFetchParams {
  url: string;
}

export interface WebFetchResult {
  title: string;
  content: string;
  [key: string]: unknown;
}

export class WebToolError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, message: string, code = 'invalid_request_error') {
    super(message);
    this.name = 'WebToolError';
    this.status = status;
    this.code = code;
  }
}

/** 校验并规范化搜索请求参数。 */
export function validateSearchParams(input: unknown): WebSearchParams {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WebToolError(400, '请求体必须是 JSON 对象');
  }
  const body = input as Record<string, unknown>;
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    throw new WebToolError(400, "'query' 字段必须为 1~128 字符且非空");
  }
  const query = body.query.trim();
  if (query.length > 128) {
    throw new WebToolError(400, "'query' 字段长度不能超过 128 个字符");
  }

  let count = 10;
  if (body.count !== undefined && body.count !== null) {
    const parsedCount = Number(body.count);
    if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > 50) {
      throw new WebToolError(400, "'count' must be between 1 and 50");
    }
    count = parsedCount;
  }

  return {
    query,
    count,
    ori_question: typeof body.ori_question === 'string' ? body.ori_question.slice(0, 128) : null,
    localization: typeof body.localization === 'string' ? body.localization : '',
    need_content: Boolean(body.need_content),
  };
}

/** 校验并规范化网页抓取请求参数。 */
export function validateFetchParams(input: unknown): WebFetchParams {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WebToolError(400, '请求体必须是 JSON 对象');
  }
  const body = input as Record<string, unknown>;
  if (typeof body.url !== 'string' || body.url.trim() === '') {
    throw new WebToolError(400, "'url' 字段必须为有效的 HTTP/HTTPS URL");
  }
  const url = body.url.trim();
  if (url.length > 8192) {
    throw new WebToolError(400, "'url' 长度不能超过 8192 字符");
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('协议不支持');
    }
    if (parsed.username || parsed.password) {
      throw new WebToolError(400, 'url 不能携带用户名或密码');
    }
  } catch (err) {
    if (err instanceof WebToolError) throw err;
    throw new WebToolError(400, "'url' 格式非法，必须为包含 host 的有效 HTTP/HTTPS 地址");
  }

  return { url };
}

/** 生成模拟搜索结果。 */
export function generateMockSearchResults(query: string, count: number, needContent: boolean): WebSearchResult {
  const items: WebSearchItem[] = [];
  const safeCount = Math.min(Math.max(count, 1), 10);
  for (let i = 1; i <= safeCount; i++) {
    items.push({
      rerank_score: +(2.8 - (i - 1) * 0.2).toFixed(2),
      title: `${query} 相关检索结果 #${i}`,
      url: `https://example.com/search-result-${i}`,
      snippet: `这是关于「${query}」的网页摘要说明片段 #${i}。`,
      summary: `深度总结：针对「${query}」的核心内容归纳与权威信息提取 #${i}。`,
      content: needContent ? `# ${query} 详细文档 #${i}\n\n网页正文详细内容...` : '',
      site_name: 'Example News',
      site_icon: 'https://example.com/favicon.ico',
      date: new Date(Date.now() - (i - 1) * 86400000).toISOString(),
      authority: 3,
    });
  }
  return { results: items };
}

/** 生成模拟网页抓取结果。 */
export function generateMockFetchResult(targetUrl: string): WebFetchResult {
  return {
    title: `网页正文抓取 - ${targetUrl}`,
    content: `# 网页内容\n\n- 目标地址: ${targetUrl}\n- 抓取时间: ${new Date().toISOString()}\n\n这是从该网页抓取并提取的 Markdown 结构化内容。`,
  };
}

/** 解析上游工具请求目标地址。 */
export function resolveToolUrl(baseUrl: string, endpoint: '/tools/search' | '/tools/fetch'): string {
  const cleanBase = (baseUrl || 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '');
  if (cleanBase.endsWith('/v1')) {
    return `${cleanBase}${endpoint}`;
  }
  return `${cleanBase}/v1${endpoint}`;
}

/** 执行网络搜索请求。 */
export async function executeWebSearch(
  transport: UpstreamTransport,
  options: {
    baseUrl: string;
    apiKey: string;
    params: WebSearchParams;
    mockUpstream?: boolean;
    signal?: AbortSignal;
  },
): Promise<WebSearchResult> {
  const { baseUrl, apiKey, params, mockUpstream, signal } = options;
  if (mockUpstream) {
    return generateMockSearchResults(params.query, params.count ?? 10, Boolean(params.need_content));
  }

  if (!apiKey) {
    throw new WebToolError(401, 'API Key 缺失或无效', 'invalid_request_error');
  }

  const url = resolveToolUrl(baseUrl, '/tools/search');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };

  const response = await transport(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    let message = `上游搜索请求失败（HTTP ${response.status}）`;
    try {
      const errJson = JSON.parse(errorText) as { error?: { message?: string } };
      if (errJson.error?.message) message = errJson.error.message;
    } catch {
      if (errorText) message = `${message}：${errorText.slice(0, 160)}`;
    }
    throw new WebToolError(response.status, message);
  }

  const json = (await response.json()) as WebSearchResult;
  return { results: Array.isArray(json.results) ? json.results : [] };
}

/** 执行网页抓取请求。 */
export async function executeWebFetch(
  transport: UpstreamTransport,
  options: {
    baseUrl: string;
    apiKey: string;
    params: WebFetchParams;
    mockUpstream?: boolean;
    signal?: AbortSignal;
  },
): Promise<WebFetchResult> {
  const { baseUrl, apiKey, params, mockUpstream, signal } = options;
  if (mockUpstream) {
    return generateMockFetchResult(params.url);
  }

  if (!apiKey) {
    throw new WebToolError(401, 'API Key 缺失或无效', 'invalid_request_error');
  }

  const url = resolveToolUrl(baseUrl, '/tools/fetch');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };

  const response = await transport(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    let message = `上游网页抓取失败（HTTP ${response.status}）`;
    try {
      const errJson = JSON.parse(errorText) as { error?: { message?: string } };
      if (errJson.error?.message) message = errJson.error.message;
    } catch {
      if (errorText) message = `${message}：${errorText.slice(0, 160)}`;
    }
    throw new WebToolError(response.status, message);
  }

  const json = (await response.json()) as WebFetchResult;
  return {
    title: typeof json.title === 'string' ? json.title : '',
    content: typeof json.content === 'string' ? json.content : '',
  };
}
