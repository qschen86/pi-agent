import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import { AttachmentStore, IMAGE_LIMITS } from "../src/attachments.js";
const dirs: string[] = [];
const store = () => { const d = mkdtempSync(join(tmpdir(), "v34-images-")); dirs.push(d); return new AttachmentStore(d); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
export const png = () => sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } }).png().toBuffer();
it("repairs only a missing JPEG end marker and still rejects missing scan data", async () => {
  const s = store();
  const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: "red" } }).jpeg().toBuffer();
  const a = await s.upload(jpeg.subarray(0, jpeg.length - 2), "image/jpeg", "phone.jpg", "o", "d");
  expect(s.read(a.attachmentId, "o").bytes).toEqual(jpeg);
  expect(a.byteSize).toBe(jpeg.length);
  await expect(s.upload(jpeg.subarray(0, jpeg.length - 10), "image/jpeg", "truncated.jpg", "o", "d")).rejects.toThrow(/损坏|解码/);
  await expect(s.upload(jpeg.subarray(0, jpeg.length - 100), "image/jpeg", "truncated.jpg", "o", "d")).rejects.toThrow(/损坏|解码/);
  const progressive = await sharp({ create: { width: 320, height: 240, channels: 3, background: "red" } }).jpeg({ progressive: true }).toBuffer();
  const secondScan = progressive.indexOf(Buffer.from([255, 218]), progressive.indexOf(Buffer.from([255, 218])) + 2);
  expect(secondScan).toBeGreaterThan(0);
  await expect(s.upload(progressive.subarray(0, secondScan), "image/jpeg", "incomplete-progressive.jpg", "o", "d")).rejects.toThrow(/完整|损坏|解码/);
  await expect(s.upload(progressive, "image/jpeg", "valid-progressive.jpg", "o", "d")).resolves.toMatchObject({ width: 320, height: 240 });
});
it("accepts a fully decodable JPEG with recoverable marker warnings while rejecting truncated pixels", async () => {
  const s = store();
  const original = await sharp({ create: { width: 320, height: 240, channels: 3, background: "red" } }).jpeg().toBuffer();
  const compatible = Buffer.concat([original.subarray(0, 2), Buffer.from([0, 0, 0, 0]), original.subarray(2)]);
  const a = await s.upload(compatible, "image/jpeg", "phone.jpg", "o", "d");
  expect(a).toMatchObject({ width: 320, height: 240, mimeType: "image/jpeg" });
  expect((await sharp(s.read(a.attachmentId, "o", true).bytes).metadata()).format).toBe("webp");
  await expect(s.upload(original.subarray(0, original.length - 100), "image/jpeg", "broken.jpg", "o", "d")).rejects.toThrow(/损坏|解码/);
});
it("preserves validated image bytes and generates a separate thumbnail; rejects foreign owners", async () => {
  const s = store(), bytes = await png(), a = await s.upload(bytes, "image/png", "<图>.png", "owner", "draft-1");
  expect(a).toMatchObject({ mimeType: "image/png", width: 32, height: 24, byteSize: bytes.length });
  expect(s.read(a.attachmentId, "owner").bytes).toEqual(bytes);
  expect((await sharp(s.read(a.attachmentId, "owner", true).bytes).metadata()).format).toBe("webp");
  expect(() => s.resolve([a.attachmentId], "other")).toThrow(/授权/);
  expect(() => s.read("../../etc/passwd", "owner")).toThrow();
});
it("rejects forged MIME, broken pixels, SVG, oversized bytes and dimensions", async () => {
  const s = store(), bytes = await png();
  await expect(s.upload(bytes, "image/jpeg", "x.jpg", "o", "d")).rejects.toThrow(/格式/);
  await expect(s.upload(bytes.subarray(0, 50), "image/png", "x.png", "o", "d")).rejects.toThrow(/损坏|解码/);
  await expect(s.upload(Buffer.from("<svg/>"), "image/svg+xml", "x.svg", "o", "d")).rejects.toThrow(/格式/);
  await expect(s.upload(Buffer.alloc(IMAGE_LIMITS.singleBytes + 1), "image/png", "x.png", "o", "d")).rejects.toThrow(/10 MiB/);
  const big = await sharp({ create: { width: 16385, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  await expect(s.upload(big, "image/png", "big.png", "o", "d")).rejects.toThrow(/尺寸/);
});
it("expires unused drafts but keeps durable message references and deletes unreferenced files", async () => {
  const s = store(), bytes = await png();
  const a = await s.upload(bytes, "image/png", "a.png", "o", "d"), b = await s.upload(bytes, "image/png", "b.png", "o", "d");
  s.attach([a.attachmentId], "o", "rt-1");
  s.cleanup(Date.now() + 25 * 3600000);
  expect(s.read(a.attachmentId, "different", false, "rt-1").bytes).toEqual(bytes);
  expect(() => s.resolve([b.attachmentId], "o")).toThrow(/过期|不存在/);
  const restored = new AttachmentStore(s.root);
  expect(restored.read(a.attachmentId, "o", false, "rt-1").bytes).toEqual(bytes);
  s.removeSession("rt-1");
  expect(() => s.read(a.attachmentId, "o")).toThrow();
});
it("enforces count and order, retains same-file separate entries, and verifies immutable content", async () => {
  const s = store(), bytes = await png(), a = await s.upload(bytes, "image/png", "a.png", "o", "d");
  expect(() => s.resolve(Array(6).fill(a.attachmentId), "o")).toThrow(/5/);
  const b = await s.upload(bytes, "image/png", "b.png", "o", "d");
  expect(b.attachmentId).not.toBe(a.attachmentId);
  expect(s.resolve([b.attachmentId, a.attachmentId], "o").map(x => x.attachmentId)).toEqual([b.attachmentId, a.attachmentId]);
  writeFileSync(join(s.root, "attachments", `${a.attachmentId}.bin`), Buffer.from("tamper"));
  expect(() => s.resolve([a.attachmentId], "o")).toThrow(/损坏/);
});
it("rejects animated PNG chunks instead of silently accepting the first frame", async () => {
  const s=store(), original=await png();
  const chunk=Buffer.alloc(20);chunk.writeUInt32BE(8,0);chunk.write("acTL",4,"ascii");chunk.writeUInt32BE(2,8);
  const animated=Buffer.concat([original.subarray(0,33),chunk,original.subarray(33)]);
  await expect(s.upload(animated,"image/png","animated.png","o","d")).rejects.toThrow(/动图/);
});
it("restores an accepted same-session reuse by another controller without granting a new session", async () => {
  const s=store(), a=await s.upload(await png(),"image/png","a.png","owner-a","d");
  s.attach([a.attachmentId],"owner-a","rt-1");
  expect(s.resolve([a.attachmentId],"owner-b","rt-1")).toHaveLength(1);
  expect(()=>s.restoreReferences([a.attachmentId],"owner-b","rt-1")).not.toThrow();
  expect(()=>s.restoreReferences([a.attachmentId],"owner-b","rt-2")).toThrow(/授权/);
});
it("records the byte layout of an undecodable JPEG so vendor trailers can be diagnosed", async () => {
  const s = store();
  const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: "red" } }).jpeg().toBuffer();
  const json = Buffer.from('vivo{"type":"fastshot"}'), len = Buffer.alloc(4); len.writeUInt32BE(json.length - 4);
  const bad = Buffer.concat([jpeg.subarray(0, jpeg.length - 40), json, len, Buffer.from("cameralbum!")]);
  const err = await s.upload(bad, "image/jpeg", "vivo.jpg", "o", "d").catch(e => e);
  expect(err.message).toMatch(/损坏|解码/);
  expect(err.decodeReason).toMatch(/lastEOI=-1/);
  expect(err.decodeReason).toContain("cameralbum!");
});

it("retains accepted deployment images across draft expiration without granting another actor access", async () => {
  const s = store(), a = await s.upload(await png(), 'image/png', 'wait.png', 'alice', 'draft');
  expect(() => s.retainDrafts([a.attachmentId], 'bob')).toThrow(/授权/);
  s.retainDrafts([a.attachmentId], 'alice');
  s.cleanup(Date.now() + 24.5 * 3600_000);
  expect(new AttachmentStore(s.root).resolve([a.attachmentId], 'alice')).toHaveLength(1);
  s.cleanup(Date.now() + 26 * 3600_000);
  expect(() => s.read(a.attachmentId, 'alice')).toThrow();
});

it("stores byte-identical uploads once (hard links) while keeping separate, independently removable entries", async () => {
  const s = store(), bytes = await png(), dir = join(s.root, "attachments");
  const a = await s.upload(bytes, "image/png", "a.png", "o", "d"), b = await s.upload(bytes, "image/png", "b.png", "other", "d2");
  expect(b.attachmentId).not.toBe(a.attachmentId);
  expect(b).toMatchObject({ originalName: "b.png", sha256: a.sha256, width: 32, height: 24 });
  for (const ext of ["bin", "webp"]) expect(statSync(join(dir, `${b.attachmentId}.${ext}`)).ino).toBe(statSync(join(dir, `${a.attachmentId}.${ext}`)).ino);
  expect(() => s.read(b.attachmentId, "o")).toThrow(/授权/);
  s.attach([a.attachmentId], "o", "rt-1");
  s.removeSession("rt-1");
  expect(() => s.read(a.attachmentId, "o")).toThrow();
  expect(s.read(b.attachmentId, "other").bytes).toEqual(bytes);
  expect((await sharp(s.read(b.attachmentId, "other", true).bytes).metadata()).format).toBe("webp");
});
it("reuses an owner's stored image by its pre-compression hash without new bytes, never across owners", async () => {
  const s = store(), bytes = await png(), source = createHash("sha256").update("original phone jpeg").digest("hex");
  const a = await s.upload(bytes, "image/png", "photo.webp", "o", "d", source);
  expect(a).not.toHaveProperty("sourceSha256");
  const r = s.reuse(source, "o", "d2")!;
  expect(r).toMatchObject({ originalName: "photo.webp", sha256: a.sha256, byteSize: a.byteSize });
  expect(r.attachmentId).not.toBe(a.attachmentId);
  expect(s.read(r.attachmentId, "o").bytes).toEqual(bytes);
  expect(s.reuse(a.sha256, "o", "d3")).toBeDefined();
  expect(s.reuse(source, "intruder", "d")).toBeUndefined();
  expect(s.reuse("0".repeat(64), "o", "d")).toBeUndefined();
  expect(() => s.reuse("not-a-hash", "o", "d")).toThrow(/哈希/);
  // Still reusable after the first entry went away, and a corrupted copy is never handed out.
  s.cleanup(Date.now() + 25 * 3600000);
  const fresh = await s.upload(bytes, "image/png", "photo.webp", "o", "d", source);
  writeFileSync(join(s.root, "attachments", `${fresh.attachmentId}.bin`), Buffer.from("tamper"));
  expect(s.reuse(source, "o", "d4")).toBeUndefined();
});
it("collapses byte-identical copies stored before sharing into links on cleanup", async () => {
  const s = store(), bytes = await png(), dir = join(s.root, "attachments");
  const a = await s.upload(bytes, "image/png", "a.png", "o", "d"), b = await s.upload(bytes, "image/png", "b.png", "o", "d");
  for (const ext of ["bin", "webp"]) { const f = join(dir, `${b.attachmentId}.${ext}`), copy = readFileSync(f); rmSync(f); writeFileSync(f, copy); }
  expect(statSync(join(dir, `${b.attachmentId}.bin`)).ino).not.toBe(statSync(join(dir, `${a.attachmentId}.bin`)).ino);
  s.cleanup();
  for (const ext of ["bin", "webp"]) expect(statSync(join(dir, `${b.attachmentId}.${ext}`)).ino).toBe(statSync(join(dir, `${a.attachmentId}.${ext}`)).ino);
  expect(s.read(b.attachmentId, "o").bytes).toEqual(bytes);
});
