/**
 * 平台模型目录（v2.4）：执行 Agent 能选哪些模型，由平台维护，不由任务文本、模型回复或 Agent 定义临时发明。
 *
 * - 内置条目以钉住版本的 Pi 模型表为底，与上游目录核对；容量取两者中较小的值（保守）。
 *   尚未进入 Pi 内置表的新条目配套版本化 models.json 定义，容量取上游当前声明。
 * - 推理强度按 Pi 的 getSupportedThinkingLevels 规则列出该模型实际支持的级别。
 * - 工具调用等能力是平台的版本化声明（Pi 表里没有通用的「支持工具调用」字段），来源写在 capabilitySource。
 * - 目录版本写进编译计划：回放时能说明当时凭哪份目录判定可选。
 */

import { OPENROUTER_CATALOG_MODELS } from "./openrouter-model-catalog.js";

export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CatalogModel {
  /** provider/model，即 API 真正使用的标识 */
  ref: string;
  provider: string;
  model: string;
  /** 页面显示名（与 API 标识分开） */
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  input: Array<"text" | "image">;
  reasoning: boolean;
  thinkingLevels: ThinkingLevelName[];
  capabilities: string[];
  capabilitySource: string;
  status: "active" | "retired";
  sources: string[];
}

export const MODEL_CATALOG: { version: string; piVersion: string; models: CatalogModel[] } = {
  version: "models@2026-09-30-selected13",
  piVersion: "0.86.1",
  models: [
    {
      ref: "deepseek/deepseek-flash",
      provider: "deepseek",
      model: "deepseek-flash",
      displayName: "DeepSeek V4.1 Flash",
      // Pi 表 1000000 / 384000；DeepSeek 官方模型列表 1048576 / 393216——取较小值
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      input: ["text", "image"],
      reasoning: true,
      // Pi 表的 thinkingLevelMap：minimal、medium 为空，xhigh 未定义
      thinkingLevels: ["off", "low", "high", "max"],
      capabilities: ["text", "code", "tool-calling"],
      capabilitySource: "平台声明（v2.4）；工具调用待真机契约探针复核",
      status: "active",
      sources: ["pi@0.86.1 内置模型表", "https://api-docs.deepseek.com/api/list-models/（2026-09-27 核对）"]
    },
    {
      ref: "zhipu/glm-5.3-flash",
      provider: "zhipu",
      model: "glm-5.3-flash",
      displayName: "GLM-5.3 Flash",
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      input: ["text", "image"],
      reasoning: true,
      // 推理模型、始终思考：2026-09-28 起供应商拒绝关闭推理（400 code 1210「该模型始终思考，不支持关闭思考」）；
      // minimal、low、medium、high 经 Pi 转发均通过参数校验
      thinkingLevels: ["minimal", "low", "medium", "high"],
      capabilities: ["text", "code", "tool-calling"],
      capabilitySource: "平台声明（v1.x 起真机任务在用）",
      status: "active",
      sources: ["本机 Pi models.json 的 zhipu 自定义 provider（2026-09-27 核对）"]
    },
    ...OPENROUTER_CATALOG_MODELS
  ]
};

export function catalogModel(ref: string): CatalogModel | undefined {
  return MODEL_CATALOG.models.find((m) => m.ref === ref);
}

const EFFORT_NAMES: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 模型选择的写法：`provider/model` 或 `provider/model:推理强度`（例如 deepseek/deepseek-flash:high）。
 * 任务创建时为三类 Agent（填充、执行、验收）选大脑用这一种写法；没写推理强度 = 用默认。
 */
export function parseModelChoice(value: string): { ref: string; effort?: ThinkingLevelName } {
  const i = value.lastIndexOf(":");
  if (i > 0 && EFFORT_NAMES.includes(value.slice(i + 1))) return { ref: value.slice(0, i), effort: value.slice(i + 1) as ThinkingLevelName };
  return { ref: value };
}

/**
 * 「先轻后重」策略里轻的那一档：模型能关推理就关（off），始终思考的模型用它支持的最低一档；
 * 不在目录里的模型沿用 off（由运行时决定）。
 */
export function lightestEffort(ref: string): ThinkingLevelName {
  const levels = catalogModel(ref)?.thinkingLevels;
  if (!levels?.length || levels.includes("off")) return "off";
  return [...levels].sort((a, b) => EFFORT_NAMES.indexOf(a) - EFFORT_NAMES.indexOf(b))[0];
}

/** 推理强度是否受该模型支持（按平台模型目录）；返回不支持的原因，支持返回 undefined */
export function effortProblem(ref: string, effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  const c = catalogModel(ref);
  if (!c) return `${ref} 不在平台模型目录里`;
  return (c.thinkingLevels as string[]).includes(effort) ? undefined : `${c.displayName} 不支持推理强度 ${effort}（可选：${c.thinkingLevels.join("、")}）`;
}

/** 执行模型的候选：`ref` + 钉住的推理强度（v2.4 评审 R4，方案 A）。 */
export interface SelectableModel { ref: string; thinking?: ThinkingLevelName }

/** 已发布旧版本的模型列表不可改写；删除候选后仍允许读取其冻结定义。
 * 这些版本不能借此为新会话绑定已移除的模型：编译阶段仍要求模型在当前目录。 */
const LEGACY_OPENROUTER_AGENT_VERSIONS: Readonly<Record<string, string>> = {
  "coder-agent": "0.3.0",
  "product-agent": "0.4.0",
  "qa-agent": "0.3.0",
  "competitor-research-agent": "0.8.0",
  "presentation-agent": "0.3.0"
};

function legacyOpenRouterChoice(def: unknown, ref: string): boolean {
  if (!ref.startsWith("openrouter/")) return false;
  const metadata = (def as { metadata?: { id?: string; version?: string; status?: string } } | undefined)?.metadata;
  return metadata?.status === "PUBLISHED" && LEGACY_OPENROUTER_AGENT_VERSIONS[metadata.id ?? ""] === metadata.version;
}

/** Agent 定义里的模型边界：多模型写法取候选集合与默认项；旧单模型写法的等效集合只有原模型（推理强度沿用运行时默认）。 */
export function selectableModelsOf(def: unknown): { models: SelectableModel[]; defaultRef: string | undefined; multi: boolean } {
  const brain = (def as { spec?: { brain?: { selectableModels?: SelectableModel[]; defaultModelRef?: string; provider?: string; model?: string; modelFamily?: string } } } | undefined)?.spec?.brain;
  if (brain?.selectableModels?.length) return { models: brain.selectableModels, defaultRef: brain.defaultModelRef, multi: true };
  const provider = brain?.provider ?? brain?.modelFamily;
  if (provider && brain?.model) return { models: [{ ref: `${provider}/${brain.model}` }], defaultRef: `${provider}/${brain.model}`, multi: false };
  return { models: [], defaultRef: undefined, multi: false };
}

/**
 * 候选集合的发布校验：目录里有且可用、无重复、默认项在集合内、上下文不小于 minContextTokens、
 * 钉住的推理强度受该模型支持；多模型写法不得与 fallback 并存（不静默换模型）。
 */
export function validateSelectableModels(def: unknown): string[] {
  const brain = (def as { spec?: { brain?: { selectableModels?: SelectableModel[]; defaultModelRef?: string; minContextTokens?: number; fallback?: unknown } } }).spec?.brain;
  if (!brain?.selectableModels) {
    return brain?.defaultModelRef !== undefined ? ["/spec/brain/defaultModelRef 只能与 selectableModels 一起使用"] : [];
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, m] of brain.selectableModels.entries()) {
    const at = `/spec/brain/selectableModels/${i}`;
    if (seen.has(m.ref)) errors.push(`${at} ${m.ref} 重复`);
    seen.add(m.ref);
    const c = catalogModel(m.ref);
    if (!c) {
      if (legacyOpenRouterChoice(def, m.ref)) continue;
      errors.push(`${at} ${m.ref} 不在平台模型目录（${MODEL_CATALOG.version}）里`); continue;
    }
    if (c.status !== "active") errors.push(`${at} ${m.ref} 已退役`);
    if (brain.minContextTokens !== undefined && c.contextWindow < brain.minContextTokens) errors.push(`${at} ${m.ref} 上下文 ${c.contextWindow} 小于 minContextTokens ${brain.minContextTokens}`);
    if (m.thinking !== undefined && !c.thinkingLevels.includes(m.thinking)) errors.push(`${at} ${m.ref} 不支持推理强度 ${m.thinking}（支持 ${c.thinkingLevels.join("、")}）`);
  }
  if (!brain.defaultModelRef) errors.push("/spec/brain/defaultModelRef 必须指定（多模型写法）");
  else if (!seen.has(brain.defaultModelRef)) errors.push(`/spec/brain/defaultModelRef ${brain.defaultModelRef} 不在 selectableModels 里`);
  if (brain.fallback !== undefined) errors.push("/spec/brain/fallback 不能与 selectableModels 并存：平台不静默换模型");
  return errors;
}
