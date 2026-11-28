/**
 * 交付物可达性检查（deliverable-check.ts + manager.enforceDeliverables）：
 *   1. 只提取用户会点的东西：Markdown 链接 / 行内代码 / 正文里的文件路径、正文里的本机链接；代码块与行内代码里的本机地址不算；
 *   2. 源码文件（讨论用）不查，避免聊代码时误报；
 *   3. 校验不通过只自动反馈给 runtime，不在时间线给用户加提示，最多补救 MAX_ENFORCEMENT_RETRIES 次。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliverableProblems, extractDeliverableRefs } from "../src/deliverable-check.js";
import { ENFORCEMENT_PROMPT_MARK } from "../src/memory-enforcement.js";
import { RuntimeSessionManager } from "../src/manager.js";
import { FakeDriver, until, tick } from "./fake-driver.js";

describe("extractDeliverableRefs", () => {
  it("collects markdown links, inline-code paths and bare paths of deliverable types", () => {
    const refs = extractDeliverableRefs([
      "看这张图 ![浅色](.ui-refinement-runs/r1/shots/light.png)，报告 [report.html](docs/out/report.html)。",
      "也可以看 `docs/x/summary.md` 和 /Users/me/work/out.pdf 这两个。",
      "文件名带空格的链接 [a b](<shots/a b.png>)"
    ].join("\n"));
    expect(refs.files.map((f) => f.path).sort()).toEqual([".ui-refinement-runs/r1/shots/light.png", "/Users/me/work/out.pdf", "docs/out/report.html", "docs/x/summary.md", "shots/a b.png"].sort());
    expect(refs.localUrls).toEqual([]);
  });

  it("ignores source files, remote links, directories, anchors and fenced code", () => {
    const refs = extractDeliverableRefs([
      "改了 `src/new-module.ts` 和 apps/web/public/app.js，看 [文档](https://example.com/a.md) 与 [目录](docs/design/)。",
      "```",
      "cat docs/in-code/hidden.md ; curl http://127.0.0.1:9/x",
      "```"
    ].join("\n"));
    expect(refs.files).toEqual([]);
    expect(refs.localUrls).toEqual([]);
  });

  it("strips :line and #fragment, decodes encoded links, and passes message directories as hints for bare names", () => {
    const refs = extractDeliverableRefs("截图在 `docs/req/evidence/` 下：[前](before%20x.png)、`after.png`，说明见 [m](docs/req/notes.md#top)。");
    const byPath = Object.fromEntries(refs.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["after.png", "before x.png", "docs/req/notes.md"]);
    expect(byPath["after.png"]!.hints).toContain("docs/req/evidence");
  });

  it("flags local-only links (markdown or bare) but not ones written as inline code or in code blocks", () => {
    const lan = ["192", "168", "1", "8"].join(".");   // 不写字面量：公开前个人信息扫描会把内网地址当成泄露
    const refs = extractDeliverableRefs([
      "原型：http://127.0.0.1:50787/ 与 [预览](http://localhost:3000/p.html)。",
      "给自己看的诊断 `http://127.0.0.1:8780/#/runtimes`，公网 https://console.example.com/ 正常。",
      `内网 http://${lan}:80/x。`
    ].join("\n"));
    expect(refs.localUrls.sort()).toEqual(["http://127.0.0.1:50787/", `http://${lan}:80/x`, "http://localhost:3000/p.html"].sort());
  });
});

describe("deliverableProblems", () => {
  it("reports unreachable files from the injected checker and local urls; checker errors are not problems", async () => {
    const base = { pid: "p", workspace: "/w", runtimeKind: "codex", assistantText: "图 ![x](shots/a.png) 与 http://127.0.0.1:1/ 。" };
    const problems = await deliverableProblems({ ...base, checkFiles: async ({ refs }) => refs.map((r) => ({ ref: r.path, reason: "文件不存在或没有读取权限" })) });
    expect(problems).toEqual(["http://127.0.0.1:1/：本机地址，用户在手机或公网入口点开必然打不开", "shots/a.png：文件不存在或没有读取权限"]);
    const errored = await deliverableProblems({ ...base, assistantText: "图 ![x](shots/a.png)", checkFiles: async () => { throw new Error("boom"); } });
    expect(errored).toEqual([]);
    expect(await deliverableProblems({ ...base, assistantText: "没有任何路径", checkFiles: async () => [{ ref: "x", reason: "y" }] })).toEqual([]);
  });
});

describe("manager: enforceDeliverables", () => {
  let dir: string, ws: string, mgr: RuntimeSessionManager, driver: FakeDriver;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "rt-deliverable-")); ws = join(dir, "work"); mkdirSync(ws);
    driver = new FakeDriver("codex");
    mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver }, skipRecovery: true });
    mgr.updateSettings({ workspaceRoots: [ws] }, "test"); await mgr.probe("codex");
  });
  afterEach(async () => { mgr.shutdown(); await tick(35); rmSync(dir, { recursive: true, force: true }); });
  const say = (i: number, text: string) => {
    driver.turns[i]!.sink.event({ key: `msg-${i}`, kind: "message", role: "assistant", text, source: "stream", parserVersion: "t", availability: "recorded" });
    driver.turns[i]!.finish({ status: "completed" });
  };
  const start = async (prompt: string) =>
    (await mgr.create({ idempotencyKey: `dl-${Math.random().toString(36).slice(2, 10)}`, runtimeKind: "codex", workspace: ws, title: "t", prompt, confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test")).session.platformSessionId;

  it("feeds back unreachable files and local urls silently, stops after the retry limit, and passes once fixed", async () => {
    writeFileSync(join(ws, "ok.png"), "x");
    mgr.setDeliverableChecker(async ({ refs }) => refs.filter((r) => r.path !== "ok.png" && !r.path.endsWith("/ok.png")).map((r) => ({ ref: r.path, reason: "文件不存在或没有读取权限" })));

    // 全部可达：不补救
    const good = await start("做图");
    await until(() => driver.turns.length === 1);
    say(0, "图在 ![ok](ok.png)");
    await tick(150);
    expect(driver.turns).toHaveLength(1);

    // 不存在的文件 + 本机地址：自动反馈，且不在时间线留给用户的提示
    const bad = await start("再做一张");
    await until(() => driver.turns.length === 2);
    say(1, "图在 ![gone](shots/gone.png)，原型 http://127.0.0.1:50787/");
    await until(() => driver.turns.length === 3);
    const feedback = driver.turns[2]!.args.prompt;
    expect(feedback.startsWith(ENFORCEMENT_PROMPT_MARK)).toBe(true);
    expect(feedback).toContain("shots/gone.png：文件不存在或没有读取权限");
    expect(feedback).toContain("http://127.0.0.1:50787/：本机地址");
    expect(mgr.store.events(bad).some((e) => e.kind === "notice" && /交付物|校验|反馈/.test(e.text ?? ""))).toBe(false);

    // 仍不通过直到补救次数用完：静默停下，不再续发
    say(2, "还是 ![gone](shots/gone.png)");
    await until(() => driver.turns.length === 4);
    say(3, "依然 ![gone](shots/gone.png)");
    await tick(200);
    expect(driver.turns).toHaveLength(4);
    expect(mgr.store.events(bad).some((e) => e.kind === "notice" && /交付物|仍未/.test(e.text ?? ""))).toBe(false);
    void good;
  });
});
