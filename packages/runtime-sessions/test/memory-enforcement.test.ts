import {createHash} from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENFORCEMENT_PROMPT_MARK, activeRulesOf, modelRuleId, composeFeedback, enforcementRule, frontendFilesOf, runRules, turnEvidence, unfinishedChainStart, type ActiveRule } from "../src/memory-enforcement.js";
import { RuntimeSessionManager } from "../src/manager.js";
import type { ProjectedEvent } from "../src/types.js";
import { dirtyChanges, type WorkspaceSnapshot } from "../src/workspace-evidence.js";
import { FakeDriver, until, tick } from "./fake-driver.js";

const RULE: ActiveRule = { topicId: "t-1", ruleId: "ui-change-screenshot-table", statement: "界面改动后用表格对照改前改后截图。", topic: "界面汇报" };
const TABLE = ["| 维度 | 改前 | 改后 |", "| --- | --- | --- |", "| 手机浅色 390 | ![改前](shots/a-before.png) | ![改后](shots/a-after.png) |"].join("\n");
const EDIT = JSON.stringify({ file_path: "/repo/apps/web/public/memory-public.js", old_string: "a", new_string: "b" });

describe("ui-change-screenshot-table rule", () => {
  const rule = enforcementRule("ui-change-screenshot-table")!;
  it("只在本回合改了前端文件时才检查", () => {
    expect(rule.applies({ assistantText: "好了", editInputs: [] })).toBe(false);
    expect(rule.applies({ assistantText: "好了", editInputs: [JSON.stringify({ file_path: "/repo/packages/x/src/a.ts" })] })).toBe(false);
    expect(rule.applies({ assistantText: "好了", editInputs: [EDIT] })).toBe(true);
    expect(frontendFilesOf([JSON.stringify({ file_path: "/r/apps/web/public/styles.css" }), JSON.stringify({ file_path: "/r/apps/wrong-book/Foo.tsx" })])).toEqual(["r/apps/web/public/styles.css", "r/apps/wrong-book/Foo.tsx"]);
  });
  it("只认 App 前端目录：docs / designs / skills 里的 html、设计稿页不算界面改动", () => {
    const doc = JSON.stringify({ file_path: "/Users/k/pi-agent/.pi-worktrees/rt-x/docs/design/memory-architecture/index.html" });
    expect(rule.applies({ assistantText: "好了", editInputs: [doc] })).toBe(false);
    expect(frontendFilesOf([doc, "designs/notes/a.css", "skills/platform/x/starter.tsx", "videos/p/index.html", "docs/a/public/x.js"])).toEqual([]);
    expect(frontendFilesOf(["public/stats.js", "/r/apps/word-detective/index.html"])).toEqual(["public/stats.js", "r/apps/word-detective/index.html"]);
  });
  it("只检查「汇报要带截图对照」的记忆：具体样式取值（如间距 12px）的记忆不适用这条规则", () => {
    expect(rule.fits("界面改动后先给真实渲染截图，表格对照改前改后。")).toBe(true);
    expect(rule.fits("各应用标题栏下方到子 tab 的这段间距要统一为 12px，由共享样式统一覆盖。")).toBe(false);
  });
  it("改前 / 改后同一行并排两张图才通过", () => {
    expect(rule.check({ assistantText: TABLE, editInputs: [EDIT] })).toEqual({ pass: true });
  });
  it("没有任何截图：不通过，并说明怎么改", () => {
    const v = rule.check({ assistantText: "已改好，样式更紧凑。", editInputs: [EDIT] });
    expect(v.pass).toBe(false);
    expect(v.problem).toContain("没有「改前 / 改后」截图对照表");
    expect(v.fix).toContain("Markdown 表格");
  });
  it("截图嵌在句子里（不是表格）：不通过，问题里指出这一点", () => {
    const v = rule.check({ assistantText: "改前 ![a](shots/a.png) 和 ![b](shots/b.png)，上半是改前。", editInputs: [EDIT] });
    expect(v.pass).toBe(false);
    expect(v.problem).toContain("没有放进「改前 / 改后」对照表");
  });
  it("表格里每行只有一张图（没有并排对照）：不通过", () => {
    const t = ["| 维度 | 截图 |", "| --- | --- |", "| 浅色 | ![a](a.png) |", "| 夜间 | ![b](b.png) |"].join("\n");
    expect(rule.check({ assistantText: t, editInputs: [EDIT] }).pass).toBe(false);
  });
});

describe("按结果取证：工作区快照对比", () => {
  const rule = enforcementRule("ui-change-screenshot-table")!;
  const snap = (files: Record<string, string>): WorkspaceSnapshot => ({ root: "/r", head: "h", files: new Map(Object.entries(files)) });
  it("新增或修改时间 / 大小变了的文件算本回合改过；开始时就脏、之后没动的不算", () => {
    const before = snap({ "apps/a/js/app.js": "1:10", "apps/a/styles.css": "1:20" });
    const after = snap({ "apps/a/js/app.js": "1:10", "apps/a/styles.css": "2:21", "apps/a/js/new.js": "3:5" });
    expect(dirtyChanges(before, after).sort()).toEqual(["apps/a/js/new.js", "apps/a/styles.css"]);
  });
  it("apps/<应用>/ 下的 js / svg 算前端文件；测试、脚本、配置文件不算", () => {
    expect(frontendFilesOf(["apps/challenge-island/js/app.js\napps/challenge-island/core.js\napps/challenge-island/icons/a.svg"])).toEqual(["apps/challenge-island/js/app.js", "apps/challenge-island/core.js", "apps/challenge-island/icons/a.svg"]);
    expect(frontendFilesOf(["apps/challenge-island/test/app-browser.test.ts\napps/a/test/x.js\napps/a/js/x.test.js\napps/a/scripts/build.js\napps/a/vite.config.js\napps/web/src/a.ts"])).toEqual([]);
  });
  it("回归（rt-5ba86245cf9d4347 第 3 轮）：python 脚本写文件，工具事件认不出；加上快照对比出的文件后照样检查，并列出改动的前端文件", () => {
    const py = ["python3 - <<'PY'", "p='js/app.js'", "s=open(p).read()", "s=s.replace('a','b')", "open(p,'w').write(s)", "PY"].join("\n");
    const mk = (over: Partial<ProjectedEvent>): ProjectedEvent => ({ key: Math.random().toString(), seq: 1, kind: "tool", recordedAt: "2026-11-12T23:00:00Z", source: "stream", parserVersion: "t", availability: "recorded", turnNo: 3, ...over });
    const events = [mk({ tool: { name: "bash", input: `cd /Users/k/pi-agent/apps/challenge-island && ${py}` } }), mk({ kind: "message", role: "assistant", text: "已完善，没有截图。" })];
    // 只看工具事件：漏判（这就是原来被跳过的原因）
    expect(rule.applies(turnEvidence(events, 3))).toBe(false);
    // 加上这一轮实际变化的文件（含测试和截图 png，它们不算界面）
    const changed = ["apps/challenge-island/js/app.js", "apps/challenge-island/styles.css", "apps/challenge-island/test/app-browser.test.ts", "docs/design/challenge-week-dots/step2-home-390.png"];
    const ev = turnEvidence(events, 3, 3, changed);
    expect(rule.applies(ev)).toBe(true);
    expect(frontendFilesOf(ev.editInputs)).toEqual(["apps/challenge-island/js/app.js", "apps/challenge-island/styles.css"]);
    const v = rule.check(ev);
    expect(v.pass).toBe(false);
    expect(v.problem).toContain("apps/challenge-island/js/app.js");
    expect(rule.check({ ...ev, assistantText: TABLE }).pass).toBe(true);
  });
  it("规则声明要按结果取证；入口域名、北京时间规则不需要", () => {
    expect(rule.usesWorkspaceChanges).toBe(true);
    expect(enforcementRule("entry-domain")?.usesWorkspaceChanges).toBeUndefined();
  });
});

describe("evidence & feedback", () => {
  const ev = (over: Partial<ProjectedEvent>): ProjectedEvent => ({ key: Math.random().toString(), seq: 1, kind: "message", recordedAt: "2026-11-11T00:00:00Z", source: "stream", parserVersion: "t", availability: "recorded", turnNo: 1, ...over });
  it("turnEvidence 只取本回合：助手消息拼接、改文件类工具输入；流式片段与读文件类工具不算", () => {
    const e = turnEvidence([
      ev({ role: "assistant", text: "第一段" }), ev({ role: "assistant", text: "半截", partial: true }), ev({ role: "assistant", text: "第二段" }),
      ev({ kind: "tool", tool: { name: "Edit", input: EDIT } }), ev({ kind: "tool", tool: { name: "Read", input: EDIT } }),
      ev({ role: "assistant", text: "别的回合", turnNo: 2 })
    ], 1);
    expect(e.assistantText).toBe("第一段\n\n第二段");
    expect(e.editInputs).toEqual([EDIT]);
  });
  it("被中断的回合不算检查过：从本轮往前数连续没正常结束的回合，改动并进本轮证据", () => {
    const t = (turnNo: number, status: string) => ({ turnNo, status });
    expect(unfinishedChainStart([t(1, "completed"), t(2, "completed")], 3)).toBe(3);
    expect(unfinishedChainStart([t(1, "completed"), t(2, "interrupted"), t(3, "running")], 3)).toBe(2);
    expect(unfinishedChainStart([t(1, "failed"), t(2, "cancelled"), t(3, "interrupted"), t(4, "running")], 4)).toBe(1);
    expect(unfinishedChainStart([t(1, "interrupted"), t(2, "completed"), t(3, "completed")], 4)).toBe(4);
    const events = [ev({ turnNo: 1, kind: "tool", tool: { name: "Edit", input: EDIT } }), ev({ turnNo: 2, role: "assistant", text: "核对完毕，截图在 evidence/ 目录" })];
    const rule = enforcementRule("ui-change-screenshot-table")!;
    expect(rule.applies(turnEvidence(events, 2))).toBe(false);
    expect(rule.applies(turnEvidence(events, 2, unfinishedChainStart([{ turnNo: 1, status: "interrupted" }], 2)))).toBe(true);
  });
  it("跳过留痕：只有改过界面的会话、这一轮没改界面时才留「未检查」，纯聊天会话不提", () => {
    const active = [RULE];
    const chat = runRules(active, { assistantText: "好", editInputs: [], sessionEditInputs: [] });
    expect(chat).toEqual({ failed: [], passed: [], skipped: [] });
    const ui = runRules(active, { assistantText: "好", editInputs: [], sessionEditInputs: [EDIT] });
    expect(ui.failed).toEqual([]);
    expect(ui.skipped).toHaveLength(1);
    expect(ui.skipped[0]!.note).toContain("没有检查截图对照表");
    expect(runRules(active, { assistantText: "好", editInputs: [EDIT], sessionEditInputs: [EDIT] }).skipped).toEqual([]);
  });
  it("三个 runtime 的改文件事件都认：Claude Edit、Pi edit、Codex「文件修改」（路径列表）、shell 里的 apply_patch / sed -i；读文件和普通命令不算", () => {
    const tools = [
      ev({ kind: "tool", tool: { name: "Edit", input: EDIT } }),
      ev({ kind: "tool", tool: { name: "edit", input: JSON.stringify({ path: "apps/web/public/styles.css" }) } }),
      ev({ kind: "tool", tool: { name: "文件修改", input: "apps/web/public/memory-public.js\napps/web/src/a.ts" } }),
      ev({ kind: "tool", tool: { name: "命令", input: "apply_patch <<'EOF'\n*** Update File: apps/web/public/index.html\nEOF" } }),
      ev({ kind: "tool", tool: { name: "Bash", input: "sed -i 's/a/b/' apps/web/public/styles.css" } }),
      ev({ kind: "tool", tool: { name: "命令", input: "grep -n foo apps/web/public/styles.css" } }),
      ev({ kind: "tool", tool: { name: "Read", input: EDIT } })
    ];
    const e = turnEvidence(tools, 1);
    expect(e.editInputs).toHaveLength(5);
    expect(enforcementRule("ui-change-screenshot-table")!.applies({ assistantText: "", editInputs: [e.editInputs[2]!] })).toBe(true);
  });
  it("shell 里只认被写入的路径：给截图留「改前」副本不算改前端；真正的 sed -i / 重定向 / apply_patch 才算", () => {
    const only = (input: string) => frontendFilesOf(turnEvidence([ev({ kind: "tool", tool: { name: "命令", input } })], 1).editInputs);
    // 复现线上的误报：git show 取改前版本，写到 tmp/before 里
    expect(only("git show HEAD:apps/web/public/styles.css > tmp/before/styles.css && cp apps/web/public/styles.css ../public/styles.css.bak")).toEqual([]);
    expect(only("cat apps/web/public/styles.css | grep rt-memory")).toEqual([]);
    expect(only("sed -i '' 's/a/b/' apps/web/public/stats.js")).toEqual(["apps/web/public/stats.js"]);
    expect(only("cat > apps/web/public/new-page.html <<'EOF'\n<p>x</p>\nEOF")).toEqual(["apps/web/public/new-page.html"]);
    expect(only("apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: apps/web/public/styles.css\n*** End Patch\nEOF")).toEqual(["apps/web/public/styles.css"]);
    // 同一条命令里既写真文件又写临时副本：只算真文件
    expect(only("cp a.css tmp/x.css; sed -i 's/a/b/' apps/web/public/memory-public.js")).toEqual(["apps/web/public/memory-public.js"]);
    // 路径里带 git 引用前缀、或在临时 / 证据目录里，不算改动
    expect(frontendFilesOf(["HEAD:apps/web/public/styles.css", "/private/tmp/x/shots/a.css", "docs/requirements/x/evidence/a.html"])).toEqual(["apps/web/public/styles.css"]);
  });
  it("activeRulesOf 取最近一次注入登记的规则", () => {
    expect(activeRulesOf([ev({ kind: "notice", injection: { label: "平台公共记忆", text: "x", count: 1, rules: [RULE] } })])).toEqual([RULE]);
    expect(activeRulesOf([ev({ kind: "notice", injection: { label: "平台公共记忆", text: "x", count: 1 } })])).toEqual([]);
  });
  it("反馈带记忆原句、问题、怎么改，并标明是平台自动消息", () => {
    const { failed } = runRules([RULE], { assistantText: "好了", editInputs: [EDIT] });
    const msg = composeFeedback(failed, 0);
    expect(msg.startsWith(ENFORCEMENT_PROMPT_MARK)).toBe(true);
    expect(msg).toContain("界面改动后用表格对照改前改后截图。");
    expect(msg).toContain("问题：");
    expect(msg).toContain("怎么改：");
    expect(msg).toContain("第 1 次");
  });
  it("同一规则、同样问题的多条记忆合并成一段反馈，只列一次改法", () => {
    const two = [RULE, { ...RULE, topicId: "t-2", topic: "间距", statement: "标题栏到子 tab 间距 12px。" }];
    const { failed } = runRules(two, { assistantText: "好了", editInputs: [EDIT] });
    expect(failed).toHaveLength(2);
    const msg = composeFeedback(failed, 0);
    expect(msg).toContain("记忆「界面汇报」");
    expect(msg).toContain("记忆「间距」");
    expect(msg.split("检查项：")).toHaveLength(2);
    expect(msg.split("怎么改：")).toHaveLength(2);
    expect(msg).not.toContain("（1）");
  });
  it("未登记的规则 id 被忽略，不会让回合失败", () => {
    expect(runRules([{ ...RULE, ruleId: "no-such-rule" }], { assistantText: "x", editInputs: [EDIT] })).toEqual({ failed: [], passed: [], skipped: [] });
  });
});

const ev0 = (over: Partial<ProjectedEvent>): ProjectedEvent => ({ key: Math.random().toString(), seq: 1, kind: "message", recordedAt: "2026-11-11T00:00:00Z", source: "stream", parserVersion: "t", availability: "recorded", turnNo: 1, ...over });

describe("entry-domain rule（入口链接只用国内入口域名）", () => {
  const rule = enforcementRule("entry-domain")!;
  const run = (assistantText: string, commandInputs: string[] = []) => ({ assistantText, editInputs: [] as string[], commandInputs });
  it("四要素齐全，且只挂给讲入口域名的记忆", () => {
    expect(rule.node).toBe("turn-end");
    expect([rule.scope, rule.criteria, rule.feedback].every((x) => x.length > 10)).toBe(true);
    expect(rule.fits("所有入口链接和验收核查都使用 gui-backup-cn.harness.fund，不再用 gui.harness.fund。")).toBe(true);
    expect(rule.fits("改动前先确认需求和方案。")).toBe(false);
  });
  it("回复里没有入口网址：不检查", () => {
    expect(rule.applies(run("已改好，测试通过。"))).toBe(false);
  });
  it("给出旧入口链接：不通过，问题里指出旧网址、改法指向国内入口", () => {
    const ev = run("已上线：[打开](https://gui.harness.fund/#/rt/abc)");
    expect(rule.applies(ev)).toBe(true);
    const v = rule.check(ev);
    expect(v.pass).toBe(false);
    expect(v.problem).toContain("gui.harness.fund/#/rt/abc");           // 问题里指出具体是哪个旧网址
    expect(v.fix).toContain("gui-backup-cn.harness.fund");              // 改法指向国内入口
  });
  it("国内入口通过；代码块、行内代码、引用行、说明旧入口的行、本地地址都不算", () => {
    expect(rule.check(run("已上线：[打开](https://gui-backup-cn.harness.fund/#/rt/abc)")).pass).toBe(true);
    const text = ["已上线：https://gui-backup-cn.harness.fund/", "```", "https://gui.harness.fund/log", "```", "日志里是 `https://gui.harness.fund/x`", "> 平台通知：https://gui.harness.fund 已上线", "不再用 https://gui.harness.fund 这个旧入口。", "本地 http://127.0.0.1:8780/ 已验证"].join("\n");
    const ev = run(text);
    expect(rule.applies(ev)).toBe(true);
    expect(rule.check(ev)).toEqual({ pass: true });
  });
  it("验收用 curl / 浏览器访问了旧入口：不通过；grep 搜旧域名这类不算访问", () => {
    expect(rule.check(run("验收完成。", ["curl -s https://gui.harness.fund/api/health"])).pass).toBe(false);
    const ev = turnEvidence([
      ev0({ kind: "tool", tool: { name: "Bash", input: "grep -rn 'https://gui.harness.fund' docs/" } }),
      ev0({ kind: "tool", tool: { name: "Bash", input: "curl -s https://gui-backup-cn.harness.fund/api/health" } }),
      ev0({ kind: "tool", tool: { name: "browser_navigate", input: JSON.stringify({ url: "https://gui.harness.fund/#/memory" }) } })
    ], 1);
    expect(ev.commandInputs).toHaveLength(2);
    expect(rule.check({ ...ev, assistantText: "" }).pass).toBe(false);
  });
});

describe("beijing-time rule（时间表达以北京时间为主）", () => {
  const rule = enforcementRule("beijing-time")!;
  const ev = (assistantText: string) => ({ assistantText, editInputs: [] as string[] });
  it("四要素齐全，只挂给讲北京时间 / 时区的记忆", () => {
    expect(rule.node).toBe("turn-end");
    expect([rule.scope, rule.criteria, rule.feedback].every((x) => x.length > 10)).toBe(true);
    expect(rule.fits("时间表达默认按北京时间（UTC+8）。")).toBe(true);
    expect(rule.fits("界面改动后给截图。")).toBe(false);
  });
  it("没有带时区的时刻：不检查", () => {
    expect(rule.applies(ev("明天 14:30 开会。"))).toBe(false);
    expect(rule.applies(ev("用 UTC 存储，不展示给用户。"))).toBe(false);
  });
  it("只写 UTC / 洛杉矶时间、没写北京时间：不通过，并指出那一行", () => {
    const t = ev("定时任务下次运行：06:30 UTC。");
    expect(rule.applies(t)).toBe(true);
    const v = rule.check(t);
    expect(v.pass).toBe(false);
    expect(v.problem).toContain("06:30 UTC");
    expect(rule.check(ev("账单窗口 11-12 09:00 洛杉矶时间截止。")).pass).toBe(false);
  });
  it("北京时间为主、UTC 只作补充：通过；代码块和行内代码里的时间戳不算", () => {
    expect(rule.check(ev("下次运行：14:30 北京时间（06:30 UTC）。")).pass).toBe(true);
    expect(rule.check(ev("下次运行：14:30 UTC+8，约 06:30 UTC。")).pass).toBe(true);
    expect(rule.check(ev("日志：`2026-11-12 06:30 UTC` 已写入。\n```\n06:30 UTC job done\n```")).pass).toBe(true);
  });
});

describe("manager: 回合结束校验强约束", () => {
  let dir: string, ws: string, mgr: RuntimeSessionManager, driver: FakeDriver;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "rt-enf-")); ws = join(dir, "work"); mkdirSync(ws);
    driver = new FakeDriver("codex");
    mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver }, skipRecovery: true });
    mgr.updateSettings({ workspaceRoots: [ws] }, "test"); await mgr.probe("codex");
    mgr.setPublicMemoryProvider(() => ({ text: "【平台公共记忆】\n强约束：\n- 界面改动后用表格对照改前改后截图。", count: 1, rules: [RULE] }));
  });
  afterEach(async () => { mgr.shutdown(); await tick(35); rmSync(dir, { recursive: true, force: true }); });
  const say = (turn: number, text: string, edit = false) => {
    const sink = driver.turns[turn]!.sink;
    if(text===TABLE)for(const name of ["a-before","a-after"]){
      const path=join(ws,"shots",name+".png");mkdirSync(join(ws,"shots"),{recursive:true});writeFileSync(path,"fixture-image");
      const receipt={receiptId:`fixture-${turn}-${name}`,sessionId:driver.turns[turn]!.args.platformSessionId,turnId:driver.turns[turn]!.args.clientMessageId,path,sha256:createHash("sha256").update("fixture-image").digest("hex")};
      sink.event({key:`receipt-${turn}-${name}`,kind:"tool",source:"platform",parserVersion:"platform-browser@1",availability:"recorded",tool:{name:"platform_browser.receipt",output:JSON.stringify(receipt),status:"completed"}});
      sink.event({key:`native-${turn}-${name}`,kind:"tool",source:"stream",parserVersion:"t",availability:"recorded",tool:{name:"platform_browser.browser",input:JSON.stringify({action:"screenshot"}),output:JSON.stringify(receipt),status:"completed"}});
    }
    if (edit) sink.event({ key: `edit-${turn}`, kind: "tool", tool: { name: "Edit", input: EDIT, output: "ok", status: "completed" }, source: "stream", parserVersion: "t", availability: "recorded" });
    sink.event({ key: `msg-${turn}`, kind: "message", role: "assistant", text, source: "stream", parserVersion: "t", availability: "recorded" });
  };
  const start = async () => {
    const { session } = await mgr.create({ idempotencyKey: "enf-create-1", runtimeKind: "codex", workspace: ws, title: "t", prompt: "改一下样式", confirmedProfileVersion: mgr.profile("codex")!.checkedAt } as never, "test");
    await until(() => driver.turns.length === 1);
    return session.platformSessionId;
  };

  it("同轮有通过和失败时，两种明细均保留，反馈仍正常续发", async () => {
    mgr.setPublicMemoryProvider(() => ({ text: "公共记忆", count: 2, rules: [RULE, { topicId: "t-domain", ruleId: "entry-domain", topic: "入口链接", statement: "所有入口链接使用 gui-backup-cn.harness.fund" }] }));
    const pid = await start();
    say(0, "已修改，使用 https://gui-backup-cn.harness.fund 验证。", true);
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => driver.turns.length === 2, 12000);
    const checks = mgr.store.events(pid).filter(e => e.turnNo === 1 && e.enforcement);
    expect(checks.map(e => e.enforcement!.phase)).toEqual(["passed", "failed"]);
    expect(new Set(checks.map(e => e.key)).size).toBe(2);
    expect(checks[0]!.enforcement!.rules[0]!.topicId).toBe("t-domain");
    expect(driver.turns[1]!.args.prompt).toContain(ENFORCEMENT_PROMPT_MARK);
  });

  it("没做到：自动把反馈发给同一会话；补齐后通过，会话里留下通知", async () => {
    const pid = await start();
    say(0, "已改好。", true);
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => driver.turns.length === 2, 12000);
    expect(driver.turns[1]!.args.prompt).toContain(ENFORCEMENT_PROMPT_MARK);
    expect(driver.turns[1]!.args.prompt).toContain("怎么改：");
    expect(mgr.store.events(pid).some((e) => e.kind === "notice" && e.text?.startsWith("强约束检查未通过"))).toBe(true);
    // 第二轮补上对照表（没有再改文件）→ 通过
    say(1, TABLE);
    driver.turns[1]!.finish({ status: "completed" });
    await until(() => mgr.store.events(pid).some((e) => e.enforcement?.phase === "passed"), 12000);
    expect(driver.turns).toHaveLength(2);
    // 侧栏「公共记忆」卡片的数据：载入时登记了规则；两次校验记录（未通过已反馈 → 补救后通过），带每条规则的问题与改法
    const page = await mgr.injections(pid);
    expect(page.items[0]!.notice).toBe("已载入平台公共记忆：1 条，其中 1 条强约束已登记检查规则（每轮结束后校验）");
    expect(page.items[0]!.rules).toEqual([{ ...RULE, title: "界面改动汇报：改前/改后截图对照表" }]);
    expect(page.checks.map((c) => [c.phase, c.attempt, c.turnNo])).toEqual([["failed", 0, 1], ["passed", 1, 2]]);
    expect(page.checks[0]!.rules[0]).toMatchObject({ topic: "界面汇报", title: "界面改动汇报：改前/改后截图对照表" });
    expect(page.checks[0]!.rules[0]!.problem).toContain("没有「改前 / 改后」截图对照表");
    expect(page.checks[0]!.rules[0]!.fix).toContain("Markdown 表格");
    expect(page.checks[1]!.notice).toBe("强约束检查通过：「界面汇报」（补救后）");
    // 平台自动反馈不是用户消息：不进消息导航（只剩用户自己发的第一条）
    expect((await mgr.messageIndex(pid)).items.map((i) => i.summary)).toEqual(["改一下样式"]);
  }, 30000);

  it("DeepSeek 写的规则（没有对应代码）：回合结束由判定模型按四要素核对；没通过就自动反馈、补齐后通过；判定模型不可用时放行并留「未检查」", async () => {
    const MODEL: ActiveRule = { topicId: "t-9", ruleId: modelRuleId("t-9"), statement: "部署前必须确认。", topic: "部署确认", title: "部署前先确认", spec: { node: "turn-end", scope: "本回合有部署命令才检查", criteria: "部署前要有用户确认", feedback: "先停下，等用户确认后再部署" } };
    mgr.setPublicMemoryProvider(() => ({ text: "【平台公共记忆】\n强约束：\n- 部署前必须确认。", count: 1, rules: [MODEL] }));
    const seen: string[] = [];
    let verdict: { applies: boolean; pass: boolean; problem?: string; fix?: string } | null = { applies: true, pass: false, problem: "没确认就部署了", fix: "1. 先停下，说明要部署的内容" };
    mgr.setModelRuleJudge(async ({ rule, evidence }) => { seen.push(`${rule.ruleId}|${evidence.assistantText}`); return verdict; });
    const pid = await start();
    say(0, "已部署。");
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => driver.turns.length === 2, 12000);
    expect(driver.turns[1]!.args.prompt).toContain(ENFORCEMENT_PROMPT_MARK);
    expect(driver.turns[1]!.args.prompt).toContain("记忆「部署确认」：部署前必须确认。");
    expect(driver.turns[1]!.args.prompt).toContain("没确认就部署了");
    verdict = { applies: true, pass: true };
    say(1, "已向你确认。");
    driver.turns[1]!.finish({ status: "completed" });
    await until(() => mgr.store.events(pid).some((e) => e.enforcement?.phase === "passed"), 12000);
    expect(seen).toEqual(["model:t-9|已部署。", "model:t-9|已向你确认。"]);
    const page = await mgr.injections(pid);
    expect(page.items[0]!.rules).toEqual([{ topicId: "t-9", ruleId: "model:t-9", topic: "部署确认", statement: "部署前必须确认。", title: "部署前先确认" }]);
    expect(page.checks.map((c) => [c.phase, c.rules[0]!.title])).toEqual([["failed", "部署前先确认"], ["passed", "部署前先确认"]]);
    // 判定模型不可用：不发反馈、会话照常，留一条「未检查」
    verdict = null;
    await mgr.sendTurn(pid, { idempotencyKey: "enf-next", prompt: "再来一次", expectedRevision: mgr.store.binding(pid)!.bindingRevision }, "test");
    await until(() => driver.turns.length === 3, 12000);
    say(2, "又部署了。");
    driver.turns[2]!.finish({ status: "completed" });
    await until(() => mgr.store.events(pid).some((e) => e.enforcement?.phase === "skipped"), 12000);
    await tick(300);
    expect(driver.turns).toHaveLength(3);
  }, 45000);

  it("按功能事实核对（原生 App 发布）：改了 apps/android 但发布目录没推进 → 不通过并把事实交给判定模型；补发布后 release.json 前进 → 通过", async () => {
    const APK: ActiveRule = { topicId: "t-apk", ruleId: modelRuleId("t-apk"), statement: "涉及原生 App，部署就包含 App 的发布。", topic: "原生 App 发布", title: "原生 App 改动要推进到发布", spec: { node: "turn-end", scope: "facts.changed-files 含 apps/android/ 文件才检查", criteria: "facts.android-release.changed 必须为 true", feedback: "运行打包发布脚本，让 release.json 推进", probes: ["changed-files", "android-release"] } };
    mgr.setPublicMemoryProvider(() => ({ text: "【平台公共记忆】\n强约束：\n- 涉及原生 App，部署就包含 App 的发布。", count: 1, rules: [APK] }));
    let release: { versionCode: number } | null = { versionCode: 41 };
    mgr.setEvidenceReaders({ "android-release": async () => release });
    const seen: Array<Record<string, unknown> | undefined> = [];
    mgr.setModelRuleJudge(async ({ evidence }) => {
      seen.push(evidence.facts);
      const rel = evidence.facts?.["android-release"] as { changed?: boolean } | undefined;
      const touched = ((evidence.facts?.["changed-files"] as string[] | null) ?? []).some((f) => f.startsWith("apps/android/"));
      if (!touched) return { applies: false, pass: true };
      return rel?.changed === true ? { applies: true, pass: true } : { applies: true, pass: false, problem: "改了 apps/android，但发布目录 release.json 没有推进（versionCode 仍是 41）", fix: "1. 运行打包发布脚本" };
    });
    // 真实 git 工作区：回合里写 apps/android 下的文件（不经过任何工具事件）
    execFileSync("git", ["init", "-q"], { cwd: ws }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "init"], { cwd: ws });
    const pid = await start();
    mkdirSync(join(ws, "apps/android/app"), { recursive: true }); writeFileSync(join(ws, "apps/android/app/Main.kt"), "// changed");
    say(0, "原生 App 已改好，APK 已发布。");   // 回复里「说了已发布」，但事实上发布目录没动
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => driver.turns.length === 2, 15000);
    expect(driver.turns[1]!.args.prompt).toContain("release.json 没有推进");
    expect(seen[0]).toMatchObject({ "changed-files": ["apps/android/app/Main.kt"], "android-release": { before: { versionCode: 41 }, after: { versionCode: 41 }, changed: false } });
    // 补救回合：真的发布了（release.json 前进），回复不用再强调
    release = { versionCode: 42 };
    say(1, "已重新打包并发布。");
    driver.turns[1]!.finish({ status: "completed" });
    await until(() => mgr.store.events(pid).some((e) => e.enforcement?.phase === "passed"), 15000);
    expect(seen[1]).toMatchObject({ "changed-files": ["apps/android/app/Main.kt"], "android-release": { before: { versionCode: 41 }, after: { versionCode: 42 }, changed: true } });
    expect(driver.turns).toHaveLength(2);
  }, 60000);

  it("连续没做到：最多自动提醒 2 次，之后停下并告知，不再发消息", async () => {
    const pid = await start();
    say(0, "已改好。", true);
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => driver.turns.length === 2, 12000);
    say(1, "还是没图");
    driver.turns[1]!.finish({ status: "completed" });
    await until(() => driver.turns.length === 3, 12000);
    say(2, "仍然没图");
    driver.turns[2]!.finish({ status: "completed" });
    await until(() => mgr.store.events(pid).some((e) => e.text?.startsWith("强约束检查仍未通过")), 12000);
    await tick(300);
    expect(driver.turns).toHaveLength(3);
    expect((await mgr.injections(pid)).checks.map((c) => c.phase)).toEqual(["failed", "failed", "exhausted"]);
  }, 45000);

  it("第一次就做到了：也留一条「通过」的校验记录（卡片里看得到平台检查过）", async () => {
    const pid = await start();
    say(0, TABLE, true);
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.events(pid).some((e) => e.enforcement?.phase === "passed"), 12000);
    expect((await mgr.injections(pid)).checks.map((c) => [c.phase, c.attempt, c.notice])).toEqual([["passed", 0, "强约束检查通过：「界面汇报」"]]);
    await tick(300);
    expect(driver.turns).toHaveLength(1);
  }, 30000);

  describe("按结果取证（真实 git 工作区，改文件不经过任何工具事件）", () => {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: ws, stdio: "pipe" });
    const put = (rel: string, text: string) => { mkdirSync(join(ws, rel, ".."), { recursive: true }); writeFileSync(join(ws, rel), text); };
    beforeEach(() => { git("init", "-q"); put("README.md", "x"); git("add", "-A"); git("commit", "-q", "-m", "init"); });

    it("模型用脚本直接写前端文件（没有 Edit 事件）：照样检查，反馈里点出文件", async () => {
      const pid = await start();
      put("apps/demo/js/app.js", "console.log(1)");
      say(0, "已完善。");
      driver.turns[0]!.finish({ status: "completed" });
      await until(() => driver.turns.length === 2, 12000);
      expect(driver.turns[1]!.args.prompt).toContain(ENFORCEMENT_PROMPT_MARK);
      expect(driver.turns[1]!.args.prompt).toContain("apps/demo/js/app.js");
      // 补上对照表 → 补救链的证据仍带着起始回合的改动，通过
      say(1, TABLE);
      driver.turns[1]!.finish({ status: "completed" });
      await until(() => mgr.store.events(pid).some((e) => e.enforcement?.phase === "passed"), 12000);
    }, 30000);

    it("本回合在工作区里提交了前端文件：同样算改过", async () => {
      await start();
      put("apps/demo/styles.css", "a{}");
      git("add", "-A"); git("commit", "-q", "-m", "ui");
      say(0, "已提交。");
      driver.turns[0]!.finish({ status: "completed" });
      await until(() => driver.turns.length === 2, 12000);
      expect(driver.turns[1]!.args.prompt).toContain("apps/demo/styles.css");
    }, 30000);

    it("开始前就有的未提交改动、本回合没再动：不检查", async () => {
      put("apps/demo/js/app.js", "old");
      await start();
      say(0, "只是回答问题");
      driver.turns[0]!.finish({ status: "completed" });
      await tick(2200);
      expect(driver.turns).toHaveLength(1);
    }, 15000);

    it("本回合只改了测试 / 文档 / 截图：不检查", async () => {
      await start();
      put("apps/demo/test/app.test.ts", "x"); put("docs/design/a/index.html", "<p>"); put("docs/design/a/shot.png", "png");
      say(0, "补了测试。");
      driver.turns[0]!.finish({ status: "completed" });
      await tick(2200);
      expect(driver.turns).toHaveLength(1);
    }, 15000);
  });

  it("本回合没改前端文件：不检查", async () => {
    await start();
    say(0, "只是回答问题");
    driver.turns[0]!.finish({ status: "completed" });
    await tick(2200);
    expect(driver.turns).toHaveLength(1);
  }, 10000);

  it("改界面的那一轮被额度中断：接续轮没改文件，汇报没带图也要被检查并反馈", async () => {
    const pid = await start();
    say(0, "截图已生成", true);
    driver.turns[0]!.finish({ status: "interrupted" });
    await tick(2200);
    expect(driver.turns).toHaveLength(1);
    expect(mgr.store.events(pid).some((e) => e.enforcement)).toBe(false);
    await mgr.sendTurn(pid, { idempotencyKey: "enf-resume-turn-1", prompt: "继续", expectedRevision: mgr.store.binding(pid)!.bindingRevision }, "test");
    await until(() => driver.turns.length === 2);
    say(1, "核对完毕，截图在 evidence/ 目录");
    driver.turns[1]!.finish({ status: "completed" });
    await until(() => driver.turns.length === 3, 12000);
    expect(driver.turns[2]!.args.prompt).toContain(ENFORCEMENT_PROMPT_MARK);
    expect(driver.turns[2]!.args.prompt).toContain("memory-public.js");
    expect((await mgr.injections(pid)).checks.map((c) => [c.phase, c.turnNo])).toEqual([["failed", 2]]);
  }, 45000);

  it("改过界面的会话里，后面一轮没改界面：留一条「未检查」记录，不发反馈", async () => {
    const pid = await start();
    say(0, TABLE, true);
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.events(pid).some((e) => e.enforcement?.phase === "passed"), 12000);
    await mgr.sendTurn(pid, { idempotencyKey: "enf-next-turn-1", prompt: "再问一个问题", expectedRevision: mgr.store.binding(pid)!.bindingRevision }, "test");
    await until(() => driver.turns.length === 2);
    say(1, "只是回答问题");
    driver.turns[1]!.finish({ status: "completed" });
    await until(() => mgr.store.events(pid).some((e) => e.enforcement?.phase === "skipped"), 12000);
    const page = await mgr.injections(pid);
    expect(page.checks.map((c) => [c.phase, c.turnNo])).toEqual([["passed", 1], ["skipped", 2]]);
    expect(page.checks[1]!.notice).toContain("强约束未检查：「界面汇报」");
    expect(page.checks[1]!.rules[0]!.note).toContain("没有改界面文件");
    await tick(300);
    expect(driver.turns).toHaveLength(2);
  }, 30000);
});
