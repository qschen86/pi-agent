/**
 * DeepSeek token 消耗渠道（v3.12）：
 *
 * - 渠道 = 应用-功能。平台模型调用由调用角色直接登记；Pi 受管会话按启动来源归类。
 * - 用量只来自本机记录：平台模型调用的真实 usage，以及 runtime 报告的会话 usage。
 * - 金额是按 Pi 模型表单价反算的估算，不是服务商账单；未知模型只计 token，不假装金额为 0。
 * - 平台功能调用从本版本起实时写账；升级前已有的审计记录在首次启动时导入一次，避免重复计算。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelInvocationPort, RoleModelConfig } from "@pi-agent/model-port";
import type { SessionBinding, UsageRecord } from "@pi-agent/runtime-sessions";
import { OFF_PEAK_FACTOR, PEAK_RULE_TEXT, isPeak } from "./deepseek-peak.js";

export type DeepSeekGroupBy = "app" | "feature" | "app-feature";

/** 一个渠道：应用 + 功能。 */
export interface DeepSeekChannel {
  app: string;
  feature: string;
}

const ROLE_CHANNELS: Record<string, DeepSeekChannel> = {
  memoryTitle: { app: "记忆", feature: "阅读标题" },
  memoryCategory: { app: "记忆", feature: "浏览分类" },
  memoryCandidate: { app: "记忆", feature: "公共记忆候选" },
  sessionTitle: { app: "会话", feature: "自动标题" },
  quickReply: { app: "会话", feature: "快捷回复" },
  noteCategory: { app: "待办", feature: "智能分类" },
  noteKind: { app: "待办", feature: "大类判断" },
  noteDevelopment: { app: "待办", feature: "开发判定" },
  noteIteration: { app: "待办", feature: "推荐任务整理" },
  noteRanking: { app: "待办", feature: "推荐排序校准" },
  gameCompanion: { app: "产物", feature: "小马伙伴" },
  challengePoem: { app: "产物", feature: "打卡小诗" },
  challengeIcon: { app: "产物", feature: "目标图标" },
  ledgerChat: { app: "股票", feature: "记账助手" },
  wrongBookRead: { app: "产物", feature: "错题本识别" },
  wrongBookQuiz: { app: "产物", feature: "错题本出题" },
  wrongBookVerify: { app: "产物", feature: "错题本验题" },
  wrongBookExplain: { app: "产物", feature: "错题本讲解" },
  artifactCategory: { app: "产物", feature: "智能打标" },
  planner: { app: "平台", feature: "需求填充" },
  contractCritic: { app: "平台", feature: "合约评审" },
  acceptanceJudge: { app: "平台", feature: "交付验收" },
  benchmarkJudge: { app: "平台", feature: "基准评分" },
  probe: { app: "平台", feature: "连通性探针" },
  visualReviewer: { app: "平台", feature: "视觉评审" },
  diagnosticTriage: { app: "平台", feature: "故障分诊" },
  errorStatsMerge: { app: "平台", feature: "错误归并" },
  errorStatsAssess: { app: "平台", feature: "错误评估" }
};

/** 角色到应用-功能的映射；同一角色有审查/记忆等变体时按提示词版本再细分。 */
export function deepSeekChannelOf(config: Pick<RoleModelConfig, "role" | "promptVersion"> & { model?: string }): DeepSeekChannel {
  if (config.role === "noteIteration" && /review/i.test(config.promptVersion)) return { app: "待办", feature: "推荐任务审查" };
  if (config.role === "gameCompanion" && /memory/i.test(config.promptVersion)) return { app: "产物", feature: "小马伙伴记忆" };
  return ROLE_CHANNELS[config.role] ?? { app: "平台", feature: config.role };
}

/**
 * Pi 会话按启动入口归到应用-功能。
 * 除了群聊、会话对比这两个有独立界面的入口，其余都是会话：
 * 从待办发起的会话、推荐任务执行本质就是 agent 会话，归「会话-对话」，
 * 否则待办的 token 量会被几十个开发会话淹没，看不出分类/判定本身的成本。
 */
export function runtimeDeepSeekChannel(binding: Pick<SessionBinding, "roomRef" | "comparisonRef">): DeepSeekChannel {
  if (binding.roomRef) return { app: "群聊", feature: "群聊对话" };
  if (binding.comparisonRef) return { app: "平台", feature: "会话对比" };
  return { app: "会话", feature: "对话" };
}

/** DeepSeek 单价（USD / 每百万 token）。来源：Pi 0.86.1 内置模型表。 */
export const DEEPSEEK_PRICES: Record<string, { label: string; input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "deepseek-flash": { label: "DeepSeek V4.1 Flash", input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  "deepseek-v4-pro": { label: "DeepSeek V4 Pro", input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 }
};

export const DEEPSEEK_PRICE_INFO = {
  version: "deepseek-pricing@2026-10-23",
  currency: "USD",
  unit: "每百万 token",
  source: "DeepSeek 官方 Models & Pricing（2026-10-23 核对）；峰时价与 Pi 0.86.1 内置模型表同值"
} as const;

export function deepSeekModelId(model: string): string {
  const leaf = (model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model).trim();
  return leaf.includes(":") ? leaf.slice(0, leaf.lastIndexOf(":")) : leaf;
}

export function isDeepSeekModel(model: string | undefined): boolean {
  if (!model) return false;
  const id = model.toLowerCase();
  return id.startsWith("deepseek/") || id.startsWith("deepseek-");
}

export interface DeepSeekUsageEntry {
  at: string;
  app: string;
  feature: string;
  /** 角色或来源；只用于说明，不是正文 */
  source: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 这组用量对应的模型调用次数（修复重试也各算一次） */
  calls: number;
  /** runtime 是否报告了用量；没有报告时只计次数，不按 0 元估算 */
  usageReported?: boolean;
  ok?: boolean;
  sessionId?: string;
}

/** 追加式本机账本：一行一次平台模型调用或一批历史审计用量。 */
export class DeepSeekUsageLedger {
  private readonly marker: string;
  constructor(private readonly file: string) {
    this.marker = `${file}.legacy-imported`;
  }

  append(entry: DeepSeekUsageEntry): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* 记录失败不影响模型调用本身 */ }
  }

  read(): DeepSeekUsageEntry[] {
    if (!existsSync(this.file)) return [];
    const out: DeepSeekUsageEntry[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as DeepSeekUsageEntry;
        if (!entry || typeof entry !== "object" || !isDeepSeekModel(entry.model)) continue;
        out.push(entry);
      } catch { /* 跳过坏行 */ }
    }
    return out;
  }

  /** 首次升级时把已有审计导入账本；标记文件保证只导入一次。 */
  bootstrap(entries: DeepSeekUsageEntry[]): number {
    try {
      if (existsSync(this.marker)) return 0;
      if (entries.length) {
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
      }
      writeFileSync(this.marker, JSON.stringify({ version: 1, importedAt: new Date().toISOString(), count: entries.length }, null, 2), { mode: 0o600 });
      return entries.length;
    } catch {
      return 0;
    }
  }
}

/** 给模型端口记账：成功调用记真实 usage；失败调用只记次数（不知道费用，不写 0）。 */
export function recordDeepSeekPort(port: ModelInvocationPort, ledger: DeepSeekUsageLedger): ModelInvocationPort {
  return {
    async complete(config, call) {
      const deepseek = config.provider === "deepseek" || isDeepSeekModel(config.model);
      try {
        const response = await port.complete(config, call);
        if (deepseek) {
          const model = response.model ?? `${config.provider}/${config.model}`;
          if (isDeepSeekModel(model)) {
            const u = response.usage;
            const channel = deepSeekChannelOf(config);
            ledger.append({
              at: new Date().toISOString(), app: channel.app, feature: channel.feature, source: config.role, model,
              input: u?.input ?? 0, output: u?.output ?? 0, cacheRead: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0,
              calls: 1, usageReported: !!u, ok: true
            });
          }
        }
        return response;
      } catch (error) {
        if (deepseek) {
          const channel = deepSeekChannelOf(config);
          ledger.append({
            at: new Date().toISOString(), app: channel.app, feature: channel.feature, source: config.role,
            model: `${config.provider}/${config.model}`, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
            calls: 1, usageReported: false, ok: false
          });
        }
        throw error;
      }
    }
  };
}

export interface DeepSeekUsageCost {
  currency: "USD";
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** 渠道里含未知单价模型时为 true：金额只覆盖已定价部分 */
  partial: boolean;
}

/** 峰谷口径：金额按调用发生时刻计价；「已省」「还能省」都是相对峰时价算出来的。 */
export interface DeepSeekTariff {
  peakCalls: number;
  offPeakCalls: number;
  /** 没有可靠发生时间的用量（累计快照）：按峰时价保守计价，也不计入「还能省」 */
  undatedCalls: number;
  /** 波谷调用占已知时段调用的比例（0–1） */
  offPeakShare: number;
  /** 波谷调用已经少付的钱（USD）；已定价才给 */
  saved?: number;
  /** 仍落在峰时的调用改到波谷可再省的钱（USD）；已定价才给 */
  remaining?: number;
}

export interface DeepSeekUsageMetrics {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheRead + cacheWrite：缓存命中的 prompt token，按 1:1 计入 totalTokens */
  cacheTokens: number;
  totalTokens: number;
  /** 计价 token：按各自单价折算成「输入 token 当量」，跨渠道比较花钱多少用它 */
  weightedTokens: number;
  /** runtime/平台没有报告用量的调用次数 */
  callsWithoutUsage: number;
  /** 未知单价模型的 token；这些 token 不进金额合计 */
  unpricedTokens: number;
  /** Pi 受管会话数（账本里的平台调用没有会话） */
  sessions: number;
  cost?: DeepSeekUsageCost;
  tariff?: DeepSeekTariff;
}

export interface DeepSeekUsageGroup extends DeepSeekUsageMetrics {
  key: string;
  label: string;
  app?: string;
  feature?: string;
  apps: string[];
  features: string[];
  models: string[];
  /** 该组 token 占全部 token 的比例（0–1）；含缓存命中，长上下文会话会偏高 */
  tokenShare: number;
  /** 该组计价 token 占全部计价 token 的比例（0–1）：按单价折算后的占比 */
  weightedShare: number;
  /** 该组估算金额占全部已定价金额的比例；总额为 0 时没有 */
  costShare?: number;
}

/** 统计应用的按日明细行：一天 × 渠道 × runtime × 发起端的 token 与估算金额（USD）。 */
export interface DeepSeekDailyRow { day: string; app: string; feature: string; runtime: string; device: string; tokens: number; usd: number; calls: number; partial: boolean }

export interface DeepSeekRuntimeSession {
  // noteRef 在类型里保留（runtime 的 binding 本就带它），但归类时不使用：从待办发起的会话仍算普通会话。
  binding: Pick<SessionBinding, "platformSessionId" | "roomRef" | "comparisonRef" | "recommendationRef" | "noteRef" | "effectiveModel" | "requestedModel"> & Partial<Pick<SessionBinding, "runtimeKind">>;
  records: UsageRecord[];
}

export interface DeepSeekUsageView {
  generatedAt: string;
  timeZone: string;
  /** 「今日」对应的本地日期 YYYY-MM-DD */
  today: string;
  scope: string;
  defaultGroupBy: DeepSeekGroupBy;
  totals: DeepSeekUsageMetrics;
  /** 累计口径（等同 ranges.all）；保留给旧调用方 */
  groups: Record<DeepSeekGroupBy, DeepSeekUsageGroup[]>;
  models: Array<{ model: string; label: string; priced: boolean; calls: number; totalTokens: number; unpricedTokens: number; cost?: DeepSeekUsageCost }>;
  /** 今日 / 昨日 / 近 7 天 / 近 30 日 / 累计，各自的合计、应用与应用-功能聚合 */
  ranges: Record<DeepSeekRangeId, DeepSeekRangeView>;
  rangeOrder: DeepSeekRangeId[];
  coverage: {
    runtimeSessions: number;
    runtimeSessionsWithDeepSeek: number;
    ledgerCalls: number;
    callsWithoutUsage: number;
    ledgerSince?: string;
  };
  price: typeof DEEPSEEK_PRICE_INFO & {
    models: Array<{ id: string; label: string; input: number; output: number; cacheRead: number; cacheWrite: number; offPeak: { input: number; output: number; cacheRead: number; cacheWrite: number } }>;
    peakRule: string;
    offPeakFactor: number;
  };
  notes: string[];
}

interface MutableMetrics {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheTokens: number;
  totalTokens: number;
  weightedTokens: number;
  callsWithoutUsage: number;
  unpricedTokens: number;
  sessions: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  pricedAny: boolean;
  peakCalls: number;
  offPeakCalls: number;
  undatedCalls: number;
  costPeak: number;
  costOffPeak: number;
}

interface MutableGroup extends MutableMetrics {
  app: string;
  feature: string;
  models: Set<string>;
}

interface ModelTokens {
  model: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  calls: number;
}

const emptyMetrics = (): MutableMetrics => ({
  calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheTokens: 0, totalTokens: 0, weightedTokens: 0,
  callsWithoutUsage: 0, unpricedTokens: 0, sessions: 0,
  costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, costTotal: 0, pricedAny: false,
  peakCalls: 0, offPeakCalls: 0, undatedCalls: 0, costPeak: 0, costOffPeak: 0
});

/**
 * 计价权重：把各类 token 折算成「输入 token 当量」。
 * 缓存命中量经常是真实输入的上百倍，但单价只有输入的几十分之一；
 * 直接按 1:1 汇总会让长上下文会话在 token 榜上虚高，所以另外给一个折算口径。
 * 未知单价模型按 1:1 计（不知道价格就不假装它便宜）。
 */
export function deepSeekTokenWeights(model: string): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const price = DEEPSEEK_PRICES[deepSeekModelId(model)];
  if (!price || price.input <= 0) return { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
  return {
    input: 1,
    output: price.output / price.input,
    cacheRead: price.cacheRead / price.input,
    cacheWrite: price.cacheWrite / price.input
  };
}

function addTokens(into: MutableMetrics, tokens: ModelTokens, peak?: boolean): void {
  const input = finite(tokens.input), output = finite(tokens.output), cacheRead = finite(tokens.cacheRead), cacheWrite = finite(tokens.cacheWrite);
  const split = input + output + cacheRead + cacheWrite;
  const total = split || finite(tokens.total);
  const weight = deepSeekTokenWeights(tokens.model);
  into.input += input; into.output += output; into.cacheRead += cacheRead; into.cacheWrite += cacheWrite;
  into.cacheTokens += cacheRead + cacheWrite;
  into.totalTokens += total;
  // 只有总量没有拆分时也算 1:1，不能让这类调用在计价榜上消失。
  into.weightedTokens += split > 0
    ? input * weight.input + output * weight.output + cacheRead * weight.cacheRead + cacheWrite * weight.cacheWrite
    : total;
  if (total <= 0) return;
  // 只有总量、没有输入/输出/缓存拆分时无法按单价反算，不能当成 0 元。
  if (split <= 0) { into.unpricedTokens += total; return; }
  const price = DEEPSEEK_PRICES[deepSeekModelId(tokens.model)];
  if (price) {
    // 波谷 5 折；没有发生时间的用量按峰时价保守计（宁可估高，不假装便宜）。
    const factor = peak === false ? OFF_PEAK_FACTOR : 1;
    const costInput = input / 1_000_000 * price.input * factor;
    const costOutput = output / 1_000_000 * price.output * factor;
    const costCacheRead = cacheRead / 1_000_000 * price.cacheRead * factor;
    const costCacheWrite = cacheWrite / 1_000_000 * price.cacheWrite * factor;
    into.costInput += costInput;
    into.costOutput += costOutput;
    into.costCacheRead += costCacheRead;
    into.costCacheWrite += costCacheWrite;
    into.costTotal = into.costInput + into.costOutput + into.costCacheRead + into.costCacheWrite;
    if (peak === false) into.costOffPeak += costInput + costOutput + costCacheRead + costCacheWrite;
    else if (peak === true) into.costPeak += costInput + costOutput + costCacheRead + costCacheWrite;
    into.pricedAny = true;
  } else {
    into.unpricedTokens += total;
  }
}

/** 一条账本记录发生在峰时还是波谷；时间不可信时返回 undefined（只进累计）。 */
function tariffOf(at: string | undefined): boolean | undefined {
  if (!at) return undefined;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms) || ms < MIN_SANE_MS) return undefined;
  return isPeak(new Date(ms));
}

function addEntry(into: MutableMetrics, entry: DeepSeekUsageEntry): void {
  const calls = Math.max(0, finite(entry.calls) || 1);
  into.calls += calls;
  if (entry.usageReported === false) into.callsWithoutUsage += calls;
  const peak = tariffOf(entry.at);
  if (peak === false) into.offPeakCalls += calls;
  else if (peak === true) into.peakCalls += calls;
  else into.undatedCalls += calls;
  addTokens(into, { model: entry.model, input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite, calls }, peak);
}

function mergeMetrics(into: MutableMetrics, from: MutableMetrics): void {
  into.calls += from.calls;
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.cacheTokens += from.cacheTokens;
  into.totalTokens += from.totalTokens;
  into.weightedTokens += from.weightedTokens;
  into.callsWithoutUsage += from.callsWithoutUsage;
  into.unpricedTokens += from.unpricedTokens;
  into.sessions += from.sessions;
  into.costInput += from.costInput;
  into.costOutput += from.costOutput;
  into.costCacheRead += from.costCacheRead;
  into.costCacheWrite += from.costCacheWrite;
  into.costTotal += from.costTotal;
  into.pricedAny ||= from.pricedAny;
  into.peakCalls += from.peakCalls;
  into.offPeakCalls += from.offPeakCalls;
  into.undatedCalls += from.undatedCalls;
  into.costPeak += from.costPeak;
  into.costOffPeak += from.costOffPeak;
}

function publicMetrics(m: MutableMetrics): DeepSeekUsageMetrics {
  const timed = m.peakCalls + m.offPeakCalls;
  return {
    calls: m.calls, input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite,
    cacheTokens: m.cacheTokens, totalTokens: m.totalTokens, weightedTokens: m.weightedTokens,
    callsWithoutUsage: m.callsWithoutUsage, unpricedTokens: m.unpricedTokens,
    sessions: m.sessions,
    ...(timed > 0 ? { tariff: {
      peakCalls: m.peakCalls, offPeakCalls: m.offPeakCalls, undatedCalls: m.undatedCalls,
      offPeakShare: m.offPeakCalls / timed,
      ...(m.pricedAny ? { saved: m.costOffPeak, remaining: m.costPeak / 2 } : {})
    } } : {}),
    ...(m.pricedAny ? { cost: {
      currency: "USD" as const, input: m.costInput, output: m.costOutput, cacheRead: m.costCacheRead,
      cacheWrite: m.costCacheWrite, total: m.costTotal, partial: m.unpricedTokens > 0
    } } : {})
  };
}

/** 按调用发生时刻算一次调用的 USD 估算；分诊预算与账本共用同一口径。 */
export function deepSeekCostUsd(model: string, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, at: Date): number {
  const price = DEEPSEEK_PRICES[deepSeekModelId(model)];
  if (!price) return 0;
  const factor = isPeak(at) ? 1 : OFF_PEAK_FACTOR;
  const input = Math.max(0, finite(usage.input)), output = Math.max(0, finite(usage.output));
  const cacheRead = Math.max(0, finite(usage.cacheRead)), cacheWrite = Math.max(0, finite(usage.cacheWrite));
  // input 已含缓存命中时，未命中部分单独计价（与旧口径一致）。
  const miss = Math.max(0, input - cacheRead);
  return (miss * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1_000_000 * factor;
}

function recordTokens(record: UsageRecord): ModelTokens {
  return {
    model: record.model ?? "", input: record.input, output: record.output,
    cacheRead: record.cachedInput, cacheWrite: record.cacheCreation, total: record.total,
    // 归档压缩后的合计行代表多次请求
    calls: (record as UsageRecord & { aggregate?: { calls?: number } }).aggregate?.calls ?? 1
  };
}

/** 一段用量及其发生时间；没有可靠时间的（累计快照）只进「累计」，不进任何时间窗。 */
interface TokenSlice { at?: number; tokens: ModelTokens }

const MIN_SANE_MS = Date.UTC(2020, 0, 1);

/**
 * 一条 delta 用量发生的时间：Pi 的 requestId 末尾带消息时间戳（毫秒，比 sampledAt 更准——回补采样会晚于消息）；
 * 其次 occurredAt，最后 sampledAt。都不可信时返回 undefined，只计入「累计」。
 */
function recordTime(record: UsageRecord): number | undefined {
  // 归档压缩后的合计行：用所在小时的中点（Pi 的合计行没有 occurredAt，sampledAt 可能是回补时间）
  const hour = (record as UsageRecord & { aggregate?: { hour?: string } }).aggregate?.hour;
  if (hour) { const ms = Date.parse(hour); if (Number.isFinite(ms)) return ms + 1_800_000; }
  const fromId = /:assistant:(\d{12,13})$/.exec(record.requestId ?? "");
  if (fromId) {
    const ms = Number(fromId[1]);
    if (Number.isFinite(ms) && ms >= MIN_SANE_MS && ms <= Date.now() + 86_400_000) return ms;
  }
  for (const text of [record.occurredAt, record.sampledAt]) {
    if (!text) continue;
    const ms = Date.parse(text);
    if (Number.isFinite(ms) && ms >= MIN_SANE_MS) return ms;
  }
  return undefined;
}

/**
 * 一次会话的 DeepSeek 用量：累计快照取最新一份（没有时间，只进累计），
 * delta 按请求 ID 去重、逐条带时间，供按天分桶；
 * 子 Agent 的消耗也要算钱，因此和普通会话用量一起汇总（不沿用会话统计卡片的排除口径）。
 */
function sessionSlices(binding: DeepSeekRuntimeSession["binding"], records: UsageRecord[]): TokenSlice[] {
  const relevant = records.filter((r) => isDeepSeekModel(r.model ?? binding.effectiveModel ?? binding.requestedModel));
  if (!relevant.length) return [];
  const main = relevant.filter((r) => !r.subagent);
  const snapshots = main.filter((r) => r.usageScope === "session" && r.counterMode === "cumulative")
    .sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
  if (snapshots.length) {
    const last = snapshots[snapshots.length - 1]!;
    const model = last.model ?? binding.effectiveModel ?? binding.requestedModel ?? "unknown";
    return [{ tokens: { ...recordTokens(last), model, calls: last.requestCount ?? 1 } }];
  }
  const out: TokenSlice[] = [];
  const seen = new Set<string>();
  for (const r of relevant) {
    if (r.counterMode !== "delta") continue;
    const key = `${r.subagent ?? ""}|${r.requestId ?? r.sourceRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const model = r.model ?? binding.effectiveModel ?? binding.requestedModel ?? "unknown";
    const at = recordTime(r);
    out.push({ ...(at !== undefined ? { at } : {}), tokens: { ...recordTokens(r), model } });
  }
  return out;
}

/* ------------------------------ 时间窗与按天分桶 ------------------------------ */

export type DeepSeekRangeId = "today" | "yesterday" | "7d" | "30d" | "all";

export const DEEPSEEK_RANGES: ReadonlyArray<{ id: DeepSeekRangeId; label: string; days?: number }> = [
  { id: "today", label: "今日", days: 1 },
  { id: "yesterday", label: "昨日" },
  { id: "7d", label: "近 7 天", days: 7 },
  { id: "30d", label: "近 30 日", days: 30 },
  { id: "all", label: "累计" }
];

/** 无法确定发生时间的用量：只进「累计」。 */
const UNDATED = "";

/** 本地时区的日期键 YYYY-MM-DD；按 15 分钟槽缓存，避免对每条记录都跑一次 Intl（时区偏移不会落在槽内）。 */
function dayKeyFactory(timeZone: string): (ms: number) => string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const memo = new Map<number, string>();
  return (ms) => {
    const slot = Math.floor(ms / 900_000);
    let key = memo.get(slot);
    if (key === undefined) {
      const parts = Object.fromEntries(format.formatToParts(ms).map((p) => [p.type, p.value]));
      key = `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
      if (memo.size > 20_000) memo.clear();
      memo.set(slot, key);
    }
    return key;
  };
}

/** 日期键加减天数（纯日历运算，与时区无关）。 */
function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

function rangeBounds(id: DeepSeekRangeId, today: string): { from?: string; to?: string } {
  if (id === "all") return {};
  if (id === "yesterday") { const y = shiftDay(today, -1); return { from: y, to: y }; }
  const days = DEEPSEEK_RANGES.find((r) => r.id === id)?.days ?? 1;
  return { from: shiftDay(today, -(days - 1)), to: today };
}

/** 一个桶：某天、某渠道、某模型、某个计费时段的累计用量；是按天缓存与时间窗求和的最小单位。 */
interface UsageCell { day: string; app: string; feature: string; model: string; tariff: "peak" | "off-peak" | "undated"; m: MutableMetrics; /** 统计应用用：发起端与 runtime；账本里的平台调用没有这两项（按「自动」「pi」算） */ device?: string; runtime?: string }

/** 一次 Pi 会话的贡献：渠道固定，按天 × 模型的桶。会话没变时可整体复用。 */
interface SessionContribution { app: string; feature: string; cells: Map<string, UsageCell> }

/** 某会话在某时刻（毫秒；没有可靠时间则为 undefined）的发起端：手机 / PC / 自动 / 未知。 */
export type DeepSeekDeviceOf = (platformSessionId: string, at: number | undefined) => string;

function sessionContribution(session: DeepSeekRuntimeSession, dayOf: (ms: number) => string, deviceOf?: DeepSeekDeviceOf): SessionContribution | undefined {
  const slices = sessionSlices(session.binding, session.records);
  if (!slices.length) return undefined;
  const channel = runtimeDeepSeekChannel(session.binding);
  const cells = new Map<string, UsageCell>();
  for (const slice of slices) {
    const day = slice.at === undefined ? UNDATED : dayOf(slice.at);
    const model = deepSeekModelId(slice.tokens.model);
    const peak = slice.at === undefined ? undefined : isPeak(new Date(slice.at));
    const tariff = peak === undefined ? "undated" as const : peak ? "peak" as const : "off-peak" as const;
    const device = deviceOf?.(session.binding.platformSessionId, slice.at);
    const key = `${day}\u0000${model}\u0000${tariff}${device === undefined ? "" : `\u0000${device}`}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { day, app: channel.app, feature: channel.feature, model, tariff, m: emptyMetrics(), ...(device !== undefined ? { device } : {}), runtime: session.binding.runtimeKind ?? "pi" };
      cells.set(key, cell);
    }
    cell.m.calls += slice.tokens.calls;
    if (peak === false) cell.m.offPeakCalls += slice.tokens.calls;
    else if (peak === true) cell.m.peakCalls += slice.tokens.calls;
    else cell.m.undatedCalls += slice.tokens.calls;
    addTokens(cell.m, { ...slice.tokens, model }, peak);
  }
  return { app: channel.app, feature: channel.feature, cells };
}

function addLedgerEntry(cells: Map<string, UsageCell>, entry: DeepSeekUsageEntry, dayOf: (ms: number) => string): void {
  const at = Date.parse(entry.at);
  const day = Number.isFinite(at) && at >= MIN_SANE_MS ? dayOf(at) : UNDATED;
  const app = entry.app || "平台", feature = entry.feature || entry.source || "其他";
  const model = deepSeekModelId(entry.model);
  const peak = tariffOf(entry.at);
  const tariff = peak === undefined ? "undated" as const : peak ? "peak" as const : "off-peak" as const;
  const key = `${day}\u0000${app}\u0000${feature}\u0000${model}\u0000${tariff}`;
  let cell = cells.get(key);
  if (!cell) { cell = { day, app, feature, model, tariff, m: emptyMetrics() }; cells.set(key, cell); }
  addEntry(cell.m, entry);
}

export interface DeepSeekRangeView {
  id: DeepSeekRangeId;
  label: string;
  /** 本地日期 YYYY-MM-DD，含首尾；「累计」没有 */
  from?: string;
  to?: string;
  totals: DeepSeekUsageMetrics;
  /** 都按计价 token（≈ 花费）倒序 */
  groups: { app: DeepSeekUsageGroup[]; "app-feature": DeepSeekUsageGroup[]; feature: DeepSeekUsageGroup[] };
  models: DeepSeekUsageView["models"];
}

interface ViewMeta {
  now: Date;
  timeZone: string;
  today: string;
  runtimeSessions: number;
  ledgerCalls: number;
  ledgerSince?: string;
}

function groupRows(groups: Map<string, MutableGroup>, mode: DeepSeekGroupBy, totalTokens: number, totalWeighted: number, totalCost: number | undefined): DeepSeekUsageGroup[] {
  const merged = new Map<string, { app?: string; feature?: string; apps: Set<string>; features: Set<string>; models: Set<string>; metrics: MutableMetrics }>();
  for (const g of groups.values()) {
    const key = mode === "app" ? g.app : mode === "feature" ? g.feature : `${g.app}\u0000${g.feature}`;
    const row = merged.get(key) ?? {
      ...(mode === "app" ? { app: g.app } : mode === "feature" ? { feature: g.feature } : { app: g.app, feature: g.feature }),
      apps: new Set<string>(), features: new Set<string>(), models: new Set<string>(), metrics: emptyMetrics()
    };
    row.apps.add(g.app); row.features.add(g.feature);
    for (const model of g.models) row.models.add(model);
    mergeMetrics(row.metrics, g);
    merged.set(key, row);
  }
  return [...merged.entries()].map(([key, row]) => {
    const metrics = publicMetrics(row.metrics);
    return {
      key: mode === "app-feature" ? `${row.app} · ${row.feature}` : key,
      label: mode === "app" ? row.app! : mode === "feature" ? row.feature! : `${row.app} · ${row.feature}`,
      ...(row.app ? { app: row.app } : {}), ...(row.feature ? { feature: row.feature } : {}),
      apps: [...row.apps].sort(), features: [...row.features].sort(), models: [...row.models].sort(),
      ...metrics,
      tokenShare: totalTokens > 0 ? metrics.totalTokens / totalTokens : 0,
      weightedShare: totalWeighted > 0 ? metrics.weightedTokens / totalWeighted : 0,
      ...(metrics.cost && totalCost && totalCost > 0 ? { costShare: metrics.cost.total / totalCost } : {})
    };
  // 按计价 token 排序：缓存命中量大的长上下文渠道不该霸榜，输出重的渠道要能浮上来。
  }).sort((a, b) => b.weightedTokens - a.weightedTokens || b.totalTokens - a.totalTokens || b.calls - a.calls || a.label.localeCompare(b.label, "zh-CN"));
}

/** 把落在时间窗内的桶汇总成一个时间窗视图。桶数 ≈ 会话数 × 活跃天数，量级很小。 */
function buildRange(
  range: { id: DeepSeekRangeId; label: string },
  today: string,
  ledgerCells: Iterable<UsageCell>,
  contributions: Iterable<SessionContribution>
): { view: DeepSeekRangeView; global: MutableMetrics } {
  const { from, to } = rangeBounds(range.id, today);
  const inRange = (day: string): boolean => range.id === "all" || (day !== UNDATED && day >= from! && day <= to!);
  const groups = new Map<string, MutableGroup>();
  const global = emptyMetrics();
  const models = new Map<string, MutableMetrics>();
  const bucket = (app: string, feature: string): MutableGroup => {
    const key = `${app}\u0000${feature}`;
    let g = groups.get(key);
    if (!g) { g = { ...emptyMetrics(), app, feature, models: new Set<string>() }; groups.set(key, g); }
    return g;
  };
  const take = (cell: UsageCell): MutableGroup => {
    const g = bucket(cell.app, cell.feature);
    g.models.add(cell.model);
    mergeMetrics(g, cell.m);
    mergeMetrics(global, cell.m);
    let m = models.get(cell.model);
    if (!m) { m = emptyMetrics(); models.set(cell.model, m); }
    mergeMetrics(m, cell.m);
    return g;
  };
  for (const cell of ledgerCells) if (inRange(cell.day)) take(cell);
  for (const contribution of contributions) {
    let touched = false;
    for (const cell of contribution.cells.values()) {
      if (!inRange(cell.day)) continue;
      take(cell);
      touched = true;
    }
    if (touched) { bucket(contribution.app, contribution.feature).sessions++; global.sessions++; }
  }
  const totalCost = global.pricedAny ? global.costTotal : undefined;
  const totals = publicMetrics(global);
  const rows = (mode: DeepSeekGroupBy) => groupRows(groups, mode, totals.totalTokens, totals.weightedTokens, totalCost);
  return {
    global,
    view: {
      id: range.id, label: range.label,
      ...(from ? { from } : {}), ...(to ? { to } : {}),
      totals,
      groups: { app: rows("app"), "app-feature": rows("app-feature"), feature: rows("feature") },
      models: [...models.entries()].map(([model, m]) => {
        const priced = !!DEEPSEEK_PRICES[deepSeekModelId(model)];
        const cost = publicMetrics(m).cost;
        return {
          model, label: DEEPSEEK_PRICES[deepSeekModelId(model)]?.label ?? model, priced,
          calls: m.calls, totalTokens: m.totalTokens, unpricedTokens: m.unpricedTokens,
          ...(cost ? { cost } : {})
        };
      }).sort((a, b) => b.totalTokens - a.totalTokens)
    }
  };
}

const VIEW_NOTES = [
  "渠道由应用-功能组成；Pi 会话按启动入口归到普通会话、群聊或会话对比；从待办发起的会话与推荐任务执行都算「会话-对话」。",
  "只统计本机记录，不是 DeepSeek 服务商账单；本机卸装、数据目录被清理或 runtime 未报告用量都会让数字偏小。",
  "今日 / 昨日 / 近 7 天 / 近 30 日按本机时区的自然日切分（近 N 天含今天）；Pi 会话按每条请求的消息时间归日，平台账本按调用时间归日。",
  "没有可靠时间的用量（旧版 runtime 的累计快照、缺时间的历史审计）只进「累计」，不会被硬塞进某一天，所以各时间窗之和可能小于累计。",
  "总 token 包含缓存命中的 prompt token（每轮重发的上下文都算一次），所以长上下文会话的 token 会远高于真实写入量。",
  "计价 token = 输入 + 输出 × 输出价/输入价 + 缓存读 × 缓存读价/输入价；用于跨渠道比较花费，不改变各字段的原始计数。表格按计价 token 倒序。",
  "金额是按 Pi 模型表单价反算的估算（USD / 每百万 token），并按调用发生时刻区分峰谷：波谷价是峰时 5 折，缓存读写与输出同样打折。",
  `峰时规则：${PEAK_RULE_TEXT}。价格表以 USD 计，未做人民币汇率换算；实际扣费以 DeepSeek 服务商账单为准。`,
  "没有可靠发生时间的用量（累计快照）按峰时价保守估算，不计入「错峰已省」与「还能省」。",
  "「错峰已省」= 波谷调用相对峰时价已经少付的钱；「还能省」= 仍落在峰时的调用全部改到波谷可再少的钱。",
  "失败调用若 runtime 没有报告用量，只计调用次数，不按 0 元估算。",
  "平台功能调用从本版本起实时记账；升级前的会话标题、快捷回复、待办分类/推荐审计在首次启动时导入一次。",
  "子 Agent 的 DeepSeek 消耗同样计入；这里不沿用会话统计卡片「子 Agent 单列」的展示口径。"
];

function buildView(ledgerCells: Iterable<UsageCell>, contributions: SessionContribution[], meta: ViewMeta): DeepSeekUsageView {
  const cells = [...ledgerCells];
  const ranges = {} as Record<DeepSeekRangeId, DeepSeekRangeView>;
  let all: MutableMetrics | undefined;
  for (const range of DEEPSEEK_RANGES) {
    const built = buildRange(range, meta.today, cells, contributions);
    ranges[range.id] = built.view;
    if (range.id === "all") all = built.global;
  }
  const total = ranges.all;
  return {
    generatedAt: meta.now.toISOString(),
    timeZone: meta.timeZone,
    today: meta.today,
    scope: "本机记录（平台账本 + Pi 受管会话）",
    defaultGroupBy: "app",
    totals: total.totals,
    groups: total.groups,
    models: total.models,
    ranges,
    rangeOrder: DEEPSEEK_RANGES.map((r) => r.id),
    coverage: {
      runtimeSessions: meta.runtimeSessions,
      runtimeSessionsWithDeepSeek: contributions.length,
      ledgerCalls: meta.ledgerCalls,
      callsWithoutUsage: all?.callsWithoutUsage ?? 0,
      ...(meta.ledgerSince ? { ledgerSince: meta.ledgerSince } : {})
    },
    price: {
      ...DEEPSEEK_PRICE_INFO,
      peakRule: PEAK_RULE_TEXT,
      offPeakFactor: OFF_PEAK_FACTOR,
      models: Object.entries(DEEPSEEK_PRICES).map(([id, p]) => ({
        id, ...p,
        offPeak: {
          input: p.input * OFF_PEAK_FACTOR, output: p.output * OFF_PEAK_FACTOR,
          cacheRead: p.cacheRead * OFF_PEAK_FACTOR, cacheWrite: p.cacheWrite * OFF_PEAK_FACTOR
        }
      }))
    },
    notes: VIEW_NOTES
  };
}

function ledgerMeta(entries: Iterable<DeepSeekUsageEntry>): { calls: number; since?: string } {
  let calls = 0;
  let since: string | undefined;
  for (const entry of entries) {
    calls += Math.max(0, finite(entry.calls) || 1);
    if (!since || entry.at < since) since = entry.at;
  }
  return { calls, ...(since ? { since } : {}) };
}

/** 汇总账本 + Pi 受管会话，得到各时间窗、应用/功能聚合视图（无缓存的纯函数版本）。 */
export function summarizeDeepSeekUsage(input: {
  ledger: DeepSeekUsageEntry[];
  sessions?: DeepSeekRuntimeSession[];
  now?: Date;
  timeZone?: string;
}): DeepSeekUsageView {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dayOf = dayKeyFactory(timeZone);
  const ledgerCells = new Map<string, UsageCell>();
  for (const entry of input.ledger) addLedgerEntry(ledgerCells, entry, dayOf);
  const sessions = input.sessions ?? [];
  const contributions = sessions.map((s) => sessionContribution(s, dayOf)).filter((c): c is SessionContribution => !!c);
  const meta = ledgerMeta(input.ledger);
  return buildView(ledgerCells.values(), contributions, {
    now, timeZone, today: dayOf(now.getTime()), runtimeSessions: sessions.length,
    ledgerCalls: meta.calls, ...(meta.since ? { ledgerSince: meta.since } : {})
  });
}

/**
 * 带缓存的增量统计：
 * - 账本是追加式文件，只读上次偏移之后新增的整行，累加进按天的桶；
 * - 每个 Pi 会话的贡献按「渠道 + 记录条数 + 最后一条记录」指纹缓存，没变的会话不重算；
 * - 调用方给出一个廉价的 signature（runtime 用量文件的 mtime/size 等），和上次相同且仍是同一天就直接返回上次的视图，
 *   连 usage.json（十几 MB）都不用重新读取。
 */
export class DeepSeekUsageTracker {
  private offset = 0;
  private readonly ledgerCells = new Map<string, UsageCell>();
  private ledgerCalls = 0;
  private ledgerSince: string | undefined;
  private readonly sessionCache = new Map<string, { fingerprint: string; contribution: SessionContribution | undefined }>();
  private cached: { key: string; view: DeepSeekUsageView } | undefined;
  private dayOf: (ms: number) => string;
  private zone: string;

  constructor(private readonly file: string, timeZone?: string) {
    this.zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.dayOf = dayKeyFactory(this.zone);
  }

  private resetLedger(): void {
    this.offset = 0; this.ledgerCells.clear(); this.ledgerCalls = 0; this.ledgerSince = undefined;
  }

  private ledgerSize(): number {
    try { return statSync(this.file).size; } catch { return 0; }
  }

  /** 只读账本新增的整行；文件变小（被清理 / 重建）时整体重读。 */
  private syncLedger(): void {
    const size = this.ledgerSize();
    if (size < this.offset) this.resetLedger();
    if (size === this.offset) return;
    const buffer = Buffer.alloc(size - this.offset);
    let fd: number | undefined;
    try {
      fd = openSync(this.file, "r");
      const read = readSync(fd, buffer, 0, buffer.length, this.offset);
      const end = buffer.subarray(0, read).lastIndexOf(0x0a);
      if (end < 0) return; // 最后一行还没写完，下次再读
      for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as DeepSeekUsageEntry;
          if (!entry || typeof entry !== "object" || !isDeepSeekModel(entry.model)) continue;
          addLedgerEntry(this.ledgerCells, entry, this.dayOf);
          this.ledgerCalls += Math.max(0, finite(entry.calls) || 1);
          if (!this.ledgerSince || entry.at < this.ledgerSince) this.ledgerSince = entry.at;
        } catch { /* 跳过坏行 */ }
      }
      this.offset += end + 1;
    } catch { /* 读不到账本时沿用已有的累计 */ }
    finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
  }

  /**
   * 统计应用用的按日明细：账本里的平台调用（发起端「自动」、runtime pi）+ 受管会话的 DeepSeek 用量
   * （发起端由 deviceOf 按请求时刻所在轮次解析）。金额与资源页同口径；没有可靠发生时间的累计用量不进按日明细。
   */
  dailyRows(input: { sessions: () => DeepSeekRuntimeSession[]; deviceOf?: DeepSeekDeviceOf }): DeepSeekDailyRow[] {
    this.syncLedger();
    let sessions: DeepSeekRuntimeSession[] = [];
    try { sessions = input.sessions(); } catch { /* 读不到会话用量时仍给平台账本 */ }
    const cells: UsageCell[] = [...this.ledgerCells.values()];
    for (const session of sessions) cells.push(...(sessionContribution(session, this.dayOf, input.deviceOf)?.cells.values() ?? []));
    const rows: DeepSeekDailyRow[] = [];
    for (const cell of cells) {
      if (cell.day === UNDATED || !cell.m.totalTokens && !cell.m.calls) continue;
      rows.push({
        day: cell.day, app: cell.app, feature: cell.feature, runtime: cell.runtime ?? "pi", device: cell.device ?? "auto",
        tokens: cell.m.totalTokens, usd: cell.m.pricedAny ? cell.m.costTotal : 0, calls: cell.m.calls, partial: cell.m.unpricedTokens > 0
      });
    }
    return rows;
  }

  view(input: { sessions: () => DeepSeekRuntimeSession[]; signature?: string; now?: Date }): DeepSeekUsageView {
    const now = input.now ?? new Date();
    const today = this.dayOf(now.getTime());
    const key = input.signature === undefined ? undefined : `${input.signature}|${this.ledgerSize()}|${today}`;
    if (key !== undefined && this.cached?.key === key) return this.cached.view;
    this.syncLedger();
    // 读不到会话用量时仍显示平台账本（不能让资源页整页失败），且这次结果不缓存，下次重试。
    let sessions: DeepSeekRuntimeSession[] = [];
    let loaded = true;
    try { sessions = input.sessions(); } catch { loaded = false; }
    const live = new Set<string>();
    const contributions: SessionContribution[] = [];
    for (const session of sessions) {
      const id = session.binding.platformSessionId;
      live.add(id);
      const last = session.records[session.records.length - 1];
      const channel = runtimeDeepSeekChannel(session.binding);
      const fingerprint = `${channel.app}|${channel.feature}|${session.binding.effectiveModel ?? ""}|${session.records.length}|${last?.requestId ?? last?.sourceRef ?? ""}|${last?.sampledAt ?? ""}|${last?.total ?? ""}`;
      let entry = this.sessionCache.get(id);
      if (!entry || entry.fingerprint !== fingerprint) {
        entry = { fingerprint, contribution: sessionContribution(session, this.dayOf) };
        this.sessionCache.set(id, entry);
      }
      if (entry.contribution) contributions.push(entry.contribution);
    }
    if (loaded) for (const id of this.sessionCache.keys()) if (!live.has(id)) this.sessionCache.delete(id);
    const view = buildView(this.ledgerCells.values(), contributions, {
      now, timeZone: this.zone, today, runtimeSessions: sessions.length,
      ledgerCalls: this.ledgerCalls, ...(this.ledgerSince ? { ledgerSince: this.ledgerSince } : {})
    });
    if (key !== undefined && loaded) this.cached = { key, view };
    return view;
  }
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/* ------------------------------ 历史审计导入 ------------------------------ */

function usageFrom(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; reported: boolean } {
  if (!value || typeof value !== "object") return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reported: false };
  const u = value as Record<string, unknown>;
  return {
    input: finite(u["input"]), output: finite(u["output"]),
    cacheRead: finite(u["cacheRead"]), cacheWrite: finite(u["cacheWrite"]), reported: true
  };
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

function mtimeOf(file: string): string {
  try { return statSync(file).mtime.toISOString(); } catch { return new Date(0).toISOString(); }
}

/**
 * 升级前的平台用量来自三处持久审计：
 * - runtime/audit.jsonl：会话标题、快捷回复（带时间）；
 * - note-categories.json：待办分类；
 * - note-iterations.json：开发判定、推荐整理/审查。
 * 旧审计不一定带时间，缺少时用文件修改时间占位，并在导入标记里保留来源，方便核对。
 */
export function readLegacyDeepSeekUsage(dataDir: string): DeepSeekUsageEntry[] {
  const out: DeepSeekUsageEntry[] = [];
  const runtimeAudit = join(dataDir, "runtime", "audit.jsonl");
  if (existsSync(runtimeAudit)) {
    for (const line of readFileSync(runtimeAudit, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const type = entry["type"];
      if (type !== "session-title-generation" && type !== "quick-reply-generation") continue;
      const model = typeof entry["model"] === "string" ? entry["model"] : "deepseek-flash";
      if (!isDeepSeekModel(model)) continue;
      const usage = usageFrom(entry["usage"]);
      if (!usage.reported) continue;
      const channel = type === "session-title-generation" ? ROLE_CHANNELS.sessionTitle! : ROLE_CHANNELS.quickReply!;
      const attempts = Array.isArray(entry["attempts"]) ? entry["attempts"].length : 1;
      out.push({
        at: typeof entry["at"] === "string" ? entry["at"] : mtimeOf(runtimeAudit),
        app: channel.app, feature: channel.feature, source: String(type),
        model, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        calls: Math.max(1, attempts), usageReported: true, ok: entry["ok"] === true
      });
    }
  }

  const categoriesFile = join(dataDir, "note-categories.json");
  const categories = readJson(categoriesFile) as { jobs?: Record<string, { audit?: Array<Record<string, unknown>> }> } | undefined;
  for (const job of Object.values(categories?.jobs ?? {})) {
    for (const audit of Array.isArray(job.audit) ? job.audit : []) {
      const config = (audit["config"] ?? {}) as Partial<RoleModelConfig>;
      if (!isDeepSeekModel(config.model ?? "deepseek-flash")) continue;
      const usage = usageFrom(audit["usage"]);
      if (!usage.reported) continue;
      const channel = deepSeekChannelOf({ role: config.role ?? "noteCategory", promptVersion: config.promptVersion ?? "" });
      out.push({
        at: typeof audit["at"] === "string" ? audit["at"] : mtimeOf(categoriesFile),
        app: channel.app, feature: channel.feature, source: String(config.role ?? "noteCategory"), model: config.model ?? "deepseek-flash",
        input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        calls: Math.max(1, Array.isArray(audit["attempts"]) ? audit["attempts"].length : 1), usageReported: true
      });
    }
  }

  const iterationsFile = join(dataDir, "note-iterations.json");
  const iterations = readJson(iterationsFile) as { audit?: Array<Record<string, unknown>> } | undefined;
  for (const audit of Array.isArray(iterations?.audit) ? iterations.audit : []) {
    const config = (audit["config"] ?? {}) as Partial<RoleModelConfig>;
    if (!isDeepSeekModel(config.model ?? "deepseek-flash")) continue;
    const usage = usageFrom(audit["usage"]);
    if (!usage.reported) continue;
    const channel = deepSeekChannelOf({ role: config.role ?? "noteIteration", promptVersion: config.promptVersion ?? "" });
    out.push({
      at: typeof audit["at"] === "string" ? audit["at"] : mtimeOf(iterationsFile),
      app: channel.app, feature: channel.feature, source: String(config.role ?? "noteIteration"), model: config.model ?? "deepseek-flash",
      input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
      calls: Math.max(1, Array.isArray(audit["attempts"]) ? audit["attempts"].length : 1), usageReported: true
    });
  }
  return out;
}
