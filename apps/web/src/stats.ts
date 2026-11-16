import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OperationRecord, SessionBinding, UsageRecord } from "@pi-agent/runtime-sessions";
import { usageTime } from "@pi-agent/runtime-sessions";
import { runtimeDeepSeekChannel, type DeepSeekDailyRow, type DeepSeekDeviceOf } from "./deepseek-usage.js";
import { parseDeployHistoryLine, type DeployHistoryEntry } from "./deploy-history.js";
import { whenIdleDirs } from "../../../scripts/deploy-when-idle.mjs";
import { PLATFORM_TIME_ZONE, beijingDateKey } from "./platform-time.js";
import { BILLING_RUNTIMES, subscriptionAccrued, usdRate, type BillingConfig, type BillingRuntime } from "./platform-billing.js";
import type { TurnOrigins } from "./turn-origin.js";

/**
 * 统计应用的按日数据（北京时间分日）：消耗 / 会话 / 部署三类，统一成「指标 × 维度」：
 * 每天每个指标一个总数，外加按 runtime / 应用·功能 / 发起端 / 控制器版本拆开的小计。
 * 前端用同一套组件做区间合计（今日、昨日、近 7 天、近 30 日）、拆解表、趋势图和月度热力图。
 */
export type StatsDomain = "cost" | "sessions" | "deploys";
export type StatsDim = "runtime" | "app" | "device" | "controller";
export interface StatsMetric { total: number; by: Partial<Record<StatsDim, Record<string, number>>> }
export interface StatsDay { day: string; v: Record<string, StatsMetric> }
export interface StatsResult {
  domain: StatsDomain;
  timeZone: string;
  generatedAt: string;
  from: string;
  to: string;
  days: StatsDay[];
  /** 每个指标可用的拆解维度，按展示顺序 */
  dims: StatsDim[];
  notes: string[];
}

export const STATS_MAX_DAYS = 400;
export const STATS_DEFAULT_DAYS = 90;

/** 北京时间 day（YYYY-MM-DD）往前 / 往后 n 天。 */
function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}
const daysInMonthOf = (day: string): number => {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** 区间内每一天都先放一个空行，趋势图和热力图不用补零。 */
export class Table {
  readonly days = new Map<string, Record<string, StatsMetric>>();
  constructor(readonly from: string, readonly to: string) {
    for (let day = from; day <= to; day = shiftDay(day, 1)) this.days.set(day, {});
  }
  add(day: string, metric: string, value: number, dims: Partial<Record<StatsDim, string>>): void {
    const row = this.days.get(day);
    if (!row || !Number.isFinite(value) || value === 0) return;
    const m = (row[metric] ??= { total: 0, by: {} });
    m.total += value;
    for (const [dim, key] of Object.entries(dims) as Array<[StatsDim, string]>) {
      const bucket = (m.by[dim] ??= {});
      bucket[key] = (bucket[key] ?? 0) + value;
    }
  }
  has(day: string): boolean { return this.days.has(day); }
  rows(): StatsDay[] { return [...this.days.entries()].map(([day, v]) => ({ day, v })); }
}

const dayOfMs = (ms: number): string => beijingDateKey(ms);
const dayOfIso = (iso: string | undefined): string | undefined => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? dayOfMs(ms) : undefined;
};

export function statsRange(now: Date, days: number): { from: string; to: string } {
  const to = beijingDateKey(now);
  return { from: shiftDay(to, -(Math.max(1, Math.min(STATS_MAX_DAYS, Math.floor(days))) - 1)), to };
}

/* ------------------------------ 发起端 ------------------------------ */

type DeviceAt = (platformSessionId: string, atMs: number | undefined) => string;

/**
 * 某会话在某时刻的发起端：取「该时刻之前最近开始的那一轮」，按这一轮的操作键反查它的第一条消息来自哪个端。
 * 时刻未知、或那之前没有任何轮次，返回「未知」。
 */
export function deviceResolver(bindings: SessionBinding[], operations: OperationRecord[], origins: TurnOrigins): DeviceAt {
  const keyOf = new Map(operations.map((o) => [o.operationId, o.idempotencyKey]));
  const byId = new Map(bindings.map((b) => [b.platformSessionId, b]));
  const cache = new Map<string, Array<{ at: number; device: string }>>();
  const timeline = (id: string) => {
    let list = cache.get(id);
    if (!list) {
      list = [];
      for (const t of byId.get(id)?.turns ?? []) {
        const at = t.startedAt ? Date.parse(t.startedAt) : NaN;
        if (Number.isFinite(at)) list.push({ at, device: origins.deviceOfTurn(keyOf.get(t.operationId), t.startedAt) });
      }
      list.sort((a, b) => a.at - b.at);
      cache.set(id, list);
    }
    return list;
  };
  return (id, atMs) => {
    if (atMs === undefined) return "unknown";
    const list = timeline(id);
    let hit: string | undefined;
    for (const item of list) { if (item.at <= atMs) hit = item.device; else break; }
    return hit ?? "unknown";
  };
}

export const channelLabel = (binding: Pick<SessionBinding, "roomRef" | "comparisonRef">): string => {
  const c = runtimeDeepSeekChannel(binding);
  return `${c.app} · ${c.feature}`;
};

/* ------------------------------ 会话 ------------------------------ */

/** 平台会话里真正出现过的会话：预约创建、首轮还没发的不算。 */
const countable = (b: SessionBinding): boolean => !(b.turns.length === 0 && (b.scheduledCreate || b.outbox?.[0]?.scheduledFor));

export interface SessionActivity {
  stats: StatsDay[];
  /** 每天每个 runtime 的「轮次起点」按 应用·功能 / 发起端 的计数：订阅费用按它摊到各维度 */
  turnWeights: Map<string, Map<string, Map<string, number>>>;
  /** 每个 runtime 第一次出现活动的日期 */
  firstDay: Map<string, string>;
}

export function sessionStats(input: { bindings: SessionBinding[]; deviceAt: DeviceAt; table: Table }): SessionActivity {
  const { table, deviceAt } = input;
  const turnWeights = new Map<string, Map<string, Map<string, number>>>();
  const firstDay = new Map<string, string>();
  const bump = (day: string, runtime: string, key: string) => {
    const byRuntime = turnWeights.get(day) ?? new Map<string, Map<string, number>>();
    const keys = byRuntime.get(runtime) ?? new Map<string, number>();
    keys.set(key, (keys.get(key) ?? 0) + 1);
    byRuntime.set(runtime, keys); turnWeights.set(day, byRuntime);
  };
  for (const b of input.bindings) {
    if (!countable(b)) continue;
    const app = channelLabel(b), runtime = b.runtimeKind;
    const created = dayOfIso(b.createdAt?.at);
    // 活跃的日子：创建日、每一轮的开始日与结束日、最后一次活动日
    const active = new Set<string>();
    const firstTurnMs = new Map<string, number>();
    if (created) active.add(created);
    for (const t of b.turns) {
      const start = t.startedAt ? Date.parse(t.startedAt) : NaN;
      if (Number.isFinite(start)) {
        const day = dayOfMs(start);
        active.add(day);
        if (!firstTurnMs.has(day)) firstTurnMs.set(day, start);
        bump(day, runtime, `${app}\u0000${deviceAt(b.platformSessionId, start)}`);
      }
      const end = dayOfIso(t.endedAt);
      if (end) active.add(end);
    }
    const last = dayOfIso(b.lastActivityAt?.at);
    if (last) active.add(last);
    const earliest = [...active].sort()[0];
    if (earliest && (!firstDay.has(runtime) || earliest < firstDay.get(runtime)!)) firstDay.set(runtime, earliest);
    for (const day of active) {
      if (!table.has(day)) continue;
      // 当天有轮次开始：看当天第一轮是谁发的；否则是前几天开始的轮次还在继续，看那一天之前最近的一轮
      const at = firstTurnMs.get(day) ?? Date.parse(`${day}T00:00:00+08:00`) - 1;
      table.add(day, "sessions", 1, { runtime, app, device: deviceAt(b.platformSessionId, at) });
    }
    if (created) table.add(created, "created", 1, { runtime, app, device: deviceAt(b.platformSessionId, Date.parse(b.createdAt.at) + 60_000) });
  }
  return { stats: table.rows(), turnWeights, firstDay };
}

/* ------------------------------ 消耗 ------------------------------ */

export async function costStats(input: {
  bindings: SessionBinding[]; usage: Record<string, UsageRecord[]>; deviceAt: DeviceAt; table: Table;
  deepseek: DeepSeekDailyRow[]; billing: BillingConfig; activity: SessionActivity; now: Date; dataDir: string;
}): Promise<{ partial: boolean }> {
  const { table, now } = input;
  let partial = false;
  // Pi / DeepSeek：账本里的平台调用 + 受管会话的 DeepSeek 用量，金额按调用时刻的峰谷单价估算
  for (const r of input.deepseek) {
    if (!table.has(r.day)) continue;
    const dims = { runtime: r.runtime, app: `${r.app} · ${r.feature}`, device: r.device };
    table.add(r.day, "tokens", r.tokens, dims);
    table.add(r.day, "usd", r.usd, dims);
    partial ||= r.partial;
  }
  // 其它 runtime 的 token：按请求时间分日（Codex 只有会话累计值、没有每次请求的时间，不分日）
  const byId = new Map(input.bindings.map((b) => [b.platformSessionId, b]));
  for (const [id, records] of Object.entries(input.usage)) {
    const b = byId.get(id);
    if (!b || b.runtimeKind === "pi") continue;
    const seen = new Set<string>(), app = channelLabel(b);
    for (const r of records) {
      if (r.subagent || r.counterMode !== "delta" || !r.requestId || seen.has(r.requestId)) continue;
      seen.add(r.requestId);
      const at = usageTime(r);
      if (at === undefined) continue;
      const day = dayOfMs(at);
      table.add(day, "tokens", (r.input ?? 0) + (r.cachedInput ?? 0) + (r.cacheCreation ?? 0) + (r.output ?? 0), { runtime: b.runtimeKind, app, device: input.deviceAt(id, at) });
    }
  }
  // 订阅：月费 ÷ 当月天数 = 一天的费用（今天只算已过去的小时），从该 runtime 第一次有活动的那天起算；
  // 当天的费用按各 应用·功能 / 发起端 的轮次数分摊，当天没有轮次就记在「会话 · 对话 / 未知」。
  const today = beijingDateKey(now);
  for (const runtime of BILLING_RUNTIMES) {
    const plan = input.billing[runtime as BillingRuntime];
    if (plan.mode !== "subscription") continue;
    const fx = await usdRate(plan.currency, input.dataDir, now);
    if (!fx) { partial = true; continue; }
    const first = input.activity.firstDay.get(runtime);
    if (!first) continue;
    for (const day of table.days.keys()) {
      if (day < first) continue;
      const usd = (day === today ? subscriptionAccrued(plan.monthly, now) : plan.monthly / daysInMonthOf(day)) * fx.rate;
      const weights = input.activity.turnWeights.get(day)?.get(runtime);
      const sum = weights ? [...weights.values()].reduce((a, b) => a + b, 0) : 0;
      if (!weights || !sum) { table.add(day, "usd", usd, { runtime, app: "会话 · 对话", device: "unknown" }); continue; }
      for (const [key, n] of weights) {
        const [app = "会话 · 对话", device = "unknown"] = key.split("\u0000");
        table.add(day, "usd", usd * n / sum, { runtime, app, device });
      }
    }
  }
  return { partial };
}

/* ------------------------------ 部署 ------------------------------ */

interface RunTimes { startMs: number; endMs: number; waitingMs: number }

/** 一次部署的流程步骤 → 开始 / 结束时刻和「等待会话」占掉的时间（耗时要扣掉它）。 */
export function runTimes(run: { steps?: Array<{ phase: string; at: string }>; finishedAt?: string }): RunTimes | undefined {
  const steps = (run.steps ?? []).map((s) => ({ phase: s.phase, at: Date.parse(s.at) })).filter((s) => Number.isFinite(s.at));
  if (!steps.length) return undefined;
  const startMs = steps[0]!.at;
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
  const endMs = Number.isFinite(finished) ? finished : steps[steps.length - 1]!.at;
  let waitingMs = 0;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.phase !== "waiting") continue;
    waitingMs += Math.max(0, (steps[i + 1]?.at ?? endMs) - steps[i]!.at);
  }
  return endMs >= startMs ? { startMs, endMs, waitingMs: Math.min(waitingMs, endMs - startMs) } : undefined;
}

let historyCache: { key: string; entries: DeployHistoryEntry[] } | undefined;
function readAllDeployEntries(file: string): DeployHistoryEntry[] {
  let key = "-";
  try { const st = statSync(file); key = `${file}|${st.mtimeMs}|${st.size}`; } catch { return []; }
  if (historyCache?.key === key) return historyCache.entries;
  const entries: DeployHistoryEntry[] = [];
  readFileSync(file, "utf8").split("\n").forEach((line, i) => { const e = parseDeployHistoryLine(line, i); if (e && e.atMs) entries.push(e); });
  historyCache = { key, entries };
  return entries;
}

export function deployStats(input: { table: Table; deviceAt: DeviceAt; root?: string }): void {
  const root = input.root ?? process.env["PI_AGENT_GUI_ROOT"] ?? join(homedir(), ".pi-agent-gui");
  const dirs = whenIdleDirs(root);
  const file = join(dirs.home, "history.log");
  if (!existsSync(file)) return;
  const runs = new Map<string, RunTimes>();
  try {
    for (const name of readdirSync(join(dirs.home, "runs"))) {
      if (!name.endsWith(".json")) continue;
      try {
        const run = JSON.parse(readFileSync(join(dirs.home, "runs", name), "utf8"));
        const t = runTimes(run);
        if (t && typeof run.sha === "string") runs.set(run.sha.slice(0, 7), t);
      } catch { /* 坏文件不影响其余部署 */ }
    }
  } catch { /* 没有 runs 目录：旧部署都没有耗时 */ }
  for (const e of readAllDeployEntries(file)) {
    // 北京时间分日；时间用日志里的本机墙上时间解析出的绝对时刻
    const day = dayOfMs(e.atMs);
    if (!input.table.has(day)) continue;
    const run = runs.get(e.sha.slice(0, 7));
    // 同一个提交可能部署过不止一次：只认结束时间和这条记录对得上的流程
    const matched = run && Math.abs(run.endMs - e.atMs) < 10 * 60_000 ? run : undefined;
    const dims = {
      runtime: e.runtimeKind,
      controller: e.controller ?? "未知",
      device: e.sessionId ? input.deviceAt(e.sessionId, matched?.startMs ?? e.atMs) : "unknown"
    };
    input.table.add(day, "deploys", 1, dims);
    if (e.state === "ok") input.table.add(day, "ok", 1, dims);
    if (e.state === "failed") input.table.add(day, "failed", 1, dims);
    if (matched && (e.state === "ok" || e.state === "failed")) {
      input.table.add(day, "durationMs", matched.endMs - matched.startMs - matched.waitingMs, dims);
      input.table.add(day, "durationN", 1, dims);
    }
  }
}

/* ------------------------------ 入口 ------------------------------ */

export interface StatsSources {
  bindings: () => SessionBinding[];
  usage: () => Record<string, UsageRecord[]>;
  operations: () => OperationRecord[];
  origins: TurnOrigins;
  deepseekRows: (deviceOf: DeepSeekDeviceOf) => DeepSeekDailyRow[];
  billing: () => BillingConfig;
  dataDir: string;
  deployRoot?: string;
  /** 数据没变就复用上一次结果：把几个文件的 mtime / size 拼成串 */
  signature: () => string;
}

export class StatsService {
  private cache = new Map<string, StatsResult>();
  constructor(private readonly src: StatsSources) {}

  async get(domain: StatsDomain, daysWanted: number, now = new Date()): Promise<StatsResult> {
    const { from, to } = statsRange(now, daysWanted);
    // 今天的订阅摊销随小时增长，所以缓存键带到分钟；数据文件没变且同一分钟内直接复用
    const key = `${domain}|${from}|${to}|${this.src.signature()}|${Math.floor(now.getTime() / 60_000)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const notes: string[] = [];
    const table = new Table(from, to);
    const bindings = this.src.bindings();
    const deviceAt = deviceResolver(bindings, this.src.operations(), this.src.origins);
    let dims: StatsDim[];
    if (domain === "deploys") {
      deployStats({ table, deviceAt, ...(this.src.deployRoot ? { root: this.src.deployRoot } : {}) });
      dims = ["runtime", "controller", "device"];
      notes.push("部署耗时 = 从开始准备到上线完成，扣掉等待会话空闲的时间；只保留了最近约 300 次部署的流程记录，更早的只有次数。",
        "控制器版本从该功能上线后才开始记录，更早的部署记为「未知」。发起端取发起部署的会话在部署开始时的那一轮的第一条消息来源。");
    } else {
      // 会话与消耗共用会话活动：消耗里的订阅费用要按各天的轮次数分摊
      const activity = sessionStats({ bindings, deviceAt, table: domain === "sessions" ? table : new Table(from, to) });
      if (domain === "sessions") {
        dims = ["runtime", "app", "device"];
        notes.push("会话数 = 当天有新事件的会话：当天创建，或当天有轮次开始 / 结束 / 最后一次活动（含已归档）。发起端取当天第一轮的第一条消息来源；一个会话一天只算一次。");
      } else {
        const { partial } = await costStats({
          bindings, usage: this.src.usage(), deviceAt, table, deepseek: this.src.deepseekRows(deviceAt),
          billing: this.src.billing(), activity, now, dataDir: this.src.dataDir
        });
        dims = ["runtime", "app", "device"];
        notes.push("费用单位为美元，是估算而非账单：Pi 按 DeepSeek 官方单价（含平台自身调用）；Claude Code / Codex 按订阅月费摊到每天，今天只算已过去的小时。",
          "token 含缓存读写。Codex 只提供会话累计值、没有每次请求的时间，不能分到某一天，所以没有 token 趋势。");
        if (partial) notes.push("有部分费用暂缺（汇率不可用或含未知单价的模型），合计偏低。");
      }
      notes.push("发起端从该功能上线后才开始记录：记录开始之前的是「未知」，记录开始之后无人发起的（定时任务、额度恢复等）是「自动」。");
    }
    const result: StatsResult = { domain, timeZone: PLATFORM_TIME_ZONE, generatedAt: now.toISOString(), from, to, days: table.rows(), dims, notes };
    if (this.cache.size > 24) this.cache.clear();
    this.cache.set(key, result);
    return result;
  }
}

