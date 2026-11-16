import { describe, expect, it } from "vitest";
import { resolveRef, assertNoCircularDeps } from "../src/version-resolver.js";
import { PlatformError } from "../src/errors.js";

const snapshot = {
  snapshotId: "snap-1",
  objects: [
    { key: "research-expert@1.0.0", version: "1.0.0", body: { kind: "AgentDefinition" } },
    { key: "report.publish@2.1.0", version: "2.1.0", body: { requires: ["notify.send@1.0.0"] } },
    { key: "notify.send@1.0.0", version: "1.0.0", body: { requires: [] } }
  ]
};

describe("Version Resolver（09 计划 §6 模块 2 / ADR-0103）", () => {
  it("精确 pin 命中 snapshot 返回对象体", () => {
    const r = resolveRef(snapshot, { ref: "research-expert@1.0.0", kind: "AgentDefinition" });
    expect(r.key).toBe("research-expert@1.0.0");
    expect(r.body).toBeDefined();
  });

  it("版本不存在 → REF_NOT_FOUND，禁止编译", () => {
    try {
      resolveRef(snapshot, { ref: "research-expert@9.9.9" });
      expect.unreachable();
    } catch (e) {
      expect((e as PlatformError).code).toBe("REF_NOT_FOUND");
    }
  });

  it("非精确引用（缺 @version）拒绝", () => {
    expect(() => resolveRef(snapshot, { ref: "research-expert" })).toThrow(/REF_NOT_FOUND/);
  });

  it("线性依赖链不误报环", () => {
    const nodes = new Map([
      ["report.publish@2.1.0", { key: "report.publish@2.1.0", requires: ["notify.send@1.0.0"] }],
      ["notify.send@1.0.0", { key: "notify.send@1.0.0", requires: [] }]
    ]);
    expect(() =>
      assertNoCircularDeps(nodes, "report.publish@2.1.0", (ref) => ref)
    ).not.toThrow();
  });

  it("循环引用 → CIRCULAR_REF 并给出环路径", () => {
    const nodes = new Map([
      ["a@1.0.0", { key: "a@1.0.0", requires: ["b@1.0.0"] }],
      ["b@1.0.0", { key: "b@1.0.0", requires: ["a@1.0.0"] }]
    ]);
    try {
      assertNoCircularDeps(nodes, "a@1.0.0", (ref) => ref);
      expect.unreachable();
    } catch (e) {
      const err = e as PlatformError;
      expect(err.code).toBe("CIRCULAR_REF");
      expect(err.message).toContain("a@1.0.0");
    }
  });
});
