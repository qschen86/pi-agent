/**
 * v2.3 P1：模型调用登记与推理强度。元数据与正文分开交给登记出口；登记失败不影响调用。
 */
import { describe, expect, it } from "vitest";
import { configHashOf, errorClassOf, invokeStructured, observedPort, requestedThinking, schemaValidator } from "../src/index.js";
import type { ModelCallContent, ModelCallRecord, ModelInvocationPort, RoleModelConfig } from "../src/index.js";

const CONFIG: RoleModelConfig = { role: "acceptanceJudge", provider: "zhipu", model: "glm-5.3-flash", promptVersion: "p1", schemaVersion: "s1", timeoutMs: 1000, maxAttempts: 2 };
const usage = { input: 100, output: 20, reasoning: 15, cacheRead: 64, cacheWrite: 0, totalTokens: 120 };

function scripted(outputs: Array<string | Error>): ModelInvocationPort {
  let i = 0;
  return {
    complete: async () => {
      const o = outputs[i++];
      if (o instanceof Error) throw o;
      return { text: o ?? "", usage, model: "glm-5.3-flash", stopReason: "stop", durationMs: 7 };
    }
  };
}

function sink(): { calls: Array<{ meta: ModelCallRecord; content: ModelCallContent }>; record: (m: ModelCallRecord, c: ModelCallContent) => void } {
  const calls: Array<{ meta: ModelCallRecord; content: ModelCallContent }> = [];
  return { calls, record: (meta, content) => calls.push({ meta, content }) };
}

describe("调用登记（observedPort）", () => {
  it("每次调用（含修复重试）各记一条：元数据带登记范围、模型、推理强度、用量（含缓存），正文单独交出", async () => {
    const s = sink();
    const port = observedPort(scripted(["不是 JSON", "{\"items\":[]}"]), s, { module: "acceptance", sessionId: "s-abc123", jobId: "aj-1", deliveryRevision: 2 });
    const r = await invokeStructured(port, CONFIG, { system: "sys", prompt: "task" }, schemaValidator({ type: "object" }));
    expect(r.ok).toBe(true);
    expect(r.usage).toMatchObject({ cacheRead: 128, totalTokens: 240 });
    expect(s.calls.map((c) => c.meta.seq)).toEqual([1, 2]);
    const m = s.calls[0].meta;
    expect(m).toMatchObject({
      role: "acceptanceJudge", scope: { module: "acceptance", sessionId: "s-abc123", jobId: "aj-1", deliveryRevision: 2 },
      provider: "zhipu", model: "glm-5.3-flash", respondedModel: "glm-5.3-flash", stopReason: "stop", status: "ok",
      thinking: { requested: "default", effective: "not_collected" }, usage, configHash: configHashOf(CONFIG), promptVersion: "p1"
    });
    expect(m.callId).toMatch(/^mc_[0-9a-f]{16}$/);
    expect(s.calls[1].meta.callId).not.toBe(m.callId);
    // 元数据里没有正文
    expect(JSON.stringify(m)).not.toContain("task");
    expect(s.calls[0].content).toEqual({ callId: m.callId, system: "sys", prompt: "task", response: "不是 JSON" });
    expect(s.calls[1].content.prompt).toContain("你上一次的输出不合格");
  });

  it("调用失败：记稳定的错误类别、用量未采集，异常照常抛给调用方；登记出口出错不影响调用", async () => {
    const s = sink();
    const port = observedPort(scripted([new Error("request timed out after 1000ms")]), s, { module: "requirement-fill", planId: "p-0123456789abcdef" });
    await expect(port.complete(CONFIG, { system: "a", prompt: "b" })).rejects.toThrowError(/timed out/);
    expect(s.calls[0].meta).toMatchObject({ status: "call-error", errorClass: "timeout", usage: "not_collected", scope: { planId: "p-0123456789abcdef" } });
    expect(s.calls[0].content.error).toContain("timed out");
    const broken = observedPort(scripted(["{}"]), { record: () => { throw new Error("disk full"); } }, { module: "x" });
    await expect(broken.complete(CONFIG, { system: "a", prompt: "b" })).resolves.toMatchObject({ text: "{}" });
    expect([errorClassOf("HTTP 401 Unauthorized"), errorClassOf("429 rate limit"), errorClassOf("OS 边界自检未通过"), errorClassOf("boom")]).toEqual(["auth", "rate-limit", "sandbox", "call-error"]);
  });
});

describe("推理强度", () => {
  it("显式配置优先，其次是模型名后缀，否则是默认；没配置时配置哈希不变", () => {
    expect(requestedThinking({ model: "glm-5.3-flash" })).toBe("default");
    expect(requestedThinking({ model: "glm-5.3-flash:off" })).toBe("off");
    expect(requestedThinking({ model: "glm-5.3-flash:off", thinking: "high" })).toBe("high");
    expect(requestedThinking({ model: "vendor:model-x" })).toBe("default");
    const { thinking: _t, ...plain } = { ...CONFIG, thinking: undefined };
    expect(configHashOf({ ...plain })).toBe(configHashOf(CONFIG));
    expect(configHashOf({ ...CONFIG, thinking: "low" })).not.toBe(configHashOf(CONFIG));
  });
});
