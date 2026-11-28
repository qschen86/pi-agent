/**
 * 平台技能「界面打磨」（v2 轻量化版）端到端测试：
 *   1. SKILL.md 符合平台加载契约，支持已有应用与从零新建应用，不含旧重型官僚流程；
 *   2. 独立 HTML/CSS 原型引擎 preview.mjs（多端视口切换、自然滚动、浅/夜切换、本地 CSS 与用户附件图片自动内联、拒绝外链、本机预览）；
 *   3. 轻量风格系统 style.mjs（read / init 新建应用 / sync 同步真实 CSS 亮暗变量 / audit 扫描硬编码色值）；
 *   4. 目标识别与演示夹具（resolve-target 支持 ring-toss 与 --new；fixtures.mjs 注入脱敏会话与待办；start-target 静态托管）；
 *   5. 轻量体检（review 只读保护）与代码落地验收（deliver 改前/改后对比 + 精确回滚保护后续改动）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPlatformSkills, PLATFORM_SKILLS_ROOT } from "../src/platform-skills.js";

const REPO = join(PLATFORM_SKILLS_ROOT, "../..");
const SKILL = join(PLATFORM_SKILLS_ROOT, "ui-design-refinement");
const script = (name: string) => join(SKILL, "scripts", name);
const RUN = "ui-20261124-1900-v2ok";
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("ui-design-refinement v2 skill definition & targets", () => {
  it("loads cleanly via platform-skills and supports both existing and brand-new apps", () => {
    const info = listPlatformSkills().find((s) => s.id === "ui-design-refinement");
    expect(info).toBeDefined();
    expect(info!.name).toBe("界面打磨");
    expect(info!.description).toContain("从零新建");
    const md = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    expect(md).toContain("三步自然闭环");
    expect(md).toContain("preview.mjs");
    expect(md).toContain("style.mjs");
    expect(md).toContain("design-tokens.css");
    expect(md).not.toContain("handbook.json");
    expect(md).not.toContain("to-proposal");
  });

  it("registers all apps including ring-toss and every registered app has lightweight .design files", () => {
    const targets = JSON.parse(readFileSync(join(SKILL, "targets.json"), "utf8")).targets as Array<{ appId: string; workspace: string }>;
    const ids = targets.map((t) => t.appId);
    for (const expected of ["heji-web", "word-detective", "pet-math-game", "ring-toss", "challenge-island", "wrong-book"]) {
      expect(ids).toContain(expected);
      const t = targets.find((x) => x.appId === expected)!;
      expect(existsSync(join(REPO, t.workspace, ".design/design-tokens.css")), `${expected} tokens`).toBe(true);
      expect(existsSync(join(REPO, t.workspace, ".design/design-system.md")), `${expected} system md`).toBe(true);
    }
  });

  it("resolve-target handles existing apps, ring-toss, ambiguous repo root, and --new brand-new apps", () => {
    const r1 = spawnSync("node", [script("resolve-target.mjs"), "--app", "ring-toss", "--cwd", REPO], { encoding: "utf8" });
    expect(r1.status, r1.stderr).toBe(0);
    expect(JSON.parse(r1.stdout).appId).toBe("ring-toss");

    const rNew = spawnSync("node", [script("resolve-target.mjs"), "--new", "family-recipe", "--name", "家庭食谱本", "--cwd", REPO], { encoding: "utf8" });
    expect(rNew.status, rNew.stderr).toBe(0);
    const parsed = JSON.parse(rNew.stdout);
    expect(parsed.status).toBe("new");
    expect(parsed.target.workspace).toBe("apps/family-recipe");
    expect(parsed.target.name).toBe("家庭食谱本");

    const rAmb = spawnSync("node", [script("resolve-target.mjs"), "--cwd", REPO], { encoding: "utf8" });
    expect(rAmb.status).toBe(3);
    expect(JSON.parse(rAmb.stdout).status).toBe("ambiguous");
  });
});

describe("preview.mjs: standalone HTML/CSS multi-viewport prototype bundler", () => {
  let repo: string, runs: string;
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  const runPreview = (args: string[]) => spawnSync("node", [script("preview.mjs"), ...args, "--runs-dir", runs], { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ui-proto-repo-")); runs = mkdtempSync(join(tmpdir(), "ui-proto-runs-"));
    git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "ok\n"); git("add", "-A"); git("commit", "-q", "-m", "init");
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(runs, { recursive: true, force: true }); });

  it("bundles independent HTML screens, inlines local CSS and attached user images, supports desktop/mobile & theme switch", () => {
    const proto = join(runs, "proto");
    const uploads = join(runs, "user-uploads");
    mkdirSync(proto, { recursive: true }); mkdirSync(uploads, { recursive: true });
    const brandLogo = join(uploads, "new-logo.png");
    writeFileSync(brandLogo, PNG_1X1);
    writeFileSync(join(proto, "tokens.css"), ":root{--accent:#c85a2b;--bg:#faf6ef}:root[data-theme='dark']{--bg:#161412}");
    writeFileSync(join(proto, "dir-a.html"), `<!doctype html><html><head><link rel="stylesheet" href="tokens.css"></head><body><img src="${brandLogo}" alt="logo"><main style="height:1600px">长页面自然滚动内容</main></body></html>`);
    writeFileSync(join(proto, "dir-b.html"), "<!doctype html><html><body><h1>方向 B</h1></body></html>");
    writeFileSync(join(proto, "manifest.json"), JSON.stringify({
      appId: "family-recipe", appName: "家庭食谱本", title: "首页视觉方案", requirement: "暖纸感，同时支持手机和桌面",
      recommendation: "A", viewports: ["mobile", "desktop"], themes: ["light", "dark"],
      directions: [
        { id: "A", name: "暖纸编辑风", tagline: "大留白、清晰排版", highlights: ["自然上下滚动", "直接使用用户上传的新 Logo"], screens: [{ id: "home", label: "首页", file: "dir-a.html" }] },
        { id: "B", name: "日历清单风", tagline: "按周排布", screens: [{ id: "home", label: "首页", file: "dir-b.html" }] }
      ]
    }));

    const r = runPreview(["build", "--run", RUN, "--manifest", join(proto, "manifest.json")]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { previewHtml: string; inlinedAssetCount: number; viewports: string[]; themes: string[] };
    expect(out.inlinedAssetCount).toBe(2); // tokens.css + new-logo.png
    expect(out.viewports).toEqual(["mobile", "desktop"]);
    expect(out.themes).toEqual(["light", "dark"]);

    const html = readFileSync(out.previewHtml, "utf8");
    expect(html).toContain('<meta name="pi-ui-preview"');
    expect(html).toContain("data:image/png;base64,"); // 用户上传的新 Logo 已内联上屏
    expect(html).toContain("--accent:#c85a2b");       // 本地 CSS 已内联
    expect(html).toContain("手机 390×844");
    expect(html).toContain("桌面 1280×800");
    expect(html).not.toContain("#534ab7");            // 无旧骨架紫蓝默认偏置
    expect(git("status", "--porcelain")).toBe("");    // 预览产物不污染 git 工作区
  });

  it("rejects external http(s) assets that break inside the offline preview sandbox", () => {
    const proto = join(runs, "proto-ext");
    mkdirSync(proto, { recursive: true });
    writeFileSync(join(proto, "bad.html"), '<!doctype html><html><body><img src="https://example.com/a.png"></body></html>');
    writeFileSync(join(proto, "manifest.json"), JSON.stringify({
      appId: "heji-web", title: "t", requirement: "r",
      directions: [{ id: "A", name: "A", screens: [{ id: "s1", label: "s1", file: "bad.html" }] }]
    }));
    const r = runPreview(["build", "--run", RUN, "--manifest", join(proto, "manifest.json")]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("外链图片");
  });
});

describe("style.mjs: lightweight single-source-of-truth design tokens", () => {
  let repo: string;
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ui-style-repo-"));
    git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "ok\n"); git("add", "-A"); git("commit", "-q", "-m", "init");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("initializes brand-new app styles, reads tokens, syncs dark/light CSS, and audits hardcoded colors", () => {
    const appDir = join(repo, "apps/family-recipe");
    const init = spawnSync("node", [script("style.mjs"), "init", "--dir", appDir, "--name", "家庭食谱本", "--preset", "warm-paper", "--dark", "--cwd", repo], { encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    expect(existsSync(join(appDir, ".design/design-tokens.css"))).toBe(true);
    expect(existsSync(join(appDir, ".design/design-system.md"))).toBe(true);

    // 写入一份带硬编码颜色的主样式表，测试 audit 与 sync
    writeFileSync(join(appDir, "styles.css"), `:root { --bg: #faf6ef; --accent: #c85a2b; }\n:root[data-theme="dark"] { --bg: #161412; }\n.btn { color: #c85a2b; background: #123456; }\n`);
    const audit = spawnSync("node", [script("style.mjs"), "audit", "--dir", appDir, "--cwd", repo], { encoding: "utf8" });
    expect(audit.status, audit.stderr).toBe(0);
    const auditJson = JSON.parse(audit.stdout);
    expect(auditJson.totalHits).toBe(2);
    expect(auditJson.findings[0].samples[0].suggestToken).toBe("--accent");

    const read = spawnSync("node", [script("style.mjs"), "read", "--app", "heji-web", "--cwd", REPO], { encoding: "utf8" });
    expect(read.status, read.stderr).toBe(0);
    const heji = JSON.parse(read.stdout);
    expect(heji.hasDesignTokens).toBe(true);
    expect(heji.tokenCounts.light).toBeGreaterThan(50);
    expect(heji.tokenCounts.dark).toBeGreaterThan(20);
  });
});

describe("demo fixtures, static target serving, review/deliver reports, and safe rollback", () => {
  let repo: string, runs: string;
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  const node = (file: string, args: string[]) => spawnSync("node", [script(file), ...args, "--runs-dir", runs], { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ui-flow-repo-")); runs = mkdtempSync(join(tmpdir(), "ui-flow-runs-"));
    git("init", "-q", "-b", "main");
    mkdirSync(join(repo, "apps/demo-app"), { recursive: true });
    writeFileSync(join(repo, "apps/demo-app/index.html"), "<!doctype html><h1>before</h1>\n");
    writeFileSync(join(repo, "apps/demo-app/extra.txt"), "keep\n");
    git("add", "-A"); git("commit", "-q", "-m", "init");
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(runs, { recursive: true, force: true }); });

  it("seedHejiDemoFixtures populates realistic sanitized sessions and notes", async () => {
    const tmpData = mkdtempSync(join(tmpdir(), "heji-demo-"));
    try {
      const mod = await import(pathToFileURL(join(SKILL, "scripts/lib/fixtures.mjs")).href) as {
        seedHejiDemoFixtures: (dir: string) => { sessions: number; notes: number };
      };
      const info = mod.seedHejiDemoFixtures(tmpData);
      expect(info.sessions).toBeGreaterThanOrEqual(3);
      expect(info.notes).toBeGreaterThanOrEqual(3);
      const bindings = JSON.parse(readFileSync(join(tmpData, "runtime/bindings.json"), "utf8"));
      expect(Object.keys(bindings)).toContain("rt-demo-design-01");
      expect(existsSync(join(tmpData, "runtime/events/rt-demo-design-01.jsonl"))).toBe(true);
      const notes = JSON.parse(readFileSync(join(tmpData, "notes.json"), "utf8"));
      expect(notes.length).toBe(info.notes);
    } finally {
      rmSync(tmpData, { recursive: true, force: true });
    }
  });

  it("start-target serves a brand-new static directory and stops cleanly", async () => {
    const up = node("start-target.mjs", ["--dir", "apps/demo-app", "--run", RUN]);
    expect(up.status, up.stderr).toBe(0);
    const { url } = JSON.parse(up.stdout) as { url: string };
    try {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("before");
    } finally {
      const down = node("start-target.mjs", ["--stop", "--run", RUN]);
      expect(down.status, down.stderr).toBe(0);
    }
  });

  it("rejects modified workspace in review mode; supports deliver mode with before/after shots and safe rollback", () => {
    expect(node("snapshot.mjs", ["--workspace", repo, "--run", RUN]).status).toBe(0);
    const f1 = join(runs, "before.png"), f2 = join(runs, "after.png");
    writeFileSync(f1, PNG_1X1); writeFileSync(f2, Buffer.concat([PNG_1X1, Buffer.from("x")]));
    expect(node("record-capture.mjs", ["--run", RUN, "--phase", "before", "--route", "/", "--viewport", "390x844", "--theme", "light", "--receipt", "rc-b1", "--path", f1]).status).toBe(0);

    // 修改文件后 review 模式必须被拒绝（退出码 2）
    writeFileSync(join(repo, "apps/demo-app/index.html"), "<!doctype html><h1>after</h1>\n");
    writeFileSync(join(repo, "apps/demo-app/extra.txt"), "changed-in-run\n");
    writeFileSync(join(runs, RUN, "report.draft.json"), JSON.stringify({
      appId: "demo-app", mode: "review", status: "completed", verification: "not_run", inspection: "browser", summary: "只读", findings: []
    }));
    expect(node("generate-report.mjs", ["--run", RUN]).status).toBe(2);

    // 改为 deliver 模式并登记改后截图 → 正常产出报告与回滚记录
    expect(node("record-capture.mjs", ["--run", RUN, "--phase", "after", "--route", "/", "--viewport", "390x844", "--theme", "light", "--receipt", "rc-a1", "--path", f2]).status).toBe(0);
    writeFileSync(join(runs, RUN, "report.draft.json"), JSON.stringify({
      appId: "demo-app", mode: "deliver", status: "completed", verification: "passed", inspection: "browser",
      summary: "已更新标题层级并通过验收",
      verificationEvidence: [{ kind: "screenshot", detail: "390x844 改前后截图已对照", receiptId: "rc-a1" }],
      findings: []
    }));
    const gen = node("generate-report.mjs", ["--run", RUN]);
    expect(gen.status, gen.stderr).toBe(0);
    const out = JSON.parse(gen.stdout) as { reportHtml: string; changedFiles: number; rollbackCommand: string };
    expect(out.changedFiles).toBe(2);
    expect(out.rollbackCommand).toContain("rollback.mjs");
    const html = readFileSync(out.reportHtml, "utf8");
    expect(html).toContain("改前 / 改后对照");
    expect(html).toContain("rc-b1");
    expect(html).toContain("rc-a1");

    // 模拟用户在报告之后又手动编辑了 extra.txt：rollback 应只还原 index.html，保护 extra.txt 不被覆盖！
    writeFileSync(join(repo, "apps/demo-app/extra.txt"), "user-later-edit\n");
    const rb = node("rollback.mjs", ["--run", RUN]);
    expect(rb.status).toBe(2); // 有 skipped 文件返回 2
    const rbOut = JSON.parse(rb.stdout) as { restored: string[]; skipped: Array<{ path: string; reason: string }> };
    expect(rbOut.restored).toEqual(["apps/demo-app/index.html"]);
    expect(rbOut.skipped[0].path).toBe("apps/demo-app/extra.txt");
    expect(readFileSync(join(repo, "apps/demo-app/index.html"), "utf8")).toBe("<!doctype html><h1>before</h1>\n");
    expect(readFileSync(join(repo, "apps/demo-app/extra.txt"), "utf8")).toBe("user-later-edit\n");
  });
});
