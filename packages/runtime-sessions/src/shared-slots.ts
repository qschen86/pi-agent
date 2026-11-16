/** Host-owned shared account admission. Unknown effects never expire or release by age. */
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,unlinkSync,writeFileSync} from "node:fs";
import {createHash,randomUUID} from "node:crypto";
import {join} from "node:path";
import {withHostMutex} from "./host-mutex.js";
import {executionBudgetLimits,nativeTurnUsageReceipt,type NativeTurnUsageReceipt,type NativeMeterUsage,type ExecutionBudgetLimits,type ProjectExecutionUsage} from "./execution-budget.js";
interface ReleaseProof {outcome:"completed"|"not-executed";sourceRef:string}
export type AdmissionClass = "business"|"evaluation"|"stage"|"coordinator";
export interface ProjectAdmissionPolicy {concurrency:number;totalConcurrency:number;revision:number;sourceRef:string;existingScopes?:string[];budget?:ExecutionBudgetLimits}
interface ProjectPolicies {version:1;policies:Array<ProjectAdmissionPolicy & {projectId:string;accountScopes?:string[]}>}
interface Reservation {usage?:NativeTurnUsageReceipt;admittedAt?:number;endedAt?:number;admissionClass?:AdmissionClass;operationId:string;projectId:string;ownerId:string;status:"reserved"|"unknown"|"released";reason?:string;release?:ReleaseProof}
interface Ledger {version:2;identityScopeId:string;limit:number;configurationSource?:string;reservations:Reservation[]}
interface Request {admissionClass?:AdmissionClass;projectPolicy?:ProjectAdmissionPolicy;identityScopeId:string;projectId:string;ownerId:string;operationId:string;limit:number}
interface QueueEntry {identityScopeId:string;projectId:string;ownerId:string;operationId:string;limit:number;admissionClass:AdmissionClass;ready:boolean;sequence:number;enqueuedAt:number;waitedAdmissions:number;status:"queued"|"admitted"|"cancelled";release?:ReleaseProof}
interface QueueLedger {version:1;nextSequence:number;entries:QueueEntry[]}
interface AdmissionPublication {version:1;transactionId:string;rootHash:string;identityScopeId:string;operationId:string;ledger:{before:Ledger|null;after:Ledger};queue:{before:QueueLedger;after:QueueLedger}}
type Result={status:"reserved"|"unknown"|"released"|"full"|"busy"|"owned"|"stale"|"waiting"|"queued"|"cancelled"|"budget-exhausted"|"budget-unknown";reason?:string};
export const FAIR_QUEUE_MAX_OVERTAKES=4;
export const FAIR_QUEUE_AGE_MS=60_000;
const nonempty=(v:unknown):v is string=>typeof v==="string"&&v.trim().length>0&&v.length<=1000;
export class SharedSlots {
 private readonly dir:string;
 constructor(dir:string){mkdirSync(dir,{recursive:true});this.dir=realpathSync(dir);}
 private file(scope:string):string {if(!nonempty(scope))throw new Error("Invalid account scope");return join(this.dir,createHash("sha256").update(scope).digest("hex")+".json");}
 private locked<T>(scope:string,fn:(file:string)=>T):T|{status:"busy"}{
  const file=this.file(scope);
  return withHostMutex(this.dir,()=>{
   // Legacy per-account locks stay fences; absent owner proof is not a lease.
   if(existsSync(file+".lock"))return{status:"busy" as const};
   this.recoverAdmission();
   return fn(file);
  });
 }
 private read(file:string,scope:string):Ledger|undefined {
  if(!existsSync(file))return;
  let value:Ledger;try{value=JSON.parse(readFileSync(file,"utf8"));}catch{throw new Error("Invalid shared slot ledger; capacity remains held");}
  this.validateLedger(value,scope);return value;
 }
 private validateLedger(value:Ledger,scope:string):void {
  if(!value||value.version!==2||value.identityScopeId!==scope||!Number.isInteger(value.limit)||value.limit<1||!Array.isArray(value.reservations)||new Set(value.reservations.map(r=>r.operationId)).size!==value.reservations.length||value.reservations.some(r=>(r.usage!==undefined&&!this.validUsage(r.usage))||(r.usage!==undefined&&r.release?.outcome==="not-executed")||!nonempty(r.operationId)||!nonempty(r.projectId)||!nonempty(r.ownerId)||(r.admissionClass!==undefined&&!["business","evaluation","stage","coordinator"].includes(r.admissionClass))||(r.admittedAt!==undefined&&(!Number.isFinite(r.admittedAt)||r.admittedAt<0))||(r.endedAt!==undefined&&(!Number.isFinite(r.endedAt)||r.endedAt<0))||!["reserved","unknown","released"].includes(r.status)||(r.status==="released"&&(!r.release||!["completed","not-executed"].includes(r.release.outcome)||!nonempty(r.release.sourceRef)))))throw new Error("Invalid shared slot ledger; capacity remains held");
 }
 private write(file:string,ledger:unknown):void {
  const temporary=file+".tmp-"+randomUUID();const fd=openSync(temporary,"wx",0o600);
  try{writeFileSync(fd,JSON.stringify(ledger));fsyncSync(fd);}finally{closeSync(fd);}
  try{renameSync(temporary,file);const parent=openSync(this.dir,"r");try{fsyncSync(parent);}finally{closeSync(parent);}}finally{if(existsSync(temporary))unlinkSync(temporary);}
 }
 private validPolicy(policy:ProjectAdmissionPolicy):boolean {return !!policy&&(policy.budget===undefined||this.validBudget(policy.budget))&&Number.isInteger(policy.concurrency)&&policy.concurrency>=1&&policy.concurrency<=8&&Number.isInteger(policy.totalConcurrency)&&policy.totalConcurrency>=1&&policy.totalConcurrency<=8&&Number.isInteger(policy.revision)&&policy.revision>=1&&nonempty(policy.sourceRef)&&(policy.existingScopes===undefined||Array.isArray(policy.existingScopes)&&policy.existingScopes.every(nonempty));}
 private validUsage(value:unknown):boolean {try{nativeTurnUsageReceipt(value);return true;}catch{return false;}}
 private validBudget(value:unknown):boolean {try{executionBudgetLimits(value);return true;}catch{return false;}}
 private policies():ProjectPolicies {
  const file=join(this.dir,"project-limits.json");let all:ProjectPolicies={version:1,policies:[]};
  if(existsSync(file)){try{all=JSON.parse(readFileSync(file,"utf8"));}catch{throw new Error("Invalid project admission policy; capacity remains held");}}
  if(all.version!==1||!Array.isArray(all.policies)||new Set(all.policies.map(p=>p.projectId)).size!==all.policies.length||all.policies.some(p=>!nonempty(p.projectId)||!this.validPolicy(p)||(p.accountScopes!==undefined&&(!Array.isArray(p.accountScopes)||p.accountScopes.some(scope=>!nonempty(scope))))))throw new Error("Invalid project admission policy; capacity remains held");
  return all;
 }
 private existingAccountScopes():string[] {
  return readdirSync(this.dir).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>{const file=join(this.dir,name);let scope:string;try{scope=JSON.parse(readFileSync(file,"utf8")).identityScopeId;}catch{throw new Error("Invalid legacy shared ledger; project capacity remains held");}if(!nonempty(scope)||this.file(scope)!==file)throw new Error("Invalid shared slot scope; capacity remains held");return scope;});
 }
 private projectPolicy(projectId:string,currentScope:string|undefined,incoming?:ProjectAdmissionPolicy):(ProjectAdmissionPolicy & {accountScopes:string[]})|"stale"|undefined {
  const file=join(this.dir,"project-limits.json"),all=this.policies();
  const prior=all.policies.find(p=>p.projectId===projectId);
  if(!incoming&&!prior)return;
  if(prior&&incoming&&incoming.revision<prior.revision)return "stale";
  if(prior&&incoming&&incoming.revision===prior.revision&&(incoming.concurrency!==prior.concurrency||incoming.totalConcurrency!==prior.totalConcurrency||incoming.sourceRef!==prior.sourceRef||JSON.stringify(incoming.budget===undefined?null:executionBudgetLimits(incoming.budget))!==JSON.stringify(prior.budget===undefined?null:executionBudgetLimits(prior.budget))))throw new Error("Conflicting project admission authorization");
  // Membership is indexed before account reservation publication. A new project uses
  // the host's known native bindings; legacy unindexed policies require source discovery.
  const scopes=prior?.accountScopes??incoming?.existingScopes??this.existingAccountScopes();
  const accountScopes=[...new Set([...scopes,...(incoming?.existingScopes??[]),...(currentScope?[currentScope]:[])])].sort();
  const basis=incoming??prior!;
  const next={projectId,concurrency:basis.concurrency,totalConcurrency:basis.totalConcurrency,revision:basis.revision,sourceRef:basis.sourceRef,accountScopes,...(basis.budget===undefined?{}:{budget:executionBudgetLimits(basis.budget)})};
  if(JSON.stringify(prior)!==JSON.stringify(next)){if(prior)all.policies[all.policies.indexOf(prior)]=next;else all.policies.push(next);this.write(file,all);}
  return next;
 }
 private projectReservations(projectId:string,currentScope:string,scopes:string[],includeReleased=false):Reservation[] {
  const result:Reservation[]=[];
  for(const scope of scopes){const file=this.file(scope);
   if(existsSync(file+".lock")&&currentScope!==scope)throw new Error("Shared account source locked; project capacity remains held");
   result.push(...(this.read(file,scope)?.reservations??[]).filter(r=>r.projectId===projectId&&(includeReleased||r.status!=="released")));
  }return result;
 }
 private usage(projectId:string,currentScope:string,scopes:string[]):ProjectExecutionUsage {
  const all=this.projectReservations(projectId,currentScope,scopes,true).filter(r=>r.release?.outcome!=="not-executed");
  const now=Date.now();let observed=0,unknown=false;
  for(const r of all){const end=r.status==="released"?r.endedAt:now;
   if(r.admittedAt===undefined||end===undefined||end<r.admittedAt){unknown=true;continue;}observed+=end-r.admittedAt;
  }
  return {calls:{used:all.length,basis:"宿主原子预留的作业调用；未知派发保守计入，确证未执行才退还"},wallTimeMs:{observed,coverage:unknown?"unknown":"complete",pendingTerminalCalls:all.filter(r=>r.status!=="released").length,basis:"累计各作业从预留至宿主确认终态的墙钟毫秒；含审批与停止核对，排队和休眠不计；未知终态持续计量"},tokens:this.meter(all,"tokens"),reportedCostUsd:this.meter(all,"reportedCostUsd")};
 }
 private meter(all:Reservation[],unit:"tokens"|"reportedCostUsd"):NativeMeterUsage {
  const known=all.filter(r=>r.status==="released"&&r.usage?.[unit]!==undefined),pendingCalls=all.length-known.length;
  // USD sums round each native receipt upward to micro-USD; never undercount a configured ceiling.
  const sum=known.reduce((total,r)=>total+(unit==="tokens"?r.usage!.tokens!:Math.ceil(r.usage!.reportedCostUsd!*1_000_000)),0);
  if(!Number.isSafeInteger(sum))throw new Error("Native usage total exceeds safe accounting range; budget held");
  return {coverage:!known.length?"not_collected":pendingCalls?"partial":"complete",...(known.length?{observed:unit==="tokens"?sum:sum/1_000_000}:{}),pendingCalls,basis:unit==="tokens"?"仅累计宿主核对本轮身份与终态的完整原生tokens；缺失或在途记录不视为0":"仅累计本轮完整runtime报告的USD折算值，每轮向上取整至微美元；缺失不视为0，不是订阅现金余额"};
 }
 /** Only called with a host-authenticated exact native terminal observation. Immutable per operation. */
 recordUsage(scope:string,operationId:string,value:NativeTurnUsageReceipt):Result {
  const usage=nativeTurnUsageReceipt(value);
  return this.locked(scope,file=>{const ledger=this.read(file,scope),r=ledger?.reservations.find(r=>r.operationId===operationId);
   if(!ledger||!r)throw new Error("Missing native usage reservation");
   if(r.release?.outcome==="not-executed")throw new Error("Not-executed reservation cannot have native usage");
   if(r.usage){if(JSON.stringify(nativeTurnUsageReceipt(r.usage))!==JSON.stringify(usage))throw new Error("Conflicting native usage receipt");return{status:r.status};}
   r.usage=usage;this.write(file,ledger);return{status:r.status};
  });
 }
 projectUsage(projectId:string,incoming?:ProjectAdmissionPolicy,knownScopes:string[]=[]):ProjectExecutionUsage {
  if(!nonempty(projectId))throw new Error("Invalid project usage identity");
  const result=this.locked(`project-usage:${projectId}`,()=>{const policy=incoming?this.projectPolicy(projectId,undefined,incoming):this.policies().policies.find(p=>p.projectId===projectId);if(policy==="stale")throw new Error("Project usage authorization stale");return this.usage(projectId,`project-usage:${projectId}`,[...new Set([...(policy?.accountScopes??[]),...knownScopes])]);});
  if("status" in result)throw new Error("Project usage source busy");return result;
 }
 private budgetIssue(policy:ProjectAdmissionPolicy,usage:ProjectExecutionUsage):Result|undefined {
  const b=policy.budget;if(!b)return;
  if(b.maxCalls!==undefined&&usage.calls.used>=b.maxCalls)return{status:"budget-exhausted",reason:"项目作业调用次数预算已用尽"};
  if(b.maxWallTimeMs!==undefined){if(usage.wallTimeMs.coverage!=="complete")return{status:"budget-unknown",reason:"历史执行时长未知，无法保证已配置的墙钟预算"};if(usage.wallTimeMs.observed>=b.maxWallTimeMs)return{status:"budget-exhausted",reason:"项目累计执行时长预算已用尽"};}
  if(b.maxTokens!==undefined)return{status:"budget-unknown",reason:"项目原生tokens用量尚未完整核对，无法保证已配置的tokens上限"};
  if(b.maxReportedCostUsd!==undefined)return{status:"budget-unknown",reason:"项目runtime报告费用尚未完整核对，无法保证已配置的USD上限"};
 }
 private queue():QueueLedger {
  const file=join(this.dir,"admission-queue.json");if(!existsSync(file))return{version:1,nextSequence:1,entries:[]};
  let q:QueueLedger;try{q=JSON.parse(readFileSync(file,"utf8"));}catch{throw new Error("Invalid shared admission queue; dispatch held");}
  this.validateQueue(q);return q;
 }
 private validateQueue(q:QueueLedger):void {
  if(!q||q.version!==1||!Number.isSafeInteger(q.nextSequence)||q.nextSequence<1||!Array.isArray(q.entries)||new Set(q.entries.map(e=>e.operationId)).size!==q.entries.length||new Set(q.entries.map(e=>e.sequence)).size!==q.entries.length||q.entries.some(e=>!nonempty(e.operationId)||!nonempty(e.ownerId)||!nonempty(e.projectId)||!nonempty(e.identityScopeId)||!Number.isInteger(e.limit)||e.limit<1||e.limit>1000||!["business","evaluation","stage","coordinator"].includes(e.admissionClass)||typeof e.ready!=="boolean"||!Number.isSafeInteger(e.sequence)||e.sequence<1||e.sequence>=q.nextSequence||!Number.isFinite(e.enqueuedAt)||e.enqueuedAt<0||!Number.isSafeInteger(e.waitedAdmissions)||e.waitedAdmissions<0||!["queued","admitted","cancelled"].includes(e.status)||(e.status==="cancelled"&&(!e.release||e.release.outcome!=="not-executed"||!nonempty(e.release.sourceRef)))))throw new Error("Invalid shared admission queue; dispatch held");
 }
 private writeQueue(q:QueueLedger):void {this.write(join(this.dir,"admission-queue.json"),q);}
 private admissionFile():string {return join(this.dir,"admission-publication.json");}
 private digest(value:unknown):string {return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
 private validateAdmission(intent:AdmissionPublication):void {
  const invalid=()=>{throw new Error("Invalid admission publication; dispatch held");};
  const exact=(value:object,keys:string[])=>value&&Object.keys(value).sort().join("|")===keys.sort().join("|");
  if(!intent||!exact(intent,["version","transactionId","rootHash","identityScopeId","operationId","ledger","queue"])||intent.version!==1||!/^[a-f0-9-]{36}$/.test(intent.transactionId)||intent.rootHash!==this.digest(this.dir)||!nonempty(intent.identityScopeId)||!nonempty(intent.operationId)||!exact(intent.ledger,["before","after"])||!exact(intent.queue,["before","after"]))invalid();
  const {before,after}=intent.ledger,beforeQueue=intent.queue.before,afterQueue=intent.queue.after;
  this.validateLedger(after,intent.identityScopeId);if(before!==null)this.validateLedger(before,intent.identityScopeId);this.validateQueue(beforeQueue);this.validateQueue(afterQueue);
  const original=before??{version:2,identityScopeId:intent.identityScopeId,limit:after.limit,reservations:[]},added=after.reservations.at(-1);
  if(!added||added.operationId!==intent.operationId||added.status!=="reserved"||!Number.isFinite(added.admittedAt)||added.admissionClass===undefined||!exact(added,["operationId","projectId","ownerId","status","admittedAt","admissionClass"])||original.reservations.some(r=>r.operationId===intent.operationId)||this.digest(after)!==this.digest({...original,reservations:[...original.reservations,added]})||beforeQueue.nextSequence!==afterQueue.nextSequence||beforeQueue.entries.length!==afterQueue.entries.length)invalid();
  for(let i=0;i<beforeQueue.entries.length;i++){
   const old=beforeQueue.entries[i]!,next=afterQueue.entries[i]!;
   if(old.operationId===intent.operationId){
    if(old.status!=="queued"||!old.ready||old.identityScopeId!==intent.identityScopeId||old.projectId!==added!.projectId||old.ownerId!==added!.ownerId||old.admissionClass!==added!.admissionClass||old.limit!==after.limit||this.digest(next)!==this.digest({...old,status:"admitted"}))invalid();
   }else if(this.digest(old)!==this.digest(next)){
    if(old.status!=="queued"||!old.ready||old.identityScopeId!==intent.identityScopeId&&old.projectId!==added!.projectId||this.digest(next)!==this.digest({...old,waitedAdmissions:old.waitedAdmissions+1}))invalid();
   }
  }
 }
 /** Roll forward host records only. A surviving reservation remains owned and occupied. */
 private recoverAdmission():void {
  const journal=this.admissionFile();if(!existsSync(journal))return;
  let intent:AdmissionPublication;try{intent=JSON.parse(readFileSync(journal,"utf8"));}catch{throw new Error("Invalid admission publication; dispatch held");}
  this.validateAdmission(intent);
  const file=this.file(intent.identityScopeId);if(existsSync(file+".lock"))throw new Error("Admission source locked; dispatch held");
  const current=this.read(file,intent.identityScopeId)??null,currentQueue=this.queue();
  const matches=(current:unknown,change:{before:unknown;after:unknown})=>this.digest(current)===this.digest(change.before)||this.digest(current)===this.digest(change.after);
  if(!matches(current,intent.ledger)||!matches(currentQueue,intent.queue))throw new Error("Admission publication source conflict; dispatch held");
  // Check both original sources before changing either fixed destination.
  if(this.digest(current)!==this.digest(intent.ledger.after))this.write(file,intent.ledger.after);
  if(this.digest(currentQueue)!==this.digest(intent.queue.after))this.writeQueue(intent.queue.after);
  unlinkSync(journal);const parent=openSync(this.dir,"r");try{fsyncSync(parent);}finally{closeSync(parent);}
 }
 private publishAdmission(scope:string,operationId:string,before:Ledger|null,after:Ledger,queueBefore:QueueLedger,queueAfter:QueueLedger):void {
  const intent:AdmissionPublication={version:1,transactionId:randomUUID(),rootHash:this.digest(this.dir),identityScopeId:scope,operationId,ledger:{before,after},queue:{before:queueBefore,after:queueAfter}};
  this.validateAdmission(intent);this.write(this.admissionFile(),intent);this.recoverAdmission();
 }
 private validateRequest(input:Request):void {
  if(!nonempty(input.ownerId)||!nonempty(input.operationId)||!nonempty(input.projectId)||!nonempty(input.identityScopeId)||!Number.isInteger(input.limit)||input.limit<1||input.limit>1000)throw new Error("Invalid slot reservation");
  if(input.projectPolicy&&!this.validPolicy(input.projectPolicy))throw new Error("Invalid project admission policy");
  if(input.admissionClass!==undefined&&!["business","evaluation","stage","coordinator"].includes(input.admissionClass))throw new Error("Invalid project admission class");
 }
 /** Publish all local intents before selection. A paused/undispatched intent owns no capacity. */
 enqueue(input:Request,ready:boolean):Result {
  this.validateRequest(input);if(typeof ready!=="boolean")throw new Error("Invalid queue readiness");
  return this.locked(input.identityScopeId,file=>{
   if(this.projectPolicy(input.projectId,input.identityScopeId,input.projectPolicy)==="stale")return{status:"stale"};
   const q=this.queue(),prior=q.entries.find(e=>e.operationId===input.operationId);
   if(prior){
    if(prior.projectId!==input.projectId||prior.identityScopeId!==input.identityScopeId||prior.admissionClass!==(input.admissionClass??"business"))throw new Error("Conflicting queue intent");
    if(prior.ownerId!==input.ownerId)return{status:"owned"};
    if(prior.status!=="queued")return{status:prior.status==="cancelled"?"cancelled":"reserved"};
    if(prior.ready!==ready||prior.limit!==input.limit){prior.ready=ready;prior.limit=input.limit;this.writeQueue(q);}return{status:"queued"};
   }
   const held=this.read(file,input.identityScopeId)?.reservations.find(r=>r.operationId===input.operationId);
   if(held)return{status:held.status==="reserved"&&held.ownerId!==input.ownerId?"owned":held.status};
   q.entries.push({identityScopeId:input.identityScopeId,projectId:input.projectId,ownerId:input.ownerId,operationId:input.operationId,limit:input.limit,admissionClass:input.admissionClass??"business",ready,sequence:q.nextSequence++,enqueuedAt:Date.now(),waitedAdmissions:0,status:"queued"});this.writeQueue(q);return{status:"queued"};
  });
 }
 cancelQueued(scope:string,operationId:string,proof:ReleaseProof):Result {
  if(proof?.outcome!=="not-executed"||!nonempty(proof.sourceRef))throw new Error("Queue cancellation requires undispatched host source");
  return this.locked(scope,file=>{
   const held=this.read(file,scope)?.reservations.find(r=>r.operationId===operationId);
   if(held&&held.status!=="released")throw new Error("Cannot retire a dispatched reservation as queued");
   const q=this.queue(),entry=q.entries.find(e=>e.operationId===operationId);if(!entry)return{status:"cancelled"};
   if(entry.identityScopeId!==scope)throw new Error("Queue intent belongs to another account");
   if(entry.status==="admitted")throw new Error("Cannot retire a dispatched queue intent");
   if(entry.status==="cancelled"){if(JSON.stringify(entry.release)!==JSON.stringify(proof))throw new Error("Conflicting queue cancellation source");return{status:"cancelled"};}
   entry.status="cancelled";entry.ready=false;entry.release={...proof};this.writeQueue(q);return{status:"cancelled"};
  });
 }
 queuePosition(scope:string,operationId:string):number|undefined {
  const result=this.locked(scope,()=>{const entries=this.queue().entries.filter(e=>e.identityScopeId===scope&&e.status==="queued").sort((a,b)=>this.compareQueue(a,b,Date.now()));const index=entries.findIndex(e=>e.operationId===operationId);return index<0?undefined:index+1;});
  return typeof result==="number"?result:undefined;
 }
 private eligible(entry:QueueEntry,currentScope:string):boolean {
  if(entry.status!=="queued"||!entry.ready)return false;
  const file=this.file(entry.identityScopeId);if(entry.identityScopeId!==currentScope&&existsSync(file+".lock"))return false;
  const ledger=this.read(file,entry.identityScopeId);
  if(ledger&&(ledger.limit!==entry.limit||ledger.reservations.some(r=>r.operationId===entry.operationId)||ledger.reservations.filter(r=>r.status!=="released").length>=ledger.limit))return false;
  const policy=this.projectPolicy(entry.projectId,entry.identityScopeId);
  if(policy&&policy!=="stale"){
   if(this.budgetIssue(policy,this.usage(entry.projectId,currentScope,policy.accountScopes)))return false;
   const occupied=this.projectReservations(entry.projectId,currentScope,policy.accountScopes);
   if(occupied.length>=policy.totalConcurrency||entry.admissionClass==="business"&&occupied.filter(r=>(r.admissionClass??"business")==="business").length>=policy.concurrency)return false;
  }return true;
 }
 private compareQueue(a:QueueEntry,b:QueueEntry,now:number):number {
  const aged=(e:QueueEntry)=>e.waitedAdmissions>=FAIR_QUEUE_MAX_OVERTAKES||now-e.enqueuedAt>=FAIR_QUEUE_AGE_MS;
  if(aged(a)!==aged(b))return aged(a)?-1:1;
  if(!aged(a)&&(a.admissionClass==="evaluation")!==(b.admissionClass==="evaluation"))return a.admissionClass==="evaluation"?-1:1;
  return a.sequence-b.sequence;
 }
 reserve(input:Request):Result {
  this.validateRequest(input);
  return this.locked(input.identityScopeId,file=>{
   const ledger=this.read(file,input.identityScopeId)??{version:2 as const,identityScopeId:input.identityScopeId,limit:input.limit,reservations:[]};
   if(ledger.limit!==input.limit)throw new Error("Shared capacity changed; explicit host configuration is required");
   const prior=ledger.reservations.find(r=>r.operationId===input.operationId);if(prior){if(prior.projectId!==input.projectId)throw new Error("Slot operation belongs to another project");if(prior.status==="reserved"&&prior.ownerId!==input.ownerId)return{status:"owned"};return{status:prior.status};}
   const policy=this.projectPolicy(input.projectId,input.identityScopeId,input.projectPolicy);if(policy==="stale")return{status:"stale"};
   if(policy){const issue=this.budgetIssue(policy,this.usage(input.projectId,input.identityScopeId,policy.accountScopes));if(issue)return issue;const occupied=this.projectReservations(input.projectId,input.identityScopeId,policy.accountScopes);
    if(occupied.length>=policy.totalConcurrency||(input.admissionClass??"business")==="business"&&occupied.filter(r=>(r.admissionClass??"business")==="business").length>=policy.concurrency)return{status:"full"};}
   if(ledger.reservations.filter(r=>r.status!=="released").length>=ledger.limit)return{status:"full"};
   const q=this.queue(),queued=q.entries.find(e=>e.operationId===input.operationId);
   if(queued){if(queued.projectId!==input.projectId||queued.identityScopeId!==input.identityScopeId||queued.admissionClass!==(input.admissionClass??"business"))throw new Error("Conflicting queue intent");if(queued.ownerId!==input.ownerId)return{status:"owned"};if(queued.status==="cancelled")return{status:"cancelled"};if(queued.status==="admitted")return{status:"unknown"};if(!queued.ready)return{status:"waiting"};}
   const candidate=queued??{identityScopeId:input.identityScopeId,projectId:input.projectId,ownerId:input.ownerId,operationId:input.operationId,limit:input.limit,admissionClass:input.admissionClass??"business",ready:true,sequence:q.nextSequence,enqueuedAt:Date.now(),waitedAdmissions:0,status:"queued" as const};
   const competitors=q.entries.filter(e=>e.operationId!==input.operationId&&(e.identityScopeId===input.identityScopeId||e.projectId===input.projectId)).filter(e=>{try{return this.eligible(e,input.identityScopeId);}catch{return false;}});
   if(competitors.some(e=>this.compareQueue(e,candidate,Date.now())<0))return{status:"waiting"};
   const before=this.read(file,input.identityScopeId)??null,queueBefore=structuredClone(q);
   ledger.reservations.push({operationId:input.operationId,projectId:input.projectId,ownerId:input.ownerId,status:"reserved",admittedAt:Date.now(),admissionClass:input.admissionClass??"business"});
   // Admission, not polling or unrelated accounts, advances the persisted starvation bound.
   if(queued)queued.status="admitted";
   for(const e of competitors)e.waitedAdmissions++;
   if(queued||competitors.length)this.publishAdmission(input.identityScopeId,input.operationId,before,ledger,queueBefore,q);
   else this.write(file,ledger);
   return{status:"reserved"};
  });
 }
 configure(scope:string,limit:number,sourceRef:string):{status:"configured"|"busy"} {
  if(!Number.isInteger(limit)||limit<1||limit>1000||!nonempty(sourceRef))throw new Error("Capacity configuration requires valid limit and host source");
  return this.locked(scope,file=>{const ledger=this.read(file,scope)??{version:2 as const,identityScopeId:scope,limit,reservations:[]};ledger.limit=limit;ledger.configurationSource=sourceRef;this.write(file,ledger);return{status:"configured" as const};});
 }
 markUnknown(scope:string,operationId:string,reason:string):Result {
  return this.locked(scope,file=>{const ledger=this.read(file,scope),r=ledger?.reservations.find(r=>r.operationId===operationId);if(!ledger||!r||r.status==="released")throw new Error("Unknown reservation cannot be restored implicitly");r.status="unknown";r.reason=reason.slice(0,400);this.write(file,ledger);return{status:"unknown"};});
 }
 release(scope:string,operationId:string,proof:ReleaseProof):Result {
  if(!proof||!["completed","not-executed"].includes(proof.outcome)||!nonempty(proof.sourceRef))throw new Error("Release requires observed terminal source");
  return this.locked(scope,file=>{const ledger=this.read(file,scope),r=ledger?.reservations.find(r=>r.operationId===operationId);if(!ledger||!r)throw new Error("Missing reservation");if(r.status==="released"){if(JSON.stringify(r.release)!==JSON.stringify(proof))throw new Error("Conflicting release source");return{status:"released"};}if(proof.outcome==="not-executed"&&r.usage)throw new Error("Cannot refund observed native usage");r.status="released";r.endedAt=Date.now();r.release={...proof};this.write(file,ledger);return{status:"released"};});
 }
 inspect(scope:string):Ledger|undefined|{status:"busy"} {return this.locked(scope,file=>this.read(file,scope));}
 snapshot(scope:string):Ledger {const value=this.locked(scope,file=>this.read(file,scope));if(!value||"status" in value)throw new Error("Shared ledger unavailable or busy");return value;}
}
