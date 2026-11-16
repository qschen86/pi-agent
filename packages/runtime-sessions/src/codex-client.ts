/**
 * Codex app-server 的 stdio JSON-RPC 客户端（F02）。
 *
 * 平台自己启动并管理这个进程，不附着 Desktop 的私有连接。参数用数组传、环境变量走允许列表，
 * 用户 prompt 只经协议消息发送，不拼接 shell。
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export type JsonRpcId = number | string;
export interface ServerRequestMsg { id: JsonRpcId; method: string; params: Record<string, unknown> }
export interface NotificationMsg { method: string; params: Record<string, unknown> }

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message); }
}

/** 服务进程可见的环境变量允许列表：不把平台的全量环境（含各类 API key）传给 runtime */
export const ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "CODEX_HOME", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "PI_AGENT_CONSOLE_PORT"];
export function allowlistedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
  // launchd 下 PATH 可能很短：补上常见位置，runtime 执行的命令才找得到 git / node
  const extraPath = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const parts = (env["PATH"] ?? "").split(":").filter(Boolean);
  for (const p of extraPath) if (!parts.includes(p)) parts.push(p);
  env["PATH"] = parts.join(":");
  return { ...env, ...extra };
}

export interface CodexClientOptions { binaryPath: string; cwd?: string; args?: string[]; env?: Record<string, string>; requestTimeoutMs?: number }

/**
 * 事件：
 *  - "notification" (msg)
 *  - "request" (msg)：服务端请求（审批、用户输入），必须调用 respond/respondError
 *  - "exit" ({ code, signal, stderrTail })
 */
export class CodexAppServerClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }>();
  private stderrTail = "";
  private exited = false;
  initializeResult?: Record<string, unknown>;

  constructor(private readonly opts: CodexClientOptions) { super(); }

  get alive(): boolean { return !!this.proc && !this.exited; }

  async start(): Promise<Record<string, unknown>> {
    const proc = spawn(this.opts.binaryPath, this.opts.args ?? ["app-server"], {
      cwd: this.opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: this.opts.env ?? allowlistedEnv()
    });
    this.proc = proc;
    proc.on("error", (e) => this.onExit(null, null, e.message));
    proc.on("exit", (code, signal) => this.onExit(code, signal));
    proc.stderr.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000); });
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    const init = await this.request("initialize", {
      clientInfo: { name: "pi_agent", title: "pi-agent", version: "2.8.0" },
      capabilities: { experimentalApi: true }
    }) as Record<string, unknown>;
    this.notify("initialized", undefined);
    this.initializeResult = init;
    return init;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, err?: string): void {
    if (this.exited) return;
    this.exited = true;
    const tail = err ? `${err}\n${this.stderrTail}` : this.stderrTail;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new RpcError(`Codex app-server 已退出（${code ?? signal ?? "?"}）：${p.method}`)); }
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
      clearTimeout(p.timer);
      if ("error" in msg) {
        const e = msg["error"] as { message?: string; code?: number; data?: unknown };
        p.reject(new RpcError(e?.message ?? "app-server 返回错误", e?.code, e?.data));
      } else p.resolve(msg["result"]);
      return;
    }
    if (typeof msg["method"] === "string") {
      if (id !== undefined) this.emit("request", { id, method: msg["method"], params: (msg["params"] ?? {}) as Record<string, unknown> });
      else this.emit("notification", { method: msg["method"], params: (msg["params"] ?? {}) as Record<string, unknown> });
    }
  }

  private write(obj: unknown): void {
    if (!this.proc || this.exited) throw new RpcError("Codex app-server 未运行");
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`Codex app-server 请求超时：${method}`));
      }, timeoutMs ?? this.opts.requestTimeoutMs ?? 60_000);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write(params === undefined ? { id, method } : { id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }

  notify(method: string, params: unknown): void { this.write(params === undefined ? { method } : { method, params }); }
  respond(id: JsonRpcId, result: unknown): void { this.write({ id, result }); }
  respondError(id: JsonRpcId, message: string): void { this.write({ id, error: { code: -32000, message } }); }

  stop(): void {
    if (!this.proc || this.exited) return;
    this.proc.stdin.end();
    const p = this.proc;
    setTimeout(() => { if (!this.exited) p.kill("SIGTERM"); }, 1500).unref();
  }
}
