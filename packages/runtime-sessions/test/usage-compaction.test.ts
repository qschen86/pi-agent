/**
 * 归档会话的用量压缩：逐次明细 → 每小时 × 模型 × 子 Agent 一行合计。
 * 统计口径不变（会话合计、请求数、按日、按模型）；回补重报已压缩的请求不重复计数。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RuntimeStore } from "../src/store.js";
import { compactUsage, dailyUsage, summarizeUsage, usageNeedsCompaction } from "../src/usage.js";
import type { SessionBinding, UsageRecord } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const piMsg = (ms: number, input: number, output: number, model = "deepseek/deepseek-flash", subagent?: string): UsageRecord => ({
  usageScope: "request", counterMode: "delta", model, raw: { input, output, cacheRead: 100 }, input, output, cachedInput: 100,
  semantics: "Pi 原生 assistant 消息用量", requestId: `s1:pi:message:assistant:${ms}`, sourceRef: `s1:pi:message:assistant:${ms}`,
  sampledAt: new Date(ms + 60_000).toISOString(), reliability: "partial", ...(subagent ? { subagent } : {})
});
const claudeMsg = (ms: number, id: string, output: number): UsageRecord => ({
  usageScope: "request", counterMode: "delta", model: "opus", raw: { output_tokens: output }, input: 5, output,
  semantics: "Claude 单请求", requestId: id, sourceRef: id, sampledAt: new Date(ms).toISOString(), occurredAt: new Date(ms).toISOString(), reliability: "complete"
});
const turnTotal = (ms: number): UsageRecord => ({ usageScope: "turn", counterMode: "cumulative", raw: { output_tokens: 999 }, output: 999, semantics: "每轮结束", sourceRef: `turn:${ms}`, sampledAt: new Date(ms).toISOString(), reliability: "complete" });
const H = Date.UTC(2026, 9, 19, 6, 0, 0);

it("folds deltas into one row per hour × model × subagent without changing totals, request counts or daily sums", () => {
  const records = [piMsg(H + 1000, 10, 1), piMsg(H + 2000, 20, 2), piMsg(H + 3_700_000, 5, 5), piMsg(H + 4000, 7, 7, "deepseek/deepseek-pro"), piMsg(H + 5000, 1, 1, undefined, "helper"),
    claudeMsg(H + 6000, "msg_a", 3), claudeMsg(H + 7000, "msg_b", 4), turnTotal(H + 8000)];
  const out = compactUsage(records);
  expect(out.every((r) => r.aggregate)).toBe(true); // 每轮结束记录有单请求数据时丢弃
  expect(out.map((r) => [r.aggregate!.hour, r.model, r.subagent ?? "", r.aggregate!.calls])).toEqual([
    ["2026-10-19T06:00Z", "deepseek/deepseek-flash", "", 2], ["2026-10-19T06:00Z", "deepseek/deepseek-flash", "helper", 1],
    ["2026-10-19T06:00Z", "deepseek/deepseek-pro", "", 1], ["2026-10-19T06:00Z", "opus", "", 2], ["2026-10-19T07:00Z", "deepseek/deepseek-flash", "", 1]]);
  const flash = out[0]!;
  expect(flash).toMatchObject({ input: 30, output: 3, cachedInput: 200, raw: { input: 30, output: 3, cacheRead: 200 } });
  expect(flash.occurredAt).toBeUndefined(); // Pi 没有 occurredAt：按日统计口径不变
  expect(out[3]!.occurredAt).toBe(new Date(H + 1_800_000).toISOString());
  const a = summarizeUsage(records), b = summarizeUsage(out);
  expect(b.totals).toEqual(a.totals); expect(b.requestCount).toBe(a.requestCount); expect(b.byModel).toEqual(a.byModel);
  for (const tz of ["Asia/Shanghai", "America/Los_Angeles"]) expect(dailyUsage(out, tz).days).toEqual(dailyUsage(records, tz).days);
  expect(usageNeedsCompaction(out)).toBe(false);
});

it("keeps cumulative session snapshots, and keeps turn totals when they are the only source", () => {
  const snap: UsageRecord = { usageScope: "session", counterMode: "cumulative", raw: {}, input: 9, semantics: "Codex", sourceRef: "codex:thread", sampledAt: new Date(H).toISOString(), reliability: "complete", requestCount: 4 };
  expect(compactUsage([snap])).toEqual([snap]);
  expect(compactUsage([turnTotal(H), turnTotal(H + 1)])).toHaveLength(2);
  expect(usageNeedsCompaction([turnTotal(H)])).toBe(false);
});

it("store compacts archived sessions once with a backup, ignores replayed usage, and merges usage added after unarchiving", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-usage-compact-")); dirs.push(dir);
  const store = new RuntimeStore(dir);
  const binding = { platformSessionId: "rt-a", runtimeKind: "pi", archived: false, turns: [] } as unknown as SessionBinding;
  store.putBinding(binding);
  const original = [piMsg(H + 1000, 10, 1), piMsg(H + 2000, 20, 2), piMsg(H + 3_700_000, 5, 5)];
  for (const r of original) store.addUsage("rt-a", r);
  const file = join(store.dir, "usage.json");
  // 磁盘上：不缩进，sourceRef 与 requestId 相同时不重复存；读回来补齐
  const disk = readFileSync(file, "utf8");
  expect(disk.includes("\n")).toBe(false); expect(disk.includes("sourceRef")).toBe(false);
  expect(new RuntimeStore(dir).usageFor("rt-a")[0]!.sourceRef).toBe(original[0]!.requestId);
  expect(store.compactArchivedUsage()).toBe(0); // 进行中的会话不压缩
  store.updateBinding("rt-a", (b) => { b.archived = true; });
  expect(store.compactArchivedUsage()).toBe(1);
  expect(existsSync(`${file}.before-compact`)).toBe(true);
  expect(store.usageFor("rt-a")).toHaveLength(2);
  const before = summarizeUsage(original);
  // 回补把原生历史里的用量整份再报一遍：已压缩的请求不再计入
  for (const r of original) store.addUsage("rt-a", r);
  expect(summarizeUsage(store.usageFor("rt-a")).totals).toEqual(before.totals);
  expect(new RuntimeStore(dir).usageFor("rt-a")).toHaveLength(2);
  // 恢复后新的请求照常记明细；再次归档时并进同一小时的合计行
  store.updateBinding("rt-a", (b) => { b.archived = false; });
  const later = piMsg(H + 9000, 100, 10);
  store.addUsage("rt-a", later);
  expect(store.usageFor("rt-a")).toHaveLength(3);
  store.updateBinding("rt-a", (b) => { b.archived = true; });
  expect(store.compactArchivedUsage(["rt-a"])).toBe(1);
  const rows = store.usageFor("rt-a");
  expect(rows).toHaveLength(2); expect(rows[0]!.aggregate!.calls).toBe(3);
  expect(summarizeUsage(rows)).toMatchObject({ totals: summarizeUsage([...original, later]).totals, requestCount: 4 });
  store.addUsage("rt-a", later);
  expect(summarizeUsage(store.usageFor("rt-a")).requestCount).toBe(4);
});
