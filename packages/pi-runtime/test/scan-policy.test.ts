import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanViolation, scanViolations } from "../src/scan-policy.mjs";
import { createPiToolGate } from "../src/pi-approval-extension.js";
import { preparePiChatBoundary } from "../src/pi-boundary.js";

/** 会话在自己的 worktree 里：仓库内可以随便扫，家目录其他地方不行。 */
const wt = { cwd: "/Users/kisen/Documents/pi-agent/.pi-worktrees/rt-1", allow: "/Users/kisen/Documents/pi-agent/.pi-worktrees/rt-1", repoRoot: "/Users/kisen/Documents/pi-agent" };
const bash = (command: string) => ({ toolName: "bash", input: { command } });

describe("长命令扫描守卫", () => {
  const denied: Array<[string, string]> = [
    // 真实事故：整台机器 home 递归 find，会话白等 76 分钟
    ["整盘 find 家目录（2026-11-14 事故原样）", "find /Users/kisen -maxdepth 4 -name \"fontTools\" -type d 2>/dev/null | head -5"],
    ["ls 拼 find 的家目录探测", "ls /opt/homebrew/lib/python3*/site-packages | head; find /Users/kisen -maxdepth 4 -name fontTools"],
    ["find ~ 无深度上限", "find ~ -name '*.ts'"],
    ["find $HOME", "find $HOME -type d -name node_modules"],
    ["find 根目录", "find / -name foo"],
    ["find 家目录（带 maxdepth 也不放行）", "find /Users/kisen -maxdepth 2 -name x"],
    ["find 家目录深处无深度上限", "find /Users/kisen/Library -name x"],
    ["find 家目录深处深度过大", "find /Users/kisen/Library -maxdepth 9 -name x"],
    ["find ~/Documents 子目录无上限", "find ~/Documents/notes -name '*.md'"],
    ["递归 grep 家目录", "grep -rn \"foo\" /Users/kisen"],
    ["递归 grep 家目录子目录", "grep -rn \"foo\" /Users/kisen/Documents"],
    ["grep -R 系统目录", "grep -R foo /Library"],
    ["rg 家目录子目录", "rg foo /Users/kisen/Library"],
    ["du 整个家目录", "du -sh /Users/kisen"],
    ["du 家目录子目录且无深度限制", "du /Users/kisen/Library"],
    ["cd 之后 grep 当前目录", "cd /Users/kisen/Library && grep -rn foo"],
    ["env/sudo 前置包装", "env FOO=1 find ~ -name x"],
    ["重定向目标不算扫描路径", "find /Users/kisen/Library -name x > /tmp/out.txt"],
    ["嵌套 shell 里的整盘扫描", "bash -lc \"find /Users/kisen -name x\""],
    ["sh -c 里的递归 grep", "sh -c 'grep -rn a /Users/kisen/Library'"]
  ];
  it.each(denied)("拒绝：%s", (_label, command) => {
    const reason = scanViolation("bash", { command }, wt);
    expect(reason).toContain("SCAN_TOO_BROAD");
  });

  const allowed: Array<[string, string]> = [
    ["工作区内相对路径 find", "find . -name x"],
    ["工作区内 grep", "grep -rn \"foo\" apps/web"],
    ["仓库内绝对路径 find", "find /Users/kisen/Documents/pi-agent/packages -name '*.ts'"],
    ["家目录子目录但带小深度", "find /Users/kisen/Library -maxdepth 3 -name x"],
    ["家目录子目录正好 5 层", "find /Users/kisen/Library -maxdepth 5 -name x"],
    ["临时目录", "find /tmp/scan -name x"],
    ["仓库内 du -sh node_modules", "du -sh /Users/kisen/Documents/pi-agent/node_modules"],
    ["非递归 grep", "grep -n foo package.json"],
    ["git grep 只扫仓库", "git grep -n foo"],
    ["回归测试命令", "npx vitest run apps/web/test/a.test.ts"],
    ["gtimeout 显式限时", "gtimeout 120 find ~ -name x"],
    ["perl alarm 显式限时", "perl -e 'alarm 60; exec @ARGV' find / -name x"],
    ["引号里的文本没被执行", "echo \"find ~ -name x\""],
    ["写入工具只带内容不跑命令", "find ~ -name y"]
  ];
  it.each(allowed)("放行：%s", (label, command) => {
    const input = label.startsWith("写入工具") ? { path: "notes.md", content: command } : { command };
    expect(scanViolation("bash", input, wt)).toBeUndefined();
  });

  it("同一轮命令里多处命中只报一条，且能列出全部", () => {
    const command = "find / -name a; grep -rn b /Users/kisen/Library";
    expect(scanViolations("bash", { command }, wt)).toHaveLength(2);
    expect(scanViolation("bash", { command }, wt)).toBe(scanViolations("bash", { command }, wt)[0]);
  });

  it("拒绝原因直接给替代写法，不只是报错", () => {
    const reason = scanViolation("bash", { command: "find /Users/kisen -maxdepth 4 -name fontTools" }, wt) ?? "";
    expect(reason).toContain("command -v");
    expect(reason).toContain("gtimeout");
  });

  it("门禁在放行判断之前拦下，不让命令进入执行", async () => {    const ctx = { hasUI: false, ui: { confirm: async () => false } };
    const blocked = await createPiToolGate("pi-ask")({ toolName: "bash", toolCallId: "c1", input: { command: "find /Users/kisen -maxdepth 4 -name fontTools" } }, ctx);
    expect(blocked).toMatchObject({ block: true });
    expect((blocked as { reason: string }).reason).toContain("SCAN_TOO_BROAD");
    // 允许的命令不在这一层被拒（pi-ask 后续才因为缺少审批 UI 拒绝，原因不同）
    const passthrough = await createPiToolGate("pi-ask")({ toolName: "bash", toolCallId: "c2", input: { command: "grep -rn foo apps/web" } }, ctx);
    expect(JSON.stringify(passthrough ?? {})).not.toContain("SCAN_TOO_BROAD");
  });

  it("守卫模块会随边界一起写进只读 guard 目录（否则运行时 import 失败）", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-guard-"));
    const workspace = join(root, "work"), guardDir = join(root, "guard");
    mkdirSync(workspace);
    const boundary = await preparePiChatBoundary({ workspace, runtimeRoot: join(root, "runtime"), guardDir, provider: "deepseek", mode: "pi-native" });
    try {
      const source = readFileSync(new URL("../src/scan-policy.mjs", import.meta.url), "utf8");
      expect(readFileSync(join(guardDir, "scan-policy.mjs"), "utf8")).toBe(source);
      expect(readFileSync(join(guardDir, "screenshot-policy.mjs"), "utf8")).toContain("SCREENSHOT_TOOL_REQUIRED");
    } finally { await boundary.dispose(); rmSync(root, { recursive: true, force: true }); }
  });
});
