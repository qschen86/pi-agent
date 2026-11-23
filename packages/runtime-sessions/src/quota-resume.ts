import type { RateLimitSnapshot, RuntimeKind } from "./types.js";

type RateLimitWindow = RateLimitSnapshot["windows"][number];

/** 额度窗口重置后多等一会儿再发：服务端重置时间和本机时钟、额度接口刷新都有误差。 */
export const QUOTA_RESUME_MARGIN_MS = 60_000;
/** 查不到重置时间时的兜底间隔：过一会儿再试一次。 */
export const QUOTA_RESUME_FALLBACK_MS = 30 * 60_000;
/** 被额度打断的轮次连续自动继续多少次仍没有一轮正常结束，就不再自动安排，交还给人。 */
export const QUOTA_RESUME_MAX_STREAK = 8;
/** 用掉 ≥ 这个比例就当作窗口已耗尽。 */
const EXHAUSTED = 99;

export const QUOTA_RESUME_PROMPT = "额度已恢复（平台自动继续，无需人工）。请从刚才因额度中断的地方继续推进：先简单核对当前进度，已经完成的部分不用重做，然后接着做完。";

export interface QuotaResumePlan {
  /** 应当重试的时刻（毫秒时间戳，已含余量） */
  at: number;
  /** 给人看的依据，例如「5 小时窗口」「重置时间未知，30 分钟后重试」 */
  window: string;
  /** at 来自真实的窗口重置时间 */
  known: boolean;
}

export interface QuotaModelFilter {
  runtimeKind?: RuntimeKind;
  model?: string;
  modelLabel?: string;
}

export interface PlanQuotaResumeOptions extends QuotaModelFilter {
  /** 本轮额度报错正文：快照尚无耗尽窗口时，可回退解析其中的 `Resets in 2h24m19s` */
  reason?: string;
}

/**
 * 按会话模型过滤分池额度窗口（目前用于 Antigravity 多模型组）：
 * - 快照没有 group（如 Codex / Claude）或未提供模型时原样返回；
 * - 规则与前端 `rtQuotaForModel` 保持一致，避免无关模型组（例如满额的 Gemini 4 Argon）拖延当前模型自动续聊。
 */
export function filterQuotaWindowsForModel(
  snapshot: Pick<RateLimitSnapshot, "windows"> | undefined,
  filter?: QuotaModelFilter
): RateLimitWindow[] {
  const windows = snapshot?.windows ?? [];
  if (!windows.length || !windows.some((w) => w.group)) return windows;
  if (filter?.runtimeKind && filter.runtimeKind !== "antigravity") return windows;
  const raw = filter?.model?.trim();
  if (!raw) return windows;
  const id = raw.toLowerCase().split("/").pop() ?? "";
  const tag = `${id} ${(filter?.modelLabel ?? "").toLowerCase()}`;
  const groupNames = [...new Set(windows.map((w) => w.group).filter((g): g is string => !!g))];
  const base = groupNames.find((g) => /gemini/i.test(g) && !/argon/i.test(g));
  const matched = /^(claude|gpt)(?:-|$)/.test(id)
    ? groupNames.find((g) => /claude|gpt/i.test(g))
    : /^(gemini|orchestrator)(?:-|$)/.test(id)
      ? (/argon|g1-pro/.test(tag) ? groupNames.find((g) => /argon/i.test(g)) ?? base : base)
      : undefined;
  return matched ? windows.filter((w) => w.group === matched) : [];
}

/** 解析额度报错里的相对重置倒计时（如 `Resets in 2h24m19s`），返回目标毫秒时间戳。 */
export function parseQuotaResetHint(reason: string | undefined, now = Date.now()): number | undefined {
  if (!reason) return undefined;
  const match = /\bresets?\s+in\s+((?:\d+\s*[dhms]\s*)+)/i.exec(reason);
  if (!match) return undefined;
  let totalMs = 0;
  for (const part of match[1]!.matchAll(/(\d+)\s*([dhms])/gi)) {
    const value = Number(part[1]);
    const unit = part[2]!.toLowerCase();
    totalMs += value * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000);
  }
  return totalMs > 0 ? now + totalMs : undefined;
}

/**
 * 从额度快照里决定下一次重试时间：
 * - 先按当前会话模型过滤分池窗口；
 * - 有窗口已用尽（5 小时、周窗口可能同时用尽）→ 等到它们全部重置，即最晚的重置时间；
 * - 没有比例但窗口带重置时间（Claude 的 rate_limit_event 经常如此）→ 取最早的未来重置时间；
 * - 若快照里没有可用窗口但报错正文给了重置倒计时（如 Antigravity 的 `Resets in 2h24m19s`）→ 按提示时刻加余量；
 * - 都没有 → 半小时后再试。
 * 已经过了重置时间的窗口不再算数（快照可能是重置前采的）。
 */
export function planQuotaResume(
  snapshot: Pick<RateLimitSnapshot, "windows"> | undefined,
  now = Date.now(),
  options?: PlanQuotaResumeOptions
): QuotaResumePlan {
  const future = filterQuotaWindowsForModel(snapshot, options).flatMap((w) => {
    const t = Date.parse(w.resetsAt ?? "");
    return Number.isFinite(t) && t > now ? [{ ...w, t }] : [];
  });
  const exhausted = future.filter((w) => w.usedPercent != null && w.usedPercent >= EXHAUSTED);
  if (exhausted.length) return { at: Math.max(...exhausted.map((w) => w.t)) + QUOTA_RESUME_MARGIN_MS, window: exhausted.map((w) => w.label).join("、"), known: true };
  const unknown = future.filter((w) => w.usedPercent == null);
  if (unknown.length) {
    const w = unknown.reduce((a, b) => (b.t < a.t ? b : a));
    return { at: w.t + QUOTA_RESUME_MARGIN_MS, window: w.label, known: true };
  }
  const hinted = parseQuotaResetHint(options?.reason, now);
  if (hinted !== undefined) return { at: hinted + QUOTA_RESUME_MARGIN_MS, window: "当前模型额度窗口", known: true };
  return { at: now + QUOTA_RESUME_FALLBACK_MS, window: "重置时间未知，稍后重试", known: false };
}

/** 快照里是否还有「已耗尽且尚未重置」的窗口（按当前会话模型分组过滤）：有则返回它们最晚的重置时间。 */
export function stillExhaustedUntil(
  snapshot: Pick<RateLimitSnapshot, "windows"> | undefined,
  now = Date.now(),
  filter?: QuotaModelFilter
): number | undefined {
  const ts = filterQuotaWindowsForModel(snapshot, filter).flatMap((w) => {
    const t = Date.parse(w.resetsAt ?? "");
    return w.usedPercent != null && w.usedPercent >= EXHAUSTED && Number.isFinite(t) && t > now ? [t] : [];
  });
  return ts.length ? Math.max(...ts) : undefined;
}
