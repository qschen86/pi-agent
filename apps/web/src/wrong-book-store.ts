/**
 * 错题本的账本：拍照批次、结构化习题、知识点掌握度、每周测验、设置。
 *
 * 和心愿挑战岛一样落在 Mac Mini 的数据目录（<dataDir>/wrong-book），换设备不丢；
 * 状态是一个 JSON（临时文件 → rename 原子写），照片单独存文件，只认 JPG / PNG / WebP。
 * 时间口径北京时间；所有读写在单进程内同步完成。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Explanation, Mastery, QuizSlot, Visual } from "./wrong-book-core.js";

export type PaperSource = "exam" | "homework";
export type PhotoMime = "image/jpeg" | "image/png" | "image/webp";

export interface WbSettings {
  grade: number;
  subject: "math";
  region: string;
  quiz: { enabled: boolean; /** 0 周日 … 6 周六（北京时间） */ weekday: number; time: string; count: number };
}

export interface WbPhoto {
  id: string;
  batchId: string;
  mime: PhotoMime;
  bytes: number;
  at: string;
  status: "queued" | "reading" | "done" | "failed";
  error?: string;
  itemCount?: number;
}

export interface WbBatch {
  id: string;
  source: PaperSource;
  /** 试卷 / 作业的日期（北京日期） */
  date: string;
  createdAt: string;
  photoIds: string[];
  status: "reading" | "review" | "done" | "failed";
  error?: string;
}

export type ItemResult = "wrong" | "right" | "unknown";

export interface WbItem {
  id: string;
  batchId: string;
  photoId: string;
  no: string;
  source: PaperSource;
  date: string;
  grade: number;
  subject: "math";
  qType: string;
  stem: string;
  options: string[];
  hasFigure: boolean;
  figureNote: string;
  childAnswer: string;
  answer: string;
  solution: string[];
  result: ItemResult;
  markSource: "teacher" | "self-check" | "unknown";
  tags: string[];
  confidence: number;
  status: "pending" | "confirmed" | "discarded";
  html: string;
  createdAt: string;
  explain?: Explanation;
  /** 已经按孩子反馈换过几次讲法（上限见 MAX_EXPLAIN_REGENS） */
  explainRegens?: number;
  /** 家长确认入库的时间：重算掌握度时按它排序（识别时间早于当时的测验也不会错序） */
  confirmedAt?: string;
}

export interface WbQuestion {
  id: string;
  slot: QuizSlot;
  qType: "choice" | "fill" | "judge";
  stem: string;
  options: string[];
  /** 每个空的标准答案；选择题是字母，判断题是「对」「错」 */
  answers: string[];
  labels: string[];
  unit: string;
  solution: string[];
  visual?: Visual;
  html: string;
  /** 出题后的核对方式：算式复算 / 独立重解 / 两者都有 */
  checked: string[];
  fromItemId?: string;
  explain?: Explanation;
  /** 已经按孩子反馈换过几次讲法（上限见 MAX_EXPLAIN_REGENS） */
  explainRegens?: number;
}

export interface WbQuiz {
  id: string;
  weekKey: string;
  createdAt: string;
  trigger: "auto" | "manual";
  status: "generating" | "ready" | "done" | "failed";
  progress: string;
  error?: string;
  questions: WbQuestion[];
  /** 孩子已经交的答案与判分 */
  responses: Record<string, { given: string[]; correct: boolean; at: string }>;
  /** 出了但没通过核对、被丢掉的题数（给家长看质量） */
  dropped: number;
  finishedAt?: string;
}

export interface WbState {
  version: 1;
  settings: WbSettings;
  photos: Record<string, WbPhoto>;
  batches: Record<string, WbBatch>;
  items: Record<string, WbItem>;
  mastery: Record<string, Mastery>;
  quizzes: Record<string, WbQuiz>;
  /** 最近一次自动出题被跳过的原因（例如还没有错题） */
  lastAutoNote?: { weekKey: string; reason: string };
}

export class WrongBookError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 413 | 429 | 503 = 400) {
    super(message);
    this.name = "WrongBookError";
  }
}

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MIN_PHOTO_BYTES = 64;
const ID_RE = /^[a-z0-9]{8,40}$/;

export const DEFAULT_SETTINGS: WbSettings = {
  grade: 3,
  subject: "math",
  region: "上海",
  quiz: { enabled: true, weekday: 6, time: "08:00", count: 12 },
};

export function sniffPhoto(bytes: Buffer): PhotoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
const photoExt = (mime: PhotoMime) => (mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg");

/** 没有原型的字典：id 是 `__proto__` 之类也只是普通键，不会污染整个进程。 */
export function dict<T>(src?: Record<string, T> | null): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, src ?? {});
}

export const newId = (): string => randomBytes(8).toString("hex");

export class WrongBookStore {
  private readonly file: string;
  private readonly photoDir: string;
  private cache?: WbState;

  constructor(dataDir: string) {
    const root = join(dataDir, "wrong-book");
    this.file = join(root, "state.json");
    this.photoDir = join(root, "photos");
    mkdirSync(this.photoDir, { recursive: true, mode: 0o700 });
  }

  /** 内存里的状态（单进程独占）；改完调用 save()。 */
  get state(): WbState {
    if (this.cache) return this.cache;
    let state: WbState | undefined;
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<WbState>;
        state = {
          version: 1,
          settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}), quiz: { ...DEFAULT_SETTINGS.quiz, ...(raw.settings?.quiz ?? {}) } },
          photos: dict(raw.photos),
          batches: dict(raw.batches),
          items: dict(raw.items),
          mastery: dict(raw.mastery),
          quizzes: dict(raw.quizzes),
          ...(raw.lastAutoNote ? { lastAutoNote: raw.lastAutoNote } : {}),
        };
      } catch {
        // 状态文件损坏：留一份备份再从空白开始，别把坏文件覆盖掉
        try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
    }
    this.cache = state ?? { version: 1, settings: structuredClone(DEFAULT_SETTINGS), photos: dict(), batches: dict(), items: dict(), mastery: dict(), quizzes: dict() };
    return this.cache;
  }

  save(): void {
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  savePhoto(batchId: string, body: Buffer): WbPhoto {
    if (body.length < MIN_PHOTO_BYTES) throw new WrongBookError("PHOTO_INVALID", "照片是空的");
    if (body.length > MAX_PHOTO_BYTES) throw new WrongBookError("PHOTO_TOO_LARGE", "照片太大了（最大 12MB）", 413);
    const mime = sniffPhoto(body);
    if (!mime) throw new WrongBookError("PHOTO_INVALID", "只支持 JPG / PNG / WebP 照片");
    const id = newId();
    const tmp = join(this.photoDir, `${id}.tmp-${process.pid}`);
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, join(this.photoDir, `${id}.${photoExt(mime)}`));
    const photo: WbPhoto = { id, batchId, mime, bytes: body.length, at: new Date().toISOString(), status: "queued" };
    this.state.photos[id] = photo;
    return photo;
  }

  photoPath(id: string): { photo: WbPhoto; path: string } | null {
    if (!ID_RE.test(id)) return null;
    const photo = this.state.photos[id];
    if (!photo) return null;
    const path = join(this.photoDir, `${id}.${photoExt(photo.mime)}`);
    return existsSync(path) ? { photo, path } : null;
  }

  readPhoto(id: string): { photo: WbPhoto; bytes: Buffer } | null {
    const hit = this.photoPath(id);
    return hit ? { photo: hit.photo, bytes: readFileSync(hit.path) } : null;
  }

  deletePhotoFile(id: string): void {
    const photo = this.state.photos[id];
    if (!photo) return;
    delete this.state.photos[id];
    try { unlinkSync(join(this.photoDir, `${id}.${photoExt(photo.mime)}`)); } catch { /* 已经不在了 */ }
  }
}
