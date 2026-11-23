import type { RuntimeKind } from "./types.js";

export type PermissionMode = "read-only" | "ask" | "auto-review" | "full-access" | "default" | "acceptEdits" | "auto" | "plan" | "bypassPermissions" | "pi-read-only" | "pi-ask" | "pi-native";
export interface PermissionOption { id: PermissionMode; label: string; detail: string }

const CODEX: PermissionOption[] = [
  { id: "read-only", label: "只读", detail: "Codex 只读沙箱：可读取文件、运行只读命令，不能写入工作区；不发起审批，越权操作直接失败。" },
  { id: "ask", label: "Ask for approval", detail: "可读写工作区并运行本地命令；需要越界或联网时由你审批。" },
  { id: "auto-review", label: "Approve for me", detail: "保留工作区沙箱；符合条件的审批请求交给 Codex 原生审核代理，其他请求仍可能需要你确认。" },
  { id: "full-access", label: "Full access", detail: "关闭文件与网络沙箱，执行时不询问审批。" }
];
const CLAUDE: PermissionOption[] = [
  { id: "default", label: "默认审批", detail: "沿用用户和项目的允许、拒绝规则；需要询问的工具由你审批。" },
  { id: "acceptEdits", label: "自动允许编辑", detail: "Claude 自动允许文件编辑；其他工具仍按原生规则审批。" },
  { id: "plan", label: "计划模式", detail: "使用 Claude 原生 plan 模式，先分析与规划。" },
  { id: "bypassPermissions", label: "Full access", detail: "跳过 Claude 工具权限询问；执行时不向你请求工具审批。" }
];
/** Antigravity ACP 的会话模式：default / accept-edits / auto / plan，以及独立免审批进程（bypassPermissions） */
const ANTIGRAVITY: PermissionOption[] = [
  { id: "default", label: "默认审批", detail: "写文件和运行命令前由你审批；读取与搜索直接执行。" },
  { id: "acceptEdits", label: "自动允许编辑", detail: "工作区内的文件编辑自动通过；运行命令等其他动作仍由你审批。" },
  { id: "auto", label: "自动审批", detail: "自动允许工作区编辑与常规安全命令；高风险或不可逆操作仍由你审批。" },
  { id: "plan", label: "计划模式", detail: "使用 Antigravity 原生 plan 模式，先分析与规划，不直接执行。" },
  { id: "bypassPermissions", label: "Full access", detail: "使用独立免审批 ACP 进程跳过 Antigravity 工具权限询问；执行时不向你请求工具审批。" }
];
const PI: PermissionOption[] = [
  { id: "pi-read-only", label: "只读", detail: "仅提供读取和搜索工具；禁用写入、编辑与命令工具。文件沙箱禁止工作区写入并保护宿主私有目录与敏感文件；模型联网保持可用。" },
  { id: "pi-ask", label: "工作区沙盒", detail: "常规读取、工作区内编辑、构建、测试与浏览器工具直接执行；删除、危险命令与扩大权限时审批。保留工作区文件沙盒：沙盒本来就会拒绝的操作（读家目录、写工作区外）直接拒绝，不再弹授权；Git 写入与浏览器测试可申请单次扩大权限，不继承会话授权；模型联网保持可用。" },
  { id: "pi-native", label: "原生工具权限", detail: "工具执行不询问，使用本机原生权限；不提供受限文件沙箱。" }
];
export function defaultPermissionMode(kind: RuntimeKind): PermissionMode { return kind === "codex" ? "ask" : kind === "pi" ? "pi-native" : kind === "antigravity" ? "auto" : "default"; }
/** Legacy dedicated contexts retain their guarded default. */
export function effectivePermissionMode(context: { runtimeKind: RuntimeKind; permissionMode?: PermissionMode; evaluation?: unknown; projectRef?: unknown; role?: unknown; comparisonRef?: unknown; roomRef?: unknown }): PermissionMode {
  const protectedPi = context.runtimeKind === "pi" && (context.evaluation || context.projectRef || context.role || context.comparisonRef || context.roomRef);
  if (context.permissionMode) return context.permissionMode;
  if (protectedPi) return "pi-ask";
  if (context.runtimeKind === "antigravity" && context.evaluation) return "default";
  return defaultPermissionMode(context.runtimeKind);
}
/**
 * 对比模式（首期）各运行时的只读权限：多条通道共用同一工作目录，只读才不会互相覆盖。
 * Claude 用原生 plan 模式（编辑与命令不执行；退出计划要经平台审批）。
 */
export function readOnlyPermissionMode(kind: RuntimeKind): PermissionMode { return kind === "codex" ? "read-only" : kind === "pi" ? "pi-read-only" : "plan"; }
/**
 * worktree 隔离下各运行时可选的权限：保留工作区边界的模式（含只读）；
 * Full access / bypassPermissions / Pi 原生工具权限能写到 worktree 之外（包括原仓库），不允许。
 */
export const COMPARE_WORKTREE_PERMISSION_MODES: Record<RuntimeKind, PermissionMode[]> = {
  codex: ["read-only", "ask", "auto-review"], "claude-code": ["plan", "default", "acceptEdits"], pi: ["pi-read-only", "pi-ask"], antigravity: ["plan", "default", "acceptEdits", "auto"]
};
export function permissionOptions(kind: RuntimeKind): PermissionOption[] { return kind === "codex" ? CODEX : kind === "pi" ? PI : kind === "antigravity" ? ANTIGRAVITY : CLAUDE; }
export function permissionOption(kind: RuntimeKind, mode: string): PermissionOption | undefined { return permissionOptions(kind).find((p) => p.id === mode); }
export function codexPermissions(mode: string = "ask") {
  if (!permissionOption("codex", mode)) throw new Error(`不支持的 Codex 权限模式：${mode}`);
  return {
    sandbox: mode === "full-access" ? "danger-full-access" as const : mode === "read-only" ? "read-only" as const : "workspace-write" as const,
    approvalPolicy: mode === "full-access" || mode === "read-only" ? "never" as const : "on-request" as const,
    approvalsReviewer: mode === "auto-review" ? "auto_review" as const : "user" as const
  };
}
