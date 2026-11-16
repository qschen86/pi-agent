/**
 * Codex reset 的本地台账：一个 JSON 文件（<dataDir>/codex-reset/state.json），原子写。
 *
 * 为什么要本地存一份：后端流水接口只保留 30 天（window_start 会往前滚），
 * 想回答「过去 7 天 / 30 天用了几张」「累计拿过几张」就必须自己按卡把时刻记下来。
 * 记录只含卡 ID、发放时刻、使用时刻和扫描历史，不含笔记、会话或任何对话内容。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CreditLedger, ResetCredit, ResetEvent } from "./collect.js";
import { mergeLedger } from "./collect.js";

export const MAX_SCANS = 60;

export type ScanTrigger = "schedule" | "catch-up" | "manual";
export type ScanStatus = "running" | "ok" | "failed";

export interface ScanRecord {
  id: string;
  trigger: ScanTrigger;
  status: ScanStatus;
  startedAt: string;
  finishedAt?: string;
  availableCount?: number;
  newGranted: string[];
  newUsed: string[];
  error?: string;
}

export interface LatestSnapshot {
  at: string;
  availableCount: number;
  totalEarnedCount: number;
  credits: ResetCredit[];
  historyWindowStart: string | null;
}

export interface CodexResetState {
  version: 1;
  ledger: CreditLedger;
  scans: ScanRecord[];
  latest?: LatestSnapshot;
}

export function emptyState(): CodexResetState {
  return { version: 1, ledger: {}, scans: [] };
}

export class CodexResetStore {
  readonly file: string;
  private loaded: CodexResetState | null = null;

  constructor(options: { dir: string; file?: string }) {
    this.file = options.file ?? join(options.dir, "state.json");
  }

  get state(): CodexResetState {
    if (!this.loaded) this.loaded = this.read();
    return this.loaded;
  }

  private read(): CodexResetState {
    if (!existsSync(this.file)) return emptyState();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CodexResetState> | null;
      return {
        version: 1,
        ledger: raw && typeof raw.ledger === "object" && raw.ledger ? raw.ledger : {},
        scans: Array.isArray(raw?.scans) ? (raw.scans as ScanRecord[]) : [],
        ...(raw?.latest && typeof raw.latest === "object" ? { latest: raw.latest } : {})
      };
    } catch {
      // 文件坏了不能挡住扫描：当作空台账继续，下一次写入就会修好它
      return emptyState();
    }
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }

  /** 最近一次成功扫描的时刻（毫秒）；没有则 0。 */
  lastFinishedAt(): number {
    for (let i = this.state.scans.length - 1; i >= 0; i -= 1) {
      const scan = this.state.scans[i]!;
      if (scan.status === "ok" && scan.finishedAt) return Date.parse(scan.finishedAt) || 0;
    }
    return 0;
  }

  hasRunning(): boolean {
    return this.state.scans.some((scan) => scan.status === "running");
  }

  /** 把一次拉到的流水并进台账，返回本次新出现的发放 / 使用（用于「有新卡」提示）。 */
  mergeEvents(events: ResetEvent[]): { newGranted: string[]; newUsed: string[] } {
    const merged = mergeLedger(this.state.ledger, events);
    this.state.ledger = merged.ledger;
    return { newGranted: merged.newGranted, newUsed: merged.newUsed };
  }

  setLatest(latest: LatestSnapshot): void {
    this.state.latest = latest;
  }

  /** 按 id 覆盖同一轮记录，保留最近 MAX_SCANS 轮，然后落盘。 */
  append(scan: ScanRecord): void {
    const at = this.state.scans.findIndex((item) => item.id === scan.id);
    if (at >= 0) this.state.scans[at] = scan; else this.state.scans.push(scan);
    if (this.state.scans.length > MAX_SCANS) this.state.scans.splice(0, this.state.scans.length - MAX_SCANS);
    this.save();
  }
}
