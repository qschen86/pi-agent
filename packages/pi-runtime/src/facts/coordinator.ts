import {randomUUID} from 'node:crypto';
import type {FactCandidate,FactScope,FactOrigin,FactRevision,RecordedDecision,Decision} from '../../../runtime-memory/src/facts-contract.js';import {defaultFactOrigin} from '../../../runtime-memory/src/facts-contract.js';
import {type FactLedger,type ProjectionFile,type EvidenceUpdate} from './ledger.js';import {factKey,factId,normalizeCandidate,sameScope} from './schema.js';import {decideFact} from './rules.js';import {parseFactText} from './templates.js';import {withMemoryLock} from '../hermes-extension.js';
export interface ProjectionPort {plan(revisions:FactRevision[]):Promise<ProjectionFile[]>;publish(files:ProjectionFile[]):Promise<void>;sync(files:ProjectionFile[]):Promise<void>;verify(files:ProjectionFile[]):Promise<boolean>}
export interface FactDependencies {ledger:FactLedger;projection:ProjectionPort;lockPath:string;signal?:AbortSignal;publishContext?:(id:string,fn:()=>Promise<void>)=>Promise<void>}
export interface CandidateBatch {requestId?:string;items:unknown[];scope:FactScope;origin?:FactOrigin}
export interface BatchResult {decisions:RecordedDecision[];commitId:string|null;state:'committed'|'no_change'|'rejected'}
const none=(kind:Decision['kind'],reasonCode:string):Decision=>({kind,reasonCode,expectedRevision:null,ruleVersion:'facts-v1',action:'none'});
export async function submitFacts(batch:CandidateBatch,deps:FactDependencies):Promise<BatchResult>{return withMemoryLock(deps.lockPath,async()=>{
 const {ledger:l,projection:p,signal}=deps;signal?.throwIfAborted();if(l.blockedScopes().some(b=>b.project===batch.scope.project&&b.target===batch.scope.target))throw new Error('fact-scope-recovery-required');if(l.pendingCommits().some(c=>sameScope(c.scope,batch.scope)))throw new Error('fact-scope-recovery-required');
 const requestId=batch.requestId??randomUUID(),decisions:RecordedDecision[]=[],revisions:FactRevision[]=[],evidenceUpdates:EvidenceUpdate[]=[];const seen=new Set<string>(),tooMany=batch.items.length>100;
 const items=tooMany?[JSON.stringify({count:batch.items.length})]:batch.items;
 for(const [index,item] of items.entries()){
  let candidate:FactCandidate|null=null,decision:Decision,previous:FactRevision|null=null;const raw=typeof item==='string'?item:JSON.stringify(item)??'null';
  try{if(tooMany)throw new Error('batch-too-large');if(Buffer.byteLength(raw)>16384)throw new Error('candidate-too-large');if(typeof item==='string'){const parsed=parseFactText(item,batch.scope);if(parsed.kind!=='candidate'){decision=none(parsed.kind,parsed.reasonCode);decisions.push(l.recordAttempt({requestId,index,candidate:null,raw,project:batch.scope.project,origin:batch.origin??defaultFactOrigin(),decision,previous:null}));continue;}candidate=parsed.candidate;}else candidate=normalizeCandidate(item);
   if(!sameScope(candidate.scope,batch.scope))throw new Error('scope-mismatch');const key=factKey(candidate);previous=l.current(key);if(seen.has(key))throw new Error('duplicate-key-in-batch');seen.add(key);
   const evidence=candidate.evidenceRef?l.evidence(candidate.evidenceRef):null;decision=decideFact({candidate,current:previous,evidence,evaluationAt:new Date().toISOString(),ruleVersion:'facts-v1'});
   if(candidate.evidenceRef&&!evidence)decision=none('rejected','unknown-evidence-ref');
   if(decision.kind==='duplicate'&&evidence&&previous)evidenceUpdates.push({key,expectedRevision:previous.revision,evidence});
   if(decision.action!=='none'&&evidence)revisions.push({factId:factId(candidate),revision:(previous?.revision??0)+1,fact:candidate,evidence,status:'accepted'});
  }catch(e){if(e instanceof Error&&e.message==='scope-mismatch')candidate=null;decision=none('rejected',e instanceof Error?e.message:'invalid-candidate');}
  decisions.push(l.recordAttempt({requestId,index,candidate,raw,project:batch.scope.project,origin:batch.origin??defaultFactOrigin(),decision:decision!,previous}));
 }
 // Replaying an existing request never repeats a projection, even if current state changed.
 if(decisions.length&&decisions.every(d=>d.attempt>1))return {decisions,commitId:decisions[0]!.commitId,state:decisions.every(d=>d.state==='committed')?'committed':'no_change'};
 if(decisions.some(d=>!['accepted','replaced','duplicate','unstructured'].includes(d.decision.kind))){l.markDecisions(decisions.map(d=>d.id),'batch-aborted');return {decisions,commitId:null,state:'rejected'};}
 const files=(await p.plan(revisions)).filter(f=>f.before!==f.after);signal?.throwIfAborted();
 if(!files.length&&!revisions.length){const refreshed=l.refreshEvidence(evidenceUpdates);l.markDecisions(decisions.map(d=>d.id),refreshed?'evidence-refreshed':'unchanged');return {decisions,commitId:null,state:'no_change'};}
 const commit=l.prepareCommit({scope:batch.scope,files,revisions,evidenceUpdates,decisionIds:decisions.map(d=>d.id)});
 try{const publish=async()=>{signal?.throwIfAborted();await p.publish(files);l.setCommitState(commit.id,'published','files-published');await p.sync(files);if(!await p.verify(files))throw new Error('projection-verification-failed');l.finishCommit(commit.id);};await (deps.publishContext?deps.publishContext(commit.id,publish):publish());return {decisions,commitId:commit.id,state:'committed'};
 }catch(e){l.setCommitState(commit.id,'recovery_required',e instanceof Error?e.message:'publish-failed');throw e;}
 });}
