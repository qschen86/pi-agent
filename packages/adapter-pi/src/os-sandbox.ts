/**
 * OS 级执行边界：macOS Seatbelt 实现（ADR-0801，ADR-0808 修订）。
 *
 * 平台自己的门禁（Policy Gateway + FsSandbox）是第一道防线，管的是"我们不去做"。
 * 这里是第二道：由**内核**拒绝越界，与平台代码是否正确无关——
 * 门禁有 bug、被绕过、或者 Pi 用了我们没想到的系统调用，副作用依然不会发生。
 * 整个 pi 进程树（bash、node、python……）都在同一个边界内。
 *
 * 规则由平台策略 RuntimeGuardPolicy 生成（runtime-guard-policy.ts），本文件只负责翻译成 SBPL。
 * Seatbelt 是 deny-default，**后写的规则覆盖先写的**，顺序即语义：
 *   基线（非文件类）→ 网络 → 读 → 写 → 危险文件 → 敏感项（最后，任何 allow 都盖不住）。
 *
 * 必须知道的坑（均有用例锁住）：
 *   1. 路径必须归一到 realpath（/var → /private/var），不归一的规则等于没写。
 *   2. 覆盖必须同粒度：`allow file-read*` 盖不住 `deny file-read-data`，只有同样针对
 *      file-read-data 的 allow 才能覆盖；少写一条，位于家目录下的运行时资源就读不到。
 *   3. 读授权若改成白名单，dyld 与系统库会缺，进程直接 SIGABRT 起不来——所以读默认放开，
 *      只拒家目录内容。
 *   4. 按文件名保护的敏感项必须**同时禁写**：可写目录里的 .env 能先改名再读（实测）。
 *   5. `(allow mach-lookup)` 不能用通配：实测沙箱内能读剪贴板。改为 SRT 同款白名单。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PlatformError } from "../../domain/src/errors.js";
import type {
  PreparedRuntimeGuard,
  RuntimeGuardPolicy,
  RuntimeGuardPrepareInput,
  RuntimeGuardProvider
} from "@pi-agent/runtime-contracts";
import { DEFAULT_HAZARD_NAMES, DEFAULT_PROTECTED_NAMES, DEFAULT_PROTECTED_PATHS, canonicalPath } from "./runtime-guard-policy.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * 非文件类基线：移植自 Anthropic Sandbox Runtime 0.0.77 的 macOS profile（Apache-2.0）。
 * 与 SRT 保持一致由 packages/runtime-guard-srt 的漂移用例锁住：升级 SRT 时一并核对。
 * 故意**不**放行 lsopen / appleevent-send：否则可以借 Launch Services、Apple Events
 * 让沙箱外的程序替自己执行。
 */
export const SEATBELT_MACH_SERVICES: readonly string[] = Object.freeze([
  "com.apple.audio.systemsoundserver",
  "com.apple.distributed_notifications@Uv3",
  "com.apple.FontObjectsServer",
  "com.apple.fonts",
  "com.apple.logd",
  "com.apple.lsd.mapdb",
  "com.apple.PowerManagement.control",
  "com.apple.system.logger",
  "com.apple.system.notification_center",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.bsd.dirhelper",
  "com.apple.securityd.xpc",
  "com.apple.coreservices.launchservicesd",
  "com.apple.SecurityServer"
]);

export const SEATBELT_SYSCTL_NAMES: readonly string[] = Object.freeze([
  "hw.activecpu", "hw.busfrequency_compat", "hw.byteorder", "hw.cacheconfig", "hw.cachelinesize_compat",
  "hw.cpufamily", "hw.cpufrequency", "hw.cpufrequency_compat", "hw.cputype", "hw.l1dcachesize_compat",
  "hw.l1icachesize_compat", "hw.l2cachesize_compat", "hw.l3cachesize_compat", "hw.logicalcpu",
  "hw.logicalcpu_max", "hw.machine", "hw.memsize", "hw.ncpu", "hw.nperflevels", "hw.packages",
  "hw.pagesize_compat", "hw.pagesize", "hw.physicalcpu", "hw.physicalcpu_max", "hw.tbfrequency_compat",
  "hw.vectorunit", "kern.argmax", "kern.bootargs", "kern.hostname", "kern.maxfiles", "kern.maxfilesperproc",
  "kern.maxproc", "kern.ngroups", "kern.osproductversion", "kern.osrelease", "kern.ostype",
  "kern.osvariant_status", "kern.osversion", "kern.secure_kernel", "kern.tcsm_available", "kern.tcsm_enable",
  "kern.usrstack64", "kern.version", "kern.willshutdown", "machdep.cpu.brand_string", "machdep.ptrauth_enabled",
  "security.mac.lockdown_mode_state", "sysctl.proc_cputype", "vm.loadavg"
]);

export const SEATBELT_SYSCTL_PREFIXES: readonly string[] = Object.freeze([
  "hw.optional.arm", "hw.optional.arm.", "hw.optional.armv8_", "hw.perflevel", "kern.proc.all",
  "kern.proc.pgrp.", "kern.proc.pid.", "machdep.cpu.", "net.routetable."
]);

/** 运行期必须可写的设备节点（stdio 等）。 */
const SYSTEM_WRITE_LITERALS = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/dtracehelper", "/dev/autofs_nowait"];

const str = (s: string): string => JSON.stringify(s);
const subpath = (p: string): string => `(subpath ${str(p)})`;
const literal = (p: string): string => `(literal ${str(p)})`;

/**
 * 文件名模式 → SBPL 正则：任意深度、覆盖该名字本身及其下所有内容。
 * 字母按大小写两种写法匹配——APFS 默认不区分大小写，新建 `.GIT/hooks` 对 git 来说就是 `.git/hooks`。
 * `*` 匹配一个路径段内的任意字符。
 */
export function nameRegex(pattern: string): string {
  const body = [...pattern]
    .map((ch) => {
      if (ch === "*") return "[^/]*";
      if (/[a-zA-Z]/.test(ch)) return `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
      if (/[.^$+?()[\]{}|\\]/.test(ch)) return `\\${ch}`;
      return ch;
    })
    .join("");
  return `(regex #"/${body}(/|$)")`;
}

function baselineRules(): string[] {
  return [
    ";; ── 基线（非文件类）：移植自 Anthropic Sandbox Runtime 0.0.77（Apache-2.0）──",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
    // 能给自己派生的子进程发信号：否则 pi 的 bash 工具超时后杀不掉卡住的命令（实测）
    "(allow signal (target same-sandbox))",
    "(allow mach-priv-task-port (target same-sandbox))",
    "(allow user-preference-read)",
    ";; 系统服务只放行白名单（不用通配：通配时沙箱内能读剪贴板）",
    `(allow mach-lookup ${SEATBELT_MACH_SERVICES.map((n) => `(global-name ${str(n)})`).join(" ")})`,
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    '(allow iokit-open (iokit-registry-entry-class "IOSurfaceRootUserClient") (iokit-registry-entry-class "RootDomainUserClient") (iokit-user-client-class "IOSurfaceSendRight"))',
    "(allow iokit-get-properties)",
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    `(allow sysctl-read ${[
      ...SEATBELT_SYSCTL_NAMES.map((n) => `(sysctl-name ${str(n)})`),
      ...SEATBELT_SYSCTL_PREFIXES.map((n) => `(sysctl-name-prefix ${str(n)})`)
    ].join(" ")})`,
    '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
    "(allow distributed-notification-post)",
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper") (literal "/dev/tty"))',
    '(allow file-ioctl file-read-data file-write-data (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))'
  ];
}

/** 由平台策略生成 Seatbelt profile。输入变了 profile 就变——边界来自授权，不是写死的常量。 */
export function buildSeatbeltProfile(policy: RuntimeGuardPolicy): string {
  const fsPolicy = policy.filesystem;
  const lines = [
    "(version 1)",
    ";; Runtime Guard（ADR-0808）· seatbelt · 由 BindingPlan 与本轮运行时目录派生",
    ";; deny default：没有显式 allow 的一切都被拒绝",
    "(deny default)",
    "",
    ...baselineRules(),
    "",
    policy.network.mode === "unrestricted"
      ? ";; ── 网络：本期保持原样，整体放行（模型调用、npm、git 都走它）──\n(allow network*)"
      : ";; ── 网络：拒绝 ──\n(deny network*)",
    "",
    ";; ── 读：默认放开（系统库与工具链要能加载）──",
    "(allow file-read*)"
  ];
  if (fsPolicy.denyReadRegions.length > 0) {
    lines.push(
      ";; 私有区域（默认：家目录）内容拒读。只拒内容（file-read-data）不拒元数据，否则连路径穿越都做不到",
      `(deny file-read-data ${fsPolicy.denyReadRegions.map(subpath).join(" ")})`
    );
  }
  if (fsPolicy.allowReadWithin.length > 0) {
    const roots = fsPolicy.allowReadWithin.map(subpath).join(" ");
    lines.push(
      ";; 重新放行：本会话的工作区与运行时必需目录（同粒度覆盖，见文件头）",
      `(allow file-read* ${roots})`,
      `(allow file-read-data ${roots})`
    );
  }
  lines.push(
    "",
    ";; ── 写：默认拒绝；只放行授权写目录与本轮运行时目录 ──",
    `(allow file-write* ${[...fsPolicy.writeScope.map(subpath), ...SYSTEM_WRITE_LITERALS.map(literal)].join(" ")})`
  );
  if (fsPolicy.hazardNames.length > 0) {
    lines.push(
      "",
      ";; ── 危险文件：写目录里也不许写（会在沙箱外被执行的钩子与配置）──",
      `(deny file-write* ${fsPolicy.hazardNames.map(nameRegex).join(" ")})`
    );
  }
  const protectedFilters = [...fsPolicy.protectedPaths.map(subpath), ...fsPolicy.protectedNames.map(nameRegex)];
  if (protectedFilters.length > 0) {
    lines.push(
      "",
      ";; ── 敏感项：最后写，上面任何 allow 都盖不住。连写也禁：否则可以先改名再读 ──",
      `(deny file-read-data ${protectedFilters.join(" ")})`,
      `(deny file-write* ${protectedFilters.join(" ")})`
    );
  }
  return lines.join("\n") + "\n";
}

/** 本机是否具备 Seatbelt。不可用时调用方必须显式处理，不得静默降级。 */
export function osSandboxAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  return existsSync(SANDBOX_EXEC);
}

/** 把命令包进 Seatbelt：返回新的 argv。 */
export function wrapWithOsSandbox(profilePath: string, command: string, args: string[]): string[] {
  return [SANDBOX_EXEC, "-f", profilePath, command, ...args];
}

/** macOS Seatbelt 实现（默认）。 */
export class SeatbeltRuntimeGuard implements RuntimeGuardProvider {
  readonly name = "seatbelt";

  /** Host-selected certificate validation services; ordinary baseline stays unchanged. */
  constructor(private readonly options: { systemTrust?: boolean; chromium?: boolean } = {}) {}

  available(): boolean {
    return osSandboxAvailable();
  }

  async prepare(input: RuntimeGuardPrepareInput): Promise<PreparedRuntimeGuard> {
    if (!this.available()) {
      throw new PlatformError("RUNTIME_UNSUPPORTED", "本机没有 Seatbelt（仅 macOS 的 /usr/bin/sandbox-exec），拒绝以无边界方式运行");
    }
    mkdirSync(input.guardDir, { recursive: true });
    // profile 放在所有写根之外：Agent 看得到它，改不了它
    const profilePath = join(input.guardDir, "sandbox.sb");
    writeFileSync(profilePath, buildSeatbeltProfile(input.policy) + (this.options.systemTrust ? '\n;; Certificate trust evaluation only; no general Mach access\n(allow mach-lookup (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent"))\n' : "") + (this.options.chromium ? '\n;; Host-approved browser capability only; no generic Mach registration/lookup\n(allow sysctl-read (sysctl-name "kern.hv_vmm_present"))\n(allow mach-register (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer.") (global-name-prefix "com.google.chrome.for.testing.MachPortRendezvousServer."))\n(allow mach-lookup (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer.") (global-name-prefix "com.google.chrome.for.testing.MachPortRendezvousServer."))\n' : ""), "utf8");
    return {
      provider: this.name,
      artifactPath: profilePath,
      wrap: async (command, args) => {
        const [bin, ...rest] = wrapWithOsSandbox(profilePath, command, args);
        return { command: bin, args: rest };
      },
      dispose: async () => {}
    };
  }
}

/* ------------------------------------------------------------------ */
/* 兼容入口：ADR-0801 时期的直接参数形式（单测与诊断脚本在用）。          */
/* ------------------------------------------------------------------ */

export interface SandboxProfileInput {
  /** 工作区在磁盘上的根目录（内部会归一到 realpath） */
  workspaceRoot: string;
  /** 工作区内允许写入的子路径（相对工作区根），如 ["out"]；空数组表示无写授权 */
  writeSubPaths: string[];
  /** 是否允许出网 */
  allowNetwork: boolean;
  /** 运行时自身所需的额外只读路径 */
  readOnlyExtras?: string[];
  /** 内核级拒读的私有区域 */
  denyReadPaths?: string[];
  /** 本次运行专用的可写临时目录 */
  runtimeTempDir?: string;
  /** 运行时自有的其他可写目录 */
  writeExtras?: string[];
}

/** 兼容入口：把直接参数映射到平台策略，再生成同一份 profile（不做编译期重叠校验）。 */
export function buildSandboxProfile(input: SandboxProfileInput): string {
  const home = homedir();
  const canon = (p: string): string => canonicalPath(p, { home });
  const root = canon(input.workspaceRoot);
  const writeRoots = input.writeSubPaths.map((sub) =>
    sub === "" || sub === "." ? root : canonicalPath(sub.replace(/^\/+/, ""), { home, base: root })
  );
  return buildSeatbeltProfile({
    version: 1,
    filesystem: {
      defaultRead: "allow",
      denyReadRegions: (input.denyReadPaths ?? []).map(canon),
      allowReadWithin: [root, ...(input.readOnlyExtras ?? []).map(canon)],
      defaultWrite: "deny",
      writeScope: [
        ...(input.runtimeTempDir ? [canon(input.runtimeTempDir)] : []),
        ...(input.writeExtras ?? []).map(canon),
        ...writeRoots
      ],
      hazardNames: [...DEFAULT_HAZARD_NAMES],
      protectedPaths: DEFAULT_PROTECTED_PATHS.map(canon),
      protectedNames: [...DEFAULT_PROTECTED_NAMES]
    },
    network: { mode: input.allowNetwork ? "unrestricted" : "deny" }
  });
}
