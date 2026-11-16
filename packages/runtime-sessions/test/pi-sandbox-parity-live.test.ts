/** Opt-in because a containing sandbox cannot host another Seatbelt boundary. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileRuntimeGuardPolicy, SeatbeltRuntimeGuard } from "@pi-agent/adapter-pi";
import { PiCommandExecutor, runPiCommand } from "../src/pi-command-executor.js";
import { piWorktreeAccess } from "../src/pi-worktree-access.js";
import type { DriverApproval, TurnSink } from "../src/driver.js";
import { PiDriver } from "../src/pi.js";

const dirs: string[] = [], executors: PiCommandExecutor[] = [];
afterEach(async () => { await Promise.all(executors.splice(0).map(e => e.dispose())); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-parity-live-"))); dirs.push(root);
  const repo = join(root, "repo"), workspace = join(repo, ".pi-worktrees", "test"), runtimeRoot = join(root, "runtime"), guardDir = join(root, "guard");
  mkdirSync(repo); mkdirSync(join(runtimeRoot, "home"), { recursive: true }); mkdirSync(join(runtimeRoot, "tmp"));
  const git = (...args: string[]) => { const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }); expect(r.status, r.stderr).toBe(0); return r.stdout; };
  git("init", "-b", "main"); git("config", "user.name", "Sandbox Test"); git("config", "user.email", "sandbox@example.invalid");
  writeFileSync(join(repo, "original.txt"), "main stays intact"); git("add", "."); git("commit", "-m", "initial"); git("worktree", "add", "-b", "pi/test", workspace);
  const approvals: DriverApproval[] = [];
  const sink = { approval: async (r: DriverApproval) => { approvals.push(r); return { approve: true, reason: "test authorization" }; }, status: () => {}, event: () => {} } as unknown as TurnSink;
  const env = { PATH: process.env.PATH!, HOME: join(runtimeRoot, "home"), TMPDIR: join(runtimeRoot, "tmp"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const executor = new PiCommandExecutor({ workspace, runtimeRoot, guardDir, env, sink, readable: [join(process.cwd(), "node_modules")] }); executors.push(executor);
  return { root, repo, workspace, runtimeRoot, guardDir, env, executor, approvals, git };
}
describe.skipIf(process.env.PI_SANDBOX_PARITY !== "1" || process.platform !== "darwin")("real Pi sandbox parity", () => {
  it.each([true, false])("native Pi discovers the custom tool and returns the explicit approval result (%s)", async approved => {
    const t = setup(), source = join(t.root, "source"); mkdirSync(source);
    const requests: any[] = [], approvals: DriverApproval[] = [];
    const server = createServer(async (req, res) => {
      let text = ""; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text); requests.push(body);
      const hasResult = body.messages.some((m: any) => m.role === "tool");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = hasResult ? { role: "assistant", content: "native execution verified" } : { role: "assistant", tool_calls: [{ index: 0, id: "call_native_expand", type: "function", function: { name: "bash_escalated", arguments: JSON.stringify({ command: "printf native-verified > native.txt", capability: "git", reason: "Verify host tool RPC", timeout: 10 }) } }] };
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: hasResult ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(source, "models.json"), JSON.stringify({ providers: { "parity-fixture": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fake-test-only-key", models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }] } } }));
    writeFileSync(join(source, "settings.json"), "{}");
    const driver = new PiDriver({ binaryPath: process.env.PI_BIN ?? "/opt/homebrew/bin/pi", sourceAgentDir: source, sessionDir: join(t.root, "sessions"), readyTimeoutMs: 10000 });
    const sink = { nativeSession: () => {}, nativeTurn: () => {}, usage: () => {}, rateLimit: () => {}, event: () => {}, status: () => {}, approval: async (r: DriverApproval) => { approvals.push(r); return { approve: approved, reason: approved ? "test authorization" : "test denial" }; } } as TurnSink;
    let handle: Awaited<ReturnType<PiDriver["startTurn"]>> | undefined;
    try {
      handle = await driver.startTurn({ workspace: t.workspace, model: "parity-fixture/fixture", permissionMode: "pi-ask", prompt: "Execute the requested tool and report its result.", clientMessageId: randomUUID(), presetSessionId: randomUUID() }, sink);
      expect(await handle.done).toMatchObject({ status: "completed", terminalObserved: true });
      expect(requests[0].tools.some((x: any) => x.function.name === "bash_escalated")).toBe(true);
      expect(approvals).toHaveLength(1); expect(approvals[0]).toMatchObject({ kind: "permissions", requiresExplicitApproval: true });
      if (approved) expect(readFileSync(join(t.workspace, "native.txt"), "utf8")).toBe("native-verified");
      else expect(existsSync(join(t.workspace, "native.txt"))).toBe(false);
      expect(requests[1].messages.find((m: any) => m.role === "tool").content).toContain(approved ? "Exit code: 0" : "test denial");
    } finally { await handle?.interrupt(); driver.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("ordinary Git reads and explicitly approved commits work without changing main or siblings", async () => {
    const t = setup(), access = piWorktreeAccess(t.workspace)!;
    const policy = compileRuntimeGuardPolicy({ workspaceRoot: t.workspace, writeSubPaths: ["."], runtimeWritable: [t.runtimeRoot], runtimeReadable: access.readRoots });
    const ordinary = await new SeatbeltRuntimeGuard().prepare({ policy, guardDir: join(t.guardDir, "ordinary"), runtimeTmp: t.env.TMPDIR });
    const run = async (command: string) => { const w = await ordinary.wrap("/bin/bash", ["--noprofile", "--norc", "-c", command]); return runPiCommand(w.command, w.args, { cwd: t.workspace, env: t.env, timeoutMs: 10000, signal: new AbortController().signal }); };
    expect((await run("git status --porcelain; git diff; git log -1 --oneline")).exitCode).toBe(0);
    writeFileSync(join(t.workspace, "change.txt"), "feature");
    expect((await run("git add change.txt")).exitCode).not.toBe(0);
    const result = await t.executor.execute({ toolCallId: "git-commit", command: "git -c core.hooksPath=/dev/null add change.txt && git -c core.hooksPath=/dev/null commit -m feature", capability: "git", reason: "Write this worktree index and branch only", timeout: 30 });
    expect(result.exitCode, result.output).toBe(0); expect(t.approvals).toHaveLength(1);
    expect(t.git("log", "main", "-1", "--format=%s").trim()).toBe("initial"); expect(t.git("log", "pi/test", "-1", "--format=%s").trim()).toBe("feature");
    const sibling = join(t.repo, ".pi-worktrees", "sibling"); t.git("worktree", "add", "-b", "pi/sibling", sibling);
    for (const [id, target] of [["main", join(t.repo, "original.txt")], ["sibling", join(sibling, "original.txt")], ["other-ref", join(t.repo, ".git", "refs", "heads", "main")]]) {
      const blocked = await t.executor.execute({ toolCallId: `write-${id}`, command: `printf modified > '${target}'`, capability: "git", reason: "Negative boundary probe", timeout: 10 });
      expect(blocked.exitCode, blocked.output).not.toBe(0);
    }
    expect(readFileSync(join(t.repo, "original.txt"), "utf8")).toBe("main stays intact");
  });
  it("Chromium fails in ordinary Seatbelt and verifies a page after explicit browser expansion", async () => {
    const t = setup(), browserCache = join(homedir(), "Library", "Caches", "ms-playwright"); expect(existsSync(browserCache)).toBe(true);
    const script = join(t.workspace, "browser.mjs");
    writeFileSync(script, `import { chromium } from ${JSON.stringify(join(process.cwd(), "node_modules/playwright/index.mjs"))};\nconst b = await chromium.launch({headless:true}); try { const p = await b.newPage(); await p.setContent('<h1>verified</h1>'); console.log(await p.locator('h1').innerText()); } finally { await b.close(); }\n`);
    const command = `node '${script}'`;
    const policy = compileRuntimeGuardPolicy({ workspaceRoot: t.workspace, writeSubPaths: ["."], runtimeWritable: [t.runtimeRoot], runtimeReadable: [browserCache, join(process.cwd(), "node_modules")] });
    const ordinary = await new SeatbeltRuntimeGuard().prepare({ policy, guardDir: join(t.guardDir, "ordinary"), runtimeTmp: t.env.TMPDIR });
    const w = await ordinary.wrap("/bin/bash", ["--noprofile", "--norc", "-c", command]);
    const denied = await runPiCommand(w.command, w.args, { cwd: t.workspace, env: { ...t.env, PLAYWRIGHT_BROWSERS_PATH: browserCache }, timeoutMs: 20000, signal: new AbortController().signal });
    expect(denied.exitCode).not.toBe(0); expect(denied.output).toContain("bootstrap_check_in");
    const result = await t.executor.execute({ toolCallId: "browser", command, capability: "browser", reason: "Chromium Mach rendezvous denied", timeout: 30 });
    expect(result.exitCode, result.output).toBe(0); expect(result.output).toContain("verified");
  });
  it("a nested workspace can commit while files outside that directory remain protected", async () => {
    const t = setup(), nested = join(t.workspace, "apps", "web"); mkdirSync(nested, { recursive: true });
    const executor = new PiCommandExecutor({ workspace: nested, runtimeRoot: t.runtimeRoot, guardDir: t.guardDir, env: t.env,
      worktree: { repoRoot: t.repo, path: t.workspace, branch: "pi/test" },
      sink: { approval: async () => ({ approve: true }), status: () => {} } as unknown as TurnSink }); executors.push(executor);
    writeFileSync(join(nested, "nested.txt"), "nested feature");
    const result = await executor.execute({ toolCallId: "nested-commit", command: "git status --porcelain && git add nested.txt && git -c core.hooksPath=/dev/null commit -m nested", capability: "git", reason: "Nested worktree validation", timeout: 30 });
    expect(result.exitCode, result.output).toBe(0);
    const blocked = await executor.execute({ toolCallId: "nested-outside", command: "printf overwrite > ../../original.txt", capability: "git", reason: "Negative boundary probe", timeout: 10 });
    expect(blocked.exitCode, blocked.output).not.toBe(0);
    expect(readFileSync(join(t.workspace, "original.txt"), "utf8")).toBe("main stays intact");
  });
  it("timeout and cancellation terminate background processes and return bounded output", async () => {
    const t = setup(), ctrl = new AbortController();
    const run = runPiCommand("/bin/bash", ["-c", "sleep 60 & wait"], { cwd: t.workspace, env: t.env, timeoutMs: 100, signal: ctrl.signal });
    expect(await run).toMatchObject({ exitCode: 1, timedOut: true });
    const next = runPiCommand("/bin/bash", ["-c", "sleep 60 & wait"], { cwd: t.workspace, env: t.env, timeoutMs: 10000, signal: ctrl.signal }); ctrl.abort();
    expect(await next).toMatchObject({ exitCode: 1, cancelled: true });
  });
  it.each(["normal", "timeout", "cancel"])("cleans detached descendants on %s completion", async mode => {
    const t = setup(), ctrl = new AbortController();
    const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'}); console.log(c.pid); c.unref(); ${mode === "normal" ? "" : "setTimeout(()=>{},60000);"}`;
    const result = runPiCommand(process.execPath, ["-e", script], { cwd: t.workspace, env: t.env, timeoutMs: mode === "timeout" ? 200 : 10000, signal: ctrl.signal });
    if (mode === "cancel") setTimeout(() => ctrl.abort(), 200);
    const finished = await result, pid = Number(finished.output.split("\n")[0]); expect(pid).toBeGreaterThan(0);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      for (let i = 0; i < 50 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(alive(), `detached child ${pid} survived ${mode}`).toBe(false);
    } finally { try { process.kill(pid, "SIGKILL"); } catch {} }
  });
});
