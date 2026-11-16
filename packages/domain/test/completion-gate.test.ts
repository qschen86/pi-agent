import { describe, expect, it } from "vitest";
import { evaluateCompletionGate } from "../src/completion-gate.js";

const base = {
  deliveryComplete: true,
  requiredCriteria: [{ criterionId: "AC-01", required: true }],
  verificationRecords: [
    { criterionId: "AC-01", result: "PASS" as const, deliveryRevision: 1, artifactHash: "sha256:" + "a".repeat(64) }
  ],
  acceptance: { decision: "ACCEPT", deliveryRevision: 1 },
  currentDeliveryRevision: 1
};

describe("Completion Gate（AP-QA-008 §5 completion_gate / G6）", () => {
  it("全部满足 → completed=true", () => {
    expect(evaluateCompletionGate(base)).toEqual({ completed: true, unmet: [] });
  });

  it("交付不完整 → 未完成", () => {
    const r = evaluateCompletionGate({ ...base, deliveryComplete: false });
    expect(r.completed).toBe(false);
    expect(r.unmet.join()).toContain("delivery.complete");
  });

  it("必须条件 FAIL 或缺失 → 未完成", () => {
    const fail = evaluateCompletionGate({
      ...base,
      verificationRecords: [{ ...base.verificationRecords[0], result: "FAIL" }]
    });
    expect(fail.completed).toBe(false);
    const missing = evaluateCompletionGate({ ...base, verificationRecords: [] });
    expect(missing.completed).toBe(false);
  });

  it("未绑定 artifact hash 的 PASS 不足以完成（G5）", () => {
    const r = evaluateCompletionGate({
      ...base,
      verificationRecords: [{ ...base.verificationRecords[0], artifactHash: "" }]
    });
    expect(r.completed).toBe(false);
  });

  it("验收非 ACCEPT → 未完成（INV-04 交付不等于完成）", () => {
    for (const decision of ["PARTIAL_ACCEPT", "REWORK", "REJECT", "EXPIRE"]) {
      const r = evaluateCompletionGate({ ...base, acceptance: { decision, deliveryRevision: 1 } });
      expect(r.completed).toBe(false);
    }
  });

  it("验收 revision 与当前交付不一致 → 未完成（防旧版本验收漂移）", () => {
    const r = evaluateCompletionGate({ ...base, acceptance: { decision: "ACCEPT", deliveryRevision: 2 }, currentDeliveryRevision: 3 });
    expect(r.completed).toBe(false);
    expect(r.unmet.join()).toContain("revision");
  });
});
