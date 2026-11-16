import {SCREENSHOT_INSTRUCTIONS} from "../../pi-runtime/src/screenshot-policy.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeSessionManager } from "../src/manager.js";
import type { RuntimeKind } from "../src/types.js";
import { ev, FakeDriver, tick, until } from "./fake-driver.js";

let dir: string;
let ws: string;
let codex: FakeDriver;
let claude: FakeDriver;
let mgr: RuntimeSessionManager;

function make(opts: { approvalTtlMs?: number } = {}): RuntimeSessionManager {
  return new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex, "claude-code": claude }, skipRecovery: true, ...opts });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rt-mgr-"));
  ws = join(dir, "work", "proj");
  mkdirSync(ws, { recursive: true });
  codex = new FakeDriver("codex");
  claude = new FakeDriver("claude-code");
  claude.stableAccountId = undefined;
  mgr = make();
  mgr.updateSettings({ workspaceRoots: [join(dir, "work")] }, "test");
  await mgr.probe("codex");
  await mgr.probe("claude-code");
});
afterEach(async () => { mgr.shutdown(); await tick(30); rmSync(dir, { recursive: true, force: true }); });

let keyN = 0;
const key = () => `key-${Date.now()}-${keyN++}`;
async function create(kind: RuntimeKind = "codex", prompt = "你好", extra: Record<string, unknown> = {}) {
  const p = mgr.profile(kind)!;
  return mgr.create({ idempotencyKey: key(), runtimeKind: kind, workspace: ws, prompt, confirmedProfileVersion: p.checkedAt, ...extra }, "test");
}
const driver = (k: RuntimeKind) => k === "codex" ? codex : claude;

it("indexes user messages and compact deployment landmarks beyond the transcript window, excluding subagents", async () => {
  const { session } = await create("codex", "首条提问");
  await until(() => codex.turns.length === 1);
  const sink = codex.turns[0]!.sink;
  for (let i = 0; i < 220; i++) sink.event(ev(`nav-${i}`, `user ${i}\n${"长".repeat(150)}`, { role: i % 2 ? "assistant" : "user" }));
  sink.event(ev("nav-image", "", { role: "user" }));
  sink.event(ev("nav-system", "[pi-agent 自动部署通知] 已上线：abcdef1（Merge commit extra description）。现在可以验证。\n部署日志：/tmp/private.log", { role: "user" }));
  const outcomes = [
    ["不用部署：abcdef2 已经在线上（线上 1234567 已包含它）。", "已在线上 · abcdef2"],
    ["部署 abcdef3 没有成功，线上仍是 1234567。", "部署失败 · abcdef3"],
    ["等空闲超时，放弃部署 abcdef4；线上仍是 1234567。", "部署超时 · abcdef4"],
    ["没有部署 abcdef5：线上是 1234567，它不在历史里。", "未部署 · abcdef5"]
  ];
  outcomes.forEach(([headline], i) => sink.event(ev(`nav-outcome-${i}`, `[pi-agent 自动部署通知] ${headline}`, { role: "user" })));
  sink.event(ev("nav-subagent", "子任务", { role: "user", subagent: "child" }));
  const index = await mgr.messageIndex(session.platformSessionId);
  expect(index.items[0]!.summary).toBe("首条提问");
  expect(index.items).toHaveLength(117);
  expect(index.items.find(e => e.key === "nav-system")).toMatchObject({ type: "deployment", summary: "部署成功 · abcdef1" });
  outcomes.forEach(([, expected], i) => expect(index.items.find(e => e.key === `nav-outcome-${i}`)?.summary).toBe(expected));
  expect(index.items.some(e => e.key === "nav-subagent")).toBe(false);
  expect(index.items.every(e => e.summary.length <= 120 && !e.summary.includes("\n"))).toBe(true);
  expect(index.items.every(e => Object.keys(e).sort().join(",") === (e.type === "deployment" ? "key,seq,summary,type" : "key,seq,summary"))).toBe(true);
  expect(index.firstSeq).toBeLessThan(index.lastSeq!);
  expect(index.items[0]!.seq).toBeLessThan((await mgr.messages(session.platformSessionId, { limit: 100 })).firstSeq!);
  await expect(mgr.messageIndex("unknown-session")).rejects.toMatchObject({ code: "RT_NOT_FOUND" });
});

it("returns the create result before the first native turn starts", async () => {
  const { session } = await create("codex", "先创建，再启动首轮");
  // 创建响应必须先于原生进程启动：用户看到会话时，首轮还没产生任何工具调用。
  expect(codex.startCalls).toBe(0);
  expect(codex.turns).toHaveLength(0);
  expect(session.turns[0]!.status).toBe("queued");
  await until(() => codex.turns.length === 1);
  expect(codex.startCalls).toBe(1);
});

describe("automatic account quota refresh", () => {
  it("discards a late quota response after the account has changed", async () => {
    const previous = mgr.profile("codex")!.identity!.identityScopeId;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    vi.spyOn(codex, "rateLimits").mockImplementation(async () => { await gate; return { available: true, sampledAt: new Date().toISOString(), source: "native", windows: [{ label: "5 小时窗口", usedPercent: 99, resetsAt: null }] }; });
    const pending = mgr.refreshRateLimit("codex");
    codex.stableAccountId = "different-account";
    await mgr.probe("codex");
    release();
    expect(await pending).toBeUndefined();
    expect(mgr.profiles().find(p => p.runtimeKind === "codex")!.rateLimit!.windows[0]!.usedPercent).toBe(10);
    expect(mgr.store.rateLimits()[previous]!.windows[0]!.usedPercent).toBe(10);
  });
  it("serves the cached snapshot immediately and refreshes stale data in the background", async () => {
    const scope = mgr.profile("codex")!.identity!.identityScopeId;
    const initial = mgr.profiles().find(p => p.runtimeKind === "codex")!.rateLimit!;
    // 一分钟内的快照直接复用，不启动原生查询。
    expect((await mgr.refreshRateLimit("codex", { automatic: true }))!.windows[0]!.usedPercent).toBe(10);
    mgr.store.saveRateLimit({ ...initial, sampledAt: new Date(Date.now() - 120_000).toISOString() });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const query = vi.spyOn(codex, "rateLimits").mockImplementation(async () => {
      await gate;
      return { available: true, sampledAt: new Date().toISOString(), source: "native", windows: [{ label: "5 小时窗口", usedPercent: 3, resetsAt: null }] };
    });
    // 过期快照不再让轮询等 3–4 秒：立即返回上次数值，同时在后台单飞刷新。
    const started = Date.now();
    const first = await mgr.refreshRateLimit("codex", { automatic: true });
    const second = await mgr.refreshRateLimit("codex", { automatic: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(first?.identityScopeId).toBe(scope);
    expect(first?.windows[0]?.usedPercent).toBe(10);
    expect(second?.windows[0]?.usedPercent).toBe(10);
    expect(query).toHaveBeenCalledTimes(1);
    release();
    await until(() => mgr.profiles().find(p => p.runtimeKind === "codex")?.rateLimit?.windows[0]?.usedPercent === 3);
  });

  it("starts a background query at a reset boundary even when the sample is less than one minute old", async () => {
    const initial = mgr.profiles().find(p => p.runtimeKind === "codex")!.rateLimit!;
    mgr.store.saveRateLimit({ ...initial, sampledAt: new Date(Date.now() - 20_000).toISOString(), windows: [{ label: "5 小时窗口", usedPercent: 75, resetsAt: new Date(Date.now() - 1000).toISOString() }] });
    const query = vi.spyOn(codex, "rateLimits").mockResolvedValue({ available: true, sampledAt: new Date().toISOString(), source: "native", windows: [{ label: "5 小时窗口", usedPercent: 12, resetsAt: null }] });
    expect((await mgr.refreshRateLimit("codex", { automatic: true }))?.windows[0]?.usedPercent).toBe(75);
    await until(() => query.mock.calls.length === 1);
    await until(() => mgr.profiles().find(p => p.runtimeKind === "codex")?.rateLimit?.windows[0]?.usedPercent === 12);
  });

  it("keeps the last value when a background refresh fails, marks it stale and backs off", async () => {
    const initial = mgr.profiles().find(p => p.runtimeKind === "codex")!.rateLimit!;
    mgr.store.saveRateLimit({ ...initial, sampledAt: new Date(Date.now() - 120_000).toISOString() });
    const query = vi.spyOn(codex, "rateLimits").mockRejectedValue(new Error("quota offline"));
    expect((await mgr.refreshRateLimit("codex", { automatic: true }))?.windows[0]?.usedPercent).toBe(10);
    await until(() => query.mock.calls.length === 1);
    await until(() => mgr.profiles().find(p => p.runtimeKind === "codex")?.rateLimit?.stale === true);
    // 30 秒退避内再轮询：继续用上次数值，不重复启动原生查询。
    expect((await mgr.refreshRateLimit("codex", { automatic: true }))?.windows[0]?.usedPercent).toBe(10);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
    // 显式手动刷新仍可立即重试并清除失败标记。
    await mgr.refreshRateLimit("codex");
    expect(mgr.profiles().find(p => p.runtimeKind === "codex")?.rateLimit?.stale).toBe(false);
  });
});

it("directory reads each profile and approval snapshot once regardless of session count", async () => {
  await create(); await create("claude-code");
  await until(() => codex.turns.length === 1 && claude.turns.length === 1);
  const profiles = vi.spyOn(mgr.store, "profiles");
  const approvals = vi.spyOn(mgr.store, "allApprovals");
  try {
    const result = await mgr.directory({ source: "chat", includeHistory: false });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(e => e.pendingApprovals)).toEqual([0, 0]);
    expect(profiles).toHaveBeenCalledTimes(1);
    expect(approvals).toHaveBeenCalledTimes(1);
  } finally { profiles.mockRestore(); approvals.mockRestore(); }
});

describe("创建与幂等（V28-01/04/05）", () => {
  it("同一幂等键只派发一次，返回同一会话", async () => {
    const p = mgr.profile("codex")!;
    const input = { idempotencyKey: "same-key-123", runtimeKind: "codex" as const, workspace: ws, prompt: "hi", confirmedProfileVersion: p.checkedAt };
    const a = await mgr.create(input, "t");
    const b = await mgr.create(input, "t");
    expect(b.replayed).toBe(true);
    expect(b.session.platformSessionId).toBe(a.session.platformSessionId);
    await until(() => codex.turns.length === 1);
    await tick(20);
    expect(codex.startCalls).toBe(1);
    const s = mgr.store.binding(a.session.platformSessionId)!;
    expect(s.nativeSessionId).toBe(codex.turns[0]!.nativeId);
    expect(s.platformSessionId).not.toBe(s.nativeSessionId);
    expect(s.effectiveModel).toBe("m-1");
    expect(s.effectiveModelSource).toBe("fake 响应");
  });

  it("确认后 profile 重新探测过 → 要求重新确认", async () => {
    const old = mgr.profile("codex")!.checkedAt;
    await tick(5);
    await mgr.probe("codex");
    await expect(mgr.create({ idempotencyKey: key(), runtimeKind: "codex", workspace: ws, prompt: "x", confirmedProfileVersion: old }, "t")).rejects.toMatchObject({ code: "RT_PROFILE_CHANGED" });
  });

  it("工作目录必须在允许根内，symlink 逃逸被拒", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "work", "link"));
    await expect(create("codex", "x", { workspace: outside })).rejects.toMatchObject({ code: "RT_WORKSPACE" });
    await expect(create("codex", "x", { workspace: join(dir, "work", "link") })).rejects.toMatchObject({ code: "RT_WORKSPACE" });
  });

  it("从待办发起的会话记下关联记录，续聊后仍在；目录里带上待办引用", async () => {
    const { session } = await create("codex", "引用待办", { noteRef: { noteId: "n-123" } });
    expect(mgr.store.binding(session.platformSessionId)!.noteRef).toEqual({ noteId: "n-123" });
    const dir = await mgr.directory({ source: "chat", includeHistory: false });
    expect(dir.entries.find(e => e.id === session.platformSessionId)?.noteRef).toEqual({ noteId: "n-123" });
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    const b = mgr.store.binding(session.platformSessionId)!;
    await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "接着聊", expectedRevision: b.bindingRevision }, "t");
    expect(mgr.store.binding(session.platformSessionId)!.noteRef).toEqual({ noteId: "n-123" });
    await expect(create("codex", "x", { noteRef: { noteId: "  " } })).rejects.toMatchObject({ code: "RT_INPUT" });
  });

  it("noteSessions 指纹不变时复用上次结果，绑定变化（含归档、新会话）后立刻重算", async () => {
    const a = await create("codex", "缓存 A", { noteRef: { noteId: "n-cache" } });
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(a.session.platformSessionId)!.status === "idle");

    const reads = vi.spyOn(mgr.store, "allBindings");
    // 只数 noteSessions 自己触发的整表读取（创建、归档等内部流程也会读表）
    const call = () => { const n = reads.mock.calls.length; const value = mgr.noteSessions(); return { value, reads: reads.mock.calls.length - n }; };
    const first = call();
    expect(first.reads).toBe(1);
    // 绑定表没变：不再读整张表，返回的就是同一份结果
    for (let i = 0; i < 3; i++) { const again = call(); expect(again.reads).toBe(0); expect(again.value).toBe(first.value); }

    // 归档改了绑定表：必须立刻反映，不能返回旧的 archived=false
    await mgr.archive(a.session.platformSessionId, true, "test");
    const afterArchive = call();
    expect(afterArchive.reads).toBe(1);
    expect(afterArchive.value["n-cache"]![0]!.archived).toBe(true);
    expect(call().reads).toBe(0);

    // 新会话关联同一待办：同样立刻出现
    const b = await create("codex", "缓存 B", { noteRef: { noteId: "n-cache" } });
    expect(call().value["n-cache"]!.map((l) => l.platformSessionId)).toContain(b.session.platformSessionId);
    reads.mockRestore();
  });

  it("bindingsStamp：未落盘的活动时间补丁也会改变指纹", async () => {
    const a = await create("codex", "指纹", { noteRef: { noteId: "n-stamp" } });
    const before = mgr.store.bindingsStamp();
    expect(before).not.toBe("");
    expect(mgr.store.bindingsStamp()).toBe(before);
    (mgr.store as unknown as { activity: Map<string, unknown> }).activity.set(a.session.platformSessionId, { at: "2099-01-01T00:00:00.000Z", source: "platform" });
    expect(mgr.store.bindingsStamp()).not.toBe(before);
  });

  it("一个待办下的多个会话可反查；归档时发出带 noteId 的通知", async () => {
    const a = await create("codex", "引用 A", { noteRef: { noteId: "n-1" } });
    const b = await create("codex", "引用 B", { noteRef: { noteId: "n-1" } });
    await until(() => codex.turns.length === 2);
    for (const turn of codex.turns) turn.finish({ status: "completed" });
    const idle = (id: string) => mgr.store.binding(id)!.status === "idle";
    await until(() => idle(a.session.platformSessionId) && idle(b.session.platformSessionId));

    const links = mgr.noteSessions();
    expect(Object.keys(links)).toEqual(["n-1"]);
    expect(links["n-1"]!.map((l) => l.platformSessionId).sort()).toEqual([a.session.platformSessionId, b.session.platformSessionId].sort());
    expect(links["n-1"]!.every((l) => l.href === `#/rt/${l.platformSessionId}` && !l.archived)).toBe(true);

    const seen: Array<{ platformSessionId: string; noteId?: string }> = [];
    mgr.on("archived", (u: { platformSessionId: string; noteId?: string }) => seen.push(u));
    await mgr.archive(a.session.platformSessionId, true, "test");
    expect(seen).toEqual([{ platformSessionId: a.session.platformSessionId, noteId: "n-1" }]);
    expect(mgr.noteSessions()["n-1"]!.find((l) => l.platformSessionId === a.session.platformSessionId)!.archived).toBe(true);

    // 无关联的会话归档也发通知，但事件里没有 noteId（宿主侧由此区分不标记待办）
    const c = await create("codex", "无引用");
    await until(() => codex.turns.length === 3);
    codex.turns[2]!.finish({ status: "completed" });
    await until(() => idle(c.session.platformSessionId));
    await mgr.archive(c.session.platformSessionId, true, "test");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ platformSessionId: c.session.platformSessionId });
    // 只有已归档且引用待办的会话进入补标清单（a 已归档，b 未归档，c 无引用）
    expect(mgr.archivedNoteIds()).toEqual(["n-1"]);
  });

  it("未报告的模型被拒；不可执行的 profile 禁止创建", async () => {
    await expect(create("codex", "x", { model: "gpt-unknown" })).rejects.toMatchObject({ code: "RT_INPUT" });
    codex.probeState = "needs-login";
    await mgr.probe("codex");
    await expect(create("codex")).rejects.toMatchObject({ code: "RT_PROFILE" });
  });

  it("原生会话已建、首轮发送失败：保留原生 ID，可续聊，不再建一份（V28-05）", async () => {
    codex.failNext = { stage: "dispatch", message: "turn/start boom", nativeId: "thr-x" };
    const { session } = await create();
    await until(() => mgr.store.operation(session.creationOperationId)!.state === "failed");
    const b = mgr.store.binding(session.platformSessionId)!;
    expect(b.nativeSessionId).toBe("thr-x");
    expect(b.status).toBe("idle");
    expect(b.turns[0]!.status).toBe("failed");
    const r = await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "再试", expectedRevision: b.bindingRevision }, "t");
    await until(() => codex.turns.length === 1);
    expect(codex.turns[0]!.args.nativeSessionId).toBe("thr-x");
    expect(r.session.turns.length).toBe(2);
  });

  it("创建阶段失败 → failed；响应异常 → unknown 不重发", async () => {
    codex.failNext = { stage: "create", message: "spawn 失败" };
    const a = await create();
    await until(() => mgr.store.binding(a.session.platformSessionId)!.status === "failed");
    codex.failNext = { stage: "unknown", message: "socket hang up" };
    const b = await create();
    await until(() => mgr.store.binding(b.session.platformSessionId)!.status === "unknown");
    expect(mgr.store.operation(b.session.creationOperationId)!.state).toBe("unknown");
    await tick(20);
    expect(codex.startCalls).toBe(2);
  });
});

describe("流式事件、去重与用量（V28-06/13）", () => {
  it("片段合并、完成替换、重复与重放不重复，工具结果补齐不抹参数", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    const t = codex.turns[0]!;
    const pid = session.platformSessionId;
    t.sink.event(ev("codex:item:a1", "你", { partial: true }));
    t.sink.event(ev("codex:item:a1", "你好", { partial: true }));
    t.sink.event(ev("codex:item:a1", "你好，世界", { partial: false }));
    t.sink.event(ev("codex:item:a1", "你好，世", { partial: true })); // 迟到片段
    t.sink.event(ev("codex:item:a1", "你好，世界", { partial: false })); // 重放
    t.sink.event({ key: "codex:item:t1", kind: "tool", tool: { name: "命令", input: "ls", status: "inProgress" }, source: "stream", parserVersion: "f", availability: "recorded" });
    t.sink.event({ key: "codex:item:t1", kind: "tool", tool: { name: "", output: "a.txt", status: "completed", exitCode: 0 }, source: "stream", parserVersion: "f", availability: "recorded" });
    const events = mgr.store.events(pid);
    const msgs = events.filter((e) => e.key === "codex:item:a1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe("你好，世界");
    expect(msgs[0]!.partial).toBe(false);
    const tool = events.find((e) => e.key === "codex:item:t1")!;
    expect(tool.tool).toMatchObject({ name: "命令", input: "ls", output: "a.txt", status: "completed" });
    // 累计快照：多次上报取最新，不相加
    const u = (total: number, at: string) => ({ usageScope: "session" as const, counterMode: "cumulative" as const, raw: {}, input: total, output: 10, total: total + 10, semantics: "s", sourceRef: "codex:thread/tokenUsage/updated", sampledAt: at, reliability: "complete" as const });
    t.sink.usage(u(100, "2026-01-01T00:00:01Z"));
    t.sink.usage(u(250, "2026-01-01T00:00:02Z"));
    t.finish({ status: "completed" });
    await until(() => mgr.store.binding(pid)!.status === "idle");
    const view = mgr.sessionView(pid);
    expect(view.usage.totals.input).toBe(250);
    expect(view.usage.coverage).toBe("complete");
    // 重启后的持久化：片段不落盘，完成记录在
    mgr.shutdown();
    const again = make();
    expect(again.store.events(pid).find((e) => e.key === "codex:item:a1")!.text).toBe("你好，世界");
    again.shutdown();
  });

  it("单请求 delta 按 requestId 去重；没有用量显示 unknown 而不是 0；子 Agent 单列", async () => {
    const { session } = await create("claude-code");
    await until(() => claude.turns.length === 1);
    const t = claude.turns[0]!;
    const pid = session.platformSessionId;
    expect(mgr.sessionView(pid).usage.coverage).toBe("unknown");
    expect(mgr.sessionView(pid).usage.totals.input).toBeUndefined();
    const d = (id: string, input: number, sub?: string) => ({ usageScope: "request" as const, counterMode: "delta" as const, raw: {}, input, output: 5, cachedInput: 100, requestId: id, semantics: "c", sourceRef: `claude:message:${id}`, sampledAt: new Date().toISOString(), reliability: "complete" as const, model: "claude-x", ...(sub ? { subagent: sub } : {}) });
    t.sink.usage(d("m1", 10));
    t.sink.usage(d("m1", 10)); // 同一请求重复上报
    t.sink.usage(d("m2", 20));
    t.sink.usage(d("m3", 999, "toolu_sub"));
    const v = mgr.sessionView(pid).usage;
    expect(v.totals.input).toBe(30);
    expect(v.totals.cachedInput).toBe(200);
    expect(v.requestCount).toBe(2);
    expect(v.subagentTotals?.input).toBe(999);
  });
});

describe("审批（V28-07）", () => {
  it("runtime-scoped session decisions return to the runtime without granting other pending requests", async () => {
    const a=await create(); await until(()=>codex.turns.length===1);
    const sink=codex.turns[0].sink;
    const req={nativeRequestId:"native-permission",kind:"permissions" as const,title:"Pi 工具授权",action:"read /skills/a",scope:"workspace",source:"Pi runtime",params:{path:"/skills/a"},requiresExplicitApproval:true,runtimeSessionScope:"本会话内相同动作与范围"};
    const selected=sink.approval(req);
    const other=sink.approval({...req,nativeRequestId:"other"});
    const pending=mgr.pendingApprovals().find(p=>p.nativeRequestId==="native-permission")!;
    expect(pending.runtimeSessionScope).toBe(req.runtimeSessionScope);
    mgr.decideApproval(a.session.platformSessionId,pending.approvalId,{approve:true,scope:"session",paramsDigest:pending.paramsDigest,turnNo:1},"owner");
    await expect(selected).resolves.toMatchObject({approve:true,scope:"session"});
    expect(mgr.sessionView(a.session.platformSessionId).session.approvalGrant).toBeUndefined();
    const remaining=mgr.pendingApprovals().find(p=>p.nativeRequestId==="other")!;
    expect(remaining.state).toBe("pending");
    mgr.decideApproval(a.session.platformSessionId,remaining.approvalId,{approve:false,paramsDigest:remaining.paramsDigest,turnNo:1},"owner");
    await expect(other).resolves.toMatchObject({approve:false});
  });

  it("explicit permission expansion neither inherits nor creates session grants", async () => {
    const a = await create(); await until(() => codex.turns.length === 1);
    const sink = codex.turns[0].sink;
    const req = (id: string, explicit = false) => ({ nativeRequestId: id, kind: "permissions" as const, title: "expand", action: id, scope: "worktree", source: "Pi", params: { id }, requiresExplicitApproval: explicit });
    const expansion = sink.approval(req("expand-pending", true));
    const ordinary = sink.approval(req("ordinary"));
    const grant = mgr.pendingApprovals().find(x => x.nativeRequestId === "ordinary")!;
    mgr.decideApproval(a.session.platformSessionId, grant.approvalId, { approve: true, paramsDigest: grant.paramsDigest, turnNo: 1, scope: "session" }, "owner");
    await expect(ordinary).resolves.toMatchObject({ approve: true });
    const pending = mgr.pendingApprovals().find(x => x.nativeRequestId === "expand-pending")!;
    expect(pending).toMatchObject({ requiresExplicitApproval: true });
    expect(() => mgr.decideApproval(a.session.platformSessionId, pending.approvalId, { approve: true, paramsDigest: pending.paramsDigest, turnNo: 1, scope: "session" }, "owner")).toThrow(/单次|single/);
    mgr.decideApproval(a.session.platformSessionId, pending.approvalId, { approve: true, paramsDigest: pending.paramsDigest, turnNo: 1 }, "owner");
    await expect(expansion).resolves.toMatchObject({ approve: true });
    const later = sink.approval(req("expand-later", true));
    const last = mgr.pendingApprovals().find(x => x.nativeRequestId === "expand-later")!;
    expect(last.state).toBe("pending");
    mgr.decideApproval(a.session.platformSessionId, last.approvalId, { approve: false, paramsDigest: last.paramsDigest, turnNo: 1 }, "owner");
    await expect(later).resolves.toMatchObject({ approve: false });
  });
  it("提问：必须逐次回答，不受本会话全部批准影响；答案经校验，只能选给出的选项或在允许时自填；跳过按拒绝", async () => {
    const a = await create(); await until(() => codex.turns.length === 1);
    const sink = codex.turns[0].sink, sid = a.session.platformSessionId;
    // 先建立一个会话级授权：之后的提问仍要等人
    const cmd = sink.approval({ nativeRequestId: "c1", kind: "command", title: "运行命令", action: "ls", scope: "", source: "Codex", params: { c: 1 } });
    const c1 = mgr.pendingApprovals().find(x => x.nativeRequestId === "c1")!;
    mgr.decideApproval(sid, c1.approvalId, { approve: true, paramsDigest: c1.paramsDigest, turnNo: 1, scope: "session" }, "owner"); await cmd;
    const questions = [
      { id: "q1", header: "库", question: "用哪个库？", options: [{ label: "dayjs" }, { label: "luxon" }], multiSelect: false, allowOther: false },
      { id: "q2", question: "要哪些功能？", options: [{ label: "时区" }, { label: "相对时间" }], multiSelect: true, allowOther: true },
      { id: "q3", question: "口令", options: [], multiSelect: false, allowOther: true, secret: true }
    ];
    const asked = sink.approval({ nativeRequestId: "ask-1", kind: "question", title: "Claude 想问你", questions, action: "", scope: "", source: "Claude", params: { questions } });
    const ap = mgr.pendingApprovals().find(x => x.nativeRequestId === "ask-1")!;
    expect(ap).toMatchObject({ state: "pending", kind: "question", requiresExplicitApproval: true, action: expect.stringContaining("用哪个库") });
    expect(ap.expiresAt).toBeUndefined();
    const decide = (body: Record<string, unknown>) => mgr.decideApproval(sid, ap.approvalId, { paramsDigest: ap.paramsDigest, turnNo: 1, approve: true, ...body } as never, "owner");
    expect(() => decide({ scope: "session", answers: {} })).toThrow(/逐次|整体/);
    expect(() => decide({})).toThrow(/回答/);
    expect(() => decide({ answers: { q1: ["moment"], q2: ["时区"], q3: ["x"] } })).toThrow(/不是可选项/);
    expect(() => decide({ answers: { q1: ["dayjs", "luxon"], q2: ["时区"], q3: ["x"] } })).toThrow(/只能选一项/);
    expect(() => decide({ answers: { q1: ["dayjs"], q2: ["时区", "自己的功能"] } })).toThrow(/还没有回答/);
    expect(() => decide({ answers: { q1: ["dayjs"], q2: ["时区"], q3: ["x"], extra: ["y"] } })).toThrow(/不存在的问题/);
    expect(mgr.store.approval(ap.approvalId)!.state).toBe("pending");
    decide({ answers: { q1: ["luxon"], q2: ["时区", "自己的功能"], q3: ["hunter2"] } });
    await expect(asked).resolves.toMatchObject({ approve: true, answers: { q1: ["luxon"], q2: ["时区", "自己的功能"], q3: ["hunter2"] } });
    const line = mgr.store.events(sid).find(e => e.approvalId === ap.approvalId && e.status === "approved")!;
    expect(line.text).toContain("库：luxon");
    expect(line.text).not.toContain("hunter2");
    expect(JSON.stringify(mgr.store.approval(ap.approvalId))).not.toContain("hunter2");
    // 跳过
    const skipped = sink.approval({ nativeRequestId: "ask-2", kind: "question", title: "Claude 想问你", questions: [questions[0]!], action: "", scope: "", source: "Claude", params: { q: 2 } });
    const ap2 = mgr.pendingApprovals().find(x => x.nativeRequestId === "ask-2")!;
    mgr.decideApproval(sid, ap2.approvalId, { approve: false, paramsDigest: ap2.paramsDigest, turnNo: 1 }, "owner");
    await expect(skipped).resolves.toMatchObject({ approve: false, reason: expect.stringContaining("不回答") });
  });
  it("本会话全部授权：批准当前与同会话待审批，之后自动批准并留记录；其他会话不受影响；撤销后恢复人工审批", async () => {
    const a = await create(), b = await create();
    await until(() => codex.turns.length === 2);
    const turn = (x: typeof a) => codex.turns.find((t) => mgr.store.binding(x.session.platformSessionId)!.nativeSessionId === t.nativeId)!;
    const ta = turn(a), tb = turn(b), req = (id: string) => ({ nativeRequestId: id, kind: "command" as const, title: "运行命令", action: `cmd ${id}`, scope: "", source: "Codex", params: { command: id } });
    const p1 = ta.sink.approval(req("r1")), p2 = ta.sink.approval(req("r2")), pb = tb.sink.approval(req("rb"));
    const first = mgr.pendingApprovals().find((x) => x.nativeRequestId === "r1")!;
    mgr.decideApproval(a.session.platformSessionId, first.approvalId, { approve: true, paramsDigest: first.paramsDigest, turnNo: 1, scope: "session" }, "owner");
    await expect(p1).resolves.toMatchObject({ approve: true }); await expect(p2).resolves.toMatchObject({ approve: true });
    expect(mgr.store.binding(a.session.platformSessionId)!.approvalGrant).toMatchObject({ grantedBy: "owner", approvalId: first.approvalId });
    expect(mgr.pendingApprovals().map((x) => x.nativeRequestId)).toEqual(["rb"]);
    await expect(ta.sink.approval(req("r3"))).resolves.toMatchObject({ approve: true });
    const auto = mgr.store.allApprovals().find((x) => x.nativeRequestId === "r3")!;
    expect(auto).toMatchObject({ state: "approved", decidedBy: "session-grant" });
    mgr.revokeApprovalGrant(a.session.platformSessionId, "owner");
    expect(mgr.store.binding(a.session.platformSessionId)!.approvalGrant).toBeUndefined();
    const p4 = ta.sink.approval(req("r4"));
    expect(mgr.pendingApprovals().map((x) => x.nativeRequestId).sort()).toEqual(["r4", "rb"]);
    for (const x of mgr.pendingApprovals()) mgr.decideApproval(x.platformSessionId, x.approvalId, { approve: false, paramsDigest: x.paramsDigest, turnNo: 1 }, "owner");
    await expect(p4).resolves.toMatchObject({ approve: false }); await expect(pb).resolves.toMatchObject({ approve: false });
  });
  it("批准与拒绝按原样传给 runtime；错参数/跨会话/过期/重复答复无效", async () => {
    const a = await create();
    const b = await create();
    await until(() => codex.turns.length === 2);
    const ta = codex.turns.find((t) => t.args.workspace && mgr.store.binding(a.session.platformSessionId)!.nativeSessionId === t.nativeId)!;
    const p1 = ta.sink.approval({ nativeRequestId: "r1", kind: "command", title: "运行命令", action: "rm -rf build", scope: "目录 x", source: "Codex", params: { command: "rm -rf build" } });
    const ap = mgr.pendingApprovals()[0]!;
    expect(mgr.store.binding(a.session.platformSessionId)!.status).toBe("waiting-input");
    expect(() => mgr.decideApproval(b.session.platformSessionId, ap.approvalId, { approve: true, paramsDigest: ap.paramsDigest, turnNo: 1 }, "t")).toThrow(/不属于/);
    expect(() => mgr.decideApproval(a.session.platformSessionId, ap.approvalId, { approve: true, paramsDigest: "bad", turnNo: 1 }, "t")).toThrow(/不匹配/);
    expect(() => mgr.decideApproval(a.session.platformSessionId, ap.approvalId, { approve: true, paramsDigest: ap.paramsDigest, turnNo: 2 }, "t")).toThrow(/不匹配/);
    mgr.decideApproval(a.session.platformSessionId, ap.approvalId, { approve: false, paramsDigest: ap.paramsDigest, turnNo: 1 }, "t");
    await expect(p1).resolves.toMatchObject({ approve: false });
    expect(() => mgr.decideApproval(a.session.platformSessionId, ap.approvalId, { approve: true, paramsDigest: ap.paramsDigest, turnNo: 1 }, "t")).toThrow(/已处理/);
    const p2 = ta.sink.approval({ nativeRequestId: "r2", kind: "command", title: "运行命令", action: "npm test", scope: "", source: "Codex", params: { command: "npm test" } });
    const ap2 = mgr.pendingApprovals()[0]!;
    mgr.decideApproval(a.session.platformSessionId, ap2.approvalId, { approve: true, paramsDigest: ap2.paramsDigest, turnNo: 1 }, "t");
    await expect(p2).resolves.toMatchObject({ approve: true });
    expect(mgr.store.binding(a.session.platformSessionId)!.status).toBe("running");
  });

  it("默认审批与问询等待人类，30 天后仍可处理，取消仍撤回请求", async () => {
    const a = await create(); await until(() => codex.turns.length === 1);
    const sid = a.session.platformSessionId, sink = codex.turns[0].sink;
    try {
      const cmd = sink.approval({nativeRequestId:"long-wait",kind:"command",title:"授权",action:"write",scope:"",source:"Pi",params:{}});
      const ap = mgr.pendingApprovals()[0]!;
      expect(ap.expiresAt).toBeUndefined();
      ap.createdAt = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      mgr.store.putApproval(ap);
      expect(mgr.pendingApprovals().some(x => x.approvalId === ap.approvalId)).toBe(true);
      mgr.decideApproval(sid, ap.approvalId, {approve:true,paramsDigest:ap.paramsDigest,turnNo:1}, "owner");
      expect(await cmd).toMatchObject({approve:true});
      const controller = new AbortController();
      const question = sink.approval({nativeRequestId:"long-question",kind:"question",title:"问询",action:"",scope:"",source:"Pi",params:{},questions:[{id:"q",question:"回答",options:[],allowOther:true,multiSelect:false}]}, controller.signal);
      expect(mgr.pendingApprovals()[0]!.expiresAt).toBeUndefined();
      const aged = mgr.pendingApprovals()[0]!;
      aged.createdAt = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      mgr.store.putApproval(aged);
      expect(mgr.pendingApprovals()).toHaveLength(1);
      controller.abort();
      expect(await question).toMatchObject({approve:false});
      expect(mgr.pendingApprovals()).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("过期按拒绝；runtime 撤回 → 失效；本轮结束 → 失效", async () => {
    mgr.shutdown();
    mgr = make({ approvalTtlMs: 40 });
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    const t = codex.turns[0]!;
    const p = t.sink.approval({ nativeRequestId: "r", kind: "command", title: "x", action: "x", scope: "", source: "s", params: 1 });
    await expect(p).resolves.toMatchObject({ approve: false });
    expect(mgr.store.allApprovals()[0]!.state).toBe("expired");
    const ac = new AbortController();
    const p2 = t.sink.approval({ nativeRequestId: "r2", kind: "command", title: "x", action: "x", scope: "", source: "s", params: 2 }, ac.signal);
    ac.abort();
    await expect(p2).resolves.toMatchObject({ approve: false });
    expect(mgr.store.allApprovals().find((a) => a.nativeRequestId === "r2")!.state).toBe("invalidated");
    void t.sink.approval({ nativeRequestId: "r3", kind: "command", title: "x", action: "x", scope: "", source: "s", params: 3 });
    t.finish({ status: "completed" });
    await until(() => mgr.store.allApprovals().find((a) => a.nativeRequestId === "r3")!.state === "invalidated");
    expect(mgr.store.binding(session.platformSessionId)!.status).toBe("idle");
  });
});

describe("并发、排队与停止（V28-08）", () => {
  it("每 profile 至多 2 个同时运行，第三个可见排队；停止只作用于目标", async () => {
    const a = await create();
    const b = await create();
    const c = await create();
    await until(() => codex.turns.length === 2);
    await tick(20);
    expect(codex.turns.length).toBe(2);
    expect(mgr.store.operation(c.session.creationOperationId)!.state).toBe("queued");
    expect(mgr.queuePosition(c.session.platformSessionId)).toBe(1);
    // Claude 的 profile 不受 Codex 满额影响
    await create("claude-code");
    await until(() => claude.turns.length === 1);
    const r = await mgr.interrupt(a.session.platformSessionId, "t");
    expect(r.noop).toBe(false);
    expect(mgr.store.binding(a.session.platformSessionId)!.status).toBe("stopping");
    await until(() => mgr.store.binding(a.session.platformSessionId)!.status === "idle");
    const ta = mgr.store.binding(a.session.platformSessionId)!.turns[0]!;
    expect(ta.status).toBe("cancelled");
    expect(codex.turns[0]!.interrupted).toBe(true);
    expect(codex.turns[1]!.interrupted).toBe(false);
    expect(mgr.store.binding(b.session.platformSessionId)!.status).toBe("running");
    // 空位释放后排队的开始执行
    await until(() => codex.turns.length === 3);
    // 已结束的再停止：无副作用
    const again = await mgr.interrupt(a.session.platformSessionId, "t");
    expect(again.noop).toBe(true);
  });

  it("运行中不允许再提交普通 turn；只读历史不能写", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    const rev = mgr.store.binding(session.platformSessionId)!.bindingRevision;
    await expect(mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "x", expectedRevision: rev }, "t")).rejects.toMatchObject({ code: "RT_BUSY" });
  });
});

describe("外部写入冲突（V28-24）", () => {
  it("原生指纹变化 → 暂停写入转只读；核对后显式恢复", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    const t = codex.turns[0]!;
    codex.fingerprints.set(t.nativeId, "v1");
    t.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.nativeFingerprint?.value === "v1", 4000);
    codex.fingerprints.set(t.nativeId, "v2-cli");
    const rev = mgr.store.binding(session.platformSessionId)!.bindingRevision;
    await expect(mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "继续", expectedRevision: rev }, "t")).rejects.toMatchObject({ code: "RT_EXTERNAL_WRITE" });
    const b = mgr.store.binding(session.platformSessionId)!;
    expect(b.conflict).toBeDefined();
    expect(mgr.sessionView(session.platformSessionId).readOnly).toBe(true);
    await expect(mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "继续", expectedRevision: b.bindingRevision }, "t")).rejects.toMatchObject({ code: "RT_EXTERNAL_WRITE" });
    const resumed = await mgr.resumeWrites(session.platformSessionId, mgr.store.binding(session.platformSessionId)!.bindingRevision, "t");
    expect(resumed.conflict).toBeUndefined();
    await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "继续", expectedRevision: resumed.bindingRevision }, "t");
    await until(() => codex.turns.length === 2);
    expect(codex.turns[1]!.args.nativeSessionId).toBe(t.nativeId);
  }, 10_000);

  it("无法核对原生状态时维持只读", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    codex.fingerprint = async () => undefined;
    await expect(mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "x", expectedRevision: mgr.store.binding(session.platformSessionId)!.bindingRevision }, "t")).rejects.toMatchObject({ code: "RT_UNVERIFIED" });
  });

  it("流式事件到达不改版本号：基于当前画面的续聊不会误冲突", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    const t = codex.turns[0]!;
    t.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    const rev = mgr.store.binding(session.platformSessionId)!.bindingRevision;
    await tick(1700); // 指纹记录在结束后 1.5 秒
    expect(mgr.store.binding(session.platformSessionId)!.bindingRevision).toBe(rev);
  }, 5000);

  it("目录项带最后一轮的轮次号与状态（页面据此算未读）", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    const entry = async () => (await mgr.directory({ source: "chat", includeHistory: false })).entries.find((e) => e.id === session.platformSessionId)!;
    expect((await entry()).latestTurn).toMatchObject({ turnNo: 1, status: "running", startedAt: expect.any(String) });
    expect((await entry()).lastTurnEndedAt).toBeUndefined();
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    const done = (await entry()).latestTurn!;
    expect(done).toMatchObject({ turnNo: 1, status: "completed" });
    expect(typeof done.endedAt).toBe("string");
    expect((await entry()).lastTurnEndedAt).toBe(done.endedAt);
    await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "继续", expectedRevision: mgr.store.binding(session.platformSessionId)!.bindingRevision }, "t");
    await until(() => codex.turns.length === 2);
    expect((await entry()).latestTurn).toMatchObject({ turnNo: 2, status: "running", startedAt: expect.any(String) });
    expect((await entry()).lastTurnEndedAt).toBe(done.endedAt);
    codex.turns[1]!.finish({ status: "failed", reason: "test failure" });
    await until(() => mgr.store.binding(session.platformSessionId)!.turns[1]!.status === "failed");
    expect((await entry()).lastTurnEndedAt).toBe((await entry()).latestTurn!.endedAt);
  });

  it("目录在轮次开始和结束时更新排序，流式事件不改变顺序", async () => {
    const a = await create("codex", "先结束");
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(a.session.platformSessionId)!.status === "idle");
    await tick(5);
    const b = await create("codex", "后结束");
    await until(() => codex.turns.length === 2);
    codex.turns[1]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(b.session.platformSessionId)!.status === "idle");
    const endedA = mgr.store.binding(a.session.platformSessionId)!.turns[0]!.endedAt!;
    const endedB = mgr.store.binding(b.session.platformSessionId)!.turns[0]!.endedAt!;
    expect(Date.parse(endedB)).toBeGreaterThan(Date.parse(endedA));
    // A 开始新一轮后置顶；B 的流式活动不能改变轮次排序。
    await mgr.sendTurn(a.session.platformSessionId, { idempotencyKey: key(), prompt: "继续", expectedRevision: mgr.store.binding(a.session.platformSessionId)!.bindingRevision }, "t");
    await until(() => codex.turns.length === 3);
    await tick(5);
    mgr.store.updateBinding(b.session.platformSessionId, x => { x.lastActivityAt = { at: new Date().toISOString(), source: "runtime" }; });
    const d = await mgr.directory({ source: "chat", includeHistory: false });
    expect(d.entries.map((e) => e.id)).toEqual([a.session.platformSessionId, b.session.platformSessionId]);
    expect(d.entries[0]!.lastTurnEndedAt).toBe(endedA);
    expect(d.entries[1]!.lastTurnEndedAt).toBe(endedB);
    await mgr.sendTurn(b.session.platformSessionId, { idempotencyKey: key(), prompt: "继续 B", expectedRevision: mgr.store.binding(b.session.platformSessionId)!.bindingRevision }, "t");
    await until(() => codex.turns.length === 4);
    expect((await mgr.directory({ source: "chat", includeHistory: false })).entries.map(e => e.id)).toEqual([b.session.platformSessionId, a.session.platformSessionId]);
    await tick(5);
    codex.turns[2]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(a.session.platformSessionId)!.status === "idle");
    expect((await mgr.directory({ source: "chat", includeHistory: false })).entries.map(e => e.id)).toEqual([a.session.platformSessionId, b.session.platformSessionId]);
    codex.turns[3]!.finish({ status: "completed" });
  });
});

describe("部署排空（V28-23）", () => {
  it("finishes already accepted capacity-queued operations while deployment admission is sealed", async () => {
    await create(); await create(); await create();
    await until(() => codex.turns.length === 2);
    mgr.setDraining(true, true);
    await expect(create()).rejects.toMatchObject({ code: "RT_DRAINING" });
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => codex.turns.length === 3);
    expect(codex.turns.every(t => !t.interrupted)).toBe(true);
    codex.turns[1]!.finish({ status: "completed" }); codex.turns[2]!.finish({ status: "completed" });
    await until(() => mgr.activity().active.length === 0);
    expect(mgr.activity()).toMatchObject({ draining: true, queued: 0, dispatching: 0, unknownOps: 0 });
  });

  it("排空后拒绝新创建/续聊、排队不启动；强制停止列出受影响会话并失效审批", async () => {
    const a = await create();
    await create();
    const c = await create();
    await until(() => codex.turns.length === 2);
    void codex.turns[0]!.sink.approval({ nativeRequestId: "r", kind: "command", title: "x", action: "x", scope: "", source: "s", params: 1 });
    mgr.setDraining(true);
    await expect(create()).rejects.toMatchObject({ code: "RT_DRAINING" });
    const act = mgr.activity();
    expect(act.draining).toBe(true);
    expect(act.active.length).toBeGreaterThanOrEqual(3);
    expect(act.active.every((x) => typeof x.workspace === "string" && x.workspace.length > 0)).toBe(true);
    expect(act.pendingApprovals).toBe(1);
    expect(act.queued).toBe(1);
    // 排空中：空出位置也不启动排队的
    codex.turns[1]!.finish({ status: "completed" });
    await tick(30);
    expect(codex.turns.length).toBe(2);
    const r = await mgr.forceStop("强制部署", "deploy");
    expect(r.affected).toContain(a.session.platformSessionId);
    expect(r.affected).toContain(c.session.platformSessionId);
    expect(mgr.pendingApprovals()).toHaveLength(0);
    expect(mgr.store.binding(a.session.platformSessionId)!.status).toBe("unknown");
    expect(mgr.store.binding(c.session.platformSessionId)!.turns[0]!.status).toBe("cancelled");
  });
});

describe("重启核对（方案 A，V28-04/09）", () => {
  it("运行中的 turn → interrupted 并补读；排队的不重发；审批失效", async () => {
    const a = await create();
    await create();
    const c = await create();
    await until(() => codex.turns.length === 2);
    void codex.turns[0]!.sink.approval({ nativeRequestId: "r", kind: "command", title: "x", action: "x", scope: "", source: "s", params: 1 });
    const native = codex.turns[0]!.nativeId;
    codex.reads.set(native, { events: [ev("codex:item:h1", "历史里的回答", { source: "history" })], usage: [], status: "idle", coverage: "complete", notes: [] });
    // 模拟进程被杀：不经过 shutdown 的正常结束
    const codex2 = new FakeDriver("codex");
    codex2.reads = codex.reads;
    const startsBefore = codex.startCalls;
    const again = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: codex2, "claude-code": claude } });
    await again.recovered;
    const ba = again.store.binding(a.session.platformSessionId)!;
    expect(ba.status).toBe("unknown");
    expect(ba.turns[0]!.status).toBe("unknown");
    expect(again.store.events(a.session.platformSessionId).some((e) => e.key === "codex:item:h1")).toBe(true);
    const bc = again.store.binding(c.session.platformSessionId)!;
    expect(bc.turns[0]!.status).toBe("cancelled");
    expect(bc.status).toBe("failed");
    expect(again.store.allApprovals().every((x) => x.state !== "pending")).toBe(true);
    await tick(30);
    expect(codex2.startCalls).toBe(0);
    expect(codex.startCalls).toBe(startsBefore);
    // 平台结束推断不是原生结束证据：可提交续聊，但未知占用仍阻止发送。
    await again.probe("codex");
    await again.sendTurn(a.session.platformSessionId, { idempotencyKey: key(), prompt: "继续", expectedRevision: again.store.binding(a.session.platformSessionId)!.bindingRevision }, "t");
    await tick(150);
    expect(codex2.startCalls).toBe(0);
    expect(again.store.binding(a.session.platformSessionId)!.turns.at(-1)!.status).toBe("queued");
    again.shutdown();
  });

  it("Claude 预分配 ID：重启时核对首条消息是否送达，未送达标 failed，无法核对标 unknown", async () => {
    // 让派发卡在启动前：不调用 nativeSession 就"崩溃"
    claude.startTurn = () => new Promise(() => {});
    const a = await create("claude-code");
    const b = await create("claude-code");
    await until(() => mgr.store.operation(a.session.creationOperationId)!.state === "dispatching" && mgr.store.operation(b.session.creationOperationId)!.state === "dispatching");
    const preA = mgr.store.operation(a.session.creationOperationId)!.presetNativeId!;
    const preB = mgr.store.operation(b.session.creationOperationId)!.presetNativeId!;
    expect(preA).toMatch(/^[0-9a-f-]{36}$/);
    const claude2 = new FakeDriver("claude-code");
    claude2.delivered.set(`${preA}|${mgr.store.binding(a.session.platformSessionId)!.turns[0]!.clientMessageId}`, false);
    claude2.delivered.set(`${preB}|${mgr.store.binding(b.session.platformSessionId)!.turns[0]!.clientMessageId}`, undefined);
    const again = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex, "claude-code": claude2 } });
    await again.recovered;
    expect(again.store.binding(a.session.platformSessionId)!.status).toBe("failed");
    expect(again.store.binding(a.session.platformSessionId)!.nativeSessionId).toBeUndefined();
    const bb = again.store.binding(b.session.platformSessionId)!;
    expect(bb.turns[0]!.status).toBe("unknown");
    again.shutdown();
  });
});

describe("历史只读、授权与合并（V28-10/11/18）", () => {
  it("未授权不列；授权后列出；与受管会话同一原生 ID 合并；撤销后清理", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    const native = codex.turns[0]!.nativeId;
    const other = join(dir, "elsewhere");
    mkdirSync(other);
    codex.history = [
      { nativeSessionId: native, title: "同一个", workspace: ws, sourceLabel: "fake", status: "unknown", updatedAt: "2026-01-01T00:00:00Z" },
      { nativeSessionId: "h-2", title: "外部历史", workspace: ws, sourceLabel: "fake", status: "unknown", updatedAt: "2026-01-02T00:00:00Z" },
      { nativeSessionId: "h-3", title: "授权外", workspace: other, sourceLabel: "fake", status: "unknown", updatedAt: "2026-01-03T00:00:00Z" }
    ];
    codex.reads.set("h-2", { events: [ev("codex:item:x", "旧回答", { source: "history" })], usage: [], status: "unknown", coverage: "complete", notes: [] });
    let d = await mgr.directory();
    expect(d.entries.filter((e) => e.sourceMode === "external-discovered")).toHaveLength(0);
    mgr.updateSettings({ history: { codex: { enabled: true, roots: [join(dir, "work")] }, "claude-code": { enabled: false, roots: [] } } }, "t");
    d = await mgr.directory();
    const disc = d.entries.filter((e) => e.sourceMode === "external-discovered");
    expect(disc.map((e) => e.nativeSessionId)).toEqual(["h-2"]);
    expect(d.entries.filter((e) => e.nativeSessionId === native)).toHaveLength(1);
    expect(d.entries.find((e) => e.nativeSessionId === native)!.id).toBe(session.platformSessionId);
    const h2 = disc[0]!;
    expect(h2.accountKnown).toBe(false);
    expect(h2.identityScopeId).toMatch(/^hist1:/);
    const msgs = await mgr.messages(h2.id, {});
    expect(msgs.events[0]!.text).toBe("旧回答");
    const view = mgr.sessionView(h2.id);
    expect(view.readOnly).toBe(true);
    await expect(mgr.sendTurn(h2.id, { idempotencyKey: key(), prompt: "x", expectedRevision: 0 }, "t")).rejects.toMatchObject({ code: "RT_READ_ONLY" });
    await expect(mgr.interrupt(h2.id, "t")).rejects.toMatchObject({ code: "RT_READ_ONLY" });
    expect(codex.startCalls).toBe(1); // 查看历史不 resume、不调用模型
    // 撤销：停止读取，旧 ID 失效
    mgr.updateSettings({ history: { codex: { enabled: false, roots: [] }, "claude-code": { enabled: false, roots: [] } } }, "t");
    await expect(mgr.messages(h2.id, {})).rejects.toMatchObject({ code: "RT_NOT_FOUND" });
    d = await mgr.directory();
    expect(d.entries.filter((e) => e.sourceMode === "external-discovered")).toHaveLength(0);
  });

  it("分页：默认最新一页，before 游标向前，after 用于断线续传", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    for (let i = 0; i < 250; i++) codex.turns[0]!.sink.event(ev(`codex:item:${i}`, `m${i}`));
    const page = await mgr.messages(session.platformSessionId, { limit: 100 });
    expect(page.events).toHaveLength(100);
    expect(page.hasMoreBefore).toBe(true);
    expect(page.hasMoreAfter).toBe(false);
    expect(page.events[99]!.text).toBe("m249");
    const prev = await mgr.messages(session.platformSessionId, { limit: 100, before: page.firstSeq! });
    expect(prev.events[99]!.seq).toBe(page.firstSeq! - 1);
    expect(prev.hasMoreAfter).toBe(true);
    const after = await mgr.messages(session.platformSessionId, { after: page.lastSeq! - 3 });
    expect(after.events).toHaveLength(3);
    expect(after.hasMoreAfter).toBe(false);
  });
});

describe("身份分区（V28-11）", () => {
  it("稳定账号 ID 可重现；无稳定 ID 用持久分区，指纹变化换新分区", async () => {
    const c1 = mgr.profile("codex")!.identity!;
    expect(c1.derivation).toBe("stable-account-id");
    await mgr.probe("codex");
    expect(mgr.profile("codex")!.identity!.identityScopeId).toBe(c1.identityScopeId);
    const k1 = mgr.profile("claude-code")!.identity!;
    expect(k1.derivation).toBe("persistent-partition");
    expect(k1.accountKnown).toBe(false);
    await mgr.probe("claude-code");
    expect(mgr.profile("claude-code")!.identity!.identityScopeId).toBe(k1.identityScopeId);
    claude.identityFingerprint = "other-account";
    await mgr.probe("claude-code");
    expect(mgr.profile("claude-code")!.identity!.identityScopeId).not.toBe(k1.identityScopeId);
  });

  it("failed and logged-out probes preserve the account partition; recovery resumes existing sessions", async () => {
    const original = mgr.profile("claude-code")!.identity!;
    const partition = mgr.store.identityPartitions()[mgr.profileId("claude-code")];
    const { session } = await create("claude-code");
    await until(() => claude.turns.length === 1);
    claude.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    await mgr.refreshRateLimit("claude-code");
    const quota = mgr.store.rateLimits()[original.identityScopeId];
    const fingerprint = claude.identityFingerprint;
    for (const state of ["needs-login", "error"] as const) {
      claude.probeState = state;
      claude.identityFingerprint = "firstParty|||none";
      expect((await mgr.probe("claude-code")).identity).toEqual(original);
      expect(mgr.store.identityPartitions()[mgr.profileId("claude-code")]).toEqual(partition);
      expect(mgr.store.rateLimits()[original.identityScopeId]).toEqual(quota);
      await expect(create("claude-code")).rejects.toMatchObject({ code: "RT_PROFILE" });
      await expect(mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "blocked", expectedRevision: mgr.store.binding(session.platformSessionId)!.bindingRevision }, "test")).rejects.toMatchObject({ code: "RT_PROFILE" });
    }
    claude.probeState = "executable";
    claude.identityFingerprint = fingerprint;
    expect((await mgr.probe("claude-code")).identity).toEqual(original);
    await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "resume", expectedRevision: mgr.store.binding(session.platformSessionId)!.bindingRevision }, "test");
    await until(() => claude.turns.length === 2);
    expect(claude.turns[1]!.args.nativeSessionId).toBe(claude.turns[0]!.nativeId);
    claude.turns[1]!.finish({ status: "completed" });
  });

  it("an unauthenticated first probe allocates no partition or quota", async () => {
    const fresh = new RuntimeSessionManager({ dataDir: join(dir, "fresh"), drivers: { "claude-code": claude }, skipRecovery: true });
    try {
      claude.probeState = "needs-login";
      const p = await fresh.probe("claude-code");
      expect(p.identity).toBeUndefined();
      expect(fresh.store.identityPartitions()).toEqual({});
      expect(fresh.store.rateLimits()).toEqual({});
    } finally { fresh.shutdown(); }
  });

  it("账号切换后续聊被拒绝（不串账号）", async () => {
    const { session } = await create("claude-code");
    await until(() => claude.turns.length === 1);
    claude.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    claude.identityFingerprint = "someone-else";
    await mgr.probe("claude-code");
    await expect(mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "x", expectedRevision: mgr.store.binding(session.platformSessionId)!.bindingRevision }, "t")).rejects.toMatchObject({ code: "RT_IDENTITY" });
  });
});

describe("规模（V28-16 的数据层部分）", () => {
  it("1000 会话目录分页与单会话 20000 事件读取在预算内", async () => {
    const kinds: RuntimeKind[] = ["codex", "claude-code"];
    for (let i = 0; i < 1000; i++) {
      const k = kinds[i % 2]!;
      mgr.store.putBinding({
        platformSessionId: `rt-fixture${String(i).padStart(6, "0")}`, runtimeKind: k, runtimeProfileId: mgr.profileId(k), hostId: mgr.store.host.hostId,
        identityScopeId: "id1:x", nativeSessionId: `n-${i}`, sourceMode: "platform-managed", executionMode: "runtime-native", title: `会话 ${i}`,
        workspace: ws, permissionLabel: "p", createdAt: { at: new Date(i * 1000).toISOString(), source: "platform" }, lastActivityAt: { at: new Date(i * 1000).toISOString(), source: "platform" },
        bindingRevision: 1, creationOperationId: "op", status: "idle", observation: "live", turns: [], coverage: "complete"
      });
    }
    const big = "rt-fixture000001";
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) mgr.store.upsertEvent(big, { key: `k${i}`, kind: i % 3 ? "message" : "tool", text: `事件 ${i}`, source: "history", parserVersion: "f", availability: "recorded", recordedAt: "x" });
    const writeMs = performance.now() - t0;
    const fresh = make();
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const s = performance.now();
      const d = await fresh.directory({ limit: 50, includeHistory: false });
      expect(d.entries).toHaveLength(50);
      const m = await fresh.messages(big, { limit: 100 });
      expect(m.events).toHaveLength(100);
      expect(m.total).toBe(20000);
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    expect(p95).toBeLessThan(200);
    expect(writeMs).toBeLessThan(20000);
    fresh.shutdown();
  }, 60_000);
});

describe("回补顺序与认证失败（V28-06/09/15）", () => {
  it("重启后补读的事件按原生顺序插在已知事件之间，turn 结束记录与历史同 key 不重复", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    const t = codex.turns[0]!;
    t.sink.event(ev("codex:item:a", "第一条"));
    t.sink.event(ev("codex:item:c", "第三条"));
    t.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    // 原生历史里有平台漏掉的一条（b），以及同一 turn 的结束记录
    codex.reads.set(t.nativeId, { events: [
      ev("codex:item:a", "第一条", { source: "history" }), ev("codex:item:b", "第二条（漏掉的）", { source: "history" }), ev("codex:item:c", "第三条", { source: "history" }),
      { key: `turn:${t.turnId}`, kind: "turn-status", status: "completed", text: "本轮完成", source: "history", parserVersion: "f", availability: "recorded" }
    ], usage: [], status: "idle", coverage: "complete", notes: [] });
    const r = await mgr.backfill(session.platformSessionId);
    expect(r.added).toBe(1);
    const texts = mgr.store.events(session.platformSessionId).filter((e) => e.kind === "message" && e.role === "assistant").map((e) => e.text);
    expect(texts).toEqual(["第一条", "第二条（漏掉的）", "第三条"]);
    expect(mgr.store.events(session.platformSessionId).filter((e) => e.kind === "turn-status")).toHaveLength(1);
    // 落盘后重新加载，顺序不变
    mgr.shutdown();
    const again = make();
    expect(again.store.events(session.platformSessionId).filter((e) => e.kind === "message" && e.role === "assistant").map((e) => e.text)).toEqual(["第一条", "第二条（漏掉的）", "第三条"]);
    again.shutdown();
  });

  it("an ordinary probe automatically clears a prior Claude failure after live authentication", async () => {
    const { session } = await create("claude-code");
    await until(() => claude.turns.length === 1);
    claude.turns[0]!.finish({ status: "failed", reason: "Failed to authenticate. API Error: 403 Request not allowed" });
    await until(() => mgr.profile("claude-code")!.state === "needs-login");
    const probe = await claude.probe();
    vi.spyOn(claude, "probe").mockResolvedValue({ ...probe, authVerified: true });
    const recovered = await mgr.probe("claude-code");
    expect(recovered.state).toBe("executable");
    expect(recovered.lastAuthFailure).toBeUndefined();
    mgr.shutdown(); mgr = make();
    expect(mgr.profile("claude-code")!.state).toBe("executable");
    expect(mgr.profile("claude-code")!.lastAuthFailure).toBeUndefined();
    expect(mgr.store.binding(session.platformSessionId)!.turns.at(-1)!.status).toBe("failed");
  });

  it("a successful probe cannot erase an auth failure recorded while that probe was in flight", async () => {
    await create("claude-code");
    await until(() => claude.turns.length === 1);
    const probe = await claude.probe();
    let resolve!: (p: typeof probe) => void;
    vi.spyOn(claude, "probe").mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = mgr.probe("claude-code", { reloggedIn: true });
    claude.turns[0]!.finish({ status: "failed", reason: "Failed to authenticate. API Error: 403 Request not allowed" });
    await until(() => mgr.profile("claude-code")!.state === "needs-login");
    resolve({ ...probe, authVerified: true });
    const result = await pending;
    expect(result.state).toBe("needs-login");
    expect(result.lastAuthFailure).toBeDefined();
  });

  it("cached identity cannot clear a Claude auth failure, even after manual confirmation", async () => {
    const { session } = await create("claude-code");
    await until(() => claude.turns.length === 1);
    claude.turns[0]!.finish({ status: "failed", reason: "Failed to authenticate. API Error: 401 OAuth access token has expired." });
    await until(() => mgr.profile("claude-code")!.state === "needs-login");
    expect(mgr.profile("claude-code")!.lastAuthFailure!.platformSessionId).toBe(session.platformSessionId);
    await expect(mgr.create({ idempotencyKey: key(), runtimeKind: "claude-code", workspace: ws, prompt: "x", confirmedProfileVersion: mgr.profile("claude-code")!.checkedAt }, "t")).rejects.toMatchObject({ code: "RT_PROFILE" });
    await mgr.probe("claude-code");
    expect(mgr.profile("claude-code")!.state).toBe("needs-login");
    await mgr.probe("claude-code", { reloggedIn: true });
    expect(mgr.profile("claude-code")!.state).toBe("needs-login");
    expect(mgr.profile("claude-code")!.lastAuthFailure).toBeDefined();
  });
});

describe("只读历史的直接打开", () => {
  it("服务重启后直接打开历史会话地址：在授权范围内重新列出后可读", async () => {
    mgr.updateSettings({ history: { codex: { enabled: true, roots: [join(dir, "work")] }, "claude-code": { enabled: false, roots: [] } } }, "t");
    codex.history = [{ nativeSessionId: "h-9", title: "历史", workspace: ws, sourceLabel: "fake", status: "unknown", updatedAt: "2026-01-01T00:00:00Z" }];
    codex.reads.set("h-9", { events: [ev("codex:item:z", "旧内容", { source: "history" })], usage: [], status: "unknown", coverage: "complete", notes: [] });
    const id = (await mgr.directory()).entries.find((e) => e.nativeSessionId === "h-9")!.id;
    mgr.shutdown();
    mgr = make();
    expect((await mgr.view(id)).readOnly).toBe(true);
    expect((await mgr.messages(id, {})).events[0]!.text).toBe("旧内容");
    await expect(mgr.view("rx-0000000000000000")).rejects.toMatchObject({ code: "RT_NOT_FOUND" });
  });
});

describe("推理强度", () => {
  it("只接受模型报告的值；创建与续聊都传给 runtime；续聊不给就沿用", async () => {
    await expect(create("codex", "x", { effort: "ultra" })).rejects.toMatchObject({ code: "RT_INPUT" });
    await expect(create("codex", "x", { model: "m-2", effort: "low" })).rejects.toMatchObject({ code: "RT_INPUT" });
    const { session } = await create("codex", "x", { effort: "high" });
    await until(() => codex.turns.length === 1);
    expect(codex.turns[0]!.args.effort).toBe("high");
    expect(mgr.store.binding(session.platformSessionId)!.requestedEffort).toBe("high");
    expect(mgr.sessionView(session.platformSessionId).effortOptions).toEqual({ efforts: ["low", "medium", "high"], defaultEffort: "low" });
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    const rev = () => mgr.store.binding(session.platformSessionId)!.bindingRevision;
    await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "a", expectedRevision: rev() }, "t");
    await until(() => codex.turns.length === 2);
    expect(codex.turns[1]!.args.effort).toBe("high");
    codex.turns[1]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "b", expectedRevision: rev(), effort: "medium" }, "t");
    await until(() => codex.turns.length === 3);
    expect(codex.turns[2]!.args.effort).toBe("medium");
    expect(mgr.store.binding(session.platformSessionId)!.turns.map((t) => t.effort)).toEqual(["high", "high", "medium"]);
  });
});

describe("推理强度：实际模型与目录 ID 不同", () => {
  it("Claude 式别名：按请求的目录 ID 找到可选强度，续聊可以调整（此前选择器不显示、提交也被拒）", async () => {
    claude.effectiveModelOverride = "full-model-1-20261001";
    const { session } = await create("claude-code", "x", { model: "m-1", effort: "low" });
    await until(() => claude.turns.length === 1);
    await until(() => mgr.store.binding(session.platformSessionId)!.effectiveModel === "full-model-1-20261001");
    expect(mgr.sessionView(session.platformSessionId).effortOptions).toEqual({ efforts: ["low", "medium", "high"], defaultEffort: "low" });
    claude.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "再想深一点", expectedRevision: mgr.store.binding(session.platformSessionId)!.bindingRevision, effort: "high" }, "t");
    await until(() => claude.turns.length === 2);
    expect(claude.turns[1]!.args.effort).toBe("high");
    claude.turns[1]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    // 不在该模型可选范围内的强度照样拒绝
    await expect(mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "x", expectedRevision: mgr.store.binding(session.platformSessionId)!.bindingRevision, effort: "ultra" }, "t")).rejects.toMatchObject({ code: "RT_INPUT" });
  });
  it("没指定模型（runtime 默认）且实际模型不在目录里：按默认模型给强度；指定了不支持强度的模型则不给", async () => {
    claude.effectiveModelOverride = "full-default-model";
    const a = await create("claude-code", "x");
    await until(() => claude.turns.length === 1);
    await until(() => mgr.store.binding(a.session.platformSessionId)!.effectiveModel === "full-default-model");
    expect(mgr.sessionView(a.session.platformSessionId).effortOptions?.efforts).toEqual(["low", "medium", "high"]);
    claude.turns[0]!.finish({ status: "completed" });
    const b = await create("claude-code", "y", { model: "m-2" });
    await until(() => claude.turns.length === 2);
    await until(() => mgr.store.binding(b.session.platformSessionId)!.effectiveModel === "full-default-model");
    expect(mgr.sessionView(b.session.platformSessionId).effortOptions).toBeUndefined();
    claude.turns[1]!.finish({ status: "completed" });
  });
});

describe("迟到的状态信号", () => {
  it("本轮结束后 runtime 再报 running，不把会话改回运行中", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    const t = codex.turns[0]!;
    t.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    t.sink.status("running");
    t.sink.status("waiting-input");
    expect(mgr.store.binding(session.platformSessionId)!.status).toBe("idle");
  });
});

describe("重启核对：停在运行中但没有进行中的一轮", () => {
  it("改回空闲，不伪造新的一轮", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    mgr.store.updateBinding(session.platformSessionId, (x) => { x.status = "running"; });
    mgr.shutdown();
    const again = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex, "claude-code": claude } });
    await again.recovered;
    const b = again.store.binding(session.platformSessionId)!;
    expect(b.status).toBe("idle");
    expect(b.turns).toHaveLength(1);
    again.shutdown();
  });
});

describe("额度不足（V28-15）", () => {
  it("记在 profile 上提示但不阻止创建；不自动换模型或 runtime；之后一轮成功即清除，重新探测不丢", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "failed", reason: "You’ve hit your usage limit.", code: "usageLimitExceeded" });
    await until(() => !!mgr.profile("codex")!.lastQuotaFailure);
    const p = mgr.profile("codex")!;
    expect(p.state).toBe("executable");
    expect(p.lastQuotaFailure).toMatchObject({ code: "usageLimitExceeded", platformSessionId: session.platformSessionId });
    const limited = mgr.store.binding(session.platformSessionId)!;
    // 额度 / 限流会重置，不是普通的运行失败：会话与本轮都标成被中断，列表据此显示「被中断」
    expect(limited.status).toBe("interrupted");
    expect(limited.turns[0]).toMatchObject({ status: "interrupted", statusReason: expect.stringContaining("usage limit") });
    expect(limited.statusReason).toContain("usage limit");
    await mgr.probe("codex");
    expect(mgr.profile("codex")!.lastQuotaFailure).toBeDefined();
    const b = await create();
    await until(() => codex.turns.length === 2);
    expect(codex.turns[1]!.args.model).toBeUndefined();
    codex.turns[1]!.finish({ status: "completed" });
    await until(() => !mgr.profile("codex")!.lastQuotaFailure);
    expect(b.session.runtimeKind).toBe("codex");
  });

  it("升级前已记录为空闲的额度失败：重启后改为被中断，列表能显示中断标签", async () => {
    const { session } = await create();
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "failed", reason: "You’ve hit your usage limit." });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "interrupted");
    // 模拟旧版本写入的记录：会话空闲、本轮失败
    mgr.store.updateBinding(session.platformSessionId, (x) => {
      x.status = "idle";
      x.statusReason = "本轮失败：You’ve hit your usage limit.";
      x.turns[0]!.status = "failed";
      x.turns[0]!.statusReason = "You’ve hit your usage limit.";
    });
    mgr.shutdown();
    const again = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex, "claude-code": claude } });
    await again.recovered;
    try {
      const b = again.store.binding(session.platformSessionId)!;
      expect(b.status).toBe("interrupted");
      expect(b.turns[0]!.status).toBe("interrupted");
      expect(b.statusReason).toContain("usage limit");
      expect((await again.directory({ source: "chat" })).entries.find((e) => e.id === session.platformSessionId)).toMatchObject({ status: "interrupted" });
    } finally { again.shutdown(); }
  });
});

describe("用量汇总与终端续聊命令（P1）", () => {
  it("Pi 请求时间与归档小时桶都计入当天，跨日请求不因采样时间归到今天", async () => {
    const { session } = await create("codex");
    await until(() => codex.turns.length === 1);
    const id = session.platformSessionId;
    mgr.store.updateBinding(id, b => { b.runtimeKind = "pi"; });
    const now = Date.now(), old = now - 3 * 86400000;
    const row = (at: number, input: number) => ({
      usageScope: "request" as const, counterMode: "delta" as const,
      raw: {}, input, output: 3, requestId: `pi:s:assistant:${at}`,
      semantics: "pi", sourceRef: "pi", sampledAt: new Date(now).toISOString(), reliability: "partial" as const
    });
    mgr.store.addUsage(id, row(now, 10));
    mgr.store.addUsage(id, row(old, 100));
    mgr.store.addUsage(id, { ...row(now + 1, 20), requestId: "aggregate",
      aggregate: { hour: new Date(Math.floor(now / 3600000) * 3600000).toISOString(), calls: 2, folded: [] } });
    const u = mgr.usageSummary({ days: 1, timeZone: "UTC" });
    expect(u.days).toHaveLength(1);
    expect(u.days[0]!.byRuntime.pi).toEqual({ input: 30, output: 6, requests: 3 });
    expect(u.unattributed).toEqual([]);
  });

  it("Claude 按请求时间分日；Codex 只有累计值单列；命令按工作目录与验证过的路径生成", async () => {
    const a = await create("claude-code");
    const c = await create("codex");
    await until(() => claude.turns.length === 1 && codex.turns.length === 1);
    const now = new Date().toISOString();
    claude.turns[0]!.sink.usage({ usageScope: "request", counterMode: "delta", raw: {}, input: 10, cachedInput: 100, cacheCreation: 5, output: 7, requestId: "m1", semantics: "c", sourceRef: "m1", sampledAt: now, occurredAt: now, reliability: "complete" });
    claude.turns[0]!.sink.usage({ usageScope: "request", counterMode: "delta", raw: {}, input: 10, output: 7, requestId: "m1", semantics: "c", sourceRef: "m1", sampledAt: now, occurredAt: now, reliability: "complete" });
    codex.turns[0]!.sink.usage({ usageScope: "session", counterMode: "cumulative", raw: {}, input: 900, output: 100, total: 1000, semantics: "x", sourceRef: "codex:thread/tokenUsage/updated", sampledAt: now, reliability: "complete" });
    const u = mgr.usageSummary({ days: 14, timeZone: "UTC" });
    expect(u.days).toHaveLength(1);
    expect(u.days[0]!.byRuntime["claude-code"]).toEqual({ input: 10, output: 7, requests: 1 });
    expect(u.days[0]!.byRuntime["codex"]).toBeUndefined();
    expect(u.unattributed).toEqual([{ runtimeKind: "codex", sessions: 1, total: 1000, input: 900, output: 100 }]);
    const { resumeCommand } = await import("../src/manager.js");
    expect(resumeCommand("codex", "t-1", "/a b/it's", "/Apps/codex")).toBe(`cd '/a b/it'\\''s' && '/Apps/codex' resume t-1`);
    expect(resumeCommand("claude-code", "s-1", "/w")).toBe(`cd '/w' && claude --resume s-1`);
    expect(mgr.sessionView(a.session.platformSessionId).resumeCommand).toContain("claude --resume");
    expect(mgr.sessionView(c.session.platformSessionId).resumeCommand).toMatch(/resume native-/);
  });

  it("Codex 续聊把已持久化的请求数基数带给驱动", async () => {
    const { session } = await create("codex");
    await until(() => codex.turns.length === 1);
    const now = new Date().toISOString();
    codex.turns[0]!.sink.usage({ usageScope: "session", counterMode: "cumulative", raw: {}, input: 100, output: 10, total: 110, requestCount: 7, semantics: "x", sourceRef: "codex:thread/tokenUsage/updated", sampledAt: now, reliability: "complete" });
    expect(mgr.sessionView(session.platformSessionId).usage.requestCount).toBe(7);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.sessionView(session.platformSessionId).session.status === "idle");
    await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "接着聊", expectedRevision: mgr.store.binding(session.platformSessionId)!.bindingRevision }, "t");
    await until(() => codex.turns.length === 2);
    expect(codex.turns[1]!.args.priorRequestCount).toBe(7);
  });
});

describe("历史创建方授权", () => {
  it("设置里的创建方传给 runtime；改窄后旧条目不再可读", async () => {
    codex.history = [
      { nativeSessionId: "d-1", title: "桌面", workspace: ws, originator: "Codex Desktop", sourceLabel: "f", status: "unknown", updatedAt: "2026-01-01T00:00:00Z" },
      { nativeSessionId: "c-1", title: "其他", workspace: ws, originator: "codex_cli_rs", sourceLabel: "f", status: "unknown", updatedAt: "2026-01-02T00:00:00Z" }
    ];
    mgr.updateSettings({ history: { codex: { enabled: true, roots: [join(dir, "work")] }, "claude-code": { enabled: false, roots: [] } } }, "t");
    let d = await mgr.directory();
    const other = d.entries.find((e) => e.nativeSessionId === "c-1")!;
    expect(d.entries.filter((e) => e.sourceMode === "external-discovered")).toHaveLength(2);
    mgr.updateSettings({ history: { codex: { enabled: true, roots: [join(dir, "work")], originators: ["Codex Desktop"] }, "claude-code": { enabled: false, roots: [] } } }, "t");
    await expect(mgr.messages(other.id, {})).rejects.toMatchObject({ code: "RT_NOT_FOUND" });
    d = await mgr.directory();
    expect(codex.lastOriginators).toEqual(["Codex Desktop"]);
    expect(d.entries.filter((e) => e.sourceMode === "external-discovered").map((e) => e.nativeSessionId)).toEqual(["d-1"]);
    expect(mgr.settings().history.codex.originators).toEqual(["Codex Desktop"]);
  });
});

describe("V3.0 角色指令注入（V30-23/28 的 D 层）", () => {
  const role = { definitionRef: "research-lead@1.0.0", templateVersion: "1", instructions: "你是调研负责人。只负责调研，不做演示稿。" };

  it("新建与续聊都经驱动的角色通道注入同一份角色正文；绑定只存哈希与证据层级", async () => {
    const a = await create("codex", "开始调研", { role, projectRef: "prj-1" });
    await until(() => codex.turns.length === 1);
    expect(codex.turns[0]!.args.roleInstructions).toBe(role.instructions+"\n\n"+SCREENSHOT_INSTRUCTIONS);
    // 角色不混进用户消息
    expect(codex.turns[0]!.args.prompt).toBe("开始调研");
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(a.session.platformSessionId)!.status === "idle");
    const b = mgr.store.binding(a.session.platformSessionId)!;
    expect(b.projectRef).toBe("prj-1");
    expect(b.role).toMatchObject({ definitionRef: "research-lead@1.0.0", injection: "codex.developerInstructions", evidence: { requested: true, runtimeConfirmed: "not_collected" } });
    expect(b.role!.instructionsHash).toMatch(/^sha256:/);
    expect(JSON.stringify(b)).not.toContain("只负责调研");
    await mgr.sendTurn(b.platformSessionId, { idempotencyKey: key(), prompt: "继续", expectedRevision: b.bindingRevision }, "t");
    await until(() => codex.turns.length === 2);
    expect(codex.turns[1]!.args.roleInstructions).toBe(role.instructions+"\n\n"+SCREENSHOT_INSTRUCTIONS);
    expect(codex.turns[1]!.args.nativeSessionId).toBe(codex.turns[0]!.nativeId);
  });

  it("Claude 绑定记 systemPrompt.append；两种 runtime 的两个角色会话互不串线", async () => {
    const other = { definitionRef: "ppt-designer@1.0.0", templateVersion: "1", instructions: "你是演示稿设计者。" };
    await create("codex", "调研", { role });
    const c = await create("claude-code", "做演示稿", { role: other });
    await until(() => codex.turns.length === 1 && claude.turns.length === 1);
    expect(claude.turns[0]!.args.roleInstructions).toBe(other.instructions+"\n\n"+SCREENSHOT_INSTRUCTIONS);
    expect(codex.turns[0]!.args.roleInstructions).toBe(role.instructions+"\n\n"+SCREENSHOT_INSTRUCTIONS);
    expect(mgr.store.binding(c.session.platformSessionId)!.role!.injection).toBe("claude.systemPrompt.append");
  });

  it("重启后续聊仍注入原角色；角色正文丢失则不以无角色身份发送", async () => {
    const a = await create("codex", "开始", { role });
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(a.session.platformSessionId)!.status === "idle");
    const codex2 = new FakeDriver("codex");
    const again = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: codex2, "claude-code": claude }, skipRecovery: true });
    await again.probe("codex");
    const pid = a.session.platformSessionId;
    await again.sendTurn(pid, { idempotencyKey: key(), prompt: "继续", expectedRevision: again.store.binding(pid)!.bindingRevision }, "t");
    await until(() => codex2.turns.length === 1);
    expect(codex2.turns[0]!.args.roleInstructions).toBe(role.instructions+"\n\n"+SCREENSHOT_INSTRUCTIONS);
    codex2.turns[0]!.finish({ status: "completed" });
    await until(() => again.store.binding(pid)!.status === "idle");
    rmSync(join(dir, "data", "runtime", "roles", `${pid}.txt`));
    await again.sendTurn(pid, { idempotencyKey: key(), prompt: "再继续", expectedRevision: again.store.binding(pid)!.bindingRevision }, "t");
    await until(() => again.store.binding(pid)!.turns.length === 3 && again.store.binding(pid)!.turns[2]!.status === "failed");
    expect(codex2.turns.length).toBe(1);
    again.shutdown();
  });

  it("所选版本不支持角色指令时拒绝创建，不退回为拼进首条消息", async () => {
    const p = mgr.profile("codex")!;
    p.capabilities.roleInstructions = { status: "unsupported", reason: "协议缺少 developerInstructions" };
    mgr.store.saveProfile(p);
    await expect(create("codex", "x", { role })).rejects.toMatchObject({ code: "RT_INCOMPATIBLE" });
    expect(codex.turns.length).toBe(0);
  });
});


describe("会话级权限与自动标题", () => {
  it.each(["codex", "claude-code"] as const)("%s 运行中修改只影响下一轮，重载后仍传入驱动", async kind => {
    const { session } = await create(kind);
    const d = driver(kind), id = session.platformSessionId;
    await until(() => d.turns.length === 1);
    const mode = kind === "codex" ? "read-only" : "plan";
    const before = d.turns[0]!.args.permissionMode;
    mgr.store.updateBinding(id, b => { b.approvalGrant = { grantedBy: "test", at: new Date().toISOString(), approvalId: "original-grant" }; });
    mgr.updatePermissionMode(id, mode, mgr.store.binding(id)!.bindingRevision, "test");
    expect(mgr.store.binding(id)!.pendingPermissionMode).toBe(mode);
    expect(mgr.store.binding(id)!.permissionMode).toBe(before);
    expect(d.turns[0]!.args.permissionMode).toBe(before);
    expect(mgr.store.binding(id)!.approvalGrant?.approvalId).toBe("original-grant");
    d.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(id)!.status === "idle");
    mgr.shutdown(); mgr = make();
    const b = mgr.store.binding(id)!;
    await mgr.sendTurn(id, { idempotencyKey: key(), prompt: "继续", expectedRevision: b.bindingRevision }, "test");
    await until(() => d.turns.length === 2);
    expect(d.turns[1]!.args.permissionMode).toBe(mode);
    expect(mgr.store.binding(id)!.approvalGrant).toBeUndefined();
    expect(mgr.store.binding(id)!.pendingPermissionMode).toBeUndefined();
    expect(mgr.store.binding(id)!.permissionMode).toBe(mode);
  });

  it("等待账号名额的当前轮仍沿用原权限，修改从下一轮生效", async () => {
    mgr.updateSettings({ maxRunningPerProfile: 1 }, "test");
    await create(); await until(() => codex.turns.length === 1);
    const { session } = await create(); const id = session.platformSessionId;
    mgr.updatePermissionMode(id, "read-only", mgr.store.binding(id)!.bindingRevision, "test");
    expect(mgr.store.binding(id)!.pendingPermissionMode).toBe("read-only");
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => codex.turns.length === 2);
    expect(codex.turns[1]!.args.permissionMode).toBe("ask");
    codex.turns[1]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(id)!.status === "idle");
    await mgr.sendTurn(id, { idempotencyKey: key(), prompt: "next", expectedRevision: mgr.store.binding(id)!.bindingRevision }, "test");
    await until(() => codex.turns.length === 3);
    expect(codex.turns[2]!.args.permissionMode).toBe("read-only");
  });

  it("空闲修改持久化，拒绝跨运行时、不支持的模式和过期版本", async () => {
    const { session } = await create(); const id = session.platformSessionId;
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(id)!.status === "idle");
    const revision = mgr.store.binding(id)!.bindingRevision;
    expect(() => mgr.updatePermissionMode(id, "plan", revision, "test")).toThrow();
    const p = mgr.profile("codex")!;
    mgr.store.saveProfile({ ...p, permissionOptions: [{ id: "ask", label: "Ask", detail: "" }, { id: "read-only", label: "只读", detail: "" }] });
    expect(() => mgr.updatePermissionMode(id, "full-access", revision, "test")).toThrow();
    mgr.updatePermissionMode(id, "read-only", revision, "test");
    expect(() => mgr.updatePermissionMode(id, "ask", revision, "test")).toThrow();
    mgr.shutdown(); mgr = make();
    expect(mgr.store.binding(id)!.permissionMode).toBe("read-only");
  });

  it.each(["roomRef", "comparisonRef", "projectRef", "evaluation", "role"])("%s 会话保持已有权限限制", async field => {
    const { session } = await create(); const id = session.platformSessionId;
    await until(() => codex.turns.length === 1);
    mgr.store.updateBinding(id, b => { (b as any)[field] = {}; });
    const b = mgr.store.binding(id)!;
    expect(mgr.sessionView(id).permissionOptions).toHaveLength(1);
    expect(() => mgr.updatePermissionMode(id, "full-access", b.bindingRevision, "test")).toThrow();
    expect(mgr.store.binding(id)!.pendingPermissionMode).toBeUndefined();
  });

  it("创建时保存权限，续聊与重新加载后仍沿用同一模式", async () => {
    const { session } = await create("codex", "修复登录页面。\n保留现有 API", { permissionMode: "auto-review" });
    expect(session.permissionMode).toBe("auto-review");
    expect(session.permissionLabel).toBe("Approve for me");
    expect(session.title).toBe("修复登录页面");
    await until(() => codex.turns.length === 1);
    expect(codex.turns[0]!.args.permissionMode).toBe("auto-review");
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    mgr.shutdown();
    mgr = make();
    const b = mgr.store.binding(session.platformSessionId)!;
    await mgr.sendTurn(b.platformSessionId, { idempotencyKey: key(), prompt: "继续", expectedRevision: b.bindingRevision }, "test");
    await until(() => codex.turns.length === 2);
    expect(codex.turns[1]!.args.permissionMode).toBe("auto-review");
  });

  it("拒绝未知权限和跨运行时权限，不派发调用", async () => {
    await expect(create("codex", "x", { permissionMode: "bypassPermissions" })).rejects.toMatchObject({ code: "RT_INPUT" });
    await expect(create("claude-code", "x", { permissionMode: "auto-review" })).rejects.toMatchObject({ code: "RT_INPUT" });
    expect(codex.startCalls + claude.startCalls).toBe(0);
  });

  it("原生标题回报更新列表，补读标题不会改变操作版本", async () => {
    const { session } = await create("codex", "修复登录页面");
    await until(() => codex.turns.length === 1);
    const t = codex.turns[0]!;
    t.sink.nativeSession(t.nativeId, { modelSource: "thread/name/updated", title: "登录页错误修复" });
    expect(mgr.store.binding(session.platformSessionId)!.title).toBe("登录页错误修复");
    const revision = mgr.store.binding(session.platformSessionId)!.bindingRevision;
    codex.reads.set(t.nativeId, { events: [], usage: [], status: "idle", coverage: "complete", notes: [], title: "完善登录体验" });
    await mgr.backfill(session.platformSessionId);
    expect(mgr.store.binding(session.platformSessionId)!.title).toBe("完善登录体验");
    expect(mgr.store.binding(session.platformSessionId)!.bindingRevision).toBe(revision);
  });
});

describe("逐运行时目录和权限", () => {
  it("缺省继承全局根，显式空根禁止该运行时创建", async () => {
    expect(mgr.workspaceRoots("codex")).toEqual([join(dir, "work")]);
    mgr.updateSettings({ workspaceRootsByRuntime: { codex: [] } }, "test");
    await expect(create("codex")).rejects.toMatchObject({ code: "RT_WORKSPACE" });
    expect(mgr.workspaceRoots("claude-code")).toEqual([join(dir, "work")]);
    expect(codex.startCalls).toBe(0);
  });
  it("独立根保留其他运行时设置并拒绝 symlink 逃逸", async () => {
    const other = join(dir, "other"); mkdirSync(other);
    mgr.updateSettings({ workspaceRootsByRuntime: { "claude-code": [] } }, "test");
    mgr.updateSettings({ workspaceRootsByRuntime: { codex: [other] } }, "test");
    expect(mgr.workspaceRoots("claude-code")).toEqual([]);
    symlinkSync(ws, join(other, "link"));
    await expect(create("codex", "hi", { workspace: join(other, "link") })).rejects.toMatchObject({ code: "RT_WORKSPACE" });
    await expect(create("codex", "hi", { workspace: ws })).rejects.toMatchObject({ code: "RT_WORKSPACE" });
  });
  it("Pi 默认原生工具权限；其他运行时权限、非法模型与 effort 均不派发", async () => {
    mgr.shutdown();
    const pi = new FakeDriver("pi");
    mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex, "claude-code": claude, pi }, skipRecovery: true });
    await mgr.probe("pi");
    for (const permissionMode of ["ask", "auto-review", "default"]) {
      await expect(create("pi", "hello", { permissionMode })).rejects.toMatchObject({ code: "RT_INPUT" });
    }
    await expect(create("codex", "hello", { permissionMode: "pi-native" })).rejects.toMatchObject({ code: "RT_INPUT" });
    await expect(create("pi", "hello", { model: "invalid" })).rejects.toMatchObject({ code: "RT_INPUT" });
    await expect(create("pi", "hello", { model: "m-1", effort: "max" })).rejects.toMatchObject({ code: "RT_INPUT" });
    expect(pi.startCalls).toBe(0);
    const { session } = await create("pi");
    expect(session).toMatchObject({ permissionMode: "pi-native", piPermissionPolicyVersion: 1, executionMode: "runtime-native", sourceMode: "platform-managed" });
    await until(() => pi.turns.length === 1);
    expect(pi.turns[0]!.args.permissionMode).toBe("pi-native");
    expect(mgr.store.operation(session.creationOperationId)?.presetNativeId).toMatch(/^[\da-f-]{36}$/);
    pi.turns[0]!.finish({ status: "completed" });
  });
});

it("freezes Pi default from persisted profile after restart without another probe", async () => {
  mgr.shutdown(); const first = new FakeDriver("pi");
  mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { pi: first }, skipRecovery: true });
  await mgr.probe("pi"); mgr.shutdown();
  const fresh = new FakeDriver("pi");
  mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { pi: fresh }, skipRecovery: true });
  const { session } = await create("pi");
  await until(() => fresh.turns.length === 1);
  expect(session.requestedModel).toBe("m-1");
  expect(fresh.turns[0].args.model).toBe("m-1");
  fresh.turns[0].finish({ status: "completed" });
});

it("V3.1 Pi preserves driver role eligibility, injects role on create and native resume", async () => {
  mgr.shutdown();
  const pi = new FakeDriver("pi");
  mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { pi }, skipRecovery: true });
  const profile = await mgr.probe("pi");
  expect(profile.capabilities.roleInstructions.status).toBe("supported");
  const role = { definitionRef: "requirements-clarifier@1.0.0", templateVersion: "1", instructions: "只澄清需求" };
  const { session } = await create("pi", "澄清目标", { role });
  await until(() => pi.turns.length === 1);
  expect(pi.turns[0].args.roleInstructions).toBe(role.instructions+"\n\n"+SCREENSHOT_INSTRUCTIONS);
  expect(mgr.store.binding(session.platformSessionId)!.role!.injection).toBe("pi.appendSystemPrompt");
  pi.turns[0].finish({ status: "completed" });
  await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
  const b = mgr.store.binding(session.platformSessionId)!;
  await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "继续澄清", expectedRevision: b.bindingRevision }, "t");
  await until(() => pi.turns.length === 2);
  expect(pi.turns[1].args.roleInstructions).toBe(role.instructions+"\n\n"+SCREENSHOT_INSTRUCTIONS);
  expect(pi.turns[1].args.nativeSessionId).toBe(pi.turns[0].nativeId);
  pi.turns[1].finish({ status: "completed" });
});

it("persists host evaluation policy and re-injects it after restart on the same native session", async () => {
  const inputs = join(dir, "evaluation-inputs"), reports = join(ws, "reports"); mkdirSync(inputs); mkdirSync(reports);
  const evaluation = { inputRoots: [realpathSync(inputs)], reportDir: realpathSync(reports) };
  const { session } = await create("codex", "核验", { evaluation });
  await until(() => codex.turns.length === 1);
  expect(codex.turns[0].args.evaluation).toEqual(evaluation);
  expect(codex.turns[0].args).toMatchObject({ platformSessionId: session.platformSessionId });
  codex.turns[0].finish({ status: "completed" });
  await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
  mgr.shutdown(); const fresh = new FakeDriver("codex");
  mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: fresh }, skipRecovery: true });
  const binding = mgr.store.binding(session.platformSessionId)!;
  await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "复核", expectedRevision: binding.bindingRevision }, "owner");
  await until(() => fresh.turns.length === 1);
  expect(fresh.turns[0].args.evaluation).toEqual(evaluation);
  expect(fresh.turns[0].args).toMatchObject({ platformSessionId: session.platformSessionId });
  expect(fresh.turns[0].args.clientMessageId).not.toBe(codex.turns[0].args.clientMessageId);
  expect(fresh.turns[0].args.nativeSessionId).toBe(codex.turns[0].nativeId);
  fresh.turns[0].finish({ status: "completed" });
});
it("rejects evaluator permissions that bypass protection and overlapping input/report roots before dispatch", async () => {
  const input = join(dir, "inputs"); mkdirSync(input);
  const evaluation = { inputRoots: [input], reportDir: join(ws, "reports") };
  for (const permissionMode of ["auto-review", "full-access"]) await expect(create("codex", "验收", { evaluation, permissionMode })).rejects.toMatchObject({ code: "RT_EVALUATION" });
  await expect(create("codex", "验收", { evaluation: { ...evaluation, inputRoots: [ws] } })).rejects.toMatchObject({ code: "RT_EVALUATION" });
  expect(codex.turns).toHaveLength(0);
});

it("denies evaluation escalation without exposing an approval button", async () => {
  const input = join(dir, "inputs"); mkdirSync(input);
  const { session } = await create("codex", "验收", { evaluation: { inputRoots: [input], reportDir: join(ws, "reports") } });
  await until(() => codex.turns.length === 1);
  const decision = await codex.turns[0].sink.approval({ nativeRequestId: "escape", kind: "command", title: "写输入", action: "write", scope: "outside", source: "fake", params: { sandbox_permissions: "require_escalated" } });
  expect(decision.approve).toBe(false);
  expect(mgr.sessionView(session.platformSessionId).approvals).toHaveLength(0);
  codex.turns[0].finish({ status: "completed" });
});
it("report symlink replacement fails before native resume and is a known not-dispatched failure", async () => {
  const input = join(dir, "inputs"), reports = join(ws, "reports"); mkdirSync(input); mkdirSync(reports);
  const { session } = await create("codex", "验收", { evaluation: { inputRoots: [input], reportDir: reports } });
  await until(() => codex.turns.length === 1);
  codex.turns[0].finish({ status: "completed" });
  await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
  rmSync(reports, { recursive: true }); symlinkSync(input, reports);
  const b = mgr.store.binding(session.platformSessionId)!;
  await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "再验收", expectedRevision: b.bindingRevision }, "t");
  await until(() => mgr.store.binding(session.platformSessionId)!.turns.at(-1)!.status === "failed");
  expect(codex.turns).toHaveLength(1);
});

it("admits eight configured account calls while the ninth waits and lowering never interrupts active turns",async()=>{
 mgr.updateSettings({maxRunningPerProfile:8},"owner");
 for(let i=0;i<9;i++)await create("codex",`call-${i}`);
 await until(()=>codex.turns.length===8);expect(mgr.activity().queued).toBe(1);
 mgr.updateSettings({maxRunningPerProfile:1},"owner");expect(mgr.activity().active.filter(b=>b.status==="running")).toHaveLength(8);expect(codex.turns.every(t=>!t.interrupted)).toBe(true);
 for(const t of codex.turns.slice(0,7))t.finish({status:"completed"});await tick(150);expect(codex.turns).toHaveLength(8);
 codex.turns[7].finish({status:"completed"});await until(()=>codex.turns.length===9);
});
it.each([0,9,1.5,NaN])("rejects invalid shared capacity %s without altering the configured limit",value=>{
 expect(()=>mgr.updateSettings({maxRunningPerProfile:value},"owner")).toThrow();expect(mgr.settings().maxRunningPerProfile).toBe(2);
});

it("holds a project's total capacity across native runtimes and lets another project proceed",async()=>{
 mgr.updateSettings({maxRunningPerProfile:8},"owner");
 mgr.setProjectAdmissionSource(projectId=>({concurrency:2,totalConcurrency:2,revision:1,sourceRef:`host-project:${projectId}:1`}));
 await create("codex","first",{projectRef:"project-one",admissionClass:"coordinator"});
 await create("claude-code","second",{projectRef:"project-one",admissionClass:"stage"});
 await until(()=>codex.turns.length===1&&claude.turns.length===1);
 await create("codex","waiting",{projectRef:"project-one",admissionClass:"evaluation"});await tick(150);expect(codex.turns).toHaveLength(1);
 await create("codex","independent",{projectRef:"project-two"});await until(()=>codex.turns.length===2);
 claude.turns[0].finish({status:"unknown",reason:"lost terminal"});await tick(150);expect(codex.turns).toHaveLength(2);
 codex.turns[0].finish({status:"completed"});await until(()=>codex.turns.length===3);expect(codex.turns[2].args.prompt).toBe("waiting");
});


it("dispatches a queued evaluator before older new business work at the same profile cap",async()=>{
 mgr.updateSettings({maxRunningPerProfile:1},"owner");
 await create("codex","active");await until(()=>codex.turns.length===1);
 await create("codex","business",{projectRef:"business-project"});
 await create("codex","evaluation",{projectRef:"evaluation-project",admissionClass:"evaluation"});
 expect(mgr.activity().queued).toBe(2);codex.turns[0].finish({status:"completed"});
 await until(()=>codex.turns.length===2);expect(codex.turns[1].args.prompt).toBe("evaluation");
 codex.turns[1].finish({status:"completed"});await until(()=>codex.turns.length===3);expect(codex.turns[2].args.prompt).toBe("business");
});
it("cancels an undispatched evaluator without blocking queued business and never replays it after recovery",async()=>{
 mgr.updateSettings({maxRunningPerProfile:1},"owner");
 await create("codex","active");await until(()=>codex.turns.length===1);
 const cancelled=await create("codex","cancel-evaluation",{admissionClass:"evaluation"});
 await create("codex","business");await mgr.interrupt(cancelled.session.platformSessionId,"owner");
 codex.turns[0].finish({status:"completed"});await until(()=>codex.turns.length===2);expect(codex.turns[1].args.prompt).toBe("business");
 codex.turns[1].finish({status:"completed"});await tick(150);mgr.shutdown();mgr=new RuntimeSessionManager({dataDir:join(dir,"data"),drivers:{codex,"claude-code":claude}});
 await mgr.recovered;await tick(150);expect(codex.turns).toHaveLength(2);
});


it("honors a queued evaluator on another manager sharing the account before local business",async()=>{
 mgr.shutdown();const sharedSlotsDir=join(dir,"global-admission");
 mgr=new RuntimeSessionManager({dataDir:join(dir,"one"),sharedSlotsDir,drivers:{codex},skipRecovery:true});
 mgr.updateSettings({workspaceRoots:[join(dir,"work")],maxRunningPerProfile:1},"owner");await mgr.probe("codex");
 mkdirSync(join(dir,"two","runtime"),{recursive:true});writeFileSync(join(dir,"two","runtime","host.json"),JSON.stringify(mgr.store.host));
 const otherDriver=new FakeDriver("codex"),other=new RuntimeSessionManager({dataDir:join(dir,"two"),sharedSlotsDir,drivers:{codex:otherDriver},skipRecovery:true});
 try{
  other.updateSettings({workspaceRoots:[join(dir,"work")],maxRunningPerProfile:1},"owner");await other.probe("codex");
  expect(other.profile("codex")!.identity!.identityScopeId).toBe(mgr.profile("codex")!.identity!.identityScopeId);
  await create("codex","active");await until(()=>codex.turns.length===1);await create("codex","business");
  await other.create({idempotencyKey:key(),runtimeKind:"codex",workspace:ws,prompt:"other-host-evaluation",admissionClass:"evaluation",confirmedProfileVersion:other.profile("codex")!.checkedAt},"owner");
  codex.turns[0].finish({status:"completed"});await until(()=>otherDriver.turns.length===1);expect(codex.turns).toHaveLength(1);
  otherDriver.turns[0].finish({status:"completed"});await until(()=>codex.turns.length===2);expect(codex.turns[1].args.prompt).toBe("business");codex.turns[1].finish({status:"completed"});await tick(20);
 }finally{other.shutdown();}
});


it("retries a durable queued cancellation after shared mutex contention",async()=>{
 mgr.updateSettings({maxRunningPerProfile:1},"owner");await create("codex","active");await until(()=>codex.turns.length===1);
 const queued=await create("codex","cancel-before-native",{admissionClass:"evaluation"});await create("codex","business");
 const lock=join(mgr.store.dir,"shared-slots","admission.lock");mkdirSync(lock);
 try{await mgr.interrupt(queued.session.platformSessionId,"owner");expect(mgr.store.operation(queued.session.creationOperationId)!.steps.some(s=>s.step==="shared-queue-cancelled")).toBe(true);}finally{rmSync(lock,{recursive:true});}
 codex.turns[0].finish({status:"completed"});await until(()=>codex.turns.length===2);expect(codex.turns[1].args.prompt).toBe("business");
});

it("rechecks continuation authority after fingerprint awaits across two managers, persisting only one new turn",async()=>{
 const created=await create();await until(()=>codex.turns.length===1);codex.turns[0]!.finish({status:"completed"});await until(()=>mgr.store.binding(created.session.platformSessionId)!.status==="idle");
 const other=make(),id=created.session.platformSessionId,revision=mgr.store.binding(id)!.bindingRevision,nativeId=mgr.store.binding(id)!.nativeSessionId!;
 const original=codex.fingerprint.bind(codex);let arrivals=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve});
 codex.fingerprint=async native=>{const source=await original(native);if(native===nativeId&&arrivals<2){arrivals++;if(arrivals===2)release();await barrier;}return source};
 try{
  const results=await Promise.allSettled([mgr.sendTurn(id,{idempotencyKey:"concurrent-turn-one",prompt:"one",expectedRevision:revision},"human"),other.sendTurn(id,{idempotencyKey:"concurrent-turn-two",prompt:"two",expectedRevision:revision},"human")]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"RT_CONFLICT"}});
  const persisted=make();try{const binding=persisted.store.binding(id)!;expect(binding.turns.map(t=>t.turnNo)).toEqual([1,2]);expect(new Set(binding.turns.map(t=>t.clientMessageId)).size).toBe(2);expect(persisted.store.allOperations().filter(o=>o.platformSessionId===id&&o.kind==="turn")).toHaveLength(1);}finally{persisted.shutdown();}
 }finally{codex.fingerprint=original;other.shutdown();}
});

describe("多运行时对话目录：用途、归档", () => {
  it("source=chat 只列普通对话（不含项目角色会话、验收探针、历史与额外条目）；已归档按 archived 参数列出", async () => {
    const probeWs = join(dir, "work", ".evaluation-qualification", "q-1");
    mkdirSync(probeWs, { recursive: true });
    const chat = await create("codex", "普通对话");
    await until(() => codex.turns.length === 1);
    await create("codex", "项目阶段", { projectRef: "prj-1" });
    await until(() => codex.turns.length === 2);
    const p = mgr.profile("claude-code")!;
    await mgr.create({ idempotencyKey: key(), runtimeKind: "claude-code", workspace: probeWs, prompt: "探针", confirmedProfileVersion: p.checkedAt }, "test");
    await until(() => claude.turns.length === 1);
    codex.history = [{ nativeSessionId: "h-1", title: "外部历史", workspace: ws, sourceLabel: "fake", status: "unknown", updatedAt: "2026-01-02T00:00:00Z" }];
    mgr.updateSettings({ history: { codex: { enabled: true, roots: [join(dir, "work")] }, "claude-code": { enabled: false, roots: [] } } }, "t");
    const extra = [{ id: "s-1", runtimeKind: "pi" as const, sourceMode: "pi-task" as const, executionMode: "contract-governed" as const, title: "合约任务", status: "running", accountKnown: true, href: "#/s/s-1" }];

    const all = await mgr.directory({}, extra);
    expect(all.entries.map((e) => e.purpose ?? e.sourceMode).sort()).toEqual(["chat", "external-discovered", "pi-task", "probe", "project"]);
    expect(all.entries.find((e) => e.purpose === "project")!.projectRef).toBe("prj-1");

    let d = await mgr.directory({ source: "chat" }, extra);
    expect(d.entries.map((e) => e.id)).toEqual([chat.session.platformSessionId]);
    expect(d.history).toEqual({});

    // 运行中不能归档；本轮结束后可以
    expect(() => mgr.archive(chat.session.platformSessionId, true, "t")).toThrow(/运行中/);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(chat.session.platformSessionId)!.status === "idle");
    mgr.archive(chat.session.platformSessionId, true, "t");
    expect((await mgr.directory({ source: "chat" })).entries).toHaveLength(0);
    d = await mgr.directory({ source: "chat", archived: "include" });
    expect(d.entries).toMatchObject([{ id: chat.session.platformSessionId, archived: true }]);
    // 目录带新建 / 归档时刻：待办页的「当日会话数」按它们分新建、在途、已归档。
    expect(d.entries[0]!.createdAt).toEqual(expect.any(String));
    expect(d.entries[0]!.archivedAt).toEqual(expect.any(String));
    expect((await mgr.directory({ archived: "only" }, extra)).entries.map((e) => e.id)).toEqual([chat.session.platformSessionId]);
    mgr.archive(chat.session.platformSessionId, false, "t");
    d = await mgr.directory({ source: "chat" });
    expect(d.entries[0]).toMatchObject({ id: chat.session.platformSessionId });
    expect(d.entries[0]!.archived).toBeUndefined();
    expect(d.entries[0]!.archivedAt).toBeUndefined();
    for (const t of [...codex.turns, ...claude.turns]) t.finish({ status: "completed" });
  });
});

describe("定时会话", () => {
  it("首轮未开始的定时会话不进目录，撤销预约后仍隐藏，发出第一轮后才出现", async () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    const reserved = await create("codex", "稍后执行", { scheduledFor: later });
    const inDirectory = async (id: string) => (await mgr.directory({ source: "chat", includeHistory: false })).entries.some((e) => e.id === id);
    // 新建的定时会话：首轮还没开始，目录里不列它；预约条目在时钟的预约总览里
    expect(mgr.store.binding(reserved.session.platformSessionId)!.scheduledCreate).toBe(true);
    expect(await inDirectory(reserved.session.platformSessionId)).toBe(false);

    // 已有轮次的会话：后来的预约消息不改变列表归属
    const running = await create("codex", "现在执行");
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(running.session.platformSessionId)!.status === "idle");
    mgr.enqueueMessage(running.session.platformSessionId, { messageId: key(), prompt: "续聊预约", scheduledFor: later } as any, "test");
    expect(await inDirectory(running.session.platformSessionId)).toBe(true);

    // 撤销预约：会话仍不进列表（没有发送过），直到真正发出第一轮
    const messageId = mgr.store.binding(reserved.session.platformSessionId)!.outbox![0]!.messageId;
    mgr.removeQueuedMessage(reserved.session.platformSessionId, messageId, "test");
    expect(await inDirectory(reserved.session.platformSessionId)).toBe(false);

    mgr.enqueueMessage(reserved.session.platformSessionId, { messageId: key(), prompt: "稍后执行", scheduledFor: new Date(Date.now() + 500).toISOString() } as any, "test");
    await until(() => codex.turns.length === 2, 6000);
    expect(await inDirectory(reserved.session.platformSessionId)).toBe(true);
  });
});

describe("用户消息走实时流", () => {
  it("创建与续聊写入的用户消息都推送 event（页面发送后不重新拉取对话）", async () => {
    const seen: string[] = [];
    mgr.on("event", (x: { platformSessionId: string; event: { kind: string; role?: string; text?: string } }) => { if (x.event.kind === "message" && x.event.role === "user") seen.push(x.event.text ?? ""); });
    const { session } = await create("codex", "第一轮");
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    const b = mgr.store.binding(session.platformSessionId)!;
    await mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "第二轮", expectedRevision: b.bindingRevision }, "t");
    expect(seen).toEqual(["第一轮", "第二轮"]);
    await until(() => codex.turns.length === 2);
    codex.turns[1]!.finish({ status: "completed" });
  });
});

describe("对比组：一次发起多个会话", () => {
  const versions = () => ({ codex: mgr.profile("codex")!.checkedAt, "claude-code": mgr.profile("claude-code")!.checkedAt });
  const compare = (lanes: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    mgr.createComparison({ idempotencyKey: "cmp-key-0001", workspace: ws, prompt: "比较一下这个方案。细节如下", lanes: lanes as never, confirmedProfileVersions: versions(), ...extra }, "t");

  it("整组创建：每条通道是带 comparisonRef 的普通会话，权限固定只读；重放同一键不重复创建", async () => {
    const { group, replayed } = await compare([{ runtimeKind: "codex" }, { runtimeKind: "codex", model: "m-2" }, { runtimeKind: "claude-code", model: "m-1", effort: "high" }]);
    expect(replayed).toBe(false);
    expect(group.lanes).toHaveLength(3);
    expect(group.title).toBe("比较一下这个方案");
    expect(group.lanes.every((l) => l.platformSessionId && !l.error)).toBe(true);
    const bindings = group.lanes.map((l) => mgr.store.binding(l.platformSessionId!)!);
    expect(bindings.map((b) => b.comparisonRef)).toEqual([1, 2, 3].map((laneNo) => ({ groupId: group.groupId, laneNo })));
    expect(bindings.map((b) => b.permissionMode)).toEqual(["read-only", "read-only", "plan"]);
    expect(bindings[2]!.requestedEffort).toBe("high");
    await until(() => codex.turns.length === 2 && claude.turns.length === 1);
    expect(codex.turns.map((t) => t.args.permissionMode)).toEqual(["read-only", "read-only"]);
    expect(codex.turns.map((t) => t.args.prompt)).toEqual(["比较一下这个方案。细节如下", "比较一下这个方案。细节如下"]);
    const again = await compare([{ runtimeKind: "codex" }, { runtimeKind: "codex", model: "m-2" }, { runtimeKind: "claude-code" }]);
    expect(again.replayed).toBe(true);
    expect(again.group.groupId).toBe(group.groupId);
    await tick(20);
    expect(codex.startCalls + claude.startCalls).toBe(3);
    await expect(compare([{ runtimeKind: "codex" }, { runtimeKind: "claude-code" }], { prompt: "另一件事" })).rejects.toMatchObject({ code: "RT_CONFLICT" });
    for (const t of [...codex.turns, ...claude.turns]) t.finish({ status: "completed" });
  });

  it("任何一条预检不过就整组拒绝，不建一半；通道数与权限受限", async () => {
    await expect(compare([{ runtimeKind: "codex" }, { runtimeKind: "claude-code", model: "nope" }])).rejects.toMatchObject({ code: "RT_INPUT", message: expect.stringContaining("通道 2") });
    await expect(compare([{ runtimeKind: "codex" }])).rejects.toMatchObject({ code: "RT_INPUT" });
    await expect(compare(Array.from({ length: 5 }, () => ({ runtimeKind: "codex" })))).rejects.toMatchObject({ code: "RT_INPUT" });
    await expect(compare([{ runtimeKind: "codex", permissionMode: "ask" }, { runtimeKind: "claude-code" }])).rejects.toMatchObject({ code: "RT_INPUT", message: expect.stringContaining("只读") });
    await expect(compare([{ runtimeKind: "codex" }, { runtimeKind: "claude-code" }], { confirmedProfileVersions: { codex: mgr.profile("codex")!.checkedAt } })).rejects.toMatchObject({ code: "RT_PROFILE_CHANGED" });
    expect(mgr.store.allBindings()).toHaveLength(0);
    expect(mgr.store.allComparisons()).toHaveLength(0);
  });

  it("同一 runtime 超过并发上限的通道排队，之后自动派发", async () => {
    const { group } = await compare([{ runtimeKind: "codex" }, { runtimeKind: "codex" }, { runtimeKind: "codex" }]);
    await until(() => codex.turns.length === 2);
    await tick(10);
    const v = mgr.comparisonView(group.groupId);
    expect(v.lanes.filter((l) => l.queuePosition === 1)).toHaveLength(1);
    expect(v.settled).toBe(false);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => codex.turns.length === 3);
    for (const t of codex.turns) t.finish({ status: "completed" });
  });

  it("对比视图：最终回复取最新一轮最后一条主 Agent 消息；指标、失败通道互不影响；结论与归档", async () => {
    const { group } = await compare([{ runtimeKind: "codex" }, { runtimeKind: "claude-code" }]);
    await until(() => codex.turns.length === 1 && claude.turns.length === 1);
    const [a, b] = [codex.turns[0]!, claude.turns[0]!];
    a.sink.event(ev("a:1", "我先看看文件"));
    a.sink.event({ key: "a:t1", kind: "tool", tool: { name: "命令", input: "ls", status: "completed", exitCode: 0 }, source: "stream", parserVersion: "f", availability: "recorded" });
    a.sink.event({ key: "a:t2", kind: "tool", tool: { name: "命令", input: "cat x", status: "failed", exitCode: 1 }, source: "stream", parserVersion: "f", availability: "recorded" });
    a.sink.event(ev("a:sub", "子 Agent 的话", { subagent: "s1" }));
    a.sink.event(ev("a:2", "结论：方案 A 更好"));
    b.sink.event(ev("b:1", "正在写", { partial: true }));
    let v = mgr.comparisonView(group.groupId);
    expect(v.lanes[0]!.answer).toMatchObject({ text: "结论：方案 A 更好", partial: false });
    expect(v.lanes[0]!.metrics).toMatchObject({ toolCalls: 2, toolFailures: 1, turns: 1 });
    expect(v.lanes[1]!.answer).toMatchObject({ text: "正在写", partial: true });
    await expect(Promise.resolve().then(() => mgr.archiveComparison(group.groupId, true, "t"))).rejects.toMatchObject({ code: "RT_BUSY" });
    a.finish({ status: "completed" });
    b.finish({ status: "failed", reason: "额度不足" });
    await until(() => mgr.comparisonView(group.groupId).settled);
    v = mgr.comparisonView(group.groupId);
    expect(v.lanes[0]!.metrics.latestTurn).toMatchObject({ status: "completed" });
    expect(typeof v.lanes[0]!.metrics.latestTurn!.durationMs).toBe("number");
    // 额度不足会重置，通道这一轮记为被中断，而不是普通失败
    expect(v.lanes[1]!.metrics.latestTurn).toMatchObject({ status: "interrupted" });
    expect(mgr.setComparisonVerdict(group.groupId, { laneNo: 1, note: "更完整" }, "t").verdict).toMatchObject({ laneNo: 1, note: "更完整" });
    expect(() => mgr.setComparisonVerdict(group.groupId, { laneNo: 9 }, "t")).toThrow();
    await mgr.archiveComparison(group.groupId, true, "t");
    expect(group.lanes.every((l) => mgr.store.binding(l.platformSessionId!)!.archived)).toBe(true);
    const d = await mgr.directory({ source: "chat", archived: "include" });
    expect(d.entries.filter((e) => e.purpose === "compare").map((e) => e.comparisonRef?.groupId)).toEqual([group.groupId, group.groupId]);
  });
});

describe("单聊归档删除 worktree", () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  async function setup() {
    sh(ws, "init", "-q", "-b", "main");
    sh(ws, "config", "user.email", "t@example.test");
    sh(ws, "config", "user.name", "t");
    writeFileSync(join(ws, "a.txt"), "base\n");
    sh(ws, "add", "-A"); sh(ws, "commit", "-q", "-m", "base");
    const { session } = await create("codex", "改代码", { worktree: true });
    await until(() => codex.turns.length === 1);
    codex.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)!.status === "idle");
    return session;
  }
  it.each(["dirty", "unmerged", "missing", "tampered-git"])("归档直接清理 %s worktree，原目录与会话历史保留", async (mode) => {
    const session = await setup(), wt = session.worktree!;
    if (mode === "unmerged") {
      writeFileSync(join(wt.path, "a.txt"), "session commit\n");
      sh(wt.path, "add", "-A"); sh(wt.path, "commit", "-q", "-m", "unmerged");
    }
    writeFileSync(join(wt.path, "pending.txt"), "uncommitted\n");
    if (mode === "missing") rmSync(wt.path, { recursive: true });
    if (mode === "tampered-git") writeFileSync(join(wt.path, ".git"), `gitdir: ${join(ws, ".git")}\n`);
    const out = await mgr.archive(session.platformSessionId, true, "test");
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(ws, "worktree", "list", "--porcelain")).not.toContain(wt.path);
    expect(sh(ws, "branch", "--list", wt.branch).trim()).toBe("");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("base\n");
    expect(out).toMatchObject({ archived: true, worktree: { removedAt: expect.any(String) } });
    expect(mgr.store.binding(session.platformSessionId)!.turns).toHaveLength(1);
    await mgr.archive(session.platformSessionId, true, "test");
    await mgr.archive(session.platformSessionId, false, "test");
    expect(existsSync(wt.path)).toBe(false);
    await expect(mgr.sendTurn(session.platformSessionId, { idempotencyKey: key(), prompt: "继续", expectedRevision: mgr.store.binding(session.platformSessionId)!.bindingRevision }, "test")).rejects.toThrow(/worktree.*删除/);
  });
  it("运行或排队中的会话不能归档删除，清理期间不能恢复或删除记录", async () => {
    const session = await setup(), wt = session.worktree!;
    mgr.store.updateBinding(session.platformSessionId, b => { b.turns[0]!.status = "queued"; });
    expect(() => mgr.archive(session.platformSessionId, true, "test")).toThrow(/运行中/);
    expect(existsSync(wt.path)).toBe(true);
    mgr.store.updateBinding(session.platformSessionId, b => { b.turns[0]!.status = "completed"; });
    const pending = mgr.archive(session.platformSessionId, true, "test");
    expect(() => mgr.archive(session.platformSessionId, false, "test")).toThrow(/清理/);
    expect(() => mgr.deletePlatformData(session.platformSessionId, "test")).toThrow(/清理/);
    await pending;
  });
});

describe("对比组 P1：git worktree 隔离、代码改动与采用", () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  let repo: string;
  beforeEach(() => {
    repo = join(dir, "work", "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.email", "t@example.test"); sh(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "src", "a.txt"), "one\ntwo\n");
    sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "init");
  });
  const versions = () => ({ codex: mgr.profile("codex")!.checkedAt, "claude-code": mgr.profile("claude-code")!.checkedAt });
  const compareWt = (extra: Record<string, unknown> = {}) => mgr.createComparison({
    idempotencyKey: `wt-${keyN++}-abcdef`, workspace: join(repo, "src"), prompt: "改一下 a.txt", isolation: "worktree",
    lanes: [{ runtimeKind: "codex", permissionMode: "ask" }, { runtimeKind: "claude-code", permissionMode: "acceptEdits" }] as never,
    confirmedProfileVersions: versions(), ...extra
  } as never, "t");

  it("每条通道一个从同一 commit 切出的 worktree；通道互相看不到对方的写入，原目录在采用前不变", async () => {
    writeFileSync(join(repo, "dirty.txt"), "未提交\n"); // 原仓库的未提交改动不带进 worktree
    const info = await mgr.comparisonWorkspaceInfo(join(repo, "src"), ["codex", "claude-code"]);
    expect(info.git).toMatchObject({ repoRoot: realpathSync(repo), subdir: "src", dirty: 1, worktreeAllowed: true, branch: "main" });
    const { group } = await compareWt({ confirmedBaseCommit: info.git!.head });
    expect(group.isolation).toBe("worktree");
    expect(group.worktree).toMatchObject({ baseCommit: info.git!.head, subdir: "src", dirtyAtCreate: 1 });
    const [l1, l2] = group.lanes.map((l) => l.worktree!);
    expect(l1!.workspace).toBe(join(realpathSync(repo), ".pi-compare", group.groupId, "L1", "src"));
    expect(group.lanes.map((l) => mgr.store.binding(l.platformSessionId!)!.workspace)).toEqual([l1!.workspace, l2!.workspace]);
    expect(group.lanes.map((l) => l.permissionMode)).toEqual(["ask", "acceptEdits"]);
    await until(() => codex.turns.length === 1 && claude.turns.length === 1);
    expect(codex.turns[0]!.args.workspace).toBe(l1!.workspace);
    expect(existsSync(join(l1!.path, "dirty.txt"))).toBe(false);
    // 通道各自写：L1 新增文件，L2 改已跟踪文件
    writeFileSync(join(l1!.workspace, "new.txt"), "from L1\n");
    writeFileSync(join(l2!.workspace, "a.txt"), "one\nTWO\n");
    expect(existsSync(join(l2!.workspace, "new.txt"))).toBe(false);
    expect(readFileSync(join(l1!.workspace, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(readFileSync(join(repo, "src", "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(existsSync(join(repo, "src", "new.txt"))).toBe(false);
    expect(sh(repo, "status", "--porcelain")).toBe("?? dirty.txt\n"); // .pi-compare 已写入 info/exclude
    const d1 = await mgr.comparisonLaneDiff(group.groupId, 1);
    expect(d1.files).toEqual([{ path: "src/new.txt", added: 1, deleted: 0, binary: false }]);
    const d2 = await mgr.comparisonLaneDiff(group.groupId, 2);
    expect(d2.files).toEqual([{ path: "src/a.txt", added: 1, deleted: 1, binary: false }]);
    expect(d2.patch).toContain("+TWO");
    // 采用：运行中拒绝；查看后改动又变了拒绝；成功后只采用一次
    await expect(mgr.adoptComparisonLane(group.groupId, 2, d2.patchHash, "t")).rejects.toMatchObject({ code: "RT_BUSY" });
    for (const t of [...codex.turns, ...claude.turns]) t.finish({ status: "completed" });
    await until(() => mgr.comparisonView(group.groupId).settled);
    await expect(mgr.adoptComparisonLane(group.groupId, 2, d1.patchHash, "t")).rejects.toMatchObject({ code: "RT_CONFLICT" });
    expect(readFileSync(join(repo, "src", "a.txt"), "utf8")).toBe("one\ntwo\n");
    const adopted = await mgr.adoptComparisonLane(group.groupId, 2, d2.patchHash, "t");
    expect(adopted.adopted).toMatchObject({ laneNo: 2, files: 1 });
    expect(readFileSync(join(repo, "src", "a.txt"), "utf8")).toBe("one\nTWO\n");
    expect(existsSync(join(repo, "src", "new.txt"))).toBe(false);
    await expect(mgr.adoptComparisonLane(group.groupId, 1, d1.patchHash, "t")).rejects.toMatchObject({ code: "RT_CONFLICT" });
    // 归档清理 worktree
    await mgr.archiveComparison(group.groupId, true, "t");
    expect(existsSync(l1!.path) || existsSync(l2!.path)).toBe(false);
    expect(existsSync(join(repo, ".pi-compare"))).toBe(false);
    expect(sh(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
    await expect(mgr.comparisonLaneDiff(group.groupId, 1)).rejects.toMatchObject({ code: "RT_GONE" });
  });

  it("通道把 worktree 的 .git 改指向自造的 gitdir：宿主读改动时不执行其中的配置，仍按主仓库登记的 gitdir 读", async () => {
    const { group } = await compareWt();
    await until(() => codex.turns.length === 1 && claude.turns.length === 1);
    const l1 = group.lanes[0]!.worktree!;
    writeFileSync(join(l1.path, "src", "a.txt"), "one\nTWO\n");
    // 通道在自己的 worktree 里造一个仓库，配置 fsmonitor 去执行命令，再把 .git 文件指过去
    const evil = join(l1.path, "evil");
    sh(l1.path, "init", "-q", evil);
    sh(evil, "-c", "user.email=e@example.test", "-c", "user.name=e", "commit", "-q", "--allow-empty", "-m", "e");
    const marker = join(dir, "pwned");
    sh(evil, "config", "core.fsmonitor", `touch ${marker}; false`);
    sh(evil, "config", "core.worktree", l1.path);
    writeFileSync(join(l1.path, ".git"), `gitdir: ${join(evil, ".git")}\n`);
    for (const t of [...codex.turns, ...claude.turns]) t.finish({ status: "completed" });
    await until(() => mgr.comparisonView(group.groupId).settled);
    const d = await mgr.comparisonLaneDiff(group.groupId, 1);
    expect(existsSync(marker)).toBe(false);
    expect(d.baseCommit).toBe(group.worktree!.baseCommit);
    expect(d.files.map((f) => f.path)).toContain("src/a.txt");
  });

  it("非 git 目录不能用 worktree；越出工作区的权限被拒；HEAD 变了要求重新确认；删除整组清理 worktree", async () => {
    await expect(mgr.createComparison({ idempotencyKey: "wt-nogit-abcdef", workspace: ws, prompt: "x", isolation: "worktree", lanes: [{ runtimeKind: "codex" }, { runtimeKind: "claude-code" }], confirmedProfileVersions: versions() }, "t")).rejects.toMatchObject({ code: "RT_INPUT" });
    expect((await mgr.comparisonWorkspaceInfo(ws, ["codex"])).git).toBeUndefined();
    await expect(compareWt({ lanes: [{ runtimeKind: "codex", permissionMode: "full-access" }, { runtimeKind: "claude-code" }] })).rejects.toMatchObject({ code: "RT_INPUT" });
    await expect(compareWt({ lanes: [{ runtimeKind: "codex" }, { runtimeKind: "claude-code", permissionMode: "bypassPermissions" }] })).rejects.toMatchObject({ code: "RT_INPUT" });
    await expect(compareWt({ confirmedBaseCommit: "0".repeat(40) })).rejects.toMatchObject({ code: "RT_PROFILE_CHANGED" });
    expect(mgr.store.allComparisons()).toHaveLength(0);
    expect(existsSync(join(repo, ".pi-compare"))).toBe(false);
    // 只读对比仍拒绝写权限
    await expect(compareWt({ isolation: "read-only" })).rejects.toMatchObject({ code: "RT_INPUT" });
    const { group } = await compareWt();
    await until(() => codex.turns.length === 1 && claude.turns.length === 1);
    await expect(mgr.deleteComparison(group.groupId, "t")).rejects.toMatchObject({ code: "RT_BUSY" });
    for (const t of [...codex.turns, ...claude.turns]) t.finish({ status: "completed" });
    await until(() => mgr.comparisonView(group.groupId).settled);
    await mgr.deleteComparison(group.groupId, "t");
    expect(mgr.store.comparison(group.groupId)).toBeUndefined();
    expect(mgr.store.allBindings()).toHaveLength(0);
    expect(existsSync(join(repo, ".pi-compare"))).toBe(false);
  });
});


it("archive pagination rejects changed snapshots and filter changes", async () => {
  const created = await create();
  await until(() => codex.turns.length === 1);
  codex.turns[0]!.finish({ status: "completed" });
  await until(() => mgr.store.binding(created.session.platformSessionId)!.status === "idle");
  const base = mgr.store.binding(created.session.platformSessionId)!;
  const bindings = Array.from({ length: 4 }, (_, i) => ({ ...base, platformSessionId: `arch-${i}`, title: `Archive ${i}`, archived: true }));
  vi.spyOn(mgr.store, "allBindings").mockImplementation(() => bindings);
  const first = await mgr.directory({ source: "chat", archived: "only", limit: 2 });
  expect(first.entries.map(e => e.id)).toEqual(["arch-0", "arch-1"]);
  const second = await mgr.directory({ source: "chat", archived: "only", limit: 2, cursor: first.nextCursor });
  expect(second.entries.map(e => e.id)).toEqual(["arch-2", "arch-3"]);
  expect(second.nextCursor).toBeUndefined();
  expect((await mgr.directory({ source: "chat", archived: "only", limit: 2, q: "Archive 3", cursor: first.nextCursor })).resetRequired).toBe(true);
  bindings[0]!.archived = false;
  const stale = await mgr.directory({ source: "chat", archived: "only", limit: 2, cursor: first.nextCursor });
  expect(stale.resetRequired).toBe(true);
  expect(stale.entries).toEqual([]);
  const fresh = await mgr.directory({ source: "chat", archived: "only", limit: 2 });
  expect(fresh.entries.map(e => e.id)).toEqual(["arch-1", "arch-2"]);
});

it('indexes session pictures outside the current history page without scanning unrelated files', async () => {
  const { session } = await create('codex', '图片历史');
  await until(() => codex.turns.length === 1);
  const sink = codex.turns[0]!.sink;
  sink.event(ev('old-picture', '[早期图片](/tmp/old-picture.png)'));
  for (let i = 0; i < 220; i++) sink.event(ev(`image-gap-${i}`, '普通消息'));
  sink.event(ev('new-picture', '', { kind: 'image', image: { path: '/generated/new.png', status: 'completed' } }));
  const index = await mgr.imageIndex(session.platformSessionId);
  expect(index.items.map(e => e.key)).toEqual(['old-picture', 'new-picture']);
  expect(index.items[0].seq).toBeLessThan((await mgr.messages(session.platformSessionId, { limit: 100 })).firstSeq!);
  await expect(mgr.imageIndex('missing')).rejects.toMatchObject({ code: 'RT_NOT_FOUND' });
});

it('persists and forwards a Pi browser ID and binds create idempotency to it', async () => {
  mgr.shutdown(); const pi = new FakeDriver('pi');
  const probe=pi.probe.bind(pi); pi.probe=async()=>({...await probe(),browserProfiles:[{id:'isolated',label:'临时隔离',persistent:false},{id:'work',label:'工作浏览器',persistent:true}]});
  mgr=new RuntimeSessionManager({dataDir:join(dir,'data'),drivers:{codex,'claude-code':claude,pi},skipRecovery:true});
  await mgr.probe('pi');
  const req={idempotencyKey:key(),runtimeKind:'pi' as const,workspace:ws,prompt:'hello',browserProfileId:'work',confirmedProfileVersion:mgr.profile('pi')!.checkedAt};
  const {session}=await mgr.create(req,'test');
  expect(session).toMatchObject({browserProfileId:'work'});
  await until(()=>pi.turns.length===1); expect(pi.turns[0]!.args).toMatchObject({browserProfileId:'work'});
  await expect(mgr.create({...req,browserProfileId:'isolated'},'test')).rejects.toMatchObject({code:'RT_CONFLICT'});
  await expect(create('codex','hello',{browserProfileId:'work'})).rejects.toMatchObject({code:'RT_INPUT'});
  await expect(create('pi','hello',{browserProfileId:'missing'})).rejects.toMatchObject({code:'RT_INPUT'});
  pi.turns[0]!.finish({status:'completed'});await until(()=>mgr.store.binding(session.platformSessionId)!.status==='idle');
  mgr.shutdown();mgr=new RuntimeSessionManager({dataDir:join(dir,'data'),drivers:{codex,'claude-code':claude,pi},skipRecovery:true});
  const saved=mgr.store.binding(session.platformSessionId)!;expect(saved.browserProfileId).toBe('work');
  await mgr.sendTurn(saved.platformSessionId,{idempotencyKey:key(),prompt:'continue',expectedRevision:saved.bindingRevision},'test');
  await until(()=>pi.turns.length===2);expect(pi.turns[1]!.args.browserProfileId).toBe('work');
});

it('forwards runtime-owned grant listing and revocation without creating a platform approval grant',async()=>{
  const {CommunitySessionGrants}=await import('../../pi-runtime/src/community-approval.js');
  const state=new CommunitySessionGrants(join(dir,'runtime-permissions','fixture.json'),'native/workspace/assembly');
  const a='a'.repeat(64),b='b'.repeat(64);state.add(a,{tool:'read',action:'read fixture',scope:ws});state.add(b);
  const pi=new FakeDriver('pi');
  Object.assign(pi,{permissionGrants:async(nativeId:string,options:{workspace:string;revoke?:{id?:string}})=>{
    if(!nativeId||options.workspace!==realpathSync(ws))throw new Error('Wrong native scope');
    return options.revoke?state.revoke(options.revoke.id):state.list();
  }});
  mgr.shutdown();mgr=new RuntimeSessionManager({dataDir:join(dir,'data'),drivers:{pi},skipRecovery:true});
  mgr.updateSettings({workspaceRoots:[join(dir,'work')]},'owner');await mgr.probe('pi');
  const {session}=await create('pi');await until(()=>pi.turns.length===1);
  const sid=session.platformSessionId;
  expect((await mgr.permissionGrants(sid)).grants).toHaveLength(2);
  await mgr.revokeRuntimeGrant(sid,'owner',a);expect(state.has(a)).toBe(false);expect(state.has(b)).toBe(true);
  expect(mgr.store.binding(sid)?.approvalGrant).toBeUndefined();
  await expect(mgr.revokeRuntimeGrant(sid,'owner','../escape')).rejects.toThrow(/授权/);
  await mgr.revokeRuntimeGrant(sid,'owner');expect((await mgr.permissionGrants(sid)).grants).toEqual([]);
});
