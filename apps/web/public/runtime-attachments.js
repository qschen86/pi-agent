"use strict";
const RT_IMAGE_DIAG_STORAGE = "pi-runtime-image-diagnostics-v1";
let rtImageDiagQueue = [];
try { rtImageDiagQueue = JSON.parse(localStorage.getItem(RT_IMAGE_DIAG_STORAGE) || "[]"); if (!Array.isArray(rtImageDiagQueue)) rtImageDiagQueue = []; } catch {}
rtImageDiagQueue = rtImageDiagQueue.filter(e => e && Date.now() - Date.parse(e.clientAt) < 24 * 3600000).slice(-40);
let rtImageDiagSending = false, rtImageDiagTimer;
function rtImageDiagSave() { try { localStorage.setItem(RT_IMAGE_DIAG_STORAGE, JSON.stringify(rtImageDiagQueue)); } catch {} }
function rtImageDiag(stage, fields = {}) {
  rtImageDiagQueue.push({ stage, clientAt: new Date().toISOString(), online: navigator.onLine, ...fields });
  rtImageDiagQueue = rtImageDiagQueue.slice(-40); rtImageDiagSave();
  clearTimeout(rtImageDiagTimer); rtImageDiagTimer = setTimeout(() => void rtImageDiagFlush(), 250);
}
async function rtImageDiagFlush() {
  if (rtImageDiagSending || !rtImageDiagQueue.length || navigator.onLine === false) return;
  rtImageDiagSending = true;
  const batch = rtImageDiagQueue.slice(0, 20);
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch("/api/runtime-attachment-diagnostics", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: batch }), signal: controller.signal });
    if (r.ok) { rtImageDiagQueue = rtImageDiagQueue.filter(e => !batch.includes(e)); rtImageDiagSave(); }
  } catch {} finally {
    clearTimeout(timeout); rtImageDiagSending = false;
    if (rtImageDiagQueue.length) { clearTimeout(rtImageDiagTimer); rtImageDiagTimer = setTimeout(() => void rtImageDiagFlush(), 10000); }
  }
}
window.addEventListener("online", () => void rtImageDiagFlush());
window.addEventListener("focus", () => void rtImageDiagFlush());
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void rtImageDiagFlush(); });
setTimeout(() => void rtImageDiagFlush(), 1000);
/* V3.4: drafts contain metadata only; image bytes remain on the authenticated host. */
const RT_IMAGE_STORAGE = "pi-agent-image-drafts-v1";
const rtImageFiles = new Map(), rtImageIntakes = new Map();
function rtForgetImage(localId) {
  rtImageIntakes.get(localId)?.cancel?.(); rtImageIntakes.delete(localId); rtImageFiles.delete(localId);
}
let rtImageDrafts = {};
try { rtImageDrafts = JSON.parse(localStorage.getItem(RT_IMAGE_STORAGE) || "{}"); } catch { /* private mode */ }
// Older versions persisted source references even when the corresponding message was omitted.
for (const d of Object.values(rtImageDrafts)) {
  if (d && !d.text && !d.images?.length && !d.pending) { delete d.noteRef; delete d.recommendationRef; }
}
function rtStoredImageDrafts() {
  return Object.fromEntries(Object.entries(rtImageDrafts).map(([k, v]) => {
    const stored = { ...v };
    if (!v.images.length && !v.pending) { stored.text = ""; delete stored.noteRef; delete stored.recommendationRef; }
    return [k, stored];
  }));
}
function rtImageDraft(key) {
  if (!rtImageDrafts[key] || !Array.isArray(rtImageDrafts[key].images)) rtImageDrafts[key] = { draftId: Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""), text: "", images: [] };
  return rtImageDrafts[key];
}
function rtSaveImageDraft(key, text) {
  const d = rtImageDraft(key); if (text !== undefined) d.text = text;
  if (!d.text.trim() && !d.images.length && !d.pending) { delete d.noteRef; delete d.recommendationRef; }
  try { localStorage.setItem(RT_IMAGE_STORAGE, JSON.stringify(rtStoredImageDrafts())); } catch { /* in-memory fallback */ }
  // 会话列表里的「草稿」标签跟着输入 / 发图 / 移除图片即时变化
  if (typeof rtSyncDraftBadge === "function") rtSyncDraftBadge(key);
}
function rtClearImageDraft(key) { for (const i of rtImageDraft(key).images) rtForgetImage(i.localId); delete rtImageDrafts[key]; try { localStorage.setItem(RT_IMAGE_STORAGE, JSON.stringify(rtStoredImageDrafts())); } catch {} if (typeof rtSyncDraftBadge === "function") rtSyncDraftBadge(key); }
function rtImageIds(key) { return rtImageDraft(key).images.filter(i => i.state === "ready").map(i => i.attachmentId); }
function rtImageSupport(kind, model) {
  const p = (ui.rt.profiles || []).find(p => p.runtimeKind === kind), m = p && ((p.models || []).find(m => m.id === model) || (!model && ((p.models || []).find(m => m.isDefault) || p.models?.[0])));
  return p?.capabilities?.imageInput?.status === "supported" && m?.inputModalities?.includes("image");
}
function rtImageError(key, kind, model) {
  const images = rtImageDraft(key).images;
  if (images.some(i => i.state === "uploading")) return "图片正在上传，请稍候";
  if (images.some(i => i.state !== "ready")) return "有图片上传失败或已过期，请重试或移除";
  if (images.reduce((n,i) => n + (i.byteSize || 0), 0) > 20 * 1024 ** 2) return "图片总大小不能超过 20 MiB，请移除部分图片";
  if (images.length && !rtImageSupport(kind, model)) return "所选运行时或模型未确认支持图片输入，请更换模型或移除图片";
  if (kind === "claude-code") for (const i of images) {
    if (i.width > 8000 || i.height > 8000) return `${i.originalName}：Claude 图片单边不能超过 8000 像素`;
    if (4 * Math.ceil(i.byteSize / 3) > 10_000_000) return `${i.originalName}：Claude 图片 base64 编码后不能超过 10 MB，请使用较小图片`;
  }
  return "";
}
function rtRefreshImages() { if (ui.view === "rt") rtRenderSoft(); else renderMain(); }
/* Phone uplinks through the public proxies are slow, so shrink before sending: a long side the
   vision models never read only costs uplink, and vendor JPEG layouts (vivo trailers) can fail
   strict server decoding although the phone renders them. The browser decodes leniently, so
   re-encode large files up front and any JPEG/PNG the server cannot decode. Encode to the largest
   quality that fits a byte budget, preferring WebP (25%~35% smaller than JPEG at equal quality). */
const RT_IMAGE_MAX_SIDE = 1600, RT_IMAGE_TARGET_BYTES = 640 * 1024;
const RT_IMAGE_QUALITY_MIN = 0.5, RT_IMAGE_QUALITY_MAX = 0.86;
function rtCanvasBlob(bitmap, width, height, type, quality) {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const g = canvas.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, width, height); g.drawImage(bitmap, 0, 0, width, height);
  return new Promise(res => canvas.toBlob(res, type, quality));
}
/** 预算内取最高质量；预算外退到质量下限，取能做到的最小体积。 */
async function rtEncodeImage(bitmap, width, height) {
  const probe = await rtCanvasBlob(bitmap, width, height, "image/webp", RT_IMAGE_QUALITY_MAX);
  const type = probe && probe.type === "image/webp" ? "image/webp" : "image/jpeg";
  let best = type === "image/webp" ? probe : await rtCanvasBlob(bitmap, width, height, type, RT_IMAGE_QUALITY_MAX);
  if (best && best.size <= RT_IMAGE_TARGET_BYTES) return { blob: best, type };
  let lo = RT_IMAGE_QUALITY_MIN, hi = RT_IMAGE_QUALITY_MAX, fitting = null;
  for (let i = 0; i < 5 && hi - lo > 0.04; i++) {
    const q = (lo + hi) / 2, mid = await rtCanvasBlob(bitmap, width, height, type, q);
    if (!mid) break;
    if (mid.size <= RT_IMAGE_TARGET_BYTES) { fitting = mid; lo = q; } else hi = q;
  }
  if (fitting) return { blob: fitting, type };
  const floor = await rtCanvasBlob(bitmap, width, height, type, RT_IMAGE_QUALITY_MIN);
  if (floor && best && floor.size < best.size) best = floor;
  return best ? { blob: best, type } : null;
}
async function rtReencodeImage(file) {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, RT_IMAGE_MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), hgt = Math.max(1, Math.round(bmp.height * scale));
    const encoded = await rtEncodeImage(bmp, w, hgt);
    if (!encoded) return null;
    const name = (file.name || "图片").replace(/\.[a-zA-Z0-9]{1,12}$/, "") + (encoded.type === "image/webp" ? ".webp" : ".jpg");
    return { blob: encoded.blob, name, width: w, height: hgt };
  } catch { return null; } finally { bmp?.close?.(); }
}
/** 优先 XHR（可上报传输字节进度）；无 XHR 的环境（诊断 vm）回退到 fetch。 */
function rtImagePost(url, headers, body, onProgress, signal) {
  if (signal?.aborted) return Promise.reject(new Error("图片导入已取消"));
  if (typeof XMLHttpRequest !== "function") {
    return fetch(url, { method: "POST", headers, body, credentials: "same-origin", ...(signal ? { signal } : {}) }).then(async r => {
      let meta; try { meta = await r.json(); } catch { throw new Error(`上传响应无法解析（HTTP ${r.status}），请重试`); }
      return { ok: r.ok, status: r.status, meta };
    });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(headers)) if (v) xhr.setRequestHeader(k, v);
    xhr.timeout = 180000;
    xhr.upload.onprogress = ev => { if (ev.lengthComputable && ev.total) onProgress?.(ev.loaded / ev.total); };
    xhr.onload = () => {
      let meta; try { meta = JSON.parse(xhr.responseText || "{}"); } catch { return reject(new Error(`上传响应无法解析（HTTP ${xhr.status}），请重试`)); }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, meta });
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new TypeError("network"));
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener("abort", abort);
    xhr.send(body);
  });
}
/** 纯 JS SHA-256：局域网 http 打开时没有 crypto.subtle（只在安全上下文提供），用它兜底。 */
function rtSha256(bytes) {
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const n = bytes.length, total = Math.ceil((n + 9) / 64) * 64, buf = new Uint8Array(total);
  buf.set(bytes); buf[n] = 0x80;
  const view = new DataView(buf.buffer); view.setUint32(total - 8, Math.floor(n / 0x20000000)); view.setUint32(total - 4, (n * 8) >>> 0);
  const W = new Uint32Array(64), rotr = (x, k) => (x >>> k) | (x << (32 - k));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) { const a = W[i - 15], b = W[i - 2]; W[i] = W[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)); }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, x => x.toString(16).padStart(8, "0")).join("");
}
/** 原文件（压缩前）的 SHA-256：同一张图再次添加时用它向服务端要已存的副本。读不到文件返回 ""。 */
async function rtImageSourceHash(file) {
  try {
    if (typeof file.arrayBuffer !== "function") return "";
    const data = await file.arrayBuffer();
    if (globalThis.crypto?.subtle) return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), b => b.toString(16).padStart(2, "0")).join("");
    return rtSha256(new Uint8Array(data));
  } catch { return ""; }
}
/** 命中返回附件元数据（不传字节）；未命中、出错、超时一律返回 null，交给正常上传。 */
async function rtImageReuse(key, sha256, uploadId) {
  if (!sha256) return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null, timer = setTimeout(() => controller?.abort(), 20000);
  try {
    const r = await fetch("/api/runtime-attachments/reuse", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha256, draftId: rtImageDraft(key).draftId }), ...(controller ? { signal: controller.signal } : {}) });
    if (!r.ok) return null;
    const meta = await r.json();
    if (meta?.reused !== true || !/^img-[a-f0-9]{32}$/.test(meta.attachmentId || "")) return null;
    rtImageDiag("reused", { uploadId, bytes: meta.byteSize });
    return meta;
  } catch { return null; } finally { clearTimeout(timer); }
}
let rtImageRefreshTimer;
function rtRefreshImagesSoon() { if (rtImageRefreshTimer) return; rtImageRefreshTimer = setTimeout(() => { rtImageRefreshTimer = undefined; rtRefreshImages(); }, 120); }
const rtSleep = ms => new Promise(res => setTimeout(res, ms));
async function rtUploadImage(key, item, file, { isCurrent = () => true, signal } = rtImageIntakes.get(item.localId) || {}) {
  if (!isCurrent()) return;
  item.state = "uploading"; item.error = ""; item.progress = 0; item.phase = "encoding"; rtSaveImageDraft(key); rtRefreshImages();
  const uploadId = item.uploadId || ("upload-" + (globalThis.crypto?.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("")));
  item.uploadId = uploadId;
  const started = Date.now(); let phase = "request", status, currentId = uploadId;
  const reencode = async (why) => {
    const re = await rtReencodeImage(file);
    if (!re) { rtImageDiag("reencode_failed", { uploadId, reason: why, mime: file.type, bytes: file.size }); return null; }
    rtImageDiag("reencoded", { uploadId, reason: why, originalBytes: file.size, bytes: re.blob.size, width: re.width, height: re.height });
    return re;
  };
  let sourceHash = "";
  const post = async (body, name, id) => {
    currentId = id;
    const url = `/api/runtime-attachments?draftId=${encodeURIComponent(rtImageDraft(key).draftId)}&name=${encodeURIComponent(name)}`;
    const headers = { "content-type": body.type || "application/octet-stream", "x-upload-id": id, ...(sourceHash ? { "x-source-sha256": sourceHash } : {}) };
    for (let attempt = 0; ; attempt++) {
      if (!isCurrent()) throw new Error("图片导入已取消");
      phase = "request"; status = undefined;
      rtImageDiag("request_started", { uploadId: id, mime: body.type, bytes: body.size, attempt });
      try {
        const result = await rtImagePost(url, headers, body, p => { if (isCurrent()) { item.progress = p; rtRefreshImagesSoon(); } }, signal);
        status = result.status; phase = "response_parse";
        rtImageDiag("response_received", { uploadId: id, status, durationMs: Date.now() - started });
        phase = "server_result";
        // 服务端并发占满时返回 503 且不排队；退避重试，避免用户看到一次假失败。
        if (result.status === 503 && attempt < 2) { phase = "retry"; await rtSleep(500 * (attempt + 1)); continue; }
        return result;
      } catch (e) {
        if (!(e instanceof TypeError) || attempt >= 2) throw e;
        phase = "retry"; rtImageDiag("retry", { uploadId: id, errorName: e.name, attempt }); await rtSleep(500 * (attempt + 1));
      }
    }
  };
  try {
    let reencoded = false;
    let body = file, name = file.name || "图片";
    // 统一转成 WebP：不再按大小分情况，避免同一批附件里有的 JPG 有的 WebP。
    // 同时查「这张图传过没有」：命中就直接用，压缩结果丢掉；没命中时压缩已在进行，不多等。
    const encoding = file.type !== "image/webp" ? reencode("format") : Promise.resolve(null);
    sourceHash = await rtImageSourceHash(file);
    if (!isCurrent()) return;
    const hit = await rtImageReuse(key, sourceHash, uploadId);
    if (!isCurrent()) return;
    if (hit) {
      Object.assign(item, hit, { state: "ready", phase: undefined, progress: undefined }); delete item.reused; rtImageFiles.delete(item.localId);
      rtImageDiag("ready", { uploadId, durationMs: Date.now() - started });
      rtSaveImageDraft(key); rtRefreshImages(); return;
    }
    const re = await encoding;
    if (!isCurrent()) return;
    if (re) { body = re.blob; name = re.name; reencoded = true; }
    item.phase = "upload"; rtRefreshImagesSoon();
    let { ok, status: code, meta } = await post(body, name, reencoded ? uploadId + "-re" : uploadId);
    if (!ok && code === 400 && !reencoded && /损坏|解码|不完整/.test(meta.error || "")) {
      const re = await reencode("decode");
      if (re) ({ ok, status: code, meta } = await post(re.blob, re.name, uploadId + "-re"));
      // The phone's own browser cannot decode the bytes either: the picker handed over an
      // incomplete copy (e.g. a stale gallery size record), even if the gallery shows it fine.
      else throw new Error("手机交给浏览器的图片数据不完整（相册里能看但浏览器读不全）。请在相册里编辑后另存一份、截图，或从「文件」里选原图再上传");
    }
    if (!isCurrent()) return;
    if (!ok) throw new Error(meta.error || `上传失败（${code}）`);
    Object.assign(item, meta, { state: "ready", phase: undefined, progress: undefined }); rtImageFiles.delete(item.localId);
    rtImageDiag("ready", { uploadId: currentId, durationMs: Date.now() - started });
  } catch (e) { if (!isCurrent()) return; item.state = "failed"; item.phase = undefined; item.error = e.name === "TypeError" && (phase === "request" || phase === "retry") ? "网络中断或上传超时，请重试" : e.message; rtImageDiag("failed", { uploadId: currentId, phase, status, errorName: e.name, durationMs: Date.now() - started }); }
  rtSaveImageDraft(key); rtRefreshImages();
}
/** 手机上行是瓶颈，但串行上传让多图总时长成倍增长；服务端为 2 个并发预留，这里对齐。 */
async function rtRunLimited(items, limit, run) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const item = items[next++]; await run(item); }
  }));
}
async function rtAddImages(key, files, intake = {}) {
  const d = rtImageDraft(key), queue = [];
  for (const file of files) {
    if (d.images.length >= 5) { announce("每条消息最多 5 张图片"); break; }
    const i = { ...(intake.intakeId ? { intakeId: intake.intakeId } : {}), localId: Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""), originalName: file.name || "粘贴图片", byteSize: file.size, state: "uploading" }; d.images.push(i); rtImageFiles.set(i.localId, file);
    if (intake.intakeId) rtImageIntakes.set(i.localId, intake);
    i.uploadId = "upload-" + i.localId;
    const fields = { uploadId: i.uploadId, mime: file.type, bytes: file.size, extension: /\.([a-zA-Z0-9]{1,12})$/.exec(file.name || "")?.[1] || "" };
    rtImageDiag("selected", fields);
    if (!["image/png","image/jpeg","image/webp"].includes(file.type) || file.size > 10 * 1024 ** 2) { i.state = "failed"; i.error = "仅支持 PNG、JPEG、静态 WebP，单图最大 10 MiB"; rtImageDiag("client_rejected", { ...fields, reason: file.size > 10 * 1024 ** 2 ? "size" : "format" }); rtSaveImageDraft(key); rtRefreshImages(); continue; }
    queue.push({ i, file });
  }
  await rtRunLimited(queue, 2, ({ i, file }) => rtUploadImage(key, i, file, intake));
}
/** Remove only quick-import screenshots when their authorization is invalidated. */
function rtRemoveIntakeImages(key) {
  const draft = rtImageDrafts[key];
  if (!draft) return;
  for (const image of draft.images) if (image.intakeId) rtForgetImage(image.localId);
  draft.images = draft.images.filter(image => !image.intakeId);
  rtSaveImageDraft(key);
  if (ui.view === 'rt-new' || ui.view === 'rt') rtRefreshImages();
}
/** 待办图片本来就在服务端：直接按 id 建附件，手机既不下载也不上传。
 *  返回没能这样附上的图片，由调用方退回「下载再上传」。 */
async function rtAddNoteImages(key, images) {
  const d = rtImageDraft(key), jobs = [], rest = [];
  for (const image of images || []) {
    if (!image?.id) continue;
    if (d.images.length >= 5) { announce("每条消息最多 5 张图片"); break; }
    const i = { localId: Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""), originalName: image.name || "图片", byteSize: image.byteSize || 0, state: "uploading", phase: "upload" };
    i.uploadId = "upload-" + i.localId;
    d.images.push(i); rtImageFiles.set(i.localId, { noteImage: image.id });
    jobs.push({ i, image });
  }
  rtSaveImageDraft(key); rtRefreshImages();
  await rtRunLimited(jobs, 2, async ({ i, image }) => {
    const started = Date.now();
    try {
      const r = await fetch("/api/runtime-attachments/from-note", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ noteImageId: image.id, draftId: d.draftId }) });
      const meta = await r.json().catch(() => ({}));
      if (!r.ok || !/^img-[a-f0-9]{32}$/.test(meta.attachmentId || "")) throw new Error(meta.error || `HTTP ${r.status}`);
      Object.assign(i, meta, { state: "ready", phase: undefined, progress: undefined });
      rtImageDiag("from_note", { uploadId: i.uploadId, bytes: meta.byteSize, durationMs: Date.now() - started });
    } catch (e) {
      d.images = d.images.filter(x => x !== i); rest.push(image);
      rtImageDiag("from_note_failed", { uploadId: i.uploadId, errorName: e?.name, durationMs: Date.now() - started });
    } finally { rtImageFiles.delete(i.localId); }
  });
  rtSaveImageDraft(key); rtRefreshImages();
  return rest;
}
function rtImagePaste(key, ev) {
  const files = Array.from(ev.clipboardData?.files || []); if (!files.length) return;
  ev.preventDefault(); const text = ev.clipboardData.getData("text/plain");
  if (text) { ev.target.setRangeText(text, ev.target.selectionStart, ev.target.selectionEnd, "end"); ev.target.dispatchEvent(new Event("input", { bubbles: true })); }
  void rtAddImages(key, files);
}
function rtImageDrop(key, ev) { if (ev.dataTransfer?.files.length) { ev.preventDefault(); void rtAddImages(key, Array.from(ev.dataTransfer.files)); } }
function rtAttachmentUrl(i, session, thumbnail = false) { return `/api/runtime-attachments/${encodeURIComponent(i.attachmentId)}?${session ? `session=${encodeURIComponent(session)}&` : ""}${thumbnail ? "thumbnail=1" : ""}`; }
/** 放大查看：先看压缩图（size=view），栏上「原图」切回原始文件 */
function rtAttachmentZoomItem(i, session) { const url = rtAttachmentUrl(i, session); return { src: `${url}${/[?&]$/.test(url) ? "" : "&"}size=view`, original: url, name: i.originalName, kind: "attachment", attachmentId: i.attachmentId }; }
function rtPreviewAttachment(i, session) {
  const url = rtAttachmentUrl(i, session);
  if (typeof openImageZoom === "function") { openImageZoom([rtAttachmentZoomItem(i, session)], 0); return; }
  const dialog = h("dialog", { class: "rt-image-dialog", "aria-label": i.originalName, onclick: ev => { if (ev.target === dialog) dialog.close(); }, onclose: () => dialog.remove() },
    h("button", { type: "button", class: "btn", onclick: () => dialog.close(), "aria-label": "关闭图片预览" }, "关闭"),
    h("p", {}, i.originalName), h("img", { src: url, alt: i.originalName }));
  document.body.append(dialog); dialog.showModal();
}
/** 多张附件：交给缩放查看器左右切换；没有查看器时退回单张预览 */
function rtPreviewAttachments(images, index, session, trigger) {
  const list = (images || []).filter(Boolean);
  if (!list.length) return;
  const at = Math.min(Math.max(0, index | 0), list.length - 1);
  if (session && typeof rtOpenSessionImages === "function" && rtOpenSessionImages(session, rtAttachmentZoomItem(list[at], session), trigger)) return;
  if (typeof openImageZoom === "function") { openImageZoom(list.map(i => rtAttachmentZoomItem(i, session)), at); return; }
  rtPreviewAttachment(list[at], session);
}
function rtAttachmentHistory(images, session) {
  if (!images?.length) return null;
  return h("div", { class: "rt-attachment-strip" }, images.map((i, index) => h("button", { type: "button", class: "rt-attachment-card", onclick: ev => rtPreviewAttachments(images, index, session, ev.currentTarget), "aria-label": `查看图片 ${i.originalName}` },
    h("img", { src: rtAttachmentUrl(i, session, true), alt: i.originalName, loading: "lazy", onerror: ev => { ev.target.hidden = true; ev.target.parentElement.append(h("span", {}, "图片缺失或无权读取")); } }), h("span", { class: "rt-attachment-name" }, i.originalName))));
}
/**
 * 图片草稿区：缩略图节点与「＋ 图片」按钮分开返回。
 * node 放在输入框上方；addButton 由调用方放到输入框底部的动作行里（和发送按钮同一行、靠左）。
 * 没有草稿图时 node 带 empty 类，由 CSS 隐藏，避免占一行高度。
 */
function rtUploadLabel(i) { return i.phase === "encoding" ? "压缩中…" : i.progress > 0 && i.progress < 1 ? `上传中 ${Math.round(i.progress * 100)}%` : "上传中…"; }
/**
 * 文件选择器常驻 body、不随输入区重绘：手机上输入区会被轮询 / 状态更新整块重绘，
 * 原先 input 放在会被重绘（或排队部署时根本不渲染）的节点里，点「＋」时 input.click() 落在已脱离页面的元素上，相册就拉不起来。
 * 这里在点击手势里同步调用常驻 input 的 click()，目标 key 每次点击时再指定。
 */
let rtImagePickerInput = null, rtImagePickerKey = "";
function rtOpenImagePicker(key) {
  if (!rtImagePickerInput || !rtImagePickerInput.isConnected) {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/png,image/jpeg,image/webp"; input.multiple = true; input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true"); input.setAttribute("aria-label", "添加图片");
    // 不用 display:none / hidden：个别手机浏览器对它们不弹选择器
    input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden";
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []), target = rtImagePickerKey;
      rtImageDiag("picker_result", { count: files.length });
      input.value = "";
      if (target && files.length) void rtAddImages(target, files);
    });
    document.body.appendChild(input);
    rtImagePickerInput = input;
  }
  rtImagePickerKey = key;
  rtImagePickerInput.value = "";
  rtImagePickerInput.click();
}
/**
 * 长按加号直接拍照：点按仍然打开相册 / 文件选择，按住不动换成带 capture 的输入，系统相机拍完就回到同一个上传流程。
 * 手里拿着手机想拍一张时不必先进相册再翻相机；原生壳把 capture 请求转成系统相机，旧 APK 退回相册选择。
 * 输入常驻 body：输入区重复重绘时，长按定时器里点到的仍是页面里的那个 input。
 */
const RT_CAMERA_HOLD_MS = 480;
let rtCameraInput = null, rtCameraKey = "";
function rtCameraInputNode() {
  if (rtCameraInput && rtCameraInput.isConnected) return rtCameraInput;
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/png,image/jpeg,image/webp"; input.multiple = false;
  input.setAttribute("capture", "environment");
  input.tabIndex = -1; input.setAttribute("aria-hidden", "true"); input.setAttribute("aria-label", "拍照");
  input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden";
  input.addEventListener("change", () => {
    const files = Array.from(input.files || []), target = rtCameraKey;
    rtImageDiag("picker_result", { count: files.length, reason: "camera" });
    input.value = "";
    if (target && files.length) void rtAddImages(target, files);
  });
  document.body.appendChild(input);
  rtCameraInput = input;
  return input;
}
function rtOpenCamera(key) {
  rtImageDiag("picker_opened", { reason: "camera" });
  const input = rtCameraInputNode();
  rtCameraKey = key; input.value = "";
  input.click();
}
function rtAttachmentComposer(key, kind, model, disabled = false) {
  const d = rtImageDraft(key);
  for (const i of d.images) {
    if (i.state === "uploading" && !rtImageFiles.has(i.localId)) { i.state = "failed"; i.error = "上传未完成，请重新添加"; }
    if (!d.pending && i.expiresAt && Date.parse(i.expiresAt) < Date.now()) { i.state = "expired"; i.error = "图片已过期，请重新添加"; }
  }
  // 点击处理不捕获 key：输入区重绘时会沿用旧节点（rtAdoptAttachmentTools），目标会话从节点上读
  // 长按状态挂在节点自己的闭包上：输入区重绘沿用旧节点时，点击与长按仍然指向同一份状态。
  const hold = { timer: 0, camera: false, key, x: 0, y: 0 };
  const addButton = h("button", { type: "button", class: "rt-attachment-add", "data-draft-key": key, disabled: disabled || d.images.length >= 5, title: d.images.length >= 5 ? "最多 5 张图片" : "点按选图片，长按拍照", "aria-label": "添加图片",
    onclick: ev => { if (hold.camera) { hold.camera = false; ev.preventDefault(); return; } rtImageDiag("picker_opened"); rtOpenImagePicker(ev.currentTarget.dataset.draftKey); } },
    h("span", { class: "rt-attachment-add-icon", "aria-hidden": "true" }, "＋"),
    h("span", { class: "rt-attachment-add-text" }, "图片"));
  rtHoldForCamera(addButton, hold);
  const node = h("div", { class: `rt-attachments${d.images.length ? "" : " empty"}` },
    h("div", { class: "rt-attachment-strip rt-attachment-draft-strip" }, d.images.map(i => h("div", { class: "rt-attachment-card rt-attachment-draft-card" },
      i.state === "ready" ? h("button", { type: "button", class: "rt-image-thumb", onclick: () => { const ready = d.images.filter(x => x.state === "ready"); rtPreviewAttachments(ready, Math.max(0, ready.indexOf(i)), null); }, "aria-label": `预览图片 ${i.originalName}` }, h("img", { src: rtAttachmentUrl(i, null, true), alt: i.originalName, onerror: () => { if (i.state === "ready") { i.state = "expired"; i.error = "图片已过期或无权读取，请重新添加"; rtSaveImageDraft(key); rtRefreshImages(); } } })) : null,
      h("span", { class: "rt-attachment-name" }, i.originalName), h("span", { class: "small" }, i.state === "uploading" ? rtUploadLabel(i) : i.state === "ready" ? `${Math.ceil(i.byteSize / 1024)} KB` : i.error || "上传失败"),
      i.state === "failed" && rtImageFiles.has(i.localId) ? h("button", { type: "button", class: "btn small", disabled, onclick: () => void rtUploadImage(key, i, rtImageFiles.get(i.localId)) }, "重试上传") : null,
      h("button", { type: "button", class: "btn small", disabled, "aria-label": `移除图片 ${i.originalName}`, onclick: () => { d.images = d.images.filter(x => x !== i); rtForgetImage(i.localId); ui.rt.sendKey = null; rtSaveImageDraft(key); rtRefreshImages(); } }, "移除")))),
    d.images.length ? h("p", { class: "small warn", role: "status" }, rtImageError(key, kind, model)) : null);
  return { node, addButton: h("span", { class: `rt-attachment-tools${rtClipboardSlotWanted() ? " has-slot" : ""}` }, addButton, rtClipboardShortcut(key, disabled)) };
}
/**
 * 加号的两段手势：松手早于阈值就是原来的选图，按住满 480ms 直接进相机。
 * 相机启动后这次按住产生的 click 被吞掉，否则松手还会再弹一次相册；移动超过 12px（列表里滚动）不算长按。
 */
function rtHoldForCamera(button, hold) {
  const cancel = () => { if (hold.timer) { clearTimeout(hold.timer); hold.timer = 0; } button.classList.remove("rt-attachment-add-holding"); };
  button.addEventListener("pointerdown", ev => {
    if (button.disabled || (ev.pointerType === "mouse" && ev.button !== 0)) return;
    hold.x = ev.clientX; hold.y = ev.clientY; hold.key = button.dataset.draftKey || hold.key; hold.camera = false;
    button.classList.add("rt-attachment-add-holding");
    hold.timer = setTimeout(() => {
      hold.timer = 0; hold.camera = true;
      button.classList.remove("rt-attachment-add-holding");
      if (typeof navigator.vibrate === "function") navigator.vibrate(12);
      rtOpenCamera(hold.key);
    }, RT_CAMERA_HOLD_MS);
  });
  button.addEventListener("pointermove", ev => { if (hold.timer && Math.hypot(ev.clientX - hold.x, ev.clientY - hold.y) > 12) cancel(); });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) button.addEventListener(type, cancel);
  // 手机长按会弹系统选择 / 分享菜单，按住加号不该出现它
  button.addEventListener("contextmenu", ev => ev.preventDefault());
  button.addEventListener("blur", cancel);
}

/**
 * 加号与剪贴板快捷按钮这一组（.rt-attachment-tools）在输入区重绘时沿用旧节点，只把新状态同步上去：
 * 进入会话时输入区会随缓存画面 → 最新详情 → 状态核对多次重绘，每次整块新建会让加号闪一下、丢失焦点。
 * 新旧两组结构不一致（子节点数量或标签不同）时不处理，仍用新建的节点。
 * 返回之前聚焦在这一组里的元素，调用方在换完节点后把焦点还回去。
 */
function rtAdoptAttachmentTools(oldRoot, newRoot) {
  const oldTools = oldRoot.querySelector(".rt-attachment-tools"), newTools = newRoot.querySelector(".rt-attachment-tools");
  if (!oldTools || !newTools || oldTools.children.length !== newTools.children.length) return null;
  const pairs = [[oldTools, newTools], ...[...newTools.children].map((n, i) => [oldTools.children[i], n])];
  if (pairs.some(([o, n]) => o.tagName !== n.tagName)) return null;
  const focused = oldTools.contains(document.activeElement) ? document.activeElement : null;
  for (const [o, n] of pairs) {
    for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
    for (const a of n.attributes) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
    if (o.innerHTML !== n.innerHTML) o.replaceChildren(...n.childNodes);
  }
  newTools.replaceWith(oldTools);
  return focused;
}

let rtClipboardPreviewFile, rtClipboardPreviewUrl = '';
/** 原生缩略图生成失败时也给个图标，别留一个空圆点（内联 SVG，不额外发请求）。 */
const RT_CLIPBOARD_GLYPH = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8a85" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2.5"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.4-2h5.2L16 6"/></svg>');
// Update only these buttons when the clipboard changes: preserve focus, text and keyboard.
function rtClipboardShortcut(key, disabled = false) {
  const button = h("button", { type: "button", class: "rt-clipboard-shortcut", hidden: true, "aria-label": "上传剪贴板图片", title: "上传剪贴板图片", onclick: ev => void window.imageIntake?.importClipboard(ev.currentTarget.dataset.clipboardKey) });
  button.dataset.clipboardKey = key; button.dataset.clipboardDisabled = disabled ? '1' : '0';
  rtPaintClipboardShortcut(button);
  return button;
}
/** 气泡预览：相册图片只带一张缩略图（data URL），剪贴板仍是本地文件（blob 地址）。 */
function rtClipboardPreviewSource(item) {
  const source = item?.thumb || item?.file;
  if (rtClipboardPreviewFile !== source) {
    if (rtClipboardPreviewUrl.startsWith('blob:')) URL.revokeObjectURL(rtClipboardPreviewUrl);
    rtClipboardPreviewFile = source;
    rtClipboardPreviewUrl = !source ? '' : typeof source === 'string' ? source : URL.createObjectURL(source);
  }
  return rtClipboardPreviewUrl;
}
function rtPaintClipboardShortcut(button) {
  const pending = window.imageIntake?.clipboardPending();
  const item = pending?.kind === 'link' ? null : pending;
  button.replaceChildren(); button.hidden = !item;
  if (!item) return;
  const label = item.imageSource === 'album' ? '上传最新照片' : '上传剪贴板图片';
  button.setAttribute('aria-label', label); button.title = label;
  const key = button.dataset.clipboardKey;
  button.disabled = button.dataset.clipboardDisabled === '1' || item.importing || rtImageDraft(key).images.length >= 5 || !!rtImageDraft(key).pending;
  button.append(h('img', { src: rtClipboardPreviewSource(item) || RT_CLIPBOARD_GLYPH, alt: '', 'aria-hidden': 'true' }));
}
/**
 * 快捷按钮可能出现（桌面剪贴板检测或 Android 相册已开启）时，为它预留固定宽度：
 * 它出现 / 消失时右边的账户胶囊、强度权限入口不再被挤得左右跳。两种能力都没开就不预留，不白占位置。
 */
function rtClipboardSlotWanted() {
  return !!(window.imageIntake?.clipboardPending() || window.piClipboardImages?.enabled?.() || window.piRecentPhotos?.enabled?.());
}
function rtPaintClipboardSlots() {
  const wanted = rtClipboardSlotWanted();
  document.querySelectorAll('.rt-attachment-tools').forEach(tools => tools.classList.toggle('has-slot', wanted));
}
window.addEventListener('pi-clipboard-pending-change', () => {
  if (!window.imageIntake?.clipboardPending() && rtClipboardPreviewUrl) rtClipboardPreviewSource(undefined);
  document.querySelectorAll('.rt-clipboard-shortcut').forEach(rtPaintClipboardShortcut);
  rtPaintClipboardSlots();
});
// 能力开关（设置里开 / 关剪贴板、相册）变了：预留的宽度跟着变
window.addEventListener('pi-capabilities-change', rtPaintClipboardSlots);
window.addEventListener('pi-recent-photos-change', rtPaintClipboardSlots);
