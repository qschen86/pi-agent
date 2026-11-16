/**
 * Codex / Claude 记忆的平台只读视图。这里的一切都是「观察」：不写、不改、不删它们的目录与数据库。
 * 事件形状与 Pi 的 SessionMemoryEvent 兼容（kind 的 injected = 消费），使会话卡片与查看器可以复用。
 */
import type { MemoryEntry, MemoryOrigin } from '../index.js';

export type NativeRuntime = 'codex' | 'claude-code';
export type NativeEntryState = 'ok' | 'too-large' | 'unstable';
export type NativeSection = 'index' | 'topic' | 'summary' | 'memory' | 'rollout' | 'note';
export type NativeAction = 'add' | 'update' | 'delete' | 'inject' | 'read' | 'search';
export type NativeTrigger =
  | 'startup-injection' | 'session-read' | 'session-search' | 'session-write' | 'session-delete'
  | 'pipeline-stage1' | 'pipeline-consolidate' | 'external-or-unknown';
export type NativeEvidence = 'transcript' | 'snapshot-diff' | 'sqlite';

export interface NativeMemoryEntry {
  /** 稳定标识：相对路径，或「相对路径#小节标题」 */
  id: string;
  path: string;
  section: NativeSection;
  title: string;
  description: string | null;
  /** Claude 主题文件头里的 type（user/feedback/project/reference…） */
  kind: string | null;
  content: string;
  hash: string;
  truncated: boolean;
  state: NativeEntryState;
  mtime: string | null;
}

export interface NativeMemorySnapshot {
  version: 1;
  runtime: NativeRuntime;
  /** Claude：项目目录键；Codex：global */
  scopeKey: string;
  project: string | null;
  capturedAt: string;
  status: 'ready' | 'not-found';
  entries: NativeMemoryEntry[];
  notes: string[];
}

export interface NativeMemoryOrigin extends MemoryOrigin {
  evidence: NativeEvidence;
}

export interface NativeMemoryEvent {
  id: string;
  kind: 'add' | 'update' | 'delete' | 'injected';
  origin: NativeMemoryOrigin;
  entry: MemoryEntry;
  previous?: MemoryEntry | null;
  displayTitle: string;
  titleState: 'ready';
  native: {
    runtime: NativeRuntime;
    action: NativeAction;
    path: string;
    section: NativeSection | null;
    scopeKey: string;
    lines?: string;
    detail?: string;
    /** 变动里 before/after 只是工具给出的片段（Edit 的 old/new），不是整份文件 */
    partial?: boolean;
    /** 该事件无法对应到任何平台会话 */
    sourceNote?: string;
  };
}

/** 平台会话事件的最小结构（与 runtime-sessions 的 ProjectedEvent 兼容，避免包间依赖） */
export interface ToolEventLike {
  key: string;
  seq: number;
  kind: string;
  tool?: { name: string; input?: string; output?: string; status?: string; exitCode?: number | null };
  turnNo?: number;
  occurredAt?: string;
  recordedAt?: string;
}
