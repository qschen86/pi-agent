/** Read-only Pi JSONL history. Metadata changes do not count as external conversation writes. */
import { readFileSync, readdirSync, realpathSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { HistoryItem, HistoryRead } from "./driver.js";
import { underRoots } from "./codex.js";
import { bounded, LIMITS } from "./redact.js";
import { object, piContentText, piUsage, projectPiMessage } from "./pi-projection.js";

export interface PiSessionRead extends HistoryRead {
  nativeSessionId: string;
  file: string;
  userMessages: Array<{ id: string; text: string; inputHash?: string }>;
  lastMessage?: Record<string, unknown>;
  systemAddendum?: string;
  createdAt?: string;
  updatedAt?: string;
}
export function readPiSession(file: string): PiSessionRead {
  let retainedBytes = 0;
  const entries: Record<string, unknown>[] = []; let partial = false;
  for (const line of boundedLines(file)) {
    if (!line.trim()) continue;
    try {
      const row = object(JSON.parse(line)); if (typeof row.type !== "string") { partial = true; continue; }
      const message = object(row.message);
      // Drop byte-heavy content after hashing it. Fingerprints still distinguish every image byte.
      if (Array.isArray(message.content)) message.content = message.content.map(raw => { const c = object(raw); if (c.type !== "image" || typeof c.data !== "string") return raw; const {data, ...meta} = c; return {...meta, dataHash: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex")}; });
      retainedBytes += Buffer.byteLength(JSON.stringify(row));
      if (retainedBytes > 32 * 1024 ** 2) throw new Error("Pi non-image history exceeds the read limit");
      entries.push(row);
    } catch (e) { if (String(e).includes("exceeds the read limit")) throw e; partial = true; }
  }
  const header = entries.find((e) => e.type === "session");
  if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") throw new Error("Pi history missing a session header");
  if (header.version !== 3) partial = true;
  const records = entries.filter((e) => e.type !== "session" && typeof e.id === "string");
  const byId = new Map(records.map((e) => [e.id, e]));
  const path: Record<string, unknown>[] = []; const seen = new Set<unknown>();
  let cursor = records.at(-1);
  while (cursor) {
    if (seen.has(cursor.id)) { partial = true; break; }
    seen.add(cursor.id); path.unshift(cursor);
    if (!cursor.parentId) break;
    const parent = byId.get(cursor.parentId); if (!parent) partial = true;
    cursor = parent;
  }
  const events: HistoryRead["events"] = [], usage: HistoryRead["usage"] = [], userMessages: PiSessionRead["userMessages"] = [];
  let lastMessage: Record<string, unknown> | undefined, systemAddendum: string | undefined;
  let title = "", model: string | undefined, updatedAt: string | undefined;
  const fingerprintRows: Record<string, unknown>[] = [];
  for (const entry of path) {
    if (entry.type === "session_info") { if (typeof entry.name === "string") title = bounded(entry.name, 80).text; continue; }
    if (entry.type === "label" || entry.type === "custom") continue;
    fingerprintRows.push(entry);
    if (typeof entry.timestamp === "string") updatedAt = entry.timestamp;
    if (entry.type === "model_change") model = `${entry.provider}/${entry.modelId}`;
    if (entry.type === "message") {
      const message = object(entry.message); lastMessage = message;
      if (message.role === "system") { const sections = object(message.sections); if (typeof sections.addendum === "string") systemAddendum = sections.addendum; }
      events.push(...projectPiMessage(message, "history", false, String(entry.id)).map((e) => ({ ...e, nativeItemId: e.nativeItemId ?? String(entry.id) })));
      if (message.role === "user") userMessages.push({ id: String(entry.id), text: piContentText(message.content), inputHash: piInputHash(message.content) });
      if (message.role === "assistant" && message.model) model = `${message.provider}/${message.model}`;
      const u = piUsage(message, header.id); if (u) usage.push(u);
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") events.push({ key: `pi:${entry.type}:${entry.id}`, kind: "compaction", ...bounded(String(entry.summary ?? ""), LIMITS.message), source: "history", parserVersion: "pi-rpc@1", availability: "recorded" });
  }
  const titleKind = title.trim() ? "name" : "preview";
  if (!title.trim()) title = bounded(userMessages[0]?.text.split(/[\n。！？]/)[0] ?? "Pi 会话", 80).text;
  return { lastMessage, systemAddendum, nativeSessionId: header.id, file, workspace: header.cwd, title, titleKind, model, events, usage, userMessages, status: "unknown", coverage: partial ? "partial" : "complete", notes: partial ? ["Pi 原生记录有损坏或不完整的行/分支"] : [], fingerprint: createHash("sha256").update(JSON.stringify(fingerprintRows.map((e) => { const { parentId: _, ...rest } = e; return rest; }))).digest("hex"), createdAt: typeof header.timestamp === "string" ? header.timestamp : undefined, updatedAt };
}

export function piSessionFiles(directories: string[], limit = 10_000): string[] {
  const files: string[] = [], seen = new Set<string>();
  const walk = (directory: string, depth: number) => {
    if (depth > 5 || files.length >= limit) return;
    let real: string; try { real = realpathSync(directory); } catch { return; }
    if (seen.has(real)) return; seen.add(real);
    for (const entry of readdirSync(real, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = join(real, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
      if (files.length >= limit) break;
    }
  };
  for (const directory of directories) walk(directory, 0);
  return files;
}
export function listPiSessions(directories: string[], workspaceRoots: string[], limit: number): { items: HistoryItem[]; coverage: "complete" | "partial"; notes: string[] } {
  const items: HistoryItem[] = []; let partial = false;
  if (!workspaceRoots.length) return { items, coverage: "complete", notes: [] };
  for (const file of piSessionFiles(directories)) {
    try {
      const read = readPiSession(file);
      if (!underRoots(read.workspace, workspaceRoots)) continue;
      partial ||= read.coverage !== "complete";
      items.push({ nativeSessionId: read.nativeSessionId, title: read.title ?? "Pi 会话", workspace: read.workspace, model: read.model, createdAt: read.createdAt, updatedAt: read.updatedAt, sourceLabel: "Pi 原生历史", status: "unknown" });
    } catch { partial = true; }
  }
  items.sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
  return { items: items.slice(0, limit), coverage: partial ? "partial" : "complete", notes: partial ? ["部分 Pi 原生历史不可读取"] : [] };
}

/** Match the submitted text and original image bytes, never a placeholder-only rendering. */
export function piInputHash(content: unknown): string {
  const blocks = Array.isArray(content) ? content.map(object) : [{type:"text",text:String(content ?? "")}];
  const text = blocks.filter(c => c.type === "text").map(c => String(c.text ?? "")).join("\n");
  const images = blocks.filter(c => c.type === "image").map(c => typeof c.dataHash === "string" ? c.dataHash : createHash("sha256").update(Buffer.from(String(c.data ?? ""), "base64")).digest("hex"));
  return createHash("sha256").update(images.length ? JSON.stringify({text,images}) : text).digest("hex");
}

/** Bounded per-record memory, independent of total transcript image size. */
function* boundedLines(file: string): Generator<string> {
  const fd = openSync(file, "r"), block = Buffer.alloc(65536); let chunks: Buffer[] = [], bytes = 0;
  try {
    while (true) {
      const n = readSync(fd, block, 0, block.length, null); if (!n) break;
      let from = 0;
      while (from < n) {
        const index = block.indexOf(10, from), end = index >= 0 && index < n ? index : n;
        const part = Buffer.from(block.subarray(from, end)); bytes += part.length;
        if (bytes > 32 * 1024 ** 2) throw new Error("Pi history record exceeds the read limit");
        chunks.push(part);
        if (end < n) { yield Buffer.concat(chunks, bytes).toString("utf8"); chunks = []; bytes = 0; }
        from = end + 1;
      }
    }
    if (bytes) yield Buffer.concat(chunks, bytes).toString("utf8");
  } finally { closeSync(fd); }
}
