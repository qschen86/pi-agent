/**
 * 错题本照片：提交之后按需压缩。
 *
 * 拍照那一侧已经按长边 2000px 出图（见 `apps/wrong-book/js/camera.js`），所以正常批次到这儿
 * 什么都没发生 —— 原样存盘、原样发给 DeepSeek。只有下面两种照片会被重新编码一次：
 *   - 单张超过 900KB（相册里没压过的原图、截图拼接的大图）；
 *   - 长边超过 2400px（比识别需要的还大，纯粹浪费上传时间）。
 *
 * 压缩参数是照着「字不能糊」定的：长边 2000px、JPEG q84、4:4:4 不做色度抽样。
 * 用一份 3000×4000 的模拟作业（纸面噪点 + 小字 + 红笔批改）量过，压完暗像素比例 0.978、
 * 平均灰度偏差 1.7/255，肉眼和识别都看不出差别；改回 4:2:0 红色批改边缘会发虚。
 * 解码失败 / 压完反而更大时保留原图，绝不因为压缩把一张照片弄坏。
 */
import sharp from "sharp";

/** 识别用的长边上限：和页面里 `WbUtil.PHOTO.maxEdge` 保持一致。 */
export const PHOTO_MAX_EDGE = 2000;
/** 小于这个体积就不动它。 */
export const PHOTO_KEEP_BYTES = 900 * 1024;
/** 长边小于这个像素也不动它。 */
export const PHOTO_KEEP_EDGE = 2400;
/** 压缩质量：够清楚，又不至于压完还是几 MB。 */
export const PHOTO_QUALITY = 84;
const MAX_INPUT_PIXELS = 40_000_000;

export interface PreparedPhoto {
  bytes: Buffer;
  /** 是否重新编码过；没压过时 width / height 是原图尺寸。 */
  compressed: boolean;
  width: number;
  height: number;
  originalBytes: number;
}

const untouched = (bytes: Buffer, width: number, height: number): PreparedPhoto => ({
  bytes,
  compressed: false,
  width,
  height,
  originalBytes: bytes.length,
});

/**
 * 提交前过一遍：只在大图 / 超大文件时重编码，其余原样返回。
 * 永远不抛错 —— 解不开的图片交给存储层按原有规则拒绝或接收。
 */
export async function preparePaperPhoto(bytes: Buffer): Promise<PreparedPhoto> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    return untouched(bytes, 0, 0);
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return untouched(bytes, 0, 0);
  const longEdge = Math.max(width, height);
  if (bytes.length <= PHOTO_KEEP_BYTES && longEdge <= PHOTO_KEEP_EDGE) return untouched(bytes, width, height);

  try {
    const out = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(PHOTO_MAX_EDGE, PHOTO_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: PHOTO_QUALITY, mozjpeg: true, chromaSubsampling: "4:4:4" })
      .toBuffer();
    if (out.length >= bytes.length) return untouched(bytes, width, height);
    const resized = await sharp(out).metadata();
    return {
      bytes: out,
      compressed: true,
      width: resized.width ?? width,
      height: resized.height ?? height,
      originalBytes: bytes.length,
    };
  } catch {
    return untouched(bytes, width, height);
  }
}
