import {screenshotViolation} from "../../pi-runtime/src/screenshot-policy.mjs";
import {scanViolation} from "../../pi-runtime/src/scan-policy.mjs";
import { evaluationHistoryStore } from "./claude-evaluation-history.js";
import { spawn } from "node:child_process";
import { prepareClaudeEvaluationBoundary } from "./claude-boundary.js";
import { CLAUDE_EVALUATION_TOOLS, claudeEvaluationPolicy } from "./claude-evaluation-policy.js";
import { SeatbeltRuntimeGuard } from "@pi-agent/adapter-pi";
import type { RuntimeGuardProvider } from "@pi-agent/runtime-contracts";
import { permissionOption, permissionOptions } from "./permissions.js";
import { questionItem, questionsText } from "./questions.js";
import type { QuestionItem } from "./types.js";
/**
 * Claude Code 驱动（F03）：Agent SDK 管理底层本地进程、会话 ID、消息流、resume、权限交互与中断。
 *
 * - 固定 SDK 版本，使用 SDK 自带的 CLI（版本见 manifest），不依赖交互 shell 的 PATH
 * - 创建时选择原生权限模式，默认 default；canUseTool 只在 Claude 原生规则需要询问时才会被调用，
 *   已被允许规则放行的工具不经过平台审批（确认页如实说明）
 * - 每轮一个进程：新建时预先分配 sessionId（幂等核对），续聊用 resume 沿原 ID
 * - 环境变量走允许列表：不把平台进程里的 API key 传进去，避免静默换计费渠道
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionResult, Query, SDKMessage, SDKUserMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { allowlistedEnv } from "./codex-client.js";
import { cap, DriverStageError } from "./driver.js";
import type { DriverEvent, HistoryItem, HistoryRead, ProbeOutcome, RuntimeDriver, StartTurnArgs, TurnHandle, TurnResult, TurnSink } from "./driver.js";
import { underRoots } from "./codex.js";
import { bounded, LIMITS, maskEmail, stringifyInput } from "./redact.js";
import type { CapabilityName, UsageRecord } from "./types.js";

export const CLAUDE_PARSER = "claude-agent-sdk@1";
export const CLAUDE_PERMISSION_MODE = "default" as const;
/** 本轮结果到达后，等待 Claude Code 后台任务收尾的上限 */
export const LINGER_MS = 15 * 60_000;

export interface ClaudeSdkPort {
  query: typeof sdk.query;
  listSessions: typeof sdk.listSessions;
  getSessionMessages: typeof sdk.getSessionMessages;
  getSessionInfo: typeof sdk.getSessionInfo;
  resolveSettings?: typeof sdk.resolveSettings;
}

export function sdkVersions(): { sdk: string; cli: string } {
  try {
    const req = createRequire(import.meta.url);
    // 包的 exports 没有导出 package.json：从入口文件所在目录找
    const pkgPath = join(dirname(req.resolve("@anthropic-ai/claude-agent-sdk")), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    let cli = "未知";
    try { cli = (JSON.parse(readFileSync(join(dirname(pkgPath), "manifest.json"), "utf8")) as { version: string }).version; } catch { /* 旧版没有 manifest */ }
    return { sdk: pkg.version, cli };
  } catch { return { sdk: "未知", cli: "未知" }; }
}

/**
 * 本轮的输入流（streaming input 模式才支持 canUseTool / interrupt）：先是本轮消息，运行中可以追加插话，稍后关闭。
 * 关闭后不再接受追加。
 */
function turnInput(first: SDKUserMessage): { iterable: AsyncIterable<SDKUserMessage>; push: (msg: SDKUserMessage) => boolean; close: () => void } {
  const queue: SDKUserMessage[] = [first];
  let wake: (() => void) | undefined, closed = false;
  return {
    iterable: (async function* () {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((r) => { wake = r; });
        wake = undefined;
      }
    })(),
    push: (msg) => { if (closed) return false; queue.push(msg); wake?.(); return true; },
    close: () => { closed = true; wake?.(); }
  };
}

/** turn/start 与插话共用的用户消息：文字 + base64 图片 */
function claudeUserMessage(uuid: string, sessionId: string, prompt: string, images?: Array<{ mimeType: string; data: string }>): SDKUserMessage {
  return {
    type: "user", message: { role: "user", content: images?.length ? [...(prompt ? [{ type: "text" as const, text: prompt }] : []), ...images.map(i => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mimeType, data: i.data } }))] : prompt }, parent_tool_use_id: null,
    uuid: uuid as `${string}-${string}-${string}-${string}-${string}`, session_id: sessionId
  } as SDKUserMessage;
}

/** SDK 只在子进程退出后才结束消息迭代，或抛出这两种退出错误（getProcessExitError） */
const CLAUDE_STREAM_ENDED = "Claude Code 进程已退出（SDK 消息流结束）";
const CLAUDE_PROCESS_EXIT = /^Claude Code process (exited with code|terminated by signal)/;
const CLAUDE_FORCE_CLOSED = "已按请求停止（进程已关闭）";
const CLAUDE_FORCE_CLOSE_GRACE_MS = 8_000;

export class ClaudeDriver implements RuntimeDriver {
  readonly kind = "claude-code" as const;
  private readonly sdk: ClaudeSdkPort;
  private readonly live = new Set<Query>();

  private readonly evaluationRoot: string;
  private readonly guard?: RuntimeGuardProvider;
  private readonly testSdk: boolean;

  private readonly home: string;
  private readonly versions?: { sdk: string; cli: string };

  constructor(opts: { sdk?: ClaudeSdkPort; evaluationRoot?: string; guard?: RuntimeGuardProvider; home?: string; versions?: { sdk: string; cli: string } } = {}) {
    this.home = opts.home ?? homedir();
    this.versions = opts.versions;
    this.evaluationRoot = opts.evaluationRoot ?? join(homedir(), ".pi-agent", "claude-evaluation");
    this.guard = opts.guard;
    this.testSdk = !!opts.sdk;
    this.sdk = opts.sdk ?? { query: sdk.query, listSessions: sdk.listSessions, getSessionMessages: sdk.getSessionMessages, getSessionInfo: sdk.getSessionInfo, resolveSettings: sdk.resolveSettings };
  }

  /** Only the real SDK under the production seatbelt guard can declare a formal evaluation policy. */
  evaluationPolicy(): { version: string; channels: string[] } | undefined {
    if (this.testSdk || this.guard || !new SeatbeltRuntimeGuard().available()) return;
    try {
      const sdkRoot = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
      const native = join(dirname(createRequire(join(sdkRoot, "package.json")).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)), "claude");
      return claudeEvaluationPolicy(sdkRoot, native);
    } catch { return; }
  }

  /** platformSessionId：会话里的命令据此知道自己是哪个平台会话（scripts/deploy-gui.sh --when-idle 用它回发部署结果） */
  private env(platformSessionId?: string): Record<string, string> {
    return allowlistedEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: "pi-agent/2.8", ...(platformSessionId ? { PI_AGENT_RUNTIME_SESSION_ID: platformSessionId } : {}) });
  }

  /* ------------------------------ 探测 ------------------------------ */

  async probe(): Promise<ProbeOutcome> {
    const v = this.versions ?? sdkVersions();
    const permissions = { label: "default", detail: "Claude Code 原生 default 权限模式：按用户/项目设置的允许与拒绝规则决定；需要询问的动作经 canUseTool 转到 pi-agent 审批。允许规则放行的工具不经过平台。" };
    const caps = Object.fromEntries((["create", "read", "stream", "resume", "interrupt", "approval", "usage", "rateLimits"] as CapabilityName[])
      .map((k) => [k, cap("supported", `固定 Agent SDK ${v.sdk}（CLI ${v.cli}）已在平台测试中验证`, v.sdk)])) as ProbeOutcome["capabilities"];
    caps.imageInput = cap("supported", `Agent SDK ${v.sdk} 原生 image content block 已接入`, v.sdk);
    caps.roleInstructions = cap("supported", `固定 Agent SDK ${v.sdk} 的 Options.systemPrompt（preset claude_code + append）`, v.sdk);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const q = this.sdk.query({ prompt: (async function* () { await gate; })() as AsyncIterable<SDKUserMessage>, options: { cwd: this.home, permissionMode: CLAUDE_PERMISSION_MODE, env: this.env() } });
    try {
      const init = await withTimeout(q.initializationResult(), 45_000, "Claude Code 初始化超时");
      const account = (init as { account?: { email?: string; organization?: string; subscriptionType?: string; apiProvider?: string; tokenSource?: string; apiKeySource?: string } }).account ?? {};
      const models = ((init as { models?: Array<{ value: string; displayName?: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }> }).models ?? [])
        .map((m) => ({
          inputModalities: /^(default|opus|sonnet|haiku|claude[-/])/.test(m.value) ? ["text", "image"] : ["text"], id: m.value, label: m.displayName && m.displayName !== m.value ? `${m.displayName}${m.resolvedModel ? `（${m.resolvedModel}）` : ""}` : m.value,
          ...(m.value === "default" ? { isDefault: true } : {}),
          ...(m.supportsEffort !== false && m.supportedEffortLevels?.length ? { efforts: m.supportedEffortLevels } : {})
        }));
      let rateLimit: ProbeOutcome["rateLimit"];
      let authVerified = false;
      try {
        const u = await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 20_000, "额度读取超时");
        // The pinned SDK documents model_scoped (including []) only on a fresh
        // usage endpoint response; cached usage may contain windows without it.
        authVerified = u.rate_limits_available && Array.isArray(u.rate_limits?.model_scoped);
        rateLimit = claudeUsageLimits(u);
        if (!u.rate_limits_available) caps.rateLimits = cap("unsupported", "该认证方式没有订阅额度窗口（API Key / 云厂商）", v.sdk);
      } catch (e) {
        caps.rateLimits = cap("unknown", `额度接口不可用：${(e as Error).message}`, v.sdk);
      }
      const loggedIn = !!(account.email || (account.apiKeySource && account.apiKeySource !== "none") || (account.apiProvider && account.apiProvider !== "firstParty"));
      const authMode = account.apiKeySource && account.apiKeySource !== "none" ? `api-key（${account.apiKeySource}）` : account.apiProvider && account.apiProvider !== "firstParty" ? account.apiProvider : `订阅登录${account.tokenSource ? `（${account.tokenSource}）` : ""}`;
      const configSummary = [`Agent SDK ${v.sdk}，内置 Claude Code CLI ${v.cli}`, ...await this.settingsSummary(this.home)];
      return {
        ...(loggedIn && authVerified ? { authVerified: true as const } : {}),
        state: loggedIn ? "executable" : "needs-login",
        stateReason: loggedIn
          ? authVerified ? "已通过 Claude 在线认证检查（未执行模型任务）" : `SDK 初始化成功，已登记账号；登录令牌是否有效只有真实调用能确认${rateLimit && !rateLimit.available && caps.rateLimits.status === "supported" ? "（额度接口没有返回数据，令牌可能已过期）" : ""}`
          : "Claude Code 未登录：请在本机运行 claude auth login",
        sdkVersion: v.sdk, binaryVersion: v.cli, binaryPath: "（Agent SDK 内置）",
        capabilities: caps, models,
        ...(loggedIn ? { identity: {
          authMode,
          summary: `${account.subscriptionType ?? "计划未知"} · ${maskEmail(account.email)}${account.organization ? " · 组织已登记" : ""}`,
          source: "Claude Agent SDK initialize.account（无稳定账号 ID）",
          fingerprint: `${account.apiProvider ?? ""}|${account.email ?? ""}|${account.organization ?? ""}|${account.apiKeySource ?? ""}`
        } } : {}),
        configSummary, permissions, permissionOptions: permissionOptions("claude-code"), ...(rateLimit ? { rateLimit } : {})
      };
    } catch (e) {
      return { state: "error", stateReason: `Claude Agent SDK 启动失败：${(e as Error).message}`, sdkVersion: v.sdk, binaryVersion: v.cli, capabilities: caps, models: [], configSummary: [], permissions };
    } finally {
      release();
      q.close();
    }
  }

  /** 确认页展示：生效的允许/拒绝规则、hooks、MCP（只列名字与条数，不含值） */
  async settingsSummary(cwd: string): Promise<string[]> {
    if (!this.sdk.resolveSettings) return ["生效设置：未读取"];
    try {
      const r = await this.sdk.resolveSettings({ cwd });
      const eff = r.effective as { permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; defaultMode?: string; additionalDirectories?: string[] }; hooks?: Record<string, unknown>; mcpServers?: Record<string, unknown>; enabledPlugins?: Record<string, unknown> };
      const p = eff.permissions ?? {};
      const out = [
        `允许规则 ${p.allow?.length ?? 0} 条${p.allow?.length ? `（如 ${p.allow.slice(0, 4).join("、")}${p.allow.length > 4 ? " …" : ""}）` : ""}——这些工具不经平台审批直接执行`,
        `拒绝规则 ${p.deny?.length ?? 0} 条，询问规则 ${p.ask?.length ?? 0} 条`,
        p.additionalDirectories?.length ? `设置中的额外目录：${p.additionalDirectories.join("、")}` : "设置中没有额外目录",
        eff.hooks && Object.keys(eff.hooks).length ? `hooks：${Object.keys(eff.hooks).join("、")}` : "没有 hooks",
        eff.mcpServers && Object.keys(eff.mcpServers).length ? `MCP 服务：${Object.keys(eff.mcpServers).join("、")}` : "设置文件中没有 MCP 服务",
        p.defaultMode ? `设置里的默认模式 ${p.defaultMode} 被平台覆盖为 default` : "权限模式：default"
      ];
      return out.map((x) => bounded(x, 400).text);
    } catch (e) { return [`生效设置读取失败：${(e as Error).message}`]; }
  }

  async rateLimits(): Promise<ProbeOutcome["rateLimit"]> {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const q = this.sdk.query({ prompt: (async function* () { await gate; })() as AsyncIterable<SDKUserMessage>, options: { cwd: this.home, permissionMode: CLAUDE_PERMISSION_MODE, env: this.env() } });
    try {
      await withTimeout(q.initializationResult(), 45_000, "Claude Code 初始化超时");
      return claudeUsageLimits(await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 20_000, "额度读取超时"));
    } finally { release(); q.close(); }
  }

  /* ------------------------------ 执行 ------------------------------ */

  async startTurn(args: StartTurnArgs, sink: TurnSink): Promise<TurnHandle> {
    const resume = args.nativeSessionId;
    const sessionId = resume ?? args.presetSessionId ?? randomUUID();
    const input = turnInput(claudeUserMessage(args.clientMessageId, sessionId, args.prompt, args.images));
    /** 已追加、还没确认合并进来的插话（消息 uuid） */
    const steers = new Set<string>();
    let stderrTail = "";
    let interrupted = false;
    let forceClosed = false;
    const mode = args.permissionMode ?? CLAUDE_PERMISSION_MODE;
    if (!permissionOption("claude-code", mode)) throw new DriverStageError(`不支持的 Claude 权限模式：${mode}`, "create");
    let boundary: Awaited<ReturnType<typeof prepareClaudeEvaluationBoundary>> | undefined;
    if (args.evaluation) {
      if (mode !== "default" || !/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) throw new DriverStageError("Claude evaluation requires default mode and a valid native session ID", "create");
      try {
        const req = createRequire(import.meta.url);
        boundary = await prepareClaudeEvaluationBoundary({ workspace: args.workspace, evaluation: args.evaluation, runtimeRoot: join(this.evaluationRoot, sessionId), guardDir: mkdtempSync(join(tmpdir(), "claude-evaluation-guard-")), readable: [dirname(dirname(req.resolve("@anthropic-ai/claude-agent-sdk")))].filter(existsSync), guard: this.guard, ...(process.platform === "darwin" ? { nativeLoginReadRoots: [join(homedir(), "Library", "Keychains")] } : {}) });
      } catch (error) { throw new DriverStageError(`Claude evaluation boundary failed: ${(error as Error).message}`, "create"); }
    }
    const options: Options = {
      cwd: args.workspace, ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort as Options["effort"] } : {}),
      permissionMode: mode as Options["permissionMode"], ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}), env: boundary ? { ...boundary.env, CLAUDE_AGENT_SDK_CLIENT_APP: "pi-agent/3.1" } : this.env(args.platformSessionId), includePartialMessages: true,
      settingSources: boundary ? [] : ["user", "project", "local"],
      ...(boundary ? { strictMcpConfig: true, mcpServers: {}, plugins: [], tools: [...CLAUDE_EVALUATION_TOOLS], spawnClaudeCodeProcess: (o) => {
        if (!o.command || o.command.startsWith("-")) throw new Error("Invalid Claude process command");
        return spawn(boundary!.command, [...boundary!.prefix, o.command, ...o.args], { cwd: o.cwd, env: { ...o.env, ...boundary!.env }, stdio: ["pipe", "pipe", "pipe"], signal: o.signal });
      } } : {}),
      ...(args.readOnlyRoom ? { tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"], disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash", "Agent", "Task", "ExitPlanMode", "EnterPlanMode"], strictMcpConfig: true, mcpServers: {}, plugins: [] } : {}),
      ...(!boundary && !args.readOnlyRoom && args.platformBrowser ? {hooks:{PreToolUse:[{hooks:[async (input)=>{
        if(input.hook_event_name!=="PreToolUse")return {};
        const reason=scanViolation(input.tool_name,input.tool_input,{cwd:args.workspace})??screenshotViolation(input.tool_name,input.tool_input,args.workspace);
        return reason?{hookSpecificOutput:{hookEventName:"PreToolUse" as const,permissionDecision:"deny" as const,permissionDecisionReason:reason}}:{};
      }]}]}}:{}),
      ...(args.platformBrowser?{mcpServers:{platform_browser:{command:process.execPath,args:[args.platformBrowser.bridgePath,args.platformBrowser.socketPath]}}}:{}),
      // V3.0 角色：保留 Claude Code 默认系统提示，只附加角色指令（替换基础提示需另做兼容验证）
      ...(args.roleInstructions ? { systemPrompt: { type: "preset", preset: "claude_code", append: args.roleInstructions } } : {}),
      ...(resume ? { resume } : { sessionId }),
      stderr: (d) => { stderrTail = (stderrTail + d).slice(-3000); },
      canUseTool: async (toolName, toolInput, o) => {
        if (args.readOnlyRoom && !["Read", "Glob", "Grep", "WebSearch", "WebFetch"].includes(toolName)) return { behavior: "deny", message: "群聊成员只读，不能执行写入、命令或退出计划模式", toolUseID: o.toolUseID };
        // In evaluation the verified OS boundary protects every local tool, including native allow rules.
        if (boundary) {
          const tools = new Set<string>(CLAUDE_EVALUATION_TOOLS);
          return tools.has(toolName) && !o.signal.aborted ? { behavior: "allow", updatedInput: toolInput, toolUseID: o.toolUseID } : { behavior: "deny", message: "Tool is outside the protected evaluation tool set", toolUseID: o.toolUseID };
        }
        if (toolName === "AskUserQuestion") return askUserQuestion(sink, toolInput, o);
        const inp = bounded(stringifyInput(toolInput), LIMITS.toolInput);
        const decision = await sink.approval({
          nativeRequestId: o.requestId ?? o.toolUseID, kind: "tool",
          title: o.title ?? `使用工具 ${toolName}`,
          action: `${toolName}\n${inp.text}`,
          scope: [o.description, o.blockedPath ? `涉及路径 ${o.blockedPath}` : "", o.decisionReason ? `原因：${o.decisionReason}` : ""].filter(Boolean).join("；") || "Claude Code 原生权限询问",
          source: `Claude Code · canUseTool${o.agentID ? ` · 子 Agent ${o.agentID}` : ""}`,
          params: { toolName, input: toolInput, toolUseID: o.toolUseID }
        }, o.signal);
        // 只放行这一次：不返回 updatedPermissions，不写"总是允许"规则
        return decision.approve ? { behavior: "allow", updatedInput: toolInput, toolUseID: o.toolUseID } : { behavior: "deny", message: decision.reason, toolUseID: o.toolUseID };
      }
    };
    let q: Query;
    try { q = this.sdk.query({ prompt: input.iterable, options }); }
    catch (e) { await boundary?.dispose(); throw new DriverStageError(`Claude Agent SDK 启动失败：${(e as Error).message}`, "spawn"); }
    this.live.add(q);
    let lingerTimer: NodeJS.Timeout | undefined;
    let quietTimer: NodeJS.Timeout | undefined;
    let finish!: (r: TurnResult) => void;
    let settled = false;
    const done = new Promise<TurnResult>((res) => { finish = (r) => { if (settled) return; settled = true; if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = undefined; } if (quietTimer) { clearTimeout(quietTimer); quietTimer = undefined; } input.close(); this.live.delete(q); q.close(); void (boundary?.dispose() ?? Promise.resolve()).then(() => res(r), () => res({ status: "failed", reason: "Claude evaluation boundary cleanup failed" })); }; });
    let confirm!: (v: void) => void;
    let fail!: (e: Error) => void;
    const confirmed = new Promise<void>((res, rej) => { confirm = res; fail = rej; });
    let sawInit = false;
    let sawAssistant = false;
    type ResultMsg = { subtype: string; is_error: boolean; result?: string; errors?: string[]; terminal_reason?: string };
    let ownResult: ResultMsg | undefined;
    let lastResult: ResultMsg | undefined;
    let lingered = false;
    /**
     * 本轮何时结束：结果已到、没有后台任务在跑、再静默 1.5 秒（后台任务完成后 Claude 会接着回复，等它说完）。
     * 关闭输入后进程自己退出，循环结束才 finish；后台任务仍在跑时保持本轮运行中。
     */
    let resultSeen = false;
    let bgTasks = new Set<string>();
    const settle = () => {
      if (settled) return;
      if (quietTimer) { clearTimeout(quietTimer); quietTimer = undefined; }
      if (!resultSeen) return;
      // 结果出来时还有没合并的插话：Claude 会接着处理它，别关输入
      if (bgTasks.size || steers.size) { sink.status("running"); return; }
      // 后台任务刚结束时多等一会儿：Claude 会处理任务通知再回复一轮
      const waitingFollowUp = lastBgEnd > lastResultAt;
      quietTimer = setTimeout(() => input.close(), waitingFollowUp ? 20_000 : 1_500);
    };
    let lastBgEnd = 0;
    let lastResultAt = 0;
    /** 结构化错误码：assistant 消息的 error（rate_limit、billing_error、authentication_failed…）或被拒的额度事件 */
    let lastError: string | undefined;
    const state: ClaudeStreamState = { partial: new Map(), ordinals: new Map(), currentMessageId: undefined, usage: new Map(), backgroundTasks: new Map() };
    // 插话送达：Claude 在工具之间把排队的消息合并进本轮时发 command_lifecycle started（未写进 SDK 类型，有就用，位置最准）；
    // 兜底是 result 的 user_message_uuids
    const delivered = (uuid: unknown) => { if (typeof uuid === "string" && steers.delete(uuid)) sink.steerDelivered?.(uuid); };
    void (async () => {
      try {
        for await (const msg of q) {
          if (settled) break;
          if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
            const init = msg as { session_id: string; model: string; tools?: string[]; mcp_servers?: Array<{ name: string }> };
            if (resume && init.session_id !== resume) {
              fail(new DriverStageError(`resume 返回了另一个会话（${init.session_id}），不静默改绑`, "create", resume));
              finish({ status: "failed", reason: "原生会话 ID 不一致" });
              q.close();
              return;
            }
            sawInit = true;
            sink.nativeSession(init.session_id, { effectiveModel: init.model, modelSource: "system/init 消息" });
            // The native init message is the host-observed tool inventory for the evaluator channel audit.
            if (boundary) sink.evaluationInventory?.({ version: 1, nativeSessionId: init.session_id, clientMessageId: args.clientMessageId,
              // Any MCP server is an undeclared channel: list it as active so the audit fails instead of hiding it.
              activeTools: [...(init.tools ?? []), ...(init.mcp_servers ?? []).map((m) => `mcp:${m.name}`)], registeredTools: (init.tools ?? []).map((name) => ({ name, source: "builtin" as const })) });
            sink.nativeTurn(args.clientMessageId);
            sink.status("running");
            confirm();
            continue;
          }
          const lifecycle = msg as unknown as { type: string; command_uuid?: string; state?: string };
          if (lifecycle.type === "command_lifecycle") { if (lifecycle.state === "started") delivered(lifecycle.command_uuid); continue; }
          projectClaudeStream(msg, sink, state);
          if (msg.type === "result") {
            // 一次运行里可能有多条 result（例如上一轮后台任务完成的通知先结算一次）。
            // 本轮的结果以带本轮用户消息 uuid 的那条为准；本轮不在这里结束——等进程把后台工作做完自己退出。
            const r = msg as { subtype: string; is_error: boolean; result?: string; errors?: string[]; terminal_reason?: string; user_message_uuid?: string; user_message_uuids?: string[] };
            const uuids = r.user_message_uuids ?? (r.user_message_uuid ? [r.user_message_uuid] : []);
            for (const uuid of uuids) delivered(uuid);
            const mine = uuids.includes(args.clientMessageId);
            if (mine || !ownResult || !uuids.length) lastResult = r;
            if (mine) ownResult = r;
            lastResultAt = Date.now();
            if (mine || (!uuids.length && sawAssistant)) {
              resultSeen = true;
              // 后台任务最多再等 15 分钟，之后关闭这个会话自己的进程
              if (!lingerTimer) lingerTimer = setTimeout(() => { lingered = true; input.close(); q.close(); }, LINGER_MS);
            }
            settle();
          } else if (msg.type === "assistant") {
            sawAssistant = true;
            const err = (msg as { error?: string }).error;
            if (err) lastError = err;
            settle();
          } else if (msg.type === "rate_limit_event" && (msg as unknown as { rate_limit_info?: { status?: string } }).rate_limit_info?.status === "rejected") lastError = "rate_limit";
          else if (msg.type === "system") {
            const sys = msg as unknown as { subtype?: string; tasks?: Array<{ task_id: string; ambient?: boolean }> };
            if (sys.subtype === "background_tasks_changed") {
              const before = bgTasks.size;
              bgTasks = new Set((sys.tasks ?? []).filter((t) => !t.ambient).map((t) => t.task_id));
              if (before && !bgTasks.size) lastBgEnd = Date.now();
              settle();
            }
          }
        }
        if (lingerTimer) clearTimeout(lingerTimer);
        if (quietTimer) clearTimeout(quietTimer);
        if (!sawInit) fail(new DriverStageError(`Claude Code 进程结束但没有初始化记录${stderrTail ? `：${stderrTail.slice(-400)}` : ""}`, "create", resume));
        const r = ownResult ?? lastResult;
        if (r) {
          const status = r.subtype === "success" && !r.is_error ? "completed" : interrupted ? "interrupted" : "failed";
          finish({ status, terminalObserved: !lingered && bgTasks.size === 0, processEnded: CLAUDE_STREAM_ENDED, ...(status !== "completed" ? { reason: bounded(r.errors?.join("；") || r.result || r.terminal_reason || r.subtype, 600).text, ...(lastError ? { code: lastError } : {}) } : lingered ? { reason: "后台任务超过 15 分钟，已关闭进程" } : {}) });
        } else finish({ status: "interrupted", processEnded: CLAUDE_STREAM_ENDED, reason: forceClosed ? CLAUDE_FORCE_CLOSED : interrupted ? "已按请求停止" : `进程结束但没有本轮结束记录${stderrTail ? `：${stderrTail.slice(-300)}` : ""}` });
      } catch (e) {
        if (!sawInit) fail(new DriverStageError(`Claude Code ${resume ? "恢复" : "创建"}会话失败：${(e as Error).message}${stderrTail ? `；${stderrTail.slice(-300)}` : ""}`, "create", resume));
        // 进程以非零码退出时，结构化错误码（如额度用尽的 rate_limit）在之前的 assistant 消息里：一并带上，供额度/认证判定
        // 平台主动关闭（SDK close：SIGTERM，5 秒后 SIGKILL）后的流异常同样算进程已结束，否则共享名额会一直停在 unknown、挡住部署
        // SDK may replace a transport/exit error with its last error result. Only an exact
        // current-turn result with no background work proves terminal completion.
        const terminalObserved = ownResult?.is_error === true && bgTasks.size === 0 && !lingered;
        finish({ status: interrupted ? "interrupted" : "failed", ...(terminalObserved ? { terminalObserved: true } : {}), ...(CLAUDE_PROCESS_EXIT.test((e as Error).message) ? { processEnded: `Claude Code 进程已退出：${bounded((e as Error).message, 120).text}` } : forceClosed ? { processEnded: CLAUDE_FORCE_CLOSED } : {}), reason: `${(e as Error).message}${stderrTail ? `；${stderrTail.slice(-300)}` : ""}`, ...(lastError ? { code: lastError } : {}) });
      }
    })();
    await confirmed;
    // 本轮用户消息已由平台记录（key user:<uuid>；历史回读时同 key 合并）
    return {
      done,
      // 插话：追加到输入流，Claude 在当前工具执行完后合并进本轮；本轮结果出来后不再接受（它会另起一轮）
      steer: async (msg) => {
        if (args.evaluation) throw new Error("受保护的验收会话不接受插话");
        if (settled || resultSeen || interrupted) throw new Error("本轮已在结束");
        steers.add(msg.clientMessageId);
        if (!input.push(claudeUserMessage(msg.clientMessageId, sessionId, msg.prompt, msg.images))) { steers.delete(msg.clientMessageId); throw new Error("本轮已在结束"); }
      },
      interrupt: async () => {
        interrupted = true;
        await withTimeout(q.interrupt(), 10_000, "中断请求超时").catch(() => {});
        // 中断后 10 秒仍没有结束记录：关掉这个会话自己的进程（每会话独立进程，不影响别的会话）
        // 关进程后等消息流自然结束（与后台任务超时同一路径），由流结束确认进程退出并释放共享名额；
        // 流仍不结束才按结果未知收尾（SDK 5 秒后 SIGKILL，这里多留余量）
        setTimeout(() => {
          if (settled) return;
          forceClosed = true;
          input.close();
          q.close();
          setTimeout(() => { if (!settled) finish({ status: "interrupted", reason: "已按请求停止（已关闭进程，但未观察到消息流结束）" }); }, CLAUDE_FORCE_CLOSE_GRACE_MS).unref();
        }, 10_000).unref();
      }
    };
  }

  /* ------------------------------ 历史 ------------------------------ */

  async listHistory(opts: { roots: string[]; limit: number; originators?: string[] }): Promise<{ items: HistoryItem[]; coverage: "complete" | "partial"; notes: string[] }> {
    if (!opts.roots.length) return { items: [], coverage: "complete", notes: [] };
    const all = await this.sdk.listSessions({});
    const items: HistoryItem[] = [];
    for (const s of all) {
      if (!underRoots(s.cwd, opts.roots)) continue;
      items.push({
        nativeSessionId: s.sessionId, title: (s.customTitle || s.summary || s.firstPrompt || "（无标题）").slice(0, 120),
        ...(s.cwd ? { workspace: s.cwd } : {}),
        ...(s.createdAt ? { createdAt: new Date(s.createdAt).toISOString() } : {}),
        updatedAt: new Date(s.lastModified).toISOString(),
        sourceLabel: "Claude Agent SDK listSessions", status: "unknown"
      });
      if (items.length >= opts.limit) break;
    }
    return { items, coverage: items.length >= opts.limit ? "partial" : "complete", notes: [] };
  }

  async readTitle(nativeSessionId: string, opts: { workspace?: string }): Promise<Pick<HistoryRead, "title" | "titleKind"> | undefined> {
    const sessionStore = evaluationHistoryStore(this.evaluationRoot, nativeSessionId);
    const info = await this.sdk.getSessionInfo(nativeSessionId, { ...(opts.workspace ? { dir: opts.workspace } : {}), ...(sessionStore ? { sessionStore } : {}) });
    const title = info?.customTitle?.trim() || info?.summary?.trim();
    return title ? { title: title.slice(0, 120), titleKind: info?.customTitle?.trim() ? "name" : "summary" } : undefined;
  }

  async readHistory(nativeSessionId: string, opts: { workspace?: string }): Promise<HistoryRead> {
    const sessionStore = evaluationHistoryStore(this.evaluationRoot, nativeSessionId);
    const historyOptions = { ...(opts.workspace ? { dir: opts.workspace } : {}), ...(sessionStore ? { sessionStore } : {}) };
    const msgs = await this.sdk.getSessionMessages(nativeSessionId, { ...historyOptions, includeSystemMessages: true });
    const info = await this.sdk.getSessionInfo(nativeSessionId, historyOptions).catch(() => undefined);
    const events: DriverEvent[] = [];
    const usage: UsageRecord[] = [];
    const notes: string[] = [];
    const ordinals = new Map<string, number>();
    let model: string | undefined;
    for (const m of msgs) {
      try {
        const out = projectSessionMessage(m, ordinals);
        events.push(...out.events);
        if (out.usage) usage.push(out.usage);
        if (out.model) model = out.model;
      } catch (e) {
        events.push({ key: `claude:bad:${m.uuid}`, kind: "unknown", text: `无法解析的记录（${(e as Error).message}）`, source: "history", parserVersion: CLAUDE_PARSER, availability: "not_collected" });
      }
    }
    if (!msgs.length) notes.push("SDK 没有读到这个会话的消息（文件可能已删除或不在授权目录）");
    return {
      events, usage, status: "unknown", coverage: msgs.length ? "complete" : "unknown", notes,
      ...(msgs.length ? { fingerprint: claudeFingerprint(msgs) } : {}),
      ...(info ? { title: (info.customTitle || info.summary || "").slice(0, 120), titleKind: info.customTitle?.trim() ? "name" as const : "summary" as const, ...(info.cwd ? { workspace: info.cwd } : {}) } : {}),
      ...(model ? { model } : {})
    };
  }

  /** 外部写入检测指纹：对话链的条数与最后一条 uuid（不用文件大小/时间：结束后的元数据追加会误报） */
  async fingerprint(nativeSessionId: string, opts: { workspace?: string }): Promise<{ value: string } | undefined> {
    try {
      const sessionStore = evaluationHistoryStore(this.evaluationRoot, nativeSessionId);
      const msgs = await this.sdk.getSessionMessages(nativeSessionId, { ...(opts.workspace ? { dir: opts.workspace } : {}), ...(sessionStore ? { sessionStore } : {}) });
      if (!msgs.length) return undefined;
      return { value: claudeFingerprint(msgs) };
    } catch { return undefined; }
  }

  async findClientMessage(nativeSessionId: string, clientMessageId: string, opts: { workspace?: string }): Promise<boolean | undefined> {
    try {
      const sessionStore = evaluationHistoryStore(this.evaluationRoot, nativeSessionId);
      const msgs = await this.sdk.getSessionMessages(nativeSessionId, { ...(opts.workspace ? { dir: opts.workspace } : {}), ...(sessionStore ? { sessionStore } : {}) });
      return msgs.some((m) => m.uuid === clientMessageId);
    } catch { return undefined; }
  }

  shutdown(): void { for (const q of this.live) q.close(); this.live.clear(); }
}

/* ------------------------------ 投影 ------------------------------ */

/** 流式片段与完整消息共用 key：messageId + 块序号（与历史文件里按块拆开的记录一致） */
interface ClaudeStreamState {
  backgroundTasks: Map<string, NonNullable<DriverEvent["backgroundTask"]>>;
  partial: Map<string, string>; ordinals: Map<string, number>; currentMessageId: string | undefined;
  /** 每个 message.id 的用量：完整消息里带的是 message_start 时的值（输出只有一两个 token），最终值在 message_delta 里 */
  usage: Map<string, { raw: Record<string, unknown>; model?: string; sub?: string }>;
}

/** 合并同一请求的用量：后到的值覆盖，但输出 token 不倒退（迟到的旧快照不能把最终值改小） */
function mergeClaudeUsage(st: ClaudeStreamState, id: string, add: Record<string, unknown>, model?: string, sub?: string) {
  const cur = st.usage.get(id) ?? { raw: {} };
  const raw = { ...cur.raw };
  for (const [k, v] of Object.entries(add)) {
    if (typeof v !== "number") continue;
    raw[k] = k === "output_tokens" && typeof raw[k] === "number" ? Math.max(raw[k] as number, v) : v;
  }
  const next = { raw, ...(model ?? cur.model ? { model: (model ?? cur.model)! } : {}), ...(sub ?? cur.sub ? { sub: (sub ?? cur.sub)! } : {}) };
  st.usage.set(id, next);
  return next;
}

/**
 * AskUserQuestion 是 Claude 向人类提问的工具，不是一次"批准/拒绝"：把 1-4 道选择题交给平台渲染成选项面板，
 * 再按 SDK 约定把答案写进 updatedInput.answers（题干 → 所选标签；多选用逗号连接；自填的就是原文）。
 */
export function claudeQuestions(input: unknown): QuestionItem[] | undefined {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const items: QuestionItem[] = [];
  const seen = new Set<string>();
  for (const [i, q] of raw.slice(0, 4).entries()) {
    const r = q as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
    // 答案以题干文本为键，重复的题干无法区分，当作无法展示
    const item = questionItem({ id: `q${i + 1}`, question: r.question, header: r.header, options: r.options, multiSelect: r.multiSelect === true, allowOther: true });
    if (!item || seen.has(item.question)) return undefined;
    seen.add(item.question);
    items.push(item);
  }
  return items;
}

async function askUserQuestion(sink: TurnSink, toolInput: Record<string, unknown>, o: { requestId?: string; toolUseID: string; agentID?: string; signal: AbortSignal }): Promise<PermissionResult> {
  const questions = claudeQuestions(toolInput);
  if (!questions) return { behavior: "deny", message: "pi-agent 无法展示这个提问（题目为空或格式不对）；请改为直接在回复里提问", toolUseID: o.toolUseID };
  const decision = await sink.approval({
    nativeRequestId: o.requestId ?? o.toolUseID, kind: "question", title: "Claude 想问你", questions,
    action: questionsText(questions), scope: "回答后 Claude 会按你的选择继续", source: `Claude Code · AskUserQuestion${o.agentID ? ` · 子 Agent ${o.agentID}` : ""}`,
    params: { toolName: "AskUserQuestion", questions, toolUseID: o.toolUseID }
  }, o.signal);
  if (!decision.approve || !decision.answers) return { behavior: "deny", message: decision.reason || "用户没有回答", toolUseID: o.toolUseID };
  const answers: Record<string, string> = {};
  for (const q of questions) answers[q.question] = (decision.answers[q.id] ?? []).join(", ");
  return { behavior: "allow", updatedInput: { ...toolInput, answers }, toolUseID: o.toolUseID };
}

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

function blockEvents(messageId: string, blocks: Block[], startOrdinal: number, base: Partial<DriverEvent> & { source: DriverEvent["source"] }): DriverEvent[] {
  const out: DriverEvent[] = [];
  blocks.forEach((b, i) => {
    const ord = startOrdinal + i;
    const common = { ...base, parserVersion: CLAUDE_PARSER, partial: false } as const;
    if (b.type === "text") {
      const t = bounded(b.text ?? "", LIMITS.message);
      out.push({ ...common, key: `claude:text:${messageId}:${ord}`, kind: "message", role: "assistant", text: t.text, availability: "recorded", ...(t.truncated ? { truncated: t.truncated } : {}), ...(t.redactions ? { redactions: t.redactions } : {}) });
    } else if (b.type === "thinking" || b.type === "redacted_thinking") {
      const text = (b.thinking ?? "").trim();
      out.push(text
        ? { ...common, key: `claude:text:${messageId}:${ord}`, kind: "reasoning", role: "assistant", text: bounded(text, LIMITS.message).text, availability: "recorded" }
        : { ...common, key: `claude:text:${messageId}:${ord}`, kind: "reasoning", role: "assistant", text: "（推理内容未公开）", availability: "redacted" });
    } else if (b.type === "tool_use" || b.type === "server_tool_use") {
      const inp = bounded(stringifyInput(b.input), LIMITS.toolInput);
      out.push({ ...common, key: `claude:tool:${b.id}`, kind: "tool", tool: { name: b.name ?? "工具", input: inp.text, status: "inProgress" }, nativeItemId: b.id!, availability: "recorded", ...(inp.redactions ? { redactions: inp.redactions } : {}) });
    } else {
      out.push({ ...common, key: `claude:block:${messageId}:${ord}`, kind: "unknown", text: `未识别的内容块：${b.type}`, availability: "not_collected" });
    }
  });
  return out;
}

function toolResultEvents(blocks: Block[], base: Partial<DriverEvent> & { source: DriverEvent["source"] }): DriverEvent[] {
  return blocks.filter((b) => b.type === "tool_result").map((b) => {
    const content = typeof b.content === "string" ? b.content
      : Array.isArray(b.content) ? (b.content as Block[]).map((c) => c.type === "text" ? c.text ?? "" : `[${c.type}]`).join("\n") : stringifyInput(b.content ?? "");
    const out = bounded(content, LIMITS.toolOutput);
    return {
      ...base, key: `claude:tool:${b.tool_use_id}`, kind: "tool" as const, parserVersion: CLAUDE_PARSER, partial: false,
      tool: { name: "", output: out.text, status: b.is_error ? "failed" : "completed" }, nativeItemId: b.tool_use_id!, availability: "recorded" as const,
      ...(out.truncated ? { truncated: out.truncated } : {}), ...(out.redactions ? { redactions: out.redactions } : {})
    };
  });
}

/** Claude 口径：input 不含 cache read / cache creation，三者分开；只对带 message.id 的单请求 delta 求和 */
export function claudeUsage(u: Record<string, unknown>, requestId: string | undefined, model: string | undefined, sampledAt: string, occurredAt?: string, subagent?: string): UsageRecord | undefined {
  const n = (k: string) => typeof u[k] === "number" ? u[k] as number : undefined;
  const input = n("input_tokens"); const output = n("output_tokens");
  if (input === undefined && output === undefined) return undefined;
  const raw: Record<string, number> = {};
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) if (n(k) !== undefined) raw[k] = n(k)!;
  return {
    usageScope: "request", counterMode: "delta", ...(model ? { model } : {}), raw,
    ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}),
    ...(n("cache_read_input_tokens") !== undefined ? { cachedInput: n("cache_read_input_tokens") } : {}),
    ...(n("cache_creation_input_tokens") !== undefined ? { cacheCreation: n("cache_creation_input_tokens") } : {}),
    semantics: "Claude：输入、缓存读取、缓存写入分开计；按 message.id 单请求求和",
    sourceRef: `claude:message:${requestId ?? "?"}`, ...(requestId ? { requestId } : {}),
    sampledAt, ...(occurredAt ? { occurredAt } : {}), reliability: requestId ? "complete" : "partial", ...(subagent ? { subagent } : {})
  };
}

export function projectSessionMessage(m: SessionMessage & { timestamp?: string }, ordinals: Map<string, number>): { events: DriverEvent[]; usage?: UsageRecord; model?: string } {
  const at = m.timestamp;
  const sub = m.parent_tool_use_id ?? m.parent_agent_id ?? undefined;
  const base = { source: "history" as const, ...(at ? { occurredAt: at } : {}), ...(sub ? { subagent: sub } : {}) };
  const msg = (m.message ?? {}) as { id?: string; role?: string; model?: string; content?: string | Block[]; usage?: Record<string, unknown> };
  if (m.type === "assistant") {
    const id = msg.id ?? m.uuid;
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
    const start = ordinals.get(id) ?? 0;
    ordinals.set(id, start + blocks.length);
    const usage = msg.usage ? claudeUsage(msg.usage, msg.id, msg.model, new Date().toISOString(), at, sub) : undefined;
    return { events: blockEvents(id, blocks, start, base), ...(usage ? { usage } : {}), ...(msg.model && msg.model !== "<synthetic>" ? { model: msg.model } : {}) };
  }
  if (m.type === "user") {
    if (typeof msg.content === "string") {
      const t = bounded(msg.content, LIMITS.message);
      return { events: [{ ...base, key: `user:${m.uuid}`, kind: "message", role: "user", text: t.text, parserVersion: CLAUDE_PARSER, availability: "recorded", nativeTurnId: m.uuid }] };
    }
    const blocks = (msg.content ?? []) as Block[];
    const results = toolResultEvents(blocks, base);
    const texts = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    if (texts.trim()) results.push({ ...base, key: `user:${m.uuid}`, kind: "message", role: "user", text: bounded(texts, LIMITS.message).text, parserVersion: CLAUDE_PARSER, availability: "recorded", nativeTurnId: m.uuid });
    return { events: results };
  }
  // system：压缩边界、通知
  const sys = m as unknown as { subtype?: string; content?: string };
  const subtype = sys.subtype ?? (m.message as { subtype?: string } | undefined)?.subtype;
  if (subtype === "compact_boundary") return { events: [{ ...base, key: `claude:sys:${m.uuid}`, kind: "compaction", text: "上下文已压缩", parserVersion: CLAUDE_PARSER, availability: "recorded" }] };
  return { events: [{ ...base, key: `claude:sys:${m.uuid}`, kind: "notice", text: bounded(typeof sys.content === "string" ? sys.content : `系统记录${subtype ? `（${subtype}）` : ""}`, 600).text, parserVersion: CLAUDE_PARSER, availability: "recorded" }] };
}

function projectClaudeStream(msg: SDKMessage, sink: TurnSink, st: ClaudeStreamState): void {
  const now = new Date().toISOString();
  const anyMsg = msg as unknown as Record<string, unknown>;
  const sub = (anyMsg["parent_tool_use_id"] as string | null | undefined) ?? undefined;
  const base = { source: "stream" as const, occurredAt: now, ...(sub ? { subagent: sub } : {}) };
  switch (msg.type) {
    case "stream_event": {
      const ev = anyMsg["event"] as { type: string; message?: { id: string; model?: string; usage?: Record<string, unknown> }; index?: number; delta?: { type: string; text?: string; thinking?: string }; usage?: Record<string, unknown> };
      if (ev.type === "message_start" && ev.message) {
        st.currentMessageId = ev.message.id;
        if (ev.message.usage) mergeClaudeUsage(st, ev.message.id, ev.message.usage, ev.message.model, sub);
      }
      if (ev.type === "message_delta" && ev.usage && st.currentMessageId) {
        const u = mergeClaudeUsage(st, st.currentMessageId, ev.usage, undefined, sub);
        const rec = claudeUsage(u.raw, st.currentMessageId, u.model, now, now, u.sub);
        if (rec) sink.usage(rec);
      }
      if (ev.type === "content_block_delta" && st.currentMessageId && ev.delta && (ev.delta.type === "text_delta" || ev.delta.type === "thinking_delta")) {
        const k = `claude:text:${st.currentMessageId}:${ev.index ?? 0}`;
        const text = (st.partial.get(k) ?? "") + (ev.delta.text ?? ev.delta.thinking ?? "");
        st.partial.set(k, text);
        if (!text.trim()) return;
        sink.event({ ...base, key: k, kind: ev.delta.type === "text_delta" ? "message" : "reasoning", role: "assistant", text: bounded(text, LIMITS.message).text, partial: true, parserVersion: CLAUDE_PARSER, availability: "recorded" });
      }
      return;
    }
    case "assistant": {
      const m = anyMsg["message"] as { id: string; model?: string; content: Block[]; usage?: Record<string, unknown> };
      // 完整消息替换流式片段：用流事件里的块序号（每条 SDK 消息通常只带一个块）
      const blocks = m.content ?? [];
      const start = st.ordinals.get(m.id) ?? 0;
      st.ordinals.set(m.id, start + blocks.length);
      for (const e of blockEvents(m.id, blocks, start, base)) sink.event(e);
      if (m.usage) {
        const merged = mergeClaudeUsage(st, m.id, m.usage, m.model, sub);
        const u = claudeUsage(merged.raw, m.id, merged.model, now, now, merged.sub);
        if (u) sink.usage(u);
      }
      return;
    }
    case "user": {
      const m = anyMsg["message"] as { content?: string | Block[] };
      if (Array.isArray(m?.content)) for (const e of toolResultEvents(m.content, base)) sink.event(e);
      return;
    }
    case "result": {
      const r = anyMsg as { uuid: string; usage?: Record<string, unknown>; modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>; total_cost_usd?: number; num_turns?: number };
      if (r.usage) {
        const u = claudeUsage(r.usage, undefined, undefined, now, now);
        if (u) sink.usage({ ...u, usageScope: "turn", counterMode: "cumulative", sourceRef: `claude:result:${r.uuid}`, reliability: "complete", semantics: "Claude 本轮结束记录的累计用量（用于核对单请求合计，不再相加）" });
      }
      // 本轮结束由平台记录；这里只留 runtime 报告的费用（不是账单）
      if (typeof r.total_cost_usd === "number") sink.event({ ...base, key: `claude:result:${r.uuid}`, kind: "notice", text: `runtime 报告本轮费用 $${r.total_cost_usd.toFixed(4)}（按 API 标价折算，不是订阅账单）`, parserVersion: CLAUDE_PARSER, availability: "recorded" });
      return;
    }
    case "rate_limit_event": {
      const info = anyMsg["rate_limit_info"] as { rateLimitType?: string; utilization?: number; resetsAt?: number; status?: string };
      if (info.utilization === undefined && !info.rateLimitType) return;
      const pct = info.utilization === undefined ? null : info.utilization <= 1 ? Math.round(info.utilization * 1000) / 10 : info.utilization;
      sink.rateLimit({
        windows: [{ label: RL_LABEL[info.rateLimitType ?? ""] ?? info.rateLimitType ?? "额度窗口", usedPercent: pct, resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null }],
        source: "Claude rate_limit_event（运行中采样）", sampledAt: now, available: true, ...(info.status === "rejected" ? { reason: "额度已用尽，请求被拒绝" } : {})
      });
      return;
    }
    case "system": {
      const subtype = anyMsg["subtype"] as string;
      if (subtype === "compact_boundary") sink.event({ ...base, key: `claude:sys:${String(anyMsg["uuid"])}`, kind: "compaction", text: "上下文已压缩", parserVersion: CLAUDE_PARSER, availability: "recorded" });
      else if (subtype === "session_state_changed") {
        const s = anyMsg["state"];
        if (s === "requires_action") sink.status("waiting-input"); else if (s === "running") sink.status("running");
      } else if (subtype === "task_started" && anyMsg["is_backgrounded"]) {
        const id = String(anyMsg["task_id"]);
        const task = { id, status: "running", startedAt: now, description: bounded(String(anyMsg["description"] ?? ""), 200).text };
        st.backgroundTasks.set(id, task);
        sink.event({ ...base, backgroundTask: task, key: `claude:task:${id}`, kind: "notice", text: `后台任务开始：${bounded(String(anyMsg["description"] ?? ""), 200).text}（本轮会等它结束）`, parserVersion: CLAUDE_PARSER, availability: "recorded" });
      } else if (subtype === "task_notification") {
        const id = String(anyMsg["task_id"]);
        const task = { ...st.backgroundTasks.get(id), id, status: String(anyMsg["status"]), endedAt: now };
        st.backgroundTasks.set(id, task);
        const label = { completed: "完成", failed: "失败", stopped: "已停止" }[String(anyMsg["status"])] ?? String(anyMsg["status"]);
        sink.event({ ...base, backgroundTask: task, key: `claude:task:${id}`, kind: "notice", text: `后台任务${label}：${bounded(String(anyMsg["summary"] ?? ""), 300).text}`, parserVersion: CLAUDE_PARSER, availability: "recorded" });
      } else if (subtype === "api_retry") sink.event({ ...base, key: `claude:sys:${String(anyMsg["uuid"])}`, kind: "notice", text: "API 请求重试中", parserVersion: CLAUDE_PARSER, availability: "recorded" });
      return;
    }
    default: return;
  }
}

const RL_LABEL: Record<string, string> = { five_hour: "5 小时窗口", seven_day: "周窗口", seven_day_opus: "周窗口（Opus）", seven_day_sonnet: "周窗口（Sonnet）", overage: "超额" };

export function claudeUsageLimits(u: { rate_limits_available: boolean; rate_limits: Record<string, { utilization: number | null; resets_at: string | null } | null | unknown> | null; subscription_type: string | null }): NonNullable<ProbeOutcome["rateLimit"]> {
  const now = new Date().toISOString();
  if (!u.rate_limits_available) return { windows: [], source: "Claude usage（实验接口）", experimental: true, sampledAt: now, available: false, reason: "该认证方式不适用订阅额度" };
  const rl = u.rate_limits ?? {};
  const windows = Object.entries(rl)
    .filter(([k, v]) => k in RL_LABEL && v && typeof v === "object" && "utilization" in (v as object))
    .map(([k, v]) => { const w = v as { utilization: number | null; resets_at: string | null }; return { label: RL_LABEL[k]!, usedPercent: w.utilization, resetsAt: w.resets_at }; });
  return {
    windows, ...(u.subscription_type ? { plan: u.subscription_type } : {}), source: "Claude usage（实验接口，可能变化）", experimental: true, sampledAt: now,
    available: windows.length > 0, ...(windows.length ? {} : { reason: "runtime 本次没有返回额度窗口（可能要在一次真实请求之后才有）" })
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

export function claudeFingerprint(msgs: SessionMessage[]): string { return `n${msgs.length}:l${msgs[msgs.length - 1]?.uuid ?? "-"}`; }
