/** Protect the complete Claude CLI process tree, including tools permitted by native settings. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { canonicalPath, compileRuntimeGuardPolicy, isWithin, SeatbeltRuntimeGuard, verifyRuntimeGuard } from "@pi-agent/adapter-pi";
import type { RuntimeGuardProvider } from "@pi-agent/runtime-contracts";
import { allowlistedEnv } from "./codex-client.js";
import { normalizeEvaluation, type EvaluationBoundary } from "./evaluation.js";
export interface ClaudeBoundaryOptions {
  workspace: string; evaluation: EvaluationBoundary; runtimeRoot: string; guardDir: string;
  readable: string[]; loginMetadataFile?: string; guard?: RuntimeGuardProvider;
  /** Human-authorized: native login storage (macOS Keychains) readable but never writable by the guarded process. */
  nativeLoginReadRoots?: string[];
}
export interface ClaudeEvaluationBoundary {
  env: Record<string, string>; command: string; prefix: string[]; dispose(): Promise<void>;
}
export async function prepareClaudeEvaluationBoundary(options: ClaudeBoundaryOptions): Promise<ClaudeEvaluationBoundary> {
  const evaluation = normalizeEvaluation(options.workspace, options.evaluation);
  const workspace = canonicalPath(options.workspace), runtimeRoot = canonicalPath(options.runtimeRoot), guardDir = canonicalPath(options.guardDir);
  const overlap = (a: string, b: string) => isWithin(a, b) || isWithin(b, a);
  if (overlap(runtimeRoot, workspace) || overlap(guardDir, workspace) || overlap(runtimeRoot, guardDir) || evaluation.inputRoots.some((p) => overlap(p, runtimeRoot) || overlap(p, guardDir))) throw new Error("Claude evaluation runtime, input, guard and workspace roots overlap");
  const guard = options.guard ?? new SeatbeltRuntimeGuard();
  if (!guard.available()) throw new Error("Claude evaluation guard unavailable; cannot run without input protection");
  const config = `${runtimeRoot}/config`, tmp = `${runtimeRoot}/tmp`;
  mkdirSync(config, { recursive: true, mode: 0o700 }); mkdirSync(tmp, { recursive: true, mode: 0o700 });
  if (lstatSync(config).isSymbolicLink() || realpathSync(config) !== config) throw new Error("Claude config path is a symlink or escaped its private runtime root");
  importLoginMetadata(config, options.loginMetadataFile ?? join(homedir(), ".claude.json"));
  mkdirSync(evaluation.reportDir, { recursive: true, mode: 0o700 }); mkdirSync(guardDir, { recursive: true, mode: 0o700 });
  const policy = compileRuntimeGuardPolicy({ workspaceRoot: workspace, writeSubPaths: [relative(workspace, evaluation.reportDir)], runtimeWritable: [runtimeRoot], runtimeReadable: [guardDir, ...evaluation.inputRoots, ...options.readable, ...(options.nativeLoginReadRoots ?? []).filter(existsSync).map((p) => realpathSync(p))] });
  const prepared = await guard.prepare({ policy, guardDir, runtimeTmp: tmp });
  let disposed = false;
  const dispose = async () => { if (disposed) return; disposed = true; await prepared.dispose(); rmSync(guardDir, { recursive: true, force: true }); };
  try {
    const check = await verifyRuntimeGuard(prepared, { policy, guardDir, runtimeTmp: tmp });
    if (!check.passed) throw new Error(`Claude evaluation guard self-check failed: ${check.failures.join("; ")}`);
    // Precompute a synchronous process prefix for the SDK's synchronous spawn callback.
    // /usr/bin/env receives the SDK command as argv, never shell-interpolated text.
    const wrapped = await prepared.wrap("/usr/bin/env", []);
    return { command: wrapped.command, prefix: wrapped.args, env: { ...allowlistedEnv(), ...wrapped.env, TMPDIR: tmp, CLAUDE_CONFIG_DIR: config,
      // Claude Code keeps Bash/task scratch under CLAUDE_CODE_TMPDIR (default /tmp); keep it in the private writable root.
      CLAUDE_CODE_TMPDIR: tmp,
      // Keep the same default Keychain identity as the ordinary SDK env. Installed CLI
      // separates this lookup from mutable config/session storage; no token is exported.
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, dispose };
  } catch (error) { await dispose(); throw error; }
}

/** The native OAuth account gate needs metadata as well as its original Keychain item.
 * Never copy credentials, MCP definitions, permissions, helpers, hooks, or project memory.
 */
function importLoginMetadata(config: string, source: string): void {
  if (!existsSync(source)) return;
  if (statSync(source).size > 4 * 1024 * 1024) throw new Error("Native Claude login metadata exceeds read limit");
  const raw = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid native Claude login metadata");
  const account = raw.oauthAccount;
  if (!account || typeof account !== "object" || Array.isArray(account)) return;
  const fields = ["accountUuid", "emailAddress", "organizationUuid", "billingType", "displayName", "fullName", "organizationName", "organizationRole", "organizationType", "workspaceRole", "seatTier", "userRateLimitTier", "organizationRateLimitTier", "accountCreatedAt", "subscriptionCreatedAt", "profileFetchedAt", "hasExtraUsageEnabled", "claudeCodeTrialDurationDays", "claudeCodeTrialEndsAt"];
  const oauthAccount = Object.fromEntries(Object.entries(account).filter(([key, value]) => fields.includes(key) && (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value))));
  if (typeof oauthAccount.accountUuid !== "string" || !oauthAccount.accountUuid.trim()) throw new Error("Native Claude login metadata has no account identity");
  const metadata = { oauthAccount, ...(typeof raw.userID === "string" ? { userID: raw.userID } : {}), ...(typeof raw.hasCompletedOnboarding === "boolean" ? { hasCompletedOnboarding: raw.hasCompletedOnboarding } : {}) };
  const temporary = join(config, `.login-metadata-${randomUUID()}.tmp`);
  try { writeFileSync(temporary, JSON.stringify(metadata), { mode: 0o600, flag: "wx" }); renameSync(temporary, join(config, ".claude.json")); }
  finally { rmSync(temporary, { force: true }); }
}
