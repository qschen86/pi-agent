/**
 * runtime 组件版本更新（docs/requirements/runtime-version-updates）：
 * 1. 每天北京时间 09:00 检测 Pi / Claude Code（Agent SDK）/ Codex / Antigravity（agy）有没有新的稳定版（不含 alpha / beta / rc）；启动时距上次成功检测超过 26 小时就补一次；设置页可手动检测。
 * 2. 发现新版：列出新增功能（从更新日志提炼，不调用模型）、破坏性变更、完整更新记录；设置入口出现红点。
 * 3. 每次检测到更新后自动跑一次「值不值得升级 / 风险 / 要兼容的」报告（同一批版本只跑一次），人也可以重新分析。
 * 4. 落后超过 10 个稳定版、结论是建议升级、没有高风险时，安排北京时间夜间（03:00–05:30）自动升级 Pi / Antigravity；Claude Code 带部署不自动升，Codex 随 ChatGPT.app 更新。
 * 5. 升级由另一个 runtime 开一个会话来执行（upgrade-plan.ts），人点「升级」或自动夜里执行的是同一份方案。
 */
import { randomUUID } from "node:crypto";
import type { ModelInvocationPort } from "@pi-agent/model-port";
import { beijingParts, beijingRunToday, nextBeijingRunAt } from "../platform-time.js";
import { dailyBeijingSchedule, registerPlatformScheduledTask } from "../platform-scheduled-tasks.js";
import { analyzeUpdate, releaseNotesInput, type AnalysisValue } from "./analysis.js";
import { buildUpgradePlan, UPGRADE_EXECUTOR, type UpgradePlan } from "./upgrade-plan.js";
import { fetchSource, SOURCES, UPDATE_KINDS, type FetchText, type UpdateKind } from "./sources.js";
import { RuntimeUpdatesStore, type AnalysisRecord, type AnalysisTrigger, type AutoUpgradeEntry, type CheckRecord, type CheckTrigger, type InstallLogEntry, type ReleaseRecord } from "./store.js";
import { compareVersions, summarizeNotes, type NoteSummary } from "./versions.js";

export const SCHEDULE_HOUR = 9;
export const SCHEDULE_MINUTE = 0;
/** 两个槽位共用台账：距上次成功检测不足这个间隔就跳过（手动检测不受限）。 */
export const MIN_INTERVAL_MS = 20 * 3_600_000;
/** 「落后超过 10 个稳定版」才考虑自动升级 */
export const AUTO_UPGRADE_THRESHOLD = 10;
/** 自动升级只碰这两个：Claude Code 每次升级都带一次部署，交给人工决定；Codex 跟随 ChatGPT.app。 */
export const AUTO_UPGRADE_KINDS: UpdateKind[] = ["pi", "antigravity"];
/** 夜间窗口：北京时间 03:00 开始，05:30 前还没空闲就顺延到第二天 */
export const AUTO_UPGRADE_HOUR = 3;
export const AUTO_UPGRADE_WINDOW_END_MINUTE = 5 * 60 + 30;
const OVERVIEW_RELEASES = 15;
const OVERVIEW_NOTES = 3_000;

export interface RuntimeUpdatesOptions {
  dir: string;
  /** 平台现在装的版本（来自 runtime 检查缓存）；读不到的 runtime 返回 undefined */
  installed: () => Partial<Record<UpdateKind, string | undefined>>;
  port?: ModelInvocationPort;
  fetchText?: FetchText;
  githubToken?: string;
  /** 已装 agy 的 `agy changelog` 输出（离线、与已装版本同源）；不接就只读公开页 */
  agyChangelog?: () => Promise<string>;
  /** pi-agent 主仓库路径：升级会话的工作目录 */
  repo?: () => string | undefined;
  /** 夜间自动升级前研判「现在有没有会话在跑」；不接就当永远忙、不自动升级 */
  isIdle?: () => Promise<boolean>;
  /** 夜间自动升级：按方案真的开一个会话；不接就只提示、不自动升级 */
  createUpgradeSession?: (plan: UpgradePlan) => Promise<{ sessionId?: string }>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface UpgradeGuide { command?: string; steps: string[]; note?: string }
export interface ReleaseView { version: string; publishedAt?: string; url?: string; firstSeenAt: string; notes: string; summary: NoteSummary; installed: boolean }
/** 自动夜间升级在这一页上的状态：能不能自动升、为什么不能、排在什么时候。 */
export interface AutoUpgradeView {
  threshold: number;
  /** 排过的安排（同一目标版本只排一次） */
  entry: Pick<AutoUpgradeEntry, "status" | "at" | "from" | "to" | "note" | "sessionId" | "postponed"> | null;
  /** 现在还不满足自动升级的全部原因（人话） */
  blocked: string[];
}
export interface RuntimeUpdateView {
  kind: UpdateKind; label: string; homepage: string;
  installed: string | null; latest: string | null; hasUpdate: boolean; ignored: boolean; alert: boolean;
  checkedAt: string | null; error: string | null;
  /** pending 只带最新 15 版；pendingCount 是实际落后的版本数 */
  pendingCount: number; pending: ReleaseView[]; history: ReleaseView[];
  /** 新增功能 / 破坏性变更：把所有待升级版本的提炼合在一起 */
  highlights: NoteSummary;
  analysis: (AnalysisRecord & { stale: boolean }) | null;
  /** 正在自动 / 手动分析这一版 */
  analyzing: boolean;
  /** 上一次分析失败的原因（成功一次就清掉） */
  analysisError: string | null;
  autoUpgrade: AutoUpgradeView;
  guide: UpgradeGuide;
}
export interface RuntimeUpdatesOverview {
  scheduleHour: number; scheduleMinute: number; nextRunAt: string; running: boolean; analyzing: UpdateKind[];
  alertCount: number; lastCheckAt: string | null;
  autoUpgrade: {
    enabled: boolean; threshold: number; startHour: number; windowEndMinute: number;
    kinds: UpdateKind[]; nextWindowAt: string;
    entries: Array<AutoUpgradeEntry & { label: string }>;
  };
  runtimes: RuntimeUpdateView[]; installLog: InstallLogEntry[]; checks: CheckRecord[];
}

/** 升级步骤与命令：卡片里展示；Pi / Claude / Antigravity 点「升级」由另一个 runtime 的会话照这些步骤执行，Codex 只能更新 ChatGPT.app。 */
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
  if (kind === "antigravity") return {
    command: "agy update",
    steps: [
      "先备份现有二进制：cp -p ~/.local/bin/agy /tmp/agy-backup（路径以 which agy 为准）",
      "执行 agy update，再用 agy --version 核对版本",
      "跑探针与 Antigravity 相关测试：npx vitest run packages/runtime-sessions/test/antigravity.test.ts packages/runtime-sessions/test/antigravity-continuation.test.ts apps/web/test/runtime-antigravity-check.test.ts",
      "任何一步失败或版本不对，用 mv 把备份换回去（别原地 cp 覆盖），核对 agy --version 回到原版本",
      "到「运行时配置」点「检查」，确认 Antigravity 版本与能力无变化、额度（/usage）仍能读出"
    ],
    note: "Antigravity 是单个二进制，不走 npm；升级前后都不用部署，已在运行的 agy 进程不受影响，下一轮会话才用新版。"
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
  /** 后台分析任务：同一 runtime 同时只跑一个 */
  private readonly jobs = new Map<UpdateKind, Promise<void>>();
  /** 检测完自动排队的分析：串行，避免三个 runtime 同时打模型 */
  private autoChain: Promise<void> = Promise.resolve();

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

  /** 平台观察到的已装版本和台账里不一样：记一条升级记录（第一次看到就记作基线），并结掉自动升级安排。 */
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
      // 自动升级的会话执行完了：已装版本到了目标版本（或更新）就标完成
      for (const entry of this.store.state.autoUpgrades) {
        if (entry.kind !== kind || entry.status !== "started") continue;
        if (compareVersions(now, entry.to) < 0) continue;
        entry.status = "done"; entry.finishedAt = at; delete entry.note;
        this.options.log?.(`自动升级完成：${SOURCES[kind].label} ${entry.from} → ${now}`);
      }
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
      const results = await Promise.allSettled(UPDATE_KINDS.map((k) => fetchSource(k, this.fetchText(), this.options.githubToken, { ...(this.options.agyChangelog ? { agyChangelog: this.options.agyChangelog } : {}) })));
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
    // 每次检测到更新后自动做一次升级推荐分析（同一批版本已有报告就跳过）
    this.queueAutoAnalyses();
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

  /** 自动夜间升级：现在能不能自动升、还差什么（人话，给页面直接展示）。 */
  private autoUpgradeView(kind: UpdateKind): AutoUpgradeView {
    const { installed, latest, pending } = this.pendingOf(kind);
    const enabled = this.store.state.autoUpgrade.enabled;
    const entry = [...this.store.state.autoUpgrades].reverse().find((e) => e.kind === kind && latest && e.to === latest);
    const blocked: string[] = [];
    if (!enabled) blocked.push("自动夜间升级已关掉");
    if (!AUTO_UPGRADE_KINDS.includes(kind)) blocked.push(kind === "codex" ? "Codex 跟着桌面版更新，不自动升" : "Claude Code 升级要改代码并部署，不自动升");
    if (!installed || !latest) blocked.push("先检测一次，才知道已装版本");
    else {
      if (!pending.length) blocked.push("已经是最新稳定版");
      else if (pending.length <= AUTO_UPGRADE_THRESHOLD) blocked.push(`落后 ${pending.length} 个版本，没超过 ${AUTO_UPGRADE_THRESHOLD} 个`);
      const analysis = this.store.state.analyses[kind];
      const fresh = analysis && analysis.installed === installed && analysis.latest === latest && analysis.notesHash === releaseNotesInput(pending).hash;
      if (pending.length && !fresh) blocked.push(this.analyzing.has(kind) ? "还在分析，分析完才有结论" : "这一批版本还没有分析报告");
      else if (analysis) {
        if (analysis.value.verdict !== "upgrade") blocked.push(`分析结论是「${{ wait: "建议观望", skip: "暂不升级" }[analysis.value.verdict] ?? analysis.value.verdict}」`);
        if (analysis.value.risks.some((r) => r.severity === "high")) blocked.push("有高风险项");
        if (!analysis.value.benefits.some((b) => b.relevance === "high")) blocked.push("没有足够大的收益");
      }
    }
    if (entry && (entry.status === "scheduled" || entry.status === "started")) blocked.length = 0;
    else if (entry && entry.to === latest) {
      const doneNote: Record<string, string> = { done: "这个版本已经自动升过了", failed: "上次自动升级失败，这个版本需要你手动处理", cancelled: "这个版本的自动升级被取消了" };
      const note = doneNote[entry.status];
      if (note) blocked.push(note);
    }
    return {
      threshold: AUTO_UPGRADE_THRESHOLD,
      entry: entry ? { status: entry.status, at: entry.at, from: entry.from, to: entry.to, ...(entry.note ? { note: entry.note } : {}), ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), ...(entry.postponed ? { postponed: entry.postponed } : {}) } : null,
      blocked: [...new Set(blocked)]
    };
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
        analyzing: this.analyzing.has(kind),
        analysisError: rec?.analysisError ?? null,
        autoUpgrade: this.autoUpgradeView(kind),
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
      autoUpgrade: {
        enabled: this.store.state.autoUpgrade.enabled, threshold: AUTO_UPGRADE_THRESHOLD,
        startHour: AUTO_UPGRADE_HOUR, windowEndMinute: AUTO_UPGRADE_WINDOW_END_MINUTE, kinds: AUTO_UPGRADE_KINDS,
        nextWindowAt: nextBeijingRunAt(this.now(), AUTO_UPGRADE_HOUR, 0).toISOString(),
        entries: this.store.state.autoUpgrades.slice(-10).reverse().map((e) => ({ ...e, label: SOURCES[e.kind].label }))
      },
      runtimes, installLog: this.store.state.installLog.slice(-20).reverse(), checks: checks.slice(-10).reverse()
    };
  }

  /** 人点「分析」：已有同一批版本的报告直接返回（force 才重新生成）；后台跑，页面轮询看进度。 */
  startAnalyze(kind: UpdateKind, trigger: AnalysisTrigger = "manual", force = false): { ok: true; started: true; cached: false } | { ok: true; started: false; cached: true; analysis: AnalysisRecord } | { ok: false; code: string; error: string } {
    const { installed, latest, pending } = this.pendingOf(kind);
    if (!installed || !latest || !pending.length) return { ok: false, code: "NO_UPDATE", error: "这个 runtime 目前没有可分析的新稳定版" };
    const notes = releaseNotesInput(pending);
    const cached = this.store.state.analyses[kind];
    if (!force && cached && cached.installed === installed && cached.latest === latest && cached.notesHash === notes.hash) return { ok: true, started: false, cached: true, analysis: cached };
    if (this.analyzing.has(kind)) return { ok: false, code: "ANALYZING", error: "正在分析，稍等一下" };
    void this.runAnalyzeJob(kind, trigger);
    return { ok: true, started: true, cached: false };
  }

  /** 检测完自动分析：有待升级版本、且这一批还没有有效报告就排一次（串行，失败不重试）。 */
  private queueAutoAnalyses(): void {
    if (!this.options.port) return;
    for (const kind of UPDATE_KINDS) {
      if (this.analyzing.has(kind)) continue;
      const { installed, latest, pending } = this.pendingOf(kind);
      if (!installed || !latest || !pending.length) continue;
      const cached = this.store.state.analyses[kind];
      if (cached && cached.installed === installed && cached.latest === latest && cached.notesHash === releaseNotesInput(pending).hash) continue;
      this.autoChain = this.autoChain.then(() => this.runAnalyzeJob(kind, "auto")).catch(() => undefined);
    }
  }

  /** 后台分析一件：成功就存报告、排自动升级；失败把原因挂在该 runtime 上，不挡住检测。 */
  private async runAnalyzeJob(kind: UpdateKind, trigger: AnalysisTrigger): Promise<void> {
    if (this.analyzing.has(kind)) return;
    const existing = this.jobs.get(kind);
    if (existing) return existing;
    const job = (async () => {
      const { installed, latest, pending } = this.pendingOf(kind);
      if (!installed || !latest || !pending.length) return;
      const notes = releaseNotesInput(pending);
      const rec = (this.store.state.runtimes[kind] ??= { releases: [] });
      this.analyzing.add(kind);
      try {
        const result = await analyzeUpdate({ port: this.options.port, kind, installed, latest, pending, now: this.now });
        if (!result.ok) {
          rec.analysisError = result.error;
          this.options.log?.(`runtime 升级分析失败（${kind}）：${result.error}`);
          return;
        }
        const analysis: AnalysisRecord = { kind, installed, latest, notesHash: notes.hash, at: this.now().toISOString(), costUsd: result.costUsd, ...(result.model ? { model: result.model } : {}), trigger, value: result.value as AnalysisValue };
        this.store.state.analyses[kind] = analysis;
        delete rec.analysisError;
        this.store.save();
        this.options.log?.(`runtime 升级分析完成（${kind}，${trigger === "auto" ? "自动" : "手动"}）：${analysis.value.verdict}`);
        // 分析完成后按条件排自动夜间升级（已有安排就跳过）
        this.maybeScheduleAutoUpgrade(kind);
      } finally {
        this.analyzing.delete(kind);
        this.jobs.delete(kind);
      }
    })();
    this.jobs.set(kind, job);
    await job;
  }

  /** 等人 / 测试用：后台分析与自动升级的任务都跑完。 */
  async whenIdle(): Promise<void> {
    await this.autoChain;
    await Promise.allSettled([...this.jobs.values()]);
  }

  /** 「落后超过 10 个版本 + 收益够大 + 风险可控」→ 排到最近一个北京夜间窗口。 */
  private maybeScheduleAutoUpgrade(kind: UpdateKind): boolean {
    const state = this.store.state;
    if (!state.autoUpgrade.enabled || !AUTO_UPGRADE_KINDS.includes(kind)) return false;
    // 自动升级要真能开会话；没接上就当不自动
    if (!this.options.createUpgradeSession || !this.options.repo?.()) return false;
    const { installed, latest, pending } = this.pendingOf(kind);
    if (!installed || !latest || !pending.length || pending.length <= AUTO_UPGRADE_THRESHOLD) return false;
    const analysis = state.analyses[kind];
    if (!analysis || analysis.installed !== installed || analysis.latest !== latest || analysis.notesHash !== releaseNotesInput(pending).hash) return false;
    if (analysis.value.verdict !== "upgrade") return false;
    if (analysis.value.risks.some((r) => r.severity === "high")) return false;
    if (!analysis.value.benefits.some((b) => b.relevance === "high")) return false;
    // 同一个目标版本只排一次（升过、失败过、取消过都不再自动排）
    if (state.autoUpgrades.some((e) => e.kind === kind && e.to === latest)) return false;
    const at = nextBeijingRunAt(this.now(), AUTO_UPGRADE_HOUR, 0);
    state.autoUpgrades.push({ id: randomUUID(), kind, from: installed, to: latest, at: at.toISOString(), createdAt: this.now().toISOString(), status: "scheduled" });
    this.store.save();
    this.options.log?.(`已安排自动夜间升级：${SOURCES[kind].label} ${installed} → ${latest}（北京时间 ${at.toISOString()} 所在夜晚）`);
    return true;
  }

  /** 开关自动夜间升级；关掉时把还没开始的安排一起取消。 */
  setAutoUpgradeEnabled(enabled: boolean): void {
    this.store.state.autoUpgrade.enabled = enabled;
    // 关掉时把还没开始的安排一起取消；重新打开后按条件重新评估
    if (!enabled) for (const e of this.store.state.autoUpgrades) if (e.status === "scheduled") { e.status = "cancelled"; e.note = "自动夜间升级已关闭"; }
    this.store.save();
  }

  /** 取消某个 runtime 还没开始的自动升级。 */
  cancelAutoUpgrade(kind: UpdateKind): boolean {
    const entry = [...this.store.state.autoUpgrades].reverse().find((e) => e.kind === kind && e.status === "scheduled");
    if (!entry) return false;
    entry.status = "cancelled";
    entry.note = "被取消";
    this.store.save();
    return true;
  }

  /** 夜间窗口检查：到点、没有会话在跑、还在窗口内就开升级会话；窗口过了顺延到明晚。 */
  async tickAutoUpgrades(): Promise<void> {
    const now = this.now();
    if (!this.store.state.autoUpgrade.enabled) return;
    const scheduled = this.store.state.autoUpgrades.filter((e) => e.status === "scheduled");
    if (!scheduled.length) return;
    const parts = beijingParts(now);
    const minutes = parts ? parts.hour * 60 + parts.minute : 0;
    for (const entry of scheduled) {
      const at = Date.parse(entry.at);
      if (!Number.isFinite(at) || now.getTime() < at) continue;
      if (!parts || minutes >= AUTO_UPGRADE_WINDOW_END_MINUTE) { entry.at = nextBeijingRunAt(now, AUTO_UPGRADE_HOUR, 0).toISOString(); continue; }
      const idle = await (this.options.isIdle?.() ?? Promise.resolve(false)).catch(() => false);
      if (!idle) { entry.postponed = (entry.postponed ?? 0) + 1; this.store.save(); continue; }
      this.store.save();
      await this.startAutoUpgrade(entry);
    }
    this.store.save();
  }

  private async startAutoUpgrade(entry: AutoUpgradeEntry): Promise<void> {
    const plan = this.upgradePlan(entry.kind);
    if (!plan.ok) { entry.status = "failed"; entry.note = plan.error; entry.finishedAt = this.now().toISOString(); this.store.save(); return; }
    // 方案里的「最新版」可能又变了：以当前方案为准重写一次
    entry.from = plan.plan.from; entry.to = plan.plan.to;
    try {
      const created = await this.options.createUpgradeSession!(plan.plan);
      entry.status = "started";
      entry.startedAt = this.now().toISOString();
      delete entry.note;
      if (created?.sessionId) entry.sessionId = created.sessionId;
      this.options.log?.(`自动夜间升级已开始：${SOURCES[entry.kind].label} ${entry.from} → ${entry.to}`);
    } catch (error) {
      entry.status = "failed";
      entry.finishedAt = this.now().toISOString();
      entry.note = (error as Error).message || "开升级会话失败";
      this.options.log?.(`自动夜间升级失败（${entry.kind}）：${entry.note}`);
    }
    this.store.save();
  }

  /** 供测试与手动触发：现在就跑一遍自动升级评估与夜间检查。 */
  async runAutoUpgradePass(): Promise<void> {
    for (const kind of AUTO_UPGRADE_KINDS) this.maybeScheduleAutoUpgrade(kind);
    await this.tickAutoUpgrades();
  }

  /** 兼容旧调用：同步等一份报告（HTTP 已改成后台任务 + 轮询）。 */
  async analyze(kind: UpdateKind, force = false): Promise<{ ok: true; analysis: AnalysisRecord; cached: boolean } | { ok: false; code: string; error: string }> {
    const started = this.startAnalyze(kind, "manual", force);
    if (!started.ok) return started;
    if (!started.started) return { ok: true, analysis: started.analysis, cached: true };
    await this.jobs.get(kind);
    const rec = this.store.state.runtimes[kind];
    const analysis = this.store.state.analyses[kind];
    if (!analysis) return { ok: false, code: "ANALYSIS_FAILED", error: rec?.analysisError || "分析失败" };
    return { ok: true, analysis, cached: false };
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
    description: "每天检测 Pi、Claude Code、Codex、Antigravity 的新稳定版，检测完自动分析；落后超过 10 版的 Pi / Antigravity 在收益够大、风险可控时于北京夜间自动升级"
  });
  let timer: NodeJS.Timeout | undefined, catchUp: NodeJS.Timeout | undefined, autoTimer: NodeJS.Timeout | undefined, stopped = false;
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
  // 自动夜间升级：每 5 分钟看一次窗口与空闲情况（没有安排时是一次空转，不碰网络）
  autoTimer = setInterval(() => { void options.service.runAutoUpgradePass().catch(() => undefined); }, 5 * 60_000);
  autoTimer.unref?.();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(catchUp); clearInterval(autoTimer); };
}
