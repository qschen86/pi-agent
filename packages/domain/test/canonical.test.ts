import { describe, expect, it } from "vitest";
import { canonicalJson, deterministicUuid, sha256Hex, sha256OfValue } from "../src/canonical.js";
import fc from "fast-check";

describe("Canonicalizer（09 计划 §6 模块 1 / G2 确定性）", () => {
  it("对象键按 UTF-16 码元排序，与输入顺序无关", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("嵌套结构与数组（数组保持顺序）规范化一致", () => {
    expect(canonicalJson([{ z: 1, y: [true, null] }, { x: "s" }])).toBe('[{"y":[true,null],"z":1},{"x":"s"}]');
  });

  it("数字格式固定：-0 → 0，非有限数字拒绝", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(1e21)).toBe("1e+21");
    expect(() => canonicalJson(NaN)).toThrow(/NON_DETERMINISTIC/);
    expect(() => canonicalJson(Infinity)).toThrow(/NON_DETERMINISTIC/);
  });

  it("属性：任意 JSON 值规范化后重新解析再规范化字节一致（幂等）", () => {
    const arb = fc.jsonValue();
    // 实现确定性核心属性，采样量高于常规单元测试。
    fc.assert(
      fc.property(arb, (v) => {
        const once = canonicalJson(v);
        const reparsed = JSON.parse(once) as unknown;
        return once === canonicalJson(reparsed as never);
      }),
      { numRuns: 2000 }
    );
  });

  it("sha256 与 planHash 形态固定", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256OfValue({ a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sha256OfValue({ a: 1, b: 2 })).toBe(sha256OfValue({ b: 2, a: 1 }));
  });

  it("deterministicUuid 确定性且形如 UUIDv5", () => {
    const a = deterministicUuid("ns", "x", "1");
    const b = deterministicUuid("ns", "x", "1");
    const c = deterministicUuid("ns", "x", "2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
