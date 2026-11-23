import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, dirname, join } from "node:path";
import type { ProjectedEvent } from "./types.js";

/**
 * 平台技能「界面打磨」的交付检查（docs/requirements/ui-design-refinement）。
 *
 * 技能说明只是给模型看的提示词，模型可以读了不照做（线上第一次真实使用就是这样：读了 SKILL.md，却没跑任何技能脚本、没有出报告）。
 * 所以这里做一条和「截图来源校验」同类的回合结束检查：本轮用了这个技能，最终回复里就必须有一份**由技能脚本生成并校验过**的对应阶段产物（review 的 report.html / refine 的 handbook.html）。
 * 不通过就把「缺什么、怎么补」自动反馈给同一会话（最多 MAX_ENFORCEMENT_RETRIES 次），仍不通过就在时间线里留一条通知。
 *
 * 判定只用确定性事实：
 *   - 「用了技能」：用户用 /界面打磨 调用过，或模型读了已部署的 SKILL.md，或跑了它的脚本（开发用的 worktree 副本不算）；
 *   - 「有报告」：回复里引用的 report.html 存在，带 <meta name="pi-ui-report" content="runId:sha256">，且同目录 report.json 的哈希与之相符、mode 为 review；Refine 按手册交付记录核对 HTML、来源与版本。
 * 模型确实不该用这个技能时，回复里写「本次未使用界面打磨」即放行。
 */
export const UI_SKILL_ID = "ui-design-refinement";
export const UI_REPORT_OPT_OUT = "本次未使用界面打磨";
const META_RE = /<meta name="pi-ui-report" content="(ui-\d{8}-\d{4}-[a-z0-9]{4}):([0-9a-f]{64})">/;
const MAX_REPORT_BYTES = 12 * 1024 * 1024;
const HANDBOOK_META_RE = /<meta name="pi-ui-handbook" content="(ui-\d{8}-\d{4}-[a-z0-9]{4}):([0-9a-f]{64})">/;
const hash = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");

/** 使用确定的交付脚本识别阶段，不根据用户正文里的相似词猜测。 */
function deliveryMode(input: UiReportCheckInput): "review" | "refine" | "repair" | "evolve" {
  let mode: "review" | "refine" | "repair" | "evolve" = "review";
  for (const event of input.events) {
    if (event.turnNo === undefined || event.turnNo < input.since || event.turnNo > input.turnNo || event.kind !== "tool") continue;
    const command = event.tool?.input ?? "";
    if (!isDeployedSkillPath(command, input.skillRoot)) continue;
    if (command.includes("/scripts/generate-handbook-delivery.mjs")) mode = "refine";
    else if (command.includes("/scripts/evolve.mjs")) mode = "evolve";
    else if (command.includes("/scripts/repair.mjs")) mode = "repair";
    else if (command.includes("/scripts/generate-report.mjs") && mode !== "repair") mode = "review";
  }
  return mode;
}

/**
 * 只有读 / 跑**已部署**的技能才算「使用」：路径在部署槽位（~/.pi-agent-gui/slots/<槽>/skills/platform/…，模型从首轮技能目录里拿到的就是这种绝对路径），
 * 或在平台实例自己的技能根目录下（skillRoot）。开发这个技能本身（worktree 里的相对路径 / 绝对路径）不算，否则开发会话会被要求交报告。
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

export interface UiReportCheckInput { events: readonly ProjectedEvent[]; since: number; turnNo: number; assistantText: string; workspace: string; /** 平台实例的技能根目录（manager 的 platformSkillsRoot） */ skillRoot?: string }

/**
 * undefined = 这一轮不需要检查（没用技能，或回复里声明了未使用）；[] = 通过；否则是问题清单。
 */
export function uiReportProblems(input: UiReportCheckInput): string[] | undefined {
  if (!usedUiSkill(input.events, input.since, input.turnNo, input.skillRoot)) return undefined;
  if (input.assistantText.includes(UI_REPORT_OPT_OUT)) return undefined;
  const mode = deliveryMode(input);
  // 尚未跑交付脚本时也检查显式引用的手册，避免让 Refine 用户补一份无关 Review 报告。
  const handbookRefs = [...input.assistantText.matchAll(/[^\s()<>"'`\[\]]*handbook\.html/g)].map((m) => m[0]);
  const evolutionRefs = [...input.assistantText.matchAll(/[^\s()<>"'`\[\]]*evolve\.html/g)].map((m) => m[0]);
  const isEvolution = mode === "evolve" && (evolutionRefs.length > 0 || handbookRefs.length === 0);
  const isRefine = !isEvolution && (mode === "refine" || (mode !== "repair" && handbookRefs.length > 0 && !input.assistantText.includes("report.html")));
  const refs = [...new Set(isEvolution ? evolutionRefs : isRefine ? handbookRefs : [...input.assistantText.matchAll(/[^\s()<>"'`\[\]]*report\.html/g)].map((m) => m[0]))];
  if (!refs.length) return [isEvolution ? "Evolve 向下扩散需要影响面交付（evolve.html），向上沉淀需要手册交付（handbook.html）。" : isRefine ? "本轮设计（refine）没有设计手册（handbook.html）的链接。" : "本轮用了「界面打磨」，但最终回复里没有检查报告（report.html）的链接。"];
  const reasons: string[] = [];
  for (const ref of refs) {
    const file = isAbsolute(ref) ? ref : resolve(input.workspace, ref);
    const why = isEvolution ? evolutionProblem(file) : isRefine ? handbookProblem(file) : reportProblem(file, mode === "repair");
    if (!why) return [];
    reasons.push(`${ref}：${why}`);
  }
  return [`回复里引用的交付物不是技能脚本生成并校验过的：${reasons.join("；")}`];
}

function evolutionProblem(file: string): string | undefined {
  try {
    if (!existsSync(file)) return "文件不存在";
    if (statSync(file).size > MAX_REPORT_BYTES) return "文件过大";
    const meta = /<meta name="pi-ui-evolve" content="(ui-\d{8}-\d{4}-[a-z0-9]{4}):([0-9a-f]{64})">/.exec(readFileSync(file, "utf8"));
    if (!meta) return "缺少 Evolve 交付标记，请运行 evolve.mjs impact";
    const raw = readFileSync(join(dirname(file), "evolve.json"), "utf8");
    if (hash(raw) !== meta[2]) return "Evolve 影响面数据被改过";
    const data = JSON.parse(raw);
    if (data.schemaVersion !== 1 || data.mode !== "evolve" || data.direction !== "down" || data.runId !== meta[1] || !data.appId || !data.handbookVersion || !data.handbookHash || !["draft", "approved"].includes(data.handbookStatus) || !Array.isArray(data.proposals) || !data.proposals.length || !Array.isArray(data.impacts) || !Array.isArray(data.batches) || !Array.isArray(data.unresolved)) return "Evolve 交付记录不完整或阶段不一致";
    return undefined;
  } catch { return "读取 Evolve 交付失败"; }
}

function handbookProblem(file: string): string | undefined {
  try {
    if (!existsSync(file)) return "文件不存在";
    if (statSync(file).size > MAX_REPORT_BYTES) return "文件过大";
    const html = readFileSync(file, "utf8"), meta = HANDBOOK_META_RE.exec(html);
    if (!meta) return "缺少 Refine 交付标记，请运行 generate-handbook-delivery.mjs";
    const dir = dirname(file), raw = readFileSync(join(dir, "handbook-delivery.json"), "utf8");
    if (hash(raw) !== meta[2]) return "手册交付记录的哈希不一致（被改过）";
    const delivery = JSON.parse(raw);
    if (delivery.schemaVersion !== 1 || delivery.mode !== "refine" || delivery.runId !== meta[1]) return "手册交付记录的阶段或 runId 不一致";
    if (typeof delivery.requirement !== "string" || !delivery.requirement.trim()) return "缺少用户本次要求";
    if (hash(html.replace(meta[0], "")) !== delivery.htmlSha256) return "手册 HTML 的哈希不一致（被改过）";
    const sources = delivery.sources;
    if (!sources || !sources["manifest.json"] || !sources["handbook.json"] || !sources["history.json"]) return "缺少手册来源数据";
    for (const [name, sha] of Object.entries(sources)) {
      if (!/^(manifest\.json|handbook\.json|history\.json|proposals\/P-\d{3}\.json)$/.test(name)) return "手册来源路径不合法";
      if (statSync(join(dir, name)).size > MAX_REPORT_BYTES || hash(readFileSync(join(dir, name))) !== sha) return `手册来源 ${name} 被改过`;
    }
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    if (manifest.appId !== delivery.appId || manifest.handbookVersion !== delivery.handbookVersion || manifest.status !== delivery.status) return "交付记录与手册版本不一致";
    if (!["draft", "approved"].includes(manifest.status) || (manifest.status === "approved" && (!manifest.approvedBy || !manifest.approvedAt))) return "手册确认状态不合法";
    if (!html.includes(`<meta name="pi-design-handbook" content="${manifest.appId}:${manifest.handbookVersion}">`)) return "HTML 与手册版本不一致";
    return undefined;
  } catch { return "读取手册交付记录失败"; }
}

function reportProblem(file: string, repair = false): string | undefined {
  try {
    if (!existsSync(file)) return "文件不存在";
    if (statSync(file).size > MAX_REPORT_BYTES) return "文件过大";
    const meta = META_RE.exec(readFileSync(file, "utf8"));
    if (!meta) return "不含技能脚本写入的报告标记（疑似手写）";
    const jsonFile = join(dirname(file), "report.json");
    if (!existsSync(jsonFile)) return "同目录缺少 report.json";
    const raw = readFileSync(jsonFile, "utf8");
    if (createHash("sha256").update(raw).digest("hex") !== meta[2]) return "report.json 与报告标记的哈希不一致（被改过）";
    const json = JSON.parse(raw);
    if (json.runId !== meta[1]) return "report.json 的 runId 与报告标记不一致";
    if (repair && json.mode !== "repair") return "Repair 必须交付落地报告，不能用只读检查报告替代";
    if (!["review", "repair"].includes(json.mode)) return "报告只开放检查（review）与落地（repair），设计阶段使用手册交付";
    if (json.mode === "repair" && (!json.handbookVersion || json.repairPlan?.handbookVersion !== json.handbookVersion || !json.repairPlan?.authorization?.by || !json.repairPlan?.authorization?.planSha256)) return "落地报告缺少手册版本或计划授权";
    return undefined;
  } catch { return "读取失败"; }
}

/** 反馈给模型的「怎么补」。 */
export const UI_REPORT_FIX = [
  "1. 按本次阶段补交付：review 运行 resolve-target → snapshot → start-target → 用 platform_browser 截图并 record-capture 登记 → 写 report.draft.json → generate-report.mjs --run <runId>。refine 运行 handbook.mjs build，再运行 generate-handbook-delivery.mjs --run <runId> --app <appId> --requirement <用户要求>，引用输出的 handbookHtml。不要把设计手册换成检查报告。",
  "2. generate-report.mjs 会输出 chatSummary 和 reportHtml：把 chatSummary 原样作为最终回复（可在前面加一句话），不要再贴报告全文。",
  "3. review 和 refine 都不要修改任何代码：refine 只能修改手册，提案逐条接受后才合入；首版确认须单独授权。repair 先按 repair.md 绑定已确认手册、展示计划并取得授权，再执行验证与落地报告。evolve 向上按提案确认交付手册，向下用 evolve.mjs impact 交付 evolve.html；每批独立取得 Repair 授权，不能自动批量改代码。",
  `4. 如果这次任务其实不属于界面检查，请在回复里写明「${UI_REPORT_OPT_OUT}」并说明原因，然后结束。`
].join("\n");
