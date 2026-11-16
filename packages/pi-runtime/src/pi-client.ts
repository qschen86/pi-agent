/** Pi RPC stdio: only LF frames JSON; prompt acceptance never means turn completion. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface PiClientOptions {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  requestTimeoutMs?: number;
  detached?: boolean;
  passthroughResponses?: boolean;
  exitGraceMs?: number;
  /** A supervisor must finish worker shutdown before its remaining process group is reaped. */
  gracefulShutdown?: boolean;
}
export type PiRpcEvent = Record<string, unknown> & { type: string };
const MAX_LINE_BYTES = 2 * 1024 * 1024;
/**
 * Frames the platform can lose when oversized, because the same content is already
 * delivered by a smaller frame:
 * - agent_end / turn_end repeat every message of the run (screenshots included) and
 *   the turn's messages, both already delivered by message_end;
 * - tool_execution_end / tool_execution_update carry the tool result that follows as
 *   the toolResult message of message_start/message_end, which projects the same
 *   `pi:tool:<id>` item with output and completed/failed status.
 * Pi mirrors an image block into `structuredContent` as well, so a single full-page
 * screenshot can put a tool result over the frame limit while its message copy fits.
 * Pi serializes events with JSON.stringify, so `type` is the leading key.
 */
const DROPPABLE_OVERSIZED_FRAME = /^\{"type":"(?:agent_end|turn_end|tool_execution_(?:end|update))"[,}]/;

function isImageBlock(value: unknown): value is { type: "image"; data?: unknown; note?: unknown } {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "image";
}

/** Base64 payloads the frame already carries in `content`, where they belong. */
function contentImageData(content: unknown): Set<string> | undefined {
  if (!Array.isArray(content)) return undefined;
  let data: Set<string> | undefined;
  for (const part of content) if (isImageBlock(part) && typeof part.data === "string") (data ??= new Set()).add(part.data);
  return data;
}

/** Replace a mirrored image block with the note that described it: keep the hint, drop the bytes. `undefined` drops it. */
function withoutMirroredBlock(value: unknown, mirrored: Set<string>, seen: WeakSet<object>): unknown {
  if (isImageBlock(value) && typeof value.data === "string" && mirrored.has(value.data)) return typeof value.note === "string" && value.note ? value.note : undefined;
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) { const next = withoutMirroredBlock(item, mirrored, seen); if (next !== undefined) kept.push(next); }
    return kept;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    const next = withoutMirroredBlock(item, mirrored, seen);
    if (next === undefined) delete record[key]; else record[key] = next;
  }
  return value;
}

function stripHolder(holder: unknown): void {
  if (!holder || typeof holder !== "object" || Array.isArray(holder)) return;
  const record = holder as Record<string, unknown>;
  const mirrored = contentImageData(record.content);
  if (!mirrored || record.structuredContent === undefined) return;
  const structured = withoutMirroredBlock(record.structuredContent, mirrored, new WeakSet());
  if (structured === undefined) delete record.structuredContent; else record.structuredContent = structured;
}

/**
 * Pi's `read` mirrors the image into `content` and `structuredContent` (its output schema
 * accepts either), and tool frames ship the whole result. Structured output is for
 * programmatic tool callers, not for the platform, so forwarding it once halves the frame.
 */
export function stripMirroredToolResultImages(event: PiRpcEvent): void {
  stripHolder(event);
  for (const key of ["result", "partialResult", "message", "data"]) stripHolder(event[key]);
  for (const key of ["messages", "toolResults"]) {
    const list = event[key];
    if (Array.isArray(list)) for (const item of list) stripHolder(item);
  }
}

export class PiRpcClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  /** Inside an oversized droppable frame: discard bytes until its LF. */
  private discarding = false;
  private nextId = 1;
  private exited = false;
  private resolveClosed!: () => void;
  private readonly closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; type: string }>();

  constructor(private readonly options: PiClientOptions) { super(); }
  get alive(): boolean { return !!this.proc && !this.exited; }

  async start(): Promise<void> {
    if (this.proc) throw new Error("Pi RPC client already started");
    const proc = spawn(this.options.binaryPath, this.options.args, {
      cwd: this.options.cwd, env: this.options.env, stdio: ["pipe", "pipe", "pipe"], detached: this.options.detached ?? process.platform !== "win32"
    });
    this.proc = proc;
    proc.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    // Drain stderr, without forwarding possible provider secrets into platform logs.
    proc.stderr.resume();
    proc.stdin.on("error", () => this.finish("Pi RPC exit: stdin closed"));
    proc.on("error", () => this.finish("Pi RPC exit: process could not start"));
    proc.on("close", (code, signal) => { this.finish(`Pi RPC exit: ${code ?? signal ?? "unknown"}`); this.resolveClosed(); });
    await new Promise<void>((resolve, reject) => { proc.once("spawn", resolve); proc.once("error", () => reject(new Error("Pi RPC process could not start"))); });
  }

  request(type: string, params: Record<string, unknown> = {}, timeoutMs = this.options.requestTimeoutMs ?? 15_000): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error("Pi RPC exit: client unavailable"));
    const id = `pi-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi RPC timeout: ${type}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, type });
      this.write({ ...params, id, type });
    });
  }

  respondUi(id: string, response: { confirmed?: boolean; cancelled?: boolean; value?: string }): void {
    if (this.alive) this.write({ ...response, id, type: "extension_ui_response" });
  }
  forward(message: Record<string, unknown>): void { this.write(message); }

  private write(message: Record<string, unknown>): void {
    this.proc?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: Buffer): void {
    if (this.exited) return;
    if (this.discarding) {
      const end = chunk.indexOf(10);
      if (end < 0) return;
      this.discarding = false;
      chunk = chunk.subarray(end + 1);
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      if (newline > MAX_LINE_BYTES) {
        if (!this.droppableOversized()) return this.protocolError(`JSONL frame exceeds ${MAX_LINE_BYTES}-byte limit`);
        this.buffer = this.buffer.subarray(newline + 1);
        continue;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let message: PiRpcEvent;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as PiRpcEvent).type !== "string") return this.protocolError();
        message = parsed as PiRpcEvent;
      } catch { return this.protocolError(); }
      stripMirroredToolResultImages(message);
      if (message.type === "response") {
        const pending = this.pending.get(String(message.id));
        if (!pending) { if (this.options.passthroughResponses) this.emit("event", message); continue; }
        if (message.command !== pending.type || typeof message.success !== "boolean") return this.protocolError();
        this.pending.delete(String(message.id)); clearTimeout(pending.timer);
        if (message.success) pending.resolve(message.data);
        else pending.reject(new Error(typeof message.error === "string" ? message.error : `Pi RPC request failed: ${pending.type}`));
      } else this.emit("event", message);
      if (this.exited) return;
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      if (!this.droppableOversized()) return this.protocolError(`JSONL frame exceeds ${MAX_LINE_BYTES}-byte limit`);
      this.buffer = Buffer.alloc(0); this.discarding = true;
    }
  }

  private droppableOversized(): boolean {
    return DROPPABLE_OVERSIZED_FRAME.test(this.buffer.subarray(0, 32).toString("latin1"));
  }

  private protocolError(detail = "invalid JSONL"): void { this.finish(`Pi RPC protocol error: ${detail}`); this.kill(); }

  private finish(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear(); this.buffer = Buffer.alloc(0); this.discarding = false;
    this.emit("exit", { reason });
  }

  private kill(): void {
    const pid = this.proc?.pid;
    if (!pid) return;
    try { if (process.platform !== "win32" && this.options.detached !== false && !this.options.gracefulShutdown) process.kill(-pid, "SIGTERM"); else this.proc?.kill("SIGTERM"); } catch { /* exited */ }
  }
  stop(): void { this.finish("Pi RPC exit: stopped"); this.kill(); }
  async waitForExit(): Promise<void> {
    if (!this.proc) return;
    const timer = setTimeout(() => {
      try { if (process.platform !== "win32" && this.options.detached !== false && this.proc?.pid) process.kill(-this.proc.pid, "SIGKILL"); else this.proc?.kill("SIGKILL"); } catch { /* exited */ }
    }, this.options.exitGraceMs ?? 2000);
    try { await this.closed; } finally {
      clearTimeout(timer);
      if(this.options.gracefulShutdown&&process.platform!=='win32'&&this.options.detached!==false&&this.proc.pid){try{process.kill(-this.proc.pid,'SIGKILL');}catch{/* group already gone */}}
    }
  }
}
