/**
 * 角色模型调用端口（v2.0 C4）：结构化输出、有限修复、逐次审计。模型用假的端口代替，行为确定。
 */
import { describe, expect, it } from "vitest";
import { extractJson, invokeStructured, schemaValidator } from "../src/index.js";
import type { ModelInvocationPort, RoleModelConfig } from "../src/index.js";
import { parsePiJson } from "@pi-agent/adapter-pi";

const CONFIG: RoleModelConfig = { role: "probe", provider: "zhipu", model: "glm-5.3-flash", promptVersion: "p1", schemaVersion: "s1", timeoutMs: 1000, maxAttempts: 2 };
const SCHEMA = { type: "object", required: ["items"], additionalProperties: false, properties: { items: { type: "array", items: { type: "string" } } } };
const usage = { input: 10, output: 5, reasoning: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };

function scripted(outputs: Array<string | Error>): ModelInvocationPort & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    complete: async (_c, call) => {
      prompts.push(call.prompt);
      const o = outputs[i++];
      if (o instanceof Error) throw o;
      return { text: o ?? "", usage, model: "glm-5.3-flash", durationMs: 7 };
    }
  };
}

describe("extractJson", () => {
  it("优先取 ```json 代码块；否则取第一个配平的对象，字符串里的括号不干扰", () => {
    expect(extractJson("说明\n```json\n{\"a\":1}\n```\n尾巴")).toEqual({ a: 1 });
    expect(extractJson("结果是 {\"q\":\"含 } 的字符串\",\"n\":[1,{\"b\":2}]} 以上")).toEqual({ q: "含 } 的字符串", n: [1, { b: 2 }] });
    expect(() => extractJson("没有 JSON")).toThrowError(/没有 JSON/);
  });
});

describe("invokeStructured", () => {
  it("一次合格：返回值、调用记录（只有哈希不含原文）、用量", async () => {
    const port = scripted(["```json\n{\"items\":[\"x\"]}\n```"]);
    const r = await invokeStructured<{ items: string[] }>(port, CONFIG, { system: "sys", prompt: "task" }, schemaValidator(SCHEMA));
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ items: ["x"] });
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ status: "ok", inputHash: expect.stringMatching(/^sha256:/), outputHash: expect.stringMatching(/^sha256:/) });
    expect(JSON.stringify(r)).not.toContain("task");
    expect(r.usage).toEqual({ input: 10, output: 5, reasoning: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 15 });
    expect(r.roleRunId).toMatch(/^rr_/);
  });

  it("校验不合格 → 带着错误修复一次 → 合格；两次用量都计入", async () => {
    const port = scripted(["{\"items\":[1]}", "{\"items\":[\"ok\"]}"]);
    const r = await invokeStructured(port, CONFIG, { system: "s", prompt: "原始任务" }, schemaValidator(SCHEMA));
    expect(r.ok).toBe(true);
    expect(r.attempts.map((a) => a.status)).toEqual(["schema-error", "ok"]);
    expect(port.prompts[1]).toContain("原始任务");
    expect(port.prompts[1]).toMatch(/上一次的输出不合格[\s\S]*items\/0/);
    expect(r.usage.totalTokens).toBe(30);
  });

  it("用完尝试次数仍不合格：失败，不降级放行", async () => {
    const port = scripted(["不是 JSON", "{\"wrong\":true}"]);
    const r = await invokeStructured(port, CONFIG, { system: "s", prompt: "p" }, schemaValidator(SCHEMA));
    expect(r.ok).toBe(false);
    expect(r.value).toBeUndefined();
    expect(r.attempts.map((a) => a.status)).toEqual(["parse-error", "schema-error"]);
    expect(r.error).toMatch(/2 次尝试内没有产出合格结果/);
  });

  it("调用失败也占用尝试次数，并如实记录", async () => {
    const port = scripted([new Error("pi 生成超时（1000ms）"), "{\"items\":[]}"]);
    const r = await invokeStructured(port, CONFIG, { system: "s", prompt: "p" }, schemaValidator(SCHEMA));
    expect(r.ok).toBe(true);
    expect(r.attempts[0]).toMatchObject({ status: "call-error", error: expect.stringContaining("超时") });
  });
});

describe("parsePiJson", () => {
  it("取最后一条助手 message_end：只要正文，不要思考过程；带真实用量", () => {
    const lines = [
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "问题" }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "zhipu", model: "glm-5.3-flash", stopReason: "stop",
        content: [{ type: "thinking", thinking: "内部推理" }, { type: "text", text: "{\"ok\":true}" }],
        usage: { input: 32, output: 65, reasoning: 58, cacheRead: 0, cacheWrite: 0, totalTokens: 97, cost: { total: 0 } } } }),
      "诊断输出"
    ].join("\n");
    const r = parsePiJson(lines);
    expect(r).toMatchObject({ text: "{\"ok\":true}", model: "glm-5.3-flash", stopReason: "stop", usage: { input: 32, output: 65, reasoning: 58, totalTokens: 97 } });
    expect(JSON.stringify(r)).not.toContain("内部推理");
  });

  it("模型报错（stopReason=error）如实抛出", () => {
    const line = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "余额不足", content: [] } });
    expect(() => parsePiJson(line)).toThrowError(/余额不足/);
  });
});
