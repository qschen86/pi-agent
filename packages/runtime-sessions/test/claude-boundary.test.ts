import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareClaudeEvaluationBoundary } from "../src/claude-boundary.js";
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
function layout() {
  const root = mkdtempSync(join(tmpdir(), "claude-evaluation-")); dirs.push(root);
  const workspace = join(root, "workspace"), input = join(root, "input"), reportDir = join(workspace, "reports");
  mkdirSync(input); mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(input, "delivery.txt"), "original"); symlinkSync(input, join(reportDir, "escape"));
  return { workspace, evaluation: { inputRoots: [input], reportDir }, runtimeRoot: join(root, "runtime"), guardDir: join(root, "guard"), readable: [] };
}
it.skipIf(process.platform !== "darwin")("guards the entire Claude process tree: report writable, input immutable, state survives disposal", async () => {
  const args = layout(); const b = await prepareClaudeEvaluationBoundary(args);
  try {
    const run = (script: string, target: string) => spawnSync(b.command, [...b.prefix, "/bin/sh", "-c", script], { env: { ...b.env, TARGET: target }, encoding: "utf8" });
    const input = join(args.evaluation.inputRoots[0], "delivery.txt");
    expect(run('cat "$TARGET"', input).stdout).toBe("original");
    expect(run('printf pass > "$TARGET"', join(args.evaluation.reportDir, "report.json")).status).toBe(0);
    expect(run('sh -c \'printf forged > "$TARGET"\'', input).status).not.toBe(0);
    expect(run('mv "$TARGET" "$TARGET.old"', input).status).not.toBe(0);
    expect(run('printf forged > "$TARGET"; printf original > "$TARGET"', input).status).not.toBe(0);
    expect(run('printf forged > "$TARGET"', join(args.evaluation.reportDir, "escape", "delivery.txt")).status).not.toBe(0);
    expect(run('printf state > "$TARGET"', join(b.env.CLAUDE_CONFIG_DIR, "session-state")).status).toBe(0);
    expect(readFileSync(input, "utf8")).toBe("original");
    await b.dispose();
    expect(readFileSync(join(b.env.CLAUDE_CONFIG_DIR, "session-state"), "utf8")).toBe("state");
    expect(existsSync(args.guardDir)).toBe(false);
  } finally { await b.dispose(); }
});
it("rejects unavailable guards and overlap before running Claude", async () => {
  await expect(prepareClaudeEvaluationBoundary({ ...layout(), guard: { name: "none", available: () => false, prepare: async () => { throw new Error("must not run"); } } })).rejects.toThrow(/guard unavailable/);
  const args = layout();
  await expect(prepareClaudeEvaluationBoundary({ ...args, runtimeRoot: args.evaluation.inputRoots[0] })).rejects.toThrow(/overlap/);
});

it.skipIf(process.platform !== "darwin")("keeps native login lookup at the original Keychain while moving mutable session state to private config", async () => {
 const args = layout(); const boundary = await prepareClaudeEvaluationBoundary(args);
 try {
  // The actual guarded subprocess receives both directories; credentials are never exported or copied.
  const observed = spawnSync(boundary.command, [...boundary.prefix, "/bin/sh", "-c", 'if [ "${CLAUDE_SECURESTORAGE_CONFIG_DIR+x}" != x ]; then exit 7; fi; if [ -n "$CLAUDE_SECURESTORAGE_CONFIG_DIR" ]; then exit 8; fi; test "$CLAUDE_CONFIG_DIR" = "$EXPECTED_PRIVATE_CONFIG"'], { env: { ...boundary.env, EXPECTED_PRIVATE_CONFIG: realpathSync(join(args.runtimeRoot, "config")) }, encoding: "utf8" });
  expect(observed.status).toBe(0);
  expect(boundary.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN"); expect(boundary.env).not.toHaveProperty("ANTHROPIC_API_KEY");
 } finally { await boundary.dispose(); }
});

it("imports only native login metadata into private config without copying tools, helpers or project memory", async () => {
 const args = layout(), source = join(args.guardDir, "native-login.json"); mkdirSync(args.guardDir);
 writeFileSync(source, JSON.stringify({ oauthAccount: { accountUuid: "account-one", emailAddress: "private@example.test", organizationUuid: "org-one", accessToken: "never-copy" }, userID: "user-one", hasCompletedOnboarding: true, apiKeyHelper: "do-not-run", mcpServers: { bad: {} }, projects: { bad: { memory: "do-not-copy" } } }));
 const b = await prepareClaudeEvaluationBoundary({ ...args, loginMetadataFile: source });
 try {
  const metadata = JSON.parse(readFileSync(join(b.env.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8"));
  expect(metadata).toEqual({ oauthAccount: { accountUuid: "account-one", emailAddress: "private@example.test", organizationUuid: "org-one" }, userID: "user-one", hasCompletedOnboarding: true });
 } finally { await b.dispose(); }
});
it("rejects a private config symlink before the host can write login metadata outside its runtime root", async () => {
 const args = layout(); mkdirSync(args.runtimeRoot); symlinkSync(args.evaluation.inputRoots[0], join(args.runtimeRoot, "config"));
 await expect(prepareClaudeEvaluationBoundary(args)).rejects.toThrow(/config.*path|config.*symlink/i);
 expect(existsSync(join(args.evaluation.inputRoots[0], ".claude.json"))).toBe(false);
});

it.skipIf(process.platform !== "darwin")("makes encrypted native login storage readable but immutable to the guarded process", async () => {
 const args = layout(), authRoot = mkdtempSync(join(process.cwd(), ".test-claude-login-")); dirs.push(authRoot); const keychain = join(authRoot, "native-keychain"); mkdirSync(keychain, { recursive: true }); writeFileSync(join(keychain, "encrypted.db"), "encrypted-fixture");
 const b = await prepareClaudeEvaluationBoundary({ ...args, nativeLoginReadRoots: [keychain] });
 try {
  const read = spawnSync(b.command, [...b.prefix, "/bin/cat", join(keychain, "encrypted.db")], { env: b.env, encoding: "utf8" }); expect(read.stdout).toBe("encrypted-fixture");
  const write = spawnSync(b.command, [...b.prefix, "/bin/sh", "-c", 'printf changed > "$TARGET"'], { env: { ...b.env, TARGET: join(keychain, "encrypted.db") }, encoding: "utf8" }); expect(write.status).not.toBe(0); expect(readFileSync(join(keychain, "encrypted.db"), "utf8")).toBe("encrypted-fixture");
 } finally { await b.dispose(); }
});
it("keeps Claude Code's own scratch directory inside the private writable runtime root", async () => {
 const args = layout(); const b = await prepareClaudeEvaluationBoundary(args);
 try { expect(b.env.CLAUDE_CODE_TMPDIR).toBe(b.env.TMPDIR); expect(b.env.CLAUDE_CODE_TMPDIR!.startsWith(realpathSync(args.runtimeRoot))).toBe(true); } finally { await b.dispose(); }
});
