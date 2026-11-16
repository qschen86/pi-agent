/**
 * 公共记忆的「强约束」校验（docs/requirements/memory-hard-constraint）。
 *
 * 强约束的记忆在首轮注入时，会把它关联的检测规则一起登记到会话（注入事件的 rules 字段）；
 * 每轮正常结束后，平台用这里的规则检查这一轮的最终回复与工具事件。不通过就给模型一段明确的反馈（哪里不对、怎么改），
 * 由管理器自动续发一轮让它改，最多 MAX_ENFORCEMENT_RETRIES 次，仍不通过就停下并告知用户。
 *
 * 规则是代码里的确定性函数（不让模型生成规则）；记忆条目只引用 ruleId。每条规则声明自己挂在哪个检测节点（现在只有 turn-end）。
 */
import { rule as beijingTimeRule } from "./memory-rules/beijing-time.js";
import { rule as entryDomainRule } from "./memory-rules/entry-domain.js";
import type { ProjectedEvent } from "./types.js";

/** 检测节点：第一版只有回合结束。部署门禁等节点以后加。 */
export type EnforcementNode = "turn-end";
export const ENFORCEMENT_NODE_LABEL: Record<EnforcementNode, string> = { "turn-end": "回合结束" };
export const MAX_ENFORCEMENT_RETRIES = 2;
export const ENFORCEMENT_PROMPT_MARK = "【平台强约束检查未通过】";

/** 本回合给规则看的证据：最终回复（本回合所有助手消息拼起来）与改文件类工具的输入。 */
export interface TurnEvidence {
  assistantText: string; editInputs: string[];
  screenshotProblems?: string[];
  /** 本回合访问网址的命令 / 浏览器类工具输入（curl、wget、open、浏览器工具），入口域名规则用；没有就不填 */
  commandInputs?: string[];
  /** 整个会话里所有改文件类工具的输入（不限回合）：规则用它判断「这是个改过界面的会话」，只用于跳过留痕，不参与通过判定 */
  sessionEditInputs?: string[];
  /** 本回合所有工具调用（「工具名：输入」，已截断）：模型判定的规则（DeepSeek 按四要素写的、没有对应代码的）用它看「做了什么」 */
  toolCalls?: string[];
  /** 取证项的事实（按规则声明的 probes 取）：changed-files 是路径数组，其余是 {before, after, changed}；模型判定的规则以它为准，回复里的措辞只作辅助 */
  facts?: Record<string, unknown>;
}
export interface RuleVerdict { pass: boolean; /** 不通过时：哪里不对 */ problem?: string; /** 不通过时：怎么改（具体步骤） */ fix?: string }
/**
 * 规则的实现由 DeepSeek flash 写（见 memory-rules/ 和 docs/requirements/memory-hard-constraint/deepseek-drafts/）；ui-change-screenshot-table 的判定逻辑是早期手写的，说明文字由 DeepSeek 对照代码重写。
 * 一条检测规则必须把四件事讲清楚（记忆页原样展示）：校验节点（node）、校验对象范围（scope）、校验规则（criteria）、结果反馈（feedback）。
 * 其中 scope / criteria / feedback 是给人看的说明，真正的判定在 applies / check 里，两边要一致。
 */
export interface EnforcementRule {
  id: string;
  /** 给人看的名字（记忆页、反馈里用） */
  title: string;
  /** 给入库判定模型看：什么样的记忆适合挂这条规则 */
  description: string;
  node: EnforcementNode;
  /** 校验对象范围：检查哪些东西、什么情况下才检查、哪些不算 */
  scope: string;
  /** 校验规则：怎样算通过 */
  criteria: string;
  /** 结果反馈：不通过时告诉模型什么 */
  feedback: string;
  /** 这条规则能不能用来检查这条记忆：记忆要求的就是规则检查的内容才算（语义一致），不是挂上就行 */
  fits(statement: string): boolean;
  /** 这一轮要不要检查（不相关的回合直接放行） */
  applies(ev: TurnEvidence): boolean;
  check(ev: TurnEvidence): RuleVerdict;
  /** 要不要「按结果取证」：回合开始 / 结束各拍一次工作区快照，用变化的文件补充工具事件里认出的改动（不管模型用什么命令写文件）。 */
  usesWorkspaceChanges?: boolean;
  /** 这一轮因为 applies 为 false 被跳过时，要不要在会话里留一条「未检查」记录：返回说明就留，不返回就静默跳过（大多数规则每轮都会跳过，留痕会刷屏） */
  skipNote?(ev: TurnEvidence): string | undefined;
}

/**
 * 模型判定的规则：DeepSeek 开推理按记忆原句写的四要素（校验节点 / 对象范围 / 校验规则 / 结果反馈），确认强约束时和记忆绑定。
 * 没有对应的代码规则，每轮结束由判定模型按这四段文字核对本回合的回复和工具记录。
 */
export interface ModelRuleSpec { node: EnforcementNode; scope: string; criteria: string; feedback: string; /** 判定要用的取证项（见 memory-probes.ts）；为空 = 规则只看最终回复 / 工具记录 */ probes?: string[] }
/** 登记的模型判定规则里用到的取证项（去重）。 */
export const probeIdsOf = (active: readonly ActiveRule[]): string[] => [...new Set(active.filter(isModelRule).flatMap((a) => a.spec!.probes ?? []))];
/** 首轮注入时登记到会话里的一条规则。ruleId 是代码规则的 id；模型判定的规则 ruleId 形如 model:<记忆编号>，并带 title / spec。 */
export interface ActiveRule { topicId: string; ruleId: string; /** 记忆的一句话规则（反馈里引用） */ statement: string; topic: string; title?: string; spec?: ModelRuleSpec }
export const modelRuleId = (topicId: string): string => `model:${topicId}`;
/** 这条登记的规则由谁判：有代码规则就用代码（确定性、不花 token），否则看有没有模型判定的四要素。 */
export const isModelRule = (a: ActiveRule): boolean => !enforcementRule(a.ruleId) && !!a.spec;
export const ruleTitleOf = (a: Pick<ActiveRule, "ruleId" | "title">): string => enforcementRule(a.ruleId)?.title ?? a.title ?? a.ruleId;

/* ------------------------------ 规则：前端改动汇报要带改前改后截图对照表 ------------------------------ */

/**
 * 改文件类工具：Claude 的 Edit / Write / MultiEdit、Pi 的 edit / write、Codex 的「文件修改」（输入是路径列表）；
 * 另外 shell 类工具（Codex 的「命令」、Claude 的 Bash、Pi 的 bash）里用 apply_patch / sed -i / tee / 重定向写文件的也算。
 * shell 命令里只取「被写入的那个路径」：`git show HEAD:apps/web/public/styles.css > tmp/before/styles.css`
 * 是在给截图留一份「改前」副本，既不是改动前端，也不该把这两个路径当成改动。
 */
const EDIT_TOOL = /edit|write|patch|change|replace|create|文件修改/i;
const SHELL_TOOL = /命令|bash|shell|exec/i;
const FRONTEND_EXT = "(?:js|css|html|tsx|jsx|vue|svg)";
/** 前端文件：公共目录下的 js/css/html/svg，或任何 css/html/tsx/jsx/vue；再要求在 App 目录里（见 APP_PATH）。测试、文档、后端 ts 不算。 */
const FRONTEND_PATH = /(?:[^\s"'\\]*\/)?public\/[^\s"'\\]+\.(?:js|css|html|svg)\b|(?:[^\s"'\\]*\/)?apps\/[^\s"'\\/]+\/[^\s"'\\]+\.(?:js|svg)\b|[^\s"'\\]+\.(?:css|html|tsx|jsx|vue)\b/g;
/** 只认 App 的前端目录：`apps/<应用>/…`，或以 `public/` 开头的相对路径（在 apps/web 里工作时）。docs/、designs/、skills/、videos/ 里的设计稿、原型页、示例 html 不是 App 界面，不算。 */
const APP_PATH = /^(?:(?:.*\/)?apps\/[^/]+\/|public\/)/;
/** 临时 / 对照 / 产物目录里的文件不算改动（截图用的改前副本、证据图目录等）。 */
const SCRATCH_PATH = /(?:^|\/)(?:tmp|temp|before|after|shots|evidence|node_modules)\//i;
/** 测试、脚本、配置文件不算界面（apps/<应用>/ 下的 js 多了，要把它们挡在外面）。 */
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|e2e|scripts)\/|\.(?:test|spec)\.|(?:^|\/)[^/]*\.config\./i;
const WRITE_TARGETS: readonly RegExp[] = [
  /\*\*\* (?:Update|Add|Delete) File:\s*(\S+)/g,                                  // apply_patch
  /\*\*\* Move to:\s*(\S+)/g,
  new RegExp(`>>?\\s*([^\\s|&;<>]+\\.${FRONTEND_EXT})\\b`, "g"),                   // 重定向
  new RegExp(`\\btee\\s+(?:-a\\s+)?([^\\s|&;<>]+\\.${FRONTEND_EXT})\\b`, "g")        // tee
];
const SED_SEGMENT = /\b(?:sed\s+-[A-Za-z]*i|perl\s+-[A-Za-z]*pi)[^;&|\n]*/g;
const FILE_TOKEN = new RegExp(`[^\\s'"|&;<>]+\\.${FRONTEND_EXT}\\b`, "g");
/** shell 命令里被写入的路径（apply_patch 的目标、sed -i / perl -pi 的文件、重定向与 tee 的目标）。 */
export function shellWriteTargets(command: string): string[] {
  const out = new Set<string>();
  for (const re of WRITE_TARGETS) for (const m of command.matchAll(re)) out.add(m[1]!);
  for (const seg of command.match(SED_SEGMENT) ?? []) for (const t of seg.match(FILE_TOKEN) ?? []) out.add(t);
  return [...out];
}
export const isEditTool = (name: string | undefined, input: string): boolean => EDIT_TOOL.test(name ?? "") || (SHELL_TOOL.test(name ?? "") && shellWriteTargets(input).length > 0);
/** 取证据时的输入：shell 命令只留写入目标（一行一个），其余工具保持原样。 */
export const editEvidenceOf = (name: string | undefined, input: string): string => (EDIT_TOOL.test(name ?? "") ? input : shellWriteTargets(input).join("\n"));

/** 访问网址的工具：shell 里的 curl / wget / open，或浏览器类工具（名字带 browser / playwright / navigate / 浏览器）。grep 之类只是在搜文本，不算访问。 */
const BROWSER_TOOL = /browser|playwright|navigate|goto|浏览器/i;
const URL_COMMAND = /\b(?:curl|wget|open|xdg-open)\b/;
export const isUrlTool = (name: string | undefined, input: string): boolean => BROWSER_TOOL.test(name ?? "") || (SHELL_TOOL.test(name ?? "") && URL_COMMAND.test(input));

export const frontendFilesOf = (inputs: readonly string[]): string[] => {
  const out = new Set<string>();
  for (const input of inputs) for (const m of input.match(FRONTEND_PATH) ?? []) {
    const path = m.replace(/^[\w.-]+:(?=[^/])/, "").replace(/^\//, "");     // 去掉 HEAD: 这类 git 引用前缀
    if (APP_PATH.test(path) && !SCRATCH_PATH.test(path) && !TEST_PATH.test(path) && !path.startsWith("../")) out.add(path);
  }
  return [...out];
};

const IMAGE_REF = /\[[^\]]*\]\([^)\s]+\.(?:png|jpe?g|webp|gif)(?:\?[^)\s]*)?\)/gi;

/** markdown 表格的数据行：`| a | b |` 形式，且不是分隔行。 */
const tableRows = (text: string): string[][] => {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|") || t.length < 3) continue;
    if (/^\|[\s:|-]+\|$/.test(t)) continue;
    rows.push(t.slice(1, -1).split("|").map((c) => c.trim()));
  }
  return rows;
};
const imagesIn = (cell: string): number => (cell.match(IMAGE_REF) ?? []).length;

const uiScreenshotTable: EnforcementRule = {
  id: "ui-change-screenshot-table",
  title: "界面改动汇报：改前/改后截图对照表",
  description: "界面（前端页面、弹层、样式、交互）改动后，汇报时必须给真实渲染截图，并用 Markdown 表格对照改前和改后（每个宽度或主题一行）。",
  node: "turn-end",
  scope:
    [
      "什么时候查：本回合改过 App 前端文件（apps/<应用>/ 下的 js、css、html、svg、tsx、vue，或 public/ 下的前端文件）",
      "怎么认定改过：按结果。回合开始和结束各取一次工作区状态（git status 的未提交文件 + 文件修改时间，再加期间本分支自己的提交），期间新增或变化的文件都算，不管是编辑工具、apply_patch、sed、重定向、tee，还是 python / node 脚本、cp、mv 写的；编辑工具事件里的路径一并计入（取并集）；取不到工作区状态时只看工具事件",
      "中断的回合：额度 / 失败 / 被停止中断的前几轮也算，改动一直记到下一次正常结束并检查为止",
      "不算改动：",
      "· docs/、designs/、skills/、videos/ 里的设计稿和示例页",
      "· 测试和脚本文件（test/、scripts/、*.test.*、*.config.*）、后端 .ts",
      "· tmp / temp / before / after / shots / evidence 等临时、对照、产物目录",
      "· ../ 上级路径"
    ].join("\n"),
  criteria:
    [
      "通过：",
      "· 最终回复里有 Markdown 表格（| 开头并结尾的行，分隔行不算）",
      "· 至少一行里合计 2 张及以上截图（png/jpg/jpeg/webp/gif），改前、改后放同一行即通过",
      "不校验：图注是否写了「改前 / 改后」，只数图"
    ].join("\n"),
  feedback:
    [
      "1. 告知本回合改了哪些前端文件（最多列 4 个）",
      "2. 区分是「完全没有截图」还是「有截图但没放进改前 / 改后对照表」",
      "3. 给 4 步改法：真实渲染截图（改前用未改动的代码、改后再截）→ 手机浅色 + 夜间 + 一个桌面宽度 → Markdown 表格（首列维度，后两列改前 / 改后）→ 表格外只补一两句说明"
    ].join("\n"),
  // 记忆要求的得是「汇报时给截图 / 改前改后对照」；只是某个具体样式取值、间距、颜色之类的要求，这条规则查不了
  fits: (statement) => /截图|对照|改前|改后/.test(statement),
  usesWorkspaceChanges: true,
  applies: (ev) => frontendFilesOf(ev.editInputs).length > 0,
  // 只在「本会话改过界面、这一轮没改」时留痕：纯聊天会话不提，界面会话里能看出这一轮平台没查截图
  skipNote: (ev) => frontendFilesOf(ev.sessionEditInputs ?? []).length > 0 ? "本回合（含被中断的前几轮）没有改界面文件，所以没有检查截图对照表；本会话之前改过的界面不在这一轮的检查范围内。" : undefined,
  check(ev) {
    const rows = tableRows(ev.assistantText);
    // 对照 = 同一行里至少两张图（改前一张、改后一张）
    const compared = rows.filter((r) => r.reduce((n, c) => n + imagesIn(c), 0) >= 2).length;
    if (compared > 0) return { pass: true };
    const files = frontendFilesOf(ev.editInputs).slice(0, 4).join("、");
    const anyImage = ev.assistantText.match(IMAGE_REF)?.length ?? 0;
    return {
      pass: false,
      problem: anyImage
        ? `本回合改动了前端文件（${files}），回复里有截图，但没有放进「改前 / 改后」对照表（需要至少一行里并排有两张图）。`
        : `本回合改动了前端文件（${files}），但回复里没有「改前 / 改后」截图对照表。`,
      fix: [
        "1. 用真实渲染截图：改前用未改动的代码（比如另开一个 git worktree 或临时副本）截一次，改后再截一次；",
        "2. 手机浅色和夜间各一组，再加一个桌面宽度；没有夜间模式的界面，在表格下面一句话说明；",
        "3. 用 Markdown 表格汇报：首列写维度（如「手机浅色 390」），后两列分别是「改前」「改后」，单元格里放截图相对路径 ![改前](相对路径.png)；",
        "4. 表格之外只补一两句说明，不要把图嵌在句子中间。"
      ].join("\n")
    };
  }
};


const screenshotProvenance:EnforcementRule={id:"platform-screenshot-provenance",title:"核验平台浏览器截图与原生工具调用来源",description:"截图必须关联真实平台浏览器工具调用与文件哈希",node:"turn-end",scope:"本轮验收汇报中声明为浏览器截图的图片链接",criteria:"图片路径、会话、真实 screenshot 工具调用及 SHA-256 一致",feedback:"使用 platform_browser 重新截图并引用工具返回的路径与 receiptId",fits:()=>false,applies:ev=>!!ev.screenshotProblems?.length,check:ev=>({pass:!ev.screenshotProblems?.length,problem:ev.screenshotProblems?.join("\n"),fix:"使用 platform_browser 重新截图，引用工具返回的路径与 receiptId；不得用本地脚本或手工图片冒充验收截图。"})};
export const ENFORCEMENT_RULES: readonly EnforcementRule[] = [uiScreenshotTable, entryDomainRule, beijingTimeRule,screenshotProvenance];
export const enforcementRule = (id: string): EnforcementRule | undefined => ENFORCEMENT_RULES.find((r) => r.id === id);
/** 给入库判定和记忆页看的规则清单。 */
export interface EnforcementRuleInfo { id: string; title: string; description: string; node: EnforcementNode; nodeLabel: string; scope: string; criteria: string; feedback: string }
export const enforcementRuleCatalog = (): EnforcementRuleInfo[] => ENFORCEMENT_RULES.filter(r=>r.id!=="platform-screenshot-provenance").map(({ id, title, description, node, scope, criteria, feedback }) => ({ id, title, description, node, nodeLabel: ENFORCEMENT_NODE_LABEL[node], scope, criteria, feedback }));
/** 规则清单的版本：加 / 改规则后，已判定过的记忆会据此重新判定一次（人工指定的除外）。 */
export const ENFORCEMENT_RULES_VERSION = ENFORCEMENT_RULES.map((r) => r.id).sort().join(",");

/* ------------------------------ 从会话事件取证据 ------------------------------ */

/**
 * 最终回复取本回合；改文件的工具输入从 sinceTurn 起算。补救回合（平台反馈后的续发）模型通常不会再改文件，
 * 所以补救链的证据要带上起始回合的改动，否则规则会判「本回合没改前端」而直接放行。
 * changedFiles：工作区快照对比出来的、这一段回合里变化的文件（见 workspace-evidence.ts），补上工具事件认不出的写法（python / node 脚本、cp、mv 等）。
 */
export function turnEvidence(events: readonly ProjectedEvent[], turnNo: number, sinceTurn = turnNo, changedFiles: readonly string[] = []): TurnEvidence {
  const mine = events.filter((e) => e.turnNo === turnNo);
  const isEdit = (e: ProjectedEvent): boolean => e.kind === "tool" && !!e.tool?.input && isEditTool(e.tool.name, e.tool.input);
  const sessionEditInputs = events.filter((e) => e.turnNo !== undefined && e.turnNo <= turnNo && isEdit(e)).map((e) => editEvidenceOf(e.tool!.name, e.tool!.input!));
  const assistantText = mine.filter((e) => e.kind === "message" && e.role === "assistant" && !e.partial && e.text).map((e) => e.text!).join("\n\n");
  const editInputs = events.filter((e) => e.turnNo !== undefined && e.turnNo >= sinceTurn && e.turnNo <= turnNo && e.kind === "tool" && e.tool?.input && isEditTool(e.tool.name, e.tool.input)).map((e) => editEvidenceOf(e.tool!.name, e.tool!.input!));
  // 按结果取证：工作区快照对比出来的改动文件（一行一个），与工具事件里认出的并集
  if (changedFiles.length) editInputs.push(changedFiles.join("\n"));
  // 访问网址只算本回合：补救回合重新核查后才能通过，不会被起始回合的旧命令一直拖着
  const commandInputs = mine.filter((e) => e.kind === "tool" && e.tool?.input && isUrlTool(e.tool.name, e.tool.input)).map((e) => e.tool!.input!);
  const flat = (v: string | undefined, n: number): string => (v ?? "").replace(/\s+/g, " ").slice(0, n);
  const toolCalls = mine.filter((e) => e.kind === "tool" && e.tool?.name).slice(0, MODEL_RULE_MAX_TOOLS).map((e) => `${e.tool!.name}：${flat(e.tool!.input, MODEL_RULE_TOOL_CHARS)}${e.tool!.output ? ` ⇒ ${flat(e.tool!.output.slice(-MODEL_RULE_OUTPUT_CHARS), MODEL_RULE_OUTPUT_CHARS)}` : ""}`);
  return { assistantText, editInputs, commandInputs, sessionEditInputs, toolCalls };
}
const MODEL_RULE_MAX_TOOLS = 40, MODEL_RULE_TOOL_CHARS = 300, MODEL_RULE_OUTPUT_CHARS = 200;

/**
 * 这一轮之前，连续「没正常结束」（额度中断 / 失败 / 被停止）的回合里最早的一轮；前一轮正常结束就是本轮自己。
 * 回合结束检查只在正常结束时跑，被中断的回合里改的文件没人查过，要并进接续那一轮的证据里，否则「改界面的一轮」和「汇报的一轮」错开就查不到。
 */
export function unfinishedChainStart(turns: ReadonlyArray<{ turnNo: number; status: string }>, turnNo: number): number {
  let start = turnNo;
  for (const t of [...turns].sort((a, b) => b.turnNo - a.turnNo)) {
    if (t.turnNo >= turnNo) continue;
    if (t.turnNo !== start - 1 || t.status === "completed") break;
    start = t.turnNo;
  }
  return start;
}

/** 会话里最近一次注入登记的规则（注入事件的 rules 字段）。 */
export function activeRulesOf(events: readonly ProjectedEvent[]): ActiveRule[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const rules = events[i]!.injection?.rules;
    if (rules?.length) return rules;
  }
  return [];
}

export interface RuleFailure { rule: ActiveRule; title: string; problem: string; fix: string }
/** 对本回合跑一遍登记的规则；返回不通过的、通过的，以及被跳过且要留痕的（规则声明了 skipNote 才有）。 */
export function runRules(active: readonly ActiveRule[], ev: TurnEvidence): { failed: RuleFailure[]; passed: ActiveRule[]; skipped: Array<{ rule: ActiveRule; note: string }> } {
  const failed: RuleFailure[] = [], passed: ActiveRule[] = [], skipped: Array<{ rule: ActiveRule; note: string }> = [];
  for (const a of active) {
    const rule = enforcementRule(a.ruleId);
    if (!rule || rule.node !== "turn-end") continue;
    if (!rule.applies(ev)) { const note = rule.skipNote?.(ev); if (note) skipped.push({ rule: a, note }); continue; }
    const v = rule.check(ev);
    if (v.pass) passed.push(a); else failed.push({ rule: a, title: rule.title, problem: v.problem ?? "不符合这条记忆的要求。", fix: v.fix ?? "按这条记忆的要求重做。" });
  }
  return { failed, passed, skipped };
}

/** 模型判定的结论：applies=false 表示这一轮不在规则的校验对象范围内（放行）；null = 判定模型没给出可用结论（调用失败 / 输出不合格）。 */
export type ModelRuleJudge = (input: { rule: ActiveRule; evidence: TurnEvidence }) => Promise<{ applies: boolean; pass: boolean; problem?: string; fix?: string } | null>;
/** 对本回合跑一遍模型判定的规则（和代码规则同样的返回形状）；判定失败就放行并留一条「未检查」，不会因为判定模型不可用而让会话被无谓地要求重做。 */
export async function runModelRules(active: readonly ActiveRule[], ev: TurnEvidence, judge: ModelRuleJudge): Promise<ReturnType<typeof runRules>> {
  const failed: RuleFailure[] = [], passed: ActiveRule[] = [], skipped: Array<{ rule: ActiveRule; note: string }> = [];
  const mine = active.filter((a) => isModelRule(a) && a.spec!.node === "turn-end");
  const verdicts = await Promise.all(mine.map((rule) => judge({ rule, evidence: ev }).catch(() => null)));
  mine.forEach((a, i) => {
    const v = verdicts[i];
    if (!v) { skipped.push({ rule: a, note: "判定模型这一轮没有给出结论，所以没有检查；不影响会话。" }); return; }
    if (!v.applies || v.pass) { if (v.applies) passed.push(a); return; }
    failed.push({ rule: a, title: ruleTitleOf(a), problem: v.problem?.trim() || "不符合这条记忆的要求。", fix: v.fix?.trim() || a.spec!.feedback });
  });
  return { failed, passed, skipped };
}

/**
 * 反馈给模型的消息：引用记忆原句、说清哪里不对、怎么改，并要求直接改完重新汇报。
 * 同一条检查项、同样的问题和改法（多条记忆挂了同一条规则）合并成一段，各条记忆的原句并列，不重复列改法。
 */
export function composeFeedback(failed: readonly RuleFailure[], attempt: number): string {
  const groups = new Map<string, RuleFailure[]>();
  for (const f of failed) {
    const key = [f.rule.ruleId, f.problem, f.fix].join("\n");
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const list = [...groups.values()];
  const parts = list.map((g, i) => [
    `${list.length > 1 ? `（${i + 1}）` : ""}${g.map((f) => `记忆「${f.rule.topic}」：${f.rule.statement}`).join("\n")}`,
    `检查项：${g[0]!.title}`,
    `问题：${g[0]!.problem}`,
    `怎么改：\n${g[0]!.fix}`
  ].join("\n"));
  return [
    `${ENFORCEMENT_PROMPT_MARK}这是平台自动发的检查反馈（第 ${attempt + 1} 次，最多 ${MAX_ENFORCEMENT_RETRIES} 次），不是用户的新需求。`,
    ...parts,
    "请按上面的步骤补齐后重新汇报；不需要道歉或解释，也不要重复已经完成的内容。"
  ].join("\n\n");
}
