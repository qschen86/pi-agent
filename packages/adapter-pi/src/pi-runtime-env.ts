/**
 * pi 的独立运行环境（ADR-0808）：每轮一个独立的家目录、临时目录、状态目录，外加环境变量白名单。
 *
 * 修复前：
 *   - pi 直接用 ~/.pi（沙箱内可读可写）：auth.json、所有 provider 的密钥、你其他项目的会话记录
 *     都读得到；settings.json / models.json 也改得了——settings 能让 pi 启动时加载扩展，
 *     Agent 改了它，你下次在沙箱外自己用 pi 时就会执行。
 *   - pi 继承宿主的**全部**环境变量，bash 工具再原样传给子进程：
 *     与任务无关的令牌（本机就有 Claude Code 的令牌）Agent 都拿得到。文件黑名单管不到环境变量。
 *
 * 现在：
 *   - 状态目录（PI_CODING_AGENT_DIR）每轮新建，只放本轮要用的那一个 provider 的配置与密钥；
 *     settings.json 去掉会加载代码的字段；fd / rg 这类工具二进制以只读方式引用原位置。
 *   - 家目录（HOME）每轮新建：git、npm 不再因为读不到真实家目录里的配置而失败，也看不到它。
 *   - 环境变量只传白名单：运行所需、网络相关（代理、证书）、pi 自己的非密钥开关，
 *     以及本轮 provider 需要的那一个密钥变量。
 *
 * 口径（如实）：pi 必须持有本轮模型的密钥，它派生的子进程与它在同一个边界里，
 * 所以**本轮所用的那一个密钥**对沙箱内进程仍然可见；遮蔽它需要网络层替换（本期不做）。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** 运行所需的基础变量。 */
const BASE_ENV = ["PATH", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ", "CI"];
/** 网络行为保持不变：代理与证书配置照传（本期不做网络治理）。 */
const NETWORK_ENV = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"
];
/** pi 自己读取的非密钥开关。 */
const PI_ENV = ["PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "PI_TIMING", "PI_AGENT_CONSOLE_PORT"];
const ENV_PREFIXES = ["LC_"];

export const PI_ENV_ALLOWLIST: readonly string[] = Object.freeze([...BASE_ENV, ...NETWORK_ENV, ...PI_ENV]);

/**
 * 内置 provider 的密钥变量（与 pi-ai 的 env-api-keys 对齐的常用子集）。
 * 自定义 provider（models.json 里定义的）按它自己的 apiKey 写法处理；其余用 passEnv 显式放行。
 */
export const BUILTIN_PROVIDER_ENV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"]
});

/** settings.json 里会让 pi 加载代码或额外资源的字段：不带进沙箱。 */
export const CODE_LOADING_SETTINGS: readonly string[] = Object.freeze(["packages", "extensions", "skills", "prompts", "themes"]);

/**
 * DeepSeek 会话的上下文压缩默认值。
 *
 * DeepSeek 原生窗口是 100 万 token，pi 默认只留 16K 给回复，自动压缩要涨到约 98 万才触发，等于没开：
 * 长会话每一步都重放十几万到三十几万 token 的上下文（近 14 天约 2/3 的估算金额花在 128K 以上的请求上）。
 * 这里按「窗口 − reserveTokens」把触发线放到约 15 万，压缩时保留最近 4 万 token 原文。
 * reserveTokens 同时是摘要输出的上限（取 0.8 倍与模型最大输出的较小者），85 万不会让摘要变长，只是上限。
 * 用户自己的 settings.json 里写了同名项就以用户的为准；评测装配不加，保持固定行为。
 */
export const PI_DEEPSEEK_COMPACTION = Object.freeze({ reserveTokens: 850_000, keepRecentTokens: 40_000 });
const DEEPSEEK_COMPACTION_MODELS: readonly string[] = Object.freeze(["deepseek-flash", "deepseek-v4-pro"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 在用户的 compaction 设置之下叠一层平台默认值（模型级覆盖，key 为 provider/modelId）。 */
function withDeepSeekCompaction(user: unknown, model: string | undefined): Record<string, unknown> {
  const base = isRecord(user) ? user : {};
  const userOverrides = isRecord(base["modelOverrides"]) ? base["modelOverrides"] : {};
  const overrides: Record<string, unknown> = { ...userOverrides };
  for (const id of new Set([...DEEPSEEK_COMPACTION_MODELS, ...(model ? [model] : [])])) {
    const key = `deepseek/${id}`;
    overrides[key] = { ...PI_DEEPSEEK_COMPACTION, ...(isRecord(userOverrides[key]) ? userOverrides[key] : {}) };
  }
  return { ...base, modelOverrides: overrides };
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export interface PiRuntimeLayout {
  /** 本轮运行时根目录（整个在写范围内） */
  root: string;
  /** TMPDIR */
  tmpDir: string;
  /** HOME */
  homeDir: string;
  /** PI_CODING_AGENT_DIR */
  agentDir: string;
}

/**
 * 送给模型的图片编码预算（models.json 的 modelOverrides[model].inputLimits）。
 *
 * pi 默认按厂商接口定预算（2000×2000、4.5 MiB base64），而平台用**一条 JSONL 帧**承载 pi 的事件，
 * 单帧硬上限只有 2 MiB：一张整页截图重编码后就超过 1 MB base64，read 结果里还会镜像一份
 * （content + structuredContent），一帧就能撑到 2.6 MiB，把整轮跑挂。
 * 这里把图片压到 1568×1568、512 KiB base64 / JPEG 75：细节仍够读 UI，帧稳定落在限额内。
 */
export const PI_IMAGE_INPUT_LIMITS = Object.freeze({
  images: Object.freeze({ resize: Object.freeze({ maxWidth: 1568, maxHeight: 1568, maxBytes: 512 * 1024, jpegQuality: 75 }) })
});

export interface PreparedPiRuntime extends PiRuntimeLayout {
  /** 本轮 provider 需要额外放行的环境变量名 */
  passEnv: string[];
  /** 运行时需要读、但位于拒读区域里的目录（如原状态目录里的工具二进制） */
  readable: string[];
  /** 审计说明（例如 OAuth 凭据没有带进沙箱） */
  notes: string[];
  /** 状态目录里有哪些文件、带进了哪些 provider（审计用，不含内容） */
  carried: { providers: string[]; auth: string[]; settingsKeys: string[] };
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 用户自己的 pi 状态目录（默认 ~/.pi/agent；用户设了 PI_CODING_AGENT_DIR 就用它）。 */
export function defaultPiConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
}

/**
 * 在 root 下建好本轮的 tmp / home / 状态目录，并从用户的状态目录里**只带走必需的部分**。
 */
export function preparePiRuntime(
  root: string,
  options: { sourceAgentDir?: string; provider?: string; model?: string; /** 给 DeepSeek 会话叠加平台的压缩默认值（评测装配不要开） */ compactionDefaults?: boolean } = {}
): PreparedPiRuntime {
  const layout: PiRuntimeLayout = {
    root,
    tmpDir: join(root, "tmp"),
    homeDir: join(root, "home"),
    agentDir: join(root, "pi-agent")
  };
  for (const dir of [layout.tmpDir, layout.homeDir, layout.agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const source = options.sourceAgentDir ?? defaultPiConfigDir();
  const passEnv: string[] = [];
  const readable: string[] = [];
  const notes: string[] = [];
  const carried = { providers: [] as string[], auth: [] as string[], settingsKeys: [] as string[] };

  const settings = readJson(join(source, "settings.json")) ?? {};
  const provider = options.provider ?? (typeof settings["defaultProvider"] === "string" ? settings["defaultProvider"] : undefined);

  // settings：去掉会加载代码的字段
  const safeSettings = Object.fromEntries(Object.entries(settings).filter(([k]) => !CODE_LOADING_SETTINGS.includes(k)));
  if (options.compactionDefaults && provider === "deepseek") safeSettings["compaction"] = withDeepSeekCompaction(safeSettings["compaction"], options.model);
  if (Object.keys(safeSettings).length > 0) {
    writeFileSync(join(layout.agentDir, "settings.json"), JSON.stringify(safeSettings, null, 2), { mode: 0o600 });
    carried.settingsKeys = Object.keys(safeSettings).sort();
  }

  if (provider) {
    // models.json：只带本轮 provider 的定义（其他 provider 的密钥不进沙箱）
    const models = readJson(join(source, "models.json"));
    const providers = models?.["providers"] as Record<string, Record<string, unknown>> | undefined;
    const entry = providers?.[provider];
    // 本轮模型的图片预算压到平台帧限额内；内置 provider 只有模型目录里的定义，所以用 modelOverrides。
    const overrides = options.model
      ? { ...(entry?.["modelOverrides"] as Record<string, unknown> | undefined), [options.model]: { inputLimits: PI_IMAGE_INPUT_LIMITS } }
      : entry?.["modelOverrides"];
    const config = (entry || overrides) ? { ...entry, ...(overrides ? { modelOverrides: overrides } : {}) } : undefined;
    if (config) {
      writeFileSync(join(layout.agentDir, "models.json"), JSON.stringify({ providers: { [provider]: config } }, null, 2), { mode: 0o600 });
      if (entry) carried.providers.push(provider);
      const apiKey = entry?.["apiKey"];
      // apiKey 写的是环境变量名：放行这一个变量
      if (typeof apiKey === "string" && ENV_NAME.test(apiKey)) passEnv.push(apiKey);
    }
    // auth.json：只带本轮 provider 的 API key；OAuth 会刷新并写回，放进一次性副本会弄丢轮换后的令牌
    const auth = readJson(join(source, "auth.json"));
    const cred = auth?.[provider] as { type?: string } | undefined;
    if (cred?.type === "api_key") {
      writeFileSync(join(layout.agentDir, "auth.json"), JSON.stringify({ [provider]: cred }, null, 2), { mode: 0o600 });
      carried.auth.push(provider);
    } else if (cred) {
      notes.push(`provider ${provider} 的 ${cred.type ?? "未知类型"} 凭据没有带进沙箱（只带 API key）；请为平台运行配置 API key`);
    }
    for (const name of BUILTIN_PROVIDER_ENV[provider] ?? []) passEnv.push(name);
  }

  // fd / rg：pi 的 find / grep 工具要用。只读引用原位置，不复制
  const bin = join(source, "bin");
  if (existsSync(bin)) {
    const realBin = realpathSync(bin);
    symlinkSync(realBin, join(layout.agentDir, "bin"));
    readable.push(realBin);
  }

  return { ...layout, passEnv: [...new Set(passEnv)], readable, notes, carried };
}

/**
 * 共享的 Playwright 浏览器目录。
 *
 * 每轮 HOME 是一次性的，Playwright 默认去 $HOME/Library/Caches/ms-playwright 找浏览器，
 * 在沙箱 HOME 下必然找不到，会话就会去下载（下载可能卡住十分钟）。
 * 这里把它指回宿主机上已装好的共享目录：
 *   1. 宿主机设了 PLAYWRIGHT_BROWSERS_PATH（且不是 "0"）→ 用它；
 *   2. 否则用宿主真实家目录下的默认缓存目录（macOS：~/Library/Caches/ms-playwright，其他：~/.cache/ms-playwright）；
 * 目录不存在就返回 undefined（不注入，保持原行为）。只给路径，不放行任何读写权限。
 */
export function sharedPlaywrightBrowsersPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const configured = env["PLAYWRIGHT_BROWSERS_PATH"];
  const candidate = configured && configured !== "0" && isAbsolute(configured)
    ? configured
    : join(home, ...(platform === "darwin" ? ["Library", "Caches", "ms-playwright"] : [".cache", "ms-playwright"]));
  return existsSync(candidate) ? candidate : undefined;
}

/** 名字是否命中白名单项（支持 `PREFIX*`）。 */
function matches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/**
 * 交给 pi 的环境变量：只传白名单，其余一律不传；`set` 里的值最后覆盖。
 * passEnv 支持 `PREFIX*`（测试夹具用它传场景参数）。
 */
export function buildPiEnvironment(
  source: NodeJS.ProcessEnv,
  options: { passEnv?: readonly string[]; set: Record<string, string> }
): Record<string, string> {
  const allowed = [...PI_ENV_ALLOWLIST, ...ENV_PREFIXES.map((p) => `${p}*`), ...(options.passEnv ?? [])];
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && matches(name, allowed)) env[name] = value;
  }
  return { ...env, ...options.set };
}

/**
 * v2.4：某个 provider 在本机有没有凭据——只看**有没有**，不读出、不返回值。
 * 依次看：内置 provider 的环境变量、Pi models.json 里该 provider 的 apiKey（写的是变量名就看变量）、auth.json 的 API key。
 * 有凭据只代表「本地配置就绪」，不代表密钥有效、额度足够或 API 当前接受该模型。
 */
export function providerCredentialPresent(provider: string, options: { sourceAgentDir?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  const env = options.env ?? process.env;
  if ((BUILTIN_PROVIDER_ENV[provider] ?? []).some((name) => Boolean(env[name]))) return true;
  const dir = options.sourceAgentDir ?? defaultPiConfigDir(env);
  const models = readJson(join(dir, "models.json"));
  const entry = (models?.["providers"] as Record<string, Record<string, unknown>> | undefined)?.[provider];
  const apiKey = entry?.["apiKey"];
  if (typeof apiKey === "string" && apiKey) {
    if (!ENV_NAME.test(apiKey)) return true;
    if (env[apiKey]) return true;
  }
  const cred = readJson(join(dir, "auth.json"))?.[provider] as { type?: string } | undefined;
  return cred?.type === "api_key";
}

/**
 * v2.5 F11：某个 provider 的凭据及其来源类别——只给服务端用（算不可逆指纹、调用服务商的只读余额接口），
 * 不得返回给页面、模型或写进日志。查找顺序与 providerCredentialPresent 相同。
 */
export function providerCredential(provider: string, options: { sourceAgentDir?: string; env?: NodeJS.ProcessEnv } = {}): { key: string; source: string } | undefined {
  const env = options.env ?? process.env;
  for (const name of BUILTIN_PROVIDER_ENV[provider] ?? []) {
    const v = env[name]?.trim();
    if (v) return { key: v, source: `env:${name}` };
  }
  const dir = options.sourceAgentDir ?? defaultPiConfigDir(env);
  const models = readJson(join(dir, "models.json"));
  const entry = (models?.["providers"] as Record<string, Record<string, unknown>> | undefined)?.[provider];
  const apiKey = entry?.["apiKey"];
  if (typeof apiKey === "string" && apiKey) {
    if (!ENV_NAME.test(apiKey)) return { key: apiKey, source: "pi-config:models.json" };
    const v = env[apiKey]?.trim();
    if (v) return { key: v, source: `env:${apiKey}` };
  }
  const cred = readJson(join(dir, "auth.json"))?.[provider] as { type?: string; key?: string } | undefined;
  return cred?.type === "api_key" && typeof cred.key === "string" && cred.key ? { key: cred.key, source: "pi-config:auth.json" } : undefined;
}
