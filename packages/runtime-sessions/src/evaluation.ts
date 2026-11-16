/** Host-owned evaluation policy. Read inputs and report writes never share a mutable root. */
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalPath, isWithin } from "@pi-agent/adapter-pi";
import type { PermissionMode } from "./permissions.js";
import type { RuntimeKind } from "./types.js";
export interface EvaluationBoundary { inputRoots: string[]; reportDir: string }
export function normalizeEvaluation(workspace: string, value: EvaluationBoundary): EvaluationBoundary {
  if (!value || !isAbsolute(value.reportDir) || !Array.isArray(value.inputRoots) || !value.inputRoots.length || value.inputRoots.some((p) => typeof p !== "string" || !isAbsolute(p) || !existsSync(p))) throw new Error("Evaluation requires absolute, existing input roots and an absolute report directory");
  const root = canonicalPath(workspace), reportDir = canonicalPath(value.reportDir);
  const inputRoots = [...new Set(value.inputRoots.map((p) => canonicalPath(p)))];
  if (reportDir === root || !isWithin(reportDir, root)) throw new Error("Evaluation report must be strictly inside job workspace");
  if (inputRoots.some((p) => isWithin(p, reportDir) || isWithin(reportDir, p))) throw new Error("Evaluation inputs overlap report write root");
  return { inputRoots, reportDir };
}
export function evaluationPermission(kind: RuntimeKind, mode: PermissionMode): boolean {
  return mode === (kind === "codex" ? "ask" : kind === "pi" ? "pi-ask" : "default");
}
