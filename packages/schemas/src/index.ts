import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface SchemaNameToId {
  "project-stage-artifact": string;
  "project-task-evaluation": string;
  "project-evaluation": string;
  "project-event-v2": string;
  "project-record-v3": string;
  "agent-definition": string;
  "task-contract": string;
  "workflow-definition": string;
  "binding-plan": string;
  "policy": string;
  "event-envelope": string;
  "verification-record": string;
  "delivery-manifest": string;
  "acceptance-record": string;
  /** v2.1 调研需求（调研类执行 Agent 的需求 schema） */
  "research-brief": string;
  /** v2.1 调研报告（调研类执行 Agent 的交付物 schema） */
  "research-report": string;
  /** v2.2 通用需求规格（非调研类任务） */
  "generic-brief": string;
  /** HTML 演示稿（presentation-html-brief@2）：任务创建时定设计系统，调研完成后填幻灯片 */
  "presentation-html-brief": string;
  "presentation-ir": string;
  "slide-intent": string;
  "slide-plan": string;
  "slide-evaluation": string;
  /** v2.6：PPT 子任务冻结的设计要求（presentation-html-brief@3，需求 schema） */
  "presentation-html-brief-v3": string;
  /** v2.6：PPT 子任务的主交付——整套逐页计划（presentation-plan@1，每页为 slide-plan@2） */
  "presentation-plan": string;
  /** v2.6：宿主浏览器渲染与几何检查的结果（render-manifest@1） */
  "render-manifest": string;
  /** v2.6：视觉审阅结果（visual-review@1），绑定 HTML 与逐页截图 */
  "visual-review": string;
  /** V3.0：AgentDefinition v2（agent.platform/v2，运行时绑定） */
  "agent-definition-v2": string;
  /** V3.0：项目主 Agent 的结构化建议（project-coordination@1） */
  "project-coordination": string;
  /** V3.0：任务交接包（project-handoff@1） */
  "project-handoff": string;
  /** V3.0：项目事件（project-event@1） */
  "project-event": string;
  /** V3.0：通用项目记录（ProjectRecord version=2） */
  "project-record-v2": string;
}

export type SchemaName = keyof SchemaNameToId;

export const SCHEMA_NAMES: SchemaName[] = [
  "agent-definition",
  "task-contract",
  "workflow-definition",
  "binding-plan",
  "policy",
  "event-envelope",
  "verification-record",
  "delivery-manifest",
  "acceptance-record",
  "research-brief",
  "research-report",
  "generic-brief",
  "presentation-html-brief",
  "presentation-ir",
  "slide-intent",
  "slide-plan",
  "slide-evaluation",
  "presentation-html-brief-v3",
  "presentation-plan",
  "render-manifest",
  "visual-review",
  "agent-definition-v2",
  "project-coordination",
  "project-handoff",
  "project-event",
  "project-record-v2",
  "project-stage-artifact",
  "project-task-evaluation",
  "project-evaluation",
  "project-event-v2",
  "project-record-v3"
];

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../schemas");

/**
 * v2.2 平台注册的需求 schema 与交付规格：Agent 的 taskInterfaces 只能引用这里登记的版本，
 * 合约的 spec.requirement.payload 按对应 schema 校验。版本一经登记不得做不兼容修改，改动须登记新版本。
 */
import { validateSelectableModels } from "./model-catalog.js";
export * from "./model-catalog.js";
import { SKILL_REFS } from "./skill-catalog.js";
export * from "./skill-catalog.js";

export const REQUIREMENT_SCHEMAS: Record<string, SchemaName> = { "research-brief@1": "research-brief", "generic-brief@1": "generic-brief", "presentation-html-brief@3": "presentation-html-brief-v3" };
export const DELIVERY_SPECS: Record<string, SchemaName> = { "research-report@1": "research-report", "presentation-html-brief@2": "presentation-html-brief", "presentation-plan@1": "presentation-plan" };

export function loadSchemaJson(name: SchemaName): JsonValue {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), "utf8")) as JsonValue;
}

export interface ValidationResult {
  ok: boolean;
  /** 结构校验错误，形如 "/spec/goal 必须提供" 风格的字段路径 + 消息 */
  errors: string[];
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    // required 错误的路径应指向缺失字段本身（/spec/identity/mission 必须提供）
    if (e.keyword === "required" && typeof e.params?.missingProperty === "string") {
      return `${e.instancePath || ""}/${e.params.missingProperty} 必须提供`;
    }
    // additionalProperties 错误指向未知字段本身（/secretSauce 是未知字段）
    if (e.keyword === "additionalProperties" && typeof e.params?.additionalProperty === "string") {
      return `${e.instancePath || ""}/${e.params.additionalProperty} 是未知字段（核心模型拒绝 x-* 之外的扩展）`;
    }
    return `${e.instancePath || "/"} ${e.message ?? "invalid"}`;
  });
}

/**
 * Schema 注册表（AP-SCHEMA-002 §Schema 发布门：Meta-schema 自校验通过）。
 * 所有 Schema 在构造时编译；任何 Schema 本身不合法会在启动时立即失败。
 */
export class SchemaRegistry {
  private readonly ajv: Ajv2020;
  private readonly validators = new Map<SchemaName, ReturnType<Ajv2020["compile"]>>();

  constructor() {
    this.ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
    addFormats(this.ajv);
    for (const name of SCHEMA_NAMES) {
      const schemaJson = loadSchemaJson(name) as object;
      const validate = this.ajv.compile(schemaJson);
      this.validators.set(name, validate);
    }
  }

  validate(name: SchemaName, value: unknown): ValidationResult {
    const validate = this.validators.get(name);
    if (!validate) throw new Error(`unknown schema: ${name}`);
    const ok = validate(value);
    return ok ? { ok: true, errors: [] } : { ok: false, errors: formatErrors(validate.errors) };
  }

  validateOrThrow(name: SchemaName, value: unknown): void {
    const result = this.validate(name, value);
    if (!result.ok) {
      const err = new Error(`SCHEMA_INVALID(${name}): ${result.errors.join("; ")}`);
      (err as Error & { code?: string }).code = "SCHEMA_INVALID";
      throw err;
    }
  }
}

/* ------------------------- 语义校验（跨字段规则，ADR-0102） ------------------------- */

interface AgentDefinitionLike {
  metadata: { id: string; version: string; status: string };
  spec: {
    capabilities: {
      skills?: string[];
      workflows?: Array<{ ref: string }>;
      tools?: Array<{ ref: string }>;
    };
    principles: Array<{ priority: number }>;
    constraints?: { network?: { default?: string; allow?: string[] } };
  };
}

/** AgentDefinition 结构合法后的语义检查：priority 唯一、引用格式可解析。 */
export function validateAgentDefinitionSemantics(value: unknown): ValidationResult {
  const errors: string[] = [];
  const def = value as AgentDefinitionLike;
  for (const [i, ref] of (def.spec.capabilities.skills ?? []).entries()) {
    if (!SKILL_REFS.includes(ref as typeof SKILL_REFS[number])) errors.push(`/spec/capabilities/skills/${i} ${ref} 不是平台注册的 Skill`);
  }
  const priorities = new Set<number>();
  for (const [i, p] of def.spec.principles.entries()) {
    if (priorities.has(p.priority)) {
      errors.push(`/spec/principles/${i}/priority 冲突：priority 必须唯一，但 ${p.priority} 重复`);
    }
    priorities.add(p.priority);
  }
  // v2.4：执行模型候选只能来自平台模型目录；默认项在集合内；不与 fallback 并存
  errors.push(...validateSelectableModels(value));
  // v2.2：任务接口只能引用平台已注册的需求 schema 与交付规格
  const ifaces = (value as { spec?: { taskInterfaces?: Array<{ requirementSchemaRef: string; deliverySpecRef: string }> } }).spec?.taskInterfaces ?? [];
  for (const [i, t] of ifaces.entries()) {
    if (!REQUIREMENT_SCHEMAS[t.requirementSchemaRef]) errors.push(`/spec/taskInterfaces/${i}/requirementSchemaRef ${t.requirementSchemaRef} 不是平台注册的需求 schema`);
    if (!DELIVERY_SPECS[t.deliverySpecRef]) errors.push(`/spec/taskInterfaces/${i}/deliverySpecRef ${t.deliverySpecRef} 不是平台注册的交付规格`);
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

interface RuleSpecLike {
  kind?: string;
  value?: string;
  operator?: string;
  threshold?: number;
  pathPrefix?: string;
}

interface TaskContractLike {
  metadata: { taskId: string; revision: number; status: string };
  spec: {
    requirements?: Array<{ id?: string; statement: string; kind?: string; origin?: string; decision?: string; obligation?: string }>;
    acceptanceAgreements?: Array<{ id: string; requirementIds: string[]; evaluatorKind: string }>;
    acceptanceCriteria: Array<{
      id: string;
      evaluator: string;
      expected: string;
      rule?: RuleSpecLike & { agreementId?: string; spec?: string };
      required?: boolean;
      requirementIds?: string[];
    }>;
    verificationPlan: { criteria: Array<{ criterionId: string; evaluatorRef?: string; required?: boolean }> };
  };
}

/**
 * 可作终判的评估器：确定性的 rule/test，以及 v2.0 S1 起的 human。
 * human 只能与 humanJudgement 规则配对（双向）：人判的是机器判不了的要求，不能借此覆盖机器规则；
 * 机器规则也不能挂在 human 名下。llm-judge/composite 仍明确拒绝（fix-5）。
 */
export const SUPPORTED_CONTRACT_EVALUATORS: ReadonlySet<string> = new Set(["rule", "test", "human", "semantic"]);

let briefRegistry: SchemaRegistry | undefined;

/** TaskContract 语义检查（fix-5 强化）：
 * 1. 验收条件 id 唯一；
 * 2. verificationPlan 引用存在的 AC；
 * 3. 每个 required 条件必须有可执行 rule；
 * 4. evaluator 必须属于 MVP 支持的确定性集合；
 * 5. verificationPlan 必须覆盖全部 required 条件，且不得弱化（required=false）。 */
export function validateTaskContractSemantics(value: unknown): ValidationResult {
  const errors: string[] = [];
  const contract = value as TaskContractLike;
  const acIds = new Set<string>();
  const byId = new Map<string, (typeof contract.spec.acceptanceCriteria)[number]>();
  for (const ac of contract.spec.acceptanceCriteria) {
    if (acIds.has(ac.id)) errors.push(`/spec/acceptanceCriteria id 冲突：${ac.id} 重复`);
    acIds.add(ac.id);
    byId.set(ac.id, ac);
  }
  for (const [i, c] of contract.spec.verificationPlan.criteria.entries()) {
    if (!acIds.has(c.criterionId)) {
      errors.push(`/spec/verificationPlan/criteria/${i}/criterionId 引用不存在的验收条件 ${c.criterionId}`);
    }
  }
  for (const ac of contract.spec.acceptanceCriteria) {
    const required = ac.required !== false;
    if (!required) continue;
    if (!ac.rule || typeof ac.rule !== "object") {
      errors.push(`/spec/acceptanceCriteria/${ac.id} required 条件缺少可执行 rule 配置，拒绝静默默认`);
    } else {
      // R2-6：按 kind 校验 rule 必需字段——缺参数在确认阶段拒绝，
      // 不允许运行时把缺参退化为恒真匹配。
      const r = ac.rule;
      const missing: string[] = [];
      if ((r.kind === "artifactContains" || r.kind === "artifactRegex" || r.kind === "artifactSection") && !r.value) missing.push("value");
      if (r.kind === "threshold" && (r.threshold === undefined || !r.operator)) missing.push("operator/threshold");
      if (r.kind === "workspaceClean" && r.pathPrefix === undefined) missing.push("pathPrefix");
      if (!r.kind) missing.push("kind");
      if (missing.length > 0) {
        errors.push(`/spec/acceptanceCriteria/${ac.id} rule 缺少必需参数：${missing.join(", ")}`);
      }
    }
    if (!SUPPORTED_CONTRACT_EVALUATORS.has(ac.evaluator)) {
      errors.push(`/spec/acceptanceCriteria/${ac.id} evaluator "${ac.evaluator}" 不受支持（仅 ${[...SUPPORTED_CONTRACT_EVALUATORS].join("/")} 可作终判）`);
    }
    // v2.0 S3：semantic 只能判 semanticAgreement，且约定必须存在
    if ((ac.evaluator === "semantic") !== (ac.rule?.kind === "semanticAgreement")) {
      errors.push(`/spec/acceptanceCriteria/${ac.id} evaluator "${ac.evaluator}" 与规则 ${ac.rule?.kind ?? "（无）"} 不配：semantic 只能判 semanticAgreement 条件`);
    }
    if (ac.rule?.kind === "semanticAgreement" && !(contract.spec.acceptanceAgreements ?? []).some((g) => g.id === ac.rule?.agreementId)) {
      errors.push(`/spec/acceptanceCriteria/${ac.id} 引用的验收约定 ${ac.rule?.agreementId ?? "（无）"} 不存在`);
    }
    if (ac.rule?.kind === "deliverableSpec" && !ac.rule.spec) errors.push(`/spec/acceptanceCriteria/${ac.id} 缺少交付物规格编号`);
    const humanRule = ac.rule?.kind === "humanJudgement";
    if ((ac.evaluator === "human") !== humanRule) {
      errors.push(
        `/spec/acceptanceCriteria/${ac.id} evaluator "${ac.evaluator}" 与规则 ${ac.rule?.kind ?? "（无）"} 不配：` +
        `human 只能判 humanJudgement 条件，humanJudgement 条件只能由 human 判`
      );
    }
    const vp = contract.spec.verificationPlan.criteria.find((c) => c.criterionId === ac.id);
    // 领域层按 human. 前缀认人工判定条件：前缀必须与 evaluator 一致，不能借名
    if (vp && (vp.evaluatorRef ?? "").startsWith("human.") !== (ac.evaluator === "human")) {
      errors.push(`/spec/verificationPlan/criteria/${ac.id} evaluatorRef "${vp.evaluatorRef}" 与 evaluator "${ac.evaluator}" 不一致`);
    }
    if (vp && (vp.evaluatorRef ?? "").startsWith("semantic.") !== (ac.evaluator === "semantic")) {
      errors.push(`/spec/verificationPlan/criteria/${ac.id} evaluatorRef "${vp.evaluatorRef}" 与 evaluator "${ac.evaluator}" 不一致`);
    }
    if (!vp) {
      errors.push(`/spec/verificationPlan 必须条件 ${ac.id} 未被验证计划覆盖，不得遗漏`);
    } else if (vp.required === false) {
      errors.push(`/spec/verificationPlan/criteria/${ac.id} 将必须条件弱化为非必须，拒绝`);
    }
  }
  // v2.0 S3：要求的来源与采纳决定
  const reqs = contract.spec.requirements ?? [];
  const reqById = new Map(reqs.filter((r) => r.id).map((r) => [r.id as string, r]));
  for (const r of reqs) {
    const decided = r.decision === undefined || r.decision === "accepted";
    // 推断、建议、默认值只有被采纳后才能成为必须项；用户明说的不需要采纳
    if (r.obligation === "must" && !decided) errors.push(`/spec/requirements/${r.id} 尚未被采纳（${r.decision}），不能是必须项`);
  }
  for (const ac of contract.spec.acceptanceCriteria) {
    if (ac.required === false) continue;
    for (const id of ac.requirementIds ?? []) {
      const r = reqById.get(id);
      if (!r) continue;
      if (r.decision && r.decision !== "accepted") errors.push(`/spec/acceptanceCriteria/${ac.id} 覆盖了未采纳的要求 ${id}`);
    }
  }
  // 限制与安全类要求不能只由语义验收判定（高风险不以模型为唯一终判）
  for (const r of reqs) {
    if (r.kind !== "constraint" || !r.id) continue;
    const covering = contract.spec.acceptanceCriteria.filter((ac) => ac.required !== false && ac.requirementIds?.includes(r.id as string));
    if (covering.length > 0 && covering.every((ac) => ac.evaluator === "semantic")) {
      errors.push(`/spec/requirements/${r.id} 是限制类要求，不能只由语义验收判定（需要程序检查或人工判定）`);
    }
  }
  for (const g of contract.spec.acceptanceAgreements ?? []) {
    for (const id of g.requirementIds) if (!reqById.has(id)) errors.push(`/spec/acceptanceAgreements/${g.id} 引用了不存在的要求 ${id}`);
  }
  // v2.2：需求区块——schemaRef 必须已注册，需求实例按对应 schema 校验（哈希与派生投影由合约起草包重算核对）
  const spec = contract.spec as TaskContractLike["spec"] & { researchBrief?: unknown; researchBriefHash?: string; requirement?: { schemaRef: string; payload: unknown } };
  if (spec.requirement) {
    const name = REQUIREMENT_SCHEMAS[spec.requirement.schemaRef];
    if (!name) errors.push(`/spec/requirement/schemaRef ${spec.requirement.schemaRef} 不是平台注册的需求 schema`);
    else for (const e of (briefRegistry ??= new SchemaRegistry()).validate(name, spec.requirement.payload).errors) errors.push(`/spec/requirement/payload${e.startsWith("/") ? "" : " "}${e}`);
  }
  // v2.1：调研需求按 research-brief schema 校验，且必须带平台计算的哈希；researchChecks 只能用于调研类合约
  if (spec.researchBrief !== undefined) {
    const r = (briefRegistry ??= new SchemaRegistry()).validate("research-brief", spec.researchBrief);
    for (const e of r.errors) errors.push(`/spec/researchBrief${e.startsWith("/") ? "" : " "}${e}`);
    if (!spec.researchBriefHash) errors.push("/spec/researchBriefHash 调研类合约必须带调研需求哈希");
  }
  for (const ac of contract.spec.acceptanceCriteria) {
    if (ac.rule?.kind === "researchChecks" && spec.researchBrief === undefined && spec.requirement?.schemaRef !== "research-brief@1") errors.push(`/spec/acceptanceCriteria/${ac.id} 是调研报告检查，但合约里没有调研需求`);
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

interface WorkflowDefinitionLike {
  metadata: { workflowId: string; version: string };
  spec: { requires?: string[] };
}

/** WorkflowDefinition 语义检查：requires 不得引用自身（循环引用的最直接形态）。 */
export function validateWorkflowDefinitionSemantics(value: unknown): ValidationResult {
  const errors: string[] = [];
  const wf = value as WorkflowDefinitionLike;
  const self = `${wf.metadata.workflowId}@${wf.metadata.version}`;
  for (const [i, r] of (wf.spec.requires ?? []).entries()) {
    if (r === self) {
      errors.push(`/spec/requires/${i} 循环引用：${self} 依赖自身`);
    }
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/* ------------------------------- 迁移（纯函数） ------------------------------- */

export interface MigrationResult {
  migrated: JsonValue;
  report: { fromApiVersion: string; toApiVersion: string; changes: string[] };
}

const API_VERSIONS = ["agent.platform/v0", "agent.platform/v1"] as const;

function isRecord(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 迁移器是纯函数：输入旧对象，输出新对象与 migration report；原对象不被修改。
 * 当前支持 agent.platform/v0 → v1：v0 的 spec.limits 移入 spec.constraints，
 * v0 顶层 data 字段更名为 spec。
 */
export function migrateToV1(input: JsonValue): MigrationResult {
  const changes: string[] = [];
  const clone = structuredClone(input);
  if (!isRecord(clone)) throw new Error("migrateToV1: 输入必须是对象");
  const fromApiVersion = String(clone["apiVersion"] ?? "");
  if (!API_VERSIONS.includes(fromApiVersion as (typeof API_VERSIONS)[number])) {
    throw new Error(`migrateToV1: 未知 apiVersion ${fromApiVersion}`);
  }
  clone["apiVersion"] = "agent.platform/v1";
  if (fromApiVersion === "agent.platform/v0") {
    if (isRecord(clone["data"]) && !clone["spec"]) {
      clone["spec"] = clone["data"];
      delete clone["data"];
      changes.push("data → spec");
    }
    const spec = clone["spec"];
    if (isRecord(spec) && isRecord(spec["limits"])) {
      const constraints = isRecord(spec["constraints"]) ? spec["constraints"] : {};
      for (const [k, v] of Object.entries(spec["limits"])) constraints[k] = v;
      spec["constraints"] = constraints;
      delete spec["limits"];
      changes.push("spec.limits → spec.constraints");
    }
  }
  return {
    migrated: clone,
    report: { fromApiVersion, toApiVersion: "agent.platform/v1", changes }
  };
}
