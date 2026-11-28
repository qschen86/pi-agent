import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeSessionManager } from "../src/manager.js";
import { QUOTA_RESUME_PROMPT } from "../src/quota-resume.js";
import { assessCacheHandoff, buildTranscript, cacheTtl, estimateContextTokens, handoffTail, handoffTitle } from "../src/cache-handoff.js";
import type { ProjectedEvent, UsageRecord } from "../src/types.js";
import { FakeDriver, until, tick } from "./fake-driver.js";

const H = 3_600_000;
const NOW = Date.parse("2026-11-24T05:00:00.000Z");
const rec = (o: Partial<UsageRecord>): UsageRecord => ({ usageScope: "request", counterMode: "delta", raw: {}, semantics: "t", sourceRef: "s", sampledAt: new Date(NOW - 5 * H).toISOString(), reliability: "complete", ...o });
const plain = (o: { endedAgoMs?: number } = {}) => ({
  runtimeKind: "claude-code" as const, turns: [{ turnNo: 1, status: "completed" as const, operationId: "op", promptPreview: "", clientMessageId: "c", ...(o.endedAgoMs !== undefined ? { endedAt: new Date(NOW - o.endedAgoMs).toISOString() } : {}) }],
  nativeSessionId: "n-1", status: "idle" as const
});

describe("缓存保留时间表", () => {
  it("按 runtime 和模型给出判定线", () => {
    expect(cacheTtl("claude-code").ttlMs).toBe(H);
    expect(cacheTtl("codex").ttlMs).toBe(H);
    expect(cacheTtl("antigravity").ttlMs).toBe(H);
    expect(cacheTtl("pi", "deepseek/deepseek-flash").ttlMs).toBe(6 * H);
    expect(cacheTtl("pi", "zhipu/glm-5.3").ttlMs).toBe(H);
  });
});

describe("上下文大小", () => {
  it("Claude / Pi：取最近一次逐请求用量的 输入 + 缓存读取 + 缓存写入，子代理和归档合计行不算", () => {
    const records = [
      rec({ input: 10, cachedInput: 100_000, cacheCreation: 2_000, sampledAt: new Date(NOW - 3 * H).toISOString() }),
      rec({ input: 20, cachedInput: 310_000, cacheCreation: 5_000, sampledAt: new Date(NOW - 2 * H).toISOString() }),
      rec({ input: 5, cachedInput: 900_000, subagent: "x", sampledAt: new Date(NOW - H).toISOString() }),
      rec({ input: 1, cachedInput: 9_000_000, aggregate: { hour: "h", calls: 30, folded: [] }, sampledAt: new Date(NOW - H / 2).toISOString() })
    ];
    expect(estimateContextTokens(records)).toEqual({ tokens: 315_020, source: "last-request" });
  });
  it("驱动直接报了 contextTokens 就用最新那条（Codex last 用量、Antigravity usage_update）", () => {
    const records = [rec({ usageScope: "session", counterMode: "cumulative", input: 9_999_999, contextTokens: 120_000, sampledAt: new Date(NOW - 2 * H).toISOString() }),
      rec({ usageScope: "session", counterMode: "cumulative", input: 9_999_999, contextTokens: 480_000, sampledAt: new Date(NOW - H).toISOString() })];
    expect(estimateContextTokens(records)).toEqual({ tokens: 480_000, source: "reported" });
  });
  it("只有整轮累计数据时不猜", () => {
    expect(estimateContextTokens([rec({ usageScope: "turn", input: 300_000, cachedInput: 1_500_000 })])).toBeUndefined();
    expect(estimateContextTokens([])).toBeUndefined();
  });
});

describe("handoffTitle：接续会话沿用最原始的名字，前面加「续N·」", () => {
  const from = { platformSessionId: "p" };
  it("第一次接续是续2；接续出来的再接续，序号 +1 而不是叠加", () => {
    expect(handoffTitle({ title: "长会话" })).toBe("续2·长会话");
    expect(handoffTitle({ title: "续2·长会话", handoff: { from } })).toBe("续3·长会话");
    expect(handoffTitle({ title: "续9·长会话", handoff: { from } })).toBe("续10·长会话");
  });
  it("没接续过的会话，标题本来就以「续N·」开头也不动它", () => {
    expect(handoffTitle({ title: "续2·手写的名字" })).toBe("续2·续2·手写的名字");
  });
  it("名字太长时截断名字、保住前缀", () => {
    const t = handoffTitle({ title: "字".repeat(80) });
    expect(t.length).toBe(80); expect(t.startsWith("续2·")).toBe(true); expect(t.endsWith("…")).toBe(true);
  });
});

describe("assessCacheHandoff", () => {
  const big = [rec({ input: 10, cachedInput: 400_000, cacheCreation: 1_000 })];
  const medium = [rec({ input: 10, cachedInput: 120_000, cacheCreation: 500 })];
  it("空闲超过缓存时间且上下文超过阈值才触发（Claude 默认 10 万，其余默认 20 万）", () => {
    expect(assessCacheHandoff(plain({ endedAgoMs: 3 * H }), big, { now: NOW })).toMatchObject({ eligible: true, due: true, idleMs: 3 * H, contextTokens: 401_010, ttlMs: H, thresholdTokens: 100_000 });
    expect(assessCacheHandoff(plain({ endedAgoMs: 3 * H }), medium, { now: NOW })).toMatchObject({ eligible: true, due: true, contextTokens: 120_510, thresholdTokens: 100_000 });
    expect(assessCacheHandoff({ ...plain({ endedAgoMs: 3 * H }), runtimeKind: "codex" as const }, medium, { now: NOW })).toMatchObject({ eligible: true, due: false, skip: "context-small", thresholdTokens: 200_000 });
    expect(assessCacheHandoff({ ...plain({ endedAgoMs: 3 * H }), runtimeKind: "antigravity" as const }, medium, { now: NOW })).toMatchObject({ eligible: true, due: false, skip: "context-small", thresholdTokens: 200_000 });
  });
  it("缓存还热、上下文不大、上下文未知都不触发，并说明原因", () => {
    expect(assessCacheHandoff(plain({ endedAgoMs: 10 * 60_000 }), big, { now: NOW })).toMatchObject({ due: false, skip: "cache-warm" });
    expect(assessCacheHandoff(plain({ endedAgoMs: 3 * H }), [rec({ input: 10, cachedInput: 50_000 })], { now: NOW })).toMatchObject({ due: false, skip: "context-small" });
    expect(assessCacheHandoff(plain({ endedAgoMs: 3 * H }), [], { now: NOW })).toMatchObject({ eligible: true, due: false, skip: "context-unknown" });
  });
  it("阈值可调；Pi 的 DeepSeek 要空闲超过 6 小时", () => {
    expect(assessCacheHandoff(plain({ endedAgoMs: 3 * H }), big, { now: NOW, thresholdTokens: 500_000 })).toMatchObject({ due: false, skip: "context-small" });
    const pi = { ...plain({ endedAgoMs: 3 * H }), runtimeKind: "pi" as const, requestedModel: "deepseek/deepseek-flash" };
    expect(assessCacheHandoff(pi, big, { now: NOW })).toMatchObject({ due: false, skip: "cache-warm" });
    expect(assessCacheHandoff({ ...pi, turns: plain({ endedAgoMs: 7 * H }).turns }, big, { now: NOW })).toMatchObject({ due: true });
  });
  it("群聊、对比、项目、已归档、还在运行（没有结束时间）、有排队消息、功能关闭的会话不参与", () => {
    const base = plain({ endedAgoMs: 3 * H });
    expect(assessCacheHandoff({ ...base, roomRef: { roomId: "r", memberId: "m" } }, big, { now: NOW })).toMatchObject({ eligible: false, due: false, skip: "not-plain-session" });
    expect(assessCacheHandoff({ ...base, archived: true }, big, { now: NOW })).toMatchObject({ eligible: false, skip: "archived" });
    expect(assessCacheHandoff(plain(), big, { now: NOW })).toMatchObject({ eligible: false, skip: "no-finished-turn" });
    expect(assessCacheHandoff({ ...base, outbox: [{ messageId: "m", prompt: "x", actor: "a", createdAt: "t" }] }, big, { now: NOW })).toMatchObject({ eligible: false, skip: "outbox-pending" });
    expect(assessCacheHandoff(base, big, { now: NOW, enabled: false })).toMatchObject({ eligible: false, skip: "disabled" });
  });
});

describe("交接材料", () => {
  const ev = (key: string, role: "user" | "assistant", text: string, extra: Partial<ProjectedEvent> = {}): ProjectedEvent => ({ key, kind: "message", role, text, source: "stream", parserVersion: "t", availability: "recorded", seq: 1, turnNo: 1, ...extra } as ProjectedEvent);
  it("只留人的消息和助手的文字回复，平台自动消息单独标出，工具输出不进去", () => {
    const events = [ev("a", "user", "做个设置页"), { ...ev("t", "assistant", "SECRET TOOL OUTPUT"), kind: "tool" } as ProjectedEvent, ev("b", "assistant", "做好了方向 A"), ev("c", "user", QUOTA_RESUME_PROMPT), ev("d", "assistant", "partial", { partial: true })];
    const md = buildTranscript("设置页", events);
    expect(md).toContain("## 用户"); expect(md).toContain("做个设置页"); expect(md).toContain("做好了方向 A"); expect(md).toContain("## 平台自动消息");
    expect(md).not.toContain("SECRET TOOL OUTPUT"); expect(md).not.toContain("partial");
  });
  it("摘录最近一条真实用户消息（跳过平台自动消息）和最近一条助手回复", () => {
    const events = [ev("a", "user", "第一问"), ev("b", "assistant", "第一答"), ev("c", "user", "第二问"), ev("d", "assistant", "第二答"), ev("e", "user", QUOTA_RESUME_PROMPT)];
    expect(handoffTail(events)).toEqual({ user: "第二问", assistant: "第二答" });
  });
});

/* ------------------------------ 管理器：新开会话接续 ------------------------------ */

let dir: string, ws: string, mgr: RuntimeSessionManager, driver: FakeDriver;
let windows: Array<{ label: string; usedPercent: number | null; resetsAt: string | null }>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rt-cache-handoff-")); ws = join(dir, "work"); mkdirSync(ws);
  driver = new FakeDriver("codex");
  windows = [{ label: "5 小时窗口", usedPercent: 100, resetsAt: new Date(Date.now() + 2 * H).toISOString() }];
  driver.rateLimits = async () => ({ windows, source: "fake", sampledAt: new Date().toISOString(), available: true });
  mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver }, skipRecovery: true });
  mgr.updateSettings({ workspaceRoots: [ws] }, "local"); await mgr.probe("codex");
});
afterEach(async () => { mgr.shutdown(); await tick(35); rmSync(dir, { recursive: true, force: true }); });

const binding = (id: string) => mgr.store.binding(id)!;
async function startSession(extra: Record<string, unknown> = {}) {
  const { session } = await mgr.create({ idempotencyKey: `c-${randomUUID()}`, runtimeKind: "codex", workspace: ws, title: "长会话", prompt: "第一轮", confirmedProfileVersion: mgr.profile("codex")!.checkedAt, ...extra }, "local");
  await until(() => driver.turns.length === 1);
  return session.platformSessionId;
}
function end(n: number, r: { status: "completed" | "failed"; reason?: string; code?: string }) {
  const t = driver.turns[n - 1]!;
  driver.fingerprints.set(t.nativeId, `fp-after-${n}`);
  t.finish(r);
}
/** 把会话变成「空闲了 3 小时、上下文 40 万」：缓存已经冷了的大会话 */
function makeCold(id: string, contextTokens = 400_000) {
  mgr.store.updateBinding(id, (x) => { const t = x.turns.at(-1)!; t.endedAt = new Date(Date.now() - 3 * H).toISOString(); }, undefined, { bump: false });
  mgr.store.addUsage(id, rec({ usageScope: "session", counterMode: "cumulative", model: undefined, input: 1_000_000, contextTokens, sampledAt: new Date().toISOString(), sourceRef: "codex:thread/tokenUsage/updated" }));
}
const key = () => `h-${randomUUID()}`;

describe("handoffSession：新开会话接续并归档旧会话", () => {
  it("新会话沿用设置和待办关联、带上接续说明；旧会话归档、不标完成待办、worktree 转给新会话不删", async () => {
    const id = await startSession({ noteRef: { noteId: "note-1" }, capabilityGateway: true });
    end(1, { status: "completed" });
    await until(() => binding(id).status === "idle");
    // 模拟旧会话有一个独立 worktree：目录里放个文件，归档后必须还在
    const wt = join(dir, "wt"); mkdirSync(wt); const marker = join(wt, "unsaved.txt"); writeFileSync(marker, "未提交的改动");
    mgr.store.updateBinding(id, (x) => { x.worktree = { repoRoot: ws, path: wt, branch: "pi/rt-0123456789abcdef", baseRef: "main", baseCommit: "abc", subdir: "" }; }, undefined, { bump: false });
    makeCold(id);
    expect(mgr.cacheHandoff(id)).toMatchObject({ eligible: true, due: true, contextTokens: 400_000 });

    const archivedEvents: Array<{ noteId?: string }> = [];
    mgr.on("archived", (e: { noteId?: string }) => archivedEvents.push(e));
    const r = await mgr.handoffSession(id, { idempotencyKey: key(), prompt: "继续做设置页", reason: "manual" }, "local");
    expect(binding(r.session.platformSessionId).capabilityGateway).toBe(true);
    const nid = r.session.platformSessionId;
    expect(nid).not.toBe(id);
    expect(r.handedOffFrom).toBe(id);
    await until(() => driver.turns.length === 2);
    const prompt = driver.turns[1]!.args.prompt;
    expect(prompt).toContain("【平台接续】"); expect(prompt).toContain(id); expect(prompt).toContain("继续做设置页");
    expect(prompt).toContain("第一轮"); // 旧会话里用户最近一条消息
    // 新会话
    expect(binding(nid)).toMatchObject({ title: "续2·长会话", runtimeKind: "codex", noteRef: { noteId: "note-1" }, handoff: { reason: "manual", from: { platformSessionId: id, title: "长会话" } } });
    expect(binding(nid).worktree).toMatchObject({ path: wt, branch: "pi/rt-0123456789abcdef" });
    expect(existsSync(binding(nid).handoff!.from!.transcriptPath!)).toBe(true);
    expect(readFileSync(binding(nid).handoff!.from!.transcriptPath!, "utf8")).toContain("第一轮");
    // 旧会话
    expect(binding(id).archived).toBe(true);
    expect(binding(id).worktree).toBeUndefined();
    expect(binding(id).handoff?.to?.platformSessionId).toBe(nid);
    expect(existsSync(marker)).toBe(true);
    // 待办没有被当成「会话做完了」
    expect(archivedEvents).toEqual([{ platformSessionId: id }]);
  });

  it("真实 git worktree：接管后未提交改动还在、分支还在；新会话归档时才删除", async () => {
    const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    sh(ws, "init", "-q", "-b", "main"); sh(ws, "config", "user.email", "t@example.test"); sh(ws, "config", "user.name", "t");
    writeFileSync(join(ws, "a.txt"), "base\n"); sh(ws, "add", "-A"); sh(ws, "commit", "-q", "-m", "base");
    const id = await startSession({ worktree: true });
    const wt = binding(id).worktree!;
    writeFileSync(join(wt.path, "pending.txt"), "uncommitted\n");
    end(1, { status: "completed" }); await until(() => binding(id).status === "idle");
    makeCold(id);
    const r = await mgr.handoffSession(id, { idempotencyKey: key(), prompt: "继续", reason: "manual" }, "local");
    const nid = r.session.platformSessionId;
    expect(r.archiveError).toBeUndefined();
    expect(binding(id).archived).toBe(true);
    expect(existsSync(join(wt.path, "pending.txt"))).toBe(true);
    expect(sh(ws, "branch", "--list", wt.branch).trim()).not.toBe("");
    expect(binding(nid).worktree).toMatchObject({ path: wt.path, branch: wt.branch });
    expect(binding(nid).workspace).toBe(binding(id).workspace);
    await until(() => driver.turns.length === 2);
    driver.turns[1]!.finish({ status: "completed" });
    await until(() => binding(nid).status === "idle");
    await mgr.archive(nid, true, "local"); // 新会话归档时才清理 worktree 和分支
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(ws, "branch", "--list", wt.branch).trim()).toBe("");
  });

  it("同一个请求键重放不会再建第二个会话", async () => {
    const id = await startSession();
    end(1, { status: "completed" }); await until(() => binding(id).status === "idle");
    makeCold(id);
    const k = key();
    const a = await mgr.handoffSession(id, { idempotencyKey: k, prompt: "继续", reason: "manual" }, "local");
    const b = await mgr.handoffSession(id, { idempotencyKey: k, prompt: "继续", reason: "manual" }, "local");
    expect(b.replayed).toBe(true);
    expect(b.session.platformSessionId).toBe(a.session.platformSessionId);
  });

  it("运行中或不满足条件的会话不能接续，什么都不会改", async () => {
    const id = await startSession();
    await expect(mgr.handoffSession(id, { idempotencyKey: key(), prompt: "x", reason: "manual" }, "local")).rejects.toMatchObject({ code: expect.stringMatching(/RT_HANDOFF_UNAVAILABLE|RT_BUSY/) });
    expect(binding(id).archived).toBeFalsy();
    expect(mgr.store.allBindings()).toHaveLength(1);
  });
});

describe("额度恢复后的自动续跑", () => {
  const limit = (n: number) => end(n, { status: "failed", reason: "You’ve hit your usage limit.", code: "usageLimitExceeded" });
  const dueNow = (id: string) => {
    mgr.store.updateBinding(id, x => { x.quotaResume!.scheduledFor = new Date(Date.now() - 1000).toISOString(); }, undefined, { bump: false });
    (mgr as unknown as { setQuotaTimer(pid: string, at: number): void }).setQuotaTimer(id, Date.now());
  };

  it("缓存已冷的大会话：不续旧会话，新开会话并归档旧会话，连续次数带过去", async () => {
    const id = await startSession();
    limit(1);
    await until(() => !!binding(id).quotaResume);
    makeCold(id);
    windows = [{ label: "5 小时窗口", usedPercent: 3, resetsAt: new Date(Date.now() + 5 * H).toISOString() }];
    dueNow(id);
    await until(() => driver.turns.length === 2, 4000);
    const nid = mgr.store.allBindings().find(b => b.platformSessionId !== id)!.platformSessionId;
    expect(driver.turns[1]!.args.prompt).toContain(QUOTA_RESUME_PROMPT);
    expect(driver.turns[1]!.args.prompt).toContain("【平台接续】");
    expect(binding(id).archived).toBe(true);
    expect(binding(nid).handoff).toMatchObject({ reason: "quota-resume", from: { platformSessionId: id } });
    expect(binding(nid).quotaResumeStreak).toBe(1);
  });

  it("上下文不大就照常续旧会话", async () => {
    const id = await startSession();
    limit(1);
    await until(() => !!binding(id).quotaResume);
    makeCold(id, 50_000);
    windows = [{ label: "5 小时窗口", usedPercent: 3, resetsAt: new Date(Date.now() + 5 * H).toISOString() }];
    dueNow(id);
    await until(() => driver.turns.length === 2, 4000);
    expect(driver.turns[1]!.args.prompt).toBe(QUOTA_RESUME_PROMPT);
    expect(binding(id).archived).toBeFalsy();
    expect(mgr.store.allBindings()).toHaveLength(1);
  });

  it("同一账号的第二个大会话被错开，不和第一个一起冷启动", async () => {
    const a = await startSession();
    const { session } = await mgr.create({ idempotencyKey: `c-${randomUUID()}`, runtimeKind: "codex", workspace: ws, title: "另一个", prompt: "第一轮", confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "local");
    await until(() => driver.turns.length === 2);
    const b = session.platformSessionId;
    limit(1); limit(2);
    await until(() => !!binding(a).quotaResume && !!binding(b).quotaResume);
    makeCold(a); makeCold(b);
    windows = [{ label: "5 小时窗口", usedPercent: 3, resetsAt: new Date(Date.now() + 5 * H).toISOString() }];
    dueNow(a); dueNow(b);
    await until(() => driver.turns.length === 3, 4000);
    await tick(300);
    expect(driver.turns).toHaveLength(3); // 只发起了一个接续
    const waiting = [a, b].filter(id => !binding(id).archived);
    expect(waiting).toHaveLength(1);
    expect(Date.parse(binding(waiting[0]!).quotaResume!.scheduledFor)).toBeGreaterThan(Date.now() + 2 * 60_000);
  });
});
