/**
 * §7 用量口径：
 *  - 只有带单请求 ID 的 delta 才求和；同 scope 的累计快照取最新值，不相加
 *  - 缺失是 unknown，不是 0
 *  - 子 Agent 单独列出，不再累计进父会话
 */
import { createHash } from "node:crypto";
import type { UsageRecord, UsageSummary } from "./types.js";

type Totals = UsageSummary["totals"];
const FIELDS = ["input", "cachedInput", "cacheCreation", "output", "reasoningOutput", "total"] as const;

function add(into: Totals, r: UsageRecord): void {
  for (const f of FIELDS) {
    const v = r[f];
    if (typeof v === "number") into[f] = (into[f] ?? 0) + v;
  }
}

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const notes: string[] = [];
  if (!records.length) return { coverage: "unknown", semantics: "没有采集到用量记录（显示为未知，不是 0）", totals: {}, byModel: [], notes: ["runtime 尚未报告用量"] };

  const main = records.filter((r) => !r.subagent);
  const sub = records.filter((r) => r.subagent);

  // 1) 会话累计快照（Codex）：取最新一份
  const snapshots = main.filter((r) => r.usageScope === "session" && r.counterMode === "cumulative").sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
  // 2) 单请求 delta（Claude）：按 requestId 去重后求和
  const deltas = new Map<string, UsageRecord>();
  let unkeyed = 0;
  for (const r of main) {
    if (r.counterMode !== "delta") continue;
    if (!r.requestId) { unkeyed++; continue; }
    deltas.set(r.requestId, r);
  }
  // 3) 每轮结束记录（Claude result）：只用于核对，或在没有单请求记录时兜底
  const turnTotals = main.filter((r) => r.usageScope === "turn" && r.counterMode === "cumulative");

  const totals: Totals = {};
  const byModel = new Map<string, { model: string; input?: number; output?: number; cachedInput?: number; cacheCreation?: number }>();
  let coverage: UsageSummary["coverage"] = "complete";
  let semantics = "";
  let sampledAt: string | undefined;
  let sourceRef: string | undefined;
  let requestCount: number | undefined;

  if (snapshots.length) {
    const last = snapshots[snapshots.length - 1]!;
    add(totals, last);
    // 累计快照也可以携带累计请求数（Codex）：取最新一份带计数的快照
    const counted = [...snapshots].reverse().find((s) => typeof s.requestCount === "number");
    if (counted) requestCount = counted.requestCount;
    semantics = last.semantics;
    sampledAt = last.sampledAt;
    sourceRef = last.sourceRef;
    coverage = last.reliability === "complete" ? "complete" : "partial";
    if (snapshots.length > 1) notes.push(`收到 ${snapshots.length} 份累计快照，取最新一份（不相加）`);
  } else if (deltas.size) {
    for (const r of deltas.values()) {
      add(totals, r);
      if (r.model) {
        const m = byModel.get(r.model) ?? { model: r.model };
        for (const f of ["input", "output", "cachedInput", "cacheCreation"] as const) if (typeof r[f] === "number") m[f] = (m[f] ?? 0) + r[f]!;
        byModel.set(r.model, m);
      }
      if (!sampledAt || r.sampledAt > sampledAt) sampledAt = r.sampledAt;
    }
    requestCount = [...deltas.values()].reduce((n, r) => n + usageCalls(r), 0);
    semantics = [...deltas.values()][0]!.semantics;
    sourceRef = `按 message.id 去重的 ${requestCount} 次请求`;
    if (unkeyed) { coverage = "partial"; notes.push(`${unkeyed} 条记录没有请求 ID，未计入`); }
    if (turnTotals.length) {
      const fromTurns: Totals = {};
      for (const t of turnTotals) add(fromTurns, t);
      const diff = (fromTurns.output ?? 0) - (totals.output ?? 0);
      if (Math.abs(diff) > 0 && (fromTurns.output ?? 0) > 0) notes.push(`各轮结束记录的输出合计 ${fromTurns.output}，单请求合计 ${totals.output ?? 0}：以单请求为准（结束记录可能含子 Agent 或重试）`);
    }
  } else if (turnTotals.length) {
    for (const t of turnTotals) add(totals, t);
    coverage = "partial";
    semantics = turnTotals[0]!.semantics;
    sourceRef = `${turnTotals.length} 轮结束记录相加（每轮独立，不含历史前缀）`;
    notes.push("没有单请求记录，用每轮结束记录兜底");
    sampledAt = turnTotals.map((t) => t.sampledAt).sort().pop();
  } else {
    coverage = "unknown";
    semantics = "记录缺少可求和的口径";
  }

  const summary: UsageSummary = {
    coverage, semantics, totals, byModel: [...byModel.values()],
    ...(requestCount !== undefined ? { requestCount } : {}),
    ...(sampledAt ? { sampledAt } : {}), ...(sourceRef ? { sourceRef } : {}), notes
  };
  if (sub.length) {
    const st: Totals = {};
    const seen = new Set<string>();
    for (const r of sub) {
      const k = r.requestId ?? r.sourceRef;
      if (seen.has(k)) continue;
      seen.add(k);
      if (r.counterMode === "delta") add(st, r);
    }
    summary.subagentTotals = { ...(st.input !== undefined ? { input: st.input } : {}), ...(st.output !== undefined ? { output: st.output } : {}) };
    notes.push("子 Agent 用量单独列出，未计入本会话合计");
  }
  return summary;
}

/** 按日汇总：只用带请求时间的可归属记录；只有会话总量的来源不分到"今天" */
export function dailyUsage(records: UsageRecord[], timeZone: string): { days: Array<{ day: string; input: number; output: number }>; unattributed: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const days = new Map<string, { input: number; output: number }>();
  let unattributed = 0;
  const seen = new Set<string>();
  for (const r of records) {
    if (r.subagent) continue;
    if (r.counterMode !== "delta" || !r.requestId) { unattributed++; continue; }
    if (seen.has(r.requestId)) continue;
    seen.add(r.requestId);
    const at = usageTime(r);
    if (at === undefined) { unattributed++; continue; }
    const d = fmt.format(new Date(at));
    const cur = days.get(d) ?? { input: 0, output: 0 };
    cur.input += r.input ?? 0; cur.output += r.output ?? 0;
    days.set(d, cur);
  }
  return { days: [...days.entries()].sort().map(([day, v]) => ({ day, ...v })), unattributed };
}

/* ------------------------------ 归档压缩 ------------------------------ */

/** 一条记录代表的请求数：压缩后的合计行是多次请求，其余是一次。 */
export function usageCalls(r: UsageRecord): number { return r.aggregate?.calls ?? 1; }

/** 记录身份：与 RuntimeStore.addUsage 的去重口径一致（有 requestId 按它，否则按来源 + 子 Agent）。 */
export function usageIdentity(r: UsageRecord): string {
  return `${r.usageScope}|${r.counterMode}|${r.requestId ? `id:${r.requestId}` : `src:${r.sourceRef}|${r.subagent ?? ""}`}`;
}
/** 身份的短指纹（11 位 base64url，约 66 位熵），存在合计行里供回补去重。 */
export function usageFingerprint(r: UsageRecord): string {
  return createHash("sha256").update(usageIdentity(r)).digest("base64url").slice(0, 11);
}

const MIN_SANE_MS = Date.UTC(2020, 0, 1);
/** 一次请求发生的时间：Pi 的 requestId 末尾带消息时间戳（最准），其次 occurredAt，最后 sampledAt。 */
export function usageTime(r: UsageRecord): number | undefined {
  // 合计行：用它所在小时的中点（整点时区下落在正确的那一天）
  if (r.aggregate) { const ms = Date.parse(r.aggregate.hour); if (Number.isFinite(ms)) return ms + 1_800_000; }
  const fromId = /:assistant:(\d{12,13})$/.exec(r.requestId ?? "");
  if (fromId) { const ms = Number(fromId[1]); if (ms >= MIN_SANE_MS && ms <= Date.now() + 86_400_000) return ms; }
  for (const text of [r.occurredAt, r.sampledAt]) {
    const ms = text ? Date.parse(text) : NaN;
    if (Number.isFinite(ms) && ms >= MIN_SANE_MS) return ms;
  }
  return undefined;
}

const RELIABILITY = ["unknown", "partial", "complete"] as const;
const isFoldableDelta = (r: UsageRecord) => !r.aggregate && r.counterMode === "delta" && !!r.requestId;
const isTurnTotal = (r: UsageRecord) => r.usageScope === "turn" && r.counterMode === "cumulative";

/** 这组记录压缩后会不会变：有还没合并的单请求，或者已有合计行时还留着每轮结束记录。 */
export function usageNeedsCompaction(records: UsageRecord[]): boolean {
  const hasRows = records.some((r) => r.aggregate);
  return records.some((r) => isFoldableDelta(r) || (hasRows && isTurnTotal(r)));
}

/**
 * 归档会话的用量压缩：带 requestId 的单请求 delta 按（UTC 小时 × 模型 × 子 Agent）加成一行合计。
 * 按小时而不是按天：页面按查看者的时区分天，整点时区下小时桶总能落到正确的那一天。
 * - 已有合计行原样并入（重复归档时可再次压缩）
 * - 有单请求数据时，每轮结束记录只用于核对，丢弃并记下指纹；没有单请求时保留（它是唯一来源）
 * - 会话累计快照（Codex）和没有 requestId 的记录原样保留
 */
export function compactUsage(records: UsageRecord[]): UsageRecord[] {
  // 同身份只留最后一条（与 addUsage 的覆盖语义一致）
  const latest = new Map<string, UsageRecord>();
  for (const r of records) latest.set(r.aggregate ? `agg|${r.requestId}` : usageIdentity(r), r);
  const rows = new Map<string, UsageRecord>();
  for (const r of latest.values()) if (r.aggregate) rows.set(r.requestId!, structuredClone(r));
  const hasDeltas = rows.size > 0 || [...latest.values()].some(isFoldableDelta);
  const keep: UsageRecord[] = [], extraFolded: string[] = [];
  for (const r of latest.values()) {
    if (r.aggregate) continue;
    if (isFoldableDelta(r)) {
      const at = usageTime(r) ?? Date.now();
      const start = Math.floor(at / 3_600_000) * 3_600_000, hour = new Date(start).toISOString().slice(0, 13) + ":00Z";
      // 保留旧桶分组以兼容已压缩数据；按日统计通过 usageTime 读取小时桶。
      const timed = !!r.occurredAt;
      const key = `agg:${hour}|${r.model ?? ""}|${r.subagent ?? ""}${timed ? "" : "|untimed"}`;
      let row = rows.get(key);
      if (!row) {
        row = { usageScope: "request", counterMode: "delta", ...(r.model ? { model: r.model } : {}), raw: {}, semantics: r.semantics, sourceRef: key, requestId: key,
          sampledAt: r.sampledAt, ...(timed ? { occurredAt: new Date(start + 1_800_000).toISOString() } : {}), reliability: r.reliability, ...(r.subagent ? { subagent: r.subagent } : {}),
          aggregate: { hour, calls: 0, folded: [] } };
        rows.set(key, row);
      }
      for (const f of ["input", "cachedInput", "cacheCreation", "output", "reasoningOutput", "total"] as const) if (typeof r[f] === "number") row[f] = (row[f] ?? 0) + r[f]!;
      for (const [k, v] of Object.entries(r.raw ?? {})) if (typeof v === "number") row.raw[k] = (row.raw[k] ?? 0) + v;
      if (r.sampledAt > row.sampledAt) row.sampledAt = r.sampledAt;
      if (RELIABILITY.indexOf(r.reliability) < RELIABILITY.indexOf(row.reliability)) row.reliability = r.reliability;
      row.aggregate!.calls++; row.aggregate!.folded.push(usageFingerprint(r));
    } else if (hasDeltas && isTurnTotal(r)) extraFolded.push(usageFingerprint(r));
    else keep.push(r);
  }
  const sorted = [...rows.values()].sort((a, b) => a.aggregate!.hour.localeCompare(b.aggregate!.hour) || a.requestId!.localeCompare(b.requestId!));
  if (extraFolded.length && sorted.length) sorted[sorted.length - 1]!.aggregate!.folded.push(...extraFolded);
  return [...keep, ...sorted];
}
