/**
 * 上下文缓存监控的诊断待办与证据包桥接：
 * - 复用 diagnostics/notes-adapter 的 diagnosticNotes（自动钉死在「平台 / debug」待办分类、人工开发判定、不进整理池）。
 * - 按 dedupKey（runtime + 异常类型 + 平台版本 + CLI 版本）去重：同一根因已有未关闭待办时只追加样本并更新证据包与待办正文，绝不产生告警风暴。
 * - 证据包存为结构化 JSON，支持经只读 HTTP 接口查看，也支持从待办发起会话后直接读取。
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CacheAlertEvent, CacheAlertReason, CacheMonitorSample, RuntimeKind } from "@pi-agent/runtime-sessions";
import { RUNTIME_LABEL } from "@pi-agent/runtime-sessions";
import type { DiagnosticNotes, NoteAnalysis } from "./diagnostics/triage.js";

const REASON_TITLE: Record<CacheAlertReason, string> = {
  "prefix-drift": "同版本内前缀/MCP 参数漂移",
  "severe-drop": "热续聊首调缓存严重跌穿",
  "degraded-streak": "热续聊首调命中率连续退化"
};

export interface CacheAlertIndexEntry {
  alertId: string;
  dedupKey: string;
  noteId: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

export interface CacheAlertBundle {
  schema: 1;
  alertId: string;
  dedupKey: string;
  reason: CacheAlertReason;
  reasonLabel: string;
  runtimeKind: RuntimeKind;
  runtimeLabel: string;
  model: string;
  platformSha: string;
  cliVersion: string;
  expectedMinHitRate: number;
  warmWindowMs: number;
  count: number;
  firstAt: string;
  lastAt: string;
  prefixChangedFields: string[];
  recentCommits: string[];
  samples: CacheMonitorSample[];
}

interface IndexFile {
  version: 1;
  byKey: Record<string, CacheAlertIndexEntry>;
}

const ALERT_ID_RE = /^ca-[0-9a-f-]{8,40}$/;

function fmtPct(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}

function fmtGap(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m} 分 ${rem} 秒` : `${m} 分钟`;
}

function fmtTokens(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, "")} 万`;
  return String(Math.round(n));
}

function readRecentCommits(repoRoot: string | undefined): string[] {
  if (!repoRoot) return [];
  try {
    return execFileSync("git", ["-C", repoRoot, "log", "-n", "5", "--oneline"], { encoding: "utf8", timeout: 3000 })
      .trim().split("\n").filter(Boolean);
  } catch { return []; }
}

export function formatCacheAlertTodo(bundle: CacheAlertBundle, bundlePath: string): { text: string; analysis: NoteAnalysis } {
  const latest = bundle.samples.at(-1)!;
  const hitStr = fmtPct(latest.hitRate);
  const baseStr = fmtPct(bundle.expectedMinHitRate);
  const title = `[缓存监控 · 异常] ${bundle.runtimeLabel} ${REASON_TITLE[bundle.reason]}（首调 ${hitStr}，基线 ${baseStr}）`;
  const prefixLine = bundle.prefixChangedFields.length
    ? `前缀指纹：同版本内发生漂移（${bundle.prefixChangedFields.join("；")}）`
    : "前缀指纹：平台侧系统提示与 MCP 传参哈希未变（需排查上游 CLI / 服务端 / 隐式配置变化）";

  const recentLines = bundle.samples.slice(-5).map((s) =>
    `- ${s.at.slice(0, 19).replace("T", " ")}Z · 会话 ${s.platformSessionId}${s.sessionTitle ? `（${s.sessionTitle}）` : ""} 第 ${s.turnNo} 轮 · 空闲 ${fmtGap(s.idleMs)} · 上轮 ${fmtTokens(s.prevContextTokens)} → 首调命中 ${fmtPct(s.hitRate)}（多算约 ${fmtTokens(s.wastedTokens)} tokens，来源 ${s.source}）`
  );

  const lines = [
    title,
    `现象：${bundle.runtimeLabel}（${bundle.model}）在 ${Math.round(bundle.warmWindowMs / 60_000)} 分钟热窗内续聊，跨回合首调命中率掉至 ${hitStr}（累计触发 ${bundle.count} 次）。`,
    prefixLine,
    `版本：平台 ${bundle.platformSha.slice(0, 12)} · CLI ${bundle.cliVersion}`,
    "最近触发样本：",
    ...recentLines,
    ...(bundle.recentCommits.length ? ["近期提交：", ...bundle.recentCommits.map((c) => `- ${c}`)] : []),
    `证据包：/api/diagnostics/cache-alerts/${bundle.alertId}`,
    `证据文件：${bundlePath}`,
    "排查提示：直接从这条待办发起会话，读取上述证据文件即可复盘前后轮的提示词、MCP 配置与原生对话库。"
  ];

  const analysis: NoteAnalysis = {
    title,
    summary: `${bundle.runtimeLabel} 热续聊首调命中率降至 ${hitStr}（基线 ${baseStr}），${bundle.prefixChangedFields.length ? `同版本内检测到 ${bundle.prefixChangedFields.join("、")} 漂移` : "平台前缀哈希未变，需排查上游 CLI / 服务端 / 隐式配置变化"}`,
    acceptance: [
      `定位 ${bundle.runtimeLabel} 热续聊首调缓存未命中的根因`,
      `修复后新开会话跨回合首调命中率恢复至基线 ${baseStr} 以上，并补齐回归测试`
    ],
    value: bundle.reason === "prefix-drift" || bundle.reason === "severe-drop" ? "high" : "medium",
    valueBasis: `单次热续聊多算约 ${fmtTokens(latest.wastedTokens)} tokens，已累计触发 ${bundle.count} 次`
  };
  return { text: lines.join("\n"), analysis };
}

export interface CacheAlertServiceOptions {
  dir: string;
  notes: Pick<DiagnosticNotes, "create" | "rewrite" | "state">;
  repoRoot?: string;
  isServing?: () => Promise<boolean>;
  log?: (message: string) => void;
}

export class CacheAlertService {
  private readonly dir: string;
  private readonly indexPath: string;
  private index: IndexFile;

  constructor(private readonly opts: CacheAlertServiceOptions) {
    this.dir = join(opts.dir, "cache-alerts");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.indexPath = join(this.dir, "index.json");
    this.index = this.loadIndex();
  }

  handle(event: CacheAlertEvent): Promise<{ alertId: string; noteId: string; updated: boolean } | undefined> {
    return this.handleAsync(event).catch((e) => {
      this.opts.log?.(`缓存异常待办创建失败：${(e as Error).message}`);
      return undefined;
    });
  }

  private async handleAsync(event: CacheAlertEvent): Promise<{ alertId: string; noteId: string; updated: boolean } | undefined> {
    if (this.opts.isServing && !(await this.opts.isServing())) return undefined;
    const now = event.sample.at || new Date().toISOString();
    const existing = this.index.byKey[event.dedupKey];
    const existingOpen = existing && this.opts.notes.state(existing.noteId) === "open" ? existing : undefined;

    if (existingOpen) {
      const bundlePath = this.bundlePath(existingOpen.alertId);
      const prevBundle = this.readBundle(existingOpen.alertId);
      const mergedSamples = dedupSamples([...(prevBundle?.samples ?? []), ...event.recentSamples, event.sample]).slice(-10);
      const changedFields = [...new Set([...(prevBundle?.prefixChangedFields ?? []), ...event.sample.prefixChangedFields])];
      const nextCount = existingOpen.count + 1;
      const bundle: CacheAlertBundle = {
        schema: 1,
        alertId: existingOpen.alertId,
        dedupKey: event.dedupKey,
        reason: event.reason,
        reasonLabel: REASON_TITLE[event.reason],
        runtimeKind: event.runtimeKind,
        runtimeLabel: RUNTIME_LABEL[event.runtimeKind],
        model: event.model,
        platformSha: event.platformSha,
        cliVersion: event.cliVersion,
        expectedMinHitRate: event.expectedMinHitRate,
        warmWindowMs: event.warmWindowMs,
        count: nextCount,
        firstAt: existingOpen.firstAt,
        lastAt: now,
        prefixChangedFields: changedFields,
        recentCommits: prevBundle?.recentCommits?.length ? prevBundle.recentCommits : readRecentCommits(this.opts.repoRoot),
        samples: mergedSamples
      };
      this.writeJson(bundlePath, bundle);
      const { text, analysis } = formatCacheAlertTodo(bundle, bundlePath);
      this.opts.notes.rewrite(existingOpen.noteId, text, analysis);
      this.index.byKey[event.dedupKey] = { ...existingOpen, count: nextCount, lastAt: now };
      this.saveIndex();
      return { alertId: existingOpen.alertId, noteId: existingOpen.noteId, updated: true };
    }

    const alertId = `ca-${randomUUID().slice(0, 12)}`;
    const bundlePath = this.bundlePath(alertId);
    const samples = dedupSamples([...event.recentSamples, event.sample]).slice(-10);
    const bundle: CacheAlertBundle = {
      schema: 1,
      alertId,
      dedupKey: event.dedupKey,
      reason: event.reason,
      reasonLabel: REASON_TITLE[event.reason],
      runtimeKind: event.runtimeKind,
      runtimeLabel: RUNTIME_LABEL[event.runtimeKind],
      model: event.model,
      platformSha: event.platformSha,
      cliVersion: event.cliVersion,
      expectedMinHitRate: event.expectedMinHitRate,
      warmWindowMs: event.warmWindowMs,
      count: 1,
      firstAt: now,
      lastAt: now,
      prefixChangedFields: [...event.sample.prefixChangedFields],
      recentCommits: readRecentCommits(this.opts.repoRoot),
      samples
    };
    this.writeJson(bundlePath, bundle);
    const { text, analysis } = formatCacheAlertTodo(bundle, bundlePath);
    const noteId = this.opts.notes.create(text, analysis);
    this.index.byKey[event.dedupKey] = { alertId, dedupKey: event.dedupKey, noteId, count: 1, firstAt: now, lastAt: now };
    this.saveIndex();
    return { alertId, noteId, updated: false };
  }

  readBundle(alertId: string): CacheAlertBundle | null {
    if (!ALERT_ID_RE.test(alertId)) return null;
    const p = this.bundlePath(alertId);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf8")) as CacheAlertBundle; }
    catch { return null; }
  }

  private bundlePath(alertId: string): string {
    return join(this.dir, `${alertId}.json`);
  }

  private loadIndex(): IndexFile {
    if (!existsSync(this.indexPath)) return { version: 1, byKey: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as Partial<IndexFile>;
      return { version: 1, byKey: parsed.byKey && typeof parsed.byKey === "object" ? parsed.byKey : {} };
    } catch { return { version: 1, byKey: {} }; }
  }

  private saveIndex(): void {
    this.writeJson(this.indexPath, this.index);
  }

  private writeJson(file: string, data: unknown): void {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }
}

function dedupSamples(samples: CacheMonitorSample[]): CacheMonitorSample[] {
  const map = new Map<string, CacheMonitorSample>();
  for (const s of samples) map.set(`${s.platformSessionId}:${s.turnNo}:${s.at}`, s);
  return [...map.values()].sort((a, b) => a.at.localeCompare(b.at));
}
