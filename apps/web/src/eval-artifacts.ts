import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * 评测产物：「产物」里的一个分类。
 *
 * 评测任务（TestCase 集）是固定的、随仓库走，写在 EVAL_SUITES 里；
 * 评测结果（各 runtime 跑出来的 HTML）是运行产生的数据，放在数据目录：
 *
 *   <evalDir>/<suite>/<case>/<result>/meta.json   结果的描述（runtime、模型、版本、指标…）
 *   <evalDir>/<suite>/<case>/<result>/index.html  产物入口（以及它依赖的文件）
 *
 * 结果由 scripts/eval-artifacts.mjs 导入。服务端读取时对 meta 逐字段校验、对文件按扩展名白名单放行，
 * 并且结果页一律带 CSP sandbox：它是模型生成的 HTML，不能碰到控制台的同源数据。
 */

export type EvalCase = {
  id: string;
  title: string;
  /** 卡片上的一句话 */
  summary: string;
  /** 发给每个 runtime 的原文（固定，不改） */
  prompt: string;
  /** 看结果时重点比什么 */
  lookFor: string[];
};

export type EvalSuite = {
  id: string;
  name: string;
  /** 这套评测在测什么变量 */
  purpose: string;
  /** 评测分类的说明（tips）：怎么跑、怎么读 */
  tips: string[];
  cases: EvalCase[];
};

export type EvalResultMeta = {
  id: string;
  runtime: string;
  model: string;
  version: string;
  versionLabel: string;
  rep: number;
  status: "ok" | "failed" | "partial";
  entry: string;
  createdAt: string;
  durationMs: number | null;
  tokens: { input: number | null; output: number | null; total: number | null } | null;
  toolCalls: number | null;
  sessionId: string;
  note: string;
  thumb: string;
  checks: {
    bytes: number | null;
    externalRefs: number | null;
    inlineScripts: number | null;
    consoleErrors: number | null;
    /** 会话里读取过的 baoyu-design 技能文件数（不同文件）：看模型有没有真的按技能走；基线应为 0 */
    skillFiles: number | null;
    overflowDesktop: boolean | null;
    overflowMobile: boolean | null;
  };
};

const FIXED_ANSWERS =
  "如果需要向我确认信息，按下面的默认处理，不要停下来等我：保真度=高保真；变体数量=1；没有现成设计系统，自行选定一套并说明；" +
  "输出目录=designs/<项目名>/，入口文件 index.html，所有资源放在同一目录里；做完后自己打开检查一遍再交付。";

export const EVAL_SUITES: EvalSuite[] = [
  {
    id: "design-skill",
    name: "设计技能评测（baoyu-design）",
    purpose: "同一批设计任务，在 Pi / Codex / Claude Code 上分别「不带技能」和「带 baoyu-design 技能」各跑一遍，看技能对产出的影响。",
    tips: [
      "这里放的是评测任务跑出来的产物。任务是固定的 5 条（见下方卡片），每条原文发给每个 runtime，不允许改措辞，否则前后不可比。",
      "「版本」= 评测条件：基线（不带技能）、baoyu-design（带技能，标明上游 commit）。同一个 runtime 内比版本，才能看出技能本身的影响；不同 runtime 之间还混着模型差异，只看趋势。",
      "每个条件建议跑 2~3 次（rep），单次结果波动很大，不要拿一次定结论。",
      "点进一条任务，勾选 2~4 个结果就能并排对比：产物画面、耗时、token、工具调用、外部依赖、是否自包含，一目了然。",
      "产物是模型生成的网页，在沙箱里打开：能运行脚本，但碰不到控制台的数据，也不会向外提交表单。",
      "结果由 scripts/eval-artifacts.mjs 导入，存放在数据目录的 eval-artifacts/ 下。",
    ],
    cases: [
      {
        id: "landing-pomodoro",
        title: "番茄钟 App 落地页",
        summary: "单页落地页：首屏、卖点、价格、行动按钮",
        prompt:
          "给一个叫「番茄岛」的专注计时 App 做一个宣传落地页：首屏要有一句话主张和下载按钮；三个卖点（25 分钟专注循环、种树记录、周报）；一个免费 / 专业版（每月 12 元）价格对比；页脚。语气克制、有设计感，桌面和手机都要好看。" +
          FIXED_ANSWERS,
        lookFor: ["首屏是否有明确的视觉焦点", "桌面 / 手机是否都不溢出", "价格对比是否清楚", "有没有套模板的味道"],
      },
      {
        id: "dashboard-coffee",
        title: "咖啡店销售仪表盘",
        summary: "给定一周数据的图表型仪表盘",
        prompt:
          "做一个咖啡店的周销售仪表盘。数据（周一到周日销量，杯）：美式 120/132/101/134/190/230/210，拿铁 90/110/95/120/160/210/205，冷萃 20/25/22/30/60/95/88；客单价 28 元。" +
          "要有：本周总销量和总营收的关键指标、按天的趋势图、三个品类的占比、一句话洞察。图表用页面里自带的代码画，不要依赖外部库。" +
          FIXED_ANSWERS,
        lookFor: ["数字是否算对（总销量 / 营收）", "图表是否可读、配色是否克制", "有没有无依据的编造数据", "是否自包含"],
      },
      {
        id: "deck-launch",
        title: "产品发布 5 页幻灯片",
        summary: "HTML 幻灯片：封面、问题、方案、数据、行动",
        prompt:
          "为「番茄岛」做一份 5 页的产品发布幻灯片（HTML，可用键盘左右键翻页）：封面；用户的问题；我们的方案；一页数据（上线 90 天，日活 3.2 万，次日留存 46%，付费转化 7.8%）；最后一页是行动号召。16:9。" +
          FIXED_ANSWERS,
        lookFor: ["能否翻页、页数是否正好 5", "每页信息密度", "数据页是否如实用了给定数字", "16:9 缩放是否正常"],
      },
      {
        id: "wireframe-ledger",
        title: "记账 App 线框图",
        summary: "手机端 3 屏低保真线框",
        prompt:
          "画一个手机记账 App 的低保真线框图，3 屏：首页（本月收支概览 + 最近账单）、记一笔（金额键盘 + 分类）、统计（按分类的占比）。要像线框，不要做成高保真视觉稿；屏幕之间用箭头或标注说明怎么跳转。" +
          "如果需要向我确认信息，按默认处理：保真度=低保真；变体数量=1；输出目录=designs/<项目名>/，入口文件 index.html；做完后自己打开检查一遍再交付。",
        lookFor: ["是否真的是低保真（没有多余装饰）", "三屏的信息是否完整", "跳转标注是否清楚"],
      },
      {
        id: "doc-resume",
        title: "一页中文简历",
        summary: "A4 打印友好、给定内容的简历",
        prompt:
          "把下面的内容排成一页 A4 的中文简历（要能打印）：姓名 林一；岗位 产品设计师；3 年经验；联系方式 linyi@example.com；" +
          "经历 1：2023-2026 星桥科技，产品设计师，主导会员体系改版，付费转化提升 18%；经历 2：2021-2023 云岫网络，交互设计师，负责 12 个后台页面的设计规范；" +
          "技能：Figma、用户研究、设计系统、基础前端；教育：2017-2021 华东工业大学 工业设计。不要编造内容里没有的信息。" +
          FIXED_ANSWERS,
        lookFor: ["是否恰好一页 A4", "有没有编造信息", "中文字体与排版", "打印样式"],
      },
    ],
  },
];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** 结果目录里允许对外提供的文件类型 */
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_DEPTH = 5;

/**
 * 结果页的 CSP：
 * - sandbox 不带 allow-same-origin：页面是不透明源，读不到控制台的 cookie / localStorage / 接口；
 * - 允许内联脚本与样式（模型生成的自包含 HTML 几乎都这么写），允许 https 的图片 / 字体 / 样式 / 脚本
 *   （基线往往靠 CDN，禁掉会让对比失真；是否有外部依赖由 checks.externalRefs 单独记录）；
 * - connect-src 'none'、form-action 'none'：不能向任何地方发请求或提交表单；
 * - frame-ancestors 'self'：只有控制台自己能嵌入。
 */
export const EVAL_CSP = [
  "sandbox allow-scripts allow-popups",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

const str = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

function isSafeRel(rel: string): boolean {
  if (!rel || rel.length > 300) return false;
  const parts = rel.split("/");
  if (parts.length > MAX_DEPTH) return false;
  return parts.every((part) => SEGMENT_RE.test(part) && !part.includes(".."));
}

function parseMeta(id: string, raw: unknown, dir: string): EvalResultMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, any>;
  const runtime = str(m["runtime"], 24);
  const version = str(m["version"], 64);
  const entry = str(m["entry"], 300) || "index.html";
  if (!runtime || !ID_RE.test(version) || !isSafeRel(entry) || !MIME[entry.slice(entry.lastIndexOf(".") + 1).toLowerCase()]) return null;
  if (!existsSync(join(dir, entry))) return null;
  const createdAt = str(m["createdAt"], 40);
  const when = Date.parse(createdAt);
  const status = m["status"] === "failed" || m["status"] === "partial" ? m["status"] : "ok";
  const tokens = m["tokens"] && typeof m["tokens"] === "object"
    ? { input: num(m["tokens"].input), output: num(m["tokens"].output), total: num(m["tokens"].total) }
    : null;
  const checks = (m["checks"] && typeof m["checks"] === "object" ? m["checks"] : {}) as Record<string, unknown>;
  const thumb = str(m["thumb"], 300);
  return {
    id,
    runtime,
    model: str(m["model"], 80),
    version,
    versionLabel: str(m["versionLabel"], 60) || version,
    rep: Number.isInteger(m["rep"]) && m["rep"] >= 1 && m["rep"] <= 99 ? m["rep"] : 1,
    status,
    entry,
    createdAt: Number.isFinite(when) ? new Date(when).toISOString() : "",
    durationMs: num(m["durationMs"]),
    tokens,
    toolCalls: num(m["toolCalls"]),
    sessionId: str(m["sessionId"], 64),
    note: str(m["note"], 300),
    thumb: thumb && isSafeRel(thumb) && /\.(png|jpe?g|webp)$/i.test(thumb) && existsSync(join(dir, thumb)) ? thumb : "",
    checks: {
      bytes: num(checks["bytes"]),
      externalRefs: num(checks["externalRefs"]),
      inlineScripts: num(checks["inlineScripts"]),
      consoleErrors: num(checks["consoleErrors"]),
      skillFiles: num(checks["skillFiles"]),
      overflowDesktop: bool(checks["overflowDesktop"]),
      overflowMobile: bool(checks["overflowMobile"]),
    },
  };
}

export class EvalArtifacts {
  private cache: { at: number; results: Map<string, EvalResultMeta[]> } | null = null;
  private ttlMs = 2000;

  constructor(private readonly dir: string | undefined) {}

  private scan(): Map<string, EvalResultMeta[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.results;
    const results = new Map<string, EvalResultMeta[]>();
    if (this.dir) {
      for (const suite of EVAL_SUITES) {
        for (const testCase of suite.cases) {
          const caseDir = join(this.dir, suite.id, testCase.id);
          const list: EvalResultMeta[] = [];
          let names: string[] = [];
          try { names = readdirSync(caseDir); } catch { /* 还没有结果 */ }
          for (const name of names.sort()) {
            if (!ID_RE.test(name)) continue;
            const dir = join(caseDir, name);
            try {
              if (!lstatSync(dir).isDirectory()) continue;
              const meta = parseMeta(name, JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")), dir);
              if (meta) list.push(meta);
            } catch { /* 坏的 meta 直接跳过，不影响其他结果 */ }
          }
          list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
          results.set(`${suite.id}/${testCase.id}`, list);
        }
      }
    }
    this.cache = { at: now, results };
    return results;
  }

  catalog() {
    const results = this.scan();
    return {
      schema: 1,
      suites: EVAL_SUITES.map((suite) => ({
        ...suite,
        cases: suite.cases.map((testCase) => ({ ...testCase, results: results.get(`${suite.id}/${testCase.id}`) ?? [] })),
      })),
    };
  }

  /** 读结果目录里的一个文件；不在白名单里就返回 null */
  read(suiteId: string, caseId: string, resultId: string, relPath: string): { body: Buffer; type: string } | null {
    if (!this.dir || !ID_RE.test(suiteId) || !ID_RE.test(caseId) || !ID_RE.test(resultId)) return null;
    const meta = this.scan().get(`${suiteId}/${caseId}`)?.find((item) => item.id === resultId);
    if (!meta) return null;
    const rel = relPath.replace(/^\/+/, "").replace(/\/+$/, "") || meta.entry;
    // meta.json 是评测登记信息（会话 id、备注），不是产物的一部分
    if (!isSafeRel(rel) || rel === "meta.json") return null;
    const type = MIME[rel.slice(rel.lastIndexOf(".") + 1).toLowerCase()];
    if (!type) return null;
    try {
      const root = realpathSync(join(this.dir, suiteId, caseId, resultId));
      const file = realpathSync(join(root, rel));
      if (!file.startsWith(root + sep)) return null;
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
      return { body: readFileSync(file), type };
    } catch {
      return null;
    }
  }
}

export const evalEtag = (body: Buffer): string => `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
