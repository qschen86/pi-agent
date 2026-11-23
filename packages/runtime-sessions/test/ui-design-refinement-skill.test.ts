/**
 * 平台技能「界面打磨」（docs/requirements/ui-design-refinement，M0）：
 * 技能包本身（注册、描述、引用的文件）、技能开关（禁用 = 不存在，普通开发提示词不变）、
 * 以及技能自带脚本（目标解析、运行快照与改动对比、报告校验）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PLATFORM_SKILLS_ROOT, PLATFORM_SKILL_MAX_CHARS, expandPlatformSkills, listPlatformSkills, platformSkillIndex, preparePlatformPrompt } from "../src/platform-skills.js";
import { PlatformSkillSwitches } from "../src/platform-skill-switches.js";
import { RuntimeSessionManager } from "../src/manager.js";
import { FakeDriver, until, tick } from "./fake-driver.js";

const ID = "ui-design-refinement";
const SKILL = join(PLATFORM_SKILLS_ROOT, ID);
const script = (name: string) => join(SKILL, "scripts", name);
// 技能自带的最小 schema 校验（零依赖）：测试里直接用它校验请求协议
const validateRequest = (req: unknown): string[] => {
  const schema = JSON.parse(readFileSync(join(SKILL, "schemas", "ui-skill-request.schema.json"), "utf8"));
  const mod = spawnSync("node", ["--input-type=module", "-e", `import {validate} from ${JSON.stringify(join(SKILL, "scripts/lib/schema.mjs"))};console.log(JSON.stringify(validate(${JSON.stringify(schema)}, ${JSON.stringify(req)})))`], { encoding: "utf8" });
  return JSON.parse(mod.stdout || "[\"校验脚本没有输出\"]") as string[];
};

describe("skill package", () => {
  it("is registered with a 'when to use' description", () => {
    const s = listPlatformSkills().find((x) => x.id === ID)!;
    expect(s).toMatchObject({ name: "界面打磨", trigger: "/界面打磨" });
    expect(s.description).toMatch(/^当用户.+时使用/);
    for (const cue of ["检查", "打磨", "已有应用"]) expect(s.description, cue).toContain(cue);
    expect(s.description).not.toContain("baoyu");
    expect(platformSkillIndex()).toContain(s.description);
  });

  it("fits the platform limit and every path it points at exists", () => {
    const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    expect(text.length).toBeLessThan(PLATFORM_SKILL_MAX_CHARS);
    const paths = [...text.matchAll(/<SKILL_DIR>\/([\w./-]+?\.(?:mjs|md|json))/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(5);
    for (const p of paths) expect(existsSync(join(SKILL, p)), p).toBe(true);
    expect(expandPlatformSkills("/界面打磨 检查一下").skills.map((x) => x.id)).toEqual([ID]);
  });

  it("opens all four phases with separate referenced workflows", () => {
    const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    expect(text).toContain("已开放 `review`");
    expect(text).toContain("`refine`");
    expect(text).toContain("references/refine.md");
    expect(text).toContain("generate-handbook-delivery.mjs");
    expect(text).toContain("references/repair.md");
    expect(text).toContain("refine 只改目标应用手册，不改应用代码");
    expect(text).toMatch(/\| `evolve` \|[^\n]*\*\*已开放\*\*/);
    expect(text).toMatch(/\| `review` \|[^\n]*\*\*已开放\*\*/);
    expect(text).toContain("references/evolve.md");
    // 开放中的步骤里不再出现「改代码」的指令
    const steps = text.slice(text.indexOf("## 1. Review 流程"), text.indexOf("## 2."));
    expect(steps).not.toMatch(/授权后改代码|Deliver|不提交、不部署/);
  });

  it("tells the model how to deliver: paste chatSummary as the final reply, cite report.html, and the opt-out phrase", () => {
    const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    for (const part of ["chatSummary", "report.html", "原样作为最终回复", "本次未使用界面打磨", "平台会检查"]) expect(text, part).toContain(part);
  });

  it("states the hard boundaries a model must follow", () => {
    const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    for (const rule of ["review", "不能", "没跑的检查不要说通过", "北京时间", "禁止", "platform_browser"]) expect(text, rule).toContain(rule);
  });

  it("targets.json lists real workspaces", () => {
    const registry = JSON.parse(readFileSync(join(SKILL, "targets.json"), "utf8")) as { targets: Array<{ appId: string; workspace: string }> };
    expect(new Set(registry.targets.map((t) => t.appId)).size).toBe(registry.targets.length);
    for (const t of registry.targets) expect(existsSync(join(PLATFORM_SKILLS_ROOT, "../..", t.workspace)), t.appId).toBe(true);
  });
});

describe("skill switches", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "skill-switch-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a disabled skill behaves as if it did not exist: no menu entry, no expansion, no first-turn index line", () => {
    expect(listPlatformSkills(PLATFORM_SKILLS_ROOT, [ID]).some((s) => s.id === ID)).toBe(false);
    const prompt = "/界面打磨 检查一下这个应用";
    expect(expandPlatformSkills(prompt, PLATFORM_SKILLS_ROOT, [ID])).toEqual({ prompt, skills: [] });
    expect(platformSkillIndex(PLATFORM_SKILLS_ROOT, [], [ID])).not.toContain("界面打磨");
    const prepared = preparePlatformPrompt(prompt, { firstTurn: true, disabled: [ID] });
    expect(prepared.prompt).not.toContain("<<<技能说明开始>>>");
    expect(prepared.prompt).not.toContain("界面打磨（");
    expect(prepared.prompt.endsWith(prompt)).toBe(true);
    // 其他技能不受影响
    expect(prepared.prompt).toContain("产品宣传视频（");
  });

  it("persists, validates and survives a corrupt file", () => {
    const file = join(dir, "platform-skills.json");
    const sw = new PlatformSkillSwitches(file);
    expect(sw.get().skills.find((s) => s.id === ID)?.enabled).toBe(true);
    expect(sw.set(ID, false).skills.find((s) => s.id === ID)?.enabled).toBe(false);
    expect(new PlatformSkillSwitches(file).disabledIds()).toEqual([ID]);
    expect(() => sw.set("no-such-skill", false)).toThrow(/没有这个技能/);
    expect(() => sw.set(ID, "yes")).toThrow(/true 或 false/);
    expect(sw.set(ID, true).skills.find((s) => s.id === ID)?.enabled).toBe(true);
    writeFileSync(file, "{ not json");
    expect(new PlatformSkillSwitches(file).disabledIds()).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("{ not json");   // 读到坏文件不覆盖，等下一次保存
  });

  it("keeps a disabled id even when the skill directory is gone (uninstall → reinstall stays disabled)", () => {
    const file = join(dir, "s.json");
    writeFileSync(file, JSON.stringify({ schema: 1, disabled: ["gone-skill"], revision: 3, updatedAt: null }));
    const sw = new PlatformSkillSwitches(file);
    expect(sw.disabledIds()).toEqual(["gone-skill"]);
    sw.set(ID, false);
    expect(sw.disabledIds()).toEqual(["gone-skill", ID]);
  });

  describe("dispatch", () => {
    let ws: string, mgr: RuntimeSessionManager, driver: FakeDriver;
    beforeEach(async () => {
      ws = join(dir, "work"); mkdirSync(ws);
      driver = new FakeDriver("codex");
      mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver }, skipRecovery: true, platformSkills: { switchesFile: join(dir, "switches.json") } });
      mgr.updateSettings({ workspaceRoots: [ws] }, "test"); await mgr.probe("codex");
    });
    afterEach(async () => { mgr.shutdown(); await tick(35); });

    it("disabling takes effect on the next dispatch without a restart", async () => {
      mgr.platformSkillSwitches!.set(ID, false);
      await mgr.create({ idempotencyKey: "skill-off-1", runtimeKind: "codex", workspace: ws, title: "t", prompt: "/界面打磨 检查一下", confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test");
      await until(() => driver.turns.length === 1);
      const sent = driver.turns[0]!.args.prompt;
      expect(sent).not.toContain("界面打磨（");
      expect(sent).not.toContain("<<<技能说明开始>>>");
      mgr.platformSkillSwitches!.set(ID, true);
      await mgr.create({ idempotencyKey: "skill-on-1", runtimeKind: "codex", workspace: ws, title: "t2", prompt: "/界面打磨 检查一下", confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test");
      await until(() => driver.turns.length === 2);
      expect(driver.turns[1]!.args.prompt).toContain("<<<技能说明开始>>>");
    });
  });
});

describe("skill scripts", () => {
  let repo: string, runs: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  const node = (file: string, args: string[], cwd = repo) => spawnSync("node", [script(file), ...args], { cwd, encoding: "utf8" });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ui-skill-repo-")); runs = mkdtempSync(join(tmpdir(), "ui-skill-runs-"));
    git("init", "-q", "-b", "main");
    mkdirSync(join(repo, "apps/word-detective"), { recursive: true }); mkdirSync(join(repo, "apps/wrong-book"), { recursive: true });
    writeFileSync(join(repo, "apps/word-detective/index.html"), "<h1>v1</h1>\n");
    writeFileSync(join(repo, "apps/wrong-book/index.html"), "<h1>w1</h1>\n");
    git("add", "-A"); git("commit", "-q", "-m", "init");
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(runs, { recursive: true, force: true }); });

  describe("resolve-target", () => {
    it("resolves from the working directory, and never guesses from the repo root", () => {
      const inside = node("resolve-target.mjs", ["--cwd", join(repo, "apps/word-detective")]);
      expect(inside.status).toBe(0);
      expect(JSON.parse(inside.stdout)).toMatchObject({ status: "resolved", appId: "word-detective", target: { workspaceAbs: expect.stringContaining("apps/word-detective") } });
      const root = node("resolve-target.mjs", ["--cwd", repo]);
      expect(root.status).toBe(3);
      expect(JSON.parse(root.stdout)).toMatchObject({ status: "ambiguous", candidates: expect.arrayContaining(["word-detective", "wrong-book", "heji-web"]) });
      const other = node("resolve-target.mjs", ["--cwd", join(repo, "apps")]);
      expect(JSON.parse(other.stdout).status).toBe("ambiguous");
    });
    it("explicit --app resolves, unknown app is reported", () => {
      expect(JSON.parse(node("resolve-target.mjs", ["--app", "wrong-book", "--cwd", repo]).stdout)).toMatchObject({ status: "resolved", appId: "wrong-book" });
      const bad = node("resolve-target.mjs", ["--app", "nope"]);
      expect(bad.status).toBe(3);
      expect(JSON.parse(bad.stdout).status).toBe("unknown");
    });
  });

  describe("snapshot + diff-since", () => {
    const RUN = "ui-20261122-1530-ab12";
    it("review that changes nothing passes; a write is caught with exit code 2", () => {
      expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN, "--runs-dir", runs]).status).toBe(0);
      expect(node("diff-since.mjs", ["--run", RUN, "--runs-dir", runs, "--expect-readonly"]).status).toBe(0);
      writeFileSync(join(repo, "apps/word-detective/index.html"), "<h1>changed</h1>\n");
      const r = node("diff-since.mjs", ["--run", RUN, "--runs-dir", runs, "--expect-readonly"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("apps/word-detective/index.html");
    });

    it("only reports what changed after the snapshot: pre-existing dirty files are not ours; added and deleted are told apart", () => {
      writeFileSync(join(repo, "apps/wrong-book/index.html"), "<h1>user edit</h1>\n");     // 快照前就脏
      node("snapshot.mjs", ["--workspace", repo, "--run", RUN, "--runs-dir", runs]);
      const snap = JSON.parse(readFileSync(join(runs, RUN, "snapshot.json"), "utf8"));
      expect(snap.dirty.map((d: { path: string }) => d.path)).toEqual(["apps/wrong-book/index.html"]);
      expect(existsSync(join(runs, RUN, "snapshot-files/apps/wrong-book/index.html"))).toBe(true);
      expect(JSON.parse(node("diff-since.mjs", ["--run", RUN, "--runs-dir", runs]).stdout).changedFiles).toEqual([]);

      writeFileSync(join(repo, "apps/word-detective/index.html"), "<h1>v2</h1>\n");
      writeFileSync(join(repo, "apps/word-detective/new.css"), "a{}\n");
      rmSync(join(repo, "apps/wrong-book/index.html"));
      const out = JSON.parse(node("diff-since.mjs", ["--run", RUN, "--runs-dir", runs]).stdout) as { changes: Array<{ path: string; status: string; beforeSha256: string | null; afterSha256: string | null; beforeSource: string }> };
      const by = Object.fromEntries(out.changes.map((c) => [c.path, c]));
      expect(by["apps/word-detective/index.html"]).toMatchObject({ status: "modified", beforeSource: "head" });
      expect(by["apps/word-detective/new.css"]).toMatchObject({ status: "added", beforeSha256: null });
      expect(by["apps/wrong-book/index.html"]).toMatchObject({ status: "deleted", beforeSource: "snapshot", afterSha256: null });
      expect(existsSync(join(runs, RUN, "changes.json"))).toBe(true);
    });

    it("also sees changes that were committed after the snapshot, and ignores the local runs directory", () => {
      node("snapshot.mjs", ["--workspace", repo, "--run", RUN, "--runs-dir", runs]);
      writeFileSync(join(repo, "apps/word-detective/index.html"), "<h1>v2</h1>\n");
      git("commit", "-q", "-am", "polish");
      mkdirSync(join(repo, ".ui-refinement-runs/x"), { recursive: true });
      writeFileSync(join(repo, ".ui-refinement-runs/x/report.md"), "r");
      const out = JSON.parse(node("diff-since.mjs", ["--run", RUN, "--runs-dir", runs]).stdout) as { changedFiles: string[] };
      expect(out.changedFiles).toEqual(["apps/word-detective/index.html"]);
    });

    it("rejects a malformed run id and a duplicate snapshot", () => {
      expect(node("snapshot.mjs", ["--workspace", repo, "--run", "bad id", "--runs-dir", runs]).status).not.toBe(0);
      expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN, "--runs-dir", runs]).status).toBe(0);
      expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN, "--runs-dir", runs]).status).not.toBe(0);
    });

    it("falls back to an excluded .ui-refinement-runs when no runs dir is writable", () => {
      const r = spawnSync("node", [script("snapshot.mjs"), "--workspace", repo, "--run", RUN], { cwd: repo, encoding: "utf8", env: { ...process.env, PI_AGENT_WEB_DATA: "/dev/null/nope" } });
      expect(r.status).toBe(0);
      expect(existsSync(join(repo, ".ui-refinement-runs", RUN, "snapshot.json"))).toBe(true);
      expect(git("status", "--porcelain")).toBe("");        // 兜底目录已写进 .git/info/exclude，不污染工作区
    });
  });

  describe("capture-plan + record-capture (M1-1)", () => {
    const RUN = "ui-20261122-1600-cd34";
    const png = (name: string, body: string) => { const f = join(runs, name); writeFileSync(f, body); return { f, sha: createHash("sha256").update(body).digest("hex") }; };
    const record = (extra: string[], run = RUN) => node("record-capture.mjs", ["--run", run, "--runs-dir", runs, ...extra]);
    const cell = (viewport: string, theme: string, receipt: string, f: string, sha?: string, phase = "before") =>
      record(["--phase", phase, "--route", "/", "--viewport", viewport, "--theme", theme, "--receipt", receipt, "--path", f, ...(sha ? ["--sha256", sha] : [])]);

    it("plans route × viewport × theme with stable names", () => {
      const plan = JSON.parse(node("capture-plan.mjs", ["--app", "heji-web", "--routes", "/,/cases/1", "--phase", "after"]).stdout);
      expect(plan.cells).toHaveLength(12);
      expect(plan.cells[0]).toMatchObject({ name: "after-home-390x844-light", width: 390, height: 844 });
      expect(plan.cells.map((c: { name: string }) => c.name)).toContain("after-cases-1-1280x800-dark");
      expect(node("capture-plan.mjs", ["--app", "nope"]).status).toBe(3);
      expect(node("capture-plan.mjs", ["--app", "heji-web", "--routes", "no-slash"]).status).not.toBe(0);
    });

    it("only accepts real files with a receipt, checks the hash, and refuses duplicate cells and reused receipts", () => {
      const a = png("a.png", "AAA"), b = png("b.png", "BBB");
      expect(cell("390x844", "light", "r-1", a.f, a.sha).status).toBe(0);
      expect(cell("390x844", "light", "r-1b", b.f).stderr).toContain("已登记过");
      expect(cell("390x844", "dark", "r-1", b.f).stderr).toContain("已用于另一个格子");
      expect(cell("390x844", "dark", "r-2", a.f, "0".repeat(64)).stderr).toContain("哈希不一致");
      expect(cell("390x844", "dark", "r-2", join(runs, "missing.png")).stderr).toContain("不存在");
      expect(cell("390x844", "sepia", "r-2", b.f).stderr).toContain("light 或 dark");
      expect(cell("big", "dark", "r-2", b.f).stderr).toContain("390x844");
      expect(record(["--phase", "before", "--viewport", "390x844", "--theme", "dark", "--path", b.f]).stderr).toContain("--receipt");
      expect(cell("390x844", "light", "r-9", b.f, undefined).status).not.toBe(0);
      expect(record(["--phase", "before", "--route", "/", "--viewport", "390x844", "--theme", "light", "--receipt", "r-9", "--path", b.f, "--replace"]).status).toBe(0);
    });

    it("coverage lists missing cells (exit 5), flags identical light/dark shots, and --shots exports the report shape", () => {
      const same = png("same.png", "SAME"), other = png("other.png", "OTHER"), l2 = png("l2.png", "L2"), d2 = png("d2.png", "D2");
      cell("390x844", "light", "c-1", l2.f); cell("390x844", "dark", "c-2", d2.f);
      cell("768x1024", "light", "c-3", same.f);
      const dup = join(runs, "same2.png"); writeFileSync(dup, "SAME");
      cell("768x1024", "dark", "c-4", dup);
      const partial = record(["--coverage", "--app", "heji-web", "--phase", "before"]);
      expect(partial.status).toBe(5);
      const out = JSON.parse(partial.stdout);
      expect(out).toMatchObject({ expected: 6, captured: 4, sameAcrossThemes: [{ route: "/", viewport: "768x1024" }] });
      expect(out.missing).toEqual(["before-home-1280x800-light", "before-home-1280x800-dark"]);
      expect(out.warning).toContain("夜间");
      cell("1280x800", "light", "c-5", other.f);
      const o2 = png("o2.png", "O2"); cell("1280x800", "dark", "c-6", o2.f);
      const full = record(["--coverage", "--app", "heji-web", "--phase", "before"]);
      expect(full.status).toBe(0);
      expect(JSON.parse(full.stdout).missing).toEqual([]);
      expect(JSON.parse(record(["--coverage", "--app", "heji-web", "--phase", "after"]).stdout).captured).toBe(0);
      const shots = JSON.parse(record(["--shots", "--phase", "before"]).stdout);
      expect(shots).toHaveLength(6);
      expect(shots[0]).toEqual({ path: l2.f, receiptId: "c-1", viewport: "390x844", theme: "light", route: "/" });
      // 导出的形状能直接通过报告校验
      const report = { runId: RUN, appId: "heji-web", mode: "review", status: "completed", verification: "not_run", inspection: "browser", summary: "s", findings: [], changedFiles: [], artifacts: { beforeScreenshots: shots } };
      const f = join(runs, "report.json"); writeFileSync(f, JSON.stringify(report));
      expect(node("validate-report.mjs", [f]).stdout.trim()).toBe("OK");
    });
  });

  describe("generate-report (M1-2)", () => {
    const RUN = "ui-20261122-1800-ab99";
    const run = (...a: string[]) => node("generate-report.mjs", ["--run", RUN, "--runs-dir", runs, ...a]);
    const rec = (route: string, viewport: string, theme: string, receipt: string, body: string, phase = "before") => {
      const f = join(runs, `${receipt}.png`); writeFileSync(f, body);
      expect(node("record-capture.mjs", ["--run", RUN, "--runs-dir", runs, "--phase", phase, "--route", route, "--viewport", viewport, "--theme", theme, "--receipt", receipt, "--path", f]).status).toBe(0);
    };
    const draft = (over: Record<string, unknown> = {}) => ({
      appId: "heji-web", mode: "review", status: "completed", verification: "not_run", inspection: "browser", summary: "首页层级清楚，但没有夜间主题。",
      request: { appId: "heji-web", mode: "review", trigger: "user", intent: "检查一下手机端" },
      findings: [
        { id: "F2", severity: "Minor", dimension: "visual", location: "首页 / 徽章区", impact: "徽章标题被截断", evidence: ["receipt:r-light"], recommendation: "换行" },
        { id: "F1", severity: "Major", dimension: "consistency", location: "全局样式", impact: "夜间用户看到刺眼的浅色页面", evidence: ["receipt:r-dark", "code: apps/word-detective/styles.css（无 prefers-color-scheme）"], recommendation: "补夜间配色" }
      ],
      ...over
    });
    const writeDraft = (d: unknown) => writeFileSync(join(runs, RUN, "report.draft.json"), JSON.stringify(d));
    beforeEach(() => { expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN, "--runs-dir", runs]).status).toBe(0); });

    it("review: assembles facts from the run, sorts by severity, writes report.json + report.md in Beijing time", () => {
      rec("/", "390x844", "light", "r-light", "L1"); rec("/", "390x844", "dark", "r-dark", "D1");
      writeDraft(draft());
      const r = run();
      expect(r.status, r.stderr).toBe(0);
      const json = JSON.parse(readFileSync(join(runs, RUN, "report.json"), "utf8"));
      expect(json).toMatchObject({ runId: RUN, appId: "heji-web", mode: "review", verification: "not_run", inspection: "browser", changedFiles: [], appCommitBefore: git("rev-parse", "HEAD").trim() });
      expect(json.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
      expect(json.findings.map((f: { id: string }) => f.id)).toEqual(["F1", "F2"]);        // Major 在前
      expect(json.artifacts.beforeScreenshots).toHaveLength(2);
      expect(json.rollbackRef).toBeUndefined();
      expect(node("validate-report.mjs", [join(runs, RUN, "report.json")]).stdout.trim()).toBe("OK");   // 产物能独立通过校验
      const md = readFileSync(join(runs, RUN, "report.md"), "utf8");
      expect(node("record-capture.mjs", ["--run", RUN, "--runs-dir", runs, "--phase", "before", "--route", "/", "--state", "intro-dialog", "--viewport", "390x844", "--theme", "light", "--receipt", "r-state", "--path", join(runs, "r-light.png")]).status).toBe(0);
      expect(node("record-capture.mjs", ["--run", RUN, "--runs-dir", runs, "--phase", "before", "--route", "/", "--state", "Bad State", "--viewport", "390x844", "--theme", "light", "--receipt", "r-state2", "--path", join(runs, "r-light.png")]).stderr).toContain("state 只能用");
      writeDraft(draft());
      expect(run().status).toBe(0);
      const mdWithState = readFileSync(join(runs, RUN, "report.md"), "utf8");
      expect(mdWithState).toContain("## 关键状态截图");
      expect(mdWithState).toContain("| intro-dialog | 390x844 | 浅色 | 当前 |");
      const missingLine = mdWithState.split("\n").find((l) => l.includes("没有拍全"))!;   // 只缺没拍的 768 / 1280；状态截图不算矩阵格子，也不会把 390 判成缺
      expect(missingLine).toContain("/ 768x1024 浅色");
      expect(missingLine).not.toContain("390x844");
      for (const part of ["# 界面检查报告：Heji 主界面", "代码已修改：否", "（北京时间）", "## 问题清单（2）", "### F1 · Major · 设计规范一致性", "## 截图（当前）", "本次只做检查，没有修改任何代码"]) expect(md, part).toContain(part);
      expect(md.indexOf("### F1")).toBeLessThan(md.indexOf("### F2"));
      for (const banned of ["修改成功", "优化成功", "已修复"]) expect(md).not.toContain(banned);
    });

    it("adds the limitations that follow from the facts: identical light/dark shots and uncaptured cells", () => {
      rec("/", "390x844", "light", "r-light", "SAME"); rec("/", "390x844", "dark", "r-dark", "SAME");
      writeDraft(draft());
      expect(run().status).toBe(0);
      const json = JSON.parse(readFileSync(join(runs, RUN, "report.json"), "utf8"));
      expect(json.limitations.join("\n")).toContain("夜间主题未验证");
      expect(json.limitations.join("\n")).toContain("改前截图没有拍全：缺 / 768x1024 浅色");
      expect(readFileSync(join(runs, RUN, "report.md"), "utf8")).toContain("## 限制与未覆盖");
    });

    it("refuses to issue a read-only report when the workspace changed (exit 2) and writes nothing", () => {
      rec("/", "390x844", "light", "r-light", "L"); rec("/", "390x844", "dark", "r-dark", "D");
      writeDraft(draft());
      writeFileSync(join(repo, "apps/word-detective/index.html"), "<h1>sneaky</h1>\n");
      const r = run();
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("apps/word-detective/index.html");
      expect(existsSync(join(runs, RUN, "report.json"))).toBe(false);
      expect(existsSync(join(runs, RUN, "report.md"))).toBe(false);
    });

    it("rejects reports that the facts do not support", () => {
      writeDraft(draft());                                                                    // 没登记任何截图
      expect(run().stderr).toContain("没有登记任何截图");
      rec("/", "390x844", "light", "r-light", "L"); rec("/", "390x844", "dark", "r-dark", "D");
      const withEvidence = draft();
      (withEvidence.findings as Array<{ evidence: string[] }>)[0]!.evidence = ["receipt:r-nope"];
      writeDraft(withEvidence);
      expect(run().stderr).toContain("没登记的截图回执 r-nope");
      const noEvidence = draft(); (noEvidence.findings as Array<{ evidence: string[] }>)[1]!.evidence = [];
      writeDraft(noEvidence);
      expect(run().stderr).toContain("必须带证据");
      writeDraft(draft({ request: { appId: "x", mode: "polish", trigger: "user" } }));
      expect(run().stderr).toContain("$.request");
      writeDraft(draft({ verification: "passed" }));
      expect(run().stderr).toContain("verificationEvidence");
      expect(existsSync(join(runs, RUN, "report.json"))).toBe(false);
      expect(run("--input", join(runs, "nope.json")).status).not.toBe(0);
    });

    it("static inspection must say why, and the report says visual verification was not done", () => {
      writeDraft(draft({ inspection: "static", findings: [{ id: "F1", severity: "Minor", dimension: "states", location: "样式", impact: "x", recommendation: "y" }] }));
      expect(run().stderr).toContain("limitations");
      writeDraft(draft({ inspection: "static", limitations: ["页面服务起不来：端口被占用"], findings: [{ id: "F1", severity: "Minor", dimension: "states", location: "样式", impact: "x", recommendation: "y" }] }));
      expect(run().status).toBe(0);
      const md = readFileSync(join(runs, RUN, "report.md"), "utf8");
      expect(md).toContain("未做视觉验证");
      expect(md).toContain("页面服务起不来");
      expect(md).not.toContain("## 截图");
    });

    it("repair: a legacy draft claiming success cannot bypass the new plan authorization", () => {
      rec("/", "390x844", "light", "b-light", "B-L"); rec("/", "390x844", "dark", "b-dark", "B-D");
      rec("/", "390x844", "light", "a-light", "A-L", "after"); rec("/", "390x844", "dark", "a-dark", "A-D", "after");
      writeFileSync(join(repo, "apps/word-detective/index.html"), "<h1>polished</h1>\n");
      writeDraft(draft({ mode: "repair", verification: "passed", verificationEvidence: [{ kind: "command", detail: "npx vitest run apps/word-detective/test → 12 passed" }], changedFiles: ["made-up.txt"],
        findings: [{ id: "F1", severity: "Major", dimension: "visual", location: "首页", impact: "i", evidence: ["receipt:b-light"], recommendation: "r", resolved: true }] }));
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("repair-plan.json");
      expect(existsSync(join(runs, RUN, "report.json"))).toBe(false);
    });
  });

  describe("sub-apps are checked in light only (user decision 2026-11-22: sub-apps need no dark theme)", () => {
    const RUN3 = "ui-20261122-1900-cc88";
    const png = (name: string, body: string) => { const f = join(runs, name); writeFileSync(f, body); return f; };
    const rec3 = (viewport: string, theme: string, receipt: string, f: string) => expect(node("record-capture.mjs", ["--run", RUN3, "--runs-dir", runs, "--phase", "before", "--route", "/", "--viewport", viewport, "--theme", theme, "--receipt", receipt, "--path", f]).status).toBe(0);
    it("capture-plan lists light cells only for sub-apps and both themes for the main app", () => {
      const sub = JSON.parse(node("capture-plan.mjs", ["--app", "word-detective"]).stdout);
      expect(sub.themes).toEqual(["light"]);
      expect(sub.cells).toHaveLength(3);
      expect(sub.cells.every((c: { theme: string }) => c.theme === "light")).toBe(true);
      const main = JSON.parse(node("capture-plan.mjs", ["--app", "heji-web"]).stdout);
      expect(main.themes).toEqual(["light", "dark"]);
      expect(main.cells).toHaveLength(6);
      for (const id of ["pet-math-game", "challenge-island", "wrong-book"]) expect(JSON.parse(node("capture-plan.mjs", ["--app", id]).stdout).themes, id).toEqual(["light"]);
    });
    it("coverage for a sub-app is complete with light shots only, and never warns about identical themes", () => {
      expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN3, "--runs-dir", runs]).status).toBe(0);
      const same = png("s.png", "SAME");
      rec3("390x844", "light", "k-1", same); rec3("768x1024", "light", "k-2", png("k2.png", "K2")); rec3("1280x800", "light", "k-3", png("k3.png", "K3"));
      const cov = node("record-capture.mjs", ["--run", RUN3, "--runs-dir", runs, "--coverage", "--app", "word-detective", "--phase", "before"]);
      expect(cov.status, cov.stdout).toBe(0);
      expect(JSON.parse(cov.stdout)).toMatchObject({ expected: 3, captured: 3, missing: [], sameAcrossThemes: [] });
    });
    it("the report for a sub-app has a single-column light gallery, no dark limitations, and no dark shots are asked for", () => {
      expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN3, "--runs-dir", runs]).status).toBe(0);
      const same = png("s.png", "SAME");
      rec3("390x844", "light", "k-1", same); rec3("768x1024", "light", "k-2", png("k2.png", "K2")); rec3("1280x800", "light", "k-3", png("k3.png", "K3"));
      rec3("390x844", "dark", "k-4", same);                      // 多拍了一张一样的夜间图：子应用不查夜间，不能因此报「夜间未验证」
      writeFileSync(join(runs, RUN3, "report.draft.json"), JSON.stringify({ appId: "word-detective", mode: "review", status: "completed", verification: "not_run", inspection: "browser", summary: "s", findings: [] }));
      const r = node("generate-report.mjs", ["--run", RUN3, "--runs-dir", runs]);
      expect(r.status, r.stderr).toBe(0);
      const json = JSON.parse(readFileSync(join(runs, RUN3, "report.json"), "utf8"));
      expect((json.limitations ?? []).join("\n")).not.toContain("夜间");
      const html = readFileSync(join(runs, RUN3, "report.html"), "utf8");
      expect(html).toContain("该应用只检查浅色");
      expect(html).toContain('class="pair single"');
      expect(html).not.toContain("与浅色完全相同");
    });
  });

  describe("platform baseline (docs/design/platform-baseline.md)", () => {
    const BASELINE = join(PLATFORM_SKILLS_ROOT, "../../docs/design/platform-baseline.md");
    const RUN2 = "ui-20261122-1900-bb77";
    const gen = (...a: string[]) => node("generate-report.mjs", ["--run", RUN2, "--runs-dir", runs, ...a]);
    const finding = (rules?: string[]) => ({ id: "F1", severity: "Minor", dimension: "consistency", location: "全局样式", impact: "夜间刺眼", evidence: ["code: styles.css 里没有 prefers-color-scheme"], recommendation: "补夜间配色", ...(rules ? { rules } : {}) });
    const draftWith = (f: unknown) => writeFileSync(join(runs, RUN2, "report.draft.json"), JSON.stringify({ appId: "word-detective", mode: "review", status: "completed", verification: "not_run", inspection: "static", summary: "s", limitations: ["只读了代码"], findings: [f] }));
    beforeEach(() => { expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN2, "--runs-dir", runs]).status).toBe(0); });

    it("every rule has the fields Review relies on, ids are unique and in order, levels are known", () => {
      const text = readFileSync(BASELINE, "utf8");
      const blocks = text.split(/^### (?=PB-\d{3} )/m).slice(1);
      expect(blocks.length).toBe(37);
      const ids = blocks.map((b) => /^(PB-\d{3}) /.exec(b)![1]!);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(ids);
      for (const b of blocks) {
        const id = b.slice(0, 6);
        expect(b, `${id} 级别`).toMatch(/- 级别：(必须|建议)　适用：/);
        for (const field of ["规则", "怎么查", "来源"]) expect(b, `${id} ${field}`).toContain(`- ${field}：`);
        expect(b, `${id} 来源`).toMatch(/- 来源：(用户|补充)/);
        if (/- 来源：用户/.test(b)) expect(b, `${id}：用户来源要写出处`).toMatch(/- 来源：用户（[^）]+）/);
      }
      expect(text).toMatch(/^版本：\*\*v0\.1\*\*/m);
      // 子应用不需要夜间主题（用户 2026-11-22）：PB-019 只适用主界面
      expect(blocks.find((b) => b.startsWith("PB-019"))).toMatch(/适用：\*\*仅主界面/);
      // 用户记忆里的设计要求一条不漏（记忆编号都能在基线里找到）
      for (const mem of ["5bc5d17b", "2f1f8fd4", "a00873cc", "08ad8d25", "2df7b43a", "5a4a0304", "965553bb", "cd33715c", "e9080a3d", "f3e29333", "29e8de6c", "f97142da"]) expect(text, `记忆 ${mem}`).toContain(mem);
    });

    it("a finding that cites an existing rule gets its title in report.md and report.html; the json keeps the ids", () => {
      draftWith(finding(["PB-019"]));
      const r = gen();
      expect(r.status, r.stderr).toBe(0);
      const md = readFileSync(join(runs, RUN2, "report.md"), "utf8");
      expect(md).toContain("**违反平台基线**：PB-019 浅色与夜间两套主题都成立");
      expect(JSON.parse(readFileSync(join(runs, RUN2, "report.json"), "utf8")).findings[0].rules).toEqual(["PB-019"]);
      expect(readFileSync(join(runs, RUN2, "report.html"), "utf8")).toContain("PB-019 · 浅色与夜间两套主题都成立");
    });

    it("rejects a rule id that is not in the baseline or is malformed", () => {
      draftWith(finding(["PB-999"]));
      expect(gen().stderr).toContain("规则 PB-999 不在平台基线");
      draftWith(finding(["pb-1"]));
      expect(gen().stderr).toContain("rules");
      expect(existsSync(join(runs, RUN2, "report.json"))).toBe(false);
    });

    it("stamps the baseline version on the report (json, md and html)", () => {
      draftWith(finding(["PB-019"]));
      expect(gen().status).toBe(0);
      expect(JSON.parse(readFileSync(join(runs, RUN2, "report.json"), "utf8")).baselineVersion).toBe("v0.1");
      expect(readFileSync(join(runs, RUN2, "report.md"), "utf8")).toContain("平台基线：v0.1");
      expect(readFileSync(join(runs, RUN2, "report.html"), "utf8")).toContain("平台基线 v0.1");
    });

    it("the request schema takes the four stages and refuses the retired modes", () => {
      for (const mode of ["review", "refine", "repair", "evolve"]) expect(validateRequest({ appId: "a", mode, trigger: "user" })).toEqual([]);
      for (const mode of ["design", "extract"]) expect(validateRequest({ appId: "a", mode, trigger: "user" }).join()).toContain("mode");
    });
  });

  describe("start-target (M1-1)", () => {
    const RUN = "ui-20261122-1700-ef56";
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    it("starts the app, switches port when the preferred one is taken, answers real requests, and stops", async () => {
      const blocker = createServer();
      await new Promise<void>((r) => blocker.listen(4174, "127.0.0.1", r)).catch(() => undefined);   // 4174 被别的进程占着也一样：目的就是首选端口不可用
      try {
        const r = node("start-target.mjs", ["--app", "word-detective", "--run", RUN, "--runs-dir", runs, "--cwd", join(PLATFORM_SKILLS_ROOT, "../..")]);
        expect(r.status, r.stderr).toBe(0);
        const info = JSON.parse(r.stdout) as { url: string; port: number; portChanged: boolean };
        expect(info.port).not.toBe(4174);
        expect(info.portChanged).toBe(true);
        const res = await fetch(info.url);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("句子侦探社");
        expect(existsSync(join(runs, RUN, "server.json"))).toBe(true);
        expect(JSON.parse(node("start-target.mjs", ["--stop", "--run", RUN, "--runs-dir", runs, "--cwd", join(PLATFORM_SKILLS_ROOT, "../..")]).stdout).stopped).toBe(true);
        await wait(500);
        await expect(fetch(info.url)).rejects.toBeTruthy();
      } finally { blocker.close(); }
    });
    it("tells the model what to do when an app has no start command, and rejects unknown apps", () => {
      const cwd = join(PLATFORM_SKILLS_ROOT, "../..");
      const none = node("start-target.mjs", ["--app", "wrong-book", "--run", RUN, "--runs-dir", runs, "--cwd", cwd]);
      expect(none.status).toBe(3);
      expect(none.stderr).toContain("页面地址");
      expect(node("start-target.mjs", ["--app", "nope", "--run", RUN, "--runs-dir", runs, "--cwd", cwd]).status).toBe(3);
      expect(node("start-target.mjs", ["--stop", "--run", RUN, "--runs-dir", runs, "--cwd", cwd]).status).not.toBe(0);
    });
  });

  describe("validate-report", () => {
    const good = () => ({
      runId: "ui-20261122-1530-ab12", appId: "word-detective", mode: "review", status: "completed", verification: "not_run", inspection: "static", summary: "只读了代码",
      findings: [{ id: "F1", severity: "Major", dimension: "interaction", location: "首页 / 开始按钮", impact: "拇指够不到", evidence: ["shot receipt r-1"], recommendation: "下移" }],
      changedFiles: [], artifacts: {}, limitations: ["没有跑浏览器"]
    });
    const check = (report: unknown) => {
      const f = join(runs, `r-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(f, JSON.stringify(report));
      return node("validate-report.mjs", [f]);
    };
    it("accepts a well-formed review report", () => { const r = check(good()); expect(r.stdout.trim()).toBe("OK"); expect(r.status).toBe(0); });
    it("rejects completed ≠ passed: verification=passed needs evidence", () => {
      const r = check({ ...good(), verification: "passed" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("verificationEvidence");
      expect(check({ ...good(), verification: "passed", verificationEvidence: [{ kind: "command", detail: "npx vitest run → 12 passed" }] }).status).toBe(0);
    });
    it("rejects a review that changed files or claims fixes", () => {
      expect(check({ ...good(), changedFiles: ["a.html"] }).stderr).toContain("review 模式不能有 changedFiles");
      const r = good(); (r.findings[0] as Record<string, unknown>).resolved = true;
      expect(check(r).stderr).toContain("不能标 resolved");
    });
    it("Critical / Major without evidence are rejected; schema violations are listed", () => {
      const r = good(); (r.findings[0] as Record<string, unknown>).evidence = [];
      expect(check(r).stderr).toContain("必须带证据");
      const bad = check({ runId: "x", appId: "a", mode: "polish", status: "ok", verification: "yes", inspection: "browser", summary: "s", findings: [], changedFiles: [], artifacts: {}, extra: 1 });
      expect(bad.status).toBe(1);
      for (const part of ["runId", "mode", "status", "verification", "extra"]) expect(bad.stderr, part).toContain(part);
    });
    it("screenshots need a receiptId", () => {
      const r = { ...good(), artifacts: { beforeScreenshots: [{ path: "/tmp/a.png", viewport: "390x844", theme: "light" }] } };
      expect(check(r).stderr).toContain("receiptId");
    });
  });
});
