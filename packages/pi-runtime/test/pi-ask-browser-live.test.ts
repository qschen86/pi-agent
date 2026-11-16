/**
 * macOS 真实 Seatbelt：pi-ask 边界里能直接启动共享目录里的 Chromium（headless shell）。
 * 走 preparePiChatBoundary 的真实装配（环境变量 + 只读白名单 + Chromium Mach 规则），不注入假 guard。
 * 本机没有 Seatbelt 或没装 Playwright 的 headless shell 时跳过。
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { sharedPlaywrightBrowsersPath } from "../../adapter-pi/src/pi-runtime-env.js";
import { SeatbeltRuntimeGuard } from "../../adapter-pi/src/os-sandbox.js";
import { preparePiChatBoundary } from "../src/pi-boundary.js";

/** 共享目录里最新的 chrome-headless-shell 可执行文件。 */
function headlessShell(cache: string | undefined): string | undefined {
  if (!cache) return undefined;
  const dirs = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
  for (const d of dirs) {
    const base = join(cache, d);
    for (const arch of readdirSync(base).filter((n) => n.startsWith("chrome-headless-shell-"))) {
      const bin = join(base, arch, "chrome-headless-shell");
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

const cache = process.platform === "darwin" ? sharedPlaywrightBrowsersPath() : undefined;
const shell = headlessShell(cache);
// 已经在 Pi 沙箱里（PI_CHAT_PERMISSION_MODE 由边界注入）时不能再套一层 Seatbelt，直接跳过。
const nestedInPiSandbox = !!process.env["PI_CHAT_PERMISSION_MODE"];
const runnable = process.platform === "darwin" && !!shell && !nestedInPiSandbox && new SeatbeltRuntimeGuard().available();

/** 仓库里的 playwright 入口（找不到就跳过 Node 库用例）。 */
const playwrightEntry = (() => { try { return createRequire(import.meta.url).resolve("playwright"); } catch { return undefined; } })();

/** playwright 所在的 node_modules 的上一级，即「所属仓库根」。 */
const repoRoot = playwrightEntry ? playwrightEntry.slice(0, playwrightEntry.lastIndexOf(`${sep}node_modules${sep}`)) : undefined;

const made: string[] = [];
const dir = (prefix: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!runnable)("pi-ask 边界里启动共享 Chromium（macOS Seatbelt）", () => {
  async function dumpDom(mode: string): Promise<{ status: number | null; out: string; env: Record<string, string> }> {
    const boundary = await preparePiChatBoundary({
      workspace: dir("pi-ask-ws-"), mode, provider: "deepseek",
      runtimeRoot: join(dir("pi-ask-rt-"), "r"), guardDir: join(dir("pi-ask-gd-"), "g"), sourceAgentDir: dir("pi-ask-agent-")
    });
    try {
      const w = await boundary.wrap(shell!, ["--headless", "--no-sandbox", "--disable-gpu", "--dump-dom", "data:text/html,<h1>shared-browser-ok</h1>"]);
      const r = spawnSync(w.command, w.args, {
        encoding: "utf8", timeout: 60_000,
        env: { PATH: process.env["PATH"] ?? "", ...boundary.env, MAC_CHROMIUM_TMPDIR: boundary.env["TMPDIR"] ?? "", ...(("env" in w ? w.env : undefined) ?? {}) }
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}`, env: boundary.env };
    } finally { await boundary.dispose(); }
  }

  it("pi-ask：环境指向共享目录，且浏览器能在沙箱里启动并渲染页面", async () => {
    const r = await dumpDom("pi-ask");
    expect(r.env["PLAYWRIGHT_BROWSERS_PATH"]).toBe(cache);
    expect(r.out).toContain("shared-browser-ok");
    expect(r.status).toBe(0);
  }, 90_000);

  it("pi-read-only：不放行共享目录，浏览器不能启动", async () => {
    const r = await dumpDom("pi-read-only");
    expect(r.out).not.toContain("shared-browser-ok");
  }, 90_000);

  // 走 Playwright Node 库：库本身在仓库的 node_modules 里（worktree 会话从主检出解析依赖），
  // 沙箱默认读不到家目录——这条路径和「直接跑二进制」是两回事。
  it.skipIf(!runnable || !playwrightEntry || !repoRoot)("pi-ask：Playwright Node 库能在沙箱里加载并驱动共享 Chromium", async () => {
    const workspace = dir("pi-ask-pw-ws-");
    const boundary = await preparePiChatBoundary({
      workspace, mode: "pi-ask", provider: "deepseek", worktree: { repoRoot: repoRoot!, path: workspace, branch: "pi/rt-live-probe" },
      runtimeRoot: join(dir("pi-ask-pw-rt-"), "r"), guardDir: join(dir("pi-ask-pw-gd-"), "g"), sourceAgentDir: dir("pi-ask-pw-agent-")
    });
    try {
      const script = join(workspace, "pw.cjs");
      writeFileSync(script, `const { chromium } = require(${JSON.stringify(playwrightEntry)});
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<h1>pw-lib-ok</h1>");
  console.log("RESULT:" + await page.textContent("h1"));
  await browser.close();
})().catch((e) => { console.log("ERR:" + String(e).slice(0, 400)); process.exit(1); });
`);
      const w = await boundary.wrap(process.execPath, [script]);
      const r = spawnSync(w.command, w.args, {
        cwd: workspace, encoding: "utf8", timeout: 60_000,
        env: { PATH: process.env["PATH"] ?? "", ...boundary.env, MAC_CHROMIUM_TMPDIR: boundary.env["TMPDIR"] ?? "", ...(("env" in w ? w.env : undefined) ?? {}) }
      });
      expect(`${r.stdout}${r.stderr}`).toContain("RESULT:pw-lib-ok");
      expect(r.status).toBe(0);
    } finally { await boundary.dispose(); }
  }, 90_000);

  // Vite 向上找 PostCSS 配置会读仓库根 package.json；这里不起 Vite，直接验证这个读权限
  // （pi-ask 能读，pi-read-only 读不到）。不做写入探测：目标是真实的仓库文件，可写性由策略的 writeScope 保证。
  it.skipIf(!runnable || !repoRoot)("仓库根 package.json：pi-ask 可读；pi-read-only 不可读", async () => {
    const attempt = async (mode: string) => {
      const workspace = dir("pi-ask-pkg-ws-");
      const boundary = await preparePiChatBoundary({
        workspace, mode, provider: "deepseek", worktree: { repoRoot: repoRoot!, path: workspace, branch: "pi/rt-live-probe" },
        runtimeRoot: join(dir("pi-ask-pkg-rt-"), "r"), guardDir: join(dir("pi-ask-pkg-gd-"), "g"), sourceAgentDir: dir("pi-ask-pkg-agent-")
      });
      try {
        const pkg = join(repoRoot!, "package.json");
        const w = await boundary.wrap("/bin/bash", ["--noprofile", "--norc", "-c", `head -c 1 ${JSON.stringify(pkg)} && echo READ_OK`]);
        const r = spawnSync(w.command, w.args, { encoding: "utf8", timeout: 30_000, env: { PATH: process.env["PATH"] ?? "", ...boundary.env, ...(("env" in w ? w.env : undefined) ?? {}) } });
        return `${r.stdout}${r.stderr}`;
      } finally { await boundary.dispose(); }
    };
    const ask = await attempt("pi-ask");
    expect(ask).toContain("READ_OK");
    expect(await attempt("pi-read-only")).not.toContain("READ_OK");
  }, 60_000);
});
