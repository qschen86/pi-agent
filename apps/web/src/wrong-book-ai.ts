/**
 * 错题本的模型调用：看图识题、每周出题、独立重解（验题）、给小朋友的讲解。
 *
 * 一律 DeepSeek Flash + 高强度推理（识图与推理都用它，见 `pi --list-models`）。
 * 提示词在服务端；模型的输出只当数据：先 JSON 校验，再逐字段清洗，
 * 不合格的题 / 规格直接丢掉，绝不把没核对过的内容交给小朋友。
 */
import { invokeStructured } from "@pi-agent/model-port";
import type { ImageMediaType, ModelInvocationPort, RoleModelConfig } from "@pi-agent/model-port";
import {
  VISUAL_VOCABULARY, cleanExplanation, cleanTags, cleanText, feedbackLabels, knowledgeForPrompt, sanitizeVisual, tagName,
} from "./wrong-book-core.js";
import type { ExplainFeedback, Explanation, QuizSlot, Visual } from "./wrong-book-core.js";

const BASE = { provider: "deepseek", model: "deepseek-flash", thinking: "high" as const, schemaVersion: "wrong-book@1" };

export const WRONG_BOOK_READ_CONFIG: RoleModelConfig = { ...BASE, role: "wrongBookRead", promptVersion: "wrong-book-read@1", timeoutMs: 360_000, maxAttempts: 2 };
export const WRONG_BOOK_QUIZ_CONFIG: RoleModelConfig = { ...BASE, role: "wrongBookQuiz", promptVersion: "wrong-book-quiz@1", timeoutMs: 360_000, maxAttempts: 2 };
export const WRONG_BOOK_VERIFY_CONFIG: RoleModelConfig = { ...BASE, role: "wrongBookVerify", promptVersion: "wrong-book-verify@1", timeoutMs: 240_000, maxAttempts: 2 };
export const WRONG_BOOK_EXPLAIN_CONFIG: RoleModelConfig = { ...BASE, role: "wrongBookExplain", promptVersion: "wrong-book-explain@1", timeoutMs: 240_000, maxAttempts: 2 };

/** 竖拍的作业照片比默认的 1600×900 高得多：只对识图放宽。 */
const PHOTO_LIMITS = { maxImages: 1, maxWidth: 3200, maxHeight: 3200, maxBytes: 12 * 1024 * 1024 };

const hasKey = (v: unknown, key: string): boolean => !!v && typeof v === "object" && Array.isArray((v as Record<string, unknown>)[key]);

/* ------------------------------ 看图识题 ------------------------------ */

export interface ReadItem {
  no: string;
  qType: string;
  stem: string;
  options: string[];
  childAnswer: string;
  answer: string;
  solution: string[];
  mark: "wrong" | "right" | "none" | "unclear";
  tags: string[];
  suggestTag: string;
  hasFigure: boolean;
  figureNote: string;
  confidence: number;
}

const READ_SYSTEM = [
  "你是上海小学数学老师的助手，要把一张三年级数学试卷 / 作业的照片整理成结构化的习题。教材是沪教版三年级第一学期。",
  "规则：",
  "1. 逐题转写。stem 是完整题干（数字、单位、符号一个都不能错）；分数写成 {分子/分母}，例如 {1/4}；填空处写 ____。",
  "2. 竖式、画图、统计图题：stem 只写题目要求；图里的信息写进 figureNote（一两句话），hasFigure 设为 true。",
  "3. 选择题把选项放进 options（每项以 A. B. C. 开头）；其余题型 options 为 []。qType 取 choice / fill / calc / word / judge / other 之一（calc 是纯计算题，word 是应用题）。",
  "4. childAnswer 是孩子手写的答案（多个空用 ； 隔开）；看不清或没写就是空字符串，不要猜。",
  "5. mark 是老师用红笔批改的结果：整题打 ✗、被扣分、有红笔订正为 \"wrong\"；打 ✓ 为 \"right\"；没有任何批改痕迹为 \"none\"；看不清为 \"unclear\"。",
  "6. answer 是这道题的标准答案，必须你自己独立算出来（不要照抄孩子的答案）；solution 是 2~5 条简短的解题步骤。",
  "7. tags 从下面的知识点 id 里挑 1~2 个最贴切的；实在没有合适的，tags 留空，并在 suggestTag 写一个不超过 8 个字的知识点名称。",
  "8. 不要抄录任何姓名、学校、班级、学号、家长签名等个人信息，这些文字一律忽略，也不要写进任何字段。",
  "9. 只整理真正的题目；标题、评语、总分、页眉页脚不是题目。没有题的照片，items 返回 []。",
  "10. 看不清的地方，confidence 给低分（0~1），不要编造。",
  "",
  "知识点（id=名称）：",
  knowledgeForPrompt(),
  "",
  "只输出一个 JSON，不要任何别的文字：",
  '{"items":[{"no":"3","qType":"calc","stem":"…","options":[],"childAnswer":"…","mark":"wrong","answer":"…","solution":["…"],"tags":["mul-2d1"],"suggestTag":"","hasFigure":false,"figureNote":"","confidence":0.9}]}',
].join("\n");

export function cleanReadItems(raw: unknown): ReadItem[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>)["items"];
  if (!Array.isArray(list)) return [];
  const out: ReadItem[] = [];
  for (const entry of list.slice(0, 60)) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const stem = cleanText(o["stem"], 400);
    if (stem.length < 2) continue;
    const mark = o["mark"] === "wrong" || o["mark"] === "right" || o["mark"] === "unclear" ? o["mark"] : "none";
    const options = Array.isArray(o["options"]) ? o["options"].map((x) => cleanText(x, 80)).filter(Boolean).slice(0, 6) : [];
    const solution = Array.isArray(o["solution"]) ? o["solution"].map((x) => cleanText(x, 120)).filter(Boolean).slice(0, 6) : [];
    const qType = typeof o["qType"] === "string" && ["choice", "fill", "calc", "word", "judge", "other"].includes(o["qType"]) ? (o["qType"] as string) : "other";
    const confidence = typeof o["confidence"] === "number" && o["confidence"] >= 0 && o["confidence"] <= 1 ? o["confidence"] : 0.5;
    out.push({
      no: cleanText(o["no"], 8), qType, stem, options, childAnswer: cleanText(o["childAnswer"], 60), answer: cleanText(o["answer"], 60),
      solution, mark, tags: cleanTags(o["tags"], 2), suggestTag: cleanText(o["suggestTag"], 8),
      hasFigure: o["hasFigure"] === true, figureNote: cleanText(o["figureNote"], 120), confidence,
    });
  }
  return out;
}

export async function readPaperPhoto(port: ModelInvocationPort, photo: { bytes: Buffer; mime: ImageMediaType }, hint: { source: "exam" | "homework" }): Promise<ReadItem[]> {
  const result = await invokeStructured<unknown>(
    port, WRONG_BOOK_READ_CONFIG,
    {
      system: READ_SYSTEM,
      prompt: `这是一张${hint.source === "exam" ? "学校考试卷" : "每天的家庭作业"}的照片。请整理成习题 JSON。`,
      images: [{ mediaType: photo.mime, bytes: new Uint8Array(photo.bytes) }],
      imageLimits: PHOTO_LIMITS,
    },
    (v) => (hasKey(v, "items") ? [] : ["缺少 items 数组"])
  );
  if (!result.ok) throw new Error(result.error);
  return cleanReadItems(result.value);
}

/* ------------------------------ 每周出题 ------------------------------ */

export interface RawQuestion {
  slotIndex: number;
  qType: "choice" | "fill" | "judge";
  stem: string;
  options: string[];
  answers: string[];
  labels: string[];
  unit: string;
  expr: string;
  solution: string[];
  visual?: Visual;
}

export interface SlotContext {
  slot: QuizSlot;
  /** 同知识点的原错题（题干 + 孩子的错误答案），出变式用 */
  wrongSamples: { stem: string; childAnswer: string }[];
}

const LEVEL_TEXT: Record<number, string> = {
  1: "基础：和课本例题同类；单步；没有连续进位 / 退位，不跨整点",
  2: "常规：和学校作业、单元测验同水平；有一次进位或退位、或跨整点、或需要两步",
  3: "拔高：至少两步、且运算不同（例如先除后乘）；或有中间带 0 的连续退位；或要先理解情境再列式。纯计算题最高只能出到第 2 档，拔高要靠情境和多一步思考，仍在三年级学过的范围内，不超纲",
};
const KIND_TEXT: Record<string, string> = {
  weak: "补弱（孩子在这个知识点上错过）：考查同一个知识点，但换数字、换情境，不能是原题；要能暴露她错在哪",
  review: "温习（最近刚掌握）：难度不超过常规，帮她巩固",
  stretch: "拔高（已经很熟练）：在这个知识点上适当加难一档",
};

const QUIZ_SYSTEM = [
  "你是上海小学三年级数学老师，给一位 8~9 岁的小朋友出一份每周小测验的题目。教材是沪教版三年级第一学期，题目必须在已学范围内，不超纲。",
  "按我给的每个「题位」各出一道题（slot 是题位序号）。",
  "要求：",
  "- 题型只用三种：choice 选择题（3~4 个选项，不要自己写 A. B.；answers 写正确选项的字母）；fill 填空题（stem 里用 ____ 标出每个空，answers 按空的顺序给出）；judge 判断题（stem 是一句陈述，answers 写「对」或「错」）。",
  "- 每道题只能有唯一确定的答案。填空题最多 2 个空；有 2 个空时必须给 labels（例如 [\"商\",\"余数\"]）。需要单位的写在 unit 里（例如 \"个\"），答案里只写数字。",
  "- 纯计算题请给出 expr：只含数字、+ - × ÷ 和括号的算式，用来让系统复算答案；有余数的除法 expr 写成 \"a÷b\"，answers 依次是商和余数。非计算题 expr 留空字符串。",
  "- 分数写成 {分子/分母}。应用题的情境要贴近 8 岁孩子的生活（分糖果、排队、买文具、校园活动），数字合理、不出现小数。",
  "- 需要图的题可以给 visual，只能是 rect（长方形）、clock（钟面）、fraction（分数）、barchart（条形统计图）四种之一；没有图就不要写 visual。题干本身必须把解题需要的数字写全，不能只靠图。",
  "- solution 是 2~5 条简短的解题步骤，最后一步写出答案（写数值，不要写「选 B」「答案是 A」这样的选项字母：选项顺序会被打乱）。步骤里每个「a × b = c」这样的算式都必须算对（系统会逐条复算）。",
  "- 有余数的除法，步骤要写成「几乘几不超过被除数、而且是最大的」（例如 5 × 4 = 20，5 × 5 = 25 太大了），不要写「最接近」。减法遇到十位是 0，要写清「先向百位借 1，十位变成 10，再借 1 给个位」。",
  "- 单位只写在 unit 字段里，题干里空的后面不要再写同样的单位。labels 要写完整（例如「每人分到的颗数」不能写成「每人分到的颗」），至少 2 个字，不要以「的」结尾。",
  "- 选择题的干扰项要对应孩子常见的错法（漏进位、乘加混用等）算出来的数，不要写 {4/1} 这种三年级没学过的写法；判断题用具体的说法，对和错都要出。",
  "- 同一份里，相同知识点的题情境、运算结构和数字大小都要明显不同，不要只换两个数字。题位里相同知识点出现多次时，一道用情境应用、一道用直接计算。",
  "- 不要和「已出过的题」重复。不要写 Markdown，不要写姓名。",
  "",
  "visual 词汇（t 为类型）：",
  VISUAL_VOCABULARY,
  "",
  "难度档次：",
  Object.values(LEVEL_TEXT).map((t, i) => `${i + 1} = ${t}`).join("\n"),
  "",
  "只输出一个 JSON，不要任何别的文字：",
  '{"questions":[{"slot":1,"qType":"fill","stem":"36 ÷ 5 = ____ …… ____","answers":["7","1"],"labels":["商","余数"],"unit":"","expr":"36÷5","solution":["…"]}]}',
].join("\n");

/** 去掉解析里「选 B」「答案：A」「（选C）」这类对选项字母的引用。 */
export function stripChoiceLetters(text: string): string {
  return text.replace(/[，,。；;]?\s*[（(]?\s*(?:正确)?(?:答案(?:是|为)?|选(?:择)?)\s*[:：]?\s*[A-D]\s*[）)]?\s*[。.]?/g, "").replace(/^[，,。；;\s]+/, "").trim();
}

/** 题干里最后一个空后面又写了同样的单位：去掉那一份（用字符串切片，不拼正则）。 */
function stripRepeatedUnit(stem: string, unit: string): string {
  const blanks = [...stem.matchAll(/_{2,}|＿{2,}/g)];
  const last = blanks[blanks.length - 1];
  if (!last || last.index === undefined) return stem;
  const end = last.index + last[0].length;
  const rest = stem.slice(end).replace(/^\s*/, "");
  return rest.startsWith(unit) ? stem.slice(0, end) + " " + rest.slice(unit.length) : stem;
}

const STEM_VISUALS: Visual["t"][] = ["rect", "clock", "fraction", "barchart"];

export function cleanQuestion(raw: unknown): RawQuestion | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const slotIndex = typeof o["slot"] === "number" ? o["slot"] : Number(o["slot"]);
  const qType = o["qType"];
  const stem = cleanText(o["stem"], 220);
  if (!Number.isInteger(slotIndex) || slotIndex < 1 || stem.length < 4) return null;
  if (qType !== "choice" && qType !== "fill" && qType !== "judge") return null;
  const answers = (Array.isArray(o["answers"]) ? o["answers"] : []).map((a) => cleanText(String(a ?? ""), 14)).filter(Boolean);
  if (answers.length === 0 || answers.length > 2) return null;
  let options = Array.isArray(o["options"]) ? o["options"].map((x) => cleanText(String(x ?? ""), 40).replace(/^[A-Da-d][.、．:：)）]\s*/, "")).filter(Boolean) : [];
  const labels = Array.isArray(o["labels"]) ? o["labels"].map((x) => cleanText(String(x ?? ""), 10)).filter(Boolean).slice(0, 2) : [];
  // 标签被截断（以「的」结尾）或太短，孩子看不懂空是什么：整题不要
  if (labels.some((l) => l.length < 2 || l.endsWith("的"))) return null;
  if (qType === "choice") {
    options = options.slice(0, 4);
    if (options.length < 3) return null;
    // 答案既可能是字母，也可能抄成了选项文字：统一成字母
    const raw0 = answers[0]!;
    const letter = /^[A-Da-d]$/.test(raw0) ? raw0.toUpperCase() : "ABCD"[options.findIndex((opt) => opt === raw0)] ?? "";
    if (!letter || "ABCD".indexOf(letter) >= options.length) return null;
    answers.splice(0, answers.length, letter);
  } else if (qType === "judge") {
    const j = answers[0] === "对" || /^(true|√|✓|正确)$/i.test(answers[0]!) ? "对" : answers[0] === "错" || /^(false|×|✗|错误)$/i.test(answers[0]!) ? "错" : "";
    if (!j) return null;
    options = [];
    answers.splice(0, answers.length, j);
  } else {
    options = [];
    const blanks = (stem.match(/_{2,}|＿{2,}|（\s*）/g) ?? []).length;
    if (blanks !== answers.length) return null; // 空的个数和答案个数对不上，题没法做
    if (answers.some((a) => !/^\d{1,6}$/.test(a))) return null; // 孩子用数字键盘作答，答案只能是整数
    if (answers.length === 2 && labels.length !== 2) return null;
  }
    // 单位只放 unit：题干里空后面又写了同样的单位，会显示成「米 米」，这里去掉题干里的那一份
  const unit = cleanText(o["unit"], 4);
  const cleanedStem = unit && qType === "fill" ? stripRepeatedUnit(stem, unit) : stem;
  // 选项位置之后会打乱：解析里不能留「选 B」「答案：A」这类字母，否则和实际选项对不上
  const solution = Array.isArray(o["solution"]) ? o["solution"].map((x) => stripChoiceLetters(cleanText(String(x ?? ""), 120))).filter(Boolean).slice(0, 6) : [];
  if (solution.length === 0) return null;
  // 题干里的图只用来「给出已知条件」：竖式、点阵、线段图这类会直接亮出解法，留给讲解用
  const drawn = sanitizeVisual(o["visual"]);
  const visual = drawn && STEM_VISUALS.includes(drawn.t) ? drawn : undefined;
  return {
    slotIndex, qType, stem: cleanedStem, options, answers, labels: qType === "fill" ? labels : [], unit,
    expr: cleanText(o["expr"], 80), solution, ...(visual ? { visual } : {}),
  };
}

export async function generateQuestions(port: ModelInvocationPort, slots: SlotContext[], offset: number, avoidStems: string[]): Promise<RawQuestion[]> {
  const lines = slots.map((s, i) => {
    const samples = s.wrongSamples.slice(0, 2).map((w) => `    原错题：${w.stem}${w.childAnswer ? `（她写的是：${w.childAnswer}）` : ""}`).join("\n");
    return [`题位 ${offset + i + 1}：知识点「${tagName(s.slot.tag)}」；${KIND_TEXT[s.slot.kind]}；难度档 ${s.slot.level}`, samples].filter(Boolean).join("\n");
  });
  const prompt = [
    "请按下面的题位出题：",
    ...lines,
    ...(avoidStems.length ? ["", "已出过的题（不要重复）：", ...avoidStems.slice(0, 12).map((s) => `- ${s}`)] : []),
  ].join("\n");
  const result = await invokeStructured<unknown>(port, WRONG_BOOK_QUIZ_CONFIG, { system: QUIZ_SYSTEM, prompt }, (v) => (hasKey(v, "questions") ? [] : ["缺少 questions 数组"]));
  if (!result.ok) throw new Error(result.error);
  const out: RawQuestion[] = [];
  for (const entry of (result.value as { questions: unknown[] }).questions.slice(0, slots.length + 2)) {
    const q = cleanQuestion(entry);
    if (q && q.slotIndex > offset && q.slotIndex <= offset + slots.length && !out.some((x) => x.slotIndex === q.slotIndex)) out.push(q);
  }
  return out;
}

/* ------------------------------ 独立重解（验题） ------------------------------ */

const VERIFY_SYSTEM = [
  "你是认真的小学数学老师。请独立解下面这道三年级数学题，只给最终答案，不要解释。",
  "选择题答案写选项字母（A/B/C/D）；判断题写「对」或「错」；填空题按空的顺序给出每个空的答案（只写数字，不带单位）。",
  '只输出一个 JSON：{"answers":["…"]}',
].join("\n");

export async function solveQuestion(port: ModelInvocationPort, q: Pick<RawQuestion, "qType" | "stem" | "options" | "labels" | "unit" | "visual">): Promise<string[] | null> {
  const prompt = [
    `题型：${q.qType === "choice" ? "选择题" : q.qType === "judge" ? "判断题" : "填空题"}`,
    `题目：${q.stem}`,
    ...(q.options.length ? ["选项：", ...q.options.map((o, i) => `${"ABCD"[i]}. ${o}`)] : []),
    ...(q.labels.length ? [`空依次是：${q.labels.join("、")}`] : []),
    ...(q.unit ? [`单位：${q.unit}`] : []),
    ...(q.visual ? [`配图（由程序按这份数据画出）：${JSON.stringify(q.visual)}`] : []),
  ].join("\n");
  const result = await invokeStructured<{ answers?: unknown }>(port, WRONG_BOOK_VERIFY_CONFIG, { system: VERIFY_SYSTEM, prompt }, (v) => (hasKey(v, "answers") ? [] : ["缺少 answers 数组"]));
  if (!result.ok || !result.value) return null;
  const answers = (result.value.answers as unknown[]).map((a) => String(a ?? "").trim()).filter(Boolean);
  return answers.length > 0 ? answers : null;
}

/* ------------------------------ 给小朋友的讲解 ------------------------------ */

const EXPLAIN_SYSTEM = [
  "你是一位特别会讲题的小学数学老师，现在给一位 8~9 岁的三年级小朋友讲一道题。她的抽象思维还在发展，太抽象的话听不进去。",
  "讲解原则：",
  "- 先用生活里能看见、摸得着的东西来讲（分糖果、排队、搭积木、数小圆点、拿钱买东西），再回到算式；不用「因此」「综上」「设」这类大人话。",
  "- 一步只讲一件事，一句话不超过 36 个字，口气像在身边轻轻聊，可以用「我们来数一数」「你看」这样的话；最多 8 步。",
  "- 能用图讲的一步就配 visual：平均分用 groups，乘法用 array，笔算用 vertical（页面会自己一步步演示竖式，你只要给出算式），讲「倍」「多几少几」用 bar，时间用 clock，周长用 rect，分数用 fraction，条形统计图用 barchart，数轴跳步用 numberline。不要硬配图。",
  "- 最后一步要得出正确答案（我会告诉你标准答案，你必须以它为准）。每一步只讲一件事：一个动作或一个算式，不超过两个短句；不用「落下来」「满十」这类大人话，要说「10 个一换成 1 个十」「借 1 当 10」。",
  "- 配图里的数字必须就是这道题里的数字，不能凭空编；图标（icon）要和题里的东西对得上（鸡蛋 🥚、糖 🍬、纸 📄、邮票 ✉️、笔 🖍️、气球 🎈、书 📚），找不到对得上的就用 ●，不要默认画苹果。",
  "- 除法讲解里每个商都先说出口诀（例如「八九七十二」）再写算式；有余数时要用一句话说明「剩下的几个不够再分一组，叫余数，余数要比除数小」；讲「几倍」时要有一步「有几个 4，就是几倍」。",
  "- tip 是一句好记的小口诀或提醒（不超过 30 个字）。",
  "- 如果给了孩子写的答案且和标准答案不同：先自己试一试，常见的错法（漏进位、把乘当成加、余数写得比除数大……）能不能算出她写的那个答案。算得出来，whyWrong 才用一两句温和的话说出具体是哪一步；算不出来，就只写一句中性的话（例如「这类题容易在某一步走偏，我们一步一步再看一遍」）。绝不说「忘了」「猜」「粗心」「笨」；孩子答对了就不写 whyWrong。",
  "",
  "visual 词汇（t 为类型）：",
  VISUAL_VOCABULARY,
  "",
  "只输出一个 JSON，不要任何别的文字：",
  '{"title":"…","steps":[{"say":"…","visual":{…}}],"tip":"…","whyWrong":"…"}',
].join("\n");

/** 按知识点给讲解的画法建议：哪些图讲得清、哪些图会把孩子讲糊涂。 */
const TAG_HINTS: Record<string, string> = {
  "add-3d": "用 vertical 竖式讲，每步只讲一位，进位说成「10 个一换成 1 个十」；不要用 groups、numberline。",
  "sub-3d": "用 vertical 竖式讲，每步只讲一位，退位说成「借 1 当 10」；十位是 0 时先向再前一位借；不要用 groups、numberline。",
  "mul-table": "用 array 点阵讲「几个几」，再写算式；不要用竖式。",
  "mul-2d1": "先用拆数讲道理（58 拆成 50 和 8，分别乘再合起来），再用 vertical 竖式演示。",
  "mul-3d1": "先拆成百、十、个分别乘再合起来，再用 vertical 竖式演示。",
  "div-table": "用 groups 讲平均分，每个商先说口诀。",
  "div-rem": "用 groups 把物品圈成一组一组，剩下的单独标出来；写完整算式（例如 30 ÷ 4 = 7（组）……2（个））并解释余数。",
  "div-rem-rule": "用 groups 讲：剩下的不够再分一组，才叫余数，所以余数一定比除数小。",
  "word-times": "用 bar 线段图：先画一份，再画几份一样长的；有几份就是几倍。",
  "word-div": "用 groups 讲平均分。",
  "time-elapsed": "用 clock 钟面，从开始走到结束。",
  "time-hms": "用 clock 钟面。",
  "time-24h": "用 clock 钟面，讲下午几点对应 24 时计时法是加 12。",
  "geo-perimeter": "用 rect，沿着四条边走一圈再把四条边加起来。",
  "geo-rect": "用 rect。",
  "frac-intro": "用 fraction：平均分成几份、涂了几份；分数写成 {1/4}。",
  "frac-compare": "用 fraction：把两个分数画成同样大的图比一比。",
  "stat-bar": "用 barchart 一格一格读数。",
};

export interface ExplainInput {
  stem: string;
  options?: string[];
  answer: string;
  solution: string[];
  childAnswer?: string;
  tags: string[];
  visual?: Visual;
  /** 按孩子反馈重讲：上一版讲解（要求换讲法，别重复） */
  previous?: Explanation;
  /** 按孩子反馈重讲：孩子说哪里没听懂 */
  feedback?: ExplainFeedback;
}

/** 重讲时给模型的要求：换例子、拆更小、换图，别把上一版再说一遍。 */
function retryPrompt(input: ExplainInput): string[] {
  if (!input.previous) return [];
  const labels = input.feedback ? feedbackLabels(input.feedback) : [];
  const text = input.feedback?.text ?? "";
  return [
    "",
    "上一版讲解孩子没听懂，这次要换一种讲法（不是把上一版再说一遍）：",
    ...(labels.length ? [`孩子说：${labels.join("、")}`] : []),
    ...(text ? [`孩子还说：${text}`] : []),
    "上一版是这样讲的（不要重复其中的句子、例子和配图）：",
    ...input.previous.steps.map((s, i) => `${i + 1}. ${s.say}`),
    "换讲法要求：换一个孩子更熟悉的生活情境（铅笔、课本、零花钱、排队、分水果）；每一步再短一点，先让孩子看懂「在做什么」再写算式；上一版用过图就换一种图或先不用图；标题也换个说法。",
  ];
}

export async function explainQuestion(port: ModelInvocationPort, input: ExplainInput): Promise<Explanation | null> {
  const prompt = [
    `知识点：${input.tags.map(tagName).join("、") || "三年级数学"}`,
    ...input.tags.filter((t) => TAG_HINTS[t]).map((t) => `这个知识点的讲法建议：${TAG_HINTS[t]}`),
    `题目：${input.stem}`,
    ...(input.options?.length ? ["选项：", ...input.options.map((o, i) => (/^[A-D][.、]/.test(o) ? o : `${"ABCD"[i]}. ${o}`))] : []),
    ...(input.visual ? [`题目配图数据：${JSON.stringify(input.visual)}`] : []),
    `标准答案：${input.answer}`,
    ...(input.solution.length ? [`参考解法：${input.solution.join(" → ")}`] : []),
    ...(input.childAnswer ? [`孩子写的答案：${input.childAnswer}`] : []),
    ...retryPrompt(input),
  ].join("\n");
  const result = await invokeStructured<unknown>(port, WRONG_BOOK_EXPLAIN_CONFIG, { system: EXPLAIN_SYSTEM, prompt }, (v) => (hasKey(v, "steps") ? [] : ["缺少 steps 数组"]));
  if (!result.ok) return null;
  return cleanExplanation(result.value) ?? null;
}
