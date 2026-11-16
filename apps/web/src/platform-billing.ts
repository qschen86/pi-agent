import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BEIJING_OFFSET_MS, beijingDateKey } from "./platform-time.js";

/**
 * 「今日消耗」的计费口径：
 * - API 计费（Pi 走 DeepSeek）：当日 token × 官方单价，由 deepseek-usage 给出，这里不重算；
 * - 订阅（Claude Code / Codex）：月费按「当月天数 × 24」平摊到每小时，乘以今天（北京时间）已过去的小时数。
 * 月费与币种可在数据目录的 runtime-billing.json 里覆盖；非美元的费用按当日汇率换成美元。
 */
export type BillingRuntime = "pi" | "claude-code" | "codex";
export type RuntimeBilling = { mode: "api" } | { mode: "subscription"; monthly: number; currency: string };
export type BillingConfig = Record<BillingRuntime, RuntimeBilling>;

export const BILLING_RUNTIMES: readonly BillingRuntime[] = ["pi", "claude-code", "codex"];
export const BILLING_FILE = "runtime-billing.json";

export const DEFAULT_BILLING: BillingConfig = {
  pi: { mode: "api" },
  "claude-code": { mode: "subscription", monthly: 20, currency: "USD" },
  codex: { mode: "subscription", monthly: 20, currency: "USD" }
};

/** 默认配置 + 数据目录里的覆盖；文件缺失、损坏或某项不合法时，那一项沿用默认值。 */
export function readBilling(dataDir: string): BillingConfig {
  const config: BillingConfig = { ...DEFAULT_BILLING };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(dataDir, BILLING_FILE), "utf8")); } catch { return config; }
  if (!raw || typeof raw !== "object") return config;
  for (const runtime of BILLING_RUNTIMES) {
    const item = (raw as Record<string, unknown>)[runtime] as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") continue;
    if (item["mode"] === "api") config[runtime] = { mode: "api" };
    else if (item["mode"] === "subscription" && typeof item["monthly"] === "number" && item["monthly"] >= 0 && Number.isFinite(item["monthly"])) {
      const currency = typeof item["currency"] === "string" && /^[A-Za-z]{3}$/.test(item["currency"]) ? item["currency"].toUpperCase() : "USD";
      config[runtime] = { mode: "subscription", monthly: item["monthly"], currency };
    }
  }
  return config;
}

/** 月费摊到每小时，乘以北京时间今天已过去的小时数（含小数），单位同月费的币种。 */
export function subscriptionAccrued(monthly: number, now: Date): number {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const daysInMonth = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  const hours = shifted.getUTCHours() + shifted.getUTCMinutes() / 60 + shifted.getUTCSeconds() / 3600;
  return monthly / (daysInMonth * 24) * hours;
}

/* ------------------------------ 汇率 ------------------------------ */

export const FX_URL = "https://open.er-api.com/v6/latest/USD";
export const FX_FILE = "fx-rates.json";
const FX_TIMEOUT_MS = 5_000;

export interface FxCache { day: string; rates: Record<string, number> }
export interface FxQuote {
  /** 1 单位该币种 = rate 美元 */
  rate: number;
  /** 汇率对应的北京日期；不等于今天说明取不到新汇率、沿用了旧的 */
  day: string;
  stale: boolean;
}
type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

function readFxCache(dataDir: string): FxCache | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, FX_FILE), "utf8")) as FxCache;
    return value && typeof value.day === "string" && value.rates && typeof value.rates === "object" ? value : undefined;
  } catch { return undefined; }
}

function writeFxCache(dataDir: string, cache: FxCache): void {
  const file = join(dataDir, FX_FILE), tmp = `${file}.tmp`;
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(tmp, JSON.stringify(cache)); renameSync(tmp, file); } catch { /* 缓存写不进去只是下次再取 */ }
}

let fxFlight: Promise<FxCache | undefined> | undefined;

/** 当日汇率表：按北京日期缓存，一天只取一次；取不到就沿用上一次的，并标明日期。 */
async function fxTable(dataDir: string, now: Date, fetchImpl: FetchLike): Promise<{ cache: FxCache; stale: boolean } | undefined> {
  const today = beijingDateKey(now);
  const cached = readFxCache(dataDir);
  if (cached?.day === today) return { cache: cached, stale: false };
  fxFlight ??= (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FX_TIMEOUT_MS);
      try {
        const response = await fetchImpl(FX_URL, { signal: controller.signal });
        if (!response.ok) return undefined;
        const body = await response.json() as { result?: string; rates?: Record<string, unknown> };
        if (body?.result !== "success" || !body.rates) return undefined;
        const rates: Record<string, number> = {};
        for (const [code, value] of Object.entries(body.rates)) if (typeof value === "number" && value > 0 && Number.isFinite(value)) rates[code] = value;
        const fresh = { day: today, rates };
        writeFxCache(dataDir, fresh);
        return fresh;
      } finally { clearTimeout(timer); }
    } catch { return undefined; }
  })().finally(() => { fxFlight = undefined; });
  const fresh = await fxFlight;
  if (fresh) return { cache: fresh, stale: false };
  return cached ? { cache: cached, stale: true } : undefined;
}

/** 某币种折美元的汇率；USD 恒为 1 且不触发网络；取不到也没有旧缓存时返回 undefined。 */
export async function usdRate(currency: string, dataDir: string, now: Date, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<FxQuote | undefined> {
  if (currency === "USD") return { rate: 1, day: beijingDateKey(now), stale: false };
  const table = await fxTable(dataDir, now, fetchImpl);
  const perUsd = table?.cache.rates[currency];
  if (!table || !perUsd) return undefined;
  return { rate: 1 / perUsd, day: table.cache.day, stale: table.stale };
}

/* ------------------------------ 今日消耗 ------------------------------ */

export interface TodayCostRuntime {
  mode: "api" | "subscription";
  /** 折算成美元的今日消耗；订阅费用换不了汇率时为 null */
  usd: number | null;
  /** 订阅的月费原值（原币种） */
  monthly?: number;
  currency?: string;
  /** 汇率所属日期；仅在发生过币种换算时给出 */
  fxDay?: string;
  fxStale?: boolean;
}
export interface TodayCost {
  day: string;
  currency: "USD";
  /** 三个 runtime 里已算出的美元合计 */
  total: number;
  /** 有 runtime 没算出来（汇率不可用）或 API 用量里含未知单价模型时为 true */
  partial: boolean;
  runtimes: Record<BillingRuntime, TodayCostRuntime>;
}

export async function todayCost(input: {
  billing: BillingConfig; now: Date; dataDir: string;
  /** API 计费 runtime 的今日美元消耗（Pi：DeepSeek 用量 × 单价）与其是否只覆盖了已定价部分 */
  apiUsd: Partial<Record<BillingRuntime, { usd: number; partial: boolean }>>;
  fetchImpl?: FetchLike;
}): Promise<TodayCost> {
  const runtimes = {} as Record<BillingRuntime, TodayCostRuntime>;
  let total = 0, partial = false;
  for (const runtime of BILLING_RUNTIMES) {
    const plan = input.billing[runtime];
    if (plan.mode === "api") {
      const api = input.apiUsd[runtime] ?? { usd: 0, partial: false };
      runtimes[runtime] = { mode: "api", usd: api.usd };
      total += api.usd; partial ||= api.partial;
      continue;
    }
    const fx = await usdRate(plan.currency, input.dataDir, input.now, input.fetchImpl);
    const base: TodayCostRuntime = { mode: "subscription", usd: null, monthly: plan.monthly, currency: plan.currency };
    if (!fx) { runtimes[runtime] = base; partial = true; continue; }
    const usd = subscriptionAccrued(plan.monthly, input.now) * fx.rate;
    runtimes[runtime] = { ...base, usd, ...(plan.currency !== "USD" ? { fxDay: fx.day, fxStale: fx.stale } : {}) };
    total += usd;
  }
  return { day: beijingDateKey(input.now), currency: "USD", total, partial, runtimes };
}
