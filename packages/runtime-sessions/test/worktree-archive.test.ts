import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { removeSessionWorktree, sessionWorktreePath } from "../src/worktree.js";

it.each([false, true])("archive removes dirty, unmerged worktree and branch, even with tampered git=%s", async (tampered) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archive-worktree-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.test"); git("config", "user.name", "test");
    writeFileSync(join(root, "base.txt"), "preserve base");
    git("add", "."); git("commit", "-qm", "base");
    const id = "rt-0123456789abcdef", branch = `pi/${id}`, path = sessionWorktreePath(root, id);
    git("worktree", "add", "-qb", branch, path);
    writeFileSync(join(path, "unmerged.txt"), "discard unmerged");
    execFileSync("git", ["-C", path, "add", "."]);
    execFileSync("git", ["-C", path, "commit", "-qm", "unmerged"]);
    writeFileSync(join(path, "dirty.txt"), "discard uncommitted");
    if (tampered) writeFileSync(join(path, ".git"), `gitdir: ${join(root, ".git")}\n`);
    await removeSessionWorktree(root, path, branch);
    expect(existsSync(path)).toBe(false);
    expect(git("branch", "--list", branch).trim()).toBe("");
    expect(git("worktree", "list", "--porcelain")).not.toContain(path);
    expect(existsSync(join(root, "base.txt"))).toBe(true);
    // Cleanup remains idempotent for a repeated archive request.
    await removeSessionWorktree(root, path, branch);
    await expect(removeSessionWorktree(root, root, branch)).rejects.toThrow("拒绝删除");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
