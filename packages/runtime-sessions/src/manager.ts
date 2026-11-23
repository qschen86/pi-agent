import {startPlatformBrowser, verifyScreenshotReceipt, screenshotReportProblems} from "./platform-browser.js";
import {SCREENSHOT_INSTRUCTIONS} from "../../pi-runtime/src/screenshot-policy.mjs";
import {LINK_READ_INSTRUCTIONS} from "./public-link-reader.js";
import { webActivity, type WebActivityItem } from "./web-activity.js";
import { runtimeRecordInstructions, platformChecks, platformInjections, type PlatformCheckItem, type PlatformInjectionItem } from "./platform-injection.js";
import { snapshotWorkspace, changedFilesSince, type WorkspaceSnapshot } from "./workspace-evidence.js";
import { beforeAfterFact, readProbeStates, READER_PROBE_IDS, type ProbeReaders } from "./memory-probes.js";
import { activeRulesOf, composeFeedback, probeIdsOf, ENFORCEMENT_PROMPT_MARK, enforcementRule, MAX_ENFORCEMENT_RETRIES, runModelRules, runRules, ruleTitleOf, turnEvidence, unfinishedChainStart, type ActiveRule, type ModelRuleJudge } from "./memory-enforcement.js";
import { platformLookups, type PlatformLookupItem } from "./platform-memory-lookups.js";
import { sessionImageIndex } from "./image-index.js";
import { PLATFORM_SKILLS_ROOT, preparePlatformPrompt, prependPlatformPreamble, type PlatformSkillInfo } from "./platform-skills.js";
import { PlatformSkillSwitches } from "./platform-skill-switches.js";
import { UI_REPORT_FIX, UI_SKILL_ID, uiReportProblems } from "./ui-report-check.js";
import { evaluationPermission, normalizeEvaluation } from "./evaluation.js";
import type { EvaluationBoundary } from "./evaluation.js";
import { COMPARE_WORKTREE_PERMISSION_MODES, defaultPermissionMode, effectivePermissionMode, permissionOption, permissionOptions, readOnlyPermissionMode } from "./permissions.js";
import { addSessionWorktree, addWorktree, applyPatch, defaultBase, gitWorkspaceInfo, insideRepo, laneDiff, removeSessionWorktree, removeSessionWorktreeIfMerged, removeWorktree, sessionWorktreeBranch, sessionWorktreePath, worktreePath } from "./worktree.js";
import type { GitWorkspaceInfo, LaneDiff } from "./worktree.js";
import type { PermissionMode } from "./permissions.js";
/**
 * 外部 runtime 会话管理器（V2.8）。
 *
 * 职责：profile 探测与身份分区、幂等的创建/续聊/中断、每会话单写租约、每 profile 并发上限与排队、
 * 审批时效与绑定、事件投影持久化与实时推送、外部写入冲突、重启核对（生命周期方案 A）、
 * 授权历史只读、用量与额度、部署排空。
 *
 * 不做的事：不实现 RuntimeAdapter.start、不写 TaskSession、不宣称合约门禁（runtime-native）。
 */
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { PiDriver } from "./pi.js";
import { ClaudeDriver } from "./claude.js";
import { AntigravityDriver } from "./antigravity.js";
import { CodexDriver, underRoots } from "./codex.js";
import { DriverStageError } from "./driver.js";
import type { ApprovalDecision, DriverApproval, DriverEvent, HistoryItem, HistoryRead, NativeFingerprint, RuntimeDriver, TurnHandle, TurnResult, TurnSink } from "./driver.js";
import { bounded, LIMITS } from "./redact.js";
import { answersSummary, questionsText, validateAnswers } from "./questions.js";
import { nativeTurnUsageReceipt, type NativeTurnUsageReceipt } from "./execution-budget.js";
import { SharedSlots } from "./shared-slots.js";
import type { AdmissionClass, ProjectAdmissionPolicy } from "./shared-slots.js";
import { RuntimeStore } from "./store.js";
import type {
  ApprovalRequest, ComparisonGroup, ComparisonLane, ComparisonRef, DirectoryEntry, IdentityScope, NoteSessionLink, OperationRecord, ProjectedEvent, QuickActionBadge, RateLimitSnapshot, StoredQuickReplies, RuntimeKind, RuntimeProfile,
  OutboxMessage, RuntimeSettings, SessionBinding, SessionPurpose, SessionStatus, TurnRecord, UsageRecord, UsageSummary
} from "./types.js";
import { COMPARE_MAX_LANES, REQUIRED_FOR_CREATE, RUNTIME_KINDS, RUNTIME_LABEL } from "./types.js";
import type { PlatformEnforcement } from "./types.js";
import { dailyUsage, summarizeUsage, usageCalls, usageTime } from "./usage.js";

import { AttachmentStore } from "./attachments.js";
import type { ImageAttachment } from "./attachments.js";
import type { ModelInvocationPort } from "@pi-agent/model-port";
import { pendingSessionTitle, SessionTitleWorker } from "./session-title.js";
import { QUOTA_RESUME_MARGIN_MS, QUOTA_RESUME_MAX_STREAK, QUOTA_RESUME_PROMPT, planQuotaResume, stillExhaustedUntil } from "./quota-resume.js";
import { AUTO_REDEPLOY_LIMIT, RETRY_REPLY, canonicalizeQuickActions, lastAssistantMessage, lastDeploymentOutcome, lastTurnEnd, quotaInterruptedReplies, QuickReplyService, withDeploymentPriority } from "./quick-replies.js";
import type { QuickReplyResult } from "./quick-replies.js";

export const PROJECTION_VERSION = "rt-projection@1";
const FOLDER_LIST_MAX = 500;

export interface FolderListing {
  /** null：列出的是允许的根本身 */
  path: string | null;
  /** 上一级仍在允许范围内时给出；否则回到根列表 */
  parent: string | null;
  roots: string[];
  entries: Array<{ name: string; path: string }>;
  truncated: boolean;
}

/** 给人看的工作目录：独立 worktree 的会话显示原来选的目录（仓库根 + 子目录），而不是 .pi-worktrees/<会话> */
export function sessionDisplayWorkspace(b: Pick<SessionBinding, "workspace" | "worktree">): string {
  return b.worktree ? (b.worktree.subdir ? join(b.worktree.repoRoot, b.worktree.subdir) : b.worktree.repoRoot) : b.workspace;
}

export class RuntimeError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 503, readonly code: string) { super(message); }
}

export interface ManagerOptions {
  dataDir: string;
  /** Host-owned admission directory shared by managers for the same account scope. */
  sharedSlotsDir?: string;
  drivers?: Partial<Record<RuntimeKind, RuntimeDriver>>;
  /** Human decisions do not expire by default; a positive value explicitly enables a deadline. */
  approvalTtlMs?: number;
  /** 提问有效期，至少不短于显式审批有效期；默认不自动超时 */
  questionTtlMs?: number;
  /** 测试：不在构造时自动核对 */
  skipRecovery?: boolean;
  historyCacheMs?: number;
  /** Platform metadata completion; production wires an isolated no-tools model port. */
  titlePort?: ModelInvocationPort;
  /**
   * 平台级技能：展开用户写的 `/技能名`，并在会话首轮补一份技能目录。生产装配处（apps/web/src/main.ts）开启；
   * 不传时提示词原样交给驱动，所有只关心提示词本身的测试与脚本不受影响。root 默认是仓库的 skills/platform。
   */
  /** switchesFile：技能开关存盘位置；不给就没有开关（全部启用） */
  platformSkills?: { root?: string; switchesFile?: string };
  /** 卡住看门狗阈值（测试用毫秒注入；不传就是 2/5/10 分钟提醒、20 分钟自动中止） */
  stallGuard?: { shellMs?: number[]; browserMs?: number[]; abortMs?: number; tickMs?: number };
  /** 认证失败后自动补一次在线认证的延迟（测试用毫秒注入；不传就是 5 秒） */
  authAutoVerifyDelayMs?: number;
  /** 检查 runtime 二进制是否升级的间隔（测试用毫秒注入；不传就是 60 秒） */
  binaryWatchMs?: number;
}

interface Running {
  turnNo: number;
  operationId: string;
  handle?: TurnHandle;
  stopRequested?: boolean;
  approvals: Set<string>;
  closeBrowser?:()=>Promise<void>;
}

interface PendingApproval { resolve: (d: ApprovalDecision) => void; timer?: NodeJS.Timeout }

export interface CreateInput {
  recordSourceRefs?: import("./types.js").EntryRef[];
  scheduledFor?: string;
  browserProfileId?: string;
  attachmentIds?: string[];
  idempotencyKey: string;
  runtimeKind: RuntimeKind;
  workspace: string;
  prompt: string;
  model?: string;
  /** 推理强度：必须是所选模型（不选则 runtime 默认模型）报告支持的值 */
  effort?: string;
  title?: string;
  permissionMode?: PermissionMode;
  /** 确认页看到的 profile 版本（checkedAt）：之后重新探测过则要求重新确认 */
  confirmedProfileVersion: string;
  /** V3.0：项目任务的角色（AgentDefinition v2 渲染的角色指令）与项目引用 */
  role?: { definitionRef: string; templateVersion: string; instructions: string };
  projectRef?: string;
  admissionClass?: AdmissionClass;
  /** Internal project job policy; public chat route does not accept this field. */
  evaluation?: EvaluationBoundary;
  evaluationPolicyHash?: string;
  /** 对比组内部创建通道时设置（接口不直接接受） */
  comparisonRef?: ComparisonRef;
  roomRef?: { roomId: string; memberId: string };
  /** 从待办记录发起的会话：关联的那条记录 id */
  noteRef?: { noteId: string };
  platformSkillsExclude?: string[];
  recommendationRef?: import("./types.js").RecommendationRef;
  deferFirstTurn?: boolean;
  /** 路由入口用：当前正在部署排空时，自动改为只建会话、首条消息进排队（不启动原生执行）。 */
  deferWhenDraining?: boolean;
  /** 在会话自己的 git worktree 里改（从 main 切出）；只用于普通单会话 */
  worktree?: boolean;
}

export interface SessionView {
  session: SessionBinding;
  readOnly: boolean;
  readOnlyReason?: string;
  usage: UsageSummary;
  approvals: ApprovalRequest[];
  rateLimit?: RateLimitSnapshot & { stale: boolean };
  profile?: Pick<RuntimeProfile, "profileId" | "state" | "binaryVersion" | "sdkVersion" | "permissions" | "hostLabel">;
  /** 续聊时可选的推理强度（本会话模型报告的） */
  effortOptions?: { efforts: string[]; defaultEffort?: string };
  permissionOptions?: import("./permissions.js").PermissionOption[];
  /** 在本机终端里继续这个原生会话的命令（P1：Desktop 打开的替代；平台会把它识别为外部写入） */
  resumeCommand?: string;
  queuePosition?: number;
  notes: string[];
  executionNotice: string;
}

export interface ComparisonInput {
  idempotencyKey: string;
  workspace: string;
  prompt: string;
  lanes: Array<{ runtimeKind: RuntimeKind; model?: string; effort?: string; permissionMode?: PermissionMode }>;
  /** 确认页看到的各运行时 profile 版本（checkedAt） */
  confirmedProfileVersions: Partial<Record<RuntimeKind, string>>;
  /** read-only（默认）或 worktree（工作目录须在有 commit 的 git 仓库里） */
  isolation?: "read-only" | "worktree";
  /** worktree：确认页看到的 base commit；之后 HEAD 变了要求重新确认 */
  confirmedBaseCommit?: string;
}

/** 新建对比前查看工作目录：是不是 git 仓库、base commit、未提交改动数、worktree 能否放在允许根内 */
export interface ComparisonWorkspaceInfo {
  workspace: string;
  git?: GitWorkspaceInfo & { worktreeRoot: string; worktreeAllowed: boolean };
}

/** L3：一条通道相对 base 的代码改动（补丁过长时截断，采用时仍用完整补丁） */
export interface ComparisonLaneDiff extends Omit<LaneDiff, "patch"> {
  laneNo: number;
  patch: string;
  truncated?: { originalChars: number };
}
const DIFF_PATCH_MAX = 400_000;

/** 对比页的一列：会话状态、可比较的指标（L1）与最终回复（L2） */
export interface ComparisonLaneView extends ComparisonLane {
  session?: Pick<SessionBinding, "platformSessionId" | "status" | "statusReason" | "requestedModel" | "effectiveModel" | "requestedEffort" | "effectiveEffort" | "permissionLabel" | "archived" | "bindingRevision" | "conflict" | "nativeSessionId" | "approvalGrant">;
  queuePosition?: number;
  approvals: ApprovalRequest[];
  metrics: {
    turns: number;
    latestTurn?: { turnNo: number; status: TurnRecord["status"]; startedAt?: string; endedAt?: string; durationMs?: number };
    /** 已结束各轮的耗时之和（缺开始或结束时间的轮次不计） */
    totalDurationMs?: number;
    toolCalls: number;
    toolFailures: number;
    errors: number;
    usage: UsageSummary["totals"];
    usageCoverage: UsageSummary["coverage"];
  };
  /** 最新一轮里最后一条主 Agent 回复；生成中为 partial */
  answer?: { text: string; seq: number; turnNo?: number; partial: boolean; truncated?: { originalChars: number } };
}

export interface ComparisonView {
  group: ComparisonGroup;
  lanes: ComparisonLaneView[];
  /** 全部通道都已不在运行（含失败/中断） */
  settled: boolean;
  notes: string[];
}

const ACTIVE: SessionStatus[] = ["creating", "running", "waiting-input", "stopping"];
/** 排队消息上限：条数与单条长度（与续聊一致） */
export const OUTBOX_LIMITS = { count: 20, prompt: 100_000 };
const OUTBOX_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** 出队时校验内容没被并发修改：只比较会发出去的部分 */
function outboxDigest(m: OutboxMessage): string {
  return createHash("sha256").update(JSON.stringify({ prompt: m.prompt, images: (m.attachments ?? []).map(a => a.attachmentId), effort: m.effort ?? null, scheduledFor: m.scheduledFor ?? null })).digest("hex");
}

/** 会话用途：项目角色会话带 projectRef/role；验收资格探针目前只能从工作目录识别（.evaluation-qualification/<id>） */
export function sessionPurpose(b: Pick<SessionBinding, "projectRef" | "role" | "workspace" | "comparisonRef" | "roomRef">): SessionPurpose {
  if (b.roomRef) return "room";
  if (b.projectRef || b.role) return "project";
  if (b.comparisonRef) return "compare";
  if (/[\\/]\.evaluation-qualification[\\/]/.test(b.workspace)) return "probe";
  return "chat";
}

/**
 * 首条消息开头的待办引用块：「引用待办记录（记于 2026-10-19 09:35）：」+ 「> 正文」。
 * 从待办发起对话时由待办页写入（见 apps/web/public/notes.js:noteConversationPrompt），用于把丢掉的 noteRef 反查回来。
 */
const SESSION_NOTE_QUOTE = /^引用待办记录（记于 ([^）\n]+)）：\n\n/;
function sessionNoteQuote(events: ProjectedEvent[], promptPreview?: string): { stamp: string; line: string } | null {
  const text = events.find((e) => e.kind === "message" && e.role === "user" && e.text)?.text ?? promptPreview ?? "";
  const head = SESSION_NOTE_QUOTE.exec(text);
  if (!head) return null;
  const line = text.slice(head[0].length).split("\n").map((l) => l.replace(/^>\s?/, "")).find((l) => l.trim());
  return line ? { stamp: head[1]!.trim(), line: line.trim() } : null;
}
export type NoteRefQuery = { stamp: string; line: string };
type NoteRefRepair = { platformSessionId: string; noteId: string };

/**
 * 与 RuntimeSessionManager.backfillNoteRefs 同实现，但不发事件：给维护脚本直接对一个 RuntimeStore 用
 * （scripts/repair-session-note-refs.ts：改历史数据；dryRun 只看会补哪些；includeArchived 连已归档会话一起看，
 * 只给人工点名的修复用 —— 已归档会话补上关联后，下次启动对账会按「归档即完成」把那条待办标完成）。
 */
export function backfillSessionNoteRefs(store: RuntimeStore, lookup: (quote: NoteRefQuery) => string | null, opts: { only?: string; dryRun?: boolean; includeArchived?: boolean } = {}): { repaired: NoteRefRepair[]; unresolved: string[] } {
  const repaired: NoteRefRepair[] = [], unresolved: string[] = [];
  for (const b of store.allBindings()) {
    if (opts.only && b.platformSessionId !== opts.only) continue;
    if ((b.archived && !opts.includeArchived) || b.noteRef?.noteId || b.recommendationRef || b.roomRef || b.comparisonRef || b.projectRef || b.role) continue;
    const quote = sessionNoteQuote(store.events(b.platformSessionId), b.turns[0]?.promptPreview);
    if (!quote) continue;
    let noteId: string | null = null;
    try { noteId = lookup(quote); } catch (e) { store.audit({ type: "note-ref-backfill", platformSessionId: b.platformSessionId, ok: false, error: bounded((e as Error).message, 200).text }); }
    if (!noteId) { unresolved.push(b.platformSessionId); continue; }
    if (!opts.dryRun) {
      try {
        store.updateBinding(b.platformSessionId, (x) => { if (!x.noteRef && !x.recommendationRef) x.noteRef = { noteId: noteId! }; });
        store.audit({ type: "note-ref-backfill", platformSessionId: b.platformSessionId, noteId });
      } catch { unresolved.push(b.platformSessionId); continue; }
    }
    repaired.push({ platformSessionId: b.platformSessionId, noteId });
  }
  return { repaired, unresolved };
}

/** 结构化错误码：认证 / 额度（Codex codexErrorInfo、Claude assistant error） */
const AUTH_CODES = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold"]);
const QUOTA_CODES = new Set(["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded", "rate_limit", "billing_error"]);
const QUOTA_FAILURE = /usage limit|rate limit|session limit|hit your (?:\w+ )?limit|quota|out of credits|额度/i;
/** runtime 报告的认证失败（令牌过期、未登录、被拒） */
const AUTH_FAILURE = /\b401\b|authenticat|oauth|access token|not logged in|log ?in required|re-?authenticate|invalid api key|unauthori[sz]ed/i;
const RATE_STALE_MS = 15 * 60_000;
/**
 * 卡住看门狗：单个工具连续运行时到阈值就提醒，到 abortMs 自动中止这一轮（可在会话里关掉）。
 * platform_browser 的等待里包含真人操作，门槛放宽到 5 分钟起步。
 */
const STALL_GUARD = { shellMs: [120_000, 300_000, 600_000], browserMs: [300_000, 600_000, 900_000], abortMs: 1_200_000, tickMs: 5_000 };
const STALL_BROWSER = /^(?:platform_browser|platform_browser\.browser|mcp__platform_browser__browser|mcp_platform_browser(?:_[0-9a-f]+)?_browser|browser)$/i;
function stallMinutes(ms: number): number { return Math.max(1, Math.round(ms / 60_000)); }
/** 工具入参的展示形态：runtime 把入参序列化成 JSON，提醒里只该看到命令本身。 */
function stallCommand(raw: string): string {
  try { const v = JSON.parse(raw) as unknown; if (v && typeof v === "object" && typeof (v as { command?: unknown }).command === "string") return (v as { command: string }).command; } catch { /* 不是 JSON：原样使用 */ }
  return raw;
}
function stallInputLabel(raw: string): string { return bounded(stallCommand(raw), 90).text.replace(/\s+/g, " "); }
/**
 * 命令自己声明的静默等待：开头连续的 `sleep N`（可带 s/m/h，以 ; 或 && 衔接）本来就不会有输出，
 * 这段时间不算卡住。只认命令开头，后面的检查命令仍然按静默时长计。
 */
function declaredWaitMs(command: string): number {
  let total = 0, rest = command.trim();
  for (;;) {
    const m = /^sleep\s+(\d+(?:\.\d+)?)([smh]?)\s*(?:;|&&|$)\s*/.exec(rest);
    if (!m) break;
    total += Number(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600 }[m[2]!] ?? 1) * 1000;
    rest = rest.slice(m[0].length);
  }
  return total;
}
/** 工具自己声明的等待：bash 开头的 sleep，或 bash_output 的 wait_seconds（等后台任务结束，期间没有输出是正常的）。 */
function declaredWaitFor(name: string, raw: string): number {
  if (name === "bash_output") {
    try { const v = (JSON.parse(raw) as { wait_seconds?: unknown }).wait_seconds; return typeof v === "number" && v > 0 ? v * 1000 : 0; } catch { return 0; }
  }
  return declaredWaitMs(stallCommand(raw));
}
/**
 * 提醒只陈述事实和下一步（时长与命令就是证据），不猜原因。
 * quietMs 是「多久没有新输出」：runtime 回传过输出（Pi）就按静默时长报，没回传过就只能按总时长报。
 */
function stallNotice(name: string, input: string, markMs: number, abortMs: number, kind: "quiet" | "running" | "overdue"): string {
  const what = kind === "quiet" ? `已 ${stallMinutes(markMs)} 分钟没有新输出` : kind === "overdue" ? `已超出命令里写明的等待时间 ${stallMinutes(markMs)} 分钟仍未结束` : `已运行 ${stallMinutes(markMs)} 分钟`;
  const head = `${name} ${what}${input ? `：${input}` : ""}。`;
  if (markMs < abortMs && abortMs - markMs <= 300_000) return `${head}还在跑就继续等；卡住了可以点停止，${stallMinutes(abortMs - markMs)} 分钟后会自动中止（可在「授权」入口关掉自动中止）。`;
  if (markMs >= 600_000) return `${head}建议停止这一轮，把范围改小再重跑。`;
  return `${head}还在跑就继续等；卡住了可以点停止，或把命令范围改小。`;
}
/**
 * 自动额度刷新走 stale-while-revalidate：快照超过 60 秒就在后台单飞刷新，但请求立即返回现有快照。
 * Claude 的原生额度查询会启动一次 Agent SDK，稳定耗时 3–4 秒；15 秒一次的自动轮询不能等它。
 */
const RATE_AUTO_REFRESH_MS = 60_000;
/** 自动刷新失败或快照过期后的最小重试间隔，避免每次轮询都启动原生查询。 */
const RATE_AUTO_RETRY_MS = 30_000;
/**
 * 真实调用报认证失败后自动补一次在线认证的延迟：等本轮原生进程收尾，也给用户重新登录留出时间。
 * 只认在线认证证据（Claude 的 authVerified），没通过就保留「待登录」，不降级成启动失败。
 */
const AUTH_AUTO_VERIFY_DELAY_MS = 5_000;
const BINARY_WATCH_MS = 60_000;

type SampledRateLimit = Omit<RateLimitSnapshot, "identityScopeId" | "runtimeKind">;

/**
 * 运行中采样的单窗口与已有快照合并：同名窗口更新，其余保留。
 * Claude 的 rate_limit_event 常常只带窗口类型和重置时间、不带 utilization；
 * 这时同一窗口（上次的重置时间还没到）已知的已用比例要保留，不能被 null 覆盖成「?」。
 * 没带任何比例的采样也不刷新 sampledAt / source，好让定时额度查询照常补上真实数值。
 */
export function mergeSampledRateLimit(prev: SampledRateLimit | undefined, s: SampledRateLimit, now = Date.now()): SampledRateLimit {
  const windows = [...(prev?.windows ?? [])];
  for (const w of s.windows) {
    const i = windows.findIndex((x) => x.label === w.label && x.group === w.group);
    const old = i >= 0 ? windows[i]! : undefined;
    const sameWindow = old?.usedPercent != null && Date.parse(old.resetsAt ?? "") > now;
    const merged = w.usedPercent == null && sameWindow ? { ...w, usedPercent: old!.usedPercent, ...(old!.windowMinutes != null && w.windowMinutes == null ? { windowMinutes: old!.windowMinutes } : {}) } : w;
    if (i >= 0) windows[i] = merged; else windows.push(merged);
  }
  const informative = !prev || s.windows.some((w) => w.usedPercent != null);
  const { reason: _prevReason, ...base } = prev ?? ({} as Partial<SampledRateLimit>);
  return {
    ...base, ...s, windows,
    ...(informative ? {} : { sampledAt: prev!.sampledAt, source: prev!.source, ...(prev!.experimental !== undefined ? { experimental: prev!.experimental } : {}) })
  } as SampledRateLimit;
}

export class RuntimeSessionManager extends EventEmitter {
  private recordAccessProvider?: (binding: SessionBinding, turnId: string) => {contextFile:string;clientPath:string};
  setRecordAccessProvider(provider: (binding:SessionBinding,turnId:string)=>{contextFile:string;clientPath:string}): void {this.recordAccessProvider=provider;}

  readonly store: RuntimeStore;
  readonly drivers: Record<RuntimeKind, RuntimeDriver>;
  private readonly sharedSlots: SharedSlots;
  private projectAdmissionSource?: (projectId: string) => ProjectAdmissionPolicy | undefined;
  private readonly slotOwner = randomUUID();
  private slotTimer?: NodeJS.Timeout;
  private sharedReconciliation?: Promise<void>;
  private slotFacts = new Map<string, { scope: string; outcome: "completed" | "not-executed"; sourceRef: string }>();
  private usageFacts = new Map<string, { scope: string; receipt: NativeTurnUsageReceipt }>();
  private queueRetirements = new Map<string, { scope: string; sourceRef: string }>();
  private running = new Map<string, Running>();
  private dispatches = new Set<Promise<void>>();
  private worktreeCleanups = new Map<string, Promise<SessionBinding>>();
  private pending = new Map<string, PendingApproval>();
  private draining = false;
  private finishQueuedOnDrain = false;
  private shuttingDown = false;
  /** 一轮刚结束、原生指纹还没刷新的会话：此时续聊会把自己这轮的写入误判为外部写入，排队消息等指纹刷新后再发 */
  private fingerprintPending = new Set<string>();
  private continuationTimers = new Map<string, NodeJS.Timeout>();
  private continuationFinalizers = new Map<string, { turnNo: number; stopRequested: boolean }>();
  private continuationFinalizing = new Set<string>();
  /** 强约束自动反馈：上一次发出反馈的那一轮与已重试次数（人发新消息后轮号对不上，自然清零） */
  private enforcement = new Map<string, { turnNo: number; attempt: number; since: number }>();
  /** 「界面打磨」交付检查的补救进度（与记忆强约束分开计数，同样最多 MAX_ENFORCEMENT_RETRIES 次） */
  private uiReportEnforcement = new Map<string, { turnNo: number; attempt: number; since: number }>();
  /** 回合开始时的工作区快照（强约束「按结果取证」用）：会话 → 回合号 → 快照；只留最近几轮，校验结束就清掉 */
  private workspaceBaselines = new Map<string, Map<number, WorkspaceSnapshot>>();
  /** 取证项（发布状态、线上部署）回合开始时的状态：会话 → 回合号 → 取证项 id → 状态；和工作区快照同一生命周期 */
  private probeBaselines = new Map<string, Map<number, Record<string, unknown>>>();
  private evidenceReaders: ProbeReaders = {};
  private outboxSending = new Set<string>();
  private reservationTimers = new Map<string, NodeJS.Timeout>();
  private quotaTimers = new Map<string, NodeJS.Timeout>();
  /** runtime → 认证失败后的自动复核计时（每类只排一个，避免重试风暴） */
  private authVerifyTimers = new Map<RuntimeKind, NodeJS.Timeout>();
  private readonly authAutoVerifyDelayMs: number;
  /** runtime 二进制升级自检：上一轮看到的指纹（连续两轮不变才动手，避免升级写文件到一半就探测）与已自动探测过的指纹（同一指纹只探一次） */
  private binarySeen = new Map<RuntimeKind, string>();
  private binaryProbed = new Map<RuntimeKind, string>();
  private binaryWatchTimer?: NodeJS.Timeout;
  /** 正在等 runtime 应答的插话：`${pid}|${messageId}` */
  private steeringInFlight = new Set<string>();
  /** 卡住看门狗：会话 → 当前在跑的工具；只有非终态工具在表里，本轮结束就清 */
  private stalls = new Map<string, { key: string; name: string; input: string; startedAt: number; /** 最近一次看到新输出的时刻；没回传过输出就等于 startedAt */ lastActiveAt: number; /** 命令自己声明的静默等待（sleep N），不计入卡住时长 */ waitMs: number; sawOutput: boolean; lastOutput: string; turnNo?: number; alerted: Set<number>; aborted: boolean }>();
  private stallTimer?: NodeJS.Timeout;
  private readonly stallGuard: { shellMs: number[]; browserMs: number[]; abortMs: number; tickMs: number };
  private readonly titleWorker?: SessionTitleWorker;
  private readonly quickReplyService?: QuickReplyService;
  private readonly approvalTtlMs: number;
  private readonly questionTtlMs: number;
  private readonly historyCacheMs: number;
  private historyCache = new Map<RuntimeKind, { at: number; rootsKey: string; items: HistoryItem[]; coverage: string; notes: string[] }>();
  private readCache = new Map<string, { at: number; read: HistoryRead; seqd: ProjectedEvent[] }>();
  private discovered = new Map<string, { kind: RuntimeKind; item: HistoryItem }>();
  private partialTimers = new Map<string, NodeJS.Timeout>();
  private rateLimitRequests = new Map<string, Promise<RateLimitSnapshot | undefined>>();
  private rateLimitAttempts = new Map<string, number>();
  private rateLimitFailures = new Set<string>();
  readonly attachments: AttachmentStore;
  readonly recovered: Promise<void>;

  constructor(opts: ManagerOptions) {
    super();
    this.setMaxListeners(200);
    this.store = new RuntimeStore(opts.dataDir);
    const migrated = this.store.migratePiNativePermissions();
    if (migrated.length) this.store.audit({ type: "pi-native-default-migration", sessions: migrated });
    // 已归档会话的逐次用量压缩成每小时 × 模型合计（一次性；之后每次归档时压缩）。失败不影响启动。
    try { const n = this.store.compactArchivedUsage(); if (n) this.store.audit({ type: "usage-compacted", sessions: n }); }
    catch (e) { console.error("归档会话用量压缩失败：", e); }
    this.attachments = new AttachmentStore(this.store.dir);
    // Durable accepted operations pin refs before expired draft cleanup, even after a crash before attach.
    for (const op of this.store.allOperations()) if (op.imageInput && this.store.binding(op.platformSessionId)) {
      try { this.attachments.restoreReferences(op.imageInput.attachmentIds, op.imageInput.owner, op.platformSessionId); }
      catch (e) { this.store.audit({ type: "image-reference-missing", operationId: op.operationId, reason: String(e) }); }
    }
    this.attachments.cleanup();
    this.sharedSlots = new SharedSlots(opts.sharedSlotsDir ?? join(this.store.dir, "shared-slots"));
    this.drivers = { codex: opts.drivers?.codex ?? new CodexDriver({ evaluationRoot: join(this.store.dir, "codex-evaluation") }), "claude-code": opts.drivers?.["claude-code"] ?? new ClaudeDriver({ evaluationRoot: join(this.store.dir, "claude-evaluation") }), pi: opts.drivers?.pi ?? new PiDriver({ sessionDir: join(this.store.dir, "pi-sessions") }), antigravity: opts.drivers?.antigravity ?? new AntigravityDriver({ stateDir: join(this.store.dir, "antigravity-probe") }) };
    this.approvalTtlMs = opts.approvalTtlMs ?? 0;
    this.stallGuard = { ...STALL_GUARD, ...(opts.stallGuard ?? {}) };
    this.authAutoVerifyDelayMs = opts.authAutoVerifyDelayMs ?? AUTH_AUTO_VERIFY_DELAY_MS;
    this.questionTtlMs = opts.questionTtlMs ?? 0;
    this.historyCacheMs = opts.historyCacheMs ?? 30_000;
    if (opts.platformSkills) {
      this.platformSkillsRoot = opts.platformSkills.root ?? PLATFORM_SKILLS_ROOT;
      if (opts.platformSkills.switchesFile) this.platformSkillSwitches = new PlatformSkillSwitches(opts.platformSkills.switchesFile, this.platformSkillsRoot);
    }
    if (opts.titlePort) this.titleWorker = new SessionTitleWorker(this.store, opts.titlePort, id => {
      this.emit("session", { platformSessionId: id });
      this.emit("directory", {});
    }, () => this.draining || this.shuttingDown);
    if (opts.titlePort) this.quickReplyService = new QuickReplyService(opts.titlePort, entry => this.store.audit(entry));
    // Retry persisted terminal facts and cross-manager queue admission without expiring leases.
    for (const op of this.store.allOperations()) {
      const fact = op.steps.find(x => x.step === "shared-slot-terminal");
      const b = this.store.binding(op.platformSessionId);
      const usage = op.steps.find(x => x.step === "native-turn-usage");
      if (usage && b) {
        try { this.usageFacts.set(op.operationId, { scope: b.identityScopeId, receipt: this.validateTurnUsage(op, b, JSON.parse(usage.detail)) }); }
        catch (error) { this.store.audit({ type: "native-usage-rejected", operationId: op.operationId, reason: String(error) }); }
      }
      const retired = op.steps.find(x => x.step === "shared-queue-cancelled");
      if (retired && b) this.queueRetirements.set(op.operationId, { scope: b.identityScopeId, sourceRef: `runtime-operation:${op.operationId}:shared-queue-cancelled` });
      if (fact && b) {
        const outcome = fact.detail === "not-executed" ? "not-executed" : fact.detail === "completed" ? "completed" : undefined;
        if (outcome) this.slotFacts.set(op.operationId, { scope: b.identityScopeId, outcome, sourceRef: `runtime-operation:${op.operationId}:shared-slot-terminal` });
      } else if (b && op.steps.some(s => s.step === "process-ended" && s.detail.trim()) && op.steps.some(s => s.step === "shared-slot-reserved" && s.detail === b.identityScopeId)) {
        // A crash between persisting the executor exit and recording the release must not strand capacity.
        this.slotFacts.set(op.operationId, { scope: b.identityScopeId, outcome: "completed", sourceRef: `runtime-operation:${op.operationId}:process-ended` });
      }
    }
    this.slotTimer = setInterval(() => { this.flushSlotFacts(); this.schedule(); }, 100);
    this.slotTimer.unref();
    this.binaryWatchTimer = setInterval(() => this.watchBinaries(), opts.binaryWatchMs ?? BINARY_WATCH_MS);
    this.binaryWatchTimer.unref();
    this.recovered = opts.skipRecovery ? Promise.resolve() : this.recover().catch((e) => { console.error("外部会话重启核对失败：", e); });
  }

  /* ============================ 设置与 profile ============================ */

  settings(): RuntimeSettings { return this.store.settings(); }

  workspaceRoots(kind: RuntimeKind): string[] {
    const settings = this.settings();
    return settings.workspaceRootsByRuntime?.[kind] ?? settings.workspaceRoots;
  }

  private driver(kind: RuntimeKind): RuntimeDriver {
    const driver = this.drivers[kind];
    if (!driver) throw new RuntimeError(`${RUNTIME_LABEL[kind]} 驱动尚不可用`, 409, "RT_INCOMPATIBLE");
    return driver;
  }

  /** 动态热替换某个 runtime 的驱动（例如开源版按需安装组件后立即启用，无需重启服务）。 */
  setDriver(kind: RuntimeKind, driver: RuntimeDriver): void {
    const prev = this.drivers[kind];
    if (prev && prev !== driver) {
      try { prev.shutdown(); } catch { /* 旧驱动收尾异常不影响新驱动注册 */ }
    }
    this.drivers[kind] = driver;
    this.binarySeen.delete(kind);
    this.binaryProbed.delete(kind);
    this.emit("profiles", {});
  }

  updateSettings(next: Omit<Partial<RuntimeSettings>, "history"> & { history?: Partial<RuntimeSettings["history"]> }, actor: string): RuntimeSettings {
    const cur = this.store.settings();
    const capacity = next.maxRunningPerProfile === undefined ? cur.maxRunningPerProfile : next.maxRunningPerProfile;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) throw new RuntimeError("共享账号调用上限必须是 1–8 的整数", 400, "RT_INPUT");
    const merged: RuntimeSettings = {
      ...cur, ...next,
      history: { ...cur.history, ...(next.history ?? {}) },
      workspaceRootsByRuntime: { ...cur.workspaceRootsByRuntime, ...next.workspaceRootsByRuntime },
      enabledModelsByRuntime: { ...cur.enabledModelsByRuntime, ...next.enabledModelsByRuntime },
      defaultSessionByRuntime: { ...cur.defaultSessionByRuntime, ...next.defaultSessionByRuntime },
      maxRunningPerProfile: capacity
    };
    for (const kind of RUNTIME_KINDS) {
      const models = merged.enabledModelsByRuntime?.[kind];
      if (models === undefined) continue;
      if (!Array.isArray(models) || models.some((m) => typeof m !== "string" || !m.trim())) throw new RuntimeError("可选模型必须是模型 id 的字符串数组", 400, "RT_INPUT");
      if (!models.length) throw new RuntimeError(`${RUNTIME_LABEL[kind]} 至少要勾选一个可选模型`, 400, "RT_INPUT");
    }
    for (const root of [...merged.workspaceRoots, ...Object.values(merged.workspaceRootsByRuntime ?? {}).flatMap((roots) => roots ?? []), ...Object.values(merged.history).flatMap((h) => h.roots)]) {
      if (!root.startsWith("/")) throw new RuntimeError(`根目录必须是绝对路径：${root}`, 400, "RT_INPUT");
      if (!existsSync(root) || !statSync(root).isDirectory()) throw new RuntimeError(`目录不存在：${root}`, 400, "RT_INPUT");
    }
    // 撤销：被移除的历史根停止观察并清理索引/缓存（V28-18）；不删除原生 transcript
    for (const kind of RUNTIME_KINDS) {
      const before = cur.history[kind];
      const after = merged.history[kind];
      const removed = before.roots.filter((r) => !after.enabled || !after.roots.includes(r));
      const narrowed = (after.originators ?? []).length > 0 && (after.originators ?? []).join("|") !== (before.originators ?? []).join("|");
      if (removed.length || (before.enabled && !after.enabled) || narrowed) {
        this.historyCache.delete(kind);
        for (const [k, v] of this.readCache) if (k.startsWith(`${kind}:`) && !(after.enabled && underRoots(v.read.workspace, after.roots))) this.readCache.delete(k);
        for (const [id, d] of this.discovered) if (d.kind === kind) this.discovered.delete(id);
        this.store.audit({ type: "history-revoked", runtimeKind: kind, removedRoots: removed.length, disabled: before.enabled && !after.enabled, actor });
      }
    }
    if (next.maxRunningPerProfile !== undefined) {
      const scopes = new Set([...Object.values(this.store.profiles()).flatMap(p => p.identity ? [p.identity.identityScopeId] : []), ...this.store.allBindings().map(b => b.identityScopeId)]);
      for (const scope of scopes) {
        if (this.sharedSlots.configure(scope, merged.maxRunningPerProfile, `settings:${actor}:${randomUUID()}`).status === "busy") throw new RuntimeError("共享账号名额正在更新，请重试", 409, "RT_BUSY");
      }
    }
    this.store.saveSettings(merged);
    this.store.audit({ type: "settings-updated", actor, publicControl: merged.publicControl, publicHistory: merged.publicHistory, workspaceRoots: merged.workspaceRoots.length });
    this.emit("directory", {});
    return this.store.settings();
  }

  /** Host projection only; project agents and chat request bodies do not choose their limits. */
  setProjectAdmissionSource(source: (projectId: string) => ProjectAdmissionPolicy | undefined): void { this.projectAdmissionSource = source; }

  profiles(): Array<RuntimeProfile & { rateLimit?: RateLimitSnapshot & { stale: boolean } }> {
    const all = this.store.profiles();
    return RUNTIME_KINDS.map((k) => all[this.profileId(k)]).filter((p): p is RuntimeProfile => !!p).map((p) => {
      const rl = p.identity ? this.rateLimitFor(p.identity.identityScopeId) : undefined;
      return { ...p, ...(rl ? { rateLimit: rl } : {}) };
    });
  }

  profileId(kind: RuntimeKind): string { return `${kind}@${this.store.host.hostId}`; }
  profile(kind: RuntimeKind): RuntimeProfile | undefined { return this.store.profiles()[this.profileId(kind)]; }

  private rateLimitFor(identityScopeId: string): (RateLimitSnapshot & { stale: boolean }) | undefined {
    const s = this.store.rateLimits()[identityScopeId];
    return s ? { ...s, stale: this.rateLimitFailures.has(identityScopeId) || Date.now() - Date.parse(s.sampledAt) > RATE_STALE_MS } : undefined;
  }

  /**
   * CLI 升级后自动重新检测：桌面 App 升级会原地替换 Codex 二进制，而平台存的是上一次检测的快照
   * （模型目录、版本、能力），不重测就会一直停在旧版本能看到的模型上。
   * 判定：二进制路径变了，或修改时间晚于上次检测时间。只看已检测过的 runtime，没人检测过的不替它做。
   */
  private watchBinaries(): void {
    if (this.shuttingDown) return;
    for (const kind of RUNTIME_KINDS) {
      const stamp = this.drivers[kind]?.binaryStamp?.();
      if (!stamp) continue;
      const key = `${stamp.path}|${stamp.mtimeMs}`;
      const stable = this.binarySeen.get(kind) === key;
      this.binarySeen.set(kind, key);
      const prev = this.profile(kind);
      if (!stable || !prev || this.binaryProbed.get(kind) === key) continue;
      const checkedAt = Date.parse(prev.checkedAt);
      if (prev.binaryPath === stamp.path && !(stamp.mtimeMs > checkedAt)) continue;
      this.binaryProbed.set(kind, key);
      void this.probe(kind).then((next) => {
        this.store.audit({ type: "runtime-binary-changed", runtimeKind: kind, path: stamp.path, from: prev.binaryVersion ?? null, to: next.binaryVersion ?? null, models: next.models.length });
      }).catch((e) => this.store.audit({ type: "runtime-binary-reprobe-failed", runtimeKind: kind, reason: bounded(String(e), 200).text }));
    }
  }

  /** 只读兼容性/认证检查：不执行模型任务 */
  async probe(kind: RuntimeKind, opts: { reloggedIn?: boolean; autoVerify?: boolean } = {}): Promise<RuntimeProfile> {
    const failureBeforeProbe = this.profile(kind)?.lastAuthFailure;
    const out = await this.driver(kind).probe();
    const prev = this.profile(kind);
    // A failed/logged-out probe is not evidence of an account switch. Keep the
    // last partition for recovery, but the non-executable state still blocks use.
    const authenticated = out.state === "executable" && !!out.identity;
    const identity = authenticated ? this.deriveIdentity(kind, out.identity!) : prev?.identity;
    // Claude must prove a live authenticated request, even for a manual relogin
    // confirmation. Never erase a failure that arrived while this probe ran.
    const sameFailure = prev?.lastAuthFailure?.at === failureBeforeProbe?.at
      && prev?.lastAuthFailure?.platformSessionId === failureBeforeProbe?.platformSessionId
      && prev?.lastAuthFailure?.message === failureBeforeProbe?.message;
    const recovered = sameFailure && (kind === "claude-code" || kind === "antigravity" ? authenticated && out.authVerified === true : opts.reloggedIn === true);
    const authFailure = recovered ? undefined : prev?.lastAuthFailure;
    if (recovered && prev?.lastAuthFailure) this.store.audit({ type: opts.reloggedIn ? "auth-relogin-confirmed" : "auth-recovered", runtimeKind: kind, ...(opts.autoVerify ? { auto: true } : {}) });
    if (opts.autoVerify && !recovered && prev?.state === "needs-login") {
      // 自动复核只负责确认恢复：没通过就保留「待登录」并写明复核结论（不降级成启动失败，也不掩盖原因）
      out.state = "needs-login";
      out.stateReason = `真实调用认证失败（${authFailure?.message ?? "认证失败"}）；自动复核在线认证未通过（${bounded(out.stateReason ?? out.state, 160).text}）。请在本机重新登录 ${RUNTIME_LABEL[kind]} 后点"已重新登录，重新检查"`;
    } else if (authFailure && out.state === "executable") {
      out.state = "needs-login";
      out.stateReason = kind === "claude-code" || kind === "antigravity"
        ? `最近一次真实调用认证失败（${authFailure.message.slice(0, 160)}）。在线认证尚未确认恢复；请在本机重新登录后点击检查。`
        : `最近一次真实调用认证失败（${authFailure.message.slice(0, 160)}）。请在本机重新登录 ${RUNTIME_LABEL[kind]}，再点"已重新登录，重新检查"`;
    }
    const profile: RuntimeProfile = {
      profileId: this.profileId(kind), runtimeKind: kind, hostId: this.store.host.hostId, hostLabel: this.store.host.label,
      ...(identity ? { identity } : {}),
      ...(out.binaryPath ? { binaryPath: out.binaryPath } : {}), ...(out.binaryVersion ? { binaryVersion: out.binaryVersion } : {}), ...(out.sdkVersion ? { sdkVersion: out.sdkVersion } : {}),
      transport: kind === "codex" ? "app-server-stdio" : kind === "pi" ? "pi-rpc" : kind === "antigravity" ? "acp-stdio" : "agent-sdk",
      state: out.state, stateReason: out.stateReason, capabilities: out.capabilities, models: out.models,
      ...(out.browserProfiles ? { browserProfiles: out.browserProfiles } : {}),
      permissions: out.permissions, ...(out.permissionOptions ? { permissionOptions: out.permissionOptions } : {}), configSummary: out.configSummary, checkedAt: new Date().toISOString(),
      ...(authFailure ? { lastAuthFailure: authFailure } : {}),
      ...(prev?.lastQuotaFailure ? { lastQuotaFailure: prev.lastQuotaFailure } : {})
    };
    // 身份空间或 binary 变了：不静默改绑已有会话；旧会话按原身份空间保留，记审计
    if (prev?.identity && identity && prev.identity.identityScopeId !== identity.identityScopeId) {
      this.store.audit({ type: "identity-changed", runtimeKind: kind, from: prev.identity.identityScopeId, to: identity.identityScopeId });
    }
    this.store.saveProfile(profile);
    if (authenticated && identity && out.rateLimit) this.store.saveRateLimit({ ...out.rateLimit, identityScopeId: identity.identityScopeId, runtimeKind: kind });
    this.emit("profiles", {});
    return profile;
  }

  /**
   * §6.1 身份分区：有稳定账号 ID 时按 (runtimeKind, hostId, authMode, stableAccountId) 带版本前缀哈希；
   * 否则生成持久分区 ID，指纹（不含凭据）变化即换新分区。不对凭据求哈希，不凭邮箱合并。
   */
  deriveIdentity(kind: RuntimeKind, id: NonNullable<Awaited<ReturnType<RuntimeDriver["probe"]>>["identity"]>): IdentityScope {
    const base = { source: id.source, authMode: id.authMode, summary: id.summary };
    if (id.stableAccountId) {
      const h = createHash("sha256").update(`${kind}|${this.store.host.hostId}|${id.authMode}|${id.stableAccountId}`).digest("hex").slice(0, 24);
      return { ...base, identityScopeId: `id1:${h}`, derivation: "stable-account-id", accountKnown: true };
    }
    const key = this.profileId(kind);
    const fp = createHash("sha256").update(id.fingerprint).digest("hex").slice(0, 24);
    const p = this.store.getOrCreateIdentityPartition(key, fp);
    return { ...base, identityScopeId: p.partitionId, derivation: "persistent-partition", accountKnown: false };
  }

  async refreshRateLimit(kind: RuntimeKind, opts: { automatic?: boolean } = {}): Promise<RateLimitSnapshot | undefined> {
    const p = this.profile(kind);
    if (!p?.identity) throw new RuntimeError("先检查连接，确定账号身份后才能读取额度", 409, "RT_PROFILE");
    const scope = p.identity.identityScopeId;
    const now = Date.now(), cached = this.rateLimitFor(scope);
    const sampled = Date.parse(cached?.sampledAt ?? "");
    const aged = Number.isFinite(sampled) ? now - sampled : Infinity;
    const crossedReset = !!cached?.windows.some(w => {
      const reset = Date.parse(w.resetsAt ?? "");
      return reset <= now && sampled < reset;
    });
    const pending = this.rateLimitRequests.get(scope);
    // 自动请求：有快照就立即返回，过期 / 跨重置点时后台刷新（单飞），新值由 profiles 事件推给页面。
    // 没有快照（首次）才等待一次原生查询。
    if (opts.automatic && cached) {
      const due = crossedReset || aged >= RATE_AUTO_REFRESH_MS;
      if (due && !pending && now - (this.rateLimitAttempts.get(scope) ?? -Infinity) >= RATE_AUTO_RETRY_MS) {
        void this.startRateLimitRefresh(kind, scope).catch(() => { /* 失败保留上次数值，按退避节奏再试 */ });
      }
      return cached;
    }
    // 手动刷新仍等待最新结果；已有在飞请求时共用，避免重复启动原生进程。
    if (pending) return pending;
    return this.startRateLimitRefresh(kind, scope);
  }

  /** 单飞的原生额度查询；成功 / 失败都会更新快照与失败标记，并通知页面刷新。 */
  private startRateLimitRefresh(kind: RuntimeKind, scope: string): Promise<RateLimitSnapshot | undefined> {
    const pending = this.rateLimitRequests.get(scope);
    if (pending) return pending;
    this.rateLimitAttempts.set(scope, Date.now());
    const request = (async () => {
      try {
        const rl = await this.driver(kind).rateLimits();
        // 查询途中切换账号或关闭服务：不能把迟到数据写回原身份空间。
        if (this.shuttingDown || this.profile(kind)?.identity?.identityScopeId !== scope) return undefined;
        if (!rl) throw new RuntimeError("runtime 没有返回账户额度快照", 503, "RT_QUOTA_UNAVAILABLE");
        const snap: RateLimitSnapshot = { ...rl, identityScopeId: scope, runtimeKind: kind };
        this.store.saveRateLimit(snap);
        this.rateLimitFailures.delete(scope);
        this.emit("profiles", { rateLimit: true });
        return snap;
      } catch (e) {
        if (!this.shuttingDown && this.profile(kind)?.identity?.identityScopeId === scope) {
          this.rateLimitFailures.add(scope);
          this.emit("profiles", { rateLimit: true });
        }
        throw e;
      } finally { this.rateLimitRequests.delete(scope); }
    })();
    this.rateLimitRequests.set(scope, request);
    return request;
  }

  /* ============================ 创建 ============================ */

  /**
   * 手动新建会话只能用运行时配置里勾选的模型；没有配置过 = 全部可选。
   * 不选模型时按运行时默认模型核对：默认模型没被勾选就要求明确选择。项目内部的角色会话不经过这里。
   */
  checkSelectableModel(kind: RuntimeKind, model: string | undefined): void {
    const allowed = this.store.settings().enabledModelsByRuntime?.[kind];
    if (!allowed) return;
    const profile = this.profile(kind);
    const effective = model?.trim() || (profile ? (profile.models.find((m) => m.isDefault) ?? (kind === "pi" ? profile.models[0] : undefined))?.id : undefined);
    if (!effective) throw new RuntimeError("运行时配置限定了可选模型，请选择一个已勾选的模型", 400, "RT_MODEL");
    if (!allowed.includes(effective)) throw new RuntimeError(`模型 ${effective} 没有在运行时配置中勾选，不能用于新建会话`, 403, "RT_MODEL");
  }

  setDraining(on: boolean, finishQueued = false): void {
    const was = this.draining;
    this.draining = on; this.finishQueuedOnDrain = on && finishQueued;
    this.store.audit({ type: on ? "drain-start" : "drain-release" });
    this.schedule();
    // 部署取消/失败时旧服务继续运行：排空期间压在队列里的首条消息要接着发
    if (was && !on) void this.resumeHeldOutboxes();
  }
  isDraining(): boolean { return this.draining; }

  private checkWorkspace(workspace: string, kind: RuntimeKind): string {
    if (!workspace.startsWith("/")) throw new RuntimeError("工作目录必须是绝对路径", 400, "RT_INPUT");
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new RuntimeError(`工作目录不存在：${workspace}`, 400, "RT_INPUT");
    const real = realpathSync(workspace);
    const roots = this.workspaceRoots(kind);
    if (!roots.length) throw new RuntimeError("还没有配置允许的工作目录根（运行时 → 设置，仅本机可改）", 403, "RT_WORKSPACE");
    if (!underRoots(real, roots)) throw new RuntimeError(`工作目录不在允许的根范围内：${real}`, 403, "RT_WORKSPACE");
    return real;
  }

  /**
   * 新建会话时在网页里逐级浏览文件夹：只列允许的工作目录根之内的子目录（不含隐藏目录与文件）。
   * 不传 path 时列出各个根本身；对外入口也能用，不依赖本机的系统对话框。
   */
  browseFolders(kind: RuntimeKind, path?: string): FolderListing {
    const roots = this.workspaceRoots(kind);
    if (!roots.length) throw new RuntimeError("还没有配置允许的工作目录根（运行时 → 设置，仅本机可改）", 403, "RT_WORKSPACE");
    const realRoots = roots.flatMap((r) => { try { return [realpathSync(r)]; } catch { return []; } });
    if (!path) return { path: null, parent: null, roots, entries: realRoots.map((r) => ({ name: r, path: r })), truncated: false };
    if (!path.startsWith("/")) throw new RuntimeError("文件夹必须是绝对路径", 400, "RT_INPUT");
    let real: string;
    try { real = realpathSync(path); if (!statSync(real).isDirectory()) throw new Error("not a directory"); }
    catch { throw new RuntimeError(`文件夹不存在：${path}`, 400, "RT_INPUT"); }
    if (!underRoots(real, roots)) throw new RuntimeError(`文件夹不在允许的根范围内：${real}`, 403, "RT_WORKSPACE");
    const names: string[] = [];
    for (const d of readdirSync(real, { withFileTypes: true })) {
      if (d.name.startsWith(".")) continue;
      let dir = d.isDirectory();
      if (d.isSymbolicLink()) { try { const t = realpathSync(join(real, d.name)); dir = statSync(t).isDirectory() && underRoots(t, roots); } catch { dir = false; } }
      if (dir) names.push(d.name);
    }
    names.sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
    const up = dirname(real);
    return {
      path: real, parent: up !== real && underRoots(up, roots) ? up : null, roots,
      entries: names.slice(0, FOLDER_LIST_MAX).map((name) => ({ name, path: join(real, name) })), truncated: names.length > FOLDER_LIST_MAX
    };
  }

  async create(input: CreateInput, actor: string): Promise<{ session: SessionBinding; operation: OperationRecord; replayed: boolean }> {
    const key = String(input.idempotencyKey ?? "").trim();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new RuntimeError("缺少有效的 idempotencyKey", 400, "RT_INPUT");
    const attachments = this.attachments.resolve(input.attachmentIds, actor);
    const inputHash = this.imageInputHash(input, attachments);
    const existing = this.store.operationByKey(key);
    if (existing) {
      if (existing.inputHash && existing.inputHash !== inputHash) throw new RuntimeError("idempotencyKey 已用于另一条消息或配置", 409, "RT_CONFLICT");
      if (existing.kind !== "create") throw new RuntimeError("idempotencyKey 已用于别的操作", 409, "RT_CONFLICT");
      return { session: this.store.binding(existing.platformSessionId)!, operation: existing, replayed: true };
    }
    const scheduledFor = this.reservationTime(input.scheduledFor);
    if (scheduledFor && (input.roomRef || input.comparisonRef || input.projectRef || input.role || input.evaluation)) throw new RuntimeError("预约消息只支持普通单聊", 400, "RT_INPUT");
    const deferFirstTurn = !!scheduledFor || !!input.deferFirstTurn || (this.draining && !!input.deferWhenDraining);
    if (this.draining && !deferFirstTurn) throw new RuntimeError("服务即将重启（部署排空中），暂停新的创建；草稿已保留", 503, "RT_DRAINING");
    const validated = this.validateCreate(input);
    const { profile, identity, prompt, model, effort, permissionMode, permissions, evaluation, role } = validated;
    const generateTitle = !!this.titleWorker && !input.title?.trim() && !input.comparisonRef && !input.roomRef && !input.projectRef && !role && !evaluation;
    let workspace = validated.workspace;
    this.checkImageInput(profile, model, attachments);
    if (attachments.length && (input.roomRef || input.comparisonRef || input.projectRef || input.evaluation)) throw new RuntimeError("首期图片附件仅支持普通单会话", 400, "RT_INPUT");
    if (input.worktree && (input.roomRef || input.comparisonRef || input.projectRef || input.evaluation)) throw new RuntimeError("独立 worktree 只用于普通单会话", 400, "RT_INPUT");

    const now = new Date().toISOString();
    const platformSessionId = `rt-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    // 独立 worktree：从仓库的 main 切出这个会话专用的 worktree，会话在里面改（改动全属于它，可以由宿主提交）
    let worktree: SessionBinding["worktree"];
    if (input.worktree) {
      const info = await gitWorkspaceInfo(workspace);
      if (!info) throw new RuntimeError("工作目录不在 git 仓库里（或仓库还没有提交），不能用独立 worktree", 400, "RT_INPUT");
      if (!underRoots(info.repoRoot, this.workspaceRoots(input.runtimeKind))) throw new RuntimeError(`仓库根 ${info.repoRoot} 不在允许的工作目录根里，worktree 放不进去`, 400, "RT_INPUT");
      const base = await defaultBase(info.repoRoot);
      const path = sessionWorktreePath(info.repoRoot, platformSessionId);
      const branch = sessionWorktreeBranch(platformSessionId);
      try { await addSessionWorktree(info.repoRoot, path, branch, base.commit); }
      catch (e) { throw new RuntimeError((e as Error).message, 400, "RT_INPUT"); }
      const inner = info.subdir ? join(path, info.subdir) : path;
      if (!existsSync(inner)) {
        await removeSessionWorktreeIfMerged(info.repoRoot, path, branch, base.ref).catch(() => undefined);
        throw new RuntimeError(`子目录 ${info.subdir} 没有提交进 ${base.ref}，worktree 里没有它`, 400, "RT_INPUT");
      }
      worktree = { repoRoot: info.repoRoot, path, branch, baseRef: base.ref, baseCommit: base.commit, subdir: info.subdir };
      workspace = inner;
    }
    const operationId = `op-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const clientMessageId = randomUUID();
    const turn: TurnRecord = { turnNo: 1, status: "queued", operationId, promptPreview: bounded(prompt, LIMITS.preview).text, clientMessageId, ...(effort ? { effort } : {}) };
    const binding: SessionBinding = {
      platformSessionId, runtimeKind: input.runtimeKind, runtimeProfileId: profile.profileId, hostId: profile.hostId,
      identityScopeId: identity.identityScopeId, sourceMode: "platform-managed", executionMode: "runtime-native",
      title: input.title?.trim() ? bounded(input.title.trim(), 80).text : generateTitle ? "正在生成标题…" : autoSessionTitle(prompt),
      titleSource: input.title?.trim() ? "user" : generateTitle ? "pending" : "prompt",
      ...(generateTitle ? { titleGeneration: pendingSessionTitle(bounded(prompt, LIMITS.message).text) } : {}),
      ...(input.browserProfileId ? { browserProfileId: input.browserProfileId } : {}),
      workspace, ...(model ? { requestedModel: model } : {}), ...(effort ? { requestedEffort: effort } : {}), permissionMode, permissionLabel: permissions.label,
      ...(input.runtimeKind === "pi" ? { piPermissionPolicyVersion: 1 as const } : {}),
      ...(input.projectRef ? { projectRef: input.projectRef } : {}),
      ...(input.comparisonRef ? { comparisonRef: input.comparisonRef } : {}),
      ...(input.roomRef ? { roomRef: input.roomRef } : {}),
      ...(input.noteRef ? { noteRef: input.noteRef } : {}),
      ...(input.recordSourceRefs ? {recordSourceRefs:structuredClone(input.recordSourceRefs)} : {}),
      ...(input.platformSkillsExclude?.length ? { platformSkillsExclude: [...input.platformSkillsExclude] } : {}),
      ...(input.recommendationRef ? { recommendationRef: structuredClone(input.recommendationRef) } : {}),
      ...(worktree ? { worktree } : {}),
      ...(input.admissionClass ? { admissionClass: input.admissionClass } : {}),
      ...(evaluation ? { evaluation } : {}),
      ...(input.evaluationPolicyHash ? { evaluationPolicyHash: input.evaluationPolicyHash } : {}),
      ...(role ? { role: {
        definitionRef: role.definitionRef, templateVersion: role.templateVersion, instructionsHash: `sha256:${createHash("sha256").update(role.instructions, "utf8").digest("hex")}`,
        injection: input.runtimeKind === "codex" ? "codex.developerInstructions" as const : input.runtimeKind === "pi" ? "pi.appendSystemPrompt" as const : input.runtimeKind === "antigravity" ? "antigravity.systemPrompt.append" as const : "claude.systemPrompt.append" as const,
        evidence: { requested: true as const, runtimeConfirmed: "not_collected" as const }
      } } : {}),
      createdAt: { at: now, source: "platform" }, lastActivityAt: { at: now, source: "platform" },
      bindingRevision: 1, creationOperationId: operationId, status: "creating", statusReason: "提交中",
      observation: "live", turns: deferFirstTurn ? [] : [turn], coverage: "complete",
      ...(scheduledFor ? { scheduledCreate: true as const, outbox: [{ messageId: createHash("sha256").update(`first:${key}`).digest("hex").slice(0, 32), prompt, scheduledFor, actor, createdAt: now, ...(attachments.length ? { attachments } : {}), ...(effort ? { effort } : {}) }] } : {})
    };
    // Claude：平台预先分配原生会话 ID，响应丢失或重启后可按 ID 核对，不会建第二份
    const presetSessionId = input.runtimeKind !== "codex" && input.runtimeKind !== "antigravity" ? randomUUID() : undefined;
    const op: OperationRecord = {
      operationId, idempotencyKey: key, inputHash, ...(attachments.length ? { imageInput: { prompt, attachmentIds: attachments.map(a => a.attachmentId), owner: actor, model, effort } } : {}), kind: "create", platformSessionId, state: "prepared", createdAt: now, updatedAt: now, turnNo: 1,
      ...(presetSessionId ? { presetNativeId: presetSessionId } : {}),
      steps: [{ at: now, step: "prepared", detail: `${RUNTIME_LABEL[input.runtimeKind]} · ${workspace}${presetSessionId ? ` · 预分配会话 ID ${presetSessionId}` : ""}` }]
    };
    // 先持久化操作记录，再创建原生会话（§4.2 第 4 步）；角色正文先于绑定落盘，续聊与重启恢复都从这里取
    if (role) this.store.putRole(platformSessionId, role.instructions);
    if (deferFirstTurn) {
      // 群聊等人类 @；普通单聊在部署排空时只建会话、把首条消息放进排队，部署结束后再由新进程发出。
      binding.status = "idle"; binding.statusReason = scheduledFor ? "等待预约发送" : input.roomRef ? "等待人类 @" : "等待部署完成后发送";
      op.state = "confirmed"; delete op.turnNo;
      const publication = this.store.createSessionOperation(binding, op);
      // 首条消息的图片先绑定到会话，排队消息出队时还要用
      this.attachments.attach(attachments.map(a => a.attachmentId), actor, platformSessionId);
      this.emit("directory", {});
      this.emit("session", { platformSessionId });
      setImmediate(() => this.titleWorker?.wake());
      if (scheduledFor) void this.drainOutbox(platformSessionId);
      return publication;
    }
    let publication: { session: SessionBinding; operation: OperationRecord; replayed: boolean };
    try { publication = this.store.createSessionOperation(binding, op); }
    catch (e) { if (worktree) void removeSessionWorktreeIfMerged(worktree.repoRoot, worktree.path, worktree.branch, worktree.baseRef).catch(() => undefined); throw e; }
    if (publication.replayed) return publication;
    this.attachments.attach(attachments.map(a => a.attachmentId), actor, platformSessionId);
    const userEvent = this.store.upsertEvent(platformSessionId, {
      key: `user:${clientMessageId}`, kind: "message", role: "user", text: bounded(prompt, LIMITS.message).text, ...(attachments.length ? { attachments } : {}),
      source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", recordedAt: now, occurredAt: now, turnNo: 1
    });
    // 用户消息也走实时流：页面发送后不重新拉取对话，不推送就要等刷新才看到自己发的这条
    if (userEvent) this.emit("event", { platformSessionId, event: userEvent });
    this.store.audit({ type: "create", platformSessionId, runtimeKind: input.runtimeKind, workspace, ...(worktree ? { worktree: { branch: worktree.branch, baseRef: worktree.baseRef, baseCommit: worktree.baseCommit } } : {}), model: model ?? null, effort: effort ?? null, permissionMode, actor, operationId });
    this.pendingPrompts.set(operationId, { prompt, ...(attachments.length ? { attachmentIds: attachments.map(a => a.attachmentId) } : {}), ...(presetSessionId ? { presetSessionId } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    // 创建响应先离开进程，首轮再启动：同步阶段只登记共享队列的排队意图（跨 manager 的优先级要马上可见），
    // 真正的 dispatch（operations/bindings 整表 fsync、会话/目录广播、driver.startTurn）留到 setImmediate。
    // 以前 schedule() 会同步执行到 dispatch() 的第一个 await，真实 runtime 的这段要几百毫秒到数秒；
    // POST 因此会等到原生进程已经跑起来才返回，页面显示「创建成功」时工具已经执行了好几轮。
    try { this.schedule({ dispatch: false }); } catch (e) { console.error("创建后登记首轮排队失败：", e); }
    setImmediate(() => {
      try { this.schedule(); } catch (e) { console.error("创建后排空首轮失败：", e); }
      try { this.emit("directory", {}); } catch (e) { console.error("创建后广播目录失败：", e); }
    });
    // Yield creation first; title completion never delays the first native turn.
    setImmediate(() => this.titleWorker?.wake());
    return { session: this.store.binding(platformSessionId)!, operation: this.store.operation(operationId)!, replayed: false };
  }

  /** 创建前的全部校验（不落盘）：单个创建与对比组的整组预检共用 */
  preflightCreate(input: Omit<CreateInput, "idempotencyKey">): void { this.validateCreate(input); }

  private validateCreate(input: Omit<CreateInput, "idempotencyKey">) {
    if (!RUNTIME_KINDS.includes(input.runtimeKind)) throw new RuntimeError("runtimeKind 只能是 codex、claude-code、pi 或 antigravity", 400, "RT_INPUT");
    const profile = this.profile(input.runtimeKind);
    if (input.browserProfileId !== undefined && (input.runtimeKind !== "pi" || typeof input.browserProfileId !== "string" || !profile?.browserProfiles?.some(p => p.id === input.browserProfileId))) throw new RuntimeError("所选浏览器配置不可用，请重新检查运行时配置", 400, "RT_INPUT");
    if (!profile) throw new RuntimeError(`还没检查过 ${RUNTIME_LABEL[input.runtimeKind]} 的连接`, 409, "RT_PROFILE");
    if (profile.checkedAt !== input.confirmedProfileVersion) throw new RuntimeError("运行时配置在确认之后重新检查过，请核对后重新确认", 409, "RT_PROFILE_CHANGED");
    if (profile.state !== "executable") throw new RuntimeError(`${RUNTIME_LABEL[input.runtimeKind]} 当前不可执行：${profile.stateReason}`, 409, "RT_PROFILE");
    const missing = REQUIRED_FOR_CREATE.filter((c) => profile.capabilities[c]?.status !== "supported");
    if (missing.length) throw new RuntimeError(`缺少必需能力：${missing.join("、")}`, 409, "RT_INCOMPATIBLE");
    if (!profile.identity) throw new RuntimeError("账号身份未确定，不能创建", 409, "RT_PROFILE");
    const workspace = this.checkWorkspace(String(input.workspace ?? "").trim(), input.runtimeKind);
    const prompt = String(input.prompt ?? "");
    if (!prompt.trim() && !input.attachmentIds?.length) throw new RuntimeError("首条消息不能为空", 400, "RT_INPUT");
    if (prompt.length > 100_000) throw new RuntimeError("首条消息过长（上限 100000 字符）", 400, "RT_INPUT");
    const model = input.model?.trim() || (input.runtimeKind === "pi" ? (profile.models.find((m) => m.isDefault)?.id ?? profile.models[0]?.id) : undefined);
    if (model && !profile.models.some((m) => m.id === model)) throw new RuntimeError(`该 runtime 没有报告这个模型：${model}`, 400, "RT_INPUT");
    const effort = this.checkEffort(profile, model, input.effort);
    const savedPerm = !input.permissionMode && !input.evaluation && !input.projectRef && !input.role && !input.comparisonRef && !input.roomRef
      ? this.settings().defaultSessionByRuntime?.[input.runtimeKind]?.permissionMode || undefined
      : undefined;
    const validSavedPerm = savedPerm && permissionOption(input.runtimeKind, savedPerm) && (!profile.permissionOptions || profile.permissionOptions.some((p) => p.id === savedPerm))
      ? savedPerm as typeof input.permissionMode
      : undefined;
    const permissionMode = effectivePermissionMode({ ...input, ...(validSavedPerm ? { permissionMode: validSavedPerm } : {}) });
    const permissions = permissionOption(input.runtimeKind, permissionMode);
    if (!permissions || (input.permissionMode && profile.permissionOptions && !profile.permissionOptions.some((p) => p.id === permissionMode))) throw new RuntimeError("该运行时不支持所选权限模式，请重新检查连接", 400, "RT_INPUT");
    let evaluation: EvaluationBoundary | undefined;
    if (input.evaluation) {
      try {
        if (!evaluationPermission(input.runtimeKind, permissionMode)) throw new Error("Evaluation cannot use permissions that bypass host protection");
        evaluation = normalizeEvaluation(workspace, input.evaluation);
      } catch (error) { throw new RuntimeError((error as Error).message, 409, "RT_EVALUATION"); }
    }
    if (input.evaluationPolicyHash && (!evaluation || this.evaluationPolicy(input.runtimeKind)?.policyHash !== input.evaluationPolicyHash)) throw new RuntimeError("Evaluation policy 未确定或保护策略已变化", 409, "RT_EVALUATION");
    if (input.recommendationRef) {
      const r = input.recommendationRef;
      if (input.noteRef || typeof r.taskId !== "string" || !r.taskId.trim() || r.taskId.length > 200 || !Number.isSafeInteger(r.revision) || r.revision < 1 || typeof r.title !== "string" || !r.title.trim() || typeof r.requirement !== "string" || !r.requirement.trim() || !Array.isArray(r.sources) || !r.sources.length || r.sources.some(n => typeof n.noteId !== "string" || !n.noteId.trim() || typeof n.text !== "string" || typeof n.inputHash !== "string") || new Set(r.sources.map(n => n.noteId)).size !== r.sources.length) throw new RuntimeError("推荐任务引用格式不对", 400, "RT_INPUT");
    }
    if(input.recordSourceRefs!==undefined && (!Array.isArray(input.recordSourceRefs)||input.recordSourceRefs.length>100||input.recordSourceRefs.some(r=>!r||r.kind!=='note'&&r.kind!=='google'||r.kind==='note'&&(!r.noteId||typeof r.noteId!=='string')||r.kind==='google'&&[r.accountId,r.calendarId,r.eventId].some(v=>typeof v!=='string'||!v))))throw new RuntimeError("记录来源格式不对",400,"RT_INPUT");
    if (input.noteRef !== undefined && (typeof input.noteRef?.noteId !== "string" || !input.noteRef.noteId.trim() || input.noteRef.noteId.length > 200)) throw new RuntimeError("待办引用格式不对", 400, "RT_INPUT");
    const role = input.role;
    if (role) {
      if (!String(role.instructions ?? "").trim()) throw new RuntimeError("角色指令不能为空", 400, "RT_INPUT");
      if (role.instructions.length > 60_000) throw new RuntimeError("角色指令过长（上限 60000 字符）", 400, "RT_INPUT");
      // 角色指令必须由 runtime 实际支持的通道注入；不支持时不退回为"拼进首条消息"
      if (profile.capabilities.roleInstructions?.status !== "supported") throw new RuntimeError(`${RUNTIME_LABEL[input.runtimeKind]} 所选版本未确认支持角色指令注入：${profile.capabilities.roleInstructions?.reason ?? "未探测"}`, 409, "RT_INCOMPATIBLE");
    }
    return { profile, identity: profile.identity, workspace, prompt, model, effort, permissionMode, permissions, evaluation, role };
  }

  /** 尚未发出的 prompt 只在内存里：重启后不自动重发（§4.4） */
  /** Host policy identity, never accepted from an Agent report or capability checkbox. */
  evaluationPolicy(kind: RuntimeKind): { policyHash: string; channels: string[] } | undefined {
    const profile = this.profile(kind), policy = this.drivers[kind].evaluationPolicy?.();
    if (!profile || !policy?.version?.trim() || !Array.isArray(policy.channels) || !policy.channels.length || policy.channels.some((c) => typeof c !== "string" || !c.trim()) || new Set(policy.channels).size !== policy.channels.length) return;
    const channels = [...policy.channels].sort();
    const descriptor = { runtimeKind: kind, version: policy.version, channels, binaryPath: profile.binaryPath ?? null, binaryVersion: profile.binaryVersion ?? null, sdkVersion: profile.sdkVersion ?? null, transport: profile.transport };
    return { policyHash: `sha256:${createHash("sha256").update(JSON.stringify(descriptor)).digest("hex")}`, channels };
  }

  /** 开启平台技能时的技能目录；未开启为 undefined */
  private platformSkillsRoot: string | undefined;
  /** 技能开关（设置里禁用的技能不展开、不进首轮目录）；没配置存盘位置时为 undefined */
  platformSkillSwitches: PlatformSkillSwitches | undefined;
  private publicMemoryProvider: ((ctx: { runtimeKind: RuntimeKind; workspace: string; repoRoot?: string }) => { text: string; count: number; onDemand?: number; rules?: import("./memory-enforcement.js").ActiveRule[] } | null | undefined) | undefined;
  /** 平台公共记忆：新会话首轮把已确认的条目补进提示词（和技能目录同一条路径）。提供者必须同步、不抛错；返回空表示不注入。 */
  setPublicMemoryProvider(fn: RuntimeSessionManager["publicMemoryProvider"]): void { this.publicMemoryProvider = fn; }
  /** 公共记忆观察（只读）：首轮注入发生 / 会话里出现一次工具调用 / 一轮结束（即时提炼用）。出错只丢统计，不影响会话。 */
  private publicMemoryObserver: { injected?: (ctx: { platformSessionId: string; runtimeKind: RuntimeKind }) => void; turnEnded?: (ctx: { platformSessionId: string; runtimeKind: RuntimeKind; turnNo: number; status: string }) => void; tool?: (ctx: { platformSessionId: string; runtimeKind: RuntimeKind; key: string; name?: string; input?: string }) => void; enforced?: (ctx: { platformSessionId: string; runtimeKind: RuntimeKind; topicId: string; ruleId: string; pass: boolean }) => void } | undefined;
  setPublicMemoryObserver(o: RuntimeSessionManager["publicMemoryObserver"]): void { this.publicMemoryObserver = o; }
  /** 模型判定的强约束规则（DeepSeek 按四要素写的、没有对应代码的）由谁来判；不设置就只查代码规则。 */
  private modelRuleJudge: ModelRuleJudge | undefined;
  setModelRuleJudge(fn: ModelRuleJudge | undefined): void { this.modelRuleJudge = fn; }
  /** 取证项读取器（原生 App 发布状态、线上部署状态）：模型判定的规则按功能事实核对，不只看回复措辞。 */
  setEvidenceReaders(readers: ProbeReaders): void { this.evidenceReaders = readers; }
  private pendingPrompts = new Map<string, { prompt: string; attachmentIds?: string[]; presetSessionId?: string; model?: string; effort?: string }>();

  private imageInputHash(input: { prompt: string; model?: string; effort?: string; workspace?: string; runtimeKind?: string; browserProfileId?: string; permissionMode?: string; role?: unknown; noteRef?: unknown; recordSourceRefs?: unknown; recommendationRef?: unknown; scheduledFor?: string }, images: ImageAttachment[]): string {
    return createHash("sha256").update(JSON.stringify({ prompt: input.prompt, images: images.map(a => ({id: a.attachmentId, hash: a.sha256})), model: input.model ?? null, effort: input.effort ?? null, workspace: input.workspace ?? null, runtime: input.runtimeKind ?? null, permission: input.permissionMode ?? null, ...(input.browserProfileId ? { browserProfileId: input.browserProfileId } : {}), role: input.role ?? null, ...(input.recordSourceRefs?{recordSourceRefs:input.recordSourceRefs}:{}), ...(input.scheduledFor !== undefined ? { scheduledFor: input.scheduledFor } : {}), ...(input.recommendationRef ? { recommendationRef: input.recommendationRef } : {}) })).digest("hex");
  }
  private checkImageInput(profile: RuntimeProfile, model: string | undefined, images: ImageAttachment[]): void {
    if (!images.length) return;
    if (profile.capabilities.imageInput?.status !== "supported" || !this.modelOption(profile, model)?.inputModalities?.includes("image")) throw new RuntimeError("所选运行时或模型未确认支持图片输入，请选择支持图片的模型或移除图片", 409, "RT_IMAGE_UNSUPPORTED");
    if (profile.runtimeKind === "claude-code") for (const image of images) {
      if (image.width > 8000 || image.height > 8000) throw new RuntimeError(`${image.originalName}：Claude 图片单边不能超过 8000 像素`, 400, "RT_IMAGE_LIMIT");
      if (4 * Math.ceil(image.byteSize / 3) > 10_000_000) throw new RuntimeError(`${image.originalName}：Claude 图片 base64 编码后不能超过 10 MB，请使用较小图片`, 400, "RT_IMAGE_LIMIT");
    }
  }

  /** 推理强度只接受该模型报告支持的值；模型没报告支持就拒绝，不悄悄忽略 */
  private checkEffort(profile: RuntimeProfile, model: string | undefined, effort: string | undefined): string | undefined {
    const e = effort?.trim() || undefined;
    if (!e) return undefined;
    const m = this.modelOption(profile, model);
    if (!m?.efforts?.length) throw new RuntimeError(`模型 ${model ?? "（runtime 默认）"} 没有报告可选的推理强度`, 400, "RT_INPUT");
    if (!m.efforts.includes(e)) throw new RuntimeError(`模型 ${m.id} 不支持推理强度 ${e}（可选：${m.efforts.join("、")}）`, 400, "RT_INPUT");
    return e;
  }

  private modelOption(profile: RuntimeProfile | undefined, model: string | undefined) {
    if (!profile) return undefined;
    return model ? profile.models.find((m) => m.id === model) : profile.models.find((m) => m.isDefault) ?? profile.models[0];
  }

  /**
   * 会话所用模型在 runtime 模型目录里的那一项（决定可选的推理强度）。
   * 先按实际模型找（runtime 改道时以实际为准）；找不到再按创建时请求的目录 ID；都没指定就是默认模型。
   * Claude 的目录用别名（opus / sonnet / default），init 回报的实际模型是完整型号（claude-opus-5-5），只按实际模型会找不到。
   */
  private sessionModelOption(profile: RuntimeProfile | undefined, b: Pick<SessionBinding, "effectiveModel" | "requestedModel">) {
    if (!profile) return undefined;
    const byId = (id: string | undefined) => id ? profile.models.find((m) => m.id === id) : undefined;
    return byId(b.effectiveModel) ?? byId(b.requestedModel) ?? (b.requestedModel ? undefined : this.modelOption(profile, undefined));
  }


  /* ============================ 对比组 ============================ */

  /**
   * 同一首条消息并行发给 2~4 条通道。整组先预检，任何一条不合格就整组拒绝（不建一半）；
   * 每条通道的幂等键由组键派生（<组键>-L<n>），响应丢失后重放会逐条核对、补齐缺的，不重复创建。
   * 首期只读隔离：各通道权限固定为该运行时的只读模式。并发仍受每个 runtime 的上限约束，多出的排队。
   */
  async createComparison(input: ComparisonInput, actor: string): Promise<{ group: ComparisonGroup; replayed: boolean }> {
    const key = String(input.idempotencyKey ?? "").trim();
    if (!/^[A-Za-z0-9_-]{8,76}$/.test(key)) throw new RuntimeError("缺少有效的 idempotencyKey", 400, "RT_INPUT");
    const prompt = String(input.prompt ?? "");
    const promptHash = `sha256:${createHash("sha256").update(prompt, "utf8").digest("hex")}`;
    const existing = this.store.comparisonByKey(key);
    if (existing) {
      if (existing.promptHash !== promptHash) throw new RuntimeError("idempotencyKey 已用于另一组对比", 409, "RT_CONFLICT");
      if (existing.lanes.some((l) => !l.platformSessionId && !l.error)) await this.createLanes(existing.groupId, prompt, input.confirmedProfileVersions, actor);
      return { group: this.store.comparison(existing.groupId)!, replayed: true };
    }
    if (this.draining) throw new RuntimeError("服务即将重启（部署排空中），暂停新的创建；草稿已保留", 503, "RT_DRAINING");
    const lanes = Array.isArray(input.lanes) ? input.lanes : [];
    if (lanes.length < 2 || lanes.length > COMPARE_MAX_LANES) throw new RuntimeError(`对比需要 2~${COMPARE_MAX_LANES} 条通道`, 400, "RT_INPUT");
    const workspace = String(input.workspace ?? "").trim();
    const isolation = input.isolation ?? "read-only";
    if (isolation !== "read-only" && isolation !== "worktree") throw new RuntimeError("isolation 只能是 read-only 或 worktree", 400, "RT_INPUT");
    const normalized: ComparisonLane[] = lanes.map((l, i) => {
      if (!RUNTIME_KINDS.includes(l?.runtimeKind)) throw new RuntimeError(`通道 ${i + 1}：runtimeKind 只能是 codex、claude-code、pi 或 antigravity`, 400, "RT_INPUT");
      const ro = readOnlyPermissionMode(l.runtimeKind);
      let mode: PermissionMode = ro;
      if (isolation === "worktree") {
        mode = l.permissionMode ?? (l.runtimeKind === "pi" ? "pi-ask" : defaultPermissionMode(l.runtimeKind));
        if (!COMPARE_WORKTREE_PERMISSION_MODES[l.runtimeKind].includes(mode)) throw new RuntimeError(`通道 ${i + 1}：worktree 对比不允许能写到工作区之外的权限（可选：${COMPARE_WORKTREE_PERMISSION_MODES[l.runtimeKind].map((m) => permissionOption(l.runtimeKind, m)?.label ?? m).join("、")}）`, 400, "RT_INPUT");
      } else if (l.permissionMode && l.permissionMode !== ro) throw new RuntimeError(`通道 ${i + 1}：只读对比只支持只读权限（${permissionOption(l.runtimeKind, ro)?.label ?? ro}），各通道共用同一工作目录；要让通道改文件请用 git worktree 隔离`, 400, "RT_INPUT");
      const model = typeof l.model === "string" && l.model.trim() ? l.model.trim() : undefined;
      const effort = typeof l.effort === "string" && l.effort.trim() ? l.effort.trim() : undefined;
      return { laneNo: i + 1, runtimeKind: l.runtimeKind, ...(model ? { model } : {}), ...(effort ? { effort } : {}), permissionMode: mode };
    });
    // 整组预检：与单个创建同一套校验（运行时配置里勾选的模型、profile 版本、可执行、能力、目录、模型、强度、权限）
    for (const l of normalized) {
      try {
        this.checkSelectableModel(l.runtimeKind, l.model);
        this.validateCreate({ runtimeKind: l.runtimeKind, workspace, prompt, ...(l.model ? { model: l.model } : {}), ...(l.effort ? { effort: l.effort } : {}), permissionMode: l.permissionMode, confirmedProfileVersion: String(input.confirmedProfileVersions?.[l.runtimeKind] ?? "") });
      } catch (e) {
        if (e instanceof RuntimeError) throw new RuntimeError(`通道 ${l.laneNo}（${RUNTIME_LABEL[l.runtimeKind]}）：${e.message}`, e.status, e.code);
        throw e;
      }
    }
    const groupId = `cmp-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const realWorkspace = this.checkWorkspace(workspace, normalized[0]!.runtimeKind);
    let wt: ComparisonGroup["worktree"];
    if (isolation === "worktree") {
      const info = await gitWorkspaceInfo(realWorkspace);
      if (!info) throw new RuntimeError("工作目录不在 git 仓库里（或仓库还没有 commit），只能只读对比", 400, "RT_INPUT");
      if (input.confirmedBaseCommit && input.confirmedBaseCommit !== info.head) throw new RuntimeError("仓库 HEAD 在确认之后变了，请核对后重新确认", 409, "RT_PROFILE_CHANGED");
      for (const l of normalized) {
        const path = worktreePath(info.repoRoot, groupId, l.laneNo);
        if (!insideRepo(info.repoRoot, path) || !underRoots(info.repoRoot, this.workspaceRoots(l.runtimeKind))) throw new RuntimeError(`通道 ${l.laneNo}（${RUNTIME_LABEL[l.runtimeKind]}）：仓库根 ${info.repoRoot} 不在允许的工作目录根之内，放不了 worktree`, 403, "RT_WORKSPACE");
        l.worktree = { path, workspace: info.subdir ? join(path, info.subdir) : path };
      }
      // 全部建好才登记；中途失败把已建的删掉，不留半组
      const made: string[] = [];
      try {
        for (const l of normalized) { await addWorktree(info.repoRoot, l.worktree!.path, info.head); made.push(l.worktree!.path); }
      } catch (e) {
        for (const path of made) await removeWorktree(info.repoRoot, path).catch(() => undefined);
        throw new RuntimeError((e as Error).message, 409, "RT_WORKTREE");
      }
      wt = { repoRoot: info.repoRoot, subdir: info.subdir, baseCommit: info.head, ...(info.branch ? { baseBranch: info.branch } : {}), dirtyAtCreate: info.dirty };
    }
    const group: ComparisonGroup = {
      groupId, idempotencyKey: key, promptHash,
      title: autoSessionTitle(prompt), workspace: realWorkspace,
      promptPreview: bounded(prompt, LIMITS.preview).text, isolation, ...(wt ? { worktree: wt } : {}), lanes: normalized, createdAt: new Date().toISOString(), createdBy: actor
    };
    this.store.putComparison(group);
    this.store.audit({ type: "comparison-create", groupId: group.groupId, isolation, ...(wt ? { baseCommit: wt.baseCommit } : {}), lanes: normalized.map((l) => `${l.runtimeKind}:${l.model ?? "default"}:${l.effort ?? "default"}:${l.permissionMode}`), workspace: group.workspace, actor });
    await this.createLanes(group.groupId, prompt, input.confirmedProfileVersions, actor);
    return { group: this.store.comparison(group.groupId)!, replayed: false };
  }

  private async createLanes(groupId: string, prompt: string, versions: Partial<Record<RuntimeKind, string>> | undefined, actor: string): Promise<void> {
    const g = this.store.comparison(groupId)!;
    for (const lane of structuredClone(g.lanes)) {
      if (lane.platformSessionId) continue;
      let result: { platformSessionId?: string; error?: string };
      try {
        const r = await this.create({
          idempotencyKey: `${g.idempotencyKey}-L${lane.laneNo}`, runtimeKind: lane.runtimeKind, workspace: lane.worktree?.workspace ?? g.workspace, prompt,
          ...(lane.model ? { model: lane.model } : {}), ...(lane.effort ? { effort: lane.effort } : {}), permissionMode: lane.permissionMode,
          confirmedProfileVersion: String(versions?.[lane.runtimeKind] ?? ""), comparisonRef: { groupId, laneNo: lane.laneNo }
        }, actor);
        result = { platformSessionId: r.session.platformSessionId };
      } catch (e) {
        result = { error: bounded((e as Error).message, 300).text };
      }
      this.store.updateComparison(groupId, (x) => {
        const target = x.lanes.find((l) => l.laneNo === lane.laneNo)!;
        if (result.platformSessionId) { target.platformSessionId = result.platformSessionId; delete target.error; }
        else target.error = result.error!;
      });
    }
    this.emit("comparison", { groupId });
  }

  comparisonView(groupId: string): ComparisonView {
    const group = this.store.comparison(groupId);
    if (!group) throw new RuntimeError("对比组不存在", 404, "RT_NOT_FOUND");
    const lanes = group.lanes.map((lane): ComparisonLaneView => {
      const b = lane.platformSessionId ? this.store.binding(lane.platformSessionId) : undefined;
      const empty: ComparisonLaneView["metrics"] = { turns: 0, toolCalls: 0, toolFailures: 0, errors: 0, usage: {}, usageCoverage: "unknown" };
      if (!b) return { ...lane, ...(lane.platformSessionId && !lane.error ? { error: "会话的平台数据已删除" } : {}), approvals: [], metrics: empty };
      const events = this.store.events(b.platformSessionId);
      const usage = summarizeUsage(this.store.usageFor(b.platformSessionId));
      const ms = (t: TurnRecord) => t.startedAt && t.endedAt ? Math.max(0, Date.parse(t.endedAt) - Date.parse(t.startedAt)) : undefined;
      const finished = b.turns.map(ms).filter((x): x is number => x !== undefined);
      const latest = b.turns[b.turns.length - 1];
      const tools = events.filter((e) => e.kind === "tool" && !e.subagent);
      const replies = events.filter((e) => e.kind === "message" && e.role === "assistant" && !e.subagent && e.text);
      const inLatest = latest ? replies.filter((e) => e.turnNo === latest.turnNo) : [];
      const last = (inLatest.length ? inLatest : replies).at(-1);
      const qp = this.queuePosition(b.platformSessionId);
      return {
        ...lane,
        session: {
          platformSessionId: b.platformSessionId, status: b.status, ...(b.statusReason ? { statusReason: b.statusReason } : {}),
          ...(b.requestedModel ? { requestedModel: b.requestedModel } : {}), ...(b.effectiveModel ? { effectiveModel: b.effectiveModel } : {}),
          ...(b.requestedEffort ? { requestedEffort: b.requestedEffort } : {}), ...(b.effectiveEffort ? { effectiveEffort: b.effectiveEffort } : {}),
          permissionLabel: b.permissionLabel, bindingRevision: b.bindingRevision, ...(b.archived ? { archived: true } : {}),
          ...(b.conflict ? { conflict: b.conflict } : {}), ...(b.nativeSessionId ? { nativeSessionId: b.nativeSessionId } : {}),
          ...(b.approvalGrant ? { approvalGrant: b.approvalGrant } : {})
        },
        ...(qp ? { queuePosition: qp } : {}),
        approvals: this.store.allApprovals().filter((a) => a.platformSessionId === b.platformSessionId && a.state === "pending"),
        metrics: {
          turns: b.turns.length,
          ...(latest ? { latestTurn: { turnNo: latest.turnNo, status: latest.status, ...(latest.startedAt ? { startedAt: latest.startedAt } : {}), ...(latest.endedAt ? { endedAt: latest.endedAt } : {}), ...(ms(latest) !== undefined ? { durationMs: ms(latest)! } : {}) } } : {}),
          ...(finished.length ? { totalDurationMs: finished.reduce((x, y) => x + y, 0) } : {}),
          toolCalls: tools.length,
          toolFailures: tools.filter((e) => e.tool?.status === "failed" || e.tool?.status === "declined" || (typeof e.tool?.exitCode === "number" && e.tool.exitCode !== 0)).length,
          errors: events.filter((e) => e.kind === "error").length,
          usage: usage.totals, usageCoverage: usage.coverage
        },
        ...(last ? { answer: { text: last.text!, seq: last.seq, ...(last.turnNo !== undefined ? { turnNo: last.turnNo } : {}), partial: !!last.partial, ...(last.truncated ? { truncated: last.truncated } : {}) } } : {})
      };
    });
    const settled = lanes.every((l) => !l.session || !(ACTIVE.includes(l.session.status) || l.queuePosition));
    const wt = group.worktree;
    const notes = [
      wt ? `worktree 隔离：各通道在 ${wt.repoRoot}/.pi-compare/${group.groupId}/ 下各自的 worktree 里运行，都从 ${wt.baseCommit.slice(0, 10)}${wt.baseBranch ? `（${wt.baseBranch}）` : ""} 切出；原目录在“采用”之前不会被改动${wt.cleanedAt ? "。worktree 已在归档时清理" : ""}`
        : "只读对比：各通道共用同一工作目录，权限固定为只读，不会改动文件",
      ...(lanes.some((l) => l.runtimeKind === "claude-code" && l.permissionMode === "plan") ? ["Claude Code 使用原生计划模式：退出计划需要你批准，批准后的操作仍按原生规则审批"] : [])
    ];
    return { group, lanes, settled, notes };
  }

  /**
   * 某一轮的指标（群聊轮内对比）：耗时取这一轮的开始到结束；工具与错误按事件的 turnNo；
   * token 取这一轮时间窗内回报的用量记录（各 runtime 口径不同，没有回报为 unknown）。
   */
  turnMetrics(platformSessionId: string, turnNo: number): { status?: TurnRecord["status"]; startedAt?: string; endedAt?: string; durationMs?: number; toolCalls: number; toolFailures: number; errors: number; usage: UsageSummary["totals"]; usageCoverage: UsageSummary["coverage"] } {
    const b = this.store.binding(platformSessionId);
    const empty = { toolCalls: 0, toolFailures: 0, errors: 0, usage: {}, usageCoverage: "unknown" as const };
    const t = b?.turns.find((x) => x.turnNo === turnNo);
    if (!b || !t) return empty;
    const events = this.store.events(platformSessionId).filter((e) => e.turnNo === turnNo && !e.subagent);
    const tools = events.filter((e) => e.kind === "tool");
    const from = t.startedAt ? Date.parse(t.startedAt) : NaN, to = t.endedAt ? Date.parse(t.endedAt) : Date.now();
    // 压缩后的合计行按小时合并，分不到具体某一轮：不计入单轮用量
    const records = Number.isFinite(from) ? this.store.usageFor(platformSessionId).filter((r) => { if (r.aggregate) return false; const at = Date.parse(r.occurredAt ?? r.sampledAt); return at >= from && at <= to + 5_000; }) : [];
    const usage = summarizeUsage(records);
    return {
      status: t.status, ...(t.startedAt ? { startedAt: t.startedAt } : {}), ...(t.endedAt ? { endedAt: t.endedAt } : {}),
      ...(t.startedAt && t.endedAt ? { durationMs: Math.max(0, Date.parse(t.endedAt) - Date.parse(t.startedAt)) } : {}),
      toolCalls: tools.length,
      toolFailures: tools.filter((e) => e.tool?.status === "failed" || e.tool?.status === "declined" || (typeof e.tool?.exitCode === "number" && e.tool.exitCode !== 0)).length,
      errors: events.filter((e) => e.kind === "error").length,
      usage: records.length ? usage.totals : {}, usageCoverage: records.length ? usage.coverage : "unknown"
    };
  }

  /** 人工结论：选出一条通道（null = 都不满意）并附备注 */
  setComparisonVerdict(groupId: string, verdict: { laneNo: number | null; note?: string }, actor: string): ComparisonGroup {
    const g = this.store.comparison(groupId);
    if (!g) throw new RuntimeError("对比组不存在", 404, "RT_NOT_FOUND");
    if (verdict.laneNo !== null && !g.lanes.some((l) => l.laneNo === verdict.laneNo)) throw new RuntimeError("没有这条通道", 400, "RT_INPUT");
    const note = String(verdict.note ?? "").trim();
    if (note.length > 2000) throw new RuntimeError("备注过长（上限 2000 字符）", 400, "RT_INPUT");
    const out = this.store.updateComparison(groupId, (x) => { x.verdict = { laneNo: verdict.laneNo, note, at: new Date().toISOString(), by: actor }; });
    this.store.audit({ type: "comparison-verdict", groupId, laneNo: verdict.laneNo, actor });
    this.emit("comparison", { groupId });
    return out;
  }

  /** 整组归档/恢复：运行中的通道不能归档，整组拒绝 */
  async archiveComparison(groupId: string, archived: boolean, actor: string): Promise<ComparisonGroup> {
    const g = this.store.comparison(groupId);
    if (!g) throw new RuntimeError("对比组不存在", 404, "RT_NOT_FOUND");
    const ids = g.lanes.map((l) => l.platformSessionId).filter((id): id is string => !!id && !!this.store.binding(id));
    if (archived && ids.some((id) => this.running.has(id))) throw new RuntimeError("还有通道在运行，不能归档", 409, "RT_BUSY");
    for (const id of ids) await this.archive(id, archived, actor);
    // 归档即清理 worktree（未采用的改动随之删除；恢复归档不重建）
    if (archived) await this.cleanupWorktrees(groupId, actor);
    return this.store.comparison(groupId)!;
  }

  /** 删除整组：清理 worktree，删各通道的平台数据（原生 transcript 不动），再删组记录 */
  async deleteComparison(groupId: string, actor: string): Promise<void> {
    const g = this.store.comparison(groupId);
    if (!g) throw new RuntimeError("对比组不存在", 404, "RT_NOT_FOUND");
    const ids = g.lanes.map((l) => l.platformSessionId).filter((id): id is string => !!id && !!this.store.binding(id));
    if (ids.some((id) => this.running.has(id))) throw new RuntimeError("还有通道在运行，不能删除", 409, "RT_BUSY");
    await this.cleanupWorktrees(groupId, actor);
    for (const id of ids) this.deletePlatformData(id, actor);
    this.store.deleteComparison(groupId);
    this.store.audit({ type: "comparison-delete", groupId, actor });
    this.emit("directory", {});
  }

  private async cleanupWorktrees(groupId: string, actor: string): Promise<void> {
    const g = this.store.comparison(groupId);
    if (!g?.worktree || g.worktree.cleanedAt) return;
    const repoRoot = g.worktree.repoRoot;
    for (const l of g.lanes) if (l.worktree) await removeWorktree(repoRoot, l.worktree.path);
    this.store.updateComparison(groupId, (x) => { if (x.worktree) x.worktree.cleanedAt = new Date().toISOString(); });
    this.store.audit({ type: "comparison-worktree-cleanup", groupId, actor });
    this.emit("comparison", { groupId });
  }

  /** 新建前查看工作目录（只读）：git 信息与 worktree 能否放进允许根 */
  async comparisonWorkspaceInfo(workspace: string, kinds: RuntimeKind[]): Promise<ComparisonWorkspaceInfo> {
    const real = this.checkWorkspace(workspace.trim(), kinds[0] ?? "codex");
    const info = await gitWorkspaceInfo(real);
    if (!info) return { workspace: real };
    const worktreeRoot = join(info.repoRoot, ".pi-compare");
    return { workspace: real, git: { ...info, worktreeRoot, worktreeAllowed: kinds.every((k) => underRoots(info.repoRoot, this.workspaceRoots(k))) } };
  }

  private worktreeLane(groupId: string, laneNo: number): { g: ComparisonGroup; lane: ComparisonLane; wt: NonNullable<ComparisonGroup["worktree"]> } {
    const g = this.store.comparison(groupId);
    if (!g) throw new RuntimeError("对比组不存在", 404, "RT_NOT_FOUND");
    const lane = g.lanes.find((l) => l.laneNo === laneNo);
    if (!lane) throw new RuntimeError("没有这条通道", 404, "RT_NOT_FOUND");
    if (!g.worktree || !lane.worktree) throw new RuntimeError("这组对比没有用 worktree 隔离，没有代码改动可比", 400, "RT_INPUT");
    if (g.worktree.cleanedAt) throw new RuntimeError("worktree 已在归档时清理", 410, "RT_GONE");
    return { g, lane, wt: g.worktree };
  }

  /** L3：通道相对 base commit 的全部改动（已提交、未提交与未跟踪） */
  async comparisonLaneDiff(groupId: string, laneNo: number): Promise<ComparisonLaneDiff> {
    const { lane, wt } = this.worktreeLane(groupId, laneNo);
    let d: LaneDiff;
    try { d = await laneDiff(wt.repoRoot, lane.worktree!.path, wt.baseCommit); }
    catch (e) { throw new RuntimeError((e as Error).message, 409, "RT_WORKTREE"); }
    const long = d.patch.length > DIFF_PATCH_MAX;
    return { ...d, laneNo, patch: long ? d.patch.slice(0, DIFF_PATCH_MAX) : d.patch, ...(long ? { truncated: { originalChars: d.patch.length } } : {}) };
  }

  /**
   * 采用一条通道：把它相对 base 的完整补丁应用到原仓库的工作区（不暂存、不 commit）。
   * 二次确认：请求必须带上用户看到的 patchHash，改动在那之后又变了就拒绝；运行中的通道不能采用；整组只采用一次。
   * 同一组的采用串行执行（进程内），记录在宿主临界区内再核对一次，避免并发采用两条。
   */
  private adopting = new Set<string>();
  async adoptComparisonLane(groupId: string, laneNo: number, patchHash: string, actor: string): Promise<ComparisonGroup> {
    if (this.adopting.has(groupId)) throw new RuntimeError("这组对比正在采用另一条通道", 409, "RT_CONFLICT");
    this.adopting.add(groupId);
    try {
      const { g, lane, wt } = this.worktreeLane(groupId, laneNo);
      if (g.adopted) throw new RuntimeError(`这组对比已经采用了通道 ${g.adopted.laneNo}`, 409, "RT_CONFLICT");
      if (lane.platformSessionId && this.running.has(lane.platformSessionId)) throw new RuntimeError("通道还在运行，结束后再采用", 409, "RT_BUSY");
      let d: LaneDiff;
      try { d = await laneDiff(wt.repoRoot, lane.worktree!.path, wt.baseCommit); }
      catch (e) { throw new RuntimeError((e as Error).message, 409, "RT_WORKTREE"); }
      if (d.patchHash !== patchHash) throw new RuntimeError("通道的改动在你查看之后又变了，请重新查看再确认", 409, "RT_CONFLICT");
      if (this.store.comparison(groupId)?.adopted) throw new RuntimeError("这组对比已经采用过", 409, "RT_CONFLICT");
      try { await applyPatch(wt.repoRoot, d.patch); }
      catch (e) { throw new RuntimeError((e as Error).message, 409, "RT_APPLY"); }
      const out = this.store.updateComparison(groupId, (x) => { x.adopted = { laneNo, patchHash, files: d.files.length, at: new Date().toISOString(), by: actor }; });
      this.store.audit({ type: "comparison-adopt", groupId, laneNo, patchHash, files: d.files.length, repoRoot: wt.repoRoot, actor });
      this.emit("comparison", { groupId });
      return out;
    } finally { this.adopting.delete(groupId); }
  }

  /* ============================ 续聊 ============================ */

  async sendTurn(platformSessionId: string, input: { idempotencyKey: string; prompt: string; attachmentIds?: string[]; expectedRevision: number; effort?: string; roomDelivery?: boolean; canDeliver?: () => boolean; outbox?: { messageId: string; digest: string }; quotaResumeStreak?: number }, actor: string): Promise<{ session: SessionBinding; operation: OperationRecord; replayed: boolean }> {
    const key = String(input.idempotencyKey ?? "").trim();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new RuntimeError("缺少有效的 idempotencyKey", 400, "RT_INPUT");
    const attachments = this.attachments.resolve(input.attachmentIds, actor, platformSessionId);
    const inputHash = this.imageInputHash(input, attachments);
    const existing = this.store.operationByKey(key);
    if (existing) {
      if (existing.inputHash && existing.inputHash !== inputHash) throw new RuntimeError("idempotencyKey 已用于另一条消息或图片顺序", 409, "RT_CONFLICT");
      if (existing.kind !== "turn" || existing.platformSessionId !== platformSessionId) throw new RuntimeError("idempotencyKey 已用于别的操作", 409, "RT_CONFLICT");
      return { session: this.store.binding(platformSessionId)!, operation: existing, replayed: true };
    }
    const b = this.managed(platformSessionId);
    if (this.draining && !(this.finishQueuedOnDrain && input.outbox)) throw new RuntimeError("服务即将重启（部署排空中），暂停新的续聊；草稿已保留", 503, "RT_DRAINING");
    if (b.roomRef && !input.roomDelivery) throw new RuntimeError("请通过群聊的人类消息投递给成员", 409, "ROOM_OWNED");
    if (b.archived) throw new RuntimeError("会话已归档，请先恢复", 409, "RT_STATE");
    if (b.worktree?.removedAt) throw new RuntimeError("会话 worktree 已在归档时删除，请新建会话继续工作", 409, "RT_GONE");
    if (b.conflict) throw new RuntimeError(`检测到外部写入，平台已暂停写入：${b.conflict.reason}。核对后可显式恢复`, 409, "RT_EXTERNAL_WRITE");
    // 部署排空时只建了会话、首条消息在排队：允许这条排队消息作为第一轮创建原生会话。
    const deferredFirstTurn = !b.nativeSessionId && b.status === "idle" && b.turns.length === 0;
    if (!b.nativeSessionId && !deferredFirstTurn && !(b.roomRef && b.turns.every((t) => t.status === "failed" || t.status === "cancelled"))) throw new RuntimeError("原生会话没有创建成功，不能续聊", 409, "RT_STATE");
    if (this.running.has(platformSessionId) || b.status === "waiting-input" || b.turns.some((t) => t.status === "queued" || t.status === "running" || t.status === "waiting-input")) {
      throw new RuntimeError("本轮还在运行，首期不支持并行提交；草稿已保留", 409, "RT_BUSY");
    }
    if (b.bindingRevision !== Number(input.expectedRevision)) throw new RuntimeError(`会话已被更新（版本 ${b.bindingRevision}），请刷新后再发送`, 409, "RT_CONFLICT");
    const prompt = String(input.prompt ?? "");
    if (!prompt.trim() && !attachments.length) throw new RuntimeError("消息不能为空", 400, "RT_INPUT");
    if (prompt.length > 100_000) throw new RuntimeError("消息过长（上限 100000 字符）", 400, "RT_INPUT");
    const profile = this.profile(b.runtimeKind);
    if (!profile || profile.state !== "executable") throw new RuntimeError(`${RUNTIME_LABEL[b.runtimeKind]} 当前不可执行：${profile?.stateReason ?? "未检查"}`, 409, "RT_PROFILE");
    if (profile.identity?.identityScopeId !== b.identityScopeId) throw new RuntimeError("当前登录账号与创建会话时的身份空间不同，不静默改绑；请切回原账号或新建会话", 409, "RT_IDENTITY");
    this.checkImageInput(profile, this.sessionModelOption(profile, b)?.id, attachments);
    if (attachments.length && (b.roomRef || b.comparisonRef || b.projectRef || b.evaluation)) throw new RuntimeError("首期图片附件仅支持普通单会话", 400, "RT_INPUT");
    // 续聊的推理强度：不给就沿用会话上次请求的值
    const effort = input.effort !== undefined && String(input.effort).trim() ? this.checkEffort(profile, this.sessionModelOption(profile, b)?.id ?? b.effectiveModel ?? b.requestedModel, input.effort) : b.requestedEffort;
    // 外部写入核对（§4.3）：原生记录在平台上次核对之后变化 → 暂停写入、转只读
    const driver = this.driver(b.runtimeKind);
    const continuation = await this.syncNativeContinuation(platformSessionId);
    if (continuation?.active || continuation?.pending) throw new RuntimeError("本轮后台任务尚未回报完毕，请稍后再发送；草稿已保留", 409, "RT_BUSY");
    let previous = this.store.binding(platformSessionId)?.nativeFingerprint?.value;
    const lifecycle = b.nativeSessionId ? driver.continuationState?.(b.nativeSessionId) : undefined;
    let fp = b.nativeSessionId ? await driver.fingerprint(b.nativeSessionId, { workspace: b.workspace, ...(previous ? { previous } : {}) }).catch(() => undefined) : { value: "room-not-started" };
    if (!fp) throw new RuntimeError("无法核对原生会话状态，维持只读；稍后重试", 409, "RT_UNVERIFIED");
    if (fp.note) this.noteFingerprint(platformSessionId, fp.note);
    if (previous && fp.value !== previous && !fp.migrated && driver.readContinuation) {
      const retry = await this.syncNativeContinuation(platformSessionId);
      if (retry?.active || retry?.pending) throw new RuntimeError("本轮后台任务尚未回报完毕，请稍后再发送；草稿已保留", 409, "RT_BUSY");
      previous = this.store.binding(platformSessionId)?.nativeFingerprint?.value;
      // A proof snapshot at or beyond the observed fingerprint supersedes the stale read.
      if (retry && previous === retry.fingerprint) fp = { value: retry.fingerprint };
    }
    const latestLifecycle = b.nativeSessionId ? driver.continuationState?.(b.nativeSessionId) : undefined;
    if (latestLifecycle?.active || (lifecycle && latestLifecycle && lifecycle.revision !== latestLifecycle.revision)) {
      throw new RuntimeError("原轮次仍有后台续写，请稍后再发送；草稿已保留", 409, "RT_BUSY");
    }
    if (previous && fp.value !== previous) {
      // 指纹语式升级（上一版格式与现在不可比）：只重建基线，不判外部写入
      if (fp.migrated) {
        this.store.updateBinding(platformSessionId, (x) => { x.nativeFingerprint = { value: fp.value, checkedAt: new Date().toISOString() }; }, undefined, { bump: false });
        this.noteFingerprint(platformSessionId, "指纹格式升级，已重建外部写入基线");
      } else {
        this.markConflict(platformSessionId, "原生会话在平台之外被续聊或修改（可能是 CLI / Desktop）", `上次核对 ${previous} → 现在 ${fp.value}`);
        throw new RuntimeError("检测到平台之外的写入，已暂停平台写入并转为只读观察", 409, "RT_EXTERNAL_WRITE");
      }
    }
    if (input.canDeliver && !input.canDeliver()) throw new RuntimeError("成员已移出或群聊已关闭，取消未发送投递", 409, "ROOM_CANCELLED");
    const now = new Date().toISOString();
    const operationId = `op-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const turnNo = Math.max(0, ...b.turns.map((t) => t.turnNo)) + 1;
    const clientMessageId = randomUUID();
    const operation: OperationRecord = { operationId, idempotencyKey: key, inputHash, ...(attachments.length ? { imageInput: { prompt, attachmentIds: attachments.map(a => a.attachmentId), owner: actor, effort } } : {}), kind: "turn", platformSessionId, ...(!b.nativeSessionId && b.runtimeKind !== "codex" ? { presetNativeId: randomUUID() } : {}), state: "prepared", createdAt: now, updatedAt: now, turnNo, steps: [{ at: now, step: "prepared", detail: `续聊第 ${turnNo} 轮，沿原生 ID ${b.nativeSessionId}` }] };
    let retitle = false;
    const publication = this.store.appendSessionOperation(platformSessionId, Number(input.expectedRevision), (x) => {
      // 排队消息出队与新一轮在同一次写入：要么都发生，要么都不发生；期间被撤销或修改就不发
      if (input.outbox) {
        const i = (x.outbox ?? []).findIndex(m => m.messageId === input.outbox!.messageId);
        if (i < 0) throw new RuntimeError("这条排队消息已撤销", 409, "RT_OUTBOX_GONE");
        if (outboxDigest(x.outbox![i]!) !== input.outbox.digest) throw new RuntimeError("这条排队消息刚被修改", 409, "RT_OUTBOX_CHANGED");
        x.outbox!.splice(i, 1);
        if (!x.outbox!.length) delete x.outbox;
      }
      x.turns.push({ turnNo, status: "queued", operationId, promptPreview: bounded(prompt, LIMITS.preview).text, clientMessageId, ...(effort ? { effort } : {}) });
      // 预约首条到点才产生第 1 轮：创建时因为还没有输入而失败的标题任务，改用这条用户消息重试一次。
      if (input.outbox && turnNo === 1 && x.titleGeneration?.state === "failed" && x.titleGeneration.errorCode === "TITLE_EMPTY_INPUT") {
        x.titleGeneration = pendingSessionTitle(bounded(prompt, LIMITS.message).text);
        x.title = "正在生成标题…"; x.titleSource = "pending"; retitle = true;
      }
      // 新的用户消息让上一条回复的推荐操作标签失效；新一轮结束后由快捷回复重新写入。
      delete x.quickAction;
      delete x.quickReplies;
      // 任何新的一轮都取消待执行的额度续聊；自动续聊带着累计次数，人发的消息则把次数清零
      delete x.quotaResume;
      if (input.quotaResumeStreak) {
        x.quotaResumeStreak = input.quotaResumeStreak;
        if (x.outboxPaused && !x.outboxPaused.editing && x.outboxPaused.reason === "本轮被中断") delete x.outboxPaused;
      } else delete x.quotaResumeStreak;
      if (effort) x.requestedEffort = effort;
      x.status = "running"; x.statusReason = "提交中"; x.lastActivityAt = { at: now, source: "platform" };
    }, operation);
    if (publication.replayed) return publication;
    this.attachments.attach(attachments.map(a => a.attachmentId), actor, platformSessionId);
    const userEvent = this.store.upsertEvent(platformSessionId, {
      key: `user:${clientMessageId}`, kind: "message", role: "user", text: bounded(prompt, LIMITS.message).text, ...(attachments.length ? { attachments } : {}),
      source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", recordedAt: now, occurredAt: now, turnNo
    });
    // 用户消息也走实时流：页面发送后不重新拉取对话，不推送就要等刷新才看到自己发的这条
    if (userEvent) this.emit("event", { platformSessionId, event: userEvent });
    this.store.audit({ type: "turn", platformSessionId, turnNo, actor, operationId });
    this.pendingPrompts.set(operationId, { prompt, ...(attachments.length ? { attachmentIds: attachments.map(a => a.attachmentId) } : {}), ...(operation.presetNativeId ? { presetSessionId: operation.presetNativeId } : {}), ...(effort ? { effort } : {}) });
    this.schedule();
    this.emit("session", { platformSessionId });
    if (retitle) setImmediate(() => this.titleWorker?.wake());
    return { session: this.store.binding(platformSessionId)!, operation: this.store.operation(operationId)!, replayed: false };
  }

  /* ============================ 排队消息 ============================ */

  private reservationTime(value: unknown, admitted = false): string | undefined {
    if (value === undefined) return undefined;
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(ms) || (!admitted && ms <= Date.now())) throw new RuntimeError("预约时间必须是未来的有效时间", 400, "RT_INPUT");
    return new Date(ms).toISOString();
  }

  private clearReservationTimer(pid: string): void {
    const timer = this.reservationTimers.get(pid);
    if (timer) clearTimeout(timer);
    this.reservationTimers.delete(pid);
  }

  /** 只为未来预约挂一个最近的唤醒；已到点但正在运行的消息由本轮结束流程继续发送。 */
  private armReservation(pid: string): void {
    this.clearReservationTimer(pid);
    const b = this.store.binding(pid);
    if (this.shuttingDown || !b || b.archived) return;
    const future = (b.outbox ?? []).map(m => Date.parse(m.scheduledFor ?? "")).filter(t => Number.isFinite(t) && t > Date.now());
    if (!future.length) return;
    const timer = setTimeout(() => {
      this.reservationTimers.delete(pid);
      void this.recovered.then(() => this.drainOutbox(pid));
    }, Math.max(1, Math.min(Math.min(...future) - Date.now(), 2_147_000_000)));
    timer.unref(); this.reservationTimers.set(pid, timer);
  }

  scheduledMessages() {
    return this.store.allBindings().filter(b => !b.archived).flatMap(b => (b.outbox ?? []).filter(m => m.scheduledFor).map(m => ({
      platformSessionId: b.platformSessionId, title: b.title, messageId: m.messageId,
      // 预约弹窗和会话列表用同一套头像：模型系列图标 + 运行时角标
      runtimeKind: b.runtimeKind, ...(b.effectiveModel ?? b.requestedModel ? { model: (b.effectiveModel ?? b.requestedModel)! } : {}),
      prompt: bounded(m.prompt, 240).text, images: m.attachments?.length ?? 0, scheduledFor: m.scheduledFor!,
      ...(b.outboxPaused ? { paused: b.outboxPaused.reason } : {})
    }))).sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
  }

  /** 能排队的会话：普通单聊（群聊、对比、项目、验收会话有自己的投递流程） */
  private outboxSession(platformSessionId: string): SessionBinding {
    const b = this.managed(platformSessionId);
    if (b.roomRef || b.comparisonRef || b.projectRef || b.role || b.evaluation) throw new RuntimeError("排队消息只支持普通单聊", 409, "RT_STATE");
    if (b.archived) throw new RuntimeError("会话已归档，请先恢复", 409, "RT_STATE");
    if (b.worktree?.removedAt) throw new RuntimeError("会话 worktree 已在归档时删除，请新建会话继续工作", 409, "RT_GONE");
    if (b.conflict) throw new RuntimeError(`检测到外部写入，平台已暂停写入：${b.conflict.reason}`, 409, "RT_EXTERNAL_WRITE");
    return b;
  }

  /** 校验一条排队消息的内容，并把图片绑定到会话（不再按草稿过期） */
  private outboxContent(b: SessionBinding, input: { prompt?: unknown; attachmentIds?: unknown }, actor: string): { prompt: string; attachments: ImageAttachment[] } {
    const prompt = String(input.prompt ?? "");
    const attachments = this.attachments.resolve(input.attachmentIds, actor, b.platformSessionId);
    if (!prompt.trim() && !attachments.length) throw new RuntimeError("消息不能为空", 400, "RT_INPUT");
    if (prompt.length > OUTBOX_LIMITS.prompt) throw new RuntimeError(`消息过长（上限 ${OUTBOX_LIMITS.prompt} 字符）`, 400, "RT_INPUT");
    if (attachments.length) {
      const profile = this.profile(b.runtimeKind);
      if (!profile) throw new RuntimeError(`${RUNTIME_LABEL[b.runtimeKind]} 尚未检查`, 409, "RT_PROFILE");
      this.checkImageInput(profile, this.sessionModelOption(profile, b)?.id, attachments);
      this.attachments.attach(attachments.map(a => a.attachmentId), actor, b.platformSessionId);
    }
    return { prompt, attachments };
  }

  private outboxChanged(pid: string, type: string, actor: string, extra: Record<string, unknown> = {}): SessionBinding {
    this.armReservation(pid);
    this.store.audit({ type: `outbox-${type}`, platformSessionId: pid, actor, ...extra });
    this.emit("session", { platformSessionId: pid });
    return this.store.binding(pid)!;
  }

  /**
   * 首条消息还排在队里（预约发送 / 部署排空）：标题输入取队首内容。
   * 修改、撤销或调整顺序时同步标题任务，别让标题描述已经改掉的内容；第 1 轮出现后由那条用户消息接管（同一段文本，哈希不变）。
   */
  private syncQueuedTitle(platformSessionId: string): void {
    const b = this.store.binding(platformSessionId);
    const job = b?.titleGeneration;
    if (!b || b.turns.length || !job || !["pending", "generated", "fallback"].includes(b.titleSource ?? "")) return;
    const prompt = b.outbox?.[0]?.prompt ?? "";
    const next = prompt.trim() ? pendingSessionTitle(bounded(prompt, LIMITS.message).text) : undefined;
    // 内容没变就不重跑：只有「输入为空」的失败（撤销后重新排队）值得按同一哈希再试一次。
    const emptyFailure = job.state === "failed" && job.errorCode === "TITLE_EMPTY_INPUT";
    const needsRun = next ? next.inputHash !== job.inputHash || emptyFailure : !emptyFailure;
    if (!needsRun) return;
    this.store.updateBinding(platformSessionId, (x) => {
      if (!x.titleGeneration || x.turns.length) return;
      if (next) {
        x.titleGeneration = next;
        // 生成结果先保留在列表里，不让标题闪回占位；来源必须回到 pending，worker 才会按新内容重跑。
        if (x.titleSource !== "generated") x.title = "正在生成标题…";
        x.titleSource = "pending";
      } else {
        x.titleGeneration.state = "failed"; x.titleGeneration.errorCode = "TITLE_EMPTY_INPUT";
        delete x.titleGeneration.owner; delete x.titleGeneration.leaseUntil;
        x.title = "新会话"; x.titleSource = "fallback";
      }
    }, undefined, { bump: false });
    setImmediate(() => this.titleWorker?.wake());
  }

  /** 加入排队：同一个 messageId 重复提交不重复入队（网络重试） */
  enqueueMessage(platformSessionId: string, input: { messageId: string; prompt: string; attachmentIds?: string[]; effort?: string; scheduledFor?: string }, actor: string, opts: { hold?: boolean; admittedReservation?: boolean } = {}): SessionBinding {
    const messageId = String(input.messageId ?? "");
    if (!OUTBOX_ID.test(messageId)) throw new RuntimeError("缺少有效的 messageId", 400, "RT_INPUT");
    const b = this.outboxSession(platformSessionId);
    if (b.outbox?.some(m => m.messageId === messageId) || this.store.operationByKey(`q-${messageId}`)) return b;
    if ((b.outbox?.length ?? 0) >= OUTBOX_LIMITS.count) throw new RuntimeError(`最多排队 ${OUTBOX_LIMITS.count} 条消息`, 409, "RT_OUTBOX_FULL");
    const scheduledFor = this.reservationTime(input.scheduledFor, opts.admittedReservation);
    const { prompt, attachments } = this.outboxContent(b, input, actor);
    let effort: string | undefined;
    if (input.effort !== undefined && String(input.effort).trim()) {
      const profile = this.profile(b.runtimeKind);
      if (!profile) throw new RuntimeError(`${RUNTIME_LABEL[b.runtimeKind]} 尚未检查`, 409, "RT_PROFILE");
      effort = this.checkEffort(profile, this.sessionModelOption(profile, b)?.id ?? b.effectiveModel ?? b.requestedModel, input.effort);
    }
    const now = new Date().toISOString();
    this.store.updateBinding(platformSessionId, (x) => {
      if (x.outbox?.some(m => m.messageId === messageId)) return;
      if ((x.outbox?.length ?? 0) >= OUTBOX_LIMITS.count) throw new RuntimeError(`最多排队 ${OUTBOX_LIMITS.count} 条消息`, 409, "RT_OUTBOX_FULL");
      (x.outbox ??= []).push({ messageId, prompt, ...(scheduledFor ? { scheduledFor } : {}), ...(attachments.length ? { attachments } : {}), ...(effort ? { effort } : {}), actor, createdAt: now });
      // 部署排空中创建的会话：首条消息先压住，等新进程起来再发；否则会在这里启动一轮又被重启打断
      if (opts.hold) x.outboxPaused = { at: now, reason: "等待部署完成后发送", auto: true };
    }, undefined, { bump: false });
    this.syncQueuedTitle(platformSessionId);
    const out = this.outboxChanged(platformSessionId, "enqueue", actor, { messageId, images: attachments.length });
    // 入队时会话刚好空闲（本轮恰在此时结束）：直接发，不让它等下一轮
    if (!opts.hold) void this.drainOutbox(platformSessionId);
    return out;
  }

  /** 修改一条还没发出的排队消息（文字与图片整体替换） */
  editQueuedMessage(platformSessionId: string, messageId: string, input: { prompt: string; attachmentIds?: string[]; scheduledFor?: string }, actor: string): SessionBinding {
    const b = this.outboxSession(platformSessionId);
    if (!b.outbox?.some(m => m.messageId === messageId)) throw new RuntimeError("这条排队消息已发送或已撤销", 404, "RT_OUTBOX_GONE");
    if (b.outbox.find(m => m.messageId === messageId)?.steering) throw new RuntimeError("这条正在插话，送达或退回排队后才能修改", 409, "RT_OUTBOX_STEERING");
    const previousTime = b.outbox.find(m => m.messageId === messageId)?.scheduledFor;
    const scheduledFor = input.scheduledFor !== undefined && input.scheduledFor === previousTime ? previousTime : this.reservationTime(input.scheduledFor);
    const { prompt, attachments } = this.outboxContent(b, input, actor);
    const now = new Date().toISOString();
    this.store.updateBinding(platformSessionId, (x) => {
      const m = x.outbox?.find(y => y.messageId === messageId);
      if (!m) throw new RuntimeError("这条排队消息已发送或已撤销", 404, "RT_OUTBOX_GONE");
      m.prompt = prompt; m.updatedAt = now;
      if (scheduledFor) m.scheduledFor = scheduledFor;
      if (attachments.length) m.attachments = attachments; else delete m.attachments;
    }, undefined, { bump: false });
    this.syncQueuedTitle(platformSessionId);
    return this.outboxChanged(platformSessionId, "edit", actor, { messageId, images: attachments.length });
  }

  /** 撤销一条还没发出的排队消息 */
  removeQueuedMessage(platformSessionId: string, messageId: string, actor: string): SessionBinding {
    const b = this.managed(platformSessionId);
    if (!b.outbox?.some(m => m.messageId === messageId)) throw new RuntimeError("这条排队消息已发送或已撤销", 404, "RT_OUTBOX_GONE");
    if (b.outbox.find(m => m.messageId === messageId)?.steering) throw new RuntimeError("这条正在插话，送达或退回排队后才能撤销", 409, "RT_OUTBOX_STEERING");
    this.store.updateBinding(platformSessionId, (x) => {
      x.outbox = (x.outbox ?? []).filter(m => m.messageId !== messageId);
      if (!x.outbox.length) { delete x.outbox; delete x.outboxPaused; }
    }, undefined, { bump: false });
    this.syncQueuedTitle(platformSessionId);
    return this.outboxChanged(platformSessionId, "remove", actor, { messageId });
  }

  /** 调整顺序：order 必须恰好是当前队列的全部 messageId（另一端已改动时拒绝，避免覆盖） */
  reorderQueuedMessages(platformSessionId: string, order: unknown, actor: string): SessionBinding {
    this.outboxSession(platformSessionId);
    if (!Array.isArray(order) || order.some(id => typeof id !== "string")) throw new RuntimeError("order 必须是 messageId 数组", 400, "RT_INPUT");
    this.store.updateBinding(platformSessionId, (x) => {
      const cur = x.outbox ?? [];
      if (order.length !== cur.length || new Set(order).size !== order.length || order.some(id => !cur.some(m => m.messageId === id))) throw new RuntimeError("排队消息已变化（可能刚发出一条），请按最新顺序再调整", 409, "RT_OUTBOX_CHANGED");
      x.outbox = (order as string[]).map(id => cur.find(m => m.messageId === id)!);
    }, undefined, { bump: false });
    this.syncQueuedTitle(platformSessionId);
    return this.outboxChanged(platformSessionId, "reorder", actor);
  }

  /** 开始修改排队消息：先暂停自动发送，免得正在改的那条被发出去（已暂停时保持原因不变） */
  holdOutboxForEdit(platformSessionId: string, actor: string): SessionBinding {
    const b = this.outboxSession(platformSessionId);
    if (!b.outbox?.length || b.outboxPaused) return b;
    this.store.updateBinding(platformSessionId, (x) => { if (x.outbox?.length && !x.outboxPaused) x.outboxPaused = { at: new Date().toISOString(), reason: "正在修改排队消息", editing: true }; }, undefined, { bump: false });
    return this.outboxChanged(platformSessionId, "hold", actor);
  }

  /** 继续发送：解除暂停；会话空闲就立刻发队首。onlyEditHold：只解除「正在修改」造成的暂停，别的暂停原因保留 */
  resumeOutbox(platformSessionId: string, actor: string, opts: { onlyEditHold?: boolean } = {}): SessionBinding {
    const b = this.outboxSession(platformSessionId);
    if (opts.onlyEditHold && !b.outboxPaused?.editing) return b;
    if (b.outboxPaused) this.store.updateBinding(platformSessionId, (x) => { delete x.outboxPaused; }, undefined, { bump: false });
    const out = this.outboxChanged(platformSessionId, "resume", actor);
    void this.drainOutbox(platformSessionId);
    return out;
  }

  /**
   * 插话（Pi / Codex / Claude Code）：把一条排队消息送进正在运行的这一轮，在当前工具执行完、下一次调用模型前送达。
   * 送达（原生记录里出现这条用户消息）才移出队列；没送出或本轮结束前没送达，就留在排队里照常处理。
   * 插话沿用本轮的模型与推理强度。
   */
  async steerQueuedMessage(platformSessionId: string, messageId: string, actor: string): Promise<SessionBinding> {
    const b = this.outboxSession(platformSessionId);
    const m = b.outbox?.find(x => x.messageId === messageId);
    if (!m) throw new RuntimeError("这条排队消息已发送或已撤销", 404, "RT_OUTBOX_GONE");
    if (m.scheduledFor) throw new RuntimeError("预约消息不能插话，请修改预约时间", 409, "RT_STATE");
    if (m.steering) return b;
    const run = this.running.get(platformSessionId);
    if (!run?.handle || run.stopRequested) throw new RuntimeError("本轮没有在运行，无法插话；消息会在本轮结束后照常发出", 409, "RT_STEER_UNAVAILABLE");
    if (!run.handle.steer) throw new RuntimeError(`${RUNTIME_LABEL[b.runtimeKind]} 不支持插话，请排队发送`, 409, "RT_STEER_UNAVAILABLE");
    const images = m.attachments?.length ? this.attachments.images(m.attachments.map(a => a.attachmentId), platformSessionId) : undefined;
    const key = `${platformSessionId}|${messageId}`, turnNo = run.turnNo, clientMessageId = randomUUID();
    this.steeringInFlight.add(key);
    try {
      this.store.updateBinding(platformSessionId, (x) => { const y = x.outbox?.find(z => z.messageId === messageId); if (y) y.steering = { at: new Date().toISOString(), actor, turnNo, clientMessageId }; }, undefined, { bump: false });
      this.outboxChanged(platformSessionId, "steer", actor, { messageId, turnNo });
      await run.handle.steer({ clientMessageId, prompt: m.prompt, ...(images ? { images } : {}) });
      return this.store.binding(platformSessionId)!;
    } catch (e) {
      this.steeringInFlight.delete(key);
      this.clearSteering(platformSessionId, [messageId]);
      throw new RuntimeError(`插话没有送出：${bounded((e as Error).message, 300).text}。这条仍在排队`, 409, "RT_STEER_FAILED");
    } finally {
      this.steeringInFlight.delete(key);
      // 插话请求期间本轮已经结束：没送达的退回排队，接着照常发
      if (this.running.get(platformSessionId)?.turnNo !== turnNo) { this.clearUndeliveredSteers(platformSessionId); void this.drainOutbox(platformSessionId); }
    }
  }

  private clearSteering(pid: string, messageIds: string[]): void {
    this.store.updateBinding(pid, (x) => { for (const m of x.outbox ?? []) if (m.steering && messageIds.includes(m.messageId)) delete m.steering; }, undefined, { bump: false });
    this.emit("session", { platformSessionId: pid });
  }

  /** 本轮结束：还标着插话、又不在等应答的，说明没赶上本轮，退回排队并在对话里说明 */
  private clearUndeliveredSteers(pid: string): void {
    const stale = (this.store.binding(pid)?.outbox ?? []).filter(m => m.steering && !this.steeringInFlight.has(`${pid}|${m.messageId}`));
    if (!stale.length) return;
    this.clearSteering(pid, stale.map(m => m.messageId));
    const now = new Date().toISOString(), turnNo = stale[0]!.steering!.turnNo;
    this.store.upsertEvent(pid, {
      key: `platform:steer-undelivered:${stale.map(m => m.messageId).join(",")}`, kind: "notice", text: `插话没赶上第 ${turnNo} 轮（${stale.length} 条），已留在排队里`, turnNo,
      source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", recordedAt: now, occurredAt: now
    });
    this.emitEvent(pid);
    this.store.audit({ type: "outbox-steer-undelivered", platformSessionId: pid, messageIds: stale.map(m => m.messageId) });
  }

  private pauseOutbox(pid: string, reason: string, auto = false): void {
    const b = this.store.binding(pid);
    if (!b?.outbox?.length || b.outboxPaused) return;
    this.store.updateBinding(pid, (x) => { if (x.outbox?.length && !x.outboxPaused) x.outboxPaused = { at: new Date().toISOString(), reason: bounded(reason, 300).text, ...(auto ? { auto } : {}) }; }, undefined, { bump: false });
    this.store.audit({ type: "outbox-paused", platformSessionId: pid, reason: bounded(reason, 300).text });
    this.emit("session", { platformSessionId: pid });
  }

  /**
   * 发出队首：会话空闲、没暂停、指纹已刷新时才发。正在运行就什么也不做（本轮结束会再触发）。
   * 发送失败（排空、账号、图片等）暂停队列并写明原因，消息留在队首。
   */
  private async drainOutbox(pid: string): Promise<void> {
    if (this.outboxSending.has(pid) || this.fingerprintPending.has(pid) || this.shuttingDown) return;
    this.outboxSending.add(pid);
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const b = this.store.binding(pid), head = b?.outbox?.find(m => !m.scheduledFor || Date.parse(m.scheduledFor) <= Date.now());
        if (!b || !head || b.outboxPaused || b.archived || b.conflict || head.steering) return;
        if (this.running.has(pid) || b.status !== "idle" || b.turns.some(t => ["queued", "running", "waiting-input"].includes(t.status))) return;
        try {
          const r = await this.sendTurn(pid, { idempotencyKey: `q-${head.messageId}`, prompt: head.prompt, attachmentIds: (head.attachments ?? []).map(a => a.attachmentId), expectedRevision: b.bindingRevision, ...(head.effort ? { effort: head.effort } : {}), outbox: { messageId: head.messageId, digest: outboxDigest(head) } }, head.actor);
          this.store.audit({ type: "outbox-sent", platformSessionId: pid, messageId: head.messageId, turnNo: r.operation.turnNo ?? null });
          return;
        } catch (e) {
          const code = (e as { code?: string }).code ?? "";
          if (code === "RT_BUSY") return;
          if (["RT_CONFLICT", "RT_OUTBOX_GONE", "RT_OUTBOX_CHANGED"].includes(code) && attempt < 3) continue;
          this.pauseOutbox(pid, `自动发送失败：${(e as Error).message}`, code === "RT_DRAINING");
          return;
        }
      }
    } finally { this.outboxSending.delete(pid); this.armReservation(pid); }
  }

  /** V3.0：角色行为验收证据（第三层）。只记验收结论引用，不改会话版本号 */
  recordRoleBehavior(platformSessionId: string, ref: string): SessionBinding {
    const b = this.managed(platformSessionId);
    if (!b.role) throw new RuntimeError("该会话没有角色绑定", 409, "RT_STATE");
    this.store.audit({ type: "role-behavior-verified", platformSessionId, ref });
    return this.store.updateBinding(platformSessionId, (x) => { x.role!.evidence.behaviorVerified = { at: new Date().toISOString(), ref }; }, undefined, { bump: false });
  }

  /** 外部写入冲突后：重新核对绑定与版本，用户显式恢复写入 */
  async resumeWrites(platformSessionId: string, expectedRevision: number, actor: string): Promise<SessionBinding> {
    const b = this.managed(platformSessionId);
    if (!b.conflict) return b;
    if (!b.nativeSessionId) throw new RuntimeError("没有原生会话", 409, "RT_STATE");
    const fp = await this.driver(b.runtimeKind).fingerprint(b.nativeSessionId, { workspace: b.workspace, ...(b.nativeFingerprint ? { previous: b.nativeFingerprint.value } : {}) }).catch(() => undefined);
    if (!fp) throw new RuntimeError("无法核对原生会话状态，维持只读", 409, "RT_UNVERIFIED");
    if (fp.note) this.noteFingerprint(platformSessionId, fp.note);
    if ((fp as { active?: boolean }).active) throw new RuntimeError("原生会话仍有活动，维持只读", 409, "RT_EXTERNAL_WRITE");
    await this.backfill(platformSessionId).catch(() => {});
    const out = this.store.updateBinding(platformSessionId, (x) => {
      delete x.conflict;
      x.nativeFingerprint = { value: fp.value, checkedAt: new Date().toISOString() };
      x.statusReason = "已核对并恢复平台写入";
    }, expectedRevision);
    this.store.audit({ type: "resume-writes", platformSessionId, actor });
    this.emit("session", { platformSessionId });
    return out;
  }

  private markConflict(platformSessionId: string, reason: string, evidence: string): void {
    this.store.updateBinding(platformSessionId, (x) => { x.conflict = { detectedAt: new Date().toISOString(), reason, evidence }; });
    this.store.audit({ type: "external-write", platformSessionId, reason });
    void this.backfill(platformSessionId).catch(() => {});
    this.emit("session", { platformSessionId });
  }

  /** 指纹相关但不是冲突的情况（读不到原生记录沿用上次、语式升级重建基线）：只记审计，不拦写入 */
  private noteFingerprint(platformSessionId: string, note: string): void {
    this.store.audit({ type: "fingerprint-note", platformSessionId, note: bounded(note, 200).text });
  }

  /** 只接收 driver 从同一原生快照证明的本轮后台续写，不加载或猜测整段历史。 */
  private async syncNativeContinuation(pid: string) {
    const b = this.store.binding(pid);
    const live = b?.nativeSessionId ? this.driver(b.runtimeKind).continuationState?.(b.nativeSessionId) : undefined;
    const turn = live ? b?.turns.find(t => t.clientMessageId === live.clientMessageId) : b?.turns.at(-1);
    const latestTurnNo = b?.turns.at(-1)?.turnNo;
    if (this.shuttingDown || !b?.nativeSessionId || !b.nativeFingerprint || b.conflict || b.archived || this.running.has(pid) || turn?.status !== "completed" || !turn.endedAt) return undefined;
    const read = this.driver(b.runtimeKind).readContinuation;
    if (!read) return undefined;
    const toolCallIds = this.store.events(pid).filter(e => e.turnNo === turn.turnNo && e.source === "stream" && e.kind === "tool")
      .map(e => e.key.split(":tool:")[1]).filter((id): id is string => !!id);
    const previous = b.nativeFingerprint.value;
    const result = await read.call(this.driver(b.runtimeKind), b.nativeSessionId, { previous, toolCallIds, endedAt: turn.endedAt }).catch(() => undefined);
    const cur = this.store.binding(pid);
    if (!result || this.shuttingDown || !cur || cur.conflict || cur.bindingRevision !== b.bindingRevision || cur.nativeFingerprint?.value !== previous || this.running.has(pid) || cur.turns.at(-1)?.turnNo !== latestTurnNo) return undefined;
    const sameTurn = (x: SessionBinding) => !x.conflict && !x.archived && x.bindingRevision === b.bindingRevision && x.turns.at(-1)?.turnNo === latestTurnNo && x.turns.find(t => t.turnNo === turn.turnNo)?.status === "completed";
    let changed = false;
    const existing = new Map(this.store.events(pid).map(e => [e.key, e]));
    const streamedKeys = new Set([...(b.nativeFingerprint.streamedKeys ?? []), ...(result.streamedKeys ?? [])]);
    for (const event of result.events) {
      if (streamedKeys.has(event.key)) continue;
      const old = existing.get(event.key);
      if (old && old.text === event.text && old.partial === event.partial &&
          old.tool?.name === event.tool?.name && old.tool?.input === event.tool?.input &&
          old.tool?.output === event.tool?.output && old.tool?.status === event.tool?.status) continue;
      this.ingest(pid, event, turn.turnNo); changed = true;
    }
    // Partial responses keep the old baseline, so a later status/text update of the same native step is read again.
    if (!result.active && (result.fingerprint !== previous || streamedKeys.size !== (b.nativeFingerprint.streamedKeys?.length ?? 0))) this.store.updateBinding(pid, x => { x.nativeFingerprint = { value: result.fingerprint, checkedAt: new Date().toISOString(), ...(streamedKeys.size ? { streamedKeys: [...streamedKeys] } : {}) }; }, undefined, { bump: false, guard: x => sameTurn(x) && x.nativeFingerprint?.value === previous });
    if (changed) {
      this.store.updateBinding(pid, x => { delete x.quickReplies; delete x.quickAction; }, undefined, { bump: false, guard: sameTurn });
      this.store.audit({ type: "native-background-continuation", platformSessionId: pid, turnNo: turn.turnNo, previous, fingerprint: result.fingerprint, active: result.active });
      this.emit("session", { platformSessionId: pid }); this.emit("directory", {});
      if (!result.active) void this.finalQuickReplies(pid).catch(() => {});
    }
    return result;
  }

  /** 有界观察原进程的后台任务；超出观察期后，查看和发送前仍会重新核对。 */
  private watchNativeContinuation(pid: string, until = Date.now() + 10 * 60_000): void {
    if (this.shuttingDown || this.continuationTimers.has(pid) || Date.now() >= until) return;
    const b = this.store.binding(pid);
    if (!b || b.conflict || b.archived || this.running.has(pid) || b.turns.at(-1)?.status !== "completed" || !this.driver(b.runtimeKind).readContinuation) return;
    const timer = setTimeout(() => {
      this.continuationTimers.delete(pid);
      void this.syncNativeContinuation(pid).then(result => {
        if (!result || result.pending || result.active) this.watchNativeContinuation(pid, until);
        else {
          const pending = this.continuationFinalizers.get(pid);
          if (pending) void this.completeIdleTurn(pid, pending.turnNo, pending.stopRequested);
          else void this.drainOutbox(pid);
        }
      }).catch(() => {});
    }, 2000);
    timer.unref(); this.continuationTimers.set(pid, timer);
  }

  /** Automatic checks and queued inputs share the same continuation boundary. */
  private async completeIdleTurn(pid: string, turnNo: number, stopRequested: boolean): Promise<void> {
    if (this.continuationFinalizing.has(pid)) return;
    this.continuationFinalizing.add(pid);
    try {
      const b = this.store.binding(pid);
      if (!b || b.turns.at(-1)?.turnNo !== turnNo || this.running.has(pid)) return;
      if (b.nativeSessionId && this.driver(b.runtimeKind).continuationState?.(b.nativeSessionId)) {
        const proof = await this.syncNativeContinuation(pid);
        const live = this.driver(b.runtimeKind).continuationState?.(b.nativeSessionId);
        if (proof?.active || proof?.pending || live?.active) {
          this.continuationFinalizers.set(pid, { turnNo, stopRequested });
          this.watchNativeContinuation(pid);
          return;
        }
      }
      this.continuationFinalizers.delete(pid);
      try {
        const sent = await this.enforceMemoryRules(pid, turnNo, stopRequested) || await this.enforceUiReport(pid, turnNo, stopRequested);
        if (!sent) await this.drainOutbox(pid);
      } catch { await this.drainOutbox(pid); }
      // A notification arriving during asynchronous evidence collection defers checks again.
      const cur = this.store.binding(pid);
      if (cur?.turns.at(-1)?.turnNo === turnNo && cur.nativeSessionId && this.driver(cur.runtimeKind).continuationState?.(cur.nativeSessionId)?.active) {
        this.continuationFinalizers.set(pid, { turnNo, stopRequested }); this.watchNativeContinuation(pid);
      }
    } finally { this.continuationFinalizing.delete(pid); }
  }

  /* ============================ 调度 ============================ */

  private runningCount(profileId: string): number {
    let n = 0;
    for (const [id] of this.running) if (this.store.binding(id)?.runtimeProfileId === profileId) n++;
    return n;
  }

  /** Room capacity spans all rooms; uncertain native effects retain their place. */
  private roomCapacityReached(binding: SessionBinding): boolean {
    if (!binding.roomRef) return false;
    const members = this.store.allBindings().filter(b => b.roomRef && b.runtimeKind === binding.runtimeKind);
    const held = new Set(members.filter(b => this.running.has(b.platformSessionId)).map(b => b.platformSessionId));
    const ledgers = new Map<string, ReturnType<SharedSlots["inspect"]>>();
    for (const member of members) {
      if (!ledgers.has(member.identityScopeId)) ledgers.set(member.identityScopeId, this.sharedSlots.inspect(member.identityScopeId));
      const ledger = ledgers.get(member.identityScopeId);
      if (ledger && "status" in ledger) return true;
      const operations = new Set(member.turns.map(t => t.operationId));
      if (ledger?.reservations.some(r => operations.has(r.operationId) && r.status !== "released")) held.add(member.platformSessionId);
    }
    return held.size >= 2;
  }

  projectExecutionUsage(projectId: string) {
    const policy = this.projectAdmissionSource?.(projectId);
    const scopes = this.store.allBindings().filter(b => b.projectRef === projectId).map(b => b.identityScopeId);
    return this.sharedSlots.projectUsage(projectId, policy ? { ...policy, existingScopes: scopes } : undefined, scopes);
  }

  private admissionRequest(b: SessionBinding, operationId: string) {
    const policy = b.projectRef ? this.projectAdmissionSource?.(b.projectRef) : undefined;
    const projectPolicy = policy ? { ...policy, existingScopes: this.store.allBindings().filter(x => x.projectRef === b.projectRef).map(x => x.identityScopeId) } : undefined;
    return { identityScopeId: b.identityScopeId, projectId: b.projectRef ?? b.platformSessionId, operationId, ownerId: this.slotOwner, limit: this.settings().maxRunningPerProfile, admissionClass: b.admissionClass ?? "business", ...(projectPolicy ? { projectPolicy } : {}) };
  }

  /** Publish the entire local queue before shared priority selection; never reserve for a waiting turn. */
  private schedule(opts: { dispatch?: boolean } = {}): void {
    const max = this.settings().maxRunningPerProfile;
    const queued = this.store.allOperations().filter(o => (o.state === "prepared" || o.state === "queued") && this.pendingPrompts.has(o.operationId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const ready = new Set<string>();
    for (const op of queued) {
      const b = this.store.binding(op.platformSessionId); if (!b) continue;
      try {
        const ledger = this.sharedSlots.inspect(b.identityScopeId);
        const previous = new Set(b.turns.filter(t => t.operationId !== op.operationId).map(t => t.operationId));
        const held = !!ledger && ("status" in ledger || ledger.reservations.some(r => previous.has(r.operationId) && r.status !== "released"));
        const available = (!this.draining || this.finishQueuedOnDrain) && !this.running.has(b.platformSessionId) && this.runningCount(b.runtimeProfileId) < max && !this.roomCapacityReached(b) && !held;
        const result = this.sharedSlots.enqueue(this.admissionRequest(b, op.operationId), available);
        if (available && result.status === "queued") ready.add(op.operationId);
        else if (op.state !== "queued") {
          this.store.stepOperation(op.operationId, "queued", "等待共享调度、原生终态或 runtime 名额", "queued");
          this.store.updateBinding(b.platformSessionId, x => { x.statusReason = "排队中：等待共享调度与名额核对"; });
          this.emit("session", { platformSessionId: b.platformSessionId });
        }
      } catch (e) { console.error(`Shared queue held (${op.operationId}):`, e); }
    }
    // 创建请求里只同步登记排队意图（共享名额的优先级要能看到它），真正启动原生进程留到响应之后。
    if (opts.dispatch === false) return;
    if (this.draining && !this.finishQueuedOnDrain) return;
    for (const op of queued) {
      const b = this.store.binding(op.platformSessionId);
      if (!b || !ready.has(op.operationId) || this.running.has(b.platformSessionId) || this.runningCount(b.runtimeProfileId) >= max || this.roomCapacityReached(b)) continue;
      const dispatch = this.dispatch(op.operationId).catch(e => {
        console.error(`外部会话派发出错（${op.operationId}）：`, e);
        this.running.delete(op.platformSessionId);
        try { this.store.stepOperation(op.operationId, "dispatch-error", bounded((e as Error).message, 200).text, "unknown"); } catch { /* Hold durable capacity. */ }
        try { this.store.updateBinding(b.platformSessionId, x => { x.status = "unknown"; x.statusReason = `平台内部错误：${bounded((e as Error).message, 200).text}`; }); } catch { /* Storage unavailable. */ }
      });
      this.dispatches.add(dispatch);
      void dispatch.finally(() => this.dispatches.delete(dispatch));
    }
  }

  queuePosition(platformSessionId: string): number | undefined {
    const b = this.store.binding(platformSessionId);
    if (!b) return undefined;
    const op = this.store.allOperations().find(o => o.platformSessionId === platformSessionId && o.state === "queued");
    if (!op) return undefined;
    try { return this.sharedSlots.queuePosition(b.identityScopeId, op.operationId); } catch { return undefined; }
  }

  private retireQueue(op: OperationRecord, b: SessionBinding): void {
    this.store.stepOperation(op.operationId, "shared-queue-cancelled", "host observed undispatched intent", "failed");
    this.queueRetirements.set(op.operationId, { scope: b.identityScopeId, sourceRef: `runtime-operation:${op.operationId}:shared-queue-cancelled` });
    this.flushSlotFacts();
  }

  private flushSlotFacts(): void {
    for (const [id, fact] of this.queueRetirements) {
      try { if (this.sharedSlots.cancelQueued(fact.scope, id, { outcome: "not-executed", sourceRef: fact.sourceRef }).status === "cancelled") this.queueRetirements.delete(id); }
      catch (error) { console.error(`Shared queue cancellation held (${id}):`, error); }
    }
    for (const [id, fact] of this.usageFacts) {
      try { if (this.sharedSlots.recordUsage(fact.scope, id, fact.receipt).status !== "busy") this.usageFacts.delete(id); }
      catch (error) { console.error(`Native usage reconciliation held (${id}):`, error); }
    }
    for (const [id, fact] of this.slotFacts) {
      if (this.usageFacts.has(id)) continue; // Receipt publication must precede capacity release.
      try {
        if (this.sharedSlots.release(fact.scope, id, { outcome: fact.outcome, sourceRef: fact.sourceRef }).status === "released") this.slotFacts.delete(id);
      } catch (error) { console.error(`Shared slot reconciliation failed (${id}):`, error); }
    }
  }

  private validateTurnUsage(op: OperationRecord, b: SessionBinding, value: unknown): NativeTurnUsageReceipt {
    const receipt = nativeTurnUsageReceipt(value), turn = b.turns.find(t => t.operationId === op.operationId);
    if (!turn || receipt.runtimeKind !== b.runtimeKind || receipt.nativeSessionId !== b.nativeSessionId || receipt.nativeTurnId !== turn.nativeTurnId || receipt.clientMessageId !== turn.clientMessageId) throw new Error("Native usage receipt belongs to another turn/session/runtime/client");
    return receipt;
  }

  private observeTurnUsage(op: OperationRecord, b: SessionBinding, value: NativeTurnUsageReceipt): void {
    try {
      const receipt = this.validateTurnUsage(op, b, value);
      const prior = op.steps.find(x => x.step === "native-turn-usage");
      if (prior && JSON.stringify(nativeTurnUsageReceipt(JSON.parse(prior.detail))) !== JSON.stringify(receipt)) throw new Error("Conflicting persisted native usage receipt");
      if (!prior) this.store.stepOperation(op.operationId, "native-turn-usage", JSON.stringify(receipt));
      this.usageFacts.set(op.operationId, { scope: b.identityScopeId, receipt });
    } catch (error) { this.store.audit({ type: "native-usage-rejected", operationId: op.operationId, reason: String(error) }); }
  }

  /**
   * 本轮原生结果是不是「明确拒绝执行」：额度不足 / 账号认证失败。
   * 只看本轮的 native 证据（结构化错误码或错误正文），不看超时、断连这类传输现象——那些仍然留 unknown 等人核对。
   */
  private rejectionOf(result: { status: string; code?: string; reason?: string }): "quota" | "auth" | undefined {
    if (result.status === "completed") return undefined;
    const code = result.code ?? "", text = result.reason ?? "";
    if (AUTH_CODES.has(code) || AUTH_FAILURE.test(text)) return "auth";
    if (QUOTA_CODES.has(code) || QUOTA_FAILURE.test(text)) return "quota";
    return undefined;
  }

  private observeSlot(op: OperationRecord, b: SessionBinding, outcome: "completed" | "not-executed", state: OperationRecord["state"] = outcome === "completed" ? "confirmed" : "failed"): void {
    // Durable host observation precedes release; a crash retries this exact proof, never the native effect.
    this.store.stepOperation(op.operationId, "shared-slot-terminal", outcome, state);
    this.slotFacts.set(op.operationId, { scope: b.identityScopeId, outcome, sourceRef: `runtime-operation:${op.operationId}:shared-slot-terminal` });
    this.flushSlotFacts();
  }

  private async dispatch(operationId: string): Promise<void> {
    const op = this.store.operation(operationId)!;
    const pid = op.platformSessionId;
    const b = this.store.binding(pid)!;
    const input = this.pendingPrompts.get(operationId);
    if (!input) return;
    const previousOperations = new Set(b.turns.filter(t => t.operationId !== operationId).map(t => t.operationId));
    const ledger = this.sharedSlots.inspect(b.identityScopeId);
    const sameSessionHeld = ledger && !("status" in ledger) && ledger.reservations.some(r => previousOperations.has(r.operationId) && r.status !== "released");
    if (sameSessionHeld || ledger && "status" in ledger) {
      if (op.state !== "queued") {
        this.store.stepOperation(operationId, "queued", "原会话旧轮次尚无可信终态，等待核对", "queued");
        this.store.updateBinding(pid, x => { x.statusReason = "排队中：旧轮次停止结果仍需核对"; });
        this.emit("session", { platformSessionId: pid });
      }
      return;
    }
    const slot = this.sharedSlots.reserve(this.admissionRequest(b, operationId));
    if (slot.status !== "reserved") {
      const budgetBlocked = slot.status === "budget-exhausted" || slot.status === "budget-unknown";
      const reason = budgetBlocked ? `预算阻塞：${slot.reason}` : `排队中：共享账号名额 ${slot.status}`;
      if (op.state !== "queued" || budgetBlocked && b.statusReason !== reason) {
        this.store.stepOperation(operationId, budgetBlocked ? "budget-blocked" : "queued", slot.reason ?? `共享账号名额等待核对：${slot.status}`, "queued");
        this.store.updateBinding(pid, x => { x.statusReason = reason; });
        this.emit("session", { platformSessionId: pid });
      }
      return;
    }
    // Keep the active turn and its approval handling on the old policy until a new dispatch.
    if (b.pendingPermissionMode && op.turnNo! > (b.pendingPermissionAfterTurn ?? 0)) {
      const next = this.sessionPermissionOptions(b).find(p => p.id === b.pendingPermissionMode);
      if (!next) {
        this.observeSlot(op, b, "not-executed");
        this.pendingPrompts.delete(operationId);
        this.store.stepOperation(operationId, "permission-invalid", "待生效权限已不受支持", "failed");
        this.finishTurn(pid, op.turnNo!, { status: "failed", reason: "待生效权限已不受支持，请重新选择权限模式" }, false);
        this.schedule(); return;
      }
      this.store.updateBinding(pid, x => {
        x.permissionMode = next.id; x.permissionLabel = next.label;
        delete x.pendingPermissionMode; delete x.pendingPermissionAfterTurn; delete x.approvalGrant;
      });
    }
    this.store.stepOperation(operationId, "shared-slot-reserved", b.identityScopeId);
    this.pendingPrompts.delete(operationId);
    const turnNo = op.turnNo!;
    const turn = b.turns.find((t) => t.turnNo === turnNo)!;
    const run: Running = { turnNo, operationId, approvals: new Set() };
    this.running.set(pid, run);
    this.store.stepOperation(operationId, "dispatching", `发往 ${RUNTIME_LABEL[b.runtimeKind]}`, "dispatching");
    this.store.updateBinding(pid, (x) => {
      const t = x.turns.find((y) => y.turnNo === turnNo)!;
      t.status = "running"; t.startedAt = new Date().toISOString();
      x.lastActivityAt = { at: t.startedAt, source: "platform" };
      x.statusReason = op.kind === "create" ? "正在创建原生会话" : "正在恢复原生会话";
    });
    this.emit("session", { platformSessionId: pid });
    this.emit("directory", {});
    const sink = this.sinkFor(pid, turnNo, operationId);
    // V3.0：有角色绑定的会话每轮都重新注入同一份角色正文；正文丢失则不发送（不以无角色身份继续）
    let roleInstructions = b.role ? this.store.role(pid) : undefined;
    if (b.role && !roleInstructions) {
      this.running.delete(pid);
      this.observeSlot(op, b, "not-executed");
      this.store.stepOperation(operationId, "role-missing", "角色正文缺失", "failed", "角色正文缺失，未发送；不以无角色身份继续");
      this.finishTurn(pid, turnNo, { status: "failed", reason: "角色正文缺失，未发送" }, false);
      this.schedule();
      return;
    }
    let handle: TurnHandle;
    let platformBrowser: Awaited<ReturnType<typeof startPlatformBrowser>> | undefined;
    try {
      if (b.evaluationPolicyHash && this.evaluationPolicy(b.runtimeKind)?.policyHash !== b.evaluationPolicyHash) throw new DriverStageError("Evaluation policy changed; not dispatched", "create");
      if (b.evaluation) {
        let checked: EvaluationBoundary;
        try { checked = normalizeEvaluation(b.workspace, b.evaluation); }
        catch (error) { throw new DriverStageError(`Evaluation boundary invalid: ${(error as Error).message}`, "create"); }
        if (!evaluationPermission(b.runtimeKind, effectivePermissionMode(b)) || JSON.stringify(checked) !== JSON.stringify(b.evaluation)) throw new DriverStageError("Evaluation policy paths or permissions changed; not dispatched", "create");
      }
      const selectedModel = input.model ?? b.requestedModel ?? (b.evaluation && b.nativeSessionId ? b.effectiveModel : undefined);
      if (b.evaluation && b.nativeSessionId && !selectedModel?.trim()) throw new DriverStageError("Protected continuation has no original effective model; preserve binding and reconcile before input", "create", b.nativeSessionId, true);
      // Codex 的累计快照携带请求数；续聊时把已持久化的基数带下去，避免驱动重启后从 0 重新数
      const priorRequestCount = b.runtimeKind === "codex" ? summarizeUsage(this.store.usageFor(b.platformSessionId)).requestCount : undefined;
      // 平台技能：派发这一刻对提示词做两件事，所有 runtime 同一条路径——
      //   1) 用户写的 `/技能名` 展开成「技能说明 + 用户原文」；2) 会话首轮补一份技能目录，让模型自己判断要不要调用。
      // 会话里记录的用户消息、幂等键、排队摘要仍是原文；评估保护会话和群聊只读成员两件事都不做（边界不允许跑技能里的命令）。
      // 自动化会话（项目 / 角色 / 评估）和群聊只读成员不展开也不补目录：它们的提示词是平台写的，不该带上给人用的技能。
      const platformPromptOn = !b.evaluation && !b.projectRef && !b.role
        && !(b.roomRef && b.permissionMode === readOnlyPermissionMode(b.runtimeKind));
      const skillsOn = this.platformSkillsRoot !== undefined && platformPromptOn;
      const skillPrep = skillsOn
        ? preparePlatformPrompt(input.prompt, { firstTurn: turnNo === 1, root: this.platformSkillsRoot!, ...(this.platformSkillSwitches?.disabledIds().length ? { disabled: this.platformSkillSwitches.disabledIds() } : {}), ...(b.platformSkillsExclude?.length ? { exclude: b.platformSkillsExclude } : {}) })
        : { prompt: input.prompt, skills: [] as PlatformSkillInfo[], indexed: [] as PlatformSkillInfo[] };
      // 平台公共记忆：只在会话首轮、同样不进自动化 / 评估会话；失败只是不注入，不影响派发。
      let dispatchPrompt = skillPrep.prompt;
      if (platformPromptOn && turnNo === 1 && this.publicMemoryProvider) {
        try {
          const memory = this.publicMemoryProvider({ runtimeKind: b.runtimeKind, workspace: b.workspace, ...(b.worktree ? { repoRoot: b.worktree.repoRoot } : {}) });
          if (memory?.text?.trim()) {
            dispatchPrompt = prependPlatformPreamble(memory.text, dispatchPrompt);
            this.ingest(pid, { key: `platform-memory:${turnNo}`, kind: "notice", text: (memory.count>0?`已载入平台公共记忆：${memory.count} 条`:`已载入公共记忆按需索引${memory.onDemand!==undefined?`：${memory.onDemand} 条`:""}`)+(memory.rules?.length?`，其中 ${memory.rules.length} 条强约束已登记检查规则（每轮结束后校验）`:""), source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", injection: { label: "平台公共记忆", text: memory.text, count: memory.count, ...(memory.onDemand !== undefined ? { onDemand: memory.onDemand } : {}), ...(memory.rules?.length ? { rules: memory.rules } : {}) } }, turnNo);
            try { this.publicMemoryObserver?.injected?.({ platformSessionId: pid, runtimeKind: b.runtimeKind }); } catch { /* 统计失败不影响派发 */ }
          }
        } catch { /* 公共记忆读不了就不注入 */ }
      }
      if (skillPrep.skills.length) this.ingest(pid, { key: `platform-skill:${turnNo}`, kind: "notice", text: `已载入平台技能：${skillPrep.skills.map((x) => x.name).join("、")}`, source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded" }, turnNo);
      const recordBinding = this.store.binding(pid) ?? b;
      const recordAccess = this.profile(recordBinding.runtimeKind)?.capabilities.roleInstructions?.status === "supported" && !recordBinding.evaluation && !(recordBinding.roomRef && recordBinding.permissionMode === readOnlyPermissionMode(recordBinding.runtimeKind)) ? this.recordAccessProvider?.(recordBinding,turn.clientMessageId) : undefined;
      if(recordAccess)roleInstructions=[roleInstructions,runtimeRecordInstructions(recordAccess)].filter(Boolean).join("\n\n");
      if (!b.evaluation && !(b.roomRef && b.permissionMode === readOnlyPermissionMode(b.runtimeKind))) {
        platformBrowser = await startPlatformBrowser({sessionId:pid,turnId:turn.clientMessageId,workspace:b.workspace,outputDir:join(b.workspace,".platform-browser",pid),event:e=>sink.event(e)});
        run.closeBrowser=platformBrowser.dispose;
        roleInstructions=[roleInstructions,SCREENSHOT_INSTRUCTIONS,LINK_READ_INSTRUCTIONS].filter(Boolean).join("\n\n");
      }
      await this.markWorkspaceBaseline(b, turnNo);
      handle = await this.driver(b.runtimeKind).startTurn({
        platformSessionId: b.platformSessionId,
        ...(platformBrowser ? {platformBrowser:platformBrowser.access}:{}),
        ...(recordAccess?{recordReadRoots:[recordAccess.contextFile,recordAccess.clientPath]}:{}),
        ...(b.nativeSessionId ? { nativeSessionId: b.nativeSessionId } : {}),
        ...(input.presetSessionId ? { presetSessionId: input.presetSessionId } : {}),
        workspace: b.workspace, ...(selectedModel ? { model: selectedModel } : {}),
        ...(b.worktree ? { worktree: { repoRoot: b.worktree.repoRoot, path: b.worktree.path, branch: b.worktree.branch } } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(b.browserProfileId ? { browserProfileId: b.browserProfileId } : {}),
        permissionMode: effectivePermissionMode(b),
        // 群聊只读成员：工具收紧到只读；可写成员（独立 worktree）按所选权限走审批
        ...(b.roomRef && b.permissionMode === readOnlyPermissionMode(b.runtimeKind) ? { readOnlyRoom: true } : {}),
        ...(roleInstructions ? { roleInstructions } : {}),
        ...(b.evaluation ? { evaluation: structuredClone(b.evaluation) } : {}),
        prompt: dispatchPrompt, ...(input.attachmentIds?.length ? { images: this.attachments.images(input.attachmentIds, pid) } : {}), clientMessageId: turn.clientMessageId,
        ...(priorRequestCount !== undefined ? { priorRequestCount } : {})
      }, sink);
    } catch (e) {
      await platformBrowser?.dispose();
      this.running.delete(pid);
      const err = e as Error;
      const stage = e instanceof DriverStageError ? e.stage : "unknown";
      const native = e instanceof DriverStageError ? e.nativeSessionId : undefined;
      const msg = bounded(err.message, 600).text;
      const cur = this.store.binding(pid)!;
      const notExecuted = stage === "spawn" || stage === "create" || e instanceof DriverStageError && e.notExecuted;
      if (!notExecuted) {
        if (!cur.nativeSessionId && native) this.bindNative(pid, native, { modelSource: "异常前的原生响应" });
        this.store.stepOperation(operationId, "unknown", msg, "unknown", "响应异常，结果未知；不会自动重发");
        this.finishTurn(pid, turnNo, { status: "unknown", reason: `结果未知：${msg}` }, false);
      } else if (native || cur.nativeSessionId) {
        // V28-05：原生会话已建、首轮发送失败 → 保留原生 ID，恢复时不再建一份
        if (!cur.nativeSessionId && native) this.bindNative(pid, native, { modelSource: "失败前的原生响应" });
        this.store.stepOperation(operationId, "dispatch-failed", msg, "failed", `原生会话已就绪，发送本轮失败：${msg}`);
        this.finishTurn(pid, turnNo, { status: "failed", reason: `发送失败：${msg}` }, false);
      } else {
        this.store.stepOperation(operationId, "create-failed", msg, "failed", `创建原生会话失败（${stage}）：${msg}`);
        this.store.updateBinding(pid, (x) => {
          const t = x.turns.find((y) => y.turnNo === turnNo)!;
          t.status = "failed"; t.statusReason = msg; t.endedAt = new Date().toISOString();
          x.status = "failed"; x.statusReason = `创建失败：${msg}`;
        });
      }
      const processEnded = e instanceof DriverStageError ? e.processEnded : undefined;
      if (notExecuted) this.observeSlot(op, b, "not-executed");
      else if (processEnded) {
        // 进程已确认退出：不会再有残留执行，放名额；回合结果仍如实标「未知」，不自动重发
        this.store.stepOperation(operationId, "process-ended", bounded(processEnded, 400).text);
        this.observeSlot(op, b, "completed", "unknown");
      } else this.sharedSlots.markUnknown(b.identityScopeId, operationId, `Dispatch outcome requires reconciliation: ${msg}`);
      this.store.audit({ type: "dispatch-failed", platformSessionId: pid, operationId, stage, message: msg });
      this.emit("session", { platformSessionId: pid });
      this.emit("directory", {});
      this.schedule();
      return;
    }
    run.handle = handle;
    this.store.stepOperation(operationId, "confirmed", "原生会话已就绪，本轮输入已送出", "confirmed");
    this.store.updateBinding(pid, (x) => {
      if (x.status === "creating" || x.status === "idle" || x.status === "interrupted" || x.status === "unknown") x.status = "running";
      x.statusReason = "本轮运行中";
    });
    this.emit("session", { platformSessionId: pid });
    // 运行中途收到停止请求（还没拿到 handle 时）
    if (run.stopRequested) void handle.interrupt().catch(() => {});
    const result = await handle.done;
    const closeBrowser = async () => {
      await platformBrowser?.dispose();
      if(platformBrowser?.receipts.length){
        const events=this.store.events(pid),failed=platformBrowser.receipts.filter(r=>!verifyScreenshotReceipt(r,pid,events));
        this.ingest(pid,{key:`browser-provenance:${turnNo}`,kind:"notice",source:"platform",parserVersion:PROJECTION_VERSION,availability:"recorded",text:failed.length?`截图来源校验未通过：${failed.length} 张图片缺少真实工具调用关联或字节已变化，不可用作验收证据。`:`截图来源校验通过：${platformBrowser.receipts.length} 张，已关联真实工具调用与 SHA-256。`},turnNo);
      }
    };
    if (handle.continuationDone) void handle.continuationDone.then(closeBrowser).catch(() => {});
    else await closeBrowser();
    const terminal = result.terminalObserved === true && result.status !== "unknown";
    // 原生明确拒绝执行（额度 / 认证错误 result）：本轮不会再产出原生工作，名额按 not-executed 放掉。
    // 这类预留留在 unknown 就是永久占用（unknown 永不按时间过期），部署脚本见 unknownOps > 0 就永远等不到空闲，
    // 排空一开就一直压住用户新消息。证据只认本轮原生报出的错误码 / 错误正文，不拿传输异常去猜。
    const rejection = terminal ? undefined : this.rejectionOf(result);
    if (terminal) {
      if (result.usageReceipt) this.observeTurnUsage(op, this.store.binding(pid)!, result.usageReceipt);
      this.observeSlot(op, b, "completed");
    } else if (result.processEnded) {
      // 进程已确认退出：这一轮不可能还在运行，释放名额；结果仍按原生记录如实标注（可能仍是未知）
      this.store.stepOperation(operationId, "process-ended", bounded(result.processEnded, 400).text);
      this.observeSlot(op, b, "completed");
    } else if (rejection) {
      this.store.stepOperation(operationId, "native-rejected", `${rejection === "quota" ? "额度" : "认证"}拒绝执行，名额按未执行释放：${bounded(result.reason ?? result.code ?? "", 400).text}`, "failed");
      this.observeSlot(op, b, "not-executed");
    } else this.sharedSlots.markUnknown(b.identityScopeId, operationId, result.reason ?? "Native terminal result unconfirmed");
    this.running.delete(pid);
    this.finishTurn(pid, turnNo, terminal ? result
      : result.processEnded && result.status !== "unknown" ? result
      : rejection ? { ...result, status: "failed" }
      : { ...result, status: "unknown", reason: [result.reason ?? "原生终态尚未确认", result.processEnded ? "进程已结束，名额已释放" : ""].filter(Boolean).join("；") }, run.stopRequested === true);
    // 额度：本轮结束后刷新一次（失败不影响会话）
    void this.refreshRateLimit(b.runtimeKind).catch(() => {});
    if (turnNo === 1 && b.nativeSessionId && this.store.binding(pid)?.titleGeneration) {
      const nativeId = b.nativeSessionId;
      void this.driver(b.runtimeKind).readTitle?.(nativeId, { workspace: b.workspace }).then(info => {
        if (this.shuttingDown || !info?.title?.trim() || info.titleKind === "preview" || !this.store.binding(pid)) return;
        this.bindNative(pid, nativeId, { ...info, modelSource: "首轮结束原生标题元数据" });
        this.emit("session", { platformSessionId: pid }); this.emit("directory", {});
      }).catch(() => {});
    }
    this.schedule();
  }

  private bindNative(pid: string, nativeId: string, info: { effectiveModel?: string; modelSource: string; effectiveEffort?: string; effortSource?: string; title?: string; titleKind?: "name" | "summary" | "preview" }): void {
    const b = this.store.binding(pid)!;
    if (b.nativeSessionId && b.nativeSessionId !== nativeId) throw new Error(`原生 ID 不一致：${b.nativeSessionId} ≠ ${nativeId}`);
    const other = this.store.findByNative(b.runtimeKind, b.hostId, nativeId);
    if (other && other.platformSessionId !== pid) throw new Error(`原生会话 ${nativeId} 已绑定到 ${other.platformSessionId}`);
    this.store.updateBinding(pid, (x) => {
      x.nativeSessionId = nativeId;
      if (info.title?.trim() && info.titleKind !== "preview" && x.titleSource !== "user") {
        x.title = bounded(info.title.trim(), 80).text; x.titleSource = "native";
        if (x.titleGeneration && ["pending", "running"].includes(x.titleGeneration.state)) x.titleGeneration.state = "superseded";
      }
      if (info.effectiveModel) { x.effectiveModel = info.effectiveModel; x.effectiveModelSource = info.modelSource; }
      if (info.effectiveEffort) { x.effectiveEffort = info.effectiveEffort; x.effectiveEffortSource = info.effortSource ?? info.modelSource; }
      if (x.status === "creating") { x.status = "running"; x.statusReason = "会话已创建"; }
    }, undefined, { bump: !b.nativeSessionId }); // Titles are metadata; do not invalidate a pending turn's operation revision.
  }

  private finishTurn(pid: string, turnNo: number, r: TurnResult, stopRequested: boolean): void {
    // 本轮结束：看门狗计时随本轮失效，不能跨轮累计
    this.stalls.delete(pid);
    this.armStallSweep();
    // 平台审批随本轮结束失效
    for (const a of this.store.allApprovals()) {
      if (a.platformSessionId === pid && a.turnNo === turnNo && a.state === "pending") this.settleApproval(a.approvalId, "invalidated", { approve: false, reason: "本轮已结束" });
    }
    // 额度 / 限流不是一次普通的运行失败：额度会重置，会话应如实标成被中断，之后可显式续聊。
    const quotaFailure = (r.status === "failed" || r.status === "unknown") && (QUOTA_CODES.has(r.code ?? "") || (r.reason && QUOTA_FAILURE.test(r.reason)));
    const authFailure = (r.status === "failed" || r.status === "unknown") && (AUTH_CODES.has(r.code ?? "") || (r.reason && AUTH_FAILURE.test(r.reason)));
    let status = r.status;
    if (stopRequested && (status === "interrupted" || status === "failed" || (quotaFailure && status === "unknown"))) status = "cancelled";
    else if (quotaFailure && (status === "failed" || status === "unknown")) status = "interrupted";
    const now = new Date().toISOString();
    const b = this.store.updateBinding(pid, (x) => {
      const t = x.turns.find((y) => y.turnNo === turnNo);
      if (status === "completed") delete x.quotaResumeStreak;
      delete x.quotaResume;
      if (t) { t.status = status; t.endedAt = now; if (r.reason || stopRequested) t.statusReason = stopRequested ? "已按请求停止" : r.reason; if (quotaFailure) t.quotaFailure = true; }
      // 普通 turn 结束后会话回 idle；没有终态的中断标 interrupted；结果未知标 unknown
      x.status = status === "interrupted" ? "interrupted" : status === "unknown" ? "unknown" : x.nativeSessionId ? "idle" : "failed";
      x.statusReason = status === "completed" ? "本轮完成" : status === "cancelled" ? "已按请求停止本轮" : status === "failed" ? `本轮失败${r.reason ? `：${r.reason}` : ""}` : status === "interrupted" ? `本轮被中断${r.reason ? `：${r.reason}` : ""}` : `本轮结果未知${r.reason ? `：${r.reason}` : ""}`;
      x.lastActivityAt = { at: now, source: "platform" };
      // 排队消息只在正常结束后自动接着发；停止 / 失败 / 未知时暂停，等人确认
      if (x.outbox?.length && status !== "completed" && !x.outboxPaused) x.outboxPaused = { at: now, reason: status === "cancelled" ? "已停止本轮" : status === "failed" ? "本轮失败" : status === "interrupted" ? "本轮被中断" : "本轮结果未知" };
    });
    this.clearUndeliveredSteers(pid);
    const nt = b.turns.find((t) => t.turnNo === turnNo)?.nativeTurnId;
    this.store.upsertEvent(pid, {
      // 与原生历史里的 turn 结束记录同 key：回补时合并，不重复显示
      key: nt ? `turn:${nt}` : `platform:turn-end:${turnNo}`, kind: "turn-status", status, text: b.statusReason ?? "", turnNo,
      source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", recordedAt: now, occurredAt: now
    });
    this.emitEvent(pid);
    this.emit("session", { platformSessionId: pid });
    this.emit("directory", {});
    try { this.publicMemoryObserver?.turnEnded?.({ platformSessionId: pid, runtimeKind: b.runtimeKind, turnNo, status }); } catch { /* 同上 */ }
    if (authFailure) { this.noteAuthFailure(b.runtimeKind, pid, r.reason ?? r.code ?? "认证失败"); this.scheduleAuthVerify(b.runtimeKind); }
    else if (quotaFailure) this.noteQuotaFailure(b.runtimeKind, pid, r.reason ?? r.code ?? "额度不足", r.code);
    else if (status === "completed") this.clearQuotaFailure(b.runtimeKind);
    if (quotaFailure && status === "interrupted") void this.armQuotaResume(pid, turnNo).catch((e) => this.store.audit({ type: "quota-resume-arm-failed", platformSessionId: pid, reason: bounded(String(e), 200).text }));
    // 快捷回复：本轮正常结束就预先生成，打开会话时按钮已就绪（结果只在内存缓存）
    if (status === "completed") setTimeout(() => { void this.finalQuickReplies(pid).catch(() => {}); }, 300).unref();
    // 记录原生指纹：之后的外部写入据此判断（结束记录可能稍后落盘，延迟一点再取）
    // 指纹刷新后再发排队消息：否则自己这轮的写入会被当成外部写入
    if (b.nativeSessionId) {
      const id = b.nativeSessionId;
      this.fingerprintPending.add(pid);
      setTimeout(() => {
        const prev = this.store.binding(pid)?.nativeFingerprint?.value;
        void this.driver(b.runtimeKind).fingerprint(id, { workspace: b.workspace, ...(prev ? { previous: prev } : {}) }).then((fp) => {
          if (!fp) { this.fingerprintPending.delete(pid); this.pauseOutbox(pid, "无法核对原生会话状态，排队消息未自动发送"); return; }
          if (fp.note) this.noteFingerprint(pid, fp.note);
          const cur = this.store.binding(pid);
          if (!cur || cur.conflict || this.running.has(pid)) { this.fingerprintPending.delete(pid); return; }
          this.store.updateBinding(pid, (x) => { x.nativeFingerprint = { ...x.nativeFingerprint, value: fp.value, checkedAt: new Date().toISOString() }; }, undefined, { bump: false });
          this.fingerprintPending.delete(pid);
          this.watchNativeContinuation(pid);
          if (status === "completed") void this.completeIdleTurn(pid, turnNo, stopRequested);
        }).catch(() => { this.fingerprintPending.delete(pid); this.pauseOutbox(pid, "无法核对原生会话状态，排队消息未自动发送"); });
      }, 1500).unref();
    }
  }

  /**
   * 平台技能「界面打磨」的交付检查（ui-report-check.ts）：本轮用了这个技能，最终回复里就必须有技能脚本生成的检查报告。
   * 不通过就把缺什么、怎么补作为系统消息续发给同一会话，最多 MAX_ENFORCEMENT_RETRIES 次；仍不通过就在时间线留一条通知。
   * 返回 true = 已经续发了一轮（排队消息暂不出队）。任何失败都只是不检查。
   */
  private async enforceUiReport(pid: string, turnNo: number, stopRequested: boolean): Promise<boolean> {
    try {
      const b = this.store.binding(pid);
      if (!b || this.platformSkillsRoot === undefined || stopRequested || this.shuttingDown || this.draining || b.archived || b.conflict || b.outbox?.length || b.turns.at(-1)?.turnNo !== turnNo) return false;
      if (b.evaluation || b.projectRef || b.role || (b.roomRef && b.permissionMode === readOnlyPermissionMode(b.runtimeKind))) return false;
      if (this.platformSkillSwitches && !this.platformSkillSwitches.enabled(UI_SKILL_ID)) return false;
      const events = this.store.events(pid);
      const start = unfinishedChainStart(b.turns, turnNo);
      const prev = this.uiReportEnforcement.get(pid), inChain = prev !== undefined && prev.turnNo >= start && prev.turnNo <= turnNo;
      const attempt = inChain ? prev.attempt : 0, since = inChain ? Math.min(prev.since, start) : start;
      const problems = uiReportProblems({ events, since, turnNo, assistantText: turnEvidence(events, turnNo).assistantText, workspace: b.workspace, skillRoot: this.platformSkillsRoot });
      if (!problems?.length) { this.uiReportEnforcement.delete(pid); return false; }
      if (attempt >= MAX_ENFORCEMENT_RETRIES) {
        this.uiReportEnforcement.delete(pid);
        this.ingest(pid, { key: `ui-report-enforce:${turnNo}`, kind: "notice", text: `「界面打磨」的交付物仍未交付（已提醒 ${attempt} 次，不再自动提醒）：${problems.join(" ")}`, source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded" }, turnNo);
        this.emit("session", { platformSessionId: pid });
        this.store.audit({ type: "ui-report-enforcement-exhausted", platformSessionId: pid, turnNo });
        return false;
      }
      this.ingest(pid, { key: `ui-report-enforce:${turnNo}`, kind: "notice", text: `「界面打磨」的交付物未交付，已自动反馈给模型要求补齐（第 ${attempt + 1} 次）：${problems.join(" ")}`, source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded" }, turnNo);
      this.emit("session", { platformSessionId: pid });
      const key = `ur-${pid}-${turnNo}-${attempt}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
      const prompt = [
        `${ENFORCEMENT_PROMPT_MARK}这是平台自动发的检查反馈（第 ${attempt + 1} 次，最多 ${MAX_ENFORCEMENT_RETRIES} 次），不是用户的新需求。`,
        "检查项：「界面打磨」必须交付对应阶段的脚本产物（检查报告或设计手册）", `问题：${problems.join("\n")}`, `怎么改：\n${UI_REPORT_FIX}`,
        "请按上面的步骤补齐后重新汇报；不需要道歉或解释，也不要重复已经完成的内容。"
      ].join("\n\n");
      const r = await this.sendTurn(pid, { idempotencyKey: key, prompt, expectedRevision: b.bindingRevision }, "system:ui-report-enforcement");
      if (r.operation.turnNo !== undefined) this.uiReportEnforcement.set(pid, { turnNo: r.operation.turnNo, attempt: attempt + 1, since });
      this.store.audit({ type: "ui-report-enforcement-sent", platformSessionId: pid, turnNo, attempt });
      return true;
    } catch { return false; }
  }

  /**
   * 强约束记忆的回合结束校验：会话首轮注入时登记了规则（注入事件的 rules）才检查。
   * 不通过就把「哪里不对、怎么改」作为一条系统消息续发给同一会话，最多 MAX_ENFORCEMENT_RETRIES 次；仍不通过就在时间线里留一条通知并停下。
   * 返回 true = 已经续发了一轮（排队消息暂不出队）。任何失败都只是不检查，不影响会话。
   */
  private async enforceMemoryRules(pid: string, turnNo: number, stopRequested: boolean): Promise<boolean> {
    try {
      const b = this.store.binding(pid);
      if (!b || stopRequested || this.shuttingDown || this.draining || b.archived || b.conflict || b.outbox?.length || b.turns.at(-1)?.turnNo !== turnNo) return false;
      const events = this.store.events(pid), active = [...activeRulesOf(events)];
      if(!b.evaluation && !(b.roomRef && b.permissionMode === readOnlyPermissionMode(b.runtimeKind)))active.push({topicId:"platform-browser",ruleId:"platform-screenshot-provenance",topic:"平台浏览器截图",statement:SCREENSHOT_INSTRUCTIONS});
      if (!active.length) { this.workspaceBaselines.delete(pid); this.probeBaselines.delete(pid); return false; }
      // 补救链：上一次反馈发出的那一轮就是这一轮时，证据里的「改了哪些文件」从链的起点算起
      // 本轮之前被中断（额度 / 失败 / 停止）的回合没检查过，它们改的文件并进本轮的证据；补救反馈那一轮若也被中断，接续轮仍算同一条补救链
      const start = unfinishedChainStart(b.turns, turnNo);
      const prev = this.enforcement.get(pid), inChain = prev !== undefined && prev.turnNo >= start && prev.turnNo <= turnNo;
      const attempt = inChain ? prev.attempt : 0, since = inChain ? Math.min(prev.since, start) : start;
      const changed = await this.changedWorkspaceFiles(b, active, since);   // null = 没有基线快照（取不到）
      const evidence = turnEvidence(events, turnNo, since, changed ?? []);
      evidence.screenshotProblems=screenshotReportProblems(evidence.assistantText,pid,b.workspace,events);
      const facts = await this.probeFacts(pid, active, since, changed);
      if (facts) evidence.facts = facts;
      const code = runRules(active, evidence), modeled = this.modelRuleJudge ? await runModelRules(active, evidence, this.modelRuleJudge) : { failed: [], passed: [], skipped: [] };
      const failed = [...code.failed, ...modeled.failed], passed = [...code.passed, ...modeled.passed], skipped = [...code.skipped, ...modeled.skipped];
      for (const a of passed) try { this.publicMemoryObserver?.enforced?.({ platformSessionId: pid, runtimeKind: b.runtimeKind, topicId: a.topicId, ruleId: a.ruleId, pass: true }); } catch { /* 统计失败不影响 */ }
      const ruleInfo = (a: ActiveRule): PlatformEnforcement["rules"][number] => ({ topicId: a.topicId, ruleId: a.ruleId, topic: a.topic, statement: a.statement, title: ruleTitleOf(a) });
      const record = (phase: PlatformEnforcement["phase"], text: string, rules: PlatformEnforcement["rules"]): void => {
        const key = phase === "passed" && failed.length ? `memory-enforce-pass:${turnNo}` : `memory-enforce:${turnNo}`;
        this.ingest(pid, { key, kind: "notice", text, source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", enforcement: { phase, attempt, rules } }, turnNo);
        this.emit("session", { platformSessionId: pid });
      };
      if (skipped.length) {
        this.ingest(pid, { key: `memory-enforce-skip:${turnNo}`, kind: "notice", text: `强约束未检查：${skipped.map((x) => `「${x.rule.topic}」`).join("、")}（${skipped[0]!.note}）`, source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", enforcement: { phase: "skipped", attempt: 0, rules: skipped.map((x) => ({ ...ruleInfo(x.rule), note: x.note })) } }, turnNo);
        this.emit("session", { platformSessionId: pid });
      }
      // 混合结果也保留通过项，前端才能汇总本轮完整统计。
      if (passed.length) record("passed", `强约束检查通过：${passed.map((a) => `「${a.topic}」`).join("、")}${attempt > 0 ? "（补救后）" : ""}`, passed.map(ruleInfo));
      if (!failed.length) {
        this.workspaceBaselines.delete(pid); this.probeBaselines.delete(pid);
        this.enforcement.delete(pid);
        return false;
      }
      const failedRules = failed.map((f) => ({ ...ruleInfo(f.rule), problem: f.problem, fix: f.fix }));
      for (const f of failed) try { this.publicMemoryObserver?.enforced?.({ platformSessionId: pid, runtimeKind: b.runtimeKind, topicId: f.rule.topicId, ruleId: f.rule.ruleId, pass: false }); } catch { /* 同上 */ }
      const names = failed.map((f) => `「${f.rule.topic}」`).join("、");
      if (attempt >= MAX_ENFORCEMENT_RETRIES) {
        this.enforcement.delete(pid); this.workspaceBaselines.delete(pid); this.probeBaselines.delete(pid);
        record("exhausted", `强约束检查仍未通过：${names}（已提醒 ${attempt} 次，不再自动提醒）。${failed.map((f) => f.problem).join(" ")}`, failedRules);
        this.store.audit({ type: "memory-enforcement-exhausted", platformSessionId: pid, turnNo, rules: failed.map((f) => f.rule.ruleId) });
        return false;
      }
      record("failed", `强约束检查未通过：${names}，已自动反馈给模型要求补齐（第 ${attempt + 1} 次）`, failedRules);
      const key = `me-${pid}-${turnNo}-${attempt}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
      const r = await this.sendTurn(pid, { idempotencyKey: key, prompt: composeFeedback(failed, attempt), expectedRevision: b.bindingRevision }, "system:memory-enforcement");
      if (r.operation.turnNo !== undefined) this.enforcement.set(pid, { turnNo: r.operation.turnNo, attempt: attempt + 1, since });
      this.store.audit({ type: "memory-enforcement-sent", platformSessionId: pid, turnNo, attempt, rules: failed.map((f) => f.rule.ruleId) });
      return true;
    } catch (e) {
      this.store.audit({ type: "memory-enforcement-skipped", platformSessionId: pid, turnNo, reason: bounded(String((e as Error).message ?? e), 200).text });
      return false;
    }
  }

  /** 强约束规则要不要按结果取证：已登记的规则里有声明要的；首轮规则还没登记，只要装了公共记忆就先拍。 */
  private needsWorkspaceChanges(pid: string, turnNo: number, active?: readonly ActiveRule[]): boolean {
    if (turnNo === 1 && !active?.length) return !!this.publicMemoryProvider;
    const rules = active ?? activeRulesOf(this.store.events(pid));
    return rules.some((a) => enforcementRule(a.ruleId)?.usesWorkspaceChanges) || probeIdsOf(rules).includes("changed-files");
  }
  private workspaceRef = (b: SessionBinding) => ({ workspace: b.workspace, ...(b.worktree ? { worktree: { repoRoot: b.worktree.repoRoot, path: b.worktree.path } } : {}) });

  /** 回合开始（发给 runtime 之前）拍一次工作区快照。拍不了就不记，之后只看工具事件。 */
  private async markWorkspaceBaseline(b: SessionBinding, turnNo: number): Promise<void> {
    const pid = b.platformSessionId;
    try { await this.markProbeBaseline(pid, turnNo); } catch { /* 取证失败不影响派发 */ }
    try {
      if (!this.needsWorkspaceChanges(pid, turnNo)) return;
      const snap = await snapshotWorkspace(this.workspaceRef(b));
      if (!snap) return;
      const m = this.workspaceBaselines.get(pid) ?? new Map<number, WorkspaceSnapshot>();
      m.set(turnNo, snap);
      for (const k of [...m.keys()]) if (k < turnNo - 3) m.delete(k);
      this.workspaceBaselines.set(pid, m);
    } catch { /* 取证失败不影响派发 */ }
  }

  /** 回合开始读一次取证项（发布状态、线上部署）：已登记规则用到的；首轮规则还没登记，装了读取器就全读（很轻，只读本机文件）。 */
  private async markProbeBaseline(pid: string, turnNo: number): Promise<void> {
    const active = activeRulesOf(this.store.events(pid));
    const ids = turnNo === 1 && !active.length ? READER_PROBE_IDS.filter((id) => this.evidenceReaders[id]) : probeIdsOf(active).filter((id) => this.evidenceReaders[id]);
    if (!ids.length) return;
    const state = await readProbeStates(ids, this.evidenceReaders);
    const m = this.probeBaselines.get(pid) ?? new Map<number, Record<string, unknown>>();
    m.set(turnNo, { ...(m.get(turnNo) ?? {}), ...state, __read: ids });
    for (const k of [...m.keys()]) if (k < turnNo - 3) m.delete(k);
    this.probeBaselines.set(pid, m);
  }

  /** 登记的模型判定规则要的功能事实：改动的文件、发布状态与线上部署（回合前后对比，基线取补救链起点那一轮）。没有规则用取证项就不取。 */
  private async probeFacts(pid: string, active: readonly ActiveRule[], since: number, changed: string[] | null): Promise<Record<string, unknown> | undefined> {
    const ids = probeIdsOf(active);
    if (!ids.length) return undefined;
    const facts: Record<string, unknown> = {};
    if (ids.includes("changed-files")) facts["changed-files"] = changed === null ? null : changed.slice(0, 200);
    const readerIds = ids.filter((id) => this.evidenceReaders[id]);
    const now = readerIds.length ? await readProbeStates(readerIds, this.evidenceReaders) : {};
    const m = this.probeBaselines.get(pid);
    const first = m ? Math.min(...[...m.keys()].filter((k) => k >= since)) : Infinity;
    const base = m?.get(first);
    for (const id of readerIds) {
      const hasBaseline = !!base && Array.isArray(base["__read"]) && (base["__read"] as string[]).includes(id);
      facts[id] = id in now ? beforeAfterFact(base?.[id], now[id], hasBaseline) : { note: "读取不到这项状态，无法核对" };
    }
    return facts;
  }

  /** 从补救链起点的快照到现在，工作区里变化的文件；没有快照 / 规则不需要就返回空。 */
  private async changedWorkspaceFiles(b: SessionBinding, active: readonly ActiveRule[], since: number): Promise<string[] | null> {
    try {
      if (!this.needsWorkspaceChanges(b.platformSessionId, since, active)) return [];
      // 链起点（含被中断的前几轮）的快照；起点那一轮没拍到就用它之后最早的一张
      const m = this.workspaceBaselines.get(b.platformSessionId);
      const first = m ? Math.min(...[...m.keys()].filter((k) => k >= since)) : Infinity;
      const base = m?.get(first);
      return base ? await changedFilesSince(base, this.workspaceRef(b)) : null;
    } catch { return null; }
  }

  /** 真实调用认证失败：profile 转"待登录"，不再显示可执行（登录状态读取的只是缓存身份） */
  private noteAuthFailure(kind: RuntimeKind, pid: string, message: string): void {
    const p = this.profile(kind);
    if (!p) return;
    this.store.saveProfile({ ...p, state: "needs-login", stateReason: `真实调用认证失败：${bounded(message, 200).text}。请在本机重新登录后再检查`, lastAuthFailure: { at: new Date().toISOString(), message: bounded(message, 300).text, platformSessionId: pid } });
    this.store.audit({ type: "auth-failure", runtimeKind: kind, platformSessionId: pid });
    this.emit("profiles", {});
  }

  /**
   * 认证失败后自动补一次在线认证：令牌过期常常是临时的（refresh 竞争、轮换），用户重新登录后
   * 平台不必等人再点一次「检查」。只在有在线认证证据的 runtime 上做（目前是 Claude），
   * 复核不通过时保留「待登录」并写明原因，不把状态降级成启动失败。
   */
  private scheduleAuthVerify(kind: RuntimeKind): void {
    if (this.shuttingDown || (kind !== "claude-code" && kind !== "antigravity") || this.authVerifyTimers.has(kind)) return;
    const timer = setTimeout(() => {
      this.authVerifyTimers.delete(kind);
      if (this.shuttingDown || !this.profile(kind)?.lastAuthFailure) return;
      void this.probe(kind, { autoVerify: true }).catch((e) =>
        this.store.audit({ type: "auth-auto-verify-failed", runtimeKind: kind, reason: bounded(String(e), 200).text }));
    }, this.authAutoVerifyDelayMs);
    timer.unref?.();
    this.authVerifyTimers.set(kind, timer);
  }

  /** 额度不足：不改可执行状态（额度会重置），在配置页与新建页显示，不自动换 runtime / 模型 / 计费渠道 */
  private noteQuotaFailure(kind: RuntimeKind, pid: string, message: string, code?: string): void {
    const p = this.profile(kind);
    if (!p) return;
    this.store.saveProfile({ ...p, lastQuotaFailure: { at: new Date().toISOString(), message: bounded(message, 300).text, ...(code ? { code } : {}), platformSessionId: pid } });
    this.store.audit({ type: "quota-failure", runtimeKind: kind, platformSessionId: pid, code: code ?? null });
    this.emit("profiles", {});
    void this.refreshRateLimit(kind).catch(() => {});
  }

  /* ============================ 额度用尽后自动续聊 ============================ */

  private quotaResumeEligible(b: SessionBinding): boolean {
    return !!b.nativeSessionId && !b.archived && !b.roomRef && !b.comparisonRef && !b.projectRef && !b.evaluation && !b.conflict;
  }

  private quotaModelFilter(b: SessionBinding): { runtimeKind: RuntimeKind; model?: string; modelLabel?: string } {
    const model = b.effectiveModel ?? b.requestedModel;
    const modelLabel = model ? this.sessionModelOption(this.profile(b.runtimeKind), b)?.label : undefined;
    return { runtimeKind: b.runtimeKind, ...(model ? { model } : {}), ...(modelLabel ? { modelLabel } : {}) };
  }

  private clearQuotaTimer(pid: string): void {
    const t = this.quotaTimers.get(pid);
    if (t) { clearTimeout(t); this.quotaTimers.delete(pid); }
  }

  private setQuotaTimer(pid: string, atMs: number): void {
    this.clearQuotaTimer(pid);
    if (this.shuttingDown) return;
    const timer = setTimeout(() => { void this.fireQuotaResume(pid).catch((e) => this.store.audit({ type: "quota-resume-error", platformSessionId: pid, reason: bounded(String(e), 200).text })); }, Math.min(Math.max(atMs - Date.now(), 1000), 2 ** 31 - 1));
    timer.unref();
    this.quotaTimers.set(pid, timer);
  }

  /**
   * 一轮因额度 / 限流被打断：读取最新额度快照，定在窗口重置之后自动续聊。
   * 5 小时、周窗口都会处理；重置时间查不到时每半小时再试。连续自动续聊有次数上限。
   */
  private async armQuotaResume(pid: string, turnNo: number): Promise<void> {
    const first = this.store.binding(pid);
    if (!first || !this.quotaResumeEligible(first)) return;
    if ((first.quotaResumeStreak ?? 0) >= QUOTA_RESUME_MAX_STREAK) {
      this.store.updateBinding(pid, x => {
        x.statusReason = `${bounded(x.statusReason || "", 250).text}；自动继续已达 ${QUOTA_RESUME_MAX_STREAK} 次上限，不再自动继续`;
      }, undefined, { bump: false });
      this.store.audit({ type: "quota-resume-capped", platformSessionId: pid });
      this.emit("session", { platformSessionId: pid });
      return;
    }
    let snap: RateLimitSnapshot | undefined;
    try { snap = await this.refreshRateLimit(first.runtimeKind); } catch { /* 用最近一次采样兜底 */ }
    snap ??= this.store.rateLimits()[first.identityScopeId];
    const b = this.store.binding(pid);
    if (!b || this.shuttingDown || b.status !== "interrupted" || b.quotaResume || !this.quotaResumeEligible(b) || b.turns.at(-1)?.turnNo !== turnNo) return;
    const reason = b.turns.at(-1)?.statusReason ?? b.statusReason;
    const plan = planQuotaResume(snap, Date.now(), { ...this.quotaModelFilter(b), ...(reason ? { reason } : {}) });
    const state: NonNullable<SessionBinding["quotaResume"]> = { scheduledFor: new Date(plan.at).toISOString(), window: plan.window, known: plan.known, createdAt: new Date().toISOString(), turnNo };
    this.store.updateBinding(pid, (x) => { x.quotaResume = state; }, undefined, { bump: false });
    this.store.audit({ type: "quota-resume-scheduled", platformSessionId: pid, turnNo, scheduledFor: state.scheduledFor, window: plan.window, known: plan.known });
    this.setQuotaTimer(pid, plan.at);
    this.emit("session", { platformSessionId: pid });
  }

  private async fireQuotaResume(pid: string): Promise<void> {
    this.quotaTimers.delete(pid);
    if (this.shuttingDown) return;
    const b = this.store.binding(pid), q = b?.quotaResume;
    if (!b || !q) return;
    const due = Date.parse(q.scheduledFor);
    if (Date.now() < due - 1000) { this.setQuotaTimer(pid, due); return; } // 超过定时器上限的长等待：到点前重新挂
    const drop = (reason: string, note?: string): void => {
      this.store.updateBinding(pid, (x) => { delete x.quotaResume; if (note) x.statusReason = bounded(`${x.statusReason ?? ""}；${note}`, 400).text; }, undefined, { bump: false });
      this.store.audit({ type: "quota-resume-dropped", platformSessionId: pid, reason });
      this.emit("session", { platformSessionId: pid });
    };
    if (!this.quotaResumeEligible(b) || b.status !== "interrupted" || b.turns.at(-1)?.turnNo !== q.turnNo) { drop("session-changed"); return; }
    const streak = (b.quotaResumeStreak ?? 0) + 1;
    if (streak > QUOTA_RESUME_MAX_STREAK) { drop("streak-cap", `已连续自动继续 ${QUOTA_RESUME_MAX_STREAK} 次仍被额度打断，不再自动继续`); return; }
    // 先核对额度确实回来了：窗口还没重置（或重置时间被往后推）就继续等
    try {
      const until = stillExhaustedUntil(await this.refreshRateLimit(b.runtimeKind), Date.now(), this.quotaModelFilter(b));
      if (until) {
        const next = until + QUOTA_RESUME_MARGIN_MS;
        this.store.updateBinding(pid, (x) => { if (x.quotaResume) { x.quotaResume.scheduledFor = new Date(next).toISOString(); x.quotaResume.known = true; } }, undefined, { bump: false });
        this.setQuotaTimer(pid, next);
        this.emit("session", { platformSessionId: pid });
        return;
      }
    } catch { /* 查不到额度也试着发：再被额度打断会重新安排 */ }
    const key = `qr-${pid}-${q.turnNo}-${streak}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = this.store.binding(pid);
      if (!cur?.quotaResume || cur.quotaResume.turnNo !== q.turnNo) return; // 期间被人取消 / 人已经发了新消息
      try {
        await this.sendTurn(pid, { idempotencyKey: key, prompt: QUOTA_RESUME_PROMPT, expectedRevision: cur.bindingRevision, quotaResumeStreak: streak }, "system:quota-resume");
        this.store.audit({ type: "quota-resume-sent", platformSessionId: pid, turnNo: q.turnNo, streak });
        return;
      } catch (e) {
        const code = (e as { code?: string }).code ?? "";
        if (code === "RT_CONFLICT" && attempt < 2) continue;
        if (code === "RT_BUSY" || code === "RT_DRAINING" || code === "RT_CONFLICT") { this.setQuotaTimer(pid, Date.now() + 60_000); return; }
        drop(`send-failed:${code}`, `自动继续没有执行：${bounded((e as Error).message, 160).text}`);
        return;
      }
    }
  }

  /** 重启后：磁盘上还挂着的额度续聊重新排上定时器（已过期的稍后就发）。 */
  private async rearmQuotaResumes(): Promise<void> {
    let n = 0;
    for (const b of this.store.allBindings()) {
      // 旧版已标明额度失败、却留在 unknown 的末轮：补分类并安排恢复。
      // 只迁移有持久化额度标记且原因匹配的记录；普通未知、已停止及后续轮次均不重放。
      const last = b.turns.at(-1);
      if (!b.quotaResume && b.status === "unknown" && last?.status === "unknown" && last.quotaFailure
        && QUOTA_FAILURE.test(last.statusReason || "") && this.quotaResumeEligible(b)) {
        const reason = `本轮被中断：${last.statusReason}`;
        this.store.updateBinding(b.platformSessionId, x => {
          x.status = "interrupted"; x.statusReason = reason;
          x.turns.at(-1)!.status = "interrupted";
        });
        this.store.upsertEvent(b.platformSessionId, {
          key: last.nativeTurnId ? `turn:${last.nativeTurnId}` : `platform:turn-end:${last.turnNo}`,
          kind: "turn-status", status: "interrupted", text: reason, turnNo: last.turnNo,
          source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded",
          recordedAt: new Date().toISOString(), occurredAt: last.endedAt || new Date().toISOString()
        });
        this.store.audit({ type: "quota-unknown-recovered", platformSessionId: b.platformSessionId, turnNo: last.turnNo });
        await this.armQuotaResume(b.platformSessionId, last.turnNo);
        continue;
      }
      if (!b.quotaResume) continue;
      if (!this.quotaResumeEligible(b) || b.status !== "interrupted") { this.store.updateBinding(b.platformSessionId, (x) => { delete x.quotaResume; }, undefined, { bump: false }); continue; }
      this.setQuotaTimer(b.platformSessionId, Math.max(Date.parse(b.quotaResume.scheduledFor), Date.now() + 3000 + n++ * 1000));
    }
  }

  /** 人取消自动续聊：本次中断不再自动继续（之后再被额度打断仍会重新安排）。 */
  cancelQuotaResume(platformSessionId: string, actor: string): SessionBinding {
    const b = this.managed(platformSessionId);
    if (!b.quotaResume && b.quotaResumeStreak === undefined) return b;
    this.clearQuotaTimer(platformSessionId);
    const out = this.store.updateBinding(platformSessionId, (x) => { delete x.quotaResume; delete x.quotaResumeStreak; }, undefined, { bump: false });
    this.store.audit({ type: "quota-resume-cancelled", platformSessionId, actor });
    this.emit("session", { platformSessionId });
    return out;
  }

  private clearQuotaFailure(kind: RuntimeKind): void {
    const p = this.profile(kind);
    if (!p?.lastQuotaFailure) return;
    const { lastQuotaFailure: _q, ...rest } = p;
    this.store.saveProfile(rest);
    this.emit("profiles", {});
  }

  private sinkFor(pid: string, turnNo: number, operationId: string): TurnSink {
    return {
      evaluationInventory: (inventory) => {
        const binding = this.store.binding(pid)!, turn = binding.turns.find(t => t.turnNo === turnNo);
        if (!["pi", "claude-code"].includes(binding.runtimeKind) || !binding.evaluation || inventory.version !== 1 || inventory.nativeSessionId !== binding.nativeSessionId || inventory.clientMessageId !== turn?.clientMessageId) throw new Error("Evaluation inventory source does not match the protected turn");
        this.store.audit({type: "evaluation-tool-inventory", platformSessionId: pid, operationId, turnNo,
          evaluationPolicyHash: binding.evaluationPolicyHash ?? null, inventory: {version: 1, nativeSessionId: inventory.nativeSessionId,
            clientMessageId: inventory.clientMessageId, activeTools: [...inventory.activeTools], registeredTools: inventory.registeredTools.map(t => ({name: t.name, source: t.source}))}});
      },
      nativeSession: (id, info) => {
        this.bindNative(pid, id, info);
        this.store.stepOperation(operationId, "native-session", `原生会话 ${id}${info.effectiveModel ? `，生效模型 ${info.effectiveModel}（${info.modelSource}）` : ""}${info.effectiveEffort ? `，推理强度 ${info.effectiveEffort}（${info.effortSource ?? info.modelSource}）` : ""}`);
        this.emit("session", { platformSessionId: pid });
        this.emit("directory", {});
      },
      nativeTurn: (turnId) => {
        this.store.updateBinding(pid, (x) => { const t = x.turns.find((y) => y.turnNo === turnNo); if (t) t.nativeTurnId = turnId; });
        this.store.stepOperation(operationId, "native-turn", `原生 turn ${turnId}`);
      },
      event: (e) => {
        this.ingest(pid, e, turnNo);
        const b = this.store.binding(pid);
        if (!this.running.has(pid) && b?.turns.at(-1)?.turnNo === turnNo && b.turns.at(-1)?.status === "completed") {
          this.store.updateBinding(pid, x => { delete x.quickReplies; delete x.quickAction; }, undefined, { bump: false });
          if (b.nativeSessionId && this.driver(b.runtimeKind).continuationState?.(b.nativeSessionId)) this.continuationFinalizers.set(pid, { turnNo, stopRequested: false });
          this.watchNativeContinuation(pid);
        }
      },
      steerDelivered: (clientMessageId) => {
        const hit: { m?: OutboxMessage } = {};
        this.store.updateBinding(pid, (x) => {
          hit.m = x.outbox?.find(m => m.steering?.clientMessageId === clientMessageId);
          if (!hit.m) return;
          x.outbox = x.outbox!.filter(m => m !== hit.m);
          if (!x.outbox.length) { delete x.outbox; delete x.outboxPaused; }
        }, undefined, { bump: false });
        if (!hit.m) return;
        // 平台这份带图片元数据；随后到的原生用户消息同 key 合并
        const now = new Date().toISOString();
        const userEvent = this.store.upsertEvent(pid, {
          key: `user:${clientMessageId}`, kind: "message", role: "user", text: bounded(hit.m.prompt, LIMITS.message).text, ...(hit.m.attachments?.length ? { attachments: hit.m.attachments } : {}),
          source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", recordedAt: now, occurredAt: now, turnNo
        });
        if (userEvent) this.emit("event", { platformSessionId: pid, event: userEvent });
        this.store.audit({ type: "outbox-steered", platformSessionId: pid, messageId: hit.m.messageId, turnNo, operationId });
        this.emit("session", { platformSessionId: pid });
      },
      roleApplied: (check) => {
        const b = this.store.binding(pid);
        if (!b?.role) return;
        this.store.updateBinding(pid, (x) => { x.role!.evidence.runtimeConfirmed = { result: check.matched ? "confirmed" : "mismatch", turnNo, at: new Date().toISOString(), source: check.source, ...(check.detail ? { detail: check.detail } : {}) }; }, undefined, { bump: false });
        this.store.stepOperation(operationId, "role-check", check.matched ? `角色注入已核对（${check.source}）` : `角色注入核对不一致：${check.detail ?? check.source}`);
        // 不一致要让人看见：这一轮可能没有按角色身份执行
        if (!check.matched) this.ingest(pid, { key: `role-check:${turnNo}`, kind: "notice", text: `角色注入核对不一致：${check.detail ?? check.source}。这一轮可能没有按角色身份执行。`, source: "stream", parserVersion: PROJECTION_VERSION, availability: "recorded" }, turnNo);
        this.emit("session", { platformSessionId: pid });
      },
      usage: (r) => { this.store.addUsage(pid, r); this.emit("session", { platformSessionId: pid, usage: true }); },
      approval: (req, signal) => this.requestApproval(pid, turnNo, req, signal),
      rateLimit: (s) => {
        const b = this.store.binding(pid);
        if (!b) return;
        this.store.saveRateLimit({ ...mergeSampledRateLimit(this.store.rateLimits()[b.identityScopeId], s), identityScopeId: b.identityScopeId, runtimeKind: b.runtimeKind });
        this.emit("profiles", {});
      },
      status: (s) => {
        const b = this.store.binding(pid);
        // 本轮已结束（或不是这一轮）：迟到的状态信号不能把会话改回运行中
        if (!b || b.status === "stopping" || this.running.get(pid)?.turnNo !== turnNo) return;
        if (b.status !== s) {
          this.store.updateBinding(pid, (x) => {
            x.status = s;
            const t = x.turns.find((y) => y.turnNo === turnNo);
            if (t && (t.status === "running" || t.status === "waiting-input")) t.status = s;
          });
          if (s === "waiting-input") this.ingest(pid, {
            key: `waiting-input:${turnNo}`, kind: "turn-status", status: "waiting-input", text: "等待你的回复或处理",
            source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", occurredAt: new Date().toISOString()
          }, turnNo);
          this.emit("session", { platformSessionId: pid });
        }
      }
    };
  }

  /** 写入一条投影事件并推送；流式片段合并后节流推送 */
  private ingest(pid: string, e: DriverEvent, turnNo?: number, seqHint?: number): void {
    // 先于入库记输出动静：Pi 的进度片段在工具块已完成入库后会被丢弃，只能在这里看到它
    if (e.kind === "tool" && e.partial) this.touchStall(pid, e);
    const b = this.store.binding(pid);
    const tn = turnNo ?? (e.nativeTurnId ? b?.turns.find((t) => t.nativeTurnId === e.nativeTurnId || t.clientMessageId === e.nativeTurnId)?.turnNo : undefined);
    const out = this.store.upsertEvent(pid, { ...e, recordedAt: new Date().toISOString(), ...(tn !== undefined ? { turnNo: tn } : {}) }, seqHint);
    if (!out) return;
    if (out.kind === "tool" && out.tool?.input && this.publicMemoryObserver?.tool && b) {
      try { this.publicMemoryObserver.tool({ platformSessionId: pid, runtimeKind: b.runtimeKind, key: out.key, ...(out.tool.name ? { name: out.tool.name } : {}), input: out.tool.input }); } catch { /* 同上 */ }
    }
    if (out.partial) {
      // 片段：每个 key 每 120ms 最多推一次
      const k = `${pid}|${out.key}`;
      if (this.partialTimers.has(k)) return;
      this.partialTimers.set(k, setTimeout(() => {
        this.partialTimers.delete(k);
        const cur = this.store.events(pid).find((x) => x.key === out.key);
        if (cur) this.emit("event", { platformSessionId: pid, event: cur });
      }, 120));
      return;
    }
    this.emit("event", { platformSessionId: pid, event: out });
    if (out.kind === "tool") this.trackStall(pid, out, tn);
    // 最后活动时间：内存里即时更新，落盘最多每 2 秒一次
    this.store.updateBinding(pid, (x) => { x.lastActivityAt = { at: out.occurredAt ?? out.recordedAt, source: out.occurredAt ? "runtime" : "platform" }; }, undefined, { bump: false, persist: false });
    this.armBindingFlush();
  }
  private flushTimer: NodeJS.Timeout | undefined;
  private armBindingFlush(): void {
    if (this.flushTimer || this.shuttingDown) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      try { this.store.flushBindings(); }
      catch (error) { console.error("Runtime bookkeeping flush held:", error); this.armBindingFlush(); }
    }, 2000);
    this.flushTimer.unref();
  }

  private emitEvent(pid: string): void {
    const ev = this.store.events(pid);
    const last = ev[ev.length - 1];
    if (last) this.emit("event", { platformSessionId: pid, event: last });
  }

  /* ============================ 卡住看门狗 ============================ */

  /** 工具进入非终态就开计时，终态就清；同一个 key 的后续更新不重置起点（要从第一次出现算起）。 */
  private trackStall(pid: string, e: ProjectedEvent, turnNo?: number): void {
    const t: NonNullable<ProjectedEvent["tool"]> = e.tool ?? { name: "工具" };
    const done = t.status === "completed" || t.status === "failed" || t.status === "declined" || typeof t.exitCode === "number";
    if (done) { if (this.stalls.delete(pid)) this.armStallSweep(); return; }
    if (this.stalls.get(pid)?.key === e.key) return;
    const seen = Date.parse(e.occurredAt ?? e.recordedAt);
    this.stalls.set(pid, {
      key: e.key, name: t.name || "工具", input: stallInputLabel(t.input ?? ""), waitMs: declaredWaitFor(t.name || "", t.input ?? ""),
      startedAt: Number.isFinite(seen) ? seen : Date.now(), lastActiveAt: Number.isFinite(seen) ? seen : Date.now(), sawOutput: false, lastOutput: "", ...(turnNo !== undefined ? { turnNo } : {}), alerted: new Set(), aborted: false
    });
    this.armStallSweep();
  }

  /** 正在跑的工具回传了和上次不同的输出：不算卡住，静默计时从现在重来，已发过的提醒档位作废（之后再静默会重新提醒）。 */
  private touchStall(pid: string, e: DriverEvent): void {
    const s = this.stalls.get(pid);
    const output = e.tool?.output;
    if (!s || s.key !== e.key || !output || output === s.lastOutput) return;
    s.lastOutput = output; s.sawOutput = true; s.lastActiveAt = Date.now(); s.waitMs = 0; s.alerted.clear();
  }

  /** 只有真的有工具在跑才挂定时器；表空了就摘掉，不在空闲会话上白转。 */
  private armStallSweep(): void {
    if (this.shuttingDown) return;
    if (!this.stalls.size) { if (this.stallTimer) { clearInterval(this.stallTimer); this.stallTimer = undefined; } return; }
    if (this.stallTimer) return;
    this.stallTimer = setInterval(() => this.sweepStalls(), this.stallGuard.tickMs);
    this.stallTimer.unref();
  }

  private sweepStalls(): void {
    const now = Date.now();
    for (const [pid, s] of [...this.stalls]) {
      // 本轮已经不在跑了（正常结束、用户先手停止、进程重启）：计时作废，不留尾账
      const b = this.store.binding(pid);
      if (!b || this.shuttingDown || !this.running.has(pid)) { this.stalls.delete(pid); continue; }
      // 有输出回传的工具按「多久没有新输出」判卡住；没有回传的只能按总时长
      const elapsed = Math.max(0, now - (s.sawOutput ? s.lastActiveAt : s.startedAt) - s.waitMs);
      const marks = STALL_BROWSER.test(s.name) ? this.stallGuard.browserMs : this.stallGuard.shellMs;
      for (const mark of marks) {
        if (elapsed < mark || s.alerted.has(mark)) continue;
        s.alerted.add(mark);
        this.ingest(pid, {
          key: `stall:${s.key}:${mark}`, kind: "notice", text: stallNotice(s.name, s.input, mark, this.stallGuard.abortMs, s.waitMs ? "overdue" : s.sawOutput ? "quiet" : "running"),
          source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", occurredAt: new Date(now).toISOString()
        }, s.turnNo);
      }
      if (s.aborted || elapsed < this.stallGuard.abortMs) continue;
      s.aborted = true;
      // 关掉自动中止的会话只留提醒，不做处置
      if (b.stallGuardAutoAbort === false) continue;
      this.ingest(pid, {
        key: `stall:${s.key}:abort`, kind: "notice",
        text: `已自动中止：${s.name} ${s.sawOutput ? `连续 ${stallMinutes(elapsed)} 分钟没有新输出` : `连续运行 ${stallMinutes(elapsed)} 分钟没有结束`}${s.input ? `（${s.input}）` : ""}。常见原因是全盘扫描、大文件下载、交互式命令没喂输入。自动中止可在「授权」入口关掉。`,
        source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", occurredAt: new Date(now).toISOString()
      }, s.turnNo);
      this.store.audit({ type: "stall-guard-abort", platformSessionId: pid, tool: s.name, elapsedMs: elapsed });
      void this.interrupt(pid, "stall-guard").catch((e) => this.store.audit({ type: "stall-guard-abort-failed", platformSessionId: pid, reason: bounded(String(e), 200).text }));
    }
    this.armStallSweep();
  }

  /** 会话内开关：卡住的工具是否允许自动中止（默认开；关掉后仍然提醒）。 */
  setStallGuardAutoAbort(platformSessionId: string, enabled: boolean, actor: string): SessionBinding {
    const session = this.store.updateBinding(platformSessionId, (x) => { x.stallGuardAutoAbort = enabled; });
    this.store.audit({ type: "stall-guard-setting", platformSessionId, actor, autoAbort: enabled });
    this.emit("session", { platformSessionId });
    return session;
  }

  /* ============================ 中断 ============================ */

  async interrupt(platformSessionId: string, actor: string): Promise<{ ok: true; noop: boolean; message: string; session: SessionBinding }> {
    const b = this.managed(platformSessionId);
    const run = this.running.get(platformSessionId);
    const queued = b.turns.find((t) => t.status === "queued");
    if (!run && queued) {
      // 排队中的直接取消：没有发出，不涉及原生会话
      this.pendingPrompts.delete(queued.operationId);
      this.store.stepOperation(queued.operationId, "cancelled", "排队中被取消，未发出", "failed", "已取消（未执行）");
      this.retireQueue(this.store.operation(queued.operationId)!, b);
      this.finishTurn(platformSessionId, queued.turnNo, { status: "cancelled", reason: "排队中被取消" }, true);
      this.store.audit({ type: "interrupt", platformSessionId, actor, turnNo: queued.turnNo, queued: true });
      return { ok: true, noop: false, message: "已取消排队中的一轮（未执行）", session: this.store.binding(platformSessionId)! };
    }
    if (!run) return { ok: true, noop: true, message: "当前没有运行中的一轮，无需停止", session: b };
    if (run.stopRequested) return { ok: true, noop: true, message: "已在停止中", session: b };
    run.stopRequested = true;
    this.store.updateBinding(platformSessionId, (x) => { x.status = "stopping"; x.statusReason = "停止中：等待 runtime 确认"; });
    this.store.audit({ type: "interrupt", platformSessionId, actor, turnNo: run.turnNo });
    this.emit("session", { platformSessionId });
    if (run.handle) {
      try { await run.handle.interrupt(); }
      catch (e) { return { ok: true, noop: false, message: `已请求停止，runtime 尚未确认：${(e as Error).message}`, session: this.store.binding(platformSessionId)! }; }
    }
    return { ok: true, noop: false, message: "已请求停止本轮", session: this.store.binding(platformSessionId)! };
  }

  /* ============================ 审批 ============================ */

  private requestApproval(pid: string, turnNo: number, req: DriverApproval, signal?: AbortSignal): Promise<ApprovalDecision> {
    const b = this.store.binding(pid);
    if (!b) return Promise.resolve({ approve: false, reason: "会话不存在" });
    const isRunning = this.running.has(pid);
    if (!isRunning) {
      const latest = b.turns.at(-1);
      if (this.shuttingDown || b.archived || b.conflict || latest?.turnNo !== turnNo || latest.status !== "completed") {
        return Promise.resolve({ approve: false, reason: "会话当前不接受后台续写审批" });
      }
    }
    if (b.evaluation) {
      this.store.audit({ type: "evaluation-escalation-denied", platformSessionId: pid, nativeRequestId: req.nativeRequestId, kind: req.kind });
      return Promise.resolve({ approve: false, reason: "验收任务不能扩大输入写权限或绕过保护边界；未批准该请求" });
    }
    const now = Date.now();
    const isQuestion = req.kind === "question";
    if (isQuestion && !req.questions?.length) return Promise.resolve({ approve: false, reason: "提问没有可展示的问题" });
    // 提问永远要真人回答：「本会话全部批准」不能替人选答案
    if (b.approvalGrant && !req.requiresExplicitApproval && !req.runtimeSessionScope && !isQuestion) {
      // Session-wide human grant: still record each request and decision, but do not wait for a click.
      const auto: ApprovalRequest = {
        approvalId: `ap-${randomUUID().replace(/-/g, "").slice(0, 16)}`, platformSessionId: pid, turnNo,
        ...(req.nativeTurnId ? { nativeTurnId: req.nativeTurnId } : {}), nativeRequestId: req.nativeRequestId, kind: req.kind,
        title: req.title, action: bounded(req.action, LIMITS.toolInput).text, scope: bounded(req.scope, 800).text, source: req.source,
        paramsDigest: digest(req.params), createdAt: new Date(now).toISOString(), expiresAt: new Date(now).toISOString(),
        bindingRevision: b.bindingRevision, state: "approved", decidedAt: new Date(now).toISOString(), decidedBy: "session-grant"
      };
      this.store.putApproval(auto);
      this.ingest(pid, { key: `approval:${auto.approvalId}`, kind: "approval", text: `${auto.title}：已按本会话全部授权自动批准`, status: "approved", approvalId: auto.approvalId, source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", occurredAt: auto.createdAt }, turnNo);
      this.store.audit({ type: "approval-auto-approved", platformSessionId: pid, approvalId: auto.approvalId, kind: auto.kind, nativeRequestId: auto.nativeRequestId, grantApprovalId: b.approvalGrant.approvalId, grantedBy: b.approvalGrant.grantedBy });
      this.emit("session", { platformSessionId: pid });
      return Promise.resolve({ approve: true, reason: "" });
    }
    const ttl = isQuestion ? Math.max(this.approvalTtlMs, this.questionTtlMs) : this.approvalTtlMs;
    const a: ApprovalRequest = {
      approvalId: `ap-${randomUUID().replace(/-/g, "").slice(0, 16)}`, platformSessionId: pid, turnNo,
      ...(req.nativeTurnId ? { nativeTurnId: req.nativeTurnId } : {}), nativeRequestId: req.nativeRequestId, kind: req.kind,
      title: req.title, action: bounded(isQuestion ? questionsText(req.questions!) : req.action, LIMITS.toolInput).text, scope: bounded(req.scope, 800).text, source: req.source,
      ...(req.requiresExplicitApproval || req.runtimeSessionScope || isQuestion ? { requiresExplicitApproval: true } : {}),
      ...(isQuestion ? { questions: req.questions! } : {}),
      ...(req.runtimeSessionScope ? {runtimeSessionScope:bounded(req.runtimeSessionScope, 800).text} : {}),
      paramsDigest: digest(req.params), createdAt: new Date(now).toISOString(), ...(ttl > 0 ? {expiresAt: new Date(now + ttl).toISOString()} : {}),
      bindingRevision: b.bindingRevision, state: "pending"
    };
    this.store.putApproval(a);
    this.running.get(pid)?.approvals.add(a.approvalId);
    this.store.updateBinding(pid, (x) => {
      x.status = "waiting-input";
      x.statusReason = isQuestion ? `等待你回答：${a.title}` : `等待审批：${a.title}`;
      if (isRunning) {
        const t = x.turns.find((y) => y.turnNo === turnNo);
        if (t) t.status = "waiting-input";
      }
    });
    this.ingest(pid, { key: `approval:${a.approvalId}`, kind: "approval", text: `${a.title}：${a.action.split("\n")[0]}`, status: "pending", approvalId: a.approvalId, source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", occurredAt: a.createdAt }, turnNo);
    this.store.audit({ type: "approval-requested", platformSessionId: pid, approvalId: a.approvalId, kind: a.kind, nativeRequestId: a.nativeRequestId });
    this.emit("session", { platformSessionId: pid });
    this.emit("approvals", {});
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = ttl > 0 ? setTimeout(() => this.settleApproval(a.approvalId, "expired", { approve: false, reason: isQuestion ? "pi-agent：提问超时，用户一直没有回答" : "pi-agent：审批超时，按拒绝处理" }), ttl) : undefined;
      timer?.unref();
      this.pending.set(a.approvalId, { resolve, timer });
      signal?.addEventListener("abort", () => this.settleApproval(a.approvalId, "invalidated", { approve: false, reason: "runtime 已撤回该请求" }), { once: true });
    });
  }

  private settleApproval(approvalId: string, state: ApprovalRequest["state"], d: ApprovalDecision): void {
    const a = this.store.approval(approvalId);
    if (!a || a.state !== "pending") return;
    a.state = state; a.decidedAt = new Date().toISOString();
    this.store.putApproval(a);
    const p = this.pending.get(approvalId);
    if (p) { clearTimeout(p.timer); this.pending.delete(approvalId); p.resolve(d); }
    this.running.get(a.platformSessionId)?.approvals.delete(approvalId);
    const label = a.runtimeSessionScope && state === "approved" && d.scope === "session" ? "已授权本会话内相同动作与范围" : a.kind === "question"
      ? (state === "approved" ? `已回答${d.answers && a.questions ? `：${answersSummary(a.questions, d.answers)}` : ""}` : { denied: "已跳过", expired: "已过期（没有回答）", invalidated: "已失效", pending: "待回答" }[state as "denied" | "expired" | "invalidated" | "pending"])
      : { approved: "已批准", denied: "已拒绝", expired: "已过期（按拒绝处理）", invalidated: "已失效", pending: "待审批" }[state];
    this.ingest(a.platformSessionId, { key: `approval:${approvalId}`, kind: "approval", text: `${a.title}：${label}`, status: state, approvalId, source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded" }, a.turnNo);
    const b = this.store.binding(a.platformSessionId);
    if (b?.status === "waiting-input" && !this.store.allApprovals().some((x) => x.platformSessionId === b.platformSessionId && x.state === "pending")) {
      if (this.running.has(b.platformSessionId)) {
        this.store.updateBinding(b.platformSessionId, (x) => { x.status = "running"; x.statusReason = "本轮运行中"; });
      } else {
        this.store.updateBinding(b.platformSessionId, (x) => {
          if (x.status === "waiting-input") {
            x.status = x.nativeSessionId ? "idle" : "failed";
            x.statusReason = "本轮完成";
          }
        });
        this.watchNativeContinuation(b.platformSessionId);
      }
    }
    this.store.audit({ type: "approval-settled", platformSessionId: a.platformSessionId, approvalId, state });
    this.emit("session", { platformSessionId: a.platformSessionId });
    this.emit("approvals", {});
  }

  /** 一次性答复：绑定会话、turn、参数摘要；过期/错绑定无效 */
  decideApproval(platformSessionId: string, approvalId: string, body: { approve: boolean; paramsDigest: string; turnNo: number; scope?: "once" | "session"; answers?: unknown }, actor: string): ApprovalRequest {
    const a = this.store.approval(approvalId);
    if (!a || a.platformSessionId !== platformSessionId) throw new RuntimeError("审批请求不存在或不属于这个会话", 404, "RT_APPROVAL");
    if (a.state !== "pending") throw new RuntimeError(`审批请求${a.state === "expired" ? "已过期" : "已处理"}，不能再答复`, 409, "RT_APPROVAL_DONE");
    if (a.expiresAt && Date.parse(a.expiresAt) <= Date.now()) {
      this.settleApproval(approvalId, "expired", { approve: false, reason: "pi-agent：审批超时，按拒绝处理" });
      throw new RuntimeError("审批请求已过期，已按拒绝处理", 410, "RT_APPROVAL_EXPIRED");
    }
    if (body.paramsDigest !== a.paramsDigest || Number(body.turnNo) !== a.turnNo) throw new RuntimeError("答复与当前请求的参数或轮次不匹配", 409, "RT_APPROVAL_MISMATCH");
    if (!this.pending.has(approvalId)) {
      this.settleApproval(approvalId, "invalidated", { approve: false, reason: "无等待者" });
      throw new RuntimeError("这个请求已不在等待中（runtime 已结束或服务重启过）", 409, "RT_APPROVAL_DONE");
    }
    const isQuestion = a.kind === "question";
    if (isQuestion && body.scope === "session") throw new RuntimeError("提问必须逐次回答，不能整体授权", 409, "RT_APPROVAL");
    let answers: ReturnType<typeof validateAnswers> | undefined;
    if (isQuestion && body.approve) {
      answers = validateAnswers(a.questions ?? [], body.answers);
      if (!answers.ok) throw new RuntimeError(answers.error, 400, "RT_ANSWER");
    }
    const runtimeSession = body.approve && body.scope === "session" && !!a.runtimeSessionScope;
    const sessionWide = body.approve && body.scope === "session" && !runtimeSession;
    if (sessionWide && a.requiresExplicitApproval) throw new RuntimeError("扩大执行权限必须单次批准，不能创建会话整体授权", 409, "RT_APPROVAL");
    if (sessionWide && this.store.binding(platformSessionId)?.evaluation) throw new RuntimeError("验收会话不能整体授权", 409, "RT_APPROVAL");
    this.store.audit({ type: "approval-decision", platformSessionId, approvalId, approve: body.approve, actor, ...(sessionWide || runtimeSession ? { scope: "session", runtimeOwned:runtimeSession } : {}) });
    if (sessionWide) {
      this.store.updateBinding(platformSessionId, (x) => { x.approvalGrant = { grantedBy: actor, at: new Date().toISOString(), approvalId }; });
      this.store.audit({ type: "approval-session-grant", platformSessionId, approvalId, actor });
    }
    this.settleApproval(approvalId, body.approve ? "approved" : "denied", {
      approve: body.approve,
      ...(runtimeSession ? {scope:"session" as const} : {}),
      reason: body.approve ? "" : isQuestion ? "用户在 pi-agent 中选择不回答这些问题；请自行做合理假设，或换种方式再问" : "用户在 pi-agent 中拒绝了这个请求",
      ...(answers?.ok ? { answers: answers.answers } : {})
    });
    // The grant also covers requests of this session already waiting.
    if (sessionWide) for (const other of this.pendingApprovals().filter((x) => x.platformSessionId === platformSessionId && !x.requiresExplicitApproval && this.pending.has(x.approvalId))) {
      this.store.audit({ type: "approval-auto-approved", platformSessionId, approvalId: other.approvalId, kind: other.kind, nativeRequestId: other.nativeRequestId, grantApprovalId: approvalId, grantedBy: actor });
      this.settleApproval(other.approvalId, "approved", { approve: true, reason: "" });
    }
    return this.store.approval(approvalId)!;
  }

  async permissionGrants(platformSessionId:string) {
    const b=this.managed(platformSessionId),driver=this.driver(b.runtimeKind);
    if(b.runtimeKind!=='pi'||!driver.permissionGrants)throw new RuntimeError('此运行时不支持授权管理',400,'RT_INPUT');
    if(!b.nativeSessionId)return {version:1 as const,revision:0,grants:[]};
    return driver.permissionGrants(b.nativeSessionId,{workspace:b.workspace});
  }
  async revokeRuntimeGrant(platformSessionId:string,actor:string,id?:string) {
    const b=this.managed(platformSessionId),driver=this.driver(b.runtimeKind);
    if(id!==undefined&&!/^[a-f0-9]{64}$/.test(id))throw new RuntimeError('授权 ID 无效',400,'RT_INPUT');
    if(b.runtimeKind!=='pi'||!driver.permissionGrants||!b.nativeSessionId)throw new RuntimeError('此会话暂不支持 runtime 授权撤销',400,'RT_INPUT');
    const result=await driver.permissionGrants(b.nativeSessionId,{workspace:b.workspace,revoke:id===undefined?{}:{id}});
    if(id===undefined)this.revokeApprovalGrant(platformSessionId,actor);
    this.store.audit({type:'runtime-permission-grant-revoked',platformSessionId,actor,grantId:id??'all',revision:result.revision});
    this.emit('session',{platformSessionId});return result;
  }

  async revokeAllApprovalGrants(platformSessionId:string,actor:string):Promise<SessionBinding> {
    const b=this.managed(platformSessionId);
    if(b.runtimeKind==='pi'&&b.nativeSessionId){await this.revokeRuntimeGrant(platformSessionId,actor);return this.store.binding(platformSessionId)!;}
    return this.revokeApprovalGrant(platformSessionId,actor);
  }

  /** Protected workflows own their policy; ordinary chats may select probed native modes. */
  private sessionPermissionOptions(b: SessionBinding) {
    const current = effectivePermissionMode(b);
    if (b.roomRef || b.comparisonRef || b.projectRef || b.evaluation || b.role || b.evaluationPolicyHash) {
      return permissionOptions(b.runtimeKind).filter(p => p.id === current);
    }
    const supported = this.store.profiles()[b.runtimeProfileId]?.permissionOptions;
    return permissionOptions(b.runtimeKind).filter(p => !supported || supported.some(s => s.id === p.id));
  }

  updatePermissionMode(id: string, mode: string, expectedRevision: number, actor: string): SessionBinding {
    const b = this.managed(id);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new RuntimeError("缺少有效的会话版本，请刷新后重试", 400, "RT_INPUT");
    if (b.archived || b.conflict || ["unknown", "disconnected"].includes(b.status)) throw new RuntimeError("当前会话状态不允许修改权限", 409, "RT_CONFLICT");
    const option = this.sessionPermissionOptions(b).find(p => p.id === mode);
    if (!option) throw new RuntimeError("该会话不支持所选权限模式", 400, "RT_INPUT");
    const active = this.running.has(id) || b.turns.some(t => ["queued", "running", "waiting-input"].includes(t.status));
    const previous = b.pendingPermissionMode ?? effectivePermissionMode(b);
    const out = this.store.updateBinding(id, x => {
      if (active) {
        if (mode === effectivePermissionMode(x)) { delete x.pendingPermissionMode; delete x.pendingPermissionAfterTurn; }
        else { x.pendingPermissionMode = option.id; x.pendingPermissionAfterTurn = x.turns.at(-1)?.turnNo ?? 0; }
      } else {
        x.permissionMode = option.id; x.permissionLabel = option.label;
        delete x.pendingPermissionMode; delete x.pendingPermissionAfterTurn;
        if (previous !== mode) delete x.approvalGrant;
      }
    }, expectedRevision);
    this.store.audit({ type: "permission-mode-changed", platformSessionId: id, actor, previous, mode, nextTurn: active });
    this.emit("session", { platformSessionId: id });
    return out;
  }

  /** Ends a session-wide approval grant; later requests wait for a human again. */
  revokeApprovalGrant(platformSessionId: string, actor: string): SessionBinding {
    const b = this.managed(platformSessionId);
    if (!b.approvalGrant) return b;
    this.store.updateBinding(platformSessionId, (x) => { delete x.approvalGrant; });
    this.store.audit({ type: "approval-session-grant-revoked", platformSessionId, actor });
    this.emit("session", { platformSessionId });
    return this.store.binding(platformSessionId)!;
  }

  /**
   * 快捷回复：会话空闲、最后一条消息是助手回复时，返回由 deepseek-flash 提取的推荐回复。
   * 最近一轮带部署结果通知时，第一条固定为「归档会话」（成功）或「重新部署」（失败），模型只补其余项。
   * 额度 / 限流中断的轮次不调用模型：最后一条通常只是额度错误，直接给平台兜底（继续 / 重试）。
   * 没有助手回复的中断 / 失败 / 按请求停止轮次，平台兜底挂在这一轮的结束记录上。
   * 只覆盖普通单聊（群聊、对比、项目、评测会话由各自流程发消息）。
   */
  async quickReplies(platformSessionId: string): Promise<QuickReplyResult> {
    const b = this.managed(platformSessionId);
    if (b.roomRef || b.comparisonRef || b.projectRef || b.evaluation || b.archived) return { state: "none", replies: [] };
    if (this.running.has(platformSessionId) || b.turns.some(t => t.status === "queued" || t.status === "running" || t.status === "waiting-input")) return { state: "none", replies: [] };
    const events = this.store.events(platformSessionId);
    const lastTurn = b.turns.at(-1);
    const last = lastAssistantMessage(events);
    const deployment = lastDeploymentOutcome(events, lastTurn?.turnNo);
    // 部署成功（或已在线上）后自动重新部署的连续失败计数清零：上限只防「失败→重试→再失败」的循环。
    if (deployment?.kind === "success") this.resetAutoRedeploy(platformSessionId);
    if (!last) {
      // 部署结果通知本身就是这一轮的最后一条消息（助手还没回复）：仍然给出平台优先项。
      if (deployment) return this.rememberQuickAction(platformSessionId, withDeploymentPriority({ state: "none", eventKey: deployment.eventKey, replies: [] }, deployment));
      // 中断 / 失败 / 用户按请求停止可能连助手回复都没有（例如额度错误直接打断、点了「停止本轮」）。
      // 这时推荐胶囊挂在轮次结束记录上，平台至少给一条「重试本轮」；额度中断给「恢复后继续 / 重试本轮」。
      const end = lastTurnEnd(events, lastTurn?.turnNo);
      if (!end || !lastTurn || !["interrupted", "failed", "unknown", "cancelled"].includes(lastTurn.status)) return { state: "none", replies: [] };
      const quota = lastTurn.quotaFailure === true
        || QUOTA_FAILURE.test(end.text ?? "")
        || this.profile(b.runtimeKind)?.lastQuotaFailure?.platformSessionId === platformSessionId;
      return this.rememberQuickAction(platformSessionId, { state: "ready", eventKey: end.key, replies: quota ? quotaInterruptedReplies() : [{ ...RETRY_REPLY }] });
    }
    // 新记录看 turn 上的标记；升级前的旧记录没有标记时，用错误原文或 profile 里最近一次额度失败补上（仍要求本轮是被中断）。
    const interrupted = lastTurn?.status === "interrupted";
    const quota = lastTurn?.quotaFailure === true
      || (interrupted && QUOTA_FAILURE.test(last.text ?? ""))
      || (interrupted && this.profile(b.runtimeKind)?.lastQuotaFailure?.platformSessionId === platformSessionId);
    if (quota) return this.rememberQuickAction(platformSessionId, withDeploymentPriority({ state: "ready", eventKey: last.key, replies: quotaInterruptedReplies() }, deployment));
    if (!this.quickReplyService) return this.rememberQuickAction(platformSessionId, withDeploymentPriority({ state: "unavailable", eventKey: last.key, replies: [], reason: "快捷回复模型未配置" }, deployment));
    return this.rememberQuickAction(platformSessionId, withDeploymentPriority(await this.quickReplyService.get(platformSessionId, last), deployment));
  }

  /** 快捷回复补完平台兜底后，用最终结果同步会话列表的推荐操作标签；persist=true 时同时存成会话的最终推荐结果。 */
  noteQuickAction(platformSessionId: string, result: QuickReplyResult, opts: { persist?: boolean } = {}): QuickReplyResult {
    const out = this.rememberQuickAction(platformSessionId, result);
    if (opts.persist) this.persistQuickReplies(platformSessionId, out);
    return out;
  }

  /**
   * 平台补完部署 / 继续 / 重试等兜底的钩子（需要部署状态，由 Web 层提供）。
   * cacheable=false 表示这次结果依赖了暂时读不到 / 不满足的外部状态，不存下来，下次重新算。
   */
  private quickReplyFinalizer?: (platformSessionId: string, raw: QuickReplyResult) => Promise<{ result: QuickReplyResult; cacheable: boolean }>;
  setQuickReplyFinalizer(fn: (platformSessionId: string, raw: QuickReplyResult) => Promise<{ result: QuickReplyResult; cacheable: boolean }>): void {
    this.quickReplyFinalizer = fn;
  }

  /** 这条推荐结果挂的消息仍是会话当前的末尾（没有新一轮、没有更新的消息）。 */
  private quickKeyCurrent(platformSessionId: string, eventKey: string): boolean {
    const b = this.store.binding(platformSessionId);
    if (!b || b.archived || this.running.has(platformSessionId) || b.turns.some(t => t.status === "queued" || t.status === "running" || t.status === "waiting-input")) return false;
    const events = this.store.events(platformSessionId);
    const last = [...events].reverse().find(e => e.kind === "message" && !e.partial && !e.subagent);
    if (last?.key === eventKey) return true;
    return lastTurnEnd(events, b.turns.at(-1)?.turnNo)?.key === eventKey;
  }

  /**
   * 列表上的推荐操作只代表「当前这一步」：用户已经又发了消息（排队 / 预约中，或新一轮已经开始）、
   * 或这条回复不再是会话末尾时，旧的部署 / 归档推荐就过期了，列表标签跟着会话当前状态走。
   */
  private quickActionCurrent(b: SessionBinding): boolean {
    if (!b.quickAction) return false;
    if (b.outbox?.length) return false;
    return this.quickKeyCurrent(b.platformSessionId, b.quickAction.eventKey);
  }

  private persistQuickReplies(platformSessionId: string, result: QuickReplyResult): void {
    const b = this.store.binding(platformSessionId);
    if (!b) return;
    const ok = result.state === "ready" && !!result.eventKey && result.replies.length > 0 && this.quickKeyCurrent(platformSessionId, result.eventKey);
    const next: StoredQuickReplies | undefined = ok
      ? { eventKey: result.eventKey!, replies: result.replies.map(r => ({ label: r.label, text: r.text, ...(r.action ? { action: r.action } : {}) })), ...(result.deployment ? { deployment: result.deployment } : {}), ...(result.deploymentSha ? { deploymentSha: result.deploymentSha } : {}), at: new Date().toISOString() }
      : undefined;
    const cur = b.quickReplies;
    if (!next && !cur) return;
    // 只比较内容：同样的结果重复写入不触发推送
    const sameContent = (a?: StoredQuickReplies, c?: StoredQuickReplies) => JSON.stringify(a && { ...a, at: "" }) === JSON.stringify(c && { ...c, at: "" });
    if (next && sameContent(cur, next)) return;
    // 算不出新结果（如模型暂时不可用）时不清掉同一条消息上的好结果；换了消息的旧结果由新一轮开始时清掉
    if (!next) return;
    this.store.updateBinding(platformSessionId, (x) => { x.quickReplies = next; }, undefined, { bump: false });
    this.emit("session", { platformSessionId });
  }

  /**
   * 最终推荐结果：模型提取 + 平台兜底（部署 / 继续 / 重试本轮）。一轮结束时预先算好并存到会话记录上，
   * 随会话详情和实时同步到手机；打开会话时已经存在的结果直接返回，不再重新调模型和读部署状态。
   */
  async finalQuickReplies(platformSessionId: string): Promise<QuickReplyResult> {
    const stored = this.store.binding(platformSessionId)?.quickReplies;
    if (stored && this.quickKeyCurrent(platformSessionId, stored.eventKey)) {
      return { state: "ready", eventKey: stored.eventKey, replies: stored.replies.map(r => ({ ...r })), ...(stored.deployment ? { deployment: stored.deployment } : {}), ...(stored.deploymentSha ? { deploymentSha: stored.deploymentSha } : {}) };
    }
    const raw = await this.quickReplies(platformSessionId);
    if (!this.quickReplyFinalizer) return raw;
    const { result, cacheable } = await this.quickReplyFinalizer(platformSessionId, raw);
    // 模型暂时不可用时的平台兜底结果不存：恢复后下一次请求再重新提取
    return this.noteQuickAction(platformSessionId, result, { persist: cacheable && raw.state !== "unavailable" });
  }

  /** 带操作的推荐项统一用固定名字（部署 / 提交并部署 / 重新部署 / 归档会话）；独立 worktree 会话部署前要先提交 */
  private canonicalQuickActions(platformSessionId: string, result: QuickReplyResult): QuickReplyResult {
    const wt = this.store.binding(platformSessionId)?.worktree;
    return canonicalizeQuickActions(result, { worktree: !!wt && !wt.removedAt });
  }

  /**
   * 把快捷回复里**第一条**（如果它本身就是 action）记到会话上，供会话列表显示「部署 / 归档」标签。
   * 只认第一名：后面的归档 / 部署不能因为排在前面的普通建议没有 action 就被提到列表上，
   * 那会让列表标签看起来像最推荐的下一步。不改 bindingRevision（只是展示用的派生信息）；
   * 结果已经过期（用户又发了消息）时不写，避免模型调用慢于下一轮时把上一条回复的操作挂到列表上。
   */
  private rememberQuickAction(platformSessionId: string, raw: QuickReplyResult): QuickReplyResult {
    const result = this.canonicalQuickActions(platformSessionId, raw);
    if (!result.eventKey) return result;
    const events = this.store.events(platformSessionId);
    const last = [...events].reverse().find(e => e.kind === "message" && !e.partial && !e.subagent);
    if (!last || last.key !== result.eventKey) return result;
    const first = result.replies[0];
    const next: QuickActionBadge | undefined = first?.action ? { action: first.action, label: first.label, eventKey: result.eventKey } : undefined;
    const cur = this.store.binding(platformSessionId)?.quickAction;
    if (JSON.stringify(cur) === JSON.stringify(next)) return result;
    this.store.updateBinding(platformSessionId, (x) => {
      if (next) x.quickAction = next;
      else delete x.quickAction;
    }, undefined, { bump: false });
    this.emit("directory", {});
    return result;
  }

  pendingApprovals(): ApprovalRequest[] { return this.store.allApprovals().filter((a) => a.state === "pending"); }

  /* ============================ 查看 ============================ */

  private managed(id: string): SessionBinding {
    const b = this.store.binding(id);
    if (!b) {
      if (this.discovered.has(id)) throw new RuntimeError("这是已发现的外部历史，只读：不能续聊、停止或审批", 403, "RT_READ_ONLY");
      throw new RuntimeError("会话不存在", 404, "RT_NOT_FOUND");
    }
    if (b.sourceMode !== "platform-managed") throw new RuntimeError("只读会话不能执行写操作", 403, "RT_READ_ONLY");
    return b;
  }

  /** 查看：已发现的历史先读一次原生记录（有界缓存），用量与覆盖范围随之可用 */
  /** 只读历史的平台 ID 由列表登记；直接打开（如服务重启后）时在授权范围内重新列一次 */
  private async ensureDiscovered(id: string): Promise<void> {
    if (!id.startsWith("rx-") || this.discovered.has(id) || this.store.binding(id)) return;
    await this.directory({ limit: 1, includeHistory: true }).catch(() => undefined);
  }

  async view(id: string, options: { includeUsage?: boolean } = {}): Promise<SessionView> {
    await this.ensureDiscovered(id);
    const d = this.store.binding(id) ? undefined : this.discovered.get(id);
    if (!d) {
      const b = this.store.binding(id);
      if (!b?.nativeSessionId || !this.driver(b.runtimeKind).continuationState?.(b.nativeSessionId)) await this.syncNativeContinuation(id);
      this.watchNativeContinuation(id); return this.sessionView(id, options);
    }
    await this.readDiscovered(d.kind, d.item).catch(() => undefined);
    const v = this.sessionView(id, options);
    const owner = await this.historyOwnership(d.kind, d.item.nativeSessionId).catch(() => undefined);
    if (owner) v.notes = [owner, ...v.notes.filter((n) => !n.startsWith("账号归属"))];
    return v;
  }

  /**
   * 历史归属证据（§6.1）：Codex rollout 首行记录了创建账号；与当前登录账号按同一规则派生的身份空间比较。
   * 只作说明，不据此把历史并入当前账号的额度或身份空间。
   */
  private async historyOwnership(kind: RuntimeKind, nativeId: string): Promise<string | undefined> {
    if (kind !== "codex") return undefined;
    const drv = this.drivers.codex as unknown as { threadMeta?: (id: string) => Promise<{ path: string | null } | undefined>; creatorAccountId?: (p: string | null, nativeId?: string) => string | undefined };
    if (!drv.threadMeta || !drv.creatorAccountId) return undefined;
    const meta = await drv.threadMeta(nativeId);
    const creator = drv.creatorAccountId(meta?.path ?? null, nativeId);
    const p = this.profile("codex");
    if (!creator) return "账号归属：未知（原生记录没有创建账号字段）";
    if (!p?.identity || p.identity.derivation !== "stable-account-id") return "账号归属：原生记录有创建账号，但当前登录身份未知，无法比较";
    const h = createHash("sha256").update(`codex|${this.store.host.hostId}|${p.identity.authMode}|${creator}`).digest("hex").slice(0, 24);
    return `id1:${h}` === p.identity.identityScopeId
      ? "账号归属：rollout 记录的创建账号与当前登录账号一致（有原生证据；仍按历史来源单独显示，不并入额度）"
      : "账号归属：由另一个账号创建（与当前登录账号不同）";
  }

  sessionView(id: string, options: { includeUsage?: boolean } = {}): SessionView {
    const b = this.store.binding(id);
    if (b) {
      const profile = this.store.profiles()[b.runtimeProfileId];
      const rl = this.rateLimitFor(b.identityScopeId);
      const notes: string[] = [];
      if (profile?.identity && profile.identity.identityScopeId !== b.identityScopeId) notes.push("当前登录的账号空间与创建时不同：续聊会被拒绝，避免串账号");
      const qp = this.queuePosition(id);
      const mo = this.sessionModelOption(profile, b);
      return {
        permissionOptions: this.sessionPermissionOptions(b),
        ...(mo?.efforts?.length ? { effortOptions: { efforts: mo.efforts, ...(mo.defaultEffort ? { defaultEffort: mo.defaultEffort } : {}) } } : {}),
        ...(b.nativeSessionId ? { resumeCommand: resumeCommand(b.runtimeKind, b.nativeSessionId, b.workspace, profile?.binaryPath, b.runtimeKind === "pi" ? (this.drivers.pi as PiDriver).nativeSessionPath?.(b.nativeSessionId, b.workspace) : undefined) } : {}),
        session: b, readOnly: !!b.conflict || !!b.roomRef, ...(b.roomRef ? { readOnlyReason: "请回到群聊，通过引用和 @ 投递人类指令" } : {}), ...(b.conflict ? { readOnlyReason: `外部写入：${b.conflict.reason}` } : {}),
        usage: options.includeUsage === false ? { coverage: "unknown", semantics: "打开用量面板后读取", totals: {}, byModel: [], notes: [] } : summarizeUsage(this.store.usageFor(id)),
        approvals: this.store.allApprovals().filter((a) => a.platformSessionId === id).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 20),
        ...(rl ? { rateLimit: rl } : {}),
        ...(profile ? { profile: { profileId: profile.profileId, state: profile.state, ...(profile.binaryVersion ? { binaryVersion: profile.binaryVersion } : {}), ...(profile.sdkVersion ? { sdkVersion: profile.sdkVersion } : {}), permissions: profile.permissions, hostLabel: profile.hostLabel } } : {}),
        ...(qp ? { queuePosition: qp } : {}), notes,
        executionNotice: `使用 ${RUNTIME_LABEL[b.runtimeKind]} 原生权限（${b.permissionLabel}），尚未启用完整 pi-agent 合约门禁`
      };
    }
    const d = this.discovered.get(id);
    if (!d) throw new RuntimeError("会话不存在（外部历史需在授权范围内重新列出）", 404, "RT_NOT_FOUND");
    const cached = this.readCache.get(`${d.kind}:${d.item.nativeSessionId}`);
    const now = new Date().toISOString();
    const pseudo: SessionBinding = {
      platformSessionId: id, runtimeKind: d.kind, runtimeProfileId: this.profileId(d.kind), hostId: this.store.host.hostId,
      identityScopeId: this.historyScope(d.kind), nativeSessionId: d.item.nativeSessionId, sourceMode: "external-discovered", executionMode: "read-only",
      ...(d.item.parentId ? { nativeParentSessionId: d.item.parentId } : {}),
      title: d.item.title, workspace: d.item.workspace ?? "（未知）", ...(cached?.read.model ?? d.item.model ? { effectiveModel: (cached?.read.model ?? d.item.model)!, effectiveModelSource: "原生历史记录" } : {}),
      permissionLabel: "只读", createdAt: { at: d.item.createdAt ?? d.item.updatedAt ?? now, source: "history-file" },
      lastActivityAt: { at: d.item.updatedAt ?? now, source: "history-file" }, bindingRevision: 0, creationOperationId: "",
      status: d.item.status, statusReason: "外部历史：没有可靠运行证据时状态为未知", observation: "partial", turns: [], coverage: cached?.read.coverage ?? "unknown"
    };
    return {
      session: pseudo, readOnly: true, readOnlyReason: "已发现的外部历史，首期只读：不续聊、不停止、不抢占外部进程",
      usage: options.includeUsage !== false && cached ? summarizeUsage(cached.read.usage) : { coverage: "unknown", semantics: "打开会话后读取", totals: {}, byModel: [], notes: [] },
      approvals: [], notes: [...(cached?.read.notes ?? []), "账号归属：历史来源按授权目录隔离；当前登录身份不能证明旧历史属于同一账号"],
      ...(d.item.workspace ? { resumeCommand: resumeCommand(d.kind, d.item.nativeSessionId, d.item.workspace, this.profile(d.kind)?.binaryPath) } : {}),
      executionNotice: "只读查看：不会 resume、不调用模型、不写原文件"
    };
  }

  /** 历史只读的身份分区：按 runtime + host + 授权来源隔离，标“账号归属未知” */
  private historyScope(kind: RuntimeKind): string {
    return `hist1:${createHash("sha256").update(`${kind}|${this.store.host.hostId}|history`).digest("hex").slice(0, 16)}`;
  }

  /** Both the transcript window and its compact index use the same authorized history source. */
  private async messageSource(id: string): Promise<{ all: ProjectedEvent[]; coverage: string; notes: string[] }> {
    let all: ProjectedEvent[];
    let coverage = "complete";
    let notes: string[] = [];
    await this.ensureDiscovered(id);
    const b = this.store.binding(id);
    if (b) {
      if (!b.nativeSessionId || !this.driver(b.runtimeKind).continuationState?.(b.nativeSessionId)) await this.syncNativeContinuation(id);
      this.watchNativeContinuation(id);
      all = this.store.events(id);
      // 升级前保存的图片事件没有资源字段（或只有旧文案）；按原生 key 回补并覆盖，保留原序号。
      const staleImage = (e: ProjectedEvent) => e.kind === "unknown" && e.text === "未识别的记录类型：imageGeneration"
        || e.kind === "notice" && !e.image && !!e.text?.startsWith("查看图片：") && e.text.endsWith("（图片未加载）");
      if (b.runtimeKind === "codex" && all.some(staleImage)) {
        await this.backfill(id);
        all = this.store.events(id);
      }
      coverage = b.coverage;
    }
    else {
      const d = this.discovered.get(id);
      if (!d) throw new RuntimeError("会话不存在（外部历史需在授权范围内重新列出）", 404, "RT_NOT_FOUND");
      const r = await this.readDiscovered(d.kind, d.item);
      all = r.seqd; coverage = r.read.coverage; notes = r.read.notes;
    }
    return { all, coverage, notes };
  }

  /** 会话里用到的联网搜索 / 网页抓取（从工具调用事件里挑出；不另存） */
  async webActivity(id: string): Promise<{ items: WebActivityItem[]; total: number; lastSeq?: number }> {
    const { all } = await this.messageSource(id);
    const last = all.at(-1)?.seq;
    const items = webActivity(all);
    // 只回最近 300 条，避免极长会话把侧栏请求撑大
    return { items: items.slice(-300), total: items.length, ...(last !== undefined ? { lastSeq: last } : {}) };
  }

  /**
   * 平台公共记忆在本会话里的两类记录（不另存，从事件里挑出）：
   * items = 首轮注入的正文，侧栏卡片点开可查看当时实际注入了什么；
   * lookups = 会话后来对按需索引的查阅（读目录 / 检索 / 看详情 / 接口），从工具调用的命令原文里识别；
   * checks = 强约束记忆每轮结束后的校验记录（通过 / 未通过已反馈 / 仍未通过）。
   */
  async injections(id: string): Promise<{ items: PlatformInjectionItem[]; lookups: PlatformLookupItem[]; checks: PlatformCheckItem[] }> {
    const { all } = await this.messageSource(id);
    return { items: platformInjections(all), lookups: platformLookups(all).slice(-300), checks: platformChecks(all).slice(-100) };
  }

  async imageIndex(id: string) {
    const { all } = await this.messageSource(id);
    return sessionImageIndex(all);
  }

  /** User messages (not the platform's enforcement feedback) and deployment landmarks without assistant/tool bodies or attachment data. */
  async messageIndex(id: string) {
    const { all } = await this.messageSource(id);
    return {
      firstSeq: all[0]?.seq, lastSeq: all.at(-1)?.seq,
      items: all.filter(e => e.kind === "message" && e.role === "user" && !e.subagent && !(e.text ?? "").startsWith(ENFORCEMENT_PROMPT_MARK)).map(e => {
        const deployment = !e.attachments?.length && /^\[pi-agent 自动部署通知\] ([^\n]+)(?:\n[\s\S]*)?$/.exec(e.text || "");
        const headline = deployment ? deployment[1]!.trim() : "";
        const result = headline.startsWith("已上线：") ? "部署成功"
          : headline.startsWith("不用部署：") ? "已在线上"
          : /^部署 .*没有成功/.test(headline) ? "部署失败"
          : headline.startsWith("等空闲超时") ? "部署超时"
          : headline.startsWith("没有部署 ") ? "未部署" : "部署结果";
        const commit = /(?:^已上线：|^不用部署：|^没有部署 |^部署 |放弃部署 )([a-f0-9]{7,40})(?![a-f0-9])/i.exec(headline)?.[1];
        return {
          key: e.key, seq: e.seq,
          ...(deployment ? { type: "deployment" as const } : {}),
          summary: (deployment ? result + (commit ? ` · ${commit.slice(0, 7)}` : "") : e.text || "").replace(/\s+/g, " ").trim().slice(0, 120)
            || (e.attachments?.length ? "图片 / 附件消息" : "用户消息")
        };
      })
    };
  }

  /** 分页 transcript：默认取最新一页；before/after 是 seq 游标。查看不会 resume */
  async messages(id: string, q: { before?: number; after?: number; limit?: number; kind?: string }): Promise<{ events: ProjectedEvent[]; hasMoreBefore: boolean; hasMoreAfter: boolean; total: number; firstSeq?: number; lastSeq?: number; projectionVersion: string; coverage: string; notes: string[] }> {
    const limit = Math.min(200, Math.max(1, q.limit ?? 100));
    let { all, coverage, notes } = await this.messageSource(id);
    if (q.kind) all = all.filter((e) => q.kind === "tool" ? e.kind === "tool" : q.kind === "conversation" ? e.kind !== "tool" : true);
    let page: ProjectedEvent[];
    let hasMoreBefore: boolean;
    if (q.after !== undefined) { page = all.filter((e) => e.seq > q.after!).slice(0, limit); hasMoreBefore = false; }
    else {
      const upto = q.before !== undefined ? all.filter((e) => e.seq < q.before!) : all;
      page = upto.slice(Math.max(0, upto.length - limit));
      hasMoreBefore = upto.length > page.length;
    }
    // ordered by seq：本页之后是否还有更新的记录（用于客户端上拉续读）。
    const lastAll = all.at(-1)?.seq;
    const hasMoreAfter = !!page.length && lastAll !== undefined && page[page.length - 1]!.seq < lastAll;
    return {
      events: page, hasMoreBefore, hasMoreAfter, total: all.length, ...(page[0] ? { firstSeq: page[0].seq } : {}), ...(page.length ? { lastSeq: page[page.length - 1]!.seq } : {}),
      projectionVersion: PROJECTION_VERSION, coverage, notes
    };
  }

  private async readDiscovered(kind: RuntimeKind, item: HistoryItem): Promise<{ read: HistoryRead; seqd: ProjectedEvent[] }> {
    const s = this.settings();
    if (!s.history[kind].enabled || !underRoots(item.workspace, s.history[kind].roots)) throw new RuntimeError("这个会话不在已授权的历史范围内", 403, "RT_HISTORY_SCOPE");
    const k = `${kind}:${item.nativeSessionId}`;
    const hit = this.readCache.get(k);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    const read = await this.driver(kind).readHistory(item.nativeSessionId, { ...(item.workspace ? { workspace: item.workspace } : {}) });
    const recordedAt = new Date().toISOString();
    // 历史回读按原生 key 去重（同一条消息只出现一次），seq 按原生顺序编号
    const byKey = new Map<string, ProjectedEvent>();
    let seq = 1;
    for (const e of read.events) {
      const prev = byKey.get(e.key);
      if (prev) { byKey.set(e.key, { ...prev, ...e, seq: prev.seq, recordedAt, ...(prev.tool && e.tool ? { tool: { ...prev.tool, ...Object.fromEntries(Object.entries(e.tool).filter(([, v]) => v !== "" && v !== undefined)) } } : {}) }); continue; }
      byKey.set(e.key, { ...e, seq: seq++, recordedAt });
    }
    const out = { at: Date.now(), read, seqd: [...byKey.values()].sort((a, b) => a.seq - b.seq) };
    this.readCache.set(k, out);
    // 有界缓存：最多 20 个会话
    while (this.readCache.size > 20) this.readCache.delete(this.readCache.keys().next().value!);
    return out;
  }

  /** 重连/恢复回补：从原生记录补齐受管会话缺的事件（按 key 去重，不重复） */
  async backfill(platformSessionId: string): Promise<{ added: number; coverage: string }> {
    const b = this.store.binding(platformSessionId);
    if (!b?.nativeSessionId) return { added: 0, coverage: "unknown" };
    this.store.updateBinding(platformSessionId, (x) => { x.observation = "catching-up"; }, undefined, { bump: false });
    this.emit("session", { platformSessionId });
    try {
      const read = await this.driver(b.runtimeKind).readHistory(b.nativeSessionId, { workspace: b.workspace });
      // 缺的事件按原生顺序插在前后两个已知事件之间（不追加到末尾，避免重启后顺序错乱）
      const existing = new Map(this.store.events(platformSessionId).map((e) => [e.key, e.seq]));
      const known = read.events.map((e) => existing.get(e.key));
      let added = 0;
      let i = 0;
      while (i < read.events.length) {
        if (known[i] !== undefined) { this.ingest(platformSessionId, { ...read.events[i]!, partial: false }); i++; continue; }
        let j = i;
        while (j < read.events.length && known[j] === undefined) j++;
        const lo = i > 0 ? known[i - 1]! : 0;
        const hi = j < read.events.length ? known[j]! : undefined;
        const n = j - i;
        for (let k = 0; k < n; k++) {
          const hint = hi === undefined ? undefined : lo + ((hi - lo) * (k + 1)) / (n + 1);
          this.ingest(platformSessionId, { ...read.events[i + k]!, partial: false }, undefined, hint !== undefined && hint < hi! ? hint : undefined);
          added++;
        }
        i = j;
      }
      for (const u of read.usage) this.store.addUsage(platformSessionId, u);
      this.store.updateBinding(platformSessionId, (x) => {
        x.observation = "live"; x.coverage = read.coverage;
        if (read.title?.trim() && read.titleKind !== "preview" && x.titleSource !== "user") {
          x.title = bounded(read.title.trim(), 80).text; x.titleSource = "native";
          if (x.titleGeneration && ["pending", "running"].includes(x.titleGeneration.state)) x.titleGeneration.state = "superseded";
        }
      }, undefined, { bump: false });
      this.emit("session", { platformSessionId });
      this.emit("directory", {});
      return { added, coverage: read.coverage };
    } catch (e) {
      this.store.updateBinding(platformSessionId, (x) => { x.observation = "stale"; x.statusReason = `${x.statusReason ?? ""}（补读原生记录失败：${bounded((e as Error).message, 200).text}）`; });
      this.emit("session", { platformSessionId });
      throw e;
    }
  }

  /* ============================ 目录 ============================ */

  /**
   * 待办记录 → 关联会话（含已归档）：会话持有 noteRef 或推荐任务来源，待办不知道有哪些会话。
   * 待办页调用一次拿到全部关联，按最近活动时间从新到旧排列。
   */
  noteSessions(): Record<string, NoteSessionLink[]> {
    // 待办列表每次读取都会来问一遍：全部绑定约 1.6MB，重读 + 解析会占住事件循环。
    // 绑定表指纹没变就直接复用上次结果（返回值只读，调用方不得修改）。
    const stamp = this.store.bindingsStamp();
    if (stamp && this.noteSessionsCache?.stamp === stamp) return this.noteSessionsCache.value;
    const out: Record<string, NoteSessionLink[]> = {};
    for (const b of this.store.allBindings()) {
      // 单条待办发起的会话，或推荐任务（多条待办聚合）发起的会话：每条来源待办都关联到它
      const noteIds = new Set([...(b.noteRef?.noteId ? [b.noteRef.noteId] : []), ...(b.recommendationRef?.sources ?? []).map((s) => s.noteId)]);
      for (const noteId of noteIds) (out[noteId] ??= []).push({
        platformSessionId: b.platformSessionId, runtimeKind: b.runtimeKind, title: b.title, status: b.status,
        archived: !!b.archived, lastActivityAt: b.lastActivityAt.at, href: `#/rt/${b.platformSessionId}`
      });
    }
    for (const list of Object.values(out)) list.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
    this.noteSessionsCache = stamp ? { stamp, value: out } : undefined;
    return out;
  }
  private noteSessionsCache: { stamp: string; value: Record<string, NoteSessionLink[]> } | undefined;

  /**
   * 已归档会话引用的待办 id（去重）：启动时据此把历史遗留的关联待办补标完成
   * （这些归档发生在本特性上线之前，不会再收到 archived 事件）。
   */
  archivedNoteIds(): string[] {
    const out = new Set<string>();
    for (const b of this.store.allBindings()) if (b.archived && b.noteRef?.noteId) out.add(b.noteRef.noteId);
    return [...out];
  }

  /**
   * 从待办发起的会话历史上可能丢了 noteRef（正文里还留着引用块，当时把引用 chip 删掉就整条清空了）：
   * 按首条消息里引用块的「记于」时间与首行文字反查待办，lookup 返回 null（对不上 / 有多条候选）就不补，不猜。
   * 只修普通单会话中仍未归档、也没有推荐任务来源的那些；幂等，可在每次启动调用。
   */
  backfillNoteRefs(lookup: (quote: NoteRefQuery) => string | null): { repaired: NoteRefRepair[]; unresolved: string[] } {
    const result = backfillSessionNoteRefs(this.store, lookup);
    for (const r of result.repaired) this.emit("session", { platformSessionId: r.platformSessionId });
    if (result.repaired.length) this.emit("directory", {});
    return result;
  }

  /**
   * archived：默认不列已归档；include = 一并列出（带 archived 标记）；only = 只列已归档。
   * source=chat 只列普通对话（不含项目角色会话与验收探针），不读历史目录。
   */
  async directory(q: { source?: string; status?: string; q?: string; runtime?: string; limit?: number; cursor?: string; includeHistory?: boolean; archived?: string } = {}, extra: DirectoryEntry[] = [], roomWorkspaces?: ReadonlyMap<string, string>): Promise<{ entries: DirectoryEntry[]; nextCursor?: string; resetRequired?: boolean; total: number; history: Record<string, { enabled: boolean; coverage?: string; notes: string[]; error?: string }> }> {
    const out: DirectoryEntry[] = [];
    const nativeSeen = new Set<string>();
    // 请求内快照：避免每个 binding 重新解析整份 profile / approval 表。
    const profiles = this.store.profiles();
    const pendingBySession = new Map<string, number>();
    for (const a of this.store.allApprovals()) if (a.state === "pending") pendingBySession.set(a.platformSessionId, (pendingBySession.get(a.platformSessionId) ?? 0) + 1);
    for (const b of this.store.allBindings()) {
      if (b.nativeSessionId) nativeSeen.add(`${b.runtimeKind}:${b.nativeSessionId}`);
      if (b.archived ? q.archived !== "include" && q.archived !== "only" : q.archived === "only") continue;
      // 创建时约定了未来发送、首轮还没开始：会话不进入会话列表，只能从时钟打开的预约弹窗进入；
      // 预约被撤销后仍按 scheduledCreate 保持隐藏，直到真正发出第一轮（turns 出现）才回到列表。
      // 旧数据没有 scheduledCreate 标记，用队首预约消息兜底。
      if (!b.archived && !b.turns.length && (b.scheduledCreate || b.outbox?.[0]?.scheduledFor)) continue;
      const latest = b.turns[b.turns.length - 1];
      const lastEnded = [...b.turns].reverse().find((t) => !!t.endedAt);
      const scheduledNext = b.archived ? undefined : (b.outbox ?? []).map(m => m.scheduledFor).filter((t): t is string => !!t && Number.isFinite(Date.parse(t))).sort((a, c) => Date.parse(a) - Date.parse(c))[0];
      // 群聊列表按所选目录分组、搜索；成员的执行 workspace 可能是独立 worktree。
      const workspace = (b.roomRef ? roomWorkspaces?.get(b.roomRef.roomId) : undefined) ?? sessionDisplayWorkspace(b);
      out.push({
        id: b.platformSessionId, runtimeKind: b.runtimeKind, sourceMode: b.sourceMode, executionMode: b.executionMode, title: b.title,
        workspace, ...(b.worktree ? { worktreeBranch: b.worktree.branch } : {}), ...(b.effectiveModel ?? b.requestedModel ? { model: (b.effectiveModel ?? b.requestedModel)! } : {}),
        status: b.status, ...(b.statusReason ? { statusReason: b.statusReason } : {}), lastActivityAt: b.lastActivityAt.at,
        ...(b.createdAt?.at ? { createdAt: b.createdAt.at } : {}), ...(b.archivedAt ? { archivedAt: b.archivedAt } : {}),
        ...(b.nativeSessionId ? { nativeSessionId: b.nativeSessionId } : {}),
        identityScopeId: b.identityScopeId, accountKnown: profiles[b.runtimeProfileId]?.identity?.accountKnown ?? false,
        ...(b.quickAction && this.quickActionCurrent(b) ? { quickAction: b.quickAction } : {}),
        ...(scheduledNext ? { scheduledNext } : {}),
        href: `#/rt/${b.platformSessionId}`, ...(b.conflict ? { conflict: true } : {}),
        ...(b.noteRef ? { noteRef: b.noteRef } : {}),
        ...(b.recommendationRef ? { recommendationRef: { taskId: b.recommendationRef.taskId, revision: b.recommendationRef.revision, title: b.recommendationRef.title, sourceCount: b.recommendationRef.sources.length } } : {}),
        pendingApprovals: pendingBySession.get(b.platformSessionId) ?? 0,
        ...(lastEnded?.endedAt ? { lastTurnEndedAt: lastEnded.endedAt } : {}),
        ...(latest ? { latestTurn: { turnNo: latest.turnNo, status: latest.status, ...(latest.status === "queued" && this.store.operation(latest.operationId)?.createdAt ? { queuedAt: this.store.operation(latest.operationId)!.createdAt } : {}), ...(latest.startedAt ? { startedAt: latest.startedAt } : {}), ...(latest.endedAt ? { endedAt: latest.endedAt } : {}) } } : {}),
        purpose: sessionPurpose(b), ...(b.projectRef ? { projectRef: b.projectRef } : {}), ...(b.comparisonRef ? { comparisonRef: b.comparisonRef } : {}), ...(b.roomRef ? { roomRef: b.roomRef } : {}), ...(b.archived ? { archived: true } : {})
      });
    }
    const history: Record<string, { enabled: boolean; coverage?: string; notes: string[]; error?: string }> = {};
    if (q.includeHistory !== false && q.source !== "chat" && q.archived !== "only") {
      const s = this.settings();
      for (const kind of RUNTIME_KINDS) {
        const h = s.history[kind];
        if (!h.enabled || !h.roots.length) { history[kind] = { enabled: false, notes: [] }; continue; }
        try {
          const list = await this.historyList(kind, h.roots, h.originators ?? []);
          history[kind] = { enabled: true, coverage: list.coverage, notes: list.notes };
          for (const item of list.items) {
            // 同一原生会话从流和历史读到：合并为受管那一项（V28-11）
            if (nativeSeen.has(`${kind}:${item.nativeSessionId}`)) continue;
            const id = `rx-${createHash("sha256").update(`${kind}|${this.store.host.hostId}|${item.nativeSessionId}`).digest("hex").slice(0, 16)}`;
            this.discovered.set(id, { kind, item });
            out.push({
              id, runtimeKind: kind, sourceMode: "external-discovered", executionMode: "read-only", title: item.title,
              ...(item.workspace ? { workspace: item.workspace } : {}), ...(item.model ? { model: item.model } : {}),
              status: item.status, ...(item.updatedAt ? { lastActivityAt: item.updatedAt } : {}), nativeSessionId: item.nativeSessionId,
              identityScopeId: this.historyScope(kind), accountKnown: false, href: `#/rt/${id}`
            });
          }
        } catch (e) {
          history[kind] = { enabled: true, notes: [], error: bounded((e as Error).message, 300).text };
        }
      }
    }
    if (q.source !== "chat" && q.archived !== "only") out.push(...extra);
    let list = out;
    if (q.source === "chat") list = list.filter((e) => e.purpose === "chat" || e.purpose === "compare" || e.purpose === "room");
    else if (q.source === "managed") list = list.filter((e) => e.sourceMode === "platform-managed");
    else if (q.source === "readonly") list = list.filter((e) => e.sourceMode === "external-discovered");
    else if (q.source === "pi") list = list.filter((e) => e.runtimeKind === "pi");
    if (q.runtime) list = list.filter((e) => e.runtimeKind === q.runtime);
    if (q.status) list = list.filter((e) => e.status === q.status || (q.status === "active" && ACTIVE.includes(e.status as SessionStatus)));
    if (q.q) { const needle = q.q.toLowerCase(); list = list.filter((e) => `${e.title} ${e.workspace ?? ""} ${e.nativeSessionId ?? ""}`.toLowerCase().includes(needle)); }
    // 轮次开始和结束都更新排序；流式事件不改变顺序。无轮次时间的历史退回活动时间。
    const orderAt = (e: DirectoryEntry): string => [e.lastTurnEndedAt, e.latestTurn?.startedAt, e.latestTurn?.endedAt]
      .filter((at): at is string => !!at && Number.isFinite(Date.parse(at)))
      .sort().at(-1) ?? e.lastActivityAt ?? "";
    list.sort((a, b) => orderAt(b).localeCompare(orderAt(a)));
    const limit = Math.min(200, Math.max(1, q.limit ?? 50));
    // Archive cursors are bound to the filtered, ordered summary snapshot. A restore,
    // archive or metadata update invalidates the chain instead of skipping/duplicating rows.
    const stamp = q.archived === "only" ? createHash("sha256").update(JSON.stringify([q.source, q.runtime, q.status, q.q, limit, list])).digest("hex") : undefined;
    let offset = 0;
    if (q.cursor) {
      const decoded = Buffer.from(q.cursor, "base64url").toString();
      if (stamp) {
        let cursor: { offset?: number; stamp?: string } = {};
        try { cursor = JSON.parse(decoded); } catch { /* stale legacy cursor */ }
        if (!cursor || cursor.stamp !== stamp || !Number.isSafeInteger(cursor.offset) || cursor.offset! < 0) return { entries: [], total: list.length, history, resetRequired: true };
        offset = cursor.offset!;
      } else offset = Math.max(0, Number(decoded) || 0);
    }
    const page = list.slice(offset, offset + limit);
    const next = offset + limit;
    return { entries: page, total: list.length, ...(next < list.length ? { nextCursor: Buffer.from(stamp ? JSON.stringify({ offset: next, stamp }) : String(next)).toString("base64url") } : {}), history };
  }

  private async historyList(kind: RuntimeKind, roots: string[], originators: string[]): Promise<{ items: HistoryItem[]; coverage: string; notes: string[] }> {
    const rootsKey = `${roots.join("|")}#${originators.join("|")}`;
    const hit = this.historyCache.get(kind);
    if (hit && hit.rootsKey === rootsKey && Date.now() - hit.at < this.historyCacheMs) return hit;
    const r = await this.driver(kind).listHistory({ roots, limit: 1000, ...(originators.length ? { originators } : {}) });
    const v = { at: Date.now(), rootsKey, items: r.items, coverage: r.coverage, notes: r.notes };
    this.historyCache.set(kind, v);
    return v;
  }

  /**
   * 用量汇总（P1）：受管会话里带请求时间的单请求用量按日归属；只有会话累计值的来源（Codex）不分日，单列合计。
   */
  usageSummary(opts: { days: number; timeZone: string }): {
    timeZone: string; days: Array<{ day: string; byRuntime: Record<string, { input: number; output: number; requests: number }> }>;
    unattributed: Array<{ runtimeKind: RuntimeKind; sessions: number; total: number; input: number; output: number }>;
    notes: string[];
  } {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: opts.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    const since = Date.now() - opts.days * 86_400_000;
    const days = new Map<string, Record<string, { input: number; output: number; requests: number }>>();
    const un = new Map<RuntimeKind, { runtimeKind: RuntimeKind; sessions: number; total: number; input: number; output: number }>();
    const allUsage = this.store.allUsage();
    for (const b of this.store.allBindings()) {
      const recs = allUsage[b.platformSessionId] ?? [];
      const d = dailyUsage(recs, opts.timeZone);
      const seen = new Set<string>();
      for (const r of recs) {
        if (r.subagent || r.counterMode !== "delta" || !r.requestId || seen.has(r.requestId)) continue;
        seen.add(r.requestId);
        const at = usageTime(r);
        if (at === undefined || at < since) continue;
        const day = fmt.format(new Date(at));
        const row = days.get(day) ?? {};
        const cur = row[b.runtimeKind] ?? { input: 0, output: 0, requests: 0 };
        cur.input += (r.input ?? 0) + (r.cachedInput ?? 0) + (r.cacheCreation ?? 0); cur.output += r.output ?? 0; cur.requests += usageCalls(r);
        row[b.runtimeKind] = cur; days.set(day, row);
      }
      if (d.unattributed && !d.days.length && Date.parse(b.lastActivityAt.at) >= since) {
        const s = summarizeUsage(recs);
        if (s.coverage !== "unknown") {
          const u = un.get(b.runtimeKind) ?? { runtimeKind: b.runtimeKind, sessions: 0, total: 0, input: 0, output: 0 };
          u.sessions++; u.total += s.totals.total ?? (s.totals.input ?? 0) + (s.totals.output ?? 0); u.input += s.totals.input ?? 0; u.output += s.totals.output ?? 0;
          un.set(b.runtimeKind, u);
        }
      }
    }
    return {
      timeZone: opts.timeZone,
      days: [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, byRuntime]) => ({ day, byRuntime })),
      unattributed: [...un.values()],
      notes: ["只统计平台受管会话；只读历史不计入", "Claude / Pi 按每次请求时间或归档小时桶归入日期（输入含缓存读写）", "Codex 只提供会话累计值、没有每次请求的时间：不分到日期，按最后活动在范围内的会话单列合计", "这是 runtime 报告的 token 用量，不是账单，也不反推订阅额度"]
    };
  }

  archive(platformSessionId: string, archived: boolean, actor: string, options: { roomControl?: boolean } = {}): Promise<SessionBinding> {
    const b = this.managed(platformSessionId);
    if (b.roomRef && !options.roomControl) throw new RuntimeError("请在群聊中归档或恢复", 409, "ROOM_OWNED");
    const pending = this.worktreeCleanups.get(platformSessionId);
    if (pending) {
      if (archived) return pending;
      throw new RuntimeError("worktree 正在清理，请稍后恢复", 409, "RT_BUSY");
    }
    if (archived && (this.running.has(b.platformSessionId) || b.turns.some((t) => ["queued", "running", "waiting-input"].includes(t.status)))) throw new RuntimeError("运行中的会话不能归档", 409, "RT_BUSY");
    const out = this.store.updateBinding(platformSessionId, (x) => {
      x.archived = archived;
      // 今天归档 / 恢复：记下归档时刻，恢复时清掉，给待办页的当日会话统计用。
      if (archived) x.archivedAt = new Date().toISOString(); else delete x.archivedAt;
      if (archived) { delete x.quickAction; delete x.quickReplies; delete x.quotaResume; delete x.quotaResumeStreak; x.outbox = x.outbox?.filter(m => !m.scheduledFor); if (!x.outbox?.length) { delete x.outbox; delete x.outboxPaused; } } });
    if (archived) { this.clearQuotaTimer(platformSessionId); this.clearReservationTimer(platformSessionId); this.syncQueuedTitle(platformSessionId); }
    // 归档后不再有新的用量：逐次明细压缩成每小时 × 模型合计。失败只影响文件大小，不影响归档。
    if (archived) { try { this.store.compactArchivedUsage([platformSessionId]); } catch (e) { console.error("用量压缩失败：", e); } }
    this.store.audit({ type: archived ? "archive" : "unarchive", platformSessionId, actor });
    this.emit("directory", { archiveChanged: true });
    // 归档后通知宿主（例如把从这条待办发起的会话对应的待办标记完成）；noteId 由会话绑定携带。
    if (archived) this.emit("archived", { platformSessionId, ...(out.noteRef ? { noteId: out.noteRef.noteId } : {}) });
    // 先归档阻止续聊；请求等待清理结束，失败返回调用方，可再次归档重试。
    const wt = b.worktree;
    if (archived && wt && !wt.removedAt) {
      const cleanup = removeSessionWorktree(wt.repoRoot, wt.path, wt.branch).then(() => {
        const cleaned = this.store.updateBinding(platformSessionId, (x) => { if (x.worktree) x.worktree.removedAt = new Date().toISOString(); });
        this.store.audit({ type: "session-worktree-removed", platformSessionId, branch: wt.branch, actor });
        this.emit("directory", {});
        return cleaned;
      }).finally(() => { this.worktreeCleanups.delete(platformSessionId); });
      this.worktreeCleanups.set(platformSessionId, cleanup);
      return cleanup;
    }
    return Promise.resolve(out);
  }

  /**
   * 自动重新部署配额：每个会话连续最多自动触发 3 次（部署成功后清零）。先占位再登记部署；部署没有登记成功时由调用方 release。
   * 手动点击「重新部署」不经过这里，因此不受上限影响。
   */
  claimAutoRedeploy(platformSessionId: string): { allowed: boolean; count: number; limit: number } {
    const limit = AUTO_REDEPLOY_LIMIT;
    let out = { allowed: false, count: limit, limit };
    this.store.updateBinding(platformSessionId, (x) => {
      const count = x.autoRedeployCount ?? 0;
      if (count >= limit) { out = { allowed: false, count, limit }; return; }
      x.autoRedeployCount = count + 1;
      out = { allowed: true, count: count + 1, limit };
    }, undefined, { bump: false });
    return out;
  }

  /** 部署成功后清零自动重新部署计数（不改 bindingRevision）。 */
  resetAutoRedeploy(platformSessionId: string): void {
    if (!this.store.binding(platformSessionId)?.autoRedeployCount) return;
    this.store.updateBinding(platformSessionId, (x) => { delete x.autoRedeployCount; }, undefined, { bump: false });
  }

  /** 自动部署登记失败（冲突、重复、服务拒绝等）时退回刚占用的配额。 */
  releaseAutoRedeploy(platformSessionId: string): void {
    this.store.updateBinding(platformSessionId, (x) => {
      const count = x.autoRedeployCount ?? 0;
      if (count <= 1) delete x.autoRedeployCount;
      else x.autoRedeployCount = count - 1;
    }, undefined, { bump: false });
  }

  /** 会话页「提交并在空闲时部署」：记审计；会话 worktree 的提交与 main 的快进由 Web 服务的部署队列完成 */
  noteDeployRequest(platformSessionId: string, actor: string, r: { request: { id: string; sha: string }; committed?: string; rebased?: boolean }, auto = false): void {
    this.store.audit({ type: "deploy-request", platformSessionId, actor, requestId: r.request.id, sha: r.request.sha, ...(auto ? { auto: true } : {}), ...(r.committed ? { committed: r.committed } : {}), ...(r.rebased ? { rebased: true } : {}) });
    // 部署已登记：排队 / 等待 / 部署中期间列表的下一步是看部署结果，旧的推荐操作标签不再展示。
    // 部署结束会发回结果通知并重新生成快捷回复，到时的推荐操作再写入。
    if (this.store.binding(platformSessionId)?.quickAction) {
      this.store.updateBinding(platformSessionId, (x) => { delete x.quickAction; }, undefined, { bump: false });
      this.emit("directory", {});
    }
  }

  /** 平台删除：只删平台数据，不删除原生 transcript（V28-18） */
  deletePlatformData(platformSessionId: string, actor: string, options: { roomControl?: boolean } = {}): void {
    const b = this.managed(platformSessionId);
    if (this.worktreeCleanups.has(platformSessionId)) throw new RuntimeError("worktree 正在清理，请稍后删除记录", 409, "RT_BUSY");
    if (b.roomRef && !options.roomControl) throw new RuntimeError("请在群聊中删除成员平台记录", 409, "ROOM_OWNED");
    if (this.running.has(b.platformSessionId)) throw new RuntimeError("运行中的会话不能删除", 409, "RT_BUSY");
    this.store.deleteBinding(platformSessionId);
    this.attachments.removeSession(platformSessionId);
    // 对比组里的通道：一并删掉它的 worktree（其余通道不受影响）
    const g = b.comparisonRef ? this.store.comparison(b.comparisonRef.groupId) : undefined;
    const lane = g?.lanes.find((l) => l.laneNo === b.comparisonRef?.laneNo);
    if (g?.worktree && !g.worktree.cleanedAt && lane?.worktree) void removeWorktree(g.worktree.repoRoot, lane.worktree.path).catch((e) => console.error("删除通道 worktree 失败：", e));
    this.store.audit({ type: "delete-platform-data", platformSessionId, nativeSessionId: b.nativeSessionId ?? null, actor });
    this.emit("directory", {});
  }

  /* ============================ 部署排空与重启核对 ============================ */

  activity(): { draining: boolean; active: Array<{ platformSessionId: string; title: string; status: string; workspace: string; turnNo?: number }>; pendingApprovals: number; queued: number; dispatching: number; unknownOps: number } {
    // 还有排队消息要自动发送的会话也算在忙：空闲时部署不应卡在两条排队消息之间
    const active = this.store.allBindings().filter((b) => ACTIVE.includes(b.status) || this.running.has(b.platformSessionId) || (b.outbox?.some(m => !m.scheduledFor || Date.parse(m.scheduledFor) <= Date.now()) && !b.outboxPaused && !b.archived && !b.conflict))
      .map((b) => ({ platformSessionId: b.platformSessionId, title: b.title, status: b.status, workspace: b.workspace, ...(this.running.get(b.platformSessionId) ? { turnNo: this.running.get(b.platformSessionId)!.turnNo } : {}) }));
    const ops = this.store.allOperations();
    const uncertain = new Set(ops.filter(o => o.state === "unknown").map(o => o.operationId));
    const runningIds = new Set([...this.running.values()].map(r => r.operationId));
    const released = new Set<string>();
    for (const scope of new Set(this.store.allBindings().map(b => b.identityScopeId))) {
      try {
        const ledger = this.sharedSlots.inspect(scope);
        if (ledger && "status" in ledger) uncertain.add(`scope-unavailable:${scope}`);
        else for (const reservation of ledger?.reservations ?? []) {
          if (reservation.status === "released") released.add(reservation.operationId);
          else if (reservation.status === "unknown" || reservation.status === "reserved" && (reservation.ownerId !== this.slotOwner || !runningIds.has(reservation.operationId))) uncertain.add(reservation.operationId);
        }
      } catch { uncertain.add(`scope-unavailable:${scope}`); }
    }
    // 结果未知的操作，名额已凭终态依据释放（进程退出、未执行或人工核实）：不再算部署要等的未知项；操作记录本身仍是未知
    for (const id of released) if (!runningIds.has(id)) uncertain.delete(id);
    return {
      draining: this.draining, active, pendingApprovals: this.pendingApprovals().length,
      queued: ops.filter((o) => (o.state === "queued" || o.state === "prepared") && this.pendingPrompts.has(o.operationId)).length,
      dispatching: ops.filter((o) => o.state === "dispatching").length,
      unknownOps: uncertain.size
    };
  }

  /** 强制部署：列出并中断受影响的会话，持久化审计与状态，失效审批 */
  async forceStop(reason: string, actor: string): Promise<{ affected: string[] }> {
    const affected: string[] = [];
    for (const [pid, run] of [...this.running]) {
      affected.push(pid);
      this.sharedSlots.markUnknown(this.store.binding(pid)!.identityScopeId, run.operationId, "Forced stop requested; native termination unconfirmed");
      run.stopRequested = false;
      void run.handle?.interrupt().catch(() => {});
      this.running.delete(pid);
      this.finishTurn(pid, run.turnNo, { status: "unknown", reason: `${reason}：停止请求已发送，原生终态等待核对` }, false);
      this.store.stepOperation(run.operationId, "force-stopped", reason, "unknown");
    }
    for (const o of this.store.allOperations()) {
      if ((o.state === "queued" || o.state === "prepared") && this.pendingPrompts.has(o.operationId)) {
        this.pendingPrompts.delete(o.operationId);
        this.store.stepOperation(o.operationId, "cancelled", reason, "failed", `${reason}：排队中的请求未发出（未执行）`);
        const binding = this.store.binding(o.platformSessionId); if (binding) this.retireQueue(o, binding);
        if (o.turnNo) this.finishTurn(o.platformSessionId, o.turnNo, { status: "cancelled", reason }, true);
        affected.push(o.platformSessionId);
      }
    }
    for (const a of this.pendingApprovals()) this.settleApproval(a.approvalId, "invalidated", { approve: false, reason });
    this.store.audit({ type: "force-stop", reason, actor, affected });
    return { affected: [...new Set(affected)] };
  }

  /** Reconcile host-owned uncertain effects against the exact authenticated native source; never replay. */
  reconcileSharedReservations(): Promise<void> {
    if (this.sharedReconciliation) return this.sharedReconciliation;
    this.sharedReconciliation = this.scanSharedReservations().finally(() => { this.sharedReconciliation = undefined; });
    return this.sharedReconciliation;
  }

  private matchesNativeTerminal(b: SessionBinding, turn: TurnRecord, fp: NativeFingerprint | undefined, delivered: boolean | undefined): boolean {
    if (delivered !== true || fp?.active !== false || fp.terminalObserved !== true || !["completed", "failed", "interrupted"].includes(fp.lastTurnStatus ?? "")) return false;
    return b.runtimeKind === "codex" ? !!turn.nativeTurnId && fp.lastTurnId === turn.nativeTurnId : b.runtimeKind === "pi" && fp.lastClientMessageId === turn.clientMessageId;
  }

  private async scanSharedReservations(): Promise<void> {
    const profiles = new Map<RuntimeKind, RuntimeProfile>();
    for (const scope of new Set(this.store.allBindings().map(b => b.identityScopeId))) {
      let ledger: ReturnType<SharedSlots["inspect"]>;
      try { ledger = this.sharedSlots.inspect(scope); }
      catch (error) { console.error(`Shared account reconciliation held (${scope}):`, error); continue; }
      if (!ledger || "status" in ledger) continue;
      for (const reservation of ledger.reservations.filter(r => r.status !== "released")) {
        const op = this.store.operation(reservation.operationId), b = op && this.store.binding(op.platformSessionId);
        const turn = b?.turns.find(t => t.operationId === op?.operationId && t.turnNo === op?.turnNo);
        if (!op || !b || !turn || this.running.has(b.platformSessionId) || b.identityScopeId !== scope || reservation.projectId !== (b.projectRef ?? b.platformSessionId) || !op.steps.some(s => s.step === "shared-slot-reserved" && s.detail === scope)) continue;
        try {
          this.sharedSlots.markUnknown(scope, op.operationId, "Awaiting exact authenticated native terminal observation");
          if (!b.nativeSessionId) continue;
          let profile = profiles.get(b.runtimeKind);
          if (!profile) { profile = await this.probe(b.runtimeKind); profiles.set(b.runtimeKind, profile); }
          if (profile.state !== "executable" || profile.identity?.identityScopeId !== scope) continue;
          const driver = this.driver(b.runtimeKind);
          const delivered = await driver.findClientMessage(b.nativeSessionId, turn.clientMessageId, { workspace: b.workspace });
          const fp = await driver.fingerprint(b.nativeSessionId, { workspace: b.workspace, ...(b.nativeFingerprint ? { previous: b.nativeFingerprint.value } : {}) });
          if (!this.matchesNativeTerminal(b, turn, fp, delivered)) continue;
          const status = fp!.lastTurnStatus as "completed" | "failed" | "interrupted";
          const reason = `原生记录已核对原操作终态：${status}`;
          this.store.stepOperation(op.operationId, "shared-slot-reconciled", JSON.stringify({ nativeSessionId: b.nativeSessionId, nativeTurnId: turn.nativeTurnId ?? null, clientMessageId: turn.clientMessageId, identityScopeId: scope, fingerprint: fp!.value, status }), "confirmed", reason);
          this.observeSlot(op, b, "completed");
          this.store.updateBinding(b.platformSessionId, x => {
            const t = x.turns.find(t => t.operationId === op.operationId)!;t.status = status;t.statusReason = reason;t.endedAt = new Date().toISOString();
            if (x.turns.at(-1)?.operationId === op.operationId) { x.status = status === "interrupted" ? "interrupted" : "idle";x.statusReason = reason; }
            if (!x.conflict) x.nativeFingerprint = { value: fp!.value, checkedAt: new Date().toISOString() };
          });
          this.store.upsertEvent(b.platformSessionId, { key: turn.nativeTurnId ? `turn:${turn.nativeTurnId}` : `platform:turn-end:${turn.turnNo}`, kind: "turn-status", status, text: reason, turnNo: turn.turnNo, source: "history", parserVersion: PROJECTION_VERSION, availability: "recorded", recordedAt: new Date().toISOString() });
          this.emit("session", { platformSessionId: b.platformSessionId });
        } catch (error) { console.error(`Shared native reconciliation held (${op.operationId}):`, error); }
      }
    }
    this.flushSlotFacts();
    this.schedule();
  }

  /**
   * 方案 A 的重启核对：runtime 进程随旧 Web 进程结束。
   * - 未发出的请求标为未执行（不自动重发）
   * - dispatching 的按原生记录核对首轮是否送达；无法判断标 unknown
   * - 受共享名额管理的 turn 无精确终态 → unknown并保留占用；审批全部失效
   * - 从原生记录补读事件
   */
  async recover(): Promise<void> {
    const reason = "平台服务重启：runtime 进程随服务结束";
    for (const a of this.store.allApprovals()) {
      if (a.state === "pending") { a.state = "invalidated"; a.decidedAt = new Date().toISOString(); this.store.putApproval(a); }
    }
    // 旧记录里额度 / 限流被当成普通失败、会话又回到空闲；升级后按同一口径改成被中断，列表与详情直接显示中断标签。
    for (const b of this.store.allBindings()) {
      if (b.status !== "idle" || !b.nativeSessionId) continue;
      const last = b.turns.at(-1);
      if (last?.status !== "failed" || !last.statusReason || !QUOTA_FAILURE.test(last.statusReason)) continue;
      this.store.updateBinding(b.platformSessionId, (x) => {
        const t = x.turns.at(-1)!;
        t.status = "interrupted";
        t.quotaFailure = true;
        x.status = "interrupted";
        x.statusReason = `本轮被中断：${t.statusReason ?? "额度 / 限流"}`;
      });
    }
    const touched = new Set<string>();
    for (const op of this.store.allOperations()) {
      if (op.state === "prepared" || op.state === "queued") {
        if (op.imageInput && this.store.binding(op.platformSessionId)) {
          try {
            const i = op.imageInput;
            this.attachments.restoreReferences(i.attachmentIds, i.owner, op.platformSessionId);
            const turn = this.store.binding(op.platformSessionId)!.turns.find(t => t.operationId === op.operationId);
            if (!turn) throw new Error("图片消息轮次记录缺失");
            const attachments = this.attachments.resolve(i.attachmentIds, i.owner, op.platformSessionId);
            this.store.upsertEvent(op.platformSessionId, { key: `user:${turn.clientMessageId}`, kind: "message", role: "user", text: bounded(i.prompt, LIMITS.message).text, attachments, source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", recordedAt: op.createdAt, occurredAt: op.createdAt, turnNo: turn.turnNo });
            this.pendingPrompts.set(op.operationId, { prompt: i.prompt, attachmentIds: i.attachmentIds, model: i.model, effort: i.effort, presetSessionId: op.presetNativeId });
            continue;
          } catch (e) { this.store.audit({ type: "image-recovery-failed", operationId: op.operationId, reason: String(e) }); }
        }
        this.store.stepOperation(op.operationId, "restart", `${reason}；请求尚未发出，未执行，不自动重发`, "failed", "服务重启前未发出（未执行）");
        const b = this.store.binding(op.platformSessionId);
        if (b) {
          this.retireQueue(op, b);
          this.store.updateBinding(b.platformSessionId, (x) => {
            const t = x.turns.find((y) => y.turnNo === op.turnNo);
            if (t) { t.status = "cancelled"; t.statusReason = "服务重启前未发出，未执行"; t.endedAt = new Date().toISOString(); }
            x.status = x.nativeSessionId ? "idle" : "failed";
            x.statusReason = x.nativeSessionId ? "服务重启：排队中的一轮未发出，可重新发送" : "服务重启：创建请求未发出";
          });
        }
        continue;
      }
      if (op.state === "dispatching") touched.add(op.platformSessionId);
    }
    for (const b of this.store.allBindings()) {
      if (!this.store.allOperations().some(o => o.platformSessionId === b.platformSessionId && this.pendingPrompts.has(o.operationId)) && (ACTIVE.includes(b.status) || b.turns.some((t) => t.status === "running" || t.status === "waiting-input"))) touched.add(b.platformSessionId);
    }
    for (const pid of touched) {
      try { await this.reconcile(pid, reason); }
      catch (e) {
        this.store.updateBinding(pid, (x) => { x.status = "unknown"; x.observation = "stale"; x.statusReason = `重启后核对失败：${bounded((e as Error).message, 200).text}`; });
      }
    }
    await this.reconcileSharedReservations();
    this.schedule();
    this.resumeOutboxesAfterRestart();
    await this.rearmQuotaResumes();
  }

  /** 部署排空解除（部署取消/失败）后，把因排空压住的首条消息接着发出去。 */
  private resumeHeldOutboxes(): void {
    for (const b of this.store.allBindings()) {
      if (!b.outbox?.length || !b.outboxPaused?.auto) continue;
      const last = b.turns.at(-1);
      if (b.status !== "idle" || (last && last.status !== "completed")) continue;
      this.store.updateBinding(b.platformSessionId, x => { if (x.outboxPaused?.auto) delete x.outboxPaused; }, undefined, { bump: false });
      void this.drainOutbox(b.platformSessionId);
    }
  }

  /**
   * 重启后的排队消息：上一轮已结束（正常 / 被人停止 / 失败）、会话空闲且队列没被人暂停（或只是因部署排空暂停）时接着发；
   * 其他情况（上一轮被重启打断、结果未知）暂停，等人确认。
   */
  private resumeOutboxesAfterRestart(): void {
    for (const b of this.store.allBindings()) {
      // 插话状态只对上一个进程里的那一轮有效
      if (b.outbox?.some(m => m.steering)) this.store.updateBinding(b.platformSessionId, x => { for (const m of x.outbox ?? []) delete m.steering; }, undefined, { bump: false });
      this.armReservation(b.platformSessionId);
      if (!b.outbox?.length || (b.outboxPaused && !b.outboxPaused.auto)) continue;
      const last = b.turns.at(-1);
      // 上一轮是人停止 / 失败后才排的消息（典型是预约）没有被这次重启打断；停止 / 失败当时若有排队消息，暂停已持久化（非自动），上面已跳过
      if (b.status === "idle" && (!last || ["completed", "cancelled", "failed"].includes(last.status))) {
        if (b.outboxPaused) this.store.updateBinding(b.platformSessionId, x => { delete x.outboxPaused; }, undefined, { bump: false });
        void this.drainOutbox(b.platformSessionId);
      } else if (!ACTIVE.includes(b.status)) this.pauseOutbox(b.platformSessionId, "服务重启时上一轮没有正常结束", true);
    }
  }

  private async reconcile(pid: string, reason: string): Promise<void> {
    const b = this.store.binding(pid)!;
    const driver = this.driver(b.runtimeKind);
    const op = this.store.operation(b.turns[b.turns.length - 1]?.operationId ?? "");
    const turn = b.turns[b.turns.length - 1];
    // Claude 预分配 ID：从操作记录里取回
    const preset = op?.presetNativeId ?? this.store.operation(b.creationOperationId)?.presetNativeId;
    const nativeId = b.nativeSessionId ?? (b.runtimeKind !== "codex" && b.runtimeKind !== "antigravity" ? preset : undefined);
    if (!nativeId) {
      if (op?.state === "dispatching") this.store.stepOperation(op.operationId, "restart", `${reason}；没有收到原生 ID，无法确认是否已在 runtime 创建（不自动重发）`, "unknown", "结果未知");
      this.store.updateBinding(pid, (x) => {
        if (turn && (turn.status === "running" || turn.status === "waiting-input" || turn.status === "queued")) { const t = x.turns.find((y) => y.turnNo === turn.turnNo)!; t.status = "unknown"; t.statusReason = "服务重启时还没有原生 ID"; }
        x.status = "unknown"; x.statusReason = "服务重启：原生会话是否已创建无法确认；不会自动重发首条消息"; x.observation = "partial";
      });
      return;
    }
    const delivered = turn ? await driver.findClientMessage(nativeId, turn.clientMessageId, { workspace: b.workspace }).catch(() => undefined) : undefined;
    if (!b.nativeSessionId && delivered) this.bindNative(pid, nativeId, { modelSource: "重启核对" });
    if (!b.nativeSessionId && delivered === false) {
      if (op) this.store.stepOperation(op.operationId, "restart", `${reason}；已核对原生记录：首条消息未送达，未执行`, "failed", "未送达（已核对）");
      this.store.updateBinding(pid, (x) => {
        const t = x.turns.find((y) => y.turnNo === turn?.turnNo); if (t) { t.status = "failed"; t.statusReason = "未送达（已核对原生记录）"; t.endedAt = new Date().toISOString(); }
        x.status = "failed"; x.statusReason = "服务重启：已核对，原生会话未创建";
      });
      return;
    }
    const previous = b.nativeFingerprint?.value;
    const fp = await driver.fingerprint(nativeId, { workspace: b.workspace, ...(previous ? { previous } : {}) }).catch(() => undefined);
    let status: TurnRecord["status"] = op?.steps.some(s => s.step === "shared-slot-reserved") ? "unknown" : "interrupted";
    let why = `${reason}，本轮没有结束记录`;
    if (turn && this.matchesNativeTerminal(b, turn, fp, delivered) && !op?.steps.some(s => s.step === "shared-slot-reserved")) {
      const s = fp!.lastTurnStatus;
      if (s === "completed" || s === "failed" || s === "interrupted") { status = s === "completed" ? "completed" : s === "failed" ? "failed" : "interrupted"; why = `重启后核对原生 turn 状态：${s}`; }
    }
    if (delivered === undefined) { status = "unknown"; why = `${reason}；无法核对本轮是否送达`; }
    if (op && (op.state === "dispatching")) this.store.stepOperation(op.operationId, "restart", why, delivered ? "confirmed" : "unknown");
    if (turn && (turn.status === "running" || turn.status === "waiting-input" || turn.status === "queued")) {
      this.store.updateBinding(pid, (x) => {
        const t = x.turns.find((y) => y.turnNo === turn.turnNo)!;
        t.status = status; t.statusReason = why; t.endedAt = new Date().toISOString();
        x.status = status === "completed" || status === "failed" ? "idle" : status === "unknown" ? "unknown" : "interrupted";
        x.statusReason = status === "interrupted" ? "服务重启中断了本轮：可显式续聊（沿原 ID 新建一轮，不重放原 turn）" : why;
      });
      this.store.upsertEvent(pid, { key: turn.nativeTurnId ? `turn:${turn.nativeTurnId}` : `platform:turn-end:${turn.turnNo}`, kind: "turn-status", status, text: why, turnNo: turn.turnNo, source: "platform", parserVersion: PROJECTION_VERSION, availability: "recorded", recordedAt: new Date().toISOString() });
    }
    else if (ACTIVE.includes(this.store.binding(pid)!.status)) {
      // 没有进行中的一轮却停在运行中（迟到的状态信号留下的）：按最后一轮的结果改回
      this.store.updateBinding(pid, (x) => { x.status = x.nativeSessionId ? "idle" : "unknown"; x.statusReason = `重启核对：没有进行中的一轮（最后一轮${turn ? `：${turn.status}` : "不存在"}）`; });
    }
    await this.backfill(pid).catch(() => {});
    // 回补后重新取指纹：回补本身不算外部写入
    const fp2 = await driver.fingerprint(nativeId, { workspace: b.workspace, ...(previous ? { previous } : {}) }).catch(() => undefined) ?? fp;
    if (fp2 && !this.store.binding(pid)?.conflict) this.store.updateBinding(pid, (x) => { x.nativeFingerprint = { value: fp2.value, checkedAt: new Date().toISOString() }; }, undefined, { bump: false });
    this.store.audit({ type: "recovered", platformSessionId: pid, turnStatus: status });
  }

  /** Let native cleanup persist its exit evidence before the web process exits. A deadline never releases capacity. */
  async shutdownAndWait(timeoutMs = 30_000): Promise<void> {
    this.shutdown();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.dispatches]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.flushSlotFacts();
      this.store.flushBindings();
    }
  }

  shutdown(): void {
    this.emit("shutdown");
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const timer of this.reservationTimers.values()) clearTimeout(timer);
    this.reservationTimers.clear();
    this.titleWorker?.stop();
    this.draining = true;
    this.finishQueuedOnDrain = false;
    try { this.schedule(); } catch (error) { console.error("Runtime shutdown scheduling held:", error); }
    if (this.slotTimer) clearInterval(this.slotTimer);
    if (this.binaryWatchTimer) { clearInterval(this.binaryWatchTimer); this.binaryWatchTimer = undefined; }
    if (this.stallTimer) { clearInterval(this.stallTimer); this.stallTimer = undefined; }
    this.stalls.clear();
    for (const timer of this.continuationTimers.values()) clearTimeout(timer);
    this.continuationTimers.clear();
    this.continuationFinalizers.clear();
    for (const [pid, run] of this.running) {
      void run.closeBrowser?.();
      try { this.sharedSlots.markUnknown(this.store.binding(pid)!.identityScopeId, run.operationId, "Host shutdown; native termination unconfirmed"); } catch (error) { console.error("Shared slot shutdown observation failed:", error); }
    }
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    try { this.store.flushBindings(); } catch (error) { console.error("Runtime shutdown bookkeeping held:", error); }
    for (const d of Object.values(this.drivers)) {
      try { d?.shutdown(); } catch (error) { console.error("Native driver shutdown failed; termination remains unconfirmed:", error); }
    }
    for (const [, p] of this.pending) clearTimeout(p.timer);
    for (const t of this.quotaTimers.values()) clearTimeout(t);
    this.quotaTimers.clear();
    for (const t of this.authVerifyTimers.values()) clearTimeout(t);
    this.authVerifyTimers.clear();
  }
}

/** 本机终端继续原生会话的命令：Codex 用验证过的绝对路径（用户 shell 里不一定有 codex） */
export function resumeCommand(kind: RuntimeKind, nativeId: string, workspace: string, binaryPath?: string, nativeSessionPath?: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const nativeArg = /^[A-Za-z0-9_-]+$/.test(nativeId) ? nativeId : q(nativeId);
  const codex = binaryPath && binaryPath.startsWith("/") ? q(binaryPath) : "codex";
  return kind === "codex" ? `cd ${q(workspace)} && ${codex} resume ${nativeArg}` : kind === "antigravity" ? `cd ${q(workspace)} && ${binaryPath ? q(binaryPath) : "agy"} --conversation ${nativeArg}` : kind === "pi" ? `cd ${q(workspace)} && ${binaryPath ? q(binaryPath) : "pi"} --session ${q(nativeSessionPath ?? nativeId)}` : `cd ${q(workspace)} && claude --resume ${nativeArg}`;
}

function digest(v: unknown): string {
  return createHash("sha256").update(stableStringify(v)).digest("hex").slice(0, 16);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export type { UsageRecord };

/** 首条消息先提供一个可读的短标题，后续原生标题回报可替换。 */
function autoSessionTitle(prompt: string): string {
  const first = prompt.trim().split(/[\n。！？!?]/u)[0]?.replace(/^#+\s*|^[-*]\s+/g, "").replace(/\s+/g, " ").trim() || "新会话";
  const chars = Array.from(first);
  return chars.length > 32 ? `${chars.slice(0, 32).join("")}…` : first;
}
