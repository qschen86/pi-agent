/**
 * 自愈的持久层：<dataDir>/diagnostics/self-heal/state.json，原子写。
 * - settings：每个板块的分析模型 / 推理强度、被屏蔽的报错规则
 * - checks：每晚每个板块一次检查（分析结论 + 关联的 finding）
 * - findings：一条结论（一个根因）及它的结果状态、关联任务与状态变化历史
 *
 * 蓝绿两个 Web 进程可能同时在线：每次读写前按文件修改时间重读，写入走临时文件 + rename。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BOARDS, type BoardId } from "./boards.js";

/** 结果状态：每次检查最终都要落到其中一个。 */
export type Result = "fixed" | "no-fix" | "awaiting-human" | "fixing" | "evaluating" | "failed";
export const RESULT_LABEL: Record<Result, string> = {
  fixed: "已修复", "no-fix": "不修复", "awaiting-human": "待人类审核", fixing: "修复中", evaluating: "评估中", failed: "处理失败"
};
/** 还在处理的状态：同一个问题再出现时不另起一条。 */
export const OPEN_RESULTS: ReadonlySet<Result> = new Set(["fixing", "evaluating", "awaiting-human"]);

/** 改动类别：none=不需要改；small=无感知小修；large=无感知大改；perceptible=用户可感知的功能改动。 */
export type FixClass = "none" | "small" | "large" | "perceptible";

export interface TaskRef {
  id: string;
  type: "note" | "session" | "commit" | "notice" | "evaluation";
  label: string;
  /** 会话 id / 待办 id / commit 等 */
  ref?: string;
  href?: string;
  at: string;
  status?: string;
}

export interface Finding {
  id: string;
  board: BoardId;
  source: "stats" | "trace";
  /** 去重键：错误统计的指纹 / 链路 finding 的指纹 */
  key: string;
  title: string;
  conclusion: string;
  /** 分析过程：默认折叠，点开才看 */
  analysis: string[];
  verdict: "do" | "skip" | "unsure";
  confidence: "high" | "medium" | "low";
  fixClass: FixClass;
  result: Result;
  resultReason: string;
  noteId?: string;
  tasks: TaskRef[];
  history: Array<{ at: string; result: Result; reason: string }>;
  /** 自动修复连续失败次数：达到上限不再自动重试 */
  failedAttempts?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Check {
  id: string;
  runId: string;
  board: BoardId;
  trigger: "schedule" | "catch-up" | "manual";
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ok" | "failed";
  /** 本次检查覆盖的报错条数（上次检查至今） */
  scanned: number;
  /** 被屏蔽规则过滤掉的结论数 */
  ignored: number;
  summary: string;
  findingIds: string[];
  costUsd: number;
}

export interface IgnoreRule { id: string; board: BoardId; match: string; reason: string; createdAt: string }
export interface BoardSettings { model?: string; effort?: string }
export interface Settings { boards: Partial<Record<BoardId, BoardSettings>>; ignore: IgnoreRule[] }

export interface State { version: 1; settings: Settings; checks: Check[]; findings: Finding[]; lastRunAt?: string }

const KEEP_CHECK_DAYS = 90;
const DAY_MS = 86_400_000;
const empty = (): State => ({ version: 1, settings: { boards: {}, ignore: [] }, checks: [], findings: [] });

export class SelfHealStore {
  readonly file: string;
  private mtime = 0;
  state: State;
  private now: () => Date;

  constructor(options: { dir: string; now?: () => Date }) {
    this.file = join(options.dir, "self-heal", "state.json");
    this.now = options.now ?? (() => new Date());
    this.state = this.load();
  }

  private load(): State {
    try {
      if (!existsSync(this.file)) return empty();
      this.mtime = statSync(this.file).mtimeMs;
      const s = JSON.parse(readFileSync(this.file, "utf8")) as State;
      if (!s || s.version !== 1) return empty();
      return { ...empty(), ...s, settings: { boards: s.settings?.boards ?? {}, ignore: s.settings?.ignore ?? [] } };
    } catch { return empty(); }
  }

  /** 另一个进程改过文件才重读。 */
  refresh(): void {
    try { if (existsSync(this.file) && statSync(this.file).mtimeMs !== this.mtime) this.state = this.load(); } catch { /* 读不到就沿用内存 */ }
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
    try { this.mtime = statSync(this.file).mtimeMs; } catch { /* 下次重读 */ }
  }

  /** 先重读再改再存。 */
  mutate<T>(fn: (state: State) => T): T {
    this.refresh();
    const out = fn(this.state);
    this.save();
    return out;
  }

  /* ------------------------------ 设置 ------------------------------ */

  boardSettings(board: BoardId): BoardSettings { this.refresh(); return this.state.settings.boards[board] ?? {}; }

  setBoardSettings(board: BoardId, patch: BoardSettings): BoardSettings {
    return this.mutate((s) => {
      const next: BoardSettings = { ...s.settings.boards[board] };
      for (const key of ["model", "effort"] as const) {
        if (key in patch) { const v = patch[key]; if (v) next[key] = v; else delete next[key]; }
      }
      if (Object.keys(next).length) s.settings.boards[board] = next; else delete s.settings.boards[board];
      return next;
    });
  }

  addIgnore(board: BoardId, match: string, reason: string): IgnoreRule {
    return this.mutate((s) => {
      const existing = s.settings.ignore.find((r) => r.board === board && r.match === match);
      if (existing) return existing;
      const rule: IgnoreRule = { id: randomUUID().slice(0, 8), board, match, reason, createdAt: this.now().toISOString() };
      s.settings.ignore.push(rule);
      return rule;
    });
  }

  removeIgnore(id: string): boolean {
    return this.mutate((s) => { const n = s.settings.ignore.length; s.settings.ignore = s.settings.ignore.filter((r) => r.id !== id); return s.settings.ignore.length < n; });
  }

  /** 这条结论命中了哪条屏蔽规则（按去重键或标题包含匹配）。 */
  ignoredBy(board: BoardId, key: string, title: string): IgnoreRule | undefined {
    this.refresh();
    return this.state.settings.ignore.find((r) => r.board === board && (key.includes(r.match) || title.includes(r.match)));
  }

  /* ------------------------------ 检查 / 结论 ------------------------------ */

  finding(id: string): Finding | undefined { this.refresh(); return this.state.findings.find((f) => f.id === id); }

  /** 同一个问题还在处理中（或近期刚判过不修）就复用，不另起一条。 */
  reusable(board: BoardId, key: string, now: Date): Finding | undefined {
    this.refresh();
    return [...this.state.findings].reverse().find((f) => f.board === board && f.key === key
      && (OPEN_RESULTS.has(f.result) || (f.result === "no-fix" && now.getTime() - Date.parse(f.updatedAt) < 14 * DAY_MS)));
  }

  /** 状态变化：写入历史；相同状态只更新原因。 */
  setResult(f: Finding, result: Result, reason: string): void {
    const at = this.now().toISOString();
    if (f.result !== result || f.resultReason !== reason) f.history.push({ at, result, reason });
    f.result = result; f.resultReason = reason; f.updatedAt = at;
  }

  addTask(f: Finding, task: Omit<TaskRef, "id" | "at"> & { at?: string }): TaskRef {
    const t: TaskRef = { id: randomUUID().slice(0, 8), at: task.at ?? this.now().toISOString(), ...task };
    f.tasks.push(t); f.updatedAt = t.at;
    return t;
  }

  /** 每个板块最近一次检查与待处理数（板块卡片用）。 */
  boardSummaries(): Array<{ board: BoardId; lastCheck?: Check; open: number; total: number }> {
    this.refresh();
    return BOARDS.map((b) => {
      const checks = this.state.checks.filter((c) => c.board === b.id);
      const findings = this.state.findings.filter((f) => f.board === b.id);
      const lastCheck = checks.reduce<Check | undefined>((a, c) => (!a || c.startedAt >= a.startedAt ? c : a), undefined);
      return { board: b.id, ...(lastCheck ? { lastCheck } : {}), open: findings.filter((f) => f.result === "awaiting-human" || f.result === "failed").length, total: findings.length };
    });
  }

  prune(): void {
    const cutoff = this.now().getTime() - KEEP_CHECK_DAYS * DAY_MS;
    this.state.checks = this.state.checks.filter((c) => Date.parse(c.startedAt) >= cutoff);
    const referenced = new Set(this.state.checks.flatMap((c) => c.findingIds));
    this.state.findings = this.state.findings.filter((f) => OPEN_RESULTS.has(f.result) || referenced.has(f.id) || Date.parse(f.updatedAt) >= cutoff);
  }
}
