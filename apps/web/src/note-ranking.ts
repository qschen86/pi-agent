/**
 * 推荐任务排序算法（策略 v3）。
 *
 * 分工：AI 只给单条待办打价值/难度标签、做语义聚合；排序由这里的确定性公式计算。
 * 每天北京时间 03:00 允许用一小段行为记录校准公式里的少量权重，模型不直接排序，也不改待办。
 * 算法保持简单：价值 ÷ 难度 + 等待时长 + 一次处理条数；权重有明确上下界，便于解释和回滚。
 */
export type RankingValue = "high" | "medium" | "low" | "unknown";
export type RankingDifficulty = "low" | "medium" | "high" | "unknown";

export type RankingWeights = {
  value: Record<RankingValue, number>;
  cost: Record<RankingDifficulty, number>;
  wait: { days: number; max: number };
  size: { per: number; max: number };
};

export type RankingFeatures = {
  value: RankingValue;
  difficulty: RankingDifficulty;
  waitDays: number;
  size: number;
  products?: string[];
};

export type RankingSample = { feedback: number; ignored: number; adopted: number };
export type RankingModel = {
  version: number;
  source: "default" | "learned";
  weights: RankingWeights;
  updatedAt?: string;
  rationale?: string;
  sample?: RankingSample;
  lastError?: string;
};
export type RankingRun = {
  at: string;
  finishedAt?: string;
  date: string;
  feedback: number;
  ignored: number;
  adopted: number;
  from?: RankingWeights;
  to?: RankingWeights;
  rationale?: string;
  usage?: unknown;
  error?: string;
  skipped?: string;
};

/** 默认权重对应策略 v2 的线上公式，升级后排序结果不会突然变化。 */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  value: { high: 3, medium: 2, low: 1, unknown: 1.5 },
  cost: { low: 1, medium: 2, high: 3, unknown: 2 },
  wait: { days: 14, max: 0.6 },
  size: { per: 0.15, max: 0.45 }
};
export const RANKING_VALUE_KEYS: RankingValue[] = ["high", "medium", "low", "unknown"];
export const RANKING_DIFFICULTY_KEYS: RankingDifficulty[] = ["low", "medium", "high", "unknown"];

export const defaultRankingModel = (): RankingModel => ({
  version: 1, source: "default", weights: structuredClone(DEFAULT_RANKING_WEIGHTS)
});

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: unknown, fallback: number, min: number, max: number) =>
  Math.round((finite(value) ? Math.min(max, Math.max(min, value)) : fallback) * 1000) / 1000;

/** 校正模型输出：缺项、非数字、越界都回退到当前值或默认值，绝不让异常权重参与排序。 */
export function sanitizeRankingWeights(candidate: unknown, fallback: RankingWeights = DEFAULT_RANKING_WEIGHTS): RankingWeights {
  const raw = (candidate && typeof candidate === "object" ? candidate : {}) as Record<string, unknown>;
  const value = (raw["value"] && typeof raw["value"] === "object" ? raw["value"] : {}) as Record<string, unknown>;
  const cost = (raw["cost"] && typeof raw["cost"] === "object" ? raw["cost"] : {}) as Record<string, unknown>;
  const wait = (raw["wait"] && typeof raw["wait"] === "object" ? raw["wait"] : {}) as Record<string, unknown>;
  const size = (raw["size"] && typeof raw["size"] === "object" ? raw["size"] : {}) as Record<string, unknown>;
  return {
    value: Object.fromEntries(RANKING_VALUE_KEYS.map((key) => [key, clamp(value[key], fallback.value[key], 0.2, 8)])) as RankingWeights["value"],
    cost: Object.fromEntries(RANKING_DIFFICULTY_KEYS.map((key) => [key, clamp(cost[key], fallback.cost[key], 0.5, 8)])) as RankingWeights["cost"],
    wait: { days: clamp(wait["days"], fallback.wait.days, 1, 60), max: clamp(wait["max"], fallback.wait.max, 0, 3) },
    size: { per: clamp(size["per"], fallback.size.per, 0, 1), max: clamp(size["max"], fallback.size.max, 0, 3) }
  };
}

/** 服务端二次约束：单次校准相对当前权重最多变化 ratio（默认 50%），避免模型一次改动过猛。 */
export function limitRankingChange(next: RankingWeights, base: RankingWeights, ratio = 0.5): RankingWeights {
  const bound = (value: number, previous: number) => {
    const lo = previous > 0 ? previous * (1 - ratio) : 0, hi = previous > 0 ? previous * (1 + ratio) : 1;
    return Math.round(Math.min(hi, Math.max(lo, value)) * 1000) / 1000;
  };
  return {
    value: Object.fromEntries(RANKING_VALUE_KEYS.map((key) => [key, bound(next.value[key], base.value[key])])) as RankingWeights["value"],
    cost: Object.fromEntries(RANKING_DIFFICULTY_KEYS.map((key) => [key, bound(next.cost[key], base.cost[key])])) as RankingWeights["cost"],
    wait: { days: bound(next.wait.days, base.wait.days), max: bound(next.wait.max, base.wait.max) },
    size: { per: bound(next.size.per, base.size.per), max: bound(next.size.max, base.size.max) }
  };
}

export function normalizeRankingModel(value: unknown): RankingModel {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<RankingModel>;
  const source = raw.source === "learned" ? "learned" : "default";
  return {
    version: finite(raw.version) && raw.version > 0 ? Math.floor(raw.version) : 1,
    source,
    weights: sanitizeRankingWeights(raw.weights),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    ...(typeof raw.rationale === "string" && raw.rationale ? { rationale: raw.rationale.slice(0, 500) } : {}),
    ...(raw.sample && typeof raw.sample === "object" ? { sample: { feedback: Math.max(0, Math.floor(Number(raw.sample.feedback) || 0)), ignored: Math.max(0, Math.floor(Number(raw.sample.ignored) || 0)), adopted: Math.max(0, Math.floor(Number(raw.sample.adopted) || 0)) } } : {}),
    ...(typeof raw.lastError === "string" && raw.lastError ? { lastError: raw.lastError.slice(0, 500) } : {})
  };
}

/** 推荐分：价值 ÷ 难度 + 等待加分 + 一次处理条数加分。单项都有上限，分数可解释、可比较。 */
export function recommendationScore(features: RankingFeatures, weights: RankingWeights = DEFAULT_RANKING_WEIGHTS): number {
  const value = weights.value[features.value] ?? DEFAULT_RANKING_WEIGHTS.value[features.value];
  const cost = Math.max(0.25, weights.cost[features.difficulty] ?? DEFAULT_RANKING_WEIGHTS.cost[features.difficulty]);
  const waitDays = Math.max(1, weights.wait.days);
  const wait = Math.min(Math.max(0, features.waitDays) / waitDays, 1) * Math.max(0, weights.wait.max);
  const size = Math.min(Math.max(0, features.size - 1) * Math.max(0, weights.size.per), Math.max(0, weights.size.max));
  return value / cost + wait + size;
}

/* ------------------------------ 北京时间 03:00 ------------------------------ */
import { beijingDateKey, beijingRunToday, nextBeijingRunAt } from "./platform-time.js";
import { dailyBeijingSchedule, registerPlatformScheduledTask } from "./platform-scheduled-tasks.js";

export { beijingDateKey as beijingDate, nextBeijingRunAt };

/** 每天北京时间凌晨 3 点跑一次；服务在 3 点后才启动、当天还没跑过时，启动 5 分钟后补一次。 */
export function startRankingScheduler(options: {
  update: (force?: boolean) => Promise<{ updated: boolean; skipped?: string; error?: string }>;
  isServing: () => Promise<boolean>;
  log?: (message: string) => void;
  now?: () => Date;
  catchUpDelayMs?: number;
}): () => void {
  const now = options.now ?? (() => new Date());
  // 登记到平台定时任务清单：推荐排序校准是平台的存量定时任务，启动后就默认进 Agent 日历。
  registerPlatformScheduledTask({
    id: "note-ranking-calibration",
    schedule: dailyBeijingSchedule(3, 0),
    source: "apps/web/src/note-ranking.ts"
  });
  let timer: NodeJS.Timeout | undefined, catchUp: NodeJS.Timeout | undefined, stopped = false;
  const fire = async () => {
    try {
      if (!(await options.isServing())) { options.log?.("推荐排序：本进程不是当前在线槽位，跳过"); return; }
      const result = await options.update();
      if (result.updated) options.log?.("推荐排序：已根据最近的忽略/启动/完成记录校准算法");
      else if (result.error) options.log?.(`推荐排序校准失败：${result.error}`);
      else options.log?.(`推荐排序：本次跳过${result.skipped ? `（${result.skipped}）` : ""}`);
    } catch (e) { options.log?.(`推荐排序校准失败：${(e as Error).message}`); }
  };
  const schedule = () => {
    if (stopped) return;
    const at = nextBeijingRunAt(now(), 3, 0);
    timer = setTimeout(() => { void fire().finally(schedule); }, Math.max(1_000, at.getTime() - now().getTime()));
    timer.unref?.();
  };
  const current = now();
  const todayAt = beijingRunToday(current, 3, 0);
  if (current.getTime() > todayAt.getTime()) {
    catchUp = setTimeout(() => { void fire(); }, options.catchUpDelayMs ?? 5 * 60_000);
    catchUp.unref?.();
  }
  schedule();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(catchUp); };
}

/** ROI v1: relative utility per conservative engineering hour, never financial ROI. */
export type RoiAssessment = {
  value: RankingValue;
  valueBasis: string;
  effortHours: { min: number; max: number };
  effortBasis: string;
  confidence: 'high' | 'medium' | 'low';
};
export type RoiWeights = { high: number; medium: number };
export const DEFAULT_ROI_WEIGHTS: RoiWeights = { high: 3, medium: 2 };
export const valuePassesFloor = (value: unknown): value is 'high' | 'medium' => value === 'high' || value === 'medium';
export function validRoiAssessment(value: unknown): value is RoiAssessment {
  const a = value as RoiAssessment | undefined;
  return !!a && valuePassesFloor(a.value) && !!a.valueBasis?.trim() && !!a.effortBasis?.trim() && ['high', 'medium'].includes(a.confidence) &&
    finite(a.effortHours?.min) && finite(a.effortHours?.max) && a.effortHours.min > 0 && a.effortHours.max >= a.effortHours.min;
}
export function relativeRecommendationScore(assessment: unknown, weights: RoiWeights = DEFAULT_ROI_WEIGHTS): number | null {
  if (!validRoiAssessment(assessment)) return null;
  return weights[assessment.value as keyof RoiWeights] / assessment.effortHours.max;
}
export function constrainRoiWeights(candidate: unknown, base: RoiWeights): RoiWeights {
  const raw = candidate as RoiWeights | undefined;
  if (!raw || !finite(raw.high) || !finite(raw.medium) || raw.medium <= 0 || raw.high <= raw.medium) throw new Error('无效的投入产出权重');
  const next = { high: Math.min(base.high * 1.1, Math.max(base.high * 0.9, raw.high)), medium: Math.min(base.medium * 1.1, Math.max(base.medium * 0.9, raw.medium)) };
  if (next.high <= next.medium) throw new Error('价值权重顺序无效');
  return next;
}
