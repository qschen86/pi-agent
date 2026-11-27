export type EntryRef = { kind: 'note'; noteId: string } | { kind: 'google'; accountId: string; calendarId: string; eventId: string; seriesId?: string };
import type { PermissionMode, PermissionOption } from "./permissions.js";
/**
 * V2.8 外部 runtime 会话的读取/管理模型（需求 §6）。
 *
 * 与 TaskSession / TaskContract / Replay 分开：外部会话是 runtime-native 执行，
 * 不写 TaskSession.aggregateVersion，不冒充合约门禁。所有原生 ID 都来自 runtime 的返回或原生记录。
 */

export type RuntimeKind = "codex" | "claude-code" | "pi" | "antigravity";
export const RUNTIME_KINDS: readonly RuntimeKind[] = ["codex", "claude-code", "pi", "antigravity"];
export const RUNTIME_LABEL: Record<RuntimeKind, string> = { codex: "Codex Desktop", "claude-code": "Claude Code CLI", pi: "Pi", antigravity: "Antigravity CLI" };

/** F01：每项能力单独判定，不把"发现 CLI"等同于"可执行" */
export type CapabilityName = "create" | "read" | "stream" | "resume" | "interrupt" | "approval" | "usage" | "rateLimits" | "roleInstructions" | "imageInput";
export const CAPABILITIES: readonly CapabilityName[] = ["create", "read", "stream", "resume", "interrupt", "approval", "usage", "rateLimits", "roleInstructions", "imageInput"];
/** 创建受管会话必须全部 supported 的能力 */
export const REQUIRED_FOR_CREATE: readonly CapabilityName[] = ["create", "stream", "resume", "interrupt", "approval"];
export interface Capability { status: "supported" | "unsupported" | "unknown"; reason: string; version?: string }

/** §4.1 状态：未安装、不兼容、待登录、可连接、可执行、错误 */
export type ProfileState = "not-installed" | "incompatible" | "needs-login" | "connectable" | "executable" | "error";

export interface IdentityScope {
  /** 带版本前缀；不含凭据，不由凭据求哈希 */
  identityScopeId: string;
  derivation: "stable-account-id" | "persistent-partition";
  /** 官方身份接口名 */
  source: string;
  authMode: string;
  /** 脱敏身份摘要（邮箱打码、计划类型） */
  summary: string;
  accountKnown: boolean;
}

export interface BrowserProfileOption { id: string; label: string; persistent: boolean }

export interface RuntimeProfile {
  browserProfiles?: BrowserProfileOption[];
  profileId: string;
  runtimeKind: RuntimeKind;
  hostId: string;
  hostLabel: string;
  identity?: IdentityScope;
  /** 实际服务环境里校验过的绝对路径（Codex），或固定 SDK 版本带的 CLI（Claude） */
  binaryPath?: string;
  binaryVersion?: string;
  sdkVersion?: string;
  transport: "app-server-stdio" | "agent-sdk" | "pi-rpc" | "acp-stdio";
  state: ProfileState;
  stateReason: string;
  capabilities: Record<CapabilityName, Capability>;
  models: ModelOption[];
  /** 默认权限配置（§8）：Codex workspace-write + on-request；Claude default */
  permissions: { label: string; detail: string };
  permissionOptions?: PermissionOption[];
  /** 确认页展示的生效配置摘要（hooks / MCP / 允许规则），不含秘密 */
  configSummary: string[];
  checkedAt: string;
  /**
   * 最近一次真实调用的认证失败：登录状态读取的是缓存身份，令牌是否有效只有真实调用能证明。
   * 记下后 profile 维持"待登录"，直到用户确认已重新登录再检查。
   */
  lastAuthFailure?: { at: string; message: string; platformSessionId: string };
  /** 最近一次真实调用因额度/限流失败：只提示，不阻止创建（额度会重置）；之后有一轮成功即清除 */
  lastQuotaFailure?: { at: string; message: string; code?: string; platformSessionId: string };
}

/** runtime 报告的模型与它支持的推理强度（Codex reasoning effort / Claude effort） */
export interface ModelOption { inputModalities?: string[]; id: string; label: string; isDefault?: boolean; efforts?: string[]; defaultEffort?: string }

export type SourceMode = "platform-managed" | "external-discovered";
export type ExecutionMode = "runtime-native" | "read-only";

export type SessionStatus = "creating" | "idle" | "running" | "waiting-input" | "stopping" | "interrupted" | "failed" | "completed" | "unknown";
export type TurnStatus = "queued" | "running" | "waiting-input" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
export type ObservationStatus = "live" | "catching-up" | "stale" | "disconnected" | "partial";
export type OperationState = "prepared" | "queued" | "dispatching" | "confirmed" | "failed" | "unknown";

export interface TimeValue { at: string; source: "runtime" | "platform" | "history-file" }

export interface TurnRecord {
  /** 平台 turn 号（本会话内递增） */
  turnNo: number;
  nativeTurnId?: string;
  status: TurnStatus;
  statusReason?: string;
  /** 这一轮因额度 / 限流中断：快捷回复可给平台兜底（不依赖模型提取） */
  quotaFailure?: boolean;
  operationId: string;
  startedAt?: string;
  endedAt?: string;
  /** 这一轮发出的用户消息摘要 */
  promptPreview: string;
  /** 客户端消息 ID（Codex clientUserMessageId / Claude user uuid）：核对首轮是否已送达 */
  clientMessageId: string;
  /** 这一轮请求的推理强度 */
  effort?: string;
}

export interface SessionBinding {
  recordSourceRefs?: EntryRef[];
  /** Opaque configuration ID owned and enforced by the runtime. */
  browserProfileId?: string;
  /** Human grant: every later approval request of this session is approved automatically until revoked. */
  approvalGrant?: { grantedBy: string; at: string; approvalId: string };
  /** 卡住看门狗：false 时只提醒、不自动中止（默认开，可在会话里改） */
  stallGuardAutoAbort?: boolean;
  platformSessionId: string;
  runtimeKind: RuntimeKind;
  runtimeProfileId: string;
  hostId: string;
  identityScopeId: string;
  nativeSessionId?: string;
  sourceMode: SourceMode;
  executionMode: ExecutionMode;
  nativeParentSessionId?: string;
  title: string;
  workspace: string;
  requestedModel?: string;
  effectiveModel?: string;
  effectiveModelSource?: string;
  /** 推理强度：请求值与 runtime 回报的生效值分开；回报不了就不填 */
  requestedEffort?: string;
  effectiveEffort?: string;
  effectiveEffortSource?: string;
  permissionLabel: string;
  permissionMode?: PermissionMode;
  /** Selected during an active turn; applied only before the next native dispatch. */
  pendingPermissionMode?: PermissionMode;
  /** The already accepted turn keeps its policy, even while waiting for an account slot. */
  pendingPermissionAfterTurn?: number;
  /** One-time ordinary Pi native-default migration; subsequent explicit choices are preserved. */
  piPermissionPolicyVersion?: 1;
  titleSource?: "prompt" | "native" | "user" | "pending" | "generated" | "fallback";
  titleGeneration?: {
    inputHash: string;
    policyVersion: string;
    state: "pending" | "running" | "succeeded" | "failed" | "superseded";
    attempts: number;
    owner?: string;
    leaseUntil?: number;
    generatedAt?: string;
    model?: string;
    errorCode?: string;
  };
  projectRef?: string;
  /** 对比组里的一条通道：同一首条消息并行发给多个会话 */
  comparisonRef?: ComparisonRef;
  roomRef?: { roomId: string; memberId: string };
  /** 从待办记录发起的会话：关联的那条记录；记录被删后按 id 取不到，不影响会话本身 */
  noteRef?: { noteId: string };
  /** 首轮技能目录里不列出的平台技能 id：评测要一个「没装这个技能」的干净基线时由创建请求设置 */
  platformSkillsExclude?: string[];
  recommendationRef?: RecommendationRef;
  /**
   * 会话自己的 git worktree（创建时勾选）：path 是 worktree 根，workspace 是其中的实际工作目录（原目录在仓库子目录时不同）；
   * 分支 branch 从 baseRef 的 baseCommit 切出。「提交并部署」在这里提交、变基到 baseRef 最新提交并快进 baseRef。
   * removedAt：归档时直接删除 worktree 和分支，未提交、未合并改动随之丢弃；恢复列表不重建。
   */
  worktree?: { repoRoot: string; path: string; branch: string; baseRef: string; baseCommit: string; subdir: string; removedAt?: string };
  /** Host-frozen project job class; chat clients cannot supply it. */
  admissionClass?: import("./shared-slots.js").AdmissionClass;
  /** Frozen host job policy, re-injected unchanged on every turn. */
  evaluation?: import("./evaluation.js").EvaluationBoundary;
  /** Formal evaluator/probe pins the effective adapter policy on every native turn. */
  evaluationPolicyHash?: string;
  /**
   * V3.0 角色绑定：角色正文另存（store.role），这里只留来源、版本与哈希。
   * 证据分层：请求已构造（宿主）/ runtime 确认（两种 runtime 都不回报完整提示 → not_collected）/ 行为验收（只由验收写入）。
   */
  role?: RoleBinding;
  createdAt: TimeValue;
  lastActivityAt: TimeValue;
  bindingRevision: number;
  creationOperationId: string;
  status: SessionStatus;
  statusReason?: string;
  /**
   * 会话列表上的推荐操作标签：最近一次快捷回复的第一条本身是 action（部署 / 归档）时才记录。
   * 只做展示，不改 bindingRevision；新一轮开始、归档或第一条不是 action 时清掉。
   */
  quickAction?: QuickActionBadge;
  /**
   * 最终推荐操作（输入框上方或回合收束卡片里的快捷回复）：一轮结束时服务端算好并存在这里，随会话详情 / 实时同步一起到手机，
   * 打开会话不用再请求。eventKey 是它所属的那条消息；新一轮开始、归档时清掉。只做展示，不改 bindingRevision。
   */
  quickReplies?: StoredQuickReplies;
  /**
   * 历史轮次的一句话结论摘要（按助手消息 eventKey 索引，最多保留最近 50 轮）：
   * 供「回合收束卡片」在回看历史轮次时直接展示，不随新一轮清掉，避免重开会话重复计费。只做展示，不改 bindingRevision。
   */
  turnSummaries?: Record<string, StoredTurnSummary>;
  /** 本会话已自动触发「重新部署」的次数：服务端累计，最多 AUTO_REDEPLOY_LIMIT 次；手动点击不计入。 */
  autoRedeployCount?: number;
  observation: ObservationStatus;
  turns: TurnRecord[];
  /** 外部写入冲突（§4.3）：存在时平台暂停写入，只读观察 */
  conflict?: { detectedAt: string; reason: string; evidence: string };
  /** 最后一次与原生记录核对的指纹（Codex updatedAt/turn 数；Claude 文件大小/末条 uuid） */
  nativeFingerprint?: { value: string; checkedAt: string; streamedKeys?: string[] };
  /**
   * 缓存变冷后的接续：长上下文会话空闲超过缓存保留时间后，续聊会把整段上下文重写一遍，
   * 所以改成新开一个会话接着做。from 在新会话上、to 在被归档的旧会话上；worktree 随之转给新会话。
   */
  handoff?: {
    from?: { platformSessionId: string; title: string; transcriptPath?: string };
    to?: { platformSessionId: string; title: string };
    at: string;
    reason: "quota-resume" | "manual";
    idleMs?: number;
    contextTokens?: number;
  };
  archived?: boolean;
  /** 归档时刻（恢复时清掉）：当天会话统计据此区分「今天归档」 */
  archivedAt?: string;
  coverage: "complete" | "partial" | "unknown";
  /**
   * 排队消息：本轮运行中先存下，一轮正常结束（completed）后按顺序逐条作为新一轮发出。
   * 发送前可改顺序、改内容（含图片）、撤销；出队与建新一轮在同一次写入里完成。只用于普通单聊。
   */
  outbox?: OutboxMessage[];
  /**
   * 创建时就约定了未来发送（首条消息预约）：首轮开始前会话不进入会话列表，
   * 只能从时钟打开的预约弹窗进入；预约被撤销后仍保持隐藏，直到真正发出第一轮。
   */
  scheduledCreate?: boolean;
  /**
   * 队列暂停：本轮停止 / 失败 / 结果未知或自动发送出错时不再自动发送，需要人确认后继续。
   * auto：部署排空导致，重启后自动继续；editing：有人正在修改排队消息，保存或取消后由该页面继续
   */
  outboxPaused?: { at: string; reason: string; auto?: boolean; editing?: boolean };
  /**
   * 额度（5 小时 / 周窗口）用尽打断了最近一轮：平台已安排在窗口重置后自动续聊一轮，不需要人来点。
   * 人发新消息、取消、归档或会话不再处于被中断状态时清掉；重启后按 scheduledFor 重新挂定时器。
   */
  quotaResume?: { scheduledFor: string; /** 依据的额度窗口 */ window: string; /** scheduledFor 来自真实重置时间（否则是兜底重试） */ known: boolean; createdAt: string; /** 被打断的那一轮 */ turnNo: number };
  /** 连续自动续聊的次数（没有一轮正常结束、也没有人介入）：达到上限就不再自动安排 */
  quotaResumeStreak?: number;
}

export interface OutboxMessage {
  /** 预约发送的最早时间（UTC）；保留此字段以区别普通排队消息。 */
  scheduledFor?: string;
  /** 客户端生成；出队时以 `q-${messageId}` 作为续聊幂等键 */
  messageId: string;
  prompt: string;
  /** 入队时已绑定到会话（不再受草稿 24 小时过期影响）；元数据用于预览 */
  attachments?: import("./attachments.js").ImageAttachment[];
  effort?: string;
  /** 入队的人：出队时以其身份解析图片 */
  actor: string;
  createdAt: string;
  updatedAt?: string;
  /** 正在插话（送进运行中的第 turnNo 轮）：送达后移出队列；本轮结束仍未送达就清掉，照常排队 */
  steering?: { at: string; actor: string; turnNo: number; /** 交给 runtime 的消息 ID（UUID；送达后对话里的 key 为 user:<它>） */ clientMessageId: string };
}

export interface RoleBinding {
  /** AgentDefinition 引用：id@semver */
  definitionRef: string;
  templateVersion: string;
  instructionsHash: string;
  /** 注入位置：codex developerInstructions / claude systemPrompt.append */
  injection: "codex.developerInstructions" | "claude.systemPrompt.append" | "pi.appendSystemPrompt" | "antigravity.systemPrompt.append";
  /** 新建、每次续聊与重启恢复后的发送都重新注入同一份角色正文 */
  evidence: { requested: true; runtimeConfirmed: "not_collected" | RoleRuntimeCheck; behaviorVerified?: { at: string; ref: string } };
}

export interface RoleRuntimeCheck {
  result: "confirmed" | "mismatch";
  turnNo: number;
  at: string;
  source: string;
  detail?: string;
}

export interface OperationRecord {
  inputHash?: string;
  imageInput?: { prompt: string; attachmentIds: string[]; owner: string; model?: string; effort?: string };
  operationId: string;
  idempotencyKey: string;
  kind: "create" | "turn" | "interrupt";
  platformSessionId: string;
  state: OperationState;
  stateReason?: string;
  createdAt: string;
  updatedAt: string;
  /** 每一步的原生响应摘要与可恢复关联键 */
  steps: Array<{ at: string; step: string; detail: string }>;
  turnNo?: number;
  /** Claude：平台预先分配的原生会话 ID（创建前持久化，重启后据此核对） */
  presetNativeId?: string;
}

/**
 * 平台自己在派发时补进提示词的正文（目前只有首轮公共记忆）。
 * 和「已载入 N 条」的通知一起存下来，事后才能在会话里点开看当时到底注入了什么——
 * 公共记忆的正文随规则增删而变，事后没法从数据文件还原。
 */
export interface PlatformInjection {
  /** 注入块的名字，例如「平台公共记忆」 */
  label: string;
  /** 实际补在提示词最前面的正文 */
  text: string;
  /** 常驻注入的条数 */
  count: number;
  /** 只给指针、按需查阅的条数 */
  onDemand?: number;
  /** 强约束记忆登记到本会话的检测规则：每轮结束后平台据此检查（见 memory-enforcement.ts） */
  rules?: import("./memory-enforcement.js").ActiveRule[];
}

/**
 * 强约束记忆的回合结束校验结果（平台生成的事件，挂在 notice 事件上）：侧栏「公共记忆」卡片按它画校验记录。
 * passed=通过；failed=未通过，已把反馈发给模型（attempt 是第几次反馈）；exhausted=反馈次数用完仍未通过，不再自动提醒；
 * skipped=这一轮没有触发这条规则（note 写原因），留痕是为了让人看得出平台没查而不是查过了。
 */
export interface PlatformEnforcement {
  phase: "passed" | "failed" | "exhausted" | "skipped";
  attempt: number;
  rules: Array<{ topicId: string; ruleId: string; topic: string; statement: string; title: string; problem?: string; fix?: string; note?: string }>;
}

/** §6.3 标准事件类型 */
export type EventKind = "message" | "image" | "tool" | "turn-status" | "approval" | "usage" | "compaction" | "error" | "reasoning" | "notice" | "unknown";
/** 沿用 Replay 的 availability 语义 */
export type Availability = "recorded" | "not_applicable" | "not_collected" | "redacted";

export interface ProjectedEvent {
  /** 去重键：原生 item/message ID；没有稳定 ID 时为文件身份+偏移 */
  key: string;
  /** 平台内顺序号（首次出现时分配，更新不改变） */
  seq: number;
  kind: EventKind;
  role?: "user" | "assistant" | "system";
  text?: string;
  attachments?: import("./attachments.js").ImageAttachment[];
  image?: { path?: string; prompt?: string; status: string };
  /** 流式片段：完成消息到达后被替换 */
  partial?: boolean;
  tool?: { name: string; input?: string; output?: string; status?: string; exitCode?: number | null };
  backgroundTask?: { id: string; status: string; startedAt?: string; endedAt?: string; description?: string };
  status?: string;
  nativeTurnId?: string;
  nativeItemId?: string;
  turnNo?: number;
  /** 子 Agent 消息：关联父会话但保持独立来源 */
  subagent?: string;
  occurredAt?: string;
  recordedAt: string;
  source: "stream" | "history" | "platform";
  parserVersion: string;
  availability: Availability;
  truncated?: { originalChars: number };
  redactions?: number;
  approvalId?: string;
  /** 平台注入的正文（首轮公共记忆）：侧栏卡片点开可查看 */
  injection?: PlatformInjection;
  /** 强约束记忆的回合结束校验结果：侧栏卡片点开可查看 */
  enforcement?: PlatformEnforcement;
  /** 本轮上下文缓存命中统计：挂在 turn-status 结束行上，点开看首调 / 整轮 / 热窗与前缀明细 */
  cacheStats?: TurnCacheStats;
  /** 本轮结束时的上下文占用与分类占比估算：挂在 turn-status 结束行上，默认收起展示总量，点开看堆叠占比条 */
  contextStats?: TurnContextStats;
}

export interface TurnContextBreakdownPart {
  key: "tool" | "system" | "chat" | "reasoning";
  label: string;
  /** 百分比（整数 0–100，各项相加 = 100） */
  percent: number;
  /** 按实测总上下文折算的估算 tokens */
  tokens: number;
}

export interface TurnContextStats {
  /** 本轮结束时实测上下文总 tokens */
  totalTokens: number;
  /** 模型上下文窗口上限（已知模型或 runtime 直报；未知时省略） */
  windowTokens?: number;
  /** 相对上一轮结束时的上下文增量（可正可负） */
  deltaTokens?: number;
  /** 相对窗口的占用比例（0..1，有 windowTokens 时存在） */
  usageRatio?: number;
  /** 水位状态：≥85% bad，≥70% warn，其余 neutral */
  tone: "neutral" | "warn" | "bad";
  /** 总量来源：reported=runtime 直报 contextTokens，last-request=最近一次请求总输入 */
  source: "reported" | "last-request";
  /** 各部分估算占比（基于本会话截至本轮的事件字符权重，按 totalTokens 归一化） */
  parts: TurnContextBreakdownPart[];
}

export interface TurnCacheStats {
  /** 折叠行主徽章展示的命中率（第 ≥2 轮测到首调时为首调命中率，否则为本轮整轮命中率） */
  primaryRate: number;
  primaryKind: "first-call" | "turn";
  tone: "ok" | "warn" | "bad" | "neutral";
  /** 折叠行紧凑标签（如「缓存 96.9%」「整轮 83.7%」「缓存 0.0% · 异常」） */
  badgeLabel: string;
  firstCall?: {
    hitRate: number;
    cachedIn: number;
    totalIn: number;
    uncachedIn: number;
    source: string;
  };
  turnTotal?: {
    hitRate: number;
    cachedIn: number;
    totalIn: number;
  };
  warm?: boolean;
  idleMs?: number;
  warmWindowMs?: number;
  prevContextTokens?: number;
  expectedMinHitRate?: number;
  severity: "ok" | "degraded" | "severe" | "skipped";
  skipReason?: string;
  prefixChanged?: boolean;
  prefixChangedFields?: string[];
  summary: string;
  detail: string;
}

/** §7 用量口径 */
export interface UsageRecord {
  usageScope: "session" | "turn" | "request";
  counterMode: "cumulative" | "delta";
  model?: string;
  /** 原始计数字段，保持来源字段名 */
  raw: Record<string, number>;
  /** 统一映射（附口径说明） */
  input?: number;
  cachedInput?: number;
  cacheCreation?: number;
  output?: number;
  reasoningOutput?: number;
  total?: number;
  /** 这次请求（或这一轮最后一次请求）带上的上下文大小：只用来判断缓存冷了之后续跑贵不贵，不参与任何求和 */
  contextTokens?: number;
  /** runtime 直报的模型上下文窗口上限（如 Antigravity usage_update.size、Codex modelContextWindow） */
  contextWindow?: number;
  semantics: string;
  sourceRef: string;
  /** 单请求 ID（只有它存在时 delta 才求和） */
  requestId?: string;
  /** 累计快照可以附带累计请求数（Codex 的 tokenUsage 更新次数） */
  requestCount?: number;
  sampledAt: string;
  occurredAt?: string;
  reliability: "complete" | "partial" | "unknown";
  subagent?: string;
  /**
   * 归档压缩后的合计行：同一会话、同一小时（UTC）、同一模型、同一子 Agent 的单请求 delta 加在一起。
   * 形状仍是一条带 requestId 的 delta 记录（旧版本照样能求和）；calls 是合并的请求数，
   * folded 是被合并记录身份的短指纹，回补时据此丢弃已经计过的请求，避免重复计数。
   */
  aggregate?: { hour: string; calls: number; folded: string[] };
}

export interface UsageSummary {
  coverage: "complete" | "partial" | "unknown";
  semantics: string;
  totals: { input?: number; cachedInput?: number; cacheCreation?: number; output?: number; reasoningOutput?: number; total?: number };
  byModel: Array<{ model: string; input?: number; output?: number; cachedInput?: number; cacheCreation?: number }>;
  requestCount?: number;
  sampledAt?: string;
  sourceRef?: string;
  notes: string[];
  subagentTotals?: { input?: number; output?: number };
}

export interface RateLimitSnapshot {
  identityScopeId: string;
  runtimeKind: RuntimeKind;
  windows: Array<{ label: string; usedPercent: number | null; resetsAt: string | null; windowMinutes?: number | null; group?: string }>;
  plan?: string;
  source: string;
  experimental?: boolean;
  sampledAt: string;
  available: boolean;
  reason?: string;
}

/** runtime 向人类提出的一道题（Claude AskUserQuestion、Codex request_user_input / MCP 表单、Pi 扩展的 select/input）。 */
export interface QuestionOption { label: string; description?: string }
export interface QuestionItem {
  /** 答案的键：同一请求内唯一 */
  id: string;
  header?: string;
  question: string;
  /** 为空 = 纯文本题 */
  options: QuestionOption[];
  multiSelect: boolean;
  /** 除了选项，是否允许自己写（Claude 的「其他」、Codex isOther、纯文本题） */
  allowOther: boolean;
  /** 答案不进入记录、审计与时间线 */
  secret?: boolean;
  /** 可以不答（MCP 表单的非必填字段） */
  optional?: boolean;
  /** 文本题的输入提示（Pi input 的 placeholder 等） */
  placeholder?: string;
  /** 文本题预填 / 多行（Pi editor） */
  prefill?: string;
  multiline?: boolean;
}
/** 题目 id → 所选标签或自填文本（单选长度为 1） */
export type QuestionAnswers = Record<string, string[]>;

export interface ApprovalRequest {
  approvalId: string;
  platformSessionId: string;
  turnNo: number;
  nativeTurnId?: string;
  nativeRequestId: string;
  kind: "command" | "file-change" | "permissions" | "tool" | "question";
  title: string;
  /** kind=question：需要人类选择/填写的问题；答复必须带 answers，且永远单次，不受「本会话全部批准」影响 */
  questions?: QuestionItem[];
  /** 动作与范围（脱敏后） */
  action: string;
  scope: string;
  source: string;
  /** A one-command expansion cannot inherit or create a session-wide grant. */
  requiresExplicitApproval?: boolean;
  /** Runtime-owned scoped session decision; never creates a platform-wide grant. */
  runtimeSessionScope?: string;
  /** 参数摘要：答复必须携带，防止跨请求答复 */
  paramsDigest: string;
  createdAt: string;
  /** Absent means wait for a human without automatic expiry. */
  expiresAt?: string;
  bindingRevision: number;
  state: "pending" | "approved" | "denied" | "expired" | "invalidated";
  decidedAt?: string;
  /** Approved automatically under a human "approve all for this session" grant. */
  decidedBy?: "session-grant";
}

/** 服务端保存的新建会话默认配置；空串 = 该项用运行时默认。只在浏览器里没有「最近一次的选择」时兜底。 */
export interface SessionDefaults { model: string; effort: string; permissionMode: string }

/** 新建会话最近一次选择（按运行时）：文件夹、上次 runtime、模型/强度/审批；各端共用一份，localStorage 仅作缓存。 */
export interface RuntimeDraftPref {
  model?: string;
  effort?: string;
  permissionMode?: string;
  explicit?: Partial<Record<"model" | "effort" | "permissionMode", boolean>>;
}

export interface RuntimeNewSessionPreferences {
  version: 1;
  piPermissionPolicyVersion?: 1;
  antigravityPermissionPolicyVersion?: 1;
  lastRuntimeKind?: RuntimeKind;
  lastWorkspace?: string;
  drafts: Partial<Record<RuntimeKind, RuntimeDraftPref>>;
  updatedAt?: string;
}

export interface QuotaLowPromptPref { off?: boolean; snoozeUntil?: string }

export interface RuntimeSettings {
  /** 新建会话允许的工作目录根 */
  workspaceRoots: string[];
  /** 未配置继承全局根；显式 [] 禁止该运行时创建 */
  workspaceRootsByRuntime?: Partial<Record<RuntimeKind, string[]>>;
  /** 手动新建会话可选的模型（运行时配置里勾选的模型 id）；未配置 = 运行时报告的全部模型 */
  enabledModelsByRuntime?: Partial<Record<RuntimeKind, string[]>>;
  /** 新建会话默认配置（手动在运行时对比表「支持模型」一行里设置）；浏览器里没有最近一次的选择时用它 */
  defaultSessionByRuntime?: Partial<Record<RuntimeKind, SessionDefaults>>;
  /** 新建会话最近一次选择（文件夹、上次 runtime、逐运行时模型/强度/审批），跟随账号保存在服务端，各设备与各线路共用 */
  newSessionPreferences?: RuntimeNewSessionPreferences;
  /**
   * 额度余量 <3% 时发送前的提醒：off = 该运行时永久不再提醒；snoozeUntil = 本周期内（到该窗口重置前）不再提醒。
   * 跟随账号保存在服务端，各设备共用同一份。
   */
  quotaLowPromptByRuntime?: Partial<Record<RuntimeKind, QuotaLowPromptPref>>;
  /** 历史只读授权：按项目根目录限定（空 = 未授权） */
  /** originators：只列这些创建方的会话（Codex 原生记录的 originator，如 Codex Desktop）；空 = 不限 */
  history: Record<RuntimeKind, { enabled: boolean; roots: string[]; originators?: string[] }>;
  /** 公网（对外域名）控制能力：默认关闭（§8） */
  publicControl: boolean;
  /** 公网历史读取：与控制分别开关 */
  publicHistory: boolean;
  /** 宿主配置的共享账号调用上限（1–8，初始2），同时限制单个profile；项目不能自行提高。 */
  maxRunningPerProfile: number;
  /** 缓存变冷后的长上下文会话改为新开会话接续：enabled 默认开；thresholdTokens 默认 20 万 */
  cacheHandoff?: { enabled?: boolean; thresholdTokens?: number };
  updatedAt?: string;
}

export interface DirectoryEntry {
  id: string;
  runtimeKind: RuntimeKind | "pi";
  sourceMode: SourceMode | "pi-task";
  executionMode: ExecutionMode | "contract-governed";
  title: string;
  /** 独立 worktree 的会话：这里是原来选的目录（列表按它分组），实际在 worktree 分支里改 */
  workspace?: string;
  worktreeBranch?: string;
  model?: string;
  status: SessionStatus | string;
  statusReason?: string;
  /** 新建时刻（ISO）：待办页 Agent 卡片按它统计「当日新建」 */
  createdAt?: string;
  /** 归档时刻（ISO）：按它统计「当日归档」；恢复后不再有 */
  archivedAt?: string;
  lastActivityAt?: string;
  /** 最近已结束轮次的时间；新一轮运行时保留上一轮的结束时间。 */
  lastTurnEndedAt?: string;
  nativeSessionId?: string;
  identityScopeId?: string;
  accountKnown: boolean;
  href: string;
  conflict?: boolean;
  /** 从待办记录发起的会话：列表用它显示单独的待办图标（记录本身另有接口读取） */
  noteRef?: { noteId: string };
  /** 从推荐任务发起的会话：列表显示聚合待办图标；完整需求只在会话详情里读，目录只带摘要 */
  recommendationRef?: { taskId: string; revision: number; title: string; sourceCount: number };
  pendingApprovals?: number;
  /** 受管会话的最后一轮（页面据此按「已结束的轮次」算未读） */
  latestTurn?: { turnNo: number; status: string; queuedAt?: string; startedAt?: string; endedAt?: string };
  /** 受管会话的用途：chat = 用户在「新建运行时会话」里开的普通对话；project = 项目角色会话；probe = 宿主验收资格探针 */
  purpose?: SessionPurpose;
  projectRef?: string;
  comparisonRef?: ComparisonRef;
  roomRef?: { roomId: string; memberId: string };
  /** 最近一次快捷回复的第一条本身是 action（部署 / 归档）；会话列表据此显示标签 */
  quickAction?: QuickActionBadge;
  /** 排队里最早的一条预约发送时间（UTC ISO）；会话列表据此显示「预约」标签 */
  scheduledNext?: string;
  archived?: boolean;
}

export interface StoredQuickReplies {
  eventKey: string;
  replies: Array<{ label: string; text: string; action?: "deploy" | "archive" }>;
  /** 本轮一句话结论（deepseek-flash 异步生成，前端卡片标明「摘要」） */
  headline?: string;
  /** 仅当助手明确提出待拍板/确认事项时存在（宁漏勿误） */
  decision?: string;
  /** 最近一轮带部署结果通知时的结果（失败时前端据此判断是否自动重新部署） */
  deployment?: "success" | "failed";
  /** 部署失败通知里的提交（自动重新部署据此判断提交有没有变化） */
  deploymentSha?: string;
  at: string;
}

export interface StoredTurnSummary {
  eventKey: string;
  turnNo?: number;
  headline: string;
  decision?: string;
  at: string;
}

/** 推荐操作标签：label 用模型给的按钮文字，eventKey 用来确认它仍属于最后一条消息 */
export interface QuickActionBadge {
  action: "deploy" | "archive";
  label: string;
  eventKey: string;
}

/** compare = 对比组里的通道会话（列表里按组折叠） */
export type SessionPurpose = "chat" | "project" | "probe" | "compare" | "room";

/**
 * 待办记录关联的会话摘要：会话创建时记下 noteRef，待办本身不知道有哪些会话。
 * 待办页据此列出并跳转；一个待办可以关联多个会话。
 */
export interface NoteSessionLink {
  platformSessionId: string;
  runtimeKind: RuntimeKind;
  title: string;
  status: SessionStatus;
  archived: boolean;
  lastActivityAt?: string;
  /** 控制台内的跳转地址（#/rt/<id>） */
  href: string;
}

/* ============================ 对比组 ============================ */

/** 一组最多几条通道 */
export const COMPARE_MAX_LANES = 4;
export interface ComparisonRef { groupId: string; laneNo: number }

export interface ComparisonLane {
  laneNo: number;
  runtimeKind: RuntimeKind;
  model?: string;
  effort?: string;
  permissionMode: PermissionMode;
  /** 已创建的会话；缺失说明创建还没完成（重试会补齐）或失败（见 error） */
  platformSessionId?: string;
  /** 整组预检通过后单条创建失败：记原因，不回滚其他通道 */
  error?: string;
  /** worktree 隔离：通道自己的 worktree 根与会话实际工作目录（原工作目录在仓库子目录时两者不同） */
  worktree?: { path: string; workspace: string };
}

/**
 * 对比组只是一层外壳：每条通道都是普通受管会话，幂等、排队、审批、恢复全部沿用。
 * 隔离两种：read-only = 共用同一工作目录、权限固定为只读；
 * worktree = 工作目录在 git 仓库里时，每条通道一个从同一 commit 切出的 worktree，可用不越出工作区的写权限。
 */
export interface ComparisonGroup {
  groupId: string;
  idempotencyKey: string;
  /** 首条消息的哈希：同一幂等键换了内容重放时拒绝 */
  promptHash: string;
  title: string;
  workspace: string;
  promptPreview: string;
  isolation: "read-only" | "worktree";
  /** worktree 隔离的仓库信息；cleanedAt 之后各通道的 worktree 已删除 */
  worktree?: { repoRoot: string; subdir: string; baseCommit: string; baseBranch?: string; dirtyAtCreate: number; cleanedAt?: string };
  /** 已采用的通道：其改动已应用到原工作目录（只采用一次） */
  adopted?: { laneNo: number; patchHash: string; files: number; at: string; by: string };
  lanes: ComparisonLane[];
  createdAt: string;
  createdBy: string;
  /** 人工结论：选出的通道（null = 都不满意）与备注 */
  verdict?: { laneNo: number | null; note: string; at: string; by: string };
}

/** Frozen requirement and source locators for a recommended iteration. */
export interface RecommendationRef {
  taskId: string; revision: number; title: string; requirement: string;
  sources: Array<{ noteId: string; text: string; inputHash: string; imageIds?: string[] }>;
}
