/**
 * 系统级联网检索的供应商选择。
 *
 * 目前两套完整实现：
 *   - brave：Brave Search + Firecrawl（原有默认，两把密钥）
 *   - deepseek：DeepSeek Search + Fetch（一把 DeepSeek key，两个端点）
 *
 * 选择顺序由 PI_AGENT_WEB_PROVIDER 控制：auto（默认）、brave、deepseek。
 * auto 先保留现有部署的 Brave + Firecrawl；只有它不完整时才用 DeepSeek。
 * 显式指定供应商时不做静默回退：缺少对应密钥就返回 undefined，让调用方如实报不可用。
 */
import { createBraveSearchClient, resolveBraveKey } from "./brave.js";
import { createDeepSeekClient, resolveDeepSeekKey } from "./deepseek.js";
import { createFirecrawlReader, resolveFirecrawlKey } from "./firecrawl.js";
import type { ZhipuToolsClient } from "./zhipu.js";

export type WebResearchProviderId = "brave" | "deepseek";
export type WebResearchProviderPreference = WebResearchProviderId | "auto";

export interface WebResearchKeys {
  deepseek?: { key: string; source: string };
  brave?: { key: string; source: string };
  firecrawl?: { key: string; source: string };
}

export interface WebResearchServices { search: string; fetch: string }

export interface WebResearchProvider {
  id: WebResearchProviderId;
  label: string;
  client: ZhipuToolsClient;
  services: WebResearchServices;
  credentials: Array<{ key: string; source: string }>;
}

export const WEB_RESEARCH_SERVICES: Readonly<Record<WebResearchProviderId, WebResearchServices>> = Object.freeze({
  brave: { search: "brave", fetch: "firecrawl" },
  deepseek: { search: "deepseek-search", fetch: "deepseek-fetch" }
});

/**
 * 不选中供应商，只把本机可用凭据找出来（资源页要分别显示两套供应商的配置状态）。
 * 显式传入 keys 时只用传入值，不再读环境变量或 Pi 配置。
 */
export function resolveWebResearchKeys(options: { env?: NodeJS.ProcessEnv; piAgentDir?: string; keys?: WebResearchKeys } = {}): WebResearchKeys {
  if (options.keys) return { ...options.keys };
  const env = options.env ?? process.env;
  return {
    deepseek: resolveDeepSeekKey(env, undefined, options.piAgentDir),
    brave: resolveBraveKey(env),
    firecrawl: resolveFirecrawlKey(env)
  };
}

export function resolveWebResearchProvider(options: {
  env?: NodeJS.ProcessEnv;
  /** Pi 状态目录（默认 ~/.pi/agent），用于读取 deepseek 的 models.json/auth.json */
  piAgentDir?: string;
  /** 测试或上层注入的凭据；给定时不再从环境变量/本机文件补齐 */
  keys?: WebResearchKeys;
  fetch?: typeof fetch;
  timeoutMs?: number;
  prefer?: WebResearchProviderPreference;
} = {}): WebResearchProvider | undefined {
  const env = options.env ?? process.env;
  const prefer = options.prefer ?? preferenceFromEnv(env);
  const keys = resolveWebResearchKeys(options);
  const brave = keys.brave && keys.firecrawl ? { search: keys.brave, reader: keys.firecrawl } : undefined;

  const chosen: WebResearchProviderId | undefined =
    prefer === "deepseek" ? (keys.deepseek ? "deepseek" : undefined)
      : prefer === "brave" ? (brave ? "brave" : undefined)
        : brave ? "brave" : keys.deepseek ? "deepseek" : undefined;

  if (chosen === "deepseek" && keys.deepseek) {
    return {
      id: "deepseek",
      label: "DeepSeek Search & Fetch",
      client: createDeepSeekClient({
        apiKey: keys.deepseek.key,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
      }),
      services: WEB_RESEARCH_SERVICES.deepseek,
      credentials: [keys.deepseek]
    };
  }
  if (chosen === "brave" && brave) {
    return {
      id: "brave",
      label: "Brave Search + Firecrawl",
      client: createBraveSearchClient({
        apiKey: brave.search.key,
        reader: createFirecrawlReader({
          apiKey: brave.reader.key,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
        }),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
      }),
      services: WEB_RESEARCH_SERVICES.brave,
      credentials: [brave.search, brave.reader]
    };
  }
  return undefined;
}

function preferenceFromEnv(env: NodeJS.ProcessEnv): WebResearchProviderPreference {
  const raw = env["PI_AGENT_WEB_PROVIDER"]?.trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (raw === "deepseek") return "deepseek";
  if (raw === "brave" || raw === "brave-firecrawl") return "brave";
  throw new Error("PI_AGENT_WEB_PROVIDER 只支持 auto、brave 或 deepseek");
}
