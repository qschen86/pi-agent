import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mergePermissions, normalizePath, pathWithin } from "../src/permission-engine.js";
import type { PermissionLayer } from "../src/permission-engine.js";
import { PlatformError } from "../src/errors.js";

function layer(name: string, read: string[], write: string[], tools: string[], extra: Partial<PermissionLayer> = {}): PermissionLayer {
  return {
    name,
    filesystem: { read, write },
    network: { default: "deny", allow: [] },
    tools: { allow: tools },
    ...extra
  };
}

const BASE_LAYERS = () => [
  layer("agent", ["/workspace/in"], ["/workspace/out"], ["fs.read", "fs.write"]),
  layer("task", ["/workspace/in", "/workspace/extra"], ["/workspace/out", "/tmp"], ["fs.read", "fs.write", "test.run"]),
  layer("organization", ["/workspace"], ["/workspace"], ["fs.read", "fs.write", "test.run", "http.get"], {
    approvals: { sideEffects: "REVIEW" },
    budget: { tokens: 100000, toolCalls: 300 }
  }),
  layer("runtime", ["/"], ["/"], ["fs.read", "fs.write", "test.run", "shell.run"]),
  layer("infrastructure", ["/"], ["/workspace"], ["fs.read", "fs.write", "test.run", "http.get"], {
    deny: [{ resource: "credential", pattern: "*", reason: "L4" }]
  })
];

describe("Permission Engine（09 计划 §6 模块 3 / INV-02）", () => {
  it("五层取交集：task 的 /tmp 被 organization 收紧掉", () => {
    const eff = mergePermissions(BASE_LAYERS());
    expect(eff.filesystem.read).toEqual(["/workspace/in"]);
    expect(eff.filesystem.write).toEqual(["/workspace/out"]);
    expect(eff.tools.allow.sort()).toEqual(["fs.read", "fs.write"].sort());
    expect(eff.approvals.sideEffects).toBe("REVIEW");
    expect(eff.budget.tokens).toBe(100000);
    expect(eff.budget.toolCalls).toBe(300);
    expect(eff.deny).toHaveLength(1);
  });

  it("授权交集为空 → POLICY_EMPTY_SET（要求修改 Contract）", () => {
    const ls = BASE_LAYERS();
    (ls[1].filesystem as { read: string[] }).read = ["/var/data"];
    try {
      mergePermissions(ls);
      expect.unreachable();
    } catch (e) {
      expect((e as PlatformError).code).toBe("POLICY_EMPTY_SET");
    }
  });

  it("deny 并集：任何一层 deny 的工具不可用且不可覆盖", () => {
    const ls = BASE_LAYERS();
    ls[0].tools = { allow: ["fs.read", "fs.write", "shell.run"], deny: ["shell.run"] };
    ls[3].tools = { allow: ["fs.read", "fs.write", "shell.run"] };
    const eff = mergePermissions(ls);
    expect(eff.tools.allow).not.toContain("shell.run");
  });

  it("预算取最小值、审批取最严格（AUTO < REVIEW < DUAL）", () => {
    const ls = BASE_LAYERS();
    ls[0].budget = { tokens: 5000, wallTimeMs: 1000 };
    ls[1].approvals = { sideEffects: "DUAL" };
    const eff = mergePermissions(ls);
    expect(eff.budget.tokens).toBe(5000);
    expect(eff.budget.wallTimeMs).toBe(1000);
    expect(eff.approvals.sideEffects).toBe("DUAL");
  });

  it("网络 default=deny 优先：任何一层拒绝即整体拒绝", () => {
    const ls = BASE_LAYERS();
    ls[0].network = { default: "deny", allow: ["a.example.com"] };
    ls[1].network = { default: "allow", allow: ["a.example.com", "b.example.com"] };
    ls[2].network = { default: "deny", allow: ["a.example.com"] };
    ls[3].network = { default: "allow", allow: ["a.example.com"] };
    ls[4].network = { default: "allow", allow: ["a.example.com"] };
    const eff = mergePermissions(ls);
    expect(eff.network.default).toBe("deny");
    expect(eff.network.allow).toEqual(["a.example.com"]);
  });

  it("属性（10000 样例，09 计划 §5）：交集结果不得放大任何一层授权", () => {
    const pathArb = fc.constantFrom("/w/a", "/w", "/w/a/b", "/x", "/w/b");
    const toolsArb = fc.constantFrom("t1", "t2", "t3");

    const layerArb = fc.record({
      name: fc.string({ minLength: 1, maxLength: 8 }),
      read: fc.array(pathArb, { minLength: 1, maxLength: 3 }),
      write: fc.array(pathArb, { minLength: 1, maxLength: 3 }),
      tools: fc.array(toolsArb, { minLength: 1, maxLength: 3 })
    });

    const property = fc.property(
      fc.array(layerArb, { minLength: 2, maxLength: 5 }),
      (ls) => {
        const layers: PermissionLayer[] = ls.map((l) => ({
          name: l.name,
          filesystem: { read: l.read, write: l.write },
          network: { default: "deny", allow: [] },
          tools: { allow: l.tools }
        }));
        let eff;
        try {
          eff = mergePermissions(layers);
        } catch (e) {
          return (e as PlatformError).code === "POLICY_EMPTY_SET";
        }
        // INV-02：任何一层不得放大——结果必须 ⊆ 每一层的授权。
        return layers.every((l) => {
          const readOk = eff.filesystem.read.every((p) => l.filesystem!.read.some((q) => pathWithin(p, q)));
          const writeOk = eff.filesystem.write.every((p) => l.filesystem!.write.some((q) => pathWithin(p, q)));
          const toolsOk = eff.tools.allow.every((t) => l.tools!.allow.includes(t));
          return readOk && writeOk && toolsOk;
        });
      }
    );
    // 09 计划 §5 测试先行策略：Property 至少 10000 个随机样例。
    fc.assert(property, { numRuns: 10000 });
  });
});

describe("路径规范化（AP-POLICY-004 §7 路径逃逸防线）", () => {
  it("解析 . 与 ..、去尾斜杠、NFC", () => {
    expect(normalizePath("/w/a/../b/")).toBe("/w/b");
    expect(normalizePath("/w/./c")).toBe("/w/c");
    expect(normalizePath("/w/é")).toBe("/w/é");
  });

  it("越过根的 .. 拒绝；空字节拒绝；相对路径拒绝", () => {
    expect(() => normalizePath("/../etc")).toThrow();
    expect(() => normalizePath("/w/\0x")).toThrow();
    expect(() => normalizePath("w/x")).toThrow();
  });

  it("pathWithin 包含判定", () => {
    expect(pathWithin("/w/a/b", "/w")).toBe(true);
    expect(pathWithin("/w/a", "/w/a")).toBe(true);
    expect(pathWithin("/w/ab", "/w/a")).toBe(false);
    expect(pathWithin("/etc/passwd", "/workspace/out")).toBe(false);
  });
});
