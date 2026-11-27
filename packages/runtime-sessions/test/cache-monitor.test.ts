import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTurnCacheStats,
  CacheMonitor,
  cacheExpectedMinHitRate,
  cacheWarmWindowMs,
  computePrefixFingerprint,
  diffPrefixFields,
  encodeAntigravityStepMetadataForTest,
  evaluateTurnCache,
  readAntigravityTurnBoundaries,
  summarizeCacheHealth,
  type CacheAlertEvent,
  type SessionBinding,
  type UsageRecord
} from "../src/index.js";
import { stableBrowserBridgePath, startPlatformBrowser } from "../src/platform-browser.js";

const dirs: string[] = [];
const tmpDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("cache-monitor 跨回合前缀稳定性契约", () => {
  it("同会话连续两轮 startPlatformBrowser 生成的 MCP 前缀指纹在各 runtime 下完全一致", async () => {
    const ws = tmpDir("cm-ws-");
    const b1 = await startPlatformBrowser({ sessionId: "rt-contract-1", turnId: "t1", workspace: ws, outputDir: join(ws, ".pb"), event: () => {} });
    const b2 = await startPlatformBrowser({ sessionId: "rt-contract-1", turnId: "t2", workspace: ws, outputDir: join(ws, ".pb"), event: () => {} });
    try {
      for (const runtimeKind of ["antigravity", "claude-code", "codex", "pi"] as const) {
        const fp1 = computePrefixFingerprint({ runtimeKind, roleInstructions: "固定系统提示", platformBrowser: b1.access, model: "m1", platformSha: "sha1", cliVersion: "1.0.0" });
        const fp2 = computePrefixFingerprint({ runtimeKind, roleInstructions: "固定系统提示", platformBrowser: b2.access, model: "m1", platformSha: "sha1", cliVersion: "1.0.0" });
        expect(fp2.combined, `${runtimeKind} 跨回合前缀指纹必须稳定`).toBe(fp1.combined);
        expect(diffPrefixFields(fp1, fp2)).toEqual([]);
      }
    } finally {
      await b1.dispose();
      await b2.dispose();
    }
  });

  it("蓝绿切槽（current 指向本槽）后桥接路径统一为 current 别名，前缀指纹不变", () => {
    const blue = stableBrowserBridgePath("/u/.pi-agent-gui/slots/blue/packages/pi-runtime/src/platform-browser-mcp.mjs", (p) => p === "/u/.pi-agent-gui/current" ? "/u/.pi-agent-gui/slots/blue" : undefined);
    const green = stableBrowserBridgePath("/u/.pi-agent-gui/slots/green/packages/pi-runtime/src/platform-browser-mcp.mjs", (p) => p === "/u/.pi-agent-gui/current" ? "/u/.pi-agent-gui/slots/green" : undefined);
    const fpBlue = computePrefixFingerprint({ runtimeKind: "antigravity", roleInstructions: "sys", platformBrowser: { bridgePath: blue, socketPath: "/tmp/a/b.sock", pointerPath: "/tmp/pb-123.sock", hookPath: "/tmp/a/h.mjs" }, platformSha: "same", cliVersion: "1.5.18" });
    const fpGreen = computePrefixFingerprint({ runtimeKind: "antigravity", roleInstructions: "sys", platformBrowser: { bridgePath: green, socketPath: "/tmp/b/b.sock", pointerPath: "/tmp/pb-123.sock", hookPath: "/tmp/b/h.mjs" }, platformSha: "same", cliVersion: "1.5.18" });
    expect(fpGreen.combined).toBe(fpBlue.combined);
  });
});

describe("cache-monitor 热窗、阈值与前缀漂移判定", () => {
  const baseFp = computePrefixFingerprint({ runtimeKind: "pi", roleInstructions: "固定系统指令", model: "deepseek/deepseek-flash", platformSha: "sha-a", cliVersion: "0.9.0" });
  const now = Date.parse("2026-11-26T20:00:00.000Z");
  const req = (input: number, cachedInput: number, atMs = now): UsageRecord => ({
    usageScope: "request", counterMode: "delta", model: "deepseek/deepseek-flash",
    raw: { input, cachedInput }, sourceRef: "test:pi",
    input, cachedInput, cacheCreation: 0, output: 100,
    semantics: "Pi", requestId: `r-${atMs}-${input}`, sampledAt: new Date(atMs).toISOString(), occurredAt: new Date(atMs).toISOString(), reliability: "complete"
  });

  it("按各 runtime 实测热窗与基线正确区分（Claude 50m / 其余 5m）", () => {
    expect(cacheWarmWindowMs("claude-code")).toBe(50 * 60_000);
    expect(cacheWarmWindowMs("pi")).toBe(5 * 60_000);
    expect(cacheWarmWindowMs("codex")).toBe(5 * 60_000);
    expect(cacheWarmWindowMs("antigravity")).toBe(5 * 60_000);
    expect(cacheExpectedMinHitRate("antigravity")).toBe(0.80);
    expect(cacheExpectedMinHitRate("claude-code")).toBe(0.85);
  });

  it("热窗内重度掉底单次即告警；超出热窗或上下文压缩则跳过不误报", () => {
    const dir = tmpDir("cm-state-");
    const alerts: CacheAlertEvent[] = [];
    const monitor = new CacheMonitor(dir, { onAlert: (e) => alerts.push(e) });

    // 超出 5 分钟热窗 → skipped，不告警
    const cold = monitor.observeTurn({
      platformSessionId: "rt-1", runtimeKind: "pi", model: "deepseek/deepseek-flash", prevModel: "deepseek/deepseek-flash",
      turnNo: 2, prevTurnEndedAtMs: now - 10 * 60_000, turnStartedAtMs: now, turnEndedAtMs: now + 5000,
      prevContextTokens: 80_000, prevPrefix: baseFp, prefix: baseFp,
      turnUsageRecords: [req(82_000, 0)]
    });
    expect(cold?.severity).toBe("skipped");
    expect(cold?.skipReason).toBe("idle-beyond-warm-window");
    expect(alerts).toHaveLength(0);

    // 发生上下文压缩（首调总输入远小于上轮上下文）→ skipped，不误报
    const compacted = monitor.observeTurn({
      platformSessionId: "rt-1", runtimeKind: "pi", model: "deepseek/deepseek-flash", prevModel: "deepseek/deepseek-flash",
      turnNo: 3, prevTurnEndedAtMs: now - 60_000, turnStartedAtMs: now, turnEndedAtMs: now + 5000,
      prevContextTokens: 100_000, prevPrefix: baseFp, prefix: baseFp,
      turnUsageRecords: [req(25_000, 0)]
    });
    expect(compacted?.severity).toBe("skipped");
    expect(compacted?.skipReason).toBe("context-compacted");
    expect(alerts).toHaveLength(0);

    // 热窗内首调 0% 命中且浪费 >= 30k → 单次重度告警
    const severe = monitor.observeTurn({
      platformSessionId: "rt-1", runtimeKind: "pi", model: "deepseek/deepseek-flash", prevModel: "deepseek/deepseek-flash",
      turnNo: 4, prevTurnEndedAtMs: now - 60_000, turnStartedAtMs: now, turnEndedAtMs: now + 5000,
      prevContextTokens: 80_000, prevPrefix: baseFp, prefix: baseFp,
      turnUsageRecords: [req(81_000, 0)]
    });
    expect(severe?.severity).toBe("severe");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.reason).toBe("severe-drop");
  });

  it("区分同版本前缀漂移（直接告警并标出变化字段）与跨版本有意修改（不误报）", () => {
    const dir = tmpDir("cm-drift-");
    const alerts: CacheAlertEvent[] = [];
    const monitor = new CacheMonitor(dir, { onAlert: (e) => alerts.push(e) });

    // 跨版本变更（platformSha 变了，提示词也变了）→ 视为预期内重建，不误报
    const fpNewRelease = computePrefixFingerprint({ runtimeKind: "pi", roleInstructions: "新版系统指令", model: "deepseek/deepseek-flash", platformSha: "sha-b", cliVersion: "0.9.0" });
    const rebuild = monitor.observeTurn({
      platformSessionId: "rt-2", runtimeKind: "pi", model: "deepseek/deepseek-flash", prevModel: "deepseek/deepseek-flash",
      turnNo: 2, prevTurnEndedAtMs: now - 30_000, turnStartedAtMs: now, turnEndedAtMs: now + 4000,
      prevContextTokens: 70_000, prevPrefix: baseFp, prefix: fpNewRelease,
      turnUsageRecords: [req(72_000, 0)]
    });
    expect(rebuild?.expectedRebuild).toBe(true);
    expect(rebuild?.severity).toBe("skipped");
    expect(alerts).toHaveLength(0);

    // 同版本内前缀自己漂移（sha 没变，但 roleInstructions 变了）→ 立即告警且指出 roleInstructions
    const fpDrifted = computePrefixFingerprint({ runtimeKind: "pi", roleInstructions: "意外动态变化的指令", model: "deepseek/deepseek-flash", platformSha: "sha-b", cliVersion: "0.9.0" });
    const drift = monitor.observeTurn({
      platformSessionId: "rt-2", runtimeKind: "pi", model: "deepseek/deepseek-flash", prevModel: "deepseek/deepseek-flash",
      turnNo: 3, prevTurnEndedAtMs: now - 30_000, turnStartedAtMs: now, turnEndedAtMs: now + 4000,
      prevContextTokens: 72_000, prevPrefix: fpNewRelease, prefix: fpDrifted,
      turnUsageRecords: [req(40_000, 34_000)]
    });
    expect(drift?.sameVersionPrefixDrift).toBe(true);
    expect(drift?.prefixChangedFields[0]).toContain("roleInstructions");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.reason).toBe("prefix-drift");
  });

  it("轻度退化连续 2 次触发告警，中间正常 1 次会清零计数", () => {
    const dir = tmpDir("cm-streak-");
    const alerts: CacheAlertEvent[] = [];
    const monitor = new CacheMonitor(dir, { onAlert: (e) => alerts.push(e) });
    const fp = computePrefixFingerprint({ runtimeKind: "claude-code", roleInstructions: "sys", model: "claude-sonnet-5-5", platformSha: "sha-c", cliVersion: "2.0.0" });

    // 第 1 次轻度退化（65% < 85%）→ 不报警
    monitor.observeTurn({
      platformSessionId: "rt-c", runtimeKind: "claude-code", model: "claude-sonnet-5-5", prevModel: "claude-sonnet-5-5",
      turnNo: 2, prevTurnEndedAtMs: now - 20 * 60_000, turnStartedAtMs: now, turnEndedAtMs: now + 3000,
      prevContextTokens: 100_000, prevPrefix: fp, prefix: fp,
      turnUsageRecords: [req(35_000, 65_000)]
    });
    expect(alerts).toHaveLength(0);

    // 正常命中（98%）→ 清零 streak
    monitor.observeTurn({
      platformSessionId: "rt-c", runtimeKind: "claude-code", model: "claude-sonnet-5-5", prevModel: "claude-sonnet-5-5",
      turnNo: 3, prevTurnEndedAtMs: now - 20 * 60_000, turnStartedAtMs: now, turnEndedAtMs: now + 3000,
      prevContextTokens: 100_000, prevPrefix: fp, prefix: fp,
      turnUsageRecords: [req(2_000, 98_000)]
    });
    expect(alerts).toHaveLength(0);

    // 再次连续 2 次退化 → 第 2 次触发告警
    for (const turnNo of [4, 5]) {
      monitor.observeTurn({
        platformSessionId: "rt-c", runtimeKind: "claude-code", model: "claude-sonnet-5-5", prevModel: "claude-sonnet-5-5",
        turnNo, prevTurnEndedAtMs: now - 10 * 60_000, turnStartedAtMs: now, turnEndedAtMs: now + 3000,
        prevContextTokens: 100_000, prevPrefix: fp, prefix: fp,
        turnUsageRecords: [req(30_000, 70_000)]
      });
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.reason).toBe("degraded-streak");
  });
});

describe("Antigravity SQLite 首步解析与近 7 天健康度汇总", () => {
  it("离线解析 Antigravity conversations DB 首调命中率并在无 DB 时走兜底判据", () => {
    const agyDir = tmpDir("cm-agy-");
    mkdirSync(join(agyDir, "conversations"), { recursive: true });
    const nativeId = "11111111-2222-3333-4444-555555555555";
    const dbPath = join(agyDir, "conversations", `${nativeId}.db`);
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, metadata blob)");
    const t0 = Math.floor(Date.parse("2026-11-26T22:00:00Z") / 1000);
    const ins = db.prepare("INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)");
    // Turn 1
    ins.run(0, 14, encodeAntigravityStepMetadataForTest({ tsSec: t0 }));
    ins.run(1, 15, encodeAntigravityStepMetadataForTest({ tsSec: t0 + 1, endSec: t0 + 20, uncachedIn: 72_000, cachedIn: 0 }));
    // Turn 2（80 秒后，热续聊首调命中 70,000 / 74,000 = 94.6%）
    ins.run(2, 14, encodeAntigravityStepMetadataForTest({ tsSec: t0 + 100 }));
    ins.run(3, 15, encodeAntigravityStepMetadataForTest({ tsSec: t0 + 101, endSec: t0 + 120, uncachedIn: 4_000, cachedIn: 70_000 }));
    db.close();

    const boundaries = readAntigravityTurnBoundaries(nativeId, agyDir);
    expect(boundaries).toHaveLength(2);
    expect(boundaries[1]!.firstCall).toMatchObject({ uncachedIn: 4_000, cachedIn: 70_000, totalIn: 74_000 });

    const fp = computePrefixFingerprint({ runtimeKind: "antigravity", roleInstructions: "sys", model: "gemini-4-neon", platformSha: "s1", cliVersion: "1.5.18" });
    const sample = evaluateTurnCache({
      platformSessionId: "rt-agy-1", nativeSessionId: nativeId, runtimeKind: "antigravity", model: "gemini-4-neon", prevModel: "gemini-4-neon",
      turnNo: 2, prevTurnEndedAtMs: (t0 + 20) * 1000, turnStartedAtMs: (t0 + 100) * 1000, turnEndedAtMs: (t0 + 120) * 1000,
      prevContextTokens: 72_000, prevPrefix: fp, prefix: fp, turnUsageRecords: [], antigravityDataDir: agyDir
    });
    expect(sample?.source).toBe("antigravity-db");
    expect(sample?.hitRate).toBeCloseTo(70_000 / 74_000, 4);
    expect(sample?.severity).toBe("ok");

    // 读不到 DB 且本轮整轮 uncached >= prevCtx * 0.85 → 兜底判为重度掉底
    const fallback = evaluateTurnCache({
      platformSessionId: "rt-agy-missing", nativeSessionId: "missing-id", runtimeKind: "antigravity", model: "gemini-4-neon", prevModel: "gemini-4-neon",
      turnNo: 2, prevTurnEndedAtMs: (t0 + 20) * 1000, turnStartedAtMs: (t0 + 100) * 1000, turnEndedAtMs: (t0 + 120) * 1000,
      prevContextTokens: 80_000, prevPrefix: fp, prefix: fp,
      turnUsageRecords: [{ usageScope: "turn", counterMode: "delta", raw: { inputTokens: 85_000, cachedReadTokens: 400_000 }, sourceRef: "test:agy", input: 85_000, cachedInput: 400_000, output: 1000, semantics: "Antigravity", sampledAt: new Date((t0 + 120) * 1000).toISOString(), reliability: "complete" }],
      antigravityDataDir: agyDir
    });
    expect(fallback?.source).toBe("antigravity-fallback");
    expect(fallback?.severity).toBe("severe");

    // 近 7 天汇总合并实时样本与历史 Antigravity DB 样本并去重
    const fakeBinding = {
      platformSessionId: "rt-agy-hist", runtimeKind: "antigravity", nativeSessionId: nativeId,
      lastActivityAt: { at: new Date((t0 + 120) * 1000).toISOString(), source: "platform" },
      turns: [
        { turnNo: 1, startedAt: new Date(t0 * 1000).toISOString(), endedAt: new Date((t0 + 20) * 1000).toISOString() },
        { turnNo: 2, startedAt: new Date((t0 + 100) * 1000).toISOString(), endedAt: new Date((t0 + 120) * 1000).toISOString() }
      ]
    } as unknown as SessionBinding;
    const summary = summarizeCacheHealth({
      samples: [],
      bindings: [fakeBinding],
      usage: {},
      days: 7,
      now: new Date((t0 + 3600) * 1000),
      antigravityDataDir: agyDir
    });
    const agyRow = summary.runtimes.find((r) => r.runtimeKind === "antigravity")!;
    expect(agyRow.sampleCount).toBe(1);
    expect(agyRow.weightedHitRate).toBeCloseTo(70_000 / 74_000, 4);
    expect(agyRow.status).toBe("healthy");
    const codexRow = summary.runtimes.find((r) => r.runtimeKind === "codex")!;
    expect(codexRow.status).toBe("no-data");
  });

  it("buildTurnCacheStats 生成每轮结束系统行的徽章与明细（首轮整轮、热续聊达标、异常掉底）", () => {
    const fp = computePrefixFingerprint({ runtimeKind: "pi", roleInstructions: "sys", model: "deepseek/deepseek-flash", platformSha: "s1", cliVersion: "0.9.0" });
    const t = Date.parse("2026-11-26T23:00:00Z");
    const rec = (input: number, cachedInput: number, id: string): UsageRecord => ({
      usageScope: "request", counterMode: "delta", model: "deepseek/deepseek-flash",
      raw: { input, cachedInput }, sourceRef: "test:pi", input, cachedInput, cacheCreation: 0, output: 100,
      semantics: "Pi", requestId: id, sampledAt: new Date(t).toISOString(), occurredAt: new Date(t).toISOString(), reliability: "complete"
    });
    // 第 1 轮：返回整轮命中率
    const firstTurn = buildTurnCacheStats({
      platformSessionId: "rt-s", runtimeKind: "pi", model: "deepseek/deepseek-flash", turnNo: 1,
      turnStartedAtMs: t, turnEndedAtMs: t + 5000, prefix: fp,
      turnUsageRecords: [rec(20_000, 0, "r1"), rec(2_000, 20_000, "r2")]
    });
    expect(firstTurn?.primaryKind).toBe("turn");
    expect(firstTurn?.tone).toBe("neutral");
    expect(firstTurn?.badgeLabel).toBe("缓存 47.6% · 首轮");
    expect(firstTurn?.detail).toContain("首轮冷启动");

    // 第 2 轮热续聊达标：主徽章为首调命中率，明细同时含首调与整轮
    const warmInput = {
      platformSessionId: "rt-s", runtimeKind: "pi" as const, model: "deepseek/deepseek-flash", prevModel: "deepseek/deepseek-flash",
      turnNo: 2, prevTurnEndedAtMs: t - 30_000, turnStartedAtMs: t, turnEndedAtMs: t + 5000,
      prevContextTokens: 80_000, prevPrefix: fp, prefix: fp,
      turnUsageRecords: [rec(2_000, 80_000, "r3"), rec(1_000, 82_000, "r4")]
    };
    const warmSample = evaluateTurnCache(warmInput);
    const warmStats = buildTurnCacheStats(warmInput, warmSample);
    expect(warmStats?.primaryKind).toBe("first-call");
    expect(warmStats?.tone).toBe("ok");
    expect(warmStats?.badgeLabel).toBe("缓存 97.6%");
    expect(warmStats?.detail).toContain("本轮首调：97.6%");
    expect(warmStats?.detail).toContain("本轮整轮：98.2%");
    expect(warmStats?.detail).toContain("前缀指纹：系统提示与 MCP 参数未变化");

    // 第 2 轮热续聊 0% 掉底 → 红色异常徽章
    const badInput = { ...warmInput, turnUsageRecords: [rec(82_000, 0, "r5")] };
    const badStats = buildTurnCacheStats(badInput, evaluateTurnCache(badInput));
    expect(badStats?.tone).toBe("bad");
    expect(badStats?.badgeLabel).toBe("缓存 0.0% · 异常");
    expect(badStats?.detail).toContain("严重掉底");
  });
});
