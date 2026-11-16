"use strict";
// Shared note references remain usable without loading the notes page.
// No data reads, timers or listeners run while this file is evaluated.

// 平台日历、日程文案与「记于」时间统一按北京时间（UTC+8，中国不实行夏令时），
// 不跟随浏览器所在时区。
const NOTE_PLATFORM_TIME_ZONE = "Asia/Shanghai";
const NOTE_BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;


function noteValid(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** 绝对时刻 → 北京时间墙上时间的字段（用 UTC 字段承载，避免再受本机时区影响）。 */
function noteBeijingParts(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  const b = new Date(d.getTime() + NOTE_BEIJING_OFFSET_MS);
  return { year: b.getUTCFullYear(), month: b.getUTCMonth() + 1, day: b.getUTCDate(), hour: b.getUTCHours(), minute: b.getUTCMinutes(), weekday: b.getUTCDay() };
}

/** 北京日期键 YYYY-MM-DD。 */
function noteBeijingDateKey(value) {
  const p = noteBeijingParts(value);
  const pad = (n) => String(n).padStart(2, "0");
  return p ? `${p.year}-${pad(p.month)}-${pad(p.day)}` : "";
}

/** 北京时间的「YYYY-MM-DD HH:mm」；非法时间返回空串。 */
function noteBeijingStamp(value) {
  const p = noteBeijingParts(value);
  const pad = (n) => String(n).padStart(2, "0");
  return p ? `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}` : "";
}


function noteStamp(iso) {
  const d = noteValid(iso);
  if (!d) return iso || "";
  return noteBeijingStamp(d);
}

// ───── 农历（v3.110）：与 apps/web/src/lunar.ts 同一套算法，结果由 test/lunar.test.ts 对照 ─────
// 用运行时自带的 Intl（chinese 历法）逐月定位初一；公历日一律按 YYYY-MM-DD 的 UTC 日序号运算，不受本机时区影响。
const NOTE_LUNAR_DAY_MS = 86400000;
const NOTE_LUNAR_SEED = Date.UTC(1900, 0, 1) / NOTE_LUNAR_DAY_MS;
const NOTE_LUNAR_MAX = 1200;
const NOTE_LUNAR_CYCLES = 700;
const NOTE_LUNAR_NEVER = "9999-12-31";
const NOTE_LUNAR_MONTHS = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
const NOTE_LUNAR_DAYS = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];
let noteLunarFormatter = null;
const noteLunarMonths = [];
const noteLunarMonthIndex = new Map();
const noteLunarSequences = new Map();

const noteLunarDayNum = (day) => Date.parse(`${day}T00:00:00Z`) / NOTE_LUNAR_DAY_MS;
const noteLunarDayText = (num) => new Date(num * NOTE_LUNAR_DAY_MS).toISOString().slice(0, 10);

function noteLunarOfNum(num) {
  if (!noteLunarFormatter) noteLunarFormatter = new Intl.DateTimeFormat("en-u-ca-chinese-nu-latn", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });
  const parts = {};
  for (const p of noteLunarFormatter.formatToParts(new Date(num * NOTE_LUNAR_DAY_MS))) parts[p.type] = p.value;
  const month = String(parts.month);
  return { year: Number(parts.relatedYear), month: parseInt(month, 10), leap: month.endsWith("bis"), day: Number(parts.day) };
}

/** 公历日（YYYY-MM-DD）→ { year, month, leap, day }；运行环境不支持农历历法或日期无效时返回 null。 */
function noteLunarOf(day) {
  const cached = noteLunarOf.cache.get(day);
  if (cached !== undefined) return cached;
  let value = null;
  try {
    const parsed = noteLunarOfNum(noteLunarDayNum(day));
    value = parsed.day >= 1 && Number.isFinite(parsed.month) ? parsed : null;
  } catch { value = null; }
  if (noteLunarOf.cache.size > 800) noteLunarOf.cache.clear();
  noteLunarOf.cache.set(day, value);
  return value;
}
noteLunarOf.cache = new Map();

const noteLunarMonthName = (month, leap) => `${leap ? "闰" : ""}${NOTE_LUNAR_MONTHS[month - 1] || month}月`;
const noteLunarDayName = (day) => NOTE_LUNAR_DAYS[day - 1] || String(day);

/** 日历格里的小字：初一显示月名（冬月、闰四月），其余显示农历日。 */
function noteLunarCellText(day) {
  const l = noteLunarOf(day);
  if (!l) return { text: "", month: false };
  return l.day === 1 ? { text: noteLunarMonthName(l.month, l.leap), month: true } : { text: noteLunarDayName(l.day), month: false };
}

/** 完整农历：十一月十六（带月名别称：正月 / 冬月 / 腊月）。 */
function noteLunarFullText(day) {
  const l = noteLunarOf(day);
  return l ? `${noteLunarMonthName(l.month, l.leap)}${noteLunarDayName(l.day)}` : "";
}

function noteLunarPushMonth(start) {
  const d = noteLunarOfNum(start);
  noteLunarMonthIndex.set(`${d.year}-${d.month}${d.leap ? "L" : ""}`, noteLunarMonths.length);
  noteLunarMonths.push({ year: d.year, month: d.month, leap: d.leap, start, length: noteLunarOfNum(start + 29).day === 1 ? 29 : 30 });
}

function noteLunarExtend(num) {
  if (!noteLunarMonths.length) noteLunarPushMonth(NOTE_LUNAR_SEED - (noteLunarOfNum(NOTE_LUNAR_SEED).day - 1));
  for (let last = noteLunarMonths[noteLunarMonths.length - 1]; last.start + last.length <= num; last = noteLunarMonths[noteLunarMonths.length - 1]) noteLunarPushMonth(last.start + last.length);
}

function noteLunarMonthAtIndex(index) {
  while (index >= noteLunarMonths.length) {
    const last = noteLunarMonths[noteLunarMonths.length - 1];
    noteLunarExtend(last.start + last.length);
  }
  return noteLunarMonths[index];
}

function noteLunarMonthAt(num) {
  noteLunarExtend(num);
  let lo = 0, hi = noteLunarMonths.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (noteLunarMonths[mid].start <= num) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function noteLunarFindMonth(year, month, leap) {
  noteLunarExtend(Date.UTC(year + 2, 0, 1) / NOTE_LUNAR_DAY_MS);
  const index = noteLunarMonthIndex.get(`${year}-${month}${leap ? "L" : ""}`);
  return index === undefined ? null : noteLunarMonths[index];
}

const noteLunarMonthDays = (m, days) => [...new Set(days.map((d) => m.start + Math.min(d, m.length) - 1))].sort((a, b) => a - b);

function* noteLunarDays(first, repeat) {
  const from = noteLunarDayNum(first), rule = repeat.lunar, interval = repeat.interval || 1;
  let yielded = 0;
  if (repeat.freq === "yearly") {
    const cycle = (year) => { const m = noteLunarFindMonth(year, rule.month, rule.leap === true); return m ? noteLunarMonthDays(m, rule.days) : []; };
    let year = noteLunarOfNum(from).year;
    for (let guard = 0; guard < NOTE_LUNAR_CYCLES && !cycle(year).some((d) => d >= from); guard++) year++;
    for (let k = 0; k < NOTE_LUNAR_CYCLES; k++, year += interval) {
      for (const d of cycle(year)) {
        if (d < from) continue;
        if (++yielded > NOTE_LUNAR_MAX) return;
        yield noteLunarDayText(d);
      }
    }
    return;
  }
  let index = noteLunarMonthAt(from);
  for (let guard = 0; guard < NOTE_LUNAR_CYCLES && !noteLunarMonthDays(noteLunarMonthAtIndex(index), rule.days).some((d) => d >= from); guard++) index++;
  for (let k = 0; k < NOTE_LUNAR_CYCLES; k++, index += interval) {
    for (const d of noteLunarMonthDays(noteLunarMonthAtIndex(index), rule.days)) {
      if (d < from) continue;
      if (++yielded > NOTE_LUNAR_MAX) return;
      yield noteLunarDayText(d);
    }
  }
}

/** 第 index 次（从 0 开始）发生的公历日；没有这一次或运行环境不支持农历历法时返回哨兵日期 9999-12-31。 */
function noteLunarRepeatDay(first, repeat, index) {
  if (!repeat || !repeat.lunar) return NOTE_LUNAR_NEVER;
  const key = `${first}|${repeat.freq}|${repeat.interval || 1}|${JSON.stringify(repeat.lunar)}`;
  let seq = noteLunarSequences.get(key);
  if (!seq) {
    if (noteLunarSequences.size >= 64) noteLunarSequences.delete(noteLunarSequences.keys().next().value);
    seq = { gen: noteLunarDays(first, repeat), days: [], done: false };
    noteLunarSequences.set(key, seq);
  }
  try {
    while (!seq.done && seq.days.length <= index) {
      const next = seq.gen.next();
      if (next.done) seq.done = true; else seq.days.push(next.value);
    }
  } catch { seq.done = true; }
  return seq.days[index] || NOTE_LUNAR_NEVER;
}

/** 农历周期规则的文案：每年冬月十五 / 每月初一、十五 / 每年闰六月初一。 */
function noteLunarRepeatText(repeat) {
  const rule = repeat.lunar, interval = repeat.interval || 1;
  const days = rule.days.map(noteLunarDayName).join("、");
  if (repeat.freq === "monthly") return interval === 1 ? `每月${days}` : `每 ${interval} 个月的${days}`;
  const date = `${noteLunarMonthName(rule.month, rule.leap === true)}${days}`;
  return interval === 1 ? `每年${date}` : `每 ${interval} 年的${date}`;
}

const NOTE_REPEAT_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 周期规则的文案：每周五 / 每天 / 每月 11 日 / 每年 10 月 1 日，以及 until / count 后缀。 */
function noteRepeatInfo(schedule) {
  const repeat = schedule && schedule.repeat;
  if (!repeat) return null;
  const anchor = schedule.start || schedule.end;
  let parts = null;
  if (schedule.allDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor || "");
    if (m) parts = { year: +m[1], month: +m[2], day: +m[3], weekday: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() };
  } else if (anchor) parts = noteBeijingParts(anchor);
  if (!parts) return null;
  const interval = repeat.interval || 1;
  const weekday = NOTE_REPEAT_WEEKDAYS[parts.weekday];
  let text;
  if (repeat.lunar) text = noteLunarRepeatText(repeat);
  else if (repeat.freq === "daily") text = interval === 1 ? "每天" : `每 ${interval} 天`;
  else if (repeat.freq === "weekly" && noteRepeatByDayOffsets(repeat).length) {
    const days = noteRepeatByDayText(repeat);
    text = interval === 1 ? days.every : `每 ${interval} 周的${days.list}`;
  }
  else if (repeat.freq === "weekly") text = interval === 1 ? `每周${weekday}` : `每 ${interval} 周（周${weekday}）`;
  else if (repeat.freq === "monthly") text = interval === 1 ? `每月 ${parts.day} 日` : `每 ${interval} 个月的 ${parts.day} 日`;
  else text = interval === 1 ? `每年 ${parts.month} 月 ${parts.day} 日` : `每 ${interval} 年的 ${parts.month} 月 ${parts.day} 日`;
  let suffix = "";
  if (repeat.until) {
    let u = null;
    if (schedule.allDay) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(repeat.until);
      if (m) u = { month: +m[2], day: +m[3] };
    } else u = noteBeijingParts(repeat.until);
    if (u) suffix = `，至 ${u.month} 月 ${u.day} 日`;
  }
  if (!suffix && repeat.count) suffix = `，共 ${repeat.count} 次`;
  return { text, suffix };
}

/** 周期日程的摘要：用「每周五 20:30 前」代替一次性的日期，后面带结束条件。 */
function noteRepeatScheduleLabel(schedule) {
  const info = noteRepeatInfo(schedule);
  if (!info) return "";
  const p = (n) => String(n).padStart(2, "0");
  const clock = (parts) => `${p(parts.hour)}:${p(parts.minute)}`;
  if (schedule.allDay) {
    if (!schedule.start && schedule.end) return `${info.text} 截止${info.suffix}`;
    return `${info.text} 全天${info.suffix}`;
  }
  if (!schedule.start && schedule.end) {
    const ep = noteBeijingParts(schedule.end);
    return ep ? `${info.text} ${clock(ep)} 前${info.suffix}` : `${info.text}${info.suffix}`;
  }
  const sp = schedule.start ? noteBeijingParts(schedule.start) : null;
  const ep = schedule.end ? noteBeijingParts(schedule.end) : null;
  if (sp && ep) return `${info.text} ${clock(sp)}–${clock(ep)}${info.suffix}`;
  if (sp) return `${info.text} ${clock(sp)} 起${info.suffix}`;
  return `${info.text}${info.suffix}`;
}

const NOTE_REPEAT_BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** byDay → 周一 = 0 的偏移，排序去重；没有 byDay 返回空数组。 */
function noteRepeatByDayOffsets(repeat) {
  const list = repeat && Array.isArray(repeat.byDay) ? repeat.byDay : [];
  return [...new Set(list.map((day) => NOTE_REPEAT_BYDAY.indexOf(day)).filter((o) => o >= 0))].sort((a, b) => a - b);
}

/** byDay 的文案：工作日 / 周末 / 一、三、五；every 是「每…」整句，list 用在「每 2 周的…」。 */
function noteRepeatByDayText(repeat) {
  const offsets = noteRepeatByDayOffsets(repeat);
  const key = offsets.join("");
  if (key === "0123456") return { every: "每天", list: "每天" };
  if (key === "01234") return { every: "工作日", list: "工作日" };
  if (key === "56") return { every: "每周末", list: "周末" };
  const names = offsets.map((o) => NOTE_REPEAT_WEEKDAYS[(o + 1) % 7]);
  const list = `周${names.join("、")}`;
  return { every: `每${list}`, list };
}

/** 北京日期（年 / 月 / 日）是周几，周一 = 0。 */
function noteRepeatWeekdayOffset(year, month, day) {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/** 每周 + byDay 的第 n 次相对第一次所在日期的天数差；与 calendar.ts 的 byDayDelta 同一套算法。 */
function noteRepeatByDayDelta(year, month, day, repeat, n) {
  const offsets = noteRepeatByDayOffsets(repeat);
  const a = noteRepeatWeekdayOffset(year, month, day);
  const firstWeek = offsets.filter((o) => o >= a);
  if (n < firstWeek.length) return firstWeek[n] - a;
  const m = n - firstWeek.length;
  return 7 * (repeat.interval || 1) * (1 + Math.floor(m / offsets.length)) + offsets[m % offsets.length] - a;
}

/** 北京时间某天的零点（YYYY-MM-DD）。 */
function noteRepeatDayStart(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - NOTE_BEIJING_OFFSET_MS : NaN;
}

/** 第 index 次（从 0 开始）的全天日期：按第一次的北京日期推进。 */
function noteRepeatDay(anchorDay, repeat, index) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchorDay || "");
  if (!m) return "";
  const year = +m[1], month = +m[2], day = +m[3];
  if (repeat.lunar) return noteLunarRepeatDay(anchorDay, repeat, index);
  if (noteRepeatByDayOffsets(repeat).length) return new Date(Date.UTC(year, month - 1, day + noteRepeatByDayDelta(year, month, day, repeat, index))).toISOString().slice(0, 10);
  const step = (repeat.interval || 1) * index;
  if (repeat.freq === "daily" || repeat.freq === "weekly") {
    const shifted = new Date(Date.UTC(year, month - 1, day + (repeat.freq === "daily" ? step : 7 * step)));
    return shifted.toISOString().slice(0, 10);
  }
  const total = year * 12 + (month - 1) + (repeat.freq === "monthly" ? step : 12 * step);
  const y = Math.floor(total / 12), mo = total - y * 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(mo + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** 第 index 次的绝对时刻：按第一次的北京时间墙上时间推进。 */
function noteRepeatInstant(anchorMs, repeat, index) {
  const parts = noteBeijingParts(anchorMs);
  if (!parts) return NaN;
  const step = (repeat.interval || 1) * index;
  const at = (year, month, day) => Date.UTC(year, month - 1, day, parts.hour, parts.minute, 0) - NOTE_BEIJING_OFFSET_MS;
  if (repeat.lunar) {
    const pad = (n) => String(n).padStart(2, "0");
    const day = noteLunarRepeatDay(`${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}`, repeat, index);
    return Date.parse(`${day}T00:00:00Z`) + (parts.hour * 60 + parts.minute) * 60000 - NOTE_BEIJING_OFFSET_MS;
  }
  if (noteRepeatByDayOffsets(repeat).length) return at(parts.year, parts.month, parts.day + noteRepeatByDayDelta(parts.year, parts.month, parts.day, repeat, index));
  if (repeat.freq === "daily") return at(parts.year, parts.month, parts.day + step);
  if (repeat.freq === "weekly") return at(parts.year, parts.month, parts.day + 7 * step);
  const total = parts.year * 12 + (parts.month - 1) + (repeat.freq === "monthly" ? step : 12 * step);
  const y = Math.floor(total / 12), m = total - y * 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return at(y, m + 1, Math.min(parts.day, last));
}

/** 周期日程最后一次结束时刻；一直重复时返回 null（永不过期）。 */
function noteRepeatLastEnd(schedule) {
  const repeat = schedule && schedule.repeat;
  if (!repeat || (!repeat.until && !repeat.count)) return null;
  const anchorValue = schedule.start || schedule.end;
  if (schedule.allDay) {
    const first = /^\d{4}-\d{2}-\d{2}$/.test(anchorValue || "") ? anchorValue : "";
    if (!first) return null;
    const startDay = /^\d{4}-\d{2}-\d{2}$/.test(schedule.start || "") ? schedule.start : "";
    const endDay = /^\d{4}-\d{2}-\d{2}$/.test(schedule.end || "") ? schedule.end : "";
    const span = startDay && endDay && endDay >= startDay ? Math.round((Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86400000) + 1 : 1;
    let last = repeat.count ? repeat.count - 1 : -1;
    if (!repeat.count) for (let i = 0; i < 20000; i++) {
      if (noteRepeatDay(first, repeat, i) > repeat.until) break;
      last = i;
    }
    return last < 0 ? null : noteRepeatDayStart(noteRepeatDay(first, repeat, last)) + Math.max(1, span) * 86400000;
  }
  const start = Date.parse(schedule.start || ""), end = Date.parse(schedule.end || "");
  const hasStart = Number.isFinite(start), hasEnd = Number.isFinite(end);
  if (!hasStart && !hasEnd) return null;
  const anchor = hasStart ? start : end;
  const duration = hasStart && hasEnd && end > start ? end - start : 3600000;
  const until = repeat.until ? (/^\d{4}-\d{2}-\d{2}$/.test(repeat.until) ? noteRepeatDayStart(repeat.until) + 86400000 - 1 : Date.parse(repeat.until)) : NaN;
  let last = repeat.count ? repeat.count - 1 : -1;
  if (!repeat.count) for (let i = 0; i < 20000; i++) {
    if (noteRepeatInstant(anchor, repeat, i) > until) break;
    last = i;
  }
  if (last < 0) return null;
  const at = noteRepeatInstant(anchor, repeat, last);
  return hasStart ? at + duration : at;
}

/** 待办日程摘要：有开始显示起止，只有结束显示截止，多天重复时把日子列在一起。会话详情与待办页共用。 */
function noteScheduleLabel(schedule) {
  if (!schedule) return "";
  if (schedule.repeat) {
    const label = noteRepeatScheduleLabel(schedule);
    if (label) return label;
  }
  const p = (n) => String(n).padStart(2, "0");
  const day = (parts) => `${parts.month} 月 ${parts.day} 日`;
  const clock = (parts) => `${p(parts.hour)}:${p(parts.minute)}`;
  // 同一个月时后面的日子只写「12 日」：11 月 11 日、12 日 19:00 起
  const dayList = (list) => {
    const first = list[0];
    const sameMonth = list.every((d) => d.year === first.year && d.month === first.month);
    return list.map((d, i) => (i && sameMonth ? `${d.day} 日` : day(d))).join("、");
  };
  if (schedule.allDay) {
    // 全天日程存的是 YYYY-MM-DD：按本地日期容器读，不能当 UTC 零点（会差一天或带出 08:00）。
    const local = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
    const wallDay = (d) => `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    const wallList = (list) => {
      const first = list[0];
      const sameMonth = list.every((d) => d.getFullYear() === first.getFullYear() && d.getMonth() === first.getMonth());
      return list.map((d, i) => (i && sameMonth ? `${d.getDate()} 日` : wallDay(d))).join("、");
    };
    const s = local(schedule.start), e = local(schedule.end);
    const unique = (list) => [...new Map(list.map((d) => [d.getTime(), d])).values()].sort((a, b) => a - b);
    const rangeEnd = s && e && e.getTime() > s.getTime() ? e : null;
    const extras = unique((schedule.repeats || []).map(local).filter((d) => d
      && (!s || d.getTime() !== s.getTime())
      && (!rangeEnd || d.getTime() < s.getTime() || d.getTime() > rangeEnd.getTime())));
    if (rangeEnd) return [`${wallDay(s)}–${wallDay(rangeEnd)}`, ...extras.map(wallDay)].join("、");
    if (s) return extras.length ? `${wallList(unique([s, ...extras]))} 全天` : `${wallDay(s)} 全天`;
    if (e) return extras.length ? `截止 ${wallDay(e)}、${wallList(extras)}` : `截止 ${wallDay(e)}`;
    return "";
  }
  const start = noteValid(schedule.start), end = noteValid(schedule.end);
  const sp = start && noteBeijingParts(start), ep = end && noteBeijingParts(end);
  if (start && end && !(schedule.repeats || []).length) {
    if (noteBeijingDateKey(start) !== noteBeijingDateKey(end)) return `${day(sp)} ${clock(sp)}–${day(ep)} ${clock(ep)}`;
    return `${day(sp)} ${clock(sp)}–${clock(ep)}`;
  }
  if (start) {
    // 不相邻的几天：11 月 11 日、12 日 19:00 起（有结束时间就写出每次的时段）。
    const dates = [{ ms: start.getTime(), parts: sp }];
    for (const raw of schedule.repeats || []) {
      const d = noteValid(raw);
      if (d && d.getTime() > start.getTime()) dates.push({ ms: d.getTime(), parts: noteBeijingParts(d) });
    }
    dates.sort((a, b) => a.ms - b.ms);
    return `${dayList(dates.map((d) => d.parts))} ${clock(sp)}${end ? `–${clock(ep)}` : " 起"}`;
  }
  if (end) return `截止 ${day(ep)} ${clock(ep)}`;
  return "";
}


/* --------------------------------- 图片 --------------------------------- */

function noteImageUrl(image, thumbnail) {
  return `/api/notes/images/${encodeURIComponent(image.id)}${thumbnail ? "?thumbnail=1" : ""}`;
}


/** 统一入口：有缩放查看器就用它（可左右切换），否则退回老式对话框 */
function noteOpenImages(items, index) {
  const list = (items || []).filter((it) => it && it.src);
  if (!list.length) return;
  const i = Math.min(Math.max(0, index | 0), list.length - 1);
  if (typeof openImageZoom === "function") { openImageZoom(list, i); return; }
  const item = list[i];
  const dialog = h("dialog", {
    class: "rt-image-dialog", "aria-label": item.name,
    onclick: (ev) => { if (ev.target === dialog) dialog.close(); },
    onclose: () => dialog.remove()
  },
    h("button", { type: "button", class: "btn", onclick: () => dialog.close(), "aria-label": "关闭图片预览" }, "关闭"),
    h("p", {}, item.name),
    h("img", { src: item.src, alt: item.name }));
  document.body.append(dialog);
  dialog.showModal();
}


/** 记录里的图片：和对话附件同款卡片（缩略图 + 文件名，点开看大图） */
function noteImageStrip(images) {
  if (!images || !images.length) return null;
  const view = images.map((image) => ({ src: noteImageUrl(image), name: image.name }));
  return h("div", { class: "note-images rt-attachment-strip" }, view.map((entry, index) =>
    h("button", { type: "button", class: "rt-attachment-card", "aria-label": `查看图片 ${entry.name}`, onclick: () => noteOpenImages(view, index) },
      h("img", { src: noteImageUrl(images[index], true), alt: entry.name, loading: "lazy" }),
      h("span", { class: "rt-attachment-name" }, entry.name),
      h("span", { class: "small muted" }, noteFileSize(images[index].byteSize)))));
}


function noteFileSize(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`;
}


/** 复制记录里的图片到新会话附件；取不到或运行时不可用就跳过，不影响文字引用。 */
async function noteCopyImages(images, key = "new") {
  if (!images.length || typeof rtAddImages !== "function" || typeof rtImageDraft !== "function") return;
  const draft = rtImageDraft(key);
  const taken = new Set(draft.images.map((i) => `${i.originalName}\u0000${i.byteSize}`));
  const files = [];
  const fresh = images.filter((image) => !taken.has(`${image.name}\u0000${image.byteSize}`));
  // 图片本来就在服务端：先按 id 直接附上，只有没附上的才下载再上传
  const rest = typeof rtAddNoteImages === "function" ? await rtAddNoteImages(key, fresh) : fresh;
  for (const image of rest) {
    try {
      const res = await fetch(noteImageUrl(image), { credentials: "same-origin" });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (!blob.size) continue;
      files.push(new File([blob], image.name || "图片", { type: image.mimeType || blob.type || "image/webp" }));
    } catch { /* 单张失败就跳过 */ }
  }
  if (files.length) await rtAddImages(key, files);
}
