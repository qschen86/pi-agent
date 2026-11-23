/**
 * runtime 版本更新的本地台账：一个 JSON 文件（<dataDir>/runtime-updates/state.json），原子写。
 * - runtimes：每个 runtime 最近一次检测到的稳定版发布记录（含更新日志原文，最多 40 版）、最新版、检测时间与错误
 * - installLog：平台观察到的「已装版本」变化（升级记录），升级由人手动做，平台只在下一次检测时发现并记下
 * - checks：检测历史
 * - analyses：人点「分析」后生成的收益 / 风险报告（每个 runtime 只留最新一份）
 * - ignored：人选择「忽略这个版本」的版本号，红点与提示只对更新的版本再亮起
 * 蓝绿两个槽位共用这个文件：每次读取前看一眼修改时间，别人写过就重新载入。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReleaseInfo, UpdateKind } from "./sources.js";
import type { AnalysisValue } from "./analysis.js";

export const MAX_CHECKS = 40;
export const MAX_INSTALL_LOG = 60;

export interface ReleaseRecord extends ReleaseInfo { firstSeenAt: string }
export interface RuntimeRecord { latest?: string; releases: ReleaseRecord[]; checkedAt?: string; error?: string; installed?: string; ignored?: string }
export interface InstallLogEntry { kind: UpdateKind; from?: string; to: string; at: string }
export type CheckTrigger = "schedule" | "catch-up" | "manual";
export interface CheckRecord {
  id: string; trigger: CheckTrigger; status: "running" | "ok" | "failed";
  startedAt: string; finishedAt?: string;
  /** 本次新发现的稳定版（此前没见过） */
  found: Array<{ kind: UpdateKind; version: string }>;
  errors: Array<{ kind: UpdateKind; error: string }>;
}
export interface AnalysisRecord { kind: UpdateKind; installed: string; latest: string; notesHash: string; at: string; costUsd: number; model?: string; value: AnalysisValue }
export interface RuntimeUpdatesState {
  version: 1;
  runtimes: Partial<Record<UpdateKind, RuntimeRecord>>;
  installLog: InstallLogEntry[];
  checks: CheckRecord[];
  analyses: Partial<Record<UpdateKind, AnalysisRecord>>;
}

const empty = (): RuntimeUpdatesState => ({ version: 1, runtimes: {}, installLog: [], checks: [], analyses: {} });

export class RuntimeUpdatesStore {
  readonly file: string;
  private loaded: RuntimeUpdatesState | null = null;
  private mtimeMs = -1;

  constructor(options: { dir: string; file?: string }) { this.file = options.file ?? join(options.dir, "state.json"); }

  get state(): RuntimeUpdatesState {
    const mtime = existsSync(this.file) ? statSync(this.file).mtimeMs : 0;
    if (!this.loaded || mtime !== this.mtimeMs) { this.loaded = this.read(); this.mtimeMs = mtime; }
    return this.loaded;
  }

  private read(): RuntimeUpdatesState {
    if (!existsSync(this.file)) return empty();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RuntimeUpdatesState> | null;
      return {
        version: 1,
        runtimes: raw && typeof raw.runtimes === "object" && raw.runtimes ? raw.runtimes : {},
        installLog: Array.isArray(raw?.installLog) ? raw!.installLog! : [],
        checks: Array.isArray(raw?.checks) ? raw!.checks! : [],
        analyses: raw && typeof raw.analyses === "object" && raw.analyses ? raw.analyses : {}
      };
    } catch { return empty(); /* 文件坏了不能挡住检测：当作空台账，下一次写入会修好它 */ }
  }

  save(): void {
    const s = this.state;
    s.checks = s.checks.slice(-MAX_CHECKS);
    s.installLog = s.installLog.slice(-MAX_INSTALL_LOG);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, this.file);
    this.mtimeMs = statSync(this.file).mtimeMs;
  }

  /** 最近一次成功检测的时刻（毫秒）；没有则 0。 */
  lastFinishedAt(): number {
    for (let i = this.state.checks.length - 1; i >= 0; i -= 1) {
      const c = this.state.checks[i]!;
      if (c.status === "ok" && c.finishedAt) return Date.parse(c.finishedAt) || 0;
    }
    return 0;
  }
}
