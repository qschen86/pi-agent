/**
 * 每晚错误统计（docs/requirements/error-stats-nightly）：
 * 1. 增量入库：工具报错（三个 runtime 的会话事件）、部署失败、记忆强约束重试用尽；
 * 2. DeepSeek（推理 high）把文案不同的同一根因归并成一个指纹；
 * 3. 触发待办（平台 / debug，由人决定修不修）：
 *    - 工具 / 部署：近 30 天内同一指纹出现在 ≥2 个 runtime，且每个 runtime 至少 2 次（过滤偶发）；不要求日期连续；
 *    - 记忆强约束：任意 runtime 重试用尽 1 次就建（规则本身可能有问题）；
 *    - 门禁 flaky：同一个测试文件近 7 天「复跑才通过」≥3 次就建（规则触发，不调 AI；隔离由门禁自己自动做，这里只通知）。
 * 每个指纹只建一次；待办完成 / 删除视为人的决定，之后只有新证据才再提醒。
 * 时间一律按北京时间（UTC+8）：独立调度每晚 23:50 跑；现在由自愈夜检（03:00，见 self-heal/）发起，待办里的时间也是北京时间。
 */
import type { JointIssue } from "../diagnostics/joint-context.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ModelInvocationPort } from "@pi-agent/model-port";
import { isPeak, nextOffPeak } from "../deepseek-peak.js";
import { beijingDateKey, beijingStamp, nextBeijingRunAt } from "../platform-time.js";
import { registerPlatformScheduledTask, dailyBeijingSchedule } from "../platform-scheduled-tasks.js";
import { catchUpWait } from "../diagnostics/scheduler.js";
import { collectDeploys, collectEnforcementExhausted, collectFlaky, collectToolFailures, type CollectOptions } from "./collect.js";
import { composeFlakyTodo, flakyKinds, GATE_FLAKY_MIN_7D, GATE_FLAKY_WINDOW_DAYS, readQuarantine } from "./flaky.js";
import { runMerge } from "./merge.js";
import { assess, needsAssessment, worthDoing } from "./assess.js";
import { buildAssessmentContext } from "./context.js";
import { RUNTIMES, type StatsRuntime } from "./normalize.js";
import { type Assessment, type ErrorStatsStore, WINDOW_DAYS, type FingerprintStat, type RunRecord, type RunTrigger } from "./store.js";

/** 每个 runtime 至少出现几次，才算「出现在这个 runtime」。 */
export const MIN_PER_RUNTIME = 2;
export const MIN_RUNTIMES = 2;
export const ENTRY_HOST = "console.example.com";
export const SCHEDULE_HOUR = 23, SCHEDULE_MINUTE = 50;
/** 一晚最多新建几条待办（第一次回填可能一下冒出很多，分几晚出，按次数从多到少）。 */
export const MAX_NEW_TODOS_PER_RUN = 8;
/** 一晚最多让 DeepSeek 评估几个（每个约 $0.01–0.03），以及评估花费的上限（美元）。 */
export const MAX_ASSESS_PER_RUN = 12;
export const ASSESS_BUDGET_USD = 0.5;
const DAY_MS = 86_400_000;
const RUNTIME_NAME: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi", unknown: "未知" };

export type NoteAnalysis = { title: string; summary: string; acceptance: string[]; value?: "high" | "medium" | "low" | "unknown"; valueBasis?: string };
export interface ErrorStatsNotes {
  create(text: string, analysis: NoteAnalysis): string;
  rewrite(noteId: string, text: string, analysis: NoteAnalysis): void;
  state(noteId: string): "open" | "done" | "deleted";
  text(noteId: string): string | null;
  backfillCategories?(noteIds: Iterable<string>): { assigned: number; unchanged: number; missing: number; skipped: number; failed: number };
}

export type Trigger = "cross-runtime" | "memory-single" | "gate-flaky";
/** recent7：门禁 flaky 要看近 7 天的次数（统计窗口是 30 天），其余类型不用。 */
export function triggerOf(s: FingerprintStat, recent7?: number): Trigger | null {
  if (s.kind === "flaky") return (recent7 ?? 0) >= GATE_FLAKY_MIN_7D ? "gate-flaky" : null;
  if (s.kind === "memory") return s.total >= 1 ? "memory-single" : null;
  const qualifying = RUNTIMES.filter((r) => (s.runtimes[r]?.count ?? 0) >= MIN_PER_RUNTIME);
  return qualifying.length >= MIN_RUNTIMES ? "cross-runtime" : null;
}

const hash = (t: string) => createHash("sha1").update(t).digest("hex").slice(0, 12);
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

function titleOf(s: FingerprintStat, ruleTitle?: (id: string) => string | undefined): string {
  const [kind, ...rest] = s.fingerprint.split("|");
  if (kind === "memory") { const id = rest[0] ?? ""; return `记忆强约束「${ruleTitle?.(id) ?? id}」重试用尽仍未通过`; }
  if (kind === "deploy") return `部署失败：${rest.slice(0, 3).join(" · ")}`.slice(0, 40);
  const [tool, ...more] = rest;
  return `${tool} 工具报错：${more.slice(-1)[0] ?? ""}`.slice(0, 40);
}

const VERDICT_LABEL = { do: "值得做", skip: "不建议做", unsure: "拿不准" } as const;
const CONF_LABEL = { high: "高", medium: "中", low: "低" } as const;

export function composeTodo(s: FingerprintStat, trigger: Trigger, now: Date, ruleTitle?: (id: string) => string | undefined, a?: Assessment): { text: string; analysis: NoteAnalysis } {
  const from = beijingDateKey(now.getTime() - (WINDOW_DAYS - 1) * DAY_MS), to = beijingDateKey(now);
  const title = a?.title ?? titleOf(s, ruleTitle);
  const label = trigger === "memory-single" ? "记忆强约束重试用尽" : "跨 runtime 重复报错";
  const head = `[错误统计 · ${label}${a ? ` · AI 评估：${VERDICT_LABEL[a.verdict]}（把握：${CONF_LABEL[a.confidence]}）` : ""}]`;
  const lines: string[] = [`${head} ${title}`, `指纹：${s.fingerprint}`];
  if (s.kind === "memory") { const id = s.fingerprint.split("|")[1] ?? ""; lines.push(`规则：「${ruleTitle?.(id) ?? id}」（${id}）`); }
  if (a) {
    lines.push(`AI 评估：${a.reason}`, `根因（假设，待修复会话核实）：${a.rootCause}`, `影响：${a.impact}`);
    if (a.proposal.length) lines.push(`建议方案：\n${a.proposal.map((x, i) => `${i + 1}. ${x}`).join("\n")}`);
    if (a.benefit) lines.push(`收益：${a.benefit}`);
    lines.push(`成本：${a.cost}`);
    if (a.risk) lines.push(`风险：${a.risk}`);
    if (a.acceptance.length) lines.push(`验收：\n${a.acceptance.map((x) => `- ${x}`).join("\n")}`);
  }
  if (s.members.length > 1) lines.push(`（DeepSeek 把 ${s.members.length} 个文案不同的指纹归并为同一个错误，成员：${s.members.slice(0, 4).map((m) => clip(m, 80)).join("；")}${s.members.length > 4 ? "…" : ""}）`);
  lines.push(`近 ${WINDOW_DAYS} 天（北京时间 ${from} ~ ${to}）共 ${s.total} 次：`);
  for (const [rt, r] of Object.entries(s.runtimes).sort((a, b) => b[1]!.count - a[1]!.count)) lines.push(`- ${RUNTIME_NAME[rt] ?? rt}：${r!.count} 次 · ${r!.days} 天 · ${r!.sessions.length} 个会话，最近一次 ${beijingStamp(r!.last)}（北京时间）`);
  lines.push("样例：");
  for (const [rt, r] of Object.entries(s.runtimes)) lines.push(`- ${RUNTIME_NAME[rt] ?? rt}：${clip(r!.sample, 300)}`);
  const sessions = [...new Set(Object.values(s.runtimes).flatMap((r) => r!.sessions))].slice(0, 6);
  if (sessions.length) lines.push(`涉及会话：${sessions.map((id) => `https://${ENTRY_HOST}/#/rt/${id}`).join("  ")}`);
  if (!a && trigger === "memory-single") lines.push("可能的方向：① 规则误判（范围太宽 / 与记忆语义不一致）→ 改规则；② 模型确实没做到 → 调整记忆措辞或反馈文案；③ 本来就做不到 → 把这条记忆降为软约束。");
  lines.push("决策：要不要修复由你定。要修 → 从这条待办发起会话；不修 → 直接完成或删除，该错误在出现新证据前不会再提醒。");
  lines.push(`（自动生成：每晚统计，规则归一化 + DeepSeek 归并相近错误${a ? "，再由 DeepSeek（推理 high）带上下文评估值不值得做；评估只是建议，AI 没有看完整代码" : ""}；触发条件：${trigger === "memory-single" ? "强约束重试用尽 ≥1 次" : `近 ${WINDOW_DAYS} 天内 ≥${MIN_RUNTIMES} 个 runtime 各出现 ≥${MIN_PER_RUNTIME} 次`}。）`);
  const runtimes = Object.keys(s.runtimes).map((r) => RUNTIME_NAME[r] ?? r).join("、");
  return {
    text: lines.join("\n"),
    analysis: {
      title: title.slice(0, 40),
      summary: a ? `${a.reason}（近 ${WINDOW_DAYS} 天共 ${s.total} 次，涉及 ${runtimes}）根因假设：${a.rootCause}` : `近 ${WINDOW_DAYS} 天共 ${s.total} 次，涉及 ${runtimes}。${trigger === "memory-single" ? "强约束自动反馈用尽后仍未通过，规则或记忆措辞可能有问题。" : "同一个错误在多个 runtime 反复出现，值得判断是否要修。"}`,
      acceptance: a?.acceptance.length ? a.acceptance.slice(0, 5) : trigger === "memory-single" ? ["确认是规则误判还是模型没做到，并给出处理（改规则 / 改措辞 / 降为软约束）"] : ["修复后同一指纹在后续统计里不再出现在多个 runtime"],
      value: a ? (a.confidence === "high" && a.verdict === "do" ? "high" : a.verdict === "do" ? "medium" : "low") : "medium",
      valueBasis: a?.benefit || "来自每晚错误统计，同一错误已重复出现"
    }
  };
}

export interface ErrorStatsOptions {
  store: ErrorStatsStore;
  analyzeDiagnostics?: (run: RunRecord) => Promise<void>;
  jointIssues?: () => JointIssue[];
  jointEvidence?: () => string;
  notes: ErrorStatsNotes;
  /** <dataDir>/runtime：会话事件与审计 */
  runtimeDir: string;
  guiRoot?: string;
  port?: ModelInvocationPort | undefined;
  ruleTitle?: (ruleId: string) => string | undefined;
  /** 规则定义（评估「记忆强约束」类错误时作上下文） */
  ruleInfo?: (ruleId: string) => { title: string; scope: string; criteria: string; feedback: string } | undefined;
  /** 仓库根（评估时读代码历史）；不给就不带代码上下文 */
  repoRoot?: string;
  /** 单晚评估花费上限（美元） */
  assessBudgetUsd?: number;
  now?: () => Date;
  log?: (m: string) => void;
  onFinished?: (run: RunRecord) => void;
  /** 自动发起的时刻（北京时间）；默认 23:50。自愈夜检接管后传 03:00，页面说明和待办文案跟着变 */
  schedule?: { hour: number; minute: number };
}

export class ErrorStatsService {
  private running: Promise<unknown> | null = null;
  private now: () => Date;
  readonly store: ErrorStatsStore;
  private readonly schedule: { hour: number; minute: number };

  constructor(private options: ErrorStatsOptions) {
    this.store = options.store;
    this.schedule = options.schedule ?? { hour: SCHEDULE_HOUR, minute: SCHEDULE_MINUTE };
    this.now = options.now ?? (() => new Date());
    // 上次进程在跑到一半时退出：留着「运行中」的记录会让页面一直转圈，改记成「中断」
    let dirty = false;
    for (const r of this.store.state.runs) if (r.status === "running" || (!r.finishedAt && !r.status)) { r.status = "interrupted"; r.finishedAt = r.startedAt; dirty = true; }
    // 每次启动都对账一次：这些待办必须钉在「平台 / debug」。历史上被模型分类覆盖的（策略升级、正文改写）在这里修回来；
    // 钉住之后不会再被覆盖，对账是幂等的，失败不阻断启动，下次启动再来。
    if (options.notes.backfillCategories) {
      const result = options.notes.backfillCategories(this.store.createdNoteIds());
      options.log?.(`错误统计待办归类（钉住「平台 / debug」）：${JSON.stringify(result)}`);
      if (!this.store.state.debugCategoriesBackfilledAt) { this.store.state.debugCategoriesBackfilledAt = this.now().toISOString(); dirty = true; }
    }
    if (dirty) try { this.store.save(); } catch { /* 下次再存 */ }
  }

  private bindings(): { runtimeOf: (id: string) => StatsRuntime | "unknown"; titleOf: (id: string) => string | undefined } {
    const map = new Map<string, { runtime: StatsRuntime; title?: string }>();
    try {
      const file = join(this.options.runtimeDir, "bindings.json");
      if (existsSync(file)) for (const [id, b] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, { runtimeKind?: string; title?: string }>)) if (b.runtimeKind === "pi" || b.runtimeKind === "claude-code" || b.runtimeKind === "codex") map.set(id, { runtime: b.runtimeKind, ...(b.title ? { title: b.title } : {}) });
    } catch { /* 读不到就只靠日志里自带的 runtime */ }
    return { runtimeOf: (id) => map.get(id)?.runtime ?? "unknown", titleOf: (id) => map.get(id)?.title };
  }

  /**
   * 开始一次统计：立即返回运行 id，统计在后台跑（手动入口不用等）。
   * 定时 / 补跑：20 小时内已经完整跑过就跳过（两个进程同时在线、重启补跑都靠这个去重）；手动 force=true 不受限。
   */
  start(trigger: RunTrigger = "schedule", force = false): { id: string; done: Promise<RunRecord> } | { skipped: "already-running" | "done-recently" } {
    if (this.running) return { skipped: "already-running" };
    const last = [...this.store.state.runs].reverse().find((r) => r.status === "ok" || r.status === "failed");
    if (!force && last?.status === "ok" && this.now().getTime() - Date.parse(last.startedAt) < 20 * 3_600_000) return { skipped: "done-recently" };
    const now = this.now();
    const run: RunRecord = {
      id: randomUUID().slice(0, 8), trigger, status: "running", date: beijingDateKey(now), startedAt: now.toISOString(),
      added: 0, byKind: { tool: 0, deploy: 0, memory: 0, flaky: 0 }, merged: 0, costUsd: 0, created: [], createdTodos: [], deferred: 0
    };
    this.store.state.runs.push(run);
    try { this.store.save(); } catch { /* 记录丢了不影响统计 */ }
    const done = this.nightly(run);
    this.running = done.finally(() => { this.running = null; });
    return { id: run.id, done };
  }

  async runNightly(force = false, trigger: RunTrigger = "schedule"): Promise<RunRecord | { skipped: string }> {
    const r = this.start(trigger, force);
    return "skipped" in r ? { skipped: r.skipped } : r.done;
  }

  isRunning(): boolean { return this.running !== null; }

  /** 最近一次成功跑完的开始时间（补跑判断用；失败、中断的不算）。 */
  lastFinishedAt(): number { const r = [...this.store.state.runs].reverse().find((x) => x.status === "ok"); return r ? Date.parse(r.startedAt) : 0; }

  /** 给「设置 · 错误统计」页：运行历史（新的在前）与当前状态。 */
  overview(limit = 30): Record<string, unknown> {
    const runs = [...this.store.state.runs].reverse().slice(0, limit);
    const now = this.now();
    return {
      running: this.running !== null, windowDays: WINDOW_DAYS, minRuntimes: MIN_RUNTIMES, minPerRuntime: MIN_PER_RUNTIME, maxNewTodosPerRun: MAX_NEW_TODOS_PER_RUN,
      scheduleHour: this.schedule.hour, scheduleMinute: this.schedule.minute, nextRunAt: nextBeijingRunAt(now, this.schedule.hour, this.schedule.minute).toISOString(),
      backfilledAt: this.store.state.backfilledAt ?? null, todos: Object.keys(this.store.state.todos).length, runs,
      flaky: { ...readQuarantine(this.options.guiRoot ?? process.env["PI_AGENT_GUI_ROOT"] ?? join(homedir(), ".pi-agent-gui"), now.getTime()), threshold: GATE_FLAKY_MIN_7D, windowDays: GATE_FLAKY_WINDOW_DAYS }
    };
  }

  private async nightly(run: RunRecord): Promise<RunRecord> {
    const { store } = this;
    const now = new Date(run.startedAt);
    try {
      // 一路失败仍分析另一来源，失败状态保留，重启可重试。
      let diagnosticFailure = false;
      const bound = this.bindings();
      const co: CollectOptions = {
        store, runtimeDir: this.options.runtimeDir, guiRoot: this.options.guiRoot ?? process.env["PI_AGENT_GUI_ROOT"] ?? join(homedir(), ".pi-agent-gui"),
        sinceMs: now.getTime() - WINDOW_DAYS * DAY_MS, runtimeOfSession: bound.runtimeOf
      };
      let collectionError: unknown;
      try {
      run.byKind.tool = await collectToolFailures(co);
      run.byKind.deploy = await collectDeploys(co);
      run.byKind.memory = await collectEnforcementExhausted(co);
      run.byKind.flaky = await collectFlaky(co);
      run.added = run.byKind.tool + run.byKind.deploy + run.byKind.memory + run.byKind.flaky;
      if (!store.state.backfilledAt) store.state.backfilledAt = now.toISOString();
      store.prune(); store.save();
      } catch (e) { collectionError = e; }
      try { await this.options.analyzeDiagnostics?.(run); }
      catch (e) { diagnosticFailure = true; run.note = `链路分诊失败：${(e as Error).message}`; }
      if (collectionError) throw collectionError;
      const merge = await runMerge({ store, stats: store.stats(), port: this.options.port, now: this.now });
      run.costUsd += merge.costUsd;
      if (merge.ok) run.merged = merge.merged; else run.note = [run.note, `归并失败：${merge.error}`].filter(Boolean).join("；");
      store.save();
      const todos = await this.applyTodos(run, bound.titleOf);
      run.createdTodos.push(...todos); run.created = [...new Set(run.createdTodos.map((t) => t.noteId))];
      run.status = diagnosticFailure ? "failed" : "ok";
      this.options.log?.(`错误统计（${run.trigger}）：入库 ${run.added} 条，新建待办 ${run.created.length} 条${merge.ok ? `，归并 ${merge.merged} 个指纹` : `（${run.note}）`}`);
    } catch (e) {
      run.status = "failed";
      run.note = [run.note, `失败：${(e as Error).message}`].filter(Boolean).join("；");
      this.options.log?.(`错误统计失败：${(e as Error).message}`);
    } finally {
      run.finishedAt = this.now().toISOString();
      try { this.options.onFinished?.(run); } catch (e) { this.options.log?.(`服务通知写入失败：${(e as Error).message}`); }
      try { store.save(); } catch { /* 下次重试 */ }
    }
    return run;
  }

  /** 归并改变了代表指纹时，把待办记录跟着挪过去（避免同一个错误建两条）。 */
  private migrateTodos(): void {
    const { todos } = this.store.state;
    for (const fp of Object.keys(todos)) {
      const root = this.store.resolve(fp);
      if (root === fp) continue;
      if (!todos[root]) todos[root] = todos[fp]!;
      delete todos[fp];
    }
  }

  /**
   * 触发条件满足的错误先交给 DeepSeek 评估「值不值得做」，值得做（且把握不是低）才建待办，由人最后决策。
   * 评估结论存起来：之后次数翻倍 / 新 runtime 加入 / 非「值得做」超过 14 天才重新评估；人关闭待办后又有新证据也重新评估。
   * 已经建好、还没带评估的待办（上一版建的）补评一次，把评估写进正文（人改过正文的不动）。
   */
  private async applyTodos(run: RunRecord, sessionTitle: (id: string) => string | undefined): Promise<Array<{ noteId: string; title: string }>> {
    const { store, options } = this;
    const now = this.now();
    this.migrateTodos();
    const todos = store.state.todos;
    const cutoff = (fp: string) => { const c = todos[fp]?.closedAt; return c ? beijingDateKey(c) : undefined; };
    const created: Array<{ noteId: string; title: string }> = [];
    run.assessed = 0; run.worth = 0; run.assessments ??= [];
    // 先核对已有待办的状态：完成 / 删除 = 人的决定，记下时刻
    for (const rec of Object.values(todos)) if (!rec.closedAt && options.notes.state(rec.noteId) !== "open") rec.closedAt = now.toISOString();
    const stats = store.stats({ cutoff });
    const recent = store.stats({ days: GATE_FLAKY_WINDOW_DAYS, cutoff });
    const guiRoot = options.guiRoot ?? process.env["PI_AGENT_GUI_ROOT"] ?? join(homedir(), ".pi-agent-gui");
    const budget = options.assessBudgetUsd ?? ASSESS_BUDGET_USD;
    let spent = 0;
    const addNote = (text: string) => { const next = run.note ? `${run.note}；${clip(text, 160)}` : clip(text, 160); run.note = clip(next, 400); };
    /** 取这个错误的评估：够新就复用；需要就调一次模型（受单晚个数 / 花费上限限制）；拿不到返回 null。 */
    const evaluate = async (s: FingerprintStat, force = false): Promise<{ a: Assessment; fresh: boolean } | null> => {
      const existing = store.state.assessments[s.fingerprint];
      const runtimes = Object.keys(s.runtimes).length;
      if (existing && !force && !needsAssessment(existing, s.total, runtimes, now)) return { a: existing, fresh: false };
      if (!options.port || run.assessed! >= MAX_ASSESS_PER_RUN || spent >= budget) return existing && !force ? { a: existing, fresh: false } : null;
      const context = buildAssessmentContext(s, { store, guiRoot, now, sessionTitle, todoState: (id) => options.notes.state(id), ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}), ...(options.ruleInfo ? { ruleInfo: options.ruleInfo } : {}) });
      const evidence = options.jointEvidence?.();
      if (evidence) { context.text += `\n[J1] 另一来源的脱敏分析结论（关联是假设，须核实）：\n${evidence.slice(0, 6000)}`; context.ids.add("J1"); }
      const r = await assess({ port: options.port, context, total: s.total, runtimes, now: this.now, issues: options.jointIssues?.() ?? [] });
      spent += r.costUsd; run.costUsd = Math.round((run.costUsd + r.costUsd) * 1e6) / 1e6; run.assessed!++;
      if (!r.ok) { addNote(`评估失败：${r.error}`); return existing && !force ? { a: existing, fresh: false } : null; }
      store.state.assessments[s.fingerprint] = r.value; store.save();
      return { a: r.value, fresh: true };
    };
    const record = (a: Assessment, noteId?: string) => run.assessments!.push({ title: a.title, verdict: a.verdict, confidence: a.confidence, reason: a.reason, ...(noteId ? { noteId } : {}) });

    const pending: Array<{ s: FingerprintStat; trigger: Trigger }> = [];
    /** 开着的待办但上次评估是「不建议做」：次数翻倍 / 新 runtime / 满 14 天要重评，否则新证据永远进不了评估 */
    const reassess: FingerprintStat[] = [];
    for (const s of stats.values()) {
      const trigger = triggerOf(s, recent.get(s.fingerprint)?.total);
      if (!trigger) continue;
      const rec = todos[s.fingerprint];
      if (rec && !rec.closedAt) {
        // 开着的待办：新 runtime 加入、或次数翻倍时更新一次数字；人改过正文就不动
        const grew = Object.keys(s.runtimes).length > rec.runtimes.length || s.total >= rec.total * 2;
        const current = options.notes.text(rec.noteId);
        const untouched = current !== null && hash(current) === rec.textHash;
        if (grew && untouched && now.getTime() - Date.parse(rec.updatedAt) >= DAY_MS) {
          const { text, analysis } = trigger === "gate-flaky"
            ? composeFlakyTodo({ s, recent7: recent.get(s.fingerprint)?.total ?? 0, quarantine: readQuarantine(guiRoot, now.getTime()), kinds: flakyKinds(guiRoot, s.fingerprint.slice(6), now.getTime() - GATE_FLAKY_WINDOW_DAYS * DAY_MS), now, windowDays: WINDOW_DAYS, entryHost: ENTRY_HOST })
            : composeTodo(s, trigger, now, options.ruleTitle, store.state.assessments[s.fingerprint]);
          options.notes.rewrite(rec.noteId, text, analysis);
          Object.assign(rec, { updatedAt: now.toISOString(), runtimes: Object.keys(s.runtimes), total: s.total, textHash: hash(text) });
        }
        const prev = store.state.assessments[s.fingerprint];
        if (prev && !worthDoing(prev) && needsAssessment(prev, s.total, Object.keys(s.runtimes).length, now)) reassess.push(s);
        continue;
      }
      // 没有待办，或上一条已被人关闭且之后又有新证据（stats 已按关闭日期截断）
      pending.push({ s, trigger });
    }
    pending.sort((a, b) => b.s.total - a.s.total);
    if (pending.length && !options.port) addNote("没有可用的模型，无法评估是否值得做，本轮没有建待办");
    for (const { s, trigger } of pending) {
      if (created.length >= MAX_NEW_TODOS_PER_RUN) { run.deferred++; continue; }
      if (trigger === "gate-flaky") {
        // 规则触发：证据（次数、错误类型）已经足够明确，不调 AI 评估（评估提示词会把「偶发」判成不做）；隔离由门禁自己做。
        const { text, analysis } = composeFlakyTodo({ s, recent7: recent.get(s.fingerprint)?.total ?? 0, quarantine: readQuarantine(guiRoot, now.getTime()), kinds: flakyKinds(guiRoot, s.fingerprint.slice(6), now.getTime() - GATE_FLAKY_WINDOW_DAYS * DAY_MS), now, windowDays: WINDOW_DAYS, entryHost: ENTRY_HOST });
        const noteId = options.notes.create(text, analysis);
        todos[s.fingerprint] = { noteId, rule: trigger, createdAt: now.toISOString(), updatedAt: now.toISOString(), runtimes: Object.keys(s.runtimes), total: s.total, textHash: hash(text), assessed: true };
        created.push({ noteId, title: analysis.title });
        run.assessments!.push({ title: analysis.title, verdict: "do", confidence: "high", reason: "门禁自动检查不稳定（规则触发，没有调用 AI）", noteId });
        store.save();
        continue;
      }
      const got = await evaluate(s, !!todos[s.fingerprint]?.closedAt && !store.state.assessments[s.fingerprint]?.at.startsWith(run.date));
      if (!got) { run.deferred++; continue; }
      const { a, fresh } = got;
      if (fresh && worthDoing(a)) run.worth!++;
      if (a.coveredBy && !options.jointIssues?.().some(i => i.noteId === a.coveredBy)) { delete store.state.assessments[s.fingerprint]; run.deferred++; continue; }
      if (!worthDoing(a) && !a.coveredBy) { if (fresh) record(a); continue; }
      const { text, analysis } = composeTodo(s, trigger, now, options.ruleTitle, a);
      const covered = a.coveredBy && options.jointIssues?.().some(i => i.noteId === a.coveredBy) ? a.coveredBy : undefined;
      const noteId = covered ?? options.notes.create(text, analysis);
      todos[s.fingerprint] = { noteId, rule: trigger, createdAt: now.toISOString(), updatedAt: now.toISOString(), runtimes: Object.keys(s.runtimes), total: s.total, textHash: hash(text), assessed: true };
      if (!covered) created.push({ noteId, title: analysis.title });
      record(a, noteId);
      store.save();
    }
    // 复评：开着的待办上次被评为「不建议做」，之后有了新证据；评估结果写回待办（人没改过正文才改），并进入自愈的结论
    reassess.sort((a, b) => b.total - a.total);
    for (const s of reassess) {
      const rec = todos[s.fingerprint]!;
      const got = await evaluate(s);
      if (!got?.fresh) continue;
      if (worthDoing(got.a)) run.worth!++;
      record(got.a, rec.noteId);
      const current = options.notes.text(rec.noteId);
      if (current !== null && hash(current) === rec.textHash) {
        const { text, analysis } = composeTodo(s, triggerOf(s) ?? rec.rule, now, options.ruleTitle, got.a);
        options.notes.rewrite(rec.noteId, text, analysis);
        Object.assign(rec, { updatedAt: now.toISOString(), assessed: true, runtimes: Object.keys(s.runtimes), total: s.total, textHash: hash(text) });
      }
      store.save();
    }
    // 补评：上一版建好、还没带评估的待办（没改过正文的才写回）
    for (const [fp, rec] of Object.entries(todos)) {
      if (rec.assessed || rec.closedAt || !options.port) continue;
      const s = stats.get(fp), current = options.notes.text(rec.noteId);
      if (!s || current === null || hash(current) !== rec.textHash) continue;
      const trigger = triggerOf(s) ?? rec.rule;
      const got = await evaluate(s);
      if (!got) continue;
      if (got.fresh && worthDoing(got.a)) run.worth!++;
      const { text, analysis } = composeTodo(s, trigger, now, options.ruleTitle, got.a);
      options.notes.rewrite(rec.noteId, text, analysis);
      Object.assign(rec, { updatedAt: now.toISOString(), assessed: true, runtimes: Object.keys(s.runtimes), total: s.total, textHash: hash(text) });
      if (got.fresh) record(got.a, rec.noteId);
      store.save();
    }
    return created;
  }
}

/** 每晚北京时间 23:50（UTC 15:50，DeepSeek 波谷）；超过 26 小时没跑过就在启动 5 分钟后补一次（峰时推迟到波谷）。 */
export function startErrorStatsScheduler(options: {
  service: ErrorStatsService; isServing: () => Promise<boolean>; log?: (m: string) => void; now?: () => Date; catchUpDelayMs?: number;
  peak?: (at: Date) => boolean; offPeak?: (at: Date) => Date;
}): () => void {
  const now = options.now ?? (() => new Date());
  registerPlatformScheduledTask({
    id: "error-stats-nightly", schedule: dailyBeijingSchedule(SCHEDULE_HOUR, SCHEDULE_MINUTE), source: "apps/web/src/error-stats/service.ts"
  });
  let timer: NodeJS.Timeout | undefined, catchUp: NodeJS.Timeout | undefined, stopped = false;
  const fire = async (trigger: RunTrigger) => {
    try {
      if (!(await options.isServing())) { options.log?.("错误统计：本进程不是当前在线槽位，跳过"); return; }
      await options.service.runNightly(false, trigger);
    } catch (e) { options.log?.(`错误统计失败：${(e as Error).message}`); }
  };
  const schedule = () => {
    if (stopped) return;
    const at = nextBeijingRunAt(now(), SCHEDULE_HOUR, SCHEDULE_MINUTE);
    timer = setTimeout(() => { void fire("schedule").finally(schedule); }, Math.max(1_000, at.getTime() - now().getTime()));
    timer.unref?.();
  };
  if (now().getTime() - options.service.lastFinishedAt() > 26 * 3_600_000) {
    const wait = catchUpWait(now(), options.catchUpDelayMs ?? 5 * 60_000, options.peak ?? isPeak, options.offPeak ?? nextOffPeak);
    catchUp = setTimeout(() => { void fire("catch-up"); }, Math.max(1_000, wait));
    catchUp.unref?.();
  }
  schedule();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(catchUp); };
}
