import { randomUUID } from "node:crypto";
import type { Hono, Context } from "hono";

const short = (v: unknown, n = 120): string | undefined => typeof v === "string" ? v.slice(0, n) : undefined;
export function uploadLog(stage: string, fields: Record<string, unknown>): void {
  console.info("[image-upload] " + JSON.stringify({ at: new Date().toISOString(), stage, ...fields }));
}

/** Before authentication so rejected upload requests are visible too; no cookies or bodies. */
export function mountUploadRequestDiagnostics(app: Hono): void {
  app.use("/api/runtime-attachments", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const supplied = c.req.header("x-upload-id") ?? "";
    const uploadId = /^upload-[a-zA-Z0-9-]{1,64}$/.test(supplied) ? supplied : `upload-${randomUUID()}`;
    const started = Date.now();
    c.header("x-upload-id", uploadId);
    const fields = { uploadId, mime: short(c.req.header("content-type")), declaredBytes: short(c.req.header("content-length")), userAgent: short(c.req.header("user-agent"), 240) };
    uploadLog("server_received", fields);
    try { await next(); }
    finally {
      let reason: string | undefined;
      if (c.res.status >= 400 && c.res.headers.get("content-type")?.includes("application/json")) {
        try { reason = short((await c.res.clone().json() as { error?: unknown }).error, 200); } catch { /* response remains untouched */ }
      }
      uploadLog("server_result", { uploadId, status: c.res.status, durationMs: Date.now() - started, reason });
    }
  });
}

const stages = new Set(["selected", "client_rejected", "request_started", "response_received", "ready", "failed", "picker_opened", "picker_result", "reencoded", "reencode_failed", "retry", "reused", "from_note", "from_note_failed"]);
let windowStart = 0, reports = 0;
export async function receiveUploadDiagnostics(c: Context): Promise<Response> {
  if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); reports = 0; }
  if (++reports > 120) return c.json({ error: "诊断上报频繁" }, 429);
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json({ error: "缺少诊断内容" }, 400);
  const chunks: Uint8Array[] = []; let size = 0;
  const timer = setTimeout(() => void reader.cancel(), 5000);
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) { await reader.cancel(); return c.json({ error: "诊断内容过大" }, 413); }
      chunks.push(part.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { events?: unknown };
    if (!Array.isArray(body.events) || body.events.length > 20) return c.json({ error: "诊断格式错误" }, 400);
    for (const e of body.events) {
      if (!e || typeof e !== "object" || !stages.has(e.stage)) continue;
      const safe: Record<string, unknown> = { clientStage: e.stage, userAgent: short(c.req.header("user-agent"), 240) };
      for (const k of ["uploadId", "clientAt", "mime", "extension", "reason", "errorName", "phase"]) safe[k] = short(e[k]);
      for (const k of ["bytes", "originalBytes", "width", "height", "durationMs", "status", "count", "attempt"]) if (typeof e[k] === "number" && Number.isFinite(e[k]) && e[k] >= 0) safe[k] = e[k];
      if (typeof e.online === "boolean") safe.online = e.online;
      uploadLog("client_event", safe);
    }
    return c.json({ ok: true });
  } catch { return c.json({ error: "诊断格式错误" }, 400); }
  finally { clearTimeout(timer); reader.releaseLock(); }
}
