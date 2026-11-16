/**
 * 消息里的图片按需压缩：缩略图（消息内嵌）与查看图（放大查看器）都转成 WebP，
 * 公网访问时不再整张传原图（截图、生成图动辄数 MB）。原图仍可通过不带 size 的地址读取。
 *
 * - 只处理位图（PNG / JPEG / WebP）；GIF（可能是动图）、SVG 原样返回。
 * - 压缩后反而更大时返回原图。
 * - 结果按「来源键 + 尺寸档位」放在内存 LRU 里，同一张图不重复编码。
 */
import sharp from "sharp";

export type ImageSize = "thumb" | "view";
const BOUNDS: Record<ImageSize, { side: number; quality: number }> = {
  // 内嵌缩略图：消息里最宽约 480 CSS 像素，按 2 倍屏取 960
  thumb: { side: 960, quality: 74 },
  // 放大查看：长边 2560，放大几倍仍清楚；需要像素级细节时查看器里可切原图
  view: { side: 2560, quality: 82 },
};
const COMPRESSIBLE = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_INPUT_PIXELS = 40_000_000;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

export function imageSizeParam(value: string | undefined | null): ImageSize | undefined {
  return value === "thumb" || value === "view" ? value : undefined;
}

export interface CompressedImage { bytes: Buffer; mimeType: string; compressed: boolean; originalBytes: number }
const cache = new Map<string, CompressedImage>();
let cacheBytes = 0;
const pending = new Map<string, Promise<CompressedImage>>();
function remember(key: string, value: CompressedImage) {
  if (value.bytes.length > CACHE_MAX_BYTES / 4) return;
  cache.set(key, value);
  cacheBytes += value.bytes.length;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(k);
    cacheBytes -= v.bytes.length;
  }
}

/**
 * 压缩一张图。`key` 必须能区分文件版本（例如路径 + 修改时间 + 大小），否则会拿到旧缓存。
 * `load` 只在缓存未命中时调用。解码失败时返回原图，不让预览因此变成错误。
 */
export async function compressImage(key: string, mimeType: string, size: ImageSize, load: () => Promise<Buffer> | Buffer): Promise<CompressedImage> {
  if (!COMPRESSIBLE.has(mimeType)) { const bytes = await load(); return { bytes, mimeType, compressed: false, originalBytes: bytes.length }; }
  const cacheKey = `${size}|${key}`;
  const hit = cache.get(cacheKey);
  if (hit) { cache.delete(cacheKey); cache.set(cacheKey, hit); return hit; }
  const running = pending.get(cacheKey);
  if (running) return running;
  const job = (async () => {
    const original = await load();
    const { side, quality } = BOUNDS[size];
    try {
      const bytes = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize(side, side, { fit: "inside", withoutEnlargement: true })
        .webp({ quality, effort: 3 })
        .toBuffer();
      const result: CompressedImage = bytes.length < original.length
        ? { bytes, mimeType: "image/webp", compressed: true, originalBytes: original.length }
        : { bytes: original, mimeType, compressed: false, originalBytes: original.length };
      remember(cacheKey, result);
      return result;
    } catch {
      return { bytes: original, mimeType, compressed: false, originalBytes: original.length };
    }
  })();
  pending.set(cacheKey, job);
  try { return await job; } finally { pending.delete(cacheKey); }
}

/**
 * 响应头：告诉查看器这张图是不是压缩版、原图多大（查看器据此在文件名旁标「已压缩 · WebP 94 KB · 原图 1.2 MB」）。
 * 文件名仍是原文件名（.png 等），所以不能只看名字判断有没有压缩。
 */
export function compressedImageHeaders(out: CompressedImage): Record<string, string> {
  return { "X-Image-Compressed": out.compressed ? "1" : "0", "X-Image-Original-Bytes": String(out.originalBytes) };
}

/** 测试用 */
export function clearImageCache() { cache.clear(); cacheBytes = 0; }
