import {screenshotViolation} from "./screenshot-policy.mjs";
import {scanViolation} from "./scan-policy.mjs";
/** Standalone extension copied into a host-owned, read-only guard directory. */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
interface ToolCall { toolName: string; toolCallId: string; input: Record<string, unknown> }
interface ToolContext {
  hasUI: boolean;
  signal?: AbortSignal;
  ui: { confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean> };
}
type Block = { block: true; reason: string };
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "web_search", "web_open"]);
const MEMORY_TOOLS = new Set(["memory_add", "memory_replace", "memory_remove", "memory_search"]);
const MUTATION_TOOLS = new Set(["write", "edit", "bash"]);
/** bash 后台任务的查看/终止：只能碰本进程自己启动的任务、不执行任何命令；启动本身是带 background 的 bash 调用，照常过上面的闸门。 */
const JOB_TOOLS = new Set(["bash_output", "bash_kill"]);

/** 会话在自己的 worktree 里改代码时的写入边界：repoRoot 之内、allow 之外的 write/edit 一律拒绝。 */
export interface PiWorktreeWriteGuard { cwd: string; allow: string; repoRoot: string }
const WRITE_PATH_TOOLS = new Set(["write", "edit"]);
const within = (p: string, root: string): boolean => p === root || p.startsWith(root + sep);
/** 最近的已存在祖先取 realpath（挡住指向主仓的符号链接），不存在的尾部按字面接上。 */
function canon(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(cur), ...tail.reverse()); }
    catch { const up = dirname(cur); if (up === cur) return resolve(p); tail.push(basename(cur)); cur = up; }
  }
}
export function parsePiWorktreeWriteGuard(raw: string | undefined): PiWorktreeWriteGuard | undefined | "invalid" {
  if (!raw) return;
  try {
    const v = JSON.parse(raw) as Partial<PiWorktreeWriteGuard>;
    if (typeof v.cwd !== "string" || typeof v.allow !== "string" || typeof v.repoRoot !== "string" || !isAbsolute(v.cwd) || !isAbsolute(v.allow) || !isAbsolute(v.repoRoot)) return "invalid";
    return { cwd: canon(v.cwd), allow: canon(v.allow), repoRoot: canon(v.repoRoot) };
  } catch { return "invalid"; }
}
/** 返回拒绝原因；允许时返回 undefined。仓库之外（/tmp、运行时目录）不在这道门的范围内。 */
export function worktreeWriteViolation(guard: PiWorktreeWriteGuard, input: Record<string, unknown>): string | undefined {
  const raw = [input["path"], input["file_path"]].find((v): v is string => typeof v === "string" && v.length > 0);
  if (!raw) return "Write target path is missing";
  const path = raw.startsWith("@") ? raw.slice(1) : raw;
  const target = canon(isAbsolute(path) ? path : resolve(guard.cwd, path));
  if (within(target, guard.allow) || !within(target, guard.repoRoot)) return;
  const inOtherWorktree = within(target, join(guard.repoRoot, ".pi-worktrees"));
  const hint = inOtherWorktree ? "" : ` Use ${join(guard.allow, relative(guard.repoRoot, target))} instead.`;
  return `Write refused: ${target} is inside the main repository but outside this session's worktree (${guard.allow}).${hint}`;
}

export interface PiCommunityGate { tools: string[]; ready(): boolean }
export function createPiToolGate(mode: string, community?: PiCommunityGate, nativeMemory = false, factsEnabled=false, worktreeGuard?: PiWorktreeWriteGuard | "invalid") {
  const seen = new Set<string>();
  return async (event: ToolCall, ctx: ToolContext): Promise<Block | undefined> => {
    const deny = (reason: string): Block => ({ block: true, reason });
    if (!["pi-read-only", "pi-ask", "pi-native", "pi-evaluation"].includes(mode)) return deny("Unknown permission mode");
    if (ctx.signal?.aborted) return deny("Turn interrupted");
    if (community && (mode !== "pi-ask" || !community.ready())) return deny("Community permissions not ready");
    // 无界递归扫描（整盘 find / 家目录 grep）会挂住整轮：先于一切放行判断拦掉，reason 里带替代写法。
    const scanRoots = worktreeGuard && worktreeGuard !== "invalid" ? worktreeGuard : undefined;
    const scan = scanViolation(event.toolName, event.input ?? {}, { cwd: scanRoots?.cwd ?? process.cwd(), ...(scanRoots ? { allow: scanRoots.allow, repoRoot: scanRoots.repoRoot } : {}) });
    if (scan) return deny(scan);
    const violation=process.env.PI_PLATFORM_BROWSER_SOCKET?screenshotViolation(event.toolName,event.input,worktreeGuard&&worktreeGuard!=="invalid"?worktreeGuard.cwd:process.cwd()):undefined;
    if(violation)return deny(violation);
    if (process.env.PI_CAPABILITY_SOCKET && ["capability_search","capability_describe","capability_invoke"].includes(event.toolName) && (mode === "pi-ask" || mode === "pi-native")) return;
    if (JOB_TOOLS.has(event.toolName) && (mode === "pi-ask" || mode === "pi-native")) return;
    if (READ_TOOLS.has(event.toolName) || event.toolName === "platform_browser" && !!process.env.PI_PLATFORM_BROWSER_SOCKET) return;
    // codemode 自己没有副作用：脚本里的 write/edit/bash 等嵌套调用会逐个再过这道闸门（读写限制、审批照常）。评测装配不挂它，仍按未知工具拒绝。
    if (event.toolName === "codemode" && mode !== "pi-evaluation") return;
    // The host executor owns the separate, explicit permission decision for this tool.
    if (event.toolName === "bash_escalated" && mode === "pi-ask") {
      if (!event.toolCallId || seen.has(event.toolCallId) || !ctx.hasUI) return deny("Duplicate, missing or unavailable host execution request");
      seen.add(event.toolCallId); return;
    }
    if (!MUTATION_TOOLS.has(event.toolName) && !community?.tools.includes(event.toolName) && !(nativeMemory && mode === "pi-native" && (MEMORY_TOOLS.has(event.toolName)||factsEnabled&&event.toolName==='memory_fact_submit'))) return deny("Unrecognized tool is not authorized");
    if (mode === "pi-read-only") return deny("Read-only conversation");
    if (!event.toolCallId || seen.has(event.toolCallId)) return deny("Duplicate or missing tool call ID");
    seen.add(event.toolCallId);
    if (worktreeGuard && WRITE_PATH_TOOLS.has(event.toolName)) {
      const reason = worktreeGuard === "invalid" ? "Worktree write guard configuration is invalid" : worktreeWriteViolation(worktreeGuard, event.input ?? {});
      if (reason) return deny(reason);
    }
    // The community extension owns allow/ask/deny; this gate only limits tool exposure.
    if (community) return;
    // Evaluation is host-authorized only inside a verified report-only OS boundary.
    if (mode === "pi-native" || mode === "pi-evaluation") return;
    if (!ctx.hasUI) return deny("No approval UI available");
    try {
      // Human decisions have no deadline; only the turn signal or frontend decision ends the wait.
      const allowed = await ctx.ui.confirm(`Pi · ${event.toolName}`, JSON.stringify(event), { signal: ctx.signal });
      if (!allowed || ctx.signal?.aborted) return deny("Approval denied, expired or interrupted");
    } catch { return deny("Approval unavailable"); }
  };
}

export const PI_ESCALATION_TITLE = "pi-chat-execute@1";
export function createPiEscalationTool() {
  const kind = Symbol.for("TypeBox.Kind");
  return {
    name: "bash_escalated", label: "单次扩大执行权限",
    description: "Retry a specific command through the host after the ordinary sandbox blocks linked-worktree Git writes (git) or Chromium IPC (browser). Requires separate human approval every time. Other workspaces and branches remain protected. First inspect the failed command for partial side effects; never blindly retry mutations. cwd is always the current workspace; use the isolated HOME and TMPDIR, not /tmp.",
    promptSnippet: "Request one-command Git or Chromium sandbox expansion after a verified boundary failure.",
    parameters: { [kind]: "Object", type: "object", additionalProperties: false, required: ["command", "reason", "capability", "timeout"], properties: {
      command: { [kind]: "String", type: "string", minLength: 1, maxLength: 3000 },
      reason: { [kind]: "String", type: "string", minLength: 1, maxLength: 600 },
      capability: { [kind]: "String", type: "string", enum: ["git", "browser"] },
      timeout: { [kind]: "Integer", type: "integer", minimum: 1, maximum: 3600 }
    } },
    execute: async (toolCallId: string, input: { command: string; reason: string; capability: string; timeout: number }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { hasUI: boolean; ui: { input(title: string, placeholder?: string, opts?: {signal?: AbortSignal; timeout?: number}): Promise<string | undefined> } }) => {
      if (!ctx.hasUI || signal?.aborted) throw new Error("Host execution unavailable or cancelled");
      const response = await ctx.ui.input(PI_ESCALATION_TITLE, JSON.stringify({ ...input, toolCallId }), { signal });
      if (!response || signal?.aborted) throw new Error("Host execution denied or cancelled");
      const result = JSON.parse(response) as { output: string; exitCode: number; cancelled?: boolean; timedOut?: boolean };
      if (typeof result.output !== "string" || !Number.isInteger(result.exitCode)) throw new Error("Invalid host command result");
      const text = `${result.output}\nExit code: ${result.exitCode}`;
      if (result.exitCode !== 0 || result.cancelled || result.timedOut) throw new Error(text);
      return { content: [{ type: "text" as const, text }], details: result };
    }
  };
}

export default function install(pi: {
  appendEntry?(customType: string, data: unknown): void;
  getActiveTools?(): string[];
  getAllTools?(): Array<{name: string; sourceInfo?: {source?: string}}>;
  registerTool?(definition: ReturnType<typeof createPiEscalationTool>): void;
  on(name: "tool_call", callback: ReturnType<typeof createPiToolGate>): void;
  on(name: "session_start", callback: (event: unknown, ctx: { ui: { notify(message: string, level: string): void } }) => void): void;
}, community?: PiCommunityGate, nativeMemory = false, factsEnabled=false): void {
  if (process.env["PI_CHAT_PERMISSION_MODE"] === "pi-ask") {
    if (!pi.registerTool) throw new Error("Pi host execution requires registerTool support");
    pi.registerTool(createPiEscalationTool());
  }
  pi.on("tool_call", createPiToolGate(process.env["PI_CHAT_PERMISSION_MODE"] ?? "pi-read-only", community, nativeMemory,factsEnabled, parsePiWorktreeWriteGuard(process.env["PI_CHAT_WORKTREE_GUARD"])));
  pi.on("session_start", (_event, ctx) => {
    if(process.env.PI_CAPABILITY_SOCKET && ["capability_search","capability_describe","capability_invoke"].some(name=>!pi.getActiveTools?.().includes(name)))throw new Error("Capability gateway tools missing from active Pi inventory");
    if(process.env.PI_PLATFORM_BROWSER_SOCKET&&!pi.getActiveTools?.().includes("platform_browser"))throw new Error("Platform browser tool missing from active Pi inventory");
    // The generated managed wrapper announces readiness after the community service initializes.
    if (community) return;
    if (process.env.PI_RUNTIME_BROWSER_PROFILE) pi.appendEntry?.("pi-runtime-browser", {id:process.env.PI_RUNTIME_BROWSER_PROFILE});
    if (process.env.PI_RUNTIME_ASSEMBLY) pi.appendEntry?.("pi-runtime-assembly", {fingerprint:process.env.PI_RUNTIME_ASSEMBLY});
    const token = process.env["PI_CHAT_GATE_TOKEN"] ?? "";
    if (process.env["PI_CHAT_PERMISSION_MODE"] !== "pi-evaluation") {
      ctx.ui.notify(`pi-chat-gate:${token}`, "info"); return;
    }
    let inventory: Record<string, unknown>;
    try {
      const activeTools = pi.getActiveTools?.(), all = pi.getAllTools?.();
      if (!Array.isArray(activeTools) || !Array.isArray(all)) throw new Error("Native inventory unavailable");
      inventory = {version: 1, token, activeTools, registeredTools: all.map(tool => ({name: tool.name, source: tool.sourceInfo?.source ?? "unknown"}))};
    } catch { inventory = {version: 1, token, error: "Native inventory unavailable"}; }
    ctx.ui.notify(`pi-chat-evaluation-tools:${JSON.stringify(inventory)}`, "info");
  });
}
