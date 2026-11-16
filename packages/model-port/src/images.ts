/**
 * 随模型调用传入的图片（v2.6 WP1）：宿主按文件头识别真实格式、读出宽高，限制张数与尺寸。
 * 只认字节，不认调用方声称的类型——声称与实际不符即拒绝，不「修正」。
 */
import { createHash } from "node:crypto";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface ModelImage {
  mediaType: ImageMediaType;
  bytes: Uint8Array;
}

/** 核对后的图片信息：进调用身份与调用记录（不含字节）。 */
export interface ImageMeta {
  mediaType: ImageMediaType;
  width: number;
  height: number;
  bytes: number;
  hash: string;
}

/** 单次调用的图片上限（REQUIREMENTS 13.1；实施基线阶段按实测调整）。 */
export const IMAGE_LIMITS = { maxImages: 8, maxWidth: 1600, maxHeight: 900, maxBytes: 10 * 1024 * 1024 };

export type ImageLimits = typeof IMAGE_LIMITS;

const sha256 = (b: Uint8Array): string => `sha256:${createHash("sha256").update(b).digest("hex")}`;

/** 按文件头识别格式并读出宽高；认不出或结构不完整返回 undefined。 */
export function sniffImage(b: Uint8Array): { mediaType: ImageMediaType; width: number; height: number } | undefined {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  // PNG：8 字节签名 + IHDR（宽高在 16、20）
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString("ascii", 12, 16) === "IHDR") {
    return { mediaType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG：FFD8 起，逐段找 SOF 标记
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return undefined;
      const marker = buf[i + 1] as number;
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9) return undefined;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { mediaType: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return undefined;
  }
  // WebP：RIFF....WEBP + VP8 / VP8L / VP8X
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { mediaType: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { mediaType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { mediaType: "image/webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return undefined;
}

/**
 * 核对一组图片：格式与声称一致、张数与尺寸在上限内。不合格即抛错——
 * 缺图、错图、超限都不能退化成一次「没有图的纯文本调用」。
 */
export function checkImages(images: ModelImage[], limits = IMAGE_LIMITS): ImageMeta[] {
  if (images.length > limits.maxImages) throw new Error(`图片太多：${images.length} 张，单次上限 ${limits.maxImages} 张`);
  return images.map((img, i) => {
    const n = i + 1;
    if (!img || !(img.bytes instanceof Uint8Array) || img.bytes.byteLength === 0) throw new Error(`第 ${n} 张图片是空的`);
    if (img.bytes.byteLength > limits.maxBytes) throw new Error(`第 ${n} 张图片 ${img.bytes.byteLength} 字节，超过上限 ${limits.maxBytes}`);
    const sniffed = sniffImage(img.bytes);
    if (!sniffed) throw new Error(`第 ${n} 张图片不是可识别的 PNG / JPEG / WebP`);
    if (sniffed.mediaType !== img.mediaType) throw new Error(`第 ${n} 张图片声称 ${img.mediaType}，实际是 ${sniffed.mediaType}`);
    if (sniffed.width < 1 || sniffed.height < 1) throw new Error(`第 ${n} 张图片尺寸无效`);
    if (sniffed.width > limits.maxWidth || sniffed.height > limits.maxHeight) {
      throw new Error(`第 ${n} 张图片 ${sniffed.width}×${sniffed.height}，超过单张上限 ${limits.maxWidth}×${limits.maxHeight}`);
    }
    return { mediaType: sniffed.mediaType, width: sniffed.width, height: sniffed.height, bytes: img.bytes.byteLength, hash: sha256(img.bytes) };
  });
}

/** 图片进调用身份的部分：按顺序的类型与内容哈希。没有图片时为空串，调用身份与 v2.6 之前一致。 */
export function imageDigest(images: ImageMeta[]): string {
  return images.length ? `\n\nimages:${images.map((m) => `${m.mediaType}|${m.hash}`).join(",")}` : "";
}
