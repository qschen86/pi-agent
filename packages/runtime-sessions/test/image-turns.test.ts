import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { RuntimeSessionManager } from "../src/manager.js";
import { FakeDriver, until, tick } from "./fake-driver.js";
const cleanups: Array<() => void> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) c(); await tick(50); });
async function setup(kind: "codex" | "claude-code" = "codex") {
  const dir = mkdtempSync(join(tmpdir(), "v34-turns-")), ws = join(dir, "ws"); mkdirSync(ws);
  const driver = new FakeDriver(kind), mgr = new RuntimeSessionManager({ dataDir: dir, drivers: { [kind]: driver }, skipRecovery: true });
  cleanups.push(() => { mgr.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  mgr.updateSettings({ workspaceRoots: [ws] }, "local"); await mgr.probe(kind);
  const profile = mgr.profile(kind)!;
  profile.capabilities.imageInput = { status: "supported", reason: "fixture protocol" };
  profile.models[0]!.inputModalities = ["text", "image"];
  mgr.store.saveProfile(profile);
  const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: "blue" } }).png().toBuffer();
  const a = await mgr.attachments.upload(bytes, "image/png", "a.png", "local", "d");
  const b = await mgr.attachments.upload(bytes, "image/png", "b.png", "local", "d");
  return { mgr, driver, dir, ws, a, b, profile };
}
it("sends image-only first and follow-up turns, keeps attachment history and rejects mutated retries", async () => {
  const t = await setup();
  const input = { runtimeKind: "codex" as const, workspace: t.ws, prompt: "", attachmentIds: [t.a.attachmentId], idempotencyKey: "image-create-1", confirmedProfileVersion: t.profile.checkedAt };
  const first = await t.mgr.create(input, "local"); await until(() => t.driver.turns.length === 1);
  expect(t.driver.turns[0]!.args.images).toEqual([{ mimeType: "image/png", data: t.mgr.attachments.read(t.a.attachmentId, "local").bytes.toString("base64"), sha256: t.a.sha256 }]);
  expect((await t.mgr.messages(first.session.platformSessionId, {})).events.find(e => e.role === "user")?.attachments?.[0]?.attachmentId).toBe(t.a.attachmentId);
  expect((await t.mgr.create(input, "local")).replayed).toBe(true);
  await expect(t.mgr.create({ ...input, prompt: "changed" }, "local")).rejects.toThrow(/idempotencyKey/);
  t.driver.turns[0]!.finish({ status: "completed" }); await until(() => first.session.status === "idle");
  const send = { prompt: "", attachmentIds: [t.a.attachmentId, t.b.attachmentId], idempotencyKey: "image-followup-1", expectedRevision: first.session.bindingRevision };
  await t.mgr.sendTurn(first.session.platformSessionId, send, "local");
  await until(() => t.driver.turns.length === 2);
  expect(t.driver.turns[1]!.args.images).toHaveLength(2);
  await expect(t.mgr.sendTurn(first.session.platformSessionId, { ...send, attachmentIds: [t.b.attachmentId, t.a.attachmentId] }, "local")).rejects.toThrow(/idempotencyKey/);
  t.driver.turns[1]!.finish({ status: "completed" });
});
it("refuses Claude native dimension and encoded-byte limits before accepting or clearing the draft", async () => {
  const t=await setup("claude-code");
  const wide=await sharp({create:{width:8001,height:1,channels:3,background:"red"}}).png().toBuffer();
  const large=await sharp(randomBytes(1800*1500*3),{raw:{width:1800,height:1500,channels:3}}).png().toBuffer();
  for(const [bytes,expected] of [[wide,/8000/],[large,/base64|编码/]] as const) {
    const a=await t.mgr.attachments.upload(bytes,"image/png","native-limit.png","local","d");
    await expect(t.mgr.create({runtimeKind:"claude-code",workspace:t.ws,prompt:"read image",attachmentIds:[a.attachmentId],idempotencyKey:a.attachmentId,confirmedProfileVersion:t.profile.checkedAt},"local")).rejects.toThrow(expected);
    expect(t.mgr.attachments.read(a.attachmentId,"local").bytes.equals(bytes)).toBe(true);
  }
  expect(t.driver.turns).toHaveLength(0); expect(t.mgr.store.allOperations()).toHaveLength(0);
});
it("refuses unsupported model and foreign attachments without dispatching a text fallback", async () => {
  const t = await setup(), input = { runtimeKind: "codex" as const, workspace: t.ws, prompt: "look", attachmentIds: [t.a.attachmentId], idempotencyKey: "image-create-2", confirmedProfileVersion: t.profile.checkedAt };
  await expect(t.mgr.create(input, "other")).rejects.toThrow(/授权/);
  t.profile.models[0]!.inputModalities = ["text"];
  t.mgr.store.saveProfile(t.profile);
  await expect(t.mgr.create(input, "local")).rejects.toThrow(/图片/);
  expect(t.driver.turns).toHaveLength(0);
});
it("recovers publication-before-event crashes and protects accepted images past draft TTL", async () => {
  const t = await setup();
  const realEvent = t.mgr.store.upsertEvent.bind(t.mgr.store);
  t.mgr.store.upsertEvent = (() => { throw new Error("simulated crash after publication"); }) as any;
  await expect(t.mgr.create({runtimeKind:"codex",workspace:t.ws,prompt:"look",attachmentIds:[t.a.attachmentId],idempotencyKey:"crash-image-1",confirmedProfileVersion:t.profile.checkedAt},"local")).rejects.toThrow(/simulated crash/);
  t.mgr.store.upsertEvent = realEvent;
  const id = t.mgr.store.allOperations().find(o=>o.idempotencyKey==="crash-image-1")!.platformSessionId;
  // Simulate publication before the ref writer as well, and a delayed host restart.
  const fs = await import("node:fs"); const file=join(t.mgr.attachments.root,"attachments",`${t.a.attachmentId}.json`);
  const meta=JSON.parse(fs.readFileSync(file,"utf8")); meta.sessions=[]; meta.expiresAt=new Date(Date.now()-1000).toISOString(); fs.writeFileSync(file,JSON.stringify(meta));
  t.mgr.shutdown();
  const driver = new FakeDriver("codex"), recovered = new RuntimeSessionManager({dataDir:t.dir,drivers:{codex:driver}});
  cleanups.unshift(()=>recovered.shutdown());
  await recovered.recovered; await until(()=>driver.turns.length===1);
  expect(driver.turns[0]!.args.images).toHaveLength(1);
  expect((await recovered.messages(id,{})).events.filter(e=>e.role==="user")).toHaveLength(1);
  expect((await recovered.messages(id,{})).events.find(e=>e.role==="user")?.attachments?.[0]?.attachmentId).toBe(t.a.attachmentId);
  driver.turns[0]!.finish({status:"completed"});
});
