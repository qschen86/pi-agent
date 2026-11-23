/**
 * bash 后台运行的接线：扩展只在能跑 bash 的非评测会话里装配；权限与写入限制不另起一套，
 * 启动后台任务就是一次带 background 的 bash 调用，照常过闸门与命令规则。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePiChatBoundary } from "../src/pi-boundary.js";
import { createPiToolGate } from "../src/pi-approval-extension.js";
import { communityPermissionConfig } from "../src/pi-community-profile.js";

const roots: string[] = [];
const boundaries: Array<Awaited<ReturnType<typeof preparePiChatBoundary>>> = [];
afterEach(async () => {
  await Promise.all(boundaries.splice(0).map((b) => b.dispose().catch(() => {})));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function layout() {
  const root = mkdtempSync(join(tmpdir(), "pi-bg-boundary-")); roots.push(root);
  const workspace = join(root, "workspace"), sourceAgentDir = join(root, "source");
  mkdirSync(workspace); mkdirSync(sourceAgentDir);
  writeFileSync(join(sourceAgentDir, "auth.json"), JSON.stringify({}));
  return { workspace, sourceAgentDir, runtimeRoot: join(root, "runtime"), guardDir: join(root, "guard"), provider: "deepseek" };
}
const toolList = (argsPrefix: string[]) => argsPrefix[argsPrefix.indexOf("--tools") + 1]!.split(",");
const extensions = (argsPrefix: string[]) => argsPrefix.flatMap((arg, i) => (arg === "--extension" ? [argsPrefix[i + 1]!] : []));

describe("边界装配", () => {
  it("pi-native / pi-ask：两个扩展文件进只读 guard 目录，bash_output / bash_kill 进工具白名单", async () => {
    for (const mode of ["pi-native", "pi-ask"] as const) {
      const args = layout();
      const boundary = await preparePiChatBoundary({ ...args, mode });
      boundaries.push(boundary);
      const entry = extensions(boundary.argsPrefix).find((e) => /background-bash\.ts$/.test(e))!;
      expect(entry).toBe(join(realpathSync(args.guardDir), "background-bash.ts"));
      expect(readFileSync(entry, "utf8")).toContain("bash_output");
      expect(readFileSync(join(realpathSync(args.guardDir), "background-jobs.ts"), "utf8")).toContain("class BackgroundJobs");
      expect(toolList(boundary.argsPrefix)).toEqual(expect.arrayContaining(["bash", "bash_output", "bash_kill"]));
    }
  });

  it("只读会话没有 bash：不装配、不加工具", async () => {
    const boundary = await preparePiChatBoundary({ ...layout(), mode: "pi-read-only" });
    boundaries.push(boundary);
    expect(extensions(boundary.argsPrefix).some((e) => /background/.test(e))).toBe(false);
    expect(toolList(boundary.argsPrefix).some((t) => /^bash/.test(t))).toBe(false);
  });
});

describe("闸门：后台启动不绕过任何限制", () => {
  const ctx = (confirm: () => Promise<boolean>) => ({ hasUI: true, ui: { confirm } });
  const bg = (id: string, command = "npm test") => ({ toolName: "bash", toolCallId: id, input: { command, background: true } });

  it("pi-ask：带 background 的 bash 照常要审批，拒绝就不执行", async () => {
    const gate = createPiToolGate("pi-ask");
    let asked = 0;
    expect(await gate(bg("b1"), ctx(async () => { asked++; return false; }))).toMatchObject({ block: true });
    expect(asked).toBe(1);
    expect(await gate(bg("b2"), ctx(async () => true))).toBeUndefined();
  });

  it("只读会话里带 background 的 bash 仍被拒", async () => {
    expect(await createPiToolGate("pi-read-only")(bg("b3"), ctx(async () => true))).toMatchObject({ block: true });
  });

  it("无界扫描拦截对后台启动同样生效", async () => {
    const gate = createPiToolGate("pi-native");
    expect(await gate(bg("b4", "find / -name '*.log'"), ctx(async () => true))).toMatchObject({ block: true });
  });

  it("bash_output / bash_kill 在 pi-ask / pi-native 放行，只读与评测里仍按未知工具拒绝", async () => {
    for (const mode of ["pi-ask", "pi-native"]) {
      for (const toolName of ["bash_output", "bash_kill"]) {
        expect(await createPiToolGate(mode)({ toolName, toolCallId: `${mode}-${toolName}`, input: { id: "job-1" } }, ctx(async () => false))).toBeUndefined();
      }
    }
    for (const mode of ["pi-read-only", "pi-evaluation"]) {
      expect(await createPiToolGate(mode)({ toolName: "bash_output", toolCallId: mode, input: { id: "job-1" } }, ctx(async () => true))).toMatchObject({ block: true });
    }
  });
});

describe("community 权限配置", () => {
  it("装配了后台运行才放行 bash_output / bash_kill；bash 的命令规则不变", () => {
    const off = communityPermissionConfig([]).permission as Record<string, unknown>;
    const on = communityPermissionConfig([], { backgroundBash: true }).permission as Record<string, unknown>;
    expect(off["bash_output"]).toBeUndefined();
    expect(on["bash_output"]).toBe("allow");
    expect(on["bash_kill"]).toBe("allow");
    expect(on["bash"]).toEqual(off["bash"]);
    expect((on["bash"] as Record<string, string>)["git push *"]).toBe("ask");
  });
});
