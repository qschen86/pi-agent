import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeployActivity } from "./deploy-queue.js";

export type DeploymentPhase = "preparing" | "waiting" | "switching" | "ready" | "failed";
export interface DeploymentTestPlan {
  mode: "scoped" | "full";
  state: "running" | "passed" | "reused" | "failed";
  files: string[];
  reasons: Array<{ file: string; rule: string }>;
}
export interface DeploymentProgress {
  phase: DeploymentPhase;
  since: string;
  sha: string;
  detail: string;
  steps: Array<{ phase: DeploymentPhase; at: string }>;
  sessions: Array<{ id: string; title: string; status: string }>;
  testPlan?: DeploymentTestPlan;
}
const phases = new Set(["preparing", "waiting", "switching", "ready", "failed"]);
/** Match both request ID and attempt start: retrying a request must not show an old attempt. */
export function deploymentProgress(q: { id: string; startedAt?: string }, root = join(homedir(), ".pi-agent-gui"), activity?: DeployActivity): DeploymentProgress | undefined {
  if (!q.startedAt) return undefined;
  try {
    const p = JSON.parse(readFileSync(join(root, "when-idle", "progress.json"), "utf8"));
    if (!Array.isArray(p.requests) || !p.requests.some((x: any) => x.id === q.id && x.startedAt === q.startedAt) || !phases.has(p.phase) || !Number.isFinite(Date.parse(p.since)) || typeof p.sha !== "string" || !Array.isArray(p.steps)) return undefined;
    let a = activity;
    if (!a && p.phase === "waiting") {
      try { a = JSON.parse(readFileSync(join(root, ".runtime-drain.json"), "utf8")); } catch { /* Keep the wait reason explicitly unconfirmed. */ }
    }
    const sessions = p.phase === "waiting" && Array.isArray(a?.active) ? a.active.map(s => ({ id: s.platformSessionId, title: s.title || "未命名会话", status: s.status })) : [];
    const blockers = p.phase === "waiting" ? [
      ...sessions.map(s => `会话「${s.title}」${s.status === "waiting-input" ? "等待处理" : s.status === "creating" ? "创建中" : s.status === "stopping" ? "停止中" : "运行中"}`),
      a?.pendingApprovals ? `待审批 ${a.pendingApprovals} 项` : "",
      a?.queued ? `已接受的排队消息 ${a.queued} 项` : "",
      a?.dispatching ? `发送中 ${a.dispatching} 项` : "",
      a?.unknownOps ? `结果未知 ${a.unknownOps} 项，等待核对` : ""
    ].filter(Boolean) : [];
    const detail = p.phase === "waiting" ? (blockers.length ? `检查与预热已完成，正在等待：${blockers.join("；")}` : "检查与预热已完成，正在核对已有任务是否全部结束")
      : p.phase === "preparing" ? "正在检查与准备候选版本，当前线上服务继续运行"
      : p.phase === "switching" ? "正在切换服务并核对新版本是否就绪"
      : p.phase === "ready" ? "新版本已上线并通过就绪检查" : "本次发布未完成，请查看部署结果";
    let testPlan: DeploymentTestPlan | undefined;
    const t = p.testPlan;
    if (t && ["scoped", "full"].includes(t.mode) && ["running", "passed", "reused", "failed"].includes(t.state) && Array.isArray(t.files) && Array.isArray(t.reasons)) {
      testPlan = { mode: t.mode, state: t.state,
        files: t.files.filter((f: unknown) => typeof f === "string" && f.length <= 2048).slice(0, 1000),
        reasons: t.reasons.filter((r: any) => r && typeof r.file === "string" && typeof r.rule === "string" && r.file.length <= 2048 && r.rule.length <= 2048).slice(0, 1000).map((r: any) => ({ file: r.file, rule: r.rule })) };
    }
    return { ...(testPlan ? { testPlan } : {}), phase: p.phase, since: p.since, sha: p.sha, detail, sessions,
      steps: p.steps.filter((s: any) => phases.has(s.phase) && Number.isFinite(Date.parse(s.at))).map((s: any) => ({ phase: s.phase, at: s.at })) };
  } catch { return undefined; }
}

export interface DeploymentRun extends DeploymentProgress {
  /** 部署脚本退出码；0 = 脚本认为成功 */
  exitCode: number;
  finishedAt: string;
}
/**
 * 守候进程在每次部署结束时按提交存档的流程步骤（when-idle/runs/<短 sha>.json）。
 * 部署结果通知用它在结束后回看各阶段耗时；没有存档（旧部署）时返回 undefined。
 */
export function readDeploymentRun(sha: string, root = process.env["PI_AGENT_GUI_ROOT"] ?? join(homedir(), ".pi-agent-gui")): DeploymentRun | undefined {
  if (!/^[a-f0-9]{7,40}$/i.test(sha)) return undefined;
  try {
    const p = JSON.parse(readFileSync(join(root, "when-idle", "runs", `${sha.slice(0, 7).toLowerCase()}.json`), "utf8"));
    if (!phases.has(p.phase) || typeof p.sha !== "string" || !p.sha.toLowerCase().startsWith(sha.slice(0, 7).toLowerCase()) || !Array.isArray(p.steps) || !Number.isFinite(Date.parse(p.since))) return undefined;
    let testPlan: DeploymentTestPlan | undefined;
    const t = p.testPlan;
    if (t && ["scoped", "full"].includes(t.mode) && ["running", "passed", "reused", "failed"].includes(t.state) && Array.isArray(t.files) && Array.isArray(t.reasons)) {
      testPlan = { mode: t.mode, state: t.state,
        files: t.files.filter((f: unknown) => typeof f === "string" && f.length <= 2048).slice(0, 1000),
        reasons: t.reasons.filter((r: any) => r && typeof r.file === "string" && typeof r.rule === "string" && r.file.length <= 2048 && r.rule.length <= 2048).slice(0, 1000).map((r: any) => ({ file: r.file, rule: r.rule })) };
    }
    return { ...(testPlan ? { testPlan } : {}), phase: p.phase, since: p.since, sha: p.sha, sessions: [],
      detail: p.phase === "ready" ? "新版本已上线并通过就绪检查" : p.phase === "failed" ? "本次发布未完成，请查看部署结果" : "部署流程已结束",
      steps: p.steps.filter((s: any) => phases.has(s.phase) && Number.isFinite(Date.parse(s.at))).map((s: any) => ({ phase: s.phase, at: s.at })),
      exitCode: Number.isFinite(p.exitCode) ? p.exitCode : 1,
      finishedAt: Number.isFinite(Date.parse(p.finishedAt)) ? p.finishedAt : p.since };
  } catch { return undefined; }
}
