/**
 * 「界面打磨」交付检查（ui-report-check.ts + manager.enforceUiReport）：
 * 用了技能就必须交付由技能脚本生成的检查报告；脚本产物与平台检查之间有契约测试，改一边会让另一边的测试变红。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENFORCEMENT_PROMPT_MARK } from "../src/memory-enforcement.js";
import { PLATFORM_SKILLS_ROOT } from "../src/platform-skills.js";
import { RuntimeSessionManager } from "../src/manager.js";
import { UI_REPORT_OPT_OUT, uiReportProblems, usedUiSkill } from "../src/ui-report-check.js";
import type { ProjectedEvent } from "../src/types.js";
import { FakeDriver, until, tick } from "./fake-driver.js";

const SKILL = join(PLATFORM_SKILLS_ROOT, "ui-design-refinement");
const RUN = "ui-20261122-1800-ab99";
const ev = (e: Partial<ProjectedEvent> & { turnNo: number }): ProjectedEvent => ({ key: `k-${Math.random()}`, kind: "tool", source: "stream", parserVersion: "t", availability: "recorded", ...e } as ProjectedEvent);
const DEPLOYED = "/Users/u/.pi-agent-gui/slots/blue/skills/platform/ui-design-refinement";
const readSkill = (turnNo: number, base = DEPLOYED) => ev({ turnNo, tool: { name: "read", input: JSON.stringify({ path: `${base}/SKILL.md` }), status: "completed" } });

describe("usedUiSkill", () => {
  it("counts a slash invocation, reading the deployed SKILL.md, or running a deployed script; not a worktree copy; not other turns", () => {
    expect(usedUiSkill([ev({ turnNo: 1, kind: "notice", key: "platform-skill:1", text: "已载入平台技能：界面打磨" })], 1, 1)).toBe(true);
    expect(usedUiSkill([readSkill(1)], 1, 1)).toBe(true);
    expect(usedUiSkill([ev({ turnNo: 1, tool: { name: "bash", input: JSON.stringify({ command: `node ${DEPLOYED}/scripts/snapshot.mjs --workspace .` }), status: "completed" } })], 1, 1)).toBe(true);
    expect(usedUiSkill([readSkill(1, "/repo/.pi-worktrees/rt-x/skills/platform/ui-design-refinement")], 1, 1)).toBe(false);   // 开发这个技能本身
    expect(usedUiSkill([ev({ turnNo: 1, kind: "notice", key: "platform-skill:1", text: "已载入平台技能：产品宣传视频" })], 1, 1)).toBe(false);
    expect(usedUiSkill([readSkill(1)], 2, 3)).toBe(false);                                                                  // 不在本轮 / 补救链范围内
  });

  it("developing the skill in a worktree is not using it — relative paths, other-slot-less absolute paths, mere mentions (regression: the check fired on the dev session itself)", () => {
    const run = (command: string) => ev({ turnNo: 1, tool: { name: "bash", input: JSON.stringify({ command }), status: "completed" } });
    expect(usedUiSkill([run("S=skills/platform/ui-design-refinement/scripts && node $S/snapshot.mjs --workspace apps/word-detective")], 1, 1)).toBe(false);
    expect(usedUiSkill([run("node skills/platform/ui-design-refinement/scripts/generate-report.mjs --run ui-20261122-1800-ab99")], 1, 1)).toBe(false);
    expect(usedUiSkill([run("git add -A skills docs/requirements/ui-design-refinement && cat skills/platform/ui-design-refinement/SKILL.md")], 1, 1)).toBe(false);
    expect(usedUiSkill([run("cat /Users/u/repo/skills/platform/ui-design-refinement/SKILL.md")], 1, 1)).toBe(false);
    // 一个会话在任何槽位（blue / green）读到的已部署路径都算；平台实例自己的技能根目录也算
    expect(usedUiSkill([readSkill(1, "/Users/u/.pi-agent-gui/slots/green/skills/platform/ui-design-refinement")], 1, 1)).toBe(true);
    expect(usedUiSkill([run("cat /opt/heji/skills/platform/ui-design-refinement/SKILL.md")], 1, 1, "/opt/heji/skills/platform")).toBe(true);
    expect(usedUiSkill([run("cat /opt/heji/skills/platform/ui-design-refinement/SKILL.md")], 1, 1)).toBe(false);
    expect(usedUiSkill([run("cat /r/.pi-worktrees/x/skills/platform/ui-design-refinement/SKILL.md")], 1, 1, "/r/.pi-worktrees/x/skills/platform")).toBe(false);
  });
});

describe("uiReportProblems", () => {
  let dir: string, ws: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ui-report-")); ws = join(dir, "ws"); mkdirSync(ws); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const used = [readSkill(1)];
  const check = (assistantText: string) => uiReportProblems({ events: used, since: 1, turnNo: 1, assistantText, workspace: ws });
  /** 按脚本的约定写一份报告（meta 标记 + 同目录 report.json 的哈希） */
  const writeReport = (rel: string, json: Record<string, unknown> = { runId: RUN, mode: "review" }, metaSha?: string) => {
    const d = join(ws, rel); mkdirSync(d, { recursive: true });
    const raw = `${JSON.stringify(json, null, 2)}\n`;
    writeFileSync(join(d, "report.json"), raw);
    writeFileSync(join(d, "report.html"), `<!doctype html><meta name="pi-ui-report" content="${RUN}:${metaSha ?? createHash("sha256").update(raw).digest("hex")}"><body>x`);
    return join(d, "report.html");
  };

  it("is not applicable when the skill was not used, or the reply opts out", () => {
    expect(uiReportProblems({ events: [], since: 1, turnNo: 1, assistantText: "好了", workspace: ws })).toBeUndefined();
    expect(check(`${UI_REPORT_OPT_OUT}，这是个后端问题。`)).toBeUndefined();
  });
  it("passes with a script-made report, absolute or relative, in a link or inline", () => {
    const abs = writeReport(`.ui-refinement-runs/${RUN}`);
    expect(check(`**界面检查报告**\n报告：[report.html](${abs})`)).toEqual([]);
    expect(check("报告：`.ui-refinement-runs/" + RUN + "/report.html`")).toEqual([]);
  });
  it("fails without a link, with a missing file, a hand-written page, a tampered json, a mismatching runId, or a non-review report", () => {
    expect(check("检查完了，问题很多。")![0]).toContain("没有检查报告");
    expect(check("[报告](/nope/report.html)")![0]).toContain("文件不存在");
    mkdirSync(join(ws, "hand")); writeFileSync(join(ws, "hand/report.html"), "<html>手写</html>");
    expect(check("[报告](hand/report.html)")![0]).toContain("疑似手写");
    const ok = writeReport("a"); writeFileSync(join(ws, "a/report.json"), JSON.stringify({ runId: RUN, mode: "review", findings: ["改过"] }));
    expect(check(`[报告](${ok})`)![0]).toContain("被改过");
    expect(check(`[报告](${writeReport("b", { runId: "ui-20261122-1801-zz99", mode: "review" })})`)![0]).toContain("runId");
    expect(check(`[报告](${writeReport("c", { runId: RUN, mode: "refine" })})`)![0]).toContain("只开放检查");
    expect(check(`[报告](${writeReport("d", { runId: RUN, mode: "review" }, "0".repeat(64))})`)![0]).toContain("被改过");
  });
  it("one valid report among several references is enough", () => {
    const good = writeReport("good");
    expect(check(`旧的 [x](/nope/report.html)，新的 [y](${good})`)).toEqual([]);
  });
});

describe("contract: what generate-report.mjs writes passes the platform check", () => {
  let repo: string, runs: string;
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  const node = (file: string, args: string[]) => spawnSync("node", [join(SKILL, "scripts", file), ...args, "--runs-dir", runs], { cwd: repo, encoding: "utf8" });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ui-contract-repo-")); runs = mkdtempSync(join(tmpdir(), "ui-contract-runs-"));
    git("init", "-q", "-b", "main"); mkdirSync(join(repo, "apps/word-detective"), { recursive: true });
    writeFileSync(join(repo, "apps/word-detective/index.html"), "<h1>v1</h1>\n"); git("add", "-A"); git("commit", "-q", "-m", "init");
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(runs, { recursive: true, force: true }); });

  it("review: html + json copy land in the workspace, are excluded from git, embed the screenshots, and the chat summary is short and fixed", () => {
    expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN]).status).toBe(0);
    // 1×1 PNG：够 data URI 用
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const shot = (name: string, theme: string, receipt: string, body = png) => { const f = join(runs, name); writeFileSync(f, body); expect(node("record-capture.mjs", ["--run", RUN, "--phase", "before", "--route", "/", "--viewport", "390x844", "--theme", theme, "--receipt", receipt, "--path", f]).status).toBe(0); };
    shot("l.png", "light", "r-light-0001"); shot("d.png", "dark", "r-dark-0001");              // 同样的字节 = 浅色与夜间相同
    writeFileSync(join(runs, RUN, "report.draft.json"), JSON.stringify({
      appId: "heji-web", mode: "review", status: "completed", verification: "not_run", inspection: "browser", summary: "没有夜间主题 <script>alert(1)</script>",
      findings: [{ id: "F1", severity: "Major", dimension: "consistency", location: "全局样式", impact: "夜间刺眼。其余说明。", evidence: ["receipt:r-dark-0001", "code: a<b>c"], recommendation: "补夜间配色" }]
    }));
    const r = node("generate-report.mjs", ["--run", RUN]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { reportHtml: string; chatSummary: string };
    expect(out.reportHtml).toBe(join(repo, ".ui-refinement-runs", RUN, "report.html"));
    expect(existsSync(join(repo, ".ui-refinement-runs", RUN, "report.json"))).toBe(true);
    expect(git("status", "--porcelain")).toBe("");                                               // 交付目录不进提交
    const html = readFileSync(out.reportHtml, "utf8");
    expect(html).toContain("data:image/png;base64,");                                            // 截图内嵌
    expect(html).toContain("与浅色完全相同");
    expect(html).not.toContain("<script>alert(1)</script>");                                     // 用户文字被转义
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("a&lt;b&gt;c");
    expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i);              // 不引用外部资源（平台预览沙箱不允许）
    const lines = out.chatSummary.split("\n");
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]).toBe("**界面检查报告｜Heji 主界面**（只读检查，没有改代码）");
    expect(lines.at(-1)).toBe(`报告（含截图，点开查看）：[report.html](${out.reportHtml})`);
    expect(out.chatSummary).toContain("最先看：F1（重要）全局样式 —— 夜间刺眼");
    // 契约：脚本产物 → 平台检查通过；篡改一个字节 → 不通过
    const check = () => uiReportProblems({ events: [readSkill(1)], since: 1, turnNo: 1, assistantText: out.chatSummary, workspace: repo });
    expect(check()).toEqual([]);
    writeFileSync(join(repo, ".ui-refinement-runs", RUN, "report.json"), `${readFileSync(join(repo, ".ui-refinement-runs", RUN, "report.json"), "utf8")} `);
    expect(check()![0]).toContain("被改过");
  });

  it("a clean review with no findings still yields a valid summary and report", () => {
    expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN]).status).toBe(0);
    writeFileSync(join(runs, RUN, "report.draft.json"), JSON.stringify({ appId: "word-detective", mode: "review", status: "completed", verification: "not_run", inspection: "static", summary: "没有问题", limitations: ["只读了代码"], findings: [] }));
    const out = JSON.parse(node("generate-report.mjs", ["--run", RUN]).stdout) as { chatSummary: string; reportHtml: string };
    expect(out.chatSummary).toContain("问题：没有发现需要处理的问题");
    expect(out.chatSummary).not.toContain("最先看");
    expect(readFileSync(out.reportHtml, "utf8")).toContain("没有发现需要处理的问题");
  });
});

describe("manager: enforceUiReport", () => {
  let dir: string, ws: string, mgr: RuntimeSessionManager, driver: FakeDriver;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "rt-ui-report-")); ws = join(dir, "work"); mkdirSync(ws);
    driver = new FakeDriver("codex");
    mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver }, skipRecovery: true, platformSkills: { switchesFile: join(dir, "switches.json") } });
    mgr.updateSettings({ workspaceRoots: [ws] }, "test"); await mgr.probe("codex");
  });
  afterEach(async () => { mgr.shutdown(); await tick(35); rmSync(dir, { recursive: true, force: true }); });
  const say = (i: number, text: string) => { driver.turns[i]!.sink.event({ key: `msg-${i}`, kind: "message", role: "assistant", text, source: "stream", parserVersion: "t", availability: "recorded" }); driver.turns[i]!.finish({ status: "completed" }); };
  const start = async (prompt: string) => (await mgr.create({ idempotencyKey: `ui-rep-${Math.random().toString(36).slice(2, 10)}`, runtimeKind: "codex", workspace: ws, title: "t", prompt, confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test")).session.platformSessionId;

  it("asks for the report when /界面打磨 was used and the reply has none; stops asking once a script-made report is cited", async () => {
    const pid = await start("/界面打磨 检查一下单词侦探");
    await until(() => driver.turns.length === 1);
    say(0, "我看了一下，页面不错。");
    await until(() => driver.turns.length === 2);
    const feedback = driver.turns[1]!.args.prompt;
    expect(feedback.startsWith(ENFORCEMENT_PROMPT_MARK)).toBe(true);
    for (const part of ["没有检查报告", "generate-report.mjs", "chatSummary", UI_REPORT_OPT_OUT, "不要修改任何代码"]) expect(feedback, part).toContain(part);
    expect(mgr.store.events(pid).some((e) => e.key.startsWith("ui-report-enforce:") && e.text?.includes("第 1 次"))).toBe(true);
    // 第二次仍没有报告：最后一次提醒
    say(1, "好的，还是没有。");
    await until(() => driver.turns.length === 3);
    expect(driver.turns[2]!.args.prompt).toContain("第 2 次");
    // 第三次仍没有：不再提醒，留一条通知
    say(2, "仍然没有。");
    await until(() => mgr.store.events(pid).some((e) => e.text?.includes("仍未交付")));
    await tick(80);
    expect(driver.turns).toHaveLength(3);
  });

  it("does nothing for sessions that did not use the skill, and accepts the opt-out phrase", async () => {
    await start("帮我写个排序函数");
    await until(() => driver.turns.length === 1);
    say(0, "写好了。");
    await tick(150);
    expect(driver.turns).toHaveLength(1);
    await start("/界面打磨 看一下这个页面");
    await until(() => driver.turns.length === 2);
    say(1, `${UI_REPORT_OPT_OUT}：你问的是后端接口，不是界面。`);
    await tick(150);
    expect(driver.turns).toHaveLength(2);
  });

  it("is off when the skill is disabled", async () => {
    mgr.platformSkillSwitches!.set("ui-design-refinement", false);
    await start("/界面打磨 检查一下");           // 禁用后不会展开，也就没有「用了技能」的证据
    await until(() => driver.turns.length === 1);
    say(0, "好的。");
    await tick(150);
    expect(driver.turns).toHaveLength(1);
  });
});
