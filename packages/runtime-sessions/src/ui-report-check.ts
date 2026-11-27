import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProjectedEvent } from "./types.js";

/**
 * 平台技能「界面打磨」的轻量交付检查（docs/requirements/ui-design-refinement）。
 *
 * 设计原则：
 *   1. 允许纯对话澄清与定调：读了 SKILL.md 或用了 /界面打磨，如果本轮只是和用户聊需求、给选择题或讨论方向
 *      （未跑交付脚本，回复里也没贴 preview.html / report.html），直接放行，不再强迫第一轮必须交 HTML。
 *   2. 只要本轮跑了交付脚本（preview.mjs build / generate-report.mjs）或回复里引用了 preview.html / report.html，
 *      就校验文件真实存在、带有技能脚本写入的 meta 签名，且同目录 JSON 哈希与关键字段一致（防止手写假报告或篡改）。
 *   3. 取消强制照搬死板 chatSummary，允许自然中文沟通；回复里写「本次未使用界面打磨」即跳过检查。
 */
export const UI_SKILL_ID = "ui-design-refinement";
export const UI_REPORT_OPT_OUT = "本次未使用界面打磨";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const PREVIEW_META_RE = /<meta name="pi-ui-preview" content="(ui-\d{8}-\d{4}-[a-z0-9]{4}):([0-9a-f]{64})">/;
const REPORT_META_RE = /<meta name="pi-ui-report" content="(ui-\d{8}-\d{4}-[a-z0-9]{4}):([0-9a-f]{64})">/;
const hash = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");

/**
 * 只有读 / 跑**已部署**的技能才算「使用」：路径在部署槽位（~/.pi-agent-gui/slots/<槽>/skills/platform/…），
 * 或在平台实例自己的技能根目录下（skillRoot）。开发这个技能本身（worktree 里的相对路径 / 绝对路径）不算。
 */
const DEPLOYED_SLOT = new RegExp(`/slots/[^/\\s"']+/skills/platform/${UI_SKILL_ID}/`);
const isDeployedSkillPath = (text: string, skillRoot?: string): boolean =>
  DEPLOYED_SLOT.test(text) || (!!skillRoot && !skillRoot.includes(".pi-worktrees/") && text.includes(`${skillRoot}/${UI_SKILL_ID}/`));

export function usedUiSkill(events: readonly ProjectedEvent[], since: number, turnNo: number, skillRoot?: string): boolean {
  return events.some((e) => {
    if (e.turnNo === undefined || e.turnNo < since || e.turnNo > turnNo) return false;
    if (e.kind === "notice" && e.key.startsWith("platform-skill:") && e.text?.includes("界面打磨")) return true;
    const input = e.kind === "tool" ? e.tool?.input : undefined;
    if (!input) return false;
    return (input.includes(`${UI_SKILL_ID}/SKILL.md`) || input.includes(`${UI_SKILL_ID}/scripts/`)) && isDeployedSkillPath(input, skillRoot);
  });
}

function ranDeliveryKind(input: UiReportCheckInput): "preview" | "report" | undefined {
  let kind: "preview" | "report" | undefined;
  for (const event of input.events) {
    if (event.turnNo === undefined || event.turnNo < input.since || event.turnNo > input.turnNo || event.kind !== "tool") continue;
    const command = event.tool?.input ?? "";
    if (!isDeployedSkillPath(command, input.skillRoot)) continue;
    if (command.includes("/scripts/generate-report.mjs")) kind = "report";
    else if (command.includes("/scripts/preview.mjs") && /\bbuild\b/.test(command)) kind = "preview";
  }
  return kind;
}

export interface UiReportCheckInput {
  events: readonly ProjectedEvent[];
  since: number;
  turnNo: number;
  assistantText: string;
  workspace: string;
  /** 平台实例的技能根目录（manager 的 platformSkillsRoot） */
  skillRoot?: string;
}

/**
 * undefined = 本轮不需要检查（没用技能、声明未使用，或属于纯对话需求澄清轮次）；
 * [] = 交付物校验通过；
 * string[] = 交付物问题清单。
 */
export function uiReportProblems(input: UiReportCheckInput): string[] | undefined {
  if (!usedUiSkill(input.events, input.since, input.turnNo, input.skillRoot)) return undefined;
  if (input.assistantText.includes(UI_REPORT_OPT_OUT)) return undefined;

  const previewRefs = [...new Set([...input.assistantText.matchAll(/[^\s()<>"'`\[\]]*preview\.html/g)].map((m) => m[0]))];
  const reportRefs = [...new Set([...input.assistantText.matchAll(/[^\s()<>"'`\[\]]*report\.html/g)].map((m) => m[0]))];
  const ran = ranDeliveryKind(input);

  // 纯对话澄清 / 对齐需求 / 方案讨论轮次：未运行交付脚本且未引用预览/报告文件，直接放行。
  if (!ran && !previewRefs.length && !reportRefs.length) return undefined;

  const problems: string[] = [];

  if (ran === "preview" && !previewRefs.length) {
    problems.push("本轮已运行 preview.mjs build 生成交互原型，但最终回复里没有附上 preview.html 链接。");
  }
  if (ran === "report" && !reportRefs.length) {
    problems.push("本轮已运行 generate-report.mjs 生成报告，但最终回复里没有附上 report.html 链接。");
  }

  if (previewRefs.length) {
    const reasons: string[] = [];
    let ok = false;
    for (const ref of previewRefs) {
      const file = isAbsolute(ref) ? ref : resolve(input.workspace, ref);
      const why = previewProblem(file);
      if (!why) { ok = true; break; }
      reasons.push(`${ref}：${why}`);
    }
    if (!ok) problems.push(`引用的交互原型不是技能脚本生成并校验过的：${reasons.join("；")}`);
  }

  if (reportRefs.length) {
    const reasons: string[] = [];
    let ok = false;
    for (const ref of reportRefs) {
      const file = isAbsolute(ref) ? ref : resolve(input.workspace, ref);
      const why = reportProblem(file);
      if (!why) { ok = true; break; }
      reasons.push(`${ref}：${why}`);
    }
    if (!ok) problems.push(`引用的报告不是技能脚本生成并校验过的：${reasons.join("；")}`);
  }

  return problems;
}

function previewProblem(file: string): string | undefined {
  try {
    if (!existsSync(file)) return "文件不存在";
    if (statSync(file).size > MAX_ARTIFACT_BYTES) return "文件过大";
    const html = readFileSync(file, "utf8");
    const meta = PREVIEW_META_RE.exec(html);
    if (!meta) return "缺少原型交付标记（疑似手写，请用 preview.mjs build 生成）";
    const jsonFile = join(dirname(file), "preview.json");
    if (!existsSync(jsonFile)) return "同目录缺少 preview.json";
    const raw = readFileSync(jsonFile, "utf8");
    if (hash(raw) !== meta[2]) return "preview.json 与原型标记的哈希不一致（被改过）";
    const data = JSON.parse(raw);
    if (data.schemaVersion !== 2 || data.mode !== "preview" || data.runId !== meta[1]) return "preview.json 的阶段或 runId 不一致";
    if (!Array.isArray(data.directions) || !data.directions.length) return "preview.json 里没有方案方向";
    return undefined;
  } catch {
    return "读取原型交付记录失败";
  }
}

function reportProblem(file: string): string | undefined {
  try {
    if (!existsSync(file)) return "文件不存在";
    if (statSync(file).size > MAX_ARTIFACT_BYTES) return "文件过大";
    const html = readFileSync(file, "utf8");
    const meta = REPORT_META_RE.exec(html);
    if (!meta) return "不含技能脚本写入的报告标记（疑似手写）";
    const jsonFile = join(dirname(file), "report.json");
    if (!existsSync(jsonFile)) return "同目录缺少 report.json";
    const raw = readFileSync(jsonFile, "utf8");
    if (hash(raw) !== meta[2]) return "report.json 与报告标记的哈希不一致（被改过）";
    const json = JSON.parse(raw);
    if (json.runId !== meta[1]) return "report.json 的 runId 与报告标记不一致";
    if (!["review", "deliver"].includes(json.mode)) return "报告 mode 只能是 review（只读体检）或 deliver（落地验收）";
    return undefined;
  } catch {
    return "读取报告失败";
  }
}

/** 反馈给模型的「怎么补」。 */
export const UI_REPORT_FIX = [
  "1. 交付交互原型时，运行 `preview.mjs build --run <runId> --manifest <manifest.json>` 并在回复中链接生成的 `preview.html`（不要手写或修改打包后的 HTML/JSON）。",
  "2. 交付 UI 体检或代码落地验收报告时，运行 `generate-report.mjs --run <runId>` 并在回复中链接生成的 `report.html`（体检为只读模式 `review`，落地验收为 `deliver`）。",
  "3. 回复请用自然中文向用户说明重点，无需照抄死板模板；若本轮仅需与用户澄清需求，不要贴无效的 HTML 路径。",
  `4. 如果这次任务不属于界面设计或打磨，请在回复里写明「${UI_REPORT_OPT_OUT}」并说明原因即可。`
].join("\n");
