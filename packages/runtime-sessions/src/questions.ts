/**
 * 人类选择面板的共用逻辑：把 runtime 的各种"提问"统一成 QuestionItem，
 * 服务端校验答案（只能选给出的选项，或在允许时自填），再按各 runtime 的格式回传。
 */
import type { QuestionAnswers, QuestionItem, QuestionOption } from "./types.js";

export const QUESTION_LIMITS = { questions: 12, options: 40, label: 200, description: 600, question: 1_000, answer: 4_000 } as const;
/** 提问等人类回答的时间比一般审批长：这是在等人做决定，不是确认一条命令 */
export const QUESTION_TTL_FLOOR_MS = 60 * 60_000;

const clip = (v: unknown, n: number): string => (typeof v === "string" ? v : "").replace(/\u0000/g, "").trim().slice(0, n);

export function cleanOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: QuestionOption[] = [];
  for (const o of raw.slice(0, QUESTION_LIMITS.options)) {
    const label = clip(typeof o === "string" ? o : (o as { label?: unknown } | null)?.label, QUESTION_LIMITS.label);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const description = clip(typeof o === "object" && o ? (o as { description?: unknown }).description : "", QUESTION_LIMITS.description);
    out.push({ label, ...(description ? { description } : {}) });
  }
  return out;
}

/** 一道题的规范化：没有题干或 id 的丢弃（调用方据此判断整个请求能不能展示） */
export function questionItem(q: { id: string; question: unknown; header?: unknown; options?: unknown; multiSelect?: boolean; allowOther?: boolean; secret?: boolean; optional?: boolean; placeholder?: unknown; prefill?: unknown; multiline?: boolean }): QuestionItem | undefined {
  const question = clip(q.question, QUESTION_LIMITS.question);
  const id = clip(q.id, 200);
  if (!question || !id) return undefined;
  const options = cleanOptions(q.options);
  const header = clip(q.header, 80), placeholder = clip(q.placeholder, 200), prefill = clip(q.prefill, QUESTION_LIMITS.answer);
  return {
    id, ...(header ? { header } : {}), question, options, multiSelect: !!q.multiSelect && options.length > 0,
    allowOther: options.length === 0 ? true : !!q.allowOther,
    ...(q.secret ? { secret: true } : {}), ...(q.optional ? { optional: true } : {}), ...(placeholder ? { placeholder } : {}), ...(prefill ? { prefill } : {}), ...(q.multiline ? { multiline: true } : {})
  };
}

/** 展示用的纯文本（审批 action、通知、旧界面兜底） */
export function questionsText(questions: QuestionItem[]): string {
  return questions.map((q, i) => [`${i + 1}. ${q.header ? `[${q.header}] ` : ""}${q.question}${q.multiSelect ? "（可多选）" : ""}`,
    ...q.options.map((o) => `   - ${o.label}${o.description ? `：${o.description}` : ""}`)].join("\n")).join("\n");
}

export type AnswerCheck = { ok: true; answers: QuestionAnswers } | { ok: false; error: string };

/** 校验人类的答案：每题都要答；只能从选项里选，或在 allowOther 时自填；单选只能一个 */
export function validateAnswers(questions: QuestionItem[], raw: unknown): AnswerCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "请先回答问题" };
  const input = raw as Record<string, unknown>;
  const answers: QuestionAnswers = {};
  for (const q of questions) {
    const v = input[q.id];
    const list = (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map((x) => (typeof x === "string" ? x.replace(/\u0000/g, "") : ""));
    const picked = list.map((x) => (q.options.some((o) => o.label === x) ? x : x.trim())).filter((x) => x.length > 0);
    if (!picked.length && q.optional) continue;
    if (!picked.length) return { ok: false, error: `还没有回答：${q.header || q.question}` };
    if (!q.multiSelect && picked.length > 1) return { ok: false, error: `只能选一项：${q.header || q.question}` };
    const seen = new Set<string>();
    for (const a of picked) {
      if (a.length > QUESTION_LIMITS.answer) return { ok: false, error: `回答太长：${q.header || q.question}` };
      if (!q.options.some((o) => o.label === a) && !q.allowOther) return { ok: false, error: `「${a.slice(0, 40)}」不是可选项` };
      seen.add(a);
    }
    answers[q.id] = [...seen];
  }
  for (const k of Object.keys(input)) if (!questions.some((q) => q.id === k)) return { ok: false, error: "答案包含不存在的问题" };
  return { ok: true, answers };
}

/** 写进时间线的摘要；secret 题只写「已提交」 */
export function answersSummary(questions: QuestionItem[], answers: QuestionAnswers): string {
  return questions.map((q) => `${q.header || q.question.slice(0, 40)}：${q.secret ? "（已提交，不记录）" : (answers[q.id] ?? []).join("、")}`).join("；");
}
