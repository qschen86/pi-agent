/**
 * 错题本的业务编排：拍照批次 → 识别 → 家长确认入库 → 掌握度 → 每周测验（出题、验题、判分）→ 讲解。
 *
 * 模型调用都在后台跑（识别、出题动辄几分钟）：接口先返回「处理中」，页面轮询。
 * 进程重启时，卡在「处理中」的批次 / 测验统一标记失败，家长点一下就能重来，不会一直转圈。
 */
import type { ModelInvocationPort } from "@pi-agent/model-port";
import {
  KNOWLEDGE, MAX_EXPLAIN_REGENS, answersMatch, applyResult, buildBlueprint, classifyTags, cleanTags, cleanText, evalExpression, normalizeAnswer,
  renderItemHtml, richHtml, sanitizeFeedback, scheduledInstant, tagGroup, tagName, todayKey, weekKey, blankMatches, explanationOk, pruneVisuals, solutionArithmeticOk, stemSignature,
} from "./wrong-book-core.js";
import type { Explanation } from "./wrong-book-core.js";
import { explainQuestion, generateQuestions, readPaperPhoto, solveQuestion } from "./wrong-book-ai.js";
import type { RawQuestion, ReadItem, SlotContext } from "./wrong-book-ai.js";
import { WrongBookError, newId } from "./wrong-book-store.js";
import type { PaperSource, WbBatch, WbItem, WbQuestion, WbQuiz, WbSettings, WrongBookStore } from "./wrong-book-store.js";

export interface WrongBookOptions {
  /** 识图、出题、验题、讲解共用的模型端口（DeepSeek Flash）。 */
  port?: ModelInvocationPort;
  /** 额外的独立验题（例如交给 Claude / Codex 再核一遍）：返回 false 就丢掉这道题，undefined 表示没意见。 */
  extraVerifier?: (q: RawQuestion) => Promise<boolean | undefined>;
  now?: () => Date;
  /** 测试里让后台任务同步等待。 */
  onSettled?: () => void;
}

const MAX_PHOTOS_PER_BATCH = 8;
const MIN_QUIZ_QUESTIONS = 6;
const CHUNK = 4;

async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export class WrongBookService {
  private readonly now: () => Date;
  private readonly running = new Set<Promise<unknown>>();
  private tickTimer?: ReturnType<typeof setInterval>;
  /** 同时在跑的识图任务不超过 2 张，避免把模型打爆。 */
  private readQueue: Promise<void> = Promise.resolve();
  private readActive = 0;

  constructor(readonly store: WrongBookStore, private readonly options: WrongBookOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.recover();
  }

  /** 重启后：卡在处理中的统一标记失败。 */
  private recover(): void {
    const s = this.store.state;
    let dirty = false;
    for (const photo of Object.values(s.photos)) {
      if (photo.status === "queued" || photo.status === "reading") {
        photo.status = "failed";
        photo.error = "服务重启了，点「重新识别」再来一次";
        dirty = true;
      }
    }
    for (const batch of Object.values(s.batches)) {
      if (batch.status === "reading") { this.refreshBatch(batch); dirty = true; }
    }
    for (const quiz of Object.values(s.quizzes)) {
      if (quiz.status === "generating") {
        quiz.status = "failed";
        quiz.error = "服务重启了，出题被打断，点「重新出题」";
        dirty = true;
      }
    }
    if (dirty) this.store.save();
  }

  /** 等所有后台任务结束（测试与优雅退出用）。 */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private background(task: () => Promise<void>): void {
    const p: Promise<unknown> = task().catch(() => undefined).finally(() => { this.running.delete(p); this.options.onSettled?.(); });
    this.running.add(p);
  }

  /* ------------------------------ 设置 ------------------------------ */

  settings(): WbSettings {
    return this.store.state.settings;
  }

  updateSettings(raw: unknown): WbSettings {
    const body = (raw ?? {}) as Record<string, unknown>;
    const quiz = (body["quiz"] ?? {}) as Record<string, unknown>;
    const s = this.store.state.settings;
    if (quiz["enabled"] !== undefined) s.quiz.enabled = quiz["enabled"] === true;
    if (quiz["weekday"] !== undefined) {
      const w = Number(quiz["weekday"]);
      if (!Number.isInteger(w) || w < 0 || w > 6) throw new WrongBookError("INPUT_INVALID", "星期要在周日到周六之间");
      s.quiz.weekday = w;
    }
    if (quiz["time"] !== undefined) {
      const t = String(quiz["time"]);
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(t)) throw new WrongBookError("INPUT_INVALID", "时间格式是 08:00");
      s.quiz.time = t.padStart(5, "0");
    }
    if (quiz["count"] !== undefined) {
      const c = Number(quiz["count"]);
      if (!Number.isInteger(c) || c < 6 || c > 20) throw new WrongBookError("INPUT_INVALID", "每周题数在 6~20 之间");
      s.quiz.count = c;
    }
    if (body["grade"] !== undefined) {
      const g = Number(body["grade"]);
      if (!Number.isInteger(g) || g < 1 || g > 6) throw new WrongBookError("INPUT_INVALID", "年级在 1~6 之间");
      s.grade = g;
    }
    // 把时间改到本周已经过去的点：别立刻补出一份，从下周开始
    if (quiz["weekday"] !== undefined || quiz["time"] !== undefined) {
      const now = this.now();
      const wk = weekKey(now);
      if (scheduledInstant(now, s.quiz.weekday, s.quiz.time).getTime() <= now.getTime() && !Object.values(this.store.state.quizzes).some((x) => x.weekKey === wk)) {
        this.store.state.lastAutoNote = { weekKey: wk, reason: "设置的时间本周已经过了，从下周开始自动出题；想现在做可以手动出一份" };
      } else if (this.store.state.lastAutoNote?.weekKey === wk && this.store.state.lastAutoNote.reason.startsWith("设置的时间")) {
        delete this.store.state.lastAutoNote;
      }
    }
    this.store.save();
    return s;
  }

  /* ------------------------------ 录入：批次与识别 ------------------------------ */

  createBatch(input: { source: unknown; date: unknown; photos: Buffer[] }): WbBatch {
    const source: PaperSource = input.source === "exam" ? "exam" : "homework";
    const today = todayKey(this.now());
    const date = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) && input.date <= today ? input.date : today;
    if (input.photos.length === 0) throw new WrongBookError("INPUT_INVALID", "先选至少一张照片");
    if (input.photos.length > MAX_PHOTOS_PER_BATCH) throw new WrongBookError("INPUT_INVALID", `一次最多 ${MAX_PHOTOS_PER_BATCH} 张照片`);
    const id = newId();
    const photoIds: string[] = [];
    try {
      for (const bytes of input.photos) photoIds.push(this.store.savePhoto(id, bytes).id);
    } catch (e) {
      for (const pid of photoIds) this.store.deletePhotoFile(pid);
      throw e;
    }
    const batch: WbBatch = { id, source, date, createdAt: this.now().toISOString(), photoIds, status: "reading" };
    this.store.state.batches[id] = batch;
    this.store.save();
    for (const pid of photoIds) this.queueRead(batch, pid);
    return batch;
  }

  retryPhoto(batchId: string, photoId: string): WbBatch {
    const batch = this.batch(batchId);
    const photo = this.store.state.photos[photoId];
    if (!photo || photo.batchId !== batchId) throw new WrongBookError("NOT_FOUND", "没有这张照片", 404);
    if (photo.status !== "failed") throw new WrongBookError("CONFLICT", "这张照片不需要重新识别", 409);
    photo.status = "queued";
    delete photo.error;
    batch.status = "reading";
    delete batch.error;
    this.store.save();
    this.queueRead(batch, photoId);
    return batch;
  }

  private queueRead(batch: WbBatch, photoId: string): void {
    this.background(async () => {
      // 简单信号量：最多 2 张同时识别
      while (this.readActive >= 2) await new Promise((r) => setTimeout(r, 200));
      this.readActive += 1;
      try { await this.readOne(batch, photoId); } finally { this.readActive -= 1; }
    });
  }

  private async readOne(batch: WbBatch, photoId: string): Promise<void> {
    const photo = this.store.state.photos[photoId];
    if (!photo) return;
    photo.status = "reading";
    this.store.save();
    try {
      const port = this.options.port;
      if (!port) throw new Error("识别服务还没准备好");
      const file = this.store.readPhoto(photoId);
      if (!file) throw new Error("照片文件不见了");
      const items = await readPaperPhoto(port, { bytes: file.bytes, mime: file.photo.mime }, { source: batch.source });
      // 识别期间家长可能已经丢弃了这一批：别再往已删除的批次里写题
      if (!this.store.state.batches[batch.id] || this.store.state.photos[photoId] !== photo) return;
      // 重试时先清掉这张照片上一次的结果
      for (const old of Object.values(this.store.state.items)) if (old.photoId === photoId && old.status === "pending") delete this.store.state.items[old.id];
      for (const read of items) this.addItem(batch, photoId, read);
      photo.status = "done";
      photo.itemCount = items.length;
      delete photo.error;
    } catch (e) {
      photo.status = "failed";
      photo.error = cleanText((e as Error).message, 160) || "识别失败";
    }
    this.refreshBatch(batch);
    this.store.save();
  }

  private addItem(batch: WbBatch, photoId: string, read: ReadItem): void {
    // 结果：老师批改优先；没批改就拿孩子的答案和标准答案对一下（只是 AI 自己判的，页面会标出来）
    let result: WbItem["result"] = "unknown";
    let markSource: WbItem["markSource"] = "unknown";
    if (read.mark === "wrong" || read.mark === "right") {
      result = read.mark;
      markSource = "teacher";
    } else if (read.childAnswer && read.answer) {
      const given = read.childAnswer.split(/[；;]/).map((x) => x.trim());
      const expected = read.answer.split(/[；;]/).map((x) => x.trim());
      result = answersMatch(expected, given) ? "right" : "wrong";
      markSource = "self-check";
    }
    let tags = read.tags;
    if (tags.length === 0 && read.suggestTag) tags = cleanTags([read.suggestTag], 1);
    const id = newId();
    const base = {
      qType: read.qType, stem: read.stem, options: read.options, hasFigure: read.hasFigure, figureNote: read.figureNote,
      childAnswer: read.childAnswer, answer: read.answer, solution: read.solution,
    };
    this.store.state.items[id] = {
      id, batchId: batch.id, photoId, no: read.no, source: batch.source, date: batch.date, grade: this.store.state.settings.grade, subject: "math",
      ...base, result, markSource, tags, confidence: read.confidence, status: "pending", html: renderItemHtml(base), createdAt: this.now().toISOString(),
    };
  }

  private refreshBatch(batch: WbBatch): void {
    const photos = batch.photoIds.map((id) => this.store.state.photos[id]).filter(Boolean);
    if (photos.some((p) => p!.status === "queued" || p!.status === "reading")) { batch.status = "reading"; return; }
    if (photos.length > 0 && photos.every((p) => p!.status === "failed")) {
      batch.status = "failed";
      batch.error = photos[0]!.error ?? "识别失败";
      return;
    }
    const pending = Object.values(this.store.state.items).some((i) => i.batchId === batch.id && i.status === "pending");
    batch.status = pending ? "review" : batch.status === "done" ? "done" : "review";
    delete batch.error;
  }

  private batch(id: string): WbBatch {
    const batch = this.store.state.batches[id];
    if (!batch) throw new WrongBookError("NOT_FOUND", "没有这个批次", 404);
    return batch;
  }

  batchDetail(id: string) {
    const batch = this.batch(id);
    return {
      ...batch,
      photos: batch.photoIds.map((pid) => { const p = this.store.state.photos[pid]; return p ? { id: p.id, status: p.status, error: p.error, itemCount: p.itemCount } : null; }).filter(Boolean),
      items: Object.values(this.store.state.items).filter((i) => i.batchId === id && i.status !== "discarded").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.no.localeCompare(b.no, "zh", { numeric: true })),
    };
  }

  /** 家长在确认页改一道题。 */
  updateItem(id: string, raw: unknown): WbItem {
    const item = this.store.state.items[id];
    if (!item) throw new WrongBookError("NOT_FOUND", "没有这道题", 404);
    if (item.status !== "pending") throw new WrongBookError("CONFLICT", "已经入库的题不能再改，删掉重新录入吧", 409);
    const b = (raw ?? {}) as Record<string, unknown>;
    if (typeof b["stem"] === "string") item.stem = cleanText(b["stem"], 400) || item.stem;
    if (typeof b["childAnswer"] === "string") item.childAnswer = cleanText(b["childAnswer"], 60);
    if (typeof b["answer"] === "string") item.answer = cleanText(b["answer"], 60);
    if (Array.isArray(b["options"])) item.options = b["options"].map((x) => cleanText(x, 80)).filter(Boolean).slice(0, 6);
    if (b["result"] === "wrong" || b["result"] === "right" || b["result"] === "unknown") { item.result = b["result"]; item.markSource = "teacher"; }
    if (Array.isArray(b["tags"])) item.tags = cleanTags(b["tags"], 3);
    if (typeof b["date"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b["date"])) item.date = b["date"];
    item.html = renderItemHtml(item);
    delete item.explain; // 题改了，旧讲解作废
    this.store.save();
    return item;
  }

  discardItem(id: string): void {
    const item = this.store.state.items[id];
    if (!item) throw new WrongBookError("NOT_FOUND", "没有这道题", 404);
    if (item.status === "confirmed") this.rebuildMasteryFromScratch(id);
    item.status = "discarded";
    this.refreshBatchOf(item.batchId);
    this.store.save();
  }

  private refreshBatchOf(batchId: string): void {
    const batch = this.store.state.batches[batchId];
    if (batch) this.refreshBatch(batch);
  }

  /** 家长确认：把没丢掉的题入库，并按对错更新知识点掌握度。 */
  confirmBatch(id: string): { confirmed: number; wrong: number } {
    const batch = this.batch(id);
    if (batch.status === "reading") throw new WrongBookError("CONFLICT", "还有照片在识别，等一下", 409);
    let confirmed = 0;
    let wrong = 0;
    const at = this.now();
    for (const item of Object.values(this.store.state.items)) {
      if (item.batchId !== id || item.status !== "pending") continue;
      item.status = "confirmed";
      item.confirmedAt = at.toISOString();
      confirmed += 1;
      if (item.result === "wrong") wrong += 1;
      if (item.result === "unknown") continue;
      for (const tag of item.tags) {
        this.store.state.mastery[tag] = applyResult(this.store.state.mastery[tag], item.result === "right", at, "paper");
      }
    }
    batch.status = "done";
    this.store.save();
    return { confirmed, wrong };
  }

  /** 丢掉整个批次（照片文件也删）。 */
  deleteBatch(id: string): void {
    const batch = this.batch(id);
    const confirmed = Object.values(this.store.state.items).some((i) => i.batchId === id && i.status === "confirmed");
    for (const item of Object.values(this.store.state.items)) if (item.batchId === id) delete this.store.state.items[item.id];
    // 已经确认过的批次：掌握度要重算
    if (confirmed) this.rebuildMasteryFromScratch();
    for (const pid of batch.photoIds) this.store.deletePhotoFile(pid);
    delete this.store.state.batches[id];
    this.store.save();
  }

  /** 删掉 / 丢弃一道已确认的题后，按剩余已确认的试卷题 + 测验作答重算掌握度。 */
  private rebuildMasteryFromScratch(skipItemId?: string): void {
    const s = this.store.state;
    type Event = { at: string; tags: string[]; ok: boolean; source: "paper" | "quiz-review" | "quiz-weak" | "quiz-stretch" };
    const events: Event[] = [];
    for (const item of Object.values(s.items)) {
      if (item.status !== "confirmed" || item.id === skipItemId || item.result === "unknown") continue;
      events.push({ at: item.confirmedAt ?? item.createdAt, tags: item.tags, ok: item.result === "right", source: "paper" });
    }
    for (const quiz of Object.values(s.quizzes)) {
      const credited = new Set<string>();
      for (const q of Object.values(quiz.questions).sort((a, b) => (quiz.responses[a.id]?.at ?? "").localeCompare(quiz.responses[b.id]?.at ?? ""))) {
        const r = quiz.responses[q.id];
        if (!r) continue;
        // 同一份测验里同一知识点答对多次只算一次（和作答时的口径一致）
        if (r.correct) { if (credited.has(q.slot.tag)) continue; credited.add(q.slot.tag); }
        events.push({ at: r.at, tags: [q.slot.tag], ok: r.correct, source: `quiz-${q.slot.kind}` as Event["source"] });
      }
    }
    events.sort((a, b) => a.at.localeCompare(b.at));
    s.mastery = {};
    for (const e of events) for (const tag of e.tags) s.mastery[tag] = applyResult(s.mastery[tag], e.ok, new Date(e.at), e.source);
  }

  listItems(filter: { result?: string; tag?: string; source?: string } = {}): WbItem[] {
    return Object.values(this.store.state.items)
      .filter((i) => i.status === "confirmed")
      .filter((i) => (filter.result ? i.result === filter.result : i.result === "wrong"))
      .filter((i) => (filter.tag ? i.tags.includes(filter.tag) : true))
      .filter((i) => (filter.source ? i.source === filter.source : true))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  }

  item(id: string): WbItem {
    const item = this.store.state.items[id];
    if (!item) throw new WrongBookError("NOT_FOUND", "没有这道题", 404);
    return item;
  }

  /* ------------------------------ 概览 ------------------------------ */

  masteryView() {
    const s = this.store.state;
    const buckets = classifyTags(s.mastery, this.now());
    const bucketOf = (tag: string) => (buckets.weak.includes(tag) ? "weak" : buckets.strong.includes(tag) ? "strong" : "growing");
    return Object.entries(s.mastery)
      .map(([tag, m]) => ({ tag, name: tagName(tag), group: tagGroup(tag), bucket: bucketOf(tag), ...m }))
      .sort((a, b) => a.box - b.box || a.name.localeCompare(b.name, "zh"));
  }

  snapshot() {
    const s = this.store.state;
    const now = this.now();
    const batches = Object.values(s.batches)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30)
      .map((b) => {
        const items = Object.values(s.items).filter((i) => i.batchId === b.id && i.status !== "discarded");
        return {
          id: b.id, source: b.source, date: b.date, createdAt: b.createdAt, status: b.status, error: b.error, photoCount: b.photoIds.length,
          itemCount: items.length, pendingCount: items.filter((i) => i.status === "pending").length, wrongCount: items.filter((i) => i.result === "wrong").length,
        };
      });
    const quizzes = Object.values(s.quizzes).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map((q) => this.quizSummary(q));
    const confirmed = Object.values(s.items).filter((i) => i.status === "confirmed");
    return {
      settings: s.settings,
      knowledge: KNOWLEDGE,
      batches,
      quizzes,
      mastery: this.masteryView(),
      counts: { wrong: confirmed.filter((i) => i.result === "wrong").length, right: confirmed.filter((i) => i.result === "right").length, pending: batches.reduce((n, b) => n + b.pendingCount, 0) },
      weekKey: weekKey(now),
      nextQuizAt: this.nextQuizAt(now),
      lastAutoNote: s.lastAutoNote ?? null,
      now: now.toISOString(),
    };
  }

  private nextQuizAt(now: Date): string | null {
    const { enabled, weekday, time } = this.store.state.settings.quiz;
    if (!enabled) return null;
    let at = scheduledInstant(now, weekday, time);
    const wk = weekKey(now);
    const done = Object.values(this.store.state.quizzes).some((q) => q.weekKey === wk);
    if (at.getTime() <= now.getTime() && done) at = new Date(at.getTime() + 7 * 24 * 3600_000);
    return at.toISOString();
  }

  /* ------------------------------ 每周测验 ------------------------------ */

  private quizSummary(q: WbQuiz) {
    const answered = Object.keys(q.responses).length;
    return {
      id: q.id, weekKey: q.weekKey, createdAt: q.createdAt, trigger: q.trigger, status: q.status, progress: q.progress, error: q.error,
      total: q.questions.length, answered, correct: Object.values(q.responses).filter((r) => r.correct).length, dropped: q.dropped, finishedAt: q.finishedAt,
    };
  }

  /** 出一份测验。已有一份在出题时返回 409。 */
  startQuiz(trigger: "auto" | "manual"): WbQuiz {
    const s = this.store.state;
    if (Object.values(s.quizzes).some((q) => q.status === "generating")) throw new WrongBookError("CONFLICT", "已经有一份测验在出题了，稍等一下", 409);
    if (!this.options.port) throw new WrongBookError("UNAVAILABLE", "出题服务还没准备好", 503);
    const now = this.now();
    const slots = buildBlueprint(s.mastery, s.settings.quiz.count, now);
    if (slots.length === 0) throw new WrongBookError("NO_DATA", "还没有可以出题的知识点：先录入几张作业或试卷，确认后再来", 409);
    const quiz: WbQuiz = { id: newId(), weekKey: weekKey(now), createdAt: now.toISOString(), trigger, status: "generating", progress: "准备出题…", questions: [], responses: {}, dropped: 0 };
    s.quizzes[quiz.id] = quiz;
    this.store.save();
    this.background(() => this.generate(quiz, slots));
    return quiz;
  }

  private contexts(slots: ReturnType<typeof buildBlueprint>): SlotContext[] {
    const wrong = Object.values(this.store.state.items).filter((i) => i.status === "confirmed" && i.result === "wrong").sort((a, b) => b.date.localeCompare(a.date));
    return slots.map((slot) => ({
      slot,
      wrongSamples: slot.kind === "weak" ? wrong.filter((i) => i.tags.includes(slot.tag)).slice(0, 2).map((i) => ({ stem: i.stem, childAnswer: i.childAnswer })) : [],
    }));
  }

  private async generate(quiz: WbQuiz, slots: ReturnType<typeof buildBlueprint>): Promise<void> {
    const port = this.options.port!;
    const contexts = this.contexts(slots);
    // 最近两份测验的题干：别重复
    const avoid = Object.values(this.store.state.quizzes).filter((q) => q.id !== quiz.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 2).flatMap((q) => q.questions.map((x) => x.stem.slice(0, 60)));
    const accepted = new Map<number, WbQuestion>();
    // 同知识点「运算结构相同」的题只留一道：验题是异步的，先占位再核对，避免两道同时通过
    const claimed = new Set<string>();
    let dropped = 0;
    try {
      for (let round = 0; round < 2; round++) {
        const missing = contexts.map((c, i) => ({ c, index: i })).filter(({ index }) => !accepted.has(index + 1));
        if (missing.length === 0) break;
        quiz.progress = round === 0 ? "老师在出题…" : "有几道没通过核对，重出中…";
        this.store.save();
        // 分块并发出题；每块的题位序号用全局序号，方便对应
        const chunks: { c: SlotContext; index: number }[][] = [];
        for (let i = 0; i < missing.length; i += CHUNK) chunks.push(missing.slice(i, i + CHUNK));
        const raws = (await pool(chunks, 3, async (chunk) => {
          // 题位序号必须连续：用块内顺序 + 偏移，再映射回全局序号
          try {
            const list = await generateQuestions(port, chunk.map((x) => x.c), 0, [...avoid, ...[...accepted.values()].map((q) => q.stem.slice(0, 60))]);
            return list.map((q) => ({ raw: q, index: chunk[q.slotIndex - 1]!.index }));
          } catch {
            return [];
          }
        })).flat();
        quiz.progress = `核对答案 0/${raws.length}`;
        this.store.save();
        let done = 0;
        await pool(raws, 4, async ({ raw, index }) => {
          // 同一份里「运算结构相同的同知识点题」只留一道，不要只换数字就算两题
          const key = `${contexts[index]!.slot.tag}|${stemSignature(raw.stem)}`;
          const dup = claimed.has(key);
          if (!dup) claimed.add(key);
          const ok = !dup && (await this.verify(raw));
          if (!ok && !dup) claimed.delete(key);
          done += 1;
          quiz.progress = `核对答案 ${done}/${raws.length}`;
          if (ok) accepted.set(index + 1, this.toQuestion(raw, contexts[index]!));
          else dropped += 1;
        });
        this.store.save();
      }
      quiz.questions = [...accepted.entries()].sort((a, b) => a[0] - b[0]).map(([, q]) => q);
      quiz.dropped = dropped;
      if (quiz.questions.length < Math.min(MIN_QUIZ_QUESTIONS, slots.length)) {
        quiz.status = "failed";
        quiz.error = `通过核对的题只有 ${quiz.questions.length} 道，不够一份测验。点「重新出题」再试一次`;
      } else {
        quiz.status = "ready";
        quiz.progress = "";
      }
    } catch (e) {
      quiz.status = "failed";
      quiz.error = cleanText((e as Error).message, 160) || "出题失败";
    }
    this.store.save();
  }

  /** 题必须通过「独立重解」一致（有算式时还要算式复算一致）才能给孩子。 */
  private async verify(raw: RawQuestion): Promise<boolean> {
    // 解题步骤里写出的算式必须算对：否则孩子看到的「解析」是错的
    if (!solutionArithmeticOk(raw.solution)) return false;
    if (raw.expr) {
      const ev = evalExpression(raw.expr);
      if (ev) {
        const expected = raw.answers;
        const ok = expected.length === 2 && ev.quotient !== undefined
          ? blankMatches(expected[0]!, String(ev.quotient)) && blankMatches(expected[1]!, String(ev.remainder))
          : expected.length === 1 && blankMatches(expected[0]!, String(Math.round(ev.value * 1e9) / 1e9));
        if (!ok) return false;
      }
    }
    const solved = await solveQuestion(this.options.port!, raw);
    if (!solved) return false;
    if (!this.sameAnswers(raw, solved)) return false;
    if (this.options.extraVerifier) {
      const extra = await this.options.extraVerifier(raw).catch(() => undefined);
      if (extra === false) return false;
    }
    return true;
  }

  /** 选择题的正确选项位置打乱（模型爱把答案放在 A）；带「以上都…」之类依赖顺序的选项不动。 */
  private shuffleChoice(raw: Pick<RawQuestion, "qType" | "options" | "answers">): { options: string[]; answers: string[] } {
    // 选项或解析依赖顺序（「以上都…」「A 和 B」「都不是」「全部」）的题不打乱
    const orderBound = (t: string) => /以上|都[是对错不]|其中|全部|均|没有|同上|(?<![A-Za-z])[A-D](?![A-Za-z])/.test(t);
    if (raw.qType !== "choice" || raw.options.some(orderBound)) return { options: raw.options, answers: raw.answers };
    const order = raw.options.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
    const correct = "ABCD".indexOf(raw.answers[0] ?? "");
    return { options: order.map((i) => raw.options[i]!), answers: ["ABCD"[order.indexOf(correct)] ?? raw.answers[0]!] };
  }

  private sameAnswers(raw: Pick<RawQuestion, "qType" | "answers">, solved: string[]): boolean {
    if (raw.qType === "choice") return (solved[0] ?? "").trim().charAt(0).toUpperCase() === raw.answers[0];
    if (raw.qType === "judge") {
      const s = solved[0] ?? "";
      const verdict = /^(对|正确|√|✓|true)/i.test(s) ? "对" : /^(错|错误|×|✗|false)/i.test(s) ? "错" : "";
      return verdict === raw.answers[0];
    }
    return answersMatch(raw.answers, solved);
  }

  private toQuestion(raw: RawQuestion, ctx: SlotContext): WbQuestion {
    const checks = ["resolve"];
    if (raw.expr && evalExpression(raw.expr)) checks.unshift("expr");
    const { options: shuffled, answers } = this.shuffleChoice(raw);
    const options = shuffled.map((o, i) => `${"ABCD"[i]}. ${o}`);
    const html = `<div class="wb-q"><div class="wb-stem">${richHtml(raw.stem)}</div>${options.length ? `<ul class="wb-options">${options.map((o) => `<li>${richHtml(o)}</li>`).join("")}</ul>` : ""}</div>`;
    return {
      id: newId(), slot: ctx.slot, qType: raw.qType, stem: raw.stem, options, answers, labels: raw.labels, unit: raw.unit,
      solution: raw.solution, ...(raw.visual ? { visual: raw.visual } : {}), html, checked: checks,
    };
  }

  quiz(id: string): WbQuiz {
    const quiz = this.store.state.quizzes[id];
    if (!quiz) throw new WrongBookError("NOT_FOUND", "没有这份测验", 404);
    return quiz;
  }

  /** 给孩子看的测验：没答的题不带答案和解析。 */
  quizView(id: string) {
    const quiz = this.quiz(id);
    return {
      ...this.quizSummary(quiz),
      questions: quiz.questions.map((q) => {
        const r = quiz.responses[q.id];
        const base = { id: q.id, qType: q.qType, stem: q.stem, options: q.options, labels: q.labels, unit: q.unit, visual: q.visual ?? null, html: q.html, kind: q.slot.kind, tag: q.slot.tag, tagName: tagName(q.slot.tag), level: q.slot.level };
        return r
          ? { ...base, answered: true, given: r.given, correct: r.correct, answers: q.answers, solution: q.solution, hasExplain: !!q.explain }
          : { ...base, answered: false };
      }),
    };
  }

  answerQuestion(quizId: string, questionId: string, rawGiven: unknown) {
    const quiz = this.quiz(quizId);
    const q = quiz.questions.find((x) => x.id === questionId);
    if (!q) throw new WrongBookError("NOT_FOUND", "没有这道题", 404);
    const existing = quiz.responses[q.id];
    if (existing) return { correct: existing.correct, answers: q.answers, solution: q.solution, given: existing.given };
    if (quiz.status !== "ready") throw new WrongBookError("CONFLICT", "这份测验已经结束了", 409);
    const given = (Array.isArray(rawGiven) ? rawGiven : [rawGiven]).map((x) => cleanText(String(x ?? ""), 20)).slice(0, 2);
    if (given.length === 0 || given.every((g) => !g)) throw new WrongBookError("INPUT_INVALID", "先写下答案");
    const correct = q.qType === "fill" ? answersMatch(q.answers, given) : normalizeAnswer(given[0] ?? "") === normalizeAnswer(q.answers[0] ?? "");
    const at = this.now();
    // 同一份测验里同一知识点只有第一次答对算数：薄弱点出了 6 个题位，不能一次测验就从 0 档刷到 5 档
    const alreadyCredited = correct && quiz.questions.some((x) => x.slot.tag === q.slot.tag && quiz.responses[x.id]?.correct);
    quiz.responses[q.id] = { given, correct, at: at.toISOString() };
    if (!alreadyCredited) {
      this.store.state.mastery[q.slot.tag] = applyResult(this.store.state.mastery[q.slot.tag], correct, at, `quiz-${q.slot.kind}` as "quiz-review" | "quiz-weak" | "quiz-stretch");
    }
    if (Object.keys(quiz.responses).length >= quiz.questions.length) {
      quiz.status = "done";
      quiz.finishedAt = at.toISOString();
    }
    this.store.save();
    return { correct, answers: q.answers, solution: q.solution, given };
  }

  /* ------------------------------ 讲解 ------------------------------ */

  /**
   * 给一道已答的测验题 / 一道错题讲解。讲解只生成一次并缓存；模型不可用时退回「解题步骤」文字版（不缓存）。
   * 带 `again` 时跳过缓存，按孩子的反馈换一种讲法重讲（最多 MAX_EXPLAIN_REGENS 次）。
   */
  async explain(
    target: { quizId?: string; questionId?: string; itemId?: string },
    opts: { again?: boolean; feedback?: unknown } = {},
  ): Promise<{ explanation: Explanation; fallback: boolean; regens: number; canRetry: boolean }> {
    const port = this.options.port;
    let holder: { explain?: Explanation; explainRegens?: number };
    let input: Parameters<typeof explainQuestion>[1];
    if (target.itemId) {
      const item = this.item(target.itemId);
      holder = item;
      input = { stem: item.stem, options: item.options, answer: item.answer, solution: item.solution, childAnswer: item.result === "wrong" ? item.childAnswer : "", tags: item.tags };
    } else {
      const quiz = this.quiz(target.quizId ?? "");
      const q = quiz.questions.find((x) => x.id === target.questionId);
      const r = q ? quiz.responses[q.id] : undefined;
      if (!q || !r) throw new WrongBookError("CONFLICT", "先答完这道题再看讲解", 409);
      holder = q;
      input = {
        stem: q.stem, options: q.options, answer: q.answers.join("、") + (q.unit ? q.unit : ""), solution: q.solution, tags: [q.slot.tag],
        childAnswer: r.correct ? "" : r.given.join("、"), ...(q.visual ? { visual: q.visual } : {}),
      };
    }
    const regens = holder.explainRegens ?? 0;
    const reply = (explanation: Explanation, fallback: boolean) => {
      const n = holder.explainRegens ?? 0;
      return { explanation, fallback, regens: n, canRetry: n < MAX_EXPLAIN_REGENS };
    };
    if (holder.explain && !opts.again) return reply(holder.explain, false);
    if (opts.again && regens >= MAX_EXPLAIN_REGENS) {
      throw new WrongBookError("EXPLAIN_LIMIT", `已经换过 ${MAX_EXPLAIN_REGENS} 种讲法了，先按这版试试；还不行，和爸爸妈妈一起看看`, 409);
    }
    const feedback = sanitizeFeedback(opts.feedback);
    const previous = opts.again && holder.explain ? holder.explain : undefined;
    // 讲解也要核对：每步算式算对、数值答案出现在讲解里；不过关重讲一次，还不行就退回解题步骤文字版
    let asked: Explanation | null = null;
    for (let attempt = 0; attempt < 2 && port && !asked; attempt++) {
      const got = await explainQuestion(port, { ...input, ...(previous ? { previous } : {}), ...(opts.again ? { feedback } : {}) }).catch(() => null);
      if (got && explanationOk(got, input.answer)) asked = got;
    }
    // 配图里的数字必须来自题目和解法；对不上的图去掉，只留文字
    const explained = asked ? pruneVisuals(asked, [input.stem, ...(input.options ?? []), input.answer, ...input.solution].join("\n")) : null;
    if (explained) {
      holder.explain = explained;
      // 每次都存下来：孩子再看时看到的是最近这版；重讲次数不因失败增加
      if (opts.again) holder.explainRegens = regens + 1;
      this.store.save();
      return reply(explained, false);
    }
    const steps = (input.solution.length ? input.solution : [`正确答案是 ${input.answer}`]).map((say) => ({ say }));
    return { explanation: { title: "一步一步来", steps, tip: "" }, fallback: true, regens, canRetry: regens < MAX_EXPLAIN_REGENS };
  }

  /* ------------------------------ 定时出题 ------------------------------ */

  /** 每分钟检查：到了设定的「星期几 几点」且本周还没出过题，就自动出一份。 */
  tick(): void {
    const s = this.store.state;
    const { enabled, weekday, time } = s.settings.quiz;
    if (!enabled || !this.options.port) return;
    const now = this.now();
    const wk = weekKey(now);
    if (now.getTime() < scheduledInstant(now, weekday, time).getTime()) return;
    const thisWeek = Object.values(s.quizzes).filter((q) => q.weekKey === wk);
    if (thisWeek.some((q) => q.status !== "failed")) return;
    // 自动出题失败（模型临时不可用、服务重启）不占本周名额：隔 10 分钟再试，最多 3 次
    const failed = thisWeek.filter((q) => q.trigger === "auto");
    if (thisWeek.length > 0 && (failed.length >= 3 || thisWeek.length > failed.length || now.getTime() - Math.max(...failed.map((q) => Date.parse(q.createdAt))) < 10 * 60_000)) return;
    if (s.lastAutoNote?.weekKey === wk) return;
    try {
      this.startQuiz("auto");
    } catch (e) {
      if (e instanceof WrongBookError && e.code === "NO_DATA") {
        s.lastAutoNote = { weekKey: wk, reason: "本周还没有可以出题的错题，先录入作业吧" };
        this.store.save();
      }
    }
  }

  start(intervalMs = 60_000): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), intervalMs);
    this.tickTimer.unref?.();
    setTimeout(() => this.tick(), 5_000).unref?.();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    delete this.tickTimer;
  }
}
