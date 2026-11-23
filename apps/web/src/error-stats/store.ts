/**
 * 错误统计的持久层：一个 JSON 文件（<dataDir>/diagnostics/error-stats/state.json），原子写。
 * - cursors：每个事件文件 / 部署日志 / 审计日志读到哪（增量入库，不重扫）
 * - buckets：按「北京日期 → runtime|指纹」的次数、会话、最近一次与样例
 * - seen：事件去重键（同一条事件被重读不会重复计数），按时间淘汰
 * - merges：DeepSeek 归并结果（被归并指纹 → 代表指纹）
 * - todos：每个代表指纹已经建过的待办（只建一次，关闭后要有新证据才再提醒）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beijingDateKey } from "../platform-time.js";
import type { ErrorKind, Occurrence, StatsRuntime } from "./normalize.js";

export const WINDOW_DAYS = 30;
const KEEP_DAYS = 45;
const DAY_MS = 86_400_000;

export interface Bucket { n: number; sessions: string[]; last: number; sample: string; kind: ErrorKind }
export interface TodoRecord {
  noteId: string; rule: "cross-runtime" | "memory-single" | "gate-flaky"; createdAt: string; updatedAt: string;
  runtimes: string[]; total: number; textHash: string;
  /** 这条待办的正文里已经带了 AI 评估 */
  assessed?: boolean;
  /** 待办被关闭（完成 / 删除）的时刻；之后只有新证据才再提醒 */
  closedAt?: string;
}
/** DeepSeek（推理 high）带上下文做的「值不值得做」评估；do 且把握不是 low 才建待办。 */
export interface Assessment {
  coveredBy?: string;
  at: string; verdict: "do" | "skip" | "unsure"; confidence: "high" | "medium" | "low";
  title: string; reason: string; rootCause: string; impact: string; proposal: string[]; benefit: string; cost: string; risk: string; acceptance: string[];
  /** 评估时的次数与 runtime 数：之后次数翻倍 / 新 runtime 加入 / 超过 14 天才重新评估 */
  total: number; runtimes: number; costUsd: number; model?: string;
}
export interface MergeLogEntry { at: string; canonical: string; members: string[]; reason: string }
export type RunTrigger = "schedule" | "catch-up" | "manual";
export type RunStatus = "running" | "ok" | "failed" | "interrupted";
export interface RunRecord {
  id: string; trigger: RunTrigger; status: RunStatus;
  date: string; startedAt: string; finishedAt?: string;
  /** 本次新入库的报错条数，及按类别拆分 */
  added: number; byKind: Record<ErrorKind, number>;
  /** DeepSeek 本次归并掉的指纹数 */
  merged: number; costUsd: number;
  /** 本次新建的待办（id 与标题）；created 只留 id，兼容早先的记录 */
  created: string[]; createdTodos: Array<{ noteId: string; title: string }>;
  /** 满足条件但因每晚上限顺延的候选数（含还没评估的） */
  deferred: number;
  /** 本轮 DeepSeek 评估：评估了几个、值得做几个，以及没建待办的原因（历史页展开可看） */
  assessed?: number; worth?: number;
  assessments?: Array<{ title: string; verdict: Assessment["verdict"]; confidence: Assessment["confidence"]; reason: string; noteId?: string }>;
  note?: string;
}
export interface State {
  version: 1;
  cursors: { events: Record<string, { offset: number; size: number }>; deploy: { offset: number }; audit: { offset: number }; flaky?: { offset: number } };
  buckets: Record<string, Record<string, Bucket>>;
  seen: Record<string, number>;
  merges: Record<string, string>;
  reviewed: Record<string, string>;
  mergeLog: MergeLogEntry[];
  assessments: Record<string, Assessment>;
  todos: Record<string, TodoRecord>;
  runs: RunRecord[];
  backfilledAt?: string;
  debugCategoriesBackfilledAt?: string;
}
/** 早先版本写的运行记录没有 id / 状态 / 触发方式：读进来时补全，历史页和补跑判断才认得。 */
export function normalizeRun(r: Partial<RunRecord> & { startedAt: string; date: string }): RunRecord {
  const created = r.created ?? [];
  return {
    ...r,
    id: r.id ?? `old${Date.parse(r.startedAt).toString(16).slice(-5)}`,
    trigger: r.trigger ?? "catch-up",
    status: r.status ?? (!r.finishedAt ? "interrupted" : String(r.note ?? "").startsWith("失败") ? "failed" : "ok"),
    added: r.added ?? 0, byKind: { tool: 0, deploy: 0, memory: 0, flaky: 0, ...r.byKind }, merged: r.merged ?? 0, costUsd: r.costUsd ?? 0,
    created, createdTodos: r.createdTodos ?? created.map((noteId) => ({ noteId, title: "（旧记录，没有标题）" })), deferred: r.deferred ?? 0
  };
}
const empty = (): State => ({ version: 1, cursors: { events: {}, deploy: { offset: 0 }, audit: { offset: 0 } }, buckets: {}, seen: {}, merges: {}, reviewed: {}, mergeLog: [], assessments: {}, todos: {}, runs: [] });

export interface RuntimeStat { count: number; days: number; sessions: string[]; last: number; sample: string }
export interface FingerprintStat { fingerprint: string; kind: ErrorKind; members: string[]; total: number; first: number; last: number; runtimes: Partial<Record<StatsRuntime, RuntimeStat>> }

export class ErrorStatsStore {
  readonly file: string;
  state: State;
  private now: () => Date;

  constructor(options: { dir: string; now?: () => Date }) {
    this.file = join(options.dir, "error-stats", "state.json");
    this.now = options.now ?? (() => new Date());
    this.state = this.load();
  }

  private load(): State {
    try {
      if (!existsSync(this.file)) return empty();
      const s = JSON.parse(readFileSync(this.file, "utf8")) as State;
      if (!s || s.version !== 1) return empty();
      const state: State = { ...empty(), ...s, cursors: { ...empty().cursors, ...s.cursors } };
      state.runs = (state.runs ?? []).map(normalizeRun);
      return state;
    } catch { return empty(); }
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }

  /** 入库一条；返回是否新增（已见过的事件不重复计数）。 */
  add(o: Occurrence): boolean {
    if (this.state.seen[o.key] !== undefined) return false;
    this.state.seen[o.key] = o.at;
    const date = beijingDateKey(o.at);
    const day = (this.state.buckets[date] ??= {});
    const b = (day[`${o.runtime}\u0001${o.fingerprint}`] ??= { n: 0, sessions: [], last: 0, sample: o.sample, kind: o.kind });
    b.n += 1;
    if (o.sessionId && !b.sessions.includes(o.sessionId) && b.sessions.length < 8) b.sessions.push(o.sessionId);
    if (o.at >= b.last) { b.last = o.at; b.sample = o.sample; }
    return true;
  }

  /** 淘汰超过保留期的统计与去重键。 */
  prune(): void {
    const cutoff = beijingDateKey(this.now().getTime() - KEEP_DAYS * DAY_MS);
    for (const d of Object.keys(this.state.buckets)) if (d < cutoff) delete this.state.buckets[d];
    const seenCutoff = this.now().getTime() - KEEP_DAYS * DAY_MS;
    for (const [k, at] of Object.entries(this.state.seen)) if (at < seenCutoff) delete this.state.seen[k];
    const live = new Set<string>();
    for (const day of Object.values(this.state.buckets)) for (const k of Object.keys(day)) live.add(this.resolve(k.split("\u0001")[1]!));
    for (const fp of Object.keys(this.state.assessments)) if (!live.has(fp) && !this.state.todos[fp]) delete this.state.assessments[fp];
    this.state.runs = this.state.runs.slice(-90);
    this.state.mergeLog = this.state.mergeLog.slice(-200);
  }

  /** 沿着 merges 找到代表指纹（防环）。 */
  resolve(fp: string): string {
    let cur = fp;
    for (let i = 0; i < 6; i++) { const next = this.state.merges[cur]; if (!next || next === cur) break; cur = next; }
    return cur;
  }

  /** 近 N 天（北京日期）按代表指纹聚合；cutoffDate 之后（含）才算，用于「关闭后只看新证据」。 */
  stats(options: { days?: number; cutoff?: (canonical: string) => string | undefined } = {}): Map<string, FingerprintStat> {
    const now = this.now().getTime();
    const from = beijingDateKey(now - ((options.days ?? WINDOW_DAYS) - 1) * DAY_MS);
    const out = new Map<string, FingerprintStat>();
    const dayCount = new Map<string, Set<string>>();
    for (const [date, day] of Object.entries(this.state.buckets)) {
      if (date < from) continue;
      for (const [k, b] of Object.entries(day)) {
        const [runtime, raw] = k.split("\u0001") as [StatsRuntime, string];
        const canonical = this.resolve(raw);
        const cut = options.cutoff?.(canonical);
        if (cut && date <= cut) continue;
        const s = out.get(canonical) ?? { fingerprint: canonical, kind: b.kind, members: [], total: 0, first: Infinity, last: 0, runtimes: {} };
        if (!s.members.includes(raw)) s.members.push(raw);
        s.total += b.n;
        s.first = Math.min(s.first, b.last); s.last = Math.max(s.last, b.last);
        const r = (s.runtimes[runtime] ??= { count: 0, days: 0, sessions: [], last: 0, sample: b.sample });
        r.count += b.n;
        for (const sid of b.sessions) if (!r.sessions.includes(sid) && r.sessions.length < 8) r.sessions.push(sid);
        if (b.last >= r.last) { r.last = b.last; r.sample = b.sample; }
        const dk = `${canonical}\u0001${runtime}`;
        const set = dayCount.get(dk) ?? new Set(); set.add(date); dayCount.set(dk, set);
        out.set(canonical, s);
      }
    }
    for (const s of out.values()) for (const [rt, r] of Object.entries(s.runtimes)) r.days = dayCount.get(`${s.fingerprint}\u0001${rt}`)?.size ?? 0;
    return out;
  }

  noteIds(): Set<string> { return new Set(Object.values(this.state.todos).map((t) => t.noteId)); }

  /** 历次真正创建的 ID 也要保留：同指纹的旧待办可能已被后续记录替换。 */
  createdNoteIds(): Set<string> {
    return new Set([...this.noteIds(), ...this.state.runs.flatMap(r => [...r.created, ...r.createdTodos.map(t => t.noteId)])]);
  }
}
