import {createRequire} from 'node:module';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,chmodSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import type {CommitState,Decision,EvidenceDraft,EvidenceSnapshot,FactCandidate,FactOrigin,FactRevision,FactScope,RecordedDecision} from '../../../runtime-memory/src/facts-contract.js';
import {ledgerSchema} from './ledger-schema.js';import {factKey} from './schema.js';
export interface ProjectionFile {path:string;before:string|null;after:string}
export interface EvidenceUpdate {key:string;expectedRevision:number;evidence:EvidenceSnapshot}
export interface ScopeBlock {key:string;project:string|null;target:string;path:string;reason:string}
export interface CommitIntent {evidenceUpdates?:EvidenceUpdate[];scope:FactScope;files:ProjectionFile[];revisions:FactRevision[];decisionIds:string[]}
export interface PreparedCommit extends CommitIntent {id:string;state:CommitState}
export interface AttemptInput {requestId:string;index:number;candidate:FactCandidate|null;raw?:string;project?:string|null;origin:FactOrigin;decision:Decision;previous:FactRevision|null}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function checkPrivate(path:string,directory=false){const s=lstatSync(path);if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||s.mode&0o077||process.getuid&&s.uid!==process.getuid())throw new Error('nonprivate-fact-store');}
export class FactLedger {
 readonly db:InstanceType<typeof DatabaseSync>;
 constructor(readonly path:string,readonly mode:'readwrite'|'readonly'){
  if(!isAbsolute(path))throw new Error('absolute-fact-store-required');checkPrivate(dirname(path),true);if(existsSync(path))checkPrivate(path);else if(mode==='readonly')throw new Error('fact-store-not-initialized');
  for(const suffix of ['-wal','-shm'])if(existsSync(path+suffix))checkPrivate(path+suffix);
  this.db=new DatabaseSync(path,{readOnly:mode==='readonly'});try{if(mode==='readwrite')chmodSync(path,0o600);this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
   const v=this.db.prepare('PRAGMA user_version').get()?.user_version;if(v===0&&mode==='readwrite'){this.transaction(()=>{this.db.exec(ledgerSchema);this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('identity',randomUUID());});}else if(v!==1)throw new Error('unsupported-fact-schema');
   if(mode==='readwrite'){this.db.exec('CREATE TABLE IF NOT EXISTS scope_blocks(scope_key TEXT PRIMARY KEY,project TEXT,target TEXT NOT NULL,path TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL);');this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');for(const suffix of ['-wal','-shm'])if(existsSync(path+suffix))chmodSync(path+suffix,0o600);}else this.db.exec('PRAGMA query_only=ON');
  }catch(e){this.db.close();throw e;}
 }
 transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 recordEvidence(draft:EvidenceDraft):EvidenceSnapshot {return this.transaction(()=>{
  if(!/^[a-f0-9]{64}$/.test(draft.sourceHash)&&draft.sourceHash.length>512)throw new Error('invalid-evidence-hash');
  let sequence=draft.sequence;if(sequence===undefined){const latest=this.db.prepare('SELECT payload FROM evidence WHERE source_id=?').all(draft.sourceId).map(r=>JSON.parse(String(r.payload)) as EvidenceSnapshot);if(latest.some(e=>Date.parse(e.observedAt)>Date.parse(draft.observedAt)))throw new Error('stale-observation');const rows=this.db.prepare('SELECT sequence FROM evidence WHERE source_id=?').all(draft.sourceId);sequence=(rows.reduce((max,r)=>BigInt(String(r.sequence))>max?BigInt(String(r.sequence)):max,0n)+1n).toString();}
  if(!/^(0|[1-9]\d*)$/.test(sequence))throw new Error('invalid-source-sequence');
  const old=this.db.prepare('SELECT * FROM evidence WHERE source_id=? AND sequence=?').get(draft.sourceId,sequence);if(old){const prior=JSON.parse(String(old.payload)) as EvidenceSnapshot;if(prior.sourceHash!==draft.sourceHash||prior.factKey!==draft.factKey||prior.value!==draft.value)throw new Error('source-equivocation');return prior;}
  const e={...draft,id:randomUUID(),sequence};this.db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?)').run(e.id,e.sourceId,e.sequence,e.sourceHash,JSON.stringify(e));return e;
 });}
 evidence(id:string):EvidenceSnapshot|null {const r=this.db.prepare('SELECT payload FROM evidence WHERE id=?').get(id);return r?JSON.parse(String(r.payload)):null;}
 current(key:string):FactRevision|null {const r=this.db.prepare('SELECT payload FROM facts WHERE key=?').get(key);return r?JSON.parse(String(r.payload)):null;}
 allCurrent():FactRevision[]{return this.db.prepare('SELECT payload FROM facts ORDER BY key').all().map(r=>JSON.parse(String(r.payload)));}
 recordAttempt(i:AttemptInput):RecordedDecision {return this.transaction(()=>{
  const raw=i.raw??JSON.stringify(i.candidate),rawHash=hash(raw);const prior=this.db.prepare('SELECT d.* FROM candidates c JOIN decisions d ON d.candidate_id=c.id WHERE c.request_id=? AND c.item_index=?').get(i.requestId,i.index);
  if(prior){const record=JSON.parse(String(prior.payload)) as RecordedDecision;if(record.rawHash!==rawHash)throw new Error('idempotency-conflict');this.db.prepare('INSERT INTO attempts(decision_id,at) VALUES(?,?)').run(record.id,new Date().toISOString());return {...record,seq:Number(prior.seq),state:String(prior.state),commitId:prior.commit_id as string|null,attempt:Number(this.db.prepare('SELECT count(*) n FROM attempts WHERE decision_id=?').get(record.id)?.n)};}
  const id=randomUUID(),at=new Date().toISOString(),tooLarge=Buffer.byteLength(raw)>16384;
  const record:RecordedDecision={project:i.candidate?.scope.project??i.project??null,seq:0,id,requestId:i.requestId,index:i.index,candidate:tooLarge?null:i.candidate,evidence:!tooLarge&&i.candidate?.evidenceRef?this.evidence(i.candidate.evidenceRef):null,rawHash,origin:i.origin,at,decision:tooLarge?{...i.decision,kind:'rejected',reasonCode:'candidate-too-large',action:'none'}:i.decision,previous:i.previous,commitId:null,state:'decided',attempt:1};
  this.db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?)').run(id,i.requestId,i.index,rawHash,tooLarge?null:raw);
  const result=this.db.prepare('INSERT INTO decisions(id,candidate_id,project,session_id,kind,at,state,payload) VALUES(?,?,?,?,?,?,?,?)').run(id,id,i.candidate?.scope.project??i.project??null,i.origin.platformSessionId,record.decision.kind,at,record.state,JSON.stringify(record));
  this.db.prepare('INSERT INTO attempts(decision_id,at) VALUES(?,?)').run(id,at);return {...record,seq:Number(result.lastInsertRowid)};
 });}
 prepareCommit(input:CommitIntent):PreparedCommit{return this.transaction(()=>{
  for(const r of input.revisions)if((this.current(factKey(r.fact))?.revision??0)!==r.revision-1)throw new Error('revision-conflict');
  const commit:PreparedCommit={...input,id:randomUUID(),state:'prepared'};this.db.prepare('INSERT INTO commits(id,state,payload) VALUES(?,?,?)').run(commit.id,commit.state,JSON.stringify(commit));for(const id of input.decisionIds)this.db.prepare('UPDATE decisions SET commit_id=?,state=? WHERE id=?').run(commit.id,'prepared',id);return commit;
 });}
 getCommit(id:string):PreparedCommit {const r=this.db.prepare('SELECT * FROM commits WHERE id=?').get(id);if(!r)throw new Error('unknown-commit');return {...JSON.parse(String(r.payload)),state:r.state};}
 pendingCommits():PreparedCommit[]{return this.db.prepare("SELECT * FROM commits WHERE state IN ('prepared','published','recovery_required') ORDER BY rowid").all().map(r=>({...JSON.parse(String(r.payload)),state:r.state}));}
 finishCommit(id:string):void {this.transaction(()=>{const c=this.getCommit(id);if(c.state==='committed')return;if(!['prepared','published','recovery_required'].includes(c.state))throw new Error('invalid-commit-state');for(const proposed of c.revisions){const r={...proposed,projectionPath:c.files[0]?.path??proposed.projectionPath};const key=factKey(r.fact);if((this.current(key)?.revision??0)!==r.revision-1)throw new Error('revision-conflict');if(r.revision>1){const old=this.current(key)!;this.db.prepare('UPDATE fact_revisions SET payload=? WHERE key=? AND revision=?').run(JSON.stringify({...old,status:'superseded'}),key,old.revision);}this.db.prepare('INSERT INTO fact_revisions VALUES(?,?,?)').run(key,r.revision,JSON.stringify(r));this.db.prepare('INSERT INTO facts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(key,r.revision,JSON.stringify(r));}this.refreshEvidenceUnlocked(c.evidenceUpdates??[]);this.db.prepare("UPDATE commits SET state='committed' WHERE id=?").run(id);this.db.prepare("UPDATE decisions SET state='committed' WHERE commit_id=?").run(id);});}
 setCommitState(id:string,state:CommitState,reason:string):void {this.transaction(()=>{this.db.prepare('UPDATE commits SET state=?,reason=? WHERE id=?').run(state,reason,id);this.db.prepare('UPDATE decisions SET state=? WHERE commit_id=?').run(state,id);});}
 markDecisions(ids:string[],state:string):void {this.transaction(()=>{for(const id of ids)this.db.prepare('UPDATE decisions SET state=? WHERE id=?').run(state,id);});}
 private refreshEvidenceUnlocked(updates:EvidenceUpdate[]):number {let refreshed=0;for(const u of updates){const r=this.current(u.key),e=u.evidence;if(!r||r.revision!==u.expectedRevision||r.fact.value!==e.value||r.evidence.sourceId!==e.sourceId||r.evidence.comparisonDomain!==e.comparisonDomain||BigInt(e.sequence)<=BigInt(r.evidence.sequence)||Date.parse(e.observedAt)<Date.parse(r.evidence.observedAt))continue;const updated={...r,evidence:e};this.db.prepare('UPDATE facts SET payload=? WHERE key=? AND revision=?').run(JSON.stringify(updated),u.key,r.revision);this.db.prepare('UPDATE fact_revisions SET payload=? WHERE key=? AND revision=?').run(JSON.stringify(updated),u.key,r.revision);refreshed++;}return refreshed;}
 refreshEvidence(updates:EvidenceUpdate[]):number {return this.transaction(()=>this.refreshEvidenceUnlocked(updates));}
 blockedScopes():ScopeBlock[]{if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='scope_blocks'").get())return [];return this.db.prepare('SELECT * FROM scope_blocks').all().map(r=>({key:String(r.scope_key),project:r.project as string|null,target:String(r.target),path:String(r.path),reason:String(r.reason)}));}
 blockScope(project:string|null,target:string,path:string,reason:string,origin:FactOrigin={platformSessionId:null,nativeSessionId:null,turnId:null,trigger:'read-drift-detection'}):void {const key=JSON.stringify([project,target]);if(this.blockedScopes().some(b=>b.key===key))return;this.recordAttempt({requestId:randomUUID(),index:0,candidate:null,raw:JSON.stringify({path,reason}),project,origin,decision:{kind:'rejected',reasonCode:'external-drift',expectedRevision:null,ruleVersion:'facts-v1',action:'none'},previous:null});this.transaction(()=>{this.db.prepare('INSERT OR IGNORE INTO scope_blocks VALUES(?,?,?,?,?,?)').run(key,project,target,path,reason,new Date().toISOString());});}
 clearScopeBlock(key:string):void {const b=this.blockedScopes().find(b=>b.key===key);if(!b)return;this.recordAttempt({requestId:randomUUID(),index:0,candidate:null,raw:JSON.stringify({path:b.path}),project:b.project,origin:{platformSessionId:null,nativeSessionId:null,turnId:null,trigger:'startup-reconciliation'},decision:{kind:'duplicate',reasonCode:'verified-projection-restored',expectedRevision:null,ruleVersion:'facts-v1',action:'none'},previous:null});this.transaction(()=>{this.db.prepare('DELETE FROM scope_blocks WHERE scope_key=?').run(key);});}
 close():void{this.db.close();}
}
export const openFactLedger=(path:string,mode:'readwrite'|'readonly')=>new FactLedger(path,mode);
