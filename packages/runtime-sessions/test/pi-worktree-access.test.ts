import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { piWorktreeAccess } from "../src/pi-worktree-access.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function layout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-access-"))); dirs.push(root);
  const workspace = join(root, "repo", ".pi-worktrees", "rt-one"), common = join(root, "repo", ".git"), admin = join(common, "worktrees", "rt-one");
  mkdirSync(workspace, { recursive: true }); mkdirSync(admin, { recursive: true });
  writeFileSync(join(workspace, ".git"), `gitdir: ${admin}\n`);
  writeFileSync(join(admin, "commondir"), "../..\n");
  writeFileSync(join(admin, "gitdir"), `${workspace}/.git\n`);
  writeFileSync(join(admin, "HEAD"), "ref: refs/heads/pi/rt-one\n");
  writeFileSync(join(common, "HEAD"), "ref: refs/heads/main\n");
  return { root, workspace, common, admin };
}
it("discovers linked Git metadata, granting only its branch, objects and worktree administration", () => {
  const t = layout(), access = piWorktreeAccess(t.workspace)!;
  expect(access.readRoots).toEqual([t.common]);
  expect(access.writeRoots).toContain(join(t.admin, "index"));
  expect(access.writeRoots).not.toContain(t.admin);
  expect(access.writeRoots).not.toContain(join(t.admin, "HEAD"));
  expect(access.writeRoots).toContain(join(t.common, "objects"));
  expect(access.writeRoots).toContain(join(t.common, "refs", "heads", "pi", "rt-one"));
  expect(access.writeRoots).not.toContain(t.common);
  expect(access.writeRoots).not.toContain(join(t.common, "refs"));
  expect(access.writeRoots).not.toContain(join(t.common, "refs", "heads", "main"));
});
it("a changed HEAD cannot select a sibling branch over the host-stored identity", () => {
  const t = layout(), identity = { repoRoot: join(t.root, "repo"), path: t.workspace, branch: "pi/rt-one" };
  expect(piWorktreeAccess(t.workspace, identity)?.branch).toBe("pi/rt-one");
  writeFileSync(join(t.admin, "HEAD"), "ref: refs/heads/pi/sibling\n");
  expect(piWorktreeAccess(t.workspace, identity)?.writeRoots).toEqual([]);
});
it("resolves trusted metadata for a nested workspace without granting worktree file writes", () => {
  const t = layout(), nested = join(t.workspace, "apps", "web"); mkdirSync(nested, { recursive: true });
  const identity = { repoRoot: join(t.root, "repo"), path: t.workspace, branch: "pi/rt-one" };
  const access = piWorktreeAccess(nested, identity)!;
  expect(access.readRoots).toEqual([t.common, t.workspace]);
  expect(access.branch).toBe(identity.branch);
  expect(access.writeRoots).not.toContain(t.workspace);
  expect(piWorktreeAccess(t.root, identity)).toBeUndefined();
});
it("does not trust an arbitrary .git pointer or mismatched back-reference", () => {
  const t = layout(); writeFileSync(join(t.admin, "gitdir"), join(t.root, "other", ".git"));
  expect(piWorktreeAccess(t.workspace)).toBeUndefined();
  writeFileSync(join(t.workspace, ".git"), `gitdir: ${t.common}\n`);
  expect(piWorktreeAccess(t.workspace)).toBeUndefined();
});
it("rejects symlinked objects, path traversal and the main checkout's branch for write access", () => {
  const t = layout(); mkdirSync(join(t.root, "outside")); symlinkSync(join(t.root, "outside"), join(t.common, "objects"));
  expect(piWorktreeAccess(t.workspace)?.writeRoots).toEqual([]);
  rmSync(join(t.common, "objects")); writeFileSync(join(t.admin, "HEAD"), "ref: refs/heads/../../escape\n");
  expect(piWorktreeAccess(t.workspace)?.writeRoots).toEqual([]);
  writeFileSync(join(t.admin, "HEAD"), "ref: refs/heads/main\n");
  expect(piWorktreeAccess(t.workspace)?.writeRoots).toEqual([]);
});
