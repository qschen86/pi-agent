/** Ordinary Pi RPC chats use the shared session manager; no TaskSession or contract gate. */
import { execFile } from "node:child_process";
import { controlPermissionGrants } from '../../pi-runtime/src/permission-control.js';
import { queryBrowserProfiles } from "../../pi-runtime/src/browser-discovery.js";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { buildPiEnvironment, BUILTIN_PROVIDER_ENV, defaultPiConfigDir, preparePiRuntime, providerCredentialPresent, SeatbeltRuntimeGuard } from "@pi-agent/adapter-pi";
import type { RuntimeGuardProvider } from "@pi-agent/runtime-contracts";
import { cap, DriverStageError, type DriverApproval, type HistoryRead, type ProbeOutcome, type RuntimeDriver, type StartTurnArgs, type TurnHandle, type TurnResult, type TurnSink } from "./driver.js";
import { CAPABILITIES, type ModelOption } from "./types.js";
import { defaultPermissionMode, permissionOption, permissionOptions } from "./permissions.js";
import { PiRpcClient, type PiClientOptions, type PiRpcEvent } from "./pi-client.js";
import { piEvaluationPolicy, PI_ISOLATION_ARGS, PI_TOOL_NAMES } from "./pi-evaluation-policy.js";
import { registeredRuntimeExecutable } from "../../pi-runtime/src/registration.js";
import { prepareRuntimeConnection, resolveRuntimeInvocation, type RuntimeConnection } from "../../pi-runtime/src/connection.js";
import { questionItem, questionsText } from "./questions.js";
import { listPiSessions, piInputHash, piSessionFiles, readPiSession, type PiSessionRead } from "./pi-history.js";
import { object, piContentText, piMessageKey, piUsage, projectPiMessage } from "./pi-projection.js";
import { bounded, LIMITS, stringifyInput } from "./redact.js";

export interface PiDriverOptions {
  binaryPath?: string;
  sourceAgentDir?: string;
  sessionDir?: string;
  guard?: RuntimeGuardProvider;
  clientFactory?: (options: PiClientOptions) => PiRpcClient;
  /** 等审批扩展确认就绪的上限（毫秒），默认 PI_READY_MS */
  readyTimeoutMs?: number;
  /** Runtime executable and operator arguments; runtime owns its own profile/configuration. */
  runtimeExecutable?: string;
  runtimeArgs?: string[];
}
/** steers：本轮插话，按发出顺序；index 为送达后在原生记录里的用户消息序号（读历史时据此还原平台 key） */
interface DispatchEntry { hash: string; baseUsers: number; state: "prepared" | "accepted" | "rejected" | "settled"; result?: TurnResult; fingerprint?: string; runtimeFingerprint?: string; steers?: Array<{ clientMessageId: string; hash: string; index?: number }> }
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** 与 piInputHash 对同一输入给出同一值：只有文字时哈希文字，带图时哈希文字与图片字节摘要 */
const inputDigest = (prompt: string, images?: Array<{ sha256: string }>) => digest(images?.length ? JSON.stringify({ text: prompt, images: images.map(i => i.sha256) }) : prompt);
/** 等 Pi 审批扩展确认就绪的上限 */
const PI_READY_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function json(file: string): Record<string, unknown> { try { return object(JSON.parse(readFileSync(file, "utf8"))); } catch { return {}; } }
function atomic(file: string, data: string): void { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.tmp-${randomUUID()}`; writeFileSync(tmp, data, { mode: 0o600 }); renameSync(tmp, file); }
function atomicCopy(source: string, file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${randomUUID()}`;
  try { copyFileSync(source, temp); chmodSync(temp, 0o600); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}

export class PiDriver implements RuntimeDriver {
  readonly kind = "pi" as const;
  readonly sessionDir: string;
  private readonly source: string;
  private clients = new Set<PiRpcClient>();
  private connections = new Set<RuntimeConnection>();
  private active = new Map<string, PiRpcClient>();
  private grantControl = new Map<string,{supported:boolean;invocation:{binaryPath:string;args?:string[]}}>();
  private models: ModelOption[] = [];
  private closing = false;
  constructor(private readonly options: PiDriverOptions = {}) {
    this.source = options.sourceAgentDir ?? defaultPiConfigDir();
    this.sessionDir = options.sessionDir ?? join(tmpdir(), "pi-agent-native-chats");
  }
  private binary(): string | undefined {
    return [this.options.binaryPath, ...String(process.env.PATH ?? "").split(":").map((p) => join(p, "pi")), "/opt/homebrew/bin/pi", "/usr/local/bin/pi"].find((p): p is string => !!p && existsSync(p));
  }
  private compatibility(binary: string): { version?: string; supported: boolean; roleInstructions?: boolean; imageInput?: boolean; packageRoot?: string } {
    let directory = dirname(realpathSync(binary));
    for (let i = 0; i < 6; i++, directory = dirname(directory)) {
      const pkg = json(join(directory, "package.json"));
      if (pkg.name !== "@earendil-works/pi-coding-agent") continue;
      const lifecycle = join(directory, "dist", "core", "agent-session.js");
      const cliArgs = join(directory, "dist", "cli", "args.js");
      const rpc = join(directory, "dist", "modes", "rpc", "rpc-types.d.ts");
      const imageInput = existsSync(rpc) && readFileSync(rpc, "utf8").includes("images?: ImageContent[]");
      return { imageInput, packageRoot: directory, version: typeof pkg.version === "string" ? pkg.version : undefined, supported: existsSync(lifecycle) && readFileSync(lifecycle, "utf8").includes('type: "agent_settled"'), roleInstructions: existsSync(cliArgs) && readFileSync(cliArgs, "utf8").includes('arg === "--append-system-prompt"') };
    }
    return { supported: false };
  }
  evaluationPolicy(): {version: string; channels: string[]} | undefined {
    if (this.closing || this.options.guard || this.options.clientFactory || this.options.runtimeExecutable || this.options.runtimeArgs?.length || process.env.PI_AGENT_PI_RUNTIME || !new SeatbeltRuntimeGuard().available()) return;
    try {
      if(registeredRuntimeExecutable())return;
      const binary = this.binary(); if (!binary) return;
      const compatible = this.compatibility(binary);
      if (!compatible.supported || !compatible.roleInstructions || !compatible.packageRoot) return;
      return piEvaluationPolicy(binary, compatible.packageRoot);
    } catch { return; }
  }
  private endpoint(options: PiClientOptions): PiRpcClient {
    if (this.closing) throw new Error("Pi driver is shut down");
    const client = this.options.clientFactory?.(options) ?? new PiRpcClient(options);
    this.clients.add(client); return client;
  }
  private providers(): string[] {
    const auth = json(join(this.source, "auth.json")), config = json(join(this.source, "models.json")), settings = json(join(this.source, "settings.json"));
    const names = new Set([...Object.keys(auth), ...Object.keys(object(config.providers)), ...Object.keys(BUILTIN_PROVIDER_ENV)]);
    if (typeof settings.defaultProvider === "string") names.add(settings.defaultProvider);
    return [...names].filter((provider) => providerCredentialPresent(provider, { sourceAgentDir: this.source }));
  }
  async probe(): Promise<ProbeOutcome> {
    const modes = permissionOptions("pi"), permissions = permissionOption("pi", defaultPermissionMode("pi"))!;
    const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, cap("unknown", "尚未核对 Pi RPC")])) as ProbeOutcome["capabilities"];
    capabilities.roleInstructions = cap("unsupported", "Pi 普通会话未提供已验证的角色注入通道");
    capabilities.rateLimits = cap("unsupported", "Pi RPC 未报告账号额度，显示未知");
    const binary = this.binary();
    let browserProfiles: ProbeOutcome["browserProfiles"];
    if (!this.options.guard && !this.options.clientFactory) {
      try {
        const invocation = resolveRuntimeInvocation({binaryPath:this.options.runtimeExecutable ?? process.env.PI_AGENT_PI_RUNTIME,args:this.options.runtimeArgs});
        browserProfiles = await queryBrowserProfiles(args => new Promise<string>((resolve, reject) => execFile(invocation.binaryPath, [...(invocation.args ?? []), ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 65536 }, (error, stdout) => error ? reject(error) : resolve(stdout))));
      } catch { /* Unavailable optional runtime discovery must not break ordinary chats. */ }
    }
    const base = { ...(browserProfiles ? { browserProfiles } : {}), capabilities, models: [] as ModelOption[], permissions, permissionOptions: modes, configSummary: ["普通 Pi 对话；不经过合约流程", "Pi runtime 自主管理扩展、权限与浏览器；平台转发原生交互", "凭据配置与模型目录就绪不等于真实调用成功"] };
    if (!binary) return { ...base, state: "not-installed", stateReason: "未发现 Pi CLI" };
    const version = this.compatibility(binary);
    capabilities.imageInput = version.imageInput ? cap("supported", "Pi RPC images 内容通道已接入", version.version) : cap("unknown", "Pi 版本未确认 images 输入", version.version);
    if (version.roleInstructions) capabilities.roleInstructions = cap("supported", "Pi CLI --append-system-prompt 原生系统指令文件通道已接入；行为资格仍需真实验收", version.version);
    if (!version.supported) return { ...base, binaryPath: binary, binaryVersion: version.version, state: "incompatible", stateReason: "Pi 版本未确认提供 agent_settled 生命周期事件" };
    const providers = this.providers();
    if (!providers.length) return { ...base, binaryPath: binary, binaryVersion: version.version, state: "needs-login", stateReason: "没有可隔离的 provider API key 配置；OAuth 凭据暂不支持此普通会话通道" };
    const models: ModelOption[] = []; const settings = json(join(this.source, "settings.json"));
    try {
      for (const provider of providers) {
        const root = mkdtempSync(join(tmpdir(), "pi-chat-probe-")); let client: PiRpcClient | undefined;
        try {
          const runtime = preparePiRuntime(root, { sourceAgentDir: this.source, provider });
          const env = buildPiEnvironment(process.env, { passEnv: runtime.passEnv, set: { HOME: runtime.homeDir, TMPDIR: runtime.tmpDir, PI_CODING_AGENT_DIR: runtime.agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" } });
          client = this.endpoint({ binaryPath: binary, args: ["--mode", "rpc", "--no-session", ...PI_ISOLATION_ARGS, "--tools", ""], cwd: root, env });
          await client.start();
          const state = object(await client.request("get_state"));
          const available = object(await client.request("get_available_models"));
          for (const raw of Array.isArray(available.models) ? available.models : []) {
            const model = object(raw); if (model.provider !== provider || typeof model.id !== "string") continue;
            let efforts: string[] | undefined;
            try {
              await client.request("set_model", { provider, modelId: model.id });
              const data = object(await client.request("get_available_thinking_levels"));
              if (Array.isArray(data.levels) && data.levels.every((level) => typeof level === "string")) efforts = data.levels as string[];
            } catch { /* Missing effort capability stays unknown. */ }
            const initial = object(state.model);
            const isDefault = (settings.defaultProvider === provider && settings.defaultModel === model.id) || (!settings.defaultModel && initial.provider === provider && initial.id === model.id);
            models.push({ inputModalities: Array.isArray(model.input) ? model.input.filter((x): x is string => typeof x === "string") : undefined, id: `${provider}/${model.id}`, label: `${provider} · ${model.name ?? model.id}`, isDefault, ...(efforts ? { efforts } : {}), ...(isDefault && efforts?.includes(String(state.thinkingLevel)) ? { defaultEffort: String(state.thinkingLevel) } : {}) });
          }
          const initial = object(state.model);
          if (typeof initial.provider === "string" && typeof initial.id === "string") await client.request("set_model", { provider: initial.provider, modelId: initial.id });
        } finally { client?.stop(); if (client) { await client.waitForExit(); this.clients.delete(client); } rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); }
      }
      this.models = models;
      const guard = this.options.guard ?? new SeatbeltRuntimeGuard();
      for (const name of ["create", "read", "stream", "resume", "interrupt", "approval", "usage"] as const) capabilities[name] = cap("supported", "Pi RPC 与原生 session 记录已核对", version.version);
      const ready = models.length > 0 && guard.available();
      return { ...base, models, binaryPath: binary, binaryVersion: version.version, state: ready ? "executable" : models.length ? "incompatible" : "needs-login", stateReason: ready ? "Pi RPC 与模型目录就绪；支持工作区沙盒与按需审批" : models.length ? "受限文件沙箱不可用，拒绝默认模式启动" : "Pi 未报告可调用模型", identity: { authMode: "provider-api-key", summary: `Pi · ${providers.join("、")}（账号未独立核实）`, source: "本机 provider 配置分区", fingerprint: `pi-provider-partition:${this.source}:${providers.sort().join(",")}` } };
    } catch (error) { return { ...base, binaryPath: binary, binaryVersion: version.version, state: "error", stateReason: bounded((error as Error).message, 200).text }; }
  }

  private dispatchPath(id: string): string { if (!UUID.test(id)) throw new Error("Invalid Pi session UUID"); return join(this.sessionDir, `${id}.dispatch.json`); }
  private journal(id: string): Record<string, DispatchEntry> { return json(this.dispatchPath(id)) as Record<string, DispatchEntry>; }
  private writeJournal(id: string, clientMessageId: string, entry: DispatchEntry): void { atomic(this.dispatchPath(id), JSON.stringify({ ...this.journal(id), [clientMessageId]: entry })); }
  private locate(id: string, workspace?: string): PiSessionRead | undefined {
    if (!UUID.test(id)) throw new Error("Invalid Pi session UUID");
    const own = join(this.sessionDir, `${id}.jsonl`);
    const files = existsSync(own) ? [own] : piSessionFiles([join(this.source, "sessions")]);
    for (const file of files) {
      try { const read = readPiSession(file); if (read.nativeSessionId === id && (!workspace || (read.workspace && realpathSync(read.workspace) === realpathSync(workspace)))) return read; } catch { /* partial source */ }
    }
    return;
  }

  async permissionGrants(nativeSessionId:string,options:{workspace:string;revoke?:{id?:string}}) {
    if(this.closing)throw new Error('Pi driver is shut down');
    const activeControl=this.grantControl.get(nativeSessionId);
    if(options.revoke&&this.active.has(nativeSessionId)&&!activeControl?.supported)throw new Error('当前 Pi 进程不支持实时撤销，请等本轮结束后重试');
    const session=this.locate(nativeSessionId,options.workspace);
    if(!session)throw new Error('Pi native session not found in selected workspace');
    const invocation=activeControl?.invocation??resolveRuntimeInvocation({binaryPath:this.options.runtimeExecutable??process.env.PI_AGENT_PI_RUNTIME,args:this.options.runtimeArgs});
    return controlPermissionGrants(args=>new Promise<string>((resolve,reject)=>execFile(invocation.binaryPath,[...(invocation.args??[]),...args],{encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024},(error,stdout)=>error?reject(new Error('Pi runtime 授权管理失败，请检查 runtime 状态')):resolve(stdout))),session.file,options.workspace,options.revoke);
  }

  async startTurn(args: StartTurnArgs, sink: TurnSink): Promise<TurnHandle> {
    if(args.evaluation && (this.options.runtimeExecutable || this.options.runtimeArgs?.length || process.env.PI_AGENT_PI_RUNTIME || (!this.options.guard&&!this.options.clientFactory&&registeredRuntimeExecutable()))) throw new DriverStageError("External Pi runtime needs its own evaluation qualification", "create", undefined, true);
    const binary = this.binary(); if (!binary) throw new DriverStageError("Pi CLI unavailable", "spawn");
    if (!this.compatibility(binary).supported) throw new DriverStageError("Pi agent_settled capability unavailable", "spawn");
    if (args.roleInstructions && !this.compatibility(binary).roleInstructions) throw new DriverStageError("Pi role instructions unsupported", "create");
    const id = args.nativeSessionId ?? args.presetSessionId ?? randomUUID();
    this.dispatchPath(id);
    if (this.active.has(id)) throw new DriverStageError("Pi native session already active", "dispatch", id);
    const previous = args.nativeSessionId ? this.locate(id, args.workspace) : undefined;
    if (args.nativeSessionId && !previous) throw new DriverStageError("Pi native session not found in the selected workspace", "create");
    const priorDispatch = this.journal(id)[args.clientMessageId];
    if (priorDispatch) throw new Error("Pi client message already dispatched; reconcile it before any new turn");
    const selected = args.model ?? previous?.model ?? this.models.find((m) => m.isDefault)?.id ?? this.models[0]?.id;
    const slash = selected?.indexOf("/") ?? -1;
    if (!selected || slash < 1) throw new DriverStageError("Pi model must identify a provider and model", "create");
    const provider = selected.slice(0, slash), modelId = selected.slice(slash + 1);
    if (!providerCredentialPresent(provider, { sourceAgentDir: this.source })) throw new DriverStageError("Pi selected provider credentials unavailable", "create");
    const savedRuntime = previous ? Object.values(this.journal(id)).reverse().find(e => e.runtimeFingerprint)?.runtimeFingerprint : undefined;
    // 联网检索：普通聊天（非评测）默认给 web_search/web_open，来源范围开放公网；评测边界不注册。
    const webResearch = args.evaluation ? undefined : args.webResearch === false ? undefined : args.webResearch ?? { sourceDomains: ["*"] };
    const temp = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "pi-connection-"));
    const gateToken = randomUUID();
    let connection: RuntimeConnection;
    try {
      const runtimeExecutable = this.options.runtimeExecutable ?? process.env.PI_AGENT_PI_RUNTIME;
      connection = await prepareRuntimeConnection({controlRoot: temp,
        spec: {version: 1, binary, workspace: args.workspace, browserProfileId: args.browserProfileId, worktree: args.worktree, mode: args.permissionMode ?? (args.evaluation ? "pi-ask" : defaultPermissionMode("pi")), provider, model: modelId, sessionId: id, memorySource:{platformSessionId:args.platformSessionId,turnId:args.clientMessageId}, sourceAgentDir: this.source, sessionFile: previous?.file, roleInstructions: args.roleInstructions, recordReadRoots: args.recordReadRoots, platformBrowser:args.platformBrowser, evaluation: args.evaluation, expectedFingerprint: savedRuntime, ...(webResearch ? {webResearch} : {})},
        ...(runtimeExecutable || this.options.runtimeArgs ? {invocation:resolveRuntimeInvocation({binaryPath:runtimeExecutable,args:this.options.runtimeArgs})} : {}),
        ...(this.options.clientFactory || this.options.guard ? {embedded:{guard:this.options.guard,sink,token:gateToken}} : {})});
      this.connections.add(connection);
    } catch (error) { rmSync(temp, { recursive: true, force: true }); throw new DriverStageError(bounded((error as Error).message, 400).text, "create", undefined, true); }
    let client: PiRpcClient | undefined, nativeFile: string | undefined, accepted = false, finished = false, interrupted = false, promptSent = false;
    let lastStreamMessage: Record<string, unknown> | undefined;
    const abort = new AbortController();
    let resolveDone!: (value: TurnResult) => void;
    const done = new Promise<TurnResult>((resolve) => { resolveDone = resolve; });
    let entry: DispatchEntry = { hash: inputDigest(args.prompt, args.images), baseUsers: previous?.userMessages.length ?? 0, state: "prepared", ...(connection.fingerprint ? { runtimeFingerprint: connection.fingerprint } : {}) };
    // 插话：本轮里第 n 条用户消息（0 是本轮输入）；收尾开始后不再接受插话（Pi 空闲时收下的 steer 不会再触发运行）
    let userOrdinal = -1, userKey = `user:${args.clientMessageId}`, settling = false;
    const save = () => { if (nativeFile && existsSync(nativeFile)) atomicCopy(nativeFile, join(this.sessionDir, `${id}.jsonl`)); };
    const finish = async (result: TurnResult) => {
      if (finished) return; finished = true; abort.abort();
      let processEnded: string | undefined;
      try {
        save(); const read = this.locate(id, args.workspace);
        if (accepted) {
          if (!read?.fingerprint) throw new Error("Missing durable transcript");
          // A crash before verified process/boundary cleanup must leave a held source.
          entry = { ...entry, state: "settled", result: { status: "unknown", terminalObserved: false, reason: "Pi runtime cleanup is pending" }, fingerprint: read.fingerprint };
          this.writeJournal(id, args.clientMessageId, entry);
        }
      } catch { result = { status: "unknown", terminalObserved: false, reason: "Pi transcript persistence could not be confirmed" }; }
      try {
        await connection.cancel();
        if (client) { client.stop(); await client.waitForExit(); this.clients.delete(client); processEnded = "Pi RPC 进程组已退出（平台停止并等到退出）"; }
        await connection.dispose(); this.connections.delete(connection); rmSync(temp, { recursive: true, force: true });
        this.active.delete(id); this.grantControl.delete(id);
      } catch {
        result = { status: "unknown", terminalObserved: false, reason: [result.reason, "Pi runtime cleanup could not be confirmed"].filter(Boolean).join("; ") };
      } finally {
        try { if (accepted) { entry = { ...entry, result }; this.writeJournal(id, args.clientMessageId, entry); } }
        catch { result = { status: "unknown", terminalObserved: false, reason: "Pi terminal journal persistence could not be confirmed" }; }
        resolveDone(processEnded ? { ...result, processEnded } : result);
      }
    };
    try {
      client = this.endpoint(connection.endpoint);
      this.active.set(id, client);
      if(connection.supervised)this.grantControl.set(id,{supported:false,invocation:{binaryPath:connection.endpoint.binaryPath,args:connection.endpoint.args?.slice(0,-4)}});
      let inventory: Record<string, unknown> | undefined;
      let gateReady!: () => void, gateFailed!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { gateReady = resolve; gateFailed = reject; });
      client.on("event", (event: PiRpcEvent) => {
        if (connection.supervised && event.type === "runtime_ready") {
          if (event.version !== 1 || event.sessionId !== id || event.workspace !== realpathSync(args.workspace) || typeof event.sessionDirectory !== "string" || typeof event.fingerprint !== "string") { gateFailed(new Error("Invalid Pi runtime readiness response")); return; }
          if(args.platformBrowser && event.platformBrowser!==1){gateFailed(new Error("Pi runtime 尚未支持平台浏览器，请先更新独立 runtime；本轮输入未发送"));return;}
          connection.sessionDirectory = event.sessionDirectory; connection.fingerprint = event.fingerprint;
          const control=this.grantControl.get(id);if(control)control.supported=event.permissionGrantControl===1;
          entry.runtimeFingerprint = event.fingerprint;
          if (args.evaluation && event.inventory) inventory = object(event.inventory);
          gateReady(); return;
        }
        if (connection.supervised && event.type === "runtime_error") {
          const error = new DriverStageError(bounded(String(event.error ?? "Pi runtime failed"), 400).text, promptSent ? "dispatch" : "create", undefined, !promptSent);
          if (!promptSent) gateFailed(error); else void finish({status:"unknown",reason:error.message});
          return;
        }
        if (event.type === "runtime_status") { if (event.status === "waiting-input" || event.status === "running") sink.status(event.status); return; }
        if (event.type === "runtime_approval") { void this.runtimeApproval(event, sink, client!, abort.signal); return; }
        if (connection.control(event, (requestId, response) => { if (!finished && !abort.signal.aborted) client!.respondUi(requestId, response); })) return;
        if (args.evaluation && event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.startsWith("pi-chat-evaluation-tools:")) {
          try {
            const observed = object(JSON.parse(event.message.slice("pi-chat-evaluation-tools:".length)));
            if (observed.token === gateToken) { inventory = observed; gateReady(); }
          } catch { /* Unbound or malformed messages never authorize dispatch. */ }
          return;
        }
        if (event.type === "extension_ui_request" && event.method === "notify" && event.message === `pi-chat-gate:${gateToken}`) { gateReady(); return; }
        if (finished) return;
        if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
          const message = object(event.message); const partial = event.type !== "message_end";
          if (message.role === "user" && event.type === "message_start") {
            // 本轮输入与插话按内容哈希认领：插话按发出顺序送达，认领第一条还没送达、内容相同的
            userOrdinal++;
            const hash = piInputHash(message.content);
            const steer = userOrdinal > 0 || hash !== entry.hash ? entry.steers?.find(x => x.index === undefined && x.hash === hash) : undefined;
            if (steer) { steer.index = entry.baseUsers + userOrdinal; this.writeJournal(id, args.clientMessageId, entry); }
            userKey = steer ? `user:${steer.clientMessageId}` : userOrdinal === 0 ? `user:${args.clientMessageId}` : piMessageKey(message);
          }
          if (message.role === "user" && event.type === "message_end" && userKey.startsWith("user:") && userKey !== `user:${args.clientMessageId}`) sink.steerDelivered?.(userKey.slice(5));
          for (const projected of projectPiMessage(message, "stream", partial)) sink.event(message.role === "user" ? { ...projected, key: userKey } : projected);
          if (!partial) { lastStreamMessage = message; const u = piUsage(message, id); if (u) sink.usage(u); save(); }
          return;
        }
        if (event.type.startsWith("tool_execution_")) {
          const result = object(event.result ?? event.partialResult);
          sink.event({ key: `pi:tool:${event.toolCallId}`, nativeItemId: String(event.toolCallId), kind: "tool", tool: { name: String(event.toolName), ...(event.args ? { input: bounded(stringifyInput(event.args), LIMITS.toolInput).text } : {}), ...(result.content ? { output: bounded(piContentText(result.content), LIMITS.toolOutput).text } : {}), status: event.type === "tool_execution_end" ? event.isError ? "failed" : "completed" : "running" }, partial: event.type !== "tool_execution_end", source: "stream", parserVersion: "pi-rpc@1", availability: "recorded" }); return;
        }
        if (event.type === "extension_ui_request") {
          if(connection.supervised){
            const method=String(event.method),requestId=String(event.id??'');
            if(['select','confirm','input','editor'].includes(method))void this.question(event,method,sink,client!,abort.signal,()=>client!.respondUi(requestId,{cancelled:true}));
          } else void this.approval(event, sink, client!, abort.signal, args.workspace);
          return;
        }
        if (event.type === "agent_settled") {
          // Pi emits settled only after retry/compaction and follow-up queues are empty.
          settling = true;
          void (async () => {
            try {
              const state = object(await client!.request("get_state"));
              // 收尾前刚排进去、没赶上的插话会留在 Pi 队列里，但不会再触发运行：按未送达处理，不等它
              const stranded = entry.steers?.filter(x => x.index === undefined).length ?? 0;
              if (state.isStreaming || state.isCompacting || Number(state.pendingMessageCount) > stranded) { settling = false; return; }
              sink.nativeSession(id, { effectiveModel: selected, modelSource: "Pi get_state", effectiveEffort: typeof state.thinkingLevel === "string" ? state.thinkingLevel : undefined, effortSource: "Pi get_state", title: typeof state.sessionName === "string" ? state.sessionName : undefined });
              // message_end already carries the complete native message. Reading
              // get_messages here grows with the entire history and can exceed the
              // RPC frame limit even when every individual event is well bounded.
              const last = object(lastStreamMessage);
              save();
              const durable = this.locate(id, args.workspace);
              if (args.roleInstructions) {
                // Pi 记录时把 preamble 以外的段包成 <name>\n正文\n</name>
                const expected = `<addendum>\n${args.roleInstructions.replace(/^\uFEFF/, "")}\n</addendum>`, actual = durable?.systemAddendum;
                sink.roleApplied?.({ matched: actual === expected, source: "Pi 会话记录的系统提示 addendum 段",
                  ...(actual === expected ? {} : { detail: actual === undefined ? "会话记录里没有 addendum 段" : `addendum 与角色正文不一致（${actual.length}/${expected.length} 字符）` }) });
              }
              const verified = last.role === "assistant" && durable?.coverage === "complete" && JSON.stringify(durable.lastMessage) === JSON.stringify(last);
              // Pi ≥1.1 reports whether the run was aborted; older builds omit it and keep the stop-reason inference.
              // An abort during retry or compaction leaves no "aborted" assistant message, so the flag is authoritative.
              const aborted = typeof event.aborted === "boolean" ? event.aborted : undefined;
              const result: TurnResult = interrupted || aborted === true ? { status: "interrupted" }
                : !verified ? { status: "unknown", reason: "Pi terminal assistant transcript could not be verified" }
                : aborted === false && last.stopReason === "aborted" ? { status: "unknown", reason: "Pi reported the run as not aborted, but its last message was aborted" }
                : last.stopReason === "aborted" ? { status: "interrupted" }
                : last.stopReason === "error" ? { status: "failed", reason: bounded(String(last.errorMessage ?? "Pi model invocation failed"), 500).text }
                : ["stop", "length"].includes(String(last.stopReason)) ? { status: "completed" }
                : { status: "unknown", reason: "Pi terminal stop reason could not be verified" };
              await finish({ ...result, terminalObserved: verified && result.status !== "unknown" });
            } catch { await finish(interrupted ? { status: "interrupted" } : { status: "unknown", reason: "Pi final state could not be verified" }); }
          })(); return;
        }
        if (event.type === "extension_error") { void finish({ status: "unknown", reason: "Pi approval extension failed; process stopped" }); return; }
        if (event.type.includes("compaction") || event.type.includes("retry")) sink.event({ key: `pi:notice:${args.clientMessageId}:${event.type}`, kind: event.type.includes("compaction") ? "compaction" : "notice", text: event.type, source: "stream", parserVersion: "pi-rpc@1", availability: "recorded" });
      });
      client.on("exit", (event: { reason?: string } | undefined) => {
        if (!finished && accepted) void finish(interrupted ? { status: "interrupted" } : {
          status: "unknown", reason: ["Pi RPC exited without a confirmed settled state", bounded(event?.reason, 400).text].filter(Boolean).join("; ")
        });
      });
      await client.start();
      let timer: NodeJS.Timeout | undefined;
      // 沙箱启动 + 扩展编译在机器高负载时可能要几十秒（线上实测 35 秒）；就绪前 prompt 还没发出，失败一律算未执行
      const readyMs = this.options.readyTimeoutMs ?? PI_READY_MS;
      try { await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DriverStageError(`Pi approval extension did not confirm readiness within ${Math.round(readyMs / 1000)}s`, "create", undefined, true)), readyMs); })]); } finally { clearTimeout(timer); }
      if (args.evaluation) {
        const active = inventory?.activeTools, registered = inventory?.registeredTools;
        const names = (values: unknown) => Array.isArray(values) && values.length === PI_TOOL_NAMES.length && values.every(name => typeof name === "string") && new Set(values).size === values.length && JSON.stringify([...values].sort()) === JSON.stringify([...PI_TOOL_NAMES].sort());
        if (inventory?.version !== 1 || !names(active) || !Array.isArray(registered) || !names(registered.map(tool => object(tool).name)) || registered.some(tool => object(tool).source !== "builtin")) {
          throw new DriverStageError("Pi evaluation native tool inventory is missing or differs from the protected builtin policy", "create", undefined, true);
        }
      }
      const state = object(await client.request("get_state"));
      if (state.sessionId !== id || typeof state.sessionFile !== "string") throw new DriverStageError("Pi did not confirm the requested native session ID", "create");
      const file = realpathSync(dirname(state.sessionFile));
      if (!connection.sessionDirectory || (!file.startsWith(realpathSync(connection.sessionDirectory) + "/") && file !== realpathSync(connection.sessionDirectory))) throw new DriverStageError("Pi session file is outside the isolated runtime directory", "create");
      nativeFile = state.sessionFile;
      // Native Pi creates its JSONL lazily. Preserve only the verified empty
      // checkpoint so a definitely rejected first prompt can continue under this UUID.
      if (!previous && !existsSync(nativeFile)) {
        const timestamp = new Date().toISOString();
        atomic(join(this.sessionDir, `${id}.jsonl`), [
          { type: "session", version: 3, id, cwd: args.workspace, timestamp },
          { type: "model_change", id: randomUUID().slice(0, 8), parentId: null, timestamp, provider: object(state.model).provider, modelId: object(state.model).id }
        ].map((row) => JSON.stringify(row)).join("\n") + "\n");
      }
      sink.nativeSession(id, { effectiveModel: `${object(state.model).provider}/${object(state.model).id}`, modelSource: "Pi get_state", effectiveEffort: typeof state.thinkingLevel === "string" ? state.thinkingLevel : undefined, effortSource: "Pi get_state" });
      if (args.evaluation) sink.evaluationInventory?.({version: 1, nativeSessionId: id, clientMessageId: args.clientMessageId,
        activeTools: [...PI_TOOL_NAMES], registeredTools: PI_TOOL_NAMES.map(name => ({name, source: "builtin"}))});
      if (args.effort) await client.request("set_thinking_level", { level: args.effort });
      this.writeJournal(id, args.clientMessageId, entry);
      promptSent = true;
      try { await client.request("prompt", { message: args.prompt, ...(args.images?.length ? { images: args.images.map(i => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : {}) }); }
      catch (error) {
        save();
        const message = (error as Error).message;
        if (/timeout|exit|protocol/i.test(message)) throw error;
        entry.state = "rejected"; this.writeJournal(id, args.clientMessageId, entry);
        throw new DriverStageError(bounded(message, 500).text, "dispatch", id);
      }
      accepted = true; entry.state = "accepted"; this.writeJournal(id, args.clientMessageId, entry); save(); sink.status("running");
      return { done, steer: async (input) => {
        if (args.evaluation) throw new Error("受保护的验收会话不接受插话");
        if (finished || settling || interrupted) throw new Error("本轮已在结束");
        // 先登记再发：送达事件可能比 steer 的应答先到
        (entry.steers ??= []).push({ clientMessageId: input.clientMessageId, hash: inputDigest(input.prompt, input.images) });
        this.writeJournal(id, args.clientMessageId, entry);
        const reply = object(await client!.request("steer", { message: input.prompt, ...(input.images?.length ? { images: input.images.map(i => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : {}) }));
        if (reply.disposition !== undefined && reply.disposition !== "queued") throw new Error(`Pi 没有把插话排进本轮（${String(reply.disposition)}）`);
      }, interrupt: async () => {
        if (finished) return; interrupted = true; abort.abort();
        try { await client!.request("abort", {}, 5_000); } catch { /* forced stop below */ }
        // A completed abort RPC verifies native cancellation, then process-group stop prevents stale work.
        await finish({ status: "interrupted" });
      } };
    } catch (error) {
      await connection.cancel();
      let processEnded: string | undefined;
      finished = true; abort.abort(); this.active.delete(id); this.grantControl.delete(id); client?.stop(); if (client) { await client.waitForExit(); this.clients.delete(client); processEnded = "Pi RPC 进程组已退出（平台停止并等到退出）"; }
      try { await connection.dispose(); this.connections.delete(connection); rmSync(temp, { recursive: true, force: true }); } catch { /* preserve the dispatch failure and native recovery evidence */ }
      // prompt 还没发出：这一轮确定没有执行（释放名额、允许重试），不能报成结果未知
      if (!promptSent && !(error instanceof DriverStageError)) throw new DriverStageError(bounded((error as Error).message, 500).text, "spawn", undefined, true);
      // prompt 已发出但应答超时/进程退出：是否执行过仍未知，但进程已确认退出，不会再有残留执行，带上证据让宿主放名额
      if (promptSent && processEnded && !(error instanceof DriverStageError)) throw new DriverStageError(bounded((error as Error).message, 500).text, "dispatch", undefined, false, processEnded);
      throw error;
    }
  }

  /** Runtime execution decisions are opaque to the aggregation platform. */
  private async runtimeApproval(event: PiRpcEvent, sink: TurnSink, client: PiRpcClient, signal: AbortSignal): Promise<void> {
    const id=String(event.id??""), request=object(event.request);
    if (!id || !["command","file-change","permissions","tool","question"].includes(String(request.kind)) || ["title","action","scope","source"].some(key=>typeof request[key]!=="string")) { if(id)client.respondUi(id,{confirmed:false,cancelled:true}); return; }
    if(signal.aborted){client.respondUi(id,{confirmed:false,cancelled:true});return;}
    try { const decision=await sink.approval({...request,nativeRequestId:id} as unknown as DriverApproval,signal);client.forward({type:"extension_ui_response",id,confirmed:decision.approve&&!signal.aborted,cancelled:signal.aborted,reason:decision.reason,...(request.runtimeSessionScope && decision.scope === "session" ? {scope:"session"} : {})}); }
    catch { client.respondUi(id,{confirmed:false,cancelled:true}); }
  }

  private async approval(event: PiRpcEvent, sink: TurnSink, client: PiRpcClient, signal: AbortSignal, workspace: string): Promise<void> {
    const id = String(event.id ?? "");
    if (!id) return;
    const cancel = () => client.respondUi(id, event.method === "confirm" ? { confirmed: false, cancelled: true } : { cancelled: true });
    if (signal.aborted) { cancel(); return; }
    const method = String(event.method);
    // 其他扩展的对话框（select / input / editor / 普通 confirm）：交给人类回答；平台工具审批的 confirm 带 toolCallId，走下面的审批
    let params: Record<string, unknown> | undefined;
    if (method === "confirm") { try { params = object(JSON.parse(String(event.message))); } catch { params = undefined; } }
    if (method === "select" || method === "input" || method === "editor" || (method === "confirm" && !(params && "toolCallId" in params))) {
      await this.question(event, method, sink, client, signal, cancel);
      return;
    }
    if (method !== "confirm") { cancel(); return; }
    if (!params) { client.respondUi(id, { confirmed: false }); return; }
    if (!["write", "edit", "bash"].includes(String(params.toolName)) || typeof params.toolCallId !== "string") { client.respondUi(id, { confirmed: false }); return; }
    const req: DriverApproval = { nativeRequestId: id, kind: params.toolName === "bash" ? "command" : "file-change", title: `Pi · ${params.toolName}`, action: bounded(stringifyInput(params.input), LIMITS.toolInput).text, scope: workspace, source: "Pi 平台工具审批扩展", params };
    sink.status("waiting-input");
    try { const decision = await sink.approval(req, signal); client.respondUi(id, { confirmed: decision.approve && !signal.aborted, cancelled: signal.aborted }); }
    catch { client.respondUi(id, { confirmed: false, cancelled: true }); }
    if (!signal.aborted) sink.status("running");
  }

  /** Pi 扩展的 select / input / editor / confirm 对话框 → 平台选项面板；跳过或超时 = cancelled */
  private async question(event: PiRpcEvent, method: string, sink: TurnSink, client: PiRpcClient, signal: AbortSignal, cancel: () => void): Promise<void> {
    const id = String(event.id);
    const title = typeof event.title === "string" ? event.title : "";
    const message = typeof event.message === "string" ? event.message : "";
    const text = method === "confirm" ? [title, message].filter(Boolean).join("\n") || "请确认" : title || "Pi 想问你";
    const options = method === "select" ? event.options : method === "confirm" ? [{ label: "确认" }, { label: "取消" }] : [];
    const item = questionItem({ id: "answer", question: text, header: method === "select" ? "请选择" : method === "confirm" ? "请确认" : "请输入", options,
      placeholder: event.placeholder, prefill: event.prefill, multiline: method === "editor" });
    if (!item) { cancel(); return; }
    // 扩展自己设了超时：它到点就当取消，平台这边的等待跟着失效
    const timeout = typeof event.timeout === "number" && event.timeout > 0 ? event.timeout : undefined;
    const wait = timeout ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : signal;
    const questions = [item];
    sink.status("waiting-input");
    try {
      const decision = await sink.approval({
        nativeRequestId: id, kind: "question", title: "Pi 扩展想问你", questions, action: questionsText(questions), scope: "回答后 Pi 会继续",
        source: "Pi 扩展 · extension_ui", params: { method, title, message, options: item.options, prompt: item.question }
      }, wait);
      const answer = decision.answers?.[item.id]?.[0];
      if (signal.aborted || wait.aborted) return;
      if (!decision.approve || answer === undefined) cancel();
      else if (method === "confirm") client.respondUi(id, { confirmed: answer === "确认" });
      else client.respondUi(id, { value: answer });
    } catch { cancel(); }
    if (!signal.aborted) sink.status("running");
  }

  async listHistory(opts: { roots: string[]; limit: number }) { return listPiSessions([this.sessionDir, join(this.source, "sessions")], opts.roots, opts.limit); }
  async readHistory(id: string, opts: { workspace?: string }): Promise<HistoryRead> {
    const read = this.locate(id, opts.workspace); if (!read) throw new Error("Pi native session not found");
    const entries = Object.entries(this.journal(id));
    const journal = entries.at(-1)?.[1];
    const status = journal?.state === "settled" && journal.fingerprint === read.fingerprint ? journal.result?.status : undefined;
    const userKeys = new Map<string, string>();
    for (const [clientId, entry] of entries) {
      const message = read.userMessages[entry.baseUsers];
      if (message && (message.inputHash ?? digest(message.text)) === entry.hash) userKeys.set(message.id, `user:${clientId}`);
      for (const steer of entry.steers ?? []) {
        const delivered = steer.index === undefined ? undefined : read.userMessages[steer.index];
        if (delivered && (delivered.inputHash ?? digest(delivered.text)) === steer.hash) userKeys.set(delivered.id, `user:${steer.clientMessageId}`);
      }
    }
    return {
      events: read.events.map((event) => event.role === "user" && event.nativeItemId && userKeys.has(event.nativeItemId) ? { ...event, key: userKeys.get(event.nativeItemId)! } : event),
      usage: read.usage, coverage: read.coverage, notes: read.notes, fingerprint: read.fingerprint, title: read.title, titleKind: read.titleKind, model: read.model, workspace: read.workspace,
      status: status === "cancelled" ? "interrupted" : status === "queued" ? "unknown" : status ?? "unknown"
    };
  }
  nativeSessionPath(id: string, workspace: string): string | undefined { return this.locate(id, workspace)?.file; }
  async fingerprint(id: string, opts: { workspace?: string }) {
    const read = this.locate(id, opts.workspace); if (!read) return;
    const latest = Object.entries(this.journal(id)).at(-1), entry = latest?.[1];
    const verified = entry?.state === "settled" && entry.fingerprint === read.fingerprint;
    return { value: read.fingerprint!, active: this.active.has(id), lastTurnStatus: verified ? entry.result?.status : undefined, lastClientMessageId: verified ? latest?.[0] : undefined, terminalObserved: verified && entry.result?.terminalObserved === true };
  }
  async findClientMessage(id: string, clientMessageId: string, opts: { workspace?: string }): Promise<boolean | undefined> {
    const entry = this.journal(id)[clientMessageId], read = this.locate(id, opts.workspace);
    if (!entry || !read || read.coverage !== "complete") return;
    const message = read.userMessages[entry.baseUsers];
    if (message) return (message.inputHash ?? digest(message.text)) === entry.hash ? true : undefined;
    return entry.state === "rejected" ? false : undefined;
  }
  async rateLimits() { return undefined; }
  shutdown(): void { this.closing = true; for (const connection of this.connections) void connection.cancel(); for (const client of this.clients) client.stop(); this.clients.clear(); }
}
