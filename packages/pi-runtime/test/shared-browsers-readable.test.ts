import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeGuardProvider } from "@pi-agent/runtime-contracts";
import { preparePiChatBoundary } from "../src/pi-boundary.js";

const made: string[] = [];
const dir = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env["PLAYWRIGHT_BROWSERS_PATH"]; });

/** 捕获传给 OS 边界的策略，然后让 prepare 失败（不真的启动沙箱）。 */
async function capturedReadScope(mode: string, repo?: string): Promise<string[]> {
  const browsers = dir("pw-browsers-");
  mkdirSync(join(browsers, "chromium-1"), { recursive: true });
  process.env["PLAYWRIGHT_BROWSERS_PATH"] = browsers;
  let scope: string[] = [];
  const guard: RuntimeGuardProvider = {
    name: "capture", available: () => true,
    prepare: async (input) => { scope = (input.policy as any).filesystem.allowReadWithin; throw new Error("captured"); }
  };
  await expect(preparePiChatBoundary({
    workspace: dir("pw-ws-"), mode, provider: "deepseek", ...(repo ? { worktree: { repoRoot: repo, path: "/nonexistent-worktree", branch: "pi/rt-x" } } : {}),
    runtimeRoot: join(dir("pw-rt-"), "r"), guardDir: join(dir("pw-gd-"), "g"),
    sourceAgentDir: dir("pw-agent-"), guard
  })).rejects.toThrow("captured");
  return [...scope, browsers];
}

describe("共享 Playwright 浏览器目录的只读放行", () => {
  it("pi-ask：目录在沙箱只读白名单里", async () => {
    const [browsers, ...rest] = (await capturedReadScope("pi-ask")).reverse();
    expect(rest).toContain(browsers);
  });
  it("pi-read-only：不放行", async () => {
    const [browsers, ...rest] = (await capturedReadScope("pi-read-only")).reverse();
    expect(rest).not.toContain(browsers);
  });
  it("pi-ask：worktree 所属仓库的 node_modules 只读放行（目录存在时）；pi-read-only 不放", async () => {
    const repo = dir("pw-repo-");
    mkdirSync(join(repo, "node_modules"));
    mkdirSync(join(repo, "packages"));
    writeFileSync(join(repo, "package.json"), "{}");
    const ask = await capturedReadScope("pi-ask", repo);
    expect(ask).toContain(join(repo, "node_modules"));
    expect(ask).toContain(join(repo, "package.json"));
    expect(ask).toContain(join(repo, "packages"));
    const readOnly = await capturedReadScope("pi-read-only", repo);
    expect(readOnly).not.toContain(join(repo, "node_modules"));
    expect(readOnly).not.toContain(join(repo, "package.json"));
    expect(readOnly).not.toContain(join(repo, "packages"));
  });
  it("仓库没有 node_modules 时不加入", async () => {
    const repo = dir("pw-repo-");
    expect(await capturedReadScope("pi-ask", repo)).not.toContain(join(repo, "node_modules"));
  });
});
