import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createPiToolGate, parsePiWorktreeWriteGuard } from "../src/pi-approval-extension.js";
import { preparePiChatBoundary } from "../src/pi-boundary.js";

let base: string, repo: string, own: string, other: string, outside: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-guard-")));
  repo = join(base, "repo"); own = join(repo, ".pi-worktrees", "rt-own"); other = join(repo, ".pi-worktrees", "rt-other"); outside = join(base, "outside");
  for (const d of [join(repo, "apps"), join(own, "apps"), other, outside]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const ctx = { hasUI: false, ui: { confirm: async () => true } };
const guard = () => parsePiWorktreeWriteGuard(JSON.stringify({ cwd: own, allow: own, repoRoot: repo }));
const call = (toolName: string, input: Record<string, unknown>, id: string) => ({ toolName, toolCallId: id, input });
const gate = () => createPiToolGate("pi-native", undefined, false, false, guard());

it.each(["write", "edit"])("%s inside the own worktree is allowed (relative and absolute)", async (tool) => {
  const g = gate();
  expect(await g(call(tool, { path: "apps/a.js" }, `${tool}-rel`), ctx)).toBeUndefined();
  expect(await g(call(tool, { path: join(own, "apps/a.js") }, `${tool}-abs`), ctx)).toBeUndefined();
  expect(await g(call(tool, { path: "@apps/new/dir/a.js" }, `${tool}-new`), ctx)).toBeUndefined();
});

it.each(["write", "edit"])("%s into the main repository is refused and points at the worktree path", async (tool) => {
  const result = await gate()(call(tool, { path: join(repo, "apps/a.js") }, `${tool}-main`), ctx);
  expect(result).toMatchObject({ block: true });
  expect(result?.reason).toContain(join(own, "apps/a.js"));
});

it("traversal, other sessions' worktrees and symlinks into the main repo are refused", async () => {
  const g = gate();
  expect(await g(call("write", { path: "../../apps/a.js" }, "dots"), ctx)).toMatchObject({ block: true });
  expect(await g(call("edit", { path: join(other, "x.js") }, "other"), ctx)).toMatchObject({ block: true });
  symlinkSync(join(repo, "apps"), join(own, "link"));
  expect(await g(call("write", { path: "link/a.js" }, "link"), ctx)).toMatchObject({ block: true });
});

it("paths outside the repository are not this gate's concern, and bash/read are untouched", async () => {
  const g = gate();
  expect(await g(call("write", { path: join(outside, "shot.mts") }, "outside"), ctx)).toBeUndefined();
  expect(await g(call("bash", { command: "git -C ../.. log" }, "bash"), ctx)).toBeUndefined();
  expect(await g(call("read", { path: join(repo, "apps/a.js") }, "read"), ctx)).toBeUndefined();
});

it("a missing path or a malformed guard configuration fails closed", async () => {
  expect(await gate()(call("write", {}, "no-path"), ctx)).toMatchObject({ block: true });
  const bad = createPiToolGate("pi-native", undefined, false, false, parsePiWorktreeWriteGuard("{not json"));
  expect(await bad(call("write", { path: "a.js" }, "bad"), ctx)).toMatchObject({ block: true });
});

it("sessions without a worktree (no guard) are unchanged", async () => {
  expect(parsePiWorktreeWriteGuard(undefined)).toBeUndefined();
  const g = createPiToolGate("pi-native", undefined, false, false, undefined);
  expect(await g(call("write", { path: join(repo, "apps/a.js") }, "free"), ctx)).toBeUndefined();
});

it("the native boundary hands the worktree guard to Pi only for worktree sessions", async () => {
  const sourceAgentDir = join(base, "source");
  mkdirSync(sourceAgentDir);
  writeFileSync(join(sourceAgentDir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "fake" } }));
  const common = { workspace: own, sourceAgentDir, provider: "deepseek", mode: "pi-native" as const };
  const withWorktree = await preparePiChatBoundary({ ...common, runtimeRoot: join(base, "rt1"), guardDir: join(base, "g1"), worktree: { repoRoot: repo, path: own, branch: "pi/rt-own" } });
  const without = await preparePiChatBoundary({ ...common, runtimeRoot: join(base, "rt2"), guardDir: join(base, "g2") });
  try {
    expect(JSON.parse(withWorktree.env.PI_CHAT_WORKTREE_GUARD!)).toEqual({ cwd: own, allow: own, repoRoot: repo });
    expect(without.env.PI_CHAT_WORKTREE_GUARD).toBeUndefined();
  } finally { await withWorktree.dispose(); await without.dispose(); }
});
