/**
 * Canonicalizer（09 计划 §6 模块 1 / AP-COMP-003 §4）。
 *
 * - canonicalJson：JCS(RFC 8785) 子集——对象键按 UTF-16 码元排序、无空白、
 *   数字采用 ES Number::toString（JSON.stringify 一致）、字符串按 JSON 转义。
 * - 相同对象规范化后字节一致（G2 确定性门禁的基础）。
 * - sha256Hex / planHash：内容寻址；planHash = "sha256:" + SHA256(canonicalJson(plan without signature))。
 *
 * 领域内核约束（09 计划 §6 关键编码约束）：本模块不读取系统时间、随机数、
 * 环境变量或网络；哈希是内容的确定性函数。
 */
import { createHash } from "node:crypto";
export type CanonicalValue = unknown;

export class NonDeterministicError extends Error {
  readonly code = "NON_DETERMINISTIC";
  constructor(message: string) {
    super(`[NON_DETERMINISTIC] ${message}`);
    this.name = "NonDeterministicError";
  }
}

export function canonicalJson(value: CanonicalValue): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new NonDeterministicError("非有限数字无法参与规范化哈希");
    }
    if (Object.is(n, -0)) return "0";
    return JSON.stringify(n);
  }
  if (t === "string") return JSON.stringify(value as string);
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      if (item === undefined) throw new NonDeterministicError("数组中出现 undefined");
      return canonicalJson(item);
    });
    return `[${parts.join(",")}]`;
  }
  const obj = value as { [k: string]: CanonicalValue };
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue; // undefined 属性视为不存在
    parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function sha256OfValue(value: CanonicalValue): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/**
 * 确定性 eventId：由流标识 + 版本推导的 UUIDv5 形态 id（无随机数参与）。
 */
export function deterministicUuid(namespace: string, ...parts: string[]): string {
  const h = sha256Hex(`${namespace}|${parts.join("|")}`);
  const bytes = h.slice(0, 32);
  return [
    bytes.slice(0, 8),
    bytes.slice(8, 12),
    `5${bytes.slice(13, 16)}`, // version 5
    ((parseInt(bytes.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + bytes.slice(17, 20), // variant
    bytes.slice(20, 32)
  ].join("-");
}
