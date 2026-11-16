/**
 * Runtime Guard：执行边界的平台端口（ADR-0808）。
 *
 * 平台只定义「允许写哪里、哪些东西不可读」，由可替换的实现编译成 OS 级硬边界
 * （macOS Seatbelt、Anthropic Sandbox Runtime……），整个运行时进程树都在边界内。
 * 这里只有平台自己的概念：不出现 SandboxManager、sandbox-exec、bubblewrap。
 *
 * 与 Policy Gateway 的分工：Gateway 回答「按契约该不该做」（授权、审批、审计、证据），
 * Runtime Guard 回答「就算进程硬要越权，OS 让不让它成功」。两层只能取交集，不能互相放大。
 */

export interface RuntimeGuardPolicy {
  version: 1;
  filesystem: {
    /** 读默认放开（系统库、工具链要能加载）…… */
    defaultRead: "allow";
    /** ……但这些区域的内容拒读（默认：家目录）。路径已归一到 realpath */
    denyReadRegions: string[];
    /** 拒读区域里重新放行读取的根：本会话的工作区、运行时自身必需的目录 */
    allowReadWithin: string[];
    /** 写默认拒绝…… */
    defaultWrite: "deny";
    /**
     * ……只有这些根可写（整个进程树、所有写路径：创建、覆盖、追加、截断、改名、chmod、删除）。
     * 由 BindingPlan 授权的写目录 + 本轮运行时目录组成，不含整个工作区、不含 ~/.pi。
     */
    writeScope: string[];
    /**
     * 写根里也不许写的「危险文件」（按名称匹配，任意深度）：
     * 会在沙箱**外**被执行的钩子与配置，如 .git/hooks、shell 启动脚本。
     * 否则 Agent 可以埋一个钩子，等人之后在沙箱外操作时触发。
     */
    hazardNames: string[];
    /** 敏感路径：任何区域都不可读，也不可改名、删除、覆盖 */
    protectedPaths: string[];
    /** 敏感文件名（任意深度，如 .env、.env.*）：同上 */
    protectedNames: string[];
  };
  /**
   * 网络：本期保持原样（整体放行），不借文件边界顺便收紧。
   * deny 只供兼容入口与不需要出网的受限命令使用——pi 必须出网调用模型。
   */
  network: { mode: "unrestricted" | "deny" };
}

export interface RuntimeGuardPrepareInput {
  policy: RuntimeGuardPolicy;
  /** 边界实现自己的工作目录（放 profile 等）。在所有写根之外，Agent 改不了它 */
  guardDir: string;
  /** 本轮临时目录（TMPDIR），在写根之内 */
  runtimeTmp: string;
}

/** 一次运行的边界：把命令包进去，用完释放。 */
export interface PreparedRuntimeGuard {
  readonly provider: string;
  /** 审计用：生效边界落在哪里（Seatbelt profile 路径 / SRT 配置路径） */
  readonly artifactPath?: string;
  wrap(command: string, args: string[]): Promise<{ command: string; args: string[]; env?: Record<string, string> }>;
  dispose(): Promise<void>;
}

/** 可替换的边界实现。上层只依赖这个接口。 */
export interface RuntimeGuardProvider {
  readonly name: string;
  /** 本机能否提供该边界。不能时调用方必须拒绝启动，或显式进入 unsafe 模式——不得静默降级 */
  available(): boolean;
  prepare(input: RuntimeGuardPrepareInput): Promise<PreparedRuntimeGuard>;
}
