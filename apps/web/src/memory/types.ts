import type { MemoryEntry, MemorySnapshot, MemoryOrigin } from '../../../../packages/runtime-memory/src/index.js';
export interface MemoryScope { kind:'global'|'project'; project:string|null }
export interface MemoryTrigger { kind:'archive'|'manual'|'startup'; workspace:string; platformSessionId?:string; at:string }
export interface MemoryObservation {
 origin?:MemoryOrigin;
 version:1; id:string; runId:string; scope:MemoryScope; sourceId:string; databaseIdentity:string;
 observedAt:string; trigger:MemoryTrigger; kind:'add'|'update'|'delete'|'generation-reset'; memoryId:string|null;
 entry:MemoryEntry|null; previous:MemoryEntry|null; baseline:boolean; previousDatabaseIdentity?:string;
}
export interface MemoryState {
 version:1; scope:MemoryScope; snapshot:MemorySnapshot; lastSuccessAt:string; lastRunId:string;
 consecutiveFailures:number; lastError:string|null; compactedAt?:string;
}
export type MemoryErrorCode='not-configured'|'not-initialized'|'unavailable'|'timeout'|'invalid-output'|'busy'|'storage-error'|'disabled'|'invalid-workspace';
export class MemoryError extends Error { constructor(readonly code:MemoryErrorCode){super(code);} }
