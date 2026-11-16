import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { isAssetVersionLine, refreshAssetVersions, resolveAssetVersionConflicts } from "../src/worktree.js";

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
