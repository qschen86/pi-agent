/**
 * 打回之后修订契约（ADR-0807）。
 *
 * 此前 REJECT 只会带着原因回到 RUNNING，契约与计划纹丝不动——下一轮验证的还是老标准，
 * 打回的理由根本没进入验收。这里锁住修订契约的状态机规则：
 *   - 只能在「当前这一版交付刚被打回、新交付还没提出」时修订；修订号严格 +1；
 *   - 修订之后必须按新契约重编译计划，否则拒绝交付（交付永远绑定最新契约）；
 *   - 运行中的重编译只能用来追上最新修订，不能借机换计划；
 *   - 执行方（runtime/adapter）无权修订契约——Agent 不能改写自己的验收标准。
 */
import { describe, expect, it } from "vitest";
import { initialAggregate, reduce } from "../src/task-session.js";
import type { CommandEnvelope, ReduceContext, ReduceResult, TaskSessionAggregate } from "../src/task-session.js";

const CTX: ReduceContext = { now: "2026-09-23T08:00:00.000Z", correlationId: "corr-rev" };
const USER = { type: "user" as const, id: "owner-1" };
const SYSTEM = { type: "system" as const, id: "platform" };
const PLAN_1 = "sha256:" + "a".repeat(64);
const PLAN_2 = "sha256:" + "b".repeat(64);
const DIGEST_1 = "sha256:" + "d".repeat(64);
const DIGEST_2 = "sha256:" + "e".repeat(64);

let seq = 0;
function send(agg: TaskSessionAggregate, type: CommandEnvelope["commandType"], payload: unknown, actor: CommandEnvelope["actor"] = USER): ReduceResult {
  seq += 1;
  return reduce(agg, {
    commandId: `cmd-rev-${seq}`,
    commandType: type,
    expectedVersion: agg.aggregateVersion,
    actor: type === "RecordVerification" || type === "SetBindingPlan" ? SYSTEM : actor,
    sessionId: "s-rev",
    idempotencyKey: `key-rev-${seq}`,
    payload
  }, CTX);
}
function ok(agg: TaskSessionAggregate, type: CommandEnvelope["commandType"], payload: unknown, actor?: CommandEnvelope["actor"]): TaskSessionAggregate {
  const r = send(agg, type, payload, actor);
  if (!r.ok) throw r.error;
  return r.aggregate;
}

function running(): TaskSessionAggregate {
  let agg = initialAggregate("s-rev");
  agg = ok(agg, "DraftContract", { contractDigest: DIGEST_1, taskId: "task-rev" });
  agg = ok(agg, "ConfirmContract", { contractRevision: 1, contractDigest: DIGEST_1 });
  agg = ok(agg, "SetBindingPlan", { planHash: PLAN_1, pins: { agent: "1.0.0", contract: 1 }, requiredCriteria: [{ criterionId: "AC1", evaluator: "rule", required: true }] });
  return ok(agg, "Start", {});
}

const manifest = (planHash: string) => ({
  deliveryId: `dlv_${"ab".repeat(8)}`,
  sourcePlanHash: planHash,
  complete: true,
  files: [{ path: "/workspace/out/r.md", mediaType: "text/markdown", size: 10, sha256: "sha256:" + "c".repeat(64), role: "artifact" as const }],
  evidenceBundle: [{ criterionId: "AC1", recordRefs: [] }],
  summary: { goal: "g", completed: "c" }
});

function deliver(agg: TaskSessionAggregate, planHash: string, criteria: string[] = ["AC1"]): TaskSessionAggregate {
  let a = ok(agg, "ProposeDelivery", { manifest: manifest(planHash) });
  for (const criterionId of criteria) {
    a = ok(a, "RecordVerification", {
      record: {
        recordId: `vr_${criterionId}_${seq}`, criterionId, result: "PASS", planHash,
        artifactHash: "sha256:" + "c".repeat(64), evidenceRefs: ["evidence://runs/self/verification/1"], deliveryRevision: a.deliveryRevision
      }
    });
  }
  return ok(a, "Deliver", {});
}

function reject(agg: TaskSessionAggregate): TaskSessionAggregate {
  return ok(agg, "Reject", {
    acceptanceId: `acc_rej_${agg.deliveryRevision}`, decision: "REJECT", deliveryRevision: agg.deliveryRevision,
    findings: ["问题列表请按严重程度排序"], signer: { userId: "owner-1", role: "Owner" }, decidedAt: CTX.now
  });
}

const revise = (revision: number, digest = DIGEST_2) => ({ contractRevision: revision, contractDigest: digest });
const replan = (planHash: string, contract: number) =>
  ({ planHash, pins: { agent: "1.0.0", contract }, requiredCriteria: [{ criterionId: "AC1", evaluator: "rule", required: true }, { criterionId: "AC2", evaluator: "rule", required: true }] });

describe("打回之后修订契约", () => {
  it("打回后可以修订：修订号 +1，仍在 RUNNING，事件记下依据的是哪一次打回", () => {
    const rejected = reject(deliver(running(), PLAN_1));
    const r = send(rejected, "ReviseContract", revise(2));
    expect(r.ok).toBe(true);
    expect(r.aggregate.contractRevision).toBe(2);
    expect(r.aggregate.contractDigest).toBe(DIGEST_2);
    expect(r.aggregate.state).toBe("RUNNING");
    expect(r.events.map((e) => e.eventType)).toEqual(["ContractRevised"]);
    expect(r.events[0].payload).toMatchObject({ contractRevision: 2, contractDigest: DIGEST_2, basedOnAcceptanceId: "acc_rej_1", basedOnDeliveryRevision: 1 });
  });

  it("修订之后必须按新契约重编译，否则拒绝交付；重编译之后第 2 轮交付绑定新计划", () => {
    const revised = ok(reject(deliver(running(), PLAN_1)), "ReviseContract", revise(2));
    const stale = send(revised, "ProposeDelivery", { manifest: manifest(PLAN_1) });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("GUARD_FAILED");
    expect(stale.error?.message).toMatch(/重编译/);

    const replanned = ok(revised, "SetBindingPlan", replan(PLAN_2, 2));
    expect(replanned.planHash).toBe(PLAN_2);
    expect(replanned.requiredCriteria.map((c) => c.criterionId)).toEqual(["AC1", "AC2"]);
    const round2 = deliver(replanned, PLAN_2, ["AC1", "AC2"]);
    expect(round2.state).toBe("DELIVERED");
    expect(round2.deliveryRevision).toBe(2);
    expect(round2.deliveries[2].sourcePlanHash).toBe(PLAN_2);
    expect(round2.deliveries[1].sourcePlanHash).toBe(PLAN_1); // 上一轮的交付仍绑定它当时的计划
  });

  it("运行中的重编译只用来追上最新修订：没修订不许换计划，也不许绑定旧修订", () => {
    const noRevision = send(running(), "SetBindingPlan", replan(PLAN_2, 1));
    expect(noRevision.ok).toBe(false);
    const revised = ok(reject(deliver(running(), PLAN_1)), "ReviseContract", revise(2));
    const oldPins = send(revised, "SetBindingPlan", replan(PLAN_2, 1));
    expect(oldPins.ok).toBe(false);
    expect(oldPins.error?.code).toBe("GUARD_FAILED");
  });

  it("不是在打回之后就不能修订：运行中、验证中、交付待验收、已接受都不行", () => {
    const run = running();
    expect(send(run, "ReviseContract", revise(2)).ok).toBe(false);
    const verifying = ok(run, "ProposeDelivery", { manifest: manifest(PLAN_1) });
    expect(send(verifying, "ReviseContract", revise(2)).ok).toBe(false);
    const delivered = deliver(running(), PLAN_1);
    expect(send(delivered, "ReviseContract", revise(2)).ok).toBe(false);
    const accepted = ok(delivered, "Accept", {
      acceptanceId: "acc_ok", decision: "ACCEPT", deliveryRevision: 1, findings: [], signer: { userId: "owner-1", role: "Owner" }, decidedAt: CTX.now
    });
    expect(send(accepted, "ReviseContract", revise(2)).ok).toBe(false);
  });

  it("修订号必须严格 +1：跳号、重复都拒绝", () => {
    const rejected = reject(deliver(running(), PLAN_1));
    for (const n of [1, 3, 0]) {
      const r = send(rejected, "ReviseContract", revise(n));
      expect(r.ok, `revision ${n}`).toBe(false);
      expect(r.error?.code).toBe("GUARD_FAILED");
    }
    expect(send(rejected, "ReviseContract", { contractRevision: 2, contractDigest: "not-a-digest" }).ok).toBe(false);
  });

  it("新一轮交付提出之后，上一轮的打回就不能再拿来修订；这一轮再被打回才能修第 3 版", () => {
    let agg = ok(reject(deliver(running(), PLAN_1)), "ReviseContract", revise(2));
    agg = ok(agg, "SetBindingPlan", replan(PLAN_2, 2));
    const verifying = ok(agg, "ProposeDelivery", { manifest: manifest(PLAN_2) });
    expect(send(verifying, "ReviseContract", revise(3)).ok).toBe(false);
    const round2 = deliver(agg, PLAN_2, ["AC1", "AC2"]);
    const rejectedAgain = reject(round2);
    const r = send(rejectedAgain, "ReviseContract", revise(3, "sha256:" + "f".repeat(64)));
    expect(r.ok).toBe(true);
    expect(r.events[0].payload).toMatchObject({ contractRevision: 3, basedOnDeliveryRevision: 2 });
  });

  it("执行方无权修订契约：Agent 不能改写自己的验收标准", () => {
    const rejected = reject(deliver(running(), PLAN_1));
    for (const type of ["runtime", "adapter"] as const) {
      const r = send(rejected, "ReviseContract", revise(2), { type, id: "pi" });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("COMMAND_UNAUTHORIZED");
    }
  });
});
