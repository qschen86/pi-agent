import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SchemaRegistry,
  SCHEMA_NAMES,
  loadSchemaJson,
  validateAgentDefinitionSemantics,
  validateTaskContractSemantics,
  validateWorkflowDefinitionSemantics,
  migrateToV1
} from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

function listJson(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listJson(p).map((x) => join(name, x)));
    else if (name.endsWith(".json")) out.push(join(name));
  }
  return out;
}

describe("Schema 发布门（AP-SCHEMA-002 §Schema 发布门）", () => {
  it("31 类 Schema 全部存在且 Meta-schema 自校验通过（含 V3.1 验收及版本化记录）", () => {
    expect(SCHEMA_NAMES).toHaveLength(31);
    expect(() => new SchemaRegistry()).not.toThrow();
    for (const name of SCHEMA_NAMES) {
      const json = loadSchemaJson(name) as Record<string, unknown>;
      expect(json["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(json["$id"]).toContain(name);
    }
  });
});

describe("Fixture 全量回归（09 计划 §4：fixtures 结果与预期一致）", () => {
  const registry = new SchemaRegistry();

  const semanticValidators: Record<string, (v: unknown) => { ok: boolean; errors: string[] }> = {
    "agent-definition": validateAgentDefinitionSemantics,
    "task-contract": validateTaskContractSemantics,
    "workflow-definition": validateWorkflowDefinitionSemantics
  };

  it("valid/：每个样例通过对应 Schema 与语义校验", () => {
    const files = listJson(join(FIXTURES, "valid"));
    expect(files.length).toBeGreaterThanOrEqual(27); // 9 类 × 至少 3 例
    for (const rel of files) {
      const schemaName = rel.split("/")[0];
      const value = JSON.parse(readFileSync(join(FIXTURES, "valid", rel), "utf8"));
      const r = registry.validate(schemaName as never, value);
      if (!r.ok) throw new Error(`valid fixture ${rel} 校验失败: ${r.errors.join("; ")}`);
      const sem = semanticValidators[schemaName];
      if (sem) {
        const s = sem(value);
        if (!s.ok) throw new Error(`valid fixture ${rel} 语义校验失败: ${s.errors.join("; ")}`);
      }
    }
  });

  it("invalid/：每个样例被拒绝，且错误信息命中预期字段路径", () => {
    const dir = join(FIXTURES, "invalid");
    const schemas = readdirSync(dir);
    let count = 0;
    for (const schema of schemas) {
      for (const rel of listJson(join(dir, schema))) {
        if (!rel.endsWith(".json")) continue;
        count += 1;
        const value = JSON.parse(readFileSync(join(dir, schema, rel), "utf8"));
        const r = registry.validate(schema as never, value);
        let expectation: { errorContains?: string[]; semantics?: string } = {};
        try {
          expectation = JSON.parse(readFileSync(join(dir, schema, rel.replace(/\.json$/, ".expect.json")), "utf8"));
        } catch {
          // 无 sidecar
        }
        if (expectation.semantics && expectation.semantics in semanticValidators) {
          // 语义非法样例：结构可合法，语义校验必须失败
          expect(semanticValidators[expectation.semantics](value).ok, `${schema}/${rel} 语义校验应失败`).toBe(false);
        } else {
          expect(r.ok, `${schema}/${rel} 应当无效`).toBe(false);
          for (const frag of expectation.errorContains ?? []) {
            expect(r.errors.join(" "), `${schema}/${rel} 错误应包含 ${frag}`).toContain(frag);
          }
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(21); // 缺字段/越权/未知枚举/错误版本 × 多 Schema
  });

  it("edge-cases/：空集合、最大/最小预算、Unicode 路径、循环引用全部被接受（结构合法）", () => {
    const edgeDir = join(FIXTURES, "edge-cases");
    for (const schema of readdirSync(edgeDir)) {
      for (const rel of listJson(join(edgeDir, schema))) {
        if (!rel.endsWith(".json")) continue;
        const value = JSON.parse(readFileSync(join(edgeDir, schema, rel), "utf8"));
        const r = registry.validate(schema as never, value);
        if (!r.ok) throw new Error(`edge fixture ${schema}/${rel} 校验失败: ${r.errors.join("; ")}`);
      }
    }
  });

  it("migrations/：v0 → v1 纯函数迁移，输出与预期一致且原对象不被修改", () => {
    const input = JSON.parse(readFileSync(join(FIXTURES, "migrations/v0-to-v1/input.json"), "utf8"));
    const expected = JSON.parse(readFileSync(join(FIXTURES, "migrations/v0-to-v1/expected.json"), "utf8"));
    const snapshotBefore = JSON.stringify(input);
    const { migrated, report } = migrateToV1(input);
    expect(report.fromApiVersion).toBe("agent.platform/v0");
    expect(report.changes.length).toBeGreaterThan(0);
    expect(migrated).toEqual(expected);
    expect(JSON.stringify(input)).toBe(snapshotBefore); // 原对象保留
  });
});

describe("扩展与未知字段（AP-SCHEMA-002 §6）", () => {
  const registry = new SchemaRegistry();

  it("x-* 扩展字段被接受（读取方必须忽略）", () => {
    const agent = JSON.parse(readFileSync(join(FIXTURES, "valid/agent-definition/A1.json"), "utf8"));
    (agent as Record<string, unknown>)["x-trace"] = { team: "platform" };
    expect(registry.validate("agent-definition", agent).ok).toBe(true);
  });

  it("未知核心字段被拒绝", () => {
    const agent = JSON.parse(readFileSync(join(FIXTURES, "valid/agent-definition/A1.json"), "utf8"));
    (agent as Record<string, unknown>)["runtimePrivate"] = { token: "x" };
    expect(registry.validate("agent-definition", agent).ok).toBe(false);
  });
});

void relative;
