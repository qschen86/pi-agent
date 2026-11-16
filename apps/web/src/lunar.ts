/**
 * 中国农历（北京时间日历日）：公历 ↔ 农历换算与农历周期日程的展开。
 *
 * 不带历法数据表：直接用运行时自带的 `Intl`（ICU 的 chinese 历法）逐月定位初一，结果按月缓存。
 * 前端 notes-shared.js 里有一份同口径的镜像（页面只需要日期 → 农历，以及过期判断），
 * 两边的结果由 test/lunar.test.ts 对照。
 *
 * 周期规则（NoteRepeat.lunar）：
 * - 每年（freq=yearly）：lunar.month（1–12，冬月 = 11，腊月 = 12）+ lunar.days，可选 leap=true 只认闰月；
 * - 每月（freq=monthly）：只有 lunar.days，每个农历月（含闰月）都算，interval 数的是农历月数。
 * 当月没有这一天（小月没有三十）顺延到当月最后一天；闰月规则的年份没有那个闰月就跳过。
 */
import { beijingDateKey } from "./platform-time.js";

export interface LunarRule {
  /** 1–12；每年规则必填，每月规则不能有 */
  month?: number;
  /** 只认闰月（只能配 month） */
  leap?: boolean;
  /** 农历日 1–30，升序不重复 */
  days: number[];
}

export interface LunarDate { year: number; month: number; leap: boolean; day: number }
interface LunarMonth { year: number; month: number; leap: boolean; start: number; length: number }

const DAY_MS = 86_400_000;
/** 第一个农历月（1900 年正月之前的腊月）从这里起算；换算只用到 1900 年之后。 */
const SEED_DAY = Date.UTC(1900, 0, 1) / DAY_MS;
/** 一条规则最多展开多少次、最多走多少个周期（防止异常规则跑飞）。 */
const MAX_OCCURRENCES = 1200;
const MAX_CYCLES = 700;
/** 没有下一次时的哨兵日期：晚于任何 until / 视窗，调用方的循环会自然结束。 */
export const LUNAR_NEVER = "9999-12-31";

const formatter = new Intl.DateTimeFormat("en-u-ca-chinese-nu-latn", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });

const dayNum = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const dayText = (num: number): string => new Date(num * DAY_MS).toISOString().slice(0, 10);

function lunarOfNum(num: number): LunarDate {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(num * DAY_MS)).map((p) => [p.type, p.value]));
  const month = String(parts.month);
  return { year: Number(parts.relatedYear), month: parseInt(month, 10), leap: month.endsWith("bis"), day: Number(parts.day) };
}

/** 公历日（YYYY-MM-DD）→ 农历。 */
export function lunarOf(day: string): LunarDate {
  return lunarOfNum(dayNum(day));
}

const months: LunarMonth[] = [];
const monthIndex = new Map<string, number>();
const monthKey = (year: number, month: number, leap: boolean) => `${year}-${month}${leap ? "L" : ""}`;

function pushMonth(start: number): void {
  const d = lunarOfNum(start);
  monthIndex.set(monthKey(d.year, d.month, d.leap), months.length);
  months.push({ ...d, start, length: lunarOfNum(start + 29).day === 1 ? 29 : 30 });
}

/** 把月表延长到覆盖 `num`（公历日序号）。 */
function extendMonths(num: number): void {
  if (!months.length) pushMonth(SEED_DAY - (lunarOfNum(SEED_DAY).day - 1));
  for (let last = months[months.length - 1]!; last.start + last.length <= num; last = months[months.length - 1]!) pushMonth(last.start + last.length);
}

/** 月表里第 index 个农历月（必要时继续往后补）。 */
function monthAtIndex(index: number): LunarMonth {
  while (index >= months.length) {
    const last = months[months.length - 1]!;
    extendMonths(last.start + last.length);
  }
  return months[index]!;
}

/** 包含 num 的农历月在月表里的位置。 */
function monthAt(num: number): number {
  extendMonths(num);
  let lo = 0, hi = months.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (months[mid]!.start <= num) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function findMonth(year: number, month: number, leap: boolean): LunarMonth | undefined {
  // 正月初一最晚 2 月下旬：补到下一个公历年初，这个农历年的月份就都在表里。
  extendMonths(Date.UTC(year + 2, 0, 1) / DAY_MS);
  const index = monthIndex.get(monthKey(year, month, leap));
  return index === undefined ? undefined : months[index];
}

/** 一个农历月里规则落在哪些日子（公历序号，升序去重）；小月没有的日子顺延到当月最后一天。 */
function monthDays(m: LunarMonth, days: number[]): number[] {
  return [...new Set(days.map((d) => m.start + Math.min(d, m.length) - 1))].sort((a, b) => a - b);
}

function* lunarDays(first: string, repeat: { freq: string; interval?: number; lunar: LunarRule }): Generator<string> {
  const from = dayNum(first);
  const rule = repeat.lunar;
  const interval = repeat.interval ?? 1;
  let yielded = 0;
  if (repeat.freq === "yearly") {
    const cycle = (year: number): number[] => {
      const m = findMonth(year, rule.month!, rule.leap === true);
      return m ? monthDays(m, rule.days) : [];
    };
    let year = lunarOfNum(from).year;
    // 第一个有「不早于 first 的发生」的农历年作为周期起点，之后每 interval 年一次。
    for (let guard = 0; guard < MAX_CYCLES && !cycle(year).some((d) => d >= from); guard++) year++;
    for (let k = 0; k < MAX_CYCLES; k++, year += interval) {
      for (const d of cycle(year)) {
        if (d < from) continue;
        if (++yielded > MAX_OCCURRENCES) return;
        yield dayText(d);
      }
    }
    return;
  }
  let index = monthAt(from);
  for (let guard = 0; guard < MAX_CYCLES && !monthDays(monthAtIndex(index), rule.days).some((d) => d >= from); guard++) index++;
  for (let k = 0; k < MAX_CYCLES; k++, index += interval) {
    for (const d of monthDays(monthAtIndex(index), rule.days)) {
      if (d < from) continue;
      if (++yielded > MAX_OCCURRENCES) return;
      yield dayText(d);
    }
  }
}

interface Sequence { gen: Generator<string>; days: string[]; done: boolean }
const sequences = new Map<string, Sequence>();
const MAX_SEQUENCES = 64;

type LunarRepeat = { freq: string; interval?: number; lunar?: LunarRule };

/** 第 index 次（从 0 开始）发生的公历日：第一次是 first 当天或之后第一个符合规则的日子。没有这一次返回 LUNAR_NEVER。 */
export function lunarRepeatDay(first: string, repeat: LunarRepeat, index: number): string {
  if (!repeat.lunar) return LUNAR_NEVER;
  const key = `${first}|${repeat.freq}|${repeat.interval ?? 1}|${JSON.stringify(repeat.lunar)}`;
  let seq = sequences.get(key);
  if (!seq) {
    if (sequences.size >= MAX_SEQUENCES) sequences.delete(sequences.keys().next().value!);
    seq = { gen: lunarDays(first, { freq: repeat.freq, interval: repeat.interval, lunar: repeat.lunar }), days: [], done: false };
    sequences.set(key, seq);
  }
  while (!seq.done && seq.days.length <= index) {
    const next = seq.gen.next();
    if (next.done) seq.done = true; else seq.days.push(next.value);
  }
  return seq.days[index] ?? LUNAR_NEVER;
}

/** 不早于 from 的第一个符合规则的公历日。 */
export function firstLunarOccurrence(repeat: LunarRepeat, from: string): string {
  return lunarRepeatDay(from, repeat, 0);
}

const MONTH_NAMES = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
const DAY_NAMES = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];

export const lunarMonthName = (month: number, leap = false): string => `${leap ? "闰" : ""}${MONTH_NAMES[month - 1] ?? month}月`;
export const lunarDayName = (day: number): string => DAY_NAMES[day - 1] ?? String(day);

/**
 * 把带农历周期的日程的第一次对齐到真正发生的公历日（宿主算，不让模型换算历法）。
 * notBefore 给了就取 max(日程自己的日子, notBefore) 起往后找；结束时间按同样的天数平移。
 */
export function alignLunarStart<T extends { start?: string; end?: string; allDay?: boolean; repeat?: LunarRepeat }>(schedule: T, notBefore?: string): T {
  const repeat = schedule.repeat;
  if (!repeat?.lunar) return schedule;
  const anchor = schedule.start ?? schedule.end;
  if (!anchor) return schedule;
  const anchorDay = schedule.allDay ? anchor : beijingDateKey(anchor);
  if (!anchorDay) return schedule;
  const target = firstLunarOccurrence(repeat, notBefore && notBefore > anchorDay ? notBefore : anchorDay);
  if (target === LUNAR_NEVER) return schedule;
  const delta = dayNum(target) - dayNum(anchorDay);
  if (!delta) return schedule;
  const shift = (value: string): string => schedule.allDay
    ? dayText(dayNum(value) + delta)
    : new Date(Date.parse(value) + delta * DAY_MS).toISOString();
  return {
    ...schedule,
    ...(schedule.start ? { start: shift(schedule.start) } : {}),
    ...(schedule.end ? { end: shift(schedule.end) } : {})
  };
}
