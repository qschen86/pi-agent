import { MAX_REPLIES, RETRY_REPLY as PLATFORM_RETRY_REPLY } from "@pi-agent/runtime-sessions";
import type { QuickReply, QuickReplyResult } from "@pi-agent/runtime-sessions";
import type { DeployInfo } from "./deploy-queue.js";

/** 模型仍返回空数组时的最后兜底：保证每一轮结束后输入框上方都有可点的下一步。 */
export const CONTINUE_REPLY = { label: "继续", text: "继续。" } as const;
export const RETRY_REPLY = PLATFORM_RETRY_REPLY;

type DeployState = Pick<DeployInfo, "eligible" | "mode" | "worktree"> | null | undefined;

/** 会话有可部署的内容：worktree 至少要有未提交改动或领先提交；共享目录会话部署的是 main，不需要这个条件。 */
function hasDeployableContent(deploy: NonNullable<DeployState>): boolean {
  if (!deploy.eligible) return false;
  if (deploy.mode !== "worktree") return true;
  const wt = deploy.worktree;
  return !!wt && (wt.changes.length > 0 || wt.ahead > 0);
}

function deployReply(deploy: NonNullable<DeployState>): QuickReply {
  const worktree = deploy.mode === "worktree";
  return {
    label: worktree ? "提交并部署" : "部署",
    text: worktree ? "可以，提交并在空闲时部署。" : "可以，空闲时部署。",
    action: "deploy"
  };
}

/** 备选方案的标记：模型给的是同一问题的互斥选项时，插一条部署会把选择挤掉 */
const CHOICE_MARK = /(方案|选项|改法|做法|路线|计划|option|approach)/i;

/**
 * 模型给的是「方案选择题」：同一问题的互斥备选（「用方案 A / 用方案 B」）。
 * 这类回复要完整保留，平台不再插部署胶囊——选哪条本来就带着执行意图。
 */export function looksLikeChoice(replies: readonly QuickReply[]): boolean {
  return replies.filter((r) => CHOICE_MARK.test(r.label) || CHOICE_MARK.test(r.text)).length >= 2;
}

/** 这次是否还值得去读部署状态：路由用它省掉不需要补胶囊时的 git 读取 */
export function needsDeployInfo(result: QuickReplyResult): boolean {
  const ready: QuickReplyResult = result.state === "unavailable" && result.eventKey
    ? { ...result, state: "ready", replies: [] } : result;
  if (ready.state !== "ready") return false;
  // 最近一轮已经有部署结果通知（成功=归档，失败=重新部署）：不再补部署。
  if (ready.deployment) return false;
  // 已经有任何 action（部署 / 重新部署 / 归档）时，不再插入第二条操作，避免列表标签与胶囊第一条不一致。
  if (ready.replies.some((r) => r.action)) return false;
  return !looksLikeChoice(ready.replies);
}

/**
 * 平台补的「部署」胶囊：能从页面部署的会话，一轮正常完成后部署就是最可能的下一步。
 * - 本轮完成、会话可部署（worktree 还要有未提交改动 / 领先提交）才补；
 * - 模型已经给出 `action=deploy` 的不重复补；给的是方案选择题时不抢位；
 * - 其余情况插到第一位，超过三条时去掉最后一条（模型认为最不可能的那条）。
 * - 共享目录会话读不到「这个会话改了什么」，只在模型没给出建议时补一条（老规则），不插到模型选项前面。
 * 模型返回空数组时就是「只补这一条」，与旧行为一致。
 */
export function withDeployFallback(
  result: QuickReplyResult,
  input: { completed: boolean; deploy?: DeployState }
): QuickReplyResult {
  if (!input.completed || result.state !== "ready" || !input.deploy) return result;
  // 最近一轮已经有部署结果通知：成功时下一步是归档，失败时平台已经补了「重新部署」；
  // 此时 worktree 相对本地 main 仍可能 ahead（线上已上线但本地 main 没快进），不能再补部署胶囊。
  if (result.deployment) return result;
  if (!hasDeployableContent(input.deploy)) return result;
  // 模型或部署结果已经给了 action：保留它的第一条，不再用平台部署覆盖。
  if (result.replies.some((r) => r.action)) return result;
  if (looksLikeChoice(result.replies)) return result;
  // 共享目录会话不知道自己改了什么，混着别的会话的未提交改动：不去挤模型的建议
  if (result.replies.length && input.deploy.mode !== "worktree") return result;
  return { ...result, replies: [deployReply(input.deploy), ...result.replies].slice(0, MAX_REPLIES) };
}

/**
 * 每轮结束都至少给一条：能部署时优先平台「部署」，失败 / 中断 / 按请求停止轮给「重试本轮」，其余给「继续」。
 * 没有 turn 记录（升级前的旧会话）或状态不认识的终态也按「继续」兜底；仍在排队 / 运行中时不补。
 * 模型给出选项时仍然会补部署胶囊（方案选择题除外），补不上就原样返回，不抢在模型前面。
 */
export function withReplyFallback(
  result: QuickReplyResult,
  input: { completed: boolean; turnStatus?: string; deploy?: DeployState }
): QuickReplyResult {
  // 模型调用失败但有可挂载的消息 key 时也用平台兜底，别让一轮结束时输入框上方空着。
  const ready: QuickReplyResult = result.state === "unavailable" && result.eventKey
    ? { ...result, state: "ready", replies: [] } : result;
  if (ready.state !== "ready") return ready;
  const deployed = withDeployFallback(ready, input);
  if (deployed !== ready) return deployed;
  if (ready.replies.length) return ready;
  // 还在进行中的轮次不算「结束」：等真正结束后再补，避免运行中冒出可点的下一步。
  if (input.turnStatus && ["queued", "running", "waiting-input"].includes(input.turnStatus)) return ready;
  if (input.turnStatus && ["failed", "interrupted", "unknown", "cancelled"].includes(input.turnStatus)) return { ...ready, replies: [{ ...RETRY_REPLY }] };
  return { ...ready, replies: [{ ...CONTINUE_REPLY }] };
}
