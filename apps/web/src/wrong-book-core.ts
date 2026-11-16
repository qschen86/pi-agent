/**
 * 错题本的纯逻辑：知识点体系、掌握度、每周出题的配比、判分、讲解动画规格的清洗、错题 HTML。
 *
 * 全部不碰磁盘和模型：模型给出的任何文本 / 规格都先经过这里的清洗，再进存储或页面。
 * 时间口径一律北京时间（见 platform-time.ts）。
 */
import { BEIJING_OFFSET_MS, beijingParts } from "./platform-time.js";

/* ------------------------------ 知识点体系（沪教版三年级第一学期·草稿） ------------------------------ */

export interface KnowledgeGroup {
  id: string;
  name: string;
  tags: { id: string; name: string }[];
}

export const KNOWLEDGE: KnowledgeGroup[] = [
  {
    id: "mul", name: "乘法",
    tags: [
      { id: "mul-table", name: "表内乘法" },
      { id: "mul-2d1", name: "两位数乘一位数" },
      { id: "mul-3d1", name: "三位数乘一位数" },
      { id: "mul-zero", name: "乘数末尾或中间有0" },
      { id: "mul-est", name: "乘法估算" },
    ],
  },
  {
    id: "div", name: "除法",
    tags: [
      { id: "div-table", name: "表内除法" },
      { id: "div-2d1", name: "两位数除以一位数" },
      { id: "div-3d1", name: "三位数除以一位数" },
      { id: "div-zero", name: "商中间或末尾有0" },
      { id: "div-rem", name: "有余数的除法" },
      { id: "div-rem-rule", name: "余数比除数小" },
    ],
  },
  {
    id: "addsub", name: "加减法",
    tags: [
      { id: "add-3d", name: "三位数加法（进位）" },
      { id: "sub-3d", name: "三位数减法（退位）" },
      { id: "addsub-est", name: "加减估算" },
      { id: "addsub-check", name: "验算" },
    ],
  },
  {
    id: "mix", name: "混合运算",
    tags: [
      { id: "mix-order", name: "先乘除后加减" },
      { id: "mix-paren", name: "带括号的混合运算" },
    ],
  },
  {
    id: "word", name: "应用题",
    tags: [
      { id: "word-times", name: "倍的认识" },
      { id: "word-mul", name: "乘法应用题" },
      { id: "word-div", name: "除法应用题（平均分）" },
      { id: "word-two-step", name: "两步计算应用题" },
      { id: "word-compare", name: "多几少几的比较" },
    ],
  },
  {
    id: "measure", name: "量与计量",
    tags: [
      { id: "time-hms", name: "时、分、秒" },
      { id: "time-24h", name: "24时计时法" },
      { id: "time-elapsed", name: "经过的时间" },
      { id: "time-calendar", name: "年、月、日" },
      { id: "len-unit", name: "长度单位" },
      { id: "weight-unit", name: "质量单位" },
    ],
  },
  {
    id: "geo", name: "图形与几何",
    tags: [
      { id: "geo-rect", name: "长方形和正方形" },
      { id: "geo-perimeter", name: "周长" },
    ],
  },
  {
    id: "frac", name: "分数初步",
    tags: [
      { id: "frac-intro", name: "认识几分之一" },
      { id: "frac-compare", name: "分数比大小" },
    ],
  },
  {
    id: "stat", name: "统计",
    tags: [
      { id: "stat-table", name: "统计表" },
      { id: "stat-bar", name: "条形统计图" },
    ],
  },
  {
    id: "think", name: "数学思考",
    tags: [
      { id: "pattern", name: "找规律" },
      { id: "logic", name: "推理与搭配" },
    ],
  },
];

const TAG_NAMES = new Map<string, string>(KNOWLEDGE.flatMap((g) => g.tags.map((t) => [t.id, t.name] as const)));
const TAG_GROUP = new Map<string, string>(KNOWLEDGE.flatMap((g) => g.tags.map((t) => [t.id, g.name] as const)));

/** 自定义知识点 id 形如 `c:名称`；其余必须在体系里。 */
export function isKnownTag(id: string): boolean {
  return TAG_NAMES.has(id) || /^c:[^\s:]{1,12}$/.test(id);
}
export function tagName(id: string): string {
  return TAG_NAMES.get(id) ?? (id.startsWith("c:") ? id.slice(2) : id);
}
export function tagGroup(id: string): string {
  return TAG_GROUP.get(id) ?? "其他";
}
/** 清洗模型给的知识点：只留体系内 id，或合法的自定义名称（转成 c:名称）。 */
export function cleanTags(input: unknown, max = 3): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    let id = text;
    if (!TAG_NAMES.has(id)) {
      const byName = [...TAG_NAMES.entries()].find(([, name]) => name === text);
      if (byName) id = byName[0];
      else id = `c:${text.replace(/^c:/, "").replace(/\s+/g, "").slice(0, 12)}`;
    }
    if (isKnownTag(id) && !out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}
/** 给提示词用的知识点清单。 */
export function knowledgeForPrompt(): string {
  return KNOWLEDGE.map((g) => `${g.name}：${g.tags.map((t) => `${t.id}=${t.name}`).join("；")}`).join("\n");
}

/* ------------------------------ 北京时间的「周」 ------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本周周一的北京日期（周一至周日为一周）。 */
export function weekKey(now: Date): string {
  const p = beijingParts(now);
  if (!p) return "";
  const sinceMonday = (p.weekday + 6) % 7;
  const mondayUtc = Date.UTC(p.year, p.month - 1, p.day) - sinceMonday * DAY_MS;
  const d = new Date(mondayUtc);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 本周设置的那个「星期几 几点」对应的绝对时刻（weekday：0 周日 … 6 周六；周日算在周一开始的这一周末尾）。 */
export function scheduledInstant(now: Date, weekday: number, time: string): Date {
  const [h, m] = parseTime(time);
  const monday = Date.parse(`${weekKey(now)}T00:00:00+08:00`);
  const offsetDays = (weekday + 6) % 7;
  return new Date(monday + offsetDays * DAY_MS + (h * 60 + m) * 60_000);
}

export function parseTime(time: string): [number, number] {
  const hit = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!hit) return [8, 0];
  const h = Number(hit[1]);
  const m = Number(hit[2]);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 ? [h, m] : [8, 0];
}

/** 北京日期键 → 时间戳（当天中午，避免边界）。 */
export function dayMs(day: string): number {
  return Date.parse(`${day}T12:00:00+08:00`);
}

export function todayKey(now: Date): string {
  const d = new Date(now.getTime() + BEIJING_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/* ------------------------------ 掌握度 ------------------------------ */

export interface Mastery {
  /** 0~5：0 薄弱，1 刚见过，2~3 在巩固，4~5 熟练（和算术宠物岛同一套盒子） */
  box: number;
  /** 出题难度 1 基础 / 2 常规 / 3 拔高；熟练后拔高题答对才升 */
  level: number;
  right: number;
  wrong: number;
  lastAt: string;
  lastWrongAt?: string;
  /** 从薄弱爬到 2 档以上的时间：「最近掌握」的依据 */
  recoveredAt?: string;
}

export type ResultSource = "paper" | "quiz-review" | "quiz-weak" | "quiz-stretch";

/** 记一次对 / 错。试卷里的对只算「见过且会」，从 3 档起步；错一律打回薄弱（熟练的错一次降 3 档）。 */
export function applyResult(prev: Mastery | undefined, ok: boolean, now: Date, source: ResultSource = "paper"): Mastery {
  const at = now.toISOString();
  if (!prev) {
    return { box: ok ? 3 : 0, level: 1, right: ok ? 1 : 0, wrong: ok ? 0 : 1, lastAt: at, ...(ok ? {} : { lastWrongAt: at }) };
  }
  const next: Mastery = { ...prev, lastAt: at };
  if (ok) {
    next.right += 1;
    next.box = Math.min(5, prev.box + 1);
    if (prev.box <= 1 && next.box >= 2) next.recoveredAt = at;
    if (source === "quiz-stretch") next.level = Math.min(3, prev.level + 1);
  } else {
    next.wrong += 1;
    next.lastWrongAt = at;
    next.box = prev.box >= 4 ? prev.box - 3 : 0;
    delete next.recoveredAt;
    if (source === "quiz-stretch") next.level = Math.max(1, prev.level - 1);
  }
  return next;
}

export interface TagBuckets {
  weak: string[];
  recent: string[];
  strong: string[];
}

const RECENT_DAYS = 28;

export function classifyTags(mastery: Record<string, Mastery>, now: Date): TagBuckets {
  const weak: [string, Mastery][] = [];
  const recent: [string, Mastery][] = [];
  const strong: [string, Mastery][] = [];
  for (const [tag, m] of Object.entries(mastery)) {
    if (m.box <= 1) weak.push([tag, m]);
    else if (m.box >= 4) strong.push([tag, m]);
    else recent.push([tag, m]);
  }
  const byWrong = (a: [string, Mastery], b: [string, Mastery]) => (b[1].lastWrongAt ?? b[1].lastAt).localeCompare(a[1].lastWrongAt ?? a[1].lastAt);
  const byRecovered = (a: [string, Mastery], b: [string, Mastery]) => (b[1].recoveredAt ?? b[1].lastAt).localeCompare(a[1].recoveredAt ?? a[1].lastAt);
  const cutoff = now.getTime() - RECENT_DAYS * DAY_MS;
  // 「最近掌握」：近 4 周内从薄弱爬上来的优先；没有的话，其余在巩固档的也算
  const fresh = recent.filter(([, m]) => m.recoveredAt && Date.parse(m.recoveredAt) >= cutoff).sort(byRecovered);
  const rest = recent.filter((x) => !fresh.includes(x)).sort(byRecovered);
  return {
    weak: weak.sort(byWrong).map(([t]) => t),
    recent: [...fresh, ...rest].map(([t]) => t),
    strong: strong.sort((a, b) => a[1].lastAt.localeCompare(b[1].lastAt)).map(([t]) => t), // 最久没碰的熟练点先拔高
  };
}

export type QuizKind = "review" | "weak" | "stretch";

export interface QuizSlot {
  tag: string;
  kind: QuizKind;
  level: number;
}

/**
 * 每周题的配比：补弱 50% · 温习最近掌握 30% · 熟练点拔高 20%。
 * 某一类没有知识点时，名额按「补弱 → 温习 → 拔高」顺序补给还有的类别；一个知识点都没有就返回空。
 */
export function buildBlueprint(mastery: Record<string, Mastery>, count: number, now: Date): QuizSlot[] {
  const buckets = classifyTags(mastery, now);
  const total = Math.max(0, Math.floor(count));
  if (total === 0) return [];
  const pools: Record<QuizKind, string[]> = { weak: buckets.weak, review: buckets.recent, stretch: buckets.strong };
  const want: Record<QuizKind, number> = { weak: Math.round(total * 0.5), stretch: Math.round(total * 0.2), review: 0 };
  want.review = total - want.weak - want.stretch;
  const order: QuizKind[] = ["weak", "review", "stretch"];
  // 空类别的名额让给别人
  let spare = 0;
  for (const kind of order) if (pools[kind].length === 0) { spare += want[kind]; want[kind] = 0; }
  if (order.every((k) => pools[k].length === 0)) return [];
  while (spare > 0) {
    for (const kind of order) {
      if (spare > 0 && pools[kind].length > 0) { want[kind] += 1; spare -= 1; }
    }
  }
  const slots: QuizSlot[] = [];
  for (const kind of order) {
    const tags = pools[kind];
    for (let i = 0; i < want[kind]; i++) {
      const tag = tags[i % tags.length]!;
      const m = mastery[tag]!;
      const level = kind === "stretch" ? Math.min(3, m.level + 1) : kind === "weak" ? Math.min(2, m.level) : m.level;
      slots.push({ tag, kind, level });
    }
  }
  // 薄弱 / 温习 / 拔高交错，别连着出同一类
  const byKind = order.map((kind) => slots.filter((s) => s.kind === kind));
  const mixed: QuizSlot[] = [];
  while (mixed.length < slots.length) for (const list of byKind) { const s = list.shift(); if (s) mixed.push(s); }
  return mixed;
}

/* ------------------------------ 判分 ------------------------------ */

const FULL_TO_HALF: Record<string, string> = { "０": "0", "１": "1", "２": "2", "３": "3", "４": "4", "５": "5", "６": "6", "７": "7", "８": "8", "９": "9", "．": ".", "，": ",", "－": "-", "＋": "+", "：": ":" };

/** 去掉空格、单位、全角，方便比较「36」「36个」「３６」。 */
export function normalizeAnswer(raw: string): string {
  let s = String(raw ?? "").trim();
  s = s.replace(/[０-９．，－＋：]/g, (c) => FULL_TO_HALF[c] ?? c).replace(/[\s,，]/g, "");
  s = s.replace(/[零〇]/g, "0");
  // 余数的几种写法（7……1、7...1、7余1）统一成 7r1
  s = s.replace(/…+|\.{2,}|余数?/g, "r");
  const stripped = s.replace(/(厘米|毫米|分米|千米|公里|平方|立方|米|千克|公斤|克|吨|个|只|条|本|块|元|角|分钟|小时|秒|天|人|辆|页|棵|朵|张|支|盒|袋|瓶|份|组|次|岁|周|月|年|时|分)+$/, "");
  // 答案本身就是单位词（「分钟」）时不要剥成空串
  return (stripped || s).toLowerCase();
}

/** 单个空：数字按数值比，其余按规范化后的文本比。 */
export function blankMatches(expected: string, given: string): boolean {
  const a = normalizeAnswer(expected);
  const b = normalizeAnswer(given);
  if (!b) return false;
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  return a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 1e-9;
}

export function answersMatch(expected: string[], given: string[]): boolean {
  if (expected.length === 0 || given.length < expected.length) return false;
  return expected.every((e, i) => blankMatches(e, given[i] ?? ""));
}

/* ------------------------------ 安全的算式求值（校验 calc 题） ------------------------------ */

/** 只认数字、+ - × ÷ * / 和括号；除不尽时返回商与余数（只在最外层是 a÷b 且都是整数时）。 */
export function evalExpression(expr: string): { value: number; quotient?: number; remainder?: number } | null {
  const src = String(expr ?? "").replace(/\s+/g, "").replace(/[×xX＊]/g, "*").replace(/[÷／]/g, "/").replace(/（/g, "(").replace(/）/g, ")");
  if (!src || src.length > 80 || !/^[\d+\-*/().]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const num = (): number => {
    const start = i;
    while (i < src.length && /[\d.]/.test(src[i]!)) i++;
    const n = Number(src.slice(start, i));
    if (!Number.isFinite(n) || start === i) throw new Error("bad number");
    return n;
  };
  const factor = (): number => {
    if (peek() === "(") { i++; const v = sum(); if (peek() !== ")") throw new Error("paren"); i++; return v; }
    if (peek() === "-") { i++; return -factor(); }
    return num();
  };
  const term = (): number => {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = src[i++]!;
      const r = factor();
      if (op === "/" && r === 0) throw new Error("div0");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") { const op = src[i++]!; const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  try {
    const value = sum();
    if (i !== src.length || !Number.isFinite(value)) return null;
    const simple = /^(\d+)\/(\d+)$/.exec(src);
    if (simple && Number(simple[2]) > 0) {
      const a = Number(simple[1]);
      const b = Number(simple[2]);
      return { value, quotient: Math.floor(a / b), remainder: a % b };
    }
    return { value };
  } catch {
    return null;
  }
}

/* ------------------------------ 文本与 HTML ------------------------------ */

export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 文本 → 安全 HTML：先转义，再把 `{a/b}` 渲染成竖排分数、`____` 渲染成填空线。 */
export function richHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\{(\d{1,4})\/(\d{1,4})\}/g, '<span class="frac"><span>$1</span><span>$2</span></span>')
    .replace(/_{2,}|＿{2,}|（\s*）|\(\s*\)/g, '<span class="blank"></span>')
    .replace(/\n/g, "<br>");
}

export interface RenderableItem {
  qType: string;
  stem: string;
  options?: string[];
  figureNote?: string;
  hasFigure?: boolean;
  childAnswer?: string;
  answer?: string;
  solution?: string[];
}

/** 一道错题的 HTML 片段（服务端按固定模板生成，不含脚本和内联样式）。 */
export function renderItemHtml(item: RenderableItem): string {
  const parts: string[] = [`<div class="wb-q"><div class="wb-stem">${richHtml(item.stem)}</div>`];
  if (item.hasFigure) {
    parts.push(`<div class="wb-figure">${item.figureNote ? `图：${richHtml(item.figureNote)}` : "本题带图，点「看原图」"}</div>`);
  }
  if (item.options?.length) {
    parts.push(`<ul class="wb-options">${item.options.map((o) => `<li>${richHtml(o)}</li>`).join("")}</ul>`);
  }
  if (item.childAnswer) parts.push(`<div class="wb-row wb-mine"><b>我的答案</b><span>${richHtml(item.childAnswer)}</span></div>`);
  if (item.answer) parts.push(`<div class="wb-row wb-right"><b>正确答案</b><span>${richHtml(item.answer)}</span></div>`);
  if (item.solution?.length) {
    parts.push(`<ol class="wb-steps">${item.solution.map((s) => `<li>${richHtml(s)}</li>`).join("")}</ol>`);
  }
  parts.push("</div>");
  return parts.join("");
}

/* ------------------------------ 讲解动画规格 ------------------------------ */

export type Visual =
  | { t: "groups"; total: number; per: number; icon: string }
  | { t: "array"; rows: number; cols: number; icon: string }
  | { t: "vertical"; op: "+" | "-" | "×" | "÷"; a: number; b: number }
  | { t: "bar"; rows: { label: string; value: number }[]; unit: string; total: string }
  | { t: "numberline"; from: number; to: number; jumps: { from: number; to: number; label: string }[]; marks: number[] }
  | { t: "clock"; h: number; m: number; h2?: number; m2?: number }
  | { t: "rect"; w: number; h: number; unit: string }
  | { t: "fraction"; parts: number; shade: number; shape: "circle" | "bar" }
  | { t: "barchart"; data: { label: string; value: number }[]; title: string };

const ICONS = ["🍎", "⭐", "🐟", "🍪", "🌸", "⚽", "🍓", "🐥", "🥚", "🍬", "📄", "✉️", "🖍️", "🎈", "🍊", "📚", "●"];
const UNITS = ["毫米", "厘米", "分米", "米", "千米"];

const int = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

/** 模型给的图形 / 动画规格：只放行固定词汇和合理范围，其余一律丢掉（该步骤退回纯文字）。 */
export function sanitizeVisual(raw: unknown): Visual | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  // 找不到对得上的图标就用中性的小圆点，别默认画苹果
  const icon = typeof v["icon"] === "string" && ICONS.includes(v["icon"]) ? (v["icon"] as string) : "●";
  switch (v["t"]) {
    case "groups": {
      const total = int(v["total"], 1, 40);
      const per = int(v["per"], 1, 20);
      return total && per && per <= total ? { t: "groups", total, per, icon } : undefined;
    }
    case "array": {
      const rows = int(v["rows"], 1, 10);
      const cols = int(v["cols"], 1, 12);
      return rows && cols && rows * cols <= 80 ? { t: "array", rows, cols, icon } : undefined;
    }
    case "vertical": {
      const op = v["op"];
      const a = int(v["a"], 0, 99999);
      const b = int(v["b"], op === "÷" || op === "×" ? 1 : 0, op === "×" || op === "÷" ? 9 : 99999);
      if (a === undefined || b === undefined) return undefined;
      if (op !== "+" && op !== "-" && op !== "×" && op !== "÷") return undefined;
      if (op === "-" && a < b) return undefined;
      return { t: "vertical", op, a, b };
    }
    case "bar": {
      if (!Array.isArray(v["rows"])) return undefined;
      const rows = v["rows"].slice(0, 5).map((r) => {
        const o = (r ?? {}) as Record<string, unknown>;
        const value = typeof o["value"] === "number" && o["value"] >= 0 && o["value"] <= 100000 ? o["value"] : undefined;
        const label = cleanText(o["label"], 8);
        return value !== undefined && label ? { label, value } : undefined;
      });
      if (rows.length === 0 || rows.some((r) => !r)) return undefined;
      return { t: "bar", rows: rows as { label: string; value: number }[], unit: cleanText(v["unit"], 4), total: cleanText(v["total"], 10) };
    }
    case "numberline": {
      const from = int(v["from"], 0, 10000);
      const to = int(v["to"], 0, 10000);
      if (from === undefined || to === undefined || to <= from || to - from > 40) return undefined;
      const jumps = Array.isArray(v["jumps"])
        ? v["jumps"].slice(0, 8).flatMap((j) => {
            const o = (j ?? {}) as Record<string, unknown>;
            const a = int(o["from"], from, to);
            const b = int(o["to"], from, to);
            const label = cleanText(o["label"], 40);
            return a !== undefined && b !== undefined && a !== b ? [{ from: a, to: b, label: label.length <= 6 ? label : "" }] : [];
          })
        : [];
      const marks = Array.isArray(v["marks"]) ? v["marks"].slice(0, 6).flatMap((m) => { const n = int(m, from, to); return n === undefined ? [] : [n]; }) : [];
      return { t: "numberline", from, to, jumps, marks };
    }
    case "clock": {
      const h = int(v["h"], 0, 23);
      const m = int(v["m"], 0, 59);
      if (h === undefined || m === undefined) return undefined;
      const h2 = int(v["h2"], 0, 23);
      const m2 = int(v["m2"], 0, 59);
      return { t: "clock", h, m, ...(h2 !== undefined && m2 !== undefined ? { h2, m2 } : {}) };
    }
    case "rect": {
      const w = int(v["w"], 1, 100);
      const h = int(v["h"], 1, 100);
      const unit = typeof v["unit"] === "string" && UNITS.includes(v["unit"]) ? (v["unit"] as string) : "厘米";
      return w && h ? { t: "rect", w, h, unit } : undefined;
    }
    case "fraction": {
      const parts = int(v["parts"], 2, 12);
      const shade = int(v["shade"], 0, 12);
      if (!parts || shade === undefined || shade > parts) return undefined;
      return { t: "fraction", parts, shade, shape: v["shape"] === "bar" ? "bar" : "circle" };
    }
    case "barchart": {
      if (!Array.isArray(v["data"])) return undefined;
      const data = v["data"].slice(0, 8).map((d) => {
        const o = (d ?? {}) as Record<string, unknown>;
        const value = int(o["value"], 0, 1000);
        const label = cleanText(o["label"], 6);
        return value !== undefined && label ? { label, value } : undefined;
      });
      if (data.length < 2 || data.some((d) => !d)) return undefined;
      return { t: "barchart", data: data as { label: string; value: number }[], title: cleanText(v["title"], 12) };
    }
    default:
      return undefined;
  }
}

/** 给提示词用的动画词汇表。 */
export const VISUAL_VOCABULARY = [
  '{"t":"groups","total":12,"per":4,"icon":"🍎"}  平均分：把 total 个物品每 per 个圈成一组（有剩余会单独显示）',
  '{"t":"array","rows":3,"cols":4,"icon":"⭐"}  乘法点阵：rows 行 × cols 列',
  '{"t":"vertical","op":"×","a":47,"b":6}  竖式演示（op 为 + - × ÷；× ÷ 时 b 为 1~9 的一位数；由页面自己算每一步，你不用写过程）',
  '{"t":"bar","rows":[{"label":"小明","value":4},{"label":"小红","value":12}],"unit":"个","total":""}  线段图：几根长度成比例的线段，用来讲「倍」「多几少几」「和差」',
  '{"t":"numberline","from":0,"to":20,"jumps":[{"from":0,"to":6,"label":"+6"}],"marks":[]}  数轴跳步',
  '{"t":"clock","h":8,"m":30,"h2":10,"m2":15}  钟面（h2/m2 可选，表示结束时刻，用来讲经过的时间）',
  '{"t":"rect","w":8,"h":5,"unit":"厘米"}  长方形（正方形令 w=h），沿着边走一圈讲周长',
  '{"t":"fraction","parts":4,"shade":1,"shape":"circle"}  把圆（或长条）平均分成 parts 份，涂 shade 份',
  '{"t":"barchart","data":[{"label":"苹果","value":8},{"label":"梨","value":5}],"title":"水果"}  条形统计图',
].join("\n");

/* ------------------------------ 出题 / 讲解的自动核对 ------------------------------ */

/** 把数字抹掉，只留运算结构：「6 + 3 × 7 = ____」和「6 + 4 × 5 = ____」是同一种题。 */
export function stemSignature(stem: string): string {
  return stem.replace(/\d+/g, "#").replace(/\s+/g, "").replace(/_{2,}|＿{2,}/g, "_");
}

/**
 * 解题步骤里写出的每一个「a op b = c」都要算得对（有余数的除法按商核对）。
 * 只认完整的整数算式；带括号或看不懂的片段跳过，不误伤。
 */
export function solutionArithmeticOk(steps: string[]): boolean {
  const text = steps.join("\n");
  const re = /(\d+(?:\s*[+\-−×÷*/]\s*\d+)+)\s*=\s*(\d+)(\s*(?:…|\.{2,}|余))?/g;
  for (const m of text.matchAll(re)) {
    const expr = m[1]!.replace(/−/g, "-");
    const ev = evalExpression(expr);
    if (!ev) continue;
    const claimed = Number(m[2]);
    const hasRem = !!m[3];
    const ok = hasRem && ev.quotient !== undefined ? ev.quotient === claimed : Math.abs(ev.value - claimed) < 1e-9;
    if (!ok) return false;
  }
  return true;
}

/** 配图里的数字必须出现在题干 / 答案 / 解法 / 讲解文字里（或由它们直接算出来的结果里）：对不上的图是错图，宁可不画。 */
export function visualGrounded(v: Visual, text: string): boolean {
  const seen = new Set((text.match(/\d+/g) ?? []).map(Number));
  const has = (n: number) => seen.has(n);
  switch (v.t) {
    case "groups": return has(v.total) && has(v.per);
    case "array": return has(v.rows) && has(v.cols);
    case "vertical": return has(v.a) && has(v.b);
    case "bar": return v.rows.every((r) => has(r.value));
    case "rect": return has(v.w) && has(v.h);
    case "clock": return (has(v.h) || has(v.h % 12 || 12)) && (v.m === 0 || has(v.m));
    case "fraction": return has(v.parts);
    case "barchart": return v.data.every((d) => has(d.value));
    case "numberline": return true;
  }
}

/**
 * 讲解文字自己也要核对：每步写出的算式算对，且数值答案要在讲解里出现（选择题只核对算式）。
 * 不过关就当没讲出来（退回解题步骤文字版）。
 */
export function explanationOk(exp: Explanation, answer: string): boolean {
  const says = exp.steps.map((x) => x.say);
  if (!solutionArithmeticOk(says)) return false;
  const nums = answer.match(/\d+/g);
  if (!nums || /^[A-D]/.test(answer.trim())) return true;
  const text = says.join("\n");
  return nums.every((n) => text.includes(n));
}

/** 去掉对不上题目的配图，保留文字。 */
export function pruneVisuals(exp: Explanation, context: string): Explanation {
  const text = [context, ...exp.steps.map((s) => s.say)].join("\n");
  return { ...exp, steps: exp.steps.map((s) => (s.visual && !visualGrounded(s.visual, text) ? { say: s.say } : s)) };
}

/* ------------------------------ 讲解 / 题目的结构清洗 ------------------------------ */

export interface ExplainStep {
  say: string;
  visual?: Visual;
}
export interface Explanation {
  title: string;
  steps: ExplainStep[];
  tip: string;
  /** 孩子答错时：错在哪、为什么会这样想（温和的一两句） */
  whyWrong?: string;
}

/* ------------------------------ 重讲：孩子说哪里没听懂 ------------------------------ */

/** 孩子能点的「没听懂」原因（页面上的按钮文案与这里一一对应）。 */
export const EXPLAIN_REASONS = [
  { id: "fast", label: "讲得太快，还没想明白" },
  { id: "example", label: "这个例子我不熟" },
  { id: "step", label: "不知道这一步在算什么" },
  { id: "visual", label: "图没看懂" },
] as const;

/** 一道题最多换 2 次讲法：再多也不是「听不懂」，是这道题超纲了，得找人一起看。 */
export const MAX_EXPLAIN_REGENS = 2;

export interface ExplainFeedback {
  reasons: string[];
  text: string;
}

/** 孩子反馈只收固定原因和一句短话：不认识的 id 丢掉，长话截断。 */
export function sanitizeFeedback(raw: unknown): ExplainFeedback {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const allowed = new Set<string>(EXPLAIN_REASONS.map((r) => r.id));
  const picked = Array.isArray(o["reasons"]) ? o["reasons"].map((r) => String(r ?? "")) : [];
  const reasons = [...new Set(picked.filter((r) => allowed.has(r)))].slice(0, EXPLAIN_REASONS.length);
  const text = typeof o["text"] === "string" ? o["text"].replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return { reasons, text };
}

/** 把原因 id 换成给模型看的中文说法。 */
export function feedbackLabels(feedback: ExplainFeedback): string[] {
  return feedback.reasons.map((id) => EXPLAIN_REASONS.find((r) => r.id === id)?.label ?? id);
}

export function cleanExplanation(raw: unknown): Explanation | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o["steps"])) return undefined;
  const steps: ExplainStep[] = [];
  for (const s of o["steps"].slice(0, 10)) {
    const r = (s ?? {}) as Record<string, unknown>;
    const say = cleanText(r["say"], 90);
    if (!say) continue;
    const visual = sanitizeVisual(r["visual"]);
    steps.push({ say, ...(visual ? { visual } : {}) });
  }
  if (steps.length === 0) return undefined;
  const whyWrong = cleanText(o["whyWrong"], 120);
  return { title: cleanText(o["title"], 24) || "一起来想一想", steps, tip: cleanText(o["tip"], 60), ...(whyWrong ? { whyWrong } : {}) };
}
