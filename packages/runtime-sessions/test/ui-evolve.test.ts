import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLATFORM_SKILLS_ROOT } from "../src/platform-skills.js";
import { uiReportProblems } from "../src/ui-report-check.js";
import type { ProjectedEvent } from "../src/types.js";

const SKILL = join(PLATFORM_SKILLS_ROOT, "ui-design-refinement"), ROOT = join(PLATFORM_SKILLS_ROOT, "../..");
const RUN = "ui-20261122-2110-ev01", SRC = "ui-20261122-2100-src1", UP = "ui-20261122-2115-up01";
const APP = "apps/word-detective", CSS = `${APP}/styles.css`, JS = `${APP}/js/evolve-fixture.js`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("Evolve: evidenced proposals, explicit impact and independently authorized batches", () => {
  let repo: string, runs: string, draft: string;
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  const node = (script: string, ...a: string[]) => spawnSync("node", [join(SKILL, "scripts", script), ...a, "--runs-dir", runs], { cwd: repo, encoding: "utf8" });
  const evolve = (...a: string[]) => node("evolve.mjs", ...a, "--run", RUN);
  const snapshot = (run: string) => node("snapshot.mjs", "--workspace", repo, "--run", run);
  const batches = () => [CSS, JS].map((file, i) => ({ id: `B${i + 1}`, title: `分批 ${i + 1}`, routes: ["/"], checks: ['node -e "console.log(\'pass\')"'], tasks: [{ id: "R1", summary: "按徽章规则落地", rules: ["WD-013"], files: [file] }] }));
  const impact = (list = batches()) => { writeFileSync(draft, JSON.stringify({ batches: list })); return evolve("impact", "--app", "word-detective", "--proposals", "P-002", "--file", draft); };
  const batch = (id: string, child: string) => evolve("batch", "--batch", id, "--repair-run", child);
  const check = (text: string) => uiReportProblems({ events: [{ seq: 1, recordedAt: "2026-11-22T21:10:00+08:00", key: "evolve", kind: "tool", turnNo: 1, source: "stream", parserVersion: "t", availability: "recorded", tool: { name: "bash", input: "node /opt/heji/slots/blue/skills/platform/ui-design-refinement/scripts/evolve.mjs impact", status: "completed" } } as ProjectedEvent], since: 1, turnNo: 1, assistantText: text, workspace: repo });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ui-evolve-repo-")); runs = mkdtempSync(join(tmpdir(), "ui-evolve-runs-")); draft = join(runs, "draft.json");
    git("init", "-q", "-b", "main"); mkdirSync(join(repo, APP, "js"), { recursive: true });
    cpSync(join(ROOT, CSS), join(repo, CSS)); cpSync(join(ROOT, APP, ".design"), join(repo, APP, ".design"), { recursive: true });
    const handbook = node("handbook.mjs", "validate", "--app", "word-detective");
    expect(handbook.status, handbook.stderr).toBe(0);
    expect(JSON.parse(handbook.stdout)).toMatchObject({ status: "approved", version: "1.0.0" });
    git("add", "-A"); git("commit", "-q", "-m", "fixture"); expect(snapshot(RUN).status).toBe(0);
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(runs, { recursive: true, force: true }); });

  it("up derives source files and hashes from a real local change, creates only a pending proposal", () => {
    expect(snapshot(SRC).status).toBe(0);
    writeFileSync(join(repo, CSS), `${readFileSync(join(repo, CSS), "utf8")}\n/* local adjustment */`);
    expect(snapshot(UP).status).toBe(0);
    const handbook = join(repo, APP, ".design/handbook.json"), before = readFileSync(handbook, "utf8");
    writeFileSync(draft, JSON.stringify({ title: "沉淀局部调整", reason: "明确局部改动的可复用原则", source: { kind: "made-up", ref: "must be ignored" }, items: [{ op: "modify", target: "rules", key: "WD-013", after: { check: "检查图标和名称的状态" }, why: "沉淀实际调整" }] }));
    const r = node("evolve.mjs", "up", "--app", "word-detective", "--run", UP, "--source-run", SRC, "--file", draft);
    expect(r.status, r.stderr).toBe(0); const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ status: "pending", source: { kind: "local-change", ref: SRC } });
    expect(out.source.files).toHaveLength(1); expect(out.source.files[0]).toMatchObject({ path: CSS }); expect(out.source.files[0].afterSha256).not.toBe(out.source.files[0].beforeSha256);
    expect(readFileSync(handbook, "utf8")).toBe(before);
    const p = JSON.parse(readFileSync(join(repo, APP, ".design/proposals", `${out.proposal}.json`), "utf8")); expect(p.items[0].decision).toBeNull();
    expect(node("handbook.mjs", "validate", "--app", "word-detective").status).toBe(0);
  });

  it("up refuses missing actual changes and cross-app provenance", () => {
    expect(snapshot(SRC).status).toBe(0);
    writeFileSync(draft, "{}");
    expect(evolve("up", "--app", "word-detective", "--source-run", SRC, "--file", draft).stderr).toContain("没有实际局部改动");
    mkdirSync(join(repo, "apps/other")); writeFileSync(join(repo, "apps/other/a.js"), "changed"); expect(snapshot(UP).status).toBe(0);
    expect(node("evolve.mjs", "up", "--run", UP, "--app", "word-detective", "--source-run", SRC, "--file", draft).stderr).toContain("不跨应用");
  });

  it("up can deliver a pending drift proposal, but rejects provenance after the local code changes again", () => {
    expect(snapshot(SRC).status).toBe(0);
    writeFileSync(join(repo, CSS), readFileSync(join(repo, CSS), "utf8").replace("--s: #3d7cb5;", "--s: #ff0000;"));
    expect(snapshot(UP).status).toBe(0);
    writeFileSync(draft, JSON.stringify({ title: "沉淀新的角色色", reason: "记录已发生的局部调整，供用户决定", items: [{ op: "modify", target: "colors", key: "s 主语", after: { value: "#ff0000" }, why: "与局部代码对照" }] }));
    // 使用真实颜色条目的 name，避免用描述猜它的键。
    const h = JSON.parse(readFileSync(join(repo, APP, ".design/handbook.json"), "utf8"));
    const d = JSON.parse(readFileSync(draft, "utf8")); d.items[0].key = h.tokens.colors.find((c: any) => c.var === "--s").name; writeFileSync(draft, JSON.stringify(d));
    const proposed = node("evolve.mjs", "up", "--run", UP, "--app", "word-detective", "--source-run", SRC, "--file", draft); expect(proposed.status, proposed.stderr).toBe(0);
    const deliver = (...extra: string[]) => node("generate-handbook-delivery.mjs", "--run", UP, "--app", "word-detective", "--requirement", "沉淀实际局部调整", ...extra);
    expect(deliver().status).toBe(1);
    const result = deliver("--evolve-up"); expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout); expect(out.chatSummary).toContain("不能宣称手册与代码一致"); expect(check(out.chatSummary)).toEqual([]);
    writeFileSync(join(repo, CSS), `${readFileSync(join(repo, CSS), "utf8")}\n/* changed again */`);
    expect(deliver("--evolve-up").stderr).toMatch(/越界改动|局部代码又变了/);
  });

  it("impact preserves code and handbook, resolves rule → component → exact code references, and passes platform delivery", () => {
    const before = git("status", "--porcelain"), r = impact(); expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout), data = JSON.parse(readFileSync(out.json, "utf8"));
    expect(data.changedRules).toEqual(["WD-013"]);
    expect(data.impacts.some((i: any) => i.kind === "components" && i.id === "badge")).toBe(true);
    expect(data.references.some((r: any) => r.file === CSS && r.line > 0)).toBe(true);
    expect(data.batches).toHaveLength(2); expect(git("status", "--porcelain")).toBe(before);
    expect(check(out.chatSummary)).toEqual([]);
    writeFileSync(out.json, "{}"); expect(check(out.chatSummary)![0]).toContain("被改过");
    expect(check("[Review](report.html)")![0]).toContain("Evolve");
  });

  it("refuses pending proposals, overlapping batches, path traversal, and unrelated rules", () => {
    expect(evolve("impact", "--app", "word-detective", "--proposals", "P-999").status).toBe(1);
    const repeated = batches(); repeated[1]!.tasks[0]!.files = [CSS]; expect(impact(repeated).stderr).toContain("跨批次重复");
    const other = batches(); other[1]!.tasks[0]!.files = ["apps/other/a.js"]; expect(impact(other).stderr).toContain("不跨应用");
    const rule = batches(); rule[0]!.tasks[0]!.rules = ["WD-012"]; expect(impact(rule).stderr).toContain("本次变更以外");
  });

  it("lists unresolved links without claiming complete dependency coverage", () => {
    const r = evolve("impact", "--app", "word-detective", "--proposals", "P-001"); expect(r.status, r.stderr).toBe(0);
    const data = JSON.parse(readFileSync(JSON.parse(r.stdout).json, "utf8")); expect(data.unresolved.length).toBeGreaterThan(0);
    expect(data.limitations.join()).toContain("不代表完整依赖");
  });

  it("requires approved handbooks for batches and invalidates an impact if the handbook changes", () => {
    const m = join(repo, APP, ".design/manifest.json"); const original = readFileSync(m, "utf8"), json = JSON.parse(original);
    // 新运行的基线允许草稿分析，但不允许生成代码计划。
    writeFileSync(m, JSON.stringify({ ...json, status: "draft" })); expect(snapshot(UP).status).toBe(0);
    writeFileSync(draft, JSON.stringify({ batches: batches() }));
    expect(node("evolve.mjs", "impact", "--run", UP, "--app", "word-detective", "--proposals", "P-002", "--file", draft).status).toBe(0);
    expect(node("evolve.mjs", "batch", "--run", UP, "--batch", "B1", "--repair-run", SRC).stderr).toContain("草稿手册");
    writeFileSync(m, original); expect(impact().status).toBe(0); writeFileSync(m, `${original}\n`);
    expect(batch("B1", SRC).stderr).toContain("手册已改变");
  });

  it("creates each batch as an unauthorised Repair plan and advances only after verified completion", () => {
    expect(impact().status).toBe(0); expect(batch("B2", SRC).status).toBe(1);
    const first = batch("B1", SRC); expect(first.status, first.stderr).toBe(0);
    const out = JSON.parse(first.stdout); expect(existsSync(join(runs, SRC, "repair-authorization.json"))).toBe(false);
    expect(node("repair.mjs", "verify", "--run", SRC, "--phase", "before").status).toBe(1);
    expect(batch("B2", UP).stderr).toMatch(/report.json|前一批/);
    expect(node("repair.mjs", "authorize", "--run", SRC, "--by", "测试用户", "--plan-sha", out.planSha256).status).toBe(0);
    expect(node("repair.mjs", "verify", "--run", SRC, "--phase", "before").status).toBe(0);
    const capture = (phase: string) => { for (const vp of ["390x844", "768x1024", "1280x800"]) {
      const f = join(runs, `${phase}-${vp}.png`); writeFileSync(f, PNG);
      expect(node("record-capture.mjs", "--run", SRC, "--phase", phase, "--route", "/", "--viewport", vp, "--theme", "light", "--receipt", `${phase}-${vp}`, "--path", f).status).toBe(0);
    } };
    capture("before"); writeFileSync(join(repo, CSS), `${readFileSync(join(repo, CSS), "utf8")}\n/* batch1 */`);
    expect(node("repair.mjs", "verify", "--run", SRC, "--phase", "after").status).toBe(0); capture("after");
    writeFileSync(join(runs, SRC, "report.draft.json"), JSON.stringify({ appId: "word-detective", mode: "repair", status: "completed", verification: "passed", inspection: "browser", summary: "fixture", findings: [] }));
    const report = node("generate-report.mjs", "--run", SRC); expect(report.status, report.stderr).toBe(0);
    const repaired = readFileSync(join(repo, CSS), "utf8"); writeFileSync(join(repo, CSS), `${repaired}\n/* later unrelated edit */`);
    expect(batch("B2", UP).stderr).toContain("后来被修改"); writeFileSync(join(repo, CSS), repaired);
    const second = batch("B2", UP); expect(second.status, second.stderr).toBe(0);
    expect(existsSync(join(runs, UP, "repair-authorization.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(runs, UP, "repair-plan.json"), "utf8")).evolution.batchId).toBe("B2");
  });
});
