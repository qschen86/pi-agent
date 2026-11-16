import type { RateLimitSnapshot } from "./types.js";

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

/**
 * 从额度快照里决定下一次重试时间：
 * - 有窗口已用尽（5 小时、周窗口可能同时用尽）→ 等到它们全部重置，即最晚的重置时间；
 * - 没有比例但窗口带重置时间（Claude 的 rate_limit_event 经常如此）→ 取最早的未来重置时间；
 * - 都没有 → 半小时后再试。
 * 已经过了重置时间的窗口不再算数（快照可能是重置前采的）。
 */
export function planQuotaResume(snapshot: Pick<RateLimitSnapshot, "windows"> | undefined, now = Date.now()): QuotaResumePlan {
  const future = (snapshot?.windows ?? []).flatMap((w) => {
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
  return { at: now + QUOTA_RESUME_FALLBACK_MS, window: "重置时间未知，稍后重试", known: false };
}

/** 快照里是否还有「已耗尽且尚未重置」的窗口：有则返回它们最晚的重置时间。 */
export function stillExhaustedUntil(snapshot: Pick<RateLimitSnapshot, "windows"> | undefined, now = Date.now()): number | undefined {
  const ts = (snapshot?.windows ?? []).flatMap((w) => {
    const t = Date.parse(w.resetsAt ?? "");
    return w.usedPercent != null && w.usedPercent >= EXHAUSTED && Number.isFinite(t) && t > now ? [t] : [];
  });
  return ts.length ? Math.max(...ts) : undefined;
}
