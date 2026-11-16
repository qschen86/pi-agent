/**
 * Runtime Guard 策略编译（ADR-0808）：由 BindingPlan 的写授权与本轮运行时目录，
 * 编译出平台自己的边界模型 RuntimeGuardPolicy，再交给可替换的实现（Seatbelt / SRT）。
 *
 * 口径（与 ADR-0801 一致，并按 SRT 升级评审修正）：
 *   - 读：默认放开（系统库、工具链要能加载），但**家目录内容默认拒读**，
 *     只放行本会话的工作区与运行时必需目录。不再放行整个仓库——
 *     控制台所有会话的数据都在仓库的 .pi-agent/ 下，放行仓库等于会话之间互相可读。
 *   - 写：默认拒绝，只有「授权写目录 + 本轮运行时目录」可写。
 *     不放大到整个工作区（那会比契约授权更宽，违反"只取交集"），也不再包含 ~/.pi：
 *     那里的 settings.json 能让 pi 加载扩展，Agent 改了它，你下次在沙箱外用 pi 时就会执行。
 *   - 敏感项与危险文件：任何区域都不可读 / 不可写（清单只能追加，不能删减）。
 *   - 网络：本期保持原样。
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PlatformError } from "../../domain/src/errors.js";
import type { RuntimeGuardPolicy } from "@pi-agent/runtime-contracts";

/**
 * 默认敏感路径：原升级文档的清单，加上评审时在本机核实存在、却不在清单里的几项。
 * 它们大多已在家目录拒读的范围内；单列出来是为了在任何放行规则之后仍然成立
 * （例如工作区恰好覆盖了它们），并且连改名、覆盖也一并禁止。
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = Object.freeze([
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.git-credentials",
  "~/.netrc",
  "~/.npmrc",
  "~/.config/gh",
  "~/.docker/config.json",
  "~/.kube",
  "~/.pi/agent/auth.json",
  "~/.pi/agent/models.json",
  "~/.pi/agent/sessions"
]);

/** 默认敏感文件名（任意深度）。 */
export const DEFAULT_PROTECTED_NAMES: readonly string[] = Object.freeze([".env", ".env.*"]);

/**
 * 危险文件（写根里也不许写，任意深度）：会在沙箱外被执行或加载的钩子与配置。
 * 清单取自 Anthropic Sandbox Runtime 0.0.77 的 mandatory deny（Apache-2.0）。
 */
export const DEFAULT_HAZARD_NAMES: readonly string[] = Object.freeze([
  ".git/hooks",
  ".git/config",
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".vscode",
  ".idea",
  ".claude/commands",
  ".claude/agents"
]);

export interface CanonicalOptions {
  /** 展开 ~ 用的家目录（默认 os.homedir()） */
  home?: string;
  /** 相对路径的基准目录（默认 process.cwd()） */
  base?: string;
}

/**
 * 归一路径：展开 ~、按基准解析相对路径、消掉 . 与 ..，再按**最近的已存在祖先**取 realpath。
 * 内核按 realpath 匹配（/var → /private/var），不归一的规则等于没写；
 * 尚不存在的尾部（例如还没创建的写目录）按字面接在归一后的祖先之后。
 */
export function canonicalPath(input: string, options: CanonicalOptions = {}): string {
  if (input.includes("\u0000")) throw new PlatformError("POLICY_FAIL_CLOSED", `非法路径（含 NUL）：${JSON.stringify(input)}`);
  const home = options.home ?? homedir();
  const expanded = input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(options.base ?? process.cwd(), expanded);
  let probe = absolute;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return absolute;
    tail.unshift(probe.slice(parent.length).replace(/^\/+/, ""));
    probe = parent;
  }
  const real = realpathSync(probe);
  return tail.length > 0 ? join(real, ...tail) : real;
}

/** a 是否等于 b 或位于 b 之内（均为归一后的绝对路径）。 */
export function isWithin(a: string, b: string): boolean {
  if (a === b) return true;
  const rel = relative(b, a);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface RuntimeGuardPolicyInput {
  /** 工作区在磁盘上的根目录 */
  workspaceRoot: string;
  /** BindingPlan 授权的写目录（相对工作区根，如 ["out"]；"" 或 "." 表示整个工作区） */
  writeSubPaths: string[];
  /** 本轮运行时可写目录（审计目录、临时目录、pi 的独立状态目录）：必须在工作区之外 */
  runtimeWritable: string[];
  /** 运行时自身需要读取、但位于拒读区域里的目录（门禁扩展代码、pi 的工具二进制等） */
  runtimeReadable?: string[];
  /** 家目录（默认 os.homedir()）：内容默认拒读 */
  home?: string;
  /** 在默认清单之上追加的敏感路径 / 文件名 */
  extraProtectedPaths?: string[];
  extraProtectedNames?: string[];
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

export function compileRuntimeGuardPolicy(input: RuntimeGuardPolicyInput): RuntimeGuardPolicy {
  const home = canonicalPath(input.home ?? homedir());
  const canon = (p: string): string => canonicalPath(p, { home });
  const root = canon(input.workspaceRoot);

  const writeRoots = input.writeSubPaths.map((sub) => {
    const target = sub === "" || sub === "." ? root : canonicalPath(sub.replace(/^\/+/, ""), { home, base: root });
    if (!isWithin(target, root)) {
      throw new PlatformError("POLICY_FAIL_CLOSED", `写授权越出工作区：${sub}`);
    }
    return target;
  });

  const runtimeWritable = input.runtimeWritable.map(canon);
  for (const dir of runtimeWritable) {
    // 运行时目录包含工作区 = 把工作区整体放开；落在工作区里 = 绕过写授权。两种都不行。
    if (isWithin(root, dir) || isWithin(dir, root)) {
      throw new PlatformError("POLICY_FAIL_CLOSED", `运行时可写目录与工作区重叠：${dir}（工作区 ${root}）`);
    }
  }

  const writeScope = unique([...writeRoots, ...runtimeWritable]);
  for (const w of writeScope) {
    if (w === sep) throw new PlatformError("POLICY_FAIL_CLOSED", "写根不能是根目录");
    if (isWithin(home, w)) throw new PlatformError("POLICY_FAIL_CLOSED", `写根不能是家目录或其上级：${w}`);
  }

  const protectedPaths = unique([...DEFAULT_PROTECTED_PATHS, ...(input.extraProtectedPaths ?? [])].map(canon));
  for (const p of protectedPaths) {
    // 敏感路径若落在写根里，整个目录可以被改名挪走、换个名字再读——拒读形同虚设
    const owner = writeScope.find((w) => isWithin(p, w));
    if (owner) throw new PlatformError("POLICY_FAIL_CLOSED", `敏感路径位于可写目录之内：${p}（写根 ${owner}）`);
  }

  return {
    version: 1,
    filesystem: {
      defaultRead: "allow",
      denyReadRegions: [home],
      // 写根本身也要可读：它们若位于拒读区域里（例如工作区在家目录下），不放行就读不回自己写的东西
      allowReadWithin: unique([root, ...runtimeWritable, ...(input.runtimeReadable ?? []).map(canon)]),
      defaultWrite: "deny",
      writeScope,
      hazardNames: [...DEFAULT_HAZARD_NAMES],
      protectedPaths,
      protectedNames: unique([...DEFAULT_PROTECTED_NAMES, ...(input.extraProtectedNames ?? [])])
    },
    network: { mode: "unrestricted" }
  };
}
