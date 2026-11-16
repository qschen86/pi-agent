import { describe, expect, it } from "vitest";
import { ENFORCEMENT_RULES, enforcementRule } from "../src/memory-enforcement.js";
import { ACCEPTANCE, HOLDOUT, type RuleCase } from "./memory-rules-cases.js";

/** 最终判定：本回合不相关就放行，相关再看 check。 */
const verdict = (id: string, ev: RuleCase[1]) => { const r = enforcementRule(id)!; return r.applies(ev) ? r.check(ev) : { pass: true as const }; };

describe("检测规则的四要素齐全（校验节点 / 校验对象范围 / 校验规则 / 结果反馈）", () => {
  for (const r of ENFORCEMENT_RULES) it(`${r.id}`, () => {
    expect(r.node).toBe("turn-end");
    for (const field of [r.scope, r.criteria, r.feedback, r.title, r.description]) expect(field.length).toBeGreaterThan(15);
    expect(typeof r.applies).toBe("function"); expect(typeof r.check).toBe("function"); expect(typeof r.fits).toBe("function");
  });
});

for (const [label, table] of [["验收用例", ACCEPTANCE], ["留出用例（模型没见过）", HOLDOUT]] as const) {
  for (const [id, cases] of Object.entries(table)) describe(`${id}：${label}`, () => {
    for (const [name, ev, shouldFail] of cases) it(`${name}：${shouldFail ? "判违规" : "放行不误报"}`, () => {
      const v = verdict(id, ev);
      expect(v.pass).toBe(!shouldFail);
      if (shouldFail) { expect((v as { problem?: string }).problem).toBeTruthy(); expect((v as { fix?: string }).fix).toBeTruthy(); }
    });
  });
}

describe("规则只挂给语义一致的记忆（fits）", () => {
  it("入口域名 / 北京时间 / 截图汇报互不串", () => {
    const entry = "所有入口链接和验收核查都使用 gui-backup-cn.harness.fund，不再用 gui.harness.fund。";
    const time = "时间表达默认按北京时间（UTC+8）：日历、定时任务、新建日程和与用户沟通的时间一律以北京时间为准。";
    const shot = "界面改动后先给真实渲染截图（浅色/夜间、多宽度，表格对照改前改后）。";
    const spacing = "各应用标题栏下方到子 tab 的这段间距要统一为 12px。";
    const deploy = "改动前先确认需求和方案；用户确认部署后，若涉及原生 App，部署就包含 App 的发布。";
    const fits = (id: string, s: string) => enforcementRule(id)!.fits(s);
    expect([fits("entry-domain", entry), fits("beijing-time", time), fits("ui-change-screenshot-table", shot)]).toEqual([true, true, true]);
    for (const s of [spacing, deploy]) for (const id of ["entry-domain", "beijing-time", "ui-change-screenshot-table"]) expect(fits(id, s), `${id} ← ${s}`).toBe(false);
    expect([fits("entry-domain", time), fits("entry-domain", shot), fits("beijing-time", entry), fits("beijing-time", shot), fits("ui-change-screenshot-table", entry), fits("ui-change-screenshot-table", time)]).toEqual([false, false, false, false, false, false]);
  });
});
