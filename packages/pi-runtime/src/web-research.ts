/**
 * 宿主侧联网检索接线（v1.8/v2.3 的 Broker 契约，接到 pi-runtime）：
 *
 *   Pi 进程里的 web_search / web_open 扩展只拿到一个 Unix socket；
 *   Broker 在宿主（runtime 进程）里跑：密钥、来源授权、预算、来源台账都不进 Pi。
 *
 * 每轮一个 Broker：pi 的会话进程一轮一个，检索编号（q1/R1/S1）也就按轮隔离——
 * 上一轮的 searchId 打不开，这是有意的（旧版契约同口径）。
 */
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrokerBudget, WebResearchProviderPreference } from "@pi-agent/web-research";
import { WebResearchBroker, memoryLedger, resolveWebResearchProvider, startBrokerServer } from "@pi-agent/web-research";

/**
 * macOS 的 sun_path 只有 104 字节（含结尾 NUL），Linux 108。留出余量，超过就换短目录。
 * 真实踩过：宿主 TMPDIR 在 /private/var/folders/… 时，runtime/tmp 下的长 socket 路径
 * 让 listen 直接 EINVAL——整轮会话起不来。
 */
const SOCKET_PATH_LIMIT = 100;
const SHORT_SOCKET_ROOT = "/tmp";

/**
 * 选 Broker socket 路径：优先放本轮运行目录；路径太长（或放不下）时退到 /tmp 下的一次性短目录。
 * 退回自己建的目录由 close() 删掉；返回的 cleanupDir 不属于调用方。
 */
export function brokerSocketPath(preferredDir: string): { socketPath: string; cleanupDir?: string } {
  const preferred = join(preferredDir, "web-research.sock");
  if (Buffer.byteLength(preferred) < SOCKET_PATH_LIMIT) return { socketPath: preferred };
  const base = existsSync(SHORT_SOCKET_ROOT) ? SHORT_SOCKET_ROOT : tmpdir();
  const dir = mkdtempSync(join(base, "piwr-"));
  chmodSync(dir, 0o700);
  return { cleanupDir: dir, socketPath: join(dir, "b.sock") };
}

export interface SessionWebResearchOptions {
  /** Broker 监听的 Unix domain socket（精确指定；边界测试用） */
  socketPath?: string;
  /** 优先放这个目录；路径过长时自动退回短目录 */
  socketDir?: string;
  /** 允许阅读的网页域名：`*` 为开放来源（仍只允许公网 HTTPS）；空数组 = 一律拒绝 */
  sourceDomains: string[];
  /** 本轮预算（搜索次数、阅读次数、正文字数） */
  budget?: Partial<BrokerBudget>;
  /** 读 DeepSeek 凭据用的 Pi 状态目录；默认 ~/.pi/agent */
  piAgentDir?: string;
  /** 供应商选择：auto / brave / deepseek；默认读 PI_AGENT_WEB_PROVIDER */
  prefer?: WebResearchProviderPreference;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export interface SessionWebResearch {
  socketPath: string;
  /** 实际选中的供应商；凭据缺失时为 undefined，工具调用会如实报 CONFIG_MISSING */
  provider?: { id: string; label: string; services: { search: string; fetch: string } };
  broker: WebResearchBroker;
  close(): Promise<void>;
}

/** 域名归一：去掉前后点、小写；`*.example.com` 与 `example.com` 等价（都覆盖子域）。 */
function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
}

/**
 * 来源范围判定：`*` 开放；否则精确匹配或子域匹配（example.com 覆盖 a.example.com）。
 * 空列表一律拒绝——同 commands 的口径：未声明就是没授予。
 */
export function sourceDomainDecision(sourceDomains: string[]): (domain: string) => { effect: "ALLOW" | "DENY"; reason: string } {
  const allowed = sourceDomains.map(normalizeDomain).filter(Boolean);
  const open = allowed.includes("*");
  return (domain: string) => {
    const host = normalizeDomain(domain);
    if (!host) return { effect: "DENY", reason: "来源域名为空" };
    if (open) return { effect: "ALLOW", reason: "开放来源范围" };
    if (allowed.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
      return { effect: "ALLOW", reason: "在来源授权范围内" };
    }
    return { effect: "DENY", reason: "不在来源授权范围内" };
  };
}

/** 启动本轮 Broker；没有可用凭据也照常启动，让工具如实报「搜索服务不可用」。 */
export async function startSessionWebResearch(options: SessionWebResearchOptions): Promise<SessionWebResearch> {
  const target = options.socketPath
    ? { socketPath: options.socketPath, cleanupDir: undefined }
    : options.socketDir
      ? brokerSocketPath(options.socketDir)
      : undefined;
  if (!target) throw new Error("Web research broker needs a socketPath or socketDir");
  let provider: ReturnType<typeof resolveWebResearchProvider>;
  try {
    provider = resolveWebResearchProvider({
      ...(options.env ? { env: options.env } : {}),
      ...(options.piAgentDir ? { piAgentDir: options.piAgentDir } : {}),
      ...(options.prefer ? { prefer: options.prefer } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {})
    });
  } catch {
    // 供应商配置写错不该让整轮会话起不来：工具照常注册，调用时报不可用。
    provider = undefined;
  }
  const broker = new WebResearchBroker({
    ...(provider ? { client: provider.client, services: provider.services } : {}),
    decideDomain: sourceDomainDecision(options.sourceDomains),
    ledger: memoryLedger(),
    ...(options.budget ? { budget: options.budget } : {})
  });
  let server: Awaited<ReturnType<typeof startBrokerServer>>;
  try { server = await startBrokerServer(target.socketPath, broker); }
  catch (error) {
    if (target.cleanupDir) rmSync(target.cleanupDir, { recursive: true, force: true });
    throw error;
  }
  return {
    socketPath: server.socketPath,
    ...(provider ? { provider: { id: provider.id, label: provider.label, services: provider.services } } : {}),
    broker,
    close: async () => {
      try { await server.close(); }
      finally { if (target.cleanupDir) rmSync(target.cleanupDir, { recursive: true, force: true }); }
    }
  };
}
