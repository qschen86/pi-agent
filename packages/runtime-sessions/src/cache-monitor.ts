/**
 * 上下文缓存日常监控（热续聊跨回合首调）：
 * - 只盯「第 >= 2 轮、上轮上下文 >= 30k、同模型未压缩、距上轮结束在热窗内」的跨回合首调，
 *   避免被单轮内多步工具调用的整轮平均值掩盖（漏报），也避免把空闲超时自然过期当成故障（误报）。
 * - 每轮记录发给驱动的前缀指纹（roleInstructions + MCP 稳定参数）：
 *   1) 同版本内指纹自己飘了 → 直接抓出漂移字段；
 *   2) 跨版本（代码/CLI 升级）指纹有意变更 → 视为老会话首次正常重建，不误报；
 *   3) 指纹未变但热续聊掉缓存（含蓝绿切槽后）→ 立即按规则告警。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserAccess } from "./platform-browser.js";
import type { RuntimeKind, SessionBinding, TurnCacheStats, UsageRecord } from "./types.js";
import { RUNTIME_KINDS, RUNTIME_LABEL } from "./types.js";
import { usageTime } from "./usage.js";

const MINUTE = 60_000;
const DAY = 86_400_000;

/** 纳入监控与热续聊统计的最小上轮上下文（太短时系统提示与最小块下限波动大，没成本风险） */
export const CACHE_MONITOR_MIN_CONTEXT_TOKENS = 30_000;
/** 单次重度掉底线：首调命中率低于此值且浪费 >= 30k tokens，单次即告警 */
export const CACHE_MONITOR_SEVERE_HIT_RATE = 0.30;
export const CACHE_MONITOR_SEVERE_WASTED_TOKENS = 30_000;
/** 轻度退化连续触发次数：同一版本下连续 2 次低于各 runtime 基线触发告警 */
export const CACHE_MONITOR_DEGRADED_STREAK = 2;
/** 样本文件保留天数（用于近 7 天展示与后续校准 TTL 留存曲线） */
const SAMPLE_RETENTION_DAYS = 30;
const MAX_STATE_SESSIONS = 400;

/**
 * 各 runtime「肯定还热」的监控热窗（下界）：
 * - Claude Code：硬 1 小时 TTL（实测 30–60 分钟 100% 命中）→ 取 50 分钟
 * - Pi / DeepSeek、Codex、Antigravity：无硬 TTL 承诺，5 分钟内实测接近 100% 稳定 → 取 5 分钟
 */
export function cacheWarmWindowMs(kind: RuntimeKind, _model?: string): number {
  return kind === "claude-code" ? 50 * MINUTE : 5 * MINUTE;
}

/** 各 runtime 热续聊首调的正常基线下限（Antigravity 受 Gemini 2,048-token 尾块回退下限约束，略低 5%） */
export function cacheExpectedMinHitRate(kind: RuntimeKind): number {
  return kind === "antigravity" ? 0.80 : 0.85;
}

export interface PrefixFingerprint {
  /** roleHash + mcpHash 的合并哈希：同一会话跨回合不变才算前缀稳定 */
  combined: string;
  roleHash: string;
  mcpHash: string;
  /** 仅记录无敏感信息的参数摘要（用于告警时直接指出哪个参数在飘） */
  mcpSummary: string;
  roleLength: number;
  platformSha: string;
  cliVersion: string;
  model: string;
}

const sha = (s: string, len = 12): string => createHash("sha256").update(s).digest("hex").slice(0, len);

/**
 * 计算发给驱动的稳定前缀指纹：
 * 按各驱动实际传给底层 CLI/SDK 的 MCP 参数取稳定部分，让「蓝绿切槽改写 current/ 别名」和「固定 pointerPath」体现为同一指纹。
 */
export function computePrefixFingerprint(input: {
  runtimeKind: RuntimeKind;
  roleInstructions?: string;
  platformBrowser?: BrowserAccess;
  readOnlyRoom?: boolean;
  model?: string;
  platformSha?: string;
  cliVersion?: string;
}): PrefixFingerprint {
  const role = input.roleInstructions ?? "";
  const roleHash = sha(role, 12);
  let mcpSummary = "none";
  if (input.platformBrowser && !input.readOnlyRoom) {
    const pb = input.platformBrowser;
    // Antigravity 传 pointerPath（固定每会话）；其余驱动如若后续改传 pointerPath 也会体现在此
    const arg = input.runtimeKind === "antigravity" ? (pb.pointerPath ?? pb.socketPath) : pb.bridgePath;
    mcpSummary = `${pb.bridgePath}|${arg}`;
  }
  const mcpHash = sha(mcpSummary, 12);
  const combined = sha(`${roleHash}|${mcpHash}`, 16);
  return {
    combined,
    roleHash,
    mcpHash,
    mcpSummary,
    roleLength: role.length,
    platformSha: input.platformSha ?? "unknown",
    cliVersion: input.cliVersion ?? "unknown",
    model: input.model ?? "unknown"
  };
}

export function diffPrefixFields(prev: PrefixFingerprint, cur: PrefixFingerprint): string[] {
  const changed: string[] = [];
  if (prev.roleHash !== cur.roleHash) changed.push(`roleInstructions (${prev.roleLength}→${cur.roleLength} chars)`);
  if (prev.mcpHash !== cur.mcpHash) changed.push(`mcpServers (${prev.mcpSummary} → ${cur.mcpSummary})`);
  return changed;
}

export type CacheSampleSource =
  | "request-first"
  | "antigravity-db"
  | "antigravity-fallback"
  | "codex-turn-delta"
  | "claude-native"
  | "pi-native";

export type CacheSeverity = "ok" | "degraded" | "severe" | "skipped";

export interface CacheMonitorSample {
  at: string;
  platformSessionId: string;
  nativeSessionId?: string;
  sessionTitle?: string;
  runtimeKind: RuntimeKind;
  model: string;
  turnNo: number;
  idleMs: number;
  warmWindowMs: number;
  warm: boolean;
  prevContextTokens: number;
  firstCallTotalIn: number;
  firstCallCachedIn: number;
  firstCallUncachedIn: number;
  hitRate: number;
  wastedTokens: number;
  expectedMinHitRate: number;
  source: CacheSampleSource;
  prefixChanged: boolean;
  prefixChangedFields: string[];
  sameVersionPrefixDrift: boolean;
  expectedRebuild: boolean;
  platformSha: string;
  cliVersion: string;
  severity: CacheSeverity;
  skipReason?: string;
}

export type CacheAlertReason = "severe-drop" | "degraded-streak" | "prefix-drift";

export interface CacheAlertEvent {
  dedupKey: string;
  reason: CacheAlertReason;
  runtimeKind: RuntimeKind;
  model: string;
  platformSha: string;
  cliVersion: string;
  expectedMinHitRate: number;
  warmWindowMs: number;
  sample: CacheMonitorSample;
  recentSamples: CacheMonitorSample[];
}

/* ------------------------------ Antigravity 原生 DB 首步解析 ------------------------------ */

let sqliteModule: typeof import("node:sqlite") | undefined;
const sqlite = (): typeof import("node:sqlite") => (sqliteModule ??= createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite"));

interface ProtoNode { f: number; w: number; v?: number; sub?: ProtoNode[] }

function decodeProto(buf: Uint8Array, depth = 0): ProtoNode[] | null {
  const out: ProtoNode[] = [];
  let i = 0;
  while (i < buf.length) {
    let tag = 0n, shift = 0n;
    while (i < buf.length) {
      const b = buf[i++]!;
      tag |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
      if (shift > 63n) return null;
    }
    const f = Number(tag >> 3n), w = Number(tag & 7n);
    if (w === 0) {
      let val = 0n; shift = 0n;
      while (i < buf.length) {
        const b = buf[i++]!;
        val |= BigInt(b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7n;
        if (shift > 63n) return null;
      }
      out.push({ f, w, v: val <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(val) : Number.MAX_SAFE_INTEGER });
    } else if (w === 1) {
      i += 8;
      if (i > buf.length) return null;
    } else if (w === 2) {
      let len = 0n; shift = 0n;
      while (i < buf.length) {
        const b = buf[i++]!;
        len |= BigInt(b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7n;
        if (shift > 63n) return null;
      }
      const n = Number(len);
      if (n < 0 || i + n > buf.length) return null;
      const slice = buf.subarray(i, i + n);
      i += n;
      const sub = depth < 2 && n > 0 && n < 64_000 ? decodeProto(slice, depth + 1) : null;
      out.push({ f, w, ...(sub && sub.length ? { sub } : {}) });
    } else if (w === 5) {
      i += 4;
      if (i > buf.length) return null;
    } else return null;
  }
  return out;
}

const protoField = (nodes: ProtoNode[] | undefined, f: number): ProtoNode | undefined => nodes?.find((n) => n.f === f);

export interface AntigravityStepUsage {
  stepIdx: number;
  atMs: number;
  uncachedIn: number;
  cachedIn: number;
  totalIn: number;
}

export interface AntigravityTurnBoundary {
  turnNo: number;
  userStepIdx: number;
  atMs: number;
  prevTurnEndMs?: number;
  prevContextTokens?: number;
  firstCall: AntigravityStepUsage;
}

/**
 * 从 Antigravity 原生 SQLite 库读取每一轮（step_type=14 后的第一个 step_type=15）的精确首调 token 用量。
 * 只读打开并立即关闭，绝不写入也不影响 agy 进程。
 */
export function readAntigravityTurnBoundaries(
  nativeSessionId: string,
  antigravityDataDir = join(homedir(), ".gemini", "antigravity-cli")
): AntigravityTurnBoundary[] {
  if (!/^[A-Za-z0-9_-]+$/.test(nativeSessionId)) return [];
  const dbPath = join(antigravityDataDir, "conversations", `${nativeSessionId}.db`);
  if (!existsSync(dbPath)) return [];
  let db: InstanceType<ReturnType<typeof sqlite>["DatabaseSync"]> | undefined;
  try {
    db = new (sqlite().DatabaseSync)(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT idx, step_type, metadata FROM steps WHERE step_type IN (14, 15) ORDER BY idx ASC").all() as Array<{ idx: number; step_type: number; metadata: Uint8Array | null }>;
    const out: AntigravityTurnBoundary[] = [];
    let turnNo = 0;
    let curTurn: { turnNo: number; userStepIdx: number; atMs: number; captured: boolean; prevTurnEndMs?: number; prevContextTokens?: number } | undefined;
    let lastEndMs: number | undefined;
    let lastCtx: number | undefined;
    for (const r of rows) {
      if (!r.metadata || !(r.metadata instanceof Uint8Array)) continue;
      const dec = decodeProto(r.metadata);
      if (!dec) continue;
      const tsSec = protoField(protoField(dec, 1)?.sub, 1)?.v;
      const atMs = tsSec && tsSec > 1_000_000_000 ? tsSec * 1000 : 0;
      if (r.step_type === 14) {
        turnNo++;
        curTurn = { turnNo, userStepIdx: r.idx, atMs, captured: false, ...(lastEndMs !== undefined ? { prevTurnEndMs: lastEndMs } : {}), ...(lastCtx !== undefined ? { prevContextTokens: lastCtx } : {}) };
      } else if (r.step_type === 15) {
        const u = protoField(dec, 9)?.sub;
        if (!u) continue;
        const uncachedIn = protoField(u, 2)?.v ?? 0;
        const cachedIn = protoField(u, 5)?.v ?? 0;
        const totalIn = uncachedIn + cachedIn;
        if (totalIn <= 0) continue;
        const endSec = protoField(protoField(dec, 7)?.sub, 1)?.v;
        const endMs = endSec && endSec > 1_000_000_000 ? endSec * 1000 : atMs;
        if (curTurn && !curTurn.captured) {
          curTurn.captured = true;
          out.push({
            turnNo: curTurn.turnNo,
            userStepIdx: curTurn.userStepIdx,
            atMs: curTurn.atMs || atMs,
            ...(curTurn.prevTurnEndMs !== undefined ? { prevTurnEndMs: curTurn.prevTurnEndMs } : {}),
            ...(curTurn.prevContextTokens !== undefined ? { prevContextTokens: curTurn.prevContextTokens } : {}),
            firstCall: { stepIdx: r.idx, atMs, uncachedIn, cachedIn, totalIn }
          });
        }
        if (endMs) lastEndMs = endMs;
        lastCtx = totalIn;
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 构造一条最简 Antigravity protobuf 元数据（供单测构造离线 DB 使用，不依赖真实 agy）。 */
export function encodeAntigravityStepMetadataForTest(input: { tsSec: number; endSec?: number; uncachedIn?: number; cachedIn?: number }): Uint8Array {
  const varint = (n: number): number[] => {
    const out: number[] = [];
    let x = BigInt(Math.max(0, Math.floor(n)));
    do { let b = Number(x & 0x7fn); x >>= 7n; if (x > 0n) b |= 0x80; out.push(b); } while (x > 0n);
    return out;
  };
  const fieldVarint = (f: number, v: number): number[] => [...varint((f << 3) | 0), ...varint(v)];
  const fieldBytes = (f: number, bytes: number[]): number[] => [...varint((f << 3) | 2), ...varint(bytes.length), ...bytes];
  const bytes: number[] = [...fieldBytes(1, fieldVarint(1, input.tsSec))];
  if (input.endSec !== undefined) bytes.push(...fieldBytes(7, fieldVarint(1, input.endSec)));
  if (input.uncachedIn !== undefined || input.cachedIn !== undefined) {
    const usage: number[] = [];
    if (input.uncachedIn) usage.push(...fieldVarint(2, input.uncachedIn));
    if (input.cachedIn) usage.push(...fieldVarint(5, input.cachedIn));
    bytes.push(...fieldBytes(9, usage));
  }
  return Uint8Array.from(bytes);
}

/* ------------------------------ 单轮缓存评估 ------------------------------ */

export interface TurnCacheMeasurementInput {
  platformSessionId: string;
  nativeSessionId?: string;
  sessionTitle?: string;
  runtimeKind: RuntimeKind;
  model: string;
  prevModel?: string;
  turnNo: number;
  turnStartedAtMs: number;
  turnEndedAtMs: number;
  prevTurnEndedAtMs?: number;
  prevContextTokens?: number;
  prevPrefix?: PrefixFingerprint;
  prefix: PrefixFingerprint;
  /** 本轮新增的 UsageRecord 列表（按时间顺序） */
  turnUsageRecords: UsageRecord[];
  /** Codex 专用：本轮开始前与结束后的累计输入/缓存输入快照 */
  codexBefore?: { input: number; cachedInput: number };
  codexAfter?: { input: number; cachedInput: number };
  /** 本轮是否检测到上下文压缩/截断 */
  compactDetected?: boolean;
  antigravityDataDir?: string;
}

function measureFirstCall(input: TurnCacheMeasurementInput): { totalIn: number; cachedIn: number; uncachedIn: number; source: CacheSampleSource } | undefined {
  if (input.runtimeKind === "pi" || input.runtimeKind === "claude-code") {
    const reqs = input.turnUsageRecords
      .filter((r) => !r.subagent && !r.aggregate && r.usageScope === "request" && r.counterMode === "delta")
      .sort((a, b) => (usageTime(a) ?? 0) - (usageTime(b) ?? 0));
    const first = reqs.find((r) => ((r.input ?? 0) + (r.cachedInput ?? 0) + (r.cacheCreation ?? 0)) >= 10_000);
    if (!first) return undefined;
    const cachedIn = first.cachedInput ?? 0;
    const uncachedIn = (first.input ?? 0) + (first.cacheCreation ?? 0);
    const totalIn = cachedIn + uncachedIn;
    return totalIn > 0 ? { totalIn, cachedIn, uncachedIn, source: "request-first" } : undefined;
  }
  if (input.runtimeKind === "antigravity") {
    if (input.nativeSessionId) {
      const boundaries = readAntigravityTurnBoundaries(input.nativeSessionId, input.antigravityDataDir);
      // 优先按 turnNo 匹配，否则取最后一个 boundary（防止重连/重试导致 step_type=14 序号偏移）
      const hit = boundaries.find((b) => b.turnNo === input.turnNo) ?? boundaries.at(-1);
      if (hit && hit.firstCall.totalIn > 0) {
        return { totalIn: hit.firstCall.totalIn, cachedIn: hit.firstCall.cachedIn, uncachedIn: hit.firstCall.uncachedIn, source: "antigravity-db" };
      }
    }
    // 兜底：原生库不可读时，用本轮 ACP usage 汇总判断首调是否打穿
    const rec = input.turnUsageRecords.find((r) => !r.subagent && (r.input !== undefined || r.cachedInput !== undefined));
    const prevCtx = input.prevContextTokens ?? 0;
    if (!rec || prevCtx <= 0) return undefined;
    const turnUncached = rec.input ?? 0;
    if (turnUncached >= prevCtx * 0.85) {
      // 整轮未缓存输入几乎等同或超过整个上轮上下文 → 首调大概率打穿
      const estTotal = Math.max(prevCtx, turnUncached);
      return { totalIn: estTotal, cachedIn: 0, uncachedIn: estTotal, source: "antigravity-fallback" };
    }
    // 正常命中时给出保守下界（turnUncached 含后续所有步骤，因此首调命中率至少不低于此）
    const estTotal = prevCtx + Math.max(0, turnUncached);
    const estCached = Math.max(0, prevCtx - turnUncached);
    return { totalIn: estTotal, cachedIn: estCached, uncachedIn: estTotal - estCached, source: "antigravity-fallback" };
  }
  if (input.runtimeKind === "codex" && input.codexBefore && input.codexAfter) {
    const dIn = input.codexAfter.input - input.codexBefore.input;
    const dCached = input.codexAfter.cachedInput - input.codexBefore.cachedInput;
    if (dIn <= 0) return undefined;
    const clampedCached = Math.max(0, Math.min(dIn, dCached));
    return { totalIn: dIn, cachedIn: clampedCached, uncachedIn: dIn - clampedCached, source: "codex-turn-delta" };
  }
  return undefined;
}

export function evaluateTurnCache(input: TurnCacheMeasurementInput): CacheMonitorSample | undefined {
  if (input.turnNo < 2) return undefined;
  const prevCtx = input.prevContextTokens ?? 0;
  if (prevCtx < CACHE_MONITOR_MIN_CONTEXT_TOKENS) return undefined;
  if (input.prevTurnEndedAtMs === undefined) return undefined;
  const idleMs = Math.max(0, input.turnStartedAtMs - input.prevTurnEndedAtMs);
  const warmWindowMs = cacheWarmWindowMs(input.runtimeKind, input.model);
  const warm = idleMs <= warmWindowMs;
  const expectedMin = cacheExpectedMinHitRate(input.runtimeKind);
  const measured = measureFirstCall(input);
  if (!measured || measured.totalIn <= 0) return undefined;

  const hitRate = measured.cachedIn / measured.totalIn;
  const wastedTokens = Math.max(0, Math.min(prevCtx, measured.uncachedIn));
  const prefixChangedFields = input.prevPrefix ? diffPrefixFields(input.prevPrefix, input.prefix) : [];
  const prefixChanged = prefixChangedFields.length > 0;
  const versionChanged = !!input.prevPrefix && (
    input.prevPrefix.platformSha !== input.prefix.platformSha ||
    input.prevPrefix.cliVersion !== input.prefix.cliVersion
  );
  const sameVersionPrefixDrift = prefixChanged && !versionChanged;
  const expectedRebuild = prefixChanged && versionChanged;
  const modelChanged = !!input.prevModel && input.prevModel !== input.model;
  // 若本轮首调总输入远小于上轮上下文（< 60%），说明底层发生了自动上下文压缩/截断
  const compacted = input.compactDetected === true || (measured.source !== "codex-turn-delta" && measured.totalIn < prevCtx * 0.60);

  let severity: CacheSeverity = "ok";
  let skipReason: string | undefined;
  if (!warm) {
    severity = "skipped";
    skipReason = "idle-beyond-warm-window";
  } else if (modelChanged) {
    severity = "skipped";
    skipReason = "model-changed";
  } else if (compacted) {
    severity = "skipped";
    skipReason = "context-compacted";
  } else if (expectedRebuild) {
    severity = "skipped";
    skipReason = "expected-version-prefix-change";
  } else if (hitRate < CACHE_MONITOR_SEVERE_HIT_RATE && wastedTokens >= CACHE_MONITOR_SEVERE_WASTED_TOKENS) {
    severity = "severe";
  } else if (hitRate < expectedMin) {
    severity = "degraded";
  }

  return {
    at: new Date(input.turnEndedAtMs).toISOString(),
    platformSessionId: input.platformSessionId,
    ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    ...(input.sessionTitle ? { sessionTitle: input.sessionTitle } : {}),
    runtimeKind: input.runtimeKind,
    model: input.model,
    turnNo: input.turnNo,
    idleMs,
    warmWindowMs,
    warm,
    prevContextTokens: prevCtx,
    firstCallTotalIn: measured.totalIn,
    firstCallCachedIn: measured.cachedIn,
    firstCallUncachedIn: measured.uncachedIn,
    hitRate,
    wastedTokens,
    expectedMinHitRate: expectedMin,
    source: measured.source,
    prefixChanged,
    prefixChangedFields,
    sameVersionPrefixDrift,
    expectedRebuild,
    platformSha: input.prefix.platformSha,
    cliVersion: input.prefix.cliVersion,
    severity,
    ...(skipReason ? { skipReason } : {})
  };
}

function fmtCachePct(r: number): string {
  return `${(Math.max(0, Math.min(1, r)) * 100).toFixed(1)}%`;
}

function fmtCacheTokens(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, "")} 亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, "")} 万`;
  return String(Math.round(n));
}

function fmtCacheGap(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
}

function measureTurnTotal(input: TurnCacheMeasurementInput): { hitRate: number; cachedIn: number; totalIn: number } | undefined {
  if (input.runtimeKind === "codex" && input.codexBefore && input.codexAfter) {
    const totalIn = input.codexAfter.input - input.codexBefore.input;
    const rawCached = input.codexAfter.cachedInput - input.codexBefore.cachedInput;
    if (totalIn <= 0) return undefined;
    const cachedIn = Math.max(0, Math.min(totalIn, rawCached));
    return { hitRate: cachedIn / totalIn, cachedIn, totalIn };
  }
  const recs = input.turnUsageRecords.filter((r) => !r.subagent && !r.aggregate);
  if (!recs.length) return undefined;
  let cachedIn = 0, totalIn = 0;
  for (const r of recs) {
    if (r.counterMode !== "delta") continue;
    const c = r.cachedInput ?? 0;
    const t = (r.input ?? 0) + c + (r.cacheCreation ?? 0);
    if (t > 0) { cachedIn += c; totalIn += t; }
  }
  return totalIn > 0 ? { hitRate: cachedIn / totalIn, cachedIn, totalIn } : undefined;
}

const SKIP_LABEL: Record<string, string> = {
  "idle-beyond-warm-window": "超出热窗（自然冷缓存）",
  "model-changed": "已切换模型",
  "context-compacted": "本轮发生上下文压缩",
  "expected-version-prefix-change": "发版/升级导致前缀变更（预期重建）",
  "first-turn": "首轮冷启动",
  "context-small": "上轮上下文不足 3 万，不计热续聊基线"
};

/**
 * 组装挂在「本轮完成」系统行上的缓存命中率摘要与展开明细（不进模型上下文）。
 */
export function buildTurnCacheStats(input: TurnCacheMeasurementInput, sample?: CacheMonitorSample): TurnCacheStats | undefined {
  const turnTotal = measureTurnTotal(input);
  if (sample) {
    const pct = fmtCachePct(sample.hitRate);
    const basePct = `${Math.round(sample.expectedMinHitRate * 100)}%`;
    const tone: TurnCacheStats["tone"] = sample.severity === "severe"
      ? "bad"
      : sample.severity === "degraded"
        ? "warn"
        : sample.severity === "ok"
          ? "ok"
          : "neutral";
    const suffix = sample.severity === "severe"
      ? " · 异常"
      : sample.severity === "degraded"
        ? " · 偏低"
        : sample.skipReason === "idle-beyond-warm-window"
          ? " · 已冷"
          : sample.skipReason === "context-compacted"
            ? " · 压缩"
            : sample.skipReason === "expected-version-prefix-change"
              ? " · 重建"
              : "";
    const badgeLabel = `缓存 ${pct}${suffix}`;
    const lines = [
      `本轮首调：${pct}（命中 ${fmtCacheTokens(sample.firstCallCachedIn)} / 总输入 ${fmtCacheTokens(sample.firstCallTotalIn)} tokens）`
    ];
    if (turnTotal) {
      lines.push(`本轮整轮：${fmtCachePct(turnTotal.hitRate)}（命中 ${fmtCacheTokens(turnTotal.cachedIn)} / 总输入 ${fmtCacheTokens(turnTotal.totalIn)} tokens）`);
    }
    const statusDesc = sample.severity === "ok"
      ? `达标（基线 ≥${basePct}）`
      : sample.severity === "severe"
        ? `严重掉底（基线 ≥${basePct}，多算约 ${fmtCacheTokens(sample.wastedTokens)} tokens）`
        : sample.severity === "degraded"
          ? `低于基线 ${basePct}（多算约 ${fmtCacheTokens(sample.wastedTokens)} tokens）`
          : (sample.skipReason ? SKIP_LABEL[sample.skipReason] ?? sample.skipReason : "跳过监控");
    lines.push(`续聊间隔：${fmtCacheGap(sample.idleMs)}（热窗 ${Math.round(sample.warmWindowMs / MINUTE)} 分钟 · 上轮 ${fmtCacheTokens(sample.prevContextTokens)} · ${statusDesc}）`);
    lines.push(sample.prefixChangedFields.length
      ? `前缀指纹：${sample.sameVersionPrefixDrift ? "同版本内漂移" : "跨版本变化"}（${sample.prefixChangedFields.join("；")}）`
      : "前缀指纹：系统提示与 MCP 参数未变化");

    const summary = turnTotal
      ? `首调 ${pct}${suffix} · 整轮 ${fmtCachePct(turnTotal.hitRate)}`
      : `首调 ${pct}${suffix}`;
    return {
      primaryRate: sample.hitRate,
      primaryKind: "first-call",
      tone,
      badgeLabel,
      firstCall: {
        hitRate: sample.hitRate,
        cachedIn: sample.firstCallCachedIn,
        totalIn: sample.firstCallTotalIn,
        uncachedIn: sample.firstCallUncachedIn,
        source: sample.source
      },
      ...(turnTotal ? { turnTotal } : {}),
      warm: sample.warm,
      idleMs: sample.idleMs,
      warmWindowMs: sample.warmWindowMs,
      prevContextTokens: sample.prevContextTokens,
      expectedMinHitRate: sample.expectedMinHitRate,
      severity: sample.severity,
      ...(sample.skipReason ? { skipReason: sample.skipReason } : {}),
      prefixChanged: sample.prefixChanged,
      ...(sample.prefixChangedFields.length ? { prefixChangedFields: sample.prefixChangedFields } : {}),
      summary,
      detail: lines.join("\n")
    };
  }

  if (!turnTotal) return undefined;
  const pct = fmtCachePct(turnTotal.hitRate);
  const skipReason = input.turnNo <= 1 ? "first-turn" : "context-small";
  const reasonText = SKIP_LABEL[skipReason]!;
  return {
    primaryRate: turnTotal.hitRate,
    primaryKind: "turn",
    tone: "neutral",
    badgeLabel: skipReason === "first-turn" ? `缓存 ${pct} · 首轮` : `缓存 ${pct}`,
    turnTotal,
    severity: "skipped",
    skipReason,
    summary: `本轮 ${pct}（${reasonText}）`,
    detail: [
      `本轮合计：${pct}（命中 ${fmtCacheTokens(turnTotal.cachedIn)} / 总输入 ${fmtCacheTokens(turnTotal.totalIn)} tokens）`,
      `口径说明：${reasonText}，第 ≥2 轮且上轮上下文 ≥3 万起按本轮首调校验`
    ].join("\n")
  };
}

/* ------------------------------ 持久化与告警状态 ------------------------------ */

export interface LastSessionCacheState {
  turnNo: number;
  endedAtMs: number;
  contextTokens: number;
  model: string;
  prefix: PrefixFingerprint;
}

interface CacheMonitorStateFile {
  version: 1;
  lastBySession: Record<string, LastSessionCacheState>;
  /** dedupKey -> 连续退化样本 */
  streaks: Record<string, CacheMonitorSample[]>;
}

const emptyState = (): CacheMonitorStateFile => ({ version: 1, lastBySession: {}, streaks: {} });

export class CacheMonitor {
  private readonly samplesFile: string;
  private readonly stateFile: string;
  private state: CacheMonitorStateFile;
  private onAlert?: (event: CacheAlertEvent) => void;

  constructor(private readonly dir: string, opts: { onAlert?: (event: CacheAlertEvent) => void } = {}) {
    mkdirSync(dir, { recursive: true });
    this.samplesFile = join(dir, "cache-monitor-samples.jsonl");
    this.stateFile = join(dir, "cache-monitor-state.json");
    this.onAlert = opts.onAlert;
    this.state = this.loadState();
  }

  setAlertHandler(fn: ((event: CacheAlertEvent) => void) | undefined): void {
    this.onAlert = fn;
  }

  lastSessionState(platformSessionId: string): LastSessionCacheState | undefined {
    return this.state.lastBySession[platformSessionId];
  }

  recordSessionEnd(platformSessionId: string, next: LastSessionCacheState): void {
    this.state.lastBySession[platformSessionId] = next;
    // 有界保留最近活跃会话，防止状态文件无限增长
    const keys = Object.keys(this.state.lastBySession);
    if (keys.length > MAX_STATE_SESSIONS) {
      const oldest = keys
        .sort((a, b) => (this.state.lastBySession[a]?.endedAtMs ?? 0) - (this.state.lastBySession[b]?.endedAtMs ?? 0))
        .slice(0, keys.length - MAX_STATE_SESSIONS);
      for (const k of oldest) delete this.state.lastBySession[k];
    }
    this.saveState();
  }

  /**
   * 评估并记录本轮缓存样本；达到告警条件时同步/异步通知 onAlert。
   * 返回生成的样本（第 1 轮或短上下文返回 undefined）。
   */
  observeTurn(input: TurnCacheMeasurementInput, nextContextTokens?: number): CacheMonitorSample | undefined {
    const sample = evaluateTurnCache(input);
    const ctx = nextContextTokens && nextContextTokens > 0 ? nextContextTokens : (sample ? sample.firstCallTotalIn : input.prevContextTokens ?? 0);
    if (ctx > 0) {
      this.recordSessionEnd(input.platformSessionId, {
        turnNo: input.turnNo,
        endedAtMs: input.turnEndedAtMs,
        contextTokens: ctx,
        model: input.model,
        prefix: input.prefix
      });
    }
    if (!sample) return undefined;
    this.appendSample(sample);

    if (sample.severity === "skipped") return sample;

    const baseKey = `${sample.runtimeKind}|${sample.platformSha}|${sample.cliVersion}`;
    if (sample.severity === "ok") {
      if (this.state.streaks[baseKey]?.length) {
        delete this.state.streaks[baseKey];
        this.saveState();
      }
      return sample;
    }

    const reason: CacheAlertReason = sample.sameVersionPrefixDrift
      ? "prefix-drift"
      : sample.severity === "severe"
        ? "severe-drop"
        : "degraded-streak";
    const dedupKey = `${sample.runtimeKind}|${reason}|${sample.platformSha}|${sample.cliVersion}`;

    if (reason === "degraded-streak") {
      const prev = this.state.streaks[baseKey] ?? [];
      const next = [...prev, sample].slice(-6);
      this.state.streaks[baseKey] = next;
      this.saveState();
      if (next.length < CACHE_MONITOR_DEGRADED_STREAK) return sample;
      this.emitAlert({
        dedupKey, reason, runtimeKind: sample.runtimeKind, model: sample.model,
        platformSha: sample.platformSha, cliVersion: sample.cliVersion,
        expectedMinHitRate: sample.expectedMinHitRate, warmWindowMs: sample.warmWindowMs,
        sample, recentSamples: next
      });
      return sample;
    }

    // 重度掉底或同版本前缀飘移：单次即触发告警
    const recent = [...(this.state.streaks[baseKey] ?? []), sample].slice(-6);
    this.state.streaks[baseKey] = recent;
    this.saveState();
    this.emitAlert({
      dedupKey, reason, runtimeKind: sample.runtimeKind, model: sample.model,
      platformSha: sample.platformSha, cliVersion: sample.cliVersion,
      expectedMinHitRate: sample.expectedMinHitRate, warmWindowMs: sample.warmWindowMs,
      sample, recentSamples: recent
    });
    return sample;
  }

  readSamples(sinceMs?: number): CacheMonitorSample[] {
    if (!existsSync(this.samplesFile)) return [];
    const out: CacheMonitorSample[] = [];
    try {
      const lines = readFileSync(this.samplesFile, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const s = JSON.parse(line) as CacheMonitorSample;
          if (!s || typeof s.hitRate !== "number") continue;
          if (sinceMs !== undefined && Date.parse(s.at) < sinceMs) continue;
          out.push(s);
        } catch { /* 跳过坏行 */ }
      }
    } catch { /* 读不到就返回空 */ }
    return out;
  }

  private emitAlert(event: CacheAlertEvent): void {
    try { this.onAlert?.(event); } catch { /* 告警处理器出错不影响主流程 */ }
  }

  private appendSample(sample: CacheMonitorSample): void {
    try {
      appendFileSync(this.samplesFile, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
      // 文件超过 1MB 时顺手裁掉 30 天前的旧样本
      const st = statSync(this.samplesFile);
      if (st.size > 1_000_000) {
        const cutoff = Date.now() - SAMPLE_RETENTION_DAYS * DAY;
        const kept = this.readSamples(cutoff).map((s) => JSON.stringify(s)).join("\n");
        const tmp = `${this.samplesFile}.tmp`;
        writeFileSync(tmp, kept ? `${kept}\n` : "", { mode: 0o600 });
        renameSync(tmp, this.samplesFile);
      }
    } catch { /* 采样写入失败不影响会话 */ }
  }

  private loadState(): CacheMonitorStateFile {
    if (!existsSync(this.stateFile)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<CacheMonitorStateFile>;
      return {
        version: 1,
        lastBySession: parsed.lastBySession && typeof parsed.lastBySession === "object" ? parsed.lastBySession : {},
        streaks: parsed.streaks && typeof parsed.streaks === "object" ? parsed.streaks : {}
      };
    } catch { return emptyState(); }
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, this.stateFile);
    } catch { /* 状态写入失败不阻塞主流程 */ }
  }
}

/* ------------------------------ 近 7 天热续聊首调命中率汇总 ------------------------------ */

export interface RuntimeCacheHealthRow {
  runtimeKind: RuntimeKind;
  label: string;
  warmWindowMinutes: number;
  baselineRate: number;
  sampleCount: number;
  /** 近 N 天热续聊首调加权命中率（sum(cached) / sum(totalIn)）；无样本时为 null */
  weightedHitRate: number | null;
  totalIn: number;
  cachedIn: number;
  wastedTokens: number;
  anomalyCount: number;
  status: "healthy" | "degraded" | "critical" | "no-data";
  lastSampleAt: string | null;
}

export interface CacheHealthSummary {
  days: number;
  generatedAt: string;
  runtimes: RuntimeCacheHealthRow[];
  notes: string[];
}

interface LightweightWarmSample {
  dedupId: string;
  atMs: number;
  runtimeKind: RuntimeKind;
  totalIn: number;
  cachedIn: number;
  wastedTokens: number;
  anomaly: boolean;
}

/**
 * 从已有历史记录补齐近 N 天热续聊首调样本（让功能上线首日就能看到真实数据，实时样本优先去重）。
 * 只读已绑定的平台会话，绝不扫描无关目录。
 */
function collectHistoricalWarmSamples(opts: {
  bindings: SessionBinding[];
  usage: Record<string, UsageRecord[]>;
  sinceMs: number;
  antigravityDataDir?: string;
  piSessionsDir?: string;
  claudeProjectsDir?: string;
}): LightweightWarmSample[] {
  const out: LightweightWarmSample[] = [];
  for (const b of opts.bindings) {
    if (b.evaluation) continue;
    const lastMs = Date.parse(b.lastActivityAt?.at ?? "");
    if (!Number.isFinite(lastMs) || lastMs < opts.sinceMs) continue;
    const turns = b.turns.filter((t) => t.startedAt && t.endedAt).sort((a, c) => a.turnNo - c.turnNo);
    if (turns.length < 2) continue;

    const warmMs = cacheWarmWindowMs(b.runtimeKind, b.effectiveModel ?? b.requestedModel);
    const minRate = cacheExpectedMinHitRate(b.runtimeKind);

    if (b.runtimeKind === "antigravity" && b.nativeSessionId) {
      const boundaries = readAntigravityTurnBoundaries(b.nativeSessionId, opts.antigravityDataDir);
      for (const bd of boundaries) {
        if (bd.turnNo < 2 || bd.prevTurnEndMs === undefined || !bd.prevContextTokens) continue;
        if (bd.atMs < opts.sinceMs) continue;
        if (bd.prevContextTokens < CACHE_MONITOR_MIN_CONTEXT_TOKENS) continue;
        const idleMs = Math.max(0, bd.atMs - bd.prevTurnEndMs);
        if (idleMs > warmMs) continue;
        if (bd.firstCall.totalIn < bd.prevContextTokens * 0.60) continue; // 排除压缩
        const hit = bd.firstCall.cachedIn / bd.firstCall.totalIn;
        const wasted = Math.max(0, Math.min(bd.prevContextTokens, bd.firstCall.uncachedIn));
        out.push({
          dedupId: `${b.platformSessionId}:${bd.turnNo}`,
          atMs: bd.atMs,
          runtimeKind: "antigravity",
          totalIn: bd.firstCall.totalIn,
          cachedIn: bd.firstCall.cachedIn,
          wastedTokens: wasted,
          anomaly: hit < minRate
        });
      }
      continue;
    }

    if (b.runtimeKind === "pi" || b.runtimeKind === "claude-code") {
      // 从 usage.json 中未聚合的逐请求记录提取跨回合首调；Pi 已归档被压成小时桶时，可回读 pi-sessions/<native>.jsonl
      let reqs: Array<{ t: number; totalIn: number; cachedIn: number; uncachedIn: number }> = (opts.usage[b.platformSessionId] ?? [])
        .filter((r) => !r.subagent && !r.aggregate && r.usageScope === "request" && r.counterMode === "delta")
        .map((r) => {
          const t = usageTime(r) ?? 0;
          const cachedIn = r.cachedInput ?? 0;
          const uncachedIn = (r.input ?? 0) + (r.cacheCreation ?? 0);
          return { t, totalIn: cachedIn + uncachedIn, cachedIn, uncachedIn };
        })
        .filter((r) => r.t > 0 && r.totalIn >= 10_000)
        .sort((a, c) => a.t - c.t);

      if (!reqs.length && b.runtimeKind === "pi" && opts.piSessionsDir && b.nativeSessionId) {
        reqs = readPiNativeRequests(opts.piSessionsDir, b.nativeSessionId);
      } else if (!reqs.length && b.runtimeKind === "claude-code" && b.nativeSessionId && b.workspace) {
        reqs = readClaudeNativeRequests(b.workspace, b.nativeSessionId, opts.claudeProjectsDir);
      }
      if (reqs.length < 2) continue;

      for (let i = 1; i < turns.length; i++) {
        const prevTurn = turns[i - 1]!;
        const curTurn = turns[i]!;
        const prevEnd = Date.parse(prevTurn.endedAt!);
        const curStart = Date.parse(curTurn.startedAt!);
        const curEnd = Date.parse(curTurn.endedAt!);
        if (!Number.isFinite(prevEnd) || !Number.isFinite(curStart) || !Number.isFinite(curEnd)) continue;
        if (curEnd < opts.sinceMs) continue;
        const idleMs = Math.max(0, curStart - prevEnd);
        if (idleMs > warmMs) continue;
        const prevLast = [...reqs].reverse().find((r) => r.t <= prevEnd + 2000);
        const curFirst = reqs.find((r) => r.t >= curStart - 2000 && r.t <= curEnd + 5000);
        if (!prevLast || !curFirst) continue;
        if (prevLast.totalIn < CACHE_MONITOR_MIN_CONTEXT_TOKENS) continue;
        if (curFirst.totalIn < prevLast.totalIn * 0.60) continue; // 排除压缩
        const hit = curFirst.cachedIn / curFirst.totalIn;
        const wasted = Math.max(0, Math.min(prevLast.totalIn, curFirst.uncachedIn));
        out.push({
          dedupId: `${b.platformSessionId}:${curTurn.turnNo}`,
          atMs: curFirst.t,
          runtimeKind: b.runtimeKind,
          totalIn: curFirst.totalIn,
          cachedIn: curFirst.cachedIn,
          wastedTokens: wasted,
          anomaly: hit < minRate
        });
      }
    }
  }
  return out;
}

function readPiNativeRequests(piSessionsDir: string, nativeSessionId: string): Array<{ t: number; totalIn: number; cachedIn: number; uncachedIn: number }> {
  if (!/^[A-Za-z0-9._-]+$/.test(nativeSessionId)) return [];
  const file = join(piSessionsDir, `${nativeSessionId}.jsonl`);
  if (!existsSync(file)) return [];
  const reqs: Array<{ t: number; totalIn: number; cachedIn: number; uncachedIn: number }> = [];
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { timestamp?: string; message?: { timestamp?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } }; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } };
        const u = o.message?.usage ?? o.usage;
        const t = Date.parse(o.timestamp ?? o.message?.timestamp ?? "");
        if (!u || !Number.isFinite(t)) continue;
        const cachedIn = u.cacheRead ?? 0;
        const uncachedIn = (u.input ?? 0) + (u.cacheWrite ?? 0);
        const totalIn = cachedIn + uncachedIn;
        if (totalIn >= 10_000) reqs.push({ t, totalIn, cachedIn, uncachedIn });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return reqs.sort((a, b) => a.t - b.t);
}

function readClaudeNativeRequests(
  workspace: string,
  nativeSessionId: string,
  claudeProjectsDir = join(homedir(), ".claude", "projects")
): Array<{ t: number; totalIn: number; cachedIn: number; uncachedIn: number }> {
  if (!/^[A-Za-z0-9._-]+$/.test(nativeSessionId)) return [];
  const encoded = workspace.replace(/[^A-Za-z0-9-]/g, "-");
  const file = join(claudeProjectsDir, encoded, `${nativeSessionId}.jsonl`);
  if (!existsSync(file)) return [];
  const reqs: Array<{ t: number; totalIn: number; cachedIn: number; uncachedIn: number }> = [];
  const seen = new Set<string>();
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as {
          timestamp?: string;
          message?: { id?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
        };
        const u = o.message?.usage;
        const id = o.message?.id;
        const t = Date.parse(o.timestamp ?? "");
        if (!u || !id || seen.has(id) || !Number.isFinite(t)) continue;
        seen.add(id);
        const cachedIn = u.cache_read_input_tokens ?? 0;
        const uncachedIn = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        const totalIn = cachedIn + uncachedIn;
        if (totalIn >= 10_000) reqs.push({ t, totalIn, cachedIn, uncachedIn });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return reqs.sort((a, b) => a.t - b.t);
}

export function summarizeCacheHealth(opts: {
  samples: CacheMonitorSample[];
  bindings?: SessionBinding[];
  usage?: Record<string, UsageRecord[]>;
  days?: number;
  now?: Date;
  antigravityDataDir?: string;
  piSessionsDir?: string;
  claudeProjectsDir?: string;
}): CacheHealthSummary {
  const days = Math.max(1, Math.min(30, opts.days ?? 7));
  const now = opts.now ?? new Date();
  const sinceMs = now.getTime() - days * DAY;

  const merged = new Map<string, LightweightWarmSample>();
  // 1) 实时监控样本（优先，含精确前缀判断与 Codex 增量）
  for (const s of opts.samples) {
    const atMs = Date.parse(s.at);
    if (!Number.isFinite(atMs) || atMs < sinceMs) continue;
    if (!s.warm || s.severity === "skipped") continue;
    const dedupId = `${s.platformSessionId}:${s.turnNo}`;
    merged.set(dedupId, {
      dedupId,
      atMs,
      runtimeKind: s.runtimeKind,
      totalIn: s.firstCallTotalIn,
      cachedIn: s.firstCallCachedIn,
      wastedTokens: s.wastedTokens,
      anomaly: s.severity === "degraded" || s.severity === "severe"
    });
  }
  // 2) 历史补齐样本（不覆盖实时样本）
  if (opts.bindings && opts.usage) {
    for (const h of collectHistoricalWarmSamples({
      bindings: opts.bindings, usage: opts.usage, sinceMs,
      ...(opts.antigravityDataDir ? { antigravityDataDir: opts.antigravityDataDir } : {}),
      ...(opts.piSessionsDir ? { piSessionsDir: opts.piSessionsDir } : {}),
      ...(opts.claudeProjectsDir ? { claudeProjectsDir: opts.claudeProjectsDir } : {})
    })) {
      if (!merged.has(h.dedupId)) merged.set(h.dedupId, h);
    }
  }

  const runtimes: RuntimeCacheHealthRow[] = RUNTIME_KINDS.map((kind) => {
    const items = [...merged.values()].filter((x) => x.runtimeKind === kind);
    const warmWindowMinutes = Math.round(cacheWarmWindowMs(kind) / MINUTE);
    const baselineRate = cacheExpectedMinHitRate(kind);
    if (!items.length) {
      return {
        runtimeKind: kind,
        label: RUNTIME_LABEL[kind],
        warmWindowMinutes,
        baselineRate,
        sampleCount: 0,
        weightedHitRate: null,
        totalIn: 0,
        cachedIn: 0,
        wastedTokens: 0,
        anomalyCount: 0,
        status: "no-data",
        lastSampleAt: null
      };
    }
    const totalIn = items.reduce((n, x) => n + x.totalIn, 0);
    const cachedIn = items.reduce((n, x) => n + x.cachedIn, 0);
    const wastedTokens = items.reduce((n, x) => n + x.wastedTokens, 0);
    const anomalyCount = items.filter((x) => x.anomaly).length;
    const weightedHitRate = totalIn > 0 ? cachedIn / totalIn : null;
    const latestMs = Math.max(...items.map((x) => x.atMs));
    const status: RuntimeCacheHealthRow["status"] = weightedHitRate === null
      ? "no-data"
      : weightedHitRate < 0.50
        ? "critical"
        : weightedHitRate < baselineRate
          ? "degraded"
          : "healthy";
    return {
      runtimeKind: kind,
      label: RUNTIME_LABEL[kind],
      warmWindowMinutes,
      baselineRate,
      sampleCount: items.length,
      weightedHitRate,
      totalIn,
      cachedIn,
      wastedTokens,
      anomalyCount,
      status,
      lastSampleAt: new Date(latestMs).toISOString()
    };
  });

  return {
    days,
    generatedAt: now.toISOString(),
    runtimes,
    notes: [
      "热续聊首调：仅统计第 ≥2 轮、上轮上下文 ≥30k、且距上轮结束在热窗内（Claude 50 分钟，其余 5 分钟）的首次模型调用命中率，不受单轮多步工具调用平均数掩盖。",
      "基线：Claude / Codex / Pi ≥85%，Antigravity ≥80%（受 Gemini 2,048-token 尾块回退下限约束）。"
    ]
  };
}
