import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLATFORM_SKILLS_ROOT } from "../src/platform-skills.js";
import { uiReportProblems } from "../src/ui-report-check.js";
import type { ProjectedEvent } from "../src/types.js";

const SKILL = join(PLATFORM_SKILLS_ROOT, "ui-design-refinement");
const ROOT = join(PLATFORM_SKILLS_ROOT, "../..");
const RUN = "ui-20261122-1930-ab12";
const deployed = "/opt/heji/slots/blue/skills/platform/ui-design-refinement";
const event = (script: string): ProjectedEvent => ({ seq: 1, recordedAt: "2026-11-22T19:30:00+08:00", key: script, kind: "tool", turnNo: 1, source: "stream", parserVersion: "t", availability: "recorded", tool: { name: "bash", input: `node ${deployed}/scripts/${script}`, status: "completed" } });

describe("Refine: requirement → proposal → delivery → platform check", () => {
  let repo: string, runs: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  const node = (script: string, ...args: string[]) => spawnSync("node", [join(SKILL, "scripts", script), ...args, "--runs-dir", runs], { cwd: repo, encoding: "utf8" });
  const hb = (...args: string[]) => node("handbook.mjs", ...args, "--app", "word-detective");
  const generate = () => node("generate-handbook-delivery.mjs", "--run", RUN, "--app", "word-detective", "--requirement", "未获得徽章的名称要清楚，供后续落地");
  const check = (assistantText: string, events = [event("generate-handbook-delivery.mjs")]) => uiReportProblems({ events, since: 1, turnNo: 1, assistantText, workspace: repo });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ui-refine-repo-")); runs = mkdtempSync(join(tmpdir(), "ui-refine-runs-"));
    git("init", "-q", "-b", "main");
    mkdirSync(join(repo, "apps/word-detective"), { recursive: true });
    cpSync(join(ROOT, "apps/word-detective/styles.css"), join(repo, "apps/word-detective/styles.css"));
    cpSync(join(ROOT, "apps/word-detective/.design"), join(repo, "apps/word-detective/.design"), { recursive: true });
    git("add", "-A"); git("commit", "-q", "-m", "initial");
    expect(node("snapshot.mjs", "--workspace", repo, "--run", RUN).status).toBe(0);
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(runs, { recursive: true, force: true }); });

  it("delivers a pending proposal without deciding it or changing code or handbook approval", () => {
    const draft = join(runs, "proposal.json");
    writeFileSync(draft, JSON.stringify({ title: "徽章名称说明", reason: "用户要求名称清楚", source: { kind: "user-request", ref: "本次明确要求" }, items: [
      { op: "modify", target: "rules", key: "WD-013", after: { check: "检查名称的字号和对比度" }, why: "把用户要求变成可检查的规则" }
    ] }));
    const proposed = hb("propose", "--file", draft);
    expect(proposed.status, proposed.stderr).toBe(0);
    const id = JSON.parse(proposed.stdout).proposal;
    expect(hb("build").status).toBe(0);
    const before = git("diff");
    const result = generate();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(check(output.chatSummary)).toEqual([]);
    expect(check(`[手册](.ui-refinement-runs/${RUN}/handbook.html)`)).toEqual([]);
    const delivery = JSON.parse(readFileSync(output.deliveryJson, "utf8"));
    expect(delivery).toMatchObject({ mode: "refine", status: "approved", pendingProposals: [id] });
    const p = JSON.parse(readFileSync(join(repo, "apps/word-detective/.design/proposals", `${id}.json`), "utf8"));
    expect(p.status).toBe("pending"); expect(p.items[0].decision).toBeNull();
    expect(git("diff")).toBe(before);
    expect(git("status", "--porcelain")).not.toContain(".ui-refinement-runs");
  });

  it("refuses application-code and other-application changes after the snapshot", () => {
    writeFileSync(join(repo, "apps/word-detective/styles.css"), "changed");
    expect(generate().status).toBe(2);
    git("restore", "apps/word-detective/styles.css");
    mkdirSync(join(repo, "apps/other")); writeFileSync(join(repo, "apps/other/index.html"), "changed");
    const result = generate();
    expect(result.status).toBe(2); expect(result.stderr).toContain("apps/other/index.html");
  });

  it("does not attribute existing dirty code to this run", () => {
    writeFileSync(join(repo, "existing.txt"), "user work");
    const next = "ui-20261122-1931-ab12";
    expect(node("snapshot.mjs", "--workspace", repo, "--run", next).status).toBe(0);
    const result = node("generate-handbook-delivery.mjs", "--run", next, "--app", "word-detective", "--requirement", "交付当前手册");
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(repo, "existing.txt"), "utf8")).toBe("user work");
  });

  it("refuses stale HTML and invalid handbooks", () => {
    const html = join(repo, "apps/word-detective/.design/handbook.html");
    writeFileSync(html, "stale");
    expect(generate().stderr).toContain("已过期");
    const manifest = join(repo, "apps/word-detective/.design/manifest.json");
    const json = JSON.parse(readFileSync(manifest, "utf8")); json.themes = ["dark"];
    writeFileSync(manifest, JSON.stringify(json));
    expect(generate().stderr).toContain("只允许 light");
  });

  it("checks the generated HTML, source snapshots and delivery JSON for tampering", () => {
    const out = JSON.parse(generate().stdout);
    writeFileSync(out.handbookHtml, `${readFileSync(out.handbookHtml, "utf8")}\n<!-- tampered -->\n`);
    expect(check(out.chatSummary)![0]).toContain("HTML 的哈希不一致");
    const fresh = JSON.parse(generate().stdout);
    writeFileSync(join(repo, ".ui-refinement-runs", RUN, "handbook.json"), "{}");
    expect(check(fresh.chatSummary)![0]).toContain("handbook.json 被改过");
    generate();
    writeFileSync(out.deliveryJson, "{}");
    expect(check(out.chatSummary)![0]).toContain("交付记录的哈希不一致");
  });

  it("does not accept a review report for a refine delivery or a plain handbook without a delivery record", () => {
    expect(check("[检查报告](report.html)")![0]).toContain("没有设计手册");
    expect(check("[手册](apps/word-detective/.design/handbook.html)")![0]).toContain("交付标记");
    const out = JSON.parse(generate().stdout);
    // 未运行交付脚本而直接引用手册时，同样要求有真实的完整交付记录。
    expect(check(out.chatSummary, [event("handbook.mjs build")])).toEqual([]);
  });
});
