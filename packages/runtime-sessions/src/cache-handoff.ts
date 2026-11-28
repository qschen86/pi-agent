import type { ProjectedEvent, RuntimeKind, SessionBinding, UsageRecord } from "./types.js";

/**
 * 缓存变冷后的续聊：模型服务端的提示缓存空闲一阵就失效，之后第一次请求要把整段上下文重新写入缓存。
 * 上下文很长时这一次很贵，所以空闲超过缓存保留时间、上下文又超过阈值的会话，改成新开会话接续（见 manager.handoffSession）。
 *
 * 各家保留时间（2026-11 查证）：
 *  - Claude Code：订阅额度内主对话 1 小时（超出套餐走额外用量时降为 5 分钟）。
 *  - Codex（OpenAI）：内存缓存空闲 5–10 分钟、最长 1 小时；部分新模型可开 24 小时，按 1 小时判定。
 *  - Pi：DeepSeek 磁盘缓存「数小时到数天」且不保证 → 6 小时；智谱隐式缓存有效期不定、显式只有 5 分钟 → 1 小时。
 *  - Antigravity（Gemini）：隐式缓存最长 24 小时、通常分钟级命中，文档没给保证 → 1 小时。
 * 表里的值是「超过它一定冷了」的判定线，偏保守：误判的代价只是多新开一次会话，不会丢东西。
 */
const HOUR = 3_600_000;
export const CACHE_HANDOFF_DEFAULT_TOKENS = 200_000;
/** Claude 1 小时缓存写入单价为普通输入的 2x（缓存读取的 20x），10 万上下冷重启成本已显著，默认阈值下调至 10 万 */
export const CACHE_HANDOFF_CLAUDE_DEFAULT_TOKENS = 100_000;

export function cacheHandoffDefaultThreshold(kind: RuntimeKind): number {
  return kind === "claude-code" ? CACHE_HANDOFF_CLAUDE_DEFAULT_TOKENS : CACHE_HANDOFF_DEFAULT_TOKENS;
}

export interface CacheTtl { ttlMs: number; basis: string }

export function cacheTtl(kind: RuntimeKind, model?: string): CacheTtl {
  switch (kind) {
    case "claude-code": return { ttlMs: HOUR, basis: "Claude 提示缓存 1 小时" };
    case "codex": return { ttlMs: HOUR, basis: "OpenAI 提示缓存空闲最长约 1 小时" };
    case "pi": return /^deepseek\b/i.test(model ?? "")
      ? { ttlMs: 6 * HOUR, basis: "DeepSeek 磁盘缓存数小时起（不保证）" }
      : { ttlMs: HOUR, basis: "智谱缓存有效期不定，按 1 小时" };
    case "antigravity": return { ttlMs: HOUR, basis: "Gemini 隐式缓存没有保留保证，按 1 小时" };
  }
}

const at = (r: UsageRecord): number => Date.parse(r.occurredAt ?? r.sampledAt) || 0;

/**
 * 最近一次请求带上的上下文大小。取不到就返回 undefined（不猜，不触发）：
 *  - 驱动直接给了 contextTokens（Codex 的 last 用量、Antigravity 的 usage_update）→ 用最新一条。
 *  - Claude / Pi 有逐请求用量：输入 + 缓存读取 + 缓存写入（输入不含缓存）。
 *  - 子代理的请求有自己的上下文，不算。归档压缩过的合计行没有逐次明细，也不算。
 */
export function estimateContextTokens(records: UsageRecord[]): { tokens: number; source: "reported" | "last-request" } | undefined {
  const own = records.filter((r) => !r.aggregate && !r.subagent);
  const reported = own.filter((r) => typeof r.contextTokens === "number" && r.contextTokens > 0).sort((a, b) => at(b) - at(a))[0];
  if (reported) return { tokens: reported.contextTokens!, source: "reported" };
  const last = own.filter((r) => r.usageScope === "request" && r.counterMode === "delta").sort((a, b) => at(b) - at(a))[0];
  if (!last) return undefined;
  const tokens = (last.input ?? 0) + (last.cachedInput ?? 0) + (last.cacheCreation ?? 0);
  return tokens > 0 ? { tokens, source: "last-request" } : undefined;
}

export interface CacheHandoffAssessment {
  /** 这个会话本身能不能用新开会话接续（运行时、类型、状态都合适） */
  eligible: boolean;
  /** 空闲超过缓存保留时间、上下文超过阈值：续旧会话会重写一整段缓存 */
  due: boolean;
  runtimeKind: RuntimeKind;
  idleMs?: number;
  ttlMs: number;
  ttlBasis: string;
  contextTokens?: number;
  thresholdTokens: number;
  /** 不触发的原因（给日志和排查用） */
  skip?: string;
}

/** 最近一轮结束的时间：没有结束时间（还在跑、从没跑过）返回 undefined */
export function lastTurnEndedAt(b: Pick<SessionBinding, "turns">): number | undefined {
  const t = b.turns.at(-1);
  if (!t || !t.endedAt) return undefined;
  const ms = Date.parse(t.endedAt);
  return Number.isFinite(ms) ? ms : undefined;
}

export function assessCacheHandoff(
  b: Pick<SessionBinding, "runtimeKind" | "effectiveModel" | "requestedModel" | "turns" | "archived" | "roomRef" | "comparisonRef" | "projectRef" | "evaluation" | "conflict" | "nativeSessionId" | "outbox" | "status">,
  usage: UsageRecord[],
  opts: { now: number; thresholdTokens?: number; enabled?: boolean }
): CacheHandoffAssessment {
  const { ttlMs, basis } = cacheTtl(b.runtimeKind, b.effectiveModel ?? b.requestedModel);
  const thresholdTokens = opts.thresholdTokens && opts.thresholdTokens > 0 ? opts.thresholdTokens : cacheHandoffDefaultThreshold(b.runtimeKind);
  const base = { runtimeKind: b.runtimeKind, ttlMs, ttlBasis: basis, thresholdTokens };
  const no = (skip: string, extra: Partial<CacheHandoffAssessment> = {}): CacheHandoffAssessment => ({ ...base, eligible: false, due: false, skip, ...extra });
  if (opts.enabled === false) return no("disabled");
  if (b.archived) return no("archived");
  if (b.roomRef || b.comparisonRef || b.projectRef || b.evaluation) return no("not-plain-session");
  if (b.conflict) return no("conflict");
  if (!b.nativeSessionId) return no("no-native-session");
  if (b.outbox?.length) return no("outbox-pending");
  const ended = lastTurnEndedAt(b);
  if (ended === undefined) return no("no-finished-turn");
  const idleMs = Math.max(0, opts.now - ended);
  const ctx = estimateContextTokens(usage);
  const common = { idleMs, ...(ctx ? { contextTokens: ctx.tokens } : {}) };
  if (!ctx) return { ...base, ...common, eligible: true, due: false, skip: "context-unknown" };
  if (idleMs <= ttlMs) return { ...base, ...common, eligible: true, due: false, skip: "cache-warm" };
  if (ctx.tokens < thresholdTokens) return { ...base, ...common, eligible: true, due: false, skip: "context-small" };
  return { ...base, ...common, eligible: true, due: true };
}

/**
 * 接续出来的新会话的标题：沿用最原始会话的名字，最前面加「续N·」（第一次接续是续2，再接续是续3……），
 * 这样会话列表里一眼分得清哪个是接续链上最新的，又只多占 3 个字符。旧会话本身就是接续出来的，才去掉它标题开头的「续N·」；
 * 标题上限 80 个字符，名字太长时截断名字、保住前缀。
 */
export function handoffTitle(old: { title: string; handoff?: { from?: unknown } }, maxLen = 80): string {
  const m = old.handoff?.from ? /^续(\d+)·(.*)$/s.exec(old.title) : null;
  const base = m ? m[2]! : old.title;
  const prefix = `续${m ? Number(m[1]) + 1 : 2}·`;
  const room = Math.max(1, maxLen - prefix.length);
  return `${prefix}${base.length > room ? `${base.slice(0, room - 1)}…` : base}`;
}

/* ------------------------------ 交接材料 ------------------------------ */

const PLATFORM_AUTO = /^(额度已恢复（平台自动继续|【平台强约束检查未通过】|\[pi-agent 自动验证通知\])/;
const cut = (s: string, n: number): string => s.length > n ? `${s.slice(0, n)}…（已截断）` : s;

/** 只保留「人的消息」和「助手的文字回复」：不含工具输出、推理和平台通知，纯文本，不调用任何模型 */
export function buildTranscript(title: string, events: ProjectedEvent[]): string {
  const lines: string[] = [`# ${title}`, ""];
  for (const e of events) {
    if (e.kind !== "message" || (e.role !== "user" && e.role !== "assistant") || e.partial) continue;
    const text = (e.text ?? "").trim();
    if (!text) continue;
    const who = e.role === "user" ? (PLATFORM_AUTO.test(text) ? "平台自动消息" : "用户") : "助手";
    lines.push(`## ${who}${e.turnNo ? ` · 第 ${e.turnNo} 轮` : ""}${e.occurredAt ? ` · ${e.occurredAt}` : ""}`, "", cut(text, 6000), "");
  }
  return lines.join("\n");
}

/** 交接摘录：最近一条用户消息 + 最近一条助手回复，用来让新会话马上知道刚才在做什么 */
export function handoffTail(events: ProjectedEvent[]): { user?: string; assistant?: string } {
  const msgs = events.filter((e) => e.kind === "message" && !e.partial && (e.text ?? "").trim());
  const lastUser = [...msgs].reverse().find((e) => e.role === "user" && !PLATFORM_AUTO.test(e.text!.trim()));
  const lastAssistant = [...msgs].reverse().find((e) => e.role === "assistant");
  return { ...(lastUser ? { user: cut(lastUser.text!.trim(), 3000) } : {}), ...(lastAssistant ? { assistant: cut(lastAssistant.text!.trim(), 4000) } : {}) };
}

export function handoffPreamble(o: { title: string; platformSessionId: string; transcriptPath: string; idleMs?: number; contextTokens?: number; tail: { user?: string; assistant?: string } }): string {
  const hours = o.idleMs !== undefined ? `（空闲约 ${o.idleMs >= 3_600_000 ? `${(o.idleMs / 3_600_000).toFixed(1)} 小时` : `${Math.round(o.idleMs / 60_000)} 分钟`}${o.contextTokens ? `，上下文约 ${Math.round(o.contextTokens / 1000)}k token` : ""}）` : "";
  return [
    `【平台接续】这是从会话「${o.title}」（${o.platformSessionId}）接续的新会话${hours}：旧会话的缓存已经过期，继续用它每一步都要重新读很长的上下文，所以平台改成新开会话。旧会话已归档，工作目录、分支和待办关联已经转到本会话，直接接着做。`,
    `旧会话的完整对话（只含人的消息和助手的文字回复，不含工具输出）在：${o.transcriptPath}`,
    "不要整份读：先看最后几轮（例如 tail -c 20000），需要某个细节时再 grep 关键词，读多了会白白消耗额度。",
    ...(o.tail.user ? ["", "旧会话里用户最近一条消息：", o.tail.user] : []),
    ...(o.tail.assistant ? ["", "旧会话里助手最近一条回复：", o.tail.assistant] : []),
    "", "以下是这次的新消息："
  ].join("\n");
}
