/**
 * 「点升级」生成的会话方案：Pi 和 Claude Code 互相升级——升级谁，就由对方 runtime 开一个会话来执行
 * （Pi 不会在自己运行的过程中替换自己的二进制，Claude 也一样）；Antigravity（agy）由 Claude Code 执行。Codex 随 ChatGPT.app 更新，不在这里。
 * 这里只产出新建会话要用的参数和首条消息；真正建会话走设置页里已有的新建会话流程（档位、权限、部署排队都沿用）。
 */
import type { AnalysisRecord } from "./store.js";
import type { UpdateKind } from "./sources.js";

export type UpgradeExecutor = "pi" | "claude-code";
/** 升级谁 → 由谁来执行 */
export const UPGRADE_EXECUTOR: Partial<Record<UpdateKind, UpgradeExecutor>> = { pi: "claude-code", "claude-code": "pi", antigravity: "claude-code" };

export interface UpgradePlan {
  target: UpdateKind; from: string; to: string;
  executor: UpgradeExecutor; workspace: string; title: string; prompt: string;
  /** 执行方的权限与工作方式：Pi 升级要写全局 npm 目录，需要不受工作区限制；Claude 升级是代码改动，放进独立 worktree */
  permissionMode: string; worktree: boolean;
}

const DEPLOY_RULES = "线上核查只用 console.example.com；有进行中的会话时用 `scripts/deploy-gui.sh --when-idle`，不要 --force。";

function context(analysis: AnalysisRecord | null, breaking: string[]): string {
  const lines: string[] = [];
  if (breaking.length) lines.push("【更新日志里的破坏性变更，需要逐条核对平台是否受影响】", ...breaking.map((b) => `- ${b}`));
  const v = analysis?.value;
  if (v) {
    lines.push("", `【平台上次的 AI 分析：${{ upgrade: "建议升级", wait: "建议观望", skip: "暂不升级" }[v.verdict]}】${v.reason}`);
    if (v.risks.length) lines.push("风险：", ...v.risks.map((r) => `- ${r.title}：${r.detail}`));
    if (v.compat.length) lines.push("要兼容的：", ...v.compat.map((c) => `- ${c.what}：${c.action}`));
    if (v.testPlan.length) lines.push("建议的验证：", ...v.testPlan.map((t) => `- ${t}`));
  }
  return lines.join("\n");
}

export function buildUpgradePlan(input: {
  target: "pi" | "claude-code" | "antigravity"; from: string; to: string; workspace: string; analysis: AnalysisRecord | null; breaking: string[];
}): UpgradePlan {
  const { target, from, to } = input;
  const extra = context(input.analysis, input.breaking);
  const subject = target === "pi" ? "Pi CLI（@earendil-works/pi-coding-agent）" : target === "antigravity" ? "Antigravity CLI（agy）" : "Claude Agent SDK（@anthropic-ai/claude-agent-sdk）";
  const header = `你是执行者：把 pi-agent 平台依赖的 ${subject} 从 ${from} 升级到 ${to}。用户已在「设置 → 运行时更新」点了升级，这就是授权，不用再逐步确认。你运行在${target === "pi" || target === "antigravity" ? "Claude Code" : "Pi"}上，不是被升级的对象，所以可以直接操作它。`;
  if (target === "antigravity") {
    const bak = `/tmp/agy-${from}-backup`;
    const prompt = [
      header, "",
      "agy 是单个二进制（通常在 ~/.local/bin/agy），不走 npm，升级后不用改代码也不用部署。任何一步失败就走回滚，不要留下半成品。步骤：",
      `1. 记下现状：which agy、agy --version（应为 ${from}），把它备份：cp -p "$(which agy)" ${bak}`,
      `2. 升级：agy update；再 agy --version 核对是否为 ${to}。不是（比如发布清单比推送先到）就回滚并汇报，不要反复重试。agy update 不可用时的兜底：mv 现有二进制到备份名，再跑 curl -fsSL https://antigravity.google/cli/install.sh | bash（安装脚本会校验 sha512，已有二进制时它会直接退出，所以要先挪走）`,
      "3. 验证：agy -p /usage --output-format json 应返回 status=SUCCESS、command.name=usage（平台额度解析 parseAntigravityQuota 依赖它）；再跑 npx vitest run packages/runtime-sessions/test/antigravity.test.ts packages/runtime-sessions/test/antigravity-continuation.test.ts apps/web/test/runtime-antigravity-check.test.ts（工作目录是 pi-agent 仓库，缺依赖先 npm ci --ignore-scripts）",
      "4. 平台依赖的 ACP 面也要核对：agy acp 能握手、session/new 返回会话 ID、session/resume 可用（可以直接用平台的探针，见第 6 步）；对照下面的更新日志有没有改 acp、/usage、会话库（steps 指纹）的条目",
      `5. 任何一步失败或版本不对：用 mv 把备份换回去（先 cp ${bak} "$(dirname "$(which agy)")/agy.restore" 再 mv 覆盖；不要原地 cp 覆盖，macOS 上会让二进制签名失效），再 agy --version 确认回到 ${from}，把失败的命令和输出原样汇报`,
      "6. 全部通过后尝试 curl -s -X POST http://127.0.0.1:8780/api/runtime-profiles/antigravity/probe 刷新平台的 Antigravity 检查；调不通就在汇报里提醒用户到「设置 → 运行时配置」点「检查」",
      "",
      "不要改仓库代码、不要提交、不要部署；已经在跑的 agy 进程不用杀，它们空闲 10 分钟会自己退出，下一轮会话才用新版。结束时用几行汇报：版本变化、验证结果、是否需要用户后续动作。",
      extra ? `\n${extra}` : ""
    ].join("\n").trimEnd();
    return { target, from, to, executor: "claude-code", workspace: input.workspace, title: `升级 Antigravity ${from} → ${to}`, prompt, permissionMode: "bypassPermissions", worktree: false };
  }
  if (target === "pi") {
    const pkg = "@earendil-works/pi-coding-agent", tmp = `/tmp/pi-${to}`;
    const prompt = [
      header, "",
      "任何一步失败就停下，不要替换全局版本，把失败的命令和输出原样汇报。步骤：",
      `1. 临时前缀试装：npm i -g --prefix ${tmp} ${pkg}@${to}`,
      `2. 用候选版跑兼容测试（工作目录是 pi-agent 仓库，缺依赖先 npm ci --ignore-scripts）：PI_BIN=${tmp}/bin/pi PATH=${tmp}/bin:$PATH PI_SANDBOX_PARITY=1 npx vitest run packages/runtime-sessions/test/pi-sandbox-parity-live.test.ts tests/replay/pi-replay-capture.test.ts，再用同样的 PI_BIN/PATH 跑全量测试`,
      `3. 确认 ${tmp}/lib/node_modules/${pkg}/dist 下 core/agent-session.js、cli/args.js、modes/rpc/rpc-types.d.ts 还在（PiDriver 探针依赖这三个文件），探针标记没变`,
      `4. 全部通过再替换全局版本：npm i -g ${pkg}@${to}；用 pi --version 核对`,
      `5. 替换后如果 pi 起不来或版本不对，立刻回滚：npm i -g ${pkg}@${from}`,
      "6. 尝试 curl -s -X POST http://127.0.0.1:8780/api/runtime-profiles/pi/probe 刷新平台的 Pi 检查；调不通就在汇报里提醒用户到「设置 → 运行时配置」点「检查」。Pi 评测资格需要重新验收，也提一句",
      "",
      "不要改仓库代码、不要提交、不要部署。结束时用几行汇报：测试结果、最终版本、是否需要用户后续动作。",
      extra ? `\n${extra}` : ""
    ].join("\n").trimEnd();
    return { target, from, to, executor: "claude-code", workspace: input.workspace, title: `升级 Pi ${from} → ${to}`, prompt, permissionMode: "bypassPermissions", worktree: false };
  }
  const prompt = [
    header, "",
    "这是一次代码改动加部署。步骤，任何一步失败就停下汇报，不要部署：",
    `1. 把 packages/runtime-sessions/package.json 里的 @anthropic-ai/claude-agent-sdk 改为精确版本 ${to}，npm install，确认 lock 文件只变这一项相关内容`,
    "2. 对照下面的破坏性变更与 apps/web/src/runtime-updates/analysis.ts 里的 COMPAT_NOTES，检查 packages/runtime-sessions/src/claude.ts 的 query 选项、hooks、消息帧处理；需要适配的改掉",
    "3. 跑 runtime-sessions 测试和 apps/web 测试，类型检查通过；有条件就做一次 Claude 真实会话冒烟（含插话）",
    "4. 提交，走平台的部署流程（会话页「空闲时部署」或 scripts/deploy-gui.sh --when-idle）。部署前先核对线上提交已在 main 里，不在就先合并。" + DEPLOY_RULES,
    "5. 部署完成后确认「设置 → 运行时配置」里 Claude 的 SDK 版本已是 " + to + "（点「检查」）",
    "",
    "涉及 runtime 的平台依赖有变化时，同步更新 COMPAT_NOTES。结束时用几行汇报：测试结果、是否已部署、需要用户后续动作。",
    extra ? `\n${extra}` : ""
  ].join("\n").trimEnd();
  return { target, from, to, executor: "pi", workspace: input.workspace, title: `升级 Claude SDK ${from} → ${to}`, prompt, permissionMode: "pi-ask", worktree: true };
}
