import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeSessionManager } from "../src/manager.js";
import { QUOTA_RESUME_FALLBACK_MS, QUOTA_RESUME_MARGIN_MS, QUOTA_RESUME_MAX_STREAK, QUOTA_RESUME_PROMPT, filterQuotaWindowsForModel, parseQuotaResetHint, planQuotaResume, stillExhaustedUntil } from "../src/quota-resume.js";
import { FakeDriver, until, tick } from "./fake-driver.js";

const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const H = 3_600_000;

describe("planQuotaResume", () => {
  it("waits for the exhausted 5h window plus a margin", () => {
    const p = planQuotaResume({ windows: [{ label: "5 小时窗口", usedPercent: 100, resetsAt: at(2 * H) }, { label: "周窗口", usedPercent: 40, resetsAt: at(90 * H) }] }, NOW);
    expect(p).toMatchObject({ at: NOW + 2 * H + QUOTA_RESUME_MARGIN_MS, window: "5 小时窗口", known: true });
  });

  it("waits for the latest reset when both windows are exhausted", () => {
    const p = planQuotaResume({ windows: [{ label: "5 小时窗口", usedPercent: 100, resetsAt: at(H) }, { label: "周窗口", usedPercent: 100, resetsAt: at(50 * H) }] }, NOW);
    expect(p.at).toBe(NOW + 50 * H + QUOTA_RESUME_MARGIN_MS);
    expect(p.window).toBe("5 小时窗口、周窗口");
  });

  it("uses the earliest future reset when no percentage is known", () => {
    const p = planQuotaResume({ windows: [{ label: "5 小时窗口", usedPercent: null, resetsAt: at(H) }, { label: "周窗口", usedPercent: null, resetsAt: at(90 * H) }] }, NOW);
    expect(p.at).toBe(NOW + H + QUOTA_RESUME_MARGIN_MS);
  });

  it("ignores windows that already reset, and falls back to a later retry", () => {
    const p = planQuotaResume({ windows: [{ label: "5 小时窗口", usedPercent: 100, resetsAt: at(-H) }] }, NOW);
    expect(p).toMatchObject({ at: NOW + QUOTA_RESUME_FALLBACK_MS, known: false });
    expect(planQuotaResume(undefined, NOW).known).toBe(false);
  });

  it("stillExhaustedUntil reports only unreset exhausted windows", () => {
    expect(stillExhaustedUntil({ windows: [{ label: "a", usedPercent: 100, resetsAt: at(H) }, { label: "b", usedPercent: 10, resetsAt: at(5 * H) }] }, NOW)).toBe(NOW + H);
    expect(stillExhaustedUntil({ windows: [{ label: "a", usedPercent: 100, resetsAt: at(-H) }] }, NOW)).toBeUndefined();
  });

  it("按模型分组过滤 Antigravity 多模型组窗口，不被其他满额模型组拖延，并支持报错里的 Resets in 提示", () => {
    const grouped = {
      windows: [
        { group: "Gemini Models", label: "5 小时窗口", usedPercent: 100, resetsAt: at(2 * H) },
        { group: "Gemini Models", label: "周窗口", usedPercent: 43, resetsAt: at(120 * H) },
        { group: "Claude and GPT models", label: "5 小时窗口", usedPercent: 0, resetsAt: at(5 * H) },
        { group: "Gemini 4 Argon", label: "周窗口", usedPercent: 100, resetsAt: at(160 * H) }
      ]
    };
    expect(filterQuotaWindowsForModel(grouped, { runtimeKind: "antigravity", model: "gemini-4-neon" }).map((w) => w.group))
      .toEqual(["Gemini Models", "Gemini Models"]);
    expect(filterQuotaWindowsForModel(grouped, { runtimeKind: "antigravity", model: "gemini-4-argon" }).map((w) => w.group))
      .toEqual(["Gemini 4 Argon"]);
    expect(filterQuotaWindowsForModel(grouped, { runtimeKind: "antigravity", model: "claude-opus-5-5" }).map((w) => w.group))
      .toEqual(["Claude and GPT models"]);
    // Neon 只等 Gemini Models 的 2 小时窗口，不被 Argon 的 160 小时周限拖延
    const neonPlan = planQuotaResume(grouped, NOW, { runtimeKind: "antigravity", model: "gemini-4-neon" });
    expect(neonPlan).toMatchObject({ at: NOW + 2 * H + QUOTA_RESUME_MARGIN_MS, window: "5 小时窗口", known: true });
    // Neon 重置后（10%），即使 Argon 仍是 100%，stillExhaustedUntil 也放行 Neon
    const afterReset = {
      windows: grouped.windows.map((w) => w.group === "Gemini Models" && w.label === "5 小时窗口" ? { ...w, usedPercent: 10 } : w)
    };
    expect(stillExhaustedUntil(afterReset, NOW, { runtimeKind: "antigravity", model: "gemini-4-neon" })).toBeUndefined();
    expect(stillExhaustedUntil(afterReset, NOW, { runtimeKind: "antigravity", model: "gemini-4-argon" })).toBe(NOW + 160 * H);
    // 快照里当前模型组还没来得及变成 100% 时，回退解析报错里的 Resets in 2h24m19s
    expect(parseQuotaResetHint("⚠ Individual quota reached. Resets in 2h24m19s.", NOW)).toBe(NOW + ((2 * 3600 + 24 * 60 + 19) * 1000));
    const hintedPlan = planQuotaResume(afterReset, NOW, {
      runtimeKind: "antigravity", model: "gemini-4-neon",
      reason: "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h24m19s."
    });
    expect(hintedPlan).toMatchObject({ at: NOW + ((2 * 3600 + 24 * 60 + 19) * 1000) + QUOTA_RESUME_MARGIN_MS, known: true });
  });
});

let dir: string, ws: string, mgr: RuntimeSessionManager, driver: FakeDriver;
let windows: Array<{ label: string; usedPercent: number | null; resetsAt: string | null }>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rt-quota-resume-")); ws = join(dir, "work"); mkdirSync(ws);
  driver = new FakeDriver("codex");
  windows = [{ label: "5 小时窗口", usedPercent: 100, resetsAt: new Date(Date.now() + 2 * H).toISOString() }];
  driver.rateLimits = async () => ({ windows, source: "fake", sampledAt: new Date().toISOString(), available: true });
  mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver }, skipRecovery: true });
  mgr.updateSettings({ workspaceRoots: [ws] }, "local"); await mgr.probe("codex");
});
afterEach(async () => { mgr.shutdown(); await tick(35); rmSync(dir, { recursive: true, force: true }); });

const binding = (id: string) => mgr.store.binding(id)!;
async function startSession() {
  const { session } = await mgr.create({ idempotencyKey: `c-${randomUUID()}`, runtimeKind: "codex", workspace: ws, title: "t", prompt: "第一轮", confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "local");
  await until(() => driver.turns.length === 1);
  return session.platformSessionId;
}
function end(n: number, r: { status: "completed" | "failed" | "unknown"; reason?: string; code?: string; processEnded?: string }) {
  const t = driver.turns[n - 1]!;
  driver.fingerprints.set(t.nativeId, `fp-after-${n}`);
  t.finish(r);
}
const limit = (n: number) => end(n, { status: "failed", reason: "You’ve hit your usage limit.", code: "usageLimitExceeded" });
/** 把待执行的续聊提前到现在并触发（真实定时器要等到窗口重置） */
function dueNow(id: string) {
  mgr.store.updateBinding(id, x => { x.quotaResume!.scheduledFor = new Date(Date.now() - 1000).toISOString(); }, undefined, { bump: false });
  (mgr as unknown as { setQuotaTimer(pid: string, at: number): void }).setQuotaTimer(id, Date.now());
}

describe("额度用尽后自动续聊", () => {
  it("schedules after the window reset, then continues on its own once the quota is back", async () => {
    const id = await startSession();
    limit(1);
    await until(() => !!binding(id).quotaResume);
    const q = binding(id).quotaResume!;
    expect(binding(id).status).toBe("interrupted");
    expect(q).toMatchObject({ window: "5 小时窗口", known: true, turnNo: 1 });
    expect(Date.parse(q.scheduledFor)).toBeGreaterThan(Date.now() + 2 * H);
    expect(driver.turns).toHaveLength(1);

    windows = [{ label: "5 小时窗口", usedPercent: 3, resetsAt: new Date(Date.now() + 5 * H).toISOString() }];
    dueNow(id);
    await until(() => driver.turns.length === 2, 4000);
    expect(driver.turns[1]!.args.prompt).toBe(QUOTA_RESUME_PROMPT);
    expect(binding(id).quotaResume).toBeUndefined();
    expect(binding(id).quotaResumeStreak).toBe(1);
    end(2, { status: "completed" });
    await until(() => binding(id).status === "idle");
    expect(binding(id).quotaResumeStreak).toBeUndefined();
  });

  it("keeps waiting when the window has not really reset yet", async () => {
    const id = await startSession();
    limit(1);
    await until(() => !!binding(id).quotaResume);
    const later = new Date(Date.now() + 3 * H).toISOString();
    windows = [{ label: "5 小时窗口", usedPercent: 100, resetsAt: later }];
    dueNow(id);
    await until(() => Date.parse(binding(id).quotaResume?.scheduledFor ?? "") > Date.now() + 2.9 * H, 4000);
    expect(driver.turns).toHaveLength(1);
  });

  it("re-arms after being limited again and stops after the streak cap", async () => {
    const id = await startSession();
    limit(1);
    await until(() => !!binding(id).quotaResume);
    mgr.store.updateBinding(id, x => { x.quotaResumeStreak = QUOTA_RESUME_MAX_STREAK - 1; }, undefined, { bump: false });
    windows = [{ label: "5 小时窗口", usedPercent: 3, resetsAt: new Date(Date.now() + 5 * H).toISOString() }];
    dueNow(id);
    await until(() => driver.turns.length === 2, 4000);
    expect(binding(id).quotaResumeStreak).toBe(QUOTA_RESUME_MAX_STREAK);
    windows = [{ label: "5 小时窗口", usedPercent: 100, resetsAt: new Date(Date.now() + 2 * H).toISOString() }];
    limit(2);
    await until(() => binding(id).status === "interrupted" && driver.turns.length === 2);
    await tick(150);
    expect(binding(id).quotaResume).toBeUndefined(); // 达到上限：交还给人
    expect(binding(id).statusReason).toContain(`自动继续已达 ${QUOTA_RESUME_MAX_STREAK} 次上限，不再自动继续`);
  });

  it("a human message cancels the scheduled resume and resets the streak", async () => {
    const id = await startSession();
    limit(1);
    await until(() => !!binding(id).quotaResume);
    await mgr.sendTurn(id, { idempotencyKey: `h-${randomUUID()}`, prompt: "我来接手", expectedRevision: binding(id).bindingRevision }, "local");
    expect(binding(id).quotaResume).toBeUndefined();
    await until(() => driver.turns.length === 2);
    end(2, { status: "completed" });
    await tick(100);
    expect(driver.turns).toHaveLength(2);
  });

  it("can be cancelled explicitly", async () => {
    const id = await startSession();
    limit(1);
    await until(() => !!binding(id).quotaResume);
    mgr.cancelQuotaResume(id, "local");
    expect(binding(id).quotaResume).toBeUndefined();
    await tick(100);
    expect(driver.turns).toHaveLength(1);
    expect(binding(id).status).toBe("interrupted");
  });

  it("does not schedule for an ordinary failure or a stop", async () => {
    const id = await startSession();
    end(1, { status: "failed", reason: "boom" });
    await until(() => binding(id).status !== "running");
    await tick(100);
    expect(binding(id).quotaResume).toBeUndefined();
  });

  it("automatically resumes quota-related unknown results but preserves ordinary unknown results", async () => {
    const id = await startSession();
    end(1, { status: "unknown", reason: "Claude Code returned an error result: You've hit your weekly limit", processEnded: "process exited" });
    await until(() => !!binding(id).quotaResume);
    expect(binding(id).status).toBe("interrupted");
    expect(binding(id).turns.at(-1)?.quotaFailure).toBe(true);
    mgr.cancelQuotaResume(id, "test");
    await mgr.sendTurn(id, { idempotencyKey: randomUUID(), prompt: "继续", expectedRevision: binding(id).bindingRevision }, "local");
    await until(() => driver.turns.length === 2);
    end(2, { status: "unknown", reason: "connection lost before receiving the result" });
    await until(() => binding(id).status === "unknown");
    expect(binding(id).quotaResume).toBeUndefined();
  });

  it("backfills a persisted quota unknown on restart without retrying ordinary unknowns", async () => {
    const id = await startSession();
    end(1, { status: "unknown", reason: "connection lost" });
    await until(() => binding(id).status === "unknown");
    mgr.store.updateBinding(id, x => {
      const t = x.turns.at(-1)!;
      t.quotaFailure = true;
      t.statusReason = "Claude Code returned an error result: You've hit your weekly limit";
    });
    mgr.shutdown();
    const again = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver } });
    await again.recovered;
    try {
      expect(again.store.binding(id)?.status).toBe("interrupted");
      expect(again.store.binding(id)?.quotaResume?.turnNo).toBe(1);
      expect(driver.turns).toHaveLength(1);
      const scheduled = again.store.binding(id)!.quotaResume!.scheduledFor;
      again.cancelQuotaResume(id, "human");
      again.shutdown();
      const third = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver } });
      await third.recovered;
      try { expect(third.store.binding(id)?.quotaResume).toBeUndefined(); }
      finally { third.shutdown(); }
      expect(scheduled).toBeTruthy();
    } finally { again.shutdown(); }
  });

  it("is restored from disk after a restart", async () => {
    const id = await startSession();
    limit(1);
    await until(() => !!binding(id).quotaResume);
    const scheduledFor = binding(id).quotaResume!.scheduledFor;
    mgr.shutdown();
    const again = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver } });
    await again.recovered;
    try {
      expect(again.store.binding(id)!.quotaResume?.scheduledFor).toBe(scheduledFor);
      expect((again as unknown as { quotaTimers: Map<string, unknown> }).quotaTimers.has(id)).toBe(true);
    } finally { again.shutdown(); }
  });

  it("Antigravity 按模型组排定与复核自动续聊：Gemini 4 Neon 不受满额的 Gemini 4 Argon 拖延", async () => {
    const anti = new FakeDriver("antigravity");
    const baseProbe = anti.probe.bind(anti);
    anti.probe = async () => ({
      ...(await baseProbe()),
      models: [{ id: "gemini-4-neon", label: "Gemini 4 Neon", isDefault: true }, { id: "gemini-4-argon", label: "Gemini 4 Argon" }]
    });
    let antiWindows = [
      { group: "Gemini Models", label: "5 小时窗口", usedPercent: 100, resetsAt: new Date(Date.now() + 2 * H).toISOString() },
      { group: "Gemini Models", label: "周窗口", usedPercent: 43, resetsAt: new Date(Date.now() + 120 * H).toISOString() },
      { group: "Gemini 4 Argon", label: "周窗口", usedPercent: 100, resetsAt: new Date(Date.now() + 160 * H).toISOString() }
    ];
    anti.rateLimits = async () => ({ windows: antiWindows, source: "agy CLI /usage (JSON)", sampledAt: new Date().toISOString(), available: true });
    const antiMgr = new RuntimeSessionManager({ dataDir: join(dir, "anti-data"), drivers: { antigravity: anti }, skipRecovery: true });
    antiMgr.updateSettings({ workspaceRoots: [ws] }, "local");
    await antiMgr.probe("antigravity");
    try {
      const { session } = await antiMgr.create({
        idempotencyKey: `ag-${randomUUID()}`, runtimeKind: "antigravity", workspace: ws, title: "ag", prompt: "第一轮",
        model: "gemini-4-neon", confirmedProfileVersion: antiMgr.profile("antigravity")!.checkedAt
      }, "local");
      const id = session.platformSessionId;
      await until(() => anti.turns.length === 1);
      anti.fingerprints.set(anti.turns[0]!.nativeId, "s2i1");
      anti.turns[0]!.finish({
        status: "failed", code: "usageLimitExceeded",
        reason: "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h24m19s.",
        terminalObserved: true
      });
      await until(() => !!antiMgr.store.binding(id)?.quotaResume);
      const q = antiMgr.store.binding(id)!.quotaResume!;
      // 按 Gemini Models 5 小时窗口（约 2h 后）排定，而非 Argon 160h 周限
      expect(q).toMatchObject({ window: "5 小时窗口", known: true, turnNo: 1 });
      expect(Date.parse(q.scheduledFor)).toBeLessThan(Date.now() + 3 * H);
      // 到点复核：Gemini Models 已恢复，Argon 仍 100% → 必须放行续聊
      antiWindows = antiWindows.map((w) => w.group === "Gemini Models" && w.label === "5 小时窗口" ? { ...w, usedPercent: 8 } : w);
      antiMgr.store.updateBinding(id, x => { x.quotaResume!.scheduledFor = new Date(Date.now() - 1000).toISOString(); }, undefined, { bump: false });
      (antiMgr as unknown as { setQuotaTimer(pid: string, at: number): void }).setQuotaTimer(id, Date.now());
      await until(() => anti.turns.length === 2, 4000);
      expect(anti.turns[1]!.args.prompt).toBe(QUOTA_RESUME_PROMPT);
    } finally { antiMgr.shutdown(); }
  });
});
