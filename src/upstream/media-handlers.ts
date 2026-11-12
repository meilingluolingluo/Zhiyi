/**
 * 生图与会话标题生成公共执行器：
 * 供 `/v1/*` 兼容路由、`/v1/personal-ai/*` 路由、OpenClaw 工具与运行时复用，避免重复实现。
 */
import type { Request as ExpressRequest } from 'express';
import type { AppConfig } from '../config';
import type { Logger } from '../logger';
import type { UpstreamTransport } from '../types';
import { normalizeImageResponsePayload, type MediaStore } from './media-store';
import { endpointUrl } from './model-settings';
import {
  buildUpstreamRequestForRoute,
  resolveOneApiRoute,
  resolveUpstreamModelId,
  translateUpstreamResponse,
} from './oneapi-protocol';
import {
  buildFallbackTitle,
  extractTitleSourceText,
  sanitizeGeneratedTitle,
  type ImageGenerationResult,
  type TitleGenerationInput,
  type TitleGenerationResult,
  type UpstreamService,
} from './service';

export interface MediaHandlerDeps {
  config: AppConfig;
  transport: UpstreamTransport;
  logger: Logger;
  mediaStore: MediaStore;
  upstream?: UpstreamService;
}

export function requestPublicOrigin(req: ExpressRequest): string | undefined {
  const host = req.get('host');
  if (!host || host.trim() === '') return undefined;
  const proto = req.protocol || 'http';
  return `${proto}://${host}`;
}

export async function executeImageGeneration(
  deps: MediaHandlerDeps,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; publicOrigin?: string } = {},
): Promise<ImageGenerationResult> {
  if (deps.upstream) {
    return deps.upstream.generateImages(body, options);
  }

  const requestedModel =
    typeof body.model === 'string' && body.model.trim() !== ''
      ? body.model.trim()
      : 'gpt-image-2';
  const upstreamModel = resolveUpstreamModelId(deps.config.upstreamBaseUrl, requestedModel);
  const url = endpointUrl(deps.config.upstreamBaseUrl, '/v1/images/generations');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!deps.config.mockUpstream && deps.config.upstreamApiKey !== '') {
    headers.authorization = `Bearer ${deps.config.upstreamApiKey}`;
  }

  const response = await deps.transport(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, model: upstreamModel }),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch((): string => '');
    return {
      ok: false,
      status: response.status,
      model: upstreamModel,
      payload: {},
      savedUrls: [],
      errorText,
    };
  }

  const rawJson = (await response.json()) as Record<string, unknown>;
  const normalized = normalizeImageResponsePayload(rawJson, deps.mediaStore, {
    outputFormat: body.output_format,
    publicOrigin: options.publicOrigin,
  });

  return {
    ok: true,
    status: response.status,
    model: upstreamModel,
    payload: normalized.payload,
    savedUrls: normalized.savedUrls,
  };
}

export async function executeTitleGeneration(
  deps: Pick<MediaHandlerDeps, 'config' | 'transport' | 'upstream'>,
  input: TitleGenerationInput,
): Promise<TitleGenerationResult> {
  if (deps.upstream) {
    return deps.upstream.generateTitle(input);
  }

  const maxLen = Math.min(Math.max(4, input.maxLength ?? 20), 60);
  const targetModel = input.model?.trim() || deps.config.defaultModel;
  const promptText = extractTitleSourceText(input);
  const fallbackTitle = buildFallbackTitle(promptText, maxLen);
  if (promptText === '' && (!input.assistantReply || input.assistantReply.trim() === '')) {
    return { title: fallbackTitle, model: targetModel, fallback: true };
  }

  const userContext = [
    promptText ? `用户消息：${promptText.slice(0, 600)}` : '',
    input.assistantReply ? `助手回复：${input.assistantReply.slice(0, 800)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const route = resolveOneApiRoute(deps.config.upstreamBaseUrl, targetModel, 'auto');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (!deps.config.mockUpstream && deps.config.upstreamApiKey !== '') {
      headers.authorization = `Bearer ${deps.config.upstreamApiKey}`;
    }
    const built = buildUpstreamRequestForRoute(
      route,
      {
        model: targetModel,
        messages: [
          {
            role: 'system',
            content:
              `你是对话标题提炼助手。请根据对话内容生成一个简洁、直观的标题（不超过 ${maxLen} 个字），` +
              '保持与用户输入相同的语言，只输出标题本身，不要加引号、书名号、序号或句末标点。',
          },
          { role: 'user', content: userContext },
        ],
        stream: false,
        temperature: 0.2,
        max_tokens: 48,
      },
      headers,
    );
    const raw = await deps.transport(built.url, {
      method: 'POST',
      headers: built.headers,
      body: built.body,
      signal: input.signal ?? AbortSignal.timeout(8_000),
    });
    const translated = await translateUpstreamResponse(route.protocol, raw, {
      requestedModel: route.upstreamModel,
      wantsStream: false,
    });
    if (!translated.ok) {
      return { title: fallbackTitle, model: targetModel, fallback: true };
    }
    const data = (await translated.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const cleaned = sanitizeGeneratedTitle(data.choices?.[0]?.message?.content ?? '', maxLen);
    if (cleaned === '') {
      return { title: fallbackTitle, model: targetModel, fallback: true };
    }
    return { title: cleaned, model: targetModel, fallback: false };
  } catch {
    return { title: fallbackTitle, model: targetModel, fallback: true };
  }
}
