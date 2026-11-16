/** Codex 的两类"问人"请求 → 平台统一的 QuestionItem，以及把答案换回 Codex 要的格式。 */
import { questionItem } from "./questions.js";
import type { QuestionAnswers, QuestionItem } from "./types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** item/tool/requestUserInput（Codex 计划模式的 request_user_input 工具） */
export function userInputQuestions(raw: unknown): QuestionItem[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out: QuestionItem[] = [], ids = new Set<string>();
  for (const q of raw) {
    if (!isObj(q)) return undefined;
    const item = questionItem({
      id: String(q["id"] ?? ""), question: q["question"], header: q["header"], options: q["options"],
      allowOther: q["isOther"] === true, secret: q["isSecret"] === true
    });
    if (!item || ids.has(item.id)) return undefined;
    ids.add(item.id); out.push(item);
  }
  return out;
}

export function userInputResponse(questions: QuestionItem[], answers: QuestionAnswers): { answers: Record<string, { answers: string[] }> } {
  return { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: answers[q.id] ?? [] }])) };
}

export interface ElicitationForm { questions: QuestionItem[]; content(answers: QuestionAnswers): Record<string, unknown> | undefined }

/**
 * MCP elicitation 表单（mode=form）：单选/多选枚举、布尔、字符串、数字。其他形态（嵌套、未知类型、URL 与设备验证）返回 undefined，调用方拒绝。
 * 必填字段缺答案时由平台校验保证每题都有答案，所以这里不再有"缺字段"。
 */
export function elicitationForm(schema: unknown): ElicitationForm | undefined {
  if (!isObj(schema) || schema["type"] !== "object" || !isObj(schema["properties"])) return undefined;
  const props = Object.entries(schema["properties"]);
  if (!props.length || props.length > 12) return undefined;
  const required = Array.isArray(schema["required"]) ? schema["required"].map(String) : [];
  const questions: QuestionItem[] = [];
  const decode = new Map<string, (answers: string[]) => unknown>();
  for (const [key, def] of props) {
    if (!isObj(def)) return undefined;
    const title = typeof def["title"] === "string" && def["title"].trim() ? def["title"] : key;
    const description = typeof def["description"] === "string" ? def["description"].trim() : "";
    const question = description && description !== title ? `${title}：${description}` : title;
    const base = { id: key, header: title.slice(0, 40), question, optional: !required.includes(key) };
    const titled = (list: unknown): Array<{ value: string; label: string }> | undefined => {
      if (!Array.isArray(list)) return undefined;
      const out = list.map((o) => (isObj(o) && typeof o["const"] === "string" ? { value: o["const"], label: typeof o["title"] === "string" && o["title"] ? o["title"] : o["const"] } : undefined));
      return out.every(Boolean) ? (out as Array<{ value: string; label: string }>) : undefined;
    };
    const choose = (opts: Array<{ value: string; label: string }>, multi: boolean): boolean => {
      // 标签相同会让答案无法还原：当作不支持
      if (!opts.length || new Set(opts.map((o) => o.label)).size !== opts.length) return false;
      const item = questionItem({ ...base, options: opts.map((o) => ({ label: o.label, description: o.label === o.value ? "" : o.value })), multiSelect: multi });
      if (!item) return false;
      questions.push(item);
      const back = new Map(opts.map((o) => [o.label, o.value]));
      decode.set(key, (a) => (multi ? a.map((x) => back.get(x) ?? x) : back.get(a[0]!) ?? a[0]));
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
      questions.push(item); decode.set(key, (a) => a[0] === "是");
    } else if (type === "string") {
      const item = questionItem({ ...base, options: [], placeholder: typeof def["format"] === "string" ? `格式：${def["format"]}` : "", prefill: typeof def["default"] === "string" ? def["default"] : "" });
      if (!item) return undefined;
      questions.push(item); decode.set(key, (a) => a[0]);
    } else if (type === "number" || type === "integer") {
      const item = questionItem({ ...base, options: [], placeholder: type === "integer" ? "整数" : "数字" });
      if (!item) return undefined;
      questions.push(item);
      decode.set(key, (a) => { const n = Number(a[0]); return Number.isFinite(n) && (type !== "integer" || Number.isInteger(n)) ? n : undefined; });
    } else return undefined;
  }
  return {
    questions,
    content(answers) {
      const content: Record<string, unknown> = {};
      for (const q of questions) {
        const given = answers[q.id];
        if (!given?.length && q.optional) continue;
        const v = decode.get(q.id)!(given ?? []);
        if (v === undefined) return undefined; // 例如数字题填了非数字
        content[q.id] = v;
      }
      return content;
    }
  };
}
