/**
 * 待定日程（v3.121）：「每 90 天续费一次」这种周期安排，用户没说上次是哪天，模型不许编造日期。
 *
 * 这时不是把日程降级成待办，而是记成「日程 · 待定时间」：留下已知的周期、平台推算一个候选首次日期，
 * 等用户补一句（或一键采用候选日期）再转成真正的日程。这里放三件与平台策略有关的小事：
 * 候选日期怎么推、周期怎么念、补上日期后用哪条提醒规则。
 */
import { beijingDateKey } from "./platform-time.js";
import { normalizeNoteRepeat } from "./notes.js";
import type { NoteRemind, NoteRepeat, NoteSchedule, NoteSchedulePending } from "./notes.js";

/** 周期用一句话说清楚：每 90 天 / 每 2 周 / 每 3 个月 / 每 2 年。 */
export function pendingRepeatLabel(repeat: NoteRepeat | undefined): string {
  if (!repeat) return "";
  const interval = repeat.interval ?? 1;
  if (repeat.lunar) return repeat.freq === "yearly" ? "每年（农历）" : "每月（农历）";
  const unit = repeat.freq === "daily" ? "天" : repeat.freq === "weekly" ? "周" : repeat.freq === "monthly" ? "个月" : "年";
  return interval === 1 ? `每${unit}` : `每 ${interval} ${unit}`;
}

/**
 * 候选首次日期：从记录日往后推一个周期（每 90 天 → 记录日 + 90 天）。
 * 模型能给出明确候选时用模型的；这里的推算只解决「一个字的时间都没说」。
 */
export function pendingScheduleSuggest(repeat: NoteRepeat | undefined, now: Date = new Date()): string {
  const today = beijingDateKey(now);
  const day = new Date(`${today}T00:00:00Z`);
  const interval = Math.max(1, repeat?.interval ?? 1);
  if (repeat?.freq === "weekly") day.setUTCDate(day.getUTCDate() + interval * 7);
  else if (repeat?.freq === "monthly") day.setUTCMonth(day.getUTCMonth() + interval);
  else if (repeat?.freq === "yearly") day.setUTCFullYear(day.getUTCFullYear() + interval);
  else day.setUTCDate(day.getUTCDate() + interval);
  return day.toISOString().slice(0, 10);
}

/** 补上日期时的提醒：周期事项默认提前 1 天（全天日程按当天 09:00 往前推）。 */
export const PENDING_SCHEDULE_REMIND: NoteRemind = { offsets: [1440], source: "inferred", scene: "renewal" };

/**
 * 待定日程 + 一个起算日期 → 真正的日程（全天，沿用已知周期与默认提醒）。
 * 日期只接受 YYYY-MM-DD：待定日程只知道「大概哪一天」，不猜几点。
 * 用户给的是「上一次」这种已经过去的日期时，按周期推到现在（往后到第一个不早于今天的日子），
 * 否则补出来的日程一保存就是过期状态、也不会提醒。
 */
export function scheduleFromPending(pending: NoteSchedulePending, day: string, now: Date = new Date()): NoteSchedule {
  const start = advanceToToday(day, pending.repeat, now);
  return {
    start,
    allDay: true,
    ...(pending.repeat ? { repeat: normalizeNoteRepeat(pending.repeat) } : {}),
    remind: { ...PENDING_SCHEDULE_REMIND, offsets: [...PENDING_SCHEDULE_REMIND.offsets] }
  };
}

/** 按周期往后推到第一个不早于今天的日子（最多推 5000 次，防坏规则死循环）。 */
function advanceToToday(day: string, repeat: NoteRepeat | undefined, now: Date): string {
  const today = beijingDateKey(now);
  if (!repeat || day >= today) return day;
  const interval = Math.max(1, repeat.interval ?? 1);
  const cursor = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(cursor.getTime())) return day;
  for (let i = 0; i < 5000 && cursor.toISOString().slice(0, 10) < today; i++) {
    if (repeat.freq === "weekly") cursor.setUTCDate(cursor.getUTCDate() + interval * 7);
    else if (repeat.freq === "monthly") cursor.setUTCMonth(cursor.getUTCMonth() + interval);
    else if (repeat.freq === "yearly") cursor.setUTCFullYear(cursor.getUTCFullYear() + interval);
    else cursor.setUTCDate(cursor.getUTCDate() + interval);
  }
  return cursor.toISOString().slice(0, 10);
}

/** 说明文案（页面与推送共用）：告诉用户还差什么、按什么周期。 */
export function pendingScheduleHint(pending: NoteSchedulePending): string {
  if (pending.hint) return pending.hint;
  const every = pendingRepeatLabel(pending.repeat);
  return every ? `${every}一次，还差第一次的日期` : "日程还差一个日期";
}
