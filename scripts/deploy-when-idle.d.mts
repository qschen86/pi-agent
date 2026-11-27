// deploy-when-idle.mjs 里给 Web 服务与测试用的导出（脚本本身是纯 JS，部署前不需要编译）
export interface WhenIdleRequest {
  action?: "rollback"; expectedLive?: string;
  id: string; sha: string; ref: string; subject?: string; repo: string;
  requestedAt: string; deadline: string; liveAtRequest: string | null; notifySession: string | null;
  /** 发起部署的会话 runtime（Web 服务登记时写入；命令行请求可能没有） */
  runtimeKind?: string;
  /** 部署成功后要快进到 sha 的分支（会话页「提交并在空闲时部署」），以及登记时它的位置 */
  ffBranch?: string; ffFrom?: string;
  /** 守候进程已开始部署它；进入 switching 后不能取消 */
  startedAt?: string;
  baselineRed?: BaselineRedState | null;
  file: string;
}
export interface WhenIdleDirs { root: string; home: string; requests: string; pidFile: string; log: string }
export function whenIdleDirs(root?: string): WhenIdleDirs;
export function readRequests(root?: string): WhenIdleRequest[];
/** 标记请求已开始部署（startedAt）或退回等待（undefined）：列表页相应显示「部署中」/「待部署」 */
export function markRequests<T extends { file: string; sha: string }>(qs: T[], startedAt: string | undefined, update?: Pick<Partial<WhenIdleRequest>, "baselineRed" | "deadline">): T[];
export function watcherPid(root?: string): number | undefined;
export function liveCommit(root?: string): string | undefined;
export function commitSubject(repo: string, sha: string): string | undefined;
export function isAncestor(repo: string, a: string, b: string): boolean;
export function cancelRequest(id: string, root?: string): { ok: true; request: WhenIdleRequest } | { ok: false; code: "NOT_FOUND" | "STARTED"; message: string };
export function enqueue(input: { repo: string; sha: string; ref?: string; notifySession?: string | null; runtimeKind?: string; hours?: number; root?: string; startWatcher?: boolean; action?: "rollback"; expectedLive?: string; ffBranch?: string; ffFrom?: string }):
  { request: Omit<WhenIdleRequest, "file">; live: string | undefined; watcherPid: number | undefined; log: string };

export function resolveRequester(input: { explicit?: string; envId?: string; cwd: string; active: Array<{ platformSessionId: string; workspace?: string }> }): { id?: string; how?: string; why?: string };
export function busyReasons(input: { activity: unknown; piTasks: number; locked: boolean; vitest: number; preparing?: boolean }): string[];
export function planDeploy<T extends { sha: string }>(requests: T[], live: string | undefined, isAncestor: (a: string, b: string) => boolean): { done: T[]; rejected: T[]; target: string | undefined; covered: T[] };
export function notifyPrompt(input: { outcome: "ok" | "already-live" | "rejected" | "failed" | "expired" | "gate-retry"; sha: string; subject: string; live?: string; logFile: string; detail?: string; requestSha?: string; requestId?: string; attempt?: number; max?: number }): string;
export function notifyKey(requestId: string): string;
export function failureHints(logText: string): string[];
export function waivedNote(logText: string): string;
export interface FastForwardResult { result: "moved" | "contained" | "checked-out" | "diverged" | "failed" | "unchanged"; tip?: string; where?: string[]; detail?: string }
export function fastForwardAfterDeploy(repo: string, branch: string, target: string): FastForwardResult;
export function branchSyncBlocker(repo: string, branch: string, target?: string): { where?: string[]; detail: string } | undefined;
export function ffNote(input: { branch: string; sha: string; outcome: "ok" | "failed"; ff?: FastForwardResult }): string;
export function shouldYieldCutover(repo: string, sha: string, root?: string): boolean;
export function runDeploy(repo: string, sha: string, logFile: string, root?: string, syncBranches?: string[], options?: { coveredIds?: string[]; action?: "rollback"; expectedLive?: string; stageOnly?: boolean; failureBase?: string; args?: string[]; env?: Record<string, string>; timeline?: { queuedAt?: string; startedAt: string; stagedAt: string } }): Promise<number>;
/** 一批请求切换前的节点时间（登记 → 预发检查开始 → 预发完成） */
export function stagingTimeline(requests: Array<{ id: string; requestedAt?: string }>, staged: StagedState | undefined): { queuedAt?: string; startedAt: string; stagedAt: string } | undefined;
/** 叠加预发（when-idle/staged.json）：逐个叠加请求，最后一次切换 */
export interface StagedState { sha: string; ids: string[]; skipped: Record<string, { sha: string; at: string; detail: string }>; live?: string; stale?: boolean; at?: string; timeline?: Record<string, { startedAt: string; stagedAt: string }> }
export const CUTOVER_WAIT_SECONDS: number;
export const STAGED_REF: string;
export function readStaged(root?: string): StagedState | undefined;
export function writeStaged(state: Omit<StagedState, "at">, root?: string): void;
export function clearStaged(root?: string): void;
export function keepStagedRef(repo: string, sha: string): void;
export function retireStagedRef(repo: string, sha?: string, branch?: string): void;
export function planStaging<T extends { id: string; sha: string }>(input: { requests: T[]; live: string | undefined; staged: StagedState | undefined; isAncestor: (a: string, b: string) => boolean; isCooling?: (request: T, base?: string) => boolean }):
  | { action: "reset"; reason: string; dependent: [] }
  | { action: "stage"; request: T; base: string | undefined; dependent: Array<{ request: T; on: string }> }
  | { action: "cutover"; sha: string; covered: T[]; dependent: Array<{ request: T; on: string }> }
  | { action: "refresh"; sha: string; covered: T[]; dependent: [] }
  | { action: "idle"; dependent: Array<{ request: T; on: string }> };
export function settleDeploy<T extends Omit<WhenIdleRequest, "file"> & { file: string }>(input: { repo: string; sha: string; code: number; covered: T[]; logFile: string; root?: string }):
  { ok: boolean; live: string | undefined; ff: Record<string, FastForwardResult>; notes: Array<{ q: T; outcome: "ok" | "failed"; extra: { live?: string; logFile: string; detail?: string } }> };
export const BUSY_EXIT: number;
export const TESTS_FAILED_EXIT: number;
export const BASELINE_RED_EXIT: number;
export const BASELINE_RED_COOLDOWN_MS: number;
/** 门禁发现失败的测试线上版本同样红：冷却状态跟随请求。 */
export interface BaselineRedState { live?: string; branchTip?: string; base?: string; target?: string; requestId?: string; files: string[]; at: string; logFile?: string }
export function parseBaselineRed(logText: string): { files: string[]; base?: string } | undefined;
export function waivedNote(logText: string): string;
export function writeBaselineRed(state: Omit<BaselineRedState, "at"> & { at?: string }, root?: string): void;
export function readBaselineRed(root?: string): BaselineRedState | undefined;
export function clearBaselineRed(root?: string): void;
export function holdForBaselineRed<T extends { file: string; sha: string }>(input: { repo: string; branch: string; target: string; covered: T[]; logFile: string; root?: string; inputs?: { live?: string; base?: string; branchTip?: string } }): { covered: T[]; files: string[] };
export function baselineRedHolds(state: BaselineRedState | undefined, now: { live?: string; branchTip?: string; target?: string; base?: string }, nowMs?: number): boolean;
export function baselineRedForRequest(request: Pick<WhenIdleRequest, "action" | "baselineRed" | "id" | "sha">, legacy?: BaselineRedState): BaselineRedState | undefined;
export function baselineRedWait(request: Pick<WhenIdleRequest, "sha">, state: BaselineRedState | undefined, now: { live?: string; base?: string; branchTip?: string }, nowMs?: number): BaselineRedState | undefined;
export function requestDeadline(request: Pick<WhenIdleRequest, "deadline">, state?: BaselineRedState, nowMs?: number): number;

export function integrateDeploy(input: { repo: string; target: string; live?: string; branch?: string; root?: string }): { ok: true; sha: string; branch: string; cleanup(): void } | { ok: false; retry?: boolean; conflicts: string[]; detail: string };
export function resolveIntegratedAssetConflicts(text: string): string | undefined;

/** 冲突自动解决：按会话记录的状态（Web 服务与守候进程共用） */
export interface AutoResolveState {
  session: string;
  phase: "resolving" | "queued" | "needs-human";
  /** 已自动处理的次数（发出解决冲突那一轮的次数） */
  attempts: number;
  max?: number;
  conflicts: string[];
  /** request：登记时变基冲突；integration：部署前集成冲突；gate：门禁失败后让会话修复（conflicts 里放失败文件） */
  stage: "request" | "integration" | "gate";
  /** 冲突时会话分支的提交：那一轮结束后没有新提交、也没合进 main，说明会话没完成合并 */
  head?: string;
  branch?: string;
  /** resolving：解决冲突那一轮的操作 id */
  operationId?: string;
  /** queued：自动重新登记的请求 */
  requestId?: string;
  /** needs-human：为什么需要人 */
  reason?: string;
  at: string;
}
export const AUTO_RESOLVE_MAX: number;
export function readAutoResolve(session: string, root?: string): AutoResolveState | undefined;
export function writeAutoResolve(state: Omit<AutoResolveState, "at">, root?: string): AutoResolveState;
export function clearAutoResolve(session: string, root?: string): void;
export function autoResolveKey(session: string, attempt: number): string;
export function autoResolvePrompt(input: { branch?: string; conflicts: string[]; attempt: number; max?: number; stage: "request" | "integration"; live?: string }): string;

/** 门禁失败后自动修复重试：重试链按会话记录（部署耗时、修复耗时、失败文件） */
export interface GateRetryAttempt { sha: string; failedAt: string; /** 这次部署（准备 + 门禁）用了多久 */ deployMs?: number; phase?: string; files: string[]; fixStartedAt?: string; /** 会话修复用了多久（发出修复任务 → 自动重新登记部署） */ fixMs?: number }
export interface GateRetryChain { session: string; startedAt: string; attempts: GateRetryAttempt[]; updatedAt: string }
export const GATE_RETRY_MAX: number;
export function readGateRetry(session: string, root?: string): GateRetryChain | undefined;
export function writeGateRetry(state: Omit<GateRetryChain, "updatedAt">, root?: string): GateRetryChain;
export function clearGateRetry(session: string, root?: string): void;
export function gateRetryable(gate: unknown): boolean;
export function runDurationMs(root: string, sha: string): number | undefined;
export function formatDuration(ms: number | undefined): string;
export function gateRetrySummary(chain: GateRetryChain | undefined, finalMs?: number): string;

export function rollbackTarget(root?: string): { sha: string; live: string; subject: string } | undefined;
export function enqueueRollback(input: { repo: string; expectedLive: string; expectedSha: string; notifySession: string; runtimeKind?: string; root?: string; startWatcher?: boolean }): { request: WhenIdleRequest };
