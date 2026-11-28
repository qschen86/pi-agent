/**
 * 自愈的基础板块（docs/requirements/self-heal）：每晚按板块汇总报错、出结论、安排处理。
 *
 * - collector=true：已经有现成的报错来源（一期接入）；其余板块先占位，页面显示「采集待接入」。
 * - 「其他」不参与自动修复，只用来挂没有对应板块的夜间任务（排序校准、记忆提炼、孤儿清理等）。
 */
export type BoardId =
  | "runtime" | "session" | "mcp-skill" | "design" | "ci-deploy" | "remote-access" | "stats" | "self-heal" | "open-source" | "other";

export interface BoardDef { id: BoardId; name: string; description: string; collector: boolean; autoFix: boolean }

export const BOARDS: readonly BoardDef[] = [
  { id: "runtime", name: "runtime", description: "会话消息里的各种报错（工具调用失败、强约束重试用尽等）", collector: true, autoFix: true },
  { id: "session", name: "平台-会话", description: "新建、预约、续聊、归档", collector: true, autoFix: true },
  { id: "mcp-skill", name: "平台-MCP/skill", description: "外部连接、MCP 与技能的调用", collector: false, autoFix: true },
  { id: "design", name: "平台-设计", description: "前端异常现场、界面渲染与资源加载", collector: true, autoFix: true },
  { id: "ci-deploy", name: "平台-CI 部署", description: "门禁、部署、回归测试", collector: true, autoFix: true },
  { id: "remote-access", name: "平台-远程访问", description: "链接设备、中继、公网入口", collector: false, autoFix: true },
  { id: "stats", name: "平台-统计", description: "用量、会话与部署统计", collector: false, autoFix: true },
  { id: "self-heal", name: "平台-自愈", description: "自愈能力自身的运行", collector: true, autoFix: true },
  { id: "open-source", name: "平台-开源发布", description: "开源版本的整理与发布", collector: false, autoFix: true },
  { id: "other", name: "其他", description: "没有对应板块的夜间任务，只展示运行状态，不参与自动修复", collector: false, autoFix: false }
] as const;

export const boardById = (id: string): BoardDef | undefined => BOARDS.find((b) => b.id === id);
export const isBoardId = (id: unknown): id is BoardId => typeof id === "string" && BOARDS.some((b) => b.id === id);

/** 错误统计的指纹：工具报错 / 记忆强约束 → runtime；部署失败 / 门禁不稳定 → CI 部署。 */
export function boardOfFingerprint(fingerprint: string): BoardId {
  const kind = fingerprint.split("|")[0];
  if (kind === "deploy" || kind === "flaky") return "ci-deploy";
  return "runtime";
}

/** 前后端链路证据（diagnostics finding）：按出错的组件 / 接口归板块，认不出来的归「其他」。 */
export function boardOfComponent(component: string | undefined, errorType?: string): BoardId {
  const text = `${component ?? ""} ${errorType ?? ""}`.toLowerCase();
  if (!text.trim()) return "other";
  if (/self-?heal|diagnostic|error-stats|triage/.test(text)) return "self-heal";
  if (/deploy|gate|regression/.test(text)) return "ci-deploy";
  if (/mcp|skill|capabilit|connection/.test(text)) return "mcp-skill";
  if (/remote|relay|tunnel|frp|device|login|auth/.test(text)) return "remote-access";
  if (/\b(js|promise|resource|render|frontend)\b/.test(text)) return "design";
  if (/stats|usage/.test(text)) return "stats";
  if (/open-?source/.test(text)) return "open-source";
  if (/session|rt-|runtime-sessions|reservation|schedul|archive|turn|message-submit/.test(text)) return "session";
  return "other";
}

/**
 * 链路结论的板块：先看出错的组件 / 接口；认不出来（链路指纹常常没有组件名）再看分诊起的标题——
 * 标题直接点名部署 / 门禁的，归 CI 部署（只看标题，不看原因假设：很多读取超时的原因假设里会顺带提到部署窗口）。
 */
export function boardOfTrace(component: string | undefined, errorType: string | undefined, title: string | undefined): BoardId {
  const byComponent = boardOfComponent(component, errorType);
  if (byComponent !== "other" && component !== "frontend") return byComponent;
  return /部署|门禁|deploy|gate|\bCI\b/i.test(title ?? "") ? "ci-deploy" : byComponent;
}

/** 定时任务 → 板块；没登记过的任务归「其他」。 */
const TASK_BOARDS: Record<string, BoardId> = {
  "self-heal-nightly": "self-heal",
  "error-stats-nightly": "self-heal",
  "diagnostics-triage": "self-heal",
  "nightly-regression": "ci-deploy",
  "nightly-regression-check": "ci-deploy",
  "deploy-review": "ci-deploy",
  "health-guard": "remote-access",
  "backup-host-activation": "remote-access",
  "codex-reset-nightly": "runtime",
  "runtime-updates-daily": "runtime",
  "note-ranking-calibration": "other",
  "public-memory-pipeline": "other",
  "nightly-orphan-cleanup": "other"
};

export function boardOfTask(taskId: string): BoardId {
  const id = taskId.replace(/^pi-agent:/, "").replace(/^com\.pi-agent\./, "").replace(/:\d+$/, "");
  return TASK_BOARDS[id] ?? "other";
}
