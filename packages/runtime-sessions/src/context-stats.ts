import { estimateContextTokens } from "./cache-handoff.js";
import type { ProjectedEvent, RuntimeKind, TurnContextBreakdownPart, TurnContextStats, UsageRecord } from "./types.js";

/**
 * 推断模型上下文窗口上限：优先采用 runtime 直报值，其次按已知模型族保守匹配，未知返回 undefined。
 */
export function inferModelContextWindow(
  runtimeKind: RuntimeKind,
  model: string | undefined,
  totalTokens: number,
  reportedWindow?: number
): number | undefined {
  if (typeof reportedWindow === "number" && Number.isFinite(reportedWindow) && reportedWindow > 0) {
    return Math.round(reportedWindow);
  }
  const m = String(model ?? "").trim().toLowerCase();
  if (/\[1m\]|\b1m\b|gemini/.test(m)) return 1_000_000;
  if (/deepseek|glm/.test(m)) return 128_000;
  if (/claude/.test(m)) return totalTokens > 200_000 ? 1_000_000 : 200_000;
  if (/gpt-5/.test(m)) return totalTokens > 272_000 ? 1_000_000 : 272_000;
  if (/\b(?:o1|o3|o4|gpt-4)/.test(m)) return 200_000;
  if (runtimeKind === "antigravity") return 1_000_000;
  if (runtimeKind === "claude-code") return totalTokens > 200_000 ? 1_000_000 : 200_000;
  if (runtimeKind === "codex") return totalTokens > 272_000 ? 1_000_000 : 272_000;
  return undefined;
}

const BUCKET_META: ReadonlyArray<{ key: TurnContextBreakdownPart["key"]; label: string }> = [
  { key: "tool", label: "工具输出" },
  { key: "system", label: "系统与记忆" },
  { key: "chat", label: "对话消息" },
  { key: "reasoning", label: "思考过程" }
];

/**
 * 按最大余数法把权重数组归一化为整数百分比（和为 100）和按 totalTokens 折算的估算 tokens（和为 totalTokens）。
 */
function normalizeBuckets(
  weights: Record<TurnContextBreakdownPart["key"], number>,
  totalTokens: number
): TurnContextBreakdownPart[] {
  const active = BUCKET_META.filter((b) => weights[b.key] > 0);
  if (!active.length || totalTokens <= 0) return [];
  const sum = active.reduce((acc, b) => acc + weights[b.key], 0);
  if (sum <= 0) return [];

  const pctItems = active.map((b) => {
    const exact = (weights[b.key] / sum) * 100;
    const floor = Math.floor(exact);
    return { key: b.key, label: b.label, floor, rem: exact - floor };
  });
  let pctLeft = 100 - pctItems.reduce((acc, x) => acc + x.floor, 0);
  for (const item of [...pctItems].sort((a, b) => b.rem - a.rem)) {
    if (pctLeft <= 0) break;
    item.floor += 1;
    pctLeft -= 1;
  }

  const tokItems = active.map((b) => {
    const exact = (weights[b.key] / sum) * totalTokens;
    const floor = Math.floor(exact);
    return { key: b.key, floor, rem: exact - floor };
  });
  let tokLeft = totalTokens - tokItems.reduce((acc, x) => acc + x.floor, 0);
  for (const item of [...tokItems].sort((a, b) => b.rem - a.rem)) {
    if (tokLeft <= 0) break;
    item.floor += 1;
    tokLeft -= 1;
  }
  const tokByKey = new Map(tokItems.map((x) => [x.key, x.floor]));

  return pctItems
    .filter((x) => x.floor > 0 || (tokByKey.get(x.key) ?? 0) > 0)
    .map((x) => ({
      key: x.key,
      label: x.label,
      percent: x.floor,
      tokens: tokByKey.get(x.key) ?? 0
    }));
}

export interface BuildTurnContextStatsInput {
  runtimeKind: RuntimeKind;
  model?: string;
  turnNo: number;
  events: ProjectedEvent[];
  usageRecords: UsageRecord[];
  prevContextTokens?: number;
  fallbackTotalTokens?: number;
}

/**
 * 汇总本轮结束时的上下文占用与估算分类占比：
 * - 总量来自 runtime 实测（contextTokens 或最近单次请求总输入），取不到时返回 undefined；
 * - 各段占比按本会话（若发生过压缩则取最近一次压缩之后）事件的字符权重折算，UI 明确标注估算口径。
 */
export function buildTurnContextStats(input: BuildTurnContextStatsInput): TurnContextStats | undefined {
  const est = estimateContextTokens(input.usageRecords);
  const totalTokens = est?.tokens ?? (typeof input.fallbackTotalTokens === "number" && input.fallbackTotalTokens > 0 ? Math.round(input.fallbackTotalTokens) : 0);
  if (!totalTokens || !Number.isFinite(totalTokens)) return undefined;

  const source: TurnContextStats["source"] = est?.source ?? "last-request";
  const ownUsage = input.usageRecords.filter((r) => !r.aggregate && !r.subagent);
  const reportedWindow = [...ownUsage]
    .filter((r) => typeof r.contextWindow === "number" && r.contextWindow > 0)
    .sort((a, b) => (Date.parse(b.occurredAt ?? b.sampledAt) || 0) - (Date.parse(a.occurredAt ?? a.sampledAt) || 0))[0]?.contextWindow;

  const windowTokens = inferModelContextWindow(input.runtimeKind, input.model, totalTokens, reportedWindow);
  const usageRatio = windowTokens && windowTokens > 0 ? Math.min(1, totalTokens / windowTokens) : undefined;
  const tone: TurnContextStats["tone"] =
    usageRatio !== undefined && usageRatio >= 0.85 ? "bad"
    : usageRatio !== undefined && usageRatio >= 0.70 ? "warn"
    : "neutral";
  const deltaTokens = input.prevContextTokens !== undefined && Number.isFinite(input.prevContextTokens)
    ? totalTokens - Math.round(input.prevContextTokens)
    : totalTokens;

  // 只统计截至本轮且属于主会话的事件；若发生过压缩则从最近一次压缩后起算，免得旧历史虚高占比。
  const eligible = input.events.filter((e) => !e.subagent && (e.turnNo === undefined || e.turnNo <= input.turnNo));
  let startIdx = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const e = eligible[i];
    if (e.kind === "compaction" || (e.kind === "notice" && /压缩|compact/i.test(e.text ?? ""))) {
      startIdx = i + 1;
      break;
    }
  }

  let toolChars = 0;
  let sysChars = 0;
  let chatChars = 0;
  let reasoningChars = 0;

  // 系统注入通常只在首轮出现，即使压缩后也仍留在系统提示中
  for (const e of eligible) {
    if (e.kind === "notice" && e.injection?.text) {
      sysChars += e.injection.text.length;
    }
  }

  for (let i = startIdx; i < eligible.length; i++) {
    const e = eligible[i];
    if (e.kind === "tool") {
      const rawLen = (e.tool?.name?.length ?? 0) + (e.tool?.input?.length ?? 0) + (e.tool?.output?.length ?? 0);
      toolChars += Math.max(rawLen, e.truncated?.originalChars ?? 0);
    } else if (e.kind === "approval") {
      toolChars += (e.text?.length ?? 0);
    } else if (e.kind === "reasoning") {
      reasoningChars += Math.max(e.text?.length ?? 0, e.truncated?.originalChars ?? 0);
    } else if (e.kind === "message") {
      chatChars += Math.max(e.text?.length ?? 0, e.truncated?.originalChars ?? 0);
    } else if (e.kind === "notice" && e.enforcement) {
      sysChars += (e.text?.length ?? 0);
    }
  }

  // 每个 runtime 都会携带系统提示与工具声明（未写入事件流）；补一个保守基线避免系统占比为 0
  const baselineSystemChars = Math.min(24_000, Math.max(6_000, Math.round(totalTokens * 0.6)));
  sysChars = Math.max(sysChars, baselineSystemChars);

  const parts = normalizeBuckets(
    { tool: toolChars, system: sysChars, chat: chatChars, reasoning: reasoningChars },
    totalTokens
  );

  return {
    totalTokens,
    ...(windowTokens !== undefined ? { windowTokens } : {}),
    deltaTokens,
    ...(usageRatio !== undefined ? { usageRatio: Number(usageRatio.toFixed(4)) } : {}),
    tone,
    source,
    parts
  };
}
