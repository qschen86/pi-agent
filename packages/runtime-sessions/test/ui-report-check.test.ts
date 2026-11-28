/**
 * 「界面打磨」轻量交付检查（ui-report-check.ts + manager.enforceUiReport）：
 *   1. 纯对话需求澄清 / 定调轮次直接放行，不误杀；
 *   2. 运行了 preview.mjs build / generate-report.mjs 或回复里引用了 preview.html / report.html 时，
 *      核对脚本签名与同目录 JSON 哈希，拦截缺失链接、手写假页与篡改内容。
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
const RUN = "ui-20261124-1800-ab99";
const ev = (e: Partial<ProjectedEvent> & { turnNo: number }): ProjectedEvent =>
  ({ key: `k-${Math.random()}`, kind: "tool", source: "stream", parserVersion: "t", availability: "recorded", ...e } as ProjectedEvent);
const DEPLOYED = "/Users/u/.pi-agent-gui/slots/blue/skills/platform/ui-design-refinement";
const readSkill = (turnNo: number, base = DEPLOYED) =>
  ev({ turnNo, tool: { name: "read", input: JSON.stringify({ path: `${base}/SKILL.md` }), status: "completed" } });
const runScript = (turnNo: number, cmd: string, base = DEPLOYED) =>
  ev({ turnNo, tool: { name: "bash", input: JSON.stringify({ command: `node ${base}/scripts/${cmd}` }), status: "completed" } });

describe("usedUiSkill", () => {
  it("counts slash invocation, reading deployed SKILL.md, or running deployed script; ignores worktree dev copies", () => {
    expect(usedUiSkill([ev({ turnNo: 1, kind: "notice", key: "platform-skill:1", text: "已载入平台技能：界面打磨" })], 1, 1)).toBe(true);
    expect(usedUiSkill([readSkill(1)], 1, 1)).toBe(true);
    expect(usedUiSkill([runScript(1, "preview.mjs build --manifest m.json")], 1, 1)).toBe(true);
    expect(usedUiSkill([readSkill(1, "/repo/.pi-worktrees/rt-x/skills/platform/ui-design-refinement")], 1, 1)).toBe(false);
    expect(usedUiSkill([ev({ turnNo: 1, kind: "notice", key: "platform-skill:1", text: "已载入平台技能：产品宣传视频" })], 1, 1)).toBe(false);
    expect(usedUiSkill([readSkill(1)], 2, 3)).toBe(false);
  });
});

describe("uiReportProblems", () => {
  let dir: string, ws: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ui-report-")); ws = join(dir, "ws"); mkdirSync(ws); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeReport = (rel: string, json: Record<string, unknown> = { runId: RUN, mode: "review" }, metaSha?: string) => {
    const d = join(ws, rel); mkdirSync(d, { recursive: true });
    const raw = `${JSON.stringify(json, null, 2)}\n`;
    writeFileSync(join(d, "report.json"), raw);
    writeFileSync(join(d, "report.html"), `<!doctype html><meta name="pi-ui-report" content="${RUN}:${metaSha ?? createHash("sha256").update(raw).digest("hex")}"><body>x`);
    return join(d, "report.html");
  };

  const writePreview = (rel: string, json: Record<string, unknown> = { schemaVersion: 2, mode: "preview", runId: RUN, directions: [{ id: "A" }] }, metaSha?: string) => {
    const d = join(ws, rel); mkdirSync(d, { recursive: true });
    const raw = `${JSON.stringify(json, null, 2)}\n`;
    writeFileSync(join(d, "preview.json"), raw);
    writeFileSync(join(d, "preview.html"), `<!doctype html><meta name="pi-ui-preview" content="${RUN}:${metaSha ?? createHash("sha256").update(raw).digest("hex")}"><body>x`);
    return join(d, "preview.html");
  };

  it("allows pure conversation / requirement clarification turns without forcing HTML delivery", () => {
    expect(uiReportProblems({ events: [readSkill(1)], since: 1, turnNo: 1, assistantText: "开始前想和你确认两个问题：1. 更偏向稳重还是轻快？2. 优先手机还是桌面？", workspace: ws })).toBeUndefined();
    expect(uiReportProblems({ events: [readSkill(1)], since: 1, turnNo: 1, assistantText: `${UI_REPORT_OPT_OUT}，这是后端接口问题。`, workspace: ws })).toBeUndefined();
    expect(uiReportProblems({ events: [], since: 1, turnNo: 1, assistantText: "普通对话", workspace: ws })).toBeUndefined();
  });

  it("validates preview.html when preview.mjs build ran or preview.html is cited", () => {
    const good = writePreview(`.ui-refinement-runs/${RUN}`);
    const events = [readSkill(1), runScript(1, `preview.mjs build --run ${RUN} --manifest m.json`)];
    expect(uiReportProblems({ events, since: 1, turnNo: 1, assistantText: `我准备了两套交互原型，点开体验：[preview.html](${good})`, workspace: ws })).toEqual([]);
    // 跑了 preview.mjs build 但没附链接
    expect(uiReportProblems({ events, since: 1, turnNo: 1, assistantText: "原型做好了，请查看。", workspace: ws })![0]).toContain("没有附上 preview.html");
    // 手写假 preview.html（即使用户轮次没跑脚本）
    mkdirSync(join(ws, "fake")); writeFileSync(join(ws, "fake/preview.html"), "<html>假原型</html>");
    expect(uiReportProblems({ events: [readSkill(1)], since: 1, turnNo: 1, assistantText: "[原型](fake/preview.html)", workspace: ws })![0]).toContain("疑似手写");
    // 篡改 preview.json
    writeFileSync(join(ws, `.ui-refinement-runs/${RUN}/preview.json`), JSON.stringify({ schemaVersion: 2, mode: "preview", runId: RUN, directions: [{ id: "Z" }] }));
    expect(uiReportProblems({ events, since: 1, turnNo: 1, assistantText: `[preview.html](${good})`, workspace: ws })![0]).toContain("被改过");
  });

  it("validates report.html for review and deliver modes", () => {
    const rev = writeReport(`.ui-refinement-runs/${RUN}`, { runId: RUN, mode: "review" });
    const del = writeReport(`deliver/${RUN}`, { runId: RUN, mode: "deliver" });
    const events = [readSkill(1), runScript(1, `generate-report.mjs --run ${RUN}`)];
    expect(uiReportProblems({ events, since: 1, turnNo: 1, assistantText: `体检完成，详见 [report.html](${rev})`, workspace: ws })).toEqual([]);
    expect(uiReportProblems({ events, since: 1, turnNo: 1, assistantText: `落地完成，详见 [report.html](${del})`, workspace: ws })).toEqual([]);
    expect(uiReportProblems({ events, since: 1, turnNo: 1, assistantText: "检查完了，一切正常。", workspace: ws })![0]).toContain("没有附上 report.html");
    expect(uiReportProblems({ events: [readSkill(1)], since: 1, turnNo: 1, assistantText: `[report](${writeReport("bad", { runId: RUN, mode: "refine" })})`, workspace: ws })![0]).toContain("只能是 review");
  });
});

describe("contract: preview.mjs & generate-report.mjs pass platform check", () => {
  let repo: string, runs: string;
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  const node = (file: string, args: string[]) => spawnSync("node", [join(SKILL, "scripts", file), ...args, "--runs-dir", runs], { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ui-contract-repo-")); runs = mkdtempSync(join(tmpdir(), "ui-contract-runs-"));
    git("init", "-q", "-b", "main"); mkdirSync(join(repo, "apps/word-detective"), { recursive: true });
    writeFileSync(join(repo, "apps/word-detective/index.html"), "<h1>v1</h1>\n"); git("add", "-A"); git("commit", "-q", "-m", "init");
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(runs, { recursive: true, force: true }); });

  it("preview.mjs build outputs signed preview.html that passes uiReportProblems", () => {
    const protoDir = join(runs, "proto");
    mkdirSync(protoDir, { recursive: true });
    writeFileSync(join(protoDir, "a.html"), "<!doctype html><html><body><h1>方案 A</h1></body></html>");
    writeFileSync(join(protoDir, "manifest.json"), JSON.stringify({
      appId: "heji-web", appName: "Heji 主界面", title: "顶栏微调", requirement: "更清爽", viewports: ["mobile", "desktop"], themes: ["light", "dark"],
      directions: [{ id: "A", name: "克制风", screens: [{ id: "home", label: "首页", file: "a.html" }] }]
    }));
    const r = node("preview.mjs", ["build", "--run", RUN, "--manifest", join(protoDir, "manifest.json")]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { previewHtml: string };
    expect(existsSync(out.previewHtml)).toBe(true);
    expect(git("status", "--porcelain")).toBe("");
    const events = [readSkill(1), runScript(1, `preview.mjs build --run ${RUN} --manifest m.json`)];
    expect(uiReportProblems({ events, since: 1, turnNo: 1, assistantText: `请点开预览：[preview.html](${out.previewHtml})`, workspace: repo })).toEqual([]);
  });

  it("generate-report.mjs outputs signed report.html that passes uiReportProblems and detects tampering", () => {
    expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN]).status).toBe(0);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const shot = (name: string, theme: string, receipt: string) => {
      const f = join(runs, name); writeFileSync(f, png);
      expect(node("record-capture.mjs", ["--run", RUN, "--phase", "before", "--route", "/", "--viewport", "390x844", "--theme", theme, "--receipt", receipt, "--path", f]).status).toBe(0);
    };
    shot("l.png", "light", "r-light-0001"); shot("d.png", "dark", "r-dark-0001");
    writeFileSync(join(runs, RUN, "report.draft.json"), JSON.stringify({
      appId: "heji-web", mode: "review", status: "completed", verification: "not_run", inspection: "browser", summary: "检查摘要 <script>alert(1)</script>",
      findings: [{ id: "F1", severity: "Major", dimension: "consistency", location: "全局样式", impact: "夜间对比偏弱", evidence: ["receipt:r-dark-0001"], recommendation: "调深底色" }]
    }));
    const r = node("generate-report.mjs", ["--run", RUN]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { reportHtml: string };
    const html = readFileSync(out.reportHtml, "utf8");
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain("<script>alert(1)</script>");
    const events = [readSkill(1), runScript(1, `generate-report.mjs --run ${RUN}`)];
    expect(uiReportProblems({ events, since: 1, turnNo: 1, assistantText: `体检结果见 [report.html](${out.reportHtml})`, workspace: repo })).toEqual([]);
    writeFileSync(join(repo, ".ui-refinement-runs", RUN, "report.json"), `${readFileSync(join(repo, ".ui-refinement-runs", RUN, "report.json"), "utf8")} `);
    expect(uiReportProblems({ events, since: 1, turnNo: 1, assistantText: `[report.html](${out.reportHtml})`, workspace: repo })![0]).toContain("被改过");
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
  const say = (i: number, text: string) => {
    driver.turns[i]!.sink.event({ key: `msg-${i}`, kind: "message", role: "assistant", text, source: "stream", parserVersion: "t", availability: "recorded" });
    driver.turns[i]!.finish({ status: "completed" });
  };
  const start = async (prompt: string) =>
    (await mgr.create({ idempotencyKey: `ui-rep-${Math.random().toString(36).slice(2, 10)}`, runtimeKind: "codex", workspace: ws, title: "t", prompt, confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test")).session.platformSessionId;

  it("allows clarification turns when /界面打磨 is used, and catches fake preview/report links", async () => {
    const pid = await start("/界面打磨 帮我重新设计首页");
    await until(() => driver.turns.length === 1);
    // 第一轮纯对话澄清：应当直接放行，不触发补救续发！
    say(0, "动手画原型前想确认两个问题：1. 更偏向暖纸风还是清爽工具风？2. 需要兼顾 PC 桌面端吗？");
    await tick(150);
    expect(driver.turns).toHaveLength(1);

    // 新会话：引用手写的假 preview.html 应当被门禁拦截
    const pid2 = await start("/界面打磨 帮我做一个方案");
    await until(() => driver.turns.length === 2);
    writeFileSync(join(ws, "preview.html"), "<html>手写假原型</html>");
    say(1, "我给你画好了原型，点开看：[preview.html](preview.html)");
    await until(() => driver.turns.length === 3);
    const feedback = driver.turns[2]!.args.prompt;
    expect(feedback.startsWith(ENFORCEMENT_PROMPT_MARK)).toBe(true);
    expect(feedback).toContain("疑似手写");
    expect(feedback).toContain("preview.mjs build");
    expect(mgr.store.events(pid2).some((e) => e.key.startsWith("ui-report-enforce:") && e.text?.includes("第 1 次"))).toBe(true);
    // 仍返回无效回复直到提醒耗尽
    say(2, "还是这个 [preview.html](preview.html)");
    await until(() => driver.turns.length === 4);
    say(3, "依然是 [preview.html](preview.html)");
    await until(() => mgr.store.events(pid2).some((e) => e.text?.includes("仍未交付")));
    await tick(80);
    expect(driver.turns).toHaveLength(4);
    void pid;
  });
});
