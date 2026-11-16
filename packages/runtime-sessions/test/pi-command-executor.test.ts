import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PiCommandExecutor } from "../src/pi-command-executor.js";
import type { TurnSink } from "../src/driver.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function setup(approved = true) {
  const root = mkdtempSync(join(tmpdir(), "pi-command-test-")); dirs.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const sink = { approval: vi.fn(async () => ({ approve: approved, reason: "test decision" })), status: vi.fn(), event: vi.fn() } as unknown as TurnSink;
  const run = vi.fn(async () => ({ output: "verified", exitCode: 0 }));
  const executor = new PiCommandExecutor({ workspace, env: { HOME: root, TMPDIR: root }, runtimeRoot: join(root, "runtime"), guardDir: join(root, "guard"), sink, run });
  return { executor, sink, run };
}
const request = (id = "tool-1") => ({ toolCallId: id, command: "node browser-test.mjs", reason: "Chromium IPC denied by ordinary sandbox", capability: "browser", timeout: 30 });
it("binds explicit approval to the exact command, reason, scope and timeout before execution", async () => {
  const t = setup(); expect(await t.executor.execute(request())).toMatchObject({ output: "verified", exitCode: 0 });
  expect(t.sink.approval).toHaveBeenCalledWith(expect.objectContaining({ kind: "permissions", requiresExplicitApproval: true, params: expect.objectContaining(request()) }), expect.any(AbortSignal));
  expect(t.run).toHaveBeenCalledOnce();
});
it("denial, malformed requests and repeated IDs cannot execute", async () => {
  const t = setup(false);
  expect((await t.executor.execute(request())).exitCode).not.toBe(0);
  expect((await t.executor.execute(request())).exitCode).not.toBe(0);
  expect((await t.executor.execute({ ...request("other"), timeout: 3601 })).exitCode).not.toBe(0);
  expect((await t.executor.execute({ ...request("third"), capability: "full-access" })).exitCode).not.toBe(0);
  expect((await t.executor.execute({ ...request("hidden-suffix"), command: "x".repeat(3001) })).exitCode).not.toBe(0);
  expect(t.run).not.toHaveBeenCalled(); expect(t.sink.approval).toHaveBeenCalledOnce();
});
it("stopping during approval prevents execution and rejects later requests", async () => {
  const t = setup();
  vi.mocked(t.sink.approval).mockImplementationOnce(async () => { await t.executor.dispose(); return { approve: true, reason: "late" }; });
  expect((await t.executor.execute(request())).exitCode).not.toBe(0);
  expect((await t.executor.execute(request("later"))).exitCode).not.toBe(0);
  expect(t.run).not.toHaveBeenCalled();
});
it("git expansion is unavailable when no verified linked worktree exists", async () => {
  const t = setup();
  expect((await t.executor.execute({ ...request(), capability: "git", command: "git commit -m change" })).exitCode).not.toBe(0);
  expect(t.sink.approval).not.toHaveBeenCalled();
});
