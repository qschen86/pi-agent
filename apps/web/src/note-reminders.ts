/**
 * 日程提醒的投递（v3.47）：每 30 秒看一遍所有日程，到点的提醒走全端推送。
 *
 * - 真正的提醒时间由日程本身给出（calendar.ts 的 event.reminders），这里只负责「到点只推一次」；
 * - 记录记下之前就已经过的提醒不补推（新建一条旧日程不该立刻响）；
 * - 投递状态写磁盘：重启 / 蓝绿切换后不会重复推；
 * - 只推未来 15 分钟内到点的提醒，过期太久的不打扰。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Note, NoteRemind, NoteStore } from "./notes.js";
import { noteCalendarEvents, noteEventTitle } from "./calendar.js";
import { beijingDayStartMs, beijingParts } from "./platform-time.js";
import { NOTE_REMIND_MAX_MINUTES, noteRemindOffsetLabel } from "./note-reminder.js";

const DAY_MS = 86_400_000;
/** 到点后多久之内还愿意推（进程刚重启 / 短暂离线） */
export const NOTE_REMIND_LATE_MS = 15 * 60_000;
/** 投递记录保留多久 */
const SENT_RETENTION_MS = 60 * DAY_MS;

export interface NoteReminderView {
  /** 去重键：同一条日程的同一次发生 + 同一个提前量 */
  key: string;
  noteId: string;
  title: string;
  minutes: number;
  /** 提醒时刻（毫秒） */
  at: number;
  /** 这一次日程的开始时刻（全天为当天北京时间零点） */
  eventStart: number;
  allDay: boolean;
  source: NoteRemind["source"];
  scene: NoteRemind["scene"];
}

export interface NoteReminderPush {
  /** 推送去重 id */
  id: string;
  title: string;
  body: string;
  /** 点开后落在哪：沿用已有的记录深链 */
  url: string;
  /** 提醒时刻（毫秒），推送过期用 */
  at: number;
}


/**
 * 扫描 [from, to] 内到点的提醒（毫秒）。日程本身可能晚于提醒（最多提前 30 天），
 * 展开日程时向后多看 30 天。记录是后来才写的，提醒点在记录之前的不补推。
 */
export function scanNoteReminders(notes: Note[], from: number, to: number, now = Date.now()): NoteReminderView[] {
  const out: NoteReminderView[] = [];
  const toIso = new Date(to + NOTE_REMIND_MAX_MINUTES * 60_000 + DAY_MS).toISOString();
  const fromIso = new Date(Math.min(from, now) - DAY_MS).toISOString();
  for (const note of notes) {
    if (note.kind === "note" || note.done || !note.schedule?.remind) continue;
    const created = Date.parse(note.createdAt);
    let events;
    try { events = noteCalendarEvents(note, { from: fromIso, to: toIso }); } catch { continue; }
    for (const event of events) {
      const allDay = event.allDay === true;
      const eventStart = allDay ? beijingDayStartMs(event.start.slice(0, 10)) : Date.parse(event.start);
      if (!Number.isFinite(eventStart)) continue;
      for (const reminder of event.reminders ?? []) {
        const at = Date.parse(reminder.at);
        if (!(at >= from && at <= to)) continue;
        if (Number.isFinite(created) && at < created - 60_000) continue;
        out.push({
          key: `${note.id}|${event.start}|${reminder.minutes}`,
          noteId: note.id,
          title: noteEventTitle(note.text),
          minutes: reminder.minutes,
          at,
          eventStart,
          allDay,
          source: note.schedule.remind.source,
          scene: note.schedule.remind.scene
        });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at || a.title.localeCompare(b.title));
}

interface State { version: 1; sent: Record<string, number> }

const p2 = (n: number) => String(n).padStart(2, "0");
const cnDay = (parts: { month: number; day: number }) => `${parts.month} 月 ${parts.day} 日`;

/** 提醒正文里的日程时间：今天 / 明天 / 其余带日期；全天不写时分。 */
export function noteReminderWhen(view: Pick<NoteReminderView, "eventStart" | "allDay">, now = Date.now()): string {
  const parts = beijingParts(view.eventStart);
  if (!parts) return "";
  const today = beijingParts(now);
  const tomorrow = beijingParts(now + DAY_MS);
  const dayKey = (p: { year: number; month: number; day: number }) => `${p.year}-${p2(p.month)}-${p2(p.day)}`;
  const label = today && dayKey(parts) === dayKey(today) ? "今天"
    : tomorrow && dayKey(parts) === dayKey(tomorrow) ? "明天" : cnDay(parts);
  return view.allDay ? `${label} 全天` : `${label} ${p2(parts.hour)}:${p2(parts.minute)}`;
}

/** 记录深链：复用已有的 #/notes/widget/<日期>/<noteId> 入口。 */
export function noteReminderUrl(view: Pick<NoteReminderView, "eventStart" | "noteId">): string {
  const parts = beijingParts(view.eventStart);
  const day = parts ? `${parts.year}-${p2(parts.month)}-${p2(parts.day)}` : "";
  return `/#/notes/widget/${day}/${encodeURIComponent(view.noteId)}`;
}

export function noteReminderPushMessage(note: Note, view: NoteReminderView, now = Date.now()): NoteReminderPush {
  const title = noteEventTitle(note.text);
  const when = noteReminderWhen(view, now);
  return {
    id: `note-reminder:${view.key}`,
    title: `日程提醒 · ${title.slice(0, 60)}`,
    body: `${when} · ${noteRemindOffsetLabel(view.minutes)}`,
    url: noteReminderUrl(view),
    at: view.at
  };
}

interface Options {
  notes: NoteStore;
  /** 投递记录放哪（一般是数据目录下的 note-reminders） */
  dir: string;
  send: (push: NoteReminderPush) => void | Promise<void>;
  now?: () => number;
  tickMs?: number;
  autoStart?: boolean;
}

export class NoteReminders {
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly file: string;
  private sent: Record<string, number> = {};
  private timer?: NodeJS.Timeout;
  private running = false;
  private again = false;
  private closed = false;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 30_000;
    this.file = join(options.dir, "note-reminders.json");
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    this.load();
    if (options.autoStart !== false) this.start();
  }

  /** 开始定时扫描；服务端等原生 FCM 队列也接好后再调用，避免启动瞬间只推到 Web 端。 */
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => { /* 下一拍再试 */ }), this.tickMs);
    this.timer.unref();
    this.wake();
  }

  /** 记录有变化：马上算一次，新建日程后不用等下一拍。 */
  wake(): void {
    if (this.closed) return;
    if (this.running) { this.again = true; return; }
    void this.tick().catch(() => { /* 下一拍再试 */ });
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 未来 days 天内的提醒（页面「即将提醒」用），按时间先后。 */
  list(days = 8, limit = 5): NoteReminderView[] {
    const now = this.now();
    return scanNoteReminders(this.options.notes.list(), now, now + days * DAY_MS, now).slice(0, limit);
  }

  /** 到点的提醒：推一次并记盘。返回这次推了几条（测试用）。 */
  async tick(): Promise<number> {
    if (this.closed) return 0;
    if (this.running) { this.again = true; return 0; }
    this.running = true;
    let delivered = 0;
    try {
      const now = this.now();
      const notes = new Map(this.options.notes.list().map((note) => [note.id, note]));
      const due = scanNoteReminders(this.options.notes.list(), now - NOTE_REMIND_LATE_MS, now, now).filter((view) => !this.sent[view.key]);
      for (const view of due) {
        const note = notes.get(view.noteId);
        if (!note) continue;
        // 日程已经结束（全天日程到次日零点）就没必要再响。
        if (view.eventStart + DAY_MS <= now) continue;
        try {
          await this.options.send(noteReminderPushMessage(note, view, now));
          this.sent[view.key] = now;
          delivered++;
        } catch { /* 推送服务不可用时下一拍重试（15 分钟内） */ }
      }
      if (delivered) this.save();
    } finally {
      this.running = false;
      if (this.again) { this.again = false; queueMicrotask(() => this.wake()); }
    }
    return delivered;
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const state = JSON.parse(readFileSync(this.file, "utf8")) as State;
      if (state?.version === 1 && state.sent && typeof state.sent === "object") this.sent = state.sent;
    } catch { /* 坏文件按没有投递记录处理 */ }
  }

  private save(): void {
    const now = this.now();
    for (const [key, at] of Object.entries(this.sent)) if (!(at + SENT_RETENTION_MS > now)) delete this.sent[key];
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sent: this.sent }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
