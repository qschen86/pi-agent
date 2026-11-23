import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { preparePiChatBoundary } from "../src/pi-boundary.js";
import { permissionOption } from "../src/permissions.js";

const dirs: string[] = [];
const boundaries: Awaited<ReturnType<typeof preparePiChatBoundary>>[] = [];
afterEach(async () => { await Promise.all(boundaries.splice(0).map((b) => b.dispose())); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
function layout() {
  const root = mkdtempSync(join(tmpdir(), "pi-boundary-")); dirs.push(root);
  const workspace = join(root, "workspace"), sourceAgentDir = join(root, "source");
  mkdirSync(workspace); mkdirSync(sourceAgentDir);
  writeFileSync(join(sourceAgentDir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "fake-private-one" }, openai: { type: "api_key", key: "fake-private-two" } }));
  return { workspace, sourceAgentDir, runtimeRoot: join(root, "runtime"), guardDir: join(root, "guard"), provider: "deepseek" };
}
it("rejects unavailable and ineffective guards before launching Pi", async () => {
  const args = layout();
  await expect(preparePiChatBoundary({ ...args, mode: "pi-ask", guard: { name: "none", available: () => false, prepare: async () => { throw new Error("must not run"); } } })).rejects.toThrow(/guard|沙箱|边界/i);
  await expect(preparePiChatBoundary({ ...layout(), mode: "pi-ask", guard: { name: "broken", available: () => true, prepare: async () => ({ provider: "broken", wrap: async (command, args) => ({ command, args }), dispose: async () => {} }) } })).rejects.toThrow(/guard|沙箱|边界/i);
});
it("native mode is explicit and carries only the selected provider", async () => {
  const args = layout(); const b = await preparePiChatBoundary({ ...args, mode: "pi-native" }); boundaries.push(b);
  expect(permissionOption("pi", "pi-native")?.detail).toMatch(/不提供受限/);
  const auth = JSON.parse(readFileSync(join(b.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"));
  expect(Object.keys(auth)).toEqual(["deepseek"]);
  expect(b.argsPrefix).toContain("--no-extensions");
  expect(b.argsPrefix).toContain("--no-prompt-templates");
  expect((await b.wrap("/bin/echo", ["hello"])).command).toBe("/bin/echo");
});
// This test performs real OS probes. Run outside the outer agent sandbox to let Seatbelt launch.
it.each(["pi-ask", "pi-read-only"])("real %s boundary enforces workspace and sensitive-file rules", async (mode) => {
  const args = layout(); const b = await preparePiChatBoundary({ ...args, mode }); boundaries.push(b);
  writeFileSync(join(args.workspace, ".env"), "SYNTHETIC_SECRET=1");
  const execute = async (script: string, extra: Record<string, string> = {}) => {
    const w = await b.wrap("/bin/sh", ["-c", script]);
    return spawnSync(w.command, w.args, { env: { ...b.env, ...w.env, ...extra }, encoding: "utf8" });
  };
  expect((await execute('printf yes > "$TARGET"', { TARGET: join(b.env.TMPDIR, "session-check") })).status).toBe(0);
  expect(readFileSync(join(b.env.TMPDIR, "session-check"), "utf8")).toBe("yes");
  const inside = join(args.workspace, "result.txt");
  expect((await execute('printf yes > "$TARGET"', { TARGET: inside })).status === 0).toBe(mode === "pi-ask");
  expect(existsSync(inside)).toBe(mode === "pi-ask");
  const outside = join(args.sourceAgentDir, "escaped.txt");
  expect((await execute('printf no > "$TARGET"', { TARGET: outside })).status).not.toBe(0);
  expect(existsSync(outside)).toBe(false);
  expect((await execute('cat "$TARGET"', { TARGET: join(args.workspace, ".env") })).status).not.toBe(0);
  if (mode === "pi-read-only") {
    const tools = b.argsPrefix[b.argsPrefix.indexOf("--tools") + 1].split(",");
    expect(tools).toEqual(["read", "grep", "find", "ls", "codemode"]);
  }
});

it.skipIf(process.platform !== "darwin")("role system file is readable but cannot be overwritten by the guarded runtime", async () => {
  const args = layout();
  const b = await preparePiChatBoundary({ ...args, mode: "pi-ask", roleInstructions: "ROLE-CHECK" }); boundaries.push(b);
  const role = b.argsPrefix[b.argsPrefix.indexOf("--append-system-prompt") + 1];
  expect(readFileSync(role, "utf8")).toBe("ROLE-CHECK");
  const read = await b.wrap("/bin/sh", ["-c", 'cat "$TARGET"']);
  expect(spawnSync(read.command, read.args, { env: { ...b.env, ...read.env, TARGET: role }, encoding: "utf8" }).stdout).toBe("ROLE-CHECK");
  const write = await b.wrap("/bin/sh", ["-c", 'printf changed > "$TARGET"']);
  expect(spawnSync(write.command, write.args, { env: { ...b.env, ...write.env, TARGET: role }, encoding: "utf8" }).status).not.toBe(0);
  expect(readFileSync(role, "utf8")).toBe("ROLE-CHECK");
});

it.skipIf(process.platform !== "darwin")("evaluation boundary permits reports and denies input write, restore, rename and symlink escape", async () => {
  const args = layout();
  const inputs = join(args.workspace, "inputs"), reports = join(args.workspace, "reports");
  mkdirSync(inputs); mkdirSync(reports);
  const input = join(inputs, "delivery.txt"); writeFileSync(input, "original");
  symlinkSync(inputs, join(reports, "escape"));
  const b = await preparePiChatBoundary({ ...args, mode: "pi-ask", evaluation: { reportDir: reports, inputRoots: [inputs] } }); boundaries.push(b);
  const run = async (script: string, target: string) => {
    const w = await b.wrap("/bin/sh", ["-c", script]);
    return spawnSync(w.command, w.args, { env: { ...b.env, ...w.env, TARGET: target }, encoding: "utf8" });
  };
  expect((await run('cat "$TARGET"', input)).stdout).toBe("original");
  expect((await run('printf verdict > "$TARGET"', join(reports, "report.json"))).status).toBe(0);
  expect((await run('printf changed > "$TARGET"', input)).status).not.toBe(0);
  expect((await run('printf changed > "$TARGET"; printf original > "$TARGET"', input)).status).not.toBe(0);
  expect((await run('mv "$TARGET" "$TARGET.old"', input)).status).not.toBe(0);
  expect((await run('printf changed > "$TARGET"', join(reports, "escape", "delivery.txt"))).status).not.toBe(0);
  expect(readFileSync(input, "utf8")).toBe("original");
  expect(b.env.PI_CHAT_PERMISSION_MODE).toBe("pi-evaluation");
});
it("evaluation refuses native mode and overlapping input/report roots", async () => {
  const args = layout();
  await expect(preparePiChatBoundary({ ...args, mode: "pi-native", evaluation: { reportDir: args.workspace, inputRoots: [args.sourceAgentDir] } })).rejects.toThrow(/evaluation|验收/i);
  const other = layout();
  await expect(preparePiChatBoundary({ ...other, mode: "pi-ask", evaluation: { reportDir: join(other.workspace, "reports"), inputRoots: [other.workspace] } })).rejects.toThrow(/overlap|重叠/i);
});
