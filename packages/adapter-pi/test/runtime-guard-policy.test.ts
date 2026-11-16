/**
 * Runtime Guard 策略编译（ADR-0808）：平台自己的边界模型，由 BindingPlan 与本轮运行时目录派生。
 *
 * 锁住评审时指出的几处：
 *   - 写范围 = 授权写目录 + 本轮运行时目录——不放大到整个工作区，也不再包含 ~/.pi；
 *   - 读：家目录内容默认拒读，只放行工作区与运行时必需目录——不再放行整个仓库
 *     （控制台所有会话的数据都在仓库的 .pi-agent/ 下）；
 *   - 路径一律归一（~、相对路径、..、/var→/private/var、尚不存在的尾部）；
 *   - 会让边界失效的配置在编译期就拒绝（fail closed），而不是生成一个看起来生效的规则。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  canonicalPath,
  compileRuntimeGuardPolicy,
  DEFAULT_HAZARD_NAMES,
  DEFAULT_PROTECTED_NAMES,
  DEFAULT_PROTECTED_PATHS
} from "@pi-agent/adapter-pi";

function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rgp-")));
  const home = join(base, "home");
  const ws = join(home, "projects", "demo"); // 工作区在家目录下（控制台的真实形态）
  const rt = join(base, "rt");
  const run = join(base, "run");
  for (const d of [home, ws, join(ws, "out"), rt, run]) mkdirSync(d, { recursive: true });
  return { base, home, ws, rt, run };
}

describe("路径归一", () => {
  it("~、相对路径、..、尚不存在的尾部都归一成绝对的 realpath", () => {
    const { base, home } = layout();
    expect(canonicalPath("~/.ssh", { home })).toBe(join(home, ".ssh"));
    expect(canonicalPath("~", { home })).toBe(home);
    expect(canonicalPath("rt/../run/x", { base })).toBe(join(base, "run", "x"));
    expect(canonicalPath(join(base, "not", "yet", "there"))).toBe(join(base, "not", "yet", "there"));
  });

  it("符号链接按真实路径归一：内核按 realpath 匹配，不归一等于没写", () => {
    const { base } = layout();
    const real = join(base, "real-dir");
    mkdirSync(real);
    symlinkSync(real, join(base, "link-dir"));
    expect(canonicalPath(join(base, "link-dir", "child"))).toBe(join(real, "child"));
    // macOS：/var 是 /private/var 的链接，mktemp 给的是前者
    if (process.platform === "darwin") {
      const unresolved = base.replace(/^\/private\/var\//, "/var/");
      expect(canonicalPath(join(unresolved, "run"))).toBe(join(base, "run"));
    }
  });

  it("含 NUL 的路径直接拒绝", () => {
    expect(() => canonicalPath("/tmp/a\u0000b")).toThrow(/非法路径/);
  });
});

describe("由授权与运行时目录编译边界", () => {
  it("写范围 = 授权写目录 + 本轮运行时目录：不含整个工作区，也不含 ~/.pi", () => {
    const { home, ws, rt, run } = layout();
    const policy = compileRuntimeGuardPolicy({ workspaceRoot: ws, writeSubPaths: ["out"], runtimeWritable: [rt, run], home });
    expect(policy.filesystem.writeScope.sort()).toEqual([join(ws, "out"), rt, run].sort());
    expect(policy.filesystem.writeScope).not.toContain(ws);
    expect(policy.filesystem.writeScope.some((p) => p.startsWith(join(home, ".pi")))).toBe(false);
    expect(policy.filesystem.defaultWrite).toBe("deny");
  });

  it("读：家目录内容拒读，只放行工作区与声明过的运行时目录", () => {
    const { home, ws, rt, run } = layout();
    const tools = join(home, ".pi", "agent", "bin");
    mkdirSync(tools, { recursive: true });
    const policy = compileRuntimeGuardPolicy({
      workspaceRoot: ws, writeSubPaths: ["out"], runtimeWritable: [rt, run], runtimeReadable: [tools], home
    });
    expect(policy.filesystem.defaultRead).toBe("allow");
    expect(policy.filesystem.denyReadRegions).toEqual([home]);
    expect(policy.filesystem.allowReadWithin).toContain(ws);
    expect(policy.filesystem.allowReadWithin).toContain(tools);
    // 没声明的家目录内容（包括 ~/.pi 本身）不在放行之列
    expect(policy.filesystem.allowReadWithin).not.toContain(join(home, ".pi"));
    expect(policy.filesystem.allowReadWithin).not.toContain(home);
  });

  it("没有写授权时，工作区全部只读：写范围里只剩运行时目录", () => {
    const { home, ws, rt, run } = layout();
    const policy = compileRuntimeGuardPolicy({ workspaceRoot: ws, writeSubPaths: [], runtimeWritable: [rt, run], home });
    expect(policy.filesystem.writeScope.sort()).toEqual([rt, run].sort());
  });

  it("敏感清单与危险文件清单只能追加、不能删减", () => {
    const { home, ws, rt, run } = layout();
    const policy = compileRuntimeGuardPolicy({
      workspaceRoot: ws, writeSubPaths: ["out"], runtimeWritable: [rt, run], home,
      extraProtectedPaths: ["~/.config/private-tool"], extraProtectedNames: ["*.pem"]
    });
    for (const p of DEFAULT_PROTECTED_PATHS) expect(policy.filesystem.protectedPaths).toContain(canonicalPath(p, { home }));
    expect(policy.filesystem.protectedPaths).toContain(join(home, ".config", "private-tool"));
    expect(policy.filesystem.protectedNames).toEqual([...DEFAULT_PROTECTED_NAMES, "*.pem"]);
    expect(policy.filesystem.hazardNames).toEqual([...DEFAULT_HAZARD_NAMES]);
    // 评审时指出的本机实际存在、却不在原文档清单里的几项
    for (const rel of [".config/gh", ".pi/agent/auth.json", ".pi/agent/sessions"]) {
      expect(policy.filesystem.protectedPaths).toContain(join(home, rel));
    }
  });

  it("网络保持整体放行：文件边界不顺便收紧网络", () => {
    const { home, ws, rt, run } = layout();
    expect(compileRuntimeGuardPolicy({ workspaceRoot: ws, writeSubPaths: ["out"], runtimeWritable: [rt, run], home }).network)
      .toEqual({ mode: "unrestricted" });
  });
});

describe("会让边界失效的配置：编译期拒绝", () => {
  const cases: Array<[string, (l: ReturnType<typeof layout>) => Parameters<typeof compileRuntimeGuardPolicy>[0], RegExp]> = [
    ["写目录越出工作区", (l) => ({ workspaceRoot: l.ws, writeSubPaths: ["../escape"], runtimeWritable: [l.rt], home: l.home }), /越出工作区/],
    ["运行时目录包含工作区（等于把工作区整体放开）", (l) => ({ workspaceRoot: l.ws, writeSubPaths: ["out"], runtimeWritable: [join(l.home, "projects")], home: l.home }), /重叠/],
    ["运行时目录落在工作区里（绕过写授权）", (l) => ({ workspaceRoot: l.ws, writeSubPaths: ["out"], runtimeWritable: [join(l.ws, "src")], home: l.home }), /重叠/],
    ["写根是家目录", (l) => ({ workspaceRoot: l.ws, writeSubPaths: ["out"], runtimeWritable: [l.home], home: l.home }), /家目录|重叠/],
    ["写根是 /", (l) => ({ workspaceRoot: l.ws, writeSubPaths: ["out"], runtimeWritable: ["/"], home: l.home }), /根目录|重叠/],
    ["敏感路径落在写根里（可被整体改名带走）", (l) => ({ workspaceRoot: l.ws, writeSubPaths: ["out"], runtimeWritable: [l.rt], home: l.home, extraProtectedPaths: [join(l.ws, "out", "keys")] }), /敏感路径/]
  ];
  for (const [name, input, message] of cases) {
    it(name, () => {
      const l = layout();
      expect(() => compileRuntimeGuardPolicy(input(l))).toThrowError(message);
    });
  }

  it("整个工作区被授权可写时，写根就是工作区本身（这是授权，不是放大）", () => {
    const l = layout();
    const policy = compileRuntimeGuardPolicy({ workspaceRoot: l.ws, writeSubPaths: ["."], runtimeWritable: [l.rt], home: l.home });
    expect(policy.filesystem.writeScope).toContain(l.ws);
    expect(relative(l.ws, policy.filesystem.writeScope[0]).startsWith("..")).toBe(false);
  });
});
