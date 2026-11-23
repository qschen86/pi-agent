import { createDeployReadCommands, planDeployRead } from "./deploy-read-commands.js";
import { isFunctionalDeployPath, NO_FUNCTIONAL_DEPLOY_CHANGES } from "./deploy-code-changes.js";
import { deploymentActionsSupported } from "../../../scripts/deployment-actions.mjs";
import { deploymentProgress, readDeploymentRun, runTimes, stagingTimeline, type DeploymentProgress, type StagingTimeline } from "./deployment-progress.js";
/**
 * 会话页「空闲时部署」：由 Web 服务登记部署请求，不依赖会话里的命令越出 runtime 沙箱，
 * 所以 Claude、Codex、Pi 的会话都能用。排队、守候、部署与回发结果复用 scripts/deploy-when-idle.mjs
 * （与 `deploy-gui.sh --when-idle` 同一套请求目录和守候进程）。
 *
 * 只对工作目录属于 pi-agent 仓库（同一个 git 公共目录，含它的 worktree）的会话开放。两种会话：
 * - worktree：创建时勾选了独立 worktree。改动全属于这个会话，「提交并在空闲时部署」由宿主提交、变基到 main 最新提交，
 *   再登记部署会话分支上的这个提交。main 不在这里前移：守候进程部署成功（门禁通过、线上就是它）后才把 main 快进过去，
 *   部署失败 main 不动，没通过门禁的提交不会进 main。会话还在运行时不提交（避免提交到一半写的文件）。
 * - shared：直接在共享的仓库目录里改。那里混着别的会话的未提交改动，不能替它提交；只能部署 main 上已有的提交。
 * 两种都要求 main 与确认框里显示的一致；守候进程在部署前自动集成最新 main、线上与请求提交。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { commitSessionWorktree, rebaseSessionWorktree, RuntimeError, sessionWorktreeStatus, sessionWorktreeDeployPaths, type SessionBinding, type WorktreeStatus } from "@pi-agent/runtime-sessions";
import { enqueueRollback, cancelRequest, clearAutoResolve, enqueue, isAncestor, readAutoResolve, readBaselineRed, baselineRedForRequest, baselineRedWait, readStaged, BASELINE_RED_COOLDOWN_MS, readRequests, watcherPid, whenIdleDirs, writeAutoResolve, type AutoResolveState, type BaselineRedState, type WhenIdleRequest } from "../../../scripts/deploy-when-idle.mjs";
import { readLatestDeployForSession, type DeployHistoryEntry } from "./deploy-history.js";

export type { AutoResolveState };

/** 登记时变基到 main 冲突：带上冲突文件与会话分支当前提交，供冲突自动解决使用 */
export class DeployConflictError extends RuntimeError {
  constructor(message: string, readonly conflicts: string[], readonly head: string, readonly committed?: string) { super(message, 409, "RT_DEPLOY_CONFLICT"); }
}

export interface DeployRequestView {
  id: string; sha: string; subject: string; requestedAt: string; startedAt?: string; notifySession: string | null;
  progress?: DeploymentProgress;
  action?: "rollback"; expectedLive?: string;
  /** 发起部署的会话 runtime（旧请求没有） */
  runtimeKind?: string;
  /** 部署成功后要快进到这个提交的分支（worktree 会话的请求） */
  ffBranch?: string;
  /** 叠加预发模式：页面按「1排队 → 2预发检查 → 3待切换 → 4切换上线」显示；stage 区分已开始的是预发检查还是切换 */
  staging?: boolean; stage?: "staging" | "cutover";
  /** 叠加预发：本请求的登记 / 预发检查 / 预发完成时刻（进度弹窗按节点算耗时） */
  timeline?: StagingTimeline;
  /** 还在排队时：它在等什么（与守候进程的空闲判定同口径） */
  wait?: DeployWait;
}
/** 守候进程判断空闲用的服务端活动（manager.activity() 的子集） */
export interface DeployActivity {
  draining?: boolean;
  active?: Array<{ platformSessionId: string; title: string; status: string }>;
  pendingApprovals?: number; queued?: number; dispatching?: number; unknownOps?: number;
}
/**
 * 排队中的请求卡在哪：
 * - deploying：另一个请求正在部署；ahead：前面还有更早的请求要先部署；
 * - sessions：有会话在跑；busy：审批、排队消息、结果未知、部署锁、vitest 等；
 * - ready：已经空闲，守候进程下一次检查就开始；watcher：守候进程没在运行，不会处理；
 * - baseline-red：门禁发现失败的测试线上版本同样红（主线坏了，不是这次改动），请求保持排队等修复。
 * 叠加预发模式（env.staged 有值；守候进程见 scripts/deploy-when-idle.mjs planStaging）：集成与测试不等会话，
 * - staged：已叠加进待切换的版本，等对话结束后一次切换；skipped：叠加时没通过，切换后以新线上版本重试；
 * - 其余排队的只会等前面的请求、另一次部署（排空、锁）或主线红，不再等会话。
 */
export interface DeployWait {
  kind: "deploying" | "ahead" | "sessions" | "busy" | "ready" | "watcher" | "baseline-red" | "staged" | "skipped";
  /** 头部标签里的短语（几个字，不能放长句） */
  short: string;
  /** 完整说明（悬停提示、输入框上方的说明行） */
  detail: string;
  /** kind = sessions：在等的会话 */
  sessions?: Array<{ id: string; title: string; status: string }>;
}
export interface DeployInfo {
  eligible: boolean;
  actionsSupported?: boolean;
  rollback?: { sha: string; live: string; subject: string };
  /** 不能用时的原因 */
  reason?: string;
  blockedCode?: "RT_DEPLOY_MAIN" | "RT_DEPLOY_NO_CODE" | "RT_DEPLOY_DIFF_UNAVAILABLE";
  branch: string;
  mode?: "worktree" | "shared";
  /** shared：为什么这个会话的改动不会自动进 main */
  note?: string;
  main?: { sha: string; subject: string };
  live?: { sha: string; subject: string };
  /** 线上提交在主分支历史里（不在时由守候进程自动集成） */
  liveInMain?: boolean;
  /** worktree 会话：未提交的改动、相对 main 的领先 / 落后提交数 */
  worktree?: { path: string; branch: string } & WorktreeStatus;
  /** 全部排队中的请求（不只这个会话的） */
  requests: DeployRequestView[];
  /** 这个会话的冲突自动解决状态（见 deploy-auto-resolve.ts） */
  autoResolve?: AutoResolveState;
  watcherRunning: boolean;
  /** 最近一次结束的部署（接口补上；结果通知还没发回会话时，详情页先用它把「部署中」更新成成功 / 失败） */
  last?: DeployHistoryEntry;
}
type DeploySession = Pick<SessionBinding, "platformSessionId" | "workspace" | "status" | "title" | "worktree"> & { runtimeKind?: string };
export interface DeployResult { request: DeployRequestView; committed?: string; rebased?: boolean; /** 变基时自动解决的 index.html 资源版本号冲突块数 */ autoResolvedAssets?: number }
export interface DeployQueue {
  /** activity：服务端当前活动；给了就为排队中的请求标出在等什么（wait） */
  info(session: DeploySession, activity?: DeployActivity): Promise<DeployInfo>;
  /** auto：冲突自动解决后由平台重新登记（不清掉已自动处理的次数）；人点按钮时清掉，重新开始计数 */
  request(input: { session: DeploySession; expectedSha: string; message?: string; auto?: boolean }): Promise<DeployResult>;
  autoResolveState(platformSessionId: string): AutoResolveState | undefined;
  /**
   * 排队状态的指纹：请求的增删、开始部署（startedAt）、冲突自动解决状态的变化都会改变它。
   * 守候进程是另一个进程，只改文件；Web 服务轮询它，变了就推「目录已变」，让列表、头部、快捷回复同时更新。
   */
  signature(): string;
  saveAutoResolve(state: Omit<AutoResolveState, "at">): AutoResolveState;
  clearAutoResolve(platformSessionId: string): void;
  cancel(id: string): DeployRequestView;
  rollback(input: { session: DeploySession; expectedLive: string; expectedSha: string }): Promise<DeployResult>;
  /** 这个会话最近一次结束的部署（同一个 root 的 history.log） */
  lastDeploy(platformSessionId: string): DeployHistoryEntry | undefined;
  /** 这个会话排队中或部署中、提交还只在会话分支上的请求（归档会删掉分支，要先等它结束） */
  branchDeployOf(platformSessionId: string): DeployRequestView | undefined;
  /** 每个请求方会话当前排队 / 部署中的请求（会话列表据此标「待部署 / 部署中」）；同一会话有多条时优先正在部署的那条，否则取最早排队的 */
  byNotifySession(activity?: DeployActivity): Promise<Map<string, DeployRequestView>>;
}

const ACTIVE = ["creating", "running", "waiting-input", "stopping"];
const SHARED_NOTE = "这个会话直接在共享的仓库目录里改：那里混着别的会话的未提交改动，而且不一定在 main 分支上，所以它的改动不会自动进 main，这里只能部署 main 上已有的提交。要让会话的改动能一键提交并部署，新建会话时勾选「独立 worktree」。";

const git = (cwd: string, ...args: string[]): string | undefined => {
  try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim(); }
  catch { return undefined; }
};
const commonDir = (dir: string): string | undefined => {
  const d = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  try { return d ? realpathSync(d) : undefined; } catch { return undefined; }
};
const view = (q: Omit<WhenIdleRequest, "file">): DeployRequestView => ({
  ...(q.action ? { action: q.action, expectedLive: q.expectedLive } : {}),
  id: q.id, sha: q.sha, subject: q.subject ?? "", requestedAt: q.requestedAt, notifySession: q.notifySession,
  ...(q.runtimeKind ? { runtimeKind: q.runtimeKind } : {}),
  ...(q.startedAt ? { startedAt: q.startedAt } : {}), ...(q.ffBranch ? { ffBranch: q.ffBranch } : {})
});

const STATUS_ZH: Record<string, string> = { creating: "创建中", running: "运行中", "waiting-input": "等输入", stopping: "停止中" };
/** 按显示宽度截短（中文算 2，英文算 1），头部标签放不下长标题 */
const clip = (t: string, width: number): string => {
  const a = [...(t || "").trim()];
  if (!a.length) return "未命名会话";
  let w = 0, i = 0;
  for (; i < a.length; i++) { w += /[\u0000-\u00ff]/.test(a[i]!) ? 1 : 2; if (w > width) break; }
  return i < a.length ? `${a.slice(0, i).join("").trimEnd()}…` : a.join("");
};
const sha7 = (sha: string): string => sha.slice(0, 7);

/**
 * 给排队中的请求标出它在等什么。与守候进程同口径（scripts/deploy-when-idle.mjs 的 watch / busyReasons / planDeploy）：
 * 有请求正在部署时其它都等它；next 是守候进程下一次要部署的请求（planDeploy 的 covered + 已在线上的），
 * 不在 next 里的要等前面更早的请求；轮到它了就看空闲判定还差什么。
 */
export function deployWaits(requests: DeployRequestView[], env: { activity: DeployActivity; vitest: number; locked: boolean; watcherRunning: boolean; next: Set<string>; baselineRed?: ReadonlyMap<string, Pick<BaselineRedState, "files"> & { at?: string }>; staged?: { ids: Set<string>; skipped: Map<string, string> } }): Map<string, DeployWait> {
  const out = new Map<string, DeployWait>();
  const started = requests.find((q) => q.startedAt);
  const st = env.staged;
  const pool = requests.filter(q => !q.startedAt && !env.baselineRed?.has(q.id) && !st?.ids.has(q.id) && !st?.skipped.has(q.id));
  const first = st ? pool[0] : requests.find((q) => !q.startedAt && env.next.has(q.id));
  const a = env.activity;
  for (const [i, q] of requests.entries()) {
    if (q.startedAt) continue;
    if (!env.watcherRunning) { out.set(q.id, { kind: "watcher", short: "部署服务未运行", detail: "部署守候进程没在运行，排队的请求暂时不会被处理（需要在本机重新安装部署服务：scripts/install-gui-control.mjs）" }); continue; }
    if (st?.ids.has(q.id)) { out.set(q.id, { kind: "staged", short: "已预发·待切换", detail: "已在备用槽位集成并通过检查，线上未改动；等在跑的对话结束后，和其他已预发的请求一次切换上线" }); continue; }
    if (st?.skipped.has(q.id)) { out.set(q.id, { kind: "skipped", short: "预发失败·待重试", detail: `叠加到待切换版本时没通过（${st.skipped.get(q.id)}）；已预发的请求上线后，会以新的线上版本为基线重试一次` }); continue; }
    const red = env.baselineRed?.get(q.id);
    if (red) {
      const files = red.files;
      const until = red.at ? Date.parse(red.at) + BASELINE_RED_COOLDOWN_MS : NaN;
      const retry = Number.isFinite(until) ? `约 ${Math.max(1, Math.ceil((until - Date.now()) / 60000))} 分钟后` : "冷却结束后";
      out.set(q.id, { kind: "baseline-red", short: "主线测试红", detail: `门禁里${files.length ? `这些测试（${files.slice(0, 3).join("、")}${files.length > 3 ? ` 等 ${files.length} 个` : ""}）` : "有测试"}在线上版本上同样不过，所以不判部署失败。此请求将在基线变化或${retry}自动重试，其他请求可继续预发` });
      continue;
    }
    if (started) { out.set(q.id, { kind: "deploying", short: `等 ${sha7(started.sha)} 部署完`, detail: `${sha7(started.sha)}（${started.subject}）正在部署（集成、测试、切换），它结束后再处理这个请求` }); continue; }
    if (st ? q !== first : !env.next.has(q.id)) {
      const ahead = st ? pool.indexOf(q) : requests.slice(0, i).filter(request => !env.baselineRed?.has(request.id)).length || 1;
      out.set(q.id, { kind: "ahead", short: `前面还有 ${ahead} 个`, detail: `前面还有 ${ahead} 个更早的部署请求${first ? `（下一个是 ${sha7(first.sha)}：${first.subject}）` : ""}，它们部署完再轮到这个` });
      continue;
    }
    if (st) {
      const other = a.draining ? ["等另一次部署", "服务正处于另一次部署的排空中"] : env.locked ? ["等部署锁", "部署锁被占用（另一次部署正在进行）"] : undefined;
      out.set(q.id, other ? { kind: "busy", short: other[0]!, detail: `${other[1]}，结束后开始集成与测试` } : { kind: "ready", short: "即将预发", detail: "集成与测试不用等对话结束，守候进程下一次检查（约 10 秒内）就在备用槽位开始；通过后等对话结束一次切换" });
      continue;
    }
    const sessions = (a.active ?? []).map((s) => ({ id: s.platformSessionId, title: s.title, status: s.status }));
    const others = [
      a.draining ? ["等另一次部署", "服务正处于另一次部署的排空中"] : null,
      a.pendingApprovals ? ["等审批", `待审批 ${a.pendingApprovals} 项`] : null,
      a.unknownOps ? ["等结果未知的操作", `结果未知的操作 ${a.unknownOps} 项（进程结束或核对后才会放行）`] : null,
      a.queued || a.dispatching ? ["等消息发出", [a.queued ? `排队的消息 ${a.queued} 项` : "", a.dispatching ? `发送中 ${a.dispatching} 项` : ""].filter(Boolean).join("、")] : null,
      env.locked ? ["等部署锁", "部署锁被占用（另一次部署正在进行）"] : null,
      env.vitest ? ["等测试进程", `${env.vitest} 个 vitest 进程在跑`] : null
    ].filter((x): x is [string, string] => !!x);
    if (!sessions.length && !others.length) { out.set(q.id, { kind: "ready", short: "即将开始", detail: "现在已经空闲，守候进程下一次检查（约半分钟内）就会开始部署" }); continue; }
    const parts = [...sessions.map((s) => `会话「${s.title || "未命名会话"}」${STATUS_ZH[s.status] ?? s.status}${s.id === q.notifySession ? "（就是这个会话，这一轮结束后）" : ""}`), ...others.map((x) => x[1])];
    const detail = `要等这些结束后才开始部署：${parts.join("；")}`;
    if (sessions.length) {
      const only = sessions.length === 1 ? sessions[0]! : undefined;
      const short = only ? (only.id === q.notifySession ? "等这一轮结束" : `等「${clip(only.title, 12)}」`) : `等 ${sessions.length} 个会话`;
      out.set(q.id, { kind: "sessions", short, detail, sessions });
    } else out.set(q.id, { kind: "busy", short: others[0]![0], detail });
  }
  return out;
}

/** 线上服务从 ~/.pi-agent-gui/slots/<槽位> 运行（PI_AGENT_GUI_ROOT 可改根目录） */
export function isDeployedSlot(cwd: string, root = process.env["PI_AGENT_GUI_ROOT"] || join(homedir(), ".pi-agent-gui")): boolean {
  try { return realpathSync(cwd).startsWith(realpathSync(join(root, "slots")) + "/"); } catch { return false; }
}

/**
 * 主仓库：线上槽位是从它克隆的（origin 指向本机路径）；开发时直接在仓库里跑则取当前目录的 git 公共目录。
 */
export function resolveRepo(cwd = process.cwd()): string | undefined {
  if (process.env["PI_AGENT_REPO"]) return process.env["PI_AGENT_REPO"];
  const origin = git(cwd, "remote", "get-url", "origin");
  if (origin && isAbsolute(origin) && existsSync(join(origin, ".git"))) return origin;
  const c = commonDir(cwd);
  return c ? dirname(c) : undefined;
}

export function createDeployQueue(opts: { repo?: string; root?: string; branch?: string; startWatcher?: boolean } = {}): DeployQueue {
  const repo = opts.repo ?? resolveRepo();
  const branch = opts.branch ?? "main";
  const root = opts.root ?? process.env["PI_AGENT_GUI_ROOT"] ?? join(homedir(), ".pi-agent-gui");
  const repoCommon = repo ? commonDir(repo) : undefined;
  const reads = createDeployReadCommands();
  const eligibleCache = new Map<string, boolean>();
  const inRepo = async (workspace: string): Promise<boolean> => {
    let ok = eligibleCache.get(workspace);
    if (ok === undefined) { ok = !!repoCommon && await reads.commonDir(workspace) === repoCommon; eligibleCache.set(workspace, ok); }
    return ok;
  };
  // 提交、变基、登记要一个接一个：同时点两次不能提交两份
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = chain.then(fn, fn); chain = next.catch(() => undefined); return next; };

  /** 给排队中的请求标上 wait；没有活动信息（老调用方）就原样返回 */
  const annotate = async (raw: WhenIdleRequest[], activity?: DeployActivity): Promise<DeployRequestView[]> => {
    let requests = raw.map(q => ({ ...view(q), ...(q.startedAt ? { progress: deploymentProgress(q, root, activity) } : {}) }));
    // 已安装的部署脚本支持 --stage-only 才是叠加预发模式（守候进程与脚本一起安装）
    let stagingMode = false;
    try { stagingMode = readFileSync(join(root, "control", "deploy-gui.sh"), "utf8").includes("--stage-only"); } catch { /* 没装控制器 */ }
    const stagedState = stagingMode ? readStaged(root) : undefined;
    const staged = stagingMode ? { ids: new Set(stagedState?.ids ?? []), skipped: new Map(Object.entries(stagedState?.skipped ?? {}).map(([id, v]) => [id, v.detail])) } : undefined;
    const confirmedLive = requests.some(q => q.progress?.phase === "ready") ? await reads.live(root) : undefined;
    if (staged) requests = requests.map((q) => {
      const stage = q.startedAt ? (staged.ids.has(q.id) ? "cutover" as const : "staging" as const) : undefined;
      const progress = q.progress?.phase === "ready" && confirmedLive !== q.progress.sha
        ? { ...q.progress, phase: "preparing" as const, detail: "预发检查已通过，等待切换，当前线上服务继续运行", steps: q.progress.steps.filter(step => step.phase !== "ready") }
        : q.progress;
      const timeline = stagingTimeline({ queuedAt: q.requestedAt, ...stagedState?.timeline?.[q.id] });
      return { ...q, staging: true, ...(stage ? { stage } : {}), ...(timeline ? { timeline } : {}), ...(progress ? { progress } : {}) };
    });
    if (!activity || !requests.some((q) => !q.startedAt)) return requests;
    const live = await reads.live(root);
    const legacy = readBaselineRed(root);
    const base = stagedState?.live === live ? stagedState?.sha ?? live : live;
    const baselineRed = new Map<string, BaselineRedState>();
    await Promise.all(raw.map(async q => {
      const state = !q.startedAt && !staged?.ids.has(q.id) ? baselineRedForRequest(q, legacy) : undefined;
      if (!state || state.live !== live || !repo || q.repo !== repo) return;
      const branchTip = await reads.git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${q.ffBranch ?? "main"}^{commit}`);
      const wait = baselineRedWait(q, state, { live, base, branchTip });
      if (wait) baselineRed.set(q.id, wait);
    }));
    const eligible = requests.filter(q => !baselineRed.has(q.id));
    let next: Set<string>;
    try {
      const plan = repo ? await planDeployRead(eligible, live, (a, b) => reads.ancestor(repo, a, b)) : undefined;
      next = new Set(plan ? [...plan.done, ...plan.covered].map((q) => q.id) : eligible.slice(0, 1).map((q) => q.id));
    } catch { next = new Set(eligible.slice(0, 1).map((q) => q.id)); }
    const waits = deployWaits(requests, { ...(staged ? { staged } : {}), activity, vitest: await reads.vitestCount(), locked: existsSync(join(whenIdleDirs(root).root, ".deploy.lock")), watcherRunning: !!watcherPid(root), next, baselineRed });
    return requests.map((q) => { const w = waits.get(q.id); return w ? { ...q, wait: w } : q; });
  };

  const info = async (s: DeploySession, activity?: DeployActivity): Promise<DeployInfo> => {
    const requests = await annotate(readRequests(root), activity);
    const auto = readAutoResolve(s.platformSessionId, root);
    const base = { actionsSupported: deploymentActionsSupported(root), branch, requests, watcherRunning: !!watcherPid(root), ...(auto ? { autoResolve: auto } : {}) };
    if (!repo || !repoCommon) return { ...base, eligible: false, reason: "找不到 pi-agent 主仓库，无法从页面部署" };
    const wt = s.worktree;
    // worktree 会话按创建时宿主记下的仓库根判断，不在会话目录里跑 git（那会读会话能改写的 `.git` 文件）
    if (!await (wt ? inRepo(wt.repoRoot) : inRepo(s.workspace))) return { ...base, eligible: false, reason: "这个会话的工作目录不在 pi-agent 仓库里" };
    if (wt && wt.baseRef !== branch) return { ...base, eligible: false, reason: `这个会话的 worktree 是从 ${wt.baseRef} 切出的，不是 ${branch}` };
    if (wt?.removedAt) return { ...base, eligible: false, reason: "这个会话的 worktree 已在归档时删除" };
    const mainSha = await reads.git(repo, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`);
    if (!mainSha) return { ...base, eligible: false, reason: `仓库里没有 ${branch} 分支` };
    const live = await reads.live(root);
    const common = {
      ...base, eligible: true, rollback: await reads.rollbackTarget(root),
      main: { sha: mainSha, subject: await reads.git(repo, "log", "-1", "--format=%s", mainSha) ?? "" },
      ...(live ? { live: { sha: live, subject: await reads.git(repo, "log", "-1", "--format=%s", live) ?? "" }, liveInMain: await reads.ancestor(repo, live, mainSha) } : {})
    };
    if (!wt) {
      const shared = { ...common, mode: "shared" as const, note: SHARED_NOTE };
      if (!live) return { ...shared, eligible: false, blockedCode: "RT_DEPLOY_DIFF_UNAVAILABLE", reason: "读不到线上版本，无法核实有效代码变动，请刷新后重试。" };
      if (live && live !== mainSha) {
        const diff = await reads.git(repo, "diff", "--name-only", "--no-renames", "-z", live, mainSha, "--");
        if (diff === undefined) return { ...shared, eligible: false, blockedCode: "RT_DEPLOY_DIFF_UNAVAILABLE", reason: "无法核实有效代码变动，请刷新后重试。" };
        if (!diff.split("\0").some(isFunctionalDeployPath)) return { ...shared, eligible: false, blockedCode: "RT_DEPLOY_NO_CODE", reason: NO_FUNCTIONAL_DEPLOY_CHANGES };
      }
      return shared;
    }
    let st: WorktreeStatus;
    try { st = await sessionWorktreeStatus(wt.repoRoot, wt.path, wt.baseRef); }
    catch (e) { return { ...base, eligible: false, reason: `读不到这个会话的 worktree：${(e as Error).message}` }; }
    const result = { ...common, mode: "worktree" as const, worktree: { path: wt.path, branch: wt.branch, ...st } };
    if (st.changes.length || st.ahead) {
      try {
        const paths = await sessionWorktreeDeployPaths(wt.repoRoot, wt.path, branch);
        if (!paths.some(isFunctionalDeployPath)) return { ...result, eligible: false, blockedCode: "RT_DEPLOY_NO_CODE", reason: NO_FUNCTIONAL_DEPLOY_CHANGES };
      } catch {
        return { ...result, eligible: false, blockedCode: "RT_DEPLOY_DIFF_UNAVAILABLE", reason: "无法核实有效代码变动，请刷新后重试。" };
      }
    }
    return result;
  };

  const enqueueFor = (sha: string, s: DeploySession, ff?: { ref: string; ffFrom: string }): DeployRequestView => {
    try {
      return view(enqueue({
        repo: repo!, sha, ref: ff?.ref ?? branch, notifySession: s.platformSessionId,
        ...(s.runtimeKind ? { runtimeKind: s.runtimeKind } : {}),
        ...(ff ? { ffBranch: branch, ffFrom: ff.ffFrom } : {}),
        ...(root ? { root } : {}), ...(opts.startWatcher === false ? { startWatcher: false } : {})
      }).request);
    } catch (e) { throw new RuntimeError((e as Error).message, 400, "RT_DEPLOY_INVALID"); }
  };

  return {
    info,
    request: ({ session: s, expectedSha, message, auto }) => serial(async () => {
      const i = await info(s);
      if (!i.eligible || !i.main) throw new RuntimeError(i.reason ?? "不能从这个会话部署", i.blockedCode ? 409 : 400, i.blockedCode ?? "RT_DEPLOY_INELIGIBLE");
      if (!expectedSha || expectedSha !== i.main.sha) throw new RuntimeError(`${branch} 已更新到 ${i.main.sha.slice(0, 7)}（${i.main.subject}），请重新确认`, 409, "RT_DEPLOY_MOVED");
      const pending = (sha: string) => i.requests.some((q) => q.sha === sha && q.notifySession === s.platformSessionId && !q.startedAt);

      if (i.mode === "shared") {
        if (i.live?.sha === i.main.sha) throw new RuntimeError(`${branch} 的 ${i.main.sha.slice(0, 7)} 已经在线上，没有新提交可部署。${SHARED_NOTE}`, 409, "RT_DEPLOY_ALREADY_LIVE");
        if (pending(i.main.sha)) throw new RuntimeError(`已经排队等着部署 ${i.main.sha.slice(0, 7)}`, 409, "RT_DEPLOY_DUPLICATE");
        return { request: enqueueFor(i.main.sha, s) };
      }

      // worktree 会话：提交 → 变基到 main 最新提交 → 登记部署会话分支的提交（部署成功后守候进程才快进 main）
      const wt = s.worktree!, st = i.worktree!;
      if (ACTIVE.includes(s.status)) throw new RuntimeError("会话还在运行，等这一轮结束再提交", 409, "RT_BUSY");
      if (!st.changes.length && !st.ahead) throw new RuntimeError(`这个会话的 worktree 里没有新改动（和 ${branch} 一样）`, 409, "RT_DEPLOY_NOTHING");
      // 人重新点了部署：之前自动解决冲突的记录（含「需要人处理」）作废，次数从头算
      if (!auto) clearAutoResolve(s.platformSessionId, root);
      let committed: string | undefined;
      if (st.changes.length) {
        const msg = (message ?? "").trim() || s.title.trim() || "pi-agent 会话改动";
        try { committed = await commitSessionWorktree(wt.repoRoot, wt.path, msg.slice(0, 2000)); }
        catch (e) { throw new RuntimeError((e as Error).message, 409, "RT_DEPLOY_COMMIT"); }
      }
      let head = committed ?? st.head, rebased = false, autoResolvedAssets: number | undefined;
      if (!isAncestor(repo!, i.main.sha, head)) {
        const r = await rebaseSessionWorktree(wt.repoRoot, wt.path, branch);
        if (!r.ok) throw new DeployConflictError(`${committed ? `已提交 ${committed.slice(0, 7)}，但` : ""}和 ${branch} 最新的改动冲突，没有部署：${r.conflicts.length ? r.conflicts.join("、") : r.detail}。可以让会话把 ${branch} 合进来解决冲突后再试`, r.conflicts, head, committed);
        head = r.head; rebased = true; autoResolvedAssets = r.autoResolvedAssets;
      }
      if (i.live?.sha === head) throw new RuntimeError(`${head.slice(0, 7)} 已经在线上`, 409, "RT_DEPLOY_ALREADY_LIVE");
      if (pending(head)) throw new RuntimeError(`已经排队等着部署 ${head.slice(0, 7)}`, 409, "RT_DEPLOY_DUPLICATE");
      // 变基后 main 就是 head 的祖先；记下登记时的 main，守候进程部署成功后从它快进
      return { request: enqueueFor(head, s, { ref: wt.branch, ffFrom: i.main.sha }), ...(committed ? { committed } : {}), ...(rebased ? { rebased } : {}), ...(autoResolvedAssets ? { autoResolvedAssets } : {}) };
    }),
    autoResolveState: (id) => readAutoResolve(id, root),
    signature() {
      const reqs = readRequests(root).map((q) => `${q.id}:${q.notifySession ?? ""}:${q.startedAt ?? ""}:${deploymentProgress(q, root)?.phase ?? ""}`);
      let auto: string[] = [];
      try {
        const dir = join(whenIdleDirs(root).home, "auto-resolve");
        auto = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => { try { return `${f}:${statSync(join(dir, f)).mtimeMs}`; } catch { return f; } }) : [];
      } catch { /* 读不到就只看请求 */ }
      return [...reqs, "|", ...auto].join(",");
    },
    saveAutoResolve: (state) => writeAutoResolve(state, root),
    clearAutoResolve: (id) => clearAutoResolve(id, root),
    lastDeploy: (id) => {
      const last = readLatestDeployForSession(id, root);
      if (!last || !["ok", "already-live"].includes(last.state)) return last;
      // 结束后的流程存档还留着开始/结束与等待会话的时间：补上部署耗时（与设置 → 统计同一口径），
      // 状态行显示「总耗时」。同提交部署过多次时只认结束时间对得上的那一次。
      const run = readDeploymentRun(last.deployedSha || last.sha, root);
      const times = run && runTimes(run);
      if (!times || !last.atMs || Math.abs(times.endMs - last.atMs) >= 10 * 60_000) return last;
      return { ...last, durationMs: Math.max(0, times.endMs - times.startMs - times.waitingMs) };
    },
    branchDeployOf(id) {
      const q = readRequests(root).find((x) => x.notifySession === id && x.ffBranch);
      return q ? view(q) : undefined;
    },
    async byNotifySession(activity) {
      const out = new Map<string, DeployRequestView>();
      // readRequests 按登记时间排序：先到的先排队，所以保留最早的一条；有请求已经开始部署就换成那条
      for (const q of await annotate(readRequests(root), activity)) {
        if (!q.notifySession) continue;
        const cur = out.get(q.notifySession);
        if (!cur || (!cur.startedAt && q.startedAt)) out.set(q.notifySession, q);
      }
      return out;
    },
    rollback: input => serial(async () => {
      const d = await info(input.session);
      if (!d.eligible) throw new RuntimeError(d.reason || "不能回滚", 409, "RT_DEPLOY_INELIGIBLE");
      try {
        const r = enqueueRollback({ repo: repo!, expectedLive: input.expectedLive, expectedSha: input.expectedSha,
          notifySession: input.session.platformSessionId, runtimeKind: input.session.runtimeKind, root, startWatcher: opts.startWatcher !== false });
        return { request: view(r.request) };
      } catch (e) { throw new RuntimeError((e as Error).message, 409, "RT_ROLLBACK_MOVED"); }
    }),
    cancel(id) {
      const r = cancelRequest(id, root);
      if (!r.ok) throw new RuntimeError(r.message, r.code === "NOT_FOUND" ? 404 : 409, r.code === "NOT_FOUND" ? "RT_NOT_FOUND" : "RT_DEPLOY_STARTED");
      return view(r.request);
    }
  };
}
