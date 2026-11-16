/**
 * 回合结束校验用的「按结果取证」：回合开始和结束各给工作区拍一次快照（git status 的未提交路径 + 文件修改时间 / 大小，再加 HEAD），
 * 两次快照之间新增或变化的文件就是本回合改过的文件——不管模型是用 Edit 工具、apply_patch、sed，还是 python / node 脚本、cp、mv 写进去的。
 * 工具事件里认出的写文件路径仍然保留（两边取并集）；快照拍不了（不是 git 仓库、git 出错、超时）就只剩工具事件，不会因此误判。
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { committedPathsBetween, workspaceGitState } from "./worktree.js";

export interface WorkspaceSnapshot { root: string; head: string; /** 未提交路径（相对仓库根）→ 修改时间:大小 */ files: Map<string, string> }
export type WorkspaceRef = { workspace: string; worktree?: { repoRoot: string; path: string } };

const MAX_FILES = 3000;
const SNAPSHOT_TIMEOUT_MS = 8000;

const signatureOf = (file: string): string => { try { const s = statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return "gone"; } };

async function takeSnapshot(ref: WorkspaceRef): Promise<WorkspaceSnapshot | undefined> {
  const st = await workspaceGitState(ref.workspace, ref.worktree);
  if (!st) return undefined;
  const files = new Map<string, string>();
  for (const p of st.dirty.slice(0, MAX_FILES)) files.set(p, signatureOf(join(st.root, p)));
  return { root: st.root, head: st.head, files };
}

/** 拍快照；超时或失败返回 undefined（只是不取证，不影响会话）。 */
export async function snapshotWorkspace(ref: WorkspaceRef): Promise<WorkspaceSnapshot | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([takeSnapshot(ref), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), SNAPSHOT_TIMEOUT_MS); timer.unref(); })]);
  } catch { return undefined; } finally { if (timer) clearTimeout(timer); }
}

/** 两次快照之间未提交文件的变化：新出现的、或修改时间 / 大小变了的。开始时就脏、之后没再动的不算。 */
export function dirtyChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  return [...after.files].filter(([path, sig]) => before.files.get(path) !== sig).map(([path]) => path);
}

/** 从 before 起本回合（链）改过的文件：未提交的变化，加上期间本分支自己提交的文件。取不到当前状态返回空。 */
export async function changedFilesSince(before: WorkspaceSnapshot, ref: WorkspaceRef): Promise<string[]> {
  const after = await snapshotWorkspace(ref);
  if (!after) return [];
  const out = new Set(dirtyChanges(before, after));
  if (before.head && after.head && before.head !== after.head) for (const p of await committedPathsBetween(ref.workspace, ref.worktree, before.head, after.head)) out.add(p);
  return [...out];
}
