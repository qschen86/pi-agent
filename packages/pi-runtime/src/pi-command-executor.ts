/** Host-side command execution: a child cannot relax its inherited Seatbelt boundary. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { compileRuntimeGuardPolicy } from "../../adapter-pi/src/runtime-guard-policy.js";
import { killProcessGroup, killProcessTree, trackProcessGroup } from "../../adapter-pi/src/process-tree.js";
import { SeatbeltRuntimeGuard } from "../../adapter-pi/src/os-sandbox.js";
import { verifyRuntimeGuard } from "../../adapter-pi/src/runtime-guard.js";
import type { RuntimeGuardProvider } from "@pi-agent/runtime-contracts";
import type { RuntimeControlSink } from "./types.js";
import { piWorktreeAccess, type PiWorktreeIdentity } from "./pi-worktree-access.js";

export interface PiCommandRequest { toolCallId: string; command: string; reason: string; capability: "git" | "browser"; timeout: number }
export interface PiCommandResult { output: string; exitCode: number; cancelled?: boolean; timedOut?: boolean }
interface Options {
  workspace: string; env: Record<string, string>; runtimeRoot: string; guardDir: string; sink: RuntimeControlSink;
  guard?: RuntimeGuardProvider;
  readable?: string[];
  writable?: string[];
  worktree?: PiWorktreeIdentity;
  /** Test seam. Production always prepares a separate OS boundary. */
  run?: (request: PiCommandRequest, signal: AbortSignal) => Promise<PiCommandResult>;
}
const failure = (output: string, cancelled = false): PiCommandResult => ({ output, exitCode: 1, ...(cancelled ? { cancelled: true } : {}) });
export function parsePiCommandRequest(value: unknown): PiCommandRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(k => !["toolCallId", "command", "reason", "capability", "timeout"].includes(k))) return;
  if (typeof p.toolCallId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(p.toolCallId) || typeof p.command !== "string" || !p.command.trim() || p.command.length > 3000 || p.command.includes("\0") || typeof p.reason !== "string" || !p.reason.trim() || p.reason.length > 600 || !["git", "browser"].includes(String(p.capability)) || !Number.isInteger(p.timeout) || Number(p.timeout) < 1 || Number(p.timeout) > 3600) return;
  return { toolCallId: p.toolCallId, command: p.command, reason: p.reason, capability: p.capability as PiCommandRequest["capability"], timeout: Number(p.timeout) };
}

export class PiCommandExecutor {
  private readonly abort = new AbortController();
  private readonly seen = new Set<string>();
  private readonly running = new Set<Promise<PiCommandResult>>();
  private readonly initialGit: ReturnType<typeof piWorktreeAccess>;
  constructor(private readonly options: Options) { this.initialGit = piWorktreeAccess(options.workspace, options.worktree); }
  async execute(value: unknown): Promise<PiCommandResult> {
    const request = parsePiCommandRequest(value), signal = this.abort.signal;
    if (!request || signal.aborted || this.seen.has(request.toolCallId)) return failure("Invalid, duplicate or cancelled permission request", signal.aborted);
    this.seen.add(request.toolCallId);
    const git = piWorktreeAccess(this.options.workspace, this.options.worktree);
    if (request.capability === "git" && (!git?.writeRoots.length || JSON.stringify(git) !== JSON.stringify(this.initialGit))) return failure("Git expansion requires the original verified linked worktree and branch");
    const scope = request.capability === "git" ? `${this.options.workspace}; Git writes: this worktree's index/commit message/reflog, shared object store, refs/heads/${git!.branch}; HEAD/repository pointers and other branches stay protected` : `${this.options.workspace}; Chromium rendezvous IPC; isolated HOME/TMPDIR; no outside workspace writes`;
    this.options.sink.status("waiting-input");
    try {
      const decision = await this.options.sink.approval({ nativeRequestId: `pi-expand:${request.toolCallId}`, kind: "permissions", title: `Pi · 扩大本次${request.capability === "git" ? " Git" : "浏览器"}执行权限`, action: `${request.command}\n原因：${request.reason}\n超时：${request.timeout}s`, scope, source: "Pi 宿主受控执行器（单次授权）", requiresExplicitApproval: true, params: { ...request, workspace: this.options.workspace, scope, ...(request.capability === "git" ? { gitWriteRoots: git!.writeRoots } : {}) } }, signal);
      if (!decision.approve || signal.aborted) return failure(decision.reason || "Permission expansion denied or cancelled", signal.aborted);
      if (request.capability === "git" && JSON.stringify(piWorktreeAccess(this.options.workspace, this.options.worktree)) !== JSON.stringify(git)) return failure("Git authorization changed while approval was pending");
      this.options.sink.status("running");
      const execution = this.options.run ? this.options.run(request, signal) : this.run(request, signal);
      this.running.add(execution);
      try { return await execution; } finally { this.running.delete(execution); }
    } catch (error) { return failure(`Permission execution failed: ${(error as Error).message}`, signal.aborted); }
    finally { if (!signal.aborted) this.options.sink.status("running"); }
  }
  private async run(request: PiCommandRequest, signal: AbortSignal): Promise<PiCommandResult> {
    const { workspace, runtimeRoot, guardDir, env } = this.options;
    const git = piWorktreeAccess(workspace, this.options.worktree);
    const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0"
      ? process.env.PLAYWRIGHT_BROWSERS_PATH : join(homedir(), "Library", "Caches", "ms-playwright");
    const browserReads = request.capability === "browser" && existsSync(browserCache) ? [browserCache] : [];
    const policy = compileRuntimeGuardPolicy({ workspaceRoot: workspace, writeSubPaths: ["."], runtimeWritable: this.options.writable ?? [runtimeRoot], runtimeReadable: [...(git?.readRoots ?? []), ...(this.options.readable ?? []), ...browserReads] });
    if (request.capability === "git") policy.filesystem.writeScope.push(...(git?.writeRoots ?? []));
    const guard = this.options.guard ?? new SeatbeltRuntimeGuard({ chromium: request.capability === "browser" });
    if (!guard.available()) return failure("Permission execution guard unavailable");
    const commandGuard = join(guardDir, `command-${randomUUID()}`);
    mkdirSync(commandGuard, { recursive: true, mode: 0o700 });
    const prepared = await guard.prepare({ policy, guardDir: commandGuard, runtimeTmp: env.TMPDIR });
    try {
      const check = await verifyRuntimeGuard(prepared, { policy, runtimeTmp: env.TMPDIR, guardDir: commandGuard });
      if (!check.passed) return failure(`Command boundary self-check failed: ${check.failures.join("; ")}`);
      const wrapped = await prepared.wrap("/bin/bash", ["--noprofile", "--norc", "-c", request.command]);
      if (signal.aborted) return failure("Turn stopped before command execution", true);
      return await runPiCommand(wrapped.command, wrapped.args, { cwd: workspace, env: { ...env, ...(browserReads.length ? { PLAYWRIGHT_BROWSERS_PATH: browserCache } : {}), ...wrapped.env }, timeoutMs: request.timeout * 1000, signal });
    } finally { await prepared.dispose(); }
  }
  async dispose(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled([...this.running]);
  }
}

/** Bounded capture and whole-process-group cleanup, including background children holding pipes. */
export function runPiCommand(command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal: AbortSignal }): Promise<PiCommandResult> {
  if (options.signal.aborted) return Promise.resolve(failure("Command cancelled before spawn", true));
  // Child groups can outlive/reparent away from their command root. A unique inherited marker lets
  // the host find them after normal parent exit, while live ancestry catches children with custom env.
  // Environment snapshots stay in memory, are never logged and are immediately reduced to PID pairs.
  const marker = `PI_AGENT_COMMAND_RUN_ID=${randomUUID()}`;
  const snapshot = (): Array<{pid: number; ppid: number; started: string; tagged: boolean}> | undefined => {
    const ps = spawnSync("/bin/ps", ["eww", "-axo", "pid=,ppid=,lstart=,command="], { encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
    if (ps.status !== 0) return;
    return ps.stdout.split("\n").flatMap(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+/.exec(line);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), started: m[3], tagged: line.includes(` ${marker} `) || line.endsWith(` ${marker}`) }] : [];
    });
  };
  if (!snapshot()) return Promise.resolve(failure("Host process supervision unavailable; command not started"));
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...options.env, PI_AGENT_COMMAND_RUN_ID: marker.slice("PI_AGENT_COMMAND_RUN_ID=".length) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const untrack = child.pid ? trackProcessGroup(child.pid) : () => {};
    let output = "", truncated = false, timedOut = false, cancelled = false, resolved = false;
    const capture = (data: Buffer) => { output += data.toString("utf8"); if (output.length > 48000) { truncated = true; output = output.slice(-48000); } };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const descendants = new Map<number, string>();
    const observe = () => {
      const rows = snapshot(); if (!rows) return;
      const family = new Set([child.pid, ...rows.filter(row => descendants.get(row.pid) === row.started).map(row => row.pid)]);
      let changed = true;
      while (changed) { changed = false; for (const row of rows) if (row.tagged || family.has(row.ppid)) { if (!family.has(row.pid)) { family.add(row.pid); changed = true; } } }
      for (const row of rows) if (family.has(row.pid) && row.pid !== child.pid) descendants.set(row.pid, row.started);
    };
    const monitor = setInterval(observe, 100);
    const stop = () => {
      observe();
      if (child.pid) killProcessTree(child.pid);
      for (const row of snapshot() ?? []) if (descendants.get(row.pid) === row.started) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
    };
    process.once("exit", stop);
    const cancel = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const finish = (exitCode: number) => {
      if (resolved) return; resolved = true; clearTimeout(timer); clearInterval(monitor); options.signal.removeEventListener("abort", cancel);
      stop(); process.removeListener("exit", stop);
      if (child.pid) killProcessGroup(child.pid); untrack();
      resolve({ output: `${truncated ? "[earlier output truncated]\n" : ""}${output}${timedOut ? "\nCommand timed out" : cancelled ? "\nCommand cancelled" : ""}`, exitCode, ...(timedOut ? { timedOut: true } : {}), ...(cancelled ? { cancelled: true } : {}) });
    };
    options.signal.addEventListener("abort", cancel, { once: true }); if (options.signal.aborted) cancel();
    child.once("exit", stop);
    child.once("error", error => { capture(Buffer.from(error.message)); finish(1); });
    child.once("close", code => finish(timedOut || cancelled ? 1 : code ?? 1));
  });
}
