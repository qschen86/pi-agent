import { describe, expect, it } from "vitest";
import { buildTurnContextStats, classifyToolKind, inferModelContextWindow } from "../src/context-stats.js";
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

describe("classifyToolKind", () => {
  it("按工具名归类，shell 类再按命令内容（写 > 测试构建 > git > 读搜）", () => {
    expect(classifyToolKind("Read", '{"file_path":"a.ts"}')).toBe("read");
    expect(classifyToolKind("grep", '{"pattern":"x"}')).toBe("read");
    expect(classifyToolKind("Edit", "{}")).toBe("edit");
    expect(classifyToolKind("文件修改", "/a/b.ts")).toBe("edit");
    expect(classifyToolKind("platform_browser.browser", '{"action":"open"}')).toBe("browser");
    expect(classifyToolKind("cua_repl.js", "await cua.getState()")).toBe("browser");
    expect(classifyToolKind("命令", `/bin/zsh -lc "sed -n '800,850p' a.js; rg -n 'x' b.ts | head -40"`)).toBe("read");
    expect(classifyToolKind("bash", '{"command":"git diff --stat && git log -3"}')).toBe("git");
    expect(classifyToolKind("Bash", '{"command":"npx vitest run a.test.ts"}')).toBe("test");
    expect(classifyToolKind("命令", `/bin/zsh -lc "python3 - <<'PY'\nopen('a').write('x')\nPY"`)).toBe("edit");
    expect(classifyToolKind("bash", '{"command":"cat > a.ts <<EOF\nx\nEOF"}')).toBe("edit");
    // 重定向到 /dev/null、2>&1、箭头函数不算写文件
    expect(classifyToolKind("bash", '{"command":"rg -n foo src 2>&1 > /dev/null; ls"}')).toBe("read");
    expect(classifyToolKind("bash", `{"command":"rg -n '=> x' src"}`)).toBe("read");
    expect(classifyToolKind("memory_search", '{"query":"x"}')).toBe("other");
    expect(classifyToolKind("bash", '{"command":"deploy-it"}')).toBe("other");
  });
});

describe("buildTurnContextStats 工具输出构成", () => {
  const usage = (tokens: number): UsageRecord[] => [{
    usageScope: "turn", counterMode: "delta", raw: {}, contextTokens: tokens, contextWindow: 272_000,
    semantics: "test", sourceRef: "test", sampledAt: "2026-11-26T08:00:00.000Z", reliability: "complete"
  }];

  it("被截断的输出按原长计，名字和入参照常计入；构成按 tokens 降序并带调用次数", () => {
    const events: ProjectedEvent[] = [
      ev({ key: "t:1", seq: 1, turnNo: 1, kind: "tool", tool: { name: "命令", input: "sed -n 1,50p a.ts", output: "O".repeat(8_000) }, truncated: { originalChars: 60_000 } }),
      ev({ key: "t:2", seq: 2, turnNo: 1, kind: "tool", tool: { name: "bash", input: "git status", output: "G".repeat(10_000) } }),
      ev({ key: "t:3", seq: 3, turnNo: 1, kind: "tool", tool: { name: "bash", input: "git diff", output: "D".repeat(10_000) } })
    ];
    const stats = buildTurnContextStats({ runtimeKind: "codex", model: "gpt-5.4", turnNo: 1, events, usageRecords: usage(100_000) })!;
    const tb = stats.toolBreakdown!;
    expect(tb.map((x) => x.key)).toEqual(["read", "git"]);
    expect(tb[0]).toMatchObject({ label: "读代码与搜索", calls: 1 });
    expect(tb[1]).toMatchObject({ label: "Git", calls: 2 });
    // 原长 60k + 入参 17 + 名字 2 ≈ 60,019；git 两条共 ≈ 20,036 → 读搜约占 75%
    const tool = stats.parts.find((p) => p.key === "tool")!;
    expect(tb[0]!.tokens / tool.tokens).toBeCloseTo(60_019 / (60_019 + 20_036), 2);
  });

  it("工具输出占上下文不足 10% 或没有工具事件时不附带构成", () => {
    const small: ProjectedEvent[] = [
      ev({ key: "u:1", seq: 1, turnNo: 1, kind: "message", role: "user", text: "U".repeat(50_000) }),
      ev({ key: "t:1", seq: 2, turnNo: 1, kind: "tool", tool: { name: "bash", input: "ls", output: "x".repeat(1_000) } })
    ];
    expect(buildTurnContextStats({ runtimeKind: "pi", model: "deepseek-chat", turnNo: 1, events: small, usageRecords: usage(50_000) })!.toolBreakdown).toBeUndefined();
    const none: ProjectedEvent[] = [ev({ key: "u:1", seq: 1, turnNo: 1, kind: "message", role: "user", text: "hello" })];
    expect(buildTurnContextStats({ runtimeKind: "pi", turnNo: 1, events: none, usageRecords: usage(10_000) })!.toolBreakdown).toBeUndefined();
  });
});
