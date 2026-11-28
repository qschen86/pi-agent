import {codexBrowserConfig,verifyCodexBrowserHook} from "./codex-browser-config.js";
export { CodexRealmRegistry } from "./codex-realms.js";
import {CodexRealmRegistry, type CodexRealm} from "./codex-realms.js";
import {bootstrapCodexStock, verifyCodexStock} from "./codex-stock.js";
import {prepareCodexEvaluationBoundary} from "./codex-boundary.js";
import {createHash, randomUUID} from "node:crypto";
import { normalizeEvaluation } from "./evaluation.js";
import { codexPermissions, permissionOptions } from "./permissions.js";
import { elicitationForm, userInputQuestions, userInputResponse, type ElicitationForm } from "./codex-questions.js";
import { questionsText } from "./questions.js";
import type { QuestionItem } from "./types.js";
/**
 * Codex 驱动（F02）：平台自己的 app-server 进程，thread / turn 原生 ID，通知流投影，审批转交。
 *
 * 生命周期方案 A：app-server 是 Web 进程的子进程；Web 重启即中断活动 turn，重启后按原生记录核对。
 * 一个 profile 共用一个 app-server；停止只发 turn/interrupt，不杀共享进程里的其他会话（F08）。
 */
import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { allowlistedEnv, CodexAppServerClient, RpcError } from "./codex-client.js";
import type { CodexClientOptions, NotificationMsg, ServerRequestMsg } from "./codex-client.js";
import { cap, DriverStageError, iso } from "./driver.js";
import type { DriverApproval, DriverEvent, HistoryItem, HistoryRead, ProbeOutcome, RuntimeDriver, StartTurnArgs, TurnHandle, TurnResult, TurnSink } from "./driver.js";
import { bounded, LIMITS, maskEmail, stringifyInput } from "./redact.js";
import type { Capability, CapabilityName, SessionStatus, TurnStatus, UsageRecord } from "./types.js";

const run = promisify(execFile);
export const CODEX_PARSER = "codex-app-server@1";

/** 默认权限：workspace-write 沙箱 + on-request 审批；创建时可选会话级权限 */
export const CODEX_PERMISSIONS = { sandbox: "workspace-write", approvalPolicy: "on-request" } as const;

export const CODEX_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  join(homedir(), ".local/bin/codex"),
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex"
];

/** 兼容检查：所选版本自己生成的协议里必须有这些方法（不按版本号猜） */
const REQUIRED_METHODS: Record<CapabilityName, string[]> = {
  imageInput: ["turn/start"],
  create: ["thread/start", "turn/start"],
  read: ["thread/list", "thread/read", "thread/items/list", "thread/turns/list"],
  stream: ["turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta"],
  resume: ["thread/resume"],
  interrupt: ["turn/interrupt"],
  approval: ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"],
  usage: ["thread/tokenUsage/updated"],
  rateLimits: ["account/rateLimits/read"],
  // V3.0：不是方法而是 thread/start、thread/resume 的参数；同样按该版本自己的协议描述核对
  roleInstructions: ["developerInstructions"]
};

/** Protocol scope only; complete process/tool protection requires separate native qualification. */
function evaluatorThreadConfig(reportDir: string): Record<string, unknown> {
  return { "project_doc_max_bytes": 0, "features.hooks": false, "features.memories": false,
    "sandbox_workspace_write.network_access": true, "sandbox_workspace_write.exclude_slash_tmp": true,
    "sandbox_workspace_write.exclude_tmpdir_env_var": true, "sandbox_workspace_write.writable_roots": [reportDir] };
}
function verifyEvaluatorThread(response: unknown, reportDir: string, threadId: string, expectedModel?: string): void {
  const r = response as Record<string, unknown>, sandbox = r?.["sandbox"] as Record<string, unknown> | undefined;
  if (expectedModel !== undefined && r?.["model"] !== expectedModel) throw new DriverStageError("Codex evaluation effective model differs from the confirmed selection", "create", threadId, true);
  // workspaceWrite implicitly includes cwd even when writableRoots is empty.
  const onlyReport = (roots: unknown) => Array.isArray(roots) && roots.length <= 1 && roots.every(root => root === reportDir);
  if (r?.["cwd"] !== reportDir || r["approvalPolicy"] !== "on-request" || r["approvalsReviewer"] !== "user" ||
      sandbox?.["type"] !== "workspaceWrite" || !onlyReport(sandbox["writableRoots"]) || sandbox["networkAccess"] !== true ||
      sandbox["excludeSlashTmp"] !== true || sandbox["excludeTmpdirEnvVar"] !== true || !onlyReport(r["runtimeWorkspaceRoots"]) ||
      !Array.isArray(r["instructionSources"]) || r["instructionSources"].length !== 0) {
    throw new DriverStageError("Codex evaluation effective sandbox or context differs from the requested protected policy", "create", threadId, true);
  }
}

/** turn/start 与 turn/steer 共用的输入：文字 + data URL 图片 */
function codexInput(prompt: string, images?: Array<{ mimeType: string; data: string }>) {
  return [...(prompt ? [{ type: "text", text: prompt, text_elements: [] }] : []), ...(images ?? []).map(i => ({ type: "image", url: `data:${i.mimeType};base64,${i.data}` }))];
}

interface ActiveTurn {
  client: CodexAppServerClient;
  threadId: string;
  turnId?: string;
  sink: TurnSink;
  finish: (r: TurnResult) => void;
  deltas: Map<string, string>;
  items: Map<string, Record<string, unknown>>;
  approvals: Map<string, AbortController>;
  /** 已被 turn/steer 收下、还没在本轮出现的插话（clientUserMessageId） */
  steers: Set<string>;
  /** 截至本轮已观察到的 tokenUsage 更新次数（= 模型请求数） */
  requestCount: number;
}

export interface CodexDriverOptions {
  binaryPath?: string;
  /** 测试替身：给定参数启动的客户端 */
  clientFactory?: (binaryPath: string, options?: CodexClientOptions) => CodexAppServerClient;
  /** Persistent host registry and private native state; outside all job inputs/workspaces. */
  evaluationRoot?: string;
  codexHome?: string;
  /** Authorized original login linked read-only into protected private realms; false disables. Test doubles get none by default. */
  nativeAuthFile?: string | false;
  /** 测试：替换默认的候选位置 */
  candidates?: string[];
}

export class CodexDriver implements RuntimeDriver {
  readonly kind = "codex" as const;
  private client?: CodexAppServerClient;
  private starting?: Promise<CodexAppServerClient>;
  private startingClient?: CodexAppServerClient;
  private disposed = false;
  private active = new Map<string, ActiveTurn>();
  private creating = new Set<string>();
  private binary?: string;
  /** 当前常驻 app-server 启动时的二进制指纹 */
  private clientStamp?: string;
  private readonly codexHome: string;
  private realms?: CodexRealmRegistry;
  private privateClients = new Map<string, CodexAppServerClient>();
  private privateStarting = new Map<string, Promise<CodexAppServerClient>>();
  private privateStartingClients = new Set<CodexAppServerClient>();

  constructor(private readonly opts: CodexDriverOptions = {}) {
    this.codexHome = opts.codexHome ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  }

  nativeAuthFile(): string | undefined {
    if (this.opts.nativeAuthFile === false || (this.opts.nativeAuthFile === undefined && this.opts.clientFactory)) return undefined;
    return this.opts.nativeAuthFile ?? join(this.opts.codexHome ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json");
  }

  resolveBinary(fresh = false): string | undefined {
    if (fresh) this.binary = undefined;
    if (this.binary) return this.binary;
    // 明确指定了路径：只用它，找不到就报未安装，不悄悄换成别的 codex
    const pinned = this.opts.binaryPath ?? process.env["PI_AGENT_CODEX_BIN"];
    const list = pinned ? [pinned] : [...(this.opts.candidates ?? CODEX_CANDIDATES), ...(process.env["PATH"] ?? "").split(":").map((d) => join(d, "codex"))];
    for (const p of list) {
      if (!p || !existsSync(p)) continue;
      try { this.binary = realpathSync(p); return this.binary; } catch { /* 下一个 */ }
    }
    return undefined;
  }

  /** 可执行文件的路径 + 修改时间：ChatGPT.app 升级会原地替换它，据此发现版本变化 */
  binaryStamp(): { path: string; mtimeMs: number } | undefined {
    const bin = this.resolveBinary(true);
    if (!bin) return undefined;
    try { return { path: bin, mtimeMs: statSync(bin).mtimeMs }; } catch { return undefined; }
  }

  /** 常驻 app-server 是按旧二进制启动的：升级后空闲时让它退出，探测与新会话才会用新版本（有进行中的回合就不动它） */
  private retireStaleClient(): void {
    const c = this.client;
    if (!c?.alive || this.clientStamp === undefined) return;
    const now = this.binaryStamp();
    if (!now || `${now.path}|${now.mtimeMs}` === this.clientStamp) return;
    if (this.active.size > 0 || this.creating.size > 0 || this.starting) return;
    this.client = undefined;
    c.stop();
  }

  private async ensureClient(): Promise<CodexAppServerClient> {
    if (this.disposed) throw new DriverStageError("Codex driver is shut down", "spawn");
    if (this.client?.alive) return this.client;
    if (this.starting) return this.starting;
    const bin = this.resolveBinary();
    if (!bin) throw new DriverStageError("找不到 Codex CLI（可用 PI_AGENT_CODEX_BIN 指定绝对路径）", "spawn");
    const stampBefore = this.binaryStamp();
    this.starting = (async () => {
      const c = this.opts.clientFactory ? this.opts.clientFactory(bin) : new CodexAppServerClient({ binaryPath: bin, env: allowlistedEnv() });
      this.startingClient = c;
      this.attachClient(c);
      try { await c.start(); } catch (e) { c.stop(); throw new DriverStageError(`Codex app-server 启动失败：${(e as Error).message}`, "spawn"); }
      if (this.disposed) { c.stop(); throw new DriverStageError("Codex driver is shut down", "spawn"); }
      this.client = c;
      this.clientStamp = stampBefore ? `${stampBefore.path}|${stampBefore.mtimeMs}` : undefined;
      return c;
    })();
    try { return await this.starting; } finally { this.starting = undefined; this.startingClient = undefined; }
  }

  private attachClient(c: CodexAppServerClient): void {
    c.on("notification", (m: NotificationMsg) => this.onNotification(c, m));
    c.on("request", (m: ServerRequestMsg) => void this.onServerRequest(c, m));
    c.on("exit", (info: {code: number | null; stderrTail: string}) => {
      if (this.client === c) this.client = undefined;
      for (const a of this.active.values()) if (a.client === c) a.finish({status: "interrupted", processEnded: `Codex app-server 进程已退出（${info.code ?? "信号"}）`, reason: `Codex app-server 退出（${info.code ?? "信号"}）${info.stderrTail ? `：${info.stderrTail.slice(-300)}` : ""}`});
    });
  }

  private realmRegistry(): CodexRealmRegistry {
    if (!this.opts.evaluationRoot) throw new DriverStageError("Codex evaluation requires a persistent private realm root", "create", undefined, true);
    return this.realms ??= new CodexRealmRegistry(this.opts.evaluationRoot);
  }
  private knownRealm(id: string): CodexRealm | undefined {
    if (!this.realms && (!this.opts.evaluationRoot || !existsSync(this.opts.evaluationRoot))) return undefined;
    return this.realmRegistry().byNative(id);
  }
  private privateSourceHash(): string {
    const bin = this.resolveBinary();
    if (!bin) throw new DriverStageError("Codex binary missing", "spawn");
    const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const h = createHash("sha256").update("codex-private-anonymous@1");
    for (const file of [bin, new URL(import.meta.url), new URL(`./codex-boundary${ext}`, import.meta.url), new URL(`./codex-realms${ext}`, import.meta.url), new URL(`./codex-stock${ext}`, import.meta.url)]) h.update(readFileSync(file));
    return "sha256:" + h.digest("hex");
  }
  private async ensurePrivateClient(realm: CodexRealm, fresh = false): Promise<CodexAppServerClient> {
    if (this.disposed) throw new DriverStageError("Codex driver is shut down", "spawn");
    if (realm.spec.sourceHash !== this.privateSourceHash()) throw new DriverStageError("Codex private realm source changed; reconcile original state", "create", realm.nativeSessionId, true);
    const registry = this.realmRegistry();
    const stock = registry.stock(realm);
    if (stock) verifyCodexStock(realm.codexHome, stock);
    else if (!fresh) throw new DriverStageError("Codex trusted stock authority missing; preserve original realm", "create", realm.nativeSessionId, true);
    const existing = this.privateClients.get(realm.realmId);
    if (existing?.alive) return existing;
    const pending = this.privateStarting.get(realm.realmId); if (pending) return pending;
    const starting = (async () => {
      if (!stock) {
        const bootstrapClients: CodexAppServerClient[] = [];
        try {
          const manifest = await bootstrapCodexStock(realm.runtimeRoot, this.resolveBinary()!, options => {
            if (this.disposed) throw new DriverStageError("Codex driver is shut down", "spawn");
            const c = this.opts.clientFactory ? this.opts.clientFactory(this.resolveBinary()!, options) : new CodexAppServerClient(options);
            bootstrapClients.push(c); this.privateStartingClients.add(c); return c;
          });
          registry.recordStock(realm, manifest);
        } finally { for (const c of bootstrapClients) this.privateStartingClients.delete(c); }
      }
      if (realm.spec.sourceHash !== this.privateSourceHash()) throw new Error("Codex bootstrap source changed; original realm held");
      const verified = registry.stock(realm);
      if (!verified) throw new Error("Codex stock bootstrap authority missing");
      verifyCodexStock(realm.codexHome, verified);
      const boundary = await prepareCodexEvaluationBoundary({workspace: realm.spec.workspace, evaluation: realm.spec.evaluation, runtimeRoot: realm.runtimeRoot, guardDir: join(this.realmRegistry().root, "guards", randomUUID()), ...(this.nativeAuthFile() ? {nativeAuthFile: this.nativeAuthFile()} : {})});
      let c: CodexAppServerClient | undefined;
      try {
        if (this.disposed) throw new DriverStageError("Codex driver is shut down", "spawn");
        const bin = this.resolveBinary()!;
        const options: CodexClientOptions = {binaryPath: boundary.command, args: [...boundary.prefix, bin, ...boundary.args], cwd: boundary.cwd, env: boundary.env};
        c = this.opts.clientFactory ? this.opts.clientFactory(bin, options) : new CodexAppServerClient(options);
        this.privateStartingClients.add(c); this.attachClient(c);
        const owner = c;
        c.once("exit", () => { if (this.privateClients.get(realm.realmId) === owner) this.privateClients.delete(realm.realmId); void boundary.dispose(); });
        await c.start();
        if (this.disposed) throw new DriverStageError("Codex driver is shut down", "spawn");
        this.privateClients.set(realm.realmId, c); return c;
      } catch (error) { if (c) c.stop(); else await boundary.dispose(); throw error; }
      finally {if (c) this.privateStartingClients.delete(c);}
    })();
    this.privateStarting.set(realm.realmId, starting);
    try { return await starting; } finally { if (this.privateStarting.get(realm.realmId) === starting) this.privateStarting.delete(realm.realmId); }
  }
  private async clientForNative(id: string): Promise<CodexAppServerClient> {
    const realm = this.knownRealm(id);
    return realm ? this.ensurePrivateClient(realm) : this.ensureClient();
  }

  /* ------------------------------ 探测 ------------------------------ */

  async probe(): Promise<ProbeOutcome> {
    const permissions = { label: "workspace-write / on-request", detail: "Codex 沙箱只允许写工作目录；越界或联网等需要审批的动作经 on-request 转到 pi-agent 审批。" };
    const empty = Object.fromEntries(Object.keys(REQUIRED_METHODS).map((k) => [k, cap("unknown", "未探测")])) as Record<CapabilityName, Capability>;
    this.retireStaleClient();
    const bin = this.resolveBinary(true);
    if (!bin) {
      const pinned = this.opts.binaryPath ?? process.env["PI_AGENT_CODEX_BIN"];
      return { state: "not-installed", stateReason: pinned ? `指定的 codex 不存在：${pinned}` : "服务进程环境里找不到 codex（已查 ChatGPT.app 内置 CLI、PATH 与常见位置）", capabilities: empty, models: [], configSummary: [], permissions };
    }
    let version = "";
    try { version = (await run(bin, ["--version"], { timeout: 10_000, env: allowlistedEnv() })).stdout.trim(); }
    catch (e) { return { state: "error", stateReason: `codex --version 失败：${(e as Error).message}`, binaryPath: bin, capabilities: empty, models: [], configSummary: [], permissions }; }
    const capabilities = await this.schemaCapabilities(bin, version);
    let client: CodexAppServerClient;
    try { client = await this.ensureClient(); }
    catch (e) { return { state: "error", stateReason: (e as Error).message, binaryPath: bin, binaryVersion: version, capabilities, models: [], configSummary: [], permissions }; }
    const account = await client.request("account/read", { refreshToken: false }).catch((e: Error) => ({ error: e.message })) as Record<string, unknown>;
    const acc = account["account"] as { type?: string; email?: string | null; planType?: string } | null | undefined;
    const routing = account["workspaceRouting"] as { chatgptAccountId?: string } | undefined;
    type RawModel = { id: string; displayName?: string; isDefault?: boolean; hidden?: boolean; supportedReasoningEfforts?: Array<{ reasoningEffort: string }>; defaultReasoningEffort?: string | null; inputModalities?: string[] };
    const models = await client.request("model/list", { limit: 50 }).then((r) => ((r as { data?: RawModel[] }).data ?? [])
      .filter((m) => !m.hidden).map((m) => {
        const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter(Boolean);
        return { inputModalities: m.inputModalities, id: m.id, label: m.displayName ?? m.id, ...(m.isDefault ? { isDefault: true } : {}), ...(efforts.length ? { efforts } : {}), ...(m.defaultReasoningEffort ? { defaultEffort: m.defaultReasoningEffort } : {}) };
      })).catch(() => []);
    const config = await client.request("config/read", { includeLayers: false }).catch(() => null) as { config?: Record<string, unknown> } | null;
    const cfg = config?.config ?? {};
    const mcp = cfg["mcp_servers"] && typeof cfg["mcp_servers"] === "object" ? Object.keys(cfg["mcp_servers"] as object) : [];
    const configSummary = [
      `CLI ${version}（${bin}）`,
      `配置默认：模型 ${String(cfg["model"] ?? "未设")}，审批 ${String(cfg["approval_policy"] ?? "未设")}，沙箱 ${String(cfg["sandbox_mode"] ?? "未设")}——平台会话按创建时选择的权限模式覆盖`,
      mcp.length ? `MCP 服务（来自 Codex 配置，会随会话加载）：${mcp.join("、")}` : "未配置 MCP 服务",
      "hooks、skills、AGENTS.md 按 Codex 原生规则从工作目录与 ~/.codex 加载"
    ];
    const rateLimit = await this.rateLimits().catch(() => undefined);
    let identity: ProbeOutcome["identity"];
    if (acc && acc.type) {
      const stable = acc.type === "chatgpt" ? (routing?.chatgptAccountId ?? (rateLimit as { accountId?: string } | undefined)?.accountId) : undefined;
      identity = {
        ...(stable ? { stableAccountId: stable } : {}),
        authMode: acc.type,
        summary: acc.type === "chatgpt" ? `ChatGPT 登录 · ${maskEmail(acc.email)} · ${acc.planType ?? "计划未知"}` : acc.type === "apiKey" ? "API Key（按 API 计费）" : acc.type,
        source: "codex account/read",
        fingerprint: `${acc.type}|${acc.email ?? ""}|${acc.planType ?? ""}`
      };
    }
    const missing = (["create", "stream", "resume", "interrupt", "approval"] as CapabilityName[]).filter((k) => capabilities[k].status !== "supported");
    const state = !acc ? "needs-login" : missing.length ? "incompatible" : "executable";
    const stateReason = !acc ? (account["error"] ? `账号读取失败：${String(account["error"])}` : "Codex 未登录：请在本机运行 codex login 或打开 Codex 登录")
      : missing.length ? `所选版本缺少必需能力：${missing.join("、")}` : "协议已核对，登录有效，可创建会话";
    return { state, stateReason, binaryPath: bin, binaryVersion: version, capabilities, models, ...(identity ? { identity } : {}), configSummary, permissions, permissionOptions: permissionOptions("codex").filter((p) => p.id !== "auto-review" || this.supportsAutoReview), ...(rateLimit ? { rateLimit } : {}) };
  }

  /** 用该版本自己生成的 JSON Schema 核对方法是否存在 */
  private supportsAutoReview = false;

  private async schemaCapabilities(bin: string, version: string): Promise<Record<CapabilityName, Capability>> {
    const dir = mkdtempSync(join(tmpdir(), "pi-codex-schema-"));
    try {
      await run(bin, ["app-server", "generate-json-schema", "--experimental", "--out", dir], { timeout: 30_000, env: allowlistedEnv() });
      const text = ["ClientRequest.json", "ServerNotification.json", "ServerRequest.json"].map((f) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "").join("\n");
      const paramsPath = join(dir, "v2", "ThreadStartParams.json");
      const params = existsSync(paramsPath) ? readFileSync(paramsPath, "utf8") : "";
      this.supportsAutoReview = params.includes('"approvalsReviewer"') && params.includes('"auto_review"');
      const has = (m: string) => text.includes(`"${m}"`);
      const caps = Object.fromEntries(Object.entries(REQUIRED_METHODS).map(([k, methods]) => {
        const miss = methods.filter((m) => !has(m));
        return [k, miss.length ? cap("unsupported", `协议缺少 ${miss.join("、")}`, version) : cap("supported", `协议含 ${methods.join("、")}`, version)];
      })) as Record<CapabilityName, Capability>;
      const turn = join(dir, "v2", "TurnStartParams.json");
      caps.imageInput = existsSync(turn) && /"ImageUserInputType"/.test(readFileSync(turn, "utf8")) ? cap("supported", "turn/start 原生 image 输入已接入", version) : cap("unknown", "未确认原生 image 输入", version);
      return caps;
    } catch (e) {
      this.supportsAutoReview = false;
      return Object.fromEntries(Object.keys(REQUIRED_METHODS).map((k) => [k, cap("unknown", `无法生成协议描述：${(e as Error).message}`, version)])) as Record<CapabilityName, Capability>;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  async rateLimits(): Promise<ProbeOutcome["rateLimit"]> {
    return this.rateLimitsFrom(await this.ensureClient());
  }

  private async rateLimitsFrom(client: CodexAppServerClient): Promise<ProbeOutcome["rateLimit"]> {
    const r = await client.request("account/rateLimits/read", undefined) as {
      rateLimits?: { primary?: Window; secondary?: Window; planType?: string } | null; accountId?: string | null; ordinaryUsageAllowed?: boolean | null;
    };
    type Window = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
    const rl = r.rateLimits;
    const win = (w: Window | undefined, fallback: string) => w ? [{
      label: w.windowDurationMins === 300 ? "5 小时窗口" : w.windowDurationMins === 10080 ? "周窗口" : w.windowDurationMins ? `${w.windowDurationMins} 分钟窗口` : fallback,
      usedPercent: w.usedPercent, resetsAt: iso(w.resetsAt ? w.resetsAt * 1000 : null) ?? null, windowMinutes: w.windowDurationMins
    }] : [];
    const windows = rl ? [...win(rl.primary, "主窗口"), ...win(rl.secondary, "次窗口")] : [];
    const out = {
      windows, ...(rl?.planType ? { plan: rl.planType } : {}),
      source: "codex account/rateLimits/read", sampledAt: new Date().toISOString(),
      available: windows.length > 0, ...(windows.length ? {} : { reason: "runtime 未返回账户额度窗口" })
    };
    return Object.assign(out, r.accountId ? { accountId: r.accountId } : {});
  }

  /* ------------------------------ 执行 ------------------------------ */

  async startTurn(args: StartTurnArgs, sink: TurnSink): Promise<TurnHandle> {
    const id = args.nativeSessionId;
    // Reserve before the first await: concurrent resumes cannot replace an operation's owner.
    if (id && (this.active.has(id) || this.creating.has(id))) throw new DriverStageError("Codex thread already has an active or starting turn", "create", id, true);
    if (id) this.creating.add(id);
    try { return await this.startOwnedTurn(args, sink); }
    finally { if (id) this.creating.delete(id); }
  }

  private async startOwnedTurn(args: StartTurnArgs, sink: TurnSink): Promise<TurnHandle> {
    let evaluation: ReturnType<typeof normalizeEvaluation> | undefined;
    if (args.evaluation) {
      try {
        if (args.permissionMode && args.permissionMode !== "ask") throw new Error("Evaluator requires ask mode; full access and automatic reviewer are forbidden");
        evaluation = normalizeEvaluation(args.workspace, args.evaluation);
        mkdirSync(evaluation.reportDir, { recursive: true, mode: 0o700 });
      } catch (error) { throw new DriverStageError((error as Error).message, "create"); }
    }
    const cwd = evaluation?.reportDir ?? args.workspace;
    let realm: CodexRealm | undefined;
    let client: CodexAppServerClient;
    try {
      if (evaluation) {
        if (!args.platformSessionId) throw new Error("Codex evaluator requires a host-owned platform session ID");
        const spec = {workspace: args.workspace, evaluation, sourceHash: this.privateSourceHash()};
        const registry = this.realmRegistry();
        if (args.nativeSessionId) realm = registry.resume(args.platformSessionId, spec, args.nativeSessionId);
        else {
          try {realm = registry.reserve(args.platformSessionId, spec);}
          catch (error) {if ((error as {code?:string}).code !== "RT_CODEX_REALM_PENDING") throw error; realm = registry.continueUnexecuted(args.platformSessionId, spec);}
        }
        client = await this.ensurePrivateClient(realm, !args.nativeSessionId);
        // Model dispatch requires a verified native login (the authorized original login, linked read-only).
        const account = await client.request("account/read", {refreshToken: false}) as {account?: {type?: string} | null};
        if (!account.account || !["chatgpt", "apiKey"].includes(account.account.type ?? "")) throw new Error("Codex private realm has no verified native login; model input withheld");
      } else {
        if (args.nativeSessionId && this.knownRealm(args.nativeSessionId)) throw new Error("Private Codex session requires its original evaluation boundary and host task identity");
        client = await this.ensureClient();
      }
    } catch (error) {
      // This entire block precedes thread/start. Stock-backed failures can retry the exact intent.
      // If publishing proof fails, retain preparing/unknown state and hold; never infer readiness.
      if (realm && !args.nativeSessionId) {try {this.realmRegistry().markUnexecuted(realm);} catch { /* Preserve authority for reconciliation. */ }}
      throw new DriverStageError((error as Error).message, "create", args.nativeSessionId, true);
    }
    const permissions = codexPermissions(args.permissionMode);
    let browserConfig:Record<string,unknown>|undefined;
    try {browserConfig=args.platformBrowser?await codexBrowserConfig(client,args.platformBrowser,cwd):undefined;}
    catch(error){throw new DriverStageError(`平台截图工具资格检查失败：${(error as Error).message}`,"create",args.nativeSessionId,true);}
    if(args.capabilityGateway&&!evaluation&&!args.readOnlyRoom&&args.permissionMode!=="read-only")browserConfig={...browserConfig,'mcp_servers.capability_gateway':{command:process.execPath,args:[args.capabilityGateway.bridgePath,args.capabilityGateway.socketPath],startup_timeout_sec:15,tool_timeout_sec:900}};
    let threadId = args.nativeSessionId;
    const resumeParams = (id: string) => ({threadId: id, cwd, ...(args.model ? {model: args.model} : {}), ...permissions, excludeTurns: true,
      ...(evaluation ? {config: evaluatorThreadConfig(cwd), runtimeWorkspaceRoots: [cwd]} : browserConfig ? {config:browserConfig} : {}),
      ...(args.roleInstructions ? {developerInstructions: args.roleInstructions} : {})});
    try {
      if (!threadId) {
        if (realm) this.realmRegistry().markDispatched(realm);
        const r = await client.request("thread/start", {
          cwd, ...(args.model ? { model: args.model } : {}),
          ...permissions, serviceName: "pi-agent",
          ...(browserConfig?{config:browserConfig}:{}),
          ...(evaluation ? { ephemeral: false, historyMode: "paginated", config: evaluatorThreadConfig(cwd), runtimeWorkspaceRoots: [cwd], dynamicTools: [], selectedCapabilityRoots: [], environments: [] } : {}),
          ...(args.roleInstructions ? { developerInstructions: args.roleInstructions } : {})
        }) as { thread: { id: string; parentThreadId?: string | null }; model?: string; reasoningEffort?: string | null };
        threadId = r.thread.id;
        if (this.active.has(threadId) || this.creating.has(threadId)) throw new DriverStageError("Codex returned a thread already owned by another operation", "create", undefined, true);
        if (realm) {
          try { realm = this.realmRegistry().bind(realm, threadId); }
          catch (error) { throw new DriverStageError(`Private Codex native binding held: ${(error as Error).message}`, "create", undefined, true); }
        }
        sink.nativeSession(threadId, { ...(r.model ? { effectiveModel: r.model } : {}), modelSource: "thread/start 响应", ...(!args.effort && r.reasoningEffort ? { effectiveEffort: r.reasoningEffort, effortSource: "thread/start 响应" } : {}) });
        if (evaluation) {
          verifyEvaluatorThread(r, cwd, threadId, args.model);
          // The native archive cycle materializes an empty rollout without synthetic history/input.
          // Authority already owns the original ID; a failed checkpoint must never create a replacement.
          try {
            await client.request("thread/archive", {threadId});
            const restored = await client.request("thread/unarchive", {threadId}) as {thread: {id: string}};
            if (restored.thread.id !== threadId) throw new Error("Native checkpoint restored another thread");
            if (typeof r.model !== "string" || !r.model.trim()) throw new Error("Native checkpoint has no original effective model");
            // An omitted resume model selects the current default, which can change the tool inventory.
            const loaded = await client.request("thread/resume", {...resumeParams(threadId), model: r.model}) as {thread: {id: string}; model?: string};
            if (loaded.thread.id !== threadId) throw new Error("Native checkpoint resumed another thread");
            verifyEvaluatorThread(loaded, cwd, threadId, r.model);
          } catch (error) {throw new DriverStageError(`Codex native empty-thread checkpoint held: ${(error as Error).message}`, "create", threadId, true);}
        }
      } else {
        const r = await client.request("thread/resume", resumeParams(threadId)) as { thread: { id: string }; model?: string; reasoningEffort?: string | null };
        if (r.thread.id !== threadId) throw new Error(`thread/resume 返回了另一个 thread（${r.thread.id}），不静默改绑`);
        sink.nativeSession(threadId, { ...(r.model ? { effectiveModel: r.model } : {}), modelSource: "thread/resume 响应", ...(!args.effort && r.reasoningEffort ? { effectiveEffort: r.reasoningEffort, effortSource: "thread/resume 响应" } : {}) });
        if (evaluation) verifyEvaluatorThread(r, cwd, threadId, args.model);
      }
    } catch (e) {
      if (e instanceof DriverStageError) {
        if (evaluation && threadId && !this.active.has(threadId)) await client.request("thread/unsubscribe", { threadId }, 10_000).catch(() => {});
        throw e;
      }
      throw new DriverStageError(`${args.nativeSessionId ? "恢复" : "创建"} Codex thread 失败：${(e as Error).message}`, "create", threadId);
    }
    if(args.platformBrowser)try{await verifyCodexBrowserHook(client,threadId,args.platformBrowser);}
    catch(error){await client.request("thread/unsubscribe",{threadId},10000).catch(()=>{});throw new DriverStageError((error as Error).message,"create",threadId,true);}
    let finish!: (r: TurnResult) => void;
    const done = new Promise<TurnResult>((res) => { finish = res; });
    let settled = false;
    // 续聊已有会话时，若持久化里还没有请求数（旧数据），从 rollout 的 token_count 事件补一个基数
    const priorRequestCount = args.priorRequestCount ?? (args.nativeSessionId ? await this.rolloutRequestCount(client, threadId) : 0);
    const active: ActiveTurn = { client, threadId, sink, deltas: new Map(), items: new Map(), approvals: new Map(), steers: new Set(), requestCount: priorRequestCount ?? 0, finish: (r) => {
      if (settled) return;
      settled = true;
      if (this.active.get(threadId!) === active) this.active.delete(threadId!);
      for (const [, ac] of active.approvals) ac.abort();
      if (client.alive) void (async () => {
        // 本轮结束时读回 thread 的生效模型与推理强度（turn/start 之后立刻读可能还没生效）
        const t = await client.request("thread/read", { threadId: threadId! }, 10_000).catch(() => null) as { thread?: { reasoningEffort?: string | null; model?: string | null; name?: string | null } } | null;
        if (t?.thread?.reasoningEffort) sink.nativeSession(threadId!, { ...(t.thread.model ? { effectiveModel: t.thread.model } : {}), modelSource: "thread/read（本轮结束时）", effectiveEffort: t.thread.reasoningEffort, effortSource: "thread/read（本轮结束时）" });
        if (t?.thread?.name) sink.nativeSession(threadId!, { title: t.thread.name, modelSource: "thread/read 标题" });
        // 再退订：Codex 对每个 thread 只允许一个写入者，平台一直挂着会挡住 CLI / Desktop 续聊（不抢占外部会话）
        await client.request("thread/unsubscribe", { threadId: threadId! }, 10_000).catch(() => {});
      })().catch(() => {});
      finish(r);
    } };
    this.active.set(threadId, active);
    try {
      const r = await client.request("turn/start", {
        threadId, clientUserMessageId: args.clientMessageId, ...(args.effort ? { effort: args.effort } : {}),
        // An empty environment list disables native file/shell tools. Pin each turn to the guarded local report root.
        ...(evaluation ? { cwd, runtimeWorkspaceRoots: [cwd], environments: [{environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd]}], approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: {
          type: "workspaceWrite", writableRoots: [evaluation.reportDir], networkAccess: true, excludeSlashTmp: true, excludeTmpdirEnvVar: true
        } } : {}),
        input: codexInput(args.prompt, args.images)
      }) as { turn: { id: string; status?: string } };
      active.turnId = r.turn.id;
      sink.nativeTurn(r.turn.id);
      sink.status("running");
      // 指定了推理强度：读回 thread 当前生效的值（runtime 的回报，不是平台的请求值）
      if (args.effort) {
        const t = await client.request("thread/read", { threadId }, 10_000).catch(() => null) as { thread?: { reasoningEffort?: string | null; model?: string | null; name?: string | null } } | null;
        if (t?.thread?.reasoningEffort) sink.nativeSession(threadId, { ...(t.thread.model ? { effectiveModel: t.thread.model } : {}), modelSource: "thread/read（本轮开始后）", effectiveEffort: t.thread.reasoningEffort, effortSource: "thread/read（本轮开始后）" });
      }
    } catch (e) {
      this.active.delete(threadId);
      throw new DriverStageError(`Codex turn/start 失败：${(e as Error).message}`, "dispatch", threadId);
    }
    return {
      done,
      // 插话：turn/steer 以 expectedTurnId 锁定这一轮；Codex 在当前工具执行完后把它作为同一轮的用户消息（带 clientId）送进去，
      // 本轮已结束时直接报错（no active turn），不会悄悄收下
      steer: async (input) => {
        if (evaluation) throw new Error("受保护的验收会话不接受插话");
        if (settled || !active.turnId) throw new Error("本轮已在结束");
        active.steers.add(input.clientMessageId);
        try {
          const r = await client.request("turn/steer", { threadId, expectedTurnId: active.turnId, clientUserMessageId: input.clientMessageId, input: codexInput(input.prompt, input.images) }, 15_000) as { turnId?: string };
          if (r.turnId !== active.turnId) throw new Error(`Codex 把插话交给了另一轮（${r.turnId ?? "未知"}）`);
        } catch (e) { active.steers.delete(input.clientMessageId); throw e; }
      },
      interrupt: async () => {
        if (!active.turnId) return;
        await client.request("turn/interrupt", { threadId, turnId: active.turnId }, 15_000);
      }
    };
  }

  private onNotification(client: CodexAppServerClient, m: NotificationMsg): void {
    const p = m.params as Record<string, unknown>;
    if (m.method === "account/rateLimits/updated") {
      // 账户级：同一身份空间共享，交给任一活动会话转给管理器
      const first = [...this.active.values()].find(a => a.client === client);
      if (first) void this.rateLimitsFrom(client).then((s) => s && first.sink.rateLimit(s)).catch(() => {});
      return;
    }
    const threadId = p["threadId"] as string | undefined;
    const a = threadId ? this.active.get(threadId) : undefined;
    if (!a || a.client !== client) return;
    const turnId = (p["turnId"] as string | undefined) ?? ((p["turn"] as { id?: string } | undefined)?.id);
    if (a.turnId && turnId && turnId !== a.turnId) return;
    switch (m.method) {
      case "thread/name/updated":
        if (typeof p["threadName"] === "string" && p["threadName"].trim()) a.sink.nativeSession(threadId!, { title: p["threadName"], modelSource: "thread/name/updated" });
        break;
      case "turn/started":
        if (!a.turnId && turnId) { a.turnId = turnId; a.sink.nativeTurn(turnId); }
        a.sink.status("running");
        break;
      case "item/started":
      case "item/completed": {
        const item = p["item"] as Record<string, unknown>;
        a.items.set(String(item["id"]), item);
        // 插话送达：本轮出现带这条 clientId 的用户消息（先通知平台出队，再写入同 key 的消息）
        const clientId = item["type"] === "userMessage" ? item["clientId"] : undefined;
        if (typeof clientId === "string" && a.steers.delete(clientId)) a.sink.steerDelivered?.(clientId);
        const at = iso((p["startedAtMs"] ?? p["completedAtMs"]) as number | undefined);
        const e = projectItem(item, turnId, { partial: m.method === "item/started", occurredAt: at, source: "stream" });
        if (e && !(m.method === "item/started" && e.kind === "message" && !e.text)) a.sink.event(e);
        break;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta": {
        const itemId = String(p["itemId"]);
        const text = (a.deltas.get(itemId) ?? "") + String(p["delta"] ?? "");
        a.deltas.set(itemId, text);
        const reasoning = m.method !== "item/agentMessage/delta";
        const b = bounded(text, LIMITS.message);
        a.sink.event({
          key: `codex:item:${itemId}`, kind: reasoning ? "reasoning" : "message", role: "assistant", text: b.text, partial: true,
          nativeItemId: itemId, ...(turnId ? { nativeTurnId: turnId } : {}), source: "stream", parserVersion: CODEX_PARSER, availability: "recorded"
        });
        break;
      }
      case "thread/tokenUsage/updated": {
        const u = p["tokenUsage"] as { total?: Record<string, number>; last?: Record<string, number>; modelContextWindow?: number } | undefined;
        if (u?.total) {
          // 每次 tokenUsage 更新对应一次模型请求；把累计次数随快照一起保存
          a.requestCount += 1;
          // last = 最近一次请求的用量，它的输入就是这次请求带上的上下文大小（只用来判断缓存冷了续跑贵不贵，不参与求和）
          const ctx = u.last?.["inputTokens"];
          const win = u.modelContextWindow;
          a.sink.usage({
            ...codexUsage(u.total, "session", "codex:thread/tokenUsage/updated", new Date().toISOString(), "complete", a.requestCount),
            ...(typeof ctx === "number" && ctx > 0 ? { contextTokens: ctx } : {}),
            ...(typeof win === "number" && win > 0 ? { contextWindow: win } : {})
          });
        }
        break;
      }
      case "thread/status/changed": {
        const st = p["status"] as { type?: string; activeFlags?: string[] } | undefined;
        if (st?.type === "active") a.sink.status(st.activeFlags?.some((f) => /approval|input/i.test(f)) ? "waiting-input" : "running");
        break;
      }
      case "serverRequest/resolved":
        // runtime 自己撤回或已处理的请求：平台那份标为失效，不再回答
        a.approvals.get(String(p["requestId"]))?.abort();
        break;
      case "thread/compacted":
        a.sink.event({ key: `codex:compact:${turnId ?? ""}:${Date.now()}`, kind: "compaction", text: "上下文已压缩", source: "stream", parserVersion: CODEX_PARSER, availability: "recorded", ...(turnId ? { nativeTurnId: turnId } : {}) });
        break;
      case "error": {
        const err = p["error"] as { message?: string } | undefined;
        a.sink.event({ key: `codex:error:${turnId ?? ""}:${Date.now()}`, kind: "error", text: `${err?.message ?? "Codex 报告错误"}${p["willRetry"] ? "（runtime 将自动重试）" : ""}`, source: "stream", parserVersion: CODEX_PARSER, availability: "recorded", ...(turnId ? { nativeTurnId: turnId } : {}) });
        break;
      }
      case "turn/completed": {
        const turn = p["turn"] as { id: string; status: string; error?: { message?: string; codexErrorInfo?: unknown } | null };
        if (a.turnId && turn.id !== a.turnId) break;
        const info = turn.error?.codexErrorInfo;
        const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
        a.finish({ status: mapTurnStatus(turn.status), terminalObserved: true, ...(turn.error?.message ? { reason: turn.error.message } : {}), ...(code ? { code } : {}) });
        break;
      }
      default: break;
    }
  }

  private async onServerRequest(client: CodexAppServerClient, m: ServerRequestMsg): Promise<void> {
    const p = m.params;
    const a = typeof p["threadId"] === "string" ? this.active.get(p["threadId"]) : undefined;
    const reply = (result: unknown) => { try { client.respond(m.id, result); } catch { /* 进程已退出 */ } };
    const refuse = (why: string) => { try { client.respondError(m.id, why); } catch { /* 进程已退出 */ } };
    if (!a || a.client !== client) { refuse("pi-agent 没有对应的活动会话，未知请求不默认允许"); return; }
    const turnId = typeof p["turnId"] === "string" && p["turnId"].length ? p["turnId"] : m.method === "mcpServer/elicitation/request" ? a.turnId : undefined;
    if (!turnId) { refuse("Codex approval has no original turn identity"); return; }
    if (a.turnId && turnId !== a.turnId) { refuse("Codex approval belongs to another turn"); return; }
    let req: DriverApproval | undefined;
    let questions: QuestionItem[] | undefined;
    let form: ElicitationForm | undefined;
    if (m.method === "item/commandExecution/requestApproval") {
      const net = p["networkApprovalContext"] ? `；联网：${stringifyInput(p["networkApprovalContext"]).slice(0, 200)}` : "";
      req = {
        nativeRequestId: String(m.id), ...(turnId ? { nativeTurnId: turnId } : {}), kind: "command", title: "运行命令",
        action: bounded(String(p["command"] ?? "（命令未提供）"), LIMITS.toolInput).text,
        scope: `目录 ${String(p["cwd"] ?? "工作目录")}${net}${p["reason"] ? `；原因：${String(p["reason"])}` : ""}`,
        source: "Codex · 当前 turn", params: { method: m.method, command: p["command"], cwd: p["cwd"], itemId: p["itemId"], approvalId: p["approvalId"] }
      };
    } else if (m.method === "item/fileChange/requestApproval") {
      const item = a.items.get(String(p["itemId"]));
      const changes = (item?.["changes"] as Array<{ path: string; kind?: { type?: string } }> | undefined) ?? [];
      req = {
        nativeRequestId: String(m.id), ...(turnId ? { nativeTurnId: turnId } : {}), kind: "file-change", title: "修改文件",
        action: changes.length ? changes.map((c) => `${c.kind?.type ?? "update"} ${c.path}`).join("\n") : "（文件列表未提供）",
        scope: `${p["grantRoot"] ? `请求本会话内允许写入 ${String(p["grantRoot"])}` : "本次修改"}${p["reason"] ? `；原因：${String(p["reason"])}` : ""}`,
        source: "Codex · 当前 turn", params: { method: m.method, itemId: p["itemId"], grantRoot: p["grantRoot"], changes: changes.map((c) => c.path) }
      };
    } else if (m.method === "item/permissions/requestApproval") {
      req = {
        nativeRequestId: String(m.id), ...(turnId ? { nativeTurnId: turnId } : {}), kind: "permissions", title: "扩大本轮权限",
        action: bounded(stringifyInput(p["permissions"]), LIMITS.toolInput).text,
        scope: `仅本轮；目录 ${String(p["cwd"] ?? "")}${p["reason"] ? `；原因：${String(p["reason"])}` : ""}`,
        source: "Codex · 当前 turn", params: { method: m.method, permissions: p["permissions"], itemId: p["itemId"] }
      };
    } else if (m.method === "item/tool/requestUserInput") {
      // Codex 计划模式的 request_user_input：选择题（可带「其他」自填）或纯文本题
      questions = userInputQuestions(p["questions"]);
      if (!questions) { refuse("pi-agent 无法展示这个提问（题目为空或格式不对）"); return; }
      req = {
        nativeRequestId: String(m.id), nativeTurnId: turnId, kind: "question", title: "Codex 想问你", questions,
        action: questionsText(questions), scope: "回答后 Codex 会按你的选择继续", source: "Codex · request_user_input",
        params: { method: m.method, itemId: p["itemId"], questions }
      };
    } else if (m.method === "mcpServer/elicitation/request") {
      // 空表单 = 纯确认（如 Computer Use 的 App 授权）；有字段的表单交给人类填写。
      // 设备验证、URL 等专用流程不能被当成空输入批准，仍拒绝。
      const schema = p["requestedSchema"] as { type?: unknown; properties?: unknown; required?: unknown } | null;
      const emptyForm = !!schema && schema.type === "object" && !!schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) &&
        !Object.keys(schema.properties).length && (schema.required === undefined || (Array.isArray(schema.required) && !schema.required.length));
      if (p["mode"] === "form" && !emptyForm && typeof p["serverName"] === "string" && typeof p["message"] === "string" && p["message"].trim()) form = elicitationForm(schema);
      if (!form && (p["mode"] !== "form" || !emptyForm || typeof p["serverName"] !== "string" || typeof p["message"] !== "string" || !p["message"].trim())) {
        refuse("pi-agent only supports confirmation-only or simple-field MCP elicitation forms");
        a.sink.event({ key: `codex:unsupported:${String(m.id)}`, kind: "notice", text: "MCP 请求需要完成专用验证或复杂表单，平台暂不支持此交互，已拒绝", source: "platform", parserVersion: CODEX_PARSER, availability: "recorded" });
        return;
      }
      const meta = p["_meta"];
      req = {
        nativeRequestId: String(m.id), nativeTurnId: turnId, kind: form ? "question" : "tool", title: form ? `MCP ${p["serverName"]} 需要你填写` : "MCP 工具授权",
        ...(form ? { questions: form.questions } : {}),
        action: form ? `${bounded(p["message"] as string, 800).text}\n${questionsText(form.questions)}` : bounded(p["message"] as string, LIMITS.toolInput).text,
        scope: `MCP ${p["serverName"]}；本次确认（未授予永久授权）${meta ? `；请求详情：${bounded(stringifyInput(meta), 600).text}` : ""}`,
        source: `Codex · MCP ${p["serverName"]}`, params: { method: m.method, ...p }
      };
    } else if (m.method === "applyPatchApproval" || m.method === "execCommandApproval") {
      reply({ decision: "denied" });
      a.sink.event({ key: `codex:legacy-approval:${String(m.id)}`, kind: "notice", text: `旧版审批请求 ${m.method} 已按拒绝处理（平台只支持 v2 审批协议）`, source: "platform", parserVersion: CODEX_PARSER, availability: "recorded" });
      return;
    } else {
      refuse(`pi-agent 暂不支持 ${m.method}`);
      a.sink.event({ key: `codex:unsupported:${String(m.id)}`, kind: "notice", text: `Codex 请求了平台尚不支持的交互（${m.method}），已拒绝而不是无限等待`, source: "platform", parserVersion: CODEX_PARSER, availability: "recorded" });
      return;
    }
    const ac = new AbortController();
    a.approvals.set(String(m.id), ac);
    a.sink.status("waiting-input");
    const decision = await a.sink.approval(req, ac.signal);
    a.approvals.delete(String(m.id));
    if (ac.signal.aborted) return;
    if (m.method === "item/tool/requestUserInput") {
      // 跳过 = 一个都没答：返回合法的空答案，而不是让整轮报错
      reply(decision.approve && decision.answers && questions ? userInputResponse(questions, decision.answers) : { answers: {} });
    } else if (m.method === "mcpServer/elicitation/request") {
      const content = decision.approve ? (form ? (decision.answers ? form.content(decision.answers) : undefined) : {}) : null;
      if (decision.approve && !content) reply({ action: "cancel", content: null, _meta: null });
      else reply({ action: decision.approve ? "accept" : "decline", content, _meta: null });
    } else if (m.method === "item/permissions/requestApproval") {
      reply(decision.approve ? { permissions: p["permissions"] ?? {}, scope: "turn" } : { permissions: {}, scope: "turn" });
    } else reply({ decision: decision.approve ? "accept" : "decline" });
    a.sink.status("running");
  }

  /* ------------------------------ 历史 ------------------------------ */

  async listHistory(opts: { roots: string[]; limit: number; originators?: string[] }): Promise<{ items: HistoryItem[]; coverage: "complete" | "partial"; notes: string[] }> {
    if (!opts.roots.length) return {items: [], coverage: "complete", notes: []};
    type Bound = {nativeSessionId: string; workspace: string; reportDir: string};
    let catalog: Bound[] = [];
    const items: HistoryItem[] = [], notes: string[] = [];
    let partial = false;
    try {
      if (this.realms || this.opts.evaluationRoot && existsSync(this.opts.evaluationRoot)) catalog = this.realmRegistry().boundSessions();
    } catch (error) {return {items: [], coverage: "partial", notes: [`Private Codex authority unavailable: ${bounded((error as Error).message, 300).text}`]};}
    const privateIds = new Set(catalog.map(r => r.nativeSessionId));
    const collect = async (client: CodexAppServerClient, realm?: Bound): Promise<void> => {
      let cursor: string | null = null, pages = 0, found = false;
      const collected: HistoryItem[] = [];
    do {
      const r = await client.request("thread/list", { limit: 100, ...(cursor ? { cursor } : {}), useStateDbOnly: true }) as {
        data: Array<{ id: string; preview: string; name: string | null; cwd: string; model: string | null; createdAt: number; updatedAt: number; parentThreadId: string | null; source: unknown; originator?: string | null; status: { type: string } }>;
        nextCursor: string | null;
      };
      for (const t of r.data) {
        if (realm) {
          if (t.id !== realm.nativeSessionId) continue;
          found = true;
          if (t.cwd !== realm.reportDir) {notes.push(`Private Codex ${realm.nativeSessionId}: native workspace differs from original realm`); partial = true; continue;}
        } else if (privateIds.has(t.id)) continue;
        if (!underRoots(t.cwd, opts.roots)) continue;
        // 创建方过滤：本地 app-server 不支持 originators 参数，在这里按原生记录的 originator 过滤；没有记录的不算匹配
        if (opts.originators?.length && !(t.originator && opts.originators.includes(t.originator))) continue;
        collected.push({
          nativeSessionId: t.id, title: (t.name || t.preview || "（无标题）").slice(0, 120), workspace: t.cwd,
          ...(t.model ? { model: t.model } : {}), createdAt: iso(t.createdAt * 1000)!, updatedAt: iso(t.updatedAt * 1000)!,
          ...(t.parentThreadId ? { parentId: t.parentThreadId } : {}),
          sourceLabel: `codex thread/list · ${typeof t.source === "string" ? t.source : "子 Agent"}${t.originator ? ` · ${t.originator}` : ""}`,
          ...(t.originator ? { originator: t.originator } : {}),
          // 平台自己的 app-server 之外的运行状态不可见：没有证据就是 unknown
          status: t.status.type === "active" ? "running" : "unknown"
        });
      }
      cursor = r.nextCursor;
      pages++;
    } while (cursor && collected.length < opts.limit && pages < 30);
    if (cursor) {partial = true; notes.push(`Codex history source reached ${pages * 100} records; earlier records not indexed`);}
    if (realm && !found) {partial = true; notes.push(`Private Codex ${realm.nativeSessionId}: original native record absent from history listing`);}
    items.push(...collected);
    };
    try {await collect(await this.ensureClient());}
    catch (error) {partial = true; notes.push(`Shared Codex history unavailable: ${bounded((error as Error).message, 300).text}`);}
    const relevant = catalog.filter(r => underRoots(r.reportDir, opts.roots));
    // Bound discovery work and report any unread sources, even if the result limit is small.
    if (relevant.length > 30) {partial = true; notes.push(`Private Codex history indexes 30 of ${relevant.length} realms per request`);}
    for (const realm of relevant.slice(-30).reverse()) {
      try {await collect(await this.clientForNative(realm.nativeSessionId), realm);}
      catch (error) {partial = true; notes.push(`Private Codex ${realm.nativeSessionId} history unavailable: ${bounded((error as Error).message, 300).text}`);}
    }
    const unique = new Map<string, HistoryItem>();
    for (const item of items) unique.set(item.nativeSessionId, item);
    const sorted = [...unique.values()].sort((x, y) => (y.updatedAt ?? "").localeCompare(x.updatedAt ?? "") || x.nativeSessionId.localeCompare(y.nativeSessionId));
    if (sorted.length > opts.limit) {partial = true; notes.push("Codex history result limit reached");}
    return {items: sorted.slice(0, opts.limit), coverage: partial ? "partial" : "complete", notes};
  }

  async readHistory(nativeSessionId: string): Promise<HistoryRead> {
    const client = await this.clientForNative(nativeSessionId);
    const t = (await client.request("thread/read", { threadId: nativeSessionId }) as { thread: { id: string; name: string | null; preview: string; cwd: string; model: string | null; updatedAt: number; path: string | null; status: { type: string } } }).thread;
    const events: DriverEvent[] = [];
    const notes: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    const turnStatus = new Map<string, { status: string; error?: string; startedAt?: number | null }>();
    // turn 状态与 item 内容分开读；item 带时间戳
    let tcur: string | null = null;
    let tpages = 0;
    do {
      const r = await client.request("thread/turns/list", { threadId: nativeSessionId, limit: 100, sortDirection: "asc", itemsView: "notLoaded", ...(tcur ? { cursor: tcur } : {}) }) as { data: Array<{ id: string; status: string; error: { message?: string } | null; startedAt: number | null; completedAt: number | null }>; nextCursor: string | null };
      for (const turn of r.data) {
        turnStatus.set(turn.id, { status: turn.status, ...(turn.error?.message ? { error: turn.error.message } : {}), startedAt: turn.startedAt });
        if (turn.status !== "inProgress") events.push({
          key: `turn:${turn.id}`, kind: "turn-status", status: mapTurnStatus(turn.status), text: turn.error?.message ? bounded(turn.error.message, 600).text : `本轮${TURN_TEXT[mapTurnStatus(turn.status)]}`,
          nativeTurnId: turn.id, ...(iso(turn.completedAt ? turn.completedAt * 1000 : null) ? { occurredAt: iso(turn.completedAt! * 1000)! } : {}),
          source: "history", parserVersion: CODEX_PARSER, availability: "recorded"
        });
      }
      tcur = r.nextCursor;
      tpages++;
    } while (tcur && tpages < 200);
    do {
      const r = await client.request("thread/items/list", { threadId: nativeSessionId, limit: 200, sortDirection: "asc", ...(cursor ? { cursor } : {}) }) as { data: Array<{ turnId: string; item: Record<string, unknown>; startedAtMs: number | null; completedAtMs: number | null }>; nextCursor: string | null };
      for (const entry of r.data) {
        const e = projectItem(entry.item, entry.turnId, { partial: false, occurredAt: iso(entry.completedAtMs ?? entry.startedAtMs), source: "history" });
        if (e) events.push(e);
      }
      cursor = r.nextCursor;
      pages++;
    } while (cursor && pages < 200);
    if (cursor) notes.push("历史过长：只读取了前 40000 条 item");
    // turn 结束记录排在该 turn 的内容之后
    const order = new Map<string, number>();
    events.forEach((e, i) => { if (e.kind !== "turn-status" && e.nativeTurnId) order.set(e.nativeTurnId, i); });
    const ranked = events.map((e, i) => ({ e, r: e.kind === "turn-status" && e.nativeTurnId && order.has(e.nativeTurnId) ? order.get(e.nativeTurnId)! + 0.5 : i }));
    ranked.sort((x, y) => x.r - y.r);
    events.splice(0, events.length, ...ranked.map((x) => x.e));
    const usage: UsageRecord[] = [];
    const u = this.rolloutUsage(t.path, this.knownRealm(nativeSessionId)?.codexHome);
    if (u.record) usage.push(u.record); else notes.push(u.note);
    const last = [...turnStatus.values()].pop();
    const status: SessionStatus = t.status.type === "active" ? "running" : last?.status === "inProgress" ? "unknown" : "idle";
    return {
      events, usage, status, coverage: cursor ? "partial" : "complete", notes,
      fingerprint: codexFingerprint([...turnStatus.keys()].pop(), last?.status), ...(t.model ? { model: t.model } : {}),
      title: (t.name || t.preview || "").slice(0, 120), titleKind: t.name?.trim() ? "name" : "preview", workspace: t.cwd
    };
  }

  /**
   * 能力缺口回退（F10）：app-server 不提供历史 token 用量，读 rollout 的 token_count。
   * 同时统计 token_count 事件数作为请求数；只读授权根（$CODEX_HOME/sessions、archived_sessions）内的真实路径，阻止 symlink 逃逸。
   */
  rolloutUsage(path: string | null, codexHome = this.codexHome): { record?: UsageRecord; note: string; requestCount?: number; creatorAccountId?: string } {
    if (!path) return { note: "runtime 未提供 rollout 位置，历史用量未采集" };
    let real: string;
    try { real = realpathSync(path); } catch { return { note: "rollout 文件不可用（可能已移动或删除），历史用量未采集" }; }
    const roots = ["sessions", "archived_sessions"].map((d) => { try { return realpathSync(join(codexHome, d)); } catch { return join(codexHome, d); } });
    if (!roots.some((r) => real.startsWith(r + sep))) return { note: "rollout 路径不在授权根内，拒绝读取" };
    let fd: number | undefined;
    try {
      fd = openSync(real, "r");
      const size = fstatSync(fd).size;
      // 请求数 = token_count 事件数；单次最多读末尾 32MB，超过上限时只能给出部分计数。
      const len = Math.min(size, 32 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      let requestCount = 0;
      let record: UsageRecord | undefined;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!line.includes('"token_count"')) continue;
        let j: { timestamp?: string; payload?: { type?: string; info?: { total_token_usage?: Record<string, number> } | null } };
        try { j = JSON.parse(line); } catch { continue; } // 半行
        if (j.payload?.type !== "token_count") continue;
        requestCount++;
        if (record) continue;
        const total = j.payload?.info?.total_token_usage;
        if (!total) continue;
        const mapped: Record<string, number> = {
          totalTokens: total["total_tokens"] ?? 0, inputTokens: total["input_tokens"] ?? 0, cachedInputTokens: total["cached_input_tokens"] ?? 0,
          cacheWriteInputTokens: total["cache_write_input_tokens"] ?? 0, outputTokens: total["output_tokens"] ?? 0, reasoningOutputTokens: total["reasoning_output_tokens"] ?? 0
        };
        record = codexUsage(mapped, "session", `rollout:${real}#token_count`, j.timestamp ?? new Date().toISOString(), "complete");
      }
      if (record) record.requestCount = requestCount;
      const partial = size > len;
      return {
        record, ...(requestCount ? { requestCount } : {}),
        note: record ? (partial ? `rollout 超过 32MB，请求数只统计了末尾一段（${requestCount}）` : "") : (size > len ? "rollout 末尾 32MB 内没有 token_count，历史用量未采集" : "rollout 中没有 token_count，历史用量未采集")
      };
    } catch (e) {
      return { note: `读取 rollout 失败：${(e as Error).message}` };
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  /** 续聊旧会话时，从 rollout 的 token_count 事件数补一个请求数基数；失败则从 0 开始 */
  private async rolloutRequestCount(client: CodexAppServerClient, threadId: string): Promise<number | undefined> {
    try {
      const t = await client.request("thread/read", { threadId }, 10_000) as { thread?: { path?: string | null } };
      return this.rolloutUsage(t?.thread?.path ?? null, this.knownRealm(threadId)?.codexHome).requestCount;
    } catch { return undefined; }
  }

  /** 历史归属证据：rollout 首行 session_meta 的 creator_account_id */
  creatorAccountId(path: string | null, nativeSessionId?: string): string | undefined {
    if (!path) return undefined;
    try {
      const real = realpathSync(path);
      const codexHome = nativeSessionId ? this.knownRealm(nativeSessionId)?.codexHome ?? this.codexHome : this.codexHome;
      const roots = ["sessions", "archived_sessions"].map((d) => { try { return realpathSync(join(codexHome, d)); } catch { return join(codexHome, d); } });
      if (!roots.some((r) => real.startsWith(r + sep))) return undefined;
      const fd = openSync(real, "r");
      try {
        const buf = Buffer.alloc(64 * 1024);
        const n = readSync(fd, buf, 0, buf.length, 0);
        const first = buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
        const m = first.match(/"creator_account_id":"([^"]+)"/);
        return m?.[1];
      } finally { closeSync(fd); }
    } catch { return undefined; }
  }

  async threadMeta(nativeSessionId: string): Promise<{ path: string | null; cwd: string; updatedAt: number } | undefined> {
    const client = await this.clientForNative(nativeSessionId);
    const r = await client.request("thread/read", { threadId: nativeSessionId }).catch(() => null) as { thread?: { path: string | null; cwd: string; updatedAt: number } } | null;
    return r?.thread;
  }

  async fingerprint(nativeSessionId: string): Promise<{ value: string; lastTurnStatus?: string; lastTurnId?: string; terminalObserved?: boolean; active?: boolean } | undefined> {
    const client = await this.clientForNative(nativeSessionId);
    const t = await client.request("thread/read", { threadId: nativeSessionId }).catch(() => null) as { thread?: { updatedAt: number; status: { type: string } } } | null;
    if (!t?.thread) return undefined;
    const turns = await client.request("thread/turns/list", { threadId: nativeSessionId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }).catch(() => null) as { data?: Array<{ id: string; status: string }> } | null;
    return {
      value: codexFingerprint(turns?.data?.[0]?.id, turns?.data?.[0]?.status),
      ...(turns?.data?.[0] ? { lastTurnStatus: turns.data[0].status, lastTurnId: turns.data[0].id, terminalObserved: ["completed", "failed", "interrupted"].includes(turns.data[0].status) } : {}),
      active: t.thread.status.type === "active"
    };
  }

  async findClientMessage(nativeSessionId: string, clientMessageId: string): Promise<boolean | undefined> {
    const client = await this.clientForNative(nativeSessionId);
    try {
      let cursor: string | null = null; let pages = 0;
      do {
        const r = await client.request("thread/items/list", { threadId: nativeSessionId, limit: 200, sortDirection: "desc", ...(cursor ? { cursor } : {}) }) as { data: Array<{ item: { type: string; clientId?: string | null } }>; nextCursor: string | null };
        if (r.data.some((e) => e.item.type === "userMessage" && e.item.clientId === clientMessageId)) return true;
        cursor = r.nextCursor; pages++;
      } while (cursor && pages < 5);
      return false;
    } catch (e) {
      if (e instanceof RpcError && /not found|no rollout|unknown thread/i.test(e.message)) return this.knownRealm(nativeSessionId) ? undefined : false;
      return undefined;
    }
  }

  shutdown(): void { this.disposed = true; for (const c of this.privateStartingClients) c.stop(); for (const c of this.privateClients.values()) c.stop(); this.startingClient?.stop(); this.client?.stop(); this.client = undefined; }
}

const TURN_TEXT: Record<TurnStatus, string> = { queued: "排队中", running: "运行中", "waiting-input": "等待输入", completed: "完成", failed: "失败", cancelled: "已取消", interrupted: "被中断", unknown: "状态未知" };

/**
 * 外部写入检测指纹：最后一个 turn 及其状态。Desktop/CLI 在同一 thread 上续聊会新增 turn；
 * 不用 updatedAt——标题生成等元数据更新也会改它，会误报冲突。
 */
export function codexFingerprint(lastTurnId: string | undefined, lastStatus: string | undefined): string { return `t${lastTurnId ?? "-"}:${lastStatus ?? "-"}`; }

export function mapTurnStatus(s: string): TurnStatus {
  return s === "completed" ? "completed" : s === "interrupted" ? "interrupted" : s === "failed" ? "failed" : s === "inProgress" ? "running" : "unknown";
}

export function underRoots(path: string | undefined, roots: string[]): boolean {
  if (!path) return false;
  let real = path;
  try { real = realpathSync(path); } catch { /* 目录已删：用原路径判断 */ }
  return roots.some((r) => {
    let root = r;
    try { root = realpathSync(r); } catch { /* 用原值 */ }
    return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

/** Codex 口径：input 含 cached input；output 含 reasoning output；total = input + output */
export function codexUsage(t: Record<string, number>, scope: UsageRecord["usageScope"], sourceRef: string, sampledAt: string, reliability: UsageRecord["reliability"], requestCount?: number): UsageRecord {
  return {
    usageScope: scope, counterMode: "cumulative", raw: { ...t },
    input: t["inputTokens"], cachedInput: t["cachedInputTokens"], cacheCreation: t["cacheWriteInputTokens"],
    output: t["outputTokens"], reasoningOutput: t["reasoningOutputTokens"], total: t["totalTokens"],
    ...(requestCount !== undefined ? { requestCount } : {}),
    semantics: "Codex：输入包含缓存输入，输出包含推理输出；会话累计快照取最新值，不相加",
    sourceRef, sampledAt, reliability
  };
}

/** 原生 ThreadItem → 标准事件（只展示公开的推理摘要，不展示原始推理内容） */
export function projectItem(item: Record<string, unknown>, turnId: string | undefined, o: { partial: boolean; occurredAt?: string | undefined; source: "stream" | "history" }): DriverEvent | null {
  const id = String(item["id"] ?? "");
  const type = String(item["type"] ?? "unknown");
  const base = {
    key: `codex:item:${id}`, nativeItemId: id, ...(turnId ? { nativeTurnId: turnId } : {}),
    ...(o.occurredAt ? { occurredAt: o.occurredAt } : {}), source: o.source, parserVersion: CODEX_PARSER, partial: o.partial
  };
  const withText = (text: string, limit: number = LIMITS.message) => {
    const b = bounded(text, limit);
    return { text: b.text, ...(b.truncated ? { truncated: b.truncated } : {}), ...(b.redactions ? { redactions: b.redactions } : {}) };
  };
  switch (type) {
    case "userMessage": {
      const content = (item["content"] as Array<{ type: string; text?: string; path?: string; name?: string }> | undefined) ?? [];
      const text = content.map((c) => c.type === "text" ? c.text ?? "" : `[${c.type}${c.name ? ` ${c.name}` : ""}${c.path ? ` ${c.path}` : ""}]`).join("\n");
      // 平台发出的消息带 clientId：与平台记录的同一条合并，不重复显示
      const clientId = item["clientId"] as string | null | undefined;
      return { ...base, ...(clientId ? { key: `user:${clientId}` } : {}), kind: "message", role: "user", ...withText(text), availability: "recorded" };
    }
    case "agentMessage":
      return { ...base, kind: "message", role: "assistant", ...withText(String(item["text"] ?? "")), availability: "recorded" };
    case "reasoning": {
      const summary = ((item["summary"] as string[] | undefined) ?? []).join("\n").trim();
      return summary
        ? { ...base, kind: "reasoning", role: "assistant", ...withText(summary), availability: "recorded" }
        : { ...base, kind: "reasoning", role: "assistant", text: "（runtime 未公开推理摘要）", availability: "not_collected" };
    }
    case "commandExecution": {
      const out = item["aggregatedOutput"] as string | null | undefined;
      const inp = bounded(String(item["command"] ?? ""), LIMITS.toolInput);
      const outp = bounded(out ?? "", LIMITS.toolOutput);
      return {
        ...base, kind: "tool", availability: "recorded",
        tool: { name: "命令", input: inp.text, ...(out ? { output: outp.text } : {}), status: String(item["status"] ?? ""), exitCode: (item["exitCode"] as number | null) ?? null },
        ...(outp.truncated ? { truncated: outp.truncated } : {}), ...(inp.redactions + outp.redactions ? { redactions: inp.redactions + outp.redactions } : {})
      };
    }
    case "fileChange": {
      const changes = (item["changes"] as Array<{ path: string; kind?: { type?: string }; diff?: string }> | undefined) ?? [];
      const diff = bounded(changes.map((c) => `${c.kind?.type ?? "update"} ${c.path}\n${c.diff ?? ""}`).join("\n"), LIMITS.toolOutput);
      return { ...base, kind: "tool", availability: "recorded", tool: { name: "文件修改", input: changes.map((c) => c.path).join("\n"), output: diff.text, status: String(item["status"] ?? "") }, ...(diff.truncated ? { truncated: diff.truncated } : {}) };
    }
    case "mcpToolCall": {
      const args = bounded(stringifyInput(item["arguments"]), LIMITS.toolInput);
      const res = item["error"] ? `错误：${(item["error"] as { message?: string }).message ?? ""}` : stringifyInput((item["result"] as { content?: unknown } | null)?.content ?? "");
      const out = bounded(res, LIMITS.toolOutput);
      return { ...base, kind: "tool", availability: "recorded", tool: { name: `${String(item["server"])}.${String(item["tool"])}`, input: args.text, output: out.text, status: String(item["status"] ?? "") }, ...(out.truncated ? { truncated: out.truncated } : {}) };
    }
    case "dynamicToolCall": {
      const args = bounded(stringifyInput(item["arguments"]), LIMITS.toolInput);
      const out = bounded(stringifyInput(item["contentItems"] ?? ""), LIMITS.toolOutput);
      return { ...base, kind: "tool", availability: "recorded", tool: { name: String(item["tool"]), input: args.text, output: out.text, status: String(item["status"] ?? "") } };
    }
    case "webSearch":
      return { ...base, kind: "tool", availability: "recorded", tool: { name: "网页搜索", input: bounded(String(item["query"] ?? stringifyInput(item["action"] ?? "")), LIMITS.toolInput).text, status: "" } };
    case "contextCompaction":
      return { ...base, kind: "compaction", text: "上下文已压缩", availability: "recorded" };
    case "sleep": {
      // 原生字段是请求时长；等待可被打断，不能据此宣称实际耗时。
      const duration = item["durationMs"];
      const requested = typeof duration === "number" && Number.isFinite(duration) && duration >= 0
        ? `请求 ${duration / 1000} 秒` : "请求时长未提供";
      return { ...base, kind: "notice", text: `${o.partial ? "正在等待" : "等待已结束"}（${requested}，可被新消息打断）`, availability: "recorded" };
    }
    case "plan":
      return { ...base, kind: "notice", ...withText(`计划：${String(item["text"] ?? "")}`), availability: "recorded" };
    case "collabAgentToolCall":
    case "subAgentActivity":
      return { ...base, kind: "notice", text: `子 Agent 活动（${String(item["tool"] ?? item["kind"] ?? type)}）${item["agentThreadId"] ? `：${String(item["agentThreadId"])}` : ""}`, subagent: String(item["agentThreadId"] ?? item["receiverThreadIds"] ?? ""), availability: "recorded" };
    case "hookPrompt":
      return { ...base, kind: "notice", text: "hook 注入了提示（内容未展示）", availability: "redacted" };
    case "imageView": {
      // 模型查看了本地图片：事件里只有路径，图片按需从磁盘读取（临时目录里被本会话引用过的文件也允许）。
      const path = typeof item["path"] === "string" ? item["path"].trim() : "";
      return path
        ? { ...base, kind: "notice", text: `查看图片：${path}`, image: { path, status: "viewed" }, availability: "recorded" }
        : { ...base, kind: "notice", text: "查看图片（未提供路径）", availability: "not_collected" };
    }
    case "imageGeneration": {
      const status = String(item["status"] ?? (o.partial ? "inProgress" : "completed"));
      const path = typeof item["savedPath"] === "string" && item["savedPath"] ? item["savedPath"] : undefined;
      const prompt = withText(typeof item["revisedPrompt"] === "string" ? item["revisedPrompt"] : "");
      return { ...base, kind: "image", role: "assistant", status,
        text: status === "failed" ? "图片生成失败" : status !== "completed" ? "图片生成中" : path ? "生成的图片" : "图片已生成，但没有可读取的图片文件",
        image: { status, ...(path ? { path } : {}), ...(prompt.text ? { prompt: prompt.text } : {}) },
        availability: "recorded", ...(prompt.redactions ? { redactions: prompt.redactions } : {}) };
    }
    case "functionCallOutput":
      return { ...base, kind: "tool", availability: "recorded", tool: { name: String(item["name"] ?? "函数输出"), output: bounded(stringifyInput(item["output"]), LIMITS.toolOutput).text } };
    default:
      return { ...base, kind: "unknown", text: `未识别的记录类型：${type}`, availability: "not_collected" };
  }
}
