/**
 * 平台日历的统一事件形状。
 *
 * 本地日程不是独立存储的实体：有开始 / 结束时间的待办会派生一条事件。
 * 普通待办来源为 pi；平台自动任务记录来源为 agent，人工介入标记不改变归属。
 * Google 日历事件由 `google-calendar.ts` 以只读方式拉取，统一成同一形状后交给页面。
 */
import type { Note, NoteRepeat } from "./notes.js";
import { NOTE_REPEAT_WEEKDAYS, noteAutomation } from "./notes.js";
import { lunarRepeatDay } from "./lunar.js";
import { BEIJING_OFFSET_MS, beijingDayStartMs, beijingParts } from "./platform-time.js";
import { noteRemindOffsetLabel, noteReminderInstant } from "./note-reminder.js";

export type CalendarEventSource = "pi" | "google" | "agent";

export interface CalendarEvent {
  recurringEventId?: string;
  relationRef?: import("./note-relation-types.js").EntryRef;
  relationCount?: number;
  relationRevision?: string;
  /** 本地事件为 `note:<id>`；Google 事件为 Google 事件 id（跨日历可能重复，配合 calendarId 使用） */
  id: string;
  source: CalendarEventSource;
  title: string;
  /** ISO 时间；Google 全天事件为 `YYYY-MM-DD` */
  start: string;
  /** ISO 时间；Google 全天事件为 `YYYY-MM-DD`（Google 的 end.date 是排他日期） */
  end: string;
  allDay?: boolean;
  /** 本地事件对应的待办 id */
  noteId?: string;
  /** 本地待办是否已完成：日程没有完成概念，所以本地日程事件不再带这个字段；保留给旧调用兼容。 */
  done?: boolean;
  /** Google 来源日历 */
  calendarId?: string;
  calendarName?: string;
  htmlLink?: string;
  location?: string;
  description?: string;
  /** Agent 定时任务：应用 / 场景 / 任务名，和标题里的三段一一对应 */
  agentApp?: string;
  agentScene?: string;
  agentName?: string;
  agentPlatform?: string;
  agentStatus?: "active" | "paused" | "unknown";
  needsHuman?: boolean;
  /** 本地日程的提醒：每次日程各自的提醒时刻（提前量见 note.schedule.remind） */
  reminders?: CalendarEventReminder[];
  /** 提醒计划本身（来源与场景），页面详情用 */
  remind?: { offsets: number[]; source: "explicit" | "inferred"; scene: string };
}

export interface CalendarEventReminder {
  /** 提前多少分钟 */
  minutes: number;
  /** 提醒时刻（ISO） */
  at: string;
  /** 说法：提前 1 小时 / 提前 1 天 */
  label: string;
}

function noteEventOrigin(note: Note): Pick<CalendarEvent, "source" | "title" | "needsHuman" | "agentApp" | "agentScene" | "agentName" | "agentPlatform" | "calendarName"> {
  const automation = noteAutomation(note);
  const title = noteEventTitle(note.text);
  if (!automation) return { source: "pi", title };
  return {
    source: "agent", title: automation.needsHuman && !title.startsWith("【需人工介入】") ? `【需人工介入】${title}` : title,
    needsHuman: automation.needsHuman, calendarName: "Agent", agentApp: "平台",
    agentScene: "自动任务记录", agentName: automation.taskId, agentPlatform: "pi-agent"
  };
}

/** 只有一端时间时，日历上按 1 小时的块展示。 */
export const CALENDAR_DEFAULT_DURATION_MS = 60 * 60 * 1000;

/** 待办标题：取正文第一段非空行，太长时截断。 */
export function noteEventTitle(text: string): string {
  const first = String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "待办";
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

/**
 * 待办 → 本地日程。
 *
 * - 只有 start：start 到 start + 1h；
 * - 只有 end：end - 1h 到 end；
 * - 两者都有：按区间；如果历史数据里 end <= start，按 start + 1h 兜底。
 * - repeats 里的每一天各派生一条同日历块：时延沿用 start → end（没有 end 时 1h）；
 * - repeat 是周期安排：第一次照上面的规则，之后按北京时间墙上时间每天 / 每周 / 每月 / 每年推进；
 *   给了 range 时只展开与区间相交的那几次，没有 range 时最多展开两年（until / count 优先）；
 * - 没有可用时间：不形成日程。
 */
export function noteCalendarEvents(note: Note, range?: { from: string; to: string }): CalendarEvent[] {
  // 笔记是想法记录，不进日历（正常不会带时间；旧数据或手工改类型时兜底）。
  if (note.kind === "note" || !note.schedule) return [];
  const repeat = note.schedule.repeat;
  const events = !repeat ? noteBaseEvents(note)
    : note.schedule.allDay ? repeatedAllDayEvents(note, repeat, noteCalendarWindow(range)) : repeatedTimedEvents(note, repeat, noteCalendarWindow(range));
  return withEventReminders(note, events);
}

/** 给每一次日程补上提醒时刻：提醒是日程的一部分，页面与推送都读这里。 */
function withEventReminders(note: Note, events: CalendarEvent[]): CalendarEvent[] {
  const remind = note.schedule?.remind;
  if (!remind) return events;
  return events.map((event) => {
    const allDay = event.allDay === true;
    const dayStart = allDay ? beijingDayStartMs(event.start.slice(0, 10)) : undefined;
    // 只有截止时间的日程按截止提前（「周五 20:30 前」），其余按开始时间。
    const anchor = allDay ? dayStart! : Date.parse(note.schedule?.start ? event.start : event.end);
    const reminders = remind.offsets
      .filter((minutes) => Number.isFinite(anchor))
      .map((minutes) => ({
        minutes,
        at: new Date(noteReminderInstant({ minutes, anchor, allDay, ...(dayStart !== undefined ? { dayStart } : {}) })).toISOString(),
        label: noteRemindOffsetLabel(minutes)
      }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return reminders.length ? { ...event, reminders, remind: { offsets: [...remind.offsets], source: remind.source, scene: remind.scene } } : event;
  });
}

/** 非周期日程：start / end / repeats 各派生一条。 */
function noteBaseEvents(note: Note): CalendarEvent[] {
  if (note.schedule?.allDay) return allDayEvents(note);
  const rawStart = note.schedule?.start ? Date.parse(note.schedule.start) : NaN;
  const rawEnd = note.schedule?.end ? Date.parse(note.schedule.end) : NaN;
  const hasStart = Number.isFinite(rawStart);
  const hasEnd = Number.isFinite(rawEnd);
  if (!hasStart && !hasEnd) return [];
  const start = hasStart ? rawStart : rawEnd - CALENDAR_DEFAULT_DURATION_MS;
  const end = hasEnd && rawEnd > start ? rawEnd : start + CALENDAR_DEFAULT_DURATION_MS;
  const extra = (note.schedule?.repeats ?? [])
    .map((at) => Date.parse(at))
    .filter((at) => Number.isFinite(at) && at > start);
  const starts = [start, ...new Set(extra)].sort((a, b) => a - b);
  return starts.map((at, index) => ({
    id: calendarEventId(note.id, index),
    ...noteEventOrigin(note),
    start: new Date(at).toISOString(),
    end: new Date(at + (end - start)).toISOString(),
    noteId: note.id,
    ...(note.text ? { description: note.text.length > 4000 ? `${note.text.slice(0, 3999)}…` : note.text } : {})
  }));
}

interface CalendarWindow { fromMs: number; toMs: number }
const DAY_MS = 86_400_000;
/** 没有区间、也没给 until / count 时，周期日程最多向前展开两年。 */
const REPEAT_HORIZON_MS = 731 * DAY_MS;
/** 单次展开最多生成多少条（防止异常规则把内存吃满）。 */
const MAX_REPEAT_OCCURRENCES = 1000;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

function noteCalendarWindow(range?: { from: string; to: string }): CalendarWindow | undefined {
  if (!range) return undefined;
  const fromMs = eventTime(range.from), toMs = eventTime(range.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return undefined;
  return { fromMs, toMs };
}

function calendarEventId(noteId: string, index: number): string {
  return index === 0 ? `note:${noteId}` : `note:${noteId}~${index + 1}`;
}

function calendarDescription(note: Note): { description?: string } {
  return note.text ? { description: note.text.length > 4000 ? `${note.text.slice(0, 3999)}…` : note.text } : {};
}

/**
 * 每周重复 + byDay：序号是「匹配到的第几次」（从 0 开始），所以 id、count、过期判断都不用改。
 * 第一次所在的周从周一算起；开始日期不在 byDay 里时它不算一次。
 */
function byDayOffsets(repeat: NoteRepeat): number[] {
  return [...new Set((repeat.byDay ?? []).map((day) => NOTE_REPEAT_WEEKDAYS.indexOf(day)).filter((o) => o >= 0))].sort((a, b) => a - b);
}

/** 北京日期（年 / 月 / 日）是周几，周一 = 0。 */
function weekdayOffset(year: number, month: number, day: number): number {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/** 第 n 次相对第一次所在日期的天数差。 */
function byDayDelta(year: number, month: number, day: number, repeat: NoteRepeat, n: number): number {
  const offsets = byDayOffsets(repeat);
  const a = weekdayOffset(year, month, day);
  const firstWeek = offsets.filter((o) => o >= a);
  if (n < firstWeek.length) return firstWeek[n]! - a;
  const m = n - firstWeek.length;
  return 7 * (repeat.interval ?? 1) * (1 + Math.floor(m / offsets.length)) + offsets[m % offsets.length]! - a;
}

/** 区间起点所在周之前一周的第一个序号：序号是匹配到的第几次，周边界上的序号是精确的，所以有 count 也能直接跳。 */
function byDayStartIndex(year: number, month: number, day: number, repeat: NoteRepeat, fromMs: number): number {
  const offsets = byDayOffsets(repeat);
  const a = weekdayOffset(year, month, day);
  const mondayMs = Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS - a * DAY_MS;
  const week = Math.max(0, Math.floor((fromMs - mondayMs) / (7 * (repeat.interval ?? 1) * DAY_MS)) - 1);
  if (week === 0) return 0;
  return offsets.filter((o) => o >= a).length + (week - 1) * offsets.length;
}

/** 第 index 次（从 0 开始）的绝对时刻：按第一次的北京时间墙上时间推进。 */
function repeatInstant(anchorMs: number, repeat: NoteRepeat, index: number): number {
  const p = beijingParts(anchorMs);
  if (!p) return NaN;
  if (repeat.lunar) {
    const day = lunarRepeatDay(`${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`, repeat, index);
    return Date.parse(`${day}T00:00:00Z`) + (p.hour * 3600 + p.minute * 60 + p.second) * 1000 - BEIJING_OFFSET_MS;
  }
  if (repeat.byDay?.length) return Date.UTC(p.year, p.month - 1, p.day + byDayDelta(p.year, p.month, p.day, repeat, index), p.hour, p.minute, p.second) - BEIJING_OFFSET_MS;
  const step = (repeat.interval ?? 1) * index;
  if (repeat.freq === "daily") return Date.UTC(p.year, p.month - 1, p.day + step, p.hour, p.minute, p.second) - BEIJING_OFFSET_MS;
  if (repeat.freq === "weekly") return Date.UTC(p.year, p.month - 1, p.day + 7 * step, p.hour, p.minute, p.second) - BEIJING_OFFSET_MS;
  return addBeijingMonths(p.year, p.month, p.day, p.hour, p.minute, p.second, (repeat.freq === "monthly" ? step : 12 * step));
}

function addBeijingMonths(year: number, month: number, day: number, hour: number, minute: number, second: number, months: number): number {
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12), m = total - y * 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, last), hour, minute, second) - BEIJING_OFFSET_MS;
}

/** 估算第一次要检查的序号：从区间起点往前退一次，避免从很多年前的第一次开始空转。 */
function repeatStartIndex(anchorMs: number, repeat: NoteRepeat, fromMs: number | undefined): number {
  if (fromMs === undefined || fromMs <= anchorMs || repeat.lunar) return 0;
  if (repeat.byDay?.length) {
    const p = beijingParts(anchorMs);
    return p ? byDayStartIndex(p.year, p.month, p.day, repeat, fromMs) : 0;
  }
  const interval = repeat.interval ?? 1;
  if (repeat.freq === "daily" || repeat.freq === "weekly") {
    const stepMs = (repeat.freq === "daily" ? DAY_MS : 7 * DAY_MS) * interval;
    return Math.max(0, Math.floor((fromMs - anchorMs) / stepMs) - 1);
  }
  const a = beijingParts(anchorMs), f = beijingParts(fromMs);
  if (!a || !f) return 0;
  const stride = (repeat.freq === "monthly" ? 1 : 12) * interval;
  return Math.max(0, Math.floor(((f.year - a.year) * 12 + (f.month - a.month)) / stride) - 1);
}

function repeatUntilMs(repeat: NoteRepeat): number | undefined {
  if (repeat.until === undefined) return undefined;
  return dayPattern.test(repeat.until) ? beijingDayStartMs(repeat.until) + DAY_MS - 1 : Date.parse(repeat.until);
}

function repeatCount(repeat: NoteRepeat): number {
  return Math.min(repeat.count ?? MAX_REPEAT_OCCURRENCES, MAX_REPEAT_OCCURRENCES);
}

function repeatedTimedEvents(note: Note, repeat: NoteRepeat, window: CalendarWindow | undefined): CalendarEvent[] {
  const schedule = note.schedule!;
  const rawStart = schedule.start ? Date.parse(schedule.start) : NaN;
  const rawEnd = schedule.end ? Date.parse(schedule.end) : NaN;
  const hasStart = Number.isFinite(rawStart), hasEnd = Number.isFinite(rawEnd);
  if (!hasStart && !hasEnd) return [];
  const anchorMs = hasStart ? rawStart : rawEnd;
  const endOnly = !hasStart;
  const duration = hasStart && hasEnd && rawEnd > rawStart ? rawEnd - rawStart : CALENDAR_DEFAULT_DURATION_MS;
  const untilMs = repeatUntilMs(repeat);
  const limit = repeatCount(repeat);
  const horizonMs = anchorMs + REPEAT_HORIZON_MS;
  const events: CalendarEvent[] = [];
  const startIndex = repeatStartIndex(anchorMs, repeat, window?.fromMs);
  for (let index = startIndex; index < limit; index++) {
    const at = repeatInstant(anchorMs, repeat, index);
    if (!Number.isFinite(at)) break;
    const start = endOnly ? at - duration : at;
    const end = endOnly ? at : at + duration;
    if (untilMs !== undefined && at > untilMs) break;
    if (window) {
      if (end <= window.fromMs) continue;
      if (start >= window.toMs) break;
    } else if (untilMs === undefined && at > horizonMs) break;
    events.push({
      id: calendarEventId(note.id, index), ...noteEventOrigin(note),
      start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      noteId: note.id, ...calendarDescription(note)
    });
  }
  return events;
}

/** 全天周期日程：第一次占的连续天数沿用不变，之后每次平移到下一个周期。 */
function repeatedAllDayEvents(note: Note, repeat: NoteRepeat, window: CalendarWindow | undefined): CalendarEvent[] {
  const schedule = note.schedule!;
  const startDay = schedule.start && dayPattern.test(schedule.start) ? schedule.start : undefined;
  const endDay = schedule.end && dayPattern.test(schedule.end) ? schedule.end : undefined;
  const first = startDay ?? endDay;
  if (!first) return [];
  const span = startDay && endDay && endDay >= startDay ? dayGap(startDay, endDay) + 1 : 1;
  const untilDay = repeat.until && dayPattern.test(repeat.until) ? repeat.until : undefined;
  const untilMs = untilDay ? beijingDayStartMs(untilDay) + DAY_MS - 1 : undefined;
  const limit = repeatCount(repeat);
  const events: CalendarEvent[] = [];
  const startIndex = repeatDayIndex(first, repeat, window?.fromMs);
  const firstMs = beijingDayStartMs(first);
  const horizonMs = firstMs + REPEAT_HORIZON_MS;
  for (let index = startIndex; index < limit; index++) {
    const day = repeatDay(first, repeat, index);
    const startMs = beijingDayStartMs(day);
    const endDayExclusive = shiftDate(day, span);
    const endMs = beijingDayStartMs(endDayExclusive);
    if (untilDay !== undefined && day > untilDay) break;
    if (window) {
      if (endMs <= window.fromMs) continue;
      if (startMs >= window.toMs) break;
    } else if (untilMs === undefined && startMs > horizonMs) break;
    events.push({
      id: calendarEventId(note.id, index), ...noteEventOrigin(note),
      start: day, end: endDayExclusive, allDay: true, noteId: note.id, ...calendarDescription(note)
    });
  }
  return events;
}

function repeatDay(anchorDay: string, repeat: NoteRepeat, index: number): string {
  if (repeat.lunar) return lunarRepeatDay(anchorDay, repeat, index);
  const [year, month, day] = anchorDay.split("-").map(Number) as [number, number, number];
  if (repeat.byDay?.length) return new Date(Date.UTC(year, month - 1, day + byDayDelta(year, month, day, repeat, index))).toISOString().slice(0, 10);
  const step = (repeat.interval ?? 1) * index;
  if (repeat.freq === "daily" || repeat.freq === "weekly") {
    const shifted = new Date(Date.UTC(year, month - 1, day + (repeat.freq === "daily" ? step : 7 * step)));
    return shifted.toISOString().slice(0, 10);
  }
  const total = year * 12 + (month - 1) + (repeat.freq === "monthly" ? step : 12 * step);
  const y = Math.floor(total / 12), m = total - y * 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

function repeatDayIndex(firstDay: string, repeat: NoteRepeat, fromMs: number | undefined): number {
  const firstMs = beijingDayStartMs(firstDay);
  if (fromMs === undefined || fromMs <= firstMs || repeat.lunar) return 0;
  if (repeat.byDay?.length) {
    const [y, m, d] = firstDay.split("-").map(Number) as [number, number, number];
    return byDayStartIndex(y, m, d, repeat, fromMs);
  }
  const interval = repeat.interval ?? 1;
  if (repeat.freq === "daily" || repeat.freq === "weekly") {
    const stepMs = (repeat.freq === "daily" ? DAY_MS : 7 * DAY_MS) * interval;
    return Math.max(0, Math.floor((fromMs - firstMs) / stepMs) - 1);
  }
  const [year, month] = firstDay.split("-").map(Number) as [number, number];
  const f = beijingParts(fromMs);
  if (!f) return 0;
  const stride = (repeat.freq === "monthly" ? 1 : 12) * interval;
  return Math.max(0, Math.floor(((f.year - year) * 12 + (f.month - month)) / stride) - 1);
}

/** 周期日程最后一次结束时刻；一直重复时返回 undefined（永不过期）。 */
function noteRepeatLastEnd(note: Note, repeat: NoteRepeat): number | undefined {
  const schedule = note.schedule!;
  if (repeat.count === undefined && repeat.until === undefined) return undefined;
  const untilMs = repeatUntilMs(repeat);
  if (schedule.allDay) {
    const startDay = schedule.start && dayPattern.test(schedule.start) ? schedule.start : undefined;
    const endDay = schedule.end && dayPattern.test(schedule.end) ? schedule.end : undefined;
    const first = startDay ?? endDay;
    if (!first) return undefined;
    const span = startDay && endDay && endDay >= startDay ? dayGap(startDay, endDay) + 1 : 1;
    const lastIndex = repeat.count !== undefined ? repeat.count - 1 : repeatLastIndex(first, repeat, untilMs!);
    if (lastIndex < 0) return undefined;
    return beijingDayStartMs(shiftDate(repeatDay(first, repeat, lastIndex), span));
  }
  const rawStart = schedule.start ? Date.parse(schedule.start) : NaN;
  const rawEnd = schedule.end ? Date.parse(schedule.end) : NaN;
  const hasStart = Number.isFinite(rawStart), hasEnd = Number.isFinite(rawEnd);
  if (!hasStart && !hasEnd) return undefined;
  const anchorMs = hasStart ? rawStart : rawEnd;
  const duration = hasStart && hasEnd && rawEnd > rawStart ? rawEnd - rawStart : CALENDAR_DEFAULT_DURATION_MS;
  let lastIndex: number;
  if (repeat.count !== undefined) lastIndex = repeat.count - 1;
  else {
    const startIndex = repeatStartIndex(anchorMs, repeat, untilMs);
    lastIndex = startIndex - 1;
    for (let index = startIndex; index < MAX_REPEAT_OCCURRENCES * 20; index++) {
      if (repeatInstant(anchorMs, repeat, index) > untilMs!) break;
      lastIndex = index;
    }
  }
  if (lastIndex < 0) return undefined;
  const at = repeatInstant(anchorMs, repeat, lastIndex);
  return hasStart ? at + duration : at;
}

function repeatLastIndex(firstDay: string, repeat: NoteRepeat, untilMs: number): number {
  const startIndex = repeatDayIndex(firstDay, repeat, untilMs);
  let last = startIndex - 1;
  for (let index = startIndex; index < MAX_REPEAT_OCCURRENCES * 20; index++) {
    if (beijingDayStartMs(repeatDay(firstDay, repeat, index)) > untilMs) break;
    last = index;
  }
  return last;
}

/** 第一条日程；只需要一个时间的调用（测试、单条详情）用它。 */
export function noteCalendarEvent(note: Note): CalendarEvent | null {
  return noteCalendarEvents(note)[0] ?? null;
}

/**
 * 日程是否已经过去。日程没有「完成」概念，只看时间：最后一次结束时间不晚于现在就是已过期。
 * 全天日程的 end 是排他日期，跨过那一天（北京时间次日零点）才算过期。
 * 一直重复、没有 until / count 的周期日程不算过期。
 */
export function noteScheduleExpired(note: Note, now = Date.now()): boolean {
  const repeat = note.schedule?.repeat;
  if (repeat) {
    const end = noteRepeatLastEnd(note, repeat);
    return end !== undefined && now >= end;
  }
  const events = noteCalendarEvents(note);
  if (!events.length) return false;
  const end = Math.max(...events.map((event) => eventTime(event.end)));
  return Number.isFinite(end) && now >= end;
}

function dayGap(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** YYYY-MM-DD 加减天数（按日历日，不受时区影响）。 */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 全天日程：和 Google 全天事件同一形状，end 是排他日期。只有 end 时按截止当天算一天。 */
function allDayEvents(note: Note): CalendarEvent[] {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const start = note.schedule?.start && day.test(note.schedule.start) ? note.schedule.start : undefined;
  const last = note.schedule?.end && day.test(note.schedule.end) ? note.schedule.end : undefined;
  const first = start ?? last;
  if (!first) return [];
  const through = last && last >= first ? last : first;
  // 连续的一段（start..end）就一条；不相邻的另外几天各一条。
  const extras = [...new Set((note.schedule?.repeats ?? []).filter((d) => day.test(d) && (d < first || d > through)))].sort();
  const days = [{ from: first, through }, ...extras.map((d) => ({ from: d, through: d }))];
  return days.map((range, index) => ({
    id: index === 0 ? `note:${note.id}` : `note:${note.id}~${index + 1}`,
    ...noteEventOrigin(note),
    start: range.from, end: shiftDate(range.through, 1), allDay: true, noteId: note.id,
    ...(note.text ? { description: note.text.length > 4000 ? `${note.text.slice(0, 3999)}…` : note.text } : {})
  }));
}

function eventTime(value: string): number {
  // 全天事件是 YYYY-MM-DD：按北京时间的零点参与区间比较（日历口径统一北京时间）。
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return dateOnly ? beijingDayStartMs(value) : Date.parse(value);
}

/** 事件与 [from, to) 有交集；Google 全天事件的排他 end 仍按同一套时间比较。 */
export function eventsInRange<T extends Pick<CalendarEvent, "start" | "end">>(events: T[], from: string, to: string): T[] {
  const start = eventTime(from);
  const end = eventTime(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return events.filter((event) => {
    const s = eventTime(event.start);
    const e = eventTime(event.end);
    return Number.isFinite(s) && Number.isFinite(e) && e > start && s < end;
  });
}
