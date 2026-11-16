/** Runtime-owned execution protocol: no Web/platform lifecycle types. */
export interface EvaluationBoundary { reportDir: string; inputRoots: string[] }
export interface RuntimeApproval {
  nativeRequestId: string;
  kind: "permissions" | "command" | "file-change";
  title: string;
  action: string;
  scope: string;
  source: string;
  requiresExplicitApproval: boolean;
  runtimeSessionScope?: string;
  params: unknown;
}
export interface RuntimeControlSink {
  approval(request: RuntimeApproval, signal: AbortSignal): Promise<{approve: boolean; reason: string}>;
  status(value: "waiting-input" | "running"): void;
}
export interface PiRuntimeSpec {
  version: 1;
  /** Opaque runtime-owned browser configuration ID; no frontend-supplied paths. */
  browserProfileId?: string;
  binary: string;
  workspace: string;
  provider: string;
  model: string;
  mode: string;
  sessionId: string;
  memorySource?: {platformSessionId?:string;turnId?:string};
  sourceAgentDir?: string;
  sessionFile?: string;
  historyDestination?: string;
  permissionStatePath?: string;
  communityProfilePath?: string;
  nativeMemoryProfilePath?: string;
  resumeCommunityProfilePath?: string;
  expectedFingerprint?: string;
  roleInstructions?: string;
  recordReadRoots?: string[];
  platformBrowser?: {socketPath:string;bridgePath:string;hookPath:string};
  evaluation?: EvaluationBoundary;
  /** 联网检索授权（可选）：未给 = 不注册 web_search/web_open 工具。 */
  webResearch?: {
    /** 允许阅读的网页域名；`*` 为开放来源（仍只允许公网 HTTPS） */
    sourceDomains: string[];
    /** 本轮预算；省略用 Broker 默认值 */
    budget?: { searches?: number; opens?: number; maxResults?: number; maxPageChars?: number; maxTotalChars?: number };
  };
  worktree?: {repoRoot: string; path: string; branch: string};
}
