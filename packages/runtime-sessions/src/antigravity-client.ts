/**
 * Antigravity CLI（agy）的 ACP stdio JSON-RPC 客户端。
 *
 * 平台自己拉起 `agy acp --process-per-session`，参数用数组传、环境变量走允许列表，
 * 用户 prompt 只经协议消息发送，不拼接 shell。不声明任何客户端能力（fs / terminal），
 * 文件和命令都由 agy 自己执行，权限请求经 session/request_permission 回到平台审批。
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { allowlistedEnv, RpcError } from "./codex-client.js";
import type { JsonRpcId, NotificationMsg, ServerRequestMsg } from "./codex-client.js";

export interface AcpClientOptions { binaryPath: string; cwd?: string; args?: string[]; env?: Record<string, string>; requestTimeoutMs?: number }

/**
 * 事件：
 *  - "notification" (msg)：session/update
 *  - "request" (msg)：服务端请求（session/request_permission），必须调用 respond/respondError
 *  - "exit" ({ code, signal, stderrTail })
 */
export class AcpClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout; method: string }>();
  private stderrTail = "";
  private exited = false;
  initializeResult?: Record<string, unknown>;

  constructor(private readonly opts: AcpClientOptions) { super(); }

  get alive(): boolean { return !!this.proc && !this.exited; }

  async start(): Promise<Record<string, unknown>> {
    const proc = spawn(this.opts.binaryPath, this.opts.args ?? ["acp", "--process-per-session"], {
      cwd: this.opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: this.opts.env ?? allowlistedEnv()
    });
    this.proc = proc;
    proc.on("error", (e) => this.onExit(null, null, e.message));
    proc.on("exit", (code, signal) => this.onExit(code, signal));
    proc.stdin.on("error", () => { /* 进程退出后的写入失败由 exit 事件统一处理 */ });
    proc.stderr.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000); });
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    const init = await this.request("initialize", {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "pi_agent", title: "pi-agent", version: "3.0.0" }
    }) as Record<string, unknown>;
    this.initializeResult = init;
    return init;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, err?: string): void {
    if (this.exited) return;
    this.exited = true;
    const tail = err ? `${err}\n${this.stderrTail}` : this.stderrTail;
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(new RpcError(`Antigravity ACP 进程已退出（${code ?? signal ?? "?"}）：${p.method}`)); }
    this.pending.clear();
    this.emit("exit", { code, signal, stderrTail: tail.slice(-2000) });
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const id = msg["id"] as JsonRpcId | undefined;
    if (id !== undefined && ("result" in msg || "error" in msg) && !("method" in msg)) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if ("error" in msg) {
        const e = msg["error"] as { message?: string; code?: number; data?: unknown };
        p.reject(new RpcError(e?.message ?? "agy 返回错误", e?.code, e?.data));
      } else p.resolve(msg["result"]);
      return;
    }
    if (typeof msg["method"] === "string") {
      if (id !== undefined) this.emit("request", { id, method: msg["method"], params: (msg["params"] ?? {}) as Record<string, unknown> } satisfies ServerRequestMsg);
      else this.emit("notification", { method: msg["method"], params: (msg["params"] ?? {}) as Record<string, unknown> } satisfies NotificationMsg);
    }
  }

  private write(obj: unknown): void {
    if (!this.proc || this.exited) throw new RpcError("Antigravity ACP 未运行");
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(obj as object) })}\n`);
  }

  /** timeoutMs=0：不设超时（session/prompt 这类长请求靠中断或进程退出收尾） */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const ms = timeoutMs ?? this.opts.requestTimeoutMs ?? 60_000;
      const timer = ms > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`Antigravity ACP 请求超时：${method}`));
      }, ms) : undefined;
      this.pending.set(id, { resolve, reject, ...(timer ? { timer } : {}), method });
      try { this.write({ id, method, params }); }
      catch (e) { if (timer) clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }

  notify(method: string, params: unknown): void { this.write({ method, params }); }
  respond(id: JsonRpcId, result: unknown): void { this.write({ id, result }); }
  respondError(id: JsonRpcId, message: string): void { this.write({ id, error: { code: -32601, message } }); }

  stop(): void {
    if (!this.proc || this.exited) return;
    this.proc.stdin.end();
    const p = this.proc;
    setTimeout(() => { if (!this.exited) p.kill("SIGTERM"); }, 1500).unref();
  }
}
