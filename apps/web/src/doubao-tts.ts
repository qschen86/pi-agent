/**
 * 豆包语音合成（火山引擎 seed-tts）：「外部资源」里的配音服务。
 *
 * 凭据与火山语音的新版控制台 API Key 是同一把（必想的 ASR 用的也是它），
 * 所以环境变量依次认 VOLCENGINE_TTS_API_KEY、VOLCENGINE_ASR_API_KEY，再认本机文件 .pi-agent/doubao-tts-api-key（权限必须是 0600）。
 * 调用只在服务端发起，密钥不进日志；每次合成只往平台调用日志写元数据（服务、能力、角色、模型、成败），不记文本。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ProviderCallLog } from "./resources.js";

export const DOUBAO_TTS_SERVICE = "voice:doubao";
export const DOUBAO_TTS_LABEL = "豆包语音合成";
export const DOUBAO_TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
export const DOUBAO_TTS_CONSOLE_URL = "https://console.volcengine.com/speech/new";
/** 默认模型（大模型语音合成 2.0）与默认配音音色（沉稳男声） */
export const DOUBAO_TTS_RESOURCE_ID = "seed-tts-2.0";
export const DOUBAO_TTS_DEFAULT_SPEAKER = "zh_male_m191_uranus_bigtts";

const DEFAULT_KEY_FILE = fileURLToPath(new URL("../../../.pi-agent/doubao-tts-api-key", import.meta.url));

export function resolveDoubaoTtsKey(
  env: NodeJS.ProcessEnv = process.env,
  keyFile = env["PI_AGENT_DOUBAO_TTS_KEY_FILE"] ?? DEFAULT_KEY_FILE
): { key: string; source: string } | undefined {
  for (const name of ["VOLCENGINE_TTS_API_KEY", "VOLCENGINE_ASR_API_KEY"]) {
    const v = env[name]?.trim();
    if (v) return { key: v, source: `env:${name}` };
  }
  if (!existsSync(keyFile)) return undefined;
  try {
    const st = statSync(keyFile);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return undefined;
    const key = readFileSync(keyFile, "utf8").trim();
    return key ? { key, source: "file" } : undefined;
  } catch {
    return undefined;
  }
}

export class DoubaoTtsError extends Error {
  constructor(readonly kind: "NO_KEY" | "HTTP" | "UPSTREAM" | "EMPTY" | "TIMEOUT" | "NETWORK", readonly status = 0) {
    super(`Doubao TTS ${kind.toLowerCase()} failure${status ? ` (${status})` : ""}`);
  }
}

export interface SynthesizeOptions {
  text: string;
  speaker?: string;
  /** seed-tts-2.0（默认）或 seed-tts-1.0 */
  resourceId?: string;
  format?: "mp3" | "wav" | "pcm" | "ogg_opus";
  sampleRate?: number;
  /** 语速，-50..100，0 为正常 */
  speechRate?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  key?: string;
  /** 传入则把这次调用的元数据记进平台调用日志，让「外部资源」页显示最近调用与本机用量 */
  callLog?: ProviderCallLog;
  /** 记进日志的调用方说明，例如 "宣传片配音" */
  role?: string;
}

/** 合成一段文本，返回音频字节。服务端流式返回多个 JSON 行，data 是 base64 的音频分片。 */
export async function synthesizeDoubao(opts: SynthesizeOptions): Promise<Buffer> {
  const resourceId = opts.resourceId ?? DOUBAO_TTS_RESOURCE_ID;
  const log = (ok: boolean, errorClass?: string) => opts.callLog?.append({
    at: new Date().toISOString(), service: DOUBAO_TTS_SERVICE, capability: "speech", role: opts.role ?? "voiceover",
    model: resourceId, ok, ...(errorClass ? { errorClass } : {})
  });
  const key = opts.key ?? resolveDoubaoTtsKey(opts.env)?.key;
  if (!key) { log(false, "NO_KEY"); throw new DoubaoTtsError("NO_KEY"); }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await (opts.fetch ?? fetch)(DOUBAO_TTS_URL, {
      method: "POST", signal: ctl.signal, redirect: "error",
      headers: { "X-Api-Key": key, "X-Api-Resource-Id": resourceId, "Content-Type": "application/json" },
      body: JSON.stringify({
        user: { uid: "pi-agent" },
        req_params: {
          text: opts.text, speaker: opts.speaker ?? DOUBAO_TTS_DEFAULT_SPEAKER,
          audio_params: { format: opts.format ?? "mp3", sample_rate: opts.sampleRate ?? 24000, speech_rate: opts.speechRate ?? 0 }
        }
      })
    });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new DoubaoTtsError("HTTP", res.status); }
    const chunks: Buffer[] = [];
    for (const line of (await res.text()).split("\n")) {
      if (!line.trim()) continue;
      let j: { code?: number; data?: string };
      try { j = JSON.parse(line); } catch { throw new DoubaoTtsError("UPSTREAM"); }
      if (j.code !== 0 && j.code !== 20000000) throw new DoubaoTtsError("UPSTREAM", j.code ?? 0);
      if (j.data) chunks.push(Buffer.from(j.data, "base64"));
    }
    if (!chunks.length) throw new DoubaoTtsError("EMPTY");
    log(true);
    return Buffer.concat(chunks);
  } catch (e) {
    const err = e instanceof DoubaoTtsError ? e : (e as Error).name === "AbortError" ? new DoubaoTtsError("TIMEOUT") : new DoubaoTtsError("NETWORK");
    log(false, err.kind);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
