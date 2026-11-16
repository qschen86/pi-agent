/**
 * 平台统一时间口径：日历、定时任务和「新建日程」的时间都以北京时间为准。
 *
 * 中国不实行夏令时，固定 UTC+8；不依赖宿主机或浏览器所在时区。
 * Google / iCloud 事件仍按各自的时区解析成绝对时刻，展示时再换算到北京时间。
 */
export const PLATFORM_TIME_ZONE = "Asia/Shanghai";
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface BeijingParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = 周日 … 6 = 周六 */
  weekday: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 绝对时刻 → 北京时间墙上时间的各字段（用 UTC 字段承载，避免再受本机时区影响）。 */
export function beijingParts(value: Date | number | string = new Date()): BeijingParts | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay()
  };
}

/** 北京日期键 YYYY-MM-DD（例如把 UTC 2026-10-22T16:00Z 归到北京 2026-10-23）。 */
export function beijingDateKey(value: Date | number | string = new Date()): string {
  const parts = beijingParts(value);
  return parts ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` : "";
}

/** 「记于 2026-10-19 09:35」这类北京时间戳，与待办页 noteStamp 同格式。 */
export function beijingStamp(value: Date | number | string): string {
  const parts = beijingParts(value);
  return parts ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}` : "";
}

/** 某天的北京时间零点对应的绝对时刻；用于全天日程 / 截止时间比较。 */
export function beijingDayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00+08:00`);
}

/** 北京时间「今天」的 hour:minute 对应的绝对时刻。 */
export function beijingRunToday(now: Date, hour: number, minute = 0): Date {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour, minute, 0, 0) - BEIJING_OFFSET_MS);
}

/** 下一次北京时间 hour:minute；已经过点就排到第二天（正好到点也算下一天，避免重复触发）。 */
export function nextBeijingRunAt(now: Date = new Date(), hour = 3, minute = 0): Date {
  const today = beijingRunToday(now, hour, minute);
  if (today.getTime() > now.getTime()) return today;
  return new Date(today.getTime() + 86_400_000);
}
