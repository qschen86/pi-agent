import type { EntryRef } from '../../../packages/runtime-sessions/src/types.js';
export type { EntryRef };
export interface RelationActor { kind: 'user' | 'runtime' | 'backfill' | 'system'; scopeId: string }
export interface RelationEvidence { sessionId?: string; turnId?: string; toolCallId?: string; evidenceKey?: string }
export interface RelationEdge { id: string; type: 'derived' | 'related'; from: EntryRef; to: EntryRef; createdAt: string; actor: RelationActor; generationSummary?: string; evidence?: RelationEvidence; revokedAt?: string; revocation?: 'deleted' | 'trimmed' | 'unrelated' | 'source-corrected'; revokeReason?: string }
export type RelationEventType = 'created' | 'derived' | 'related' | 'unrelated' | 'source-corrected' | 'kind-changed' | 'content-changed' | 'schedule-changed' | 'completed' | 'reopened' | 'deleted' | 'trimmed';
export interface RelationEvent { id: string; origin: 'recorded' | 'metadata' | 'backfill'; type: RelationEventType; occurredAt: string; recordedAt: string; refs: EntryRef[]; edgeIds: string[]; actor: RelationActor; evidence?: RelationEvidence; contentHash?: string; generationSummary?: string }
export interface RelationTombstone { ref: EntryRef; removedAt: string; cause: 'deleted' | 'trimmed'; links: Array<Pick<RelationEdge,'id'|'type'|'from'|'to'>> }
export interface RelationReceipt { scopeId: string; channel: 'web' | 'runtime' | 'backfill'; key: string; requestHash: string; resultId: string }
export interface NoteRelations { schemaVersion: 1; edges: RelationEdge[]; events: RelationEvent[]; tombstones: RelationTombstone[]; receipts: RelationReceipt[] }
export interface RelationNode { ref: EntryRef; state: 'available' | 'deleted' | 'unavailable'; title?: string; displayKind?: 'note' | 'todo' | 'event'; relationCount: number; createdAt?: string; checkedAt?: string; verification?: 'ready' | 'failed' | 'pending'; verificationPending?: boolean }
export type RelationRevision = string;
export interface GraphQuery { root: EntryRef; expanded: EntryRef[]; revision?: string; cursor?: string }
export interface GraphPage { revision: string; nodes: RelationNode[]; edges: RelationEdge[]; nextCursor?: string; remainingNodes: number; remainingEdges: number; truncated: boolean }
export interface TimelinePage { revision: string; events: RelationEvent[]; scope: EntryRef[]; nodes?: RelationNode[]; nextCursor?: string }
export interface RelationContext { actor: RelationActor; channel: RelationReceipt['channel']; evidence?: RelationEvidence }
export class RelationError extends Error { constructor(message: string, readonly status: 400|401|403|404|409|503 = 400) { super(message); } }
export const emptyRelations = (): NoteRelations => ({schemaVersion:1,edges:[],events:[],tombstones:[],receipts:[]});
