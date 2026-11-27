import { describe, expect, it } from "vitest";
import { buildTurnContextStats, inferModelContextWindow } from "../src/context-stats.js";
import type { ProjectedEvent, UsageRecord } from "../src/types.js";

const ev = (partial: Partial<ProjectedEvent> & Pick<ProjectedEvent, "key" | "seq" | "kind">): ProjectedEvent => ({
  source: "stream",
  parserVersion: "test@1",
  availability: "recorded",
  recordedAt: "2026-11-26T08:00:00.000Z",
  ...partial
});

describe("inferModelContextWindow", () => {
  it("优先采用 runtime 直报窗口，其次按模型族保守匹配", () => {
    expect(inferModelContextWindow("antigravity", "gemini-3.1-pro", 80_000, 500_000)).toBe(500_000);
    expect(inferModelContextWindow("antigravity", "gemini-3.1-pro", 80_000)).toBe(1_000_000);
    expect(inferModelContextWindow("claude-code", "claude-sonnet-4-6", 120_000)).toBe(200_000);
    expect(inferModelContextWindow("claude-code", "claude-sonnet-4-6", 260_000)).toBe(1_000_000);
    expect(inferModelContextWindow("claude-code", "claude-opus-4-6[1m]", 80_000)).toBe(1_000_000);
    expect(inferModelContextWindow("pi", "deepseek-chat", 60_000)).toBe(128_000);
    expect(inferModelContextWindow("codex", "gpt-5.4", 120_000)).toBe(272_000);
  });
});

describe("buildTurnContextStats", () => {
  it("按实测总上下文与事件字符权重归一化四类占比，百分比和为 100 且 tokens 和等于总量", () => {
    const usage: UsageRecord[] = [{
      usageScope: "turn",
      counterMode: "delta",
      raw: {},
      contextTokens: 107_000,
      contextWindow: 1_000_000,
      semantics: "test",
      sourceRef: "test",
      sampledAt: "2026-11-26T08:00:00.000Z",
      reliability: "complete"
    }];
    const events: ProjectedEvent[] = [
      ev({ key: "inj:1", seq: 1, turnNo: 1, kind: "notice", injection: { label: "平台公共记忆", text: "S".repeat(12_000), count: 5 } }),
      ev({ key: "u:1", seq: 2, turnNo: 1, kind: "message", role: "user", text: "U".repeat(2_000) }),
      ev({ key: "t:1", seq: 3, turnNo: 1, kind: "tool", tool: { name: "read_file", input: "I".repeat(500), output: "O".repeat(2_000) }, truncated: { originalChars: 60_000 } }),
      ev({ key: "r:1", seq: 4, turnNo: 1, kind: "reasoning", text: "R".repeat(6_000) }),
      ev({ key: "a:1", seq: 5, turnNo: 1, kind: "message", role: "assistant", text: "A".repeat(10_000) }),
      // 子 Agent 事件不计入主会话占比
      ev({ key: "sub:1", seq: 6, turnNo: 1, subagent: "sub-1", kind: "tool", tool: { name: "bash", output: "X".repeat(900_000) } })
    ];

    const stats = buildTurnContextStats({
      runtimeKind: "antigravity",
      model: "gemini-3.1-pro",
      turnNo: 1,
      events,
      usageRecords: usage,
      prevContextTokens: 74_000
    });
    expect(stats).toBeDefined();
    expect(stats!.totalTokens).toBe(107_000);
    expect(stats!.windowTokens).toBe(1_000_000);
    expect(stats!.deltaTokens).toBe(33_000);
    expect(stats!.usageRatio).toBeCloseTo(0.107, 4);
    expect(stats!.tone).toBe("neutral");
    expect(stats!.parts.reduce((s, p) => s + p.percent, 0)).toBe(100);
    expect(stats!.parts.reduce((s, p) => s + p.tokens, 0)).toBe(107_000);
    // truncated.originalChars=60k 让工具输出排在最高位，且未被 900k 的 subagent 污染
    const toolPart = stats!.parts.find((p) => p.key === "tool")!;
    expect(toolPart.percent).toBeGreaterThan(45);
    expect(toolPart.percent).toBeLessThan(80);
  });

  it("高水位按 70% warn / 85% bad 分级，压缩后从压缩点重算对话和工具权重", () => {
    const usage: UsageRecord[] = [{
      usageScope: "request",
      counterMode: "delta",
      raw: {},
      input: 10_000,
      cachedInput: 150_000,
      cacheCreation: 15_000,
      semantics: "test",
      sourceRef: "test",
      sampledAt: "2026-11-26T08:10:00.000Z",
      reliability: "complete"
    }];
    const events: ProjectedEvent[] = [
      ev({ key: "t:old", seq: 1, turnNo: 1, kind: "tool", tool: { name: "bash", output: "X".repeat(500_000) } }),
      ev({ key: "cmp:1", seq: 2, turnNo: 2, kind: "compaction", text: "上下文已压缩" }),
      ev({ key: "u:2", seq: 3, turnNo: 2, kind: "message", role: "user", text: "M".repeat(40_000) })
    ];

    const stats = buildTurnContextStats({
      runtimeKind: "claude-code",
      model: "claude-sonnet-4-6",
      turnNo: 2,
      events,
      usageRecords: usage
    });
    expect(stats).toBeDefined();
    expect(stats!.totalTokens).toBe(175_000);
    expect(stats!.windowTokens).toBe(200_000);
    expect(stats!.tone).toBe("bad"); // 175k / 200k = 87.5% >= 85%
    // 压缩前的 500k tool 输出不再占主导，对话消息权重占大头
    expect(stats!.parts.some((p) => p.key === "tool")).toBe(false);
    expect(stats!.parts.find((p) => p.key === "chat")!.percent).toBeGreaterThan(50);
  });

  it("无用量记录且无兜底时返回 undefined，不伪造 0", () => {
    expect(buildTurnContextStats({
      runtimeKind: "pi",
      turnNo: 1,
      events: [],
      usageRecords: []
    })).toBeUndefined();
  });
});
