/**
 * 生图媒体存储与模型识别辅助：
 * - 安全保存 / 读取网关生成的图片（测试与无落盘环境走内存，运行期落盘到 data/generated-images）
 * - 严格校验文件名，防止路径穿越
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ImageOutputFormat = 'png' | 'jpeg' | 'webp';

const SAFE_FILENAME_RE = /^[a-f0-9-]+\.(png|jpe?g|webp)$/i;
const IMAGE_MODEL_RE = /(gpt-image|dall-e|imagen|flux|seedream|wanx|cogview|sdxl|stable-diffusion)/i;

export function isImageGenerationModel(model: string): boolean {
  return IMAGE_MODEL_RE.test((model ?? '').trim());
}

export function isValidImageFilename(filename: string): boolean {
  return SAFE_FILENAME_RE.test(filename);
}

export function mimeTypeForImageFormat(ext: string): string {
  const lower = ext.toLowerCase();
  if (lower === 'jpg' || lower === 'jpeg') return 'image/jpeg';
  if (lower === 'webp') return 'image/webp';
  return 'image/png';
}

export function publicImageUrl(filename: string, publicOrigin?: string): string {
  const rel = `/v1/images/files/${filename}`;
  if (!publicOrigin || publicOrigin.trim() === '') return rel;
  return `${publicOrigin.replace(/\/+$/, '')}${rel}`;
}

export class MediaStore {
  private readonly memory = new Map<string, { data: Buffer; mimeType: string }>();

  constructor(private readonly storageDir: string | null) {
    if (storageDir) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
  }

  saveBase64(
    b64: string,
    format: ImageOutputFormat = 'png',
  ): { filename: string; mimeType: string; size: number } {
    const clean = b64.replace(/^data:image\/[a-z0-9+.-]+;base64,/i, '').trim();
    const buf = Buffer.from(clean, 'base64');
    if (buf.length === 0) {
      throw new Error('上游返回的图像 base64 数据为空');
    }
    const ext = format === 'jpeg' ? 'jpg' : format;
    const filename = `${randomUUID()}.${ext}`;
    const mimeType = mimeTypeForImageFormat(ext);

    if (this.storageDir) {
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(path.join(this.storageDir, filename), buf, { mode: 0o644 });
    } else {
      this.memory.set(filename, { data: buf, mimeType });
    }
    return { filename, mimeType, size: buf.length };
  }

  read(filename: string): { data: Buffer; mimeType: string } | null {
    if (!isValidImageFilename(filename)) return null;
    const ext = path.extname(filename).slice(1);
    const mimeType = mimeTypeForImageFormat(ext);
    if (this.storageDir) {
      const target = path.join(this.storageDir, filename);
      if (!fs.existsSync(target)) return null;
      return { data: fs.readFileSync(target), mimeType };
    }
    return this.memory.get(filename) ?? null;
  }
}

export function normalizeImageResponsePayload(
  rawJson: Record<string, unknown>,
  mediaStore: MediaStore,
  options: { outputFormat?: unknown; publicOrigin?: string; onError?: (err: unknown) => void } = {},
): { payload: Record<string, unknown>; savedUrls: string[] } {
  const rawFormat = String(options.outputFormat ?? 'png').toLowerCase();
  const format: ImageOutputFormat =
    rawFormat === 'jpeg' || rawFormat === 'jpg'
      ? 'jpeg'
      : rawFormat === 'webp'
        ? 'webp'
        : 'png';

  const items: unknown[] = Array.isArray(rawJson.data) ? rawJson.data : [];
  const savedUrls: string[] = [];
  const normalizedItems = items.map((entry): unknown => {
    if (!entry || typeof entry !== 'object') return entry;
    const item = entry as Record<string, unknown>;
    if (typeof item.b64_json === 'string' && item.b64_json.trim() !== '') {
      try {
        const saved = mediaStore.saveBase64(item.b64_json, format);
        const localUrl = publicImageUrl(saved.filename, options.publicOrigin);
        savedUrls.push(localUrl);
        return {
          ...item,
          url: typeof item.url === 'string' && item.url !== '' ? item.url : localUrl,
          local_url: localUrl,
        };
      } catch (err) {
        options.onError?.(err);
        return item;
      }
    }
    if (typeof item.url === 'string' && item.url !== '') {
      savedUrls.push(item.url);
    }
    return item;
  });

  return {
    payload: { ...rawJson, data: normalizedItems },
    savedUrls,
  };
}
