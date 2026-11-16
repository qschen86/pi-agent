import { describe, expect, it } from "vitest";
import { initialAggregate, reduce, requiredUnmet } from "../src/task-session.js";
import type { CommandEnvelope, ReduceContext, ReduceResult, SessionState, TaskSessionAggregate } from "../src/task-session.js";
import { PlatformError } from "../src/errors.js";

const CTX: ReduceContext = { now: "2026-09-21T08:00:00.000Z", correlationId: "corr-1" };
const USER = { type: "user" as const, id: "owner-1" };

let seq = 0;
function makeCmd(agg: TaskSessionAggregate, type: CommandEnvelope["commandType"], payload: unknown, over: { expectedVersion?: number; commandId?: string; actor?: CommandEnvelope["actor"] } = {}): CommandEnvelope {
  seq += 1;
  return {
    commandId: over.commandId ?? `cmd-${seq}`,
    commandType: type,
    expectedVersion: over.expectedVersion ?? agg.aggregateVersion,
    actor: over.actor ?? (type === "RecordVerification" ? SYSTEM : USER),
    sessionId: "s-1",
    idempotencyKey: `key-${seq}`,
    payload
  };
}

const SYSTEM = { type: "system" as const, id: "platform" };

function send(agg: TaskSessionAggregate, type: CommandEnvelope["commandType"], payload: unknown, over: { expectedVersion?: number; commandId?: string; actor?: CommandEnvelope["actor"] } = {}): ReduceResult {
  return reduce(agg, makeCmd(agg, type, payload, over), CTX);
}

function ok(agg: TaskSessionAggregate, type: CommandEnvelope["commandType"], payload: unknown, over: { expectedVersion?: number; commandId?: string; actor?: CommandEnvelope["actor"] } = {}): TaskSessionAggregate {
  const r = send(agg, type, payload, over);
  if (!r.ok) throw r.error;
  return r.aggregate;
}

function draft(agg: TaskSessionAggregate): TaskSessionAggregate {
  return ok(agg, "DraftContract", { contractDigest: "sha256:" + "d".repeat(64), taskId: "task-001" });
}

function toRunning(): TaskSessionAggregate {
  let agg = initialAggregate("s-1");
  agg = draft(agg);
  agg = ok(agg, "ConfirmContract", { contractRevision: 3, contractDigest: "sha256:" + "d".repeat(64) });
  agg = ok(agg, "SetBindingPlan", { planHash: "sha256:" + "a".repeat(64), pins: { agent: "1.0.0", contract: 3 }, requiredCriteria: [{ criterionId: "AC-01", evaluator: "rule", required: true }] }, { actor: SYSTEM });
  return ok(agg, "Start", {});
}

function manifestView() {
  return {
    deliveryId: `dlv_${"ab".repeat(8)}`,
    sourcePlanHash: "sha256:" + "a".repeat(64),
    complete: true,
    files: [{ path: "/workspace/out/r.md", mediaType: "text/markdown", size: 10, sha256: "sha256:" + "c".repeat(64), role: "artifact" as const }],
    evidenceBundle: [{ criterionId: "AC-01", recordRefs: [] }],
    summary: { goal: "g", completed: "c" }
  };
}

function verificationRecord(result: "PASS" | "FAIL" = "PASS") {
  return {
    recordId: `vr_${"a1".repeat(6)}${seq}`,
    criterionId: "AC-01",
    result,
    artifactHash: "sha256:" + "c".repeat(64),
    evidenceRefs: ["evidence://runs/self/verification/1"],
    deliveryRevision: 1
  };
}

function toDelivered(agg: TaskSessionAggregate): TaskSessionAggregate {
  let a = ok(agg, "ProposeDelivery", { manifest: manifestView() });
  a = ok(a, "RecordVerification", { record: verificationRecord("PASS") });
  return ok(a, "Deliver", {});
}

const acceptPayload = (revision: number, decision: string) => ({
  acceptanceId: `acc_${seq}`,
  decision,
  deliveryRevision: revision,
  signer: { userId: "owner-1", role: "Owner" },
  decidedAt: CTX.now
});

describe("TaskSession 状态机（AP-STATE-007 §2 迁移矩阵）", () => {
  it("合法主路径 DRAFT→READY→RUNNING→VERIFYING→DELIVERED→ACCEPTED→COMPLETED→ARCHIVED", () => {
    let agg = initialAggregate("s-1");
    agg = draft(agg);
    expect(agg.state).toBe("CONTRACTING");
    agg = ok(agg, "ConfirmContract", { contractRevision: 1, contractDigest: "sha256:" + "d".repeat(64) });
    expect(agg.state).toBe("READY");
    agg = ok(agg, "SetBindingPlan", { planHash: "sha256:" + "a".repeat(64), pins: { agent: "1.0.0", contract: 1 }, requiredCriteria: [] }, { actor: SYSTEM });
    agg = ok(agg, "Start", {});
    expect(agg.state).toBe("RUNNING");
    expect(agg.currentAttemptId).toBeDefined();
    agg = ok(agg, "ProposeDelivery", { manifest: manifestView() });
    expect(agg.state).toBe("VERIFYING");
    expect(agg.deliveryRevision).toBe(1);
    agg = ok(agg, "RecordVerification", { record: verificationRecord() });
    agg = ok(agg, "Deliver", {});
    expect(agg.state).toBe("DELIVERED");
    agg = ok(agg, "Accept", acceptPayload(1, "ACCEPT"));
    expect(agg.state).toBe("COMPLETED"); // 派生完成（S-04）
    agg = ok(agg, "Archive", {});
    expect(agg.state).toBe("ARCHIVED");
  });

  it("迁移矩阵：每个状态的不允许命令全部拒绝（STATE_INVALID_TRANSITION，而非版本冲突）", () => {
    const probes: Array<{ agg: TaskSessionAggregate; wrong: CommandEnvelope["commandType"][] }> = [];
    probes.push({ agg: initialAggregate("s-1"), wrong: ["Start", "Pause", "Accept", "Deliver", "Archive", "Retry", "Resume", "ConfirmContract"] }); // SetBindingPlan 权限见 regression
    probes.push({ agg: ok(draft(initialAggregate("s-1")), "ConfirmContract", { contractRevision: 1, contractDigest: "sha256:" + "d".repeat(64) }), wrong: ["Pause", "Resume", "Accept", "Deliver", "ProposeDelivery", "RecordVerification", "Retry", "DraftContract"] });
    probes.push({ agg: toRunning(), wrong: ["ConfirmContract", "Start", "Accept", "Deliver", "Archive", "Resume"] });
    probes.push({ agg: ok(toRunning(), "Pause", { reason: "审批" }), wrong: ["Start", "Pause", "ProposeDelivery", "Accept", "Deliver"] });
    probes.push({ agg: ok(toRunning(), "ProposeDelivery", { manifest: manifestView() }), wrong: ["Start", "Pause", "ProposeDelivery", "Accept", "Cancel"] });
    probes.push({ agg: toDelivered(toRunning()), wrong: ["Start", "Pause", "Deliver", "ProposeDelivery", "Cancel", "Resume"] });
    probes.push({ agg: ok(toDelivered(toRunning()), "Accept", acceptPayload(1, "ACCEPT")), wrong: ["Start", "Pause", "Accept", "Rework", "Deliver", "Cancel", "Retry"] });

    for (const { agg, wrong } of probes) {
      for (const w of wrong) {
        const r = send(agg, w, {});
        expect(r.ok, `${agg.state} 不应接受 ${w}`).toBe(false);
        expect(r.error?.code, `${agg.state} + ${w} 应为状态错误`).toBe("STATE_INVALID_TRANSITION");
      }
    }
  });

  it("S-01：无 plan_hash/pins 拒绝 Start", () => {
    const agg = ok(draft(initialAggregate("s-1")), "ConfirmContract", { contractRevision: 1, contractDigest: "sha256:" + "d".repeat(64) });
    const r2 = send(agg, "Start", {});
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe("GUARD_FAILED");
  });

  it("S-04：不存在直接产生 COMPLETED 的命令（Accept 之外）", () => {
    const delivered = toDelivered(toRunning());
    for (const c of ["Pause", "Resume", "Start", "Deliver", "Archive", "Retry", "RecordVerification"] as const) {
      const r = send(delivered, c, {});
      if (r.ok) {
        expect(r.aggregate.state).not.toBe("COMPLETED");
      }
    }
  });

  it("S-05：terminal 状态不可回到 RUNNING", () => {
    const agg = ok(toRunning(), "Cancel", { reason: "终态演示" });
    expect(agg.state).toBe("CANCELLED");
    for (const c of ["Start", "ReturnToRun", "Resume", "Rework", "Accept"] as const) {
      const r = send(agg, c, {});
      expect(r.ok, `CANCELLED 不应接受 ${c}`).toBe(false);
    }
  });

  it("UC-023：REJECT 回到 RUNNING 继续迭代（非终态，新 attempt，必须带原因）", () => {
    const delivered = toDelivered(toRunning());
    const withoutReason = send(delivered, "Reject", acceptPayload(1, "REJECT"));
    expect(withoutReason.ok).toBe(false);
    expect(withoutReason.error?.code).toBe("GUARD_FAILED");

    const agg = ok(delivered, "Reject", { ...acceptPayload(1, "REJECT"), reason: "问题分析太泛，没有说明验证码步骤" });
    expect(agg.state).toBe("RUNNING");
    expect(agg.reworkCount).toBe(1);
    expect(agg.acceptance?.decision).toBe("REJECT");
    // 迭代后可再次交付（新 revision）。
    const a2 = ok(agg, "ProposeDelivery", { manifest: manifestView() });
    expect(a2.deliveryRevision).toBe(2);
  });

  it("S-06：同一 command_id 重复提交不产生第二次状态变化（返回原结果，幂等先于版本校验）", () => {
    const agg = toRunning();
    const c = makeCmd(agg, "Pause", { reason: "审批" }, { commandId: "cmd-fixed-1" });
    const r1 = reduce(agg, c, CTX);
    expect(r1.ok).toBe(true);
    expect(r1.aggregate.state).toBe("PAUSED");
    // 客户端重试：同一 commandId（即使 expectedVersion 已过期）→ 返回原结果。
    const r2 = reduce(r1.aggregate, { ...c, expectedVersion: 0 }, CTX);
    expect(r2.ok).toBe(true);
    expect(r2.replayed).toBe(true);
    expect(r2.events).toHaveLength(0);
    expect(r2.aggregate).toBe(r1.aggregate); // 返回原结果对应的聚合，无新状态
  });

  it("乐观并发：expectedVersion 不匹配 → VERSION_CONFLICT，不自动覆盖", () => {
    const agg = toRunning();
    const r = send(agg, "Pause", { reason: "x" }, { expectedVersion: agg.aggregateVersion + 5 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("VERSION_CONFLICT");
  });

  it("没有 Evidence 的 DeliveryProposed 必须被拒绝（09 计划 §5 必须 5）", () => {
    const agg = toRunning();
    const bad = { ...manifestView(), evidenceBundle: [] };
    const r = send(agg, "ProposeDelivery", { manifest: bad });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("EVIDENCE_MISSING");
  });

  it("验证未全 PASS 时 Deliver 拒绝（S-03）", () => {
    let agg = ok(toRunning(), "ProposeDelivery", { manifest: manifestView() });
    agg = ok(agg, "RecordVerification", { record: verificationRecord("FAIL") });
    const r = send(agg, "Deliver", {});
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("EVIDENCE_MISSING");
    expect(requiredUnmet(agg).length).toBeGreaterThan(0);
  });

  it("验收 revision 不对应当前交付 → 不得完成（09 计划 §5 必须 6）", () => {
    const delivered = toDelivered(toRunning());
    const r = send(delivered, "Accept", acceptPayload(99, "ACCEPT"));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("ACCEPTANCE_REVISION_MISMATCH");
  });

  it("REWORK → RUNNING；再次交付 revision 递增；DRAFT→ACCEPTED 直接拒绝（09 计划 §5 必须 4）", () => {
    const delivered = toDelivered(toRunning());
    const rw = send(delivered, "Rework", acceptPayload(1, "REWORK"));
    expect(rw.ok).toBe(true);
    expect(rw.aggregate.state).toBe("RUNNING");
    expect(rw.aggregate.reworkCount).toBe(1);

    // REWORK 后第二次交付：revision 递增到 2。
    const a2 = ok(rw.aggregate, "ProposeDelivery", { manifest: manifestView() });
    expect(a2.deliveryRevision).toBe(2);

    // DRAFT 直接 Accept → STATE_INVALID_TRANSITION
    const draft = initialAggregate("s-2");
    const r = send(draft, "Accept", acceptPayload(1, "ACCEPT"));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("STATE_INVALID_TRANSITION");
  });

  it("S-02：副作用事件缺 policy_decision_id 被隔离（fail closed）", () => {
    const agg = toRunning();
    const RUNTIME = { type: "runtime" as const, id: "mock" };
    const r = send(agg, "RecordRuntimeEvent", { eventType: "ToolSucceeded", payload: { invocationId: "i1" } }, { actor: RUNTIME });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("POLICY_FAIL_CLOSED");
    const okR = send(agg, "RecordRuntimeEvent", { eventType: "ToolSucceeded", payload: { invocationId: "i1" }, policyDecisionId: "pd_1" }, { actor: RUNTIME });
    expect(okR.ok).toBe(true);
  });

  it("fatal ToolFailed 使会话进入 FAILED；Retry 回 READY 重新 Start（新 attempt）", () => {
    const agg = toRunning();
    const attempt1 = agg.currentAttemptId;
    let a = ok(agg, "RecordRuntimeEvent", { eventType: "ToolFailed", payload: { fatal: true, reason: "runtime crash" }, policyDecisionId: "pd_9" }, { actor: { type: "runtime", id: "mock" } });
    expect(a.state).toBe("FAILED");
    a = ok(a, "Retry", {});
    expect(a.state).toBe("READY");
    a = ok(a, "Start", {});
    expect(a.state).toBe("RUNNING");
    expect(a.currentAttemptId).not.toBe(attempt1);
  });

  it("暂停/恢复守卫：Resume 需要 resolved=true", () => {
    const paused = ok(toRunning(), "Pause", { reason: "等待人工审批" });
    expect(paused.state).toBe("PAUSED");
    const r = send(paused, "Resume", {});
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("GUARD_FAILED");
    const resumed = ok(paused, "Resume", { resolved: true });
    expect(resumed.state).toBe("RUNNING");
  });

  it("PARTIAL_ACCEPT 必须给出明确子集；REJECT 保留证据进终态", () => {
    const delivered = toDelivered(toRunning());
    const p = send(delivered, "PartialAccept", { ...acceptPayload(1, "PARTIAL_ACCEPT"), acceptedSubset: undefined });
    expect(p.ok).toBe(false);
    const p2 = send(delivered, "PartialAccept", { ...acceptPayload(1, "PARTIAL_ACCEPT"), acceptedSubset: ["/workspace/out/r.md"] });
    expect(p2.ok).toBe(true);
    expect(p2.aggregate.state).toBe("PARTIALLY_ACCEPTED");

    const d2 = toDelivered(toRunning());
    const rj = ok(d2, "Reject", { ...acceptPayload(1, "REJECT"), reason: "r" });
    expect(rj.state).toBe("RUNNING"); // UC-023：REJECT → RUNNING
    expect(rj.verificationRecords.length).toBeGreaterThan(0); // 证据保留
  });
});

void PlatformError;
