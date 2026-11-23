/**
 * runtime 组件版本更新（docs/requirements/runtime-version-updates）：
 * 1. 每天北京时间 09:00 检测 Pi / Claude Code（Agent SDK）/ Codex 有没有新的稳定版；启动时距上次成功检测超过 26 小时就补一次；设置页可手动检测。
 * 2. 发现新版：列出新增功能（从更新日志提炼，不调用模型）、破坏性变更、完整更新记录；设置入口出现红点。
 * 3. 人点「分析」才调用一次模型，生成「值不值得升级 / 风险 / 要兼容的」报告。
 * 4. Pi 与 Claude Code 点「升级」由对方 runtime 开会话执行（upgrade-plan.ts）；Codex 随 ChatGPT.app 更新，平台不动它。升级后检测会发现已装版本变了，记进升级记录。
 */
import { randomUUID } from "node:crypto";
import type { ModelInvocationPort } from "@pi-agent/model-port";
import { nextBeijingRunAt } from "../platform-time.js";
import { dailyBeijingSchedule, registerPlatformScheduledTask } from "../platform-scheduled-tasks.js";
import { analyzeUpdate, releaseNotesInput, type AnalysisValue } from "./analysis.js";
import { buildUpgradePlan, UPGRADE_EXECUTOR, type UpgradePlan } from "./upgrade-plan.js";
import { fetchSource, SOURCES, UPDATE_KINDS, type FetchText, type UpdateKind } from "./sources.js";
import { RuntimeUpdatesStore, type AnalysisRecord, type CheckRecord, type CheckTrigger, type InstallLogEntry, type ReleaseRecord } from "./store.js";
import { compareVersions, summarizeNotes, type NoteSummary } from "./versions.js";

export const SCHEDULE_HOUR = 9;
export const SCHEDULE_MINUTE = 0;
/** 两个槽位共用台账：距上次成功检测不足这个间隔就跳过（手动检测不受限）。 */
export const MIN_INTERVAL_MS = 20 * 3_600_000;
const OVERVIEW_RELEASES = 15;
const OVERVIEW_NOTES = 3_000;

export interface RuntimeUpdatesOptions {
  dir: string;
  /** 平台现在装的版本（来自 runtime 检查缓存）；读不到的 runtime 返回 undefined */
  installed: () => Partial<Record<UpdateKind, string | undefined>>;
  port?: ModelInvocationPort;
  fetchText?: FetchText;
  githubToken?: string;
  /** pi-agent 主仓库路径：升级会话的工作目录 */
  repo?: () => string | undefined;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface UpgradeGuide { command?: string; steps: string[]; note?: string }
export interface ReleaseView { version: string; publishedAt?: string; url?: string; firstSeenAt: string; notes: string; summary: NoteSummary; installed: boolean }
export interface RuntimeUpdateView {
  kind: UpdateKind; label: string; homepage: string;
  installed: string | null; latest: string | null; hasUpdate: boolean; ignored: boolean; alert: boolean;
  checkedAt: string | null; error: string | null;
  /** pending 只带最新 15 版；pendingCount 是实际落后的版本数 */
  pendingCount: number; pending: ReleaseView[]; history: ReleaseView[];
  /** 新增功能 / 破坏性变更：把所有待升级版本的提炼合在一起 */
  highlights: NoteSummary;
  analysis: (AnalysisRecord & { stale: boolean }) | null;
  guide: UpgradeGuide;
}
export interface RuntimeUpdatesOverview {
  scheduleHour: number; scheduleMinute: number; nextRunAt: string; running: boolean; analyzing: UpdateKind[];
  alertCount: number; lastCheckAt: string | null;
  runtimes: RuntimeUpdateView[]; installLog: InstallLogEntry[]; checks: CheckRecord[];
}

/** 升级步骤与命令：卡片里展示；Pi / Claude 点「升级」由另一个 runtime 的会话照这些步骤执行，Codex 只能更新 ChatGPT.app。 */
export function upgradeGuide(kind: UpdateKind, latest: string): UpgradeGuide {
  if (kind === "pi") return {
    command: `npm i -g @earendil-works/pi-coding-agent@${latest}`,
    steps: [
      `先在临时前缀试装：npm i -g --prefix /tmp/pi-${latest} @earendil-works/pi-coding-agent@${latest}`,
      `用候选版跑兼容测试：PI_BIN=/tmp/pi-${latest}/bin/pi PATH=/tmp/pi-${latest}/bin:$PATH PI_SANDBOX_PARITY=1 npx vitest run packages/runtime-sessions/test/pi-sandbox-parity-live.test.ts tests/replay/pi-replay-capture.test.ts，再跑全量测试`,
      "确认 dist/core/agent-session.js、dist/cli/args.js、dist/modes/rpc/rpc-types.d.ts 还在，探针标记没变",
      `通过后再替换全局版本：npm i -g @earendil-works/pi-coding-agent@${latest}`,
      "到「运行时配置」点「检查」，确认 Pi 版本与能力无变化；Pi 评测资格需要重新验收"
    ]
  };
  if (kind === "claude-code") return {
    command: `npm i -E @anthropic-ai/claude-agent-sdk@${latest} -w @pi-agent/runtime-sessions`,
    steps: [
      `在新会话 / 工作树里把 packages/runtime-sessions/package.json 的 @anthropic-ai/claude-agent-sdk 改为 ${latest}（精确版本号）并 npm install`,
      "对照更新日志里的 Breaking 条目检查 claude.ts 的 query 选项、hooks 与消息帧处理",
      "跑 runtime-sessions 测试与 Claude 的真实会话冒烟（含插话），再走部署（有进行中的外部会话会阻塞普通部署）",
      "部署后到「运行时配置」点「检查」，确认 SDK 与 CLI 版本"
    ],
    note: "Claude 随平台依赖升级，不是单独安装的程序，所以需要一次代码改动和部署。"
  };
  return {
    steps: [
      "Codex 使用 ChatGPT.app 内置的 CLI，更新 ChatGPT.app 即可带上新版；它常常是比稳定版更新的 alpha，已装版本不低于最新稳定版时不用动",
      "如果想固定在某个稳定版：单独安装 Codex CLI，并用环境变量 PI_AGENT_CODEX_BIN 指向它",
      "升级后到「运行时配置」点「检查」，确认 app-server 能力探针全部通过"
    ],
    note: "Codex 跟随 ChatGPT.app（Codex 桌面版）一起升级，平台不会操作它。"
  };
}

const releaseView = (r: ReleaseRecord, installed: boolean, notesLimit: number): ReleaseView => ({
  version: r.version, ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}), ...(r.url ? { url: r.url } : {}), firstSeenAt: r.firstSeenAt,
  notes: r.notes.slice(0, notesLimit), summary: summarizeNotes(r.notes), installed
});

export class RuntimeUpdatesService {
  readonly store: RuntimeUpdatesStore;
  private readonly now: () => Date;
  private running = false;
  private readonly analyzing = new Set<UpdateKind>();

  constructor(private readonly options: RuntimeUpdatesOptions) {
    this.now = options.now ?? (() => new Date());
    this.store = new RuntimeUpdatesStore({ dir: options.dir });
  }

  private fetchText(): FetchText {
    // 公网偶发连接失败（fetch failed / 超时）：重试两次再放弃；HTTP 错误状态（403 限流等）不重试
    return this.options.fetchText ?? (async (url, init) => {
      let last: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const res = await fetch(url, { ...(init?.headers ? { headers: init.headers } : {}), signal: AbortSignal.timeout(45_000) });
          const body = await res.text();
          return { ok: res.ok, status: res.status, text: async () => body };
        } catch (error) {
          last = error;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 1_000 * attempt));
        }
      }
      const cause = (last as { cause?: { code?: string; message?: string } })?.cause;
      throw new Error(`${new URL(url).host} 连接失败：${cause?.code ?? cause?.message ?? (last as Error)?.message ?? "未知错误"}`);
    });
  }

  isFresh(): boolean {
    const last = this.store.lastFinishedAt();
    return last > 0 && this.now().getTime() - last < MIN_INTERVAL_MS;
  }

  /** 平台观察到的已装版本和台账里不一样：记一条升级记录（第一次看到就记作基线）。 */
  private syncInstalled(): void {
    const installed = this.options.installed();
    const at = this.now().toISOString();
    let changed = false;
    for (const kind of UPDATE_KINDS) {
      const now = installed[kind];
      if (!now) continue;
      const rec = (this.store.state.runtimes[kind] ??= { releases: [] });
      if (rec.installed === now) continue;
      this.store.state.installLog.push({ kind, ...(rec.installed ? { from: rec.installed } : {}), to: now, at });
      rec.installed = now; changed = true;
    }
    if (changed) this.store.save();
  }

  async check(trigger: CheckTrigger): Promise<CheckRecord> {
    const record: CheckRecord = { id: randomUUID(), trigger, status: "running", startedAt: this.now().toISOString(), found: [], errors: [] };
    this.running = true;
    this.store.state.checks.push(record);
    this.store.save();
    try {
      this.syncInstalled();
      const results = await Promise.allSettled(UPDATE_KINDS.map((k) => fetchSource(k, this.fetchText(), this.options.githubToken)));
      const at = this.now().toISOString();
      const installed = this.options.installed();
      results.forEach((result, i) => {
        const kind = UPDATE_KINDS[i]!;
        const rec = (this.store.state.runtimes[kind] ??= { releases: [] });
        rec.checkedAt = at;
        if (result.status === "rejected") {
          const error = (result.reason as Error)?.message || "检测失败";
          rec.error = error; record.errors.push({ kind, error }); return;
        }
        delete rec.error;
        const known = new Map(rec.releases.map((r) => [r.version, r]));
        const had = rec.releases.length > 0;
        rec.latest = result.value.latest;
        // 累积：这次没读到的旧版本（Codex 只能读到近期的稳定版）继续留着，更新记录才会越积越全
        const merged = new Map(rec.releases.map((r) => [r.version, r]));
        for (const r of result.value.releases) merged.set(r.version, { ...r, firstSeenAt: known.get(r.version)?.firstSeenAt ?? at });
        rec.releases = [...merged.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, 80);
        const inst = installed[kind];
        for (const r of rec.releases) {
          if (known.has(r.version) || (inst && compareVersions(r.version, inst) <= 0)) continue;
          if (had) record.found.push({ kind, version: r.version });
        }
      });
      // 全部失败才算这次检测失败；部分失败仍记 ok，错误挂在各 runtime 上
      record.status = record.errors.length === UPDATE_KINDS.length ? "failed" : "ok";
    } catch (error) {
      record.status = "failed";
      record.errors.push({ kind: "pi", error: (error as Error).message });
    } finally {
      record.finishedAt = this.now().toISOString();
      this.running = false;
      this.store.save();
    }
    if (record.found.length) this.options.log?.(`runtime 新稳定版：${record.found.map((f) => `${f.kind} ${f.version}`).join("、")}`);
    for (const e of record.errors) this.options.log?.(`runtime 版本检测失败（${e.kind}）：${e.error}`);
    return record;
  }

  start(trigger: CheckTrigger = "manual"): { done: Promise<CheckRecord> } | { skipped: "running" } {
    if (this.running) return { skipped: "running" };
    this.running = true;
    const done = this.check(trigger).finally(() => { this.running = false; });
    return { done };
  }

  private pendingOf(kind: UpdateKind): { installed?: string; latest?: string; pending: ReleaseRecord[]; all: ReleaseRecord[] } {
    const rec = this.store.state.runtimes[kind];
    const installed = this.options.installed()[kind] ?? rec?.installed;
    const all = rec?.releases ?? [];
    const pending = installed && rec?.latest && compareVersions(rec.latest, installed) > 0 ? all.filter((r) => compareVersions(r.version, installed) > 0) : [];
    return { ...(installed ? { installed } : {}), ...(rec?.latest ? { latest: rec.latest } : {}), pending, all };
  }

  /** 设置入口红点与会话外提示用：有几个 runtime 有没被忽略的新稳定版。 */
  summary(): { alertCount: number; items: Array<{ kind: UpdateKind; label: string; installed: string; latest: string }> } {
    const items = UPDATE_KINDS.flatMap((kind) => {
      const { installed, latest, pending } = this.pendingOf(kind);
      if (!installed || !latest || !pending.length || this.store.state.runtimes[kind]?.ignored === latest) return [];
      return [{ kind, label: SOURCES[kind].label, installed, latest }];
    });
    return { alertCount: items.length, items };
  }

  overview(): RuntimeUpdatesOverview {
    const runtimes = UPDATE_KINDS.map((kind): RuntimeUpdateView => {
      const rec = this.store.state.runtimes[kind];
      const { installed, latest, pending, all } = this.pendingOf(kind);
      const ignored = !!latest && rec?.ignored === latest;
      const analysisRec = this.store.state.analyses[kind];
      const features: string[] = [], breaking: string[] = [];
      for (const r of pending) { const s = summarizeNotes(r.notes); features.push(...s.features.map((f) => `${r.version}：${f}`)); breaking.push(...s.breaking.map((b) => `${r.version}：${b}`)); }
      const history = all.filter((r) => !pending.includes(r)).slice(0, 8);
      return {
        kind, label: SOURCES[kind].label, homepage: SOURCES[kind].homepage,
        installed: installed ?? null, latest: latest ?? null, hasUpdate: pending.length > 0, ignored, alert: pending.length > 0 && !ignored,
        checkedAt: rec?.checkedAt ?? null, error: rec?.error ?? null,
        pendingCount: pending.length, pending: pending.slice(0, OVERVIEW_RELEASES).map((r) => releaseView(r, false, OVERVIEW_NOTES)),
        history: history.map((r) => releaseView(r, true, OVERVIEW_NOTES)),
        highlights: { features: features.slice(0, 12), breaking: breaking.slice(0, 8) },
        analysis: analysisRec ? { ...analysisRec, stale: !(installed === analysisRec.installed && latest === analysisRec.latest && releaseNotesInput(pending).hash === analysisRec.notesHash) } : null,
        guide: upgradeGuide(kind, latest ?? "<最新版>")
      };
    });
    const checks = this.store.state.checks;
    const lastOk = [...checks].reverse().find((c) => c.status !== "running");
    return {
      scheduleHour: SCHEDULE_HOUR, scheduleMinute: SCHEDULE_MINUTE,
      nextRunAt: nextBeijingRunAt(this.now(), SCHEDULE_HOUR, SCHEDULE_MINUTE).toISOString(),
      running: this.running || checks.some((c) => c.status === "running" && this.now().getTime() - Date.parse(c.startedAt) < 10 * 60_000),
      analyzing: [...this.analyzing], alertCount: runtimes.filter((r) => r.alert).length, lastCheckAt: lastOk?.finishedAt ?? null,
      runtimes, installLog: this.store.state.installLog.slice(-20).reverse(), checks: checks.slice(-10).reverse()
    };
  }

  /** 人点「分析」：已有同一批版本的报告直接返回（force 才重新生成）。 */
  async analyze(kind: UpdateKind, force = false): Promise<{ ok: true; analysis: AnalysisRecord; cached: boolean } | { ok: false; code: string; error: string }> {
    const { installed, latest, pending } = this.pendingOf(kind);
    if (!installed || !latest || !pending.length) return { ok: false, code: "NO_UPDATE", error: "这个 runtime 目前没有可分析的新稳定版" };
    const notes = releaseNotesInput(pending);
    const cached = this.store.state.analyses[kind];
    if (!force && cached && cached.installed === installed && cached.latest === latest && cached.notesHash === notes.hash) return { ok: true, analysis: cached, cached: true };
    if (this.analyzing.has(kind)) return { ok: false, code: "ANALYZING", error: "正在分析，稍等一下" };
    this.analyzing.add(kind);
    try {
      const result = await analyzeUpdate({ port: this.options.port, kind, installed, latest, pending, now: this.now });
      if (!result.ok) return { ok: false, code: "ANALYSIS_FAILED", error: result.error };
      const analysis: AnalysisRecord = { kind, installed, latest, notesHash: notes.hash, at: this.now().toISOString(), costUsd: result.costUsd, ...(result.model ? { model: result.model } : {}), value: result.value as AnalysisValue };
      this.store.state.analyses[kind] = analysis;
      this.store.save();
      return { ok: true, analysis, cached: false };
    } finally { this.analyzing.delete(kind); }
  }

  /** 点「升级」：生成由另一个 runtime 执行的会话方案（调用方再走新建会话流程）。 */
  upgradePlan(kind: UpdateKind): { ok: true; plan: UpgradePlan } | { ok: false; code: string; error: string } {
    if (kind === "codex" || !UPGRADE_EXECUTOR[kind]) return { ok: false, code: "MANUAL_ONLY", error: "Codex 跟随 ChatGPT.app（Codex 桌面版）升级，平台不替你操作" };
    const { installed, latest, pending } = this.pendingOf(kind);
    if (!installed || !latest || !pending.length) return { ok: false, code: "NO_UPDATE", error: "这个 runtime 目前没有可升级的新稳定版" };
    const workspace = this.options.repo?.();
    if (!workspace) return { ok: false, code: "NO_REPO", error: "找不到 pi-agent 主仓库路径（可设环境变量 PI_AGENT_REPO）" };
    const analysis = this.store.state.analyses[kind] ?? null;
    const breaking: string[] = [];
    for (const r of pending) breaking.push(...summarizeNotes(r.notes).breaking.map((b) => `${r.version}：${b}`));
    return { ok: true, plan: buildUpgradePlan({ target: kind, from: installed, to: latest, workspace, analysis, breaking: breaking.slice(0, 12) }) };
  }

  /** 忽略当前最新版：红点与提示熄灭，直到出现更新的稳定版。 */
  ignore(kind: UpdateKind, undo = false): boolean {
    const rec = this.store.state.runtimes[kind];
    if (!rec?.latest) return false;
    if (undo) delete rec.ignored; else rec.ignored = rec.latest;
    this.store.save();
    return true;
  }
}

export function startRuntimeUpdatesScheduler(options: { service: RuntimeUpdatesService; log?: (message: string) => void; now?: () => Date; catchUpDelayMs?: number }): () => void {
  const now = options.now ?? (() => new Date());
  registerPlatformScheduledTask({
    id: "runtime-updates-daily", app: "平台", scene: "版本", name: "runtime 新版本检测",
    schedule: dailyBeijingSchedule(SCHEDULE_HOUR, SCHEDULE_MINUTE), source: "apps/web/src/runtime-updates/service.ts",
    description: "每天检测 Pi、Claude Code、Codex 有没有新的稳定版，有就在设置里提示；不会自动升级"
  });
  let timer: NodeJS.Timeout | undefined, catchUp: NodeJS.Timeout | undefined, stopped = false;
  const fire = async (trigger: CheckTrigger) => {
    try {
      if (options.service.isFresh()) return;
      const started = options.service.start(trigger);
      if ("done" in started) await started.done;
    } catch (error) { options.log?.(`runtime 版本检测失败：${(error as Error).message}`); }
  };
  const schedule = () => {
    if (stopped) return;
    const at = nextBeijingRunAt(now(), SCHEDULE_HOUR, SCHEDULE_MINUTE);
    timer = setTimeout(() => { void fire("schedule").finally(schedule); }, Math.max(1_000, at.getTime() - now().getTime()));
    timer.unref?.();
  };
  if (now().getTime() - options.service.store.lastFinishedAt() > 26 * 3_600_000) {
    catchUp = setTimeout(() => { void fire("catch-up"); }, Math.max(1, options.catchUpDelayMs ?? 5 * 60_000));
    catchUp.unref?.();
  }
  schedule();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(catchUp); };
}
