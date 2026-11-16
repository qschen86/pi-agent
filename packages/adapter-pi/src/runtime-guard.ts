/**
 * 启动自检（ADR-0808）：每次启动 pi 之前，用**合成探针**实测这一轮的边界确实生效，
 * 不生效就拒绝启动（fail closed）。与具体实现无关：探针走的是和 pi 完全相同的 wrap。
 *
 * 修复前的自检去读 ~/.ssh/config，读失败就当"边界生效"——可读失败也可能只是文件不存在
 * （本机就没有这个文件），沙箱完全失效也照样通过；而且只测拒读、不测拒写。
 *
 * 现在每一项都有正反对照：
 *   - 正向：本轮临时目录可写、普通文件可读——证明探针真的在边界内跑起来了，
 *     而不是包装本身坏了、什么都执行失败；
 *   - 反向：敏感文件不可读也不可改名、危险文件不可写、边界外不可写、家目录不可列；
 *   - 宿主侧核对：写进去的字节真的在，边界外真的没有多出文件，敏感文件没被挪走。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { PreparedRuntimeGuard, RuntimeGuardPolicy } from "@pi-agent/runtime-contracts";

export type ProbeResult = "ok" | "denied";

export interface GuardSelfCheck {
  passed: boolean;
  results: Record<string, ProbeResult>;
  failures: string[];
}

/** 每个探针的期望结果。 */
export const GUARD_PROBE_EXPECTATIONS: Readonly<Record<string, ProbeResult>> = Object.freeze({
  write_inside: "ok",
  read_plain: "ok",
  read_protected: "denied",
  rename_protected: "denied",
  write_hazard: "denied",
  write_outside: "denied",
  list_home: "denied"
});

const PROBE_SCRIPT = [
  'p() { if ( eval "$2" ) >/dev/null 2>&1; then echo "$1=ok"; else echo "$1=denied"; fi; }',
  `p write_inside 'printf probe > "$P/written"'`,
  `p read_plain 'cat "$P/plain"'`,
  `p read_protected 'cat "$P/.env"'`,
  `p rename_protected 'mv "$P/.env" "$P/moved"'`,
  `p write_hazard 'mkdir -p "$P/.git/hooks" && printf x > "$P/.git/hooks/pre-commit"'`,
  `p write_outside 'printf x > "$O/escaped"'`,
  `p list_home 'ls "$H"'`
].join("\n");

export async function verifyRuntimeGuard(
  prepared: PreparedRuntimeGuard,
  input: { policy: RuntimeGuardPolicy; runtimeTmp: string; guardDir: string }
): Promise<GuardSelfCheck> {
  const probe = join(input.runtimeTmp, `.guard-probe-${randomBytes(4).toString("hex")}`);
  const outside = join(input.guardDir, "outside");
  mkdirSync(probe, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(probe, ".env"), "PROBE_SECRET=1\n");
  writeFileSync(join(probe, "plain"), "plain\n");

  const home = input.policy.filesystem.denyReadRegions[0];
  // 宿主自己都列不出家目录时（极少见），这一项证明不了什么，跳过而不是算通过
  const homeProbe = home !== undefined && canList(home);

  try {
    const wrapped = await prepared.wrap("/bin/sh", ["-c", PROBE_SCRIPT]);
    const run = spawnSync(wrapped.command, wrapped.args, {
      env: { PATH: "/usr/bin:/bin", P: probe, O: outside, H: home ?? "/nonexistent", ...wrapped.env },
      encoding: "utf8",
      timeout: 15_000
    });
    const results: Record<string, ProbeResult> = {};
    for (const line of (run.stdout ?? "").split("\n")) {
      const m = /^([a-z_]+)=(ok|denied)$/.exec(line.trim());
      if (m) results[m[1]] = m[2] as ProbeResult;
    }
    const failures: string[] = [];
    for (const [name, expected] of Object.entries(GUARD_PROBE_EXPECTATIONS)) {
      if (name === "list_home" && !homeProbe) continue;
      const actual = results[name];
      if (actual !== expected) failures.push(`${name}=${actual ?? "未执行"}（应为 ${expected}）`);
    }
    // 宿主侧核对：只看探针自己说的不够
    if (results["write_inside"] === "ok" && readFileOr(join(probe, "written")) !== "probe") {
      failures.push("write_inside 报告成功，但宿主侧看不到写入的字节");
    }
    if (existsSync(join(outside, "escaped"))) failures.push("边界外出现了探针写入的文件");
    if (!existsSync(join(probe, ".env"))) failures.push("敏感文件被挪走了");
    if (run.error) failures.push(`探针无法运行：${run.error.message}`);
    return { passed: failures.length === 0, results, failures };
  } finally {
    rmSync(probe, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

function canList(dir: string): boolean {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

function readFileOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
