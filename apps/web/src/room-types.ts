import type { PermissionMode, RuntimeKind } from "@pi-agent/runtime-sessions";

export type RoomSettings = { attribution: "shown" | "anonymous"; shareScope: "replies" | "summary" | "full" };
export interface RoomMemberInput { alias: string; runtimeKind: RuntimeKind; model?: string; effort?: string; permissionMode?: PermissionMode; confirmedProfileVersion?: string }
export interface RoomMember {
  memberId: string; alias: string; /** 旧群聊（2026-10-18 前）成员可能绑过 Agent 定义；只用于显示历史记录 */ agentRef?: { id: string; version: string; hash: string }; roleName?: string;
  binding: { runtimeKind: RuntimeKind; model?: string; effort?: string; permissionMode: PermissionMode };
  platformSessionId: string; joinedAt: string; removedAt?: string;
  /** 可写成员：自己的 git worktree（从群聊起点切出）；workspace 是成员会话的工作目录（仓库子目录时在 worktree 里对应） */
  worktree?: { path: string; workspace: string };
}
export interface RoomSource { memberId: string; alias: string; agentRef?: RoomMember["agentRef"]; runtimeKind: RuntimeKind; model?: string; platformSessionId: string; turnNo: number; seqStart: number; seqEnd: number }
export interface QuoteInput { seq: number; span?: { start: number; end: number }; hash?: string }
export interface RoomQuote { seq: number; span?: { start: number; end: number }; hash: string; text: string; author: string; source?: RoomSource; truncated?: boolean }
export interface RoomDelivery {
  memberId: string; key: string; prompt: string; cutoff: number; eventCutoffs: Record<string, number>;
  status: "queued" | "dispatching" | "running" | "completed" | "failed" | "unknown" | "cancelled";
  turnNo?: number; operationId?: string; error?: string; resultSeq?: number; retryable?: boolean; retryNo?: number;
}
export interface RoomMessage {
  seq: number; kind: "human" | "member" | "system"; author: string; text: string; createdAt: string;
  idempotencyKey?: string; requestHash?: string; memberId?: string; replyTo?: number; source?: RoomSource;
  quotes: RoomQuote[]; mentions: string[]; deliveries: RoomDelivery[];
  /** 轮内对比的人工结论：最佳回复的成员（null = 都不满意）；只记录，不触发执行 */
  verdict?: { memberId: string | null; note: string; at: string; by: string };
}
export interface RoomRoundMember {
  memberId: string; alias: string; roleName?: string; runtimeKind: string; model?: string; effort?: string; platformSessionId: string; removed: boolean;
  status: RoomDelivery["status"]; error?: string; turnNo?: number; queuePosition?: number; approvals: number;
  reply?: { seq: number; text: string };
  metrics: ReturnType<import("@pi-agent/runtime-sessions").RuntimeSessionManager["turnMetrics"]>;
}
export interface RoomRound { roomId: string; seq: number; message: RoomMessage; settled: boolean; members: RoomRoundMember[]; verdict?: RoomMessage["verdict"] }
export interface Room {
  roomId: string; title: string; workspace: string; idempotencyKey: string; requestHash: string;
  createdAt: string; createdBy: string; archived: boolean; members: RoomMember[]; messages: RoomMessage[]; settings: RoomSettings;
  /** 工作目录在有 commit 的 git 仓库里时记下起点；可写成员的 worktree 都从 baseCommit 切出。cleanedAt：归档时已删除各成员 worktree */
  worktree?: { repoRoot: string; subdir: string; baseCommit: string; baseBranch?: string; dirtyAtCreate: number; cleanedAt?: string };
  /** 已采用到原目录的成员改动（可以多次、分别采用；同一份补丁只采用一次） */
  adoptions?: Array<{ memberId: string; alias: string; patchHash: string; files: number; at: string; by: string }>;
}
export interface RoomCreateInput { idempotencyKey: string; title: string; workspace: string; members: RoomMemberInput[]; settings?: Partial<RoomSettings>; confirmedProfileVersions?: Partial<Record<RuntimeKind, string>>;
  /** 有可写成员时必填：新建前看到的 HEAD；之后 HEAD 变了要求重新确认 */
  confirmedBaseCommit?: string }
export interface RoomPostInput { idempotencyKey: string; text: string; quotes?: QuoteInput[]; mentions?: string[] | "all" }
