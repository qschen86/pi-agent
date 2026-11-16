/**
 * Completion Gate（09 计划 §6 模块 7 / AP-QA-008 §5）。
 *
 * completion_gate =
 *   delivery.complete
 *   AND requiredVerification.every(result == PASS)
 *   AND acceptance.decision == ACCEPT
 *   AND acceptance.deliveryRevision == currentDeliveryRevision
 *
 * COMPLETED 只能由该门禁从 ACCEPTED 派生（S-04），不存在直接命令。
 */
import type { TaskSessionAggregate } from "./task-session.js";
import { effectiveRecord, requiredUnmet } from "./task-session.js";

export interface CompletionGateInput {
  deliveryComplete: boolean;
  requiredCriteria: Array<{ criterionId: string; required: boolean }>;
  verificationRecords: Array<{ criterionId: string; result: "PASS" | "FAIL" | "INCONCLUSIVE"; deliveryRevision: number; artifactHash: string; evaluator?: "rule" | "human" | "semantic" }>;
  acceptance?: { decision: string; deliveryRevision: number };
  currentDeliveryRevision: number;
}

export interface CompletionGateResult {
  completed: boolean;
  unmet: string[];
}

export function evaluateCompletionGate(input: CompletionGateInput): CompletionGateResult {
  const unmet: string[] = [];

  if (!input.deliveryComplete) unmet.push("delivery.complete = false");
  for (const c of input.requiredCriteria) {
    if (!c.required) continue;
    // 与状态机同一套取值：人工判定补上的 INCONCLUSIVE 以人工结论为准（v2.0 S1）
    const rec = effectiveRecord(
      { verificationRecords: input.verificationRecords as TaskSessionAggregate["verificationRecords"] },
      c.criterionId,
      input.currentDeliveryRevision
    );
    if (!rec) unmet.push(`${c.criterionId} 缺少验证记录`);
    else if (rec.result !== "PASS") unmet.push(`${c.criterionId} = ${rec.result}`);
    else if (!rec.artifactHash.startsWith("sha256:")) unmet.push(`${c.criterionId} 验证记录未绑定 artifact hash`);
  }
  if (!input.acceptance) unmet.push("缺少 AcceptanceRecord");
  else {
    if (input.acceptance.decision !== "ACCEPT") unmet.push(`验收决定为 ${input.acceptance.decision}（要求 ACCEPT）`);
    if (input.acceptance.deliveryRevision !== input.currentDeliveryRevision) {
      unmet.push(
        `验收 revision ${input.acceptance.deliveryRevision} ≠ 当前交付 ${input.currentDeliveryRevision}`
      );
    }
  }

  return { completed: unmet.length === 0, unmet };
}

/** 聚合便捷入口：与状态机 Deliver 使用同一套强校验（fix-8 统一门禁，无第二套标准）。 */
export function evaluateCompletionGateForAggregate(agg: TaskSessionAggregate): CompletionGateResult {
  const unmet = requiredUnmet(agg);
  if (!agg.acceptance) unmet.push("缺少 AcceptanceRecord");
  else {
    if (agg.acceptance.decision !== "ACCEPT") unmet.push(`验收决定为 ${agg.acceptance.decision}（要求 ACCEPT）`);
    if (agg.acceptance.deliveryRevision !== agg.deliveryRevision) unmet.push("验收 revision 与当前交付不一致");
  }
  return { completed: unmet.length === 0, unmet };
}
