/**
 * 视频预览：把 1080p60 原片按需转成 720p30 的 MP4，给手机预览用。
 *
 * 背景：会话里生成的宣传片动辄 1080p60 / 18 MB / 2.6 Mbps，公网或手机弱网下
 * 播放会持续落后。图片已有 thumb/view 压缩，视频没有；这里补上同一层能力。
 *
 * - 只处理视频，输出 MP4（H.264 + AAC，faststart），支持 Range。
 * - 结果按「源路径 + 大小 + 修改时间」缓存在临时目录，源文件变了自然换 key。
 * - ffmpeg 不存在、转码失败、输出反而更大时返回 null，调用方回退原片。
 * - 转码参数固定，源路径只作为 argv 传入，不经 shell。
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type VideoSize = "preview";

export function videoPreviewParam(value: string | undefined | null): VideoSize | undefined {
  return value === "preview" ? "preview" : undefined;
}

export interface VideoPreviewFile {
  path: string;
  size: number;
  mtimeMs: number;
  mimeType: "video/mp4";
}

const CACHE_VERSION = "v1";
const MIN_SOURCE_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_FILES = 80;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const TRANSCODE_TIMEOUT_MS = 180_000;
const MAX_CONCURRENT_TRANSCODES = 2;

const cacheDir = (): string => process.env["PI_AGENT_VIDEO_PREVIEW_DIR"]?.trim() || join(tmpdir(), "pi-agent-video-previews");
const ffmpegBin = (): string => process.env["PI_AGENT_FFMPEG"]?.trim() || "ffmpeg";

let ffmpegState: "unknown" | "ok" | "missing" = "unknown";
const pending = new Map<string, Promise<VideoPreviewFile | null>>();
let runningTranscodes = 0;
const transcodeWaiters: Array<() => void> = [];

async function acquireTranscodeSlot(): Promise<() => void> {
  if (runningTranscodes < MAX_CONCURRENT_TRANSCODES) runningTranscodes++;
  else await new Promise<void>((resolve) => transcodeWaiters.push(resolve));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = transcodeWaiters.shift();
    // 直接把名额交给下一个等待者，runningTranscodes 不变；没人等才归还。
    if (next) next(); else runningTranscodes--;
  };
}

function cacheKey(sourcePath: string, size: number, mtimeMs: number): string {
  return createHash("sha256").update(`${CACHE_VERSION}|${sourcePath}|${size}|${Math.floor(mtimeMs)}`).digest("hex");
}

async function ffmpegAvailable(): Promise<boolean> {
  if (ffmpegState !== "unknown") return ffmpegState === "ok";
  ffmpegState = await new Promise<"ok" | "missing">((resolve) => {
    execFile(ffmpegBin(), ["-version"], { timeout: 5000, maxBuffer: 256 * 1024 }, (error) => resolve(error ? "missing" : "ok"));
  });
  return ffmpegState === "ok";
}

/**
 * 720p30 / 约 1.5 Mbps 上限。缩放只缩不放，长边不超过 1280，宽高取偶数。
 * 30fps 对 128 BPM 的宣传片已经足够；60fps 留给原始 master。
 */
async function transcode(sourcePath: string, outputPath: string): Promise<boolean> {
  const args = [
    "-nostdin", "-y", "-loglevel", "error",
    "-i", sourcePath,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
    "-maxrate", "1500k", "-bufsize", "3000k",
    "-profile:v", "high", "-level", "3.1", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-ac", "2",
    "-sn", "-dn", "-map_metadata", "-1",
    "-movflags", "+faststart",
    "-f", "mp4",
    outputPath
  ];
  return await new Promise<boolean>((resolve) => {
    execFile(ffmpegBin(), args, { timeout: TRANSCODE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error) => resolve(!error));
  });
}

async function cachedFile(key: string): Promise<VideoPreviewFile | null> {
  const path = join(cacheDir(), `${key}.mp4`);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return null;
    return { path, size: info.size, mtimeMs: info.mtimeMs, mimeType: "video/mp4" };
  } catch {
    return null;
  }
}

let pruning = false;
/** 简单 LRU：保留最近的 80 个、总量不超过 512 MB；不阻塞响应。 */
async function pruneCache(): Promise<void> {
  if (pruning) return;
  pruning = true;
  try {
    const names = (await readdir(cacheDir())).filter((name) => name.endsWith(".mp4"));
    const files = (await Promise.all(names.map(async (name) => {
      const path = join(cacheDir(), name);
      try { const info = await stat(path); return { path, size: info.size, mtimeMs: info.mtimeMs }; }
      catch { return null; }
    }))).filter((file): file is { path: string; size: number; mtimeMs: number } => !!file);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = new Set<string>();
    let total = 0;
    for (const file of files) {
      if (keep.size < MAX_CACHE_FILES && total + file.size <= MAX_CACHE_BYTES) {
        keep.add(file.path);
        total += file.size;
      }
    }
    await Promise.all(files.filter((file) => !keep.has(file.path)).map((file) => unlink(file.path).catch(() => {})));
  } catch { /* 清理是尽力而为，不影响这次预览 */ }
  finally {
    pruning = false;
  }
}

/**
 * 生成（或复用）720p30 预览。`sourcePath` 必须已经过调用方的越权/符号链接检查。
 * 返回 null 表示应回退原片。
 */
export async function makeVideoPreview(sourcePath: string, sourceSize: number, sourceMtimeMs: number): Promise<VideoPreviewFile | null> {
  if (!Number.isSafeInteger(sourceSize) || sourceSize < MIN_SOURCE_BYTES || sourceSize > MAX_SOURCE_BYTES) return null;
  if (!(await ffmpegAvailable())) return null;

  const key = cacheKey(sourcePath, sourceSize, sourceMtimeMs);
  const hit = await cachedFile(key);
  if (hit) return hit;

  const running = pending.get(key);
  if (running) return running;

  const job = (async (): Promise<VideoPreviewFile | null> => {
    const dir = cacheDir();
    let tmpPath: string | undefined;
    let release: (() => void) | undefined;
    try {
      await mkdir(dir, { recursive: true });
      const finalPath = join(dir, `${key}.mp4`);
      tmpPath = `${finalPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      release = await acquireTranscodeSlot();
      if (!(await transcode(sourcePath, tmpPath))) return null;
      const out = await stat(tmpPath);
      // 输出没有变小就不值得替换原片（例如源本来就是 720p30）。
      if (!out.isFile() || out.size === 0 || out.size >= sourceSize) return null;
      await rename(tmpPath, finalPath);
      tmpPath = undefined;
      void pruneCache();
      return { path: finalPath, size: out.size, mtimeMs: out.mtimeMs, mimeType: "video/mp4" };
    } catch {
      return null;
    } finally {
      if (tmpPath) await unlink(tmpPath).catch(() => {});
      release?.();
    }
  })();

  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}

/** 测试/维护用：清空缓存并重置 ffmpeg 探测。 */
export async function clearVideoPreviewCache(): Promise<void> {
  pending.clear();
  ffmpegState = "unknown";
  await rm(cacheDir(), { recursive: true, force: true }).catch(() => {});
}
