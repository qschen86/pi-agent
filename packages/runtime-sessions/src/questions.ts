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

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
/** agy 给每题附带的自由填写字段标题（Other） */
const OTHER_TITLE = /^(?:other|其他|其它)$/i;

export interface ElicitationForm { questions: QuestionItem[]; content(answers: QuestionAnswers): Record<string, unknown> | undefined }

/**
 * 表单式 elicitation 的 restricted JSON Schema → 平台题库：单选/多选枚举、布尔、字符串、数字。
 * Codex 的 MCP elicitation 与 Antigravity 的 ACP elicitation/create 共用这套形态。
 * 其他形态（嵌套、未知类型、URL 与设备验证）返回 undefined，调用方拒绝。
 */
export function elicitationForm(schema: unknown): ElicitationForm | undefined {
  if (!isObj(schema) || schema["type"] !== "object" || !isObj(schema["properties"])) return undefined;
  const props = Object.entries(schema["properties"]);
  if (!props.length || props.length > 12) return undefined;
  const defs = new Map(props);
  const required = Array.isArray(schema["required"]) ? schema["required"].map(String) : [];
  /** agy 的 ask_question 给每道选择题附带 <key>_other 自填字段：并进主问题的「其他」，答案回到这个键 */
  const otherKeyOf = (key: string): string | undefined => {
    const otherKey = `${key}_other`;
    const other = defs.get(otherKey);
    return isObj(other) && other["type"] === "string" && OTHER_TITLE.test(String(other["title"] ?? "").trim()) ? otherKey : undefined;
  };
  const pairedOther = (key: string): boolean => {
    if (!key.endsWith("_other")) return false;
    const base = key.slice(0, -"_other".length), def = defs.get(key);
    return !!defs.get(base) && isObj(def) && def["type"] === "string" && OTHER_TITLE.test(String(def["title"] ?? "").trim());
  };
  const questions: QuestionItem[] = [];
  const decode = new Map<string, (answers: string[]) => Record<string, unknown> | undefined>();
  for (const [key, def] of props) {
    if (pairedOther(key)) continue;
    if (!isObj(def)) return undefined;
    const otherKey = otherKeyOf(key);
    const title = typeof def["title"] === "string" && def["title"].trim() ? def["title"] : key;
    const description = typeof def["description"] === "string" ? def["description"].trim() : "";
    const question = description && description !== title ? `${title}：${description}` : title;
    const base = { id: key, header: title.slice(0, 40), question, optional: !required.includes(key) };
    const titled = (list: unknown): Array<{ value: string; label: string; description?: string }> | undefined => {
      if (!Array.isArray(list)) return undefined;
      const out = list.map((o) => (isObj(o) && typeof o["const"] === "string"
        ? { value: o["const"], label: typeof o["title"] === "string" && o["title"] ? o["title"] : o["const"], ...(typeof o["description"] === "string" && o["description"].trim() ? { description: o["description"].trim() } : {}) }
        : undefined));
      return out.every(Boolean) ? (out as Array<{ value: string; label: string; description?: string }>) : undefined;
    };
    const choose = (opts: Array<{ value: string; label: string; description?: string }>, multi: boolean): boolean => {
      // 标签相同会让答案无法还原：当作不支持
      if (!opts.length || new Set(opts.map((o) => o.label)).size !== opts.length) return false;
      const item = questionItem({ ...base, options: opts.map((o) => ({ label: o.label, description: o.description ?? (o.label === o.value ? "" : o.value) })), multiSelect: multi, allowOther: !!otherKey });
      if (!item) return false;
      questions.push(item);
      const back = new Map(opts.map((o) => [o.label, o.value]));
      decode.set(key, (a) => {
        const out: Record<string, unknown> = {};
        const picked = a.filter((x) => back.has(x)), typed = a.filter((x) => !back.has(x));
        if (picked.length) out[key] = multi ? picked.map((x) => back.get(x)!) : back.get(picked[0]!)!;
        if (typed.length) {
          if (!otherKey) return undefined;
          out[otherKey] = typed.join("，");
        }
        return out;
      });
      return true;
    };
    const type = def["type"];
    if (type === "string" && Array.isArray(def["oneOf"])) {
      const o = titled(def["oneOf"]); if (!o || !choose(o, false)) return undefined;
    } else if (type === "string" && Array.isArray(def["enum"])) {
      const names = Array.isArray(def["enumNames"]) ? def["enumNames"] : [];
      const vals = def["enum"].filter((x): x is string => typeof x === "string");
      if (vals.length !== def["enum"].length) return undefined;
      if (!choose(vals.map((v, i) => ({ value: v, label: typeof names[i] === "string" && names[i] ? (names[i] as string) : v })), false)) return undefined;
    } else if (type === "array" && isObj(def["items"])) {
      const items = def["items"];
      const o = Array.isArray(items["anyOf"]) ? titled(items["anyOf"]) : Array.isArray(items["enum"]) && items["enum"].every((x) => typeof x === "string") ? (items["enum"] as string[]).map((v) => ({ value: v, label: v })) : undefined;
      if (!o || !choose(o, true)) return undefined;
    } else if (type === "boolean") {
      const item = questionItem({ ...base, options: [{ label: "是" }, { label: "否" }] });
      if (!item) return undefined;
      questions.push(item); decode.set(key, (a) => ({ [key]: a[0] === "是" }));
    } else if (type === "string") {
      const item = questionItem({ ...base, options: [], placeholder: typeof def["format"] === "string" ? `格式：${def["format"]}` : "", prefill: typeof def["default"] === "string" ? def["default"] : "" });
      if (!item) return undefined;
      questions.push(item); decode.set(key, (a) => ({ [key]: a[0] }));
    } else if (type === "number" || type === "integer") {
      const item = questionItem({ ...base, options: [], placeholder: type === "integer" ? "整数" : "数字" });
      if (!item) return undefined;
      questions.push(item);
      decode.set(key, (a) => {
        const n = Number(a[0]);
        return Number.isFinite(n) && (type !== "integer" || Number.isInteger(n)) ? { [key]: n } : undefined;
      });
    } else return undefined;
  }
  return {
    questions,
    content(answers) {
      const content: Record<string, unknown> = {};
      for (const q of questions) {
        const given = answers[q.id];
        if (!given?.length && q.optional) continue;
        const part = decode.get(q.id)!(given ?? []);
        if (!part) return undefined; // 例如数字题填了非数字
        Object.assign(content, part);
      }
      return content;
    }
  };
}
