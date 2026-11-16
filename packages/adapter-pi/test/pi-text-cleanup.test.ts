/**
 * runPiText 不得在 $TMPDIR 留下任何目录（含 OS 边界的 pi-text-guard-*）。
 * 此前 prepared.dispose() 是空操作、guardDir 无人删除，每次调用泄漏一个目录。
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { osSandboxAvailable } from "../src/os-sandbox.js";
import { runPiText } from "../src/pi-text.js";

const AVAILABLE = process.platform === "darwin" && osSandboxAvailable();

describe.skipIf(!AVAILABLE)("runPiText temp cleanup", () => {
  const saved = process.env["TMPDIR"];
  const roots: string[] = [];
  afterEach(() => {
    if (saved === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = saved;
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function isolatedTmp(): string {
    const base = realpathSync(mkdtempSync(join(saved ?? tmpdir(), "pi-text-cleanup-")));
    roots.push(base);
    const tmp = join(base, "tmp");
    mkdirSync(tmp);
    process.env["TMPDIR"] = tmp;
    return tmp;
  }
  function fakePi(dir: string, body: string): string {
    const bin = join(dir, "fake-pi");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  it("成功路径：返回后 TMPDIR 里没有残留", async () => {
    const tmp = isolatedTmp();
    const bin = fakePi(join(tmp, ".."), "echo ok");
    const out = await runPiText({ systemPrompt: "s", prompt: "p", bin });
    expect(out).toContain("ok");
    expect(readdirSync(tmp)).toEqual([]);
  }, 60_000);

  it("失败路径（pi 非 0 退出）：同样不残留", async () => {
    const tmp = isolatedTmp();
    const bin = fakePi(join(tmp, ".."), "echo boom >&2; exit 3");
    await expect(runPiText({ systemPrompt: "s", prompt: "p", bin })).rejects.toThrow(/退出码 3/);
    expect(readdirSync(tmp)).toEqual([]);
    expect(existsSync(tmp)).toBe(true);
  }, 60_000);
});
