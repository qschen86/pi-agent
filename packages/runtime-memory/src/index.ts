/** Platform-owned read port. Never instantiate Hermes' DatabaseManager: opening it can migrate/write. */
import {filterFactEntries} from './facts-reader.js';
import {join,dirname} from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface MemoryOrigin {
  platformSessionId: string | null; nativeSessionId: string | null; turnId: string | null;
  provider: string | null; model: string | null; trigger: string; writtenAt: string; tool?: string; factCommitId?:string;
  query?: string; queryMethod?: 'fts5'|'literal'; effectiveQuery?: string;
  filters?: {project?:string|null;target?:string;category?:string;limit?:number};
}
export interface MemoryWrite {
  id: string; memoryId: string; kind: 'add'|'update'|'delete'; origin: MemoryOrigin;
  entry: MemoryEntry | null; previous: MemoryEntry | null;
}
export interface SessionMemoryEvent { id:string; kind:'add'|'update'|'delete'|'injected'; origin:MemoryOrigin; entry:MemoryEntry; previous?:MemoryEntry|null }
export interface SessionMemoryPage { version:1; events:SessionMemoryEvent[]; nextCursor:string|null; hasMore:boolean }
export function validateSessionMemoryPage(page:SessionMemoryPage,sessionId:string):void {
 if(!page || page.version!==1 || !Array.isArray(page.events) || page.events.length>100 || typeof page.hasMore!=='boolean' || !(page.nextCursor===null||typeof page.nextCursor==='string'&&page.nextCursor.length<1024) || page.hasMore!==(page.nextCursor!==null) || Buffer.byteLength(JSON.stringify(page))>10*1024*1024)throw new Error('Invalid session memory events');
 const ids=new Set<string>();
 for(const e of page.events){
  validateOrigin(e.origin);
  if(!/^[a-f0-9]{32}$/.test(e.id)||ids.has(e.id)||!['add','update','delete','injected'].includes(e.kind)||e.origin.platformSessionId!==sessionId||!e.entry||!/^\d+$/.test(e.entry.id)||typeof e.entry.content!=='string'||!(e.entry.project===null||typeof e.entry.project==='string')||!['memory','user','failure'].includes(e.entry.target))throw new Error('Invalid session memory event');
  if(e.kind==='update' && (!e.previous || typeof e.previous.content!=='string' || e.previous.id!==e.entry.id))throw new Error('Invalid previous memory');
  ids.add(e.id);
 }
}
export interface MemoryEntry {
  provenance?: { first: MemoryOrigin | null; last: MemoryOrigin };
  id: string;
  project: string | null;
  target: string;
  category: string | null;
  content: string;
  failure_reason: string | null;
  tool_state: string | null;
  corrected_to: string | null;
  created: string;
}
export type MemorySnapshotScope = 'all' | 'global' | 'project';
export interface MemorySnapshot {
  scope?: MemorySnapshotScope;
  version: 1;
  sourceId: string;
  databaseIdentity: string;
  project: string | null;
  capturedAt: string;
  entries: MemoryEntry[];
  hash: string;
  writes?: MemoryWrite[];
  factsHealth?:'ready'|'degraded';
}
export type MemoryDelta = { kind: 'add'; id: string; entry: MemoryEntry }
  | { kind: 'update'; id: string; previous: MemoryEntry; entry: MemoryEntry }
  | { kind: 'delete'; id: string; previous: MemoryEntry };
export interface MemoryHealth { status: 'ready' | 'not-initialized' | 'unavailable' }
export interface RuntimeMemoryAdapter {
  readSnapshot(scope?: MemorySnapshotScope): Promise<MemorySnapshot>;
  getChanges(previous: MemorySnapshot, latest: MemorySnapshot): MemoryDelta[];
  getHealth(): Promise<MemoryHealth>;
}
const columns = ['project', 'target', 'category', 'content', 'failure_reason', 'tool_state', 'corrected_to', 'created'] as const;
export function sameMemoryKnowledge(a:MemoryEntry|null|undefined,b:MemoryEntry|null|undefined):boolean {
  if(!a||!b)return !a&&!b;
  return a.id===b.id && columns.every(key=>a[key]===b[key]);
}
export function memorySnapshotHash(snapshot: Pick<MemorySnapshot, 'sourceId' | 'databaseIdentity' | 'project' | 'entries' | 'scope' | 'writes' | 'factsHealth'>): string {
  const payload: unknown[] = [1, snapshot.sourceId, snapshot.databaseIdentity, snapshot.project, snapshot.entries];
  if (snapshot.scope && snapshot.scope !== 'all') payload.push(snapshot.scope);
  if (snapshot.writes !== undefined) payload.push(snapshot.writes);
  if(snapshot.factsHealth!==undefined)payload.push(snapshot.factsHealth);
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
function validateOrigin(origin: MemoryOrigin): void {
  if(origin?.query!==undefined && (typeof origin.query!=='string'||origin.query.length>32000) || origin?.effectiveQuery!==undefined && (typeof origin.effectiveQuery!=='string'||origin.effectiveQuery.length>64000) || origin?.queryMethod!==undefined && !['fts5','literal'].includes(origin.queryMethod) || origin?.filters!==undefined && (!origin.filters || typeof origin.filters!=='object' || Array.isArray(origin.filters) || Object.entries(origin.filters).some(([k,v])=>k==='limit'?typeof v!=='number'||!Number.isFinite(v):!['project','target','category'].includes(k)||!(k==='project'&&v===null||typeof v==='string'&&v.length<=512))))throw new Error('Invalid memory query');
  if (!origin || [origin.platformSessionId,origin.nativeSessionId,origin.turnId,origin.provider,origin.model].some(v=>v!==null && (typeof v!=='string'||v.length>512)) || typeof origin.trigger!=='string' || origin.trigger.length>100 || typeof origin.writtenAt!=='string' || !Number.isFinite(Date.parse(origin.writtenAt)) || origin.tool!==undefined && (typeof origin.tool!=='string'||origin.tool.length>100)) throw new Error('Invalid memory provenance');
}
export function validateMemorySnapshot(snapshot: MemorySnapshot): void {
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.sourceId !== 'string' || !snapshot.sourceId || typeof snapshot.databaseIdentity !== 'string' || !snapshot.databaseIdentity || !(snapshot.project === null || typeof snapshot.project === 'string' && !!snapshot.project.trim()) || ![undefined,'all','global','project'].includes(snapshot.scope) || typeof snapshot.capturedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.capturedAt)) || !Array.isArray(snapshot.entries) || snapshot.entries.length > 10000 || Buffer.byteLength(JSON.stringify(snapshot)) > 10 * 1024 * 1024) throw new Error('Invalid memory snapshot/limit');
  for (const e of snapshot.entries) if(e?.provenance){if(e.provenance.first!==null)validateOrigin(e.provenance.first);validateOrigin(e.provenance.last);}
  if(snapshot.writes!==undefined){
    if(!Array.isArray(snapshot.writes)||snapshot.writes.length>10000)throw new Error('Invalid memory writes');
    const ids=new Set<string>();
    for(const w of snapshot.writes){
      if(!w || !/^[a-f0-9]{32}$/.test(w.id)||ids.has(w.id)||!/^\d+$/.test(w.memoryId)||!['add','update','delete'].includes(w.kind)||w.kind!=='delete'&&!w.entry||w.kind!=='add'&&!w.previous||w.kind==='delete'&&w.entry!==null||w.kind==='add'&&w.previous!==null)throw new Error('Invalid memory write');
      ids.add(w.id);validateOrigin(w.origin);
      for(const e of [w.entry,w.previous])if(e && (e.id!==w.memoryId || typeof e.content!=='string'||typeof e.created!=='string'||!['memory','user','failure'].includes(e.target)||[e.category,e.failure_reason,e.tool_state,e.corrected_to].some(v=>v!==null&&typeof v!=='string')||(snapshot.scope==='project'?e.project!==snapshot.project:![null,snapshot.project].includes(e.project))))throw new Error('Invalid memory write scope');
    }
  }
  if (snapshot.scope === 'global' && snapshot.project !== null || snapshot.scope === 'project' && snapshot.project === null) throw new Error('Memory snapshot scope mismatch');
  if (snapshot.entries.some(e => !e || typeof e.id !== 'string' || !/^\d+$/.test(e.id) || typeof e.content !== 'string' || typeof e.created !== 'string' || !['memory','user','failure'].includes(e.target) || [e.category,e.failure_reason,e.tool_state,e.corrected_to].some(v => v !== null && typeof v !== 'string') || !(e.project === null || typeof e.project === 'string') || (snapshot.scope === 'project' ? e.project !== snapshot.project : e.project !== null && e.project !== snapshot.project)) || new Set(snapshot.entries.map(e=>e.id)).size !== snapshot.entries.length || snapshot.hash !== memorySnapshotHash(snapshot)) throw new Error('Invalid memory snapshot/hash');
}
export function diffMemorySnapshots(previous: MemorySnapshot, latest: MemorySnapshot): MemoryDelta[] {
  for (const snapshot of [previous, latest]) validateMemorySnapshot(snapshot);
  if (previous.sourceId !== latest.sourceId || previous.project !== latest.project || (previous.scope ?? 'all') !== (latest.scope ?? 'all')) throw new Error('Memory snapshot source/scope mismatch');
  if (previous.databaseIdentity !== latest.databaseIdentity) throw new Error('Hermes database generation/identity changed; checkpoint reset required');
  const before = new Map(previous.entries.map(e=>[e.id,e])), after = new Map(latest.entries.map(e=>[e.id,e]));
  const changes: MemoryDelta[]=[];
  for (const id of [...new Set([...before.keys(),...after.keys()])].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0)) {
    const old=before.get(id), entry=after.get(id);
    if (!entry) changes.push({kind:'delete',id,previous:old!});
    else if (!old) changes.push({kind:'add',id,entry});
    else if (JSON.stringify(old)!==JSON.stringify(entry)) changes.push({kind:'update',id,previous:old,entry});
  }
  return changes;
}
function databaseIdentity(file: string): string {
  const stat = statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
export class HermesMemoryAdapter implements RuntimeMemoryAdapter {
  constructor(private readonly options: { databasePath: string; sourceId: string; project: string | null; includeProvenance?: boolean;factLedgerPath?:string }) {
    if (!isAbsolute(options.databasePath) || !options.sourceId || options.project !== null && !options.project.trim()) throw new Error('Invalid memory source/scope');
    this.options = { ...options };
  }
  readSessionEvents(sessionId:string,cursor?:string):SessionMemoryPage {
    if(!sessionId || sessionId.length>512)throw new Error('Invalid memory session');
    let before:string[]|undefined;
    if(cursor){
      try{before=JSON.parse(cursor);}catch{throw new Error('Invalid memory cursor');}
      if(!Array.isArray(before)||before.length!==2||typeof before[0]!=='string'||!Number.isFinite(Date.parse(before[0]))||typeof before[1]!=='string'||!/^[a-f0-9]{32}$/.test(before[1]))throw new Error('Invalid memory cursor');
    }
    if(!existsSync(this.options.databasePath))throw new Error('Hermes memory is not initialized');
    const db=new DatabaseSync(this.options.databasePath,{readOnly:true});
    try{
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN');
      const has=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      const sources:string[]=[];
      if(has('runtime_memory_writes'))sources.push("SELECT event_id, kind, origin, COALESCE(after_entry,before_entry) AS entry, before_entry AS previous FROM runtime_memory_writes WHERE kind IN ('add','update','delete') AND json_extract(origin,'$.platformSessionId')=?");
      if(has('runtime_memory_recalls'))sources.push("SELECT event_id, 'injected' AS kind, origin, entry, NULL AS previous FROM runtime_memory_recalls WHERE json_extract(origin,'$.platformSessionId')=?");
      const rows=sources.length?db.prepare(`SELECT *,json_extract(origin,'$.writtenAt') AS at FROM (${sources.join(' UNION ALL ')}) ${before?"WHERE (json_extract(origin,'$.writtenAt'),event_id)<(?,?)":''} ORDER BY at DESC,event_id DESC LIMIT 101`).all(...sources.map(()=>sessionId),...(before??[])):[];
      const hasMore=rows.length>100;
      const events=rows.slice(0,100).map(r=>({id:String(r.event_id),kind:r.kind as SessionMemoryEvent['kind'],origin:JSON.parse(String(r.origin)),entry:JSON.parse(String(r.entry)),previous:r.previous?JSON.parse(String(r.previous)):null}));
      const last=events.at(-1);
      const result:SessionMemoryPage={version:1,events,hasMore,nextCursor:hasMore&&last?JSON.stringify([last.origin.writtenAt,last.id]):null};
      validateSessionMemoryPage(result,sessionId);
      return result;
    }finally{db.close();}
  }
  listProjects():string[] {
    if (!existsSync(this.options.databasePath)) throw new Error('Hermes memory is not initialized');
    const db = new DatabaseSync(this.options.databasePath, {readOnly:true});
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000');
      const audited=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_memory_writes'").get();
      const catalog=audited?`SELECT project FROM memories UNION SELECT json_extract(before_entry, '$.project') FROM runtime_memory_writes WHERE before_entry IS NOT NULL UNION SELECT json_extract(after_entry, '$.project') FROM runtime_memory_writes WHERE after_entry IS NOT NULL`:'SELECT project FROM memories';
      const rows=db.prepare(`SELECT DISTINCT project FROM (${catalog}) WHERE project IS NOT NULL ORDER BY project LIMIT 501`).all();
      if(rows.length>500 || rows.some(r=>typeof r.project!=='string' || !r.project || /[\\/\0]/.test(r.project) || ['.','..'].includes(r.project as string)))throw new Error('Invalid Hermes project catalog');
      return rows.map(r=>r.project as string);
    } finally {db.close();}
  }
  async readSnapshot(scope: MemorySnapshotScope = 'all'): Promise<MemorySnapshot> {
    if (!['all','global','project'].includes(scope) || scope === 'project' && !this.options.project) throw new Error('Invalid memory snapshot scope/project');
    // Missing/corrupt stores must never look like an empty authoritative snapshot (mass deletion).
    if (!existsSync(this.options.databasePath)) throw new Error('Hermes memory is not initialized');
    const identity = databaseIdentity(this.options.databasePath);
    const db = new DatabaseSync(this.options.databasePath, { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN');
      const schema = db.prepare('PRAGMA table_info(memories)').all();
      if (!['id', ...columns].every(name => schema.some(col => col.name === name)) || !schema.some(col => col.name === 'id' && col.pk === 1 && col.type === 'INTEGER')) throw new Error('Unsupported Hermes memory schema');
      const where = scope === 'global' ? 'project IS NULL' : scope === 'project' ? 'project = ?' : 'project IS NULL OR project = ?';
      const query = db.prepare(`SELECT CAST(id AS TEXT) AS id, ${columns.join(', ')} FROM memories
        WHERE ${where} ORDER BY id LIMIT 10001`);
      const entries = (scope === 'global' ? query.all() : query.all(this.options.project)) as unknown as MemoryEntry[];
      if (entries.length > 10000 || Buffer.byteLength(JSON.stringify(entries)) > 10 * 1024 * 1024) throw new Error('Hermes snapshot exceeds limit; refusing a partial snapshot');
      if (entries.some(e => !/^\d+$/.test(e.id) || typeof e.content !== 'string' || typeof e.created !== 'string' || !['memory', 'user', 'failure'].includes(e.target))) throw new Error('Unsupported Hermes memory records');
      let writes: MemoryWrite[] | undefined=this.options.includeProvenance===false?undefined:[];
      if(this.options.includeProvenance!==false && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_memory_writes'").get()){
        // Filter in SQLite before loading: never return another project's memory history.
        const match=(ref:string)=>scope==='global'?`json_extract(${ref}, '$.project') IS NULL`:scope==='project'?`json_extract(${ref}, '$.project') = ?`:`(json_extract(${ref}, '$.project') IS NULL OR json_extract(${ref}, '$.project') = ?)`;
        const query=db.prepare(`SELECT * FROM runtime_memory_writes WHERE (before_entry IS NOT NULL AND (${match('before_entry')})) OR (after_entry IS NOT NULL AND (${match('after_entry')})) ORDER BY seq LIMIT 10001`);
        const rows=scope==='global'?query.all():query.all(this.options.project,this.options.project);
        if(rows.length>10000)throw new Error('Hermes write history exceeds snapshot limit');
        writes=rows.map(r=>({id:String(r.event_id),memoryId:String(r.memory_id),kind:r.kind as MemoryWrite['kind'],origin:JSON.parse(String(r.origin)),entry:r.after_entry?JSON.parse(String(r.after_entry)):null,previous:r.before_entry?JSON.parse(String(r.before_entry)):null}));
        for(const entry of entries){
          const history=writes.filter(w=>w.memoryId===entry.id);
          if(history.length && sameMemoryKnowledge(entry,history.at(-1)!.entry))entry.provenance={first:history[0]!.kind==='add'?history[0]!.origin:null,last:history.at(-1)!.origin};
        }
      }
      if (databaseIdentity(this.options.databasePath) !== identity) throw new Error('Hermes database generation changed during snapshot');
      const factPath=this.options.factLedgerPath??join(dirname(this.options.databasePath),'../runtime-facts.sqlite');
      const facts=existsSync(factPath)||entries.some(e=>e.content.includes('@runtime-fact'))?filterFactEntries(factPath,entries):null;
      const snapshot = { version: 1 as const, sourceId: this.options.sourceId, databaseIdentity: identity, project: scope === 'global' ? null : this.options.project, ...(scope === 'all' ? {} : {scope}), capturedAt: new Date().toISOString(), entries:facts?.entries??entries,...(facts?{factsHealth:facts.health}:{}), ...(writes===undefined?{}:{writes}) };
      db.exec('COMMIT');
      const result = { ...snapshot, hash: memorySnapshotHash(snapshot) };
      validateMemorySnapshot(result);
      return result;
    } finally { db.close(); }
  }
  getChanges(previous: MemorySnapshot, latest: MemorySnapshot): MemoryDelta[] {
    if ([previous,latest].some(s => s.sourceId !== this.options.sourceId || s.project !== (s.scope === 'global' ? null : this.options.project))) throw new Error('Memory snapshot source/scope mismatch');
    return diffMemorySnapshots(previous,latest);
  }
  async getHealth(): Promise<MemoryHealth> {
    if (!existsSync(this.options.databasePath)) return { status: 'not-initialized' };
    try { await this.readSnapshot(); return { status: 'ready' }; }
    catch { return { status: 'unavailable' }; }
  }
}
