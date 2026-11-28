/** 自愈修复会话的首条消息：方案、范围护栏、部署约定、收尾格式。 */
import type { Plan } from "./policy.js";
import { SMALL_MAX_FILES } from "./policy.js";
import type { Finding } from "./store.js";

export function fixPrompt(finding: Finding, plan: Plan, deploy: boolean): string {
  const list = (items: string[]) => items.length ? items.map((x, i) => `${i + 1}. ${x}`).join("\n") : "（评估没有给出具体步骤，请先自己核实根因）";
  return [
    `[自愈 · 自动修复] ${plan.title}`,
    "这是平台每晚自愈夜检判定「值得修」的问题。先核实根因（下面的根因只是假设），再按方案修；核实后发现不需要改，就不要提交。",
    `根因（假设）：${plan.rootCause}`,
    plan.impact ? `影响：${plan.impact}` : "",
    `方案：\n${list(plan.proposal)}`,
    `验收：\n${list(plan.acceptance)}`,
    plan.risk ? `已知风险：${plan.risk}` : "",
    "",
    "硬性要求：",
    "- 只在当前 worktree 里改；补一条能复现这个问题的回归测试，跑相关测试并通过后再提交。",
    deploy ? `- 不改变用户可感知的功能、界面、交互和文案；改动控制在 ${SMALL_MAX_FILES} 个文件以内，不碰部署、鉴权登录、持久化存储和会话核心。超出这些范围就停下来，不要提交，在最后说明为什么需要人来处理。`
      : "- 不改变用户可感知的功能、界面、交互和文案；严格按已通过多模型评估的方案与范围修复，不自行扩大范围。需要超出方案时停下来说明，交给人审核。",
    deploy
      ? "- 测试通过并提交后，按仓库约定用 scripts/deploy-gui.sh --when-idle 请求部署（会话内部署），并等部署结果；部署失败就如实说明，不要强行绕过门禁。"
      : "- 提交即可，不要部署：这是较大的改动，上线要等人确认。",
    "- 验收和对外链接一律使用 console.example.com。",
    "",
    "收尾：最后一条消息单独一行写结论，格式 `自愈结果：已修复 | 无需修复 | 需要人处理 — 一句话原因`。",
    `（自愈结论编号 ${finding.id}，来源板块 ${finding.board}）`
  ].join("\n").replace(/\n{3,}/g, "\n\n");
}
