/**
 * 日程提醒（v3.47）：新建日程时同步判断「提前多久提醒」。
 *
 * 1. 文字里明说了（「提前 1 小时提醒」「开会前半小时提醒我」）→ 按说的提醒；
 * 2. 没说 → 按场景推断：
 *    - 上班回家：提前 1 小时；
 *    - 生日纪念日：提前 1 / 3 / 5 / 7 天（全天日程在当天北京时间 09:00 提醒）；
 *    - 机票火车票：提前 1 天 / 1.5 小时；
 * 3. 不在以上场景 → 不提醒。
 *
 * 判断结果是记录自己的数据（schedule.remind），页面与推送共用，不在客户端重复推断。
 */
import type { NoteRemind, NoteReminderScene, NoteSchedule } from "./notes.js";

const MINUTES_PER_DAY = 1440;
/** 单个提前量上限：30 天，防止模型或输入写出离谱的数字 */
export const NOTE_REMIND_MAX_MINUTES = 30 * MINUTES_PER_DAY;
/** 一条日程最多几个提前量（生日 1/3/5/7 天就是 4 个） */
export const NOTE_REMIND_MAX_OFFSETS = 8;
/** 全天日程的提醒时刻：当天北京时间 09:00 */
export const NOTE_REMIND_ALL_DAY_HOUR = 9;

const UNIT_MINUTES: Record<string, number> = {
  分钟: 1, 分: 1, 小时: 60, 钟头: 60, 天: MINUTES_PER_DAY, 日: MINUTES_PER_DAY,
  周: 7 * MINUTES_PER_DAY, 星期: 7 * MINUTES_PER_DAY, 礼拜: 7 * MINUTES_PER_DAY,
  个月: 30 * MINUTES_PER_DAY, 月: 30 * MINUTES_PER_DAY
};
const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文 / 阿拉伯数字（含「半」）：支持 半、十、十五、二十、二十五。 */
export function noteRemindCount(raw: string): number | undefined {
  const s = String(raw || "").trim();
  if (!s) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s === "半") return 0.5;
  if (!/^[零一二两三四五六七八九十]+$/.test(s)) return undefined;
  if (!s.includes("十")) return s.length === 1 ? CN_DIGITS[s] : undefined;
  const ten = s.indexOf("十");
  if (ten !== s.lastIndexOf("十")) return undefined;
  const tens = ten === 0 ? 1 : CN_DIGITS[s.slice(0, ten)];
  const ones = ten === s.length - 1 ? 0 : CN_DIGITS[s.slice(ten + 1)];
  if (tens === undefined || ones === undefined) return undefined;
  return tens * 10 + ones;
}

const NUMBER = "(?:半|\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十]+)";
const UNITS = Object.keys(UNIT_MINUTES).sort((a, b) => b.length - a.length).join("|");
const TOKEN = new RegExp(`(${NUMBER})\\s*个?\\s*(半)?\\s*(${UNITS})?|(${UNITS})`, "g");

/**
 * 「提前 X」「X 前」后面的那一小段 → 分钟数列表。
 * 支持多个提前量：1/3/5/7 天、1 天 1.5 小时、一天半、半小时。
 */
export function parseNoteRemindOffsets(block: string): number[] {
  const text = String(block || "")
    // 「一天半」「两小时半」：半跟在单位后面，先折算成 1.5 天 / 2.5 小时。
    .replace(new RegExp(`(${NUMBER})\\s*个?\\s*(${UNITS})\\s*半`, "g"), (_all, count: string, unit: string) => `${noteRemindCount(count) ?? 0}.5${unit}`)
    .replace(/提醒|通知|叫我|提示|记得|左右|之前|以前|前|我|要|会|请|一下/g, " ")
    .replace(/[、,，和或/]/g, " ");
  const tokens: Array<{ count: number; unit?: string }> = [];
  let bareUnit: string | undefined;
  let consumed = "";
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    consumed += m[0];
    if (m[4]) { bareUnit = m[4]; if (tokens.length) tokens[tokens.length - 1]!.unit ??= bareUnit; continue; }
    const count = noteRemindCount(m[1]!);
    if (count === undefined) return [];
    const value = count + (m[2] ? 0.5 : 0);
    const unit = m[3];
    tokens.push({ count: value, ...(unit ? { unit } : {}) });
  }
  // 除了分隔符和这些 token，不允许有别的内容，避免把「提前准备一下」当成提醒时间。
  const rest = text.replace(TOKEN, "").replace(/\s+/g, "");
  if (rest || !tokens.length) return [];
  // 没有单位的 token 沿用最近的单位（「1/3/5/7 天」只有最后一个带单位）。
  const offsets: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    let unit = token.unit;
    if (!unit) for (let j = i + 1; j < tokens.length && !unit; j++) unit = tokens[j]!.unit;
    if (!unit) for (let j = i - 1; j >= 0 && !unit; j--) unit = tokens[j]!.unit;
    if (!unit) continue;
    const minutes = Math.round(token.count * (UNIT_MINUTES[unit] ?? 0));
    if (minutes > 0 && minutes <= NOTE_REMIND_MAX_MINUTES) offsets.push(minutes);
  }
  return [...new Set(offsets)].sort((a, b) => b - a).slice(0, NOTE_REMIND_MAX_OFFSETS);
}

/** 文字里明说的提醒时间：按句看，句子里要有「提醒 / 通知 / 叫我 / 提示」。 */
export function explicitNoteRemindOffsets(text: string): number[] {
  const clauses = String(text || "").split(/[。；;！!？?\n]/);
  const offsets: number[] = [];
  for (const clause of clauses) {
    if (!/提醒|通知|叫我|提示/.test(clause)) continue;
    for (const m of clause.matchAll(/提前\s*([^。；;！!？?\n]*)/g)) {
      offsets.push(...parseNoteRemindOffsets(m[1]!));
    }
    for (const m of clause.matchAll(new RegExp(`(${NUMBER})\\s*个?\\s*(半)?\\s*(${UNITS})\\s*(?:之前|以前|前)`, "g"))) {
      offsets.push(...parseNoteRemindOffsets(m[0]!));
    }
    // 「开会前 1 小时提醒我」：「前」在数字前面也算（和「提前 1 小时」重复时下面会去重）。
    for (const m of clause.matchAll(new RegExp(`前\\s*(${NUMBER})\\s*个?\\s*(半)?\\s*(${UNITS})`, "g"))) {
      offsets.push(...parseNoteRemindOffsets(m[0]!));
    }
  }
  return [...new Set(offsets)].filter((m) => m > 0 && m <= NOTE_REMIND_MAX_MINUTES)
    .sort((a, b) => b - a).slice(0, NOTE_REMIND_MAX_OFFSETS);
}

/** 场景：按需求里明确的三种；文字同时命中多个时，提前量取并集，场景记优先级最高的一个。 */
const SCENES: Array<{ scene: NoteReminderScene; offsets: number[]; pattern: RegExp }> = [
  { scene: "travel", offsets: [MINUTES_PER_DAY, 90], pattern: /机票|飞机票|航班|飞机|登机|值机|高铁|动车|火车|列车|车次|机场|大巴|长途汽车/ },
  { scene: "birthday", offsets: [7 * MINUTES_PER_DAY, 5 * MINUTES_PER_DAY, 3 * MINUTES_PER_DAY, MINUTES_PER_DAY], pattern: /生日|纪念日|周年|忌日|祭日|满月|百天/ },
  { scene: "commute", offsets: [60], pattern: /上班|下班|通勤|回家|出门|接小明|送小明|放学/ }
];

/** 一条日程该提前多久提醒；没有明说、也不在已知场景里 → null（不提醒）。 */
export function noteRemindPlan(text: string): NoteRemind | null {
  const explicit = explicitNoteRemindOffsets(text);
  if (explicit.length) return { offsets: explicit, source: "explicit", scene: "explicit" };
  const matched = SCENES.filter((s) => s.pattern.test(text));
  if (!matched.length) return null;
  const offsets = [...new Set(matched.flatMap((s) => s.offsets))].sort((a, b) => b - a).slice(0, NOTE_REMIND_MAX_OFFSETS);
  return { offsets, source: "inferred", scene: matched[0]!.scene };
}

/** 把提醒计划挂到日程上；没有计划时去掉旧计划（文字改掉后不会留下过期提醒）。 */
export function withNoteRemind(schedule: NoteSchedule | null | undefined, text: string): NoteSchedule | null {
  if (!schedule) return schedule ?? null;
  const { remind: _old, ...rest } = schedule;
  const plan = noteRemindPlan(text);
  return plan ? { ...rest, remind: plan } : rest;
}

/** 一个提前量的说法：提前 1 天 / 提前 1.5 小时 / 提前 30 分钟。 */
export function noteRemindOffsetLabel(minutes: number): string {
  const value = Math.max(1, Math.round(minutes));
  if (value % MINUTES_PER_DAY === 0) return `提前 ${value / MINUTES_PER_DAY} 天`;
  if (value >= 60 && value % 30 === 0) {
    const hours = value / 60;
    return `提前 ${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
  }
  return `提前 ${value} 分钟`;
}

/** 整条日程的提醒说法：同一单位时合并成「提前 7 / 5 / 3 / 1 天」。 */
export function noteRemindLabel(offsets: number[]): string {
  const list = [...new Set(offsets)].filter((m) => m > 0).sort((a, b) => b - a);
  if (!list.length) return "";
  if (list.every((m) => m % MINUTES_PER_DAY === 0)) return `提前 ${list.map((m) => m / MINUTES_PER_DAY).join(" / ")} 天`;
  return list.map(noteRemindOffsetLabel).join("、");
}

export const NOTE_REMIND_SCENE_LABEL: Record<NoteReminderScene, string> = {
  explicit: "按你说的",
  travel: "按机票 / 火车票场景",
  birthday: "按生日 / 纪念日场景",
  commute: "按上班回家场景",
  renewal: "按续费 / 周期事项"
};

/** 提醒来源说明（页面详情里用）：明说的写「按你说的」，推断的写场景。 */
export function noteRemindSourceLabel(remind: NoteRemind): string {
  return NOTE_REMIND_SCENE_LABEL[remind.scene] ?? "按场景推断";
}

/**
 * 某一次日程的提醒时刻（毫秒）：定时日程按开始时间（只有截止时按截止）提前；
 * 全天日程按当天北京时间 09:00 提前，保证生日这类「提前 1 天」落在早上而不是半夜。
 */
export function noteReminderInstant(input: { minutes: number; anchor: number; allDay: boolean; dayStart?: number }): number {
  const base = input.allDay
    ? (input.dayStart ?? input.anchor) + NOTE_REMIND_ALL_DAY_HOUR * 3600_000
    : input.anchor;
  return base - input.minutes * 60_000;
}
