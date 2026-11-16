/** Discover host-owned linked worktree metadata without executing repository hooks/config. */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { canonicalPath, isWithin } from "../../adapter-pi/src/runtime-guard-policy.js";

export interface PiWorktreeAccess { readRoots: string[]; writeRoots: string[]; branch?: string }
export interface PiWorktreeIdentity { repoRoot: string; path: string; branch: string }
export function piWorktreeAccess(workspace: string, expected?: PiWorktreeIdentity): PiWorktreeAccess | undefined {
  try {
    const cwd = realpathSync(workspace), root = expected ? realpathSync(expected.path) : cwd;
    if (!isWithin(cwd, root)) return;
    const pointer = join(root, ".git");
    if (!lstatSync(pointer).isFile() || lstatSync(pointer).isSymbolicLink()) return;
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(pointer, "utf8"));
    if (!match) return;
    const admin = realpathSync(resolve(root, match[1]));
    const common = realpathSync(resolve(admin, readFileSync(join(admin, "commondir"), "utf8").trim()));
    if (basename(common) !== ".git" || dirname(admin) !== join(common, "worktrees") || isWithin(common, root) || isWithin(root, common)) return;
    if (expected && realpathSync(join(expected.repoRoot, ".git")) !== common) return;
    if (realpathSync(readFileSync(join(admin, "gitdir"), "utf8").trim()) !== realpathSync(pointer)) return;
    const access: PiWorktreeAccess = { readRoots: [common, ...(cwd !== root ? [root] : [])], writeRoots: [] };
    const head = readFileSync(join(admin, "HEAD"), "utf8").trim();
    const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
    // A branch path must be literal, cannot traverse or select another namespace.
    if (!branch || (expected && expected.branch !== branch) || !/^[A-Za-z0-9_/-]+$/.test(branch) || branch.split("/").some(p => !p) || readFileSync(join(common, "HEAD"), "utf8").trim() === head) return access;
    // Never authorize HEAD, gitdir or commondir writes: these select the repository/branch.
    const paths = [join(admin, "index"), join(admin, "index.lock"), join(admin, "HEAD.lock"), join(admin, "COMMIT_EDITMSG"), join(admin, "logs", "HEAD"), join(common, "objects"), join(common, "refs", "heads", branch), join(common, "refs", "heads", `${branch}.lock`), join(common, "logs", "refs", "heads", branch)];
    // Existing ancestor symlinks must never turn an authorization into an outside write.
    if (paths.some(p => canonicalPath(p) !== p || !p.startsWith(common + sep))) return access;
    // packed refs are readable but never writable; committing an existing packed branch creates a loose ref.
    access.branch = branch; access.writeRoots = paths;
    return access;
  } catch { return; }
}
