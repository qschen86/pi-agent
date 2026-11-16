import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sameMemoryKnowledge, diffMemorySnapshots, validateMemorySnapshot, type MemoryDelta, type MemorySnapshot } from '../../../../packages/runtime-memory/src/index.js';
import { withHostMutex } from '../../../../packages/runtime-sessions/src/host-mutex.js';
import { MemoryError, type MemoryObservation, type MemoryScope, type MemoryState, type MemoryTrigger } from './types.js';
export const digest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyPattern=/^[a-f0-9]{32}$/;
/** File content is durable before rename; fsync directory seals publication before the next checkpoint. */
export function atomicWrite(file:string, value:string | Uint8Array):void {
 const temp=file+'.'+randomUUID()+'.tmp'; const fd=openSync(temp,'wx',0o600);
 try {writeFileSync(fd,value);fsyncSync(fd);} finally {closeSync(fd);}
 try {renameSync(temp,file);const dir=openSync(join(file,'..'),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
 finally {if(existsSync(temp))unlinkSync(temp);}
}
export class MemoryStore {
 constructor(readonly root:string, private readonly now=()=>new Date()){}
 locked<T>(fn:()=>T):T {
  mkdirSync(this.root,{recursive:true,mode:0o700});
  const result=withHostMutex(this.root,fn);
  if(result && typeof result==='object' && 'status' in result && result.status==='busy')throw new MemoryError('busy');
  return result as T;
 }
 private dir(key:string):string {if(!keyPattern.test(key))throw new MemoryError('invalid-output');return join(this.root,'scopes',key);}
 state(key:string):MemoryState|null {
  const file=join(this.dir(key),'state.json');
  if(!existsSync(file))return null;
  const state=JSON.parse(readFileSync(file,'utf8')) as MemoryState;
  validateMemorySnapshot(state.snapshot);
  if(state.version!==1 || digest([state.snapshot.sourceId,state.scope.kind,state.scope.project]).slice(0,32)!==key || state.snapshot.project!==state.scope.project || state.snapshot.scope!==state.scope.kind || typeof state.lastRunId!=='string')throw new MemoryError('storage-error');
  return state;
 }
 observations(key:string):MemoryObservation[] {
  const dir=this.dir(key); if(!existsSync(dir))return [];
  const result=new Map<string,MemoryObservation>();
  for(const file of readdirSync(dir).filter(f=>/^observations-\d{4}-\d{2}\.jsonl$/.test(f)).sort()){
   for(const line of readFileSync(join(dir,file),'utf8').split('\n').filter(Boolean)){
    const row=JSON.parse(line) as MemoryObservation;
    if(row.version!==1 || !/^[a-f0-9]{64}$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.runId) || !['add','update','delete','generation-reset'].includes(row.kind) || digest([row.sourceId,row.scope.kind,row.scope.project]).slice(0,32)!==key)throw new MemoryError('storage-error');
    result.set(row.id,row);
   }
  }
  return [...result.values()];
 }
 private publish(key:string,state:MemoryState,rows:MemoryObservation[]):void {
  validateMemorySnapshot(state.snapshot);
  if(digest([state.snapshot.sourceId,state.scope.kind,state.scope.project]).slice(0,32)!==key || state.snapshot.scope!==state.scope.kind || rows.some(r=>r.runId!==state.lastRunId || r.sourceId!==state.snapshot.sourceId || r.databaseIdentity!==state.snapshot.databaseIdentity || digest([r.sourceId,r.scope.kind,r.scope.project]).slice(0,32)!==key || !/^[a-f0-9]{64}$/.test(r.id)))throw new MemoryError('storage-error');
  const ledger=this.observations(key), existing=new Set(ledger.map(o=>o.id));
  const additions=rows.filter(r=>!existing.has(r.id));
  for(const month of new Set(additions.map(r=>r.observedAt.slice(0,7)))){
   if(!/^\d{4}-\d{2}$/.test(month))throw new MemoryError('storage-error');
   const content=[...ledger.filter(r=>r.observedAt.slice(0,7)===month),...additions.filter(r=>r.observedAt.slice(0,7)===month)];
   atomicWrite(join(this.dir(key),`observations-${month}.jsonl`),content.map(r=>JSON.stringify(r)+'\n').join(''));
  }
  atomicWrite(join(this.dir(key),'state.json'),JSON.stringify(state)+'\n');
 }
 private recover(key:string):void {
  const file=join(this.dir(key),'pending.json');if(!existsSync(file))return;
  const pending=JSON.parse(readFileSync(file,'utf8')) as {state:MemoryState;rows:MemoryObservation[]};
  if(!pending || !Array.isArray(pending.rows))throw new MemoryError('storage-error');
  this.publish(key,pending.state,pending.rows);
  unlinkSync(file);
  const dir=openSync(this.dir(key),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 }
 commit(snapshot:MemorySnapshot,trigger:MemoryTrigger):{scopeKey:string;observations:number} {
  validateMemorySnapshot(snapshot);
  if(snapshot.scope!=='global' && snapshot.scope!=='project')throw new MemoryError('invalid-output');
  const scope:MemoryScope={kind:snapshot.scope,project:snapshot.project}, key=digest([snapshot.sourceId,scope.kind,scope.project]).slice(0,32);
  return this.locked(()=>{
   const dir=this.dir(key);mkdirSync(dir,{recursive:true,mode:0o700});
   this.recover(key);
   let previous:MemoryState|null;
   try {previous=this.state(key);}catch{renameSync(join(dir,'state.json'),join(dir,`state.json.corrupt-${randomUUID()}`));previous=null;}
   if(previous && Date.parse(snapshot.capturedAt)<Date.parse(previous.snapshot.capturedAt))throw new MemoryError('busy');
   const time=this.now().toISOString(), reset=previous && previous.snapshot.databaseIdentity!==snapshot.databaseIdentity;
   // Read all retained observations before changing state, even on no-op: a corrupt ledger fences writes.
   const ledger=this.observations(key);
   const seenWrites=new Set(!reset?previous?.snapshot.writes?.map(w=>w.id):[]);
   const writes=(snapshot.writes??[]).filter(w=>!seenWrites.has(w.id));
   const auditedIds=new Set(writes.map(w=>w.memoryId));
   const deltas:MemoryDelta[]=!previous || reset ? snapshot.entries.map(entry=>({kind:'add',id:entry.id,entry})) : diffMemorySnapshots(previous.snapshot,snapshot);
   const runId=digest([key,previous?.lastRunId??null,previous?.snapshot.hash??null,snapshot.hash]);
   const rows:MemoryObservation[]=[];
   if(reset)rows.push({version:1,id:digest([runId,'reset']),runId,scope,sourceId:snapshot.sourceId,databaseIdentity:snapshot.databaseIdentity,observedAt:time,trigger,kind:'generation-reset',memoryId:null,entry:null,previous:null,baseline:false,previousDatabaseIdentity:previous!.snapshot.databaseIdentity});
   for(const delta of deltas.filter(d=>!auditedIds.has(d.id)))rows.push({version:1,id:digest([runId,delta.kind,delta.id]),runId,scope,sourceId:snapshot.sourceId,databaseIdentity:snapshot.databaseIdentity,observedAt:time,trigger,kind:delta.kind,memoryId:delta.id,entry:'entry' in delta?delta.entry:null,previous:'previous' in delta?delta.previous:null,baseline:!previous||!!reset});
   const tracked=new Map(previous && !reset && previous.snapshot.writes!==undefined?previous.snapshot.entries.map(e=>[e.id,e]):[]);
   const baselineKnown=!!previous && !reset && previous.snapshot.writes!==undefined;
   const replayed=new Set<string>();
   for(const write of writes){
    const before=tracked.get(write.memoryId)??null;
    if((baselineKnown||replayed.has(write.memoryId)) && !sameMemoryKnowledge(before,write.previous)){
     const entry=write.previous;
     rows.push({version:1,id:digest([runId,'gap-before',write.id]),runId,scope,sourceId:snapshot.sourceId,databaseIdentity:snapshot.databaseIdentity,observedAt:time,trigger,kind:!entry?'delete':!before?'add':'update',memoryId:write.memoryId,entry,previous:before,baseline:false});
    }
    rows.push({version:1,id:digest([snapshot.sourceId,snapshot.databaseIdentity,'write',write.id]),runId,scope,sourceId:snapshot.sourceId,databaseIdentity:snapshot.databaseIdentity,observedAt:time,trigger,kind:write.kind,memoryId:write.memoryId,entry:write.entry,previous:write.previous,baseline:false,origin:write.origin});
    if(write.entry)tracked.set(write.memoryId,write.entry);else tracked.delete(write.memoryId);
    replayed.add(write.memoryId);
   }
   // An older process may still write without auditing. Never let a known earlier writer
   // absorb a later unattributed mutation, even if the net current value matches the old checkpoint.
   const finalAudited=new Map(writes.map(w=>[w.memoryId,w.entry]));
   const actual=new Map(snapshot.entries.map(e=>[e.id,e]));
   for(const [id,before] of finalAudited){
    const entry=actual.get(id)??null;
    if(!sameMemoryKnowledge(before,entry)){
     const kind=!entry?'delete':!before?'add':'update';
     rows.push({version:1,id:digest([runId,'unaudited',id]),runId,scope,sourceId:snapshot.sourceId,databaseIdentity:snapshot.databaseIdentity,observedAt:time,trigger,kind,memoryId:id,entry,previous:before,baseline:false});
    }
   }
   const existing=new Set(ledger.map(o=>o.id)), additions=rows.filter(r=>!existing.has(r.id));
   // Seal the transition before publishing either ledger or checkpoint. Recovery must finish it
   // even when Runtime has already advanced to a newer snapshot after the process crash.
   const state:MemoryState={version:1,scope,snapshot,lastSuccessAt:time,lastRunId:rows.length?runId:previous?.lastRunId??runId,consecutiveFailures:0,lastError:null};
   if(rows.length){
    atomicWrite(join(dir,'pending.json'),JSON.stringify({state,rows})+'\n');
    this.recover(key);
   }else{atomicWrite(join(dir,'state.json'),JSON.stringify(state)+'\n');}
   this.compact(key,time);
   return {scopeKey:key,observations:additions.length};
  });
 }
 private compact(key:string,time:string):void {
  const all=this.observations(key), cutoff=new Date(time);cutoff.setUTCMonth(cutoff.getUTCMonth()-12);
  const retained=all.filter(o=>o.kind!=='generation-reset' && o.observedAt>=cutoff.toISOString()).slice(-200000);
  const keep=new Set([...retained,...all.filter(o=>o.kind==='generation-reset')].map(o=>o.id));
  if(keep.size===all.length)return;
  const dir=this.dir(key);
  for(const file of readdirSync(dir).filter(f=>/^observations-\d{4}-\d{2}\.jsonl$/.test(f))){
   const rows=all.filter(o=>o.observedAt.slice(0,7)===file.slice(13,20) && keep.has(o.id));
   atomicWrite(join(dir,file),rows.map(o=>JSON.stringify(o)+'\n').join(''));
  }
 }
 status():Array<{scopeKey:string;kind:string;entries:number;lastSuccessAt:string|null;lastError:string|null}> {
  const dir=join(this.root,'scopes');if(!existsSync(dir))return [];
  return readdirSync(dir).filter(k=>keyPattern.test(k)).map(scopeKey=>{
   try {const state=this.state(scopeKey);return {scopeKey,kind:state?.scope.kind??'unknown',entries:state?.snapshot.entries.length??0,lastSuccessAt:state?.lastSuccessAt??null,lastError:null};}
   catch{return {scopeKey,kind:'unknown',entries:0,lastSuccessAt:null,lastError:'storage-error'};}
  });
 }
}
