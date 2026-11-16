/**
 * 对比组的 git worktree 隔离（V3.2 P1）。
 *
 * 每条通道一个 worktree，全部从同一个 commit 切出（detached HEAD），放在 <仓库根>/.pi-compare/<组>/L<n>；
 * 目录名写进仓库的 .git/info/exclude（本地、不提交），不出现在原仓库的 git status 里。
 * 原仓库的未提交改动不会带进 worktree。
 *
 * 所有 git 调用都禁用 hooks（core.hooksPath=/dev/null）与 fsmonitor、不交互；diff 用临时 index，不改通道自己的暂存区。
 *
 * 通道能写自己的 worktree，包括其中的 `.git` 文件：改成指向它自己造的 gitdir（带 core.fsmonitor / filter 等配置）
 * 就能让宿主执行的 git 命令替它跑任意程序。所以在 worktree 里执行的 git 一律用 --git-dir / --work-tree 显式指定，
 * gitdir 取自主仓库自己的 worktrees/<名>/gitdir 记录（通道写不到），不按 worktree 里的 `.git` 文件发现仓库。
 */
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const COMPARE_DIR = ".pi-compare";
const SAFE_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

async function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<string> {
  if (opts.input !== undefined) return gitWithInput(cwd, args, opts.input, opts.env);
  const { stdout } = await run("git", [...SAFE_CONFIG, "-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...opts.env }, maxBuffer: 256 * 1024 * 1024, timeout: 60_000
  });
  return stdout;
}

function gitWithInput(cwd: string, args: string[], input: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", [...SAFE_CONFIG, "-C", cwd, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, maxBuffer: 64 * 1024 * 1024, timeout: 60_000
    }, (err, stdout, stderr) => err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve(String(stdout)));
    child.stdin?.end(input);
  });
}

const gitError = (e: unknown): string => {
  const x = e as { stderr?: string; message?: string };
  return (x.stderr || x.message || String(e)).trim().split("\n").slice(0, 6).join("\n");
};

export interface GitWorkspaceInfo {
  repoRoot: string;
  /** 工作目录相对仓库根的子路径（"" = 仓库根） */
  subdir: string;
  head: string;
  branch?: string;
  /** 未提交（含未跟踪）的文件数：这些改动不会带进 worktree */
  dirty: number;
}

/** 不是 git 仓库、或仓库还没有任何 commit：返回 undefined */
export async function gitWorkspaceInfo(dir: string): Promise<GitWorkspaceInfo | undefined> {
  let top: string;
  try { top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim(); } catch { return undefined; }
  if (!top) return undefined;
  const repoRoot = realpathSync(top);
  let head: string;
  try { head = (await git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim(); } catch { return undefined; }
  const branch = (await git(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim();
  const status = await git(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]).catch(() => "");
  const real = realpathSync(dir);
  const subdir = relative(repoRoot, real);
  return { repoRoot, subdir: subdir.startsWith("..") || isAbsolute(subdir) ? "" : subdir, head, ...(branch ? { branch } : {}), dirty: status.split("\n").filter((l) => l.trim() && !l.includes(`${COMPARE_DIR}/`)).length };
}

/** 对比目录写进 .git/info/exclude（worktree 共用主仓库的 info/exclude） */
async function ensureExcluded(repoRoot: string): Promise<void> {
  const common = (await git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const file = join(common, "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const line = `/${COMPARE_DIR}/`;
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!cur.split("\n").some((l) => l.trim() === line)) appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}# pi-agent 对比组的 worktree\n${line}\n`);
}

export function worktreePath(repoRoot: string, groupId: string, laneNo: number): string {
  return join(repoRoot, COMPARE_DIR, groupId, `L${laneNo}`);
}

export async function addWorktree(repoRoot: string, path: string, commit: string): Promise<void> {
  await ensureExcluded(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  try { await git(repoRoot, ["worktree", "add", "--detach", "--quiet", path, commit]); }
  catch (e) { throw new Error(`创建 worktree 失败：${gitError(e)}`); }
}

/** 删除 worktree（含通道里未提交的改动）并清掉空的组目录 */
export async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  if (existsSync(path)) {
    try { await git(repoRoot, ["worktree", "remove", "--force", "--force", path]); }
    catch { rmSync(path, { recursive: true, force: true }); }
  }
  await git(repoRoot, ["worktree", "prune"]).catch(() => undefined);
  const group = dirname(path);
  try { if (existsSync(group) && !readdirSync(group).length) rmdirSync(group); } catch { /* 忽略 */ }
  const base = join(repoRoot, COMPARE_DIR);
  try { if (existsSync(base) && !readdirSync(base).length) rmdirSync(base); } catch { /* 忽略 */ }
}

/**
 * 通道 worktree 的 gitdir：只从主仓库的 <common>/worktrees/*\/gitdir 记录里找（它们指回 <worktree>/.git），
 * 不读 worktree 里通道可改的 `.git` 文件。找不到说明 worktree 已失效或被篡改。
 */
export async function trustedGitDir(repoRoot: string, worktree: string): Promise<string> {
  const common = (await git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const dir = join(common, "worktrees");
  const want = join(worktree, ".git");
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const admin = join(dir, name);
    let target: string;
    try { target = readFileSync(join(admin, "gitdir"), "utf8").trim(); } catch { continue; }
    if (target === want) return admin;
  }
  throw new Error(`主仓库里没有这个 worktree 的登记：${worktree}`);
}

export interface LaneDiff {
  baseCommit: string;
  /** 通道 worktree 的 HEAD（通道自己 commit 过时与 base 不同） */
  head: string;
  files: Array<{ path: string; added: number | null; deleted: number | null; binary: boolean }>;
  added: number;
  deleted: number;
  /** 完整补丁（相对仓库根，含二进制）；对比 base 的已提交 + 未提交 + 未跟踪改动 */
  patch: string;
  patchHash: string;
}

/**
 * 通道相对 base 的全部改动：用临时 index（read-tree HEAD + add -A）收进未跟踪文件，
 * 不改通道自己的暂存区；遵守 .gitignore。
 */
export async function laneDiff(repoRoot: string, worktree: string, baseCommit: string): Promise<LaneDiff> {
  const index = join(tmpdir(), `pi-compare-index-${randomUUID()}`);
  try {
    const env = { GIT_INDEX_FILE: index, GIT_DIR: await trustedGitDir(repoRoot, worktree), GIT_WORK_TREE: worktree };
    await git(worktree, ["read-tree", "HEAD"], { env });
    await git(worktree, ["add", "-A", "--", "."], { env });
    const [patch, numstat, head] = await Promise.all([
      git(worktree, ["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", baseCommit], { env }),
      git(worktree, ["diff", "--cached", "--numstat", "-z", "--no-renames", baseCommit], { env }),
      git(worktree, ["rev-parse", "HEAD"], { env })
    ]);
    const files: LaneDiff["files"] = [];
    for (const rec of numstat.split("\0").filter(Boolean)) {
      const m = rec.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
      if (!m) continue;
      const binary = m[1] === "-";
      files.push({ path: m[3]!, added: binary ? null : Number(m[1]), deleted: binary ? null : Number(m[2]), binary });
    }
    return {
      baseCommit, head: head.trim(), files,
      added: files.reduce((n, f) => n + (f.added ?? 0), 0), deleted: files.reduce((n, f) => n + (f.deleted ?? 0), 0),
      patch, patchHash: `sha256:${createHash("sha256").update(patch).digest("hex")}`
    };
  } catch (e) {
    throw new Error(`读取通道改动失败：${gitError(e)}`);
  } finally { rmSync(index, { force: true }); }
}

/** 先 --check 再应用到原仓库的工作区（不改暂存区、不 commit）；冲突时整体不应用 */
export async function applyPatch(repoRoot: string, patch: string): Promise<void> {
  if (!patch.trim()) throw new Error("这条通道没有改动");
  try { await git(repoRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], { input: patch }); }
  catch (e) { throw new Error(`不能干净地应用到原目录（原目录的改动可能与之冲突）：${gitError(e)}`); }
  try { await git(repoRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patch }); }
  catch (e) { throw new Error(`应用失败：${gitError(e)}`); }
}

/** 规划中的 worktree 路径是否在仓库根之内（防止 groupId 等拼出越界路径） */
export function insideRepo(repoRoot: string, path: string): boolean {
  return path.startsWith(repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep);
}

/* ============================ 会话自己的 worktree（空闲时部署） ============================ */

/**
 * 单个会话可选在自己的 worktree 里改代码：<仓库根>/.pi-worktrees/<会话>，分支 pi/<会话>，从 base（默认 main）切出。
 * 改动全属于这个会话，所以「提交并部署」可以由宿主 add -A 提交，不会带上别的会话的未提交改动。
 * 同对比组一样：worktree 里执行的 git 一律用主仓库登记的 gitdir，不按 worktree 里会话可改的 `.git` 文件发现仓库。
 */
export const SESSION_WORKTREE_DIR = ".pi-worktrees";
export const sessionWorktreePath = (repoRoot: string, platformSessionId: string): string => join(repoRoot, SESSION_WORKTREE_DIR, platformSessionId);
export const sessionWorktreeBranch = (platformSessionId: string): string => `pi/${platformSessionId}`;

/** base 分支：有 main 用 main，否则 master，否则当前 HEAD */
export async function defaultBase(repoRoot: string): Promise<{ ref: string; commit: string }> {
  for (const ref of ["main", "master"]) {
    const commit = (await git(repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${ref}^{commit}`]).catch(() => "")).trim();
    if (commit) return { ref, commit };
  }
  return { ref: "HEAD", commit: (await git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() };
}

export async function addSessionWorktree(repoRoot: string, path: string, branch: string, commit: string): Promise<void> {
  await ensureExcludedDir(repoRoot, SESSION_WORKTREE_DIR, "pi-agent 会话的 worktree");
  mkdirSync(dirname(path), { recursive: true });
  try { await git(repoRoot, ["worktree", "add", "--quiet", "-b", branch, path, commit]); }
  catch (e) { throw new Error(`创建 worktree 失败：${gitError(e)}`); }
}

async function ensureExcludedDir(repoRoot: string, dir: string, note: string): Promise<void> {
  const common = (await git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const file = join(common, "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const line = `/${dir}/`;
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!cur.split("\n").some((l) => l.trim() === line)) appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}# ${note}\n${line}\n`);
}

/** 在会话 worktree 里执行 git：显式 --git-dir / --work-tree（取自主仓库登记），不信 worktree 里的 `.git` 文件 */
async function wtGit(repoRoot: string, worktree: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const gitDir = await trustedGitDir(repoRoot, worktree);
  return git(worktree, ["--git-dir", gitDir, "--work-tree", worktree, ...args], { env: { GIT_DIR: gitDir, GIT_WORK_TREE: worktree, ...env } });
}

export interface WorktreeStatus {
  head: string;
  /** 未提交（含未跟踪）的改动：porcelain 两位状态码 + 路径 */
  changes: Array<{ status: string; path: string }>;
  /** head 上有、base 分支上没有的提交数 / base 分支上有、head 上没有的提交数 */
  ahead: number;
  behind: number;
}
export async function sessionWorktreeStatus(repoRoot: string, worktree: string, baseRef: string): Promise<WorktreeStatus> {
  const [head, status, counts] = await Promise.all([
    wtGit(repoRoot, worktree, ["rev-parse", "HEAD"]),
    wtGit(repoRoot, worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    wtGit(repoRoot, worktree, ["rev-list", "--left-right", "--count", `HEAD...refs/heads/${baseRef}`])
  ]);
  const changes: WorktreeStatus["changes"] = [];
  const recs = status.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!;
    if (r.length < 4) continue;
    changes.push({ status: r.slice(0, 2), path: r.slice(3) });
    if (r[0] === "R" || r[0] === "C") i++; // 重命名带一条原路径
  }
  const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
  return { head: head.trim(), changes, ahead: ahead ?? 0, behind: behind ?? 0 };
}

/** 会话自身相对分叉点的净改动，包含暂存、未暂存和未跟踪文件；不把主线的新提交算作会话改动。 */
export async function sessionWorktreeDeployPaths(repoRoot: string, worktree: string, baseRef: string): Promise<string[]> {
  const base = (await wtGit(repoRoot, worktree, ["merge-base", "HEAD", `refs/heads/${baseRef}`])).trim();
  const [tracked, untracked] = await Promise.all([
    wtGit(repoRoot, worktree, ["diff", "--name-only", "--no-renames", "-z", base, "--"]),
    wtGit(repoRoot, worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
  ]);
  return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))];
}

/** 工作区的 git 状态：仓库根、HEAD、未提交（含未跟踪）的路径（相对仓库根）。会话 worktree 走登记的 gitdir，普通目录直接 -C。不是 git 仓库 / 取不到 → undefined。 */
export async function workspaceGitState(workspace: string, wt?: { repoRoot: string; path: string }): Promise<{ root: string; head: string; dirty: string[] } | undefined> {
  try {
    const g = (args: string[]): Promise<string> => wt ? wtGit(wt.repoRoot, wt.path, args) : git(workspace, args);
    const [root, head, status] = await Promise.all([wt ? Promise.resolve(wt.path) : g(["rev-parse", "--show-toplevel"]).then((x) => x.trim()), g(["rev-parse", "HEAD"]).then((x) => x.trim()).catch(() => ""), g(["status", "--porcelain=v1", "-z", "--untracked-files=all"])]);
    const dirty: string[] = [];
    const recs = status.split("\0");
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]!;
      if (r.length < 4) continue;
      dirty.push(r.slice(3));
      if (r[0] === "R" || r[0] === "C") i++;
    }
    return { root, head, dirty };
  } catch { return undefined; }
}

/** from → to 之间本分支自己提交过的路径（只走第一父链、不含合并提交，所以合并 main 带进来的别人的改动不算；from 不是 to 的祖先，如被 rebase 过，返回空）。 */
export async function committedPathsBetween(workspace: string, wt: { repoRoot: string; path: string } | undefined, from: string, to: string): Promise<string[]> {
  try {
    const g = (args: string[]): Promise<string> => wt ? wtGit(wt.repoRoot, wt.path, args) : git(workspace, args);
    await g(["merge-base", "--is-ancestor", from, to]);
    return (await g(["log", "--first-parent", "--no-merges", "--name-only", "--pretty=format:", `${from}..${to}`])).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

/** 提交 worktree 里的全部改动（遵守 .gitignore）；没有改动返回 undefined */
export async function commitSessionWorktree(repoRoot: string, worktree: string, message: string): Promise<string | undefined> {
  await wtGit(repoRoot, worktree, ["add", "-A", "--", "."]);
  const staged = await wtGit(repoRoot, worktree, ["diff", "--cached", "--name-only"]);
  if (!staged.trim()) return undefined;
  try { await wtGit(repoRoot, worktree, ["commit", "--quiet", "--no-verify", "-m", message]); }
  catch (e) { throw new Error(`提交失败：${gitError(e)}`); }
  return (await wtGit(repoRoot, worktree, ["rev-parse", "HEAD"])).trim();
}

/* ---------- index.html 里资源版本号（?v=）冲突的自动解决 ---------- */

/** 资源版本号所在的文件：scripts/version-web-assets.mjs 只改它 */
export const ASSET_VERSION_FILE = "apps/web/public/index.html";
const ASSET_PUBLIC_DIR = "apps/web/public";

/** 一行是不是引用本地 js/css 资源并带版本号（?v=...） */
export function isAssetVersionLine(line: string): boolean {
  return /(?:src|href)="\/[^"?]+\.(?:js|css)\?/.test(line);
}

/** 去掉 ?v= 后面的值，只留资源路径与标签结构：用来判断两侧是不是同一行只差版本号 */
const stripAssetVersion = (line: string): string => line.replace(/(\?v=)[^"]*/g, "$1");

/**
 * index.html 的冲突块如果两侧只差资源版本号（?v=...），就取 base（变基时是 main）一侧解决——版本号稍后按文件字节重算。
 * 只要有一个冲突块掺了别的内容（改了标签、换了资源、增删行）就整体不解决，交回会话。
 */
export function resolveAssetVersionConflicts(text: string): { ok: true; content: string; hunks: number } | { ok: false; reason: string } {
  const lines = text.split("\n");
  const out: string[] = [];
  let hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^<{7}(?: |$)/.test(lines[i]!)) { out.push(lines[i]!); continue; }
    const ours: string[] = [], theirs: string[] = [];
    let phase: "ours" | "base" | "theirs" | "done" = "ours";
    for (i++; i < lines.length; i++) {
      const l = lines[i]!;
      if (phase === "ours" && /^\|{7}(?: |$)/.test(l)) { phase = "base"; continue; }
      if ((phase === "ours" || phase === "base") && /^={7}(?: |$)/.test(l)) { phase = "theirs"; continue; }
      if (phase === "theirs" && /^>{7}(?: |$)/.test(l)) { phase = "done"; break; }
      if (phase === "ours") ours.push(l); else if (phase === "theirs") theirs.push(l);
    }
    if (phase !== "done") return { ok: false, reason: "冲突标记不完整" };
    if (!ours.length || ours.length !== theirs.length) return { ok: false, reason: "两侧行数不同" };
    for (let k = 0; k < ours.length; k++) {
      const a = ours[k]!, b = theirs[k]!;
      if (!isAssetVersionLine(a) || !isAssetVersionLine(b) || stripAssetVersion(a) !== stripAssetVersion(b))
        return { ok: false, reason: `冲突行不是同一资源的版本号：${a.trim().slice(0, 120)}` };
    }
    out.push(...ours);
    hunks++;
  }
  return hunks ? { ok: true, content: out.join("\n"), hunks } : { ok: false, reason: "没有找到版本号冲突块" };
}

/** 按文件字节重算 index.html 里所有 js/css 的 ?v=（与 scripts/version-web-assets.mjs 一致；宿主自己算，不执行 worktree 里的脚本） */
export function refreshAssetVersions(text: string, read: (requestPath: string) => Buffer | string): string {
  return text.replace(/((?:src|href)="\/(?:[^"?]+\.(?:js|css)))(?:\?[^"]*)?"/g, (_match, prefix: string) => {
    const requestPath = prefix.slice(prefix.indexOf('"') + 1);
    return `${prefix}?v=${createHash("sha256").update(read(requestPath)).digest("hex").slice(0, 12)}"`;
  });
}

const unmergedFiles = async (repoRoot: string, worktree: string): Promise<string[]> =>
  (await wtGit(repoRoot, worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
    .split("\n").map((s) => s.trim()).filter(Boolean);

/** 只读 worktree 里 apps/web/public 下的资源并算哈希：路径越界就拒绝，不执行任何 worktree 里的脚本 */
function readPublicAsset(worktree: string, requestPath: string): Buffer {
  const base = join(worktree, ASSET_PUBLIC_DIR);
  const rel = relative(base, join(base, requestPath));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`资源路径越界：${requestPath}`);
  return readFileSync(join(base, requestPath));
}

const MAX_ASSET_RESOLVE_ROUNDS = 20;

/**
 * 变基已在冲突中暂停：冲突只有 index.html 且冲突块只差资源版本号时就地解决并 --continue，继续变基可能再遇到同类冲突，最多重试若干轮。
 * 返回新的 head；不能自动解决时返回冲突文件与原因（调用方负责 abort）。
 */
async function tryResolveAssetVersionRebase(repoRoot: string, worktree: string, conflicts: string[]): Promise<
  { ok: true; head: string; chunks: number } | { ok: false; conflicts: string[]; detail?: string }> {
  let chunks = 0;
  for (let round = 0; round < MAX_ASSET_RESOLVE_ROUNDS; round++) {
    if (conflicts.length !== 1 || conflicts[0] !== ASSET_VERSION_FILE) return { ok: false, conflicts };
    try {
      const file = join(worktree, ASSET_VERSION_FILE);
      const parsed = resolveAssetVersionConflicts(readFileSync(file, "utf8"));
      if (!parsed.ok) return { ok: false, conflicts, detail: `index.html 的冲突不能自动解决：${parsed.reason}` };
      writeFileSync(file, refreshAssetVersions(parsed.content, (p) => readPublicAsset(worktree, p)));
      await wtGit(repoRoot, worktree, ["add", "--", ASSET_VERSION_FILE]);
      chunks += parsed.hunks;
    } catch (e) { return { ok: false, conflicts, detail: gitError(e) }; }
    try {
      await wtGit(repoRoot, worktree, ["rebase", "--continue"], { GIT_EDITOR: "true" });
      return { ok: true, head: (await wtGit(repoRoot, worktree, ["rev-parse", "HEAD"])).trim(), chunks };
    } catch (e) {
      const next = await unmergedFiles(repoRoot, worktree);
      if (!next.length) return { ok: false, conflicts, detail: gitError(e) };
      conflicts = next;
    }
  }
  return { ok: false, conflicts, detail: "自动解决的版本号冲突次数过多" };
}

/**
 * 把 worktree 分支变基到 base 分支最新提交上。index.html 里只差资源版本号（?v=）的冲突自动解决（按文件字节重算），
 * 其余冲突整体放弃（--abort）并返回冲突文件。
 */
export async function rebaseSessionWorktree(repoRoot: string, worktree: string, baseRef: string): Promise<{ ok: true; head: string; autoResolvedAssets?: number } | { ok: false; conflicts: string[]; detail: string }> {
  try {
    await wtGit(repoRoot, worktree, ["rebase", "--quiet", `refs/heads/${baseRef}`]);
    return { ok: true, head: (await wtGit(repoRoot, worktree, ["rev-parse", "HEAD"])).trim() };
  } catch (e) {
    const conflicts = await unmergedFiles(repoRoot, worktree);
    const auto = await tryResolveAssetVersionRebase(repoRoot, worktree, conflicts);
    if (auto.ok) return { ok: true, head: auto.head, autoResolvedAssets: auto.chunks };
    await wtGit(repoRoot, worktree, ["rebase", "--abort"]).catch(() => undefined);
    return { ok: false, conflicts: auto.conflicts.length ? auto.conflicts : conflicts, detail: auto.detail ?? gitError(e) };
  }
}

/**
 * 分支在哪些 worktree（含主仓库目录）里检出。检出中的分支不能由宿主直接前移，否则那个 worktree 的文件会和分支对不上；
 * 「提交并在空闲时部署」登记前用它挡掉注定不能前移 main 的请求（前移本身在部署成功后由守候进程做）。
 */
export async function branchCheckouts(repoRoot: string, branch: string): Promise<string[]> {
  const list = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  return list.split("\n\n").filter((b) => b.split("\n").includes(`branch refs/heads/${branch}`)).map((b) => b.split("\n")[0]!.replace(/^worktree /, ""));
}

/** 归档单聊时直接删除专属目录和分支（含未提交、未合并改动），不读取会话可改的 .git。 */
export async function removeSessionWorktree(repoRoot: string, worktree: string, branch: string): Promise<void> {
  if (!/^pi\/rt-[a-f0-9]{16}$/.test(branch) || worktree !== sessionWorktreePath(repoRoot, branch.slice(3))) {
    throw new Error("会话 worktree 路径或分支不匹配，拒绝删除");
  }
  const base = dirname(worktree);
  if (existsSync(base) && realpathSync(base) !== join(realpathSync(repoRoot), SESSION_WORKTREE_DIR)) {
    throw new Error("会话 worktree 父目录已被改动，拒绝删除");
  }
  await rm(worktree, { recursive: true, force: true });
  await git(repoRoot, ["worktree", "prune", "--expire", "now"]);
  const exists = (await git(repoRoot, ["branch", "--list", branch])).trim();
  if (exists) await git(repoRoot, ["branch", "-D", branch]);
  try { if (existsSync(base) && !readdirSync(base).length) rmdirSync(base); } catch { /* 其他会话仍在使用 */ }
}

/** 创建失败时的保守回收：没有未提交改动，分支已并进 base；删掉 worktree 和分支 */
export async function removeSessionWorktreeIfMerged(repoRoot: string, worktree: string, branch: string, baseRef: string): Promise<{ removed: boolean; reason?: string }> {
  if (!existsSync(worktree)) { await git(repoRoot, ["worktree", "prune"]).catch(() => undefined); return { removed: false, reason: "worktree 已不存在" }; }
  const s = await sessionWorktreeStatus(repoRoot, worktree, baseRef);
  if (s.changes.length) return { removed: false, reason: `还有 ${s.changes.length} 个未提交的改动` };
  if (s.ahead) return { removed: false, reason: `还有 ${s.ahead} 个提交没进 ${baseRef}` };
  // 直接删目录再 prune：`git worktree remove` 会读 worktree 里会话可改的 `.git` 文件
  rmSync(worktree, { recursive: true, force: true });
  await git(repoRoot, ["worktree", "prune"]).catch(() => undefined);
  await git(repoRoot, ["branch", "-D", branch]).catch(() => undefined);
  const base = join(repoRoot, SESSION_WORKTREE_DIR);
  try { if (existsSync(base) && !readdirSync(base).length) rmdirSync(base); } catch { /* 忽略 */ }
  return { removed: true };
}
