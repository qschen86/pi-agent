// Server-side gate. Evidence must come from configured probes, never request-body assertions.
// A pass means the configured checks passed; it is not an account-safety guarantee.
export const NETWORK_REPORT_TTL_MS = 5 * 60_000;
const runtimes = new Set(['codex', 'claude-code', 'antigravity']);
const stages = new Set(['install', 'login', 'first-task']);
const checks = ['region', 'connectivity', 'networkType'];
const allowedNetworkTypes = new Set(['residential', 'non-datacenter']);

export function evaluateRuntimeNetwork({ runtime, report, networkId, now = Date.now() }) {
  if (!runtimes.has(runtime)) throw Error('不支持的可选运行时');
  const reasons = [];
  if (!report || report.runtime !== runtime || !networkId || report.networkId !== networkId) reasons.push('missing-or-mismatched-report');
  if (!Number.isFinite(report?.checkedAt) || report.checkedAt > now || now - report.checkedAt >= NETWORK_REPORT_TTL_MS) reasons.push('expired-report');
  for (const name of checks) {
    const evidence = report?.checks?.[name];
    // Unknown, unavailable, high-risk, unsupported, and failed checks all block.
    if (evidence?.status !== 'passed') reasons.push(`${name}-not-passed`);
    if (typeof evidence?.source !== 'string' || !evidence.source.trim()) reasons.push(`${name}-missing-source`);
  }
  // An ASN/ISP name, or an absent hosting flag, does not establish a residential exit.
  if (!allowedNetworkTypes.has(report?.checks?.networkType?.value)) reasons.push('network-type-not-allowed');
  return { runtime, allowed: reasons.length === 0, reasons, accountSafetyGuaranteed: false };
}

/** Recheck current egress immediately before an install/login/task side effect. */
export async function withRuntimeNetworkGate({ runtime, stage, inspect, operation, now = () => Date.now() }) {
  if (!stages.has(stage)) throw Error('不支持的网络检查阶段');
  // Probe failure must never fall back to installing or logging in.
  const { report, networkId } = await inspect(runtime);
  const decision = evaluateRuntimeNetwork({ runtime, report, networkId, now: now() });
  if (!decision.allowed) {
    const error = new Error('当前网络检查未通过，已停止安装、登录或首次任务；请查看检查结果后重试');
    error.code = 'RUNTIME_NETWORK_BLOCKED';
    error.decision = decision;
    throw error;
  }
  return operation();
}
