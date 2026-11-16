/**
 * TaskSession Reducer（09 计划 §6 模块 6 / AP-STATE-007）。
 *
 * 纯函数状态迁移：reduce(aggregate, command, ctx) → { aggregate', events, error }。
 * - 完成由验收记录派生（S-04 / INV-04）：不存在产生 COMPLETED 的命令。
 * - 幂等（S-06）：同 command_id 最多生效一次，重复请求返回原结果。
 * - 乐观并发：expectedVersion 不匹配返回 VERSION_CONFLICT，不自动覆盖。
 * - 领域纯度：时间由 ctx.now 显式注入；eventId 由内容推导，无随机数。
 */
import type { JsonValue } from "@pi-agent/schemas";
import { PlatformError } from "./errors.js";
import { canonicalJson, deterministicUuid, sha256Hex } from "./canonical.js";

export const SESSION_STATE_SCHEMA_VERSION = 1;

export type SessionState =
  | "DRAFT"
  | "CONTRACTING"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "VERIFYING"
  | "DELIVERED"
  | "ACCEPTED"
  | "PARTIALLY_ACCEPTED"
  | "REJECTED"
  | "CANCELLED"
  | "FAILED"
  | "COMPLETED"
  | "ARCHIVED";

export const TERMINAL_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  "COMPLETED",
  "ARCHIVED",
  "PARTIALLY_ACCEPTED",
  "CANCELLED"
]);
// 注意：REJECTED 不是终态（一期验收 UC-023）——REJECT 回到 RUNNING 继续迭代。

export type EventType =
  | "DefinitionPublished"
  | "ContractDrafted"
  | "ContractConfirmed"
  | "ContractRevised"
  | "PlanCompiled"
  | "RuntimeBound"
  | "RuntimeStarted"
  | "Progressed"
  | "Paused"
  | "Resumed"
  | "Cancelled"
  | "ToolRequested"
  | "PolicyDecided"
  | "ToolSucceeded"
  | "ToolFailed"
  | "WorkflowStarted"
  | "WorkflowWaiting"
  | "WorkflowSucceeded"
  | "WorkflowFailed"
  | "ArtifactCreated"
  | "VerificationRecorded"
  | "ReturnToRun"
  | "RetryScheduled"
  | "DeliveryProposed"
  | "Delivered"
  | "Accepted"
  | "PartiallyAccepted"
  | "ReworkRequested"
  | "Rejected"
  | "CompletedDerived"
  | "Archived";

export interface Actor {
  type: "user" | "system" | "runtime" | "adapter";
  id: string;
}

export interface EventEnvelope {
  eventId: string;
  eventType: EventType;
  schemaVersion: number;
  occurredAt: string;
  tenantId: string;
  sessionId: string;
  attemptId?: string;
  aggregateVersion: number;
  actor: Actor;
  correlationId: string;
  causationId?: string;
  idempotencyKey: string;
  planHash?: string;
  /** S-02：副作用事件必须引用 policy_decision_id */
  policyDecisionId?: string;
  /** 引发该事件的命令指纹（W5/G7：恢复后据此重建幂等台账） */
  commandFingerprint?: string;
  payload: JsonValue;
  payloadHash: string;
}

export type CommandType =
  | "DraftContract"
  | "ConfirmContract"
  | "ReviseContract"
  | "SetBindingPlan"
  | "Start"
  | "Pause"
  | "Resume"
  | "Cancel"
  | "Fail"
  | "Retry"
  | "Close"
  | "ProposeDelivery"
  | "RecordVerification"
  | "ReturnToRun"
  | "Deliver"
  | "Accept"
  | "PartialAccept"
  | "Rework"
  | "Reject"
  | "Archive"
  | "RecordRuntimeEvent";

export interface CommandEnvelope<P = unknown> {
  commandId: string;
  commandType: CommandType;
  expectedVersion: number;
  actor: Actor;
  sessionId: string;
  idempotencyKey: string;
  payload: P;
}

export interface ReduceContext {
  /** 注入时间（领域内核不读系统时钟） */
  now: string;
  correlationId: string;
  tenantId?: string;
}

/* ------------------------------ 聚合与视图 ------------------------------ */

export interface PlanPins {
  agent: string;
  contract: number;
  workflow?: string;
  registrySnapshotId?: string;
  capabilityCatalogVersion?: string;
}

export interface RequiredCriterion {
  criterionId: string;
  evaluator: string;
  required: boolean;
}

export interface ManifestFileView {
  path: string;
  mediaType: string;
  size: number;
  sha256: string;
  role: "artifact" | "evidence" | "reproduction";
}

export interface DeliveryManifestView {
  deliveryId: string;
  /** 交付所依据的编译计划：必须与当前会话 planHash 一致（R2-H）。 */
  sourcePlanHash: string;
  deliveryRevision: number;
  complete: boolean;
  files: ManifestFileView[];
  evidenceBundle: Array<{ criterionId: string; recordRefs: string[] }>;
  summary: { goal: string; completed: string };
}

export interface VerificationRecordView {
  recordId: string;
  criterionId: string;
  result: "PASS" | "FAIL" | "INCONCLUSIVE";
  artifactHash: string;
  evidenceRefs: string[];
  deliveryRevision: number;
  /** 验证来源计划；提供时必须与当前会话 planHash 一致 */
  planHash?: string;
  /**
   * 判定方（v2.0 S1）：缺省为机器规则。human 记录只能补上同一条件、同一交付版本里
   * 「等待人工判定」的 INCONCLUSIVE，且只对人工判定条件有效，不能覆盖机器给出的 PASS/FAIL。
   */
  evaluator?: "rule" | "human" | "semantic";
  /**
   * 程序检查的检查器版本（v2.2，形如 research-checks@1.1.0）。同一交付版本上再记一条程序检查结果，
   * 只能来自同一检查套件的补丁版本（只修误判、不改判定标准）；生效的是最新一条。
   */
  checkerVersion?: string;
}

/** 检查器版本：id@major.minor.patch。补丁版本 = 同 id、同 major.minor、patch 更大。 */
export function isCheckerPatch(from: string | undefined, to: string | undefined): boolean {
  const parse = (v: string | undefined): [string, number, number, number] | undefined => {
    const m = /^([a-z][a-z0-9-]*)@(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
    return m ? [m[1], Number(m[2]), Number(m[3]), Number(m[4])] : undefined;
  };
  const a = parse(from), b = parse(to);
  return !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && b[3] > a[3];
}

/** 人工判定条件：验证计划里的判定器引用以 human. 开头（v2.0 S1）。 */
export function isHumanCriterion(c: Pick<RequiredCriterion, "evaluator">): boolean {
  return c.evaluator.startsWith("human.");
}

/** 语义验收条件：判定器引用以 semantic. 开头（v2.0 S3）。验收助手判不了的，由人判。 */
export function isSemanticCriterion(c: Pick<RequiredCriterion, "evaluator">): boolean {
  return c.evaluator.startsWith("semantic.");
}

/**
 * 条件在某个交付版本上的有效记录：有人工判定就以人工判定为准（它只可能补在 INCONCLUSIVE 之后），
 * 否则取机器记录。
 */
export function effectiveRecord(agg: Pick<TaskSessionAggregate, "verificationRecords">, criterionId: string, deliveryRevision: number): VerificationRecordView | undefined {
  const recs = agg.verificationRecords.filter((r) => r.criterionId === criterionId && r.deliveryRevision === deliveryRevision);
  // 优先级：人工判定 > 语义验收 > 规则记录（后两者都只能补在「等待判定」之后）
  const latest = (e: string): VerificationRecordView | undefined => [...recs].reverse().find((r) => r.evaluator === e);
  // 程序检查：同一版本上检查器补丁版本重验过的，以最新一条为准（v2.2 V22-12）
  const latestRule = [...recs].reverse().find((r) => r.evaluator === undefined || r.evaluator === "rule");
  return latest("human") ?? latest("semantic") ?? latestRule;
}

export interface AcceptanceView {
  acceptanceId: string;
  decision: "ACCEPT" | "PARTIAL_ACCEPT" | "REWORK" | "REJECT" | "EXPIRE";
  deliveryRevision: number;
  acceptedSubset?: string[];
  findings?: string[];
  reason?: string;
  signer: { userId: string; role: string };
  decidedAt: string;
}

export interface TaskSessionAggregate {
  sessionId: string;
  tenantId: string;
  state: SessionState;
  aggregateVersion: number;
  contractRevision?: number;
  /** CONTRACTING 阶段冻结的契约内容摘要（fix-11 同源判定复用） */
  contractDigest?: string;
  pins?: PlanPins;
  planHash?: string;
  requiredCriteria: RequiredCriterion[];
  attempts: Array<{ attemptId: string; startedAt: string; endedAt?: string }>;
  currentAttemptId?: string;
  /** 0 = 尚未提出交付；每次 ProposeDelivery 递增 */
  deliveryRevision: number;
  deliveries: Record<number, DeliveryManifestView>;
  verificationRecords: VerificationRecordView[];
  acceptance?: AcceptanceView;
  /** S-06：commandId → 原结果摘要 + 命令指纹（指纹不同即 ID 复用，不是重试） */
  processedCommands: Record<string, { resultSummary: string; atVersion: number; fingerprint: string }>;
  reworkCount: number;
  cancelReason?: string;
}

export function initialAggregate(sessionId: string, tenantId = "self"): TaskSessionAggregate {
  return {
    sessionId,
    tenantId,
    state: "DRAFT",
    aggregateVersion: 0,
    requiredCriteria: [],
    attempts: [],
    deliveryRevision: 0,
    deliveries: {},
    verificationRecords: [],
    processedCommands: {},
    reworkCount: 0
  };
}

export interface ReduceResult {
  ok: boolean;
  aggregate: TaskSessionAggregate;
  events: EventEnvelope[];
  error?: PlatformError;
  /** true = 幂等重放，返回原结果，无新事件（S-06） */
  replayed?: boolean;
}

/* ------------------------------- 事件构造 ------------------------------- */

function buildEvent(
  agg: TaskSessionAggregate,
  eventType: EventType,
  cmd: CommandEnvelope,
  ctx: ReduceContext,
  payload: unknown,
  opts?: { policyDecisionId?: string; causationId?: string; commandFingerprint?: string }
): EventEnvelope {
  const version = agg.aggregateVersion + 1;
  // 可选字段缺省时不落键：信封是要被 Schema 校验与持久化的事实源（R3-7）。
  return {
    eventId: deterministicUuid("pi-agent.event", agg.sessionId, String(version)),
    eventType,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    occurredAt: ctx.now,
    tenantId: agg.tenantId,
    sessionId: agg.sessionId,
    ...(agg.currentAttemptId !== undefined ? { attemptId: agg.currentAttemptId } : {}),
    aggregateVersion: version,
    actor: cmd.actor,
    correlationId: ctx.correlationId,
    // W5/G7：事件必须能回答"哪条命令导致了我"，否则崩溃后重建不出幂等台账，
    // 同一 command_id 的重试会被当成新命令再执行一次。
    causationId: opts?.causationId ?? cmd.commandId,
    ...(opts?.commandFingerprint !== undefined ? { commandFingerprint: opts.commandFingerprint } : {}),
    idempotencyKey: cmd.idempotencyKey,
    ...(agg.planHash !== undefined ? { planHash: agg.planHash } : {}),
    ...(opts?.policyDecisionId !== undefined ? { policyDecisionId: opts.policyDecisionId } : {}),
    payload: payload as unknown as JsonValue,
    payloadHash: `sha256:${sha256Hex(canonicalJson(payload))}`
  };
}

function apply(agg: TaskSessionAggregate, event: EventEnvelope): TaskSessionAggregate {
  const next: TaskSessionAggregate = { ...agg, aggregateVersion: event.aggregateVersion };
  switch (event.eventType) {
    case "ContractDrafted": {
      const p = event.payload as { contractDigest: string; taskId: string };
      next.contractDigest = p.contractDigest;
      next.contractRevision = 0;
      next.state = "CONTRACTING";
      break;
    }
    case "ContractConfirmed":
      next.contractRevision = (event.payload as { contractRevision: number }).contractRevision;
      next.state = "READY";
      break;
    case "ContractRevised": {
      // ADR-0807：打回之后修订契约，状态不变（仍在 RUNNING）；计划随后重编译追上。
      const p = event.payload as { contractRevision: number; contractDigest: string };
      next.contractRevision = p.contractRevision;
      next.contractDigest = p.contractDigest;
      break;
    }
    case "PlanCompiled": {
      const p = event.payload as unknown as { planHash: string; pins: PlanPins; requiredCriteria: RequiredCriterion[] };
      next.planHash = p.planHash;
      next.pins = p.pins;
      next.requiredCriteria = p.requiredCriteria;
      break;
    }
    case "RuntimeStarted": {
      const p = event.payload as { attemptId: string };
      next.state = "RUNNING";
      next.currentAttemptId = p.attemptId;
      next.attempts = [...agg.attempts, { attemptId: p.attemptId, startedAt: event.occurredAt }];
      break;
    }
    case "Paused":
      next.state = "PAUSED";
      break;
    case "Resumed":
      next.state = "RUNNING";
      break;
    case "Cancelled":
      next.state = "CANCELLED";
      next.cancelReason = (event.payload as { reason?: string }).reason;
      next.attempts = agg.attempts.map((a) =>
        a.attemptId === agg.currentAttemptId ? { ...a, endedAt: event.occurredAt } : a
      );
      break;
    case "DeliveryProposed": {
      const p = event.payload as unknown as { manifest: DeliveryManifestView };
      next.state = "VERIFYING";
      next.deliveryRevision = p.manifest.deliveryRevision;
      next.deliveries = {
        ...agg.deliveries,
        [p.manifest.deliveryRevision]: p.manifest
      };
      next.currentAttemptId = agg.currentAttemptId;
      break;
    }
    case "VerificationRecorded": {
      const r = event.payload as unknown as VerificationRecordView;
      next.verificationRecords = [...agg.verificationRecords, r];
      break;
    }
    case "Delivered": {
      const p = event.payload as { deliveryRevision: number };
      next.state = "DELIVERED";
      next.deliveryRevision = p.deliveryRevision;
      break;
    }
    case "ReturnToRun":
      next.state = "RUNNING";
      break;
    case "RetryScheduled":
      // FAILED → READY（S-05：不直接回 RUNNING，由 Start 建新 attempt）。
      next.state = "READY";
      break;
    case "Accepted": {
      const a = event.payload as unknown as AcceptanceView;
      next.acceptance = a;
      next.state = "ACCEPTED";
      break;
    }
    case "CompletedDerived":
      next.state = "COMPLETED";
      break;
    case "PartiallyAccepted": {
      const a = event.payload as unknown as AcceptanceView;
      next.acceptance = a;
      next.state = "PARTIALLY_ACCEPTED";
      break;
    }
    case "ReworkRequested": {
      const a = event.payload as unknown as AcceptanceView & { newAttemptId: string };
      next.acceptance = a;
      next.state = "RUNNING";
      next.reworkCount = agg.reworkCount + 1;
      next.currentAttemptId = a.newAttemptId;
      next.attempts = [...agg.attempts, { attemptId: a.newAttemptId, startedAt: event.occurredAt }];
      break;
    }
    case "Rejected": {
      const a = event.payload as unknown as AcceptanceView & { newAttemptId: string };
      next.acceptance = a;
      // UC-023：REJECT 回到 RUNNING 继续迭代（非终态），新 attempt。
      next.state = "RUNNING";
      next.reworkCount = agg.reworkCount + 1;
      next.currentAttemptId = a.newAttemptId;
      next.attempts = [...agg.attempts, { attemptId: a.newAttemptId, startedAt: event.occurredAt }];
      break;
    }
    case "Archived":
      next.state = "ARCHIVED";
      break;
    case "ToolFailed": {
      const p = event.payload as { fatal?: boolean };
      if (p.fatal === true) {
        next.state = "FAILED";
        next.attempts = agg.attempts.map((a) =>
          a.attemptId === agg.currentAttemptId ? { ...a, endedAt: event.occurredAt } : a
        );
      }
      break;
    }
    default:
      // 执行观察类事件不改变状态（Progressed/PolicyDecided/ToolSucceeded/ArtifactCreated/...）
      break;
  }
  return next;
}

/** 契约已修订、计划还停在旧修订上（ADR-0807）。pins 缺失的旧数据不在此列。 */
function planBehindContract(agg: TaskSessionAggregate): boolean {
  return typeof agg.contractRevision === "number" && typeof agg.pins?.contract === "number" && agg.pins.contract < agg.contractRevision;
}

function fail(
  agg: TaskSessionAggregate,
  cmd: CommandEnvelope,
  error: PlatformError
): ReduceResult {
  return { ok: false, aggregate: agg, events: [], error };
}

/** 命令同一性指纹：类型 + 身份 + 载荷（幂等判定依据，R3-6）。 */
function commandFingerprint(cmd: CommandEnvelope): string {
  return sha256Hex(canonicalJson({
    commandType: cmd.commandType,
    actor: cmd.actor,
    payload: (cmd.payload ?? null) as JsonValue
  } as unknown as JsonValue));
}

function attemptIdFor(sessionId: string, n: number): string {
  return `att_${sha256Hex(`${sessionId}|attempt|${n}`).slice(0, 16)}`;
}

/* --------------------------- 副作用事件类型判定 --------------------------- */

const SIDE_EFFECT_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "ToolSucceeded",
  "ToolFailed",
  "ArtifactCreated",
  "WorkflowSucceeded",
  "WorkflowFailed"
]);

/**
 * 命令权限分级（评审第二轮 R2-A：统一命令权限）。
 * reducer 单点强制——任何入口（引擎、HTTP、测试直调）都不能以错误身份
 * 发出命令：SetBindingPlan 仅系统（编译器）、RecordRuntimeEvent 仅运行时。
 */
export const COMMAND_AUTHORITY: Record<CommandType, ReadonlySet<Actor["type"]>> = {
  SetBindingPlan: new Set(["system"]),
  RecordRuntimeEvent: new Set(["runtime"]),
  DraftContract: new Set(["user", "system"]),
  ConfirmContract: new Set(["user", "system"]),
  // ADR-0807：执行方（runtime/adapter）不能修订契约——Agent 不能改写自己的验收标准。
  ReviseContract: new Set(["user", "system"]),
  Start: new Set(["user", "system"]),
  Pause: new Set(["user", "system"]),
  Resume: new Set(["user", "system"]),
  Cancel: new Set(["user", "system"]),
  Fail: new Set(["user", "system"]),
  Retry: new Set(["user", "system"]),
  Close: new Set(["user", "system"]),
  ProposeDelivery: new Set(["user", "system"]),
  RecordVerification: new Set(["system"]),
  ReturnToRun: new Set(["user", "system"]),
  Deliver: new Set(["user", "system"]),
  Accept: new Set(["user", "system"]),
  PartialAccept: new Set(["user", "system"]),
  Rework: new Set(["user", "system"]),
  Reject: new Set(["user", "system"]),
  Archive: new Set(["user", "system"])
};

/**
 * RecordRuntimeEvent 入口的事件白名单：只有运行时观察事件可以经此落账。
 * 状态迁移事件（CompletedDerived/Accepted/PlanCompiled/Delivered 等）只能由
 * 受控命令派生——堵住"运行时事件直接宣告完成"的注入路径。
 */
export const OBSERVABLE_RUNTIME_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "Progressed",
  "ToolRequested",
  "PolicyDecided",
  "ToolSucceeded",
  "ToolFailed",
  "WorkflowStarted",
  "WorkflowWaiting",
  "WorkflowSucceeded",
  "WorkflowFailed",
  "ArtifactCreated"
]);

/* --------------------------------- Reducer --------------------------------- */

export function reduce(
  agg: TaskSessionAggregate,
  cmd: CommandEnvelope,
  ctx: ReduceContext
): ReduceResult {
  // 命令权限分级（R2-A）：身份校验先于一切——包括幂等短路。
  // R3-6：否则越权命令只要复用一个已处理的 commandId 就会被报告为成功。
  if (!COMMAND_AUTHORITY[cmd.commandType]?.has(cmd.actor.type)) {
    return fail(
      agg,
      cmd,
      new PlatformError(
        "COMMAND_UNAUTHORIZED",
        `身份 ${cmd.actor.type} 无权发出命令 ${cmd.commandType}（要求 ${[...(COMMAND_AUTHORITY[cmd.commandType] ?? [])].join("/")}）`
      )
    );
  }

  // S-06：同 command_id 最多生效一次——重复请求返回原结果，不产生第二次状态变化。
  // R3-6：幂等必须绑定命令同一性（类型 + 身份 + 载荷）；同 ID 换内容是 ID 复用，不是重试。
  const fingerprint = commandFingerprint(cmd);
  const prior = agg.processedCommands[cmd.commandId];
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) {
      return fail(
        agg,
        cmd,
        new PlatformError(
          "COMMAND_ID_REUSED",
          `commandId ${cmd.commandId} 已用于另一条命令（${prior.resultSummary}），拒绝按重试处理`
        )
      );
    }
    return { ok: true, aggregate: agg, events: [], replayed: true };
  }

  // 乐观并发控制（ADR-0602）：不匹配返回 409 语义错误，不自动覆盖。
  if (cmd.expectedVersion !== agg.aggregateVersion) {
    return fail(
      agg,
      cmd,
      new PlatformError(
        "VERSION_CONFLICT",
        `expectedVersion ${cmd.expectedVersion} 与当前 ${agg.aggregateVersion} 不符（会话 ${agg.sessionId} 状态 ${agg.state}）`,
        { details: { currentVersion: agg.aggregateVersion, state: agg.state } }
      )
    );
  }

  const attemptNumber = agg.attempts.length + 1;

  const emit = (eventType: EventType, payload: unknown, opts?: { policyDecisionId?: string }): ReduceResult => {
    const event = buildEvent(agg, eventType, cmd, ctx, payload, { ...opts, commandFingerprint: fingerprint });
    return { ok: true, aggregate: apply(agg, event), events: [event] };
  };

  const markProcessed = (r: ReduceResult, resultSummary: string): ReduceResult => {
    const agg2 = r.aggregate;
    const processed: TaskSessionAggregate["processedCommands"] = { ...agg2.processedCommands };
    processed[cmd.commandId] = {
      resultSummary,
      atVersion: r.events.length > 0 ? r.events[r.events.length - 1].aggregateVersion : agg2.aggregateVersion,
      fingerprint
    };
    return { ...r, aggregate: { ...agg2, processedCommands: processed } };
  };

  switch (cmd.commandType) {
    case "DraftContract": {
      if (agg.state !== "DRAFT") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `DraftContract 要求 DRAFT，当前 ${agg.state}`));
      }
      const p = cmd.payload as { contractDigest: string; taskId: string };
      if (!p?.contractDigest?.startsWith("sha256:") || !p?.taskId) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "DraftContract 需要 contractDigest 与 taskId"));
      }
      const r = emit("ContractDrafted", { contractDigest: p.contractDigest, taskId: p.taskId });
      return markProcessed(r, "contract drafted");
    }

    case "ConfirmContract": {
      if (agg.state !== "CONTRACTING") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `ConfirmContract 要求 CONTRACTING（先 DraftContract），当前 ${agg.state}`));
      }
      const p = cmd.payload as { contractRevision: number; contractDigest?: string };
      if (typeof p?.contractRevision !== "number" || p.contractRevision < 1) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "ConfirmContract 需要 contractRevision ≥ 1（Contract 完整）"));
      }
      // 冻结的必须是 DRAFTING 阶段登记的那份契约（防确认时偷换内容）。
      if (p.contractDigest !== undefined && agg.contractDigest !== undefined && p.contractDigest !== agg.contractDigest) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "ConfirmContract 的契约内容与 DraftContract 登记的不一致"));
      }
      const r = emit("ContractConfirmed", { contractRevision: p.contractRevision });
      return markProcessed(r, `contract@${p.contractRevision}`);
    }

    case "SetBindingPlan": {
      // 运行中唯一允许换计划的情形：契约刚被修订（ADR-0807），计划要追上它。
      // 除此之外换计划等于中途改授权，一律拒绝。
      const catchingUp = agg.state === "RUNNING" && planBehindContract(agg);
      if (agg.state !== "READY" && !catchingUp) {
        return fail(agg, cmd, new PlatformError(
          "STATE_INVALID_TRANSITION",
          agg.state === "RUNNING"
            ? "运行中只能为刚修订的契约重编译计划（ADR-0807），不能中途更换计划"
            : `SetBindingPlan 要求 READY（先确认 Contract），当前 ${agg.state}`
        ));
      }
      const p = cmd.payload as unknown as { planHash: string; pins: PlanPins; requiredCriteria: RequiredCriterion[] };
      if (catchingUp && p?.pins?.contract !== agg.contractRevision) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", `重编译必须基于最新修订的契约（第 ${agg.contractRevision} 版）`));
      }
      if (!p?.planHash?.startsWith("sha256:")) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "SetBindingPlan 需要内容寻址 planHash"));
      }
      if (!p.pins?.agent || !p.pins?.contract) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "SetBindingPlan 需要 agent 与 contract 的精确 pins"));
      }
      const r = emit("PlanCompiled", { planHash: p.planHash, pins: p.pins, requiredCriteria: p.requiredCriteria ?? [] });
      return markProcessed(r, `plan ${p.planHash.slice(0, 18)}…`);
    }

    case "ReviseContract": {
      // ADR-0807：只能在「当前这一版交付刚被打回、新交付还没提出」时修订。
      if (agg.state !== "RUNNING") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `ReviseContract 要求打回之后的 RUNNING，当前 ${agg.state}`));
      }
      const acc = agg.acceptance;
      if (!acc || (acc.decision !== "REJECT" && acc.decision !== "REWORK") || acc.deliveryRevision !== agg.deliveryRevision) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "只有当前这一版交付被打回之后、新交付提出之前才能修订契约"));
      }
      const p = cmd.payload as { contractRevision?: unknown; contractDigest?: unknown };
      const expected = (agg.contractRevision ?? 0) + 1;
      if (p?.contractRevision !== expected) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", `契约修订号必须是 ${expected}（严格递增）`));
      }
      if (typeof p.contractDigest !== "string" || !p.contractDigest.startsWith("sha256:")) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "ReviseContract 需要修订后契约的内容摘要"));
      }
      const r = emit("ContractRevised", {
        contractRevision: expected,
        contractDigest: p.contractDigest,
        basedOnAcceptanceId: acc.acceptanceId,
        basedOnDeliveryRevision: acc.deliveryRevision
      });
      return markProcessed(r, `contract@${expected} revised`);
    }

    case "Start": {
      if (agg.state !== "READY") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `Start 要求 READY，当前 ${agg.state}`));
      }
      // S-01：RUNNING 前必须存在 plan_hash 与所有 pins。
      if (!agg.planHash || !agg.pins?.agent || !agg.pins?.contract) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "S-01：缺少 plan_hash 或 pins，拒绝 Start"));
      }
      const r = emit("RuntimeStarted", { attemptId: attemptIdFor(agg.sessionId, attemptNumber) });
      return markProcessed(r, `attempt #${attemptNumber}`);
    }

    case "Pause": {
      if (agg.state !== "RUNNING") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `Pause 要求 RUNNING，当前 ${agg.state}`));
      }
      const reason = (cmd.payload as { reason?: string })?.reason;
      if (!reason) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "Pause 必须携带暂停原因"));
      }
      const r = emit("Paused", { reason });
      return markProcessed(r, "paused");
    }

    case "Resume": {
      if (agg.state !== "PAUSED") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `Resume 要求 PAUSED，当前 ${agg.state}`));
      }
      if ((cmd.payload as { resolved?: boolean })?.resolved !== true) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "暂停原因未解除，拒绝 Resume"));
      }
      const r = emit("Resumed", {});
      return markProcessed(r, "resumed");
    }

    case "Cancel": {
      if (!["DRAFT", "CONTRACTING", "READY", "RUNNING", "PAUSED", "FAILED"].includes(agg.state)) {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `不允许从 ${agg.state} 取消`));
      }
      const reason = (cmd.payload as { reason?: string })?.reason ?? "cancelled by operator";
      const r = emit("Cancelled", { reason });
      return markProcessed(r, "cancelled");
    }

    case "Fail": {
      if (!["RUNNING", "PAUSED", "VERIFYING"].includes(agg.state)) {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `不允许从 ${agg.state} 标记失败`));
      }
      const p = cmd.payload as { policyDecisionId?: string; reason?: string };
      const r = emit("ToolFailed", { fatal: true, reason: p?.reason ?? "runtime failure" }, { policyDecisionId: p?.policyDecisionId });
      return markProcessed(r, "failed");
    }

    case "Retry": {
      if (agg.state !== "FAILED") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `Retry 要求 FAILED，当前 ${agg.state}`));
      }
      // FAILED → READY；S-05 满足（未回到 RUNNING，而是重新走 Start 创建新 attempt）。
      // R3-4：状态迁移必须落在事件事实源上，否则重放得到的状态与活动会话分歧。
      const r = emit("RetryScheduled", { reason: (cmd.payload as { reason?: string })?.reason ?? "retry after failure" });
      return markProcessed(r, "retry-scheduled");
    }

    case "Close": {
      if (agg.state !== "FAILED") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `Close 要求 FAILED，当前 ${agg.state}`));
      }
      const r = emit("Cancelled", { reason: "closed after failure" });
      return markProcessed(r, "closed");
    }

    case "ProposeDelivery": {
      if (agg.state !== "RUNNING") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `ProposeDelivery 要求 RUNNING，当前 ${agg.state}`));
      }
      // ADR-0807：交付永远按最新契约验收——契约修订了而计划还没追上，就不许交付。
      if (planBehindContract(agg)) {
        return fail(agg, cmd, new PlatformError(
          "GUARD_FAILED",
          `契约已修订到第 ${agg.contractRevision} 版，交付前必须按新契约重编译计划`
        ));
      }
      const manifest = (cmd.payload as unknown as { manifest: DeliveryManifestView })?.manifest;
      if (!manifest?.files || manifest.files.length < 1) {
        return fail(agg, cmd, new PlatformError("EVIDENCE_MISSING", "S-03：交付清单缺少制品文件，拒绝 DeliveryProposed"));
      }
      // R2-H：交付清单必须绑定当前编译计划，防止跨计划交付漂移。
      if (!manifest.sourcePlanHash || manifest.sourcePlanHash !== agg.planHash) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "交付清单的 sourcePlanHash 与会话 planHash 不一致，拒绝交付"));
      }
      // 「没有 Evidence 的 DeliveryProposed 必须被拒绝」（09 计划 §5 必须失败测试 5）。
      if (!manifest.evidenceBundle || manifest.evidenceBundle.length < 1) {
        return fail(agg, cmd, new PlatformError("EVIDENCE_MISSING", "交付缺少 evidenceBundle，拒绝 DeliveryProposed"));
      }
      const revision = agg.deliveryRevision + 1;
      const manifestWithRev: DeliveryManifestView = { ...manifest, deliveryRevision: revision };
      const r = emit("DeliveryProposed", { manifest: manifestWithRev });
      return markProcessed(r, `delivery revision ${revision} proposed`);
    }

    case "RecordVerification": {
      if (agg.state !== "VERIFYING") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `RecordVerification 要求 VERIFYING，当前 ${agg.state}`));
      }
      const record = (cmd.payload as unknown as { record: VerificationRecordView })?.record;
      if (!record?.criterionId || !record.artifactHash?.startsWith("sha256:")) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "VerificationRecord 必须绑定 criterionId 与 artifact hash"));
      }
      if (!record.evidenceRefs || record.evidenceRefs.length < 1) {
        return fail(agg, cmd, new PlatformError("EVIDENCE_MISSING", "VerificationRecord 缺少证据引用"));
      }
      // 验证记录必须对应当前交付 revision；旧 revision 拒绝且不自动改写。
      if (record.deliveryRevision !== agg.deliveryRevision) {
        return fail(
          agg,
          cmd,
          new PlatformError(
            "GUARD_FAILED",
            `VerificationRecord 的 revision ${record.deliveryRevision} 与当前交付 ${agg.deliveryRevision} 不符，拒绝记录`
          )
        );
      }
      if (record.planHash !== undefined && record.planHash !== agg.planHash) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", `VerificationRecord 的 planHash 与会话计划不一致`));
      }
      // v2.2：同一交付版本已有程序检查结果时，只接受同一检查套件补丁版本的重验（只修误判、不改判定标准）
      if (record.evaluator === undefined || record.evaluator === "rule") {
        const prior = [...agg.verificationRecords].reverse().find((r) => r.criterionId === record.criterionId && r.deliveryRevision === record.deliveryRevision && (r.evaluator === undefined || r.evaluator === "rule"));
        if (prior && !isCheckerPatch(prior.checkerVersion, record.checkerVersion)) {
          return fail(agg, cmd, new PlatformError("GUARD_FAILED",
            `${record.criterionId} 在本次交付已有程序检查结果；只能用同一检查套件的补丁版本重验（${prior.checkerVersion ?? "无版本"} → ${record.checkerVersion ?? "无版本"}）`));
        }
      }
      // v2.0 S3：语义验收只补语义条件上规则验证器给出的「等待语义验收」，每个交付版本只判一次
      if (record.evaluator === "semantic") {
        const criterion = agg.requiredCriteria.find((c) => c.criterionId === record.criterionId);
        if (!criterion || !isSemanticCriterion(criterion)) {
          return fail(agg, cmd, new PlatformError("GUARD_FAILED", `${record.criterionId} 不是语义验收条件，不能语义判定`));
        }
        const current = effectiveRecord(agg, record.criterionId, record.deliveryRevision);
        if (!current || (current.evaluator !== undefined && current.evaluator !== "rule") || current.result !== "INCONCLUSIVE") {
          return fail(agg, cmd, new PlatformError("GUARD_FAILED", `${record.criterionId} 在本次交付已有结论，不能再语义判定`));
        }
      }
      // v2.0 S1：人工判定只补「等待人工判定」，不覆盖机器结论，也不能判机器条件；S3 起也可以判语义验收判不了的条件
      if (record.evaluator === "human") {
        const criterion = agg.requiredCriteria.find((c) => c.criterionId === record.criterionId);
        if (!criterion || !(isHumanCriterion(criterion) || isSemanticCriterion(criterion))) {
          return fail(agg, cmd, new PlatformError("GUARD_FAILED", `${record.criterionId} 不是人工判定条件，不能人工判定`));
        }
        const current = effectiveRecord(agg, record.criterionId, record.deliveryRevision);
        if (current?.result !== "INCONCLUSIVE") {
          return fail(agg, cmd, new PlatformError(
            "GUARD_FAILED",
            current ? `${record.criterionId} 在本次交付已有结论 ${current.result}，不能再判` : `${record.criterionId} 还没有本次交付的验证记录，不能先判`
          ));
        }
        if (record.result === "INCONCLUSIVE") {
          return fail(agg, cmd, new PlatformError("GUARD_FAILED", "人工判定只能是 PASS 或 FAIL"));
        }
      }
      const r = emit("VerificationRecorded", { ...record });
      return markProcessed(r, `${record.criterionId}=${record.result}`);
    }

    case "ReturnToRun": {
      if (agg.state !== "VERIFYING") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `ReturnToRun 要求 VERIFYING，当前 ${agg.state}`));
      }
      // v2.0 S3d：整改请求随事件入账（要求编号、未满足之处、证据位置、不可改变的约束），回放与审计据此追溯
      const p = cmd.payload as { reason?: string; repair?: JsonValue };
      const r = emit("ReturnToRun", { reason: p?.reason ?? "verification failed", ...(p?.repair !== undefined ? { repair: p.repair } : {}) });
      return markProcessed(r, "returned to run");
    }

    case "Deliver": {
      if (agg.state !== "VERIFYING") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `Deliver 要求 VERIFYING，当前 ${agg.state}`));
      }
      const manifest = agg.deliveries[agg.deliveryRevision];
      if (!manifest) {
        return fail(agg, cmd, new PlatformError("ARTIFACT_MISSING", "当前 revision 无交付清单"));
      }
      // S-03：DELIVERED 必须有 artifact manifest 与 verification summary（全部必须条件 PASS）。
      const missing = requiredUnmet(agg);
      if (missing.length > 0) {
        return fail(
          agg,
          cmd,
          new PlatformError(
            "EVIDENCE_MISSING",
            `S-03：完成门禁未满足（${missing.join("; ")}），拒绝交付`
          )
        );
      }
      const r = emit("Delivered", { deliveryRevision: agg.deliveryRevision });
      return markProcessed(r, `delivered revision ${agg.deliveryRevision}`);
    }

    case "Accept":
    case "PartialAccept":
    case "Rework":
    case "Reject": {
      if (agg.state !== "DELIVERED") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `${cmd.commandType} 要求 DELIVERED，当前 ${agg.state}`));
      }
      const record = cmd.payload as unknown as AcceptanceView;
      if (!record?.decision || !record.signer?.userId || !record.decidedAt) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "AcceptanceRecord 缺少 decision/signer/decidedAt"));
      }
      // 「AcceptanceRecord 不对应当前 delivery_revision 时，任务不得完成」。
      if (record.deliveryRevision !== agg.deliveryRevision) {
        return fail(
          agg,
          cmd,
          new PlatformError(
            "ACCEPTANCE_REVISION_MISMATCH",
            `验收对象 revision ${record.deliveryRevision} 与当前交付 ${agg.deliveryRevision} 不符`
          )
        );
      }
      const expectedDecision =
        cmd.commandType === "Accept" ? "ACCEPT" :
        cmd.commandType === "PartialAccept" ? "PARTIAL_ACCEPT" :
        cmd.commandType === "Rework" ? "REWORK" : "REJECT";
      if (record.decision !== expectedDecision) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", `命令 ${cmd.commandType} 要求 decision=${expectedDecision}`));
      }
      if (cmd.commandType === "PartialAccept" && (!record.acceptedSubset || record.acceptedSubset.length === 0)) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "PARTIAL_ACCEPT 必须给出接受的明确子集"));
      }

      if (cmd.commandType === "Accept") {
        // ACCEPT → ACCEPTED，随后派生 COMPLETED（S-04：无直接命令）。
        const acc = buildEvent(agg, "Accepted", cmd, ctx, record as unknown as JsonValue, { commandFingerprint: fingerprint });
        const afterAccept = apply(agg, acc);
        const derived = buildEvent(afterAccept, "CompletedDerived", cmd, ctx, {
          derivedFrom: "Accepted",
          acceptanceId: record.acceptanceId,
          deliveryRevision: record.deliveryRevision
        }, { commandFingerprint: fingerprint });
        const done = { ok: true as const, aggregate: apply(afterAccept, derived), events: [acc, derived] };
        return markProcessed(done, "completed");
      }
      if (cmd.commandType === "PartialAccept") {
        const r = emit("PartiallyAccepted", record as unknown as JsonValue);
        return markProcessed(r, "partially accepted");
      }
      if (cmd.commandType === "Rework" || cmd.commandType === "Reject") {
        // UC-020/023：REWORK 与 REJECT 都回到 RUNNING 继续迭代；
        // 新 attempt；下一次交付将生成新 delivery_revision。REJECT 必须带 reason。
        if (cmd.commandType === "Reject" && !record.findings?.length && !(record as AcceptanceView & { reason?: string }).reason) {
          return fail(agg, cmd, new PlatformError("GUARD_FAILED", "REJECT 必须携带拒绝原因（findings/reason）"));
        }
        const newAttempt = attemptIdFor(agg.sessionId, attemptNumber);
        const payload = { ...record, newAttemptId: newAttempt, ...(cmd.commandType === "Reject" ? { rejected: true } : {}) };
        const r = emit(cmd.commandType === "Rework" ? "ReworkRequested" : "Rejected", payload);
        return markProcessed(r, cmd.commandType === "Rework" ? "rework" : "reject → revision");
      }
      return fail(agg, cmd, new PlatformError("GUARD_FAILED", `未知验收命令 ${cmd.commandType}`));
    }

    case "Archive": {
      // ACCEPTED 立即派生 COMPLETED（S-04）；归档允许在派生前后的两个状态。
      if (agg.state !== "ACCEPTED" && agg.state !== "COMPLETED") {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `Archive 要求 ACCEPTED/COMPLETED，当前 ${agg.state}`));
      }
      const r = emit("Archived", {});
      return markProcessed(r, "archived");
    }

    case "RecordRuntimeEvent": {
      // 执行观察类事件：状态机不迁移（fatal ToolFailed 除外），但强制 S-02。
      const p = cmd.payload as unknown as { eventType: EventType; payload?: unknown; policyDecisionId?: string };
      const runtimeStates: SessionState[] = ["RUNNING", "PAUSED", "VERIFYING"];
      if (!runtimeStates.includes(agg.state)) {
        return fail(agg, cmd, new PlatformError("STATE_INVALID_TRANSITION", `状态 ${agg.state} 不接受运行时事件 ${p?.eventType}`));
      }
      if (!p?.eventType) {
        return fail(agg, cmd, new PlatformError("GUARD_FAILED", "RecordRuntimeEvent 需要 eventType"));
      }
      // 运行时入口只接受观察事件白名单；内部状态事件（CompletedDerived、
      // Accepted、PlanCompiled 等）只能由受控命令派生，防止注入完成。
      if (!OBSERVABLE_RUNTIME_EVENTS.has(p.eventType)) {
        return fail(
          agg,
          cmd,
          new PlatformError(
            "STATE_INVALID_TRANSITION",
            `运行时事件入口不接受内部状态事件 ${p.eventType}（只允许 ${[...OBSERVABLE_RUNTIME_EVENTS].join("/")}）`
          )
        );
      }
      if (SIDE_EFFECT_EVENTS.has(p.eventType) && !p.policyDecisionId) {
        // S-02：任何副作用事件必须引用 policy_decision_id。
        return fail(agg, cmd, new PlatformError("POLICY_FAIL_CLOSED", `S-02：副作用事件 ${p.eventType} 缺少 policy_decision_id，已隔离`));
      }
      const r = emit(p.eventType, p.payload ?? {}, { policyDecisionId: p.policyDecisionId });
      return markProcessed(r, `event ${p.eventType}`);
    }

    default: {
      const exhaustive: never = cmd.commandType;
      return fail(agg, cmd, new PlatformError("GUARD_FAILED", `未知命令 ${(exhaustive as string)}`));
    }
  }
}

/**
 * 交付/完成门禁的唯一实现（S-03 / completion_gate，fix-8 统一）。
 * 状态机 Deliver 与独立评估入口都走这一套强校验：
 * - 交付清单存在且 complete
 * - 每条必须条件：当前 revision 的 PASS 记录
 * - 记录绑定 artifact hash 且该 hash 必须出现在交付清单中（hash 关联）
 * - 证据引用非空；planHash（提供时）与会话计划一致
 */
export function requiredUnmet(agg: TaskSessionAggregate): string[] {
  const unmet: string[] = [];
  const manifest = agg.deliveries[agg.deliveryRevision];
  if (!manifest) {
    unmet.push(`交付 revision ${agg.deliveryRevision} 缺失`);
    return unmet;
  }
  if (manifest.complete !== true) unmet.push("delivery.complete = false");
  if (manifest.sourcePlanHash !== agg.planHash) unmet.push("交付清单 sourcePlanHash 与会话计划不一致");
  const manifestHashes = new Set(manifest.files.map((f) => f.sha256));
  for (const c of agg.requiredCriteria) {
    if (!c.required) continue;
    const rec = effectiveRecord(agg, c.criterionId, agg.deliveryRevision);
    if (!rec) {
      unmet.push(`${c.criterionId} 无验证记录`);
      continue;
    }
    if (rec.result !== "PASS") {
      unmet.push(`${c.criterionId} 结果 ${rec.result}`);
      continue;
    }
    if (!rec.artifactHash.startsWith("sha256:")) {
      unmet.push(`${c.criterionId} 未绑定 artifact hash`);
      continue;
    }
    if (!manifestHashes.has(rec.artifactHash)) {
      unmet.push(`${c.criterionId} 的验证 hash 不在交付清单中（hash 无关联）`);
    }
    if (rec.evidenceRefs.length < 1) {
      unmet.push(`${c.criterionId} 缺少证据引用`);
    }
    if (rec.planHash !== undefined && agg.planHash !== undefined && rec.planHash !== agg.planHash) {
      unmet.push(`${c.criterionId} 的验证来源 planHash 与会话计划不一致`);
    }
  }
  return unmet;
}


/**
 * 按事件流重放出聚合（W5 恢复 / G7）。
 *
 * 纯函数：同一串事件永远得到同一个聚合。除了状态本身，还重建**幂等台账**
 * ——事件携带 causationId 与 commandFingerprint，因此崩溃恢复后再次收到
 * 同一条命令仍然会被识别为重试（返回原结果），而不是执行第二次。
 * `resultSummary` 无法从事件还原，标记为 recovered；它只用于错误信息。
 */
export function replayAggregate(
  sessionId: string,
  events: readonly EventEnvelope[],
  tenantId = "self"
): TaskSessionAggregate {
  let agg = initialAggregate(sessionId, tenantId);
  const processed: TaskSessionAggregate["processedCommands"] = {};
  for (const event of [...events].sort((a, b) => a.aggregateVersion - b.aggregateVersion)) {
    agg = apply(agg, event);
    if (event.causationId !== undefined) {
      processed[event.causationId] = {
        resultSummary: "recovered",
        atVersion: event.aggregateVersion,
        fingerprint: event.commandFingerprint ?? ""
      };
    }
  }
  return { ...agg, processedCommands: processed };
}

/**
 * 单条事件的演化（纯函数，与 replayAggregate 同一套规则）。
 * 供只读回放逐步重建任意时刻的聚合状态（v1.9）；不做幂等台账。
 */
export const applyEvent = (agg: TaskSessionAggregate, event: EventEnvelope): TaskSessionAggregate => apply(agg, event);
