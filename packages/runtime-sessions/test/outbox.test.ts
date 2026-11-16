import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeSessionManager } from "../src/manager.js";
import { FakeDriver, until, tick } from "./fake-driver.js";

let dir: string, ws: string, mgr: RuntimeSessionManager, driver: FakeDriver;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rt-outbox-")); ws = join(dir, "work"); mkdirSync(ws);
  driver = new FakeDriver("codex");
  mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver }, skipRecovery: true });
  mgr.updateSettings({ workspaceRoots: [ws] }, "local"); await mgr.probe("codex");
});
afterEach(async () => { mgr.shutdown(); await tick(35); rmSync(dir, { recursive: true, force: true }); });

const mid = () => randomUUID().replace(/-/g, "");
const binding = (id: string) => mgr.store.binding(id)!;
const prompts = () => driver.turns.map(t => t.args.prompt);

/** 首轮在运行中的会话 */
async function runningSession() {
  const { session } = await mgr.create({ idempotencyKey: `c-${randomUUID()}`, runtimeKind: "codex", workspace: ws, title: "t", prompt: "第一轮", confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "local");
  await until(() => driver.turns.length === 1);
  return session.platformSessionId;
}
/** 结束当前一轮并模拟原生记录因这轮而变化（指纹改变） */
function finish(n: number, status: "completed" | "failed" = "completed") {
  const t = driver.turns[n - 1]!;
  driver.fingerprints.set(t.nativeId, `fp-after-${n}`);
  t.finish({ status });
}

describe("outbox (排队消息)", () => {
  it("sends a new reservation that becomes due during durable session publication", async () => {
    const now = Date.now(), publish = mgr.store.createSessionOperation.bind(mgr.store);
    const clock = vi.spyOn(Date, 'now');
    const publication = vi.spyOn(mgr.store, 'createSessionOperation').mockImplementation((...args) => {
      const result = publish(...args);
      clock.mockReturnValue(now + 120000); // publication/worktree setup crossed the deadline
      return result;
    });
    try {
      await mgr.create({ idempotencyKey: `c-${randomUUID()}`, runtimeKind: 'codex', workspace: ws, prompt: '创建中到点', scheduledFor: new Date(now + 60000).toISOString(), confirmedProfileVersion: mgr.profile('codex')!.checkedAt }, 'local');
    } finally { clock.mockRestore(); publication.mockRestore(); }
    await until(() => driver.turns.length === 1);
    expect(prompts()).toEqual(['创建中到点']);
  });

  it("accepts an overdue reservation only from a previously admitted deployment submission", async () => {
    const id = await runningSession();
    const input = { messageId: mid(), prompt: '部署期间到点', scheduledFor: new Date(Date.now() - 60000).toISOString() };
    expect(() => mgr.enqueueMessage(id, input, 'local')).toThrow(/时间/);
    mgr.enqueueMessage(id, input, 'local', { admittedReservation: true } as any);
    finish(1); await until(() => driver.turns.length === 2);
    expect(prompts()).toEqual(['第一轮', '部署期间到点']);
  });

  it("does not send future reservations or block ordinary queued messages, then sends at due time", async () => {
    const id = await runningSession(), messageId = mid();
    mgr.enqueueMessage(id, { messageId, prompt: "预约", scheduledFor: new Date(Date.now() + 60000).toISOString() } as any, "local");
    mgr.enqueueMessage(id, { messageId: mid(), prompt: "普通排队" }, "local");
    finish(1); await until(() => driver.turns.length === 2);
    expect(prompts()).toEqual(["第一轮", "普通排队"]);
    finish(2); await until(() => binding(id).status === "idle");
    expect(driver.turns).toHaveLength(2);
    mgr.editQueuedMessage(id, messageId, { prompt: "预约", scheduledFor: new Date(Date.now() + 500).toISOString() }, "local");
    await until(() => driver.turns.length === 3, 6000);
    expect(prompts()[2]).toBe("预约");
    expect(binding(id).outbox).toBeUndefined();
  });

  it("atomically creates a session with a reserved first message and recovers the timer after restart", async () => {
    const input = { idempotencyKey: `c-${randomUUID()}`, runtimeKind: "codex" as const, workspace: ws, prompt: "预约首条", scheduledFor: new Date(Date.now() + 60000).toISOString(), confirmedProfileVersion: mgr.profile("codex")!.checkedAt };
    const { session } = await mgr.create(input as any, "local");
    const id = session.platformSessionId;
    expect(binding(id).turns).toHaveLength(0);
    expect(binding(id).outbox?.[0]).toMatchObject({ prompt: "预约首条", scheduledFor: input.scheduledFor });
    expect(mgr.activity().active).toHaveLength(0); // 未来预约不阻止空闲部署
    expect((await mgr.create(input as any, "local")).replayed).toBe(true);
    expect(binding(id).outbox).toHaveLength(1);
    await expect(mgr.create({ ...input, scheduledFor: new Date(Date.now() + 60000).toISOString() } as any, "local")).rejects.toMatchObject({ code: "RT_CONFLICT" });
    mgr.editQueuedMessage(id, binding(id).outbox![0]!.messageId, { prompt: "预约首条", scheduledFor: new Date(Date.now() + 500).toISOString() }, "local");
    mgr.shutdown();
    mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver } });
    await mgr.recovered;
    await until(() => driver.turns.length === 1);
    expect(prompts()).toEqual(["预约首条"]);
  });

  it("validates reservation times, allows rescheduling, forbids early steering, and cancels on archive", async () => {
    const id = await runningSession(), messageId = mid();
    expect(() => mgr.enqueueMessage(id, { messageId, prompt: "x", scheduledFor: "bad" } as any, "local")).toThrow(/时间/);
    expect(() => mgr.enqueueMessage(id, { messageId, prompt: "x", scheduledFor: new Date(Date.now() - 1000).toISOString() } as any, "local")).toThrow(/时间/);
    mgr.enqueueMessage(id, { messageId, prompt: "later", scheduledFor: new Date(Date.now() + 60000).toISOString() } as any, "local");
    await expect(mgr.steerQueuedMessage(id, messageId, "local")).rejects.toThrow(/预约/);
    const next = new Date(Date.now() + 120000).toISOString();
    mgr.editQueuedMessage(id, messageId, { prompt: "edited", scheduledFor: next } as any, "local");
    expect(binding(id).outbox![0]).toMatchObject({ prompt: "edited", scheduledFor: next });
    finish(1); await until(() => binding(id).status === "idle");
    await mgr.archive(id, true, "local");
    expect(binding(id).outbox).toBeUndefined();
    await mgr.archive(id, false, "local");
    expect(binding(id).outbox).toBeUndefined();
  });

  it("finishes previously accepted outbox messages during deployment drain without admitting new direct turns", async () => {
    const id = await runningSession();
    mgr.enqueueMessage(id, { messageId: mid(), prompt: "部署前已排队" }, "local");
    mgr.setDraining(true, true);
    await expect(mgr.sendTurn(id, { idempotencyKey: "blocked-new-turn", prompt: "新消息", expectedRevision: binding(id).bindingRevision }, "local")).rejects.toMatchObject({ code: "RT_DRAINING" });
    finish(1); await until(() => driver.turns.length === 2);
    expect(prompts()).toEqual(["第一轮", "部署前已排队"]);
    finish(2); await until(() => mgr.activity().active.length === 0);
    expect(mgr.activity()).toMatchObject({ draining: true, queued: 0, dispatching: 0, unknownOps: 0 });
  });

  it("queues while running, keeps edits and order, and sends one per completed turn without a false external-write conflict", async () => {
    const id = await runningSession();
    const [a, b, c] = [mid(), mid(), mid()];
    mgr.enqueueMessage(id, { messageId: a, prompt: "A" }, "local");
    mgr.enqueueMessage(id, { messageId: b, prompt: "B" }, "local");
    mgr.enqueueMessage(id, { messageId: c, prompt: "C" }, "local");
    // 网络重试：同一 messageId 不重复入队
    mgr.enqueueMessage(id, { messageId: a, prompt: "A" }, "local");
    expect(binding(id).outbox!.map(m => m.prompt)).toEqual(["A", "B", "C"]);
    const rev = binding(id).bindingRevision;
    mgr.editQueuedMessage(id, b, { prompt: "B2" }, "local");
    mgr.reorderQueuedMessages(id, [b, c, a], "local");
    mgr.removeQueuedMessage(id, c, "local");
    expect(binding(id).outbox!.map(m => m.prompt)).toEqual(["B2", "A"]);
    expect(binding(id).bindingRevision).toBe(rev); // 排队编辑不让发送中的版本号失效
    expect(() => mgr.reorderQueuedMessages(id, [a], "local")).toThrow(/已变化/);
    expect(mgr.activity().active.map(x => x.platformSessionId)).toContain(id);

    finish(1);
    await until(() => driver.turns.length === 2);
    expect(prompts()).toEqual(["第一轮", "B2"]);
    expect(binding(id).outbox!.map(m => m.prompt)).toEqual(["A"]);
    expect(binding(id).conflict).toBeUndefined();
    expect(() => mgr.editQueuedMessage(id, b, { prompt: "late" }, "local")).toThrow(/已发送或已撤销/);
    const user = (await mgr.messages(id, {})).events.filter(e => e.role === "user").map(e => e.text);
    expect(user).toEqual(["第一轮", "B2"]);

    finish(2);
    await until(() => driver.turns.length === 3);
    expect(prompts()[2]).toBe("A");
    expect(binding(id).outbox).toBeUndefined();
    finish(3);
    await until(() => binding(id).status === "idle");
    await tick(1700);
    expect(driver.turns).toHaveLength(3);
    expect(binding(id).conflict).toBeUndefined();
    expect(mgr.activity().active).toHaveLength(0);
  });

  it("pauses after a stop or failure and resumes on request", async () => {
    const id = await runningSession();
    mgr.enqueueMessage(id, { messageId: mid(), prompt: "next" }, "local");
    await mgr.interrupt(id, "local");
    await until(() => binding(id).status !== "running" && binding(id).status !== "stopping");
    expect(binding(id).outboxPaused?.reason).toMatch(/停止/);
    await tick(1700);
    expect(driver.turns).toHaveLength(1);
    expect(mgr.activity().active).toHaveLength(0); // 暂停的队列不挡部署

    mgr.resumeOutbox(id, "local");
    await until(() => driver.turns.length === 2);
    expect(prompts()[1]).toBe("next");
    expect(binding(id).outboxPaused).toBeUndefined();

    mgr.enqueueMessage(id, { messageId: mid(), prompt: "after failure" }, "local");
    finish(2, "failed");
    await until(() => !!binding(id).outboxPaused);
    expect(binding(id).outboxPaused!.reason).toMatch(/失败/);
    await tick(1700);
    expect(driver.turns).toHaveLength(2);
  });

  it("pauses with the send error and resumes automatically after a drain-paused restart", async () => {
    const id = await runningSession();
    mgr.enqueueMessage(id, { messageId: mid(), prompt: "during drain" }, "local");
    mgr.setDraining(true);
    finish(1);
    await until(() => !!binding(id).outboxPaused);
    expect(binding(id).outboxPaused).toMatchObject({ auto: true });
    expect(binding(id).outboxPaused!.reason).toMatch(/排空/);
    mgr.setDraining(false);
    (mgr as unknown as { resumeOutboxesAfterRestart(): void }).resumeOutboxesAfterRestart();
    await until(() => driver.turns.length === 2);
    expect(prompts()[1]).toBe("during drain");
  });

  it("binds queued images to the session, lets them be replaced, and sends them", async () => {
    const profile = mgr.profile("codex")!;
    profile.capabilities.imageInput = { status: "supported", reason: "fixture" };
    profile.models[0]!.inputModalities = ["text", "image"];
    mgr.store.saveProfile(profile);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
    const x = await mgr.attachments.upload(png, "image/png", "x.png", "local", "d1");
    const y = await mgr.attachments.upload(png, "image/png", "y.png", "local", "d1");
    const id = await runningSession();
    const m = mid();
    mgr.enqueueMessage(id, { messageId: m, prompt: "", attachmentIds: [x.attachmentId] }, "local");
    expect(binding(id).outbox![0]!.attachments!.map(a => a.originalName)).toEqual(["x.png"]);
    // 已绑定到会话：按会话可读（排队里的缩略图），且不再随草稿过期
    expect(mgr.attachments.read(x.attachmentId, "", true, id).mimeType).toBe("image/webp");
    mgr.editQueuedMessage(id, m, { prompt: "看图", attachmentIds: [y.attachmentId, x.attachmentId] }, "local");
    expect(() => mgr.editQueuedMessage(id, m, { prompt: "" }, "local")).toThrow(/不能为空/);
    finish(1);
    await until(() => driver.turns.length === 2);
    expect(driver.turns[1]!.args.prompt).toBe("看图");
    expect(driver.turns[1]!.args.images).toHaveLength(2);
    const sent = (await mgr.messages(id, {})).events.filter(e => e.role === "user").at(-1)!;
    expect(sent.attachments!.map(a => a.originalName)).toEqual(["y.png", "x.png"]);
  });

  it("validates input and limits", async () => {
    const id = await runningSession();
    expect(() => mgr.enqueueMessage(id, { messageId: "bad", prompt: "x" }, "local")).toThrow(/messageId/);
    expect(() => mgr.enqueueMessage(id, { messageId: mid(), prompt: "  " }, "local")).toThrow(/不能为空/);
    expect(() => mgr.enqueueMessage(id, { messageId: mid(), prompt: "x", effort: "ultra" }, "local")).toThrow(/推理强度/);
    for (let i = 0; i < 20; i++) mgr.enqueueMessage(id, { messageId: mid(), prompt: `m${i}` }, "local");
    expect(() => mgr.enqueueMessage(id, { messageId: mid(), prompt: "overflow" }, "local")).toThrow(/最多排队 20/);
    expect(() => mgr.removeQueuedMessage(id, mid(), "local")).toThrow(/已发送或已撤销/);
  });
});

describe("插话（运行中把排队消息送进本轮）", () => {
  const events = (id: string) => mgr.store.events(id);
  it("steers a queued message into the running turn; it leaves the queue only when delivered", async () => {
    driver.steerable = true;
    const id = await runningSession();
    const [a, b] = [mid(), mid()];
    mgr.enqueueMessage(id, { messageId: a, prompt: "A" }, "local");
    mgr.enqueueMessage(id, { messageId: b, prompt: "B" }, "local");
    await mgr.steerQueuedMessage(id, b, "local");
    const steerId = driver.turns[0]!.steers[0]!.clientMessageId;
    expect(steerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(driver.turns[0]!.steers).toEqual([{ clientMessageId: steerId, prompt: "B" }]);
    expect(binding(id).outbox!.find(m => m.messageId === b)!.steering).toMatchObject({ actor: "local", turnNo: 1, clientMessageId: steerId });
    // 正在插话的这条不能改也不能撤销；重复点击不重复发送
    expect(() => mgr.editQueuedMessage(id, b, { prompt: "B2" }, "local")).toThrow(/正在插话/);
    expect(() => mgr.removeQueuedMessage(id, b, "local")).toThrow(/正在插话/);
    await mgr.steerQueuedMessage(id, b, "local");
    expect(driver.turns[0]!.steers).toHaveLength(1);

    driver.turns[0]!.sink.steerDelivered!(steerId);
    expect(binding(id).outbox!.map(m => m.prompt)).toEqual(["A"]);
    expect(events(id).find(e => e.key === `user:${steerId}`)).toMatchObject({ role: "user", text: "B", turnNo: 1 });

    finish(1);
    await until(() => driver.turns.length === 2);
    expect(prompts()).toEqual(["第一轮", "A"]);
  });

  it("a steer that misses the turn goes back to the queue, is explained, and is sent next as usual", async () => {
    driver.steerable = true;
    const id = await runningSession();
    const a = mid();
    mgr.enqueueMessage(id, { messageId: a, prompt: "A" }, "local");
    await mgr.steerQueuedMessage(id, a, "local");
    finish(1);
    await until(() => driver.turns.length === 2);
    expect(prompts()).toEqual(["第一轮", "A"]);
    expect(binding(id).outbox).toBeUndefined();
    expect(events(id).some(e => e.kind === "notice" && /插话没赶上第 1 轮/.test(e.text ?? ""))).toBe(true);
  });

  it("keeps the message queued when the runtime refuses, and refuses when idle or unsupported", async () => {
    driver.steerable = true; driver.steerFail = "本轮已在结束";
    const id = await runningSession();
    const a = mid();
    mgr.enqueueMessage(id, { messageId: a, prompt: "A" }, "local");
    await expect(mgr.steerQueuedMessage(id, a, "local")).rejects.toMatchObject({ code: "RT_STEER_FAILED" });
    expect(binding(id).outbox![0]).toMatchObject({ messageId: a });
    expect(binding(id).outbox![0]!.steering).toBeUndefined();

    driver.steerable = false; driver.steerFail = undefined;
    const other = await (async () => { const { session } = await mgr.create({ idempotencyKey: `c-${randomUUID()}`, runtimeKind: "codex", workspace: ws, title: "t2", prompt: "x", confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "local"); await until(() => driver.turns.length === 2); return session.platformSessionId; })();
    const b = mid();
    mgr.enqueueMessage(other, { messageId: b, prompt: "B" }, "local");
    await expect(mgr.steerQueuedMessage(other, b, "local")).rejects.toThrow(/不支持插话/);

    // 本轮结束后（队列暂停、会话空闲）不能插话
    mgr.holdOutboxForEdit(id, "local");
    finish(1);
    await until(() => binding(id).status === "idle");
    await expect(mgr.steerQueuedMessage(id, a, "local")).rejects.toMatchObject({ code: "RT_STEER_UNAVAILABLE" });
  });
});
