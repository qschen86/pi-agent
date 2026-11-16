/**
 * 公开分享的 Google 日历：把一个 embed / cid / ical 地址贴进来，直接读公开 ICS。
 *
 * 公开日历不需要 OAuth；只有私有日历才需要 `google-calendar.ts` 里的 OAuth 流程。
 * 这里负责地址归一化、公开 ICS 拉取与解析（含常见 RRULE 重复事件）。
 */
import type { CalendarEvent } from "./calendar.js";

const GOOGLE_HOSTS = new Set(["calendar.google.com", "www.google.com"]);
/** iCloud 已发布日历：p204-caldav.icloud.com.cn / p204-caldav.icloud.com 等 */
const ICLOUD_HOST = /^(?:p\d+-)?caldav\.icloud\.com(?:\.cn)?$/i;
const MAX_ICS_BYTES = 5 * 1024 * 1024;
const MAX_OCCURRENCES = 50_000;

export interface SharedCalendarSource {
  /** 归一化后的公开 ICS 地址 */
  icsUrl: string;
  /** 日历 ID（xxx@group.calendar.google.com 等） */
  calendarId: string;
}

function makeSource(calendarId: string): SharedCalendarSource {
  const id = calendarId.trim();
  if (!id || /[\s\x00-\x1f]/.test(id)) throw new Error("Google 日历 ID 不能为空或包含空白字符");
  if (id.length > 500) throw new Error("Google 日历 ID 太长");
  return {
    icsUrl: `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`,
    calendarId: id
  };
}

function decodeCid(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
  return decoded;
}

/**
 * 接受用户从 Google 日历复制出来的分享地址：
 * - https://calendar.google.com/calendar/embed?src=...&ctz=...
 * - https://calendar.google.com/calendar/u/0?cid=...
 * - https://calendar.google.com/calendar/ical/.../public/basic.ics
 * - 直接填日历 ID（primary、xxx@group.calendar.google.com）
 */
export function normalizeSharedCalendarUrl(raw: string): SharedCalendarSource {
  const value = String(raw || "").trim();
  if (!value) throw new Error("请贴一个 Google 日历分享地址");
  if (value.length > 4000) throw new Error("日历地址太长");
  let url: URL | undefined;
  try {
    if (/^webcal:\/\//i.test(value)) url = new URL(value.replace(/^webcal:/i, "https:"));
    else if (/^https?:\/\//i.test(value)) url = new URL(value);
  } catch {
    throw new Error("无法识别的日历地址");
  }
  if (!url) return makeSource(value);
  if (ICLOUD_HOST.test(url.hostname)) {
    if (!/^\/published\//i.test(url.pathname)) throw new Error("iCloud 请使用“已发布日历”的链接（/published/...）");
    if (url.protocol === "http:") url.protocol = "https:";
    return { icsUrl: url.toString(), calendarId: `icloud:${url.hostname}${url.pathname}` };
  }
  if (!GOOGLE_HOSTS.has(url.hostname.toLowerCase())) throw new Error("目前支持 Google 和 iCloud 的公开日历地址");
  const ical = /\/calendar\/ical\/([^/]+)\//.exec(url.pathname);
  if (ical?.[1]) {
    // 用户可能贴的是 Google 的“秘密地址（iCal 格式）”（private-.../basic.ics）：
    // 这是带密钥的只读地址，直接保留完整路径，不要改写成 public/basic.ics。
    const calendarId = decodeURIComponent(ical[1]);
    if (/\/basic\.ics$/i.test(url.pathname)) {
      if (url.protocol === "http:") url.protocol = "https:";
      return { icsUrl: url.toString(), calendarId };
    }
    try { return makeSource(calendarId); }
    catch { throw new Error("无法识别日历地址里的日历 ID"); }
  }
  const src = url.searchParams.get("src");
  const cid = url.searchParams.get("cid");
  const id = src || (cid ? decodeCid(cid) : "");
  if (!id) throw new Error("地址里没有日历 ID；请使用 Google 日历的“公开地址”或含 src/cid 的分享链接");
  return makeSource(id);
}

/* ------------------------------- ICS 解析 ------------------------------- */

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface IcsDateValue {
  dateOnly: boolean;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  tzid?: string;
  utc: boolean;
}

interface RRule {
  freq: string;
  interval: number;
  count?: number;
  until?: IcsDateValue;
  byDay?: Array<{ ordinal?: number; weekday: number }>;
  byMonthDay?: number[];
  byMonth?: number[];
}

interface IcsEvent {
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  url?: string;
  status?: string;
  start: IcsDateValue;
  end?: IcsDateValue;
  durationMs?: number;
  rrule?: string;
  recurrenceId?: IcsDateValue;
  exdates: IcsDateValue[];
  rdates: IcsDateValue[];
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "", quoted = false;
  for (const ch of value) {
    if (ch === "\"") quoted = !quoted;
    if (ch === separator && !quoted) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function parseProperty(line: string): IcsProperty | undefined {
  let quoted = false, colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") quoted = !quoted;
    else if (ch === ":" && !quoted) { colon = i; break; }
  }
  if (colon < 0) return undefined;
  const head = line.slice(0, colon), rawValue = line.slice(colon + 1);
  const parts = splitOutsideQuotes(head, ";");
  const name = (parts.shift() || "").trim().toUpperCase();
  if (!name) return undefined;
  const params: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    params[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { name, params, value: rawValue };
}

function unfoldIcs(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

export function unescapeIcsText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, ch: string) => ch === "n" || ch === "N" ? "\n" : ch);
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

function dateKey(d: IcsDateValue): string {
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return asUtc - date.getTime();
  } catch {
    return 0;
  }
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = timeZoneOffsetMs(new Date(guess), timeZone);
  let value = guess - first;
  const secondOffset = timeZoneOffsetMs(new Date(value), timeZone);
  if (secondOffset !== first) value = guess - secondOffset;
  return value;
}

function parseIcsDate(value: string, params: Record<string, string>, defaultTzid?: string): IcsDateValue | undefined {
  const raw = value.trim();
  const dateOnly = params["VALUE"] === "DATE" || /^\d{8}$/.test(raw);
  if (dateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
    if (!m) return undefined;
    return { dateOnly: true, year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: 0, minute: 0, second: 0, utc: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (!m) return undefined;
  const tzid = params["TZID"] || defaultTzid;
  return {
    dateOnly: false, year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]),
    ...(tzid ? { tzid } : {}),
    utc: !!m[7] || !tzid
  };
}

function dateValueMs(d: IcsDateValue): number {
  if (d.dateOnly) return Date.UTC(d.year, d.month - 1, d.day);
  if (d.utc || !d.tzid) return Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second);
  return zonedTimeToUtc(d.year, d.month, d.day, d.hour, d.minute, d.second, d.tzid);
}

function dateValueOutput(d: IcsDateValue): string {
  if (d.dateOnly) return dateKey(d);
  return new Date(dateValueMs(d)).toISOString();
}

function dateValueKey(d: IcsDateValue): string {
  return d.dateOnly ? dateKey(d) : String(dateValueMs(d));
}

function parseDuration(value: string): number | undefined {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const sign = m[1] === "-" ? -1 : 1;
  const week = Number(m[2] || 0), day = Number(m[3] || 0), hour = Number(m[4] || 0), minute = Number(m[5] || 0), second = Number(m[6] || 0);
  return sign * (((week * 7 + day) * 24 + hour) * 60 + minute) * 60_000 + sign * second * 1000;
}

function parseRRule(value: string, defaultTzid?: string): RRule | undefined {
  const parts = Object.fromEntries(value.split(";").map((part) => {
    const eq = part.indexOf("=");
    return eq < 0 ? [part.toUpperCase(), ""] : [part.slice(0, eq).toUpperCase(), part.slice(eq + 1)];
  }));
  const freq = (parts["FREQ"] || "").toUpperCase();
  if (!freq) return undefined;
  const interval = Math.max(1, Math.floor(Number(parts["INTERVAL"] || 1) || 1));
  const count = parts["COUNT"] ? Math.max(0, Math.floor(Number(parts["COUNT"]) || 0)) : undefined;
  const until = parts["UNTIL"] ? parseIcsDate(parts["UNTIL"], {}, defaultTzid) : undefined;
  const byDay = parts["BYDAY"] ? parts["BYDAY"].split(",").flatMap((token) => {
    const m = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(token.trim().toUpperCase());
    if (!m) return [];
    const map: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
    const weekday = map[m[2]!];
    if (!weekday) return [];
    return [{ ...(m[1] ? { ordinal: Number(m[1]) } : {}), weekday }];
  }) : undefined;
  const byMonthDay = parts["BYMONTHDAY"] ? parts["BYMONTHDAY"].split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x !== 0) : undefined;
  const byMonth = parts["BYMONTH"] ? parts["BYMONTH"].split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x >= 1 && x <= 12) : undefined;
  return { freq, interval, ...(count !== undefined ? { count } : {}), ...(until ? { until } : {}), ...(byDay?.length ? { byDay } : {}), ...(byMonthDay?.length ? { byMonthDay } : {}), ...(byMonth?.length ? { byMonth } : {}) };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOf(year: number, month: number, day: number): number {
  const js = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return js === 0 ? 7 : js;
}

function shiftDays(base: IcsDateValue, days: number): IcsDateValue {
  const d = new Date(Date.UTC(base.year, base.month - 1, base.day + days, base.hour, base.minute, base.second));
  return {
    ...base,
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds()
  };
}

function weekStart(base: IcsDateValue): IcsDateValue {
  const weekday = weekdayOf(base.year, base.month, base.day);
  return shiftDays(base, -(weekday - 1));
}

function weekdayDaysInMonth(year: number, month: number, weekday: number): number[] {
  const max = daysInMonth(year, month);
  const out: number[] = [];
  for (let day = 1; day <= max; day++) if (weekdayOf(year, month, day) === weekday) out.push(day);
  return out;
}

function monthCandidates(base: IcsDateValue, rule: RRule, year: number, month: number): IcsDateValue[] {
  const max = daysInMonth(year, month);
  const days: number[] = [];
  if (rule.byMonthDay?.length) {
    for (const raw of rule.byMonthDay) {
      const day = raw > 0 ? raw : max + raw + 1;
      if (day >= 1 && day <= max) days.push(day);
    }
  } else if (rule.byDay?.length) {
    for (const by of rule.byDay) {
      const matches = weekdayDaysInMonth(year, month, by.weekday);
      if (by.ordinal) {
        const index = by.ordinal > 0 ? by.ordinal - 1 : matches.length + by.ordinal;
        if (matches[index] !== undefined) days.push(matches[index]!);
      } else {
        days.push(...matches);
      }
    }
  } else if (base.day <= max) {
    days.push(base.day);
  }
  return [...new Set(days)].sort((a, b) => a - b).map((day) => ({ ...base, year, month, day }));
}

function* rruleCandidates(base: IcsDateValue, rule: RRule): Generator<IcsDateValue> {
  const freq = rule.freq;
  if (freq === "DAILY") {
    for (let k = 0; k < MAX_OCCURRENCES; k++) yield shiftDays(base, rule.interval * k);
    return;
  }
  if (freq === "WEEKLY") {
    const start = weekStart(base);
    for (let k = 0; k < MAX_OCCURRENCES; k++) {
      if (rule.byDay?.length) {
        const week = shiftDays(start, 7 * rule.interval * k);
        const candidates = rule.byDay.map((by) => shiftDays(week, by.weekday - 1)).sort((a, b) => dateValueMs(a) - dateValueMs(b));
        for (const candidate of candidates) yield candidate;
      } else {
        yield shiftDays(base, 7 * rule.interval * k);
      }
    }
    return;
  }
  if (freq === "MONTHLY" || freq === "YEARLY") {
    for (let k = 0; k < MAX_OCCURRENCES; k++) {
      if (freq === "MONTHLY") {
        const index = base.month - 1 + rule.interval * k;
        const year = base.year + Math.floor(index / 12);
        const month = ((index % 12) + 12) % 12 + 1;
        for (const candidate of monthCandidates(base, rule, year, month)) yield candidate;
      } else {
        const year = base.year + rule.interval * k;
        const months = rule.byMonth?.length ? rule.byMonth : [base.month];
        for (const month of [...months].sort((a, b) => a - b)) {
          for (const candidate of monthCandidates(base, rule, year, month)) yield candidate;
        }
      }
    }
    return;
  }
  // HOURLY / MINUTELY 等不展开，保留首次发生，避免误读。
  yield base;
}

function eventDuration(start: IcsDateValue, end: IcsDateValue | undefined, durationMs: number | undefined): number {
  if (end) {
    const value = dateValueMs(end) - dateValueMs(start);
    if (value > 0) return value;
  }
  if (durationMs && durationMs > 0) return durationMs;
  return start.dateOnly ? 86_400_000 : 3_600_000;
}

function parseEventProperties(lines: string[], defaultTzid?: string): IcsEvent | undefined {
  const props = new Map<string, IcsProperty>();
  const exdates: IcsDateValue[] = [];
  const rdates: IcsDateValue[] = [];
  for (const line of lines) {
    const property = parseProperty(line);
    if (!property) continue;
    if (property.name === "EXDATE") {
      for (const part of property.value.split(",")) {
        const d = parseIcsDate(part, property.params, defaultTzid);
        if (d) exdates.push(d);
      }
      continue;
    }
    if (property.name === "RDATE") {
      for (const part of property.value.split(",")) {
        const d = parseIcsDate(part, property.params, defaultTzid);
        if (d) rdates.push(d);
      }
      continue;
    }
    props.set(property.name, property);
  }
  const startProperty = props.get("DTSTART");
  if (!startProperty) return undefined;
  const start = parseIcsDate(startProperty.value, startProperty.params, defaultTzid);
  if (!start) return undefined;
  const endProperty = props.get("DTEND");
  const end = endProperty ? parseIcsDate(endProperty.value, endProperty.params, defaultTzid) : undefined;
  const duration = props.get("DURATION") ? parseDuration(props.get("DURATION")!.value) : undefined;
  const recurrenceProperty = props.get("RECURRENCE-ID");
  const recurrenceId = recurrenceProperty ? parseIcsDate(recurrenceProperty.value, recurrenceProperty.params, defaultTzid) : undefined;
  return {
    ...(props.get("UID") ? { uid: unescapeIcsText(props.get("UID")!.value) } : {}),
    ...(props.get("SUMMARY") ? { summary: unescapeIcsText(props.get("SUMMARY")!.value) } : {}),
    ...(props.get("DESCRIPTION") ? { description: unescapeIcsText(props.get("DESCRIPTION")!.value) } : {}),
    ...(props.get("LOCATION") ? { location: unescapeIcsText(props.get("LOCATION")!.value) } : {}),
    ...(props.get("URL") ? { url: unescapeIcsText(props.get("URL")!.value) } : {}),
    ...(props.get("STATUS") ? { status: props.get("STATUS")!.value.trim().toUpperCase() } : {}),
    start, ...(end ? { end } : {}), ...(duration !== undefined ? { durationMs: duration } : {}),
    ...(props.get("RRULE") ? { rrule: props.get("RRULE")!.value } : {}),
    ...(recurrenceId ? { recurrenceId } : {}),
    exdates, rdates
  };
}

function eventFromIcs(
  event: IcsEvent,
  calendarId: string,
  calendarName: string | undefined,
  occurrence: IcsDateValue,
  durationMs: number,
  index: number
): CalendarEvent {
  const startMs = dateValueMs(occurrence);
  const endValue: IcsDateValue = occurrence.dateOnly
    ? shiftDays(occurrence, Math.max(1, Math.round(durationMs / 86_400_000)))
    : { ...occurrence, utc: true, dateOnly: false, tzid: undefined };
  const endMs = startMs + durationMs;
  return {
    id: `${event.uid || "ics"}:${index}:${startMs}`,
    source: "google",
    title: (event.summary || "").trim() || "（无标题）",
    start: dateValueOutput(occurrence),
    end: occurrence.dateOnly ? dateValueOutput(endValue) : new Date(endMs).toISOString(),
    ...(occurrence.dateOnly ? { allDay: true } : {}),
    calendarId,
    ...(calendarName ? { calendarName } : {}),
    ...(event.location ? { location: event.location.slice(0, 500) } : {}),
    ...(event.description ? { description: event.description.slice(0, 4000) } : {}),
    ...(event.url && /^https?:\/\//i.test(event.url) ? { htmlLink: event.url.slice(0, 1000) } : {})
  };
}

/** 解析公开 ICS，只返回与 [from, to) 有交集的事件。 */
export function parseIcsCalendar(text: string, options: { from: string; to: string; calendarId: string }): CalendarEvent[] {
  const from = Date.parse(options.from), to = Date.parse(options.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const lines = unfoldIcs(text);
  let defaultTzid = "";
  let calendarName = "";
  const eventBlocks: string[][] = [];
  let block: string[] | undefined;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") { block = []; continue; }
    if (upper === "END:VEVENT") { if (block) eventBlocks.push(block); block = undefined; continue; }
    if (block) { block.push(line); continue; }
    const property = parseProperty(line);
    if (property?.name === "X-WR-TIMEZONE") defaultTzid = property.value.trim();
    if (property?.name === "X-WR-CALNAME") calendarName = unescapeIcsText(property.value).trim();
  }
  const parsedAll = eventBlocks.map((block) => parseEventProperties(block, defaultTzid || undefined)).filter((event): event is IcsEvent => !!event);
  // 被单独改过 / 取消的重复实例（RECURRENCE-ID）不要在主事件展开里再出现一次。
  const overrides = new Map<string, Set<string>>();
  for (const event of parsedAll) {
    if (!event.uid || !event.recurrenceId) continue;
    const set = overrides.get(event.uid) || new Set<string>();
    set.add(dateValueKey(event.recurrenceId));
    overrides.set(event.uid, set);
  }
  const parsed = parsedAll.filter((event) => event.status !== "CANCELLED");
  const events: CalendarEvent[] = [];
  for (const event of parsed) {
    const baseMs = dateValueMs(event.start);
    const duration = eventDuration(event.start, event.end, event.durationMs);
    const exdates = new Set(event.exdates.map(dateValueKey));
    if (!event.rrule || event.recurrenceId) {
      if (baseMs + duration > from && baseMs < to) events.push(eventFromIcs(event, options.calendarId, calendarName || undefined, event.start, duration, 0));
      continue;
    }
    const rule = parseRRule(event.rrule, defaultTzid || undefined);
    if (!rule) {
      if (baseMs + duration > from && baseMs < to) events.push(eventFromIcs(event, options.calendarId, calendarName || undefined, event.start, duration, 0));
      continue;
    }
    const untilMs = rule.until ? dateValueMs(rule.until) + (rule.until.dateOnly ? 86_400_000 - 1 : 0) : Infinity;
    let emitted = 0, index = 0, done = false;
    for (const occurrence of rruleCandidates(event.start, rule)) {
      const startMs = dateValueMs(occurrence);
      if (startMs < baseMs) continue;
      if (startMs > untilMs) { done = true; break; }
      if (rule.count !== undefined && emitted >= rule.count) { done = true; break; }
      emitted++;
      const occurrenceKey = dateValueKey(occurrence);
      if (exdates.has(occurrenceKey) || (event.uid && overrides.get(event.uid)?.has(occurrenceKey))) continue;
      if (startMs + duration > from && startMs < to) {
        events.push(eventFromIcs(event, options.calendarId, calendarName || undefined, occurrence, duration, index++));
      }
      if (startMs >= to && (rule.freq === "DAILY" || rule.freq === "WEEKLY" || rule.freq === "MONTHLY" || rule.freq === "YEARLY")) { done = true; break; }
    }
    // RDATE 是额外的单次发生；COUNT / UNTIL 不约束它。
    for (const rdate of event.rdates) {
      const startMs = dateValueMs(rdate);
      if (startMs + duration > from && startMs < to && !exdates.has(dateValueKey(rdate))) {
        events.push(eventFromIcs(event, options.calendarId, calendarName || undefined, rdate, duration, index++));
      }
    }
    if (done) continue;
  }
  return events;
}

/** 判断一个已归一化的地址是否是 iCloud 已发布日历。 */
export function isIcloudPublishedUrl(url: string): boolean {
  try { return ICLOUD_HOST.test(new URL(url).hostname); } catch { return false; }
}

/** 供服务端拉取公开 / 秘密 ICS 时使用：限制大小并给出可读错误。 */
export async function fetchIcsFeed(fetchImpl: typeof fetch, url: string): Promise<string> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "text/calendar,text/plain;q=0.9,*/*;q=0.8" },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error("这个日历不是公开分享的，或地址已失效；Google 日历可改用“秘密地址（iCal 格式）”，iCloud 请确认“已发布日历”链接仍有效；仍不行再使用私有日历 OAuth");
    if (response.status === 401 || response.status === 403) throw new Error("这个日历需要登录/授权；Google 可用“秘密地址（iCal 格式）”，iCloud 请使用“已发布日历”链接，或使用私有日历 OAuth");
    throw new Error(`Google 日历返回 HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length > MAX_ICS_BYTES) throw new Error("公开日历文件超过 5 MiB，暂不支持");
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error("地址返回的不是日历数据；请确认使用 Google 日历的公开分享地址（含 src=）");
  }
  return text;
}
