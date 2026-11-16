import type { DriverEvent } from "./driver.js";
import type { UsageRecord } from "./types.js";
import { bounded, LIMITS, stringifyInput } from "./redact.js";
import { createHash } from "node:crypto";

export const PI_PROJECTION_VERSION = "pi-rpc@1";
export const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function piContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((v) => { const c = object(v); return c.type === "text" ? String(c.text ?? "") : c.type === "image" ? "[图片]" : ""; }).filter(Boolean).join("\n");
}
export function piMessageKey(message: Record<string, unknown>, fallback = "unknown"): string {
  return `pi:message:${message.role}:${message.timestamp ?? fallback}`;
}
export function projectPiMessage(message: Record<string, unknown>, source: "stream" | "history", partial = false, fallback?: string): DriverEvent[] {
  const role = String(message.role ?? ""), key = piMessageKey(message, fallback);
  const base = { source, parserVersion: PI_PROJECTION_VERSION, availability: "recorded" as const, partial };
  const events: DriverEvent[] = [];
  if (role === "toolResult") {
    events.push({ ...base, key: `pi:tool:${message.toolCallId}`, kind: "tool", tool: { name: String(message.toolName ?? "tool"), output: bounded(piContentText(message.content), LIMITS.toolOutput).text, status: message.isError ? "failed" : "completed" } });
    return events;
  }
  // 按原文内容的顺序投影：先出现的思考排在正文前面（事件的先后决定 seq，也就是页面上的顺序）
  const textRole = role === "user" || role === "assistant" ? role : undefined;
  const text = textRole ? bounded(piContentText(message.content), LIMITS.message) : undefined;
  let textAt = -1;
  for (const raw of Array.isArray(message.content) ? message.content : []) {
    const content = object(raw);
    if ((content.type === "text" || content.type === "image") && textAt < 0 && text?.text) { textAt = events.length; events.push({ ...base, key, kind: "message", role: textRole, ...text }); }
    if (content.type === "thinking") events.push({ ...base, key: `${key}:thinking`, kind: "reasoning", ...bounded(String(content.thinking ?? ""), LIMITS.message) });
    if (content.type === "toolCall") events.push({ ...base, key: `pi:tool:${content.id}`, nativeItemId: String(content.id), kind: "tool", tool: { name: String(content.name), input: bounded(stringifyInput(content.arguments), LIMITS.toolInput).text, status: "pending" } });
  }
  if (textAt < 0 && text?.text) events.unshift({ ...base, key, kind: "message", role: textRole, ...text });
  if (message.errorMessage) events.push({ ...base, key: `${key}:error`, kind: "error", ...bounded(String(message.errorMessage), LIMITS.message) });
  return events;
}
export function piUsage(message: Record<string, unknown>, sessionId: string): UsageRecord | undefined {
  const usage = object(message.usage);
  const raw = Object.fromEntries(Object.entries(usage).filter(([, value]) => typeof value === "number" && Number.isFinite(value))) as Record<string, number>;
  if (!Object.keys(raw).length) return;
  const key = `${sessionId}:${piMessageKey(message, createHash("sha256").update(JSON.stringify(message)).digest("hex"))}`;
  return {
    usageScope: "request", counterMode: "delta", raw, model: `${message.provider}/${message.model}`,
    input: raw.input, output: raw.output, cachedInput: raw.cacheRead, cacheCreation: raw.cacheWrite, total: raw.totalTokens,
    semantics: "Pi 原生 assistant 消息用量；input 为未缓存输入，cacheRead/cacheWrite 单列；按会话与消息时间标识去重。",
    requestId: key, sourceRef: key, sampledAt: new Date().toISOString(), reliability: "partial"
  };
}
