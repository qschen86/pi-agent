import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isAssetVersionLine, rebaseSessionWorktree, refreshAssetVersions, resolveAssetVersionConflicts } from "../src/worktree.js";

const script = (hash: string) => `<script src="/runtime.js?v=${hash}"></script>`;
const conflict = (ours: string, theirs: string) => `<!doctype html>\n<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> x\n</html>\n`;

it("只差资源版本号的冲突块取 base 一侧解决（其余行原样保留）", () => {
  const r = resolveAssetVersionConflicts(conflict(script("aaaaaaaaaaaa"), script("bbbbbbbbbbbb")));
  expect(r).toMatchObject({ ok: true, hunks: 1 });
  if (r.ok) {
    expect(r.content).toContain(`?v=aaaaaaaaaaaa`);
    expect(r.content).not.toContain("<<<<<<<");
    expect(r.content.split("\n")).toHaveLength(4); // 头、脚本、尾 + 结尾空行
  }
});

it("diff3 样式的冲突块也支持（忽略 base 段）", () => {
  const text = `<<<<<<< HEAD\n${script("aaaaaaaaaaaa")}\n||||||| base\n${script("000000000000")}\n=======\n${script("bbbbbbbbbbbb")}\n>>>>>>> x\n`;
  expect(resolveAssetVersionConflicts(text)).toMatchObject({ ok: true, hunks: 1 });
});

const diff3 = (base: string[], ours: string[], theirs: string[]) =>
  ["<!doctype html>", "<<<<<<< HEAD", ...ours, "||||||| merged common ancestors", ...base, "=======", ...theirs, ">>>>>>> x", "</html>", ""].join("\n");

it("两侧在同一处各自新增资源标签时取并集（两个都保留，版本号稍后重算）", () => {
  const r = resolveAssetVersionConflicts(diff3(
    [script("000000000000")],
    [script("000000000000"), `<script src="/notes.js?v=aaaaaaaaaaaa"></script>`],
    [script("000000000000"), `<link rel="stylesheet" href="/extra.css?v=bbbbbbbbbbbb">`]
  ));
  expect(r).toMatchObject({ ok: true, hunks: 1 });
  if (r.ok) {
    expect(r.content).toContain("/notes.js");
    expect(r.content).toContain("/extra.css");
    expect(r.content).not.toContain("<<<<<<<");
  }
});

it("base 段为空（两边都在同一处插入第一个标签）也能取并集", () => {
  const r = resolveAssetVersionConflicts(diff3(
    [],
    [`<script src="/notes.js?v=aaaaaaaaaaaa"></script>`],
    [`<script src="/stats.js?v=bbbbbbbbbbbb"></script>`]
  ));
  expect(r).toMatchObject({ ok: true, hunks: 1 });
  if (r.ok) {
    expect(r.content).toContain("/notes.js");
    expect(r.content).toContain("/stats.js");
  }
});

it("有一侧删掉或换掉原有标签、或同一资源改了标签本身时不自动合并", () => {
  expect(resolveAssetVersionConflicts(diff3(
    [script("000000000000"), `<script src="/b.js?v=000000000000"></script>`],
    [script("aaaaaaaaaaaa")],
    [script("bbbbbbbbbbbb"), `<script src="/b.js?v=bbbbbbbbbbbb"></script>`]
  ))).toMatchObject({ ok: false });
  expect(resolveAssetVersionConflicts(diff3(
    [script("000000000000")],
    [`<script src="/runtime.js?v=aaaaaaaaaaaa" defer></script>`],
    [script("bbbbbbbbbbbb")]
  ))).toMatchObject({ ok: false });
  expect(resolveAssetVersionConflicts(diff3(
    [script("000000000000")],
    [script("000000000000"), `<div class="mine">会话</div>`],
    [script("000000000000"), `<div class="main">main</div>`]
  ))).toMatchObject({ ok: false });
});

it("换了资源、掺了别的内容、行数不同或没有冲突块都不自动解决", () => {
  expect(resolveAssetVersionConflicts(conflict(script("aaaaaaaaaaaa"), `<script src="/room.js?v=bbbbbbbbbbbb"></script>`))).toMatchObject({ ok: false });
  expect(resolveAssetVersionConflicts(conflict("<div>会话</div>", "<div>main</div>"))).toMatchObject({ ok: false });
  expect(resolveAssetVersionConflicts(conflict(script("aaaaaaaaaaaa"), `${script("bbbbbbbbbbbb")}\n<script src="/room.js?v=cccccccccccc"></script>`))).toMatchObject({ ok: false });
  expect(resolveAssetVersionConflicts("<!doctype html>\n<html></html>\n")).toMatchObject({ ok: false });
});

it("按文件字节重算 ?v=（与 scripts/version-web-assets.mjs 一致）", () => {
  const files: Record<string, string> = { "/runtime.js": "console.log(1)\n", "/styles.css": "a{}" };
  const html = `<!doctype html>\n<link rel="stylesheet" href="/styles.css?v=old"><script src="/runtime.js?v=old"></script>\n`;
  const out = refreshAssetVersions(html, (p) => files[p]!);
  const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
  expect(out).toContain(`/styles.css?v=${hash(files["/styles.css"]!)}`);
  expect(out).toContain(`/runtime.js?v=${hash(files["/runtime.js"]!)}`);
});

it("isAssetVersionLine 只认带版本号的本地 js/css 引用", () => {
  expect(isAssetVersionLine(`<script src="/runtime.js?v=aaaaaaaaaaaa"></script>`)).toBe(true);
  expect(isAssetVersionLine(`<link rel="stylesheet" href="/styles.css?v=aaaaaaaaaaaa">`)).toBe(true);
  expect(isAssetVersionLine(`<script src="/runtime.js"></script>`)).toBe(false);
  expect(isAssetVersionLine(`<script src="https://cdn.example.com/x.js?v=1"></script>`)).toBe(false);
});

it("会话变基遇到两边各自新增的资源标签时自动并集解决，并按文件字节重算版本号", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rebase-assets-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  const page = (lines: string[]) => lines.join("\n") + "\n";
  const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
  const id = "rt-0123456789abcdef", branch = `pi/${id}`;
  const path = join(root, ".pi-worktrees", id);
  try {
    mkdirSync(join(root, "apps/web/public"), { recursive: true });
    git("init", "-q", "-b", "main");
    writeFileSync(join(root, ".git/info/exclude"), ".pi-worktrees/\n");
    writeFileSync(join(root, "apps/web/public/a.js"), "base js");
    writeFileSync(join(root, "apps/web/public/index.html"), page([`<script src="/a.js?v=base"></script>`]));
    git("add", "-A"); git("commit", "-qm", "base");
    git("worktree", "add", "-q", "-b", branch, path);
    writeFileSync(join(path, "apps/web/public/notes.js"), "notes module");
    writeFileSync(join(path, "apps/web/public/index.html"), page([`<script src="/a.js?v=base"></script>`, `<script src="/notes.js?v=new"></script>`]));
    execFileSync("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
    execFileSync("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "notes"]);
    writeFileSync(join(root, "apps/web/public/stats.js"), "stats module");
    writeFileSync(join(root, "apps/web/public/index.html"), page([`<script src="/a.js?v=base"></script>`, `<script src="/stats.js?v=new"></script>`]));
    git("add", "-A"); git("commit", "-qm", "stats");
    const r = await rebaseSessionWorktree(root, path, "main");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.autoResolvedAssets).toBeGreaterThan(0);
      const html = readFileSync(join(path, "apps/web/public/index.html"), "utf8");
      expect(html).not.toContain("<<<<<<<");
      expect(html).toContain(`/notes.js?v=${hash("notes module")}`);
      expect(html).toContain(`/stats.js?v=${hash("stats module")}`);
      expect(html).toContain(`/a.js?v=${hash("base js")}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
