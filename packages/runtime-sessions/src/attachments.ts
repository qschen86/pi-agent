import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

export const IMAGE_LIMITS = { singleBytes: 10 * 1024 ** 2, totalBytes: 20 * 1024 ** 2, count: 5, pixels: 40_000_000, side: 16384, ttlMs: 24 * 3600000 };
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";
export interface ImageAttachment { attachmentId: string; originalName: string; mimeType: ImageMime; byteSize: number; width: number; height: number; sha256: string; expiresAt: string }
/** sourceSha256：浏览器压缩前原文件的哈希，用于同一张图再次添加时免上传。 */
interface Record extends ImageAttachment { owner: string; draftId: string; sessions: string[]; sourceSha256?: string }
export interface DriverImage { mimeType: ImageMime; data: string; sha256: string }
export class AttachmentError extends Error {
  readonly code = "RT_ATTACHMENT";
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 410 | 413 = 400, readonly decodeReason?: string) { super(message); }
}
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const SHA256 = /^[a-f0-9]{64}$/;

/** Platform-private immutable originals, derived previews and durable owner/session references. */
export class AttachmentStore {
  readonly root: string;
  private readonly dir: string;
  constructor(root: string) { this.root = root; this.dir = join(root, "attachments"); mkdirSync(this.dir, { recursive: true, mode: 0o700 }); }
  private file(id: string, suffix: string): string {
    if (!/^img-[a-f0-9]{32}$/.test(id)) throw new AttachmentError("图片不存在", 404);
    return join(this.dir, `${id}.${suffix}`);
  }
  private record(id: string): Record {
    const file = this.file(id, "json");
    if (!existsSync(file)) throw new AttachmentError("图片已过期或不存在，请重新添加", 410);
    return JSON.parse(readFileSync(file, "utf8")) as Record;
  }
  private save(r: Record): void {
    const f = this.file(r.attachmentId, "json"), t = `${f}.tmp-${randomUUID()}`;
    writeFileSync(t, JSON.stringify(r), { mode: 0o600 }); renameSync(t, f);
  }
  private public(r: Record): ImageAttachment { const { owner: _o, draftId: _d, sessions: _s, sourceSha256: _h, ...meta } = r; return meta; }
  /** Same bytes share one inode: each attachment keeps its own `${id}.bin` name (older releases still read it),
   *  but duplicates are hard links, so storage is paid once and removing one entry never affects another. */
  private share(from: string, to: string): void {
    try { linkSync(from, to); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e; copyFileSync(from, to); }
  }
  /** An existing record whose stored original still verifies against its hash; never trusts a record alone. */
  private intact(r: Record): boolean {
    try {
      const bin = this.file(r.attachmentId, "bin");
      if (!existsSync(this.file(r.attachmentId, "webp")) || statSync(bin).size !== r.byteSize) return false;
      return hash(readFileSync(bin)) === r.sha256;
    } catch { return false; }
  }
  private create(base: Record, name: string, owner: string, draftId: string, sourceSha256?: string): Record {
    const id = `img-${randomUUID().replace(/-/g, "")}`;
    const r: Record = { attachmentId: id, originalName: name.slice(0, 200), mimeType: base.mimeType, byteSize: base.byteSize, width: base.width, height: base.height, sha256: base.sha256, owner, draftId, sessions: [], expiresAt: new Date(Date.now() + IMAGE_LIMITS.ttlMs).toISOString(), ...(sourceSha256 ? { sourceSha256 } : {}) };
    try { for (const ext of ["bin", "webp"]) this.share(this.file(base.attachmentId, ext), this.file(id, ext)); this.save(r); }
    catch (e) { this.remove(id); throw e; }
    return r;
  }
  /** Re-adding an image this owner already uploaded: a new draft entry over the stored bytes, no transfer.
   *  Matches the browser's pre-compression hash or the stored bytes' hash; scoped to the owner so a known
   *  hash never grants access to someone else's image. Returns undefined on a miss (caller uploads). */
  reuse(sha256: string, owner: string, draftId: string): ImageAttachment | undefined {
    if (!SHA256.test(sha256)) throw new AttachmentError("图片哈希格式不正确");
    if (!owner || !draftId || draftId.length > 120) throw new AttachmentError("缺少图片草稿标识");
    const candidates = this.all().filter(r => r.owner === owner && (r.sourceSha256 === sha256 || r.sha256 === sha256)).sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt));
    for (const base of candidates) {
      if (!this.intact(base)) continue;
      try { return this.public(this.create(base, base.originalName, owner, draftId, base.sourceSha256)); } catch { /* removed meanwhile: try the next one */ }
    }
    return undefined;
  }
  async upload(bytes: Buffer, mime: string, name: string, owner: string, draftId: string, sourceSha256?: string): Promise<ImageAttachment> {
    if (bytes.length > IMAGE_LIMITS.singleBytes) throw new AttachmentError("单图不能超过 10 MiB", 413);
    if (!bytes.length || !["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new AttachmentError("只支持 PNG、JPEG、静态 WebP 格式");
    if (!owner || !draftId || draftId.length > 120) throw new AttachmentError("缺少图片草稿标识");
    const signature = bytes.subarray(0, 12);
    const format = signature.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png" : signature[0] === 255 && signature[1] === 216 ? "jpeg" : signature.toString("ascii",0,4) === "RIFF" && signature.toString("ascii",8,12) === "WEBP" ? "webp" : "";
    if (`image/${format}` !== mime) throw new AttachmentError("图片内容与声明格式不符");
    const source = sourceSha256 && SHA256.test(sourceSha256) ? sourceSha256 : undefined;
    // Identical bytes were already validated and decoded once: link to them instead of decoding and storing again.
    const digest = hash(bytes);
    for (const base of this.all().filter(r => r.sha256 === digest && r.mimeType === mime)) {
      if (!this.intact(base)) continue;
      try {
        const r = this.create(base, name, owner, draftId, source);
        console.info("[image-upload] " + JSON.stringify({ at: new Date().toISOString(), stage: "deduplicated", attachmentId: r.attachmentId, sharedWith: base.attachmentId, bytes: r.byteSize }));
        return this.public(r);
      } catch { /* removed meanwhile */ }
    }
    if (format === "png") {
      for (let off = 8; off + 12 <= bytes.length;) {
        const n = bytes.readUInt32BE(off);
        if (bytes.toString("ascii", off + 4, off + 8) === "acTL") throw new AttachmentError("不支持动图格式");
        if (n > bytes.length - off - 12) break;
        off += n + 12;
      }
    }
    const decode = async (input: Buffer, strict = false) => {
      // JPEG marker warnings can accompany intact pixels. Repair attempts use
      // warning-level validation to reject incomplete scan data, including warnings.
      const img = sharp(input, { limitInputPixels: IMAGE_LIMITS.pixels, failOn: format === "jpeg" && !strict ? "error" : "warning" });
      const m = await img.metadata();
      // A progressive JPEG can render after its first scan while later scans are
      // missing. Strict decoding alone cannot prove its content is complete.
      if (strict && m.isProgressive) throw new AttachmentError("渐进式 JPEG 数据不完整，无法自动修复，请重新导出图片");
      if (m.format !== format || (m.pages ?? 1) > 1) throw new AttachmentError("不支持动图或多页图片格式");
      const width = m.width ?? 0, height = m.height ?? 0;
      if (!width || !height || width > IMAGE_LIMITS.side || height > IMAGE_LIMITS.side || width * height > IMAGE_LIMITS.pixels) throw new AttachmentError("图片尺寸超限（单边 16384，最多 40000000 像素）", 413);
      await img.clone().raw().toBuffer();
      const thumb = await img.rotate().resize(320, 240, { fit: "inside", withoutEnlargement: true }).webp().toBuffer();
      return { width, height, thumb };
    };
    let result: Awaited<ReturnType<typeof decode>>, endMarkerRestored = false;
    try {
      try { result = await decode(bytes); }
      catch (e) {
        if (e instanceof AttachmentError || format !== "jpeg" || !/premature end of JPEG image/.test(String(e)) || bytes.subarray(-2).equals(Buffer.from([255, 217]))) throw e;
        const repaired = Buffer.concat([bytes, Buffer.from([255, 217])]);
        if (repaired.length > IMAGE_LIMITS.singleBytes) throw new AttachmentError("单图不能超过 10 MiB", 413);
        // Adding EOI is lossless only if all scan data is present. No permissive
        // decoding or fabricated pixels: reject any warning in the repaired image.
        result = await decode(repaired, true);
        bytes = repaired; endMarkerRestored = true;
      }
    } catch (e) {
      if (e instanceof AttachmentError) throw e;
      // Byte layout facts only (no pixels): where the last end marker sits and what trails it,
      // so vendor trailers (e.g. vivo "...cameralbum!") can be told apart from truncation.
      const eoi = bytes.lastIndexOf(Buffer.from([255, 217])), tail = bytes.subarray(-24);
      const layout = ` | len=${bytes.length} lastEOI=${eoi} tailHex=${tail.toString("hex")} tailText=${JSON.stringify(tail.toString("latin1").replace(/[^\x20-\x7e]/g, "."))}`;
      throw new AttachmentError(/pixel limit/i.test(String(e)) ? "图片尺寸超限（最多 40000000 像素）" : "图片损坏或无法解码", 400, String(e).slice(0, 300) + layout);
    }
    const { width, height, thumb } = result;
    const id = `img-${randomUUID().replace(/-/g, "")}`;
    const r: Record = { attachmentId: id, originalName: name.slice(0, 200), mimeType: mime as ImageMime, byteSize: bytes.length, width, height, sha256: hash(bytes), owner, draftId, sessions: [], expiresAt: new Date(Date.now() + IMAGE_LIMITS.ttlMs).toISOString(), ...(source ? { sourceSha256: source } : {}) };
    try { writeFileSync(this.file(id, "bin"), bytes, { mode: 0o600 }); writeFileSync(this.file(id, "webp"), thumb, { mode: 0o600 }); this.save(r); }
    catch (e) { this.remove(id); throw e; }
    if (endMarkerRestored) console.info("[image-upload] " + JSON.stringify({ at: new Date().toISOString(), stage: "jpeg_end_marker_restored", attachmentId: id, bytes: bytes.length }));
    return this.public(r);
  }
  read(id: string, owner: string, thumbnail = false, sessionId?: string): { bytes: Buffer; mimeType: ImageMime } {
    const r = this.record(id);
    if (sessionId ? !r.sessions.includes(sessionId) : r.owner !== owner) throw new AttachmentError("没有图片访问授权", 403);
    if (!r.sessions.length && Date.parse(r.expiresAt) < Date.now()) throw new AttachmentError("图片已过期，请重新添加", 410);
    const f = this.file(id, thumbnail ? "webp" : "bin");
    if (!existsSync(f)) throw new AttachmentError("图片文件缺失", 410);
    const bytes = readFileSync(f);
    if (!thumbnail && (bytes.length !== r.byteSize || hash(bytes) !== r.sha256)) throw new AttachmentError("图片文件损坏", 410);
    return { bytes, mimeType: thumbnail ? "image/webp" : r.mimeType };
  }
  resolve(ids: unknown, owner: string, sessionId?: string): ImageAttachment[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new AttachmentError("attachmentIds 必须是图片 ID 数组");
    if (ids.length > IMAGE_LIMITS.count) throw new AttachmentError("每条消息最多 5 张图片");
    const records = ids.map(id => {
      const r = this.record(id);
      if (r.owner !== owner && !(sessionId && r.sessions.includes(sessionId))) throw new AttachmentError("没有图片绑定授权", 403);
      this.read(id, owner, false, sessionId && r.sessions.includes(sessionId) ? sessionId : undefined);
      return this.public(r);
    });
    if (records.reduce((n,r) => n + r.byteSize, 0) > IMAGE_LIMITS.totalBytes) throw new AttachmentError("图片总大小不能超过 20 MiB", 413);
    return records;
  }
  /** Accepted deployment messages keep drafts readable through their bounded wait. */
  retainDrafts(ids: unknown, owner: string, sessionId?: string): void {
    for (const image of this.resolve(ids, owner, sessionId)) {
      const record = this.record(image.attachmentId);
      if (!record.sessions.length) {
        record.expiresAt = new Date(Math.max(Date.parse(record.expiresAt), Date.now() + 25 * 3600_000)).toISOString();
        this.save(record);
      }
    }
  }
  attach(ids: string[], owner: string, sessionId: string): void {
    this.resolve(ids, owner, sessionId);
    for (const id of ids) { const r = this.record(id); if (!r.sessions.includes(sessionId)) r.sessions.push(sessionId); this.save(r); }
  }
  /** Only for inputs already published durably by RuntimeStore; they outlive draft TTL. */
  restoreReferences(ids: string[], owner: string, sessionId: string): void {
    for (const id of ids) { const r = this.record(id); if (r.owner !== owner && !r.sessions.includes(sessionId)) throw new AttachmentError("没有图片恢复授权", 403); if (!r.sessions.includes(sessionId)) { r.sessions.push(sessionId); this.save(r); } this.read(id, owner, false, sessionId); }
  }
  images(ids: string[], sessionId: string): DriverImage[] { return ids.map(id => { const r = this.record(id), b = this.read(id, "", false, sessionId); return { mimeType: r.mimeType, sha256: r.sha256, data: b.bytes.toString("base64") }; }); }
  private remove(id: string): void { for (const ext of ["json","bin","webp"]) rmSync(this.file(id, ext), { force: true }); }
  cleanup(now = Date.now()): void {
    for (const r of this.all()) if (!r.sessions.length && Date.parse(r.expiresAt) < now) this.remove(r.attachmentId);
    this.dedupe();
  }
  /** Turns byte-identical copies stored before hard-link sharing (or by a copy fallback) into links. */
  private dedupe(): void {
    const first = new Map<string, Record>();
    for (const r of this.all()) {
      const base = first.get(r.sha256);
      if (!base) { if (this.intact(r)) first.set(r.sha256, r); continue; }
      try {
        for (const ext of ["bin", "webp"]) {
          const from = this.file(base.attachmentId, ext), to = this.file(r.attachmentId, ext);
          if (!existsSync(to) || statSync(from).ino === statSync(to).ino) continue;
          if (ext === "bin" && !this.intact(r)) break;
          const tmp = `${to}.tmp-${randomUUID()}`;
          linkSync(from, tmp); renameSync(tmp, to);
        }
      } catch { /* best effort: a failed link leaves the separate copy in place */ }
    }
  }
  removeSession(id: string): void { for (const r of this.all()) if (r.sessions.includes(id)) { r.sessions = r.sessions.filter(s => s !== id); if (!r.sessions.length) this.remove(r.attachmentId); else this.save(r); } }
  private all(): Record[] {
    return readdirSync(this.dir).filter(f => /^img-[a-f0-9]{32}\.json$/.test(f)).flatMap(f => { try { return [this.record(f.slice(0, -5))]; } catch { return []; } });
  }
}
