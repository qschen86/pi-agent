#!/usr/bin/env node
import { deploymentActionsSupported, withDeploymentActions } from './deployment-actions.mjs';
// 空闲时部署：在 pi-agent 自己的会话里迭代 pi-agent。
//
// 外部 runtime 会话是 Web 服务的子进程（V2.8 生命周期方案 A），服务重启会打断进行中的一轮，所以
// deploy-gui.sh 遇到活动会话就拒绝部署——请求部署的那个会话自己就在活动中。这里把部署登记成请求，
// 由一个脱离 Web 服务进程组的守候进程（setsid）等到全局空闲，再跑普通部署（不加 --force），
// 部署结束后（成功、测试没过、回滚都算）给请求它的会话续聊一条消息，让它接着验证。
//
//   node scripts/deploy-when-idle.mjs request --ref <提交> [--notify-session <ID>|auto|none] [--hours <N>]
//   node scripts/deploy-when-idle.mjs status
//   node scripts/deploy-when-idle.mjs watch          （守候进程本身，由 request 拉起）
//
// 规则（与 deploy-gui.sh 的人工部署规则一致）：
// - 保存登记时的提交；空闲时集成最新 main、线上与目标提交，再通过原有部署门禁。
// - 空闲 = 没有活动的一轮、待审批、排队/发送中、结果未知的操作，没有 Pi 任务在跑，没有部署锁，没有 vitest 在跑；
//   连续两次检查都空闲才动手（群聊成员之间的轮次间隙不算空闲）。
// - deploy-gui.sh 退出码 75 = 忙/被锁，回去继续等；测试没过在机器负载下常是超时，等没有 vitest 后重试一次。
// - deploy-gui.sh 退出码 78 = 失败的测试线上版本同样红（主线本身坏了，比如写死日期的用例过期）：请求保持排队、不通知失败，
//   本请求冷却到期或集成输入变化时再试，后续请求继续预发。冷却状态保存在请求中，等待时间不计入请求期限。
// - 请求带 ffBranch（会话页「提交并在空闲时部署」：提交在会话分支上，还没进 main）：部署成功（退出码 0 且线上就是目标）
//   后才把 ffBranch 快进到目标（未检出时比较并交换，干净检出时同步索引与工作区；有本地改动或不能快进就不动，
//   发布照常收尾并记录同步受阻原因；分支发生并发分叉才重新集成）。部署失败 ffBranch 不动。
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = process.env.PI_AGENT_GUI_ROOT || join(homedir(), ".pi-agent-gui");
// 线上服务的端口（与 deploy-gui.sh 一致）；不跟随调用方 Web 服务的端口，开发实例不能代替线上判断空闲
const PORT = process.env.PI_AGENT_GUI_PORT || "8780";
const BASE = `http://127.0.0.1:${PORT}`;
/** 排队目录；root 只给测试换位置 */
export function whenIdleDirs(root = ROOT) {
  const home = join(root, "when-idle");
  return { root, home, requests: join(home, "requests"), pidFile: join(home, "watcher.pid"), log: join(home, "watcher.log") };
}
const { home: HOME_DIR, requests: REQ_DIR, pidFile: PID_FILE, log: LOG } = whenIdleDirs();
export const BUSY_EXIT = 75;
export const TESTS_FAILED_EXIT = 3;
/** 失败的测试在线上版本同样红：与这次部署无关，请求保持排队（见 run-test-gate.mjs BaselineRedError） */
export const BASELINE_RED_EXIT = 78;
/** 同一组 线上/分支/目标 再次尝试门禁前至少等这么久（同样的输入白跑一轮要 7 分钟以上的整套测试） */
export const BASELINE_RED_COOLDOWN_MS = 30 * 60_000;

/* ------------------------------ 主线红（线上同样红）的记录 ------------------------------ */

const baselineRedFile = (root = ROOT) => join(whenIdleDirs(root).home, "baseline-red.json");
/** 从部署日志里取门禁打印的「基线红：{base, files}」；没有返回 undefined */
export function parseBaselineRed(logText) {
  const line = String(logText).split("\n").reverse().find((l) => l.startsWith("基线红：") || l.startsWith("基线红放行："));
  if (!line) return undefined;
  try {
    const v = JSON.parse(line.slice(line.indexOf("：") + 1));
    return Array.isArray(v.files) ? { files: v.files.map(String), base: typeof v.base === "string" ? v.base : undefined } : undefined;
  } catch { return undefined; }
}
export function writeBaselineRed(state, root = ROOT) {
  mkdirSync(whenIdleDirs(root).home, { recursive: true });
  const file = baselineRedFile(root), tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, at: state.at ?? new Date().toISOString() }, null, 2)); renameSync(tmp, file);
}
export function readBaselineRed(root = ROOT) {
  try {
    const v = JSON.parse(readFileSync(baselineRedFile(root), "utf8"));
    return v && Array.isArray(v.files) && Number.isFinite(Date.parse(v.at)) ? v : undefined;
  } catch { return undefined; }
}
export function clearBaselineRed(root = ROOT) { rmSync(baselineRedFile(root), { force: true }); }
/**
 * 门禁说失败的测试线上版本同样红（退出码 78）：不是这次部署的问题。请求撤掉「部署中」标记继续排队（不判失败、不通知），
 * 记下 线上/分支尖端/目标 和红的文件，输入不变就不再重跑整套门禁。返回仍在排队的请求和红的文件。
 */
export function holdForBaselineRed({ repo, branch, target, covered, logFile, root = ROOT, inputs }) {
  let text = ""; try { text = readFileSync(logFile, "utf8"); } catch { /* 没有日志 */ }
  const files = parseBaselineRed(text)?.files ?? [];
  const state = { ...(inputs ?? { live: liveCommit(root), branchTip: branchTip(repo, branch) }), target, files, logFile, at: new Date().toISOString() };
  const queued = markRequests(covered, undefined, { baselineRed: state });
  if (queued.length) writeBaselineRed({ ...state, requestId: queued[0].id }, root);
  return { covered: queued, files };
}
/**
 * 同一线上版本、分支尖端、预发基础及目标提交在冷却期内只检查一次。
 */
export function baselineRedHolds(state, { live, branchTip, target, base }, now = Date.now()) {
  return !!state && state.live === live && state.branchTip === branchTip && state.target === target &&
    (state.base === undefined || state.base === (base ?? live)) && now - Date.parse(state.at) < BASELINE_RED_COOLDOWN_MS;
}

export function baselineRedForRequest(request, legacy) {
  if (request.action) return undefined;
  if (request.baselineRed !== undefined) return request.baselineRed ?? undefined;
  return legacy?.target === request.sha && (!legacy.requestId || legacy.requestId === request.id) ? legacy : undefined;
}

const branchTip = (repo, branch = "main") => git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`);

export function baselineRedWait(request, state, { live, base = live, branchTip }, now = Date.now()) {
  return baselineRedHolds(state, { live, base, branchTip, target: request.sha }, now) ? state : undefined;
}

export function requestDeadline(request, state, now = Date.now()) {
  const heldAt = Date.parse(state?.at);
  const deadline = Date.parse(request.deadline);
  return deadline + (heldAt <= deadline ? Math.min(BASELINE_RED_COOLDOWN_MS, Math.max(0, now - heldAt)) : 0);
}

function coolingRequests(live, legacy, now) {
  return (q, base) => {
    const state = baselineRedForRequest(q, legacy);
    return !!state && !!baselineRedWait(q, state, { live, base, branchTip: branchTip(q.repo, q.ffBranch) }, now);
  };
}

/* ------------------------------ 纯逻辑（有单测） ------------------------------ */

/**
 * 找出请求部署的会话：环境变量（Claude 会话里有）优先；否则在活动会话里按工作目录最长前缀匹配，唯一才算。
 * 返回 { id, how } 或 { id: undefined, why }。
 */
export function resolveRequester({ explicit, envId, cwd, active }) {
  if (explicit && explicit !== "auto") return explicit === "none" ? { why: "已指定不通知" } : { id: explicit, how: "指定" };
  if (envId) return { id: envId, how: "PI_AGENT_RUNTIME_SESSION_ID" };
  const inside = (ws) => !!ws && (cwd === ws || cwd.startsWith(ws.endsWith("/") ? ws : ws + "/"));
  const hits = active.filter((s) => inside(s.workspace));
  if (!hits.length) return { why: active.length ? "当前目录不在任何活动会话的工作目录里" : "没有活动会话（不在 pi-agent 会话里运行）" };
  const best = Math.max(...hits.map((s) => s.workspace.length));
  const top = hits.filter((s) => s.workspace.length === best);
  if (top.length > 1) return { why: `有 ${top.length} 个活动会话都在这个目录（${top.map((s) => s.platformSessionId).join("、")}），用 --notify-session 指定` };
  return { id: top[0].platformSessionId, how: `工作目录 ${top[0].workspace}` };
}

/** 空闲判定：返回还在忙的原因（空数组 = 空闲） */
export function busyReasons({ activity, piTasks, locked, vitest, preparing = false }) {
  const r = [];
  if (!activity) return ["读不到 /api/runtime/activity（服务没起来或正在重启）"];
  if (activity.draining) r.push("服务正处于部署排空中（另一次部署）");
  if (!preparing) {
    for (const s of activity.active ?? []) r.push(`会话「${String(s.title ?? "").slice(0, 24)}」${s.status}`);
    if (activity.pendingApprovals) r.push(`待审批 ${activity.pendingApprovals} 项`);
    if (activity.queued) r.push(`排队 ${activity.queued} 项`);
    if (activity.dispatching) r.push(`发送中 ${activity.dispatching} 项`);
    if (activity.unknownOps) r.push(`结果未知 ${activity.unknownOps} 项`);
    if (piTasks) r.push(`Pi 任务 ${piTasks} 个在跑`);
  }
  if (locked) r.push("部署锁被占用");
  if (vitest) r.push(`${vitest} 个 vitest 进程在跑`);
  return r;
}

/**
 * 决定这一次部署哪个提交、覆盖哪些请求。requests 按登记先后排列；isAncestor(a, b) = a 是 b 的祖先（含相等）。
 * - 已在线上的请求直接完成；
 * - 目标 = 包含最早一条待办请求的最新请求（一次部署顺带覆盖更早的请求）；
 * - 分叉仍保留请求，由部署前的独立工作区自动合并。
 */
export function planDeploy(requests, live, isAncestor) {
  const done = [], pending = [];
  for (const q of requests) (live && isAncestor(q.sha, live) ? done : pending).push(q);
  if (!pending.length) return { done, rejected: [], target: undefined, covered: [] };
  const first = pending[0];
  const target = [...pending].reverse().find((q) => isAncestor(first.sha, q.sha))?.sha ?? first.sha;
  const covered = pending.filter((q) => isAncestor(q.sha, target));
  return { done, rejected: [], target, covered };
}

/* ------------------------------ 叠加预发 ------------------------------ */
//
// 会话在跑时不再干等：请求一到就在备用槽位里逐个「叠加」做集成 + 门禁（deploy-gui.sh --stage-only，不预热、不排空、不切换），
// 每一步建在上一步通过的结果上；某一步失败只把它跳过。预发全部处理完后再做一次切换（排空 → 等在跑的对话结束 → 切），
// 一次上线所有通过的请求。被跳过的请求在切换后以新的线上版本为基线重来一次，那时再失败才算真失败。
// 状态在 when-idle/staged.json：{ sha: 最新预发提交, ids: 已叠加的请求, skipped: { 请求id: {sha, at, detail} }, live: 预发时的线上提交 }。

/** 切换时在排空状态下最多等在跑的对话多久（秒）；超时释放排空，预发保留，稍后再切 */
export const CUTOVER_WAIT_SECONDS = Number(process.env.PI_AGENT_CUTOVER_WAIT_SECONDS) || 1800;
const stagedFile = (root = ROOT) => join(whenIdleDirs(root).home, "staged.json");
export function readStaged(root = ROOT) {
  try {
    const v = JSON.parse(readFileSync(stagedFile(root), "utf8"));
    return v && /^[a-f0-9]{40}$/.test(v.sha ?? "") && Array.isArray(v.ids) ? { ...v, skipped: v.skipped ?? {} } : undefined;
  } catch { return undefined; }
}
export function writeStaged(state, root = ROOT) {
  mkdirSync(whenIdleDirs(root).home, { recursive: true });
  const file = stagedFile(root), tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2)); renameSync(tmp, file);
}
export function clearStaged(root = ROOT) { rmSync(stagedFile(root), { force: true }); }
/**
 * 一批请求在切换前的节点时间（登记 → 预发检查开始 → 预发完成）：取这批里最早的登记 / 预检开始和最晚的预发完成。
 * 切换那次部署把它写进 progress.json 并随流程存档保存，结果弹窗和耗时统计才看得到预发这一段。
 */
export function stagingTimeline(requests, staged) {
  const marks = requests.map(q => ({ queuedAt: q.requestedAt, ...staged?.timeline?.[q.id] })).filter(t => t.startedAt && t.stagedAt);
  if (!marks.length) return undefined;
  const queued = marks.map(t => t.queuedAt).filter(Boolean).sort()[0];
  return { ...(queued ? { queuedAt: queued } : {}), startedAt: marks.map(t => t.startedAt).sort()[0], stagedAt: marks.map(t => t.stagedAt).sort().at(-1) };
}
/** 预发提交用分支引用保住（集成工作区清理后它不在任何分支上，部署脚本要求提交在分支上） */
export const STAGED_REF = "pi-deploy/staged";
export function keepStagedRef(repo, sha) {
  spawnSync("git", ["-C", repo, "update-ref", `refs/heads/${STAGED_REF}`, sha]);
}
/** 预发收尾：给了 sha（已上线）且它没进目标分支，就改名成恢复锚点（线上就是这个提交，不能让它没有分支）；否则只删引用 */
export function retireStagedRef(repo, sha, branch = "main") {
  const ref = `refs/heads/${STAGED_REF}`;
  if (git(repo, "rev-parse", "--verify", "--quiet", ref) === undefined) return;
  const tip = git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`);
  if (sha && !(tip && isAncestor(repo, sha, tip))) spawnSync("git", ["-C", repo, "update-ref", `refs/heads/pi-deploy/live-${String(sha).slice(0, 7)}`, sha]);
  spawnSync("git", ["-C", repo, "update-ref", "-d", ref]);
}

/**
 * 下一步做什么。requests 按登记先后排列；isAncestor(a, b) = a 是 b 的祖先（含相等）。
 * - reset：预发已失效（线上变了、不再包含线上），丢掉预发重新叠加；
 * - stage：把 request 叠加到 base（已预发的最新提交，没有则是线上）上做集成 + 门禁；
 * - refresh：目标分支在预发期间前移（staged.stale）：把新的分支合进已预发的版本，只多测一步，不推倒重来；
 * - cutover：没有要叠加的了，把预发的 sha 一次切上去，covered 是它包含的请求；
 * - idle：什么都不用做。
 * dependent：基于某个已跳过请求的提交（带着它的改动）的请求，一并跳过，不拿它去白跑门禁。
 * isCooling：跳过仍在冷却的请求，继续检查后续请求。
 */
export function planStaging({ requests, live, staged, isAncestor, isCooling = () => false }) {
  const open = requests.filter((q) => !(live && isAncestor(q.sha, live)));
  const valid = !!(staged && live && isAncestor(live, staged.sha));
  if (staged && !valid) return { action: "reset", reason: live ? `线上 ${live.slice(0, 7)} 不在预发 ${staged.sha.slice(0, 7)} 的历史里` : "读不到线上提交", dependent: [] };
  const skipped = valid ? staged.skipped ?? {} : {};
  const ids = new Set(valid ? staged.ids : []);
  const inStack = (q) => valid && (ids.has(q.id) || isAncestor(q.sha, staged.sha));
  const covered = open.filter(inStack);
  if (valid && !covered.length) return { action: "reset", reason: "预发里的请求都已不在队列里", dependent: [] };
  if (valid && staged.stale) return { action: "refresh", sha: staged.sha, covered, dependent: [] };
  const skippedShas = Object.values(skipped).map((s) => s.sha);
  const dependent = [];
  let next;
  for (const q of open) {
    if (inStack(q) || skipped[q.id] || isCooling(q, valid ? staged.sha : live)) continue;
    const on = skippedShas.find((s) => isAncestor(s, q.sha));
    if (on) { dependent.push({ request: q, on }); continue; }
    next = q; break;
  }
  if (next) return { action: "stage", request: next, base: valid ? staged.sha : live, dependent };
  if (valid) return { action: "cutover", sha: staged.sha, covered, dependent };
  return { action: "idle", dependent };
}

/** Only generated URL hashes may be resolved automatically; never choose a side for source changes. */
export function resolveIntegratedAssetConflicts(text) {
  const lines = text.split("\n"), out = [];
  let hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^<{7}(?: |$)/.test(lines[i])) { out.push(lines[i]); continue; }
    const ours = [], theirs = [];
    let phase = "ours";
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      if (phase === "ours" && /^\|{7}(?: |$)/.test(line)) { phase = "base"; continue; }
      if (["ours", "base"].includes(phase) && /^={7}(?: |$)/.test(line)) { phase = "theirs"; continue; }
      if (phase === "theirs" && /^>{7}(?: |$)/.test(line)) { phase = "done"; break; }
      if (phase === "ours") ours.push(line); else if (phase === "theirs") theirs.push(line);
    }
    const strip = line => line.replace(/(\?v=)[^"]*/g, "$1");
    if (phase !== "done" || !ours.length || ours.length !== theirs.length || !ours.every((line, k) => /(?:src|href)="\/[^"?]+\.(?:js|css)\?v=/.test(line) && strip(line) === strip(theirs[k]))) return undefined;
    out.push(...ours); hunks++;
  }
  return hunks ? out.join("\n") : undefined;
}

function integratedAssetVersions(path, text) {
  const base = join(path, "apps/web/public");
  return text.replace(/((?:src|href)="\/(?:[^"?]+\.(?:js|css)))(?:\?[^\"]*)?"/g, (_m, prefix) => {
    const asset = join(base, prefix.slice(prefix.indexOf('"') + 1));
    const rel = relative(base, realpathSync(asset));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("资源路径越界");
    return `${prefix}?v=${createHash("sha256").update(readFileSync(asset)).digest("hex").slice(0, 12)}"`;
  });
}

/** Build a disposable host-owned candidate. Never modify a session worktree or main before gates pass. */
export function integrateDeploy({ repo, target, live, branch = "main", root = ROOT }) {
  const baseline = git(repo, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`);
  if (!baseline) return { ok: false, conflicts: [], detail: `找不到 ${branch} 分支` };
  if ([baseline, live].filter(Boolean).every(sha => isAncestor(repo, sha, target)))
    return { ok: true, sha: target, branch, cleanup() {} };
  const home = whenIdleDirs(root).home;
  mkdirSync(home, { recursive: true });
  const parent = mkdtempSync(join(home, "integration-"));
  const path = join(parent, "worktree");
  const ref = `pi-deploy/${parent.split("/").pop()}`;
  const run = (...args) => spawnSync("git", ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "-c", "user.name=pi-agent deploy", "-c", "user.email=deploy@pi-agent.local", ...args], { encoding: "utf8" });
  const cleanup = () => {
    // Keep a reachable recovery anchor if deployment succeeded but main moved concurrently.
    const head = git(path, "rev-parse", "HEAD");
    const tip = git(repo, "rev-parse", `refs/heads/${branch}`);
    const keep = head && liveCommit(root) === head && (!tip || !isAncestor(repo, head, tip));
    spawnSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", path]);
    if (!keep) spawnSync("git", ["-C", repo, "branch", "-D", ref]);
    rmSync(parent, { recursive: true, force: true });
  };
  try {
    const add = spawnSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", ref, path, baseline], { encoding: "utf8" });
    if (add.status !== 0) throw new Error(add.stderr || "创建集成工作区失败");
    for (const sha of [...new Set([live, target].filter(Boolean))]) {
      if (isAncestor(repo, sha, git(path, "rev-parse", "HEAD"))) continue;
      const merged = run("merge", "--no-edit", "--no-overwrite-ignore", sha);
      if (merged.status !== 0) {
        const conflicts = (git(path, "diff", "--name-only", "--diff-filter=U") ?? "").split("\n").filter(Boolean);
        if (conflicts.length === 1 && conflicts[0] === "apps/web/public/index.html") {
          const index = join(path, conflicts[0]);
          const resolved = resolveIntegratedAssetConflicts(readFileSync(index, "utf8"));
          if (resolved !== undefined) {
            writeFileSync(index, integratedAssetVersions(path, resolved));
            if (run("add", "--", conflicts[0]).status === 0 && run("commit", "--no-edit").status === 0) continue;
          }
        }
        cleanup();
        return { ok: false, conflicts, detail: conflicts.length ? `自动合并冲突：${conflicts.join("、")}` : merged.stderr || "自动合并失败" };
      }
    }
    // Recompute generated URLs using host code, without executing candidate scripts.
    const index = join(path, "apps/web/public/index.html");
    if (existsSync(index)) {
      const html = integratedAssetVersions(path, readFileSync(index, "utf8"));
      writeFileSync(index, html);
      if (run("diff", "--quiet").status !== 0) {
        if (run("add", "--", "apps/web/public/index.html").status !== 0 || run("commit", "-m", "chore: refresh integrated web asset versions").status !== 0) throw new Error("提交资源版本号失败");
      }
    }
    const sha = git(path, "rev-parse", "HEAD");
    if (![baseline, live, target].filter(Boolean).every(s => isAncestor(repo, s, sha))) throw new Error("集成提交未包含全部输入版本");
    return { ok: true, sha, branch, cleanup };
  } catch (e) { cleanup(); return { ok: false, conflicts: [], detail: e.message }; }
}

/** 比较本请求提交与集成候选相对基线的改动差异，列出额外并入的非本请求文件（便于排查为何测试范围扩大）。 */
export function extraIntegratedFiles(repo, { base, requestSha, candidateSha }) {
  if (!base || !requestSha || !candidateSha || requestSha === candidateSha) return [];
  const diffFiles = (from, to) => {
    const out = git(repo, "diff", "--name-only", "--no-renames", from, to);
    return out ? out.split("\n").map(s => s.trim()).filter(Boolean) : [];
  };
  const mergeBase = git(repo, "merge-base", base, requestSha);
  if (!mergeBase) return [];
  const own = new Set(diffFiles(mergeBase, requestSha));
  const all = diffFiles(base, candidateSha);
  return all.filter(f => !own.has(f)).sort();
}

/** 续聊接口的幂等键只接受 [A-Za-z0-9_-]{8,80}：同一请求重试不会发两条 */
export const notifyKey = (requestId) => `deploy-when-idle-${String(requestId).replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 80);

export function notifyPrompt({ outcome, sha, subject, live, logFile, detail, requestSha, requestId }) {
  // 多个请求叠加上线时，线上是集成合并提交；写上本请求自己的提交号，会话页才能认出这条通知就是它的结果
  const included = requestSha && !sha.startsWith(requestSha.slice(0, 7)) ? `本请求的提交 ${requestSha.slice(0, 7)} 已包含在内。` : "";
  const head = {
    ok: `已上线：${sha.slice(0, 7)}（${subject}）。现在 console.example.com 跑的就是这一版，可以接着验证。${included}`,
    "already-live": `不用部署：${sha.slice(0, 7)} 已经在线上（线上 ${live?.slice(0, 7)} 已包含它）。`,
    rejected: `没有部署 ${sha.slice(0, 7)}：线上是 ${live?.slice(0, 7)}，它不在这个提交的历史里（这期间有别的提交上线了）。`,
    failed: `部署 ${sha.slice(0, 7)} 没有成功，线上仍是 ${live?.slice(0, 7)}。`,
    expired: `等空闲超时，放弃部署 ${sha.slice(0, 7)}；线上仍是 ${live?.slice(0, 7)}。`
  }[outcome];
  return [`[pi-agent 自动部署通知] ${head}`, detail ? `\n${detail}` : "", requestId ? `\n部署请求：${requestId}\n请求提交：${requestSha || sha}` : "", `\n部署日志：${logFile}`].join("");
}

/* ------------------------------ 冲突自动解决 ------------------------------ */
//
// 「提交并在空闲时部署」遇到代码冲突（登记时变基到 main，或部署前集成 main / 线上）时，不直接交给人：
// 平台给请求部署的会话发一轮「把 main 合进来、解决冲突、提交」，那一轮正常结束后由 Web 服务自动重新登记部署。
// 会话说需要人类取舍（放弃合并）、那一轮失败、或连续 AUTO_RESOLVE_MAX 次仍冲突，才停下来交给人。
// 状态按会话存在 when-idle/auto-resolve/<会话>.json，Web 服务和守候进程共用：
//   resolving   已发出解决冲突的一轮（operationId），等它结束
//   queued      已自动重新登记部署（部署结束后清掉；部署前集成再冲突时沿用次数）
//   needs-human 自动处理不了，reason 说明原因（人再点部署时清掉）

export const AUTO_RESOLVE_MAX = 3;
/** 超过这么久的状态视为过期（会话早就不管了） */
const AUTO_RESOLVE_TTL_MS = 24 * 3600_000;
const autoResolveFile = (session, root) => join(whenIdleDirs(root).home, "auto-resolve", `${String(session).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

export function readAutoResolve(session, root = ROOT) {
  try {
    const st = JSON.parse(readFileSync(autoResolveFile(session, root), "utf8"));
    if (st?.session !== session || !(Date.now() - Date.parse(st.at) < AUTO_RESOLVE_TTL_MS)) return undefined;
    return st;
  } catch { return undefined; }
}
export function writeAutoResolve(state, root = ROOT) {
  const file = autoResolveFile(state.session, root);
  mkdirSync(dirname(file), { recursive: true });
  const st = { ...state, at: new Date().toISOString() };
  writeFileSync(`${file}.tmp`, JSON.stringify(st, null, 2));
  renameSync(`${file}.tmp`, file);
  return st;
}
export function clearAutoResolve(session, root = ROOT) { rmSync(autoResolveFile(session, root), { force: true }); }
/** 发解决冲突那一轮用的幂等键（续聊接口只接受 [A-Za-z0-9_-]{8,80}） */
export const autoResolveKey = (session, attempt) => `deploy-resolve-${String(session).replace(/[^A-Za-z0-9_-]/g, "-").slice(-24)}-${attempt}-${Date.now().toString(36)}`.slice(0, 80);

/** 发给会话的「解决冲突」消息 */
export function autoResolvePrompt({ branch = "main", conflicts, attempt, max = AUTO_RESOLVE_MAX, stage, live }) {
  const files = conflicts.length ? conflicts.map((f) => `- ${f}`).join("\n") : "- （git 没列出具体文件）";
  return [
    `[pi-agent 自动部署] ${stage === "integration" ? "部署前集成" : "提交部署时"}，这个会话分支和 ${branch} 最新的改动冲突（自动处理第 ${attempt}/${max} 次），冲突文件：`,
    files,
    "",
    "请在这个会话的 worktree 里解决，然后结束这一轮：",
    `1. 运行 git merge ${branch}${live ? `，然后 git merge ${live}（线上版本还没进 ${branch}）` : ""}。用 merge，不要 rebase；不要改动 ${branch} 分支本身，也不要 push。`,
    `2. 逐个解决冲突：保留 ${branch} 上别人的改动，同时保留这个会话改动的意图；拿不准时用 git log ${branch} -- <文件> 看对方提交的说明。`,
    "3. 跑和冲突文件相关的测试与类型检查；改过 apps/web/public 下的 JS/CSS 就运行 node scripts/version-web-assets.mjs。全部通过后 git commit 完成合并。",
    "4. 不要自己请求部署：这一轮正常结束后，平台会检查合并结果并自动重新提交部署。",
    "",
    "如果两边的意图互相矛盾、需要人来取舍，不要硬合：运行 git merge --abort，然后在回复里说明需要人决定什么。平台看到合并没完成，会停下来交给人。"
  ].join("\n");
}

/** 常见的门禁失败：只给文字提示（宿主不执行会话 worktree 里的脚本） */
const FAILURE_HINTS = [
  { pattern: /(?:FAIL\s+[^\n]*(?:static-cache|v27-assets)\.test|❯[^\n]*(?:static-cache|v27-assets)\.test[^\n]*failed)/, hint: "static-cache / v27-assets 测试没过：多半是改了 apps/web/public 下的 JS/CSS 却没更新 index.html 里的版本号。在会话 worktree 里运行 node scripts/version-web-assets.mjs，提交后再请求部署。" },
  { pattern: /类型检查没过/, hint: "类型检查没过：在会话 worktree 里运行 npm run typecheck 看具体错误。" }
];
export function failureHints(logText) {
  return FAILURE_HINTS.filter((h) => h.pattern.test(logText ?? "")).map((h) => h.hint);
}

/** Host-owned preflight. Unrelated untracked files are preserved by the fast-forward. */
export function branchSyncBlocker(repo, branch, target) {
  const list = git(repo, "worktree", "list", "--porcelain");
  if (list === undefined) return { detail: "无法读取仓库 worktree 列表" };
  const blocks = list.split("\n\n").filter(Boolean);
  // A rebase/bisect temporarily detaches HEAD; branch ownership lives in its metadata.
  for (const block of blocks.filter(b => b.split("\n").includes("detached"))) {
    const path = block.split("\n")[0].replace(/^worktree /, "");
    const admin = git(path, "rev-parse", "--absolute-git-dir");
    if (!admin) return { detail: `无法读取 ${path} 的 Git 操作状态` };
    for (const state of ["rebase-merge/head-name", "rebase-apply/head-name", "BISECT_START"]) {
      const file = join(admin, state);
      let name;
      try { name = readFileSync(file, "utf8").trim(); } catch (e) {
        if (e.code === "ENOENT") continue;
        return { detail: `无法读取 ${path} 的 Git 操作状态：${e.message}` };
      }
      if (name === branch || name === `refs/heads/${branch}`) return { where: [path], detail: `${path} 有未结束的 Git 操作（${state}），请先完成或取消` };
    }
  }
  const where = blocks.filter(b => b.split("\n").includes(`branch refs/heads/${branch}`))
    .map(b => b.split("\n")[0].replace(/^worktree /, ""));
  if (where.length > 1) return { where, detail: `${branch} 在多个工作区检出，无法安全同步` };
  for (const path of where) {
    if (git(path, "symbolic-ref", "-q", "HEAD") !== `refs/heads/${branch}`) return { where, detail: `${path} 的分支状态已改变` };
    const admin = git(path, "rev-parse", "--absolute-git-dir");
    if (!admin) return { where, detail: `无法读取 ${path} 的 Git 操作状态` };
    for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "index.lock", "HEAD.lock"]) {
      if (existsSync(join(admin, state))) return { where, detail: `${path} 有未结束的 Git 操作（${state}），请先完成或取消` };
    }
    const status = git(path, "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=no");
    if (status === undefined || status) return { where, detail: `${path} 有未提交改动或无法读取状态，请先提交或预发后重试` };
    if (target) {
      const changed = git(path, "diff", "--name-only", "-z", branch, target);
      if (changed === undefined) return { where, detail: "无法比较待同步文件" };
      for (const file of changed.split("\0").filter(Boolean)) {
        const parts = file.split("/");
        for (let n = 1; n <= parts.length; n++) {
          const entry = parts.slice(0, n).join("/");
          let stat;
          try { stat = lstatSync(join(path, entry)); } catch (e) {
            if (e.code === "ENOENT") break;
            return { where, detail: `无法检查 ${path}/${entry}：${e.message}` };
          }
          if ((n === parts.length || !stat.isDirectory()) && git(path, "ls-files", "--error-unmatch", "--", entry) === undefined)
            return { where, detail: `${path}/${entry} 是未跟踪文件，与待同步文件冲突，请先移走后重试` };
          if (n === parts.length && stat.isDirectory() && /^\d+ (blob|commit) /.test(git(path, "ls-tree", target, "--", entry) ?? "")) {
            const others = git(path, "ls-files", "--others", "--", entry);
            if (others === undefined || others) return { where, detail: `${path}/${entry} 内有未跟踪文件或无法读取状态，与待同步文件冲突，请先移走后重试` };
          }
          if (!stat.isDirectory()) break;
        }
      }
    }
  }
}

/** After successful deployment, fast-forward the branch and any clean checkout without hooks. */
export function fastForwardAfterDeploy(repo, branch, target) {
  const tip = git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`);
  if (!tip) return { result: "failed", tip, detail: `仓库里没有 ${branch} 分支` };
  if (isAncestor(repo, target, tip)) return { result: "contained", tip };
  // Committed divergence must not be hidden by unrelated local file changes.
  if (!isAncestor(repo, tip, target)) return { result: "diverged", tip };
  const syncFailed = (detail) => {
    const current = git(repo, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`);
    const diverged = current && !isAncestor(repo, current, target) && !isAncestor(repo, target, current);
    return { result: diverged ? "diverged" : "failed", tip: current ?? tip, detail };
  };
  const blocker = branchSyncBlocker(repo, branch, target);
  if (blocker) return { result: "checked-out", tip, ...blocker };
  const where = (git(repo, "worktree", "list", "--porcelain") ?? "").split("\n\n")
    .filter((b) => b.split("\n").includes(`branch refs/heads/${branch}`)).map((b) => b.split("\n")[0].replace(/^worktree /, ""));
  if (where.length) {
    // Git updates the checked-out branch, index and files together; no detach/reset or hooks.
    const r = spawnSync("git", ["-C", where[0], "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", target], { encoding: "utf8" });
    return r.status === 0 && git(where[0], "rev-parse", "HEAD") === target && git(where[0], "symbolic-ref", "-q", "HEAD") === `refs/heads/${branch}`
      ? { result: "moved", tip } : syncFailed((r.stderr || "").trim() || "快进后的分支状态不符合预期");
  }
  const r = spawnSync("git", ["-C", repo, "update-ref", "-m", "pi-agent: 部署成功后快进", `refs/heads/${branch}`, target, tip], { encoding: "utf8" });
  return r.status === 0 ? { result: "moved", tip } : syncFailed((r.stderr || "").trim() || `退出码 ${r.status}`);
}

/** 通知里关于 ffBranch 的一段话 */
export function ffNote({ branch, sha, outcome, ff }) {
  const s7 = sha.slice(0, 7), tip = ff?.tip?.slice(0, 7);
  if (outcome !== "ok") return `${branch} 没变（仍是 ${tip ?? "-"}）：这个提交只在会话分支上，没进 ${branch}。修好后再点「提交并在空闲时部署」。`;
  const unmerged = `发布已完成，本地 ${branch} 暂未同步；工作区文件保持原样。后续发布仍会集成 ${branch} 与真实线上提交。`;
  switch (ff.result) {
    case "moved": return `${branch} 已从 ${tip} 快进到 ${s7}。`;
    case "contained": return `${branch}（${tip}）已包含 ${s7}。`;
    case "checked-out": return `${branch} 没有前移：${ff.detail}。${unmerged}`;
    case "diverged": return `${branch} 已被别人前移到 ${tip}，不能快进到 ${s7}，没有硬合。${unmerged}`;
    default: return `没能把 ${branch} 快进到 ${s7}（${ff.detail}）。${unmerged}`;
  }
}

/* ------------------------------ 环境读取 ------------------------------ */

async function getJson(path, timeoutMs = 8000) {
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : undefined;
  } catch { return undefined; }
}
async function postJson(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function git(repo, ...args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}
const isAncestorIn = (repo) => (a, b) => a === b || spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", a, b]).status === 0;
const vitestCount = () => (spawnSync("ps", ["-Ao", "command"], { encoding: "utf8" }).stdout ?? "").split("\n").filter((l) => /vitest/.test(l) && !/deploy-when-idle/.test(l)).length;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const now = () => new Date().toLocaleString("sv-SE");
const log = (msg) => appendFileSync(LOG, `[${now()}] ${msg}\n`);
/** history.log 是制表符分隔的，字段里不能带制表符或换行 */
const historyField = (value) => String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
/**
 * 部署控制器版本：守候进程自己和同目录部署脚本的内容哈希前 7 位。统计应用据此对比不同版本部署器的成功率与耗时；
 * 脚本一改，版本就变，不需要手工维护版本号。读不到文件时记 unknown，不影响部署。
 */
const CONTROLLER_VERSION = (() => {
  try {
    const self = fileURLToPath(import.meta.url), hash = createHash("sha256");
    hash.update(readFileSync(self));
    const sibling = join(dirname(self), "deploy-gui.sh");
    if (existsSync(sibling)) hash.update(readFileSync(sibling));
    return hash.digest("hex").slice(0, 7);
  } catch { return "unknown"; }
})();

async function piTaskCount() {
  const list = await getJson("/api/sessions");
  return Array.isArray(list) ? list.filter((x) => ["running", "verifying", "accepting"].includes(x?.runStatus)).length : 0;
}
/** 排队中的请求，按登记先后；startedAt = 守候进程已经开始部署它 */
export function readRequests(root = ROOT) {
  const dir = whenIdleDirs(root).requests;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => { try { return { ...JSON.parse(readFileSync(join(dir, f), "utf8")), file: join(dir, f) }; } catch { return undefined; } })
    .filter(Boolean);
}
export function watcherPid(root = ROOT) {
  try { const pid = Number(readFileSync(whenIdleDirs(root).pidFile, "utf8")); return pid && alive(pid) ? pid : undefined; } catch { return undefined; }
}
/** 线上（current 槽位）的提交 */
export function liveCommit(root = ROOT) {
  try {
    const marker = JSON.parse(readFileSync(join(root, "control", "web-supervisor.json"), "utf8"));
    if (marker.protocol === 2) return alive(marker.pid) && !marker.running?.dead && /^[a-f0-9]{40}$/.test(marker.running?.sha ?? "") ? marker.running.sha : undefined;
  } catch { /* pre-supervisor installation */ }
  try { return git(realpathSync(join(root, "current")), "rev-parse", "HEAD"); } catch { return undefined; }
}
export const commitSubject = (repo, sha) => git(repo, "log", "-1", "--format=%s", sha);
export const isAncestor = (repo, a, b) => isAncestorIn(repo)(a, b);

/** Cancel queued/preparing/waiting requests; serialize with the cutover boundary. */
export function cancelRequest(id, root = ROOT) {
  return withDeploymentActions(whenIdleDirs(root).home, () => {
    const q = readRequests(root).find(x => x.id === id);
    if (!q) return { ok: false, code: "NOT_FOUND", message: "没有这个部署请求（可能已经部署或被取消）" };
    if (!deploymentActionsSupported(root)) return { ok: false, code: "STARTED", message: "部署控制器尚未升级，请先运行 scripts/install-gui-control.mjs" };
    if (readStaged(root)?.ids.includes(q.id)) return { ok: false, code: "STARTED", message: "已叠加进待切换的候选，不能单独取消" };
    if (q.startedAt) {
      let p;
      try { p = JSON.parse(readFileSync(join(whenIdleDirs(root).home, "progress.json"), "utf8")); } catch {}
      if (!p?.requests?.some(x => x.id === q.id && x.startedAt === q.startedAt) || !["preparing", "idle", "waiting"].includes(p.phase))
        return { ok: false, code: "STARTED", message: "正在核对部署阶段或已进入切换服务，不能取消，请刷新进度" };
    }
    rmSync(q.file, { force: true });
    appendFileSync(join(whenIdleDirs(root).home, "history.log"), `${now()}\t${q.sha.slice(0, 7)}\tcancelled\t${q.notifySession ?? "-"}\t\t${historyField(q.subject)}\t${historyField(q.runtimeKind)}\t${CONTROLLER_VERSION}\t${historyField(q.id)}\t\n`);
    return { ok: true, request: q };
  });
}

/** Only offer a verified standby belonging to the currently serving slot. */
export function rollbackTarget(root = ROOT) {
  try {
    const live = liveCommit(root), current = realpathSync(join(root, "current"));
    const blue = realpathSync(join(root, "slots/blue"));
    const target = current === blue ? "green" : current === realpathSync(join(root, "slots/green")) ? "blue" : undefined;
    if (!live || !target || git(current, "rev-parse", "HEAD") !== live) return undefined;
    const slot = join(root, "slots", target), sha = git(slot, "rev-parse", "HEAD");
    if (!sha || sha === live || readFileSync(join(slot, ".deploy-ok"), "utf8").trim() !== sha) return undefined;
    return { sha, live, subject: commitSubject(slot, sha) ?? "" };
  } catch { return undefined; }
}
export function enqueueRollback({ repo, expectedLive, expectedSha, notifySession, runtimeKind, root = ROOT, startWatcher = true }) {
  return withDeploymentActions(whenIdleDirs(root).home, () => {
    const fail = message => { throw Object.assign(new Error(message), { code: "ROLLBACK_MOVED" }); };
    if (!deploymentActionsSupported(root)) fail("部署控制器尚未升级，请先运行 scripts/install-gui-control.mjs");
    const target = rollbackTarget(root);
    if (!target || target.live !== expectedLive || target.sha !== expectedSha) fail("线上或可回滚版本已变化，请刷新后重新确认");
    const pending = readRequests(root);
    const same = pending.find(q => q.action === "rollback" && q.sha === expectedSha && q.expectedLive === expectedLive && q.notifySession === notifySession);
    if (same) return { request: same };
    if (pending.length) fail("还有部署请求未结束，请等待或取消后再回滚");
    const r = enqueue({ repo, sha: target.sha, notifySession, runtimeKind, root, startWatcher, action: "rollback", expectedLive });
    return r;
  });
}

/**
 * 登记一次空闲时部署，并确保有守候进程在等。命令行（会话里的 --when-idle）与 Web 服务（会话页按钮）共用。
 * 失败抛 Error（带 code）。startWatcher=false 只给测试用。
 */
export function enqueue({ repo, sha, ref = sha, notifySession = null, runtimeKind, hours = 6, root = ROOT, startWatcher = true, ffBranch, ffFrom, action, expectedLive }) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const d = whenIdleDirs(root);
  if (!git(repo, "for-each-ref", "--contains", sha, "--format=%(refname)", "refs/heads", "refs/tags")) throw fail("NOT_ON_BRANCH", `提交 ${sha.slice(0, 7)} 不在任何分支或标签上，先提交到分支再请求部署`);
  if (spawnSync("git", ["-C", repo, "cat-file", "-e", `${sha}:scripts/deploy-gui.sh`]).status !== 0) throw fail("NO_DEPLOY_SCRIPT", `提交 ${sha.slice(0, 7)} 里没有 scripts/deploy-gui.sh`);
  const live = liveCommit(root);
  mkdirSync(d.requests, { recursive: true });
  const requestedAt = new Date().toISOString();
  const id = `${requestedAt.replace(/[-:.TZ]/g, "")}-${sha.slice(0, 7)}`;
  if (ffBranch && !(ffFrom && isAncestor(repo, ffFrom, sha))) throw fail("NOT_FAST_FORWARD", `提交 ${sha.slice(0, 7)} 不是 ${ffBranch}（${ffFrom?.slice(0, 7) ?? "-"}）的后续提交，部署成功后也没法快进`);
  const req = { id, sha, ref, ...(action === "rollback" ? { action, expectedLive } : {}), subject: commitSubject(repo, sha), repo, requestedAt, deadline: new Date(Date.now() + hours * 3600_000).toISOString(), liveAtRequest: live ?? null, notifySession, ...(runtimeKind ? { runtimeKind } : {}), ...(ffBranch ? { ffBranch, ffFrom } : {}) };
  const tmp = join(d.requests, `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify(req, null, 2)); renameSync(tmp, join(d.requests, `${id}.json`));

  // 守候脚本放到 ~/.pi-agent-gui/when-idle/ 再跑：不依赖请求方的工作区或当前槽位还在
  let pid = watcherPid(root);
  if (startWatcher && !existsSync(join(root, "control", "deploy-worker.plist"))) {
    rmSync(join(d.requests, `${id}.json`), { force: true });
    throw fail("WORKER_NOT_INSTALLED", "独立部署服务尚未安装；先运行 scripts/install-gui-control.mjs");
  }
  // The launchd worker polls durable requests. Never spawn a worker inheriting the requesting runtime's sandbox.

  return { request: req, live, watcherPid: pid, log: d.log };
}

/* ------------------------------ request ------------------------------ */

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

async function request(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const worktree = dirname(here);
  const ref = arg(argv, "--ref") || "main";
  const sha = git(worktree, "rev-parse", "--verify", `${ref}^{commit}`);
  if (!sha) { console.error(`找不到提交：${ref}`); process.exit(2); }
  // 守候进程在主仓库里跑（工作区可能被删）；部署用的是目标提交自己的 deploy-gui.sh
  const repo = dirname(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const activity = await getJson("/api/runtime/activity");
  const who = resolveRequester({ explicit: arg(argv, "--notify-session"), envId: process.env.PI_AGENT_RUNTIME_SESSION_ID, cwd: realpathSync(process.cwd()), active: (activity?.active ?? []).map((s) => ({ ...s, workspace: s.workspace ? (() => { try { return realpathSync(s.workspace); } catch { return s.workspace; } })() : undefined })) });
  const hours = Number(arg(argv, "--hours") || 6);
  let r;
  try { r = enqueue({ repo, sha, ref, notifySession: who.id ?? null, hours }); }
  catch (e) { console.error(e.message); process.exit(2); }
  console.log(`已登记：空闲时部署 ${sha.slice(0, 7)}（${r.request.subject}）`);
  console.log(`线上现在是 ${r.live?.slice(0, 7) ?? "-"}；最多等 ${hours} 小时`);
  console.log(who.id ? `部署结束后会给会话 ${who.id} 发结果（${who.how}）` : `部署结束后不会通知会话：${who.why}`);
  console.log(`守候进程 ${r.watcherPid}；日志 ${r.log}；查看排队：scripts/deploy-gui.sh --status`);
  console.log("请结束这一轮：只要还有会话在跑，部署就会一直等着。");
}

/* ------------------------------ status ------------------------------ */

function status() {
  const reqs = readRequests();
  const pid = watcherPid();
  if (!reqs.length) { console.log("空闲时部署：没有排队的请求"); return; }
  console.log(`空闲时部署：${reqs.length} 个请求排队，守候进程${pid ? ` ${pid} 在等` : "没在运行（下次请求会重新拉起）"}`);
  for (const q of reqs) console.log(`  ${q.sha.slice(0, 7)}  ${q.requestedAt}  通知 ${q.notifySession ?? "-"}  ${q.subject ?? ""}`);
  try { const tail = readFileSync(LOG, "utf8").trimEnd().split("\n").slice(-1)[0]; if (tail) console.log(`  最近：${tail}`); } catch { /* 还没有日志 */ }
}

/* ------------------------------ watch ------------------------------ */

async function notify(q, outcome, extra) {
  if (!q.notifySession) return;
  const prompt = notifyPrompt({ outcome, sha: q.sha, subject: q.subject ?? "", logFile: extra.logFile ?? LOG, live: extra.live, detail: extra.detail, requestSha: q.requestSha, requestId: q.id });
  await sendToSession(q.notifySession, notifyKey(q.id), prompt, outcome);
}

/** 给会话续聊一条消息；返回受理的操作 id（没发出去返回 undefined） */
async function sendToSession(session, idempotencyKey, prompt, label) {
  // 刚重启时服务和会话都在恢复，会话也可能正被用户续聊：每 20 秒试一次，最多 30 分钟
  for (let i = 0; i < 90; i++) {
    const v = await getJson(`/api/runtime-sessions/${encodeURIComponent(session)}`);
    const s = v?.session;
    if (s && s.status === "idle") {
      try {
        const r = await postJson(`/api/runtime-sessions/${encodeURIComponent(session)}/turns`, { idempotencyKey, prompt, expectedRevision: s.bindingRevision });
        if (r.status === 201) { log(`已通知会话 ${session}（${label}）`); return r.body?.operation?.operationId ?? ""; }
        log(`通知会话 ${session} 被拒（${r.status} ${r.body?.code ?? ""} ${r.body?.error ?? ""}）`);
        // 只重试临时的版本冲突和服务重启；RT_IDENTITY（登录身份空间变了）重试不会成功，直接放弃
        const retryable = r.status === 503 || (r.status === 409 && r.body?.code === "RT_CONFLICT");
        if (!retryable) return undefined;
      } catch (e) { log(`通知会话 ${session} 出错：${e.message}`); }
    } else if (s && !["running", "creating", "waiting-input", "stopping"].includes(s.status)) {
      log(`会话 ${session} 状态是 ${s.status}，不通知`); return undefined;
    }
    await sleep(20_000);
  }
  log(`30 分钟内没能通知会话 ${session}`);
  return undefined;
}

/**
 * 部署前集成冲突：会话分支上的请求（ffBranch）交给请求它的会话去合并解决，结束后由 Web 服务自动重新登记。
 * 已自动处理够 AUTO_RESOLVE_MAX 次、或消息发不出去时返回说明，由调用方按普通失败通知（交给人）。
 */
async function autoResolveIntegration(q, candidate, { repo, branch, live }) {
  const prev = readAutoResolve(q.notifySession);
  const attempt = (prev?.attempts ?? 0) + 1;
  const base = { session: q.notifySession, attempts: attempt, max: AUTO_RESOLVE_MAX, conflicts: candidate.conflicts, stage: "integration", head: q.sha, branch };
  if (attempt > AUTO_RESOLVE_MAX) {
    const reason = `已自动解决 ${AUTO_RESOLVE_MAX} 次仍和 ${branch} 冲突：${candidate.conflicts.join("、")}`;
    writeAutoResolve({ ...base, attempts: prev.attempts, phase: "needs-human", reason });
    return { handled: false, detail: `${reason}，需要你来处理。` };
  }
  const tip = git(repo, "rev-parse", `refs/heads/${branch}`);
  const liveOutside = live && tip && !isAncestor(repo, live, tip) ? live : undefined;
  const prompt = autoResolvePrompt({ branch, conflicts: candidate.conflicts, attempt, stage: "integration", ...(liveOutside ? { live: liveOutside } : {}) });
  const operationId = await sendToSession(q.notifySession, autoResolveKey(q.notifySession, attempt), prompt, `解决冲突 ${attempt}/${AUTO_RESOLVE_MAX}`);
  if (operationId === undefined) {
    const reason = `部署前集成冲突（${candidate.conflicts.join("、")}），但没能把解决冲突的消息发给会话`;
    writeAutoResolve({ ...base, attempts: prev?.attempts ?? 0, phase: "needs-human", reason });
    return { handled: false, detail: `${reason}，需要你来处理。` };
  }
  writeAutoResolve({ ...base, phase: "resolving", operationId });
  return { handled: true };
}
function finish(q, outcome, note, root = ROOT, deployedSha) {
  rmSync(q.file, { force: true });
  appendFileSync(join(whenIdleDirs(root).home, "history.log"), `${now()}\t${q.sha.slice(0, 7)}\t${outcome}\t${q.notifySession ?? "-"}\t${historyField(note)}\t${historyField(q.subject)}\t${historyField(q.runtimeKind)}\t${CONTROLLER_VERSION}\t${historyField(q.id)}\t${historyField(deployedSha)}\n`);
}
/**
 * Mark an attempt started or pending under the same lock used for cancellation.
 * r+ 打开：刚被取消（文件已删）的不会被重新写出来，也不算进这次部署。
 */
export function markRequests(qs, startedAt, update) {
  return qs.filter(q => withDeploymentActions(dirname(dirname(q.file)), () => {
    try {
      const latest = JSON.parse(readFileSync(q.file, "utf8"));
      const tmp = `${q.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...latest, ...update, file: undefined, startedAt }, null, 2)); renameSync(tmp, q.file);
      return true;
    } catch { return false; }
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 每次部署的流程步骤只在 progress.json 里，下一次部署就会被覆盖：结束时按提交存一份到 runs/<短 sha>.json，
 * 让部署结果通知事后仍能回看各阶段耗时和选测依据。重试同一提交时后一次覆盖前一次；只保留最近 RUNS_KEEP 份。
 */
const RUNS_KEEP = 300;
export function archiveRun(root, progressFile, sha, code) {
  try {
    const p = JSON.parse(readFileSync(progressFile, "utf8"));
    if (p.sha !== sha || !Array.isArray(p.steps)) return;
    const dir = join(whenIdleDirs(root).home, "runs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sha.slice(0, 7)}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...p, requests: undefined, exitCode: code, finishedAt: new Date().toISOString() }));
    renameSync(`${file}.tmp`, file);
    const old = readdirSync(dir).filter(f => f.endsWith(".json")).map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(RUNS_KEEP);
    for (const { f } of old) rmSync(join(dir, f), { force: true });
  } catch { /* 存档失败不影响部署结果 */ }
}

/** Waiting cutovers yield only to work that the next staging pass can actually process. */
export function shouldYieldCutover(repo, sha, root = ROOT) {
  const staged = readStaged(root);
  if (!staged || staged.sha !== sha) return false;
  const live = liveCommit(root), legacy = readBaselineRed(root), now = Date.now();
  const requests = readRequests(root).filter(q => q.repo === repo && !q.action &&
    (staged.ids.includes(q.id) || requestDeadline(q, baselineRedForRequest(q, legacy), now) >= now));
  const step = planStaging({ requests, live, staged, isAncestor: isAncestorIn(repo),
    isCooling: coolingRequests(live, legacy, now)
  });
  return step.action === "stage";
}

export function runDeploy(repo, sha, logFile, root = ROOT, syncBranches = [], options = {}) {
  if (options.coveredIds && !readRequests(root).some(q => options.coveredIds.includes(q.id))) return Promise.resolve(77);
  for (const branch of new Set(options.action === "rollback" || options.stageOnly ? [] : [...syncBranches, ...readRequests(root).filter(q => !q.action && isAncestor(repo, q.sha, sha)).map(q => q.ffBranch).filter(Boolean)])) {
    const tip = git(repo, "rev-parse", `refs/heads/${branch}`);
    if (!tip || !isAncestor(repo, tip, sha)) { appendFileSync(logFile, `${branch} 已变化，不能快进到待部署提交\n`); return Promise.resolve(76); }
  }
  // 用目标提交自己的部署脚本：部署流程随代码一起演进。PI_AGENT_WHEN_IDLE_DEPLOY 只给测试换成替身，不碰线上服务
  const fake = process.env.PI_AGENT_WHEN_IDLE_DEPLOY;
  const installed = join(root, "control", "deploy-gui.sh");
  const script = fake || (existsSync(installed) ? installed : join(whenIdleDirs(root).home, `deploy-gui-${sha.slice(0, 12)}.sh`));
  if (!fake && script !== installed) writeFileSync(join(whenIdleDirs(root).home, "deployment-actions.mjs"), readFileSync(new URL("./deployment-actions.mjs", import.meta.url)));
  if (!fake && script !== installed) writeFileSync(script, spawnSync("git", ["-C", repo, "show", `${sha}:scripts/deploy-gui.sh`], { encoding: "utf8" }).stdout, { mode: 0o755 });
  return new Promise((resolve) => {
    mkdirSync(whenIdleDirs(root).home, { recursive: true });
    const progressFile = join(whenIdleDirs(root).home, "progress.json");
    const initialized = withDeploymentActions(whenIdleDirs(root).home, () => {
      const at = new Date().toISOString();
      const requests = readRequests(root).filter(q => q.startedAt && (options.coveredIds ? options.coveredIds.includes(q.id) : isAncestor(repo, q.sha, sha))).map(q => ({ id: q.id, startedAt: q.startedAt }));
      if (options.coveredIds?.length && !requests.length) return false;
      writeFileSync(`${progressFile}.tmp`, JSON.stringify({ sha, requests, phase: "preparing", since: at, steps: [{ phase: "preparing", at }], ...(options.timeline ? { staging: options.timeline } : {}) }));
      renameSync(`${progressFile}.tmp`, progressFile);
      return true;
    });
    if (!initialized) { if (!fake && script !== installed) rmSync(script, { force: true }); resolve(77); return; }
    const out = openSync(logFile, "a");
    const child = spawn("/bin/bash", [script, ...(options.action === "rollback" ? ["--rollback", "--expected-live", options.expectedLive] : []), ...(options.stageOnly ? ["--stage-only"] : []), ...(options.args ?? []), "--ref", sha], { stdio: ["ignore", out, out], cwd: repo, env: { ...process.env, ...options.env, PI_AGENT_REPO: repo, PI_AGENT_DEPLOY_PROGRESS: progressFile } });
    child.on("exit", (code) => { closeSync(out); if (!fake && script !== installed) rmSync(script, { force: true }); archiveRun(root, progressFile, sha, code ?? 1); resolve(code ?? 1); });
  });
}

/**
 * 部署结束后：判定成败、成功时快进请求里的 ffBranch、结束这些请求。返回要发给各会话的通知（由调用方发送）。
 */
/** 带红放行：门禁里线上同样红的测试没拦这次部署。上线通知里写明文件和已红多久，请会话（或你）有空去修，别让它一直红着。 */
export function waivedNote(logText) {
  const lines = String(logText).split("\n");
  const age = lines.reverse().find((l) => l.startsWith("带红放行（已红时长）："));
  if (age) return `⚠ 带红上线：${age.slice("带红放行（已红时长）：".length)}。这些测试在线上版本上同样不过，与本次部署无关，所以没有拦；建议另开会话修复，修好前每次发布都会带着它们。`;
  const v = parseBaselineRed(lines.join("\n"));
  return v?.files.length ? `⚠ 带红上线：${v.files.join("、")}。这些测试在线上版本上同样不过，与本次部署无关，所以没有拦；建议另开会话修复。` : "";
}
export function settleDeploy({ repo, sha, code, covered, logFile, root = ROOT }) {
  covered = covered.filter(q => existsSync(q.file));
  const nowLive = liveCommit(root);
  const ok = code === 0 && nowLive === sha;
  let logText = "";
  try { logText = readFileSync(logFile, "utf8"); } catch { /* 没有日志 */ }
  const tail = logText.trimEnd().split("\n").slice(-12).join("\n");
  const hints = ok ? [] : failureHints(logText);
  const ffs = new Map();
  for (const b of new Set(covered.map((q) => q.ffBranch).filter(Boolean))) {
    ffs.set(b, ok ? fastForwardAfterDeploy(repo, b, sha) : { result: "unchanged", tip: git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${b}^{commit}`) });
  }
  const notes = [];
  for (const q of covered) {
    const ff = q.ffBranch ? ffs.get(q.ffBranch) : undefined;
    if (ok && ff?.result === "diverged") {
      // Slot activation and branch synchronization are separate operations. Retain the same
      // request if another writer moved main in between, so the next idle pass repairs it.
      markRequests([q], undefined);
      continue;
    }
    const main = q.ffBranch ? ffNote({ branch: q.ffBranch, sha, outcome: ok ? "ok" : "failed", ff }) : "";
    finish(q, ok ? "ok" : `failed:${code}`, ff ? `${q.ffBranch}:${ff.result}` : undefined, root, ok ? sha : undefined);
    // 这次部署有了结果（成功或门禁没过）：自动解决冲突的过程到此为止
    if (q.notifySession) clearAutoResolve(q.notifySession, root);
    const detail = [main, ok ? waivedNote(logText) : "", ...hints, ok ? "" : `部署输出最后几行：\n${tail}`].filter(Boolean).join("\n");
    notes.push({ q: ok ? { ...q, sha, subject: commitSubject(repo, sha) ?? q.subject, requestSha: q.sha } : q, outcome: ok ? "ok" : "failed", extra: { live: nowLive, logFile, ...(detail ? { detail } : {}) } });
  }
  return { ok, live: nowLive, ff: Object.fromEntries(ffs), notes };
}

async function watch() {
  mkdirSync(HOME_DIR, { recursive: true });
  const other = watcherPid();
  if (other && other !== process.pid) { log(`已有守候进程 ${other}，退出`); return; }
  writeFileSync(PID_FILE, String(process.pid));
  log(`守候进程 ${process.pid} 启动`);
  let lastWait = "", testRetries = new Map();
  try {
    for (;;) {
      const reqs = readRequests();
      if (!reqs.length) { if (process.argv.includes("--persistent")) { await sleep(10000); continue; } log("没有排队的请求，退出"); return; }
      const live = liveCommit();
      const legacyRed = readBaselineRed(), nowMs = Date.now();
      const stagedIds = new Set(readStaged()?.ids ?? []);
      for (const q of reqs) if (requestDeadline(q, baselineRedForRequest(q, legacyRed), nowMs) < nowMs && !stagedIds.has(q.id)) {
        log(`${q.sha.slice(0, 7)} 等空闲超时，放弃`); finish(q, "expired"); await notify(q, "expired", { live });
      }
      const pending = readRequests();
      if (!pending.length) continue;
      // Never compare or combine requests from different repositories.
      const repo = pending[0].repo;
      const rollback = pending[0].action === "rollback" ? pending[0] : null;
      if (rollback) {
        const reasons = busyReasons({ activity: await getJson("/api/runtime/activity"), piTasks: await piTaskCount(), locked: existsSync(join(ROOT, ".deploy.lock")), vitest: vitestCount() });
        if (reasons.length) { await sleep(10000); continue; }
        if (!markRequests([rollback], new Date().toISOString()).length) continue;
        const logFile = join(HOME_DIR, `rollback-${rollback.id}.log`);
        const code = await runDeploy(repo, rollback.sha, logFile, ROOT, [], { action: "rollback", expectedLive: rollback.expectedLive, coveredIds: [rollback.id] });
        if (code === 77) continue;
        if (code === BUSY_EXIT) { markRequests([rollback], undefined); await sleep(10000); continue; }
        const r = settleDeploy({ repo, sha: rollback.sha, code, covered: [rollback], logFile });
        for (const n of r.notes) await notify(n.q, n.outcome, { ...n.extra, detail: "回滚请求。" + (n.extra.detail || "") });
        continue;
      }
      const plan = planDeploy(pending.filter(q => q.repo === repo && !q.action), live, isAncestorIn(repo));
      if (live && plan.done.length) {
        // Recover activation without re-deploying just because a local checkout cannot sync.
        const recovered = settleDeploy({ repo, sha: live, code: 0, covered: plan.done.map(q => ({ ...q, ffBranch: q.ffBranch ?? "main" })), logFile: LOG });
        const finished = new Set(recovered.notes.map(n => n.q.id));
        for (const q of plan.done) {
          if (!finished.has(q.id)) { plan.covered.push(q); plan.target ??= q.sha; continue; }
          log(`${q.sha.slice(0, 7)} 已在线上；${q.ffBranch ?? "分支"} 同步结果 ${recovered.ff[q.ffBranch ?? "main"]?.result ?? "无需同步"}`);
        }
        for (const n of recovered.notes) await notify(n.q, "already-live", n.extra);
      }
      if (!plan.target) continue;

      // 叠加预发：先逐个叠加（不等会话空闲），都处理完再一次切换（见 planStaging）
      const open = pending.filter(q => q.repo === repo && !q.action);
      const staged = readStaged();
      const isAnc = isAncestorIn(repo);
      const step = planStaging({ requests: open, live, staged, isAncestor: isAnc,
        isCooling: coolingRequests(live, legacyRed, nowMs)
      });
      // 依赖了已跳过请求的请求：一并跳过，切换后再试
      if (step.dependent.length && staged) {
        const skipped = { ...staged.skipped };
        for (const d of step.dependent) { skipped[d.request.id] = { sha: d.request.sha, at: new Date().toISOString(), detail: `基于已跳过的 ${d.on.slice(0, 7)}` }; log(`${d.request.sha.slice(0, 7)} 带着已跳过请求 ${d.on.slice(0, 7)} 的改动，一并跳过，切换后再试`); }
        writeStaged({ ...staged, skipped }); continue;
      }
      if (step.action === "reset") {
        log(`预发失效（${step.reason}），重新叠加`);
        clearStaged(); retireStagedRef(repo, undefined);
        markRequests(open.filter(q => staged?.ids.includes(q.id)), undefined);
        continue;
      }
      if (step.action === "idle") { await sleep(10_000); continue; }

      // 叠加和切换都不再等所有会话同时空闲：只避开另一次部署（锁、排空）
      const reasons = busyReasons({ activity: await getJson("/api/runtime/activity"), piTasks: 0, locked: existsSync(join(ROOT, ".deploy.lock")), vitest: 0, preparing: true });
      if (reasons.length) {
        const w = reasons.join("；");
        if (w !== lastWait) { log(`等待：${w}`); lastWait = w; }
        await sleep(20_000); continue;
      }
      lastWait = "";

      if (step.action === "stage") {
        const q = step.request;
        const stacked = step.base !== live;
        const branch = q.ffBranch ?? "main";
        const inputs = { live, base: step.base, branchTip: branchTip(repo, branch) };
        const priorHold = baselineRedForRequest(q, legacyRed);
        // Mark before integration so cancellation cannot race candidate construction.
        const stageStartedAt = new Date().toISOString();
        const deadline = requestDeadline(q, priorHold, nowMs);
        const resumed = priorHold ? { baselineRed: null, ...(Number.isFinite(deadline) ? { deadline: new Date(deadline).toISOString() } : {}) } : undefined;
        if (!markRequests([q], stageStartedAt, resumed).length) { log("要预发的请求刚被取消"); continue; }
        const candidate = integrateDeploy({ repo, target: q.sha, live: step.base, branch });
        const skip = (detail) => { writeStaged({ ...staged, skipped: { ...staged.skipped, [q.id]: { sha: q.sha, at: new Date().toISOString(), detail } } }); markRequests([q], undefined); log(`${q.sha.slice(0, 7)} 叠加失败（${detail}），先跳过，切换后以新线上版本重试`); };
        if (!candidate.ok) {
          log(candidate.detail);
          if (candidate.retry) { markRequests([q], undefined); await sleep(15_000); continue; }
          if (stacked) { skip(candidate.detail); continue; }
          finish(q, "failed:integration", candidate.detail);
          // 会话分支上的请求遇到代码冲突：先让会话自己合并解决，结束后自动重新登记部署
          const auto = q.ffBranch && q.notifySession && candidate.conflicts.length
            ? await autoResolveIntegration(q, candidate, { repo, branch, live: liveCommit() }) : undefined;
          if (auto?.handled) { log(`${q.sha.slice(0, 7)} 集成冲突，已交给会话 ${q.notifySession} 解决`); continue; }
          if (q.notifySession && !auto) clearAutoResolve(q.notifySession);
          await notify(q, "failed", { live: liveCommit(), detail: `${candidate.detail}。线上与 ${branch} 未改动${auto?.detail ? `。${auto.detail}` : "，解决后再请求部署"}。` });
          continue;
        }
        const sha = candidate.sha;
        const logFile = join(HOME_DIR, `stage-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${sha.slice(0, 7)}.log`);
        appendFileSync(logFile, `预发：请求 ${q.sha}，叠加在 ${step.base ?? "-"} 上，候选 ${sha}\n`);
        const extraFiles = extraIntegratedFiles(repo, { base: live, requestSha: q.sha, candidateSha: sha });
        if (extraFiles.length) {
          const shown = extraFiles.slice(0, 20).join("、") + (extraFiles.length > 20 ? ` 等共 ${extraFiles.length} 个` : "");
          appendFileSync(logFile, `额外并入改动（非本请求提交直接修改，来自 ${branch} 或前置预发）：${shown}\n`);
        }
        log(`开始预发 ${sha.slice(0, 7)}（请求 ${q.sha.slice(0, 7)}，${stacked ? `叠加在已预发的 ${step.base.slice(0, 7)} 上` : "基于线上"}${extraFiles.length ? `，额外并入 ${extraFiles.length} 个文件` : ""}），输出见 ${logFile}`);
        try {
          keepStagedRef(repo, sha); // 预发过程中部署脚本要求提交在分支上；失败时再还原
          const code = await runDeploy(repo, sha, logFile, ROOT, [], { coveredIds: [q.id], stageOnly: true });
          if (code === 77) { log("预发请求已取消"); if (staged) keepStagedRef(repo, staged.sha); else retireStagedRef(repo, undefined); continue; }
          markRequests([q], undefined);
          if (code === 0) {
            writeStaged({ sha, ids: [...(staged?.ids ?? []), q.id], skipped: staged?.skipped ?? {}, live, timeline: { ...staged?.timeline, [q.id]: { startedAt: stageStartedAt, stagedAt: new Date().toISOString() } } });
            log(`已预发 ${sha.slice(0, 7)}（${(staged?.ids.length ?? 0) + 1} 个请求，线上未改动）`);
            continue;
          }
          // 这一步没预发成：预发引用还原到上一步通过的提交
          if (staged) keepStagedRef(repo, staged.sha); else retireStagedRef(repo, undefined);
          if (code === BUSY_EXIT) { log("预发时部署被占用（退出码 75），稍后重来"); await sleep(15_000); continue; }
          if ([BASELINE_RED_EXIT, TESTS_FAILED_EXIT].includes(code) && (liveCommit() !== inputs.live || branchTip(repo, branch) !== inputs.branchTip)) {
            testRetries.delete(q.id);
            log(`${q.sha.slice(0, 7)} 门禁运行期间线上或目标分支已变化，重新集成后再检查`);
            continue;
          }
          if (code === BASELINE_RED_EXIT) {
            const held = holdForBaselineRed({ repo, branch, target: q.sha, covered: [q], logFile, inputs });
            log(`主线测试红：${held.files.join("、") || "（见日志）"} 线上版本同样不过，请求保持排队、不通知失败；输出见 ${logFile}`);
            lastWait = "baseline-red";
            continue;
          }
          const retryKey = JSON.stringify(inputs);
          if (code === TESTS_FAILED_EXIT && testRetries.get(q.id) !== retryKey) { testRetries.set(q.id, retryKey); log(`预发门禁未通过，稍等后重试一次；输出见 ${logFile}`); await sleep(60_000); continue; }
          if (stacked) { skip(`预发门禁没过（退出码 ${code}）`); continue; }
          const r = settleDeploy({ repo, sha, code, covered: [{ ...q, ffBranch: q.ffBranch ?? branch }], logFile });
          log(`部署失败（退出码 ${code}），线上 ${r.live?.slice(0, 7)}`);
          for (const n of r.notes) await notify(n.q, n.outcome, n.extra);
        } finally { candidate.cleanup(); }
        continue;
      }

      if (step.action === "refresh") {
        // 目标分支前移：把新分支合进已预发的版本，补测这一步；合不进或没过就丢掉重新叠加
        const covered = markRequests(step.covered, new Date().toISOString());
        const branch = step.covered[0]?.ffBranch ?? "main";
        const candidate = covered.length ? integrateDeploy({ repo, target: step.sha, live: step.sha, branch }) : { ok: false, detail: "请求都已被取消", conflicts: [] };
        const drop = (why) => { log(`刷新预发失败（${why}），丢弃预发重新叠加`); markRequests(covered, undefined); clearStaged(); retireStagedRef(repo, undefined); };
        if (!candidate.ok) { drop(candidate.detail); continue; }
        try {
          const sha = candidate.sha;
          const logFile = join(HOME_DIR, `stage-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${sha.slice(0, 7)}.log`);
          appendFileSync(logFile, `刷新预发：把 ${branch} 合进 ${step.sha}，候选 ${sha}\n`);
          log(`刷新预发：${branch} 前移，合进已预发的 ${step.sha.slice(0, 7)} → ${sha.slice(0, 7)}，输出见 ${logFile}`);
          keepStagedRef(repo, sha);
          const code = await runDeploy(repo, sha, logFile, ROOT, [], { coveredIds: covered.map(q => q.id), stageOnly: true });
          if (code === 77) { keepStagedRef(repo, step.sha); continue; }
          markRequests(covered, undefined);
          if (code === 0) { writeStaged({ ...staged, sha, stale: false, live }); log(`已刷新预发 ${sha.slice(0, 7)}`); continue; }
          if (code === BUSY_EXIT) { keepStagedRef(repo, step.sha); await sleep(15_000); continue; }
          drop(`门禁退出码 ${code}`);
        } finally { candidate.cleanup(); }
        continue;
      }

      // cutover：所有可叠加的都叠加完了，把预发的版本一次切上去
      const covered = markRequests(step.covered, new Date().toISOString());
      if (!covered.length) { log("要切换的请求都已被取消，丢弃预发"); clearStaged(); retireStagedRef(repo, undefined); continue; }
      const branch = covered[0].ffBranch ?? "main";
      const sha = step.sha;
      const logFile = join(HOME_DIR, `deploy-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${sha.slice(0, 7)}.log`);
      appendFileSync(logFile, `切换预发版本：${sha}，覆盖 ${covered.length} 个请求，同步分支 ${branch}\n`);
      log(`开始切换预发版本 ${sha.slice(0, 7)}（覆盖 ${covered.length} 个请求；先不排空等空闲最多 ${Math.round(CUTOVER_WAIT_SECONDS / 60)} 分钟，仍不空闲再短排空兜底），输出见 ${logFile}`);
      const code = await runDeploy(repo, sha, logFile, ROOT, [branch], { coveredIds: covered.map(q => q.id), args: ["--cutover-wait", String(CUTOVER_WAIT_SECONDS), "--yield-to-requests"], timeline: stagingTimeline(covered, readStaged()) });
      if (code === 77) { log("部署请求已取消，预发未切换"); continue; }
      if (code === 79) {
        markRequests(covered, undefined);
        log("等待会话结束期间收到新部署，已释放排空并保留预发，继续叠加新请求");
        continue;
      }
      // 等对话结束超时（75）：预发留着，稍后再切；本地分支在这期间前移（76）：预发不含新提交，丢掉重新叠加
      if (code === BUSY_EXIT) { markRequests(covered, undefined); log("切换时仍有对话在进行（退出码 75），已释放排空，预发保留，稍后再切"); await sleep(30_000); continue; }
      if (code === 76) { markRequests(covered, undefined); writeStaged({ ...readStaged(), stale: true }); log("目标分支在预发期间前移（退出码 76），把新分支合进已预发的版本补测一步后再切换"); await sleep(5_000); continue; }
      if (code === BASELINE_RED_EXIT || code === TESTS_FAILED_EXIT) {
        // 切换前复核门禁（本应命中复用）没过：丢掉预发，回到逐个叠加，由单个请求的结果判成败
        markRequests(covered, undefined); clearStaged(); retireStagedRef(repo, undefined);
        log(`切换前门禁复核没过（退出码 ${code}），丢弃预发，重新逐个叠加；输出见 ${logFile}`);
        await sleep(15_000); continue;
      }
      const r = settleDeploy({ repo, sha, code, covered: covered.map(q => ({ ...q, ffBranch: q.ffBranch ?? branch })), logFile });
      log(r.ok ? `已上线 ${sha.slice(0, 7)}（${covered.length} 个请求）` : `部署失败（退出码 ${code}），线上 ${r.live?.slice(0, 7)}`);
      for (const [b, ff] of Object.entries(r.ff)) log(`${b}：${ff.result}（${ff.tip?.slice(0, 7) ?? "-"}${ff.result === "moved" ? ` → ${sha.slice(0, 7)}` : ""}）`);
      for (const n of r.notes) await notify(n.q, n.outcome, n.extra);
      clearStaged(); retireStagedRef(repo, r.ok ? sha : undefined, branch);
    }
  } finally {
    try { if (Number(readFileSync(PID_FILE, "utf8")) === process.pid) rmSync(PID_FILE); } catch { /* 已被清掉 */ }
  }
}

/* ------------------------------ 入口 ------------------------------ */

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, ...rest] = process.argv.slice(2);
  mkdirSync(HOME_DIR, { recursive: true });
  if (cmd === "check-cutover-yield") process.exitCode = shouldYieldCutover(rest[0], rest[1]) ? 79 : 0;
  else if (cmd === "request") await request(rest);
  else if (cmd === "status") status();
  else if (cmd === "watch") await watch();
  else { console.error("用法：deploy-when-idle.mjs request|status|watch"); process.exit(2); }
}
