/**
 * v2.5 F11「外部资源」：模型、搜索、抓取服务的配置状态、最近调用结果、本机用量与可获取的余额。
 *
 * 证据边界（需求 F11）：
 * - 凭据只说明本机有配置：显示是否配置、来源类别与不可逆的指纹，绝不返回密钥本身。
 * - 最近调用成功／失败来自平台级调用日志（只记元数据：服务、能力、角色、时间、成败、错误类别），不代表所有模型或操作都可用。
 * - 用量是本机记录；余额只按服务商受支持的只读接口、由你手动刷新时读取，读不到就写「无法获取」与原因，不拿本机用量或预算冒充。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RateLimitSnapshot, RuntimeProfile } from "@pi-agent/runtime-sessions";
import type { WebResearchProviderId, WebResearchProviderPreference } from "@pi-agent/web-research";

export type ServiceKind = "model" | "search" | "fetch" | "voice";

/** 平台默认联网供应商的两套完整配置：前端按这个列表分组显示并切换。 */
export interface WebResearchProviderOption {
  id: WebResearchProviderId;
  label: string;
  description: string;
  /** 这套配置需要的凭据是否齐全；不齐全时不能切换过去。 */
  ready: boolean;
  reason?: string;
  services: { search: string; fetch: string };
}

/** 外部资源里的联网供应商状态：preference 是保存的选择，selected 是当前实际生效的一套。 */
export interface WebResearchResource {
  preference: WebResearchProviderPreference;
  selected?: WebResearchProviderId;
  /** 选择本身无法解析时的原因（例如环境变量写错）；页面要显示出来而不是整页失败 */
  error?: string;
  options: WebResearchProviderOption[];
}

const WEB_RESEARCH_PREFERENCES: readonly WebResearchProviderPreference[] = ["auto", "brave", "deepseek"];

export function isWebResearchProviderPreference(value: unknown): value is WebResearchProviderPreference {
  return typeof value === "string" && (WEB_RESEARCH_PREFERENCES as readonly string[]).includes(value);
}

/** 手动切换结果落在数据目录：重启后仍生效；默认 auto，跟随环境变量与可用凭据。 */
export class WebResearchProviderSettings {
  constructor(private readonly file: string) {}

  read(): WebResearchProviderPreference {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as { provider?: unknown };
      return isWebResearchProviderPreference(value.provider) ? value.provider : "auto";
    } catch {
      return "auto";
    }
  }

  write(provider: WebResearchProviderPreference): void {
    if (!isWebResearchProviderPreference(provider)) throw new Error("联网供应商只能是 auto、brave 或 deepseek");
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, provider }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** 调用日志的一条：只有元数据，没有请求或响应正文、没有凭据 */
export interface ProviderCall {
  at: string;
  /** model:<provider>、brave、firecrawl、deepseek-search、deepseek-fetch、voice:doubao */
  service: string;
  capability: "chat" | "search" | "read" | "speech";
  /** executor、planner、acceptanceJudge、contractCritic… */
  role: string;
  model?: string;
  ok: boolean;
  errorClass?: string;
  tokens?: number;
  sessionId?: string;
  planId?: string;
}

export class ProviderCallLog {
  constructor(private readonly file: string) {}

  append(call: ProviderCall): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(call)}\n`, { mode: 0o600 });
    } catch { /* 记录失败不影响调用本身 */ }
  }

  read(): ProviderCall[] {
    if (!existsSync(this.file)) return [];
    const out: ProviderCall[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as ProviderCall); } catch { /* 跳过坏行 */ }
    }
    return out;
  }
}

/** 凭据的可安全展示信息：来源类别与不可逆指纹（sha256 前 12 位）；runtime = 运行时订阅登录（无指纹） */
export interface CredentialView { configured: boolean; source?: "env" | "local-file" | "pi-config" | "runtime"; sourceDetail?: string; fingerprint?: string }

export function credentialView(found: { key: string; source: string } | undefined): CredentialView {
  if (!found) return { configured: false };
  const source = found.source.startsWith("env:") ? "env" : found.source.startsWith("pi-config") ? "pi-config" : "local-file";
  const detail = found.source.startsWith("env:") ? found.source.slice(4) : found.source === "file" ? "受权限保护的本机文件" : found.source;
  return { configured: true, source, sourceDetail: detail, fingerprint: `sha256:${createHash("sha256").update(found.key).digest("hex").slice(0, 12)}` };
}

/** 余额／额度：服务商受支持的只读接口给出的值，或无法获取的原因 */
export interface BalanceView {
  status: "ok" | "unavailable" | "not-refreshed";
  reason?: string;
  /** 按币种或额度单位的数值 */
  amounts?: Array<{ label: string; value: number; unit: string }>;
  scope?: string;
  period?: string;
  source?: string;
  fetchedAt?: string;
  /** 缓存超过 1 小时：非实时 */
  stale?: boolean;
  consoleUrl?: string;
}

export interface BalanceAdapter {
  service: string;
  source: string;
  consoleUrl: string;
  read(key: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Omit<BalanceView, "fetchedAt" | "stale" | "consoleUrl" | "source">>;
}

async function getJson(fetchImpl: typeof fetch, url: string, key: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: ctl.signal });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

const reasonOf = (status: number): string => status === 401 || status === 403 ? `无权限（HTTP ${status}）` : status === 404 ? "接口不存在（HTTP 404）" : `服务商返回 HTTP ${status}`;

/** 只读余额接口：DeepSeek；2026-09-30 加入 OpenRouter credits（账户余额，不使用 key 限额替代）。 */
export const BALANCE_ADAPTERS: Record<string, BalanceAdapter | { unsupported: string; consoleUrl: string }> = {
  "model:deepseek": {
    service: "model:deepseek", source: "GET https://api.deepseek.com/user/balance", consoleUrl: "https://platform.deepseek.com/usage",
    async read(key, fetchImpl, timeoutMs) {
      const r = await getJson(fetchImpl, "https://api.deepseek.com/user/balance", key, timeoutMs);
      if (r.status !== 200) return { status: "unavailable", reason: reasonOf(r.status) };
      const b = r.body as { is_available?: boolean; balance_infos?: Array<{ currency?: string; total_balance?: string | number }> } | undefined;
      const infos = Array.isArray(b?.balance_infos) ? b!.balance_infos : [];
      if (!infos.length) return { status: "unavailable", reason: "返回里没有余额信息" };
      return {
        status: "ok", scope: "该 API key 所属账户",
        amounts: infos.map((x) => ({ label: `余额（${b?.is_available === false ? "当前不可用" : "可用"}）`, value: Number(x.total_balance), unit: String(x.currency ?? "") }))
          .filter((x) => Number.isFinite(x.value))
      };
    }
  },
  "model:openrouter": {
    service: "model:openrouter", source: "GET https://openrouter.ai/api/v1/credits", consoleUrl: "https://openrouter.ai/settings/credits",
    async read(key, fetchImpl, timeoutMs) {
      const r = await getJson(fetchImpl, "https://openrouter.ai/api/v1/credits", key, timeoutMs);
      if (r.status === 403) return { status: "unavailable", reason: "OpenRouter 拒绝读取账户余额（HTTP 403）；官方接口要求 Management Key，当前凭据可能没有该权限。可在服务商控制台查看余额。" };
      if (r.status !== 200) return { status: "unavailable", reason: reasonOf(r.status) };
      const d = (r.body as { data?: { total_credits?: unknown; total_usage?: unknown } } | undefined)?.data;
      if (typeof d?.total_credits !== "number" || !Number.isFinite(d.total_credits) || typeof d.total_usage !== "number" || !Number.isFinite(d.total_usage) || !Number.isFinite(d.total_credits - d.total_usage)) {
        return { status: "unavailable", reason: "返回里没有有效的账户余额数据（total_credits / total_usage）" };
      }
      return {
        status: "ok", scope: "该 API key 所属账户",
        amounts: [
          { label: "账户余额", value: d.total_credits - d.total_usage, unit: "USD" },
          { label: "累计充值", value: d.total_credits, unit: "USD" },
          { label: "累计消费", value: d.total_usage, unit: "USD" }
        ]
      };
    }
  },
  firecrawl: {
    service: "firecrawl", source: "GET https://api.firecrawl.dev/v2/team/credit-usage", consoleUrl: "https://www.firecrawl.dev/app/usage",
    async read(key, fetchImpl, timeoutMs) {
      const r = await getJson(fetchImpl, "https://api.firecrawl.dev/v2/team/credit-usage", key, timeoutMs);
      if (r.status !== 200) return { status: "unavailable", reason: reasonOf(r.status) };
      const d = (r.body as { data?: { remainingCredits?: number; planCredits?: number; billingPeriodStart?: string; billingPeriodEnd?: string } } | undefined)?.data;
      if (!d || typeof d.remainingCredits !== "number") return { status: "unavailable", reason: "返回里没有剩余额度" };
      return {
        status: "ok", scope: "该 API key 所属团队",
        amounts: [{ label: "剩余额度", value: d.remainingCredits, unit: "credits" }, ...(typeof d.planCredits === "number" ? [{ label: "套餐额度", value: d.planCredits, unit: "credits" }] : [])],
        ...(d.billingPeriodStart || d.billingPeriodEnd ? { period: `${d.billingPeriodStart ?? "?"} ~ ${d.billingPeriodEnd ?? "?"}` } : {})
      };
    }
  },
  brave: { unsupported: "未确认受支持的只读余额接口（响应头里的限流剩余量不是余额）", consoleUrl: "https://api-dashboard.search.brave.com/" },
  "deepseek-search": { unsupported: "DeepSeek 搜索与模型共用同一个账户余额；请在「模型」中的 DeepSeek 行查看", consoleUrl: "https://platform.deepseek.com/usage" },
  "deepseek-fetch": { unsupported: "DeepSeek 抓取与模型共用同一个账户余额；请在「模型」中的 DeepSeek 行查看", consoleUrl: "https://platform.deepseek.com/usage" },
  "model:zhipu": { unsupported: "未确认受支持的只读余额接口", consoleUrl: "https://open.bigmodel.cn/usercenter/finance" },
  "voice:doubao": { unsupported: "火山引擎语音合成按字符计费，未确认受支持的只读余额接口；用量请到火山引擎语音控制台查看", consoleUrl: "https://console.volcengine.com/speech/new" }
};

/** 余额缓存：按服务保存上次读取的结果（失败时保留上次成功值并标出） */
export class BalanceCache {
  constructor(private readonly file: string) {}
  all(): Record<string, BalanceView & { lastOk?: BalanceView }> {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {}; } catch { return {}; }
  }
  put(service: string, view: BalanceView): void {
    const all = this.all();
    const prev = all[service];
    const lastOk = view.status === "ok" ? undefined : prev?.status === "ok" ? prev : prev?.lastOk;
    all[service] = { ...view, ...(lastOk ? { lastOk } : {}) };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export const BALANCE_STALE_MS = 3_600_000;
export const BALANCE_MIN_REFRESH_MS = 60_000;
/** 运行时页面（Pi 的 DeepSeek / OpenRouter 余额）打开时，缓存超过这个时间就顺带重新读一次 */
export const BALANCE_AUTO_REFRESH_MS = 600_000;

/** 页面上显示的余额：没登记接口、没配凭据、没读过、读取失败（回退到上次成功值并标非实时）各有说法 */
export function balanceViewOf(service: string, configured: boolean, cached: (BalanceView & { lastOk?: BalanceView }) | undefined, now: number): BalanceView {
  const adapter = BALANCE_ADAPTERS[service];
  if (!adapter) return { status: "unavailable", reason: "没有登记这个服务的余额接口" };
  if ("unsupported" in adapter) return { status: "unavailable", reason: adapter.unsupported, consoleUrl: adapter.consoleUrl };
  if (!configured) return { status: "unavailable", reason: "本机没有配置凭据", consoleUrl: adapter.consoleUrl, source: adapter.source };
  if (!cached) return { status: "not-refreshed", reason: "还没有读取过；点「刷新余额」时才会调用服务商的只读接口", consoleUrl: adapter.consoleUrl, source: adapter.source };
  const shown = cached.status === "ok" ? cached : cached.lastOk ? { ...cached.lastOk, reason: `最近一次读取失败：${cached.reason ?? "未知原因"}；显示的是上次成功读取的值` } : cached;
  return { ...shown, consoleUrl: adapter.consoleUrl, source: adapter.source,
    ...(shown.fetchedAt && now - Date.parse(shown.fetchedAt) > BALANCE_STALE_MS ? { stale: true } : {}),
    ...(cached.status !== "ok" && cached.lastOk ? { stale: true } : {}) };
}

/** 一个服务在页面上的状态 */
export interface ServiceStatus {
  service: string;
  kind: ServiceKind;
  label: string;
  credential: CredentialView;
  /** 未配置／本机凭据已配置、未验证／最近调用成功／最近调用失败／状态过期或未知／订阅额度可读、过期、不可用 */
  state: "not-configured" | "configured-unverified" | "last-ok" | "last-failed" | "stale" | "quota-ok" | "quota-stale" | "quota-unavailable";
  last?: { at: string; ok: boolean; capability: string; role: string; model?: string; errorClass?: string };
  usage: { calls: number; failures: number; tokens?: number; since?: string };
  roles: Array<{ role: string; model?: string; note?: string }>;
  balance: BalanceView;
  /** 订阅额度（Claude / OpenAI 等运行时账号）：模型账号按账户窗口计，没有现金余额 */
  quota?: ServiceQuota;
}

/** 运行时读取到的账户额度窗口（「新建会话」里的账户额度是同一份快照） */
export interface ServiceQuota {
  runtimeKind: string;
  available: boolean;
  reason?: string;
  plan?: string;
  source: string;
  sampledAt: string;
  stale: boolean;
  experimental?: boolean;
  windows: Array<{ label: string; usedPercent: number | null; resetsAt: string | null }>;
  /** 当前入口能否手动刷新额度（对外入口只有开了控制授权才可以） */
  canRefresh: boolean;
}

/** 最近一次调用超过 7 天：状态过期，不能据此判断现在可用 */
export const CALL_STALE_MS = 7 * 24 * 3_600_000;

export function serviceStatus(input: {
  service: string; kind: ServiceKind; label: string; credential: CredentialView; calls: ProviderCall[];
  roles: ServiceStatus["roles"]; balance?: BalanceView & { lastOk?: BalanceView }; now: number;
}): ServiceStatus {
  const calls = input.calls.filter((c) => c.service === input.service).sort((a, b) => a.at.localeCompare(b.at));
  const last = calls.at(-1);
  const tokens = calls.reduce((a, c) => a + (c.tokens ?? 0), 0);
  const state: ServiceStatus["state"] = !input.credential.configured ? "not-configured"
    : !last ? "configured-unverified"
      : input.now - Date.parse(last.at) > CALL_STALE_MS ? "stale"
        : last.ok ? "last-ok" : "last-failed";
  const balance = balanceViewOf(input.service, input.credential.configured, input.balance, input.now);
  return {
    service: input.service, kind: input.kind, label: input.label, credential: input.credential, state,
    ...(last ? { last: { at: last.at, ok: last.ok, capability: last.capability, role: last.role, ...(last.model ? { model: last.model } : {}), ...(last.errorClass ? { errorClass: last.errorClass } : {}) } } : {}),
    usage: { calls: calls.length, failures: calls.filter((c) => !c.ok).length, ...(tokens ? { tokens } : {}), ...(calls[0] ? { since: calls[0].at } : {}) },
    roles: input.roles,
    balance
  };
}

/**
 * 运行时订阅额度（Claude / OpenAI 的订阅登录）：它也是模型账号的额度，所以和模型服务用同一种
 * ServiceStatus 行展示，只是「余额 / 额度」列换成 runtime 报告的账户窗口。与「新建会话」的账户额度是同一份快照，
 * 都来自 runtime 的只读账户接口（Claude usage / codex account/rateLimits）或运行中的额度事件。
 * Pi 没有订阅额度窗口，它用到的模型服务余额已作为 model provider 列在本页，这里不再重复。
 *
 * 证据边界与「新建会话」一致：只显示窗口（5 小时 / 周等）、已用比例与重置时间，不反推订阅用了几成，
 * 也不冒充服务商账单；只给脱敏身份摘要，不含任何凭据。
 */
/** 订阅账号在资源页上的名字；Pi 不在此列 */
export const RUNTIME_QUOTA_LABEL: Record<string, string> = { "claude-code": "Claude（订阅）", codex: "OpenAI（ChatGPT 订阅）" };

export function runtimeQuotaServices(
  profiles: Array<RuntimeProfile & { rateLimit?: RateLimitSnapshot & { stale: boolean } }>,
  opts: { canRefresh?: boolean } = {}
): ServiceStatus[] {
  return profiles.filter((p) => p.runtimeKind !== "pi").map((p) => {
    const cap = p.capabilities?.rateLimits;
    const rl = p.rateLimit;
    const supported = cap ? cap.status !== "unsupported" : true;
    const stale = rl?.stale === true;
    const state: ServiceStatus["state"] = !supported ? "quota-unavailable"
      : !rl ? "configured-unverified"
        : !rl.available ? "quota-unavailable"
          : stale ? "quota-stale" : "quota-ok";
    return {
      service: `runtime:${p.runtimeKind}`,
      kind: "model",
      label: RUNTIME_QUOTA_LABEL[p.runtimeKind] ?? p.runtimeKind,
      credential: {
        configured: !!p.identity,
        ...(p.identity ? { source: "runtime" as const, sourceDetail: p.identity.summary } : {})
      },
      state,
      usage: { calls: 0, failures: 0 },
      roles: [{ role: "运行时会话（订阅额度）" }],
      balance: { status: "unavailable", reason: "订阅按账户额度窗口计，不提供现金余额" },
      quota: {
        runtimeKind: p.runtimeKind,
        available: rl?.available === true,
        ...(!supported && cap?.reason ? { reason: cap.reason } : {}),
        ...(rl?.reason ? { reason: rl.reason } : {}),
        ...(rl?.plan ? { plan: rl.plan } : {}),
        source: rl?.source ?? "runtime 账号接口",
        sampledAt: rl?.sampledAt ?? p.checkedAt,
        stale,
        ...(rl?.experimental ? { experimental: true } : {}),
        windows: rl?.windows.map((w) => ({ label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null })) ?? [],
        canRefresh: opts.canRefresh === true
      }
    };
  });
}
