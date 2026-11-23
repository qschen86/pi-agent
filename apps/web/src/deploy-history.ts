import { deploymentProgress, type DeploymentProgress } from "./deployment-progress.js";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { liveCommit, readRequests, watcherPid, whenIdleDirs } from "../../../scripts/deploy-when-idle.mjs";

/**
 * 平台设置 → 版本：部署历史。
 *
 * 守候进程把每次部署的结果追加到 `~/.pi-agent-gui/when-idle/history.log`，
 * 每行是 `时间 \t 短 sha \t 结果 \t 会话 id \t 备注 [\t 提交标题]`。
 * 这里只读这份追加日志；没有日志、没有部署服务时返回空列表，不影响设置页打开。
 */
export type DeployState = "ok" | "failed" | "cancelled" | "expired" | "already-live" | "unknown";
export type DeployCounts = Record<DeployState, number>;
export type DeployRuntime = "codex" | "claude-code" | "pi" | "unknown";
export type DeployRuntimeCounts = Record<DeployRuntime, number>;
export interface DeployPeriodStats {
  total: number;
  ok: number;
  failed: number;
  other: number;
}
export interface DeployPeriods {
  today: DeployPeriodStats;
  last7: DeployPeriodStats;
  last30: DeployPeriodStats;
  all: DeployPeriodStats;
}
export interface DeployDay {
  date: string;
  total: number;
  runtimes: DeployRuntimeCounts;
}

export interface DeployHistoryEntry {
  /** 日志行本身没有 id：用时间 + sha + 行号组成稳定标识 */
  id: string;
  /** 日志里的原始时间（本机时区，sv-SE 格式） */
  at: string;
  /** 用于前端排序；读不出来时为 0 */
  atMs: number;
  sha: string;
  state: DeployState;
  /** 原始结果，保留 failed:3 这类退出码 */
  outcome: string;
  ok: boolean;
  sessionId: string | null;
  note: string;
  subject: string;
  /** 发起部署的会话 runtime；旧日志没有记录时按会话绑定补，识别不了记 unknown */
  runtimeKind: DeployRuntime;
  /** 写下这条记录的部署控制器版本（脚本内容哈希前 7 位）；旧日志没有记录，为 undefined */
  controller?: string;
  requestId?: string;
  deployedSha?: string;
  /** 部署耗时（毫秒）：从开始准备到上线完成，扣掉等待会话的时间；有流程存档时由部署接口补上 */
  durationMs?: number;
}

export interface DeployActiveEntry {
  action?: "rollback"; expectedLive?: string;
  id: string;
  sha: string;
  subject: string;
  sessionId: string | null;
  requestedAt: string;
  startedAt?: string;
  progress?: DeploymentProgress;
  state: "pending" | "started";
  runtimeKind: DeployRuntime;
}

export interface DeployHistory {
  /** 已结束的部署，按时间倒序 */
  entries: DeployHistoryEntry[];
  /** 整个 history.log 的状态计数（不是当前这一页） */
  counts: DeployCounts;
  /** 正在排队 / 部署中的请求；按登记时间正序 */
  active: DeployActiveEntry[];
  /** 按日期聚合的部署次数（含 runtime 拆分），用于日历热力图 */
  calendar: DeployDay[];
  /** 今日 / 最近 7 天 / 最近 30 天 / 累计 */
  periods: DeployPeriods;
  runtimePeriods: Record<DeployRuntime, DeployPeriods>;
  total: number;
  /** 统计快照最后一次折算新日志的时间（ISO）；没有日志时为空 */
  statsAt?: string | undefined;
  watcherRunning: boolean;
  live?: string;
}

export interface DeployHistoryOptions {
  /** 日期统计的目标时区；省略时保留部署日志的本机日期口径。 */
  timeZone?: string;
  /** 只保留这一段已结束记录（默认从最新开始取 200 条） */
  limit?: number;
  /** 从时间倒序的第几条开始（翻页用；默认 0） */
  offset?: number;
  /** 旧日志没有 runtime 字段时，按会话 id 查它的 runtime */
  runtimeFor?: (sessionId: string | null) => string | undefined;
}

const clean = (value: string): string => value.replace(/[\t\r\n]+/g, " ").trim();

function stateOf(outcome: string): DeployState {
  const base = outcome.split(":")[0] ?? "";
  return base === "ok" || base === "failed" || base === "cancelled" || base === "expired" || base === "already-live"
    ? base
    : "unknown";
}

function runtimeOf(value: string | undefined): DeployRuntime {
  return value === "codex" || value === "claude-code" || value === "pi" ? value : "unknown";
}

function dayKeyOffset(days: number, timeZone?: string): string {
  if (timeZone) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const date = new Date(today + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  }
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const emptyPeriod = (): DeployPeriodStats => ({ total: 0, ok: 0, failed: 0, other: 0 });

function atMsOf(at: string): number {
  const ms = Date.parse(at.replace(" ", "T"));
  return Number.isFinite(ms) ? ms : 0;
}

/** 解析 history.log 的一行；格式不对就跳过。 */
export function parseDeployHistoryLine(line: string, index = 0): DeployHistoryEntry | undefined {
  if (!line.trim()) return undefined;
  const parts = line.split("\t");
  if (parts.length < 4) return undefined;
  const [at = "", sha = "", outcome = "", session = "", ...rest] = parts;
  if (!at.trim() || !sha.trim() || !outcome.trim()) return undefined;
  const state = stateOf(outcome);
  return {
    id: `${at}-${sha}-${index}`,
    at,
    atMs: atMsOf(at),
    sha,
    state,
    outcome,
    ok: state === "ok",
    sessionId: session && session !== "-" ? session : null,
    note: clean(rest[0] ?? ""),
    subject: clean(rest[1] ?? ""),
    runtimeKind: runtimeOf(clean(rest[2] ?? "")),
    ...(clean(rest[3] ?? "") ? { controller: clean(rest[3] ?? "") } : {}),
    ...(clean(rest[4] ?? "") ? { requestId: clean(rest[4] ?? "") } : {}),
    ...(/^[a-f0-9]{7,40}$/i.test(rest[5] ?? "") ? { deployedSha: rest[5] } : {}),
  };
}

/** 这个会话最近一次结束的部署；只从日志末尾往前找，不等整份历史解析完。 */
export function readLatestDeployForSession(sessionId: string, root?: string): DeployHistoryEntry | undefined {
  if (!sessionId) return undefined;
  const resolvedRoot = root ?? process.env["PI_AGENT_GUI_ROOT"] ?? join(homedir(), ".pi-agent-gui");
  const file = join(whenIdleDirs(resolvedRoot).home, "history.log");
  if (!existsSync(file)) return undefined;
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseDeployHistoryLine(lines[i]!, i);
      if (entry?.sessionId === sessionId) return entry;
    }
  } catch { /* 读不到日志时页面只少一条部署结果，不影响接口其他字段 */ }
  return undefined;
}

/* ------------------------------ 统计快照 + 增量 ------------------------------ */

/**
 * 统计（累计 / 周期 / 日历）不再每次读整份 history.log 重算：
 * 快照记录「已折算到日志第几个字节」，之后每次只读追加的部分叠加上去。
 * 日志被截断、改写（快照末尾校验和对不上）或快照损坏时才整份重建一次。
 * 快照存在 when-idle/stats-snapshot.json；进程内另留一份，免得每次请求都读盘。
 */
interface DayBucket { total: number; ok: number; failed: number; runtimes: DeployRuntimeCounts; runtimeStats: Record<DeployRuntime, DeployPeriodStats> }
interface StatsSnapshot {
  version: 2;
  /** 已折算的字节数（恰好停在某个换行之后） */
  offset: number;
  /** 已折算的换行数 = 下一行（未折算行）的行号，日志条目 id 用它保持稳定 */
  lines: number;
  /** offset 之前最多 TAIL_CHECK 字节的 sha1，用来发现日志被改写 */
  tail: string;
  total: number;
  counts: DeployCounts;
  runtimeStats: Record<DeployRuntime, DeployPeriodStats>;
  days: Record<string, DayBucket>;
  updatedAt: string;
}

const SNAPSHOT_VERSION = 2;
const TAIL_CHECK = 256;
const SNAPSHOT_FILE = "stats-snapshot.json";
const memorySnapshots = new Map<string, StatsSnapshot>();

const emptyCounts = (): DeployCounts => ({ ok: 0, failed: 0, cancelled: 0, expired: 0, "already-live": 0, unknown: 0 });
const emptyRuntimeStats = (): Record<DeployRuntime, DeployPeriodStats> => ({ codex: emptyPeriod(), "claude-code": emptyPeriod(), pi: emptyPeriod(), unknown: emptyPeriod() });
const emptySnapshot = (): StatsSnapshot => ({ version: SNAPSHOT_VERSION, offset: 0, lines: 0, tail: "", total: 0, counts: emptyCounts(), runtimeStats: emptyRuntimeStats(), days: {}, updatedAt: "" });
const tailHash = (bytes: Buffer): string => createHash("sha1").update(bytes).digest("hex");

function foldEntry(snapshot: StatsSnapshot, entry: DeployHistoryEntry, timeZone?: string): void {
  snapshot.total++;
  snapshot.counts[entry.state]++;
  const addRuntime = (stats: DeployPeriodStats) => {
    stats.total++;
    if (entry.state === "ok") stats.ok++;
    else if (entry.state === "failed") stats.failed++;
    else stats.other++;
  };
  addRuntime(snapshot.runtimeStats[entry.runtimeKind]);
  // 日志的无时区时间由守候进程按本机时区写入，atMs 已按相同本机时区解析。
  if (timeZone && !entry.atMs) return;
  const date = timeZone
    ? new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(entry.atMs))
    : entry.at.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  let day = snapshot.days[date];
  if (!day) { day = { total: 0, ok: 0, failed: 0, runtimes: { codex: 0, "claude-code": 0, pi: 0, unknown: 0 }, runtimeStats: emptyRuntimeStats() }; snapshot.days[date] = day; }
  addRuntime(day.runtimeStats[entry.runtimeKind]);
  day.total++;
  if (entry.state === "ok") day.ok++;
  else if (entry.state === "failed") day.failed++;
  day.runtimes[entry.runtimeKind]++;
}

function readBytes(file: string, from: number, to: number): Buffer {
  const length = Math.max(0, to - from);
  const buffer = Buffer.alloc(length);
  if (!length) return buffer;
  const fd = openSync(file, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  } finally { closeSync(fd); }
}

function loadSnapshot(file: string, snapshotFile: string): StatsSnapshot | undefined {
  const cached = memorySnapshots.get(snapshotFile);
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(snapshotFile, "utf8")) as Partial<StatsSnapshot>;
    if (raw && raw.version === SNAPSHOT_VERSION && Number.isFinite(raw.offset) && Number.isFinite(raw.lines)
      && typeof raw.tail === "string" && raw.counts && raw.days && typeof raw.total === "number") {
      return raw as StatsSnapshot;
    }
  } catch { /* 没有快照或损坏：按空快照整份重建 */ }
  return undefined;
}

function snapshotStillValid(file: string, snapshot: StatsSnapshot, size: number): boolean {
  if (snapshot.offset > size) return false;
  if (snapshot.offset === 0) return snapshot.tail === "";
  try { return tailHash(readBytes(file, Math.max(0, snapshot.offset - TAIL_CHECK), snapshot.offset)) === snapshot.tail; }
  catch { return false; }
}

interface LogStats {
  snapshot: StatsSnapshot;
  /** 最后一个换行之后没写完的行（手工写入或正在追加）；只参与本次返回，不进快照 */
  pending: string;
}

function foldedLogStats(file: string, snapshotFile: string, runtimeFor?: (sessionId: string | null) => string | undefined, timeZone?: string): LogStats {
  let size = 0;
  try { size = statSync(file).size; } catch { /* 没有日志 */ }
  let snapshot = loadSnapshot(file, snapshotFile);
  let rebuilt = false;
  if (!snapshot || !snapshotStillValid(file, snapshot, size)) {
    snapshot = emptySnapshot();
    rebuilt = size > 0;
  }
  const resolve = (entry: DeployHistoryEntry): DeployHistoryEntry => {
    if (entry.runtimeKind === "unknown" && entry.sessionId) entry.runtimeKind = runtimeOf(runtimeFor?.(entry.sessionId));
    return entry;
  };
  let folded = 0;
  let pending = "";
  if (size > snapshot.offset) {
    const base = Math.max(0, snapshot.offset - TAIL_CHECK);
    const bytes = readBytes(file, base, size);
    const fresh = bytes.subarray(snapshot.offset - base);
    const lastNewline = fresh.lastIndexOf(0x0a);
    const complete = lastNewline >= 0 ? fresh.subarray(0, lastNewline + 1) : Buffer.alloc(0);
    pending = fresh.subarray(complete.length).toString("utf8");
    if (complete.length) {
      let index = snapshot.lines;
      for (const line of complete.toString("utf8").split("\n").slice(0, -1)) {
        const entry = parseDeployHistoryLine(line, index++);
        if (entry) foldEntry(snapshot, resolve(entry), timeZone);
      }
      snapshot.lines = index;
      snapshot.offset += complete.length;
      snapshot.tail = tailHash(bytes.subarray(Math.max(0, snapshot.offset - base - TAIL_CHECK), snapshot.offset - base));
      snapshot.updatedAt = new Date().toISOString();
      folded = complete.length;
    }
  }
  memorySnapshots.set(snapshotFile, snapshot);
  if (folded || rebuilt) {
    try {
      const temp = `${snapshotFile}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(snapshot));
      renameSync(temp, snapshotFile);
    } catch { /* 快照写不进去只是下次再折算一遍增量，不影响接口 */ }
  }
  return { snapshot, pending };
}

/** 丢掉进程内的快照（模拟服务重启；磁盘上的快照文件保留）。 */
export function forgetDeployStatsMemory(): void { memorySnapshots.clear(); }

function periodsOf(snapshot: StatsSnapshot, timeZone?: string, runtime?: DeployRuntime): DeployPeriods {
  const periods: DeployPeriods = { today: emptyPeriod(), last7: emptyPeriod(), last30: emptyPeriod(), all: emptyPeriod() };
  const { counts } = snapshot;
  periods.all = { total: snapshot.total, ok: counts.ok, failed: counts.failed, other: snapshot.total - counts.ok - counts.failed };
  if (runtime) periods.all = { ...snapshot.runtimeStats[runtime] };
  const today = dayKeyOffset(0, timeZone), start7 = dayKeyOffset(6, timeZone), start30 = dayKeyOffset(29, timeZone);
  const add = (period: DeployPeriodStats, day: Pick<DayBucket, "total" | "ok" | "failed">) => {
    period.total += day.total; period.ok += day.ok; period.failed += day.failed; period.other += day.total - day.ok - day.failed;
  };
  for (const [date, bucket] of Object.entries(snapshot.days)) {
    const day = runtime ? bucket.runtimeStats[runtime] : bucket;
    if (date === today) add(periods.today, day);
    if (date >= start7 && date <= today) add(periods.last7, day);
    if (date >= start30 && date <= today) add(periods.last30, day);
  }
  return periods;
}

/**
 * 按「时间倒序第 offset..offset+limit 条」从日志末尾往回读，只解析这一页要的那几行。
 * 日志本来就是追加写的，末尾就是最新的；窗口内再按时间排一次，兼容小幅时钟回拨。
 */
function readEntryPage(file: string, lastLine: number, limit: number, offset: number, runtimeFor?: (sessionId: string | null) => string | undefined): DeployHistoryEntry[] {
  let size = 0;
  try { size = statSync(file).size; } catch { return []; }
  const need = offset + limit;
  let window = Math.max(16 * 1024, need * 512);
  for (;;) {
    const from = Math.max(0, size - window);
    const text = readBytes(file, from, size).toString("utf8");
    const segments = text.split("\n");
    // 窗口不是从文件开头读的话，第一段可能被截断，丢掉。
    const first = from > 0 ? 1 : 0;
    const entries: DeployHistoryEntry[] = [];
    for (let i = first; i < segments.length; i++) {
      const entry = parseDeployHistoryLine(segments[i]!, lastLine - (segments.length - 1 - i));
      if (entry) entries.push(entry);
    }
    if (entries.length >= need || from === 0) {
      entries.sort((a, b) => b.atMs - a.atMs || b.at.length - a.at.length);
      const page = entries.slice(offset, offset + limit);
      for (const entry of page) {
        if (entry.runtimeKind === "unknown" && entry.sessionId) entry.runtimeKind = runtimeOf(runtimeFor?.(entry.sessionId));
      }
      return page;
    }
    window *= 4;
  }
}

/** 读取部署历史；root 默认是 PI_AGENT_GUI_ROOT 或 ~/.pi-agent-gui（与守候进程同口径）。 */
export function readDeployHistory(root?: string, options: DeployHistoryOptions = {}): DeployHistory {
  const limit = Math.max(1, Math.min(2000, options.limit ?? 200));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  // 每次调用时再决定根目录，测试和服务重启后都能换 PI_AGENT_GUI_ROOT。
  const resolvedRoot = root ?? process.env["PI_AGENT_GUI_ROOT"] ?? join(homedir(), ".pi-agent-gui");
  const dirs = whenIdleDirs(resolvedRoot);
  const file = join(dirs.home, "history.log");
  const timeZone = options.timeZone
    ? new Intl.DateTimeFormat("en", { timeZone: options.timeZone }).resolvedOptions().timeZone
    : undefined;
  // 不同时区各有自己的增量快照，避免默认设置页与北京时间今日卡片相互污染。
  const snapshotName = timeZone ? `stats-snapshot-${createHash("sha256").update(timeZone).digest("hex").slice(0, 12)}.json` : SNAPSHOT_FILE;
  let stats: StatsSnapshot = emptySnapshot();
  let entries: DeployHistoryEntry[] = [];
  if (existsSync(file)) {
    try {
      const folded = foldedLogStats(file, join(dirs.home, snapshotName), options.runtimeFor, timeZone);
      stats = folded.snapshot;
      if (folded.pending.trim()) {
        // 日志最后一行没有换行结尾：只叠加到本次返回，不进快照。
        const extra = parseDeployHistoryLine(folded.pending, stats.lines);
        if (extra) {
          if (extra.runtimeKind === "unknown" && extra.sessionId) extra.runtimeKind = runtimeOf(options.runtimeFor?.(extra.sessionId));
          stats = structuredClone(stats);
          foldEntry(stats, extra, timeZone);
        }
      }
      entries = readEntryPage(file, stats.lines, limit, offset, options.runtimeFor);
    } catch { /* 读不到日志就当没有历史，设置页仍可使用 */ }
  }
  const counts = stats.counts;
  const periods = periodsOf(stats, timeZone);
  const calendar: DeployDay[] = Object.entries(stats.days)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => ({ date, total: day.total, runtimes: { ...day.runtimes } }));
  const active: DeployActiveEntry[] = [];
  try {
    active.push(...readRequests(resolvedRoot)
      .map((q): DeployActiveEntry => ({
        ...(q.action ? { action: q.action, expectedLive: q.expectedLive } : {}),
        id: q.id,
        sha: q.sha,
        subject: q.subject ?? "",
        sessionId: q.notifySession ?? null,
        requestedAt: q.requestedAt,
        ...(q.startedAt ? { startedAt: q.startedAt, progress: deploymentProgress(q, resolvedRoot) } : {}),
        state: q.startedAt ? "started" : "pending",
        runtimeKind: runtimeOf(q.runtimeKind ?? (q.notifySession ? options.runtimeFor?.(q.notifySession) : undefined)),
      })));
  } catch { /* 排队目录不可读时只是没有进行中的部署 */ }
  active.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  let live: string | undefined;
  try { live = liveCommit(resolvedRoot); } catch { /* 没有监督进程 / 槽位时只是没有线上版本 */ }
  return {
    entries,
    counts,
    calendar,
    periods,
    runtimePeriods: Object.fromEntries((["codex", "claude-code", "pi", "unknown"] as const).map(runtime => [runtime, periodsOf(stats, timeZone, runtime)])) as Record<DeployRuntime, DeployPeriods>,
    active,
    total: stats.total,
    statsAt: stats.updatedAt || undefined,
    watcherRunning: !!watcherPid(resolvedRoot),
    ...(live ? { live } : {}),
  };
}
