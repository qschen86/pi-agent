/**
 * Agent 日历：把 pi-agent 平台自己的定时任务汇总成只读日历事件。
 *
 * 数据来自三处：
 * - 平台定时任务清单（platform-scheduled-tasks.ts）里的静态定义：
 *   Web 进程内固定时间的任务（每晚故障分诊、推荐排序校准）；
 * - 调度器启动时登记的运行时时间（registerPlatformScheduledTask），同一 id 以实际时间为准；
 * - 平台注册在 launchd 里的任务（com.pi-agent.*，见 scripts/install-*.mjs），未知任务自动补充。
 *
 * 标题统一是 `应用 · 场景 · 任务名`，例如 `平台 · 故障诊断 · 每晚 AI 分诊`。
 * 平台内定时器和平台承诺的固定时间按北京时间解释；launchd 的 StartCalendarInterval
 * 仍按宿主机本地时间触发，扫描时先换算成绝对时刻，页面再统一显示为北京时间。
 * 间隔小于 1 小时的常驻检查（健康守护、备份主机激活）不逐次展开，按北京时间的天显示为
 * 全天事件，避免一天出现几千条；间隔 ≥ 1 小时的按实际发生时间展开。
 *
 * 任务清单来自 platform-scheduled-tasks.ts：静态清单 + 调度器启动时的运行时登记，
 * 未知的 launchd com.pi-agent.* 任务自动补充。增量任务只要在调度器启动时登记一次，
 * 默认就出现在这里，不需要再改本文件。
 *
 * 这里不读取 Codex / Claude Code / 其他 runtime 的 automations：那些属于 runtime，
 * 不是 pi-agent 平台自己的定时任务。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isPeak } from "./deepseek-peak.js";
import type { CalendarEvent } from "./calendar.js";
import { PLATFORM_TIME_ZONE } from "./platform-time.js";
import { platformScheduledTasks } from "./platform-scheduled-tasks.js";

export type AgentTaskStatus = "active" | "paused" | "unknown";

export interface AgentScheduledTask {
  id: string;
  /** 平台应用：平台 / 待办 / 会话 / 资源 / 产物 */
  app: string;
  /** 场景：故障诊断、质量保障、可用性、备份… */
  scene: string;
  /** 任务名 */
  name: string;
  /** 标准 RRULE；间隔任务用 FREQ=SECONDLY / MINUTELY 表示 cadence */
  schedule: string;
  /** 解释 schedule 墙上时间的 IANA 时区：launchd 用宿主机时区，平台内任务用北京时间 */
  timeZone: string;
  status: AgentTaskStatus;
  description?: string;
  /** 首次发生时间的锚点（创建时间）；COUNT 与 INTERVAL 用它对齐 */
  anchor?: string;
  /** 本机来源文件 / 代码位置，只用于诊断，不展示在日历里 */
  source: string;
  /** 这条任务会调模型时标明供应商，用于在事件里显示峰谷时段 */
  billing?: "deepseek";
}

export interface AgentCalendarScanOptions {
  home?: string;
  /** launchd 用户任务目录；默认 ~/Library/LaunchAgents */
  launchAgentsDir?: string;
  /** 测试固定 launchd 宿主机时区；默认本机时区 */
  timeZone?: string;
  /** 测试固定“现在”；只影响默认锚点 */
  now?: number;
}

export interface AgentCalendarScanResult {
  tasks: AgentScheduledTask[];
  warnings: string[];
}

const MAX_TEXT = 4_000;
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_AGENT_EVENTS = 5_000;
const MAX_RULE_DAYS = 3_700;

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function readText(path: string): string | undefined {
  try {
    const size = statSync(path).size;
    if (size > MAX_CONFIG_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function clean(value: unknown, max = 300): string {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function systemTimeZone(options: AgentCalendarScanOptions): string {
  return options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function xmlText(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function plistString(text: string, key: string): string | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`, "i").exec(text);
  return match ? xmlText(match[1]!.trim()) : undefined;
}

function plistInteger(text: string, key: string): number | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`, "i").exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

interface LaunchdInterval { hour?: number; minute?: number; weekday?: number; day?: number; month?: number }
interface LaunchdTask { label: string; source: string; rules: string[]; }

function launchdIntervals(text: string): LaunchdInterval[] {
  const at = text.search(/<key>StartCalendarInterval<\/key>/i);
  if (at < 0) return [];
  const tail = text.slice(at);
  const arrayAt = tail.search(/<array>/i);
  const dictAt = tail.search(/<dict>/i);
  if (arrayAt >= 0 && (dictAt < 0 || arrayAt < dictAt)) {
    const end = tail.indexOf("</array>", arrayAt);
    const body = end >= 0 ? tail.slice(arrayAt, end) : tail.slice(arrayAt);
    return (body.match(/<dict>[\s\S]*?<\/dict>/gi) ?? []).map(launchdIntervalOf);
  }
  if (dictAt >= 0) {
    const end = tail.indexOf("</dict>", dictAt);
    const block = end >= 0 ? tail.slice(dictAt, end + 7) : tail.slice(dictAt);
    return [launchdIntervalOf(block)];
  }
  return [];
}

function launchdIntervalOf(block: string): LaunchdInterval {
  return {
    ...(plistInteger(block, "Hour") !== undefined ? { hour: plistInteger(block, "Hour") } : {}),
    ...(plistInteger(block, "Minute") !== undefined ? { minute: plistInteger(block, "Minute") } : {}),
    ...(plistInteger(block, "Weekday") !== undefined ? { weekday: plistInteger(block, "Weekday") } : {}),
    ...(plistInteger(block, "Day") !== undefined ? { day: plistInteger(block, "Day") } : {}),
    ...(plistInteger(block, "Month") !== undefined ? { month: plistInteger(block, "Month") } : {})
  };
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function rruleOfInterval(interval: LaunchdInterval): string | undefined {
  const hour = interval.hour !== undefined ? Math.max(0, Math.min(23, interval.hour)) : 0;
  const minute = interval.minute !== undefined ? Math.max(0, Math.min(59, interval.minute)) : 0;
  const time = `BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0`;
  if (interval.weekday !== undefined) {
    const weekday = ((Math.floor(interval.weekday) % 7) + 7) % 7;
    return `RRULE:FREQ=WEEKLY;BYDAY=${WEEKDAYS[weekday]};${time}`;
  }
  if (interval.day !== undefined) {
    const day = Math.max(1, Math.min(31, Math.floor(interval.day)));
    const month = interval.month === undefined ? "" : `BYMONTH=${Math.max(1, Math.min(12, Math.floor(interval.month)))};`;
    return `RRULE:FREQ=MONTHLY;${month}BYMONTHDAY=${day};${time}`;
  }
  return `RRULE:FREQ=DAILY;${time}`;
}

function scanLaunchd(dir: string, warnings: string[]): Map<string, LaunchdTask> {
  const out = new Map<string, LaunchdTask>();
  if (!isDir(dir)) return out;
  let files: string[] = [];
  try { files = readdirSync(dir).filter((name) => name.endsWith(".plist")).sort(); } catch { warnings.push("launchd 用户任务目录读取失败"); return out; }
  for (const file of files) {
    const path = join(dir, file);
    const text = readText(path);
    if (!text) { warnings.push(`launchd 任务 ${file} 读取失败或文件过大`); continue; }
    const label = plistString(text, "Label") || basename(file, ".plist");
    if (!/^com\.pi-agent\./.test(label)) continue;
    const rules: string[] = [];
    for (const interval of launchdIntervals(text)) {
      const rule = rruleOfInterval(interval);
      if (rule) rules.push(rule);
    }
    const startInterval = plistInteger(text, "StartInterval");
    if (!rules.length && startInterval !== undefined && startInterval > 0) {
      // 间隔任务统一用 SECONDLY / HOURLY；< 1 小时的在生成日历时按天折叠。
      rules.push(startInterval < 3_600
        ? `RRULE:FREQ=SECONDLY;INTERVAL=${Math.max(1, Math.floor(startInterval))}`
        : `RRULE:FREQ=HOURLY;INTERVAL=${Math.max(1, Math.round(startInterval / 3_600))}`);
    }
    if (rules.length) out.set(label, { label, source: path, rules });
  }
  return out;
}

function launchdFallbackName(label: string): string {
  return label.replace(/^com\.pi-agent\./, "") || label;
}

/** 扫描 pi-agent 平台的定时任务。未知的 launchd 任务会以「平台 · 平台任务 · 标签」补充。 */
export function scanAgentScheduledTasks(options: AgentCalendarScanOptions = {}): AgentCalendarScanResult {
  const home = options.home || homedir();
  const launchAgentsDir = options.launchAgentsDir || join(home, "Library", "LaunchAgents");
  const warnings: string[] = [];
  const launchd = scanLaunchd(launchAgentsDir, warnings);
  // launchd 的 StartCalendarInterval 按宿主机本地时间触发；平台内定时器（分诊 / 排序）按北京时间。
  // 展示统一由页面换算成北京时间。
  const hostTimeZone = systemTimeZone(options);
  const definitions = platformScheduledTasks();
  const tasks: AgentScheduledTask[] = [];
  const knownLabels = new Set<string>();

  for (const definition of definitions) {
    if (definition.enabled && !definition.enabled()) continue;
    const found = definition.launchdLabel ? launchd.get(definition.launchdLabel) : undefined;
    if (definition.launchdLabel) knownLabels.add(definition.launchdLabel);
    // 平台承诺的固定时间优先：每小时轮询的 launchd 任务也按承诺时间展示。
    const rules = definition.canonicalSchedule
      ? [definition.canonicalSchedule]
      : found?.rules?.length ? found.rules : (definition.schedule ? [definition.schedule] : []);
    const timeZone = definition.canonicalSchedule || !found ? PLATFORM_TIME_ZONE : hostTimeZone;
    rules.forEach((schedule, index) => {
      tasks.push({
        id: `pi-agent:${definition.id}${rules.length > 1 ? `:${index + 1}` : ""}`,
        app: definition.app,
        scene: definition.scene,
        name: definition.name,
        schedule,
        timeZone,
        status: found ? "active" : definition.launchdLabel ? "unknown" : "active",
        description: found ? definition.description : definition.launchdLabel
          ? `${definition.description}（launchd 中未找到 ${definition.launchdLabel}）`
          : definition.description,
        source: found?.source ?? definition.source,
        ...(definition.billing ? { billing: definition.billing } : {})
      });
    });
  }

  for (const [label, task] of [...launchd].sort(([a], [b]) => a.localeCompare(b))) {
    if (knownLabels.has(label)) continue;
    task.rules.forEach((schedule, index) => {
      tasks.push({
        id: `pi-agent:${label}${task.rules.length > 1 ? `:${index + 1}` : ""}`,
        app: "平台",
        scene: "平台任务",
        name: launchdFallbackName(label),
        schedule,
        timeZone: hostTimeZone,
        status: "active",
        description: `launchd 任务 ${label}`,
        source: task.source
      });
    });
  }

  const seen = new Set<string>();
  return {
    tasks: tasks.filter((task) => {
      const key = `${task.id}\u0000${task.schedule}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    warnings
  };
}

interface RRuleSpec {
  freq: "SECONDLY" | "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: number;
  byHour?: number[];
  byMinute?: number[];
  bySecond?: number[];
  byDay?: number[];
  byMonthDay?: number[];
  byMonth?: number[];
}

function parseInts(value: string | undefined, min: number, max: number): number[] | undefined {
  if (!value) return undefined;
  const values = value.split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x >= min && x <= max);
  return values.length ? [...new Set(values)] : undefined;
}

function parseRRule(value: string): RRuleSpec | undefined {
  const raw = value.replace(/^RRULE:/i, "");
  const parts = new Map<string, string>();
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    parts.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }
  const freq = (parts.get("FREQ") || "").toUpperCase();
  if (!["SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return undefined;
  const weekdays: number[] = [];
  const byDay = parts.get("BYDAY");
  if (byDay) {
    for (const token of byDay.split(",")) {
      const match = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(token.trim().toUpperCase());
      if (!match) continue;
      const index = WEEKDAYS.indexOf(match[2]!);
      if (index < 0) continue;
      // 本模块用 1=周一 … 7=周日；WEEKDAYS 是 0=周日 … 6=周六。
      weekdays.push(index === 0 ? 7 : index);
    }
  }
  const untilRaw = parts.get("UNTIL");
  let until: number | undefined;
  if (untilRaw) {
    const compact = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(untilRaw);
    until = compact
      ? Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]), Number(compact[4] || 23), Number(compact[5] || 59), Number(compact[6] || 59))
      : Date.parse(untilRaw);
    if (!Number.isFinite(until)) until = undefined;
  }
  const count = parts.get("COUNT") ? Math.max(0, Math.floor(Number(parts.get("COUNT")) || 0)) : undefined;
  const byHour = parseInts(parts.get("BYHOUR"), 0, 23);
  const byMinute = parseInts(parts.get("BYMINUTE"), 0, 59);
  const bySecond = parseInts(parts.get("BYSECOND"), 0, 59);
  const byMonthDay = parseInts(parts.get("BYMONTHDAY"), -31, 31);
  const byMonth = parseInts(parts.get("BYMONTH"), 1, 12);
  return {
    freq: freq as RRuleSpec["freq"],
    interval: Math.max(1, Math.floor(Number(parts.get("INTERVAL") || 1) || 1)),
    ...(count !== undefined ? { count } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(byHour ? { byHour } : {}),
    ...(byMinute ? { byMinute } : {}),
    ...(bySecond ? { bySecond } : {}),
    ...(weekdays.length ? { byDay: [...new Set(weekdays)] } : {}),
    ...(byMonthDay ? { byMonthDay } : {}),
    ...(byMonth ? { byMonth } : {})
  };
}

/** 规则两次发生之间的秒数；小于 1 天就折叠成全天事件。 */
function cadenceSeconds(spec: RRuleSpec): number {
  if (spec.freq === "SECONDLY") return spec.interval;
  if (spec.freq === "MINUTELY") return spec.interval * 60;
  if (spec.freq === "HOURLY") return spec.interval * 3_600;
  return Number.POSITIVE_INFINITY;
}

function isSubDailyTask(task: AgentScheduledTask): boolean {
  const spec = parseRRule(task.schedule);
  // 每小时及更频繁的任务都按天折叠；每天 / 每周 / 每月仍按实际时间展开。
  return !!spec && cadenceSeconds(spec) < 86_400;
}

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

function partsInZone(ms: number, timeZone: string): ZonedParts {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
    const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return { year, month, day, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday: jsDay === 0 ? 7 : jsDay };
  } catch {
    const d = new Date(ms);
    const jsDay = d.getUTCDay();
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), weekday: jsDay === 0 ? 7 : jsDay };
  }
}

function zoneOffsetMs(date: Date, timeZone: string): number {
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

function zonedUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = zoneOffsetMs(new Date(guess), timeZone);
  let value = guess - first;
  const secondOffset = zoneOffsetMs(new Date(value), timeZone);
  if (secondOffset !== first) value = guess - secondOffset;
  return value;
}

function dayNumber(parts: Pick<ZonedParts, "year" | "month" | "day">): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function weekStartDay(parts: Pick<ZonedParts, "year" | "month" | "day" | "weekday">): number {
  return dayNumber(parts) - (parts.weekday - 1);
}

function monthIndex(parts: Pick<ZonedParts, "year" | "month">): number {
  return parts.year * 12 + parts.month - 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateMatches(spec: RRuleSpec, anchor: ZonedParts, date: ZonedParts): boolean {
  if (date.year < anchor.year || (date.year === anchor.year && date.month < anchor.month)
    || (date.year === anchor.year && date.month === anchor.month && date.day < anchor.day)) return false;
  if (spec.freq === "DAILY") {
    return (dayNumber(date) - dayNumber(anchor)) % spec.interval === 0;
  }
  if (spec.freq === "WEEKLY") {
    if ((weekStartDay(date) - weekStartDay(anchor)) % (7 * spec.interval) !== 0) return false;
    return spec.byDay?.length ? spec.byDay.includes(date.weekday) : date.weekday === anchor.weekday;
  }
  if (spec.freq === "MONTHLY") {
    if ((monthIndex(date) - monthIndex(anchor)) % spec.interval !== 0) return false;
    if (spec.byMonth?.length && !spec.byMonth.includes(date.month)) return false;
    if (spec.byMonthDay?.length) {
      const max = daysInMonth(date.year, date.month);
      return spec.byMonthDay.some((raw) => (raw > 0 ? date.day === raw : date.day === max + raw + 1));
    }
    return date.day === Math.min(anchor.day, daysInMonth(date.year, date.month));
  }
  if (spec.freq === "YEARLY") {
    if ((date.year - anchor.year) % spec.interval !== 0) return false;
    const months = spec.byMonth?.length ? spec.byMonth : [anchor.month];
    if (!months.includes(date.month)) return false;
    if (spec.byMonthDay?.length) {
      const max = daysInMonth(date.year, date.month);
      return spec.byMonthDay.some((raw) => (raw > 0 ? date.day === raw : date.day === max + raw + 1));
    }
    return date.day === Math.min(anchor.day, daysInMonth(date.year, date.month));
  }
  return false;
}

function ruleOccurrences(task: AgentScheduledTask, fromMs: number, toMs: number): number[] {
  const spec = parseRRule(task.schedule);
  if (!spec || toMs <= fromMs) return [];
  const timeZone = task.timeZone || "UTC";
  // 没有创建时间的任务（launchd）当作长期存在；用固定周一做锚点，保证 2026 等任意月份都能展开。
  const parsedAnchor = Date.parse(task.anchor || "");
  const anchorMs = Number.isFinite(parsedAnchor) ? parsedAnchor : Date.UTC(2020, 0, 6);
  const anchor = partsInZone(anchorMs, timeZone);
  const starts: number[] = [];
  if (spec.freq === "HOURLY") {
    const step = Math.max(1, spec.interval) * 3_600_000;
    const first = anchorMs + Math.max(0, Math.ceil((fromMs - anchorMs) / step)) * step;
    for (let at = spec.count !== undefined ? anchorMs : first, n = 0; at < toMs && n < MAX_AGENT_EVENTS; at += step, n++) {
      if (spec.until !== undefined && at > spec.until) break;
      if (spec.count !== undefined && n >= spec.count) break;
      if (at >= fromMs && at >= anchorMs) starts.push(at);
    }
    return starts;
  }
  const fromParts = partsInZone(fromMs, timeZone);
  const toParts = partsInZone(toMs, timeZone);
  // 带 COUNT 的规则要从锚点开始数；否则从请求区间前一天开始就够了。
  const startDay = spec.count !== undefined ? dayNumber(anchor) : Math.max(dayNumber(anchor), dayNumber(fromParts) - 1);
  const endDay = dayNumber(toParts) + 1;
  const hours = spec.byHour?.length ? spec.byHour : [anchor.hour];
  const minutes = spec.byMinute?.length ? spec.byMinute : [anchor.minute];
  const seconds = spec.bySecond?.length ? spec.bySecond : [anchor.second];
  let emitted = 0;
  for (let day = startDay, n = 0; day <= endDay && n < MAX_RULE_DAYS && emitted < MAX_AGENT_EVENTS; day++, n++) {
    const date = new Date(day * 86_400_000);
    const dateParts: ZonedParts = {
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
      hour: 0, minute: 0, second: 0, weekday: date.getUTCDay() === 0 ? 7 : date.getUTCDay()
    };
    if (!dateMatches(spec, anchor, dateParts)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        for (const second of seconds) {
          const at = zonedUtc(dateParts.year, dateParts.month, dateParts.day, hour, minute, second, timeZone);
          if (at < anchorMs) continue;
          if (spec.until !== undefined && at > spec.until) continue;
          if (spec.count !== undefined && emitted >= spec.count) return starts;
          emitted++;
          if (at >= fromMs && at < toMs) starts.push(at);
        }
      }
    }
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

function eventTitle(task: AgentScheduledTask): string {
  return [task.app, task.scene, task.name].filter(Boolean).join(" · ");
}

function cadenceLabel(task: AgentScheduledTask): string {
  const spec = parseRRule(task.schedule);
  if (!spec) return "";
  if (spec.freq === "SECONDLY") return `每 ${spec.interval} 秒`;
  if (spec.freq === "MINUTELY") return `每 ${spec.interval} 分钟`;
  if (spec.freq === "HOURLY") return spec.interval === 1 ? "每小时" : `每 ${spec.interval} 小时`;
  return "";
}

function dateKeyFromDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

function shiftDateKey(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 每小时及更频繁的任务折叠成每天一条全天事件；其他任务按 RRULE 展开成 [from, to) 内的事件。 */
export function agentCalendarEvents(tasks: readonly AgentScheduledTask[], from: string, to: string): CalendarEvent[] {
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const out: CalendarEvent[] = [];
  for (const task of tasks) {
    const title = eventTitle(task);
    if (isSubDailyTask(task)) {
      // 常驻检查按天折叠：按北京时间划天，避免宿主机时区把「今天」推到前一天。
      const startDay = dayNumber(partsInZone(fromMs, PLATFORM_TIME_ZONE));
      const endDay = dayNumber(partsInZone(toMs - 1, PLATFORM_TIME_ZONE));
      for (let day = startDay; day <= endDay; day++) {
        const start = dateKeyFromDay(day);
        const cadence = cadenceLabel(task);
        const description = [
          cadence ? `${cadence}运行` : "",
          task.status === "paused" ? "已暂停" : "",
          task.description || ""
        ].filter(Boolean).join("；").slice(0, MAX_TEXT);
        out.push({
          id: `agent:${task.id}:${start}`,
          source: "agent",
          title,
          start,
          end: shiftDateKey(start, 1),
          allDay: true,
          calendarId: "agent:pi-agent",
          calendarName: "Agent",
          ...(description ? { description } : {}),
          agentApp: task.app,
          agentScene: task.scene,
          agentName: task.name,
          agentPlatform: "pi-agent",
          agentStatus: task.status
        });
      }
      continue;
    }
    const starts = ruleOccurrences(task, fromMs, toMs);
    for (const at of starts) {
      // 会调模型的任务（目前只有故障分诊）把每次运行的计费时段写清楚：峰时没有 5 折。
      const tariff = task.billing === "deepseek" ? (isPeak(new Date(at)) ? "计费时段：峰时（无折扣）" : "计费时段：波谷（峰时价的 5 折）") : "";
      const description = [
        tariff,
        task.status === "paused" ? "已暂停" : "",
        task.description || ""
      ].filter(Boolean).join("\n\n").slice(0, MAX_TEXT);
      out.push({
        id: `agent:${task.id}:${at}`,
        source: "agent",
        title,
        start: new Date(at).toISOString(),
        end: new Date(at + 3_600_000).toISOString(),
        calendarId: "agent:pi-agent",
        calendarName: "Agent",
        ...(description ? { description } : {}),
        agentApp: task.app,
        agentScene: task.scene,
        agentName: task.name,
        agentPlatform: "pi-agent",
        agentStatus: task.status
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title));
}
