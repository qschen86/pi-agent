/** Host-owned project budget units. Undefined limits mean unbounded, never zero usage. */
export interface ExecutionBudgetLimits {
  maxCalls?: number;
  /** Sum of native-operation wall time from admission through observed terminal, including approval/stop reconciliation. */
  maxWallTimeMs?: number;
  maxTokens?: number;
  /** Runtime-reported USD equivalent; this is not a subscription cash balance. */
  maxReportedCostUsd?: number;
}
const bounds = { maxCalls: 1_000_000, maxWallTimeMs: 31_536_000_000, maxTokens: 1_000_000_000_000, maxReportedCostUsd: 1_000_000 };
export function executionBudgetLimits(value: unknown): ExecutionBudgetLimits {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(bounds, k))) throw new Error("项目预算必须是带明确单位的对象");
  const result: ExecutionBudgetLimits = {};
  for (const key of Object.keys(bounds) as Array<keyof ExecutionBudgetLimits>) {
    if (!Object.hasOwn(value, key)) continue;
    const n = (value as Record<string, unknown>)[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > bounds[key] || key !== "maxReportedCostUsd" && !Number.isSafeInteger(n)) throw new Error(`项目预算 ${key} 数值无效`);
    result[key] = n;
  }
  return result;
}
export function executionBudgetIncreases(previous: ExecutionBudgetLimits | undefined, next: ExecutionBudgetLimits): boolean {
  return (Object.keys(bounds) as Array<keyof ExecutionBudgetLimits>).some(key => previous?.[key] !== undefined && (next[key] === undefined || next[key]! > previous[key]!));
}
export interface ProjectExecutionUsage {
  calls: { used: number; basis: string };
  wallTimeMs: { observed: number; coverage: "complete" | "unknown"; pendingTerminalCalls: number; basis: string };
  tokens: NativeMeterUsage;
  reportedCostUsd: NativeMeterUsage;
}

/** Exact operation terminal receipt. Session totals and display text are not accepted here. */
export interface NativeTurnUsageReceipt {
  version: 1;
  runtimeKind: "codex" | "claude-code" | "pi" | "antigravity";
  nativeSessionId: string;
  nativeTurnId: string;
  clientMessageId: string;
  sourceRef: string;
  /** Complete tokens for this turn, including every model request. Omit when unprovable. */
  tokens?: number;
  /** Complete runtime-reported USD equivalent for this turn, not subscription cash. */
  reportedCostUsd?: number;
}
export interface NativeMeterUsage {
  coverage: "complete" | "partial" | "not_collected";
  /** Sum of proven receipts only. Missing reports never become zero. */
  observed?: number;
  pendingCalls: number;
  basis: string;
}
export function nativeTurnUsageReceipt(value: unknown): NativeTurnUsageReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native usage receipt");
  const v = value as Record<string, unknown>;
  const fields = ["version", "runtimeKind", "nativeSessionId", "nativeTurnId", "clientMessageId", "sourceRef", "tokens", "reportedCostUsd"];
  if (Object.keys(v).some(k => !fields.includes(k)) || v.version !== 1 || !["codex", "claude-code", "pi", "antigravity"].includes(String(v.runtimeKind))) throw new Error("Invalid native usage receipt");
  for (const key of ["nativeSessionId", "nativeTurnId", "clientMessageId", "sourceRef"]) if (typeof v[key] !== "string" || !(v[key] as string).trim() || (v[key] as string).length > 2000) throw new Error("Invalid native usage identity/source");
  if (v.tokens === undefined && v.reportedCostUsd === undefined) throw new Error("Native usage receipt has no known units");
  if (Object.hasOwn(v, "tokens") && (typeof v.tokens !== "number" || !Number.isSafeInteger(v.tokens) || v.tokens < 0)) throw new Error("Invalid native tokens usage");
  if (Object.hasOwn(v, "reportedCostUsd") && (typeof v.reportedCostUsd !== "number" || !Number.isFinite(v.reportedCostUsd) || v.reportedCostUsd < 0 || v.reportedCostUsd > 1_000_000)) throw new Error("Invalid native USD usage");
  return { version: 1, runtimeKind: v.runtimeKind as NativeTurnUsageReceipt["runtimeKind"], nativeSessionId: v.nativeSessionId as string, nativeTurnId: v.nativeTurnId as string, clientMessageId: v.clientMessageId as string, sourceRef: v.sourceRef as string, ...(v.tokens === undefined ? {} : { tokens: v.tokens as number }), ...(v.reportedCostUsd === undefined ? {} : { reportedCostUsd: v.reportedCostUsd as number }) };
}
