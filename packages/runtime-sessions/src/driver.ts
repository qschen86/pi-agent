import type { PermissionMode, PermissionOption } from "./permissions.js";
/**
 * runtime 驱动端口：管理器只依赖这个接口，Codex / Claude 各自实现；测试用替身实现。
 *
 * 驱动负责协议细节与原生→标准事件的投影；平台状态、幂等、租约、审批时效、持久化都在管理器里。
 */
import type { Capability, CapabilityName, ModelOption, ProfileState, ProjectedEvent, RateLimitSnapshot, RuntimeKind, SessionStatus, TurnStatus, UsageRecord } from "./types.js";

export type DriverEvent = Omit<ProjectedEvent, "seq" | "recordedAt" | "turnNo">;

export interface DriverApproval {
  nativeRequestId: string;
  nativeTurnId?: string;
  kind: "command" | "file-change" | "permissions" | "tool" | "question";
  title: string;
  /** kind=question 必填：平台渲染成选项面板，答案经 ApprovalDecision.answers 回来 */
  questions?: import("./types.js").QuestionItem[];
  action: string;
  scope: string;
  source: string;
  /** This permission expansion always requires a single human decision, even with a session grant. */
  requiresExplicitApproval?: boolean;
  /** Runtime-owned scoped session decision; never creates a platform-wide grant. */
  runtimeSessionScope?: string;
  /** 用于参数摘要（答复须绑定） */
  params: unknown;
}
/** kind=question 时 approve=true 表示已回答（answers 已通过平台校验），approve=false 表示跳过 */
export interface ApprovalDecision { approve: boolean; reason: string; scope?: "session"; answers?: import("./types.js").QuestionAnswers }

/** Observed before input dispatch through the host-only Pi extension handshake. */
export interface EvaluationToolInventory {
  version: 1; nativeSessionId: string; clientMessageId: string;
  activeTools: string[]; registeredTools: Array<{name: string; source: "builtin"}>;
}
export interface TurnSink {
  roleApplied?(check: { matched: boolean; source: string; detail?: string }): void;
  /** 插话已作为用户消息进入本轮（原生记录可核对）；在对应的用户消息事件之前调用 */
  steerDelivered?(clientMessageId: string): void;
  evaluationInventory?(inventory: EvaluationToolInventory): void;
  nativeSession(id: string, info: { effectiveModel?: string; modelSource: string; parentId?: string; effectiveEffort?: string; effortSource?: string; title?: string; titleKind?: "name" | "summary" | "preview" }): void;
  nativeTurn(turnId: string): void;
  event(e: DriverEvent): void;
  usage(r: UsageRecord): void;
  /** 交给平台：等用户决定或过期（过期按拒绝）；signal 中止 = runtime 已撤回该请求，平台标记失效 */
  approval(req: DriverApproval, signal?: AbortSignal): Promise<ApprovalDecision>;
  rateLimit(s: Omit<RateLimitSnapshot, "identityScopeId" | "runtimeKind">): void;
  /** 原生状态变化：运行中 / 等待输入 */
  status(s: "running" | "waiting-input"): void;
}

export interface StartTurnArgs {
  capabilityGateway?: import("./capability-access.js").CapabilityAccess;
  platformBrowser?: import("./platform-browser.js").BrowserAccess;
  recordReadRoots?: string[];
  browserProfileId?: string;
  /** Host-owned task session identity, stable across turns and host restarts. */
  platformSessionId?: string;
  /** 已有原生会话：沿原 ID 续聊；不给 = 新建 */
  nativeSessionId?: string;
  /** Claude：平台预先分配的会话 ID（幂等核对用） */
  presetSessionId?: string;
  workspace: string;
  /** Host-stored worktree identity; never inferred from agent-mutable Git pointers for authorization. */
  worktree?: import("./pi-worktree-access.js").PiWorktreeIdentity;
  model?: string;
  /** 推理强度（该模型报告支持的值之一） */
  effort?: string;
  permissionMode?: PermissionMode;
  readOnlyRoom?: boolean;
  prompt: string;
  images?: import("./attachments.js").DriverImage[];
  /**
   * V3.0 角色指令（AgentDefinition v2 的角色模板渲染结果）：Codex 经 thread/start、thread/resume 的
   * developerInstructions 注入，Claude 经 systemPrompt preset append 注入；每次新建与续聊都重新带上。
   */
  roleInstructions?: string;
  /** Internal host-owned job policy, never interpreted from agent output. */
  evaluation?: import("./evaluation.js").EvaluationBoundary;
  /**
   * Pi 联网检索（web_search / web_open）的本轮来源授权；只有 Pi 读这个字段。
   * 不传 = 普通聊天会话默认开放公网来源（`*`，仍只允许公网 HTTPS）；false = 不注册检索工具。
   */
  webResearch?: { sourceDomains: string[] } | false;
  /** Codex clientUserMessageId / Claude 用户消息 uuid */
  clientMessageId: string;
  /** 续聊前已持久化的累计请求数（目前 Codex 用来续上 tokenUsage 更新计数） */
  priorRequestCount?: number;
}

/** code：runtime 给出的结构化错误码（Codex codexErrorInfo、Claude 消息 error），用来区分认证失败与额度不足 */
export interface TurnResult { /** Exact complete per-unit native receipt; accepted only with this turn's observed terminal. */ usageReceipt?: import("./execution-budget.js").NativeTurnUsageReceipt; status: TurnStatus; reason?: string; code?: string; /** Set only after a native terminal record for this turn; transport loss is insufficient. */ terminalObserved?: boolean;
  /**
   * The host observed the process executing this turn exit (how, in words). The turn can no longer be running,
   * so it stops holding shared capacity even when its native result stays unconfirmed. Never set from a timeout or lost connection alone.
   */
  processEnded?: string }

export interface NativeFingerprint {
  value: string;
  lastTurnStatus?: string;
  active?: boolean;
  lastTurnId?: string;
  lastClientMessageId?: string;
  /** True only for an authoritative terminal record, never inferred from process disappearance. */
  terminalObserved?: boolean;
  /** 读不到原生记录、沿用上次指纹时的说明：只记审计，不参与比对 */
  note?: string;
  /** 本次值与上次记录的语式不同（指纹格式升级）：不可比，只重建基线，不判外部写入 */
  migrated?: boolean;
}

/** 全部新增记录均已由原生结构化来源核对为本轮后台续写；undefined 表示无法证明，不能放行。 */
export interface NativeContinuation {
  /** Native event keys already delivered through the live sink; persisted for recovery deduplication. */
  streamedKeys?: string[];
  /** Structured native tool IDs used to check live-stream persistence, never text-based ownership. */
  toolCallIds?: string[];
  fingerprint: string;
  events: DriverEvent[];
  active: boolean;
  pending: boolean;
}

export interface TurnHandle {
  /** The original sink and tool resources remain in use after the foreground result. */
  continuationDone?: Promise<void>;
  done: Promise<TurnResult>;
  interrupt(): Promise<void>;
  /**
   * 运行中插话（Pi steer、Codex turn/steer、Claude 流式输入）：在当前这批工具执行完、下一次调用模型前送达。
   * resolve = runtime 已排进本轮；真正送达时经 sink.steerDelivered 通知。reject = 没有送出（本轮已在结束等）。
   */
  steer?(input: { clientMessageId: string; prompt: string; images?: import("./attachments.js").DriverImage[] }): Promise<void>;
}

export interface HistoryItem {
  nativeSessionId: string;
  title: string;
  workspace?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  parentId?: string;
  sourceLabel: string;
  /** 原生记录的创建方（Codex originator）；没有记录则不填 */
  originator?: string;
  /** 只读历史的运行证据：没有可靠证据时 unknown，不显示 running */
  status: SessionStatus;
}

export interface HistoryRead {
  events: DriverEvent[];
  usage: UsageRecord[];
  status: SessionStatus;
  coverage: "complete" | "partial" | "unknown";
  notes: string[];
  fingerprint?: string;
  model?: string;
  title?: string;
  titleKind?: "name" | "summary" | "preview";
  workspace?: string;
}

export interface ProbeOutcome {
  browserProfiles?: import("./types.js").BrowserProfileOption[];
  /** Fresh authenticated endpoint response; cached account/usage data is insufficient. Internal to the host. */
  authVerified?: true;
  state: ProfileState;
  stateReason: string;
  binaryPath?: string;
  binaryVersion?: string;
  sdkVersion?: string;
  capabilities: Record<CapabilityName, Capability>;
  models: ModelOption[];
  identity?: { stableAccountId?: string; authMode: string; summary: string; source: string; fingerprint: string };
  configSummary: string[];
  permissions: { label: string; detail: string };
  permissionOptions?: PermissionOption[];
  rateLimit?: Omit<RateLimitSnapshot, "identityScopeId" | "runtimeKind">;
}

export interface RuntimeDriver {
  readonly kind: RuntimeKind;
  /** Complete host-owned evaluation policy; absent while any effective tool channel is unknown. */
  evaluationPolicy?(): { version: string; channels: string[] } | undefined;
  probe(): Promise<ProbeOutcome>;
  /** 当前可执行文件的指纹（每次现查，不走缓存）；管理器据此发现 CLI 升级并自动重新检测。没有独立二进制的 runtime 不实现 */
  binaryStamp?(): { path: string; mtimeMs: number } | undefined;
  /** Runtime owns grants and persistence. Frontends pass native identity plus opaque grant IDs only. */
  permissionGrants?(nativeSessionId:string,options:{workspace:string;revoke?:{id?:string}}):Promise<import('../../pi-runtime/src/permission-control.js').PermissionGrantList>;
  /** 返回时原生会话已创建/恢复且本轮输入已送出；任何一步失败抛 DriverStageError */
  startTurn(args: StartTurnArgs, sink: TurnSink): Promise<TurnHandle>;
  listHistory(opts: { roots: string[]; limit: number; originators?: string[] }): Promise<{ items: HistoryItem[]; coverage: "complete" | "partial"; notes: string[] }>;
  readHistory(nativeSessionId: string, opts: { workspace?: string }): Promise<HistoryRead>;
  /** Lightweight metadata read after a turn; never loads transcripts just to name a session. */
  readTitle?(nativeSessionId: string, opts: { workspace?: string }): Promise<Pick<HistoryRead, "title" | "titleKind"> | undefined>;
  /** 外部写入检测与重启核对：原生记录的指纹 */
  fingerprint(nativeSessionId: string, opts: { workspace?: string; /** 绑定里上次记录的指纹：读不到原生记录时按需沿用，只有运行时自己决定用不用 */ previous?: string }): Promise<NativeFingerprint | undefined>;
  continuationState?(nativeSessionId: string): { clientMessageId: string; revision: number; active: boolean } | undefined;
  readContinuation?(nativeSessionId: string, opts: { previous: string; toolCallIds: string[]; endedAt: string }): Promise<NativeContinuation | undefined>;
  /** 首轮/续聊核对：带该客户端消息 ID 的用户消息是否已在原生记录中 */
  findClientMessage(nativeSessionId: string, clientMessageId: string, opts: { workspace?: string }): Promise<boolean | undefined>;
  rateLimits(): Promise<Omit<RateLimitSnapshot, "identityScopeId" | "runtimeKind"> | undefined>;
  shutdown(): void;
}

/** 分阶段失败：创建成功但首轮失败时，管理器据此保留已创建的原生 ID（V28-05） */
export class DriverStageError extends Error {
  /** processEnded：宿主亲眼等到执行进程退出（结果仍可能未知，但这一轮不会再有进程在跑，名额可以放） */
  constructor(message: string, readonly stage: "spawn" | "create" | "dispatch", readonly nativeSessionId?: string, readonly notExecuted = false, readonly processEnded?: string) { super(message); }
}

export const iso = (ms: number | null | undefined): string | undefined =>
  typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;

export function cap(status: Capability["status"], reason: string, version?: string): Capability {
  return { status, reason, ...(version ? { version } : {}) };
}
