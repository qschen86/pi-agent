/**
 * W8 · 执行边界：OS 级沙箱（AP-PLAN-009 §10 W8「执行边界」/ §11 G8 安全）。
 *
 * 此前的边界全部由平台自己的门禁强制（Policy Gateway + FsSandbox 路径判定）。
 * 那是"我们不去做"，不是"做不到"——门禁有 bug 或被绕过，副作用就真的发生了。
 * W8 加的是第二道防线：由**内核**拒绝越界，与平台代码是否正确无关。
 *
 * 实现基座：macOS Seatbelt（`sandbox-exec`）。用 `/bin/sh` 直接验证边界本身，
 * 不依赖模型，快且确定。
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxProfile, osSandboxAvailable, wrapWithOsSandbox } from "@pi-agent/adapter-pi";

const AVAILABLE = osSandboxAvailable();

/** 在 OS 沙箱里跑一条 shell 命令，返回 { ok, output }。 */
function runSandboxed(profilePath: string, script: string): { ok: boolean; output: string } {
  const [cmd, ...args] = wrapWithOsSandbox(profilePath, "/bin/sh", ["-c", script]);
  try {
    const output = execFileSync(cmd, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

interface Fixture {
  workspace: string;
  outsideFile: string;
  profilePath: string;
  runtimeTemp: string;
}

function fixture(): Fixture {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "w8-ws-")));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "w8-outside-")));
  const outsideFile = join(outsideDir, "secret.txt");
  writeFileSync(outsideFile, "TOP SECRET", "utf8");
  writeFileSync(join(workspace, "input.md"), "工作区内的文件", "utf8");

  const runtimeTemp = realpathSync(mkdtempSync(join(tmpdir(), "w8-rt-")));
  const profilePath = join(realpathSync(mkdtempSync(join(tmpdir(), "w8-prof-"))), "profile.sb");
  writeFileSync(
    profilePath,
    buildSandboxProfile({
      workspaceRoot: workspace,
      writeSubPaths: ["out"],
      allowNetwork: false,
      runtimeTempDir: runtimeTemp,
      // 私有区域内核级拒读：模拟用户家目录里与任务无关的部分
      denyReadPaths: [outsideDir]
    }),
    "utf8"
  );
  return { workspace, outsideFile, profilePath, runtimeTemp };
}

describe.skipIf(!AVAILABLE)("W8 OS 级执行边界（内核强制）", () => {
  it("写授权目录内：允许", () => {
    const f = fixture();
    const r = runSandboxed(f.profilePath, `mkdir -p ${f.workspace}/out && echo ok > ${f.workspace}/out/a.txt`);
    expect(r.ok, r.output).toBe(true);
    expect(readFileSync(join(f.workspace, "out/a.txt"), "utf8").trim()).toBe("ok");
  });

  it("工作区内但写授权之外（源码目录）：被内核拒绝", () => {
    const f = fixture();
    const r = runSandboxed(f.profilePath, `echo pwned > ${f.workspace}/src.txt`);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not permitted|Operation not permitted/i);
    expect(existsSync(join(f.workspace, "src.txt"))).toBe(false);
  });

  it("工作区之外的写：被内核拒绝", () => {
    const f = fixture();
    const r = runSandboxed(f.profilePath, `echo pwned > ${f.outsideFile}`);
    expect(r.ok).toBe(false);
    expect(readFileSync(f.outsideFile, "utf8")).toBe("TOP SECRET");
  });

  it("被列为私有区域的路径：内核级拒读（平台门禁失效也读不到）", () => {
    const f = fixture();
    const r = runSandboxed(f.profilePath, `cat ${f.outsideFile}`);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not permitted/i);
    expect(r.output).not.toContain("TOP SECRET");
  });

  it("路径归一：传 /var/... 与 /private/var/... 生成等价边界（符号链接不是绕过口）", () => {
    const f = fixture();
    // 工作区用未归一的 /var 前缀重新生成 profile，边界必须一样成立
    const unresolved = f.workspace.replace("/private/var/", "/var/");
    const p2 = join(realpathSync(mkdtempSync(join(tmpdir(), "w8-prof3-"))), "p.sb");
    writeFileSync(p2, buildSandboxProfile({
      workspaceRoot: unresolved, writeSubPaths: ["out"], allowNetwork: false, denyReadPaths: []
    }), "utf8");
    expect(runSandboxed(p2, `mkdir -p ${f.workspace}/out && echo ok > ${f.workspace}/out/b.txt`).ok).toBe(true);
    expect(runSandboxed(p2, `echo bad > ${f.workspace}/root.txt`).ok).toBe(false);
  });

  it("工作区内的读：允许（边界不是一律拒绝）", () => {
    const f = fixture();
    const r = runSandboxed(f.profilePath, `cat ${f.workspace}/input.md`);
    expect(r.ok, r.output).toBe(true);
    expect(r.output).toContain("工作区内的文件");
  });

  it("本次运行的临时目录可写，但别的临时目录不可写（不笼统放行系统临时区）", () => {
    const f = fixture();
    expect(runSandboxed(f.profilePath, `echo ok > ${f.runtimeTemp}/scratch.txt`).ok).toBe(true);
    const otherTemp = realpathSync(mkdtempSync(join(tmpdir(), "w8-other-")));
    expect(runSandboxed(f.profilePath, `echo bad > ${otherTemp}/x.txt`).ok).toBe(false);
  });

  it("allowNetwork=false 时出网被拒绝", () => {
    const f = fixture();
    const r = runSandboxed(f.profilePath, `curl -s -m 5 https://example.com`);
    expect(r.ok).toBe(false);
  });

  it("profile 由授权派生：写子路径变了，允许的目录随之改变", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "w8-ws2-")));
    const profilePath = join(realpathSync(mkdtempSync(join(tmpdir(), "w8-prof2-"))), "p.sb");
    writeFileSync(profilePath, buildSandboxProfile({
      workspaceRoot: workspace, writeSubPaths: ["reports"], allowNetwork: false
    }), "utf8");

    expect(runSandboxed(profilePath, `mkdir -p ${workspace}/reports && echo ok > ${workspace}/reports/r.md`).ok).toBe(true);
    expect(runSandboxed(profilePath, `mkdir -p ${workspace}/out && echo no > ${workspace}/out/x.md`).ok).toBe(false);
  });
});

describe("W8 OS 沙箱可用性探测", () => {
  it("在 macOS 上应当可用；不可用时必须能被显式查询到（不静默降级）", () => {
    expect(typeof osSandboxAvailable()).toBe("boolean");
    if (process.platform === "darwin") expect(AVAILABLE).toBe(true);
  });
});
