import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInvocationPort, ModelResponse } from "@pi-agent/model-port";
import { RuntimeSessionManager } from "../src/manager.js";
import { SESSION_TITLE_CONFIG, SessionTitleWorker, validateSessionTitle } from "../src/session-title.js";
import { sessionTitlePrompt } from "../src/session-title-prompt.js";
import { FakeDriver, until, tick } from "./fake-driver.js";

const response = (title = "生成会话摘要标题"): ModelResponse => ({
  text: JSON.stringify({ title, description: "在平台层生成首条消息的摘要标题" }), model: "deepseek-flash", durationMs: 1,
  usage: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 120 }
});
let dir: string, ws: string, mgr: RuntimeSessionManager, driver: FakeDriver;
let port: ModelInvocationPort & { complete: ReturnType<typeof vi.fn> };
const managers: RuntimeSessionManager[] = [];
const workers: SessionTitleWorker[] = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rt-title-")); ws = join(dir, "work"); mkdirSync(ws);
  driver = new FakeDriver("codex"); port = { complete: vi.fn(async () => response()) };
  mgr = make(); mgr.updateSettings({ workspaceRoots: [ws] }, "test"); await mgr.probe("codex");
});
function make() {
  const m = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver }, skipRecovery: true, titlePort: port });
  managers.push(m); return m;
}
afterEach(async () => {
  workers.splice(0).forEach(w => w.stop()); managers.splice(0).forEach(m => m.shutdown());
  await tick(35); rmSync(dir, { recursive: true, force: true });
});
async function create(extra: Record<string, unknown> = {}) {
  return mgr.create({ idempotencyKey: `title-${randomUUID()}`, runtimeKind: "codex", workspace: ws,
    prompt: "引用待办记录（记于 2026-10-11 22:49）：\n请在平台层生成会话摘要标题", confirmedProfileVersion: mgr.profile("codex")!.checkedAt, ...extra }, "test");
}

describe("platform title generation", () => {
  it("does not wait for title completion; persists and notifies the shared title without changing activity", async () => {
    let resolve!: (r: ModelResponse) => void;
    port.complete.mockImplementation(() => new Promise<ModelResponse>(r => { resolve = r; }));
    const { session } = await create(); const id = session.platformSessionId;
    expect(session.title).toBe("正在生成标题…");
    await until(() => driver.turns.length === 1 && port.complete.mock.calls.length === 1);
    const before = structuredClone(mgr.store.binding(id)!);
    const sessionChanged = vi.fn(), directoryChanged = vi.fn();
    mgr.on("session", sessionChanged); mgr.on("directory", directoryChanged);
    resolve(response()); await until(() => mgr.store.binding(id)?.titleSource === "generated");
    const after = mgr.store.binding(id)!;
    expect(after.title).toBe("生成会话摘要标题"); expect(after.lastActivityAt).toEqual(before.lastActivityAt);
    expect(after.bindingRevision).toBe(before.bindingRevision);
    expect(after.titleGeneration).toMatchObject({ state: "succeeded", attempts: 1, model: "deepseek-flash" });
    expect(after.titleGeneration?.owner).toBeUndefined();
    expect(sessionChanged).toHaveBeenCalledWith({ platformSessionId: id }); expect(directoryChanged).toHaveBeenCalled();
    expect((await mgr.directory({ source: "chat", includeHistory: false })).entries[0].title).toBe(after.title);
    expect((await mgr.view(id)).session.title).toBe(after.title);
    expect(port.complete).toHaveBeenCalledWith(SESSION_TITLE_CONFIG, expect.objectContaining({ prompt: sessionTitlePrompt(session.turns[0].promptPreview + "") }));
  });

  it("pins DeepSeek Flash non-thinking and copies the Codex rules; only first user text is sent", async () => {
    const { session } = await create(); await until(() => session.titleGeneration?.state === "succeeded" || mgr.store.binding(session.platformSessionId)?.titleSource === "generated");
    const [config, call] = port.complete.mock.calls[0];
    expect(config).toMatchObject({ provider: "deepseek", model: "deepseek-flash", thinking: "off", role: "sessionTitle" });
    expect(call.prompt).toContain("Generate a concise UI title (up to 36 characters)");
    expect(call.prompt).toContain("- Write the title in the user's locale.");
    expect(call.prompt).toContain("User prompt:\n引用待办记录");
    expect(call.images).toBeUndefined(); expect(driver.startCalls).toBe(1);
  });

  it("preserves manual titles and leaves project/room/compare scopes outside automatic enrolment", async () => {
    const { session } = await create({ title: "手动指定标题" });
    await until(() => driver.turns.length === 1); await tick(30);
    expect(session.titleGeneration).toBeUndefined(); expect(port.complete).not.toHaveBeenCalled();
    driver.turns[0].sink.nativeSession(driver.turns[0].nativeId, { title: "原生名称", modelSource: "test" });
    expect(mgr.store.binding(session.platformSessionId)?.title).toBe("手动指定标题");
    const { session: project } = await create({ projectRef: "p-1" });
    expect(project.titleSource).toBe("prompt"); expect(project.titleGeneration).toBeUndefined();
  });

  it.each(["user", "native"] as const)("a late generated result cannot overwrite a %s title", async source => {
    let resolve!: (r: ModelResponse) => void;
    port.complete.mockImplementation(() => new Promise<ModelResponse>(r => { resolve = r; }));
    const { session } = await create(); await until(() => !!resolve && driver.turns.length === 1);
    if (source === "native") driver.turns[0].sink.nativeSession(driver.turns[0].nativeId, { title: "原生正式标题", modelSource: "test" });
    else mgr.store.updateBinding(session.platformSessionId, b => { b.title = "手动标题"; b.titleSource = "user"; });
    resolve(response()); await tick(25);
    expect(mgr.store.binding(session.platformSessionId)?.title).toBe(source === "native" ? "原生正式标题" : "手动标题");
  });

  it("history previews do not replace generated summaries; a real native name does", async () => {
    const { session } = await create(); await until(() => mgr.store.binding(session.platformSessionId)?.titleSource === "generated" && driver.turns.length === 1);
    driver.reads.set(driver.turns[0].nativeId, { events: [], usage: [], status: "unknown", coverage: "complete", notes: [], title: "第一条消息预览", titleKind: "preview" });
    await mgr.backfill(session.platformSessionId);
    expect(mgr.store.binding(session.platformSessionId)?.title).toBe("生成会话摘要标题");
    driver.reads.get(driver.turns[0].nativeId)!.titleKind = "name";
    await mgr.backfill(session.platformSessionId);
    expect(mgr.store.binding(session.platformSessionId)?.titleSource).toBe("native");
  });

  it("reads first-turn native title metadata without loading transcript history", async () => {
    const readTitle = vi.fn(async () => ({ title: "原生首轮摘要", titleKind: "summary" as const }));
    Object.assign(driver, { readTitle });
    const { session } = await create();
    await until(() => mgr.store.binding(session.platformSessionId)?.titleSource === "generated" && driver.turns.length === 1);
    driver.turns[0].finish({ status: "completed" });
    await until(() => mgr.store.binding(session.platformSessionId)?.title === "原生首轮摘要");
    expect(readTitle).toHaveBeenCalledWith(driver.turns[0].nativeId, { workspace: session.workspace });
    expect(driver.readCalls).toBe(0);
  });

  it("failed metadata calls are bounded to two attempts, survive restart and leave chat running", async () => {
    port.complete.mockRejectedValue(new Error("provider unavailable"));
    const { session } = await create();
    // 首次 + 一次修复共 2 次调用都在同一次领取内用掉，失败后直接落到 fallback。
    await until(() => mgr.store.binding(session.platformSessionId)?.titleGeneration?.state === "failed");
    expect(port.complete).toHaveBeenCalledTimes(2);
    // Backfill changes source metadata, but the first message retains its client key.
    const user = mgr.store.events(session.platformSessionId).find(e => e.role === "user")!;
    mgr.store.upsertEvent(session.platformSessionId, { ...user, source: "history" });
    mgr.shutdown(); mgr = make();
    await until(() => mgr.store.binding(session.platformSessionId)?.titleGeneration?.state === "failed");
    expect(port.complete).toHaveBeenCalledTimes(2);
    expect(mgr.store.binding(session.platformSessionId)).toMatchObject({ title: "新会话", titleSource: "fallback", status: "running" });
    mgr.shutdown(); mgr = make(); await tick(1_050); expect(port.complete).toHaveBeenCalledTimes(2);
  });

  it("expired running leases recover without resetting persisted attempts", async () => {
    let resolve!: (r: ModelResponse) => void;
    port.complete.mockImplementationOnce(() => new Promise<ModelResponse>(r => { resolve = r; }));
    const { session } = await create(); await until(() => !!resolve);
    mgr.shutdown(); mgr.store.updateBinding(session.platformSessionId, b => { b.titleGeneration!.leaseUntil = 0; });
    mgr = make(); await until(() => mgr.store.binding(session.platformSessionId)?.titleSource === "generated");
    expect(mgr.store.binding(session.platformSessionId)?.titleGeneration?.attempts).toBe(2);
    resolve(response("旧调用结果")); await tick(20);
    expect(mgr.store.binding(session.platformSessionId)?.title).toBe("生成会话摘要标题");
  });

  it("two workers atomically claim one durable task; replayed creation does not invoke twice", async () => {
    let resolve!: (r: ModelResponse) => void;
    port.complete.mockImplementation(() => new Promise<ModelResponse>(r => { resolve = r; }));
    const { session } = await create({ idempotencyKey: "title-replay" });
    await create({ idempotencyKey: "title-replay" });
    const other = new SessionTitleWorker(mgr.store, port, () => {}, () => false); workers.push(other);
    other.wake(); await until(() => !!resolve); await tick(20);
    expect(port.complete).toHaveBeenCalledTimes(1); resolve(response());
  });

  it("rejects malformed or long titles and recovers on the next finite attempt", async () => {
    port.complete.mockResolvedValueOnce(response("x".repeat(37))).mockResolvedValue(response("修复标题长度"));
    const { session } = await create(); await until(() => mgr.store.binding(session.platformSessionId)?.titleSource === "generated");
    expect(port.complete).toHaveBeenCalledTimes(2); expect(mgr.store.binding(session.platformSessionId)?.title).toBe("修复标题长度");
    expect(validateSessionTitle({ title: "# 标题", description: "内容" })).not.toEqual([]);
  });

  it("keeps a valid title when the model returns an over-long description", async () => {
    const longDescription = "Review session rt-186196cacf5a4eab PWA architecture performance optimization analysis and assess remaining gains";
    expect(Array.from(longDescription).length).toBeGreaterThan(100);
    port.complete.mockResolvedValue({
      text: JSON.stringify({ title: "评估 PWA 性能优化分析", description: longDescription }), model: "deepseek-flash", durationMs: 1,
      usage: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 120 }
    });
    const { session } = await create();
    await until(() => mgr.store.binding(session.platformSessionId)?.titleSource === "generated");
    expect(mgr.store.binding(session.platformSessionId)?.title).toBe("评估 PWA 性能优化分析");
    // 摘要超长只截断，不作废标题，也不触发修复重试。
    expect(port.complete).toHaveBeenCalledTimes(1);
    const v: { title: string; description: string } = { title: "合格标题", description: "x".repeat(120) };
    expect(validateSessionTitle(v)).toEqual([]);
    expect(v.description).toHaveLength(100);
  });

  it("generates the title from a scheduled first message before the first turn exists", async () => {
    const scheduledFor = new Date(Date.now() + 60_000).toISOString();
    const { session } = await create({ prompt: "预约：一小时后检查部署结果", scheduledFor });
    const id = session.platformSessionId;
    expect(session.turns).toEqual([]);
    expect(session.outbox?.[0]).toMatchObject({ prompt: "预约：一小时后检查部署结果", scheduledFor });
    await until(() => mgr.store.binding(id)?.titleSource === "generated");
    expect(mgr.store.binding(id)?.title).toBe("生成会话摘要标题");
    expect(port.complete).toHaveBeenCalledTimes(1);
    expect(port.complete.mock.calls[0]![1].prompt).toContain("预约：一小时后检查部署结果");
    expect(driver.startCalls).toBe(0);
    // 到点发出后仍是同一段文本，不再多调一次模型。
    mgr.store.updateBinding(id, b => { b.outbox![0]!.scheduledFor = new Date(Date.now() - 1_000).toISOString(); });
    mgr.resumeOutbox(id, "test");
    await until(() => driver.turns.length === 1);
    await tick(30);
    expect(mgr.store.binding(id)?.title).toBe("生成会话摘要标题");
    expect(port.complete).toHaveBeenCalledTimes(1);
  });

  it("regenerates after the scheduled message is edited, and resets when it is removed", async () => {
    port.complete.mockResolvedValueOnce(response("旧的预约标题")).mockResolvedValue(response("新的预约标题"));
    const scheduledFor = new Date(Date.now() + 60_000).toISOString();
    const { session } = await create({ prompt: "旧预约内容", scheduledFor });
    const id = session.platformSessionId, messageId = mgr.store.binding(id)!.outbox![0]!.messageId;
    await until(() => mgr.store.binding(id)?.title === "旧的预约标题");
    mgr.editQueuedMessage(id, messageId, { prompt: "新预约内容", scheduledFor }, "test");
    await until(() => mgr.store.binding(id)?.title === "新的预约标题");
    expect(port.complete).toHaveBeenCalledTimes(2);
    expect(port.complete.mock.calls[1]![1].prompt).toContain("新预约内容");
    expect(mgr.store.binding(id)?.titleGeneration).toMatchObject({ state: "succeeded", attempts: 1 });
    // 撤销唯一一条预约后会话是空的：回到中性占位，不保留已经不存在的主题，也不再调用模型。
    mgr.removeQueuedMessage(id, messageId, "test");
    expect(mgr.store.binding(id)).toMatchObject({ title: "新会话", titleSource: "fallback" });
    expect(mgr.store.binding(id)?.titleGeneration).toMatchObject({ state: "failed", errorCode: "TITLE_EMPTY_INPUT" });
    await tick(30);
    expect(port.complete).toHaveBeenCalledTimes(2);
    // 重新排队首条消息时按新内容再生成一次。
    mgr.enqueueMessage(id, { messageId: "retry-queue-0001", prompt: "重新预约的内容" }, "test");
    await until(() => mgr.store.binding(id)?.title === "新的预约标题" && mgr.store.binding(id)?.titleSource === "generated" && port.complete.mock.calls.length === 3);
    expect(port.complete.mock.calls[2]![1].prompt).toContain("重新预约的内容");
  });

  it("resets a scheduled-only title when archiving cancels the reservation", async () => {
    port.complete.mockResolvedValue(response("预约归档标题"));
    const { session } = await create({ prompt: "待归档的预约", scheduledFor: new Date(Date.now() + 60_000).toISOString() });
    const id = session.platformSessionId;
    await until(() => mgr.store.binding(id)?.titleSource === "generated");
    await mgr.archive(id, true, "test");
    expect(mgr.store.binding(id)).toMatchObject({ title: "新会话", titleSource: "fallback", archived: true });
    expect(mgr.store.binding(id)?.outbox).toBeUndefined();
    expect(port.complete).toHaveBeenCalledTimes(1);
  });

  it("retries an empty-input title failure once the deferred first message is dispatched", async () => {
    // 旧数据：预约创建时还没有首条消息事件，标题任务以空输入失败；升级后到点发送，按这条消息补生成一次。
    port.complete.mockResolvedValue(response("补生成的标题"));
    const scheduledFor = new Date(Date.now() + 60_000).toISOString();
    const { session } = await create({ prompt: "补生成的首条内容", scheduledFor });
    const id = session.platformSessionId;
    await until(() => mgr.store.binding(id)?.titleSource === "generated");
    mgr.store.updateBinding(id, b => {
      b.title = "新会话"; b.titleSource = "fallback";
      b.titleGeneration = { ...b.titleGeneration!, state: "failed", errorCode: "TITLE_EMPTY_INPUT", attempts: 1 };
      delete b.titleGeneration.owner; delete b.titleGeneration.leaseUntil;
    });
    port.complete.mockClear();
    mgr.store.updateBinding(id, b => { b.outbox![0]!.scheduledFor = new Date(Date.now() - 1_000).toISOString(); });
    mgr.resumeOutbox(id, "test");
    await until(() => mgr.store.binding(id)?.title === "补生成的标题");
    expect(port.complete).toHaveBeenCalledTimes(1);
    expect(port.complete.mock.calls[0]![1].prompt).toContain("补生成的首条内容");
  });
});
