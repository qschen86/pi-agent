/**
 * 门禁 flaky（每晚错误统计的第四类来源，docs/requirements/gate-flaky-quarantine）：
 * 隔离名单由门禁自己写（scripts/flaky-quarantine.mjs，在全机唯一的 gate 锁内），这里只读：
 * 给待办正文和「设置 → 错误统计」的只读列表用。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beijingDateKey, beijingStamp } from "../platform-time.js";
import type { FingerprintStat } from "./store.js";

/** 近 7 天「复跑才通过」达到这个次数就触发（与 scripts/flaky-quarantine.mjs 的 FLAKY_THRESHOLD 一致，有测试锁住）。 */
export const GATE_FLAKY_MIN_7D = 3;
export const GATE_FLAKY_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

export interface QuarantineEntry { file: string; since: string; expiresAt: string; count?: number }
export interface QuarantineRelease { file: string; at: string; reason: string; suspectedRegression?: boolean }
export interface QuarantineView {
  entries: Array<QuarantineEntry & { runs: number; red: number }>;
  released: QuarantineRelease[];
}

const testGatesDir = (guiRoot: string) => join(guiRoot, "test-gates");

export function readQuarantine(guiRoot: string, now = Date.now()): QuarantineView {
  try {
    const s = JSON.parse(readFileSync(join(testGatesDir(guiRoot), "quarantine.json"), "utf8")) as { version?: number; entries?: QuarantineEntry[]; released?: QuarantineRelease[]; runs?: Record<string, Array<{ ok: boolean }>> };
    if (s.version !== 1) return { entries: [], released: [] };
    const entries = (s.entries ?? []).filter((e) => Date.parse(e.expiresAt) > now).map((e) => {
      const runs = s.runs?.[e.file] ?? [];
      return { ...e, runs: runs.length, red: runs.filter((r) => !r.ok).length };
    });
    return { entries, released: (s.released ?? []).filter((r) => now - Date.parse(r.at) < 14 * DAY_MS).slice(-10).reverse() };
  } catch { return { entries: [], released: [] }; }
}

/** 近 N 天这个文件每次「复跑才通过」的失败原因（超时 / 断言），以及最近一条的摘要。 */
export function flakyKinds(guiRoot: string, file: string, sinceMs: number): { timeout: number; assertion: number; unknown: number; lastError: string } {
  const out = { timeout: 0, assertion: 0, unknown: 0, lastError: "" };
  let text = "";
  try { text = readFileSync(join(testGatesDir(guiRoot), "flaky-tests.jsonl"), "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.includes(file)) continue;
    let e: { at?: string; files?: string[]; details?: Array<{ file?: string; kind?: string; error?: string }> };
    try { e = JSON.parse(line); } catch { continue; }
    if (!e.files?.includes(file) || !(Date.parse(e.at ?? "") >= sinceMs)) continue;
    const d = e.details?.find((x) => x.file === file);
    const kind = d?.kind === "timeout" || d?.kind === "assertion" ? d.kind : "unknown";
    out[kind]++;
    if (d?.error) out.lastError = d.error;
  }
  return out;
}

/** 测试文件路径里的页面名：apps/web/test/route-loading-browser.test.ts → route-loading */
export function flakyLabel(file: string): string {
  return (file.split("/").pop() ?? file).replace(/\.test\.ts$/, "").replace(/-browser$/, "");
}

export interface FlakyTodoInput { s: FingerprintStat; recent7: number; quarantine: QuarantineView; kinds: ReturnType<typeof flakyKinds>; now: Date; windowDays: number; entryHost: string }

/** 待办正文：用产品语言，不假设读的人懂测试框架。规则生成，不调用 AI。 */
export function composeFlakyTodo(i: FlakyTodoInput): { text: string; analysis: { title: string; summary: string; acceptance: string[]; value: "medium"; valueBasis: string } } {
  const file = i.s.fingerprint.slice("flaky|".length), label = flakyLabel(file);
  const entry = i.quarantine.entries.find((e) => e.file === file);
  const title = `自动检查不稳定：${label}`.slice(0, 40);
  const status = entry
    ? `已自动暂时隔离：它照常运行、结果照常记录，但红了不再拦住上线；到北京时间 ${beijingStamp(Date.parse(entry.expiresAt))} 到期，到期后恢复拦截，仍不稳定会再次被隔离。`
    : "还没有被隔离（只隔离浏览器类检查，且同时最多隔离 12 个）。它红了会先自动重跑一次，重跑通过才放行。";
  const why = [i.kinds.timeout ? `等待超时 ${i.kinds.timeout} 次` : "", i.kinds.assertion ? `断言没过 ${i.kinds.assertion} 次` : "", i.kinds.unknown ? `原因未记录 ${i.kinds.unknown} 次` : ""].filter(Boolean).join("，");
  const lines = [
    `[错误统计 · 门禁自动检查不稳定] ${title}`,
    `指纹：${i.s.fingerprint}`,
    `这是什么：部署前的自动检查里，「${label}」近 ${GATE_FLAKY_WINDOW_DAYS} 天有 ${i.recent7} 次第一次没通过、单独重跑才通过（近 ${i.windowDays} 天共 ${i.s.total} 次）。时好时坏说明多半不是功能坏了，而是检查本身对机器忙闲或等待时间太敏感。`,
    why ? `失败原因：${why}${i.kinds.lastError ? `；最近一条：${i.kinds.lastError}` : ""}` : "",
    `现状：${status}`,
    `影响：每次重跑会拉长部署，并拖慢排队中的其他部署。隔离期间，这块界面如果真的被改坏，要等夜间回归（最长约一天）才会发现。`,
    `测试文件：${file}`,
    `决策：要不要修由你定。要修 → 从这条待办发起会话（常见修法：把过紧的等待时间放宽到统一值，或让检查等页面状态稳定后再判断）；不修 → 直接完成或删除，出现新的不稳定证据前不会再提醒。`,
    `近 ${i.windowDays} 天（${beijingDateKey(i.now.getTime() - (i.windowDays - 1) * DAY_MS)} ~ ${beijingDateKey(i.now)}，北京时间）入库于每晚 23:50 的错误统计；入口：https://${i.entryHost}/#/settings（设置 → 错误统计 → 门禁自动隔离）。`
  ].filter(Boolean);
  return {
    text: lines.join("\n"),
    analysis: {
      title,
      summary: `「${label}」近 ${GATE_FLAKY_WINDOW_DAYS} 天有 ${i.recent7} 次复跑才通过，${entry ? "已自动暂时隔离" : "尚未隔离"}。`,
      acceptance: ["修复后连续 7 天没有复跑才通过的记录", "隔离到期或测试被修后跑通，自动恢复拦截"],
      value: "medium",
      valueBasis: "减少部署门禁的重复运行和排队等待"
    }
  };
}
