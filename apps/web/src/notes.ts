/**
 * 待办记录（大备忘录）：按时间顺序存下每次记下的一个小想法。
 *
 * 存成一个 JSON 数组，放在控制台的数据目录里，随会话数据一起被备份/迁移。
 * 图片字节单独放在同目录的 `notes-images/` 下，记录里只存引用元数据。
 * 写入走「临时文件 → rename」：读者要么看到旧版本、要么看到完整的新版本，
 * 不会读到写了一半的 JSON（同 FileStateStore 的做法）。
 *
 * 只负责存取与基本形状校验，业务校验（空文本、长度上限）在 ConsoleService。
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { buildRelationIndex, validateMetadata } from "./note-relations.js";
import { prepareRelationHistory } from "./note-relation-history.js";
import type { LunarRule } from "./lunar.js";
import { RelationError, emptyRelations, type RelationReceipt, type RelationContext } from "./note-relation-types.js";

export type NoteImageMime = "image/png" | "image/jpeg" | "image/webp";

/** 记录里附带的一张图片；字节存在 notes-images/ 下，按 id 取。 */
export interface NoteImage {
  id: string;
  name: string;
  mimeType: NoteImageMime;
  byteSize: number;
  width: number;
  height: number;
}

/**
 * 待办的日程时间：至少有一端；只有 start / 只有 end 也成立（日历上按 1 小时块展示）。
 * 存 ISO 时间，页面按本地时区显示；全天日程（allDay）的 start / end 是 YYYY-MM-DD（end 含当天）。
 * repeats 是不相邻的另外几天的开始时间（「11 号、12 号晚上 7 点」），格式与 start 相同；
 * 每次的时长沿用 start → end（没有 end 时按日历默认 1 小时）。
 * repeat 是周期性安排（每天 / 每周 / 每月 / 每年），按第一次的北京时间墙上时间推进；
 * 与 repeats 互斥。
 */
export interface NoteSchedule {
  start?: string;
  end?: string;
  allDay?: boolean;
  repeats?: string[];
  repeat?: NoteRepeat;
}

export type NoteRepeatFrequency = "daily" | "weekly" | "monthly" | "yearly";

/** 星期几（周一在前，与页面一致）；只用于每周重复的 byDay。 */
export const NOTE_REPEAT_WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type NoteRepeatWeekday = typeof NOTE_REPEAT_WEEKDAYS[number];

/** 周期性安排：until 与 count 最多给一个；都不给表示一直重复。 */
export interface NoteRepeat {
  freq: NoteRepeatFrequency;
  /** 间隔：每 N 天 / 周 / 月 / 年，1–99；缺省 1 */
  interval?: number;
  /**
   * 每周重复时落在星期几（仅 freq 为 weekly）：工作日 = MO–FR，每周一三五 = MO、WE、FR。
   * 缺省 = 只在第一次那天的星期几。第一次所在的那一周从周一算起；开始日期不在 byDay 里时，
   * 开始日期本身不算一次，从之后第一个匹配的日子起。count 数的是匹配到的次数。
   */
  byDay?: NoteRepeatWeekday[];
  /** 最后一次（含）：全天日程为 YYYY-MM-DD，定时日程可以带时间或只给日期 */
  until?: string;
  /** 一共重复多少次（含第一次），1–500 */
  count?: number;
  /**
   * 农历周期（v3.110）：freq 为 yearly = 每年农历 month 月的 days 日；freq 为 monthly = 每个农历月的 days 日。
   * 公历日期由宿主用农历历法换算（lunar.ts），不由模型换算；不能和 byDay 同用。
   */
  lunar?: LunarRule;
}

/** 一条日程最多列多少个重复的开始时间（防止模型把每天都展开成几十条） */
export const NOTE_SCHEDULE_MAX_REPEATS = 31;
/** 周期日程最多重复多少次（含第一次） */
export const NOTE_REPEAT_MAX_COUNT = 500;
/** 周期间隔上限 */
export const NOTE_REPEAT_MAX_INTERVAL = 99;

const NOTE_REPEAT_FREQUENCIES: readonly NoteRepeatFrequency[] = ["daily", "weekly", "monthly", "yearly"];

/** 农历周期规则校验：每年要 month，每月不能有 month；leap 只配 month；days 是 1–4 个不重复的农历日（1–30）。 */
function isLunarRule(value: unknown, freq: unknown): value is LunarRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const l = value as Partial<LunarRule>;
  if (Object.keys(l).some((key) => key !== "month" && key !== "leap" && key !== "days")) return false;
  if (freq !== "yearly" && freq !== "monthly") return false;
  if (!Array.isArray(l.days) || !l.days.length || l.days.length > 4) return false;
  if (l.days.some((d) => !Number.isInteger(d) || d < 1 || d > 30) || new Set(l.days).size !== l.days.length) return false;
  if (freq === "yearly" ? !Number.isInteger(l.month) || l.month! < 1 || l.month! > 12 : l.month !== undefined) return false;
  if (l.leap !== undefined && (typeof l.leap !== "boolean" || freq !== "yearly")) return false;
  return true;
}

/** 周期规则校验：字段白名单、频率、间隔、次数与 until 格式。 */
export function isNoteRepeat(value: unknown, allDay = false): value is NoteRepeat {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Partial<NoteRepeat>;
  if (Object.keys(r).some((key) => key !== "freq" && key !== "interval" && key !== "until" && key !== "count" && key !== "byDay" && key !== "lunar")) return false;
  if (!NOTE_REPEAT_FREQUENCIES.includes(r.freq as NoteRepeatFrequency)) return false;
  if (r.byDay !== undefined) {
    if (r.freq !== "weekly" || !Array.isArray(r.byDay) || !r.byDay.length || r.byDay.length > 7) return false;
    if (r.byDay.some((day) => !NOTE_REPEAT_WEEKDAYS.includes(day)) || new Set(r.byDay).size !== r.byDay.length) return false;
  }
  if (r.lunar !== undefined && (r.byDay !== undefined || !isLunarRule(r.lunar, r.freq))) return false;
  if (r.interval !== undefined && (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > NOTE_REPEAT_MAX_INTERVAL)) return false;
  if (r.count !== undefined && (!Number.isInteger(r.count) || r.count < 1 || r.count > NOTE_REPEAT_MAX_COUNT)) return false;
  if (r.until !== undefined) {
    if (typeof r.until !== "string" || !r.until || !Number.isFinite(Date.parse(r.until))) return false;
    if (allDay && !/^\d{4}-\d{2}-\d{2}$/.test(r.until)) return false;
  }
  if (r.until !== undefined && r.count !== undefined) return false;
  return true;
}

/** 周期规则的规范形式：byDay 按周一到周日排序（页面文案、存储都稳定）。其余字段原样复制。 */
export function normalizeNoteRepeat(repeat: NoteRepeat): NoteRepeat {
  const { byDay, lunar, ...rest } = repeat;
  if (lunar) return { ...rest, lunar: { ...(lunar.month !== undefined ? { month: lunar.month } : {}), ...(lunar.leap ? { leap: true } : {}), days: [...lunar.days].sort((a, b) => a - b) } };
  if (!byDay) return { ...rest };
  return { ...rest, byDay: [...byDay].sort((a, b) => NOTE_REPEAT_WEEKDAYS.indexOf(a) - NOTE_REPEAT_WEEKDAYS.indexOf(b)) };
}

/**
 * 记录的大类（v3.17）：笔记 = 想法记录；待办 = 要去做的事；日程 = 有时间的待办（kind 为 todo 且带 schedule）。
 * 旧记录没有 kind，一律按待办。
 */
export type NoteKind = "note" | "todo";
/** 平台自动任务及其运行记录；人工介入不改变 Agent 归属。 */
export interface NoteAutomation { taskId: string; needsHuman: boolean }

export function isNoteAutomation(value: unknown): value is NoteAutomation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as NoteAutomation;
  return typeof a.taskId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/.test(a.taskId)
    && typeof a.needsHuman === "boolean";
}

/** 旧回归脚本没有写来源：只认标题和专用脚本路径共同出现的记录。 */
export function noteAutomation(note: Pick<Note, "text" | "automation">): NoteAutomation | undefined {
  if (isNoteAutomation(note.automation)) return note.automation;
  if (/^【每日完整回归(?:失败|未按时完成)】/.test(note.text)
    && note.text.includes("node ~/.pi-agent-gui/control/nightly-regression.mjs run")) {
    return { taskId: "nightly-regression", needsHuman: /需人工处理|^【每日完整回归未按时完成】/.test(note.text) };
  }
  return undefined;
}
/** 页面看到的三类：日程由「待办 + 时间」派生，不单独存。 */
export type NoteDisplayKind = "note" | "todo" | "event";
export const noteDisplayKind = (note: Pick<Note, "kind" | "schedule">): NoteDisplayKind =>
  note.kind === "note" ? "note" : note.schedule ? "event" : "todo";

export type NoteWriting = { state: "pending" | "failed" } | {
  state: "ready"; id: string; originalText: string; formattedText: string; refinedText: string; suggestion: string;
};

export interface Note {
  relations?: import("./note-relation-types.js").NoteRelations;
  id: string;
  automation?: NoteAutomation;
  /** 正文；按原样保存，只做首尾空白裁剪 */
  text: string;
  /** AI 基础整理的原文与待人工决定的建议；只针对当前正文。 */
  writing?: NoteWriting;
  /** 记下的时刻（ISO） */
  createdAt: string;
  /** 最近一次编辑的时刻；从未编辑过则为空 */
  updatedAt?: string;
  /** 是否已完成 */
  done?: boolean;
  /** 最近一次标记完成的时刻；取消完成则清空 */
  doneAt?: string;
  /** 附带的图片；没有图片时字段缺省 */
  images?: NoteImage[];
  /** 关联日程的开始 / 结束时间；没有时间时字段缺省，不进入日历 */
  schedule?: NoteSchedule;
  /** 大类；缺省为待办 */
  kind?: NoteKind;
  /** 谁定的大类：AI 判断，或人工指定（人工指定后编辑正文不再让 AI 改大类） */
  kindSource?: "ai" | "user";
  /** 正在等 AI 判断大类 */
  kindPending?: boolean;
  /** 置顶：在今日卡片的推荐模块里排在全部推荐之前，并带置顶标记 */
  pinned?: boolean;
  /** 置顶时刻；取消置顶时清空 */
  pinnedAt?: string;
}

/** 单条上限：再长就属于文档而不是「小想法」了 */
export const NOTE_MAX_LENGTH = 20000;
/** 完整保留的记录条数上限：超出后最早的记录会被丢弃 */
export const NOTE_MAX_COUNT = 5000;

/** 批量导入一条记录：与手记不同，时间由导入方给（外部笔记的原始记录时间） */
export interface NoteImportEntry {
  text: string;
  createdAt: string;
  images?: NoteImage[];
  kind?: NoteKind;
  kindSource?: "ai" | "user";
  pinned?: boolean;
}
/** 一条记录最多带几张图片 */
export const NOTE_MAX_IMAGES = 9;
/** 单张图片字节上限 */
export const NOTE_IMAGE_MAX_BYTES = 10 * 1024 ** 2;
const NOTE_IMAGE_MAX_SIDE = 16384;
const NOTE_IMAGE_MAX_PIXELS = 40_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isImage(value: unknown): value is NoteImage {
  const i = value as Partial<NoteImage> | null;
  return !!i && typeof i === "object" && typeof i.id === "string" && i.id.length > 0
    && typeof i.name === "string" && typeof i.mimeType === "string"
    && typeof i.byteSize === "number" && typeof i.width === "number" && typeof i.height === "number";
}

export function isSchedule(value: unknown): value is NoteSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Partial<NoteSchedule>;
  if (Object.keys(s).some((key) => key !== "start" && key !== "end" && key !== "allDay" && key !== "repeats" && key !== "repeat")) return false;
  if (s.allDay !== undefined && s.allDay !== true) return false;
  if (s.start === undefined && s.end === undefined) return false;
  for (const key of ["start", "end"] as const) {
    const raw = s[key];
    if (raw !== undefined && (typeof raw !== "string" || !raw || !Number.isFinite(Date.parse(raw)))) return false;
    if (raw !== undefined && s.allDay && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  }
  if (s.repeats !== undefined) {
    if (!Array.isArray(s.repeats) || !s.repeats.length || s.repeats.length > NOTE_SCHEDULE_MAX_REPEATS) return false;
    for (const raw of s.repeats) {
      if (typeof raw !== "string" || !raw || !Number.isFinite(Date.parse(raw))) return false;
      if (s.allDay && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
    }
  }
  if (s.repeat !== undefined) {
    if (s.repeats !== undefined) return false;
    if (!isNoteRepeat(s.repeat, s.allDay === true)) return false;
  }
  if (s.start !== undefined && s.end !== undefined && Date.parse(s.end) < Date.parse(s.start)) return false;
  return true;
}

function cloneSchedule(schedule: NoteSchedule): NoteSchedule {
  return {
    ...schedule,
    ...(schedule.repeats ? { repeats: [...schedule.repeats] } : {}),
    ...(schedule.repeat ? { repeat: normalizeNoteRepeat(schedule.repeat) } : {})
  };
}

function cloneNote(note: Note): Note {
  const automation = noteAutomation(note);
  return {
    ...note,
    ...(note.relations ? { relations: structuredClone(note.relations) } : {}),
    ...(automation ? { automation: { ...automation } } : {}),
    ...(note.writing ? { writing: { ...note.writing } } : {}),
    ...(note.images ? { images: note.images.map((i) => ({ ...i })) } : {}),
    ...(note.schedule ? { schedule: cloneSchedule(note.schedule) } : {})
  };
}

function isNote(value: unknown): value is Note {
  const n = value as Partial<Note> | null;
  return !!n && typeof n === "object" && typeof n.id === "string" && n.id.length > 0
    && typeof n.text === "string" && typeof n.createdAt === "string" && n.createdAt.length > 0
    && (n.updatedAt === undefined || typeof n.updatedAt === "string")
    && (n.done === undefined || typeof n.done === "boolean")
    && (n.doneAt === undefined || typeof n.doneAt === "string")
    && (n.images === undefined || (Array.isArray(n.images) && n.images.every(isImage)))
    && (n.schedule === undefined || (!!n.schedule && typeof n.schedule === "object" && !Array.isArray(n.schedule)));
}

/** 大类字段是 v3.17 新加的：不认识的取值只丢掉这些字段（按待办），不丢掉整条记录。 */
function cleanKind(note: Note): Note {
  if ((note.kind === undefined || note.kind === "note" || note.kind === "todo")
    && (note.kindSource === undefined || note.kindSource === "ai" || note.kindSource === "user")
    && (note.kindPending === undefined || note.kindPending === true)) return note;
  const cleaned = { ...note };
  if (cleaned.kind !== "note" && cleaned.kind !== "todo") delete cleaned.kind;
  if (cleaned.kindSource !== "ai" && cleaned.kindSource !== "user") delete cleaned.kindSource;
  if (cleaned.kindPending !== true) delete cleaned.kindPending;
  return cleaned;
}

/** 置顶字段是新加的：不认识的取值只丢掉置顶标记，不丢掉整条记录。 */
function cleanPinned(note: Note): Note {
  if ((note.pinned === undefined || typeof note.pinned === "boolean")
    && (note.pinnedAt === undefined || typeof note.pinnedAt === "string")) return note;
  const cleaned = { ...note };
  if (typeof cleaned.pinned !== "boolean") delete cleaned.pinned;
  if (typeof cleaned.pinnedAt !== "string") delete cleaned.pinnedAt;
  return cleaned;
}

interface StoredNoteImage extends NoteImage { sha256?: string; sourceSha256?: string }
const SHA256 = /^[a-f0-9]{64}$/;
const publicImage = ({ sha256: _h, sourceSha256: _s, ...image }: StoredNoteImage): NoteImage => image;

/** 图片校验 / 读取失败的输入问题（对应 400/404/413） */
export class NoteImageError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 413 = 400) { super(message); }
}

/**
 * 待办图片：平台私有、按 id 存放。
 *
 * 每张图三个文件：`.bin` 原图、`.webp` 缩略图、`.json` 元数据（正文不依赖它，
 * 只用于按 id 取图时判断类型与完整性）。上传时用 sharp 校验格式、尺寸与可解码性。
 */
export class NoteImageStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private file(id: string, ext: "bin" | "webp" | "json"): string {
    if (!/^img-[a-f0-9]{32}$/.test(id)) throw new NoteImageError("图片不存在", 404);
    return join(this.root, `${id}.${ext}`);
  }

  /** 存储侧多记两个哈希（不进记录正文）：sha256 = 收到的字节，sourceSha256 = 浏览器压缩前的原文件。 */
  private stored(id: string): StoredNoteImage | undefined {
    try { return JSON.parse(readFileSync(this.file(id, "json"), "utf8")) as StoredNoteImage; } catch { return undefined; }
  }

  /** 已存的一份：两份文件都在、原图大小对得上才算数。 */
  private intact(r: StoredNoteImage): boolean {
    try { return existsSync(this.file(r.id, "webp")) && statSync(this.file(r.id, "bin")).size === r.byteSize; } catch { return false; }
  }

  /** 同一张图只占一份空间：新 id 的文件硬链接到已存的那份，删任何一条都不影响别的。 */
  private copyOf(base: StoredNoteImage, name: string, sourceSha256?: string): NoteImage {
    const record: StoredNoteImage = { id: `img-${randomUUID().replace(/-/g, "")}`, name: name.slice(0, 200), mimeType: base.mimeType, byteSize: base.byteSize, width: base.width, height: base.height, ...(base.sha256 ? { sha256: base.sha256 } : {}), ...(sourceSha256 ? { sourceSha256 } : {}) };
    try {
      for (const ext of ["bin", "webp"] as const) {
        const from = this.file(base.id, ext), to = this.file(record.id, ext);
        try { linkSync(from, to); } catch { copyFileSync(from, to); }
      }
      this.saveRecord(record);
    } catch (e) { this.remove(record.id); throw e; }
    return publicImage(record);
  }

  private all(): StoredNoteImage[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).flatMap((f) => { const m = /^(img-[a-f0-9]{32})\.json$/.exec(f); const r = m ? this.stored(m[1]!) : undefined; return r ? [r] : []; });
  }

  /** 再次添加同一张图：按压缩前（或收到的）哈希找已存的一份，建新 id 返回，不用再传字节；找不到返回 undefined。 */
  reuse(sha256: string): NoteImage | undefined {
    if (!SHA256.test(sha256)) throw new NoteImageError("图片哈希格式不正确");
    for (const base of this.all().filter((r) => r.sourceSha256 === sha256 || r.sha256 === sha256)) {
      if (!this.intact(base)) continue;
      try { return this.copyOf(base, base.name, base.sourceSha256); } catch { /* 刚被清掉：试下一份 */ }
    }
    return undefined;
  }

  private saveRecord(record: NoteImage): void {
    const target = this.file(record.id, "json");
    const tmp = `${target}.tmp-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, target);
  }

  /** 按 id 读元数据；找不到就给 404，让调用方知道要重新添加 */
  metadata(id: string): NoteImage {
    const f = this.file(id, "json");
    if (!existsSync(f)) throw new NoteImageError("图片不存在，请重新添加", 404);
    try { return publicImage(JSON.parse(readFileSync(f, "utf8")) as StoredNoteImage); }
    catch { throw new NoteImageError("图片元数据损坏，请重新添加", 404); }
  }

  /** 校验并按 id 存下图片，返回记录里要引用的元数据 */
  async save(bytes: Buffer, mime: string, name: string, sourceSha256?: string): Promise<NoteImage> {
    if (!bytes.length || !["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new NoteImageError("只支持 PNG、JPEG、静态 WebP 格式");
    if (bytes.length > NOTE_IMAGE_MAX_BYTES) throw new NoteImageError("单张图片不能超过 10 MiB", 413);
    const head = bytes.subarray(0, 12);
    const format = head.subarray(0, 8).equals(PNG_SIGNATURE) ? "png"
      : head[0] === 255 && head[1] === 216 ? "jpeg"
      : head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP" ? "webp" : "";
    if (`image/${format}` !== mime) throw new NoteImageError("图片内容与声明格式不符");
    if (format === "png") {
      for (let off = 8; off + 12 <= bytes.length;) {
        const n = bytes.readUInt32BE(off);
        if (bytes.toString("ascii", off + 4, off + 8) === "acTL") throw new NoteImageError("不支持动图格式");
        if (n > bytes.length - off - 12) break;
        off += n + 12;
      }
    }
    const source = sourceSha256 && SHA256.test(sourceSha256) ? sourceSha256 : undefined;
    // 一模一样的字节已经校验、转码过一次：直接链接那一份，不再解码也不再多占空间。
    const digest = createHash("sha256").update(bytes).digest("hex");
    for (const base of this.all().filter((r) => r.sha256 === digest)) {
      if (!this.intact(base)) continue;
      const storedName = base.mimeType === "image/webp" ? name.replace(/\.[a-zA-Z0-9]{1,12}$/, "") + ".webp" : name;
      try { return this.copyOf(base, storedName, source); } catch { /* 刚被清掉 */ }
    }
    let width = 0, height = 0, thumb: Buffer, stored = bytes, storedMime = mime as NoteImageMime;
    try {
      const img = sharp(bytes, { limitInputPixels: NOTE_IMAGE_MAX_PIXELS });
      const meta = await img.metadata();
      if (meta.format !== format || (meta.pages ?? 1) > 1) throw new NoteImageError("不支持动图或多页图片格式");
      width = meta.width ?? 0; height = meta.height ?? 0;
      if (!width || !height || width > NOTE_IMAGE_MAX_SIDE || height > NOTE_IMAGE_MAX_SIDE || width * height > NOTE_IMAGE_MAX_PIXELS) throw new NoteImageError("图片尺寸超限（单边 16384，最多 40000000 像素）", 413);
      await img.clone().raw().toBuffer();
      thumb = await img.clone().rotate().resize(480, 480, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      // 与对话附件同一目标：统一存成 WebP。已经是 WebP 的不再重编码（客户端已压过，避免二次损失）。
      if (format !== "webp") { stored = await img.clone().rotate().webp({ quality: 82 }).toBuffer(); storedMime = "image/webp"; }
    } catch (e) {
      if (e instanceof NoteImageError) throw e;
      throw new NoteImageError(/pixel limit/i.test(String(e)) ? "图片尺寸超限（最多 40000000 像素）" : "图片损坏或无法解码");
    }
    const storedName = storedMime === "image/webp" ? name.replace(/\.[a-zA-Z0-9]{1,12}$/, "") + ".webp" : name;
    const record: StoredNoteImage = { id: `img-${randomUUID().replace(/-/g, "")}`, name: storedName.slice(0, 200), mimeType: storedMime, byteSize: stored.length, width, height, sha256: digest, ...(source ? { sourceSha256: source } : {}) };
    try {
      writeFileSync(this.file(record.id, "bin"), stored, { mode: 0o600 });
      writeFileSync(this.file(record.id, "webp"), thumb, { mode: 0o600 });
      this.saveRecord(record);
    } catch (e) { this.remove(record.id); throw e; }
    return publicImage(record);
  }

  read(id: string, thumbnail = false): { bytes: Buffer; mimeType: string } {
    const record = this.metadata(id);
    const f = this.file(id, thumbnail ? "webp" : "bin");
    if (!existsSync(f)) throw new NoteImageError("图片文件缺失，请重新添加", 404);
    return { bytes: readFileSync(f), mimeType: thumbnail ? "image/webp" : record.mimeType };
  }

  /** 校验引用的一组图片 id，重复去掉；不合法或不存在时给出可读的输入错误 */
  resolve(ids: unknown): NoteImage[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new NoteImageError("图片列表格式不对");
    const unique = [...new Set(ids as string[])];
    if (unique.length > NOTE_MAX_IMAGES) throw new NoteImageError(`一条记录最多 ${NOTE_MAX_IMAGES} 张图片`);
    return unique.map((id) => this.metadata(id));
  }

  remove(id: string): void {
    for (const ext of ["bin", "webp", "json"] as const) rmSync(this.file(id, ext), { force: true });
  }

  /** 清掉没有被任何记录引用的图片文件（例如上传后没保存就离开）。 */
  prune(keep: Set<string>): void {
    if (!existsSync(this.root)) return;
    for (const f of readdirSync(this.root)) {
      const m = /^(img-[a-f0-9]{32})\.(bin|webp|json)$/.exec(f);
      if (m && !keep.has(m[1]!)) rmSync(join(this.root, f), { force: true });
    }
  }
}

export interface NoteReceiptArchive { _noteRelations: { schemaVersion: 1; retiredReceipts: RelationReceipt[] } }
export type NoteSnapshot = Array<Note | NoteReceiptArchive>;
function archiveReceipts(rows: readonly unknown[], strict = false): RelationReceipt[] {
  let found = false, receipts: RelationReceipt[] = [];
  for (const row of rows) {
    if (isNote(row)) continue;
    if (row && typeof row === 'object' && '_noteRelations' in row) {
      const value = (row as NoteReceiptArchive)._noteRelations;
      if (found || Object.keys(row).length !== 1 || !value || value.schemaVersion !== 1 || !Array.isArray(value.retiredReceipts) || Object.keys(value).some(k => !['schemaVersion','retiredReceipts'].includes(k))) throw new RelationError('幂等存档版本或结构无效',503);
      validateMetadata({...emptyRelations(),receipts:value.retiredReceipts});
      found = true; receipts = structuredClone(value.retiredReceipts);
    } else if (strict) throw new RelationError('备份记录无效');
  }
  return receipts;
}
function uniqueReceipts(receipts: readonly RelationReceipt[]): RelationReceipt[] {
  const map = new Map<string,RelationReceipt>();
  for (const r of receipts) {
    const key = JSON.stringify([r.scopeId,r.channel,r.key]), old = map.get(key);
    if (old && (old.requestHash !== r.requestHash || old.resultId !== r.resultId)) throw new RelationError('幂等存档副本不一致',503);
    map.set(key,r);
  }
  return [...map.values()];
}

export class NoteStore {
  /** 图片字节与元数据的存取；记录里引用它的 id */
  readonly images: NoteImageStore;
  /** 始终保持「新的在前」的顺序 */
  private notes: Note[];
  private committed: Note[] = [];
  private retiredReceipts: RelationReceipt[] = [];
  private writeProblem = "";

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.images = new NoteImageStore(join(dirname(file), "notes-images"));
    this.notes = this.load();
    this.committed = structuredClone(this.notes);
    try { buildRelationIndex(this.notes); this.relationReceipts(); } catch (e) { this.writeProblem = (e as Error).message; }
    // 未关联记录的图片也可能属于浏览器中尚未提交的草稿。
    // 重启或部署候选预热不能据此删除图片；删除已保存记录时仍回收其图片。
  }

  private load(): Note[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(parsed)) { this.writeProblem = "记录文件结构损坏"; return []; }
      try { this.retiredReceipts = archiveReceipts(parsed); } catch(e) { this.writeProblem = (e as Error).message; }
      // 日程字段是新加的：旧记录没有它；损坏的日程只丢掉时间，不丢掉整条待办。
      const notes = parsed.filter(isNote).map(cleanKind).map(cleanPinned).map((note) => {
        if (note.schedule && !isSchedule(note.schedule)) {
          const cleaned = { ...note };
          delete cleaned.schedule;
          return cleaned;
        }
        return note;
      });
      // 导入历史记录后数组里可能出现时间乱序（旧记录被插到了新的前面）：读盘时按记录时间归位。
      return notes.sort((a, b) => a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1);
    } catch {
      this.writeProblem = "记录文件损坏，禁止覆盖";
      // 文件损坏时不让整个备忘录打不开；保留文件原样，方便人工排查。
      return [];
    }
  }

  /** 「新的在前」按记录时间倒序；时间相同的保持原有相对顺序（sort 稳定）。 */
  private order(): void {
    this.notes.sort((a, b) => a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1);
  }

  /** 把当前顺序按记录时间归位（导入后调用）；顺序没变就不写盘。 */
  reorder(): void {
    const before = this.notes.map((n) => n.id).join("\n");
    this.order();
    if (this.notes.map((n) => n.id).join("\n") !== before) this.save();
  }

  private save(cause: "deleted" | "trimmed" = "deleted", context?: RelationContext, at?: string): void {
    const candidate = structuredClone(this.notes);
    this.notes = structuredClone(this.committed);
    if (this.writeProblem) throw new RelationError(this.writeProblem, 503);
    prepareRelationHistory(this.committed, candidate, cause, context, at);
    for (const n of candidate) if (n.relations) validateMetadata(n.relations);
    buildRelationIndex(candidate);
    const remainingIds = new Set(candidate.map(n=>n.id));
    const retired = uniqueReceipts([...this.retiredReceipts,...this.committed.filter(n=>!remainingIds.has(n.id)).flatMap(n=>n.relations?.receipts??[])]);
    uniqueReceipts([...retired,...candidate.flatMap(n=>n.relations?.receipts??[])]);
    const snapshot: NoteSnapshot = [...candidate,...(retired.length?[{_noteRelations:{schemaVersion:1 as const,retiredReceipts:retired}}]:[])];
    const tmp = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    try { writeFileSync(tmp, JSON.stringify(snapshot, null, 2)); renameSync(tmp, this.file); }
    catch (e) { try { rmSync(tmp, { force: true }); } catch {} throw e; }
    const retained = new Set(candidate.flatMap(n => (n.images ?? []).map(i => i.id)));
    const discarded = this.committed.flatMap(n => n.images ?? []).filter(i => !retained.has(i.id));
    this.notes = candidate;
    this.retiredReceipts = structuredClone(retired);
    this.committed = structuredClone(candidate);
    for (const image of discarded) { try { this.images.remove(image.id); } catch (e) { console.error("图片回收失败", (e as Error).message); } }
  }

  mutateRelations<T>(run: (draft: Note[]) => T, context?: RelationContext, cause: "deleted" | "trimmed" = "deleted"): T {
    if (this.writeProblem) throw new RelationError(this.writeProblem, 503);
    const draft = structuredClone(this.notes);
    const result = run(draft);
    if (result instanceof Promise) throw new RelationError("关联事务必须同步");
    this.notes = draft;
    this.save(cause, context);
    return structuredClone(result);
  }

  relationReceipts(): RelationReceipt[] { return structuredClone(uniqueReceipts([...this.retiredReceipts,...this.notes.flatMap(n=>n.relations?.receipts??[])])); }
  exportSnapshot(): NoteSnapshot { return structuredClone([...this.notes,...(this.retiredReceipts.length?[{_noteRelations:{schemaVersion:1 as const,retiredReceipts:this.retiredReceipts}}]:[])]); }
  restoreSnapshot(rows: readonly (Note | NoteReceiptArchive)[]): void {
    if (!Array.isArray(rows)) throw new RelationError('备份记录无效');
    const retired = archiveReceipts(rows,true), candidate = structuredClone(rows.filter(isNote));
    if (new Set(candidate.map(n=>n.id)).size!==candidate.length || candidate.length>NOTE_MAX_COUNT) throw new RelationError('备份记录无效');
    buildRelationIndex(candidate); uniqueReceipts([...retired,...candidate.flatMap(n=>n.relations?.receipts??[])]);
    const old = this.committed, oldReceipts = this.retiredReceipts, oldProblem = this.writeProblem;
    this.committed = candidate; this.notes = candidate; this.retiredReceipts = retired; this.writeProblem = '';
    try { this.save(); } catch(e) { this.committed = old; this.notes = structuredClone(old); this.retiredReceipts=oldReceipts; this.writeProblem=oldProblem; throw e; }
  }

  /** 新的在前 */
  list(): Note[] {
    return this.notes.map(cloneNote);
  }

  get(id: string): Note | undefined {
    const hit = this.notes.find((n) => n.id === id);
    return hit ? cloneNote(hit) : undefined;
  }

  add(text: string, at = new Date().toISOString(), images: NoteImage[] = [], schedule?: NoteSchedule, meta: { kind?: NoteKind; kindSource?: "ai" | "user"; kindPending?: boolean; pinned?: boolean; writing?: NoteWriting; automation?: NoteAutomation } = {}, apply?: (notes: Note[], note: Note) => void, context?: RelationContext): Note {
    const note: Note = {
      id: `n-${randomUUID()}`, text, createdAt: at,
      ...(meta.automation ? { automation: { ...meta.automation } } : {}),
      ...(images.length ? { images: images.map((i) => ({ ...i })) } : {}),
      ...(schedule ? { schedule: cloneSchedule(schedule) } : {}),
      ...(meta.kind ? { kind: meta.kind } : {}),
      ...(meta.kindSource ? { kindSource: meta.kindSource } : {}),
      ...(meta.kindPending ? { kindPending: true } : {}),
      ...(meta.writing ? { writing: { ...meta.writing } } : {}),
      ...(meta.pinned ? { pinned: true, pinnedAt: at } : {})
    };
    this.mutateRelations(draft => { draft.unshift(note); apply?.(draft, note); draft.splice(NOTE_MAX_COUNT); }, context, "trimmed");
    return this.get(note.id)!;
  }

  /**
   * 批量导入：按给定顺序逐条插到最前（调用方按「旧 → 新」给，落盘后新的仍在前），
   * 一次写文件。导入的历史记录保留原始时间，不带 AI 整理 / 判断大类的待办标记。
   */
  addMany(entries: NoteImportEntry[]): Note[] {
    if (!entries.length) return [];
    const added = entries.map((entry) => {
      const note: Note = {
        id: `n-${randomUUID()}`, text: entry.text, createdAt: entry.createdAt,
        ...(entry.images?.length ? { images: entry.images.map((i) => ({ ...i })) } : {}),
        ...(entry.kind ? { kind: entry.kind } : {}),
        ...(entry.kindSource ? { kindSource: entry.kindSource } : {}),
        ...(entry.pinned ? { pinned: true, pinnedAt: entry.createdAt } : {})
      };
      this.notes.unshift(note);
      return cloneNote(note);
    });
    this.trim();
    this.order();
    this.save("trimmed");
    return added.map(n=>this.get(n.id)!);
  }

  /** 超出条数上限时丢弃最早的记录，并回收它们的图片 */
  private trim(): void {
    if (this.notes.length <= NOTE_MAX_COUNT) return;
    this.notes.splice(NOTE_MAX_COUNT);
  }

  /**
   * 只改提供的字段；改文字、图片或日程时刷新 updatedAt（`touch: false` 时不刷新，例如 AI 判断大类写入时间），
   * 改完成状态时维护 doneAt。kindSource 传 null 表示清掉。
   */
  update(id: string, patch: { text?: string; images?: NoteImage[]; done?: boolean; schedule?: NoteSchedule | null; kind?: NoteKind; kindSource?: "ai" | "user" | null; kindPending?: boolean; pinned?: boolean; touch?: boolean; writing?: NoteWriting | null }, at = new Date().toISOString()): Note | undefined {
    const index = this.notes.findIndex((n) => n.id === id);
    if (index < 0) return undefined;
    // 把旧告警识别出的来源一并保留，编辑正文后也不会退回人的日历。
    const next: Note = cloneNote(this.notes[index]!);
    if (patch.text !== undefined) next.text = patch.text;
    // 直接存储层改正文也必须丢弃旧建议，除非同时提供了对应的新结果。
    if (patch.text !== undefined && patch.text !== this.notes[index]!.text && patch.writing === undefined) delete next.writing;
    if (patch.writing !== undefined) { if (patch.writing) next.writing = { ...patch.writing }; else delete next.writing; }
    if (patch.images !== undefined) { if (patch.images.length) next.images = patch.images.map((i) => ({ ...i })); else delete next.images; }
    if (patch.done !== undefined) { next.done = patch.done; if (patch.done) next.doneAt = at; else delete next.doneAt; }
    if (patch.schedule !== undefined) {
      if (patch.schedule) next.schedule = cloneSchedule(patch.schedule);
      else delete next.schedule;
    }
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.kindSource !== undefined) { if (patch.kindSource) next.kindSource = patch.kindSource; else delete next.kindSource; }
    if (patch.kindPending !== undefined) { if (patch.kindPending) next.kindPending = true; else delete next.kindPending; }
    if (patch.pinned !== undefined) {
      if (patch.pinned) { next.pinned = true; if (!next.pinnedAt) next.pinnedAt = at; }
      else { delete next.pinned; delete next.pinnedAt; }
    }
    if (patch.touch ?? (patch.text !== undefined || patch.images !== undefined || patch.schedule !== undefined)) next.updatedAt = at;
    this.notes[index] = next;
    this.save("deleted", {actor:{kind:patch.touch===false?"system":"user",scopeId:"local"},channel:"web"}, at);
    return this.get(id);
  }

  remove(id: string): boolean {
    const index = this.notes.findIndex((n) => n.id === id);
    if (index < 0) return false;
    this.notes.splice(index, 1);
    this.save();
    return true;
  }
}
