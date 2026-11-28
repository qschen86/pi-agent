/** Codex 的两类"问人"请求 → 平台统一的 QuestionItem，以及把答案换回 Codex 要的格式。 */
import { questionItem } from "./questions.js";
import type { QuestionAnswers, QuestionItem } from "./types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

// 表单式 elicitation 的 schema → 题库是通用逻辑（MCP 与 ACP 同形），实现在 questions.ts；这里保留原导出位置。
export { elicitationForm, type ElicitationForm } from "./questions.js";

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
