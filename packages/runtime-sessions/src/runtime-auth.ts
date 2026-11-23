/**
 * 统一的运行时网页可视化登录状态机（Codex / Claude Code / Antigravity / Pi）。
 *
 * 设计目标：
 * - 不要求用户在终端 CLI 里操作或复制命令；
 * - 服务端以强隔离环境变量托管各 runtime 的官方登录 RPC 或子进程；
 * - 统一抽象成 4 种标准交互模式：callback / code-paste / hybrid / api-key；
 * - OAuth URL 严格执行 HTTPS + 官方域名白名单校验；
 * - 授权码、回调 URL、API Key 仅在内存直传，绝不写日志、不回显前端。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CodexAppServerClient, allowlistedEnv, type NotificationMsg } from "./codex-client.js";
import type { RuntimeKind, RuntimeProfile } from "./types.js";

export type AuthFlowMode = "callback" | "code-paste" | "hybrid" | "api-key";
export type AuthFlowPhase =
  | "starting"
  | "awaiting-auth"
  | "submitting"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RuntimeAuthFlowSnapshot {
  flowId: string;
  runtimeKind: RuntimeKind;
  mode: AuthFlowMode;
  phase: AuthFlowPhase;
  authUrl?: string;
  codePrompt?: string;
  message: string;
  error?: string;
  startedAt: string;
  expiresAt: string;
  updatedAt: string;
  identitySummary?: string;
  modelCount?: number;
}

export interface RuntimeAuthSubmitInput {
  code?: string;
  provider?: string;
  apiKey?: string;
  modelId?: string;
}

export interface RuntimeAuthProviderOption {
  id: string;
  label: string;
  models?: string[];
}

export interface RuntimeAuthFlowOptions {
  /** 登录进程的工作目录 */
  cwd: string;
  /** 解析各 runtime 的可执行文件路径 */
  resolveBinary: (kind: Exclude<RuntimeKind, "pi">) => string | undefined;
  /** 构造各 runtime 专用的隔离环境变量 */
  envFor: (kind: RuntimeKind) => Record<string, string>;
  /** 登录完成后触发平台 probe（返回最新 profile） */
  verifyProfile: (kind: RuntimeKind) => Promise<RuntimeProfile>;
  /** Pi API Key 验活与写入隔离凭据 */
  configurePiApiKey?: (input: { provider: string; apiKey: string; modelId?: string }) => Promise<{ models: string[]; modelId: string }>;
  /** 登录超时（毫秒），默认 6 分钟 */
  timeoutMs?: number;
  /** 等待 CLI 输出官方登录链接的超时（毫秒），默认 15 秒 */
  urlWaitTimeoutMs?: number;
  /** 测试替身：自定义 Codex 登录客户端 */
  codexClientFactory?: (binaryPath: string, env: Record<string, string>, cwd: string) => CodexAppServerClient;
  /** 测试替身：自定义子进程启动器（Claude / Antigravity） */
  spawnLoginProcess?: (command: string, args: string[], options: { env: Record<string, string>; cwd: string }) => ChildProcessWithoutNullStreams;
}

const OFFICIAL_AUTH_HOSTS: Record<Exclude<RuntimeKind, "pi">, ReadonlySet<string>> = {
  codex: new Set(["auth.openai.com", "chatgpt.com"]),
  "claude-code": new Set(["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"]),
  antigravity: new Set(["accounts.google.com"]),
};

const DEFAULT_TIMEOUT_MS = 6 * 60_000;
const DEFAULT_URL_WAIT_MS = 15_000;
const MAX_CODE_LENGTH = 4096;

/** 严格校验官方 OAuth URL：只允许 HTTPS + 对应厂商域名白名单，防钓鱼/开放重定向。 */
export function validateOfficialAuthUrl(kind: Exclude<RuntimeKind, "pi">, raw: string): string {
  const cleaned = raw.trim().replace(/[),.;]+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error("官方登录链接格式无效");
  }
  if (parsed.protocol !== "https:" || !OFFICIAL_AUTH_HOSTS[kind].has(parsed.hostname)) {
    throw new Error("官方登录链接域名不在允许列表中");
  }
  return parsed.href;
}

/** 从 CLI stdout/stderr 文本片段中提取并校验第一个官方 OAuth URL。 */
export function extractOfficialAuthUrl(kind: Exclude<RuntimeKind, "pi">, text: string): string | undefined {
  const matches = text.match(/https:\/\/[^\s"'<>]+/g);
  if (!matches) return undefined;
  for (const candidate of matches) {
    try {
      return validateOfficialAuthUrl(kind, candidate);
    } catch {
      /* 忽略非官方链接 */
    }
  }
  return undefined;
}

interface ActiveFlow {
  snapshot: RuntimeAuthFlowSnapshot;
  timer?: NodeJS.Timeout;
  codexClient?: CodexAppServerClient;
  codexLoginId?: string;
  child?: ChildProcessWithoutNullStreams;
  cancelled: boolean;
  settled: boolean;
  verifying?: Promise<RuntimeAuthFlowSnapshot>;
  cleanup: () => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeInputText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`请输入${label}`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label}不能为空`);
  if (trimmed.length > MAX_CODE_LENGTH || /[\r\n\0]/.test(trimmed)) {
    throw new Error(`${label}格式无效，请粘贴单行内容`);
  }
  return trimmed;
}

function defaultSpawn(command: string, args: string[], options: { env: Record<string, string>; cwd: string }): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    env: options.env,
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function killChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  try { child.stdin.end(); } catch { /* ignore */ }
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  const force = setTimeout(() => {
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }, 1500);
  force.unref();
}

export class RuntimeAuthFlowManager {
  private readonly flows = new Map<RuntimeKind, ActiveFlow>();
  private readonly timeoutMs: number;
  private readonly urlWaitTimeoutMs: number;

  constructor(private readonly opts: RuntimeAuthFlowOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.urlWaitTimeoutMs = opts.urlWaitTimeoutMs ?? DEFAULT_URL_WAIT_MS;
  }

  /** 读取某个 runtime 当前或最近的登录流程快照（不含任何凭据或敏感输出）。 */
  status(kind: RuntimeKind, flowId?: string): RuntimeAuthFlowSnapshot | null {
    const active = this.flows.get(kind);
    if (!active) return null;
    if (flowId && active.snapshot.flowId !== flowId) return null;
    return { ...active.snapshot };
  }

  /** 启动指定 runtime 的可视化登录流程；如果已有旧流程，先干净释放。 */
  async start(kind: RuntimeKind): Promise<RuntimeAuthFlowSnapshot> {
    const existing = this.flows.get(kind);
    if (existing && !existing.settled) {
      await this.cancel(kind, existing.snapshot.flowId);
    }

    const flowId = `auth-${randomUUID()}`;
    const started = Date.now();
    const snapshot: RuntimeAuthFlowSnapshot = {
      flowId,
      runtimeKind: kind,
      mode: kind === "pi" ? "api-key" : kind === "codex" ? "callback" : kind === "antigravity" ? "code-paste" : "hybrid",
      phase: kind === "pi" ? "awaiting-auth" : "starting",
      message: kind === "pi"
        ? "请填写模型服务商的 API Key，平台会直连官方接口验证可用性"
        : "正在准备官方登录链接…",
      startedAt: new Date(started).toISOString(),
      expiresAt: new Date(started + this.timeoutMs).toISOString(),
      updatedAt: new Date(started).toISOString(),
    };

    const flow: ActiveFlow = {
      snapshot,
      cancelled: false,
      settled: false,
      cleanup: () => {
        if (flow.timer) { clearTimeout(flow.timer); flow.timer = undefined; }
        if (flow.codexClient) {
          const client = flow.codexClient;
          flow.codexClient = undefined;
          try { client.stop(); } catch { /* ignore */ }
        }
        if (flow.child) {
          const child = flow.child;
          flow.child = undefined;
          killChild(child);
        }
      },
    };
    this.flows.set(kind, flow);

    flow.timer = setTimeout(() => {
      if (flow.settled) return;
      this.fail(flow, "登录已超时，请重新发起官方登录");
    }, this.timeoutMs);
    flow.timer.unref();

    if (kind === "pi") return { ...flow.snapshot };
    if (kind === "codex") return this.startCodex(flow);
    if (kind === "claude-code") return this.startCliOauth(flow, "claude-code", ["auth", "login"]);
    return this.startCliOauth(flow, "antigravity", ["acp", "--login"]);
  }

  private touch(flow: ActiveFlow, patch: Partial<RuntimeAuthFlowSnapshot>): void {
    Object.assign(flow.snapshot, patch, { updatedAt: nowIso() });
  }

  private fail(flow: ActiveFlow, errorMessage: string): RuntimeAuthFlowSnapshot {
    if (flow.settled) return { ...flow.snapshot };
    flow.settled = true;
    flow.cleanup();
    this.touch(flow, { phase: "failed", error: errorMessage, message: errorMessage });
    return { ...flow.snapshot };
  }

  private async runVerify(flow: ActiveFlow): Promise<RuntimeAuthFlowSnapshot> {
    if (flow.verifying) return flow.verifying;
    flow.verifying = (async () => {
      this.touch(flow, { phase: "verifying", error: undefined, message: "授权已收到，正在验证账号与可用模型…" });
      try {
        const profile = await this.opts.verifyProfile(flow.snapshot.runtimeKind);
        if (flow.cancelled) return { ...flow.snapshot };
        if (profile.state === "executable") {
          flow.settled = true;
          flow.cleanup();
          this.touch(flow, {
            phase: "succeeded",
            error: undefined,
            message: "账号连接已通过，可以开始使用",
            identitySummary: profile.identity?.summary,
            modelCount: profile.models.length,
          });
          return { ...flow.snapshot };
        }
        const reason = profile.state === "needs-login"
          ? "尚未检测到有效登录状态，请确认已在官方页面完成授权后重试"
          : (profile.stateReason || "连接校验未通过，请重试");
        // 若登录进程仍存活，回到 awaiting-auth 允许用户继续；否则标记失败
        const stillLive = !!(flow.codexClient?.alive || (flow.child && flow.child.exitCode === null));
        if (stillLive && !flow.settled) {
          this.touch(flow, { phase: "awaiting-auth", error: reason, message: reason });
          return { ...flow.snapshot };
        }
        return this.fail(flow, reason);
      } catch (error) {
        const msg = error instanceof Error && error.message ? error.message : "连接校验失败，请重试";
        return this.fail(flow, msg);
      } finally {
        flow.verifying = undefined;
      }
    })();
    return flow.verifying;
  }

  private async startCodex(flow: ActiveFlow): Promise<RuntimeAuthFlowSnapshot> {
    const bin = this.opts.resolveBinary("codex");
    if (!bin) return this.fail(flow, "未安装 Codex 组件，请先安装组件");
    const env = this.opts.envFor("codex");
    const client = this.opts.codexClientFactory
      ? this.opts.codexClientFactory(bin, env, this.opts.cwd)
      : new CodexAppServerClient({ binaryPath: bin, env: allowlistedEnv(env), cwd: this.opts.cwd });
    flow.codexClient = client;

    client.on("notification", (msg: NotificationMsg) => {
      if (flow.settled || flow.cancelled) return;
      if (msg.method !== "account/login/completed") return;
      const params = msg.params as { loginId?: string | null; success?: boolean; error?: string | null };
      if (flow.codexLoginId && params.loginId && params.loginId !== flow.codexLoginId) return;
      if (params.success) {
        flow.codexClient = undefined;
        try { client.stop(); } catch { /* ignore */ }
        void this.runVerify(flow);
      } else {
        this.fail(flow, params.error ? `官方登录未完成：${params.error}` : "官方登录未完成，请重试");
      }
    });

    client.on("exit", () => {
      if (!flow.settled && !flow.cancelled && flow.snapshot.phase !== "verifying") {
        this.fail(flow, "Codex 登录进程提前退出，请重新发起登录");
      }
    });

    try {
      await client.start();
      const result = await client.request("account/login/start", {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
      }) as { authUrl?: string; loginId?: string };
      const authUrl = validateOfficialAuthUrl("codex", result.authUrl || "");
      flow.codexLoginId = result.loginId;
      this.touch(flow, {
        mode: "callback",
        phase: "awaiting-auth",
        authUrl,
        error: undefined,
        message: "请点击下方按钮在浏览器完成 OpenAI 登录，授权后此处会自动检测并完成验证",
      });
      return { ...flow.snapshot };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "无法发起 Codex 登录";
      return this.fail(flow, msg);
    }
  }

  private async startCliOauth(
    flow: ActiveFlow,
    kind: "claude-code" | "antigravity",
    args: string[],
  ): Promise<RuntimeAuthFlowSnapshot> {
    const bin = this.opts.resolveBinary(kind);
    if (!bin) {
      return this.fail(flow, `未安装 ${kind === "antigravity" ? "Antigravity" : "Claude Code"} 组件，请先安装组件`);
    }
    const baseEnv = this.opts.envFor(kind);
    // 禁止后台进程擅自拉起系统浏览器，由 Heji 界面给出明确按钮和复制链接入口
    const env: Record<string, string> = { ...baseEnv, BROWSER: "/usr/bin/true" };
    const spawner = this.opts.spawnLoginProcess ?? defaultSpawn;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawner(bin, args, { env, cwd: this.opts.cwd });
    } catch (error) {
      return this.fail(flow, error instanceof Error ? error.message : "无法启动登录进程");
    }
    flow.child = child;
    child.stdin.on("error", () => { /* 忽略进程退出后的 stdin 写入报错 */ });

    let buffer = "";
    let resolveUrl!: (url: string | undefined) => void;
    let urlResolved = false;
    const urlPromise = new Promise<string | undefined>((resolve) => { resolveUrl = resolve; });
    const settleUrl = (url: string | undefined) => {
      if (urlResolved) return;
      urlResolved = true;
      resolveUrl(url);
    };

    const inspectChunk = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer = (buffer + text).slice(-8192);
      if (!flow.snapshot.authUrl) {
        const found = extractOfficialAuthUrl(kind, buffer);
        if (found) {
          this.touch(flow, {
            phase: "awaiting-auth",
            authUrl: found,
            codePrompt: kind === "antigravity"
              ? "在浏览器完成 Google 授权后，复制页面显示的授权码（或跳转后的完整网址）粘贴到下方提交"
              : "如果浏览器页面显示了授权码，请粘贴到下方提交；若页面已自动完成登录，此处会自动通过校验",
            message: kind === "antigravity"
              ? "请打开下方 Google 登录链接授权，然后粘贴回调页的授权码或完整网址"
              : "请打开下方 Claude 官方链接登录；授权完成后会自动检测，若页面提供授权码可直接粘贴",
          });
          settleUrl(found);
        }
      }
    };

    child.stdout.on("data", inspectChunk);
    child.stderr.on("data", inspectChunk);

    child.on("error", () => {
      settleUrl(undefined);
      if (!flow.settled && !flow.cancelled) {
        this.fail(flow, "登录进程启动失败，请确认组件完整后重试");
      }
    });

    child.on("close", (code) => {
      settleUrl(undefined);
      if (flow.child === child) flow.child = undefined;
      if (flow.cancelled || flow.settled) return;
      if (code === 0) {
        void this.runVerify(flow);
      } else {
        const hint = flow.snapshot.phase === "submitting"
          ? "授权码无效或已过期，请重新发起官方登录"
          : "官方登录未完成，请重新发起登录";
        this.fail(flow, hint);
      }
    });

    const waitTimer = setTimeout(() => settleUrl(undefined), this.urlWaitTimeoutMs);
    waitTimer.unref();
    await urlPromise;
    clearTimeout(waitTimer);

    if (flow.settled || flow.cancelled) return { ...flow.snapshot };
    if (!flow.snapshot.authUrl) {
      return this.fail(flow, "未能获取到官方登录链接，请检查网络连接后重试");
    }
    return { ...flow.snapshot };
  }

  /** 提交授权码（Antigravity / Claude Code）或 API Key（Pi）。 */
  async submit(kind: RuntimeKind, flowId: string, input: RuntimeAuthSubmitInput): Promise<RuntimeAuthFlowSnapshot> {
    const flow = this.flows.get(kind);
    if (!flow || flow.snapshot.flowId !== flowId) {
      throw new Error("登录会话不存在或已过期，请重新发起登录");
    }
    if (flow.settled || flow.cancelled) {
      throw new Error("当前登录会话已结束，请重新发起登录");
    }

    if (kind === "pi") {
      if (!this.opts.configurePiApiKey) throw new Error("当前实例不支持在此配置 Pi API Key");
      const provider = safeInputText(input.provider || "deepseek", "模型服务商");
      const apiKey = safeInputText(input.apiKey, "API Key");
      const modelId = input.modelId ? safeInputText(input.modelId, "默认模型") : undefined;
      this.touch(flow, { phase: "submitting", error: undefined, message: "正在验证 API Key 并保存隔离凭据…" });
      try {
        await this.opts.configurePiApiKey({ provider, apiKey, ...(modelId ? { modelId } : {}) });
        return await this.runVerify(flow);
      } catch (error) {
        const msg = error instanceof Error && error.message ? error.message : "API Key 验证失败，请检查后重试";
        this.touch(flow, { phase: "awaiting-auth", error: msg, message: msg });
        return { ...flow.snapshot };
      }
    }

    if (kind === "codex" && input.apiKey) {
      const apiKey = safeInputText(input.apiKey, "OpenAI API Key");
      if (!flow.codexClient?.alive) throw new Error("Codex 登录连接已断开，请重新发起");
      this.touch(flow, { phase: "submitting", error: undefined, message: "正在验证 OpenAI API Key…" });
      try {
        await flow.codexClient.request("account/login/start", { type: "apiKey", apiKey });
        const client = flow.codexClient;
        flow.codexClient = undefined;
        try { client.stop(); } catch { /* ignore */ }
        return await this.runVerify(flow);
      } catch {
        return this.fail(flow, "API Key 登录未通过，请检查 Key 是否有效");
      }
    }

    const code = safeInputText(input.code, "授权码或回调网址");
    if (!flow.child || flow.child.exitCode !== null) {
      throw new Error("登录进程已结束，请重新发起官方登录");
    }
    this.touch(flow, { phase: "submitting", error: undefined, message: "正在提交授权回执并交换凭据…" });
    // 仅在内存直写 stdin，不写磁盘、不打印日志
    flow.child.stdin.write(`${code}\n`);
    return { ...flow.snapshot };
  }

  /** 手动复核连接状态（用户已在浏览器完成登录时的兜底按钮）。 */
  async verify(kind: RuntimeKind, flowId?: string): Promise<RuntimeAuthFlowSnapshot> {
    const flow = this.flows.get(kind);
    if (!flow || (flowId && flow.snapshot.flowId !== flowId)) {
      const profile = await this.opts.verifyProfile(kind);
      const ts = nowIso();
      return {
        flowId: flowId || `verify-${randomUUID()}`,
        runtimeKind: kind,
        mode: kind === "pi" ? "api-key" : kind === "codex" ? "callback" : kind === "antigravity" ? "code-paste" : "hybrid",
        phase: profile.state === "executable" ? "succeeded" : "failed",
        message: profile.state === "executable" ? "账号连接已通过" : (profile.stateReason || "尚未检测到有效登录"),
        ...(profile.state === "executable" ? {} : { error: profile.stateReason || "尚未检测到有效登录" }),
        startedAt: ts,
        expiresAt: ts,
        updatedAt: ts,
        identitySummary: profile.identity?.summary,
        modelCount: profile.models.length,
      };
    }
    return this.runVerify(flow);
  }

  /** 取消正在进行的登录流程并立刻回收子进程。 */
  async cancel(kind: RuntimeKind, flowId?: string): Promise<RuntimeAuthFlowSnapshot | null> {
    const flow = this.flows.get(kind);
    if (!flow) return null;
    if (flowId && flow.snapshot.flowId !== flowId) return null;
    flow.cancelled = true;
    flow.settled = true;
    if (flow.codexClient?.alive && flow.codexLoginId) {
      await flow.codexClient.request("account/login/cancel", { loginId: flow.codexLoginId }).catch(() => {});
    }
    flow.cleanup();
    this.touch(flow, { phase: "cancelled", error: undefined, message: "已取消本次登录" });
    return { ...flow.snapshot };
  }

  shutdown(): void {
    for (const flow of this.flows.values()) {
      flow.cancelled = true;
      flow.settled = true;
      flow.cleanup();
    }
    this.flows.clear();
  }
}
