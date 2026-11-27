/**
 * Antigravity CLI（agy）驱动：经 `agy acp` 的 Agent Client Protocol（stdio JSON-RPC）。
 *
 * 协议事实来自真实 agy 1.5.14 的实测（Google AI Pro 登录）：
 *  - 会话 ID 由 agy 在 session/new 时分配（与 Codex 同类，平台不预分配）；
 *  - session/resume 在新进程里恢复同一会话；session/load 回放历史（只有消息与工具，没有 token 用量和时间）；
 *  - 执行命令 / 写文件前发 session/request_permission（allow_once / reject_once）；
 *  - session/prompt 响应带本轮 usage（输入、输出、缓存读、思考）；session/cancel 后 stopReason=cancelled；
 *  - 角色指令经 session/new 的 _meta.antigravity.systemPrompt.append 注入；
 *  - 账户额度由只读 CLI `-p /usage --output-format json` 读取；ACP usage_update 仅是上下文窗口。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AcpClient } from "./antigravity-client.js";
import { readAntigravityContinuation } from "./antigravity-continuation.js";
import { allowlistedEnv, RpcError } from "./codex-client.js";
import type { NotificationMsg, ServerRequestMsg } from "./codex-client.js";
import { underRoots } from "./codex.js";
import { cap, DriverStageError } from "./driver.js";
import type { DriverApproval, DriverEvent, HistoryItem, HistoryRead, NativeFingerprint, ProbeOutcome, RuntimeDriver, StartTurnArgs, TurnHandle, TurnResult, TurnSink } from "./driver.js";
import { defaultPermissionMode, permissionOption, permissionOptions } from "./permissions.js";
import { bounded, LIMITS, stringifyInput } from "./redact.js";
import type { Capability, CapabilityName, ModelOption, UsageRecord } from "./types.js";
import { CAPABILITIES } from "./types.js";

const run = promisify(execFile);
/** node:sqlite 只在真正读库时加载：加载失败按「读不到库」处理，不影响驱动其它能力 */
let sqliteModule: typeof import("node:sqlite") | undefined;
const sqlite = (): typeof import("node:sqlite") => (sqliteModule ??= createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite"));
export const ANTIGRAVITY_PARSER = "antigravity-acp@1";
/** steps 语义指纹的语式：s{条数}i{最大 idx}。上一版是「主库大小:mtime:WAL 大小」，两者不可比 */
export const ANTIGRAVITY_STEPS_FP = /^s\d+i-?\d+$/;
/** 没有活动轮次后保留 agy 进程的时间：避免每轮重新登录握手，又不长期占 75～100 MB 内存 */
export const ANTIGRAVITY_LINGER_MS = 10 * 60_000;
const MODE_ID: Record<string, string> = { default: "default", acceptEdits: "accept-edits", auto: "auto", plan: "plan", bypassPermissions: "default" };
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const FORCE_FINISH_MS = 8_000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
const num = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 不用空、错误或残缺的命令结果覆盖上一份有效快照。 */
export function parseAntigravityQuota(payload: unknown): NonNullable<ProbeOutcome["rateLimit"]> {
  const root = obj(payload), command = obj(root["command"]), groups = obj(command["data"])["groups"];
  if (root["status"] !== "SUCCESS" || command["name"] !== "usage" || root["num_turns"] !== 0) throw new Error("Antigravity CLI 未返回只读额度查询结果");
  if (!Array.isArray(groups) || !groups.length) throw new Error("Antigravity CLI 未提供模型组额度");
  const windows: NonNullable<ProbeOutcome["rateLimit"]>["windows"] = [];
  for (const entry of groups) {
    const group = obj(entry), name = str(group["name"])?.trim(), buckets = group["buckets"];
    if (!name || !Array.isArray(buckets) || !buckets.length) throw new Error("Antigravity 模型组额度格式不完整");
    for (const value of buckets) {
      const bucket = obj(value), remaining = num(bucket["remaining_fraction"]), reset = bucket["reset_time"];
      if (remaining === undefined || remaining < 0 || remaining > 1) throw new Error("Antigravity 剩余额度比例无效");
      if (reset != null && (typeof reset !== "string" || !Number.isFinite(Date.parse(reset)))) throw new Error("Antigravity 额度重置时间无效");
      const period = bucket["window"], label = period === "5h" ? "5 小时窗口" : period === "weekly" ? "周窗口" : str(bucket["name"])?.trim();
      if (!label) throw new Error("Antigravity 额度窗口名称缺失");
      windows.push({ group: name, label, usedPercent: (1 - remaining) * 100, resetsAt: reset == null ? null : new Date(reset as string).toISOString(),
        ...(period === "5h" ? { windowMinutes: 300 } : period === "weekly" ? { windowMinutes: 10080 } : {}) });
    }
  }
  return { windows, available: true, source: "agy CLI /usage (JSON)", sampledAt: new Date().toISOString() };
}

export interface AntigravityDriverOptions { binaryPath?: string; home?: string; env?: Record<string, string>; lingerMs?: number; quotaTimeoutMs?: number; /** 读不到会话库时的重试间隔（毫秒） */ fingerprintSettleMs?: number; /** 探测会话的固定目录（保存会话 ID）；默认放在系统临时目录 */ stateDir?: string }

interface ActiveTurn {
  client: AcpClient; sessionId: string; sink: TurnSink; clientMessageId: string; model?: string;
  browserSocket?: string; browserOutputLines: number;
  message: string; lastMessage: string; thought: string; messageNo: number; thoughtNo: number; lastText: "message" | "thought" | null;
  /** ACP usage_update 报的上下文占用与窗口上限：本轮最后一次的值，随这一轮的用量记录保存 */
  contextUsed?: number;
  contextSize?: number;
  readOnly: boolean; tools: Map<string, Json>; approvals: Map<string, AbortController>; finish: (r: TurnResult) => void; settled: boolean; cancelled: boolean;
}

/** end_turn 后仍由原 ACP 进程与 clientMessageId 拥有的消息、工具及审批接收通道。 */
interface BackgroundContinuationChannel {
  turn: ActiveTurn; revision: number; verifiedRevision: number; streamedKeys: Set<string>; matchedLiveKeys: Set<string>; events: Map<string, DriverEvent>; tools: Set<string>; close: () => void;
  client: AcpClient; sink: TurnSink; clientMessageId: string; readOnly: boolean; approvals: Map<string, AbortController>;
}

export class AntigravityDriver implements RuntimeDriver {
  readonly kind = "antigravity" as const;
  private turnClient?: AcpClient;
  private bypassTurnClient?: AcpClient;
  private historyClient?: AcpClient;
  /** 最近一次承载该原生会话的 agy ACP 进程：进程已退出或重启后不再把库里残留任务判成 pending */
  private readonly sessionClient = new Map<string, AcpClient>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly continuations = new Map<string, BackgroundContinuationChannel>();
  private readonly starting = new Set<string>();
  private readonly collectors = new Map<string, (update: Json) => void>();
  private lingerTimers = new Map<AcpClient, NodeJS.Timeout>();
  private tierName: string | undefined;
  /** 最近一次读成功的语义指纹：读不到库时沿用它，不把「读不到」变成外部写入或只读阻断 */
  private readonly lastFingerprint = new Map<string, string>();

  constructor(private readonly opts: AntigravityDriverOptions = {}) {}

  private get home(): string { return this.opts.home ?? homedir(); }
  private get dataDir(): string { return join(this.home, ".gemini", "antigravity-cli"); }
  private processEnv(): Record<string, string> {
    return this.opts.env ? { ...this.opts.env, HOME: this.home } : allowlistedEnv({ HOME: this.home });
  }

  resolveBinary(): string | undefined {
    const pinned = this.opts.binaryPath ?? process.env["PI_AGENT_AGY_BIN"];
    const candidates = pinned
      ? [pinned]
      : [join(this.home, ".local", "bin", "agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy",
        ...(process.env["PATH"] ?? "").split(":").filter(Boolean).map((d) => join(d, "agy"))];
    return candidates.find((c): c is string => !!c && c.startsWith("/") && existsSync(c));
  }

  /* ------------------------------ 进程管理 ------------------------------ */

  private async ensureClient(slot: "turn" | "bypass" | "history"): Promise<AcpClient> {
    const existing = slot === "turn" ? this.turnClient : slot === "bypass" ? this.bypassTurnClient : this.historyClient;
    if (existing?.alive) { this.armLinger(existing); return existing; }
    const bin = this.resolveBinary();
    if (!bin) throw new Error("找不到 agy：请先安装 Antigravity CLI（curl -fsSL https://antigravity.google/cli/install.sh | bash）");
    const args = slot === "bypass" ? ["acp", "--process-per-session", "--dangerously-skip-permissions"] : ["acp", "--process-per-session"];
    // 显式固定 agy 进程的启动 cwd，绝不继承宿主进程的 process.cwd()（蓝绿部署时为 slots/blue 或 slots/green）：
    // agy 会把启动 cwd 自动写进系统提示顶部的 Active Workspaces，切槽若跟着变会导致前缀缓存 0% 命中。
    mkdirSync(this.probeDir, { recursive: true });
    const client = new AcpClient({ binaryPath: bin, args, cwd: this.probeDir, env: this.processEnv(), requestTimeoutMs: 60_000 });
    client.on("notification", (m: NotificationMsg) => this.onNotification(client, m));
    client.on("request", (m: ServerRequestMsg) => this.onServerRequest(client, m));
    client.on("exit", (info: { code: number | null; signal: string | null; stderrTail: string }) => this.onClientExit(client, info));
    client.on("error", () => { /* 事件由 exit 统一处理 */ });
    if (slot === "turn") this.turnClient = client;
    else if (slot === "bypass") this.bypassTurnClient = client;
    else this.historyClient = client;
    try { await client.start(); }
    catch (e) {
      if (slot === "turn") this.turnClient = undefined;
      else if (slot === "bypass") this.bypassTurnClient = undefined;
      else this.historyClient = undefined;
      client.stop();
      throw e;
    }
    this.armLinger(client);
    return client;
  }

  private closeContinuation(sid: string): void {
    const ch = this.continuations.get(sid);
    if (!ch) return;
    this.flushText(ch.turn);
    this.continuations.delete(sid);
    for (const [, ac] of ch.approvals) ac.abort();
    ch.approvals.clear();
    ch.close();
  }

  private armLinger(client: AcpClient): void {
    const old = this.lingerTimers.get(client);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      if ([...this.active.values()].some((a) => a.client === client) ||
          [...this.continuations.values()].some((c) => c.client === client && (c.approvals.size > 0 || [...c.turn.tools.values()].some(tool => ["in_progress", "pending"].includes(str(tool["status"]) ?? "")))) ||
          this.starting.size) { this.armLinger(client); return; }
      this.lingerTimers.delete(client);
      client.stop();
    }, this.opts.lingerMs ?? ANTIGRAVITY_LINGER_MS);
    t.unref();
    this.lingerTimers.set(client, t);
  }

  private onClientExit(client: AcpClient, info: { code: number | null; signal: string | null; stderrTail: string }): void {
    const t = this.lingerTimers.get(client);
    if (t) clearTimeout(t);
    this.lingerTimers.delete(client);
    if (this.turnClient === client) this.turnClient = undefined;
    if (this.bypassTurnClient === client) this.bypassTurnClient = undefined;
    if (this.historyClient === client) this.historyClient = undefined;
    for (const [sid, c] of this.sessionClient) if (c === client) this.sessionClient.delete(sid);
    for (const [sid, ch] of [...this.continuations]) if (ch.client === client) this.closeContinuation(sid);
    for (const a of [...this.active.values()]) {
      if (a.client !== client) continue;
      const how = `agy 进程已退出（${info.code ?? info.signal ?? "?"}）`;
      a.finish({ status: "interrupted", reason: `${how}${info.stderrTail ? `：${info.stderrTail.slice(-300)}` : ""}`, processEnded: how });
    }
  }

  /* ------------------------------ 探测 ------------------------------ */

  async probe(): Promise<ProbeOutcome> {
    const permissionOpts = permissionOptions("antigravity");
    const permissions = permissionOption("antigravity", defaultPermissionMode("antigravity"))!;
    const unknownCaps = Object.fromEntries(CAPABILITIES.map((k) => [k, cap("unknown", "未探测")])) as Record<CapabilityName, Capability>;
    const bin = this.resolveBinary();
    if (!bin) return { state: "not-installed", stateReason: "服务进程环境里找不到 agy（已查 ~/.local/bin、Homebrew 与 PATH）。安装：curl -fsSL https://antigravity.google/cli/install.sh | bash", capabilities: unknownCaps, models: [], configSummary: [], permissions };
    let version = "";
    try { version = (await run(bin, ["--version"], { timeout: 10_000, env: this.processEnv() })).stdout.trim(); }
    catch (e) { return { state: "error", stateReason: `agy --version 失败：${(e as Error).message}`, binaryPath: bin, capabilities: unknownCaps, models: [], configSummary: [], permissions }; }
    let client: AcpClient;
    try { client = await this.ensureClient("history"); }
    catch (e) { return { state: "error", stateReason: (e as Error).message, binaryPath: bin, binaryVersion: version, capabilities: unknownCaps, models: [], configSummary: [], permissions }; }
    const init = client.initializeResult ?? {};
    const agentCaps = obj(init["agentCapabilities"]);
    const sessionCaps = obj(agentCaps["sessionCapabilities"]);
    const meta = obj(obj(agentCaps["_meta"])["antigravity"]);
    const promptCaps = obj(agentCaps["promptCapabilities"]);
    // 套餐与模型清单要登录后才有，session/new 与 session/resume 都会带上（不调用模型）。
    // 复用同一条探测会话：每次 session/new 都会在 agy 的数据目录留下一个空对话文件
    let created: Json;
    try { created = await this.openProbeSession(client); }
    catch (e) {
      const message = (e as Error).message;
      const loginRelated = /auth|login|log in|sign.?in|credential|oauth|unauthori[sz]ed|401/i.test(message);
      return { state: loginRelated ? "needs-login" : "error", stateReason: loginRelated ? "Antigravity 未登录：请在本机终端运行 agy acp --login，用 Google 账号授权" : `session/new 失败：${message}`, binaryPath: bin, binaryVersion: version, capabilities: unknownCaps, models: [], configSummary: [`CLI ${version}（${bin}）`], permissions, permissionOptions: permissionOpts };
    }
    const tier = obj(obj(created["_meta"])["antigravity"])["tier"] as { name?: string; id?: string } | undefined;
    this.tierName = tier?.name;
    const models = parseModels(created, promptCaps["image"] === true);
    const has = (k: string) => k in sessionCaps;
    const capabilities: Record<CapabilityName, Capability> = {
      create: cap("supported", "session/new 已实际创建会话", version),
      read: agentCaps["loadSession"] === true || has("load") ? cap("supported", "session/load 回放历史（只含消息与工具，无 token 用量）", version) : cap("unsupported", "agy 未声明 session/load", version),
      stream: cap("supported", "session/update 流式通知（文字、思考、工具调用）", version),
      resume: has("resume") ? cap("supported", "session/resume 可在新进程里恢复同一会话", version) : cap("unsupported", "agy 未声明 session/resume", version),
      interrupt: cap("supported", "session/cancel，实测返回 stopReason=cancelled", version),
      approval: cap("supported", "session/request_permission（allow_once / reject_once）", version),
      usage: cap("supported", "session/prompt 响应带本轮输入、输出、缓存读与思考 token", version),
      rateLimits: cap("supported", "只读 agy -p /usage --output-format json：按模型组读取额度与重置时间", version),
      roleInstructions: obj(meta["systemPrompt"])["append"] === true ? cap("supported", "session/new 的 _meta.antigravity.systemPrompt.append", version) : cap("unknown", "未确认系统提示追加", version),
      imageInput: promptCaps["image"] === true ? cap("supported", "promptCapabilities.image", version) : cap("unsupported", "agy 未声明图片输入", version)
    };
    const missing = (["create", "stream", "resume", "interrupt", "approval"] as CapabilityName[]).filter((k) => capabilities[k].status !== "supported");
    const identity: ProbeOutcome["identity"] = {
      authMode: "google-oauth",
      summary: `Google 登录 · ${tier?.name ?? "套餐未知"}`,
      source: "agy acp session/new _meta.antigravity.tier",
      fingerprint: `google-oauth|${tier?.id ?? ""}`
    };
    return {
      authVerified: true,
      state: missing.length ? "incompatible" : "executable",
      stateReason: missing.length ? `所选版本缺少必需能力：${missing.join("、")}` : "协议已核对，登录有效，可创建会话",
      binaryPath: bin, binaryVersion: version, capabilities, models, identity,
      configSummary: [
        `CLI ${version}（${bin}）`,
        `套餐：${tier?.name ?? "未知"}；账户额度经 CLI /usage 按模型组读取`,
        "对话历史由 agy 保存在 ~/.gemini/antigravity-cli/conversations；MCP、skills、插件按 agy 原生规则加载",
        `协议：${String(obj(init["agentInfo"])["name"] ?? "Antigravity ACP Server")} ${String(obj(init["agentInfo"])["version"] ?? "")}`.trim()
      ],
      permissions, permissionOptions: permissionOpts
    };
  }

  private get probeDir(): string { return this.opts.stateDir ?? join(tmpdir(), "pi-agent-antigravity-probe"); }

  private async openProbeSession(client: AcpClient): Promise<Json> {
    const dir = this.probeDir;
    mkdirSync(dir, { recursive: true });
    const idFile = join(dir, "session-id");
    const saved = existsSync(idFile) ? readFileSync(idFile, "utf8").trim() : "";
    if (/^[A-Za-z0-9_-]+$/.test(saved)) {
      try { return obj(await client.request("session/resume", { sessionId: saved, cwd: dir, mcpServers: [] }, 30_000)); } catch { /* 会话文件被清理或登录失效：重新创建，失败原因由 session/new 给出 */ }
    }
    const created = obj(await client.request("session/new", { cwd: dir, mcpServers: [] }, 30_000));
    const id = str(created["sessionId"]);
    if (id) writeFileSync(idFile, id, { mode: 0o600 });
    return created;
  }

  async rateLimits(): Promise<ProbeOutcome["rateLimit"]> {
    const bin = this.resolveBinary();
    if (!bin) throw new Error("找不到 agy，无法读取账户额度");
    mkdirSync(this.probeDir, { recursive: true });
    let stdout: string;
    try {
      ({ stdout } = await run(bin, ["-p", "/usage", "--output-format", "json"], {
        cwd: this.probeDir, env: this.processEnv(), encoding: "utf8",
        timeout: this.opts.quotaTimeoutMs ?? 30_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024
      }));
    } catch (e) {
      // 不把 CLI stderr（可能含本机路径或账号信息）直接带到页面。
      throw new Error((e as { killed?: boolean }).killed ? "Antigravity 额度读取超时，请稍后重试" : "Antigravity CLI 额度读取失败，请检查登录与连接后重试");
    }
    let payload: unknown;
    try { payload = JSON.parse(stdout); } catch { throw new Error("Antigravity CLI 未返回有效的额度 JSON"); }
    return { ...parseAntigravityQuota(payload), ...(this.tierName ? { plan: this.tierName } : {}) };
  }

  /* ------------------------------ 执行 ------------------------------ */

  async startTurn(args: StartTurnArgs, sink: TurnSink): Promise<TurnHandle> {
    const id = args.nativeSessionId;
    if (id && (this.active.has(id) || this.starting.has(id))) throw new DriverStageError("Antigravity 会话已有进行中的轮次", "create", id, true);
    if (id && this.continuationState(id)?.active) throw new DriverStageError("Antigravity 后台续写尚未核对完成", "create", id, true);
    if (args.evaluation) throw new DriverStageError("Antigravity 暂不支持评测任务", "create", id, true);
    if (id) this.starting.add(id);
    try { return await this.startOwnedTurn(args, sink); }
    finally { if (id) this.starting.delete(id); }
  }

  private async startOwnedTurn(args: StartTurnArgs, sink: TurnSink): Promise<TurnHandle> {
    const bypass = args.permissionMode === "bypassPermissions" && !args.readOnlyRoom;
    let client: AcpClient;
    try { client = await this.ensureClient(bypass ? "bypass" : "turn"); }
    catch (e) { throw new DriverStageError((e as Error).message, "spawn", args.nativeSessionId, true); }
    const meta = args.roleInstructions ? { _meta: { antigravity: { systemPrompt: { append: args.roleInstructions } } } } : {};
    // agy 在同一 worker 内 session/resume 时，若同名 MCP 的 args 变化会额外注册 platform_browser_<hash> 工具，
    // 导致每回合顶部工具声明变化、Gemini 前缀缓存 0% 命中并泄漏 MCP 子进程；传按会话固定的 pointerPath，调用时再解析本轮 socket。
    const mcpServers = args.platformBrowser && !args.readOnlyRoom ? [{
      name: "platform_browser",
      command: process.execPath,
      args: [args.platformBrowser.bridgePath, args.platformBrowser.pointerPath ?? args.platformBrowser.socketPath],
      env: [],
    }] : [];
    let sessionId = args.nativeSessionId;
    let opened: Json;
    try {
      if (sessionId) {
        opened = obj(await client.request("session/resume", { sessionId, cwd: args.workspace, mcpServers, ...meta }, 60_000));
        const got = str(opened["sessionId"]);
        if (got && got !== sessionId) throw new Error(`session/resume 返回了另一个会话（${got}），不静默改绑`);
      } else {
        opened = obj(await client.request("session/new", { cwd: args.workspace, mcpServers, ...meta }, 60_000));
        sessionId = str(opened["sessionId"]);
        if (!sessionId) throw new Error("session/new 没有返回会话 ID");
        if (this.active.has(sessionId)) throw new DriverStageError("Antigravity 返回了已被其他操作占用的会话", "create", undefined, true);
      }
    } catch (e) {
      if (e instanceof DriverStageError) throw e;
      throw new DriverStageError(`${args.nativeSessionId ? "恢复" : "创建"} Antigravity 会话失败：${(e as Error).message}`, "create", args.nativeSessionId);
    }
    const sid = sessionId;
    this.sessionClient.set(sid, client);
    const configs = obj(opened)["configOptions"] as Array<{ id?: string; currentValue?: string }> | undefined;
    const current = (id: string) => configs?.find((c) => c.id === id)?.currentValue;
    const modes = obj(opened["modes"]);
    try {
      const wantMode = MODE_ID[args.permissionMode ?? defaultPermissionMode("antigravity")] ?? "default";
      if (wantMode !== str(modes["currentModeId"])) await client.request("session/set_mode", { sessionId: sid, modeId: wantMode }, 20_000);
      if (args.model && args.model !== current("model")) await client.request("session/set_config_option", { sessionId: sid, configId: "model", value: args.model }, 20_000);
      if (args.effort && args.effort !== current("thought_level")) await client.request("session/set_config_option", { sessionId: sid, configId: "thought_level", value: args.effort }, 20_000);
    } catch (e) {
      throw new DriverStageError(`设置 Antigravity 会话参数失败：${(e as Error).message}`, "create", sid, true);
    }
    const effectiveModel = args.model ?? current("model");
    sink.nativeSession(sid, {
      ...(effectiveModel ? { effectiveModel } : {}), modelSource: args.nativeSessionId ? "session/resume 响应" : "session/new 响应",
      ...(args.effort ?? current("thought_level") ? { effectiveEffort: args.effort ?? current("thought_level")!, effortSource: args.effort ? "平台请求" : args.nativeSessionId ? "session/resume 响应" : "session/new 响应" } : {})
    });
    sink.nativeTurn(args.clientMessageId);

    let closeContinuation!: () => void;
    const continuationDone = new Promise<void>(resolve => { closeContinuation = resolve; });
    let finish!: (r: TurnResult) => void;
    const done = new Promise<TurnResult>((res) => { finish = res; });
    const turn: ActiveTurn = {
      client, sessionId: sid, sink, clientMessageId: args.clientMessageId, ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(args.platformBrowser ? { browserSocket: args.platformBrowser.socketPath } : {}), browserOutputLines: 0,
      message: "", lastMessage: "", thought: "", messageNo: 0, thoughtNo: 0, lastText: null, readOnly: args.readOnlyRoom === true, tools: new Map(), approvals: new Map(), settled: false, cancelled: false,
      finish: (r) => {
        if (turn.settled) return;
        turn.settled = true;
        this.flushText(turn);
        if (this.active.get(sid) === turn) this.active.delete(sid);
        for (const [, ac] of turn.approvals) ac.abort();
        if (r.status === "completed" && client.alive) {
          this.continuations.set(sid, { turn, revision: 0, verifiedRevision: 0, streamedKeys: new Set(), matchedLiveKeys: new Set(), events: new Map(), tools: new Set(), close: closeContinuation, client, sink, clientMessageId: args.clientMessageId, readOnly: turn.readOnly, approvals: new Map() });
        } else {
          this.closeContinuation(sid);
          closeContinuation();
        }
        finish(r);
      }
    };
    // No await between the final lifecycle check and transferring the subscription.
    if (this.continuationState(sid)?.active) throw new DriverStageError("Antigravity 在恢复期间产生了后台续写，请稍后重试", "create", sid, true);
    this.closeContinuation(sid);
    this.active.set(sid, turn);
    const prompt: Json[] = [{ type: "text", text: args.prompt }, ...(args.images ?? []).map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data }))];
    let promptRequest: Promise<unknown>;
    try {
      promptRequest = client.request("session/prompt", { sessionId: sid, ...(UUID.test(args.clientMessageId) ? { messageId: args.clientMessageId } : {}), prompt }, 0);
    } catch (e) {
      closeContinuation();
      this.active.delete(sid);
      throw new DriverStageError(`发送 Antigravity 输入失败：${(e as Error).message}`, "dispatch", sid);
    }
    promptRequest.then((r) => {
      const res = obj(r);
      const usage = obj(res["usage"]);
      const record = antigravityUsage(usage, turn.clientMessageId, turn.model, new Date().toISOString());
      if (record) sink.usage({ ...record, ...(turn.contextUsed ? { contextTokens: turn.contextUsed } : {}), ...(turn.contextSize ? { contextWindow: turn.contextSize } : {}) });
      const stop = str(res["stopReason"]) ?? "end_turn";
      const quotaNotice = stop === "end_turn" ? antigravityQuotaNotice(turn.message || turn.lastMessage) : undefined;
      if (quotaNotice) {
        turn.finish({ status: "failed", code: "usageLimitExceeded", reason: quotaNotice, terminalObserved: true });
        return;
      }
      const status: TurnResult["status"] = stop === "end_turn" ? "completed" : stop === "cancelled" ? "cancelled" : "failed";
      turn.finish({ status, ...(status === "failed" ? { reason: `agy 结束原因：${stop}` } : {}), terminalObserved: true });
    }, (e: Error) => {
      const rpc = e instanceof RpcError;
      // 服务端给出了错误响应 = 本轮已有原生终态；进程退出 / 超时 / 写入失败则交给 exit 事件，不在这里宣称终态
      if (rpc && e.code !== undefined) turn.finish({ status: "failed", reason: e.message, code: String(e.code), terminalObserved: true });
      else turn.finish({ status: "failed", reason: e.message });
    });
    return {
      done, continuationDone,
      interrupt: async () => {
        if (turn.settled) return;
        turn.cancelled = true;
        try { client.notify("session/cancel", { sessionId: sid }); } catch { /* 进程已退出：exit 事件会收尾 */ }
        const timer = setTimeout(() => turn.finish({ status: "interrupted", reason: "已请求停止，agy 未在时限内确认；本轮可能仍在执行" }), FORCE_FINISH_MS);
        timer.unref();
        await done;
        clearTimeout(timer);
      }
    };
  }

  /* ------------------------------ 通知投影 ------------------------------ */

  private onNotification(client: AcpClient, m: NotificationMsg): void {
    if (m.method !== "session/update") return;
    const sid = str(m.params["sessionId"]);
    const update = obj(m.params["update"]);
    if (!sid) return;
    const collector = this.collectors.get(sid);
    if (collector && client === this.historyClient) { collector(update); return; }
    const active = this.active.get(sid), background = this.continuations.get(sid);
    const turn = active ?? background?.turn;
    if (!turn || turn.client !== client) return;
    // end_turn only ends the foreground request. Its authenticated ACP subscription
    // and sink remain owned by the original client message until handoff or exit.
    if (!active && background && ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(str(update["sessionUpdate"]) ?? "")) {
      background.revision++;
      if (str(update["toolCallId"])) background.tools.add(str(update["toolCallId"])!);
      this.armLinger(client);
    }
    this.projectUpdate(turn, update);
  }

  private emitTurnEvent(turn: ActiveTurn, event: DriverEvent): void {
    const ch = this.continuations.get(turn.sessionId);
    if (ch?.turn === turn) ch.events.set(event.key, event);
    turn.sink.event(event);
  }

  private eventBase(turn: ActiveTurn, key: string, partial: boolean): Pick<DriverEvent, "key" | "source" | "parserVersion" | "partial" | "availability"> {
    return { key: `antigravity:${turn.sessionId}:${turn.clientMessageId}:${key}`, source: "stream", parserVersion: ANTIGRAVITY_PARSER, partial, availability: "recorded" };
  }

  private flushText(turn: ActiveTurn): void {
    if (turn.thought) {
      const b = bounded(turn.thought.trim(), LIMITS.message);
      this.emitTurnEvent(turn, { ...this.eventBase(turn, `thought${turn.thoughtNo}`, false), kind: "reasoning", role: "assistant", text: b.text, ...(b.truncated ? { truncated: b.truncated } : {}), occurredAt: new Date().toISOString() });
      turn.thought = ""; turn.thoughtNo++;
    }
    if (turn.message) {
      turn.lastMessage = turn.message;
      const b = bounded(turn.message, LIMITS.message);
      this.emitTurnEvent(turn, { ...this.eventBase(turn, `msg${turn.messageNo}`, false), kind: "message", role: "assistant", text: b.text, ...(b.truncated ? { truncated: b.truncated } : {}), ...(b.redactions ? { redactions: b.redactions } : {}), occurredAt: new Date().toISOString() });
      turn.message = ""; turn.messageNo++;
    }
    turn.lastText = null;
  }

  private projectUpdate(turn: ActiveTurn, update: Json): void {
    const kind = str(update["sessionUpdate"]);
    const text = str(obj(update["content"])["text"]) ?? "";
    switch (kind) {
      case "agent_message_chunk":
        if (turn.lastText === "thought") this.flushText(turn);
        turn.lastText = "message"; turn.message += text;
        this.emitTurnEvent(turn, { ...this.eventBase(turn, `msg${turn.messageNo}`, true), kind: "message", role: "assistant", text: bounded(turn.message, LIMITS.message).text });
        return;
      case "agent_thought_chunk":
        if (turn.lastText === "message") this.flushText(turn);
        turn.lastText = "thought"; turn.thought += text;
        this.emitTurnEvent(turn, { ...this.eventBase(turn, `thought${turn.thoughtNo}`, true), kind: "reasoning", role: "assistant", text: bounded(turn.thought.trim(), LIMITS.message).text });
        return;
      case "tool_call":
      case "tool_call_update": {
        if (kind === "tool_call") { this.flushText(turn); turn.lastMessage = ""; }
        const id = str(update["toolCallId"]);
        if (!id) return;
        const merged = { ...(turn.tools.get(id) ?? {}), ...update };
        const rawName = str(merged["name"]) ?? "";
        const status = str(merged["status"]) ?? "";
        if (turn.browserSocket && /^mcp_platform_browser(?:_[0-9a-f]+)?_browser$/.test(rawName) && (status === "completed" || status === "failed") && !merged["rawOutput"]) {
          try {
            const lines = readFileSync(`${turn.browserSocket}.log`, "utf8").trim().split("\n").filter(Boolean);
            const line = lines[turn.browserOutputLines];
            if (line) { turn.browserOutputLines++; merged["rawOutput"] = { output: line }; }
          } catch { /* 尚未产生浏览器调用日志 */ }
        }
        turn.tools.set(id, merged);
        this.emitTurnEvent(turn, toolEvent(merged, this.eventBase(turn, `tool:${id}`, false), "stream"));
        return;
      }
      // session_info_update（agy 自动起的标题）不转发：agy 看到的是平台注入公共记忆之后的整段 prompt，起出来的名字
      // 是「Platform Skills Overview」这类前言内容，会盖掉平台自己的标题生成。只读历史（外部会话）才用 agy 的标题。
      case "usage_update": {
        const used = num(update["used"]); if (used !== undefined && used > 0) turn.contextUsed = used;
        const size = num(update["size"]); if (size !== undefined && size > 0) turn.contextSize = size;
        return;
      } // 上下文占用与窗口上限：只记数字，不进会话记录
      default: return; // available_commands_update、mode / config 变化：不进会话记录
    }
  }

  private onServerRequest(client: AcpClient, m: ServerRequestMsg): void {
    if (m.method !== "session/request_permission") { try { client.respondError(m.id, `pi-agent 不支持 ${m.method}`); } catch { /* 进程已退出 */ } return; }
    const sid = str(m.params["sessionId"]);
    const turn = sid ? this.active.get(sid) : undefined;
    const bg = !turn && sid ? this.continuations.get(sid) : undefined;
    const channel = turn && turn.client === client ? turn : (bg && bg.client === client ? bg : undefined);
    const options = (m.params["options"] as Array<{ optionId: string; kind?: string }> | undefined) ?? [];
    const answer = (kind: "allow" | "reject" | "cancel") => {
      const opt = options.find((o) => kind === "allow" ? /^allow/.test(o.kind ?? "") : /^reject/.test(o.kind ?? ""));
      try { client.respond(m.id, { outcome: kind !== "cancel" && opt ? { outcome: "selected", optionId: opt.optionId } : { outcome: "cancelled" } }); } catch { /* 进程已退出 */ }
    };
    if (!channel) { answer("cancel"); return; }
    if (bg) this.armLinger(client);
    const tc = obj(m.params["toolCall"]);
    const raw = obj(tc["rawInput"]);
    const toolKind = str(tc["kind"]) ?? "other";
    const command = str(raw["CommandLine"]);
    // 群聊只读成员：agy 对写文件、运行命令都会先发权限请求，这里除读取 / 搜索 / 联网外一律直接拒绝，不打扰人
    if (channel.readOnly && !["read", "search", "fetch", "think"].includes(toolKind)) { answer("reject"); return; }
    const approvalId = String(m.id);
    const ac = new AbortController();
    channel.approvals.set(approvalId, ac);
    const approval: DriverApproval = {
      nativeRequestId: approvalId, nativeTurnId: channel.clientMessageId,
      kind: toolKind === "execute" ? "command" : ["edit", "delete", "move"].includes(toolKind) ? "file-change" : "tool",
      title: toolKind === "execute" ? "Antigravity 请求运行命令" : ["edit", "delete", "move"].includes(toolKind) ? "Antigravity 请求修改文件" : `Antigravity 请求使用工具 ${str(tc["name"]) ?? toolKind}`,
      action: bounded(command ?? str(tc["title"]) ?? str(tc["name"]) ?? toolKind, LIMITS.toolInput).text,
      scope: bounded(str((tc["locations"] as Array<{ path?: string }> | undefined)?.[0]?.path) ?? "会话工作目录", LIMITS.preview).text,
      source: "antigravity session/request_permission",
      params: { toolCallId: str(tc["toolCallId"]), kind: toolKind, title: str(tc["title"]), input: raw }
    };
    channel.sink.approval(approval, ac.signal).then((d) => answer(d.approve ? "allow" : "reject"), () => answer("cancel"))
      .finally(() => { channel.approvals.delete(approvalId); });
  }

  /* ------------------------------ 历史 ------------------------------ */

  async listHistory(opts: { roots: string[]; limit: number; originators?: string[] }): Promise<{ items: HistoryItem[]; coverage: "complete" | "partial"; notes: string[] }> {
    const client = await this.ensureClient("history");
    const items: HistoryItem[] = [];
    let cursor: string | undefined;
    let partial = false;
    for (let page = 0; page < 20 && items.length < opts.limit; page++) {
      const r = obj(await client.request("session/list", cursor ? { cursor } : {}, 30_000));
      for (const s of (r["sessions"] as Json[] | undefined) ?? []) {
        const cwd = str(s["cwd"]);
        if (opts.roots.length && !underRoots(cwd, opts.roots)) continue;
        const updated = str(s["updatedAt"]);
        items.push({ nativeSessionId: String(s["sessionId"]), title: str(s["title"]) ?? "（无标题）", ...(cwd ? { workspace: cwd } : {}), ...(updated ? { updatedAt: updated } : {}), sourceLabel: "Antigravity", status: "unknown" });
        if (items.length >= opts.limit) { partial = true; break; }
      }
      cursor = str(r["nextCursor"]);
      if (!cursor) break;
      if (page === 19) partial = true;
    }
    return { items, coverage: partial ? "partial" : "complete", notes: ["Antigravity 会话列表来自 session/list；运行状态与用量不在列表里，显示为未知"] };
  }

  async readHistory(nativeSessionId: string, opts: { workspace?: string }): Promise<HistoryRead> {
    const client = await this.ensureClient("history");
    const events: DriverEvent[] = [];
    let pending: { role: "user" | "assistant"; text: string; index: number } | undefined;
    let index = 0;
    const ordinal = (n: number) => `antigravity:history:${nativeSessionId}:${n}`;
    const flush = () => {
      if (!pending) return;
      const b = bounded(pending.text, LIMITS.message);
      events.push({ key: ordinal(pending.index), kind: "message", role: pending.role, text: b.text, ...(b.truncated ? { truncated: b.truncated } : {}), ...(b.redactions ? { redactions: b.redactions } : {}), source: "history", parserVersion: ANTIGRAVITY_PARSER, availability: "recorded", partial: false });
      pending = undefined;
    };
    this.collectors.set(nativeSessionId, (u) => {
      const kind = str(u["sessionUpdate"]);
      const text = str(obj(u["content"])["text"]) ?? "";
      if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
        const role = kind === "user_message_chunk" ? "user" : "assistant";
        if (pending && pending.role === role) pending.text += text;
        else { flush(); pending = { role, text, index: index++ }; }
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        flush();
        const id = str(u["toolCallId"]);
        if (!id) return;
        const at = events.findIndex((e) => e.key === `antigravity:history:${nativeSessionId}:tool:${id}`);
        const ev = toolEvent(u, { key: `antigravity:history:${nativeSessionId}:tool:${id}`, source: "history", parserVersion: ANTIGRAVITY_PARSER, partial: false, availability: "recorded" }, "history");
        if (at >= 0) events[at] = ev; else events.push(ev);
      } else if (kind === "agent_thought_chunk") {
        flush();
        const key = ordinal(index++);
        events.push({ key, kind: "reasoning", role: "assistant", text: bounded(text.trim(), LIMITS.message).text, source: "history", parserVersion: ANTIGRAVITY_PARSER, availability: "recorded", partial: false });
      }
    });
    try {
      await client.request("session/load", { sessionId: nativeSessionId, cwd: opts.workspace ?? homedir(), mcpServers: [] }, 60_000);
    } finally { this.collectors.delete(nativeSessionId); }
    flush();
    const fp = await this.fingerprint(nativeSessionId, opts);
    const title = (await this.titleFromList(client, nativeSessionId));
    return {
      events, usage: [], status: "unknown", coverage: "partial",
      notes: ["session/load 回放不含 token 用量和时间戳；用量只在平台管理的会话里按轮记录"],
      ...(fp ? { fingerprint: fp.value } : {}), ...(title ? { title, titleKind: "name" as const } : {}), ...(opts.workspace ? { workspace: opts.workspace } : {})
    };
  }

  private async titleFromList(client: AcpClient, id: string): Promise<string | undefined> {
    const r = obj(await client.request("session/list", {}, 30_000).catch(() => ({})));
    return str(((r["sessions"] as Json[] | undefined) ?? []).find((s) => s["sessionId"] === id)?.["title"]);
  }

  /**
   * 外部写入检测：agy 把会话存在一个 SQLite 库里。指纹 = steps 的条数 + 最大 idx（语义指纹）。
   * 不用主库大小 / mtime / WAL 大小：agy 一轮结束后还会继续写库，稍后做 WAL checkpoint 时主库变大、mtime 推后、WAL 归零，
   * 三个分量同时变，会把 agy 自己的收尾写库误判成「平台之外的写入」（Claude / Codex 也因同样原因不用文件元数据）。
   * steps 新增也可能是本轮后台任务完成后的自动续写，需由 readContinuation 核对结构化来源后再决定是否拦截。
   * 读不到库（agy 独占或库文件暂不可用）时沿用上次指纹，只带 note 说明，不判外部写入。
   */
  async fingerprint(nativeSessionId: string, opts: { workspace?: string; previous?: string }): Promise<NativeFingerprint | undefined> {
    if (!/^[A-Za-z0-9_-]+$/.test(nativeSessionId)) return undefined;
    const dbPath = join(this.dataDir, "conversations", `${nativeSessionId}.db`);
    let value: string | undefined;
    for (let i = 0; i < 3 && !value; i++) {
      if (i) await new Promise((r) => setTimeout(r, this.opts.fingerprintSettleMs ?? 250));
      value = readStepsFingerprint(dbPath);
    }
    if (value) {
      this.lastFingerprint.set(nativeSessionId, value);
      // 上一版存的是「主库大小:mtime:WAL 大小」，语式不同不可比：交给管理器只重建基线，不判外部写入
      return { value, ...(opts.previous && !ANTIGRAVITY_STEPS_FP.test(opts.previous) ? { migrated: true } : {}) };
    }
    const last = this.lastFingerprint.get(nativeSessionId) ?? opts.previous;
    return last ? { value: last, note: "读不到 Antigravity 会话库，沿用上次指纹（未判外部写入）" } : undefined;
  }

  private hasLiveProcess(nativeSessionId: string): boolean {
    return !!this.sessionClient.get(nativeSessionId)?.alive;
  }

  continuationState(nativeSessionId: string) {
    const ch = this.continuations.get(nativeSessionId);
    return ch?.client.alive ? { clientMessageId: ch.clientMessageId, revision: ch.revision,
      active: ch.approvals.size > 0 || ch.revision !== ch.verifiedRevision } : undefined;
  }

  async readContinuation(nativeSessionId: string, opts: { previous: string; toolCallIds: string[]; endedAt: string }) {
    if (!/^[A-Za-z0-9_-]+$/.test(nativeSessionId)) return undefined;
    const result = readAntigravityContinuation(join(this.dataDir, "conversations", `${nativeSessionId}.db`), nativeSessionId, opts.previous, opts.toolCallIds, opts.endedAt);
    if (!result) return undefined;
    const ch = this.continuations.get(nativeSessionId);
    // Stream receipt proves ownership; matching the persisted tail only proves
    // delivery completeness. A lagging SQLite snapshot must never settle new output.
    const liveText = ch ? bounded(ch.turn.message || ch.turn.lastMessage, LIMITS.message).text : "";
    const caughtUp = !ch || ch.revision === ch.verifiedRevision ||
      ([...ch.tools].every(id => result.toolCallIds?.includes(id)) &&
        (!liveText || result.events.filter(e => e.kind === "message").at(-1)?.text === liveText));
    if (ch?.client.alive && caughtUp && !result.active && !ch.approvals.size) {
      this.flushText(ch.turn);
      ch.verifiedRevision = ch.revision;
      // A complete native tail can finalize the buffered live message.
      // Exact per-record coverage below prevents recovery from hiding missed records.
    }
    if (ch?.client.alive) {
      // Both sources have already been independently attributed. Exact, one-to-one
      // display deduplication is not evidence of ownership. Unmatched records remain
      // in the database fallback, even if later records were received live.
      const messages = [...ch.events.values()].filter(e => e.kind === "message" && !e.partial && !ch.matchedLiveKeys.has(e.key));
      for (const event of result.events) {
        if (event.partial || ch.streamedKeys.has(event.key)) continue;
        if (event.kind === "tool" && event.nativeItemId) {
          const live = [...ch.events.values()].find(e => e.kind === "tool" && e.nativeItemId === event.nativeItemId);
          if (live) {
            this.emitTurnEvent(ch.turn, { ...event, key: live.key, source: "stream" });
            if (["completed", "failed"].includes(event.tool?.status ?? "")) {
              const raw = ch.turn.tools.get(event.nativeItemId);
              if (raw) ch.turn.tools.set(event.nativeItemId, { ...raw, status: event.tool!.status });
            }
            ch.streamedKeys.add(event.key);
          }
        } else if (event.kind === "message") {
          const index = messages.findIndex(e => e.role === event.role && e.text === event.text);
          if (index >= 0) { ch.matchedLiveKeys.add(messages[index]!.key); messages.splice(index, 1); ch.streamedKeys.add(event.key); }
        }
      }
      return { ...result, active: result.active || !caughtUp || ch.approvals.size > 0, streamedKeys: [...ch.streamedKeys] };
    }
    // After process exit, persisted records can be recovered but cannot still be running.
    return !this.hasLiveProcess(nativeSessionId) && (result.pending || result.active)
      ? { ...result, pending: false, active: false } : result;
  }

  /** ACP 的 prompt 带 messageId，但回放的用户消息不回带它，无法核对：明确返回未知，不猜 */
  async findClientMessage(): Promise<boolean | undefined> { return undefined; }

  shutdown(): void {
    for (const t of this.lingerTimers.values()) clearTimeout(t);
    this.lingerTimers.clear();
    for (const sid of [...this.continuations.keys()]) this.closeContinuation(sid);
    this.sessionClient.clear();
    this.turnClient?.stop();
    this.bypassTurnClient?.stop();
    this.historyClient?.stop();
    this.turnClient = undefined; this.bypassTurnClient = undefined; this.historyClient = undefined;
  }
}

/* ------------------------------ 纯函数（便于测试） ------------------------------ */

/**
 * agy 在流式轮次里撞上额度上限时，有时不返回 JSON-RPC error，而是发出一条简短的系统告警消息并以 end_turn 结束。
 * 只认整条单行系统额度告警（如 `⚠ Individual quota reached...`），避免误判普通对话里提到 quota 的回复。
 */
const ANTIGRAVITY_QUOTA_NOTICE = /^(?:⚠\s*)?(?:individual\s+|model\s+|weekly\s+|session\s+)?quota\s+(?:reached|exceeded|exhausted|limit\s+reached)\b[^\n]{0,240}$/i;
export function antigravityQuotaNotice(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\n")) return undefined;
  return ANTIGRAVITY_QUOTA_NOTICE.test(trimmed) ? trimmed : undefined;
}

/** steps 语义指纹：条数 + 最大 idx（空库为 s0i-1） */
export function stepsFingerprint(count: number, maxIdx: number | null | undefined): string {
  return `s${count}i${maxIdx === null || maxIdx === undefined ? -1 : maxIdx}`;
}

/**
 * 只读打开会话库取语义指纹：WAL 里尚未 checkpoint 的记录同样算数（外部续聊写完就在 WAL 里）。
 * 读不到就返回 undefined，既不抛也不猜。
 */
export function readStepsFingerprint(dbPath: string): string | undefined {
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    db = new (sqlite().DatabaseSync)(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    const row = db.prepare("select count(*) as c, max(idx) as m from steps").get() as { c?: number | bigint; m?: number | bigint | null } | undefined;
    if (!row || row.c === undefined || row.c === null) return undefined;
    return stepsFingerprint(Number(row.c), row.m === null || row.m === undefined ? null : Number(row.m));
  } catch { return undefined; }
  finally { try { db?.close(); } catch { /* 已关闭或从未打开 */ } }
}

export function parseModels(created: Json, imageInput: boolean): ModelOption[] {
  const available = ((obj(created["models"])["availableModels"] as Array<{ modelId?: string }> | undefined) ?? []).map((m) => String(m.modelId ?? "")).filter(Boolean);
  const configs = (created["configOptions"] as Array<{ id?: string; currentValue?: string; options?: Array<{ value: string; name: string }> }> | undefined) ?? [];
  const model = configs.find((c) => c.id === "model");
  const thought = configs.find((c) => c.id === "thought_level");
  const thoughtDefault = thought?.currentValue;
  const modalities = imageInput ? ["text", "image"] : ["text"];
  return (model?.options ?? []).map((o) => {
    const efforts = EFFORT_ORDER.filter((e) => available.includes(`${o.value}-${e}`));
    const defaultEffort = thoughtDefault && efforts.includes(thoughtDefault) ? thoughtDefault : efforts.includes("high") ? "high" : efforts[0];
    return {
      id: o.value, label: o.name, inputModalities: modalities, ...(o.value === model?.currentValue ? { isDefault: true } : {}),
      ...(efforts.length ? { efforts, ...(defaultEffort ? { defaultEffort } : {}) } : {})
    };
  });
}

/** agy 的 totalTokens = 输入 + 输出 + 缓存读；outputTokens 已含思考 token（thoughtTokens 是其中一部分） */
export function antigravityUsage(u: Json, requestId: string, model: string | undefined, sampledAt: string): UsageRecord | undefined {
  const input = num(u["inputTokens"]); const output = num(u["outputTokens"]);
  if (input === undefined && output === undefined) return undefined;
  const raw: Record<string, number> = {};
  for (const k of ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"]) if (num(u[k]) !== undefined) raw[k] = num(u[k])!;
  return {
    usageScope: "turn", counterMode: "delta", ...(model ? { model } : {}), raw,
    ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}),
    ...(num(u["cachedReadTokens"]) !== undefined ? { cachedInput: num(u["cachedReadTokens"])! } : {}),
    ...(num(u["cachedWriteTokens"]) ? { cacheCreation: num(u["cachedWriteTokens"])! } : {}),
    ...(num(u["thoughtTokens"]) !== undefined ? { reasoningOutput: num(u["thoughtTokens"])! } : {}),
    ...(num(u["totalTokens"]) !== undefined ? { total: num(u["totalTokens"])! } : {}),
    semantics: "Antigravity：输入不含缓存读取；输出含思考 token；按 session/prompt 响应的单轮计数求和",
    sourceRef: `antigravity:turn:${requestId}`, requestId, sampledAt, reliability: "complete"
  };
}

const TOOL_NAME: Record<string, string> = { execute: "命令", edit: "文件修改", delete: "文件修改", move: "文件修改", read: "读取文件", search: "搜索", fetch: "联网", think: "思考" };

export function toolEvent(u: Json, base: Pick<DriverEvent, "key" | "source" | "parserVersion" | "partial" | "availability">, source: "stream" | "history"): DriverEvent {
  const kind = str(u["kind"]) ?? "other";
  const rawName = str(u["name"]);
  const name = rawName && /^mcp_platform_browser(?:_[0-9a-f]+)?_browser$/.test(rawName) ? "platform_browser.browser" : (TOOL_NAME[kind] ?? rawName ?? "工具");
  const raw = obj(u["rawInput"] ?? u["args"]);
  const out = obj(u["rawOutput"]);
  const diffs = ((u["content"] as Json[] | undefined) ?? []).filter((c) => c["type"] === "diff");
  const contentText = ((u["content"] as Json[] | undefined) ?? []).map((c) => str(obj(c["content"])["text"])).filter(Boolean).join("\n");
  const input = str(raw["CommandLine"]) ?? (diffs.length ? diffs.map((d) => String(d["path"] ?? "")).join("\n") : Object.keys(raw).length ? stringifyInput(raw) : str(u["title"]) ?? "");
  const output = diffs.length ? diffs.map((d) => `${String(d["path"] ?? "")}\n${String(d["newText"] ?? "")}`).join("\n") : (str(out["output"]) || contentText);
  const inp = bounded(input, LIMITS.toolInput);
  const outp = bounded(output, LIMITS.toolOutput);
  const status = ({ completed: "completed", failed: "failed", in_progress: "inProgress", pending: "inProgress" } as Record<string, string>)[str(u["status"]) ?? ""] ?? "inProgress";
  const exitCode = num(out["exit_code"]);
  return {
    ...base, source, kind: "tool", ...(str(u["toolCallId"]) ? { nativeItemId: str(u["toolCallId"]) } : {}),
    tool: { name, input: inp.text, ...(output ? { output: outp.text } : {}), status, ...(exitCode !== undefined ? { exitCode } : {}) },
    ...(outp.truncated ? { truncated: outp.truncated } : {}), ...(inp.redactions + outp.redactions ? { redactions: inp.redactions + outp.redactions } : {})
  };
}
