import { describe, expect, it } from "vitest";
import { beforeAfterFact, isProbeId, PROBE_CATALOG, readProbeStates } from "../src/memory-probes.js";
import { composeFeedback, isModelRule, probeIdsOf, modelRuleId, runModelRules, runRules, ruleTitleOf, turnEvidence, type ActiveRule, type TurnEvidence } from "../src/memory-enforcement.js";
import type { ProjectedEvent } from "../src/types.js";

/** DeepSeek 写的规则（模型判定）：没有对应代码，会话每轮结束由判定模型按四要素核对。 */
const SPEC = { node: "turn-end" as const, scope: "本回合有部署命令才检查", criteria: "部署前要有用户确认", feedback: "先停下，等用户确认后再部署" };
const MODEL: ActiveRule = { topicId: "t1", ruleId: modelRuleId("t1"), statement: "部署前必须确认。", topic: "部署确认", title: "部署前先确认", spec: SPEC };
const CODE: ActiveRule = { topicId: "t2", ruleId: "beijing-time", statement: "时间以北京时间为主。", topic: "时间" };
const EV: TurnEvidence = { assistantText: "已部署。", editInputs: [] };

describe("模型判定的规则", () => {
  it("登记的规则由谁判：有代码规则 → 代码；只有四要素 → 模型；规则名优先代码，其次 DeepSeek 写的标题", () => {
    expect(isModelRule(MODEL)).toBe(true);
    expect(isModelRule(CODE)).toBe(false);
    expect(isModelRule({ ...MODEL, ruleId: "ui-change-screenshot-table" })).toBe(false);
    expect(ruleTitleOf(MODEL)).toBe("部署前先确认");
    expect(ruleTitleOf(CODE)).toBe("对外的时间表达默认用北京时间（UTC+8）");
    expect(ruleTitleOf({ ruleId: "model:x" })).toBe("model:x");
  });
  it("同步的代码规则跳过模型规则（不会因为找不到代码规则就当通过 / 失败）", () => {
    const r = runRules([MODEL], EV);
    expect(r).toEqual({ failed: [], passed: [], skipped: [] });
  });
  it("不通过 / 通过 / 不在范围内（放行不留痕）/ 判定失败（放行并留「未检查」）", async () => {
    const calls: string[] = [];
    const judge = async ({ rule }: { rule: ActiveRule; evidence: TurnEvidence }) => {
      calls.push(rule.topicId);
      return rule.topicId === "bad" ? { applies: true, pass: false, problem: "没确认就部署了", fix: "1. 先停下" }
        : rule.topicId === "ok" ? { applies: true, pass: true }
        : rule.topicId === "na" ? { applies: false, pass: true }
        : rule.topicId === "boom" ? (() => { throw new Error("挂了"); })() : null;
    };
    const mk = (id: string): ActiveRule => ({ ...MODEL, topicId: id, ruleId: modelRuleId(id) });
    const r = await runModelRules([mk("bad"), mk("ok"), mk("na"), mk("boom"), mk("nul"), CODE], EV, judge);
    expect(calls.sort()).toEqual(["bad", "boom", "na", "nul", "ok"]);   // 代码规则不走模型
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ title: "部署前先确认", problem: "没确认就部署了", fix: "1. 先停下" });
    expect(r.passed.map((a) => a.topicId)).toEqual(["ok"]);
    expect(r.skipped.map((x) => x.rule.topicId).sort()).toEqual(["boom", "nul"]);
  });
  it("判不通过但没写改法：用规则里「结果反馈」兜底；反馈消息引用记忆原句和规则名", async () => {
    const r = await runModelRules([MODEL], EV, async () => ({ applies: true, pass: false, problem: "没确认" }));
    expect(r.failed[0]!.fix).toBe(SPEC.feedback);
    const text = composeFeedback(r.failed, 0);
    expect(text).toContain("记忆「部署确认」：部署前必须确认。");
    expect(text).toContain("检查项：部署前先确认");
    expect(text).toContain("没确认");
  });
  it("取证：本回合的工具调用（工具名：输入，截断）交给模型规则，只取本回合、最多 40 条", () => {
    const ev = (key: string, turnNo: number, extra: Partial<ProjectedEvent>): ProjectedEvent => ({ key, turnNo, kind: "tool", ...extra } as ProjectedEvent);
    const events = [
      ev("a", 1, { tool: { name: "Bash", input: "echo 旧回合" } as never }),
      ...Array.from({ length: 45 }, (_, i) => ev(`b${i}`, 2, { tool: { name: "Bash", input: i === 0 ? `deploy\n  --x ${"y".repeat(400)}` : `ls ${i}` } as never }))
    ];
    const out = turnEvidence(events, 2).toolCalls!;
    expect(out).toHaveLength(40);
    expect(out[0]!.startsWith("Bash：deploy --x y")).toBe(true);
    expect(out[0]!.length).toBeLessThanOrEqual(310);
    expect(out.join("\n")).not.toContain("旧回合");
  });
  it("取证：工具调用带输出末尾（判定模型能看到命令真的跑出了什么）", () => {
    const ev = [
      { key: "a", turnNo: 1, kind: "tool", tool: { name: "Bash", input: "node package-release.mjs", output: `${"x".repeat(500)}\n发布完成 versionCode=42` } },
      { key: "b", turnNo: 1, kind: "tool", tool: { name: "Read", input: "a.ts" } }
    ] as unknown as ProjectedEvent[];
    const out = turnEvidence(ev, 1).toolCalls!;
    expect(out[0]).toContain("⇒ ");
    expect(out[0]).toContain("发布完成 versionCode=42");
    expect(out[0]!.length).toBeLessThan(300);
    expect(out[1]).toBe("Read：a.ts");
  });
});

describe("取证项（功能事实）", () => {
  it("目录：改动文件 / 原生 App 发布 / 线上部署；规则用到的取证项按登记的规则汇总（去重，代码规则和没声明的不算）", () => {
    expect(PROBE_CATALOG.map((p) => p.id)).toEqual(["changed-files", "android-release", "live-deploy"]);
    expect(isProbeId("android-release")).toBe(true);
    expect(isProbeId("nope")).toBe(false);
    const a: ActiveRule = { ...MODEL, spec: { ...SPEC, probes: ["changed-files", "android-release"] } };
    const b: ActiveRule = { ...MODEL, topicId: "t3", ruleId: modelRuleId("t3"), spec: { ...SPEC, probes: ["android-release"] } };
    expect(probeIdsOf([a, b, CODE, MODEL])).toEqual(["changed-files", "android-release"]);
  });
  it("前后对比：有基线才下结论；没基线不给 changed", () => {
    expect(beforeAfterFact({ versionCode: 41 }, { versionCode: 42 }, true)).toEqual({ before: { versionCode: 41 }, after: { versionCode: 42 }, changed: true });
    expect(beforeAfterFact({ versionCode: 41 }, { versionCode: 41 }, true)).toMatchObject({ changed: false });
    expect(beforeAfterFact(undefined, { versionCode: 41 }, false)).not.toHaveProperty("changed");
    expect(beforeAfterFact(undefined, { versionCode: 1 }, true)).toMatchObject({ before: null, changed: true });
  });
  it("读取：失败的项没有事实、不影响别的项；超时不卡住", async () => {
    const out = await readProbeStates(["android-release", "live-deploy", "changed-files"], {
      "android-release": async () => ({ versionCode: 1 }), "live-deploy": async () => { throw new Error("boom"); }
    });
    expect(out).toEqual({ "android-release": { versionCode: 1 } });
    const slow = await readProbeStates(["live-deploy"], { "live-deploy": () => new Promise(() => {}) }, 30);
    expect(slow).toEqual({});
  });
});
