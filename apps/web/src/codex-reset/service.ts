/**
 * 每晚扫描 Codex 的 reset 卡（docs/requirements/codex-reset-nightly）：
 * 1. 拉一次「现在有几张可用」+「最近 30 天发放 / 使用流水」；
 * 2. 并进本地台账（后端只有 30 天窗口，长期统计靠自己沉淀）；
 * 3. 首页 / 设置页展示：可用张数、过去 7 天用了几张、最近一次使用时间、扫描历史。
 *
 * 时间一律按北京时间（UTC+8）：每晚 23:30 跑一次，服务在那之后才启动的话启动 5 分钟后补一次。
 * 两个槽位（蓝绿）共用一个台账文件：靠「距上次成功扫描不足 20 小时就跳过」避免重复扫，
 * 手动「立即扫描」不受这个限制。
 */
import { randomUUID } from "node:crypto";
import { beijingStamp, nextBeijingRunAt } from "../platform-time.js";
import { dailyBeijingSchedule, registerPlatformScheduledTask } from "../platform-scheduled-tasks.js";
import { CodexResetFetchError, codexAuthPath, collectResetSnapshot, collectAvailableCredits, readCodexAuth, windowStats, type FetchJson, type LedgerStats, type ResetCredit } from "./collect.js";
import { CodexResetStore, type LatestSnapshot, type ScanRecord, type ScanTrigger } from "./store.js";

export const SCHEDULE_HOUR = 23;
export const SCHEDULE_MINUTE = 30;
/** 两个槽位共用台账：距上次成功扫描不足这个间隔就跳过（手动扫描不受限）。 */
export const MIN_INTERVAL_MS = 20 * 3_600_000;

export interface CodexResetAuth {
  path: string;
  /** 读到了 chatgpt 登录态 */
  ok: boolean;
  expiresAt: string | null;
}

export interface CodexResetOverview {
  scheduleHour: number;
  scheduleMinute: number;
  nextRunAt: string | null;
  running: boolean;
  lastScanAt: string | null;
  availableCount: number;
  credits: ResetCredit[];
  stats: LedgerStats;
  auth: CodexResetAuth;
  scans: ScanRecord[];
  error: string | null;
}

export interface CodexResetServiceOptions {
  dir: string;
  authPath?: string;
  fetchImpl?: FetchJson;
  now?: () => Date;
  log?: (message: string) => void;
  /** 测试注入：默认走真实接口 */
  collect?: typeof collectResetSnapshot;
  collectAvailable?: typeof collectAvailableCredits;
}

export class CodexResetService {
  readonly store: CodexResetStore;
  private readonly options: CodexResetServiceOptions;
  private readonly now: () => Date;
  private running = false;
  private badgeRefresh: Promise<void> | null = null;
  private badgeRetryAt = 0;
  private lastError: string | null = null;

  constructor(options: CodexResetServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.store = new CodexResetStore({ dir: options.dir });
  }

  authPath(): string { return this.options.authPath ?? codexAuthPath(); }

  auth(): CodexResetAuth {
    const path = this.authPath();
    const auth = readCodexAuth(path);
    return { path, ok: !!auth, expiresAt: auth?.expiresAtMs ? new Date(auth.expiresAtMs).toISOString() : null };
  }

  /** 距上次成功扫描不足 20 小时就跳过（蓝绿两个槽位不会各扫一遍）。 */
  isFresh(): boolean {
    const last = this.store.lastFinishedAt();
    return last > 0 && this.now().getTime() - last < MIN_INTERVAL_MS;
  }

  /** 跑一轮扫描；同一进程里不允许并发。失败也落一条 failed 记录，页面能看到原因。 */
  async scan(trigger: ScanTrigger): Promise<ScanRecord> {
    const startedAt = this.now().toISOString();
    const record: ScanRecord = { id: randomUUID(), trigger, status: "running", startedAt, newGranted: [], newUsed: [] };
    this.running = true;
    this.store.append(record);
    try {
      const collect = this.options.collect ?? collectResetSnapshot;
      const snapshot = await collect({
        authPath: this.authPath(),
        now: this.now,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
      });
      const { newGranted, newUsed } = this.store.mergeEvents(snapshot.events);
      const latest: LatestSnapshot = {
        at: snapshot.at,
        availableCount: snapshot.availableCount,
        totalEarnedCount: snapshot.totalEarnedCount,
        credits: snapshot.credits,
        historyWindowStart: snapshot.historyWindowStart
      };
      this.store.setLatest(latest);
      const done: ScanRecord = {
        ...record,
        status: "ok",
        finishedAt: this.now().toISOString(),
        availableCount: snapshot.availableCount,
        newGranted,
        newUsed
      };
      this.store.append(done);
      this.lastError = null;
      if (newGranted.length || newUsed.length) {
        this.options.log?.(`Codex reset：新发放 ${newGranted.length} 张，新使用 ${newUsed.length} 张，现在可用 ${snapshot.availableCount} 张`);
      }
      return done;
    } catch (error) {
      const message = error instanceof CodexResetFetchError ? error.message : (error as Error).message || "扫描失败";
      const failed: ScanRecord = { ...record, status: "failed", finishedAt: this.now().toISOString(), error: message };
      this.store.append(failed);
      this.lastError = message;
      this.options.log?.(`Codex reset 扫描失败：${message}`);
      return failed;
    } finally {
      this.running = false;
    }
  }

  /** 手动触发：已有一轮在跑就拒绝，不叠加。 */
  start(trigger: ScanTrigger = "manual"): { done: Promise<ScanRecord> } | { skipped: "running" } {
    if (this.running) return { skipped: "running" };
    this.running = true;
    const done = this.scan(trigger).finally(() => { this.running = false; });
    return { done };
  }

  overview(): CodexResetOverview {
    const latest = this.store.state.latest;
    const lastScan = [...this.store.state.scans].reverse().find((scan) => scan.status !== "running");
    return {
      scheduleHour: SCHEDULE_HOUR,
      scheduleMinute: SCHEDULE_MINUTE,
      nextRunAt: nextBeijingRunAt(this.now(), SCHEDULE_HOUR, SCHEDULE_MINUTE).toISOString(),
      running: this.running || this.store.hasRunning(),
      lastScanAt: lastScan?.finishedAt ?? latest?.at ?? null,
      availableCount: latest?.availableCount ?? 0,
      credits: latest?.credits ?? [],
      stats: windowStats(this.store.state.ledger, this.now()),
      auth: this.auth(),
      scans: this.store.state.scans.slice(-12).reverse(),
      error: this.lastError
    };
  }

  /** 跟随额度更新卡数；并发合并，失败保留最后快照并允许后续重试。 */
  async refreshBadge(): Promise<void> {
    if (this.badgeRefresh) return this.badgeRefresh;
    if (this.now().getTime() < this.badgeRetryAt) return;
    this.badgeRefresh = (async () => {
      try {
        const available = await (this.options.collectAvailable ?? collectAvailableCredits)({
          authPath: this.authPath(), now: this.now,
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
        });
        this.store.setLatest({
          ...available, at: this.now().toISOString(),
          historyWindowStart: this.store.state.latest?.historyWindowStart ?? null
        });
        this.store.save();
        this.badgeRetryAt = this.now().getTime() + 60_000;
      } catch {
        this.badgeRetryAt = this.now().getTime() + 15_000;
      }
    })().finally(() => { this.badgeRefresh = null; });
    return this.badgeRefresh;
  }

  /** 勾在额度组件右上角用的小结：只要张数与最近一张过期时刻（不含任何卡片明细）。 */
  badge(): { availableCount: number; soonestExpiry: string | null } {
    const latest = this.store.state.latest;
    const now = this.now().getTime();
    const valid = (latest?.credits ?? []).filter((c) => (c.status || "available") === "available" && (!c.expiresAt || Date.parse(c.expiresAt) > now));
    const expiries = valid.map((c) => c.expiresAt).filter((v): v is string => !!v).sort();
    return {
      availableCount: latest?.availableCount === 0 ? 0 : latest?.credits.length ? valid.length : latest?.availableCount ?? 0,
      soonestExpiry: expiries[0] ?? null
    };
  }

  /** 「过去 7 天用了几张」这类问题的一句话摘要（北京时间）。 */
  summary(): string {
    const data = this.overview();
    const last = data.stats.lastUsedAt ? beijingStamp(data.stats.lastUsedAt) : "没有记录";
    return `可用 ${data.availableCount} 张；过去 7 天用掉 ${data.stats.used7d} 张（最近一次 ${last}）`;
  }
}

/**
 * 每晚 23:30（北京时间）扫一次；服务启动时距上次成功扫描超过 26 小时就补一次。
 * 定时器 unref，不影响进程退出。
 */
export function startCodexResetScheduler(options: {
  service: CodexResetService;
  log?: (message: string) => void;
  now?: () => Date;
  catchUpDelayMs?: number;
}): () => void {
  const now = options.now ?? (() => new Date());
  registerPlatformScheduledTask({
    id: "codex-reset-nightly",
    app: "平台",
    scene: "用量",
    name: "Codex reset 夜间扫描",
    schedule: dailyBeijingSchedule(SCHEDULE_HOUR, SCHEDULE_MINUTE),
    source: "apps/web/src/codex-reset/service.ts",
    description: "每晚抓一次 Codex 的 reset 卡发放与使用情况，写进平台台账"
  });
  let timer: NodeJS.Timeout | undefined, catchUp: NodeJS.Timeout | undefined, stopped = false;
  const fire = async (trigger: ScanTrigger) => {
    try {
      if (trigger !== "manual" && options.service.isFresh()) return;
      await options.service.scan(trigger);
    } catch (error) {
      options.log?.(`Codex reset 定时扫描失败：${(error as Error).message}`);
    }
  };
  const schedule = () => {
    if (stopped) return;
    const at = nextBeijingRunAt(now(), SCHEDULE_HOUR, SCHEDULE_MINUTE);
    timer = setTimeout(() => { void fire("schedule").finally(schedule); }, Math.max(1_000, at.getTime() - now().getTime()));
    timer.unref?.();
  };
  if (now().getTime() - options.service.store.lastFinishedAt() > 26 * 3_600_000) {
    const delay = Math.max(1_000, options.catchUpDelayMs ?? 5 * 60_000);
    catchUp = setTimeout(() => { void fire("catch-up"); }, delay);
    catchUp.unref?.();
  }
  schedule();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(catchUp); };
}
