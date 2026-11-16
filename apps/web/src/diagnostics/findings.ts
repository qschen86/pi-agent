/**
 * 诊断 finding（V1.4 §7）：一个指纹在一个 episode 里的问题，以及它的分诊结论、待办与验证状态。
 * 故障结论只以这里为准；待办完成或删除只记录，不改变 finding 的结论，也不触发抑制。
 *
 * 存在 <dataRoot>/diagnostics/findings.json。蓝绿切换期间两个 Web 进程可能同时在线，
 * 所以读改写都在跨进程文件锁（diagnostics/.lock，带租约）里做，锁内先重读文件。
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type FindingStatus =
  | "pending_triage" | "no_fix" | "uncertain" | "triage_failed"
  | "fix_proposed" | "fixing" | "awaiting_release" | "observing" | "verified" | "insufficient" | "recurred"
  | "ignored" | "note_deleted";

export const STATUS_LABEL: Record<FindingStatus, string> = {
  pending_triage: "等待 AI 分诊", no_fix: "AI 判断不需要修复", uncertain: "AI 判断不确定", triage_failed: "分诊失败，稍后重试",
  fix_proposed: "AI 建议修复，等你决定", fixing: "修复中", awaiting_release: "已修复，等待上线", observing: "已上线，观察中",
  verified: "已验证修复", insufficient: "证据不足，无法确认是否修好", recurred: "修复后再次出现", ignored: "已忽略", note_deleted: "待办已删除"
};
/** 活跃：同指纹再出现时只更新计数，不另起一条 */
export const ACTIVE: ReadonlySet<FindingStatus> = new Set(["pending_triage", "fix_proposed", "fixing", "awaiting_release", "observing", "triage_failed"]);

export type Triage = {
  coveredBy?: string;
  at: string; inputHash: string; verdict: "fix" | "no_fix" | "uncertain"; confidence: "high" | "medium" | "low";
  title: string; symptom: string; impact: string; likelyCause: string; evidence: string[];
  solution: string[]; benefit: string; risk: string; acceptance: string[]; noiseReason?: string;
  usage?: { input: number; output: number; cacheRead: number; costUsd: number }; model?: string;
};
export type Finding = {
  id: string; key: string; source: "scan" | "report"; fingerprint: string; episode: number;
  status: FindingStatus; noteId?: string; bundleIds: string[];
  component?: string; errorType?: string; summary?: string;
  occurrences: number; sessions: number; releases: string[]; firstSeen: string; lastSeen: string;
  triage?: Triage; triagedOccurrences?: number; triageAttempts?: number;
  ignoredUntil?: string; noteDone?: { at: string; by: "archive" | "user" | "unknown" };
  /** 「待分析」占位待办：之后分诊成功时允许把正文换成分析结果一次 */
  noteRewritable?: boolean;
  /** 建待办的意图（先落盘再建）：建完还没记下 noteId 就崩溃时，重试按证据包链接认领，不重复建 */
  notePending?: string;
  /** C 期：从这条待办发起的修复会话（证据包已复制到其工作目录） */
  repairSessions?: Array<{ platformSessionId: string; workspace: string; preparedAt: string; runtimeKind: string | null }>;
  /** C 期：最近一次导入的修复会话报告摘要（结论以会话为准） */
  repair?: { platformSessionId: string; importedAt: string; reportHash: string; disposition: string; evidenceLevel: string; summary: string; agreesWithTriage: boolean | null; limitations: string[]; exit: string };
  fix?: { commit?: string; tests?: string[]; mergedAt?: string; releasedIn?: string; activatedAt?: string };
  verification?: { at: string; result: "pending" | "verified" | "insufficient" | "recurred"; detail: string;
    progress?: { days: number; attempts: number; minAttempts: number; observeDays: number; recurrences: number; quality: string } };
  history: Array<{ at: string; status: FindingStatus; reason: string }>;
  createdAt: string; updatedAt: string;
};
type State = { schema: 1; findings: Finding[]; triageRuns: Array<{ date: string; startedAt: string; finishedAt?: string; triaged: number; costUsd: number; skipped?: string }>; watermark?: { bundlesThrough: string } };

const LOCK_LEASE_MS = 120_000;

export class FindingStore {
  readonly file: string;
  private lockFile: string;
  private now: () => Date;
  private state: State = { schema: 1, findings: [], triageRuns: [] };

  constructor(dir: string, now: () => Date = () => new Date()) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "findings.json");
    this.lockFile = join(dir, ".lock");
    this.now = now;
    this.reload();
  }

  private loadedMtime = 0;
  /** 另一个进程改过文件才重读（/api/notes 每次装饰都会调用） */
  reloadIfChanged(): void {
    try { const m = statSync(this.file).mtimeMs; if (m !== this.loadedMtime) this.reload(); } catch { /* 还没有文件 */ }
  }
  reload(): void {
    try { this.loadedMtime = statSync(this.file).mtimeMs; } catch { /* 还没有文件 */ }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as State;
      if (parsed && parsed.schema === 1 && Array.isArray(parsed.findings)) this.state = { ...parsed, triageRuns: parsed.triageRuns ?? [] };
    } catch { /* 没有文件或损坏：从空开始，损坏的文件保留给人工排查 */ }
  }
  /** 锁内中途落盘（建待办前先记下意图） */
  persist(): void { this.save(); }
  private save(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    renameSync(tmp, this.file);
    try { this.loadedMtime = statSync(this.file).mtimeMs; } catch { /* 刚写完 */ }
  }

  /**
   * 跨进程锁：O_EXCL 建锁文件；锁超过租约（进程崩溃留下的）就接管。拿不到锁时最多等 waitMs。
   * fn 内的修改在锁内保存。
   */
  withLock<T>(fn: (s: FindingStore) => T, waitMs = 5_000): T {
    const deadline = Date.now() + waitMs;
    let fd: number | null = null;
    for (;;) {
      try { fd = openSync(this.lockFile, "wx"); writeSync(fd, `${process.pid} ${new Date().toISOString()}`); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try { if (Date.now() - statSync(this.lockFile).mtimeMs > LOCK_LEASE_MS) { unlinkSync(this.lockFile); continue; } } catch { continue; }
        if (Date.now() > deadline) throw new Error("诊断状态正被另一个进程占用，稍后再试");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      this.reload();
      const out = fn(this);
      this.save();
      return out;
    } finally {
      try { closeSync(fd!); } catch { /* 已关 */ }
      try { unlinkSync(this.lockFile); } catch { /* 已删 */ }
    }
  }

  all(): Finding[] { return this.state.findings; }
  byKey(key: string): Finding | undefined { return this.state.findings.find((f) => f.key === key); }
  byNote(noteId: string): Finding | undefined { return this.state.findings.find((f) => f.noteId === noteId); }
  byId(id: string): Finding | undefined { return this.state.findings.find((f) => f.id === id); }
  /** 同指纹最新的一条（按 episode） */
  latest(fingerprint: string): Finding | undefined {
    return this.state.findings.filter((f) => f.fingerprint === fingerprint && f.source === "scan").sort((a, b) => b.episode - a.episode)[0];
  }
  noteIds(): Map<string, Finding> { return new Map(this.state.findings.filter((f) => f.noteId).map((f) => [f.noteId!, f])); }

  create(input: Omit<Finding, "id" | "history" | "createdAt" | "updatedAt" | "status"> & { status?: FindingStatus; reason?: string }): Finding {
    const at = this.now().toISOString();
    const { reason, status, ...rest } = input;
    const f: Finding = { id: `f${randomBytes(8).toString("hex")}`, ...rest, status: status ?? "pending_triage", history: [{ at, status: status ?? "pending_triage", reason: reason ?? "新问题" }], createdAt: at, updatedAt: at };
    this.state.findings.push(f);
    return f;
  }
  setStatus(f: Finding, status: FindingStatus, reason: string): void {
    if (f.status === status) return;
    const at = this.now().toISOString();
    f.status = status; f.updatedAt = at;
    f.history.push({ at, status, reason: reason.slice(0, 200) });
    if (f.history.length > 50) f.history.splice(0, f.history.length - 50);
  }
  touch(f: Finding): void { f.updatedAt = this.now().toISOString(); }

  get watermark(): string | undefined { return this.state.watermark?.bundlesThrough; }
  setWatermark(iso: string): void { this.state.watermark = { bundlesThrough: iso }; }
  runs(): State["triageRuns"] { return this.state.triageRuns; }
  addRun(run: State["triageRuns"][number]): void { this.state.triageRuns.push(run); if (this.state.triageRuns.length > 60) this.state.triageRuns.splice(0, this.state.triageRuns.length - 60); }
  spentToday(date: string): number { return this.state.triageRuns.filter((r) => r.date === date).reduce((n, r) => n + (r.costUsd || 0), 0); }
}
