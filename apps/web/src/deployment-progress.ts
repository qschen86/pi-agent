import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeployActivity } from "./deploy-queue.js";

export type DeploymentPhase = "preparing" | "idle" | "waiting" | "switching" | "ready" | "failed";
export interface DeploymentTestPlan {
  mode: "scoped" | "full";
  state: "running" | "passed" | "reused" | "failed";
  files: string[];
  reasons: Array<{ file: string; rule: string }>;
}
/** 叠加预发模式下切换前的节点时间：登记 → 预发检查开始 → 预发完成 */
export interface StagingTimeline { queuedAt?: string; startedAt: string; stagedAt: string }
export interface DeploymentProgress {
  phase: DeploymentPhase;
  since: string;
  sha: string;
  detail: string;
  steps: Array<{ phase: DeploymentPhase; at: string }>;
  sessions: Array<{ id: string; title: string; status: string }>;
  testPlan?: DeploymentTestPlan;
  staging?: StagingTimeline;
}
const phases = new Set(["preparing", "idle", "waiting", "switching", "ready", "failed"]);
export function stagingTimeline(v: any): StagingTimeline | undefined {
  if (!v || !Number.isFinite(Date.parse(v.startedAt)) || !Number.isFinite(Date.parse(v.stagedAt))) return undefined;
  return { ...(Number.isFinite(Date.parse(v.queuedAt)) ? { queuedAt: v.queuedAt } : {}), startedAt: v.startedAt, stagedAt: v.stagedAt };
}
/** Match both request ID and attempt start: retrying a request must not show an old attempt. */
export function deploymentProgress(q: { id: string; startedAt?: string }, root = join(homedir(), ".pi-agent-gui"), activity?: DeployActivity): DeploymentProgress | undefined {
  if (!q.startedAt) return undefined;
  try {
    const p = JSON.parse(readFileSync(join(root, "when-idle", "progress.json"), "utf8"));
    if (!Array.isArray(p.requests) || !p.requests.some((x: any) => x.id === q.id && x.startedAt === q.startedAt) || !phases.has(p.phase) || !Number.isFinite(Date.parse(p.since)) || typeof p.sha !== "string" || !Array.isArray(p.steps)) return undefined;
    let a = activity;
    const listing = p.phase === "idle" || p.phase === "waiting";
    if (!a && listing) {
      try { a = JSON.parse(readFileSync(join(root, ".runtime-drain.json"), "utf8")); } catch { /* Keep the wait reason explicitly unconfirmed. */ }
    }
    const sessions = listing && Array.isArray(a?.active) ? a.active.map(s => ({ id: s.platformSessionId, title: s.title || "未命名会话", status: s.status })) : [];
    const blockers = listing ? [
      ...sessions.map(s => `会话「${s.title}」${s.status === "waiting-input" ? "等待处理" : s.status === "creating" ? "创建中" : s.status === "stopping" ? "停止中" : "运行中"}`),
      a?.pendingApprovals ? `待审批 ${a.pendingApprovals} 项` : "",
      a?.queued ? `已接受的排队消息 ${a.queued} 项` : "",
      a?.dispatching ? `发送中 ${a.dispatching} 项` : "",
      a?.unknownOps ? `结果未知 ${a.unknownOps} 项，等待核对` : ""
    ].filter(Boolean) : [];
    const detail = p.phase === "idle" ? (blockers.length ? `检查与预热已完成，正在等空闲（新会话和新消息照常运行，不排空）：${blockers.join("；")}` : "检查与预热已完成，正在等空闲")
      : p.phase === "waiting" ? (blockers.length ? `检查与预热已完成，正在等待：${blockers.join("；")}` : "检查与预热已完成，正在核对已有任务是否全部结束")
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
    const staging = stagingTimeline(p.staging);
    return { ...(testPlan ? { testPlan } : {}), ...(staging ? { staging } : {}), phase: p.phase, since: p.since, sha: p.sha, detail, sessions,
      steps: p.steps.filter((s: any) => phases.has(s.phase) && Number.isFinite(Date.parse(s.at))).map((s: any) => ({ phase: s.phase, at: s.at })) };
  } catch { return undefined; }
}

export interface RunTimes { startMs: number; endMs: number; waitingMs: number }
/** 一次部署的流程步骤 → 开始 / 结束时刻和「等待会话」占掉的时间（耗时要扣掉它）。统计应用和会话里的部署状态行共用这一份口径。 */
export function runTimes(run: { steps?: Array<{ phase: string; at: string }>; finishedAt?: string; staging?: StagingTimeline }): RunTimes | undefined {
  const steps = (run.steps ?? []).map((s) => ({ phase: s.phase, at: Date.parse(s.at) })).filter((s) => Number.isFinite(s.at));
  if (!steps.length) return undefined;
  // 叠加预发：预发检查是真实耗时，计入开始；预发完成到切换开始之间只是在等，和「等待会话」一样扣掉
  const staging = stagingTimeline(run.staging);
  const stagedStart = staging ? Date.parse(staging.startedAt) : NaN, stagedEnd = staging ? Date.parse(staging.stagedAt) : NaN;
  const startMs = Number.isFinite(stagedStart) ? Math.min(stagedStart, steps[0]!.at) : steps[0]!.at;
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
  const endMs = Number.isFinite(finished) ? finished : steps[steps.length - 1]!.at;
  let waitingMs = Number.isFinite(stagedEnd) ? Math.max(0, steps[0]!.at - stagedEnd) : 0;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.phase !== "waiting" && steps[i]!.phase !== "idle") continue;
    waitingMs += Math.max(0, (steps[i + 1]?.at ?? endMs) - steps[i]!.at);
  }
  return endMs >= startMs ? { startMs, endMs, waitingMs: Math.min(waitingMs, endMs - startMs) } : undefined;
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
    const staging = stagingTimeline(p.staging);
    return { ...(testPlan ? { testPlan } : {}), ...(staging ? { staging } : {}), phase: p.phase, since: p.since, sha: p.sha, sessions: [],
      detail: p.phase === "ready" ? "新版本已上线并通过就绪检查" : p.phase === "failed" ? "本次发布未完成，请查看部署结果" : "部署流程已结束",
      steps: p.steps.filter((s: any) => phases.has(s.phase) && Number.isFinite(Date.parse(s.at))).map((s: any) => ({ phase: s.phase, at: s.at })),
      exitCode: Number.isFinite(p.exitCode) ? p.exitCode : 1,
      finishedAt: Number.isFinite(Date.parse(p.finishedAt)) ? p.finishedAt : p.since };
  } catch { return undefined; }
}
