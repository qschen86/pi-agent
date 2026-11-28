/**
 * 自愈夜检（docs/requirements/self-heal）：
 * 1. 联合分析：沿用错误统计（工具 / 部署 / 记忆报错）+ 前后端链路分诊，得到「值不值得修」的结论；
 * 2. 按基础板块归类：每个板块一次检查，结论带结果状态（已修复 / 不修复 / 待人类审核 / 修复中 / 评估中 / 处理失败）；
 * 3. 按策略处置：有感知的改动出方案交给人；无感知小修直接开修复会话（修完自动部署）；无感知大改先多模型评估风险收益；
 * 4. 修复会话结束后对账（看会话分支上有没有提交、有没有合进 main），回写结果并发服务通知。
 * 时间一律按北京时间；每晚 03:00 跑，错过了启动 5 分钟后补跑（DeepSeek 峰时顺延到波谷）。
 */
import { randomUUID } from "node:crypto";
import type { ModelInvocationPort } from "@pi-agent/model-port";
import { isPeak, nextOffPeak } from "../deepseek-peak.js";
import { beijingDateKey, nextBeijingRunAt } from "../platform-time.js";
import { dailyBeijingSchedule, registerPlatformScheduledTask } from "../platform-scheduled-tasks.js";
import { catchUpWait } from "../diagnostics/scheduler.js";
import type { ErrorStatsService } from "../error-stats/service.js";
import type { Assessment } from "../error-stats/store.js";
import type { Triage } from "../diagnostics/findings.js";
import { BOARDS, boardById, boardOfFingerprint, boardOfTrace, type BoardId } from "./boards.js";
import { classify, evaluateRisk, type Plan } from "./policy.js";
import { fixPrompt } from "./prompt.js";
import { RESULT_LABEL, type Check, type Finding, type Result, type SelfHealStore } from "./store.js";

export const SCHEDULE_HOUR = 3, SCHEDULE_MINUTE = 0;
/** 一晚最多自动开几个修复会话（额度、门禁和部署队列都是共享的）。 */
export const MAX_AUTO_FIX_PER_RUN = 3;
/** 同一个问题连续自动修复失败几次后不再自动重试，交给人。 */
export const MAX_FAILED_ATTEMPTS = 2;
/** 修复会话超过这么久还没有结果，记为处理失败。 */
export const FIX_TIMEOUT_MS = 6 * 3_600_000;
const HOUR_MS = 3_600_000;

export type RunTrigger = "schedule" | "catch-up" | "manual";

/** 链路分诊的一条 finding（diagnostics/findings.ts 的子集）。 */
export interface TraceFinding {
  id: string; fingerprint: string; component?: string; errorType?: string; summary?: string; noteId?: string;
  occurrences: number; lastSeen: string; triage?: Triage;
}

export interface LaunchInput { findingId: string; board: BoardId; title: string; prompt: string; noteId?: string }
export interface SessionOutcome {
  /** 会话还在跑（含排队中） */
  active: boolean;
  /** 修复分支上有没有提交（相对创建时的 base） */
  commits: boolean;
  /** 分支最新提交是否已进 main */
  merged: boolean;
  head?: string;
  lastTurn?: "completed" | "failed" | "cancelled" | string;
  /** 分支已不在（会话归档后被清理），无法核实 */
  gone?: boolean;
}

export interface SelfHealDeps {
  store: SelfHealStore;
  errorStats: Pick<ErrorStatsService, "start" | "store">;
  traceFindings: () => TraceFinding[];
  port?: ModelInvocationPort | undefined;
  noteState: (noteId: string) => "open" | "done" | "deleted";
  completeNote?: (noteId: string) => void;
  launchFix: (input: LaunchInput) => Promise<{ sessionId: string }>;
  inspectSession: (sessionId: string) => SessionOutcome | undefined;
  notify: (n: { id: string; title: string; body: string; at?: string }) => void;
  maxAutoFix?: number;
  now?: () => Date;
  log?: (m: string) => void;
}

interface Item {
  board: BoardId; source: "stats" | "trace"; key: string; plan: Plan; verdict: Finding["verdict"]; confidence: Finding["confidence"];
  reason: string; noteId?: string; analysis: string[];
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
const VERDICT_TEXT = { do: "值得修", skip: "不需要修", unsure: "拿不准" } as const;

function itemFromAssessment(fp: string, a: Assessment, noteId: string | undefined): Item {
  return {
    board: boardOfFingerprint(fp), source: "stats", key: fp, verdict: a.verdict, confidence: a.confidence, reason: a.reason, ...(noteId ? { noteId } : {}),
    plan: { title: a.title, rootCause: a.rootCause, impact: a.impact, proposal: a.proposal, benefit: a.benefit, cost: a.cost, risk: a.risk, acceptance: a.acceptance },
    analysis: [`指纹：${fp}`, `AI 评估：${VERDICT_TEXT[a.verdict]}（把握 ${a.confidence}）— ${a.reason}`, `根因（假设）：${a.rootCause}`, `影响：${a.impact}`,
      ...(a.proposal.length ? [`方案：${a.proposal.join("；")}`] : []), ...(a.benefit ? [`收益：${a.benefit}`] : []), `成本：${a.cost}`, ...(a.risk ? [`风险：${a.risk}`] : []),
      `评估模型：${a.model ?? "deepseek-flash"}，当时 ${a.total} 次 / ${a.runtimes} 个 runtime`]
  };
}

function itemFromTrace(f: TraceFinding): Item | undefined {
  const t = f.triage;
  if (!t) return undefined;
  const verdict = t.verdict === "fix" ? "do" : t.verdict === "no_fix" ? "skip" : "unsure";
  return {
    board: boardOfTrace(f.component, f.errorType, t.title), source: "trace", key: f.fingerprint, verdict, confidence: t.confidence, reason: t.likelyCause, ...(f.noteId ? { noteId: f.noteId } : {}),
    plan: { title: t.title, rootCause: t.likelyCause, impact: t.impact, proposal: t.solution, benefit: t.benefit, cost: "未评估", risk: t.risk, acceptance: t.acceptance },
    analysis: [`链路指纹：${f.fingerprint}`, `现象：${t.symptom}`, `分诊：${t.verdict === "fix" ? "建议修复" : t.verdict === "no_fix" ? "不需要修复" : "不确定"}（把握 ${t.confidence}）`, `可能原因：${t.likelyCause}`, `影响：${t.impact}`,
      ...(t.solution.length ? [`方案：${t.solution.join("；")}`] : []), ...(t.evidence.length ? [`证据：${t.evidence.join("；")}`] : [])]
  };
}

export class SelfHealService {
  private running: Promise<unknown> | null = null;
  private readonly ownedRuns = new Set<string>();
  private readonly now: () => Date;
  readonly store: SelfHealStore;

  constructor(private readonly deps: SelfHealDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
  }

  isRunning(): boolean { return this.running !== null; }
  /** 这一轮联合分析是自愈发起的：错误统计自己的完成通知不再重复发。 */
  ownsRun(errorStatsRunId: string): boolean { return this.ownedRuns.has(errorStatsRunId); }
  lastRunAt(): number { this.store.refresh(); return Date.parse(this.store.state.lastRunAt ?? "") || 0; }

  start(trigger: RunTrigger = "schedule", force = false): { id: string; done: Promise<string> } | { skipped: "already-running" | "done-recently" } {
    if (this.running) return { skipped: "already-running" };
    if (!force && this.now().getTime() - this.lastRunAt() < 20 * HOUR_MS) return { skipped: "done-recently" };
    const id = randomUUID().slice(0, 8);
    const done = this.nightly(id, trigger);
    this.running = done.finally(() => { this.running = null; });
    return { id, done };
  }

  async runNightly(trigger: RunTrigger = "schedule", force = false): Promise<string | { skipped: string }> {
    const r = this.start(trigger, force);
    return "skipped" in r ? { skipped: r.skipped } : r.done;
  }

  /* ------------------------------ 夜检 ------------------------------ */

  private async nightly(runId: string, trigger: RunTrigger): Promise<string> {
    const { store } = this.deps;
    const startedAt = this.now();
    const sinceMs = this.lastRunAt() || startedAt.getTime() - 24 * HOUR_MS;
    const checks = new Map<BoardId, Check>();
    const checkOf = (board: BoardId): Check => {
      let c = checks.get(board);
      if (!c) { c = { id: `${runId}-${board}`, runId, board, trigger, startedAt: startedAt.toISOString(), status: "running", scanned: 0, ignored: 0, summary: "", findingIds: [], costUsd: 0 }; checks.set(board, c); }
      return c;
    };
    let fixesStarted = 0;
    try {
      for (const b of BOARDS) if (b.collector) checkOf(b.id);
      const analysis = this.deps.errorStats.start(trigger, true);
      if ("skipped" in analysis) throw new Error("上一轮联合分析还在跑，本轮先不重复分析");
      this.ownedRuns.add(analysis.id);
      const run = await analysis.done;
      const analysisNote = run.status === "failed" ? `联合分析没有完整跑完：${run.note ?? "未知原因"}` : "";
      // 本轮的错误统计 / 链路分诊把结论写在各自的存储里：按时间取这一轮新出的
      const items: Item[] = [];
      for (const [fp, a] of Object.entries(this.deps.errorStats.store.state.assessments)) {
        if (a.at >= run.startedAt) items.push(itemFromAssessment(fp, a, this.deps.errorStats.store.state.todos[fp]?.noteId));
      }
      for (const f of this.deps.traceFindings()) {
        if (f.triage && f.triage.at >= run.startedAt) { const item = itemFromTrace(f); if (item) items.push(item); }
      }
      this.countScanned(sinceMs, checkOf);
      const seen = new Set<string>();
      for (const item of items) {
        const dedupe = `${item.board}\u0001${item.key}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const check = checkOf(item.board);
        const rule = store.ignoredBy(item.board, item.key, item.plan.title);
        if (rule) { check.ignored++; continue; }
        const fixesLeft = (this.deps.maxAutoFix ?? MAX_AUTO_FIX_PER_RUN) - fixesStarted;
        const { finding, launched } = await this.handle(item, check, startedAt, fixesLeft > 0);
        if (launched) fixesStarted++;
        if (!check.findingIds.includes(finding.id)) check.findingIds.push(finding.id);
      }
      const finishedAt = this.now().toISOString();
      for (const c of checks.values()) {
        const findings = c.findingIds.map((id) => store.finding(id)).filter((f): f is Finding => !!f);
        const count = (r: Result) => findings.filter((f) => f.result === r).length;
        c.status = analysisNote ? "failed" : "ok"; c.finishedAt = finishedAt;
        c.summary = [`检查 ${c.scanned} 条报错`, findings.length ? `形成 ${findings.length} 条结论（已修复 ${count("fixed")}，修复中 ${count("fixing") + count("evaluating")}，待人类审核 ${count("awaiting-human")}，不修复 ${count("no-fix")}，失败 ${count("failed")}）` : c.scanned ? "本轮没有新的评估结论（这些报错已被已有待办或评估覆盖，不会重复分析）" : "没有需要处理的结论", c.ignored ? `屏蔽 ${c.ignored} 条` : "", analysisNote].filter(Boolean).join("；");
      }
      store.mutate((s) => {
        s.checks.push(...checks.values()); s.lastRunAt = startedAt.toISOString(); store.prune();
      });
      await this.reconcile();
      this.notifyRun(runId, checks, trigger);
      this.deps.log?.(`自愈夜检（${trigger}）：${[...checks.values()].map((c) => `${c.board} ${c.findingIds.length}`).join("，")}`);
    } catch (e) {
      const message = (e as Error).message;
      const finishedAt = this.now().toISOString();
      for (const c of checks.values()) { c.status = "failed"; c.finishedAt = finishedAt; c.summary = `夜检失败：${clip(message, 200)}`; }
      store.mutate((s) => { s.checks.push(...checks.values()); });
      this.deps.notify({ id: `self-heal:run:${runId}`, title: "自愈夜检失败", body: clip(message, 300) });
      this.deps.log?.(`自愈夜检失败：${message}`);
    }
    return runId;
  }

  /** 各板块「上次检查至今」覆盖的报错条数。 */
  private countScanned(sinceMs: number, checkOf: (board: BoardId) => Check): void {
    const from = beijingDateKey(sinceMs);
    for (const [date, day] of Object.entries(this.deps.errorStats.store.state.buckets)) {
      if (date < from) continue;
      for (const [key, b] of Object.entries(day)) if (b.last >= sinceMs) checkOf(boardOfFingerprint(key.split("\u0001")[1] ?? "")).scanned += b.n;
    }
    for (const f of this.deps.traceFindings()) if (Date.parse(f.lastSeen) >= sinceMs) checkOf(boardOfTrace(f.component, f.errorType, f.triage?.title)).scanned += f.occurrences;
  }

  /* ------------------------------ 单条结论的判定与处置 ------------------------------ */

  private async handle(item: Item, check: Check, now: Date, canLaunch: boolean): Promise<{ finding: Finding; launched: boolean }> {
    const { store } = this.deps;
    const reused = store.reusable(item.board, item.key, now);
    if (reused) return { finding: reused, launched: false };
    const at = now.toISOString();
    const finding: Finding = {
      id: randomUUID().slice(0, 10), board: item.board, source: item.source, key: item.key, title: item.plan.title, conclusion: item.reason,
      analysis: item.analysis, verdict: item.verdict, confidence: item.confidence, fixClass: "none", result: "no-fix", resultReason: "", tasks: [], history: [],
      ...(item.noteId ? { noteId: item.noteId } : {}), createdAt: at, updatedAt: at
    };
    if (item.noteId) store.addTask(finding, { type: "note", label: "平台 / debug 待办", ref: item.noteId, href: "#/notes", at });
    let launched = false;
    if (item.verdict === "skip") {
      store.setResult(finding, "no-fix", `AI 评估不需要修复：${clip(item.reason, 160)}`);
    } else if (item.verdict === "unsure" || item.confidence === "low") {
      store.setResult(finding, "awaiting-human", `AI 把握不足（${item.verdict === "unsure" ? "拿不准" : "把握低"}），交给你判断`);
    } else {
      const cfg = store.boardSettings(item.board);
      const c = await classify(this.deps.port, cfg, item.plan, this.now);
      check.costUsd = Math.round((check.costUsd + c.costUsd) * 1e6) / 1e6;
      if (!c.ok) {
        store.setResult(finding, "awaiting-human", `没能判断改动类别（${clip(c.error, 120)}），交给你判断`);
      } else {
        const v = c.value;
        finding.fixClass = v.perceptible ? "perceptible" : v.size;
        finding.analysis.push(`改动类别：${v.perceptible ? "涉及用户可感知的改动" : v.size === "small" ? "无感知小修" : "无感知大改"}（${v.reason}）${v.files.length ? `；预计涉及：${v.files.join("、")}` : ""}`);
        if (v.perceptible) {
          store.setResult(finding, "awaiting-human", "涉及用户可感知的功能改动，方案已准备好，请审核");
        } else if (!boardById(item.board)?.autoFix) {
          store.setResult(finding, "awaiting-human", "这个板块不参与自动修复");
        } else if (this.priorFailures(item.board, item.key) >= MAX_FAILED_ATTEMPTS) {
          store.setResult(finding, "awaiting-human", `之前已自动修复失败 ${MAX_FAILED_ATTEMPTS} 次，不再自动重试`);
        } else if (v.size === "small") {
          if (!canLaunch) store.setResult(finding, "awaiting-human", "今晚自动修复的名额已用完，请手动安排或等下一轮");
          else launched = await this.launch(finding, item.plan, true, "小修，直接安排修复");
        } else {
          store.setResult(finding, "evaluating", "改动较大，正在请多个模型分别评估风险和收益");
          const verdict = await evaluateRisk(this.deps.port, item.plan, this.now);
          check.costUsd = Math.round((check.costUsd + verdict.costUsd) * 1e6) / 1e6;
          store.addTask(finding, { type: "evaluation", label: verdict.go ? "多模型评估：风险收益合适" : "多模型评估：不建议直接做" });
          finding.analysis.push(`多模型风险收益评估：\n${verdict.summary}`);
          if (!verdict.go) store.setResult(finding, "awaiting-human", `多模型评估认为风险收益不合适（或评估不完整），交给你决定：${clip(verdict.summary, 200)}`);
          else if (!canLaunch) store.setResult(finding, "awaiting-human", "评估通过，但今晚自动修复的名额已用完");
          else launched = await this.launch(finding, item.plan, false, "大改，多模型评估通过后执行（修完等你确认部署）");
        }
      }
    }
    store.mutate((s) => { s.findings.push(finding); });
    return { finding, launched };
  }

  private priorFailures(board: BoardId, key: string): number {
    const cutoff = this.now().getTime() - 14 * 24 * HOUR_MS;
    return this.store.state.findings.filter((f) => f.board === board && f.key === key && f.result === "failed" && Date.parse(f.updatedAt) >= cutoff).length;
  }

  /** 开修复会话；失败时记为待人类审核并说明原因。 */
  private async launch(finding: Finding, plan: Plan, deploy: boolean, why: string): Promise<boolean> {
    try {
      const { sessionId } = await this.deps.launchFix({ findingId: finding.id, board: finding.board, title: `自愈：${clip(plan.title, 30)}`, prompt: fixPrompt(finding, plan, deploy), ...(finding.noteId ? { noteId: finding.noteId } : {}) });
      this.store.addTask(finding, { type: "session", label: deploy ? "修复会话（修完自动部署）" : "修复会话（修完等你确认部署）", ref: sessionId, href: `#/rt/${sessionId}`, status: "running" });
      this.store.setResult(finding, "fixing", `${why}；修复会话已开始`);
      finding.analysis.push(deploy ? "处置：无感知小修，自动开修复会话，通过门禁后自动部署。" : "处置：多模型评估通过，自动开修复会话，修完不自动部署，等你确认。");
      return true;
    } catch (e) {
      this.store.setResult(finding, "awaiting-human", `没能启动修复会话：${clip((e as Error).message, 160)}`);
      return false;
    }
  }

  /* ------------------------------ 对账 ------------------------------ */

  /** 修复中的结论：看会话结束了没有、结果如何；待审核的结论：待办被人处理了就记下。 */
  async reconcile(): Promise<number> {
    const { store } = this.deps;
    store.refresh();
    let changed = 0;
    const now = this.now();
    for (const f of store.state.findings) {
      if (f.result === "fixing") changed += this.reconcileFixing(f, now) ? 1 : 0;
      else if (f.result === "awaiting-human" && f.noteId) {
        const state = this.deps.noteState(f.noteId);
        if (state !== "open") { store.setResult(f, "no-fix", state === "done" ? "你已处理完对应待办" : "你已删除对应待办"); changed++; this.publishResult(f); }
      }
    }
    if (changed) store.mutate(() => undefined);
    return changed;
  }

  private reconcileFixing(f: Finding, now: Date): boolean {
    const task = [...f.tasks].reverse().find((t) => t.type === "session");
    const out = task?.ref ? this.deps.inspectSession(task.ref) : undefined;
    const deploy = !!task?.label.includes("自动部署");
    const fail = (reason: string) => { f.failedAttempts = (f.failedAttempts ?? 0) + 1; this.store.setResult(f, "failed", reason); if (task) task.status = "failed"; this.publishResult(f); return true; };
    if (!out) return fail("修复会话已经不存在");
    if (out.active) {
      if (now.getTime() - Date.parse(task!.at) > FIX_TIMEOUT_MS) return fail("修复会话超过 6 小时还没有结果");
      return false;
    }
    if (task) task.status = "done";
    if (out.lastTurn === "failed") return fail("修复会话最后一轮失败");
    if (out.gone) { this.store.setResult(f, "awaiting-human", "修复会话已归档，无法核实结果，请查看会话"); this.publishResult(f); return true; }
    if (out.commits && out.merged) {
      if (out.head) this.store.addTask(f, { type: "commit", label: `提交 ${out.head.slice(0, 7)}（已合入 main）`, ref: out.head });
      this.store.setResult(f, "fixed", "修复已提交并合入 main");
      if (f.noteId) try { this.deps.completeNote?.(f.noteId); } catch { /* 待办状态由人再处理 */ }
    } else if (out.commits) {
      if (out.head) this.store.addTask(f, { type: "commit", label: `提交 ${out.head.slice(0, 7)}（未合入 main）`, ref: out.head });
      this.store.setResult(f, "awaiting-human", deploy ? "修复已提交，但没有成功上线，请看会话里的部署结果" : "修复已完成并提交，等你确认部署");
    } else if (out.lastTurn === "cancelled") {
      this.store.setResult(f, "awaiting-human", "修复会话被中止，没有提交，请查看会话");
    } else {
      this.store.setResult(f, "no-fix", "修复会话核实后判断不需要改动（没有提交）");
    }
    this.publishResult(f);
    return true;
  }

  /* ------------------------------ 人的决定 ------------------------------ */

  /** 待人类审核的结论：批准（开修复会话，修完等确认部署）或不修复。 */
  async decide(findingId: string, decision: "approve" | "reject"): Promise<Finding> {
    const f = this.store.finding(findingId);
    if (!f) throw new SelfHealError("没有这条结论", "FINDING_NOT_FOUND", 404);
    if (f.result !== "awaiting-human" && f.result !== "failed") throw new SelfHealError("这条结论已经在处理或已有结果，不需要再决定", "FINDING_NOT_PENDING", 409);
    if (decision === "reject") {
      this.store.setResult(f, "no-fix", "你决定不修复");
      this.store.mutate(() => undefined);
      return f;
    }
    const plan = this.planOf(f);
    this.store.addTask(f, { type: "notice", label: "你批准修复" });
    if (!await this.launch(f, plan, false, "你批准修复")) { this.store.mutate(() => undefined); throw new SelfHealError(f.resultReason, "LAUNCH_FAILED", 502); }
    this.store.mutate(() => undefined);
    return f;
  }

  /** 从结论里还原方案（人批准时用）：分析过程里存的是文字，这里优先取错误统计 / 链路分诊里的原始结构。 */
  private planOf(f: Finding): Plan {
    const a = f.source === "stats" ? this.deps.errorStats.store.state.assessments[f.key] : undefined;
    if (a) return { title: a.title, rootCause: a.rootCause, impact: a.impact, proposal: a.proposal, benefit: a.benefit, cost: a.cost, risk: a.risk, acceptance: a.acceptance };
    const t = this.deps.traceFindings().find((x) => x.fingerprint === f.key)?.triage;
    if (t) return { title: t.title, rootCause: t.likelyCause, impact: t.impact, proposal: t.solution, benefit: t.benefit, cost: "未评估", risk: t.risk, acceptance: t.acceptance };
    return { title: f.title, rootCause: f.conclusion, impact: "", proposal: [], benefit: "", cost: "", risk: "", acceptance: [] };
  }

  /* ------------------------------ 通知 ------------------------------ */

  private publishResult(f: Finding): void {
    const board = boardById(f.board)?.name ?? f.board;
    this.deps.notify({ id: `self-heal:${f.id}:${f.result}`, title: `自愈 · ${board} · ${RESULT_LABEL[f.result]}`, body: `${f.title}\n${f.resultReason}` });
  }

  private notifyRun(runId: string, checks: Map<BoardId, Check>, trigger: RunTrigger): void {
    const findings = [...checks.values()].flatMap((c) => c.findingIds).map((id) => this.store.finding(id)).filter((f): f is Finding => !!f);
    const scanned = [...checks.values()].reduce((n, c) => n + c.scanned, 0);
    const need = findings.filter((f) => f.result === "awaiting-human");
    this.deps.notify({
      id: `self-heal:run:${runId}`, title: need.length ? `自愈夜检完成，${need.length} 条需要你审核` : "自愈夜检完成",
      body: `${trigger === "manual" ? "手动" : "夜间"}检查 ${scanned} 条报错，形成 ${findings.length} 条结论；已修复 ${findings.filter((f) => f.result === "fixed").length}，修复中 ${findings.filter((f) => f.result === "fixing").length}，待人类审核 ${need.length}。${need.length ? `\n待审核：${need.slice(0, 5).map((f) => f.title).join("；")}` : ""}`
    });
    for (const f of need) this.publishResult(f);
  }

  /* ------------------------------ 给页面 ------------------------------ */

  overview(): Record<string, unknown> {
    const now = this.now();
    const summaries = this.store.boardSummaries();
    return {
      running: this.running !== null, scheduleHour: SCHEDULE_HOUR, scheduleMinute: SCHEDULE_MINUTE, nextRunAt: nextBeijingRunAt(now, SCHEDULE_HOUR, SCHEDULE_MINUTE).toISOString(),
      maxAutoFixPerRun: this.deps.maxAutoFix ?? MAX_AUTO_FIX_PER_RUN, lastRunAt: this.store.state.lastRunAt ?? null,
      boards: BOARDS.map((b) => {
        const s = summaries.find((x) => x.board === b.id)!;
        return { ...b, settings: this.store.state.settings.boards[b.id] ?? {}, lastCheck: s.lastCheck ?? null, open: s.open, total: s.total };
      })
    };
  }

  boardDetail(id: BoardId, limit = 30): Record<string, unknown> {
    this.store.refresh();
    const def = boardById(id)!;
    const checks = this.store.state.checks.filter((c) => c.board === id).slice(-limit).reverse();
    const findings = new Map(this.store.state.findings.map((f) => [f.id, f]));
    return {
      board: def, settings: this.store.state.settings.boards[id] ?? {}, ignore: this.store.state.settings.ignore.filter((r) => r.board === id),
      checks: checks.map((c) => ({ ...c, findings: c.findingIds.map((fid) => findings.get(fid)).filter(Boolean) }))
    };
  }
}

export class SelfHealError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

/** 每晚北京时间 03:00（UTC 19:00，DeepSeek 波谷）；超过 26 小时没跑过就在启动 5 分钟后补一次（峰时顺延到波谷）。 */
export function startSelfHealScheduler(options: {
  service: SelfHealService; isServing: () => Promise<boolean>; log?: (m: string) => void; now?: () => Date; catchUpDelayMs?: number;
  peak?: (at: Date) => boolean; offPeak?: (at: Date) => Date; reconcileEveryMs?: number;
}): () => void {
  const now = options.now ?? (() => new Date());
  registerPlatformScheduledTask({
    id: "self-heal-nightly", schedule: dailyBeijingSchedule(SCHEDULE_HOUR, SCHEDULE_MINUTE), app: "平台", scene: "自愈", name: "自愈夜检", billing: "deepseek",
    description: "每天北京时间 03:00 汇总上次检查至今的报错，按基础板块分析：无感知小修直接安排修复，大改先多模型评估风险收益，有感知的改动出方案通知你审核；结果和历史在设置的自愈里。",
    source: "apps/web/src/self-heal/service.ts"
  });
  let timer: NodeJS.Timeout | undefined, catchUp: NodeJS.Timeout | undefined, reconcile: NodeJS.Timeout | undefined, stopped = false;
  const fire = async (trigger: RunTrigger) => {
    try {
      if (!(await options.isServing())) { options.log?.("自愈夜检：本进程不是当前在线槽位，跳过"); return; }
      await options.service.runNightly(trigger, false);
    } catch (e) { options.log?.(`自愈夜检失败：${(e as Error).message}`); }
  };
  const schedule = () => {
    if (stopped) return;
    const at = nextBeijingRunAt(now(), SCHEDULE_HOUR, SCHEDULE_MINUTE);
    timer = setTimeout(() => { void fire("schedule").finally(schedule); }, Math.max(1_000, at.getTime() - now().getTime()));
    timer.unref?.();
  };
  if (now().getTime() - options.service.lastRunAt() > 26 * HOUR_MS) {
    const wait = catchUpWait(now(), options.catchUpDelayMs ?? 5 * 60_000, options.peak ?? isPeak, options.offPeak ?? nextOffPeak);
    catchUp = setTimeout(() => { void fire("catch-up"); }, Math.max(1_000, wait));
    catchUp.unref?.();
  }
  // 修复会话在夜检之外结束（部署要排队，可能几小时后）：定期对账，结果状态才不会停在「修复中」
  reconcile = setInterval(() => {
    void (async () => { if (await options.isServing()) await options.service.reconcile(); })().catch((e) => options.log?.(`自愈对账失败：${(e as Error).message}`));
  }, options.reconcileEveryMs ?? 5 * 60_000);
  reconcile.unref?.();
  schedule();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(catchUp); clearInterval(reconcile); };
}
