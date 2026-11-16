/**
 * 心愿挑战岛：每日 / 每周挑战目标、打卡（带照片）、星星积分与心愿兑换的服务端账本。
 *
 * 为什么要放服务端：小朋友的打卡照片和积分不能只存在浏览器里，换设备 / 清缓存就全丢了。
 * 页面可以离线操作，恢复网络后把操作按顺序补交；每个操作都带客户端生成的 id，
 * 重复提交只会生效一次，所以「重试」不会多记一次打卡。
 *
 * 口径：
 *  - 日期与周次一律按北京时间（固定 UTC+8，不受宿主机时区影响）。
 *  - 星星余额不单独存：= 所有打卡的 points + bonus − 所有兑换的 cost − 所有惩罚记录的 points。
 *    这样删记录后不会对不上；扣分可以扣成负数（先欠着，打卡再补回来）。
 *  - 每个目标每个周期最多打卡 target 次；第 target 次打卡记下完成奖励 bonus（之后不再重复给）。
 *  - 打卡照片单独存文件，state.json 里只留元数据；读写都在一个进程内同步完成，
 *    写入走「临时文件 → rename」，读者不会看到写了一半的 JSON。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beijingDateKey, beijingDayStartMs, beijingParts } from "./platform-time.js";

export type ChallengePeriod = "daily" | "weekly";
export type PhotoMime = "image/jpeg" | "image/png" | "image/webp";

export interface ChallengeChild {
  id: string;
  name: string;
  emoji: string;
  color: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChallengeGoal {
  id: string;
  childId: string;
  title: string;
  emoji: string;
  period: ChallengePeriod;
  /** 每次打卡得到的星星 */
  points: number;
  /** 一个周期内打满 target 次的额外奖励 */
  bonus: number;
  target: number;
  photoRequired: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChallengeGift {
  id: string;
  name: string;
  emoji: string;
  cost: number;
  /** null = 不限量 */
  stock: number | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChallengeCheckin {
  id: string;
  childId: string;
  goalId: string;
  /** 北京时间日期 YYYY-MM-DD */
  dayKey: string;
  /** 北京时间这一周的周一日期 YYYY-MM-DD（周次身份） */
  weekKey: string;
  at: string;
  /** 这次打卡得到的星星：打卡时可以临时调，默认取目标的 points。 */
  points: number;
  bonus: number;
  photoId?: string;
  note?: string;
  /** 事后补交（页面只让补最近 15 天）：相册与记录里标「补交」。 */
  backfill?: boolean;
}

export interface ChallengeRedemption {
  id: string;
  childId: string;
  giftId: string;
  giftName: string;
  giftEmoji: string;
  cost: number;
  at: string;
  dayKey: string;
  note?: string;
}

export interface ChallengePhoto {
  id: string;
  childId: string;
  mime: PhotoMime;
  bytes: number;
  at: string;
}

/** 惩罚任务（扣分项）：不小心做了就记一笔，星星会变少。 */
export interface ChallengePenalty {
  id: string;
  childId: string;
  title: string;
  emoji: string;
  /** 每次扣多少颗星星（正数，记录时从余额里减掉） */
  points: number;
  /** 记扣分时要不要先拍一张现场照片（老数据没有这个字段时按 true 处理） */
  photoRequired?: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 一次扣分记录。标题 / emoji / 星星数在记录时快照，改惩罚任务不会改写历史。 */
export interface ChallengePenaltyLog {
  id: string;
  childId: string;
  penaltyId: string;
  title: string;
  emoji: string;
  points: number;
  at: string;
  /** 北京时间日期 YYYY-MM-DD */
  dayKey: string;
  photoId?: string;
  note?: string;
}

export interface ChallengeState {
  schema: 1;
  children: ChallengeChild[];
  goals: ChallengeGoal[];
  gifts: ChallengeGift[];
  checkins: ChallengeCheckin[];
  redemptions: ChallengeRedemption[];
  penalties: ChallengePenalty[];
  penaltyLogs: ChallengePenaltyLog[];
  photos: Record<string, ChallengePhoto>;
  /** 已处理过的操作 id（只留最近 2000 个），用于重试幂等 */
  appliedOps: string[];
}

export interface ChallengeWeek {
  /** 周一日期（北京时间） */
  key: string;
  start: string;
  end: string;
  label: string;
}

export interface ChallengeClock {
  now: string;
  today: string;
  week: ChallengeWeek;
}

export interface ChallengeSnapshot extends ChallengeClock {
  state: ChallengeState;
}

export class ChallengeError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 413 = 400) {
    super(message);
    this.name = "ChallengeError";
  }
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_CHILDREN = 8;
const MAX_GOALS = 60;
const MAX_GIFTS = 60;
const MAX_CHECKINS = 5000;
const MAX_REDEMPTIONS = 2000;
const MAX_PENALTIES = 30;
const MAX_PENALTY_LOGS = 3000;
const MAX_PHOTOS = 3000;
const OPS_KEPT = 2000;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MIN_PHOTO_BYTES = 64;
/** 离线补交允许的最早时间（再早视为异常数据） */
const MAX_BACKFILL_MS = 60 * 86_400_000;
/** 允许客户端时钟比服务器快这么多（只看将来几分钟，避免时区误差误伤） */
const MAX_FUTURE_MS = 10 * 60_000;

function cleanText(value: unknown, max: number, label: string, min = 1): string {
  if (typeof value !== "string") throw new ChallengeError("INPUT_INVALID", `${label}格式不对`);
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (text.length < min) throw new ChallengeError("INPUT_INVALID", `${label}不能为空`);
  return text.slice(0, max);
}

function cleanOptionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function cleanId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new ChallengeError("INPUT_INVALID", `${label}格式不对`);
  return value;
}

function cleanInt(value: unknown, min: number, max: number, label: string, fallback?: number): number {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < min || n > max) {
    throw new ChallengeError("INPUT_INVALID", `${label}需要是 ${min}～${max} 的整数`);
  }
  return n;
}

function cleanBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function cleanEmoji(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (!text || text.length > 8) return fallback;
  return text;
}

function cleanColor(value: unknown, fallback: string): string {
  return typeof value === "string" && COLOR_RE.test(value) ? value.toLowerCase() : fallback;
}

function parseMoment(value: unknown, fallback: Date, nowMs: number): Date {
  if (value === undefined || value === null || value === "") return fallback;
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new ChallengeError("INPUT_INVALID", "时间格式不对");
  if (ms > nowMs + MAX_FUTURE_MS) throw new ChallengeError("INPUT_INVALID", "时间不能晚于现在");
  if (ms < nowMs - MAX_BACKFILL_MS) throw new ChallengeError("INPUT_INVALID", "太久以前的记录不能再补了");
  return new Date(ms);
}

/** 北京时间某一周（周一到周日）。 */
export function beijingWeekOf(value: Date | string = new Date()): ChallengeWeek {
  const day = beijingDateKey(value);
  const parts = beijingParts(value);
  const weekday = parts?.weekday ?? 0;
  const mondayOffset = (weekday + 6) % 7;
  const startMs = beijingDayStartMs(day) - mondayOffset * 86_400_000;
  const start = beijingDateKey(startMs);
  const end = beijingDateKey(startMs + 6 * 86_400_000);
  return { key: start, start, end, label: `${start.slice(5)} ~ ${end.slice(5)}` };
}

export function periodKeyOf(period: ChallengePeriod, moment: Date): string {
  if (period === "daily") return beijingDateKey(moment);
  return beijingWeekOf(moment).key;
}

export function clockOf(now: Date): ChallengeClock {
  return { now: now.toISOString(), today: beijingDateKey(now), week: beijingWeekOf(now) };
}

function emptyState(): ChallengeState {
  return {
    schema: 1,
    children: [],
    goals: [],
    gifts: [],
    checkins: [],
    redemptions: [],
    penalties: [],
    penaltyLogs: [],
    photos: {},
    appliedOps: []
  };
}

function balanceOf(state: ChallengeState, childId: string): number {
  let total = 0;
  for (const c of state.checkins) if (c.childId === childId) total += c.points + c.bonus;
  for (const r of state.redemptions) if (r.childId === childId) total -= r.cost;
  for (const p of state.penaltyLogs) if (p.childId === childId) total -= p.points;
  return total;
}

function photoExt(mime: PhotoMime): string {
  return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}

function sniffImage(bytes: Buffer): PhotoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export type ChallengeOpResult = { id: string; ok: true; duplicate?: boolean } | { id: string; ok: false; code: string; message: string };

interface ChallengeOp {
  id: string;
  type: string;
  at?: string;
  [key: string]: unknown;
}

/**
 * 账本本体。所有方法同步读写；HTTP 层只负责鉴权与搬数据。
 */
export class ChallengeStore {
  private readonly file: string;
  private readonly photoDir: string;

  constructor(dataDir: string, private readonly now: () => Date = () => new Date()) {
    this.file = join(dataDir, "challenge", "state.json");
    this.photoDir = join(dataDir, "challenge", "photos");
  }

  private load(): ChallengeState {
    if (!existsSync(this.file)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<ChallengeState>;
      return {
        schema: 1,
        children: Array.isArray(parsed.children) ? parsed.children : [],
        goals: Array.isArray(parsed.goals) ? parsed.goals : [],
        gifts: Array.isArray(parsed.gifts) ? parsed.gifts : [],
        checkins: Array.isArray(parsed.checkins) ? parsed.checkins : [],
        redemptions: Array.isArray(parsed.redemptions) ? parsed.redemptions : [],
        penalties: Array.isArray(parsed.penalties) ? parsed.penalties : [],
        penaltyLogs: Array.isArray(parsed.penaltyLogs) ? parsed.penaltyLogs : [],
        photos: parsed.photos && typeof parsed.photos === "object" ? parsed.photos : {},
        appliedOps: Array.isArray(parsed.appliedOps) ? parsed.appliedOps : []
      };
    } catch {
      return emptyState();
    }
  }

  private save(state: ChallengeState): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  snapshot(): ChallengeSnapshot {
    const now = this.now();
    return { ...clockOf(now), state: this.load() };
  }

  /** 一次可提交多个操作；按数组顺序执行，单个失败不影响后面的（照片等依赖由客户端保证顺序）。 */
  applyOps(input: unknown): { results: ChallengeOpResult[]; snapshot: ChallengeSnapshot } {
    if (!Array.isArray(input)) throw new ChallengeError("INPUT_INVALID", "操作列表格式不对");
    if (input.length > 100) throw new ChallengeError("INPUT_INVALID", "一次最多提交 100 个操作");
    const now = this.now();
    const state = this.load();
    const results: ChallengeOpResult[] = [];
    let changed = false;
    const touchedGoals = new Set<string>();

    for (const raw of input) {
      let opId = "";
      try {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ChallengeError("INPUT_INVALID", "操作格式不对");
        const op = raw as ChallengeOp;
        opId = cleanId(op.id, "操作 id");
        if (state.appliedOps.includes(opId)) {
          results.push({ id: opId, ok: true, duplicate: true });
          continue;
        }
        const applied = this.applyOne(state, op, now, touchedGoals);
        if (applied) changed = true;
        state.appliedOps.push(opId);
        if (state.appliedOps.length > OPS_KEPT) state.appliedOps.splice(0, state.appliedOps.length - OPS_KEPT);
        changed = true;
        results.push({ id: opId, ok: true });
      } catch (error) {
        const e = error instanceof ChallengeError ? error : new ChallengeError("INPUT_INVALID", "操作没有生效");
        results.push({ id: opId || "unknown", ok: false, code: e.code, message: e.message });
      }
    }

    if (changed) {
      for (const goalId of touchedGoals) this.recomputeBonuses(state, goalId);
      this.save(state);
    }
    const at = this.now();
    return { results, snapshot: { ...clockOf(at), state } };
  }

  /** 返回是否真的改动了数据（重复创建等幂等操作返回 false）。 */
  private applyOne(state: ChallengeState, op: ChallengeOp, now: Date, touchedGoals: Set<string>): boolean {
    const at = now.toISOString();
    switch (op.type) {
      case "child.add": {
        // 添加操作的 op id 就是实体的 id：同一次添加重试时既不重复加，也不会换出一个新 id。
        const id = op.id;
        if (state.children.some((c) => c.id === id)) return false;
        if (state.children.filter((c) => c.active).length >= MAX_CHILDREN) throw new ChallengeError("LIMIT", `最多 ${MAX_CHILDREN} 个小朋友`);
        state.children.push({
          id,
          name: cleanText(op["name"], 12, "名字"),
          emoji: cleanEmoji(op["emoji"], "🦄"),
          color: cleanColor(op["color"], "#6ec6ff"),
          active: true,
          createdAt: at,
          updatedAt: at
        });
        return true;
      }
      case "child.update": {
        const child = this.child(state, op["childId"]);
        if (op["name"] !== undefined) child.name = cleanText(op["name"], 12, "名字");
        if (op["emoji"] !== undefined) child.emoji = cleanEmoji(op["emoji"], child.emoji);
        if (op["color"] !== undefined) child.color = cleanColor(op["color"], child.color);
        if (op["active"] !== undefined) child.active = cleanBool(op["active"], child.active);
        child.updatedAt = at;
        return true;
      }
      case "child.remove": {
        const child = this.child(state, op["childId"]);
        child.active = false;
        child.updatedAt = at;
        for (const goal of state.goals) if (goal.childId === child.id) goal.active = false;
        for (const penalty of state.penalties) if (penalty.childId === child.id) penalty.active = false;
        return true;
      }
      case "goal.add": {
        const id = op.id;
        if (state.goals.some((g) => g.id === id)) return false;
        const child = this.child(state, op["childId"]);
        if (state.goals.filter((g) => g.childId === child.id && g.active).length >= MAX_GOALS) throw new ChallengeError("LIMIT", "目标太多了，先删几个吧");
        const period = op["period"] === "weekly" ? "weekly" : "daily";
        state.goals.push({
          id,
          childId: child.id,
          title: cleanText(op["title"], 20, "目标名称"),
          emoji: cleanEmoji(op["emoji"], "🌟"),
          period,
          points: cleanInt(op["points"], 1, 100, "每次星星", 10),
          bonus: cleanInt(op["bonus"], 0, 200, "完成奖励", 10),
          target: cleanInt(op["target"], 1, 14, "目标次数", 1),
          photoRequired: cleanBool(op["photoRequired"], true),
          active: true,
          createdAt: at,
          updatedAt: at
        });
        return true;
      }
      case "goal.update": {
        const goal = this.goal(state, op["goalId"]);
        if (op["title"] !== undefined) goal.title = cleanText(op["title"], 20, "目标名称");
        if (op["emoji"] !== undefined) goal.emoji = cleanEmoji(op["emoji"], goal.emoji);
        if (op["period"] !== undefined) goal.period = op["period"] === "weekly" ? "weekly" : "daily";
        if (op["points"] !== undefined) goal.points = cleanInt(op["points"], 1, 100, "每次星星");
        if (op["bonus"] !== undefined) goal.bonus = cleanInt(op["bonus"], 0, 200, "完成奖励");
        if (op["target"] !== undefined) goal.target = cleanInt(op["target"], 1, 14, "目标次数");
        if (op["photoRequired"] !== undefined) goal.photoRequired = cleanBool(op["photoRequired"], goal.photoRequired);
        if (op["active"] !== undefined) goal.active = cleanBool(op["active"], goal.active);
        goal.updatedAt = at;
        touchedGoals.add(goal.id);
        return true;
      }
      case "goal.remove": {
        const goal = this.goal(state, op["goalId"]);
        goal.active = false;
        goal.updatedAt = at;
        return true;
      }
      case "gift.add": {
        const id = op.id;
        if (state.gifts.some((g) => g.id === id)) return false;
        if (state.gifts.filter((g) => g.active).length >= MAX_GIFTS) throw new ChallengeError("LIMIT", "心愿池满了");
        state.gifts.push({
          id,
          name: cleanText(op["name"], 20, "礼物名称"),
          emoji: cleanEmoji(op["emoji"], "🎁"),
          cost: cleanInt(op["cost"], 1, 10_000, "需要的星星"),
          stock: op["stock"] === null || op["stock"] === undefined || op["stock"] === "" ? null : cleanInt(op["stock"], 0, 99, "数量"),
          active: true,
          createdAt: at,
          updatedAt: at
        });
        return true;
      }
      case "gift.update": {
        const gift = this.gift(state, op["giftId"]);
        if (op["name"] !== undefined) gift.name = cleanText(op["name"], 20, "礼物名称");
        if (op["emoji"] !== undefined) gift.emoji = cleanEmoji(op["emoji"], gift.emoji);
        if (op["cost"] !== undefined) gift.cost = cleanInt(op["cost"], 1, 10_000, "需要的星星");
        if (op["stock"] !== undefined) gift.stock = op["stock"] === null || op["stock"] === "" ? null : cleanInt(op["stock"], 0, 99, "数量");
        if (op["active"] !== undefined) gift.active = cleanBool(op["active"], gift.active);
        gift.updatedAt = at;
        return true;
      }
      case "gift.remove": {
        const gift = this.gift(state, op["giftId"]);
        gift.active = false;
        gift.updatedAt = at;
        return true;
      }
      case "checkin.add": {
        const id = op.id;
        if (state.checkins.some((c) => c.id === id)) return false;
        if (state.checkins.length >= MAX_CHECKINS) throw new ChallengeError("LIMIT", "记录太多了");
        const child = this.child(state, op["childId"]);
        const goal = this.goal(state, op["goalId"]);
        if (goal.childId !== child.id) throw new ChallengeError("INPUT_INVALID", "这个目标不是这位小朋友的");
        if (!goal.active) throw new ChallengeError("GOAL_ARCHIVED", "这个目标已经收起来了");
        const moment = parseMoment(op["at"], now, now.getTime());
        const atIso = moment.toISOString();
        const dayKey = beijingDateKey(moment);
        const weekKey = beijingWeekOf(moment).key;
        const count = state.checkins.filter((c) => c.goalId === goal.id && (goal.period === "daily" ? c.dayKey === dayKey : c.weekKey === weekKey)).length;
        if (count >= goal.target) {
          throw new ChallengeError("GOAL_FULL", goal.period === "daily" ? "今天的这个目标已经完成啦" : "这周的这个目标已经完成啦");
        }
        const photoId = op["photoId"] === undefined || op["photoId"] === null || op["photoId"] === "" ? undefined : cleanId(op["photoId"], "照片 id");
        if (photoId) {
          const photo = state.photos[photoId];
          if (!photo) throw new ChallengeError("PHOTO_MISSING", "照片还没上传好，请重试");
          if (photo.childId !== child.id) throw new ChallengeError("INPUT_INVALID", "照片不是这位小朋友的");
        } else if (goal.photoRequired) {
          throw new ChallengeError("PHOTO_REQUIRED", "这个目标要拍照才能打卡");
        }
        const note = cleanOptionalText(op["note"], 60);
        const backfill = op["backfill"] === true;
        // 这次打卡的星星：默认用目标里设的值，打卡时可以改（1～100）。
        const earned = op["points"] === undefined || op["points"] === null || op["points"] === "" ? goal.points : cleanInt(op["points"], 1, 100, "这次的星星");
        state.checkins.push({
          id,
          childId: child.id,
          goalId: goal.id,
          dayKey,
          weekKey,
          at: atIso,
          points: earned,
          bonus: 0,
          ...(photoId ? { photoId } : {}),
          ...(note ? { note } : {}),
          ...(backfill ? { backfill: true } : {})
        });
        touchedGoals.add(goal.id);
        return true;
      }
      case "checkin.remove": {
        const id = cleanId(op["checkinId"], "打卡 id");
        const index = state.checkins.findIndex((c) => c.id === id);
        if (index < 0) return false;
        const [removed] = state.checkins.splice(index, 1);
        if (removed) touchedGoals.add(removed.goalId);
        return true;
      }
      case "penalty.add": {
        const id = op.id;
        if (state.penalties.some((p) => p.id === id)) return false;
        const child = this.child(state, op["childId"]);
        if (state.penalties.filter((p) => p.childId === child.id && p.active).length >= MAX_PENALTIES) {
          throw new ChallengeError("LIMIT", "惩罚任务太多了，先删几个吧");
        }
        state.penalties.push({
          id,
          childId: child.id,
          title: cleanText(op["title"], 20, "惩罚任务名称"),
          emoji: cleanEmoji(op["emoji"], "🔔"),
          points: cleanInt(op["points"], 1, 100, "扣的星星", 5),
          photoRequired: cleanBool(op["photoRequired"], true),
          active: true,
          createdAt: at,
          updatedAt: at
        });
        return true;
      }
      case "penalty.update": {
        const penalty = this.penalty(state, op["penaltyId"]);
        if (op["title"] !== undefined) penalty.title = cleanText(op["title"], 20, "惩罚任务名称");
        if (op["emoji"] !== undefined) penalty.emoji = cleanEmoji(op["emoji"], penalty.emoji);
        if (op["points"] !== undefined) penalty.points = cleanInt(op["points"], 1, 100, "扣的星星");
        if (op["photoRequired"] !== undefined) penalty.photoRequired = cleanBool(op["photoRequired"], penalty.photoRequired !== false);
        if (op["active"] !== undefined) penalty.active = cleanBool(op["active"], penalty.active);
        penalty.updatedAt = at;
        return true;
      }
      case "penalty.remove": {
        const penalty = this.penalty(state, op["penaltyId"]);
        penalty.active = false;
        penalty.updatedAt = at;
        return true;
      }
      case "penaltyLog.add": {
        const id = op.id;
        if (state.penaltyLogs.some((p) => p.id === id)) return false;
        if (state.penaltyLogs.length >= MAX_PENALTY_LOGS) throw new ChallengeError("LIMIT", "扣分记录太多了");
        const child = this.child(state, op["childId"]);
        const penalty = this.penalty(state, op["penaltyId"]);
        if (penalty.childId !== child.id) throw new ChallengeError("INPUT_INVALID", "这个惩罚任务不是这位小朋友的");
        if (!penalty.active) throw new ChallengeError("PENALTY_ARCHIVED", "这个惩罚任务已经收起来了");
        const moment = parseMoment(op["at"], now, now.getTime());
        const photoId = op["photoId"] === undefined || op["photoId"] === null || op["photoId"] === "" ? undefined : cleanId(op["photoId"], "照片 id");
        if (photoId) {
          const photo = state.photos[photoId];
          if (!photo) throw new ChallengeError("PHOTO_MISSING", "照片还没上传好，请重试");
          if (photo.childId !== child.id) throw new ChallengeError("INPUT_INVALID", "照片不是这位小朋友的");
        } else if (penalty.photoRequired !== false) {
          throw new ChallengeError("PHOTO_REQUIRED", "这条惩罚任务要拍照才能记扣分");
        }
        const note = cleanOptionalText(op["note"], 60);
        state.penaltyLogs.push({
          id,
          childId: child.id,
          penaltyId: penalty.id,
          title: penalty.title,
          emoji: penalty.emoji,
          points: penalty.points,
          at: moment.toISOString(),
          dayKey: beijingDateKey(moment),
          ...(photoId ? { photoId } : {}),
          ...(note ? { note } : {})
        });
        return true;
      }
      case "penaltyLog.remove": {
        const id = cleanId(op["penaltyLogId"], "扣分记录 id");
        const index = state.penaltyLogs.findIndex((p) => p.id === id);
        if (index < 0) return false;
        state.penaltyLogs.splice(index, 1);
        return true;
      }
      case "redemption.add": {
        const id = op.id;
        if (state.redemptions.some((r) => r.id === id)) return false;
        if (state.redemptions.length >= MAX_REDEMPTIONS) throw new ChallengeError("LIMIT", "兑换记录太多了");
        const child = this.child(state, op["childId"]);
        const gift = this.gift(state, op["giftId"]);
        if (!gift.active) throw new ChallengeError("GIFT_ARCHIVED", "这个礼物已经下架了");
        if (gift.stock !== null) {
          const used = state.redemptions.filter((r) => r.giftId === gift.id).length;
          if (used >= gift.stock) throw new ChallengeError("GIFT_EMPTY", "这个礼物已经被换光啦");
        }
        const balance = balanceOf(state, child.id);
        // 这次兑换实际花掉的星星：不填就用礼物标价（1～10000），跟打卡时改星星一致。
        const cost = op["cost"] === undefined || op["cost"] === null || op["cost"] === "" ? gift.cost : cleanInt(op["cost"], 1, 10_000, "这次的星星");
        if (balance < cost) {
          throw new ChallengeError("NOT_ENOUGH", `星星还不够，还差 ${cost - balance} 颗`);
        }
        const moment = parseMoment(op["at"], now, now.getTime());
        const note = cleanOptionalText(op["note"], 60);
        state.redemptions.push({
          id,
          childId: child.id,
          giftId: gift.id,
          giftName: gift.name,
          giftEmoji: gift.emoji,
          cost,
          at: moment.toISOString(),
          dayKey: beijingDateKey(moment),
          ...(note ? { note } : {})
        });
        return true;
      }
      case "redemption.remove": {
        const id = cleanId(op["redemptionId"], "兑换 id");
        const index = state.redemptions.findIndex((r) => r.id === id);
        if (index < 0) return false;
        state.redemptions.splice(index, 1);
        return true;
      }
      default:
        throw new ChallengeError("INPUT_INVALID", "不认识的操作");
    }
  }

  /** 第 target 次打卡记完成奖励；删记录后重算，奖励跟着回到真正打满的那一次。 */
  private recomputeBonuses(state: ChallengeState, goalId: string): void {
    const goal = state.goals.find((g) => g.id === goalId);
    if (!goal) return;
    const groups = new Map<string, ChallengeCheckin[]>();
    for (const checkin of state.checkins) {
      if (checkin.goalId !== goalId) continue;
      const key = goal.period === "daily" ? checkin.dayKey : checkin.weekKey;
      const list = groups.get(key);
      if (list) list.push(checkin);
      else groups.set(key, [checkin]);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
      list.forEach((checkin, index) => {
        checkin.bonus = index === goal.target - 1 ? goal.bonus : 0;
      });
    }
  }

  private child(state: ChallengeState, id: unknown): ChallengeChild {
    const childId = cleanId(id, "小朋友 id");
    const child = state.children.find((c) => c.id === childId);
    if (!child) throw new ChallengeError("CHILD_NOT_FOUND", "找不到这位小朋友", 404);
    return child;
  }

  private goal(state: ChallengeState, id: unknown): ChallengeGoal {
    const goalId = cleanId(id, "目标 id");
    const goal = state.goals.find((g) => g.id === goalId);
    if (!goal) throw new ChallengeError("GOAL_NOT_FOUND", "找不到这个目标", 404);
    return goal;
  }

  private gift(state: ChallengeState, id: unknown): ChallengeGift {
    const giftId = cleanId(id, "礼物 id");
    const gift = state.gifts.find((g) => g.id === giftId);
    if (!gift) throw new ChallengeError("GIFT_NOT_FOUND", "找不到这个礼物", 404);
    return gift;
  }

  private penalty(state: ChallengeState, id: unknown): ChallengePenalty {
    const penaltyId = cleanId(id, "惩罚任务 id");
    const penalty = state.penalties.find((p) => p.id === penaltyId);
    if (!penalty) throw new ChallengeError("PENALTY_NOT_FOUND", "找不到这个惩罚任务", 404);
    return penalty;
  }

  /* ---------------- 照片 ---------------- */

  savePhoto(childId: string, body: ArrayBuffer, requestedId?: string): ChallengePhoto {
    const state = this.load();
    const child = this.child(state, childId);
    const bytes = Buffer.from(body);
    if (bytes.length < MIN_PHOTO_BYTES) throw new ChallengeError("PHOTO_INVALID", "照片是空的");
    if (bytes.length > MAX_PHOTO_BYTES) throw new ChallengeError("PHOTO_TOO_LARGE", "照片太大了（最大 8MB）", 413);
    const mime = sniffImage(bytes);
    if (!mime) throw new ChallengeError("PHOTO_INVALID", "只支持 JPG / PNG / WebP 照片");
    const id = requestedId ? cleanId(requestedId, "照片 id") : randomBytes(16).toString("hex");
    if (state.photos[id]) return state.photos[id];
    if (Object.keys(state.photos).length >= MAX_PHOTOS) throw new ChallengeError("LIMIT", "照片太多了，先删掉一些旧记录");
    mkdirSync(this.photoDir, { recursive: true, mode: 0o700 });
    const name = `${id}.${photoExt(mime)}`;
    const tmp = join(this.photoDir, `${name}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`);
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, join(this.photoDir, name));
    const photo: ChallengePhoto = { id, childId: child.id, mime, bytes: bytes.length, at: this.now().toISOString() };
    state.photos[id] = photo;
    this.save(state);
    return photo;
  }

  photo(id: string): { photo: ChallengePhoto; path: string } | null {
    if (!ID_RE.test(id)) return null;
    const state = this.load();
    const photo = state.photos[id];
    if (!photo) return null;
    const path = join(this.photoDir, `${id}.${photoExt(photo.mime)}`);
    return existsSync(path) ? { photo, path } : null;
  }

  deletePhoto(id: string): boolean {
    if (!ID_RE.test(id)) return false;
    const state = this.load();
    const photo = state.photos[id];
    if (!photo) return false;
    delete state.photos[id];
    this.save(state);
    try {
      unlinkSync(join(this.photoDir, `${id}.${photoExt(photo.mime)}`));
    } catch {
      /* 文件已经不在了也不影响账本 */
    }
    return true;
  }
}

export const CHALLENGE_LIMITS = { MAX_PHOTO_BYTES, MAX_CHILDREN, MAX_CHECKINS } as const;
export { balanceOf as challengeBalanceOf };
