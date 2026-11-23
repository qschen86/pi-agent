import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLATFORM_SKILLS_ROOT } from "../src/platform-skills.js";
import { uiReportProblems } from "../src/ui-report-check.js";
import type { ProjectedEvent } from "../src/types.js";

const SKILL = join(PLATFORM_SKILLS_ROOT, "ui-design-refinement"), ROOT = join(PLATFORM_SKILLS_ROOT, "../..");
const RUN = "ui-20261122-2000-ab12", APP = "apps/word-detective", CSS = `${APP}/styles.css`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("Repair: version-bound authorization, verification, paired delivery and guarded rollback", () => {
  let repo: string, runs: string, dir: string, draft: string, original: string;
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  const node = (script: string, ...a: string[]) => spawnSync("node", [join(SKILL, "scripts", script), ...a, "--runs-dir", runs], { cwd: repo, encoding: "utf8" });
  const repair = (...a: string[]) => node("repair.mjs", ...a, "--run", RUN);
  const plan = (over = {}) => {
    writeFileSync(draft, JSON.stringify({ appId: "word-detective", routes: ["/"], tasks: [{ id: "R1", summary: "按手册调整样式", rules: ["WD-013"], files: [CSS, `${APP}/new.txt`, `${APP}/old.txt`] }], checks: ['node -e "console.log(\'checks passed\')"'], ...over }));
    return repair("plan", "--file", draft);
  };
  const authorize = () => {
    const p = plan(); expect(p.status, p.stderr).toBe(0);
    const sha = JSON.parse(p.stdout).planSha256;
    expect(repair("authorize", "--by", "应用所有者", "--plan-sha", sha).status).toBe(0);
  };
  const verify = (phase: string) => repair("verify", "--phase", phase);
  const captures = (phase: string) => {
    for (const viewport of ["390x844", "768x1024", "1280x800"]) {
      const file = join(runs, `${phase}-${viewport}.png`); writeFileSync(file, PNG);
      const r = node("record-capture.mjs", "--run", RUN, "--phase", phase, "--viewport", viewport, "--theme", "light", "--route", "/", "--receipt", `${phase}-${viewport}`, "--path", file);
      expect(r.status, r.stderr).toBe(0);
    }
  };
  const report = (over = {}) => {
    writeFileSync(join(dir, "report.draft.json"), JSON.stringify({ appId: "word-detective", mode: "repair", status: "completed", inspection: "static", verification: "not_run", summary: "Repair 工具回归", findings: [], limitations: ["单元测试夹具，不是实际页面验收"], ...over }));
    return node("generate-report.mjs", "--run", RUN);
  };
  const readReport = () => JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  const change = () => writeFileSync(join(repo, CSS), `${original}\n/* repaired */\n`);
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ui-repair-repo-")); runs = mkdtempSync(join(tmpdir(), "ui-repair-runs-")); dir = join(runs, RUN); draft = join(runs, "plan.draft.json");
    git("init", "-q", "-b", "main"); mkdirSync(join(repo, APP), { recursive: true });
    cpSync(join(ROOT, CSS), join(repo, CSS)); cpSync(join(ROOT, APP, ".design"), join(repo, APP, ".design"), { recursive: true });
    const handbook = node("handbook.mjs", "validate", "--app", "word-detective");
    expect(handbook.status, handbook.stderr).toBe(0);
    expect(JSON.parse(handbook.stdout)).toMatchObject({ status: "approved", version: "1.0.0" });
    writeFileSync(join(repo, APP, "old.txt"), "old file\n");
    git("add", "-A"); git("commit", "-q", "-m", "baseline");
    // 用户已有脏内容必须在运行结束及回滚后保留。
    original = `${readFileSync(join(repo, CSS), "utf8")}\n/* user work */\n`; writeFileSync(join(repo, CSS), original);
    expect(node("snapshot.mjs", "--workspace", repo, "--run", RUN).status).toBe(0);
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(runs, { recursive: true, force: true }); });

  it("refuses draft handbooks, unknown rules, cross-app files, handbook edits, traversal and symlinks", () => {
    const manifest = join(repo, APP, ".design/manifest.json"), json = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, JSON.stringify({ ...json, status: "draft" }));
    expect(plan().stderr).toContain("approved"); writeFileSync(manifest, `${JSON.stringify(json, null, 2)}\n`);
    // 恢复快照中的字节，否则会被「计划前已修改」守卫拒绝。
    git("restore", `${APP}/.design/manifest.json`);
    for (const file of ["apps/other/a.css", `${APP}/.design/handbook.json`, `${APP}/../escape.css`]) {
      expect(plan({ tasks: [{ id: "R1", summary: "s", rules: ["WD-013"], files: [file] }] }).status).toBe(1);
    }
    expect(plan({ tasks: [{ id: "R1", summary: "s", rules: ["WD-999"], files: [CSS] }] }).stderr).toContain("不存在的规则");
    symlinkSync(join(runs, "external"), join(repo, APP, "link.css"));
    expect(plan({ tasks: [{ id: "R1", summary: "s", rules: ["WD-013"], files: [`${APP}/link.css`] }] }).status).toBe(1);
  });

  it("needs an exact plan authorization before verification, and invalidates it if plan or handbook changes", () => {
    const p = plan(); expect(p.status).toBe(0);
    expect(verify("before").status).toBe(1);
    expect(repair("authorize", "--by", "应用所有者", "--plan-sha", "wrong").status).toBe(1);
    expect(repair("authorize", "--by", "应用所有者", "--plan-sha", JSON.parse(p.stdout).planSha256).status).toBe(0);
    const file = join(dir, "repair-plan.json"), saved = readFileSync(file, "utf8");
    writeFileSync(file, saved.replace("按手册调整样式", "another plan"));
    expect(verify("before").stderr).toContain("授权后被修改"); writeFileSync(file, saved);
    const hb = join(repo, APP, ".design/handbook.json"); writeFileSync(hb, `${readFileSync(hb, "utf8")}\n`);
    expect(verify("before").stderr).toContain("手册版本或内容已改变");
  });

  it("delivers an authorized repair with full pairs and rolls back modified, added and deleted files while preserving existing dirt", () => {
    authorize(); expect(verify("before").status).toBe(0); captures("before");
    change(); writeFileSync(join(repo, APP, "new.txt"), "new"); rmSync(join(repo, APP, "old.txt"));
    expect(verify("after").status).toBe(0); captures("after");
    const r = report({ inspection: "browser", verification: "passed" }); expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout), json = readReport();
    expect(json).toMatchObject({ mode: "repair", verification: "passed", handbookVersion: "1.0.0", rollbackRef: RUN });
    expect(json.changedFiles).toHaveLength(3);
    expect(out.chatSummary).toContain("| 维度 | 改前 | 改后 |");
    const html = readFileSync(out.reportHtml, "utf8");
    expect(html).toContain("计划与授权"); expect(html).toContain("改前 / 改后"); expect(html).toContain("data:image/png;base64");
    const events = ["repair.mjs", "generate-report.mjs"].map((script, seq) => ({ seq, recordedAt: "2026-11-22T20:00:00+08:00", key: script, kind: "tool", turnNo: 1, source: "stream", parserVersion: "t", availability: "recorded", tool: { name: "bash", input: `node /opt/heji/slots/blue/skills/platform/ui-design-refinement/scripts/${script}`, status: "completed" } } as ProjectedEvent));
    expect(uiReportProblems({ events, since: 1, turnNo: 1, assistantText: out.chatSummary, workspace: repo })).toEqual([]);
    const rollback = spawnSync(json.rollbackCommand, { shell: true, cwd: repo, encoding: "utf8" }); expect(rollback.status, rollback.stderr).toBe(0);
    expect(readFileSync(join(repo, CSS), "utf8")).toBe(original);
    expect(existsSync(join(repo, APP, "new.txt"))).toBe(false); expect(readFileSync(join(repo, APP, "old.txt"), "utf8")).toBe("old file\n");
    expect(JSON.parse(node("rollback.mjs", "--run", RUN).stdout).alreadyRestored).toHaveLength(3);
  });

  it("refuses changed files outside the authorized scope and refuses a late authorization", () => {
    authorize(); writeFileSync(join(repo, APP, "outside.css"), "new");
    expect(report().stderr).toContain("超出已授权计划");
    rmSync(join(repo, APP, "outside.css")); change();
    const sha = JSON.parse(readFileSync(join(dir, "repair-authorization.json"), "utf8")).planSha256;
    expect(repair("authorize", "--by", "应用所有者", "--plan-sha", sha).stderr).toContain("事后补写");
  });

  it("derives failed from command exits and enforces the repair iteration limit", () => {
    const p = plan({ checks: ['node -e "process.exit(require(\'fs\').existsSync(\'apps/word-detective/new.txt\')?1:0)"'] });
    expect(p.status, p.stderr).toBe(0); expect(repair("authorize", "--by", "用户", "--plan-sha", JSON.parse(p.stdout).planSha256).status).toBe(0);
    expect(verify("before").status).toBe(0); writeFileSync(join(repo, APP, "new.txt"), "fail");
    expect(verify("after").status).toBe(1); expect(report().status).toBe(0); expect(readReport().verification).toBe("failed");
    expect(report({ verification: "passed" }).status).toBe(1);
    expect(verify("after").status).toBe(1); expect(verify("after").stderr).toContain("次数上限");
  });

  it("does not pass with missing screenshots, stale verification, altered screenshots or altered logs", () => {
    authorize(); expect(verify("before").status).toBe(0); captures("before"); change(); expect(verify("after").status).toBe(0);
    expect(report({ verification: "passed" }).status).toBe(1); expect(report().status).toBe(0); expect(readReport().verification).toBe("not_run");
    captures("after"); writeFileSync(join(runs, "after-390x844.png"), "tampered");
    expect(report().stderr).toContain("哈希不一致"); writeFileSync(join(runs, "after-390x844.png"), PNG);
    writeFileSync(join(dir, "checks/after-1-1.log"), "tampered"); expect(report().stderr).toContain("日志被改过");
    expect(verify("after").status).toBe(0); writeFileSync(join(repo, CSS), `${original}\n/* later */`);
    expect(report().stderr).toContain("验证后代码又变了");
  });

  it("skips later edits during rollback instead of overwriting them", () => {
    authorize(); change(); expect(report().status).toBe(0);
    writeFileSync(join(repo, CSS), "later work");
    const r = node("rollback.mjs", "--run", RUN); expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).skipped[0].reason).toContain("报告之后被修改");
    expect(readFileSync(join(repo, CSS), "utf8")).toBe("later work");
  });

  it("keeps an identical baseline failure visible instead of counting it as a new failure", () => {
    const p = plan({ checks: ['node -e "console.error(\'known baseline failure\');process.exit(1)"'] });
    expect(p.status).toBe(0); expect(repair("authorize", "--by", "用户", "--plan-sha", JSON.parse(p.stdout).planSha256).status).toBe(0);
    expect(verify("before").status).toBe(1); captures("before"); change();
    expect(verify("after").status).toBe(1); captures("after");
    const r = report({ verification: "passed", inspection: "browser" }); expect(r.status, r.stderr).toBe(0);
    expect(readReport().limitations.join()).toContain("基线已有失败且日志完全一致");
    expect(readReport().verification).toBe("passed");
  });
});
