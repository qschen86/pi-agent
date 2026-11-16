import { existsSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { hostname } from 'node:os';
import type { SessionBinding } from '../../../../packages/runtime-sessions/src/types.js';
import { atomicWrite, MemoryStore } from './store.js';
import { RuntimeMemoryPort, type MemoryPort } from './port.js';
import { syncMemory } from './sync.js';
import { MemoryError, type MemoryTrigger } from './types.js';
interface MemoryRuntime {
 store:{binding(id:string):SessionBinding|undefined;allBindings():SessionBinding[]};
 on(event:string,listener:(event:any)=>void):unknown; off(event:string,listener:(event:any)=>void):unknown;
}
export interface MemoryJob {
 id:string;workspace:string;repositoryRoot?:string;trigger:MemoryTrigger;state:'queued'|'running'|'succeeded'|'failed'|'skipped';attempts:number;createdAt:number;nextAttemptAt:number;finishedAt?:number;lastError:string|null;owner?:{host:string;pid:number;instance:string};rerun?:boolean;
}
interface Queue {version:1;bootstrapped:boolean;jobs:MemoryJob[]}
const terminal=(j:MemoryJob)=>['succeeded','failed','skipped'].includes(j.state);
const retry=[30000,120000,600000,3600000];
const errorCode=(e:unknown)=>e instanceof MemoryError?e.code:'storage-error';
export class MemorySyncService {
 readonly store:MemoryStore;
 private readonly instance=randomUUID();
 private timer:ReturnType<typeof setInterval>|undefined;
 private controller:AbortController|undefined;
 private busy=false; private started=false; private stopped=false;private queueError:string|null=null;
 private notConfiguredUntil=0;
 constructor(private readonly options:{root:string;runtime:MemoryRuntime;enabled?:boolean;port?:MemoryPort;now?:()=>number}){this.store=new MemoryStore(options.root,()=>new Date(this.now()));}
 get enabled():boolean{return this.options.enabled??process.env['PI_AGENT_MEMORY_SYNC']==='on';}
 private now():number{return this.options.now?.()??Date.now();}
 private readQueue():Queue {
  const file=join(this.options.root,'jobs.json');if(!existsSync(file))return {version:1,bootstrapped:false,jobs:[]};
  try{
   const q=JSON.parse(readFileSync(file,'utf8')) as Queue;
   if(q.version!==1 || typeof q.bootstrapped!=='boolean' || !Array.isArray(q.jobs) || q.jobs.length>500 || q.jobs.some(j=>!j || typeof j.id!=='string' || typeof j.workspace!=='string' || !isAbsolute(j.workspace) || !['queued','running','succeeded','failed','skipped'].includes(j.state) || !Number.isInteger(j.attempts) || j.attempts<0 || !Number.isFinite(j.nextAttemptAt) || !j.trigger || j.trigger.workspace!==j.workspace))throw new Error();
   return q;
  }catch{throw new MemoryError('storage-error');}
 }
 private mutate<T>(fn:(q:Queue)=>T):T{
  return this.store.locked(()=>{const q=this.readQueue();const result=fn(q);atomicWrite(join(this.options.root,'jobs.json'),JSON.stringify(q)+'\n');return result;});
 }
 private enqueueIn(q:Queue,trigger:MemoryTrigger,repositoryRoot?:string):MemoryJob {
  const now=this.now(),existing=q.jobs.find(j=>j.workspace===trigger.workspace && !terminal(j));
  if(existing){existing.nextAttemptAt=Math.max(existing.nextAttemptAt,now+2000);if(existing.state==='running')existing.rerun=true;return existing;}
  q.jobs=q.jobs.filter(j=>!terminal(j) || (j.finishedAt??now)>now-7*86400000);
  while(q.jobs.length>=500){const index=q.jobs.findIndex(terminal);if(index<0)throw new MemoryError('busy');q.jobs.splice(index,1);}
  const job:MemoryJob={id:randomUUID(),workspace:trigger.workspace,...(repositoryRoot?{repositoryRoot}:{}),trigger,state:'queued',attempts:0,createdAt:now,nextAttemptAt:now+2000,lastError:null};q.jobs.push(job);return job;
 }
 enqueue(trigger:MemoryTrigger,repositoryRoot?:string):MemoryJob {
  if(!this.enabled)throw new MemoryError('disabled');
  if(!isAbsolute(trigger.workspace) || trigger.workspace.length>4096 || repositoryRoot!==undefined && !isAbsolute(repositoryRoot))throw new MemoryError('invalid-workspace');
  return this.mutate(q=>this.enqueueIn(q,trigger,repositoryRoot));
 }
 enqueueSession(sessionId:string,kind:MemoryTrigger['kind']='manual'):MemoryJob|null {
  const b=this.options.runtime.store.binding(sessionId);
  if(!b || b.runtimeKind!=='pi' || kind==='archive' && !b.archived)return null;
  return this.enqueue({kind,platformSessionId:sessionId,workspace:b.workspace,at:new Date(this.now()).toISOString()},b.worktree?.repoRoot);
 }
 private archive=(event:{platformSessionId:string})=>{
  try{
   const b=this.options.runtime.store.binding(event.platformSessionId);
   if(!b || b.runtimeKind!=='pi' || !b.archived)return;
   // UUID publication needs no shared mutex; a busy queue cannot drop an archive trigger.
   const dir=join(this.options.root,'inbox');mkdirSync(dir,{recursive:true,mode:0o700});
   const trigger:MemoryTrigger={kind:'archive',platformSessionId:b.platformSessionId,workspace:b.workspace,at:new Date(this.now()).toISOString()};
   atomicWrite(join(dir,randomUUID()+'.json'),JSON.stringify({trigger,repositoryRoot:b.worktree?.repoRoot})+'\n');
  }catch(e){this.queueError=errorCode(e);}
 };
 private drainInbox():void {
  const dir=join(this.options.root,'inbox');if(!existsSync(dir))return;
  const files=readdirSync(dir).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).slice(0,500);
  if(!files.length)return;
  this.mutate(q=>{
   for(const file of files){
    if(!existsSync(join(dir,file)))continue;
    const item=JSON.parse(readFileSync(join(dir,file),'utf8')) as {trigger:MemoryTrigger;repositoryRoot?:string};
    if(!item.trigger || item.trigger.kind!=='archive' || !isAbsolute(item.trigger.workspace) || typeof item.trigger.platformSessionId!=='string')throw new MemoryError('storage-error');
    this.enqueueIn(q,item.trigger,item.repositoryRoot);
   }
  });
  for(const file of files){try{unlinkSync(join(dir,file));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 }

 private bootstrap(q:Queue):void {
   if(!q.bootstrapped){
    const seen=new Set<string>();
    for(const b of this.options.runtime.store.allBindings()){
     if(b.runtimeKind!=='pi' || !b.archived || seen.has(b.workspace) || q.jobs.some(j=>j.workspace===b.workspace))continue;
     if(seen.size>=50)break;seen.add(b.workspace);
     this.enqueueIn(q,{kind:'startup',workspace:b.workspace,platformSessionId:b.platformSessionId,at:new Date(this.now()).toISOString()},b.worktree?.repoRoot);
    }
    q.bootstrapped=true;
   }
 }
 start():void {
  if(!this.enabled || this.started)return;
  this.started=true;this.stopped=false;
  this.options.runtime.on('archived',this.archive);this.options.runtime.on('shutdown',this.stop);
  try{this.mutate(q=>{
   this.bootstrap(q);
  });}catch(e){this.queueError=errorCode(e);}
  this.timer=setInterval(()=>{void this.runNext().catch(e=>{this.queueError=errorCode(e);});},1000);this.timer.unref();
 }
 stop=():void=>{
  this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;
  this.controller?.abort();this.options.runtime.off('archived',this.archive);this.options.runtime.off('shutdown',this.stop);this.started=false;
 };
 async runNext():Promise<void>{
  if(!this.enabled || this.stopped || this.busy)return;
  this.busy=true;
  let job:MemoryJob|undefined;
  try{
   this.drainInbox();
   job=this.mutate(q=>{
    this.bootstrap(q);
    for(const j of q.jobs.filter(j=>j.state==='running')){
     if(j.owner?.instance===this.instance){j.state='queued';j.attempts=Math.max(0,j.attempts-1);j.nextAttemptAt=this.now();delete j.owner;continue;}
     if(j.owner?.host!==hostname())continue;
     let dead=false;try{process.kill(j.owner.pid,0);}catch(e){dead=(e as NodeJS.ErrnoException).code==='ESRCH';}
     if(dead){j.state='queued';delete j.owner;}
    }
    // A live other slot owns the worker. A foreign/unreadable owner fences recovery.
    if(q.jobs.some(j=>j.state==='running'))return;
    const next=q.jobs.find(j=>j.state==='queued' && j.nextAttemptAt<=this.now());if(!next)return;
    next.state='running';next.attempts++;next.owner={host:hostname(),pid:process.pid,instance:this.instance};return structuredClone(next);
   });
   if(!job)return;
   this.controller=new AbortController();let failure:string|null=null, skipped=false;
   try{
    if(job.trigger.kind!=='manual' && this.now()<this.notConfiguredUntil)throw new MemoryError('not-configured');
    await syncMemory(this.store,this.options.port??new RuntimeMemoryPort(),job.trigger,job.repositoryRoot,this.controller.signal);
   }catch(e){failure=errorCode(e);skipped=['not-configured','not-initialized'].includes(failure);if(failure==='not-configured')this.notConfiguredUntil=this.now()+300000;}
   this.mutate(q=>{
    const current=q.jobs.find(j=>j.id===job!.id);if(!current || current.owner?.instance!==this.instance)return;
    delete current.owner;current.lastError=failure;
    if(current.rerun){current.state='queued';current.attempts=0;current.nextAttemptAt=this.now()+2000;delete current.rerun;return;}
    if(this.stopped){current.state='queued';current.attempts--;current.nextAttemptAt=this.now();return;}
    if(!failure){current.state='succeeded';current.finishedAt=this.now();}
    else if(skipped){current.state='skipped';current.finishedAt=this.now();}
    else if(current.attempts>=5 || ['invalid-output','invalid-workspace'].includes(failure)){current.state='failed';current.finishedAt=this.now();}
    else{current.state='queued';current.nextAttemptAt=this.now()+retry[current.attempts-1]!;}
   });this.queueError=null;
  }finally{this.controller=undefined;this.busy=false;}
 }
 status():object {
  let jobs:MemoryJob[]=[];try{if(existsSync(join(this.options.root,'jobs.json')))jobs=this.readQueue().jobs;}catch(e){this.queueError=errorCode(e);}
  return {enabled:this.enabled,lastError:this.queueError,scopes:this.store.status(),queue:{queued:jobs.filter(j=>j.state==='queued').length,running:jobs.filter(j=>j.state==='running').length,failed:jobs.filter(j=>j.state==='failed').length},jobs:jobs.slice(-50).map(j=>({id:j.id,state:j.state,attempts:j.attempts,lastError:j.lastError,nextAttemptAt:j.state==='queued'?new Date(j.nextAttemptAt).toISOString():null}))};
 }
}
