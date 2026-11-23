/**
 * 设计手册（refine 阶段的交付物）：数据层校验、变更提案与确认、HTML 渲染、真实的「单词侦探」手册、
 * 以及 Review 引用「已确认手册」规则（两层标准的第二层）。
 *
 * 子应用不需要夜间主题（用户 2026-11-22）：这里专门守住「浅色应用的手册里不能出现夜间内容」。
 */
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLATFORM_SKILLS_ROOT } from "../src/platform-skills.js";

const SKILL = join(PLATFORM_SKILLS_ROOT, "ui-design-refinement");
const REPO = join(PLATFORM_SKILLS_ROOT, "../..");
const REAL_DESIGN = join(REPO, "apps/word-detective/.design");
const lib = async (name: string) => import(join(SKILL, "scripts/lib", name));
type Lib = Record<string, (...a: any[]) => any>;

const baseline = new Map([["PB-019", { title: "浅色与夜间", level: "必须" }], ["PB-024", { title: "字号", level: "建议" }], ["PB-021", { title: "主操作", level: "建议" }]]);
const CSS = `:root {\n  --ink: #26334d;\n  --r: 18px;\n  --shadow-sm: 0 2px 0 rgba(226, 210, 182, 0.75);\n}\n.btn { color: var(--ink); }\n.card { border-radius: var(--r); }\n`;

/** 一份最小但完整、合法的浅色手册（子应用）。 */
const fixture = (over: { manifest?: Record<string, unknown>; handbook?: Record<string, unknown> } = {}) => {
  const manifest = { schemaVersion: 1, appId: "demo-app", name: "示例", handbookVersion: "0.1.0", status: "draft", rulePrefix: "DM", themes: ["light"], baseline: { version: "v0.1" }, ...over.manifest };
  const handbook = {
    schemaVersion: 1, appId: "demo-app",
    overview: { positioning: "一个示例应用", keywords: ["简洁"], principles: [{ id: "P1", title: "清楚", text: "一屏一件事" }] },
    tokens: {
      themes: ["light"],
      colors: [{ group: "文字", name: "ink", var: "--ink", value: "#26334d", usage: "主文字" }],
      typography: { families: [{ name: "主字体", usage: "系统字体" }], scale: [{ size: "14px", usage: "正文" }] },
      radius: [{ name: "r", var: "--r", value: "18px", usage: "卡片" }],
      shadow: [{ name: "shadow-sm", var: "--shadow-sm", value: "0 2px 0 rgba(226, 210, 182, 0.75)", usage: "硬阴影" }],
      spacing: [{ value: "8px", count: 3 }], motion: [{ value: "120ms", usage: "按压" }]
    },
    components: [{ id: "button", name: "按钮", className: "btn", purpose: "主操作", specimen: { html: '<button class="btn">好的</button>' }, states: ["默认"], rules: ["DM-001"] }],
    interactions: [{ id: "tap", title: "点按", text: "点一下就响应", rules: [] }],
    pages: [{ id: "home", title: "首页", description: "首页", screenshots: [] }],
    rules: [{ id: "DM-001", level: "必须", title: "一屏一个主操作", text: "每屏一个主按钮", check: "视觉", source: "现状", inherits: "PB-021" }],
    baselineExceptions: [],
    ...over.handbook
  };
  return { manifest, handbook };
};
const ctx = (extra: Record<string, unknown> = {}) => ({ targetThemes: ["light"], baseline, css: CSS, checkFiles: false, ...extra });

describe("validateHandbook", () => {
  it("accepts a complete light-only handbook", async () => {
    const { validateHandbook } = await lib("handbook.mjs") as Lib;
    expect(validateHandbook(fixture(), ctx())).toEqual([]);
  });

  it("light-only apps: no dark theme, no dark colours, no dark screenshots (sub-apps need no dark theme)", async () => {
    const { validateHandbook } = await lib("handbook.mjs") as Lib;
    expect(validateHandbook(fixture({ manifest: { themes: ["light", "dark"] }, handbook: { tokens: { ...fixture().handbook.tokens, themes: ["light", "dark"] } } }), ctx()).join()).toContain("这个应用只允许 light");
    const dark = fixture();
    (dark.handbook.tokens as any).colors.push({ group: "文字", name: "ink-dark", value: "#eee", usage: "夜间文字", theme: "dark" });
    expect(validateHandbook(dark, ctx()).join()).toContain("浅色应用的手册里不能出现夜间色");
    const shot = fixture();
    (shot.handbook.pages as any)[0].screenshots = [{ file: "a.png", viewport: "390x844", theme: "dark", receiptId: "r-1", sha256: "a".repeat(64) }];
    expect(validateHandbook(shot, ctx()).join()).toContain("theme=dark 不在手册允许的主题里");
    const html = fixture(); (html.handbook.components as any)[0].purpose = "夜间模式下的按钮";
    expect(validateHandbook(html, ctx()).join()).toContain("浅色应用的手册里不能出现夜间内容");
    const mismatch = fixture(); (mismatch.handbook.tokens as any).themes = ["light", "dark"];
    expect(validateHandbook(mismatch, ctx()).join()).toContain("tokens.themes 必须与 manifest.themes 完全一致");
  });

  it("an app rule cannot relax a MUST baseline rule; SHOULD rules can have exceptions", async () => {
    const { validateHandbook } = await lib("handbook.mjs") as Lib;
    const must = fixture({ handbook: { baselineExceptions: [{ rule: "PB-019", reason: "不想做" }] } });
    expect(validateHandbook(must, ctx()).join()).toContain("「必须」级规则不能放宽");
    expect(validateHandbook(fixture({ handbook: { baselineExceptions: [{ rule: "PB-024", reason: "字号由内容决定" }] } }), ctx())).toEqual([]);
    expect(validateHandbook(fixture({ handbook: { baselineExceptions: [{ rule: "PB-999", reason: "x" }] } }), ctx()).join()).toContain("平台基线里没有这条规则");
  });

  it("detects drift between the handbook and the code: variable value, missing variable, missing class", async () => {
    const { validateHandbook } = await lib("handbook.mjs") as Lib;
    const v = fixture(); (v.handbook.tokens as any).colors[0].value = "#000000";
    expect(validateHandbook(v, ctx()).join()).toContain("手册与代码不一致：--ink 手册写 #000000，样式里是 #26334d");
    const m = fixture(); (m.handbook.tokens as any).colors[0].var = "--nope";
    expect(validateHandbook(m, ctx()).join()).toContain("变量 --nope 在样式里不存在");
    const c = fixture(); (c.handbook.components as any)[0].className = "btn gone";
    expect(validateHandbook(c, ctx()).join()).toContain("类名 .gone 在样式里不存在");
    expect(validateHandbook(fixture(), ctx({ css: undefined }))).toEqual([]);          // 没给样式就不对照
  });

  it("checks ids, levels, rule prefixes and references", async () => {
    const { validateHandbook } = await lib("handbook.mjs") as Lib;
    const dup = fixture(); (dup.handbook.rules as any).push({ ...(dup.handbook.rules as any)[0] });
    expect(validateHandbook(dup, ctx()).join()).toContain("规则：编号 DM-001 重复");
    const prefix = fixture(); (prefix.handbook.rules as any)[0].id = "XX-001";
    expect(validateHandbook(prefix, ctx()).join()).toContain("不合法");
    const level = fixture(); (level.handbook.rules as any)[0].level = "可选";
    expect(validateHandbook(level, ctx()).join()).toContain("level 必须是 必须 / 建议");
    const ref = fixture(); (ref.handbook.components as any)[0].rules = ["DM-099"];
    expect(validateHandbook(ref, ctx()).join()).toContain("引用了不存在的规则 DM-099");
    const pb = fixture(); (pb.handbook.rules as any)[0].inherits = "PB-999";
    expect(validateHandbook(pb, ctx()).join()).toContain("inherits 的 PB-999 不在平台基线里");
    expect(validateHandbook(fixture({ manifest: { rulePrefix: "PB" } }), ctx()).join()).toContain("不能是 PB");
  });

  it("specimens cannot carry scripts or event handlers; an approved handbook needs a human approver", async () => {
    const { validateHandbook } = await lib("handbook.mjs") as Lib;
    const s = fixture(); (s.handbook.components as any)[0].specimen.html = '<button onclick="x()">a</button>';
    expect(validateHandbook(s, ctx()).join()).toContain("标本里不能有脚本或事件属性");
    expect(validateHandbook(fixture({ manifest: { status: "approved" } }), ctx()).join()).toContain("必须有 approvedBy 和 approvedAt");
  });

  it("screenshots must exist and match their sha256", async () => {
    const { validateHandbook } = await lib("handbook.mjs") as Lib;
    const dir = mkdtempSync(join(tmpdir(), "hb-shots-")); mkdirSync(join(dir, "shots"));
    try {
      writeFileSync(join(dir, "shots/a.png"), "PNG");
      const sha = (await import("node:crypto")).createHash("sha256").update("PNG").digest("hex");
      const ok = fixture(); (ok.handbook.pages as any)[0].screenshots = [{ file: "a.png", viewport: "390x844", theme: "light", receiptId: "r-1", sha256: sha }];
      expect(validateHandbook(ok, ctx({ dir, checkFiles: true }))).toEqual([]);
      (ok.handbook.pages as any)[0].screenshots[0].sha256 = "b".repeat(64);
      expect(validateHandbook(ok, ctx({ dir, checkFiles: true })).join()).toContain("内容与登记的 sha256 不一致");
      (ok.handbook.pages as any)[0].screenshots[0].file = "missing.png";
      expect(validateHandbook(ok, ctx({ dir, checkFiles: true })).join()).toContain("截图文件不存在");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("change proposals: propose → decide → apply, and the first approval", () => {
  const draft = () => ({ title: "新增一条规则", reason: "Review 发现 F9", source: { kind: "review-finding", ref: "F9" }, items: [
    { op: "add", target: "rules", after: { id: "DM-002", level: "建议", title: "新规则", text: "文字", check: "视觉", source: "提案" }, why: "补一条" },
    { op: "modify", target: "rules", key: "DM-001", after: { text: "每屏只放一个主按钮" }, why: "更清楚" }] });
  const state = (over?: Parameters<typeof fixture>[0]) => ({ ...fixture(over), history: { entries: [] }, proposals: [] });

  it("creates a pending proposal with before-snapshots, and refuses impossible items", async () => {
    const { createProposal } = await lib("handbook.mjs") as Lib;
    const r = createProposal(draft(), state());
    expect(r.errors).toBeUndefined();
    expect(r.proposal).toMatchObject({ id: "P-001", status: "pending", baseVersion: "0.1.0" });
    expect(r.proposal.items[1].before.text).toBe("每屏一个主按钮");
    expect(r.proposal.items.every((i: any) => i.decision === null)).toBe(true);
    const bad = draft(); bad.items[0]!.after!.id = "DM-001"; bad.items[1]!.key = "DM-404"; delete (bad.items[1] as any).why;
    const e = createProposal(bad, state()).errors.join();
    expect(e).toContain("里已有 DM-001，不能新增"); expect(e).toContain("里没有 DM-404，不能修改"); expect(e).toContain("每条都要写 why");
    expect(createProposal({ title: "", reason: "", items: [] }, state()).errors.join()).toContain("title 和 reason");
    const two = createProposal(draft(), { ...state(), proposals: [r.proposal] });
    expect(two.proposal.id).toBe("P-002");
  });

  it("deciding needs a human (--by), a pending proposal, and known items", async () => {
    const { createProposal, decideProposal } = await lib("handbook.mjs") as Lib;
    const p = createProposal(draft(), state()).proposal;
    expect(decideProposal(p, { accept: ["i1"], reject: ["i2"] }).errors.join()).toContain("确认人 --by 不能为空");
    expect(decideProposal(p, { accept: ["i9"], by: "用户" }).errors.join()).toContain("提案里没有条目 i9");
    expect(decideProposal(p, { accept: ["i1"], reject: ["i1"], by: "用户" }).errors.join()).toContain("同时被接受和拒绝");
    const d = decideProposal(p, { accept: ["i1"], reject: ["i2"], by: "用户" }).proposal;
    expect(d.items.map((i: any) => i.decision)).toEqual(["accepted", "rejected"]);
    expect(d.decidedBy).toBe("用户");
    expect(decideProposal({ ...d, status: "applied" }, { accept: [], by: "用户" }).errors.join()).toContain("只有 pending 能确认");
  });

  it("applying merges only accepted items, bumps the minor version, writes history, and refuses stale or undecided proposals", async () => {
    const { createProposal, decideProposal, applyProposal } = await lib("handbook.mjs") as Lib;
    const st = state();
    const created = createProposal(draft(), st).proposal;
    expect(applyProposal(st, created, { ctx: ctx() }).errors.join()).toContain("还有条目没决定");
    const decided = decideProposal(created, { accept: ["i1"], reject: ["i2"], by: "用户" }).proposal;
    const r = applyProposal(st, decided, { ctx: ctx() });
    expect(r.errors).toBeUndefined();
    expect(r.manifest.handbookVersion).toBe("0.2.0");
    expect(r.handbook.rules.map((x: any) => x.id)).toEqual(["DM-001", "DM-002"]);
    expect(r.handbook.rules[0].text).toBe("每屏一个主按钮");                       // 被拒绝的修改没有合入
    expect(r.proposal).toMatchObject({ status: "applied", appliedVersion: "0.2.0" });
    expect(r.history.entries.at(-1)).toMatchObject({ version: "0.2.0", kind: "proposal", proposal: "P-001", by: "用户" });
    expect(r.history.entries.at(-1).accepted).toHaveLength(1); expect(r.history.entries.at(-1).rejected).toHaveLength(1);
  });

  it("a proposal made on an older version still applies when its items do not conflict; a conflicting item is refused", async () => {
    const { createProposal, decideProposal, applyProposal } = await lib("handbook.mjs") as Lib;
    const st = state();
    const decided = decideProposal(createProposal(draft(), st).proposal, { accept: ["i1", "i2"], by: "用户" }).proposal;     // 基于 0.1.0
    // 手册升到 0.2.0，但改的是别的条目：提案照常合入，并在版本记录里写明基于哪个版本
    const other = { ...st, manifest: { ...st.manifest, handbookVersion: "0.2.0" }, handbook: { ...st.handbook, interactions: [{ id: "tap", title: "点按", text: "点一下就响应，并有反馈", rules: [] }] } };
    const ok = applyProposal(other, decided, { ctx: ctx() });
    expect(ok.errors).toBeUndefined();
    expect(ok.manifest.handbookVersion).toBe("0.3.0");
    expect(ok.history.entries.at(-1).summary).toContain("提案基于 v0.1.0，合入到 v0.2.0 之上");
    // 提案要改的那条在提案之后被别人改过：拒绝，不能悄悄覆盖
    const edited = { ...other, handbook: { ...other.handbook, rules: [{ ...(st.handbook.rules as any)[0], text: "别人改过的文字" }] } };
    expect(applyProposal(edited, decided, { ctx: ctx() }).errors.join()).toContain("在提案之后被改过");
    // 提案要新增的编号已被占用 / 要改的条目已被删除
    const taken = { ...other, handbook: { ...other.handbook, rules: [...(st.handbook.rules as any), { id: "DM-002", level: "建议", title: "占位", text: "t", check: "c", source: "s" }] } };
    expect(applyProposal(taken, decided, { ctx: ctx() }).errors.join()).toContain("里已经有 rules/DM-002");
    const gone = { ...other, handbook: { ...other.handbook, rules: [] } };
    expect(applyProposal(gone, decided, { ctx: ctx() }).errors.join()).toContain("已经不存在");
  });

  it("all items rejected: the proposal closes, the handbook and version stay the same", async () => {
    const { createProposal, decideProposal, applyProposal } = await lib("handbook.mjs") as Lib;
    const st = state();
    const decided = decideProposal(createProposal(draft(), st).proposal, { reject: ["i1", "i2"], by: "用户" }).proposal;
    const r = applyProposal(st, decided, { ctx: ctx() });
    expect(r.changed).toBe(false);
    expect(r.manifest.handbookVersion).toBe("0.1.0");
    expect(r.proposal.status).toBe("rejected");
    expect(r.handbook).toEqual(st.handbook);
    expect(r.history.entries.at(-1).kind).toBe("proposal-rejected");
  });

  it("an accepted item that would make the handbook invalid is refused and nothing is written", async () => {
    const { createProposal, decideProposal, applyProposal } = await lib("handbook.mjs") as Lib;
    const st = state();
    const d = draft(); d.items[0]!.after!.level = "随便";
    const decided = decideProposal(createProposal(d, st).proposal, { accept: ["i1"], reject: ["i2"], by: "用户" }).proposal;
    const r = applyProposal(st, decided, { ctx: ctx() });
    expect(r.errors.join()).toContain("合入后的手册校验不通过");
    expect(r.manifest).toBeUndefined();
  });

  it("first approval: only a draft, only with a human approver; it becomes 1.0.0", async () => {
    const { approveFirst } = await lib("handbook.mjs") as Lib;
    const st = state();
    expect(approveFirst(st, { by: "", ctx: ctx() }).errors.join()).toContain("确认人 --by 不能为空");
    const r = approveFirst(st, { by: "应用所有者", ctx: ctx() });
    expect(r.manifest).toMatchObject({ status: "approved", handbookVersion: "1.0.0", approvedBy: "应用所有者" });
    expect(r.history.entries.at(-1)).toMatchObject({ version: "1.0.0", kind: "approve" });
    expect(approveFirst({ ...st, manifest: r.manifest }, { by: "x", ctx: ctx() }).errors.join()).toContain("只有草稿能做首版确认");
  });
});

describe("css scan (the facts the handbook is built on)", () => {
  it("counts variables, font sizes, radii, hard-coded colours and small tap targets", async () => {
    const { scanCss } = await lib("css-scan.mjs") as Lib;
    const s = scanCss(`/* c */\n:root{--a:#112233;--r:12px}\n.btn{font-size:14px;border-radius:var(--r);color:#112233;background:#abcdef;min-height:40px}\n.card{font-size:14px;padding:8px 12px;border:1px solid rgba(0,0,0,.1)}\n@media (min-width: 620px){.card{padding:16px}}\n@keyframes spin{from{opacity:0}to{opacity:1}}`);
    expect(s.vars).toEqual([{ name: "--a", value: "#112233" }, { name: "--r", value: "12px" }]);
    expect(s.fontSizes[0]).toMatchObject({ value: "14px", count: 2 });
    expect(s.radii[0].value).toBe("var(--r)");
    expect(s.spacing.map((x: any) => x.value)).toEqual(expect.arrayContaining(["8px", "12px", "16px"]));
    expect(s.hardColors.find((c: any) => c.value === "#112233").variable).toBe("--a");       // 手写色值恰好等于一个变量
    expect(s.hardColors.find((c: any) => c.value === "#abcdef").variable).toBeNull();
    expect(s.breakpoints).toEqual(["(min-width: 620px)"]);
    expect(s.keyframes).toEqual(["spin"]);
    expect(s.smallTargets).toEqual([{ selector: ".btn", prop: "min-height", px: 40 }]);
  });
});

describe("the real handbook: 单词侦探 (a sub-app, light only)", () => {
  const load = async () => (await lib("handbook.mjs") as Lib).loadHandbook(REAL_DESIGN);
  const realCtx = async () => {
    const { baselineRuleInfo } = await lib("baseline.mjs") as Lib;
    const { targetThemes } = await lib("targets.mjs") as Lib;
    return { dir: REAL_DESIGN, targetThemes: targetThemes("word-detective"), baseline: baselineRuleInfo(), css: readFileSync(join(REPO, "apps/word-detective/styles.css"), "utf8") };
  };

  it("is valid, light-only, approved by its owner, and consistent with the code", async () => {
    const { validateHandbook } = await lib("handbook.mjs") as Lib;
    const st = await load();
    expect(st.manifest).toMatchObject({ appId: "word-detective", rulePrefix: "WD", themes: ["light"], status: "approved", handbookVersion: "1.0.0", approvedBy: "应用所有者", baseline: { version: "v0.1" } });
    expect(st.manifest.approvedAt).toBeTruthy();
    expect(validateHandbook(st, await realCtx())).toEqual([]);                              // 含手册与样式的对照、截图哈希
    expect(st.handbook.components.length).toBeGreaterThanOrEqual(15);
    expect(st.handbook.pages.flatMap((p: any) => p.screenshots).every((s: any) => s.theme === "light")).toBe(true);
    expect(JSON.stringify(st.handbook)).not.toMatch(/"theme":\s*"dark"/);
  });

  it("the three accepted proposals retain their sources, decisions and cross-app authorization", async () => {
    const st = await load();
    expect(st.proposals.map((p: any) => [p.id, p.status, p.source.kind + (p.source.ref ?? "")])).toEqual([["P-001", "applied", "extraction"], ["P-002", "applied", "review-findingF3"], ["P-003", "applied", "review-findingF1"]]);
    expect(st.proposals[2].impact.crossApp).toEqual(["pet-math-game", "challenge-island", "wrong-book"]);      // 胶囊是共享的，改动跨应用
    expect(st.manifest.handbookVersion).toBe("1.0.0");
    expect(st.handbook.rules).toHaveLength(13);
    for (const [index, proposal] of st.proposals.entries()) {
      expect(proposal.decidedBy).toBe("应用所有者");
      expect(proposal.items.every((item: any) => item.decision === "accepted")).toBe(true);
      expect(proposal.appliedVersion).toBe(`0.${index + 2}.0`);
      expect(st.history.entries[index]).toMatchObject({ proposal: proposal.id, by: "应用所有者", version: proposal.appliedVersion });
    }
    expect(st.history.entries.at(-1)).toMatchObject({ version: "1.0.0", kind: "approve", by: "应用所有者" });
  });

  it("replaying the accepted proposals from their before-snapshots reproduces the current handbook", async () => {
    const { decideProposal, applyProposal } = await lib("handbook.mjs") as Lib;
    const st = await load(); const c = await realCtx();
    // 从提案自带的 before 快照恢复初稿，避免把已合入的真实提案当作 pending 重复执行。
    const initial = structuredClone(st.handbook);
    for (const proposal of [...st.proposals].reverse()) for (const item of [...proposal.items].reverse()) {
      const list = initial[item.target];
      const index = list.findIndex((entry: any) => entry.id === item.key);
      if (item.op === "add") list.splice(index, 1);
      else if (item.op === "modify") list[index] = structuredClone(item.before);
      else list.push(structuredClone(item.before));
    }
    const { approvedBy: _approvedBy, approvedAt: _approvedAt, ...draftManifest } = st.manifest;
    let cur = { manifest: { ...draftManifest, status: "draft", handbookVersion: "0.1.0" }, handbook: initial, history: { entries: [] } };
    for (const p of st.proposals) {
      const pending = { ...p, status: "pending", items: p.items.map((item: any) => ({ ...item, decision: null })) };
      const d = decideProposal(pending, { accept: p.items.map((i: any) => i.id), by: "测试", now: new Date("2026-11-22T10:00:00Z") }).proposal;
      const r = applyProposal(cur, d, { ctx: c });
      expect(r.errors, p.id).toBeUndefined();
      cur = { manifest: r.manifest, handbook: r.handbook, history: r.history };
    }
    expect(cur.handbook).toEqual(st.handbook);
    expect(cur.manifest.handbookVersion).toBe("0.4.0");
    expect(cur.handbook.rules.map((r: any) => r.id)).toEqual(expect.arrayContaining(["WD-012", "WD-013"]));
    expect(cur.handbook.components.find((x: any) => x.id === "badge").rules).toEqual(["WD-013"]);
  });

  it("handbook.html is the current rendering of the handbook (rebuild with handbook.mjs build if this fails)", async () => {
    const { buildHandbookHtml } = await lib("build-handbook.mjs") as Lib;
    const st = await load();
    const html = buildHandbookHtml(st, { dir: REAL_DESIGN, css: readFileSync(join(REPO, "apps/word-detective/styles.css"), "utf8") });
    expect(readFileSync(join(REAL_DESIGN, "handbook.html"), "utf8")).toBe(html);
  });

  it("the rendered page: six chapters + appendix, live specimens, real screenshots inline, no external resources, no dark theme at all", async () => {
    const html = readFileSync(join(REAL_DESIGN, "handbook.html"), "utf8");
    for (const part of ["一、设计总览", "二、视觉系统", "三、组件图鉴", "四、交互规范", "五、页面范例", "六、质量规则", "七、现状数据", "版本记录", "已确认", "主题：仅浅色", "平台基线 v0.1"]) expect(html, part).toContain(part);
    expect(html).not.toContain("这是草稿");
    expect(html).not.toContain("待确认的变更提案");
    for (const id of ["P-001", "P-002", "P-003"]) expect(html).toContain(id);
    expect(html).toContain("v1.0.0");
    expect(html).toContain("v0.4.0");
    expect((html.match(/data-spec=/g) ?? []).length).toBeGreaterThanOrEqual(15);          // 每个组件一个标本
    expect(html).toContain(":host{");                                                       // 应用样式的 :root 被改写成 :host（Shadow DOM 里生效）
    expect((html.match(/data:image\/png;base64,/g) ?? []).length).toBe(8);                  // 8 张真实截图内嵌
    expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i);
    // 浅色应用：没有主题切换、没有夜间样式、也没有切换脚本
    expect(html).not.toContain('id="theme"'); expect(html).not.toContain("data-theme"); expect(html).not.toContain("matchMedia('(prefers-color-scheme");
    expect(html).not.toContain(":root[data-theme=dark]");
    expect(html).toContain("color-scheme:light");
  });
});

describe("handbook CLI + Review integration (on a copy of the real handbook in a temp repo)", () => {
  let repo: string, runs: string;
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  const hb = (...a: string[]) => spawnSync("node", [join(SKILL, "scripts/handbook.mjs"), ...a, "--app", "word-detective"], { cwd: repo, encoding: "utf8" });
  const node = (file: string, args: string[]) => spawnSync("node", [join(SKILL, "scripts", file), ...args, "--runs-dir", runs], { cwd: repo, encoding: "utf8" });
  const resetCopyToDraft = () => {
    const designDir = join(repo, "apps/word-detective/.design");
    const manifestPath = join(designDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.approvedBy;
    delete manifest.approvedAt;
    manifest.status = "draft";
    manifest.handbookVersion = "0.4.0";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const historyPath = join(designDir, "history.json");
    const history = JSON.parse(readFileSync(historyPath, "utf8"));
    history.entries = history.entries.filter((e: any) => e.kind !== "approve");
    writeFileSync(historyPath, JSON.stringify(history, null, 2) + "\n");
    expect(hb("build").status).toBe(0);
    git("add", "-A");
    git("commit", "-q", "-m", "reset to draft fixture");
  };
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "hb-repo-")); runs = mkdtempSync(join(tmpdir(), "hb-runs-"));
    git("init", "-q", "-b", "main");
    mkdirSync(join(repo, "apps/word-detective"), { recursive: true });
    cpSync(join(REPO, "apps/word-detective/styles.css"), join(repo, "apps/word-detective/styles.css"));
    cpSync(REAL_DESIGN, join(repo, "apps/word-detective/.design"), { recursive: true });
    git("add", "-A"); git("commit", "-q", "-m", "init");
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(runs, { recursive: true, force: true }); });

  it("validate / show / build work; build writes handbook.html identical to the committed one", () => {
    expect(JSON.parse(hb("validate").stdout)).toMatchObject({ ok: true, status: "approved", version: "1.0.0", themes: ["light"], rules: 13 });
    expect(JSON.parse(hb("show").stdout).proposals).toHaveLength(3);
    writeFileSync(join(repo, "apps/word-detective/.design/handbook.html"), "stale");
    expect(hb("build").status).toBe(0);
    expect(readFileSync(join(repo, "apps/word-detective/.design/handbook.html"), "utf8")).toBe(readFileSync(join(REAL_DESIGN, "handbook.html"), "utf8"));
  });

  it("validate catches the handbook drifting from the code", () => {
    const css = join(repo, "apps/word-detective/styles.css");
    writeFileSync(css, readFileSync(css, "utf8").replace("--s: #3d7cb5;", "--s: #ff0000;"));
    const r = hb("validate");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("手册与代码不一致：--s 手册写 #3d7cb5，样式里是 #ff0000");
  });

  it("decide and approve refuse to run without a human's name; the whole proposal → apply → approve flow works", () => {
    resetCopyToDraft();
    // 新提案在临时副本中创建；不依赖仓库中的真实提案仍处于待确认状态。
    const proposalDraft = join(repo, "proposal.json");
    writeFileSync(proposalDraft, JSON.stringify({ title: "补充检查说明", reason: "CLI 回归", source: { kind: "extraction" }, items: [
      { op: "modify", target: "rules", key: "WD-013", after: { check: "CLI 回归：检查未获得徽章的名称对比度" }, why: "验证完整确认流程" }
    ] }));
    const created = hb("propose", "--file", proposalDraft);
    expect(created.status, created.stderr).toBe(0);
    const id = JSON.parse(created.stdout).proposal;
    expect(hb("decide", "--proposal", id, "--accept", "i1").stderr).toContain("确认人");
    expect(hb("approve").stderr).toContain("确认人");
    expect(hb("apply", "--proposal", id).stderr).toContain("还有条目没决定");
    expect(JSON.parse(hb("decide", "--proposal", id, "--accept", "i1", "--by", "用户").stdout).accepted).toEqual(["i1"]);
    const applied = JSON.parse(hb("apply", "--proposal", id).stdout);
    expect(applied).toMatchObject({ status: "applied", version: "0.5.0", changed: true });
    const html = readFileSync(join(repo, "apps/word-detective/.design/handbook.html"), "utf8");
    expect(html).toContain("CLI 回归：检查未获得徽章的名称对比度"); expect(html).toContain("v0.5.0");
    expect(hb("apply", "--proposal", id).stderr).toContain("已是 applied"); // 不能重复合入
    const ap = JSON.parse(hb("approve", "--by", "应用所有者").stdout);
    expect(ap).toMatchObject({ version: "1.0.0", status: "approved", approvedBy: "应用所有者" });
    expect(readFileSync(join(repo, "apps/word-detective/.design/handbook.html"), "utf8")).toContain("已确认");
    expect(hb("approve", "--by", "x").stderr).toContain("只有草稿能做首版确认");
  });

  describe("Review cites rules from the handbook (second layer of the standard)", () => {
    const RUN = "ui-20261122-1900-dd11";
    const draft = (rules: string[]) => ({ appId: "word-detective", mode: "review", status: "completed", verification: "not_run", inspection: "static", summary: "s", limitations: ["只读了代码"],
      findings: [{ id: "F1", severity: "Minor", dimension: "consistency", location: "首页", impact: "未获得徽章名称看不清", evidence: ["code: styles.css .badge"], recommendation: "保持可读", rules }] });
    const gen = (rules: string[]) => {
      expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN]).status).toBe(0);
      writeFileSync(join(runs, RUN, "report.draft.json"), JSON.stringify(draft(rules)));
      return node("generate-report.mjs", ["--run", RUN]);
    };

    it("a DRAFT handbook is not a standard: citing its rules is refused", () => {
      resetCopyToDraft();
      const r = gen(["WD-001"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("来自尚未确认的手册（草稿 v0.4.0），不能作为检查标准");
    });

    it("an APPROVED handbook is: PB and WD rules are both accepted, the report says which layer, and records the handbook version", () => {
      resetCopyToDraft();
      expect(hb("approve", "--by", "应用所有者").status).toBe(0);
      git("add", "-A"); git("commit", "-q", "-m", "approve");
      const r = gen(["PB-025", "WD-001"]);
      expect(r.status, r.stderr).toBe(0);
      const json = JSON.parse(readFileSync(join(runs, RUN, "report.json"), "utf8"));
      expect(json).toMatchObject({ baselineVersion: "v0.1", handbookVersion: "1.0.0" });
      const md = readFileSync(join(runs, RUN, "report.md"), "utf8");
      expect(md).toContain("**违反平台基线**：PB-025 文字对比度足够，状态不只靠颜色表达");
      expect(md).toContain("**偏离本应用手册（v1.0.0）**：WD-001 角色三色一致");
      expect(md).toContain("应用手册：v1.0.0");
      expect(readFileSync(join(runs, RUN, "report.html"), "utf8")).toContain("应用手册 v1.0.0");
    });

    it("an unknown handbook rule id is refused", () => {
      expect(gen(["WD-999"]).stderr).toContain("规则 WD-999 不在 word-detective 的设计手册 v1.0.0 里");
    });
  });
});
