import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {afterEach,expect,it,vi} from "vitest";
import {SharedSlots} from "../src/shared-slots.js";
const roots:string[]=[];const root=()=>{const p=mkdtempSync(join(tmpdir(),"shared-slots-"));roots.push(p);return p;};afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
const request=(operationId:string)=>({identityScopeId:"account-1",projectId:"project-1",ownerId:"host-one",operationId,limit:2});
it("shares durable capacity across store instances and keeps unknown work occupied",()=>{
 const dir=root(),a=new SharedSlots(dir),b=new SharedSlots(dir);expect(a.reserve(request("one")).status).toBe("reserved");expect(b.reserve(request("two")).status).toBe("reserved");
 a.markUnknown("account-1","one","native result lost");expect(new SharedSlots(dir).reserve(request("three")).status).toBe("full");
 expect(()=>a.release("account-1","one",{outcome:"completed",sourceRef:""})).toThrow(/source/);expect(b.reserve(request("three")).status).toBe("full");
 a.release("account-1","one",{outcome:"not-executed",sourceRef:"native:one:confirmed-not-sent"});expect(b.reserve(request("three")).status).toBe("reserved");expect(a.reserve(request("one")).status).toBe("released");expect(()=>b.reserve({...request("one"),projectId:"foreign-project"})).toThrow(/another project/);
 expect(()=>b.reserve({...request("four"),limit:3})).toThrow(/capacity/);
});
it("never resets corrupted authoritative reservations to an empty pool",()=>{
 const dir=root(),a=new SharedSlots(dir);a.reserve(request("one"));const file=join(dir,readdirSync(dir).find(p=>p.endsWith(".json"))!);writeFileSync(file,"broken ledger");expect(()=>new SharedSlots(dir).reserve(request("two"))).toThrow(/ledger/);expect(readFileSync(file,"utf8")).toBe("broken ledger");
});
it("atomically admits at most two native effects across eight separate processes",async()=>{
 const dir=root(),module=fileURLToPath(new URL("../src/shared-slots.ts",import.meta.url));
 // 完整测试并行运行时，持锁进程可能被调度暂停；等待明确结果，仍严格核对两次准入和六次拒绝。
 const script=`import {SharedSlots} from ${JSON.stringify(module)};const store=new SharedSlots(process.argv[1]);const deadline=Date.now()+10000;let result;do{result=store.reserve({identityScopeId:"account-1",projectId:"project-"+process.argv[2],operationId:"operation-"+process.argv[2],ownerId:"host-"+process.argv[2],limit:2});if(result.status!=="busy")break;await new Promise(r=>setTimeout(r,5));}while(Date.now()<deadline);process.stdout.write(JSON.stringify(result));`;
 const results=await Promise.all(Array.from({length:8},(_,i)=>new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script,dir,String(i)],{stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",b=>{out+=b;});child.stderr.on("data",b=>{err+=b;});child.on("error",reject);child.on("close",code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));})));
 expect(results.filter(r=>r.status==="reserved")).toHaveLength(2);expect(results.filter(r=>r.status==="full")).toHaveLength(6);expect(new SharedSlots(dir).snapshot("account-1").reservations.filter(r=>r.status!=="released")).toHaveLength(2);
});

it("never grants a second host dispatch ownership of the same reserved operation",()=>{
 const dir=root(),first=new SharedSlots(dir),second=new SharedSlots(dir);
 expect(first.reserve(request("same-operation")).status).toBe("reserved");
 expect(second.reserve({...request("same-operation"),ownerId:"host-two"}).status).toBe("owned");
 first.markUnknown("account-1","same-operation","first host lost response");
 expect(second.reserve({...request("same-operation"),ownerId:"host-two"}).status).toBe("unknown");
 expect(second.snapshot("account-1").reservations.filter(r=>r.status!=="released")).toHaveLength(1);
});
it('changes capacity only by explicit host configuration and preserves occupied unknown work on reduction',()=>{
 const dir=root(),slots=new SharedSlots(dir);slots.reserve(request('one'));slots.reserve(request('two'));slots.markUnknown('account-1','one','lost');
 expect(slots.configure('account-1',1,'human-settings:revision-2').status).toBe('configured');
 expect(slots.snapshot('account-1').reservations.filter(r=>r.status!=='released')).toHaveLength(2);
 expect(slots.reserve({...request('three'),limit:1}).status).toBe('full');
 expect(()=>slots.configure('account-1',3,'')).toThrow(/source/);
 expect(slots.configure('account-1',3,'human-settings:revision-3').status).toBe('configured');
 expect(slots.reserve({...request('three'),limit:3}).status).toBe('reserved');
});

it("reserves project total and business capacity atomically across distinct account scopes",()=>{
 const dir=root(),a=new SharedSlots(dir),b=new SharedSlots(dir),policy={concurrency:1,totalConcurrency:2,revision:1,sourceRef:"confirmed-project:revision-1"};
 const req=(op:string,scope:string,admissionClass:"business"|"evaluation")=>({...request(op),identityScopeId:scope,limit:8,admissionClass,projectPolicy:policy});
 expect(a.reserve(req("business-one","account-a","business")).status).toBe("reserved");
 expect(b.reserve(req("business-two","account-b","business")).status).toBe("full");
 expect(b.reserve(req("evaluation-one","account-b","evaluation")).status).toBe("reserved");
 expect(a.reserve(req("evaluation-two","account-c","evaluation")).status).toBe("full");
 a.markUnknown("account-a","business-one","lost-terminal");expect(a.reserve(req("evaluation-three","account-c","evaluation")).status).toBe("full");
 b.release("account-b","evaluation-one",{outcome:"completed",sourceRef:"native:verified-evaluation"});expect(a.reserve(req("evaluation-three","account-c","evaluation")).status).toBe("reserved");
 expect(a.snapshot("account-a").reservations.filter(r=>r.status!=="released")).toHaveLength(1);
});
it("fences stale project rules and never bypasses a configured project limit by omitting policy",()=>{
 const slots=new SharedSlots(root()),initial={...request("first"),limit:8,projectPolicy:{concurrency:2,totalConcurrency:2,revision:1,sourceRef:"project:1"}};
 slots.reserve(initial);
 const lowered={...initial,operationId:"held-after-lowering",identityScopeId:"other-account",projectPolicy:{...initial.projectPolicy,concurrency:1,totalConcurrency:1,revision:2,sourceRef:"project:2"}};
 expect(slots.reserve(lowered).status).toBe("full");
 expect(slots.reserve({...initial,operationId:"stale-increase",identityScopeId:"other-account"}).status).not.toBe("reserved");
 expect(slots.reserve({...request("omitted-policy"),limit:8,identityScopeId:"third-account"}).status).toBe("full");
});
it("atomically admits three project calls across eight processes with separate accounts",async()=>{
 const dir=root(),module=fileURLToPath(new URL("../src/shared-slots.ts",import.meta.url));
 const script=`import {SharedSlots} from ${JSON.stringify(module)};const store=new SharedSlots(process.argv[1]);let result;for(let n=0;n<100;n++){result=store.reserve({identityScopeId:"account-"+process.argv[2],projectId:"one-project",operationId:"operation-"+process.argv[2],ownerId:"host-"+process.argv[2],limit:8,admissionClass:"business",projectPolicy:{concurrency:8,totalConcurrency:3,revision:1,sourceRef:"approved-project:1"}});if(result.status!=="busy")break;await new Promise(r=>setTimeout(r,5));}process.stdout.write(JSON.stringify(result));`;
 const results=await Promise.all(Array.from({length:8},(_,i)=>new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script,dir,String(i)],{stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);child.on("error",reject);child.on("close",code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));})));
 expect(results.filter(r=>r.status==="reserved")).toHaveLength(3);expect(results.filter(r=>r.status==="full")).toHaveLength(5);
});

it("keeps a corrupted account held without blocking an independently indexed project",()=>{
 const dir=root(),slots=new SharedSlots(dir),policy={concurrency:2,totalConcurrency:2,revision:1,sourceRef:"host-project:1",existingScopes:[]};
 slots.reserve({...request("broken-one"),identityScopeId:"broken-account",projectId:"broken-project",projectPolicy:policy});
 slots.reserve({...request("healthy-one"),identityScopeId:"healthy-account",projectId:"healthy-project",projectPolicy:policy});
 const file=readdirSync(dir).filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).map(f=>join(dir,f)).find(f=>JSON.parse(readFileSync(f,"utf8")).identityScopeId==="broken-account")!;writeFileSync(file,"corrupt-source");
 expect(slots.reserve({...request("healthy-two"),identityScopeId:"another-healthy-account",projectId:"healthy-project",projectPolicy:policy}).status).toBe("reserved");
 expect(slots.reserve({...request("new-project-one"),identityScopeId:"third-healthy-account",projectId:"new-project",projectPolicy:policy}).status).toBe("reserved");
 expect(()=>slots.reserve({...request("broken-two"),identityScopeId:"new-account",projectId:"broken-project",projectPolicy:policy})).toThrow();expect(readFileSync(file,"utf8")).toBe("corrupt-source");
});


it("prioritizes shared evaluator intents across hosts while preserving same-class FIFO",()=>{
 const slots=new SharedSlots(root());
 const req=(id:string,kind:"business"|"evaluation")=>({...request(id),limit:1,admissionClass:kind});
 slots.reserve(req("active","business"));
 const business=req("business","business"),eval1=req("eval-first","evaluation"),eval2=req("eval-second","evaluation");
 for(const r of [business,eval1,eval2])expect(slots.enqueue(r,true).status).toBe("queued");
 expect(slots.snapshot("account-1").reservations).toHaveLength(1);
 slots.release("account-1","active",{outcome:"completed",sourceRef:"native:active:terminal"});
 expect(slots.reserve(business).status).toBe("waiting");expect(slots.reserve(eval2).status).toBe("waiting");
 expect(slots.reserve(eval1).status).toBe("reserved");
 slots.release("account-1","eval-first",{outcome:"completed",sourceRef:"native:eval-first:terminal"});
 expect(slots.reserve(eval2).status).toBe("reserved");
});
it("promotes eligible older business work after four competing admissions and persists its wait",()=>{
 const dir=root();let slots=new SharedSlots(dir);
 const req=(id:string,kind:"business"|"evaluation")=>({...request(id),limit:1,admissionClass:kind});
 const old=req("old-business","business");slots.enqueue(old,true);
 for(let i=0;i<4;i++){
  const next=req(`evaluation-${i}`,"evaluation");slots.enqueue(next,true);
  expect(slots.reserve(old).status).toBe("waiting");expect(slots.reserve(next).status).toBe("reserved");
  slots.release("account-1",next.operationId,{outcome:"completed",sourceRef:`native:${i}:terminal`});slots=new SharedSlots(dir);
 }
 const next=req("evaluation-after-bound","evaluation");slots.enqueue(next,true);
 expect(slots.reserve(next).status).toBe("waiting");expect(slots.reserve(old).status).toBe("reserved");
});
it("skips capacity-ineligible or host-paused queue heads without losing their arrival order",()=>{
 const slots=new SharedSlots(root()),policy={concurrency:1,totalConcurrency:2,revision:1,sourceRef:"project:1",existingScopes:[]};
 const req=(id:string,scope:string,kind:"business"|"evaluation")=>({...request(id),identityScopeId:scope,limit:8,admissionClass:kind,projectPolicy:policy});
 slots.reserve(req("active-business","a","business"));
 const blocked=req("older-business","b","business"),paused=req("paused-eval","b","evaluation"),evaluation=req("ready-eval","c","evaluation");
 slots.enqueue(blocked,true);slots.enqueue(paused,false);slots.enqueue(evaluation,true);
 expect(slots.reserve(evaluation).status).toBe("reserved");
 slots.release("c",evaluation.operationId,{outcome:"completed",sourceRef:"native:eval:terminal"});
 slots.enqueue(paused,true);expect(slots.reserve(paused).status).toBe("reserved");
});
it("retires only proven undispatched queue intents and fences another dispatch owner",()=>{
 const slots=new SharedSlots(root()),queued=request("cancel-me");slots.enqueue(queued,true);
 expect(slots.enqueue({...queued,ownerId:"other-host"},true).status).toBe("owned");
 expect(()=>slots.cancelQueued(queued.identityScopeId,queued.operationId,{outcome:"not-executed",sourceRef:""})).toThrow();
 expect(slots.cancelQueued(queued.identityScopeId,queued.operationId,{outcome:"not-executed",sourceRef:"host:cancelled-before-send"}).status).toBe("cancelled");
 expect(slots.enqueue(queued,true).status).toBe("cancelled");expect(slots.reserve(queued).status).toBe("cancelled");
 const active=request("active-effect");slots.enqueue(active,true);slots.reserve(active);slots.markUnknown(active.identityScopeId,active.operationId,"lost");
 expect(()=>slots.cancelQueued(active.identityScopeId,active.operationId,{outcome:"not-executed",sourceRef:"host:unproven"})).toThrow(/dispatched/);
});


it("promotes waiting work by elapsed time without expiring an unknown native reservation",()=>{
 const slots=new SharedSlots(root()),clock=vi.spyOn(Date,"now");
 try{
  clock.mockReturnValue(1000);const old={...request("old"),limit:1};slots.enqueue(old,true);
  clock.mockReturnValue(61_001);const evaluator={...request("eval"),limit:1,admissionClass:"evaluation" as const};slots.enqueue(evaluator,true);
  expect(slots.reserve(evaluator).status).toBe("waiting");expect(slots.reserve(old).status).toBe("reserved");slots.markUnknown("account-1","old","no terminal");
  clock.mockReturnValue(9_999_999);expect(slots.reserve(evaluator).status).toBe("full");expect(slots.snapshot("account-1").reservations[0].status).toBe("unknown");
 }finally{clock.mockRestore();}
});
it("uses global queue order when independent processes race for a shared account",async()=>{
 const dir=root(),slots=new SharedSlots(dir),module=fileURLToPath(new URL("../src/shared-slots.ts",import.meta.url));
 const business={...request("business-race"),ownerId:"business-host",limit:1},evaluation={...request("eval-race"),ownerId:"evaluation-host",limit:1,admissionClass:"evaluation" as const};
 slots.enqueue(business,true);slots.enqueue(evaluation,true);
 const script=`import {SharedSlots} from ${JSON.stringify(module)};const store=new SharedSlots(process.argv[1]),request=JSON.parse(process.argv[2]);let result;for(let n=0;n<100;n++){result=store.reserve(request);if(result.status!=="busy")break;await new Promise(r=>setTimeout(r,5));}process.stdout.write(JSON.stringify(result));`;
 const results=await Promise.all([business,evaluation].map(request=>new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script,dir,JSON.stringify(request)],{stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);child.on("error",reject);child.on("close",code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));})));
 expect(results[0].status).not.toBe("reserved");expect(results[1].status).toBe("reserved");expect(slots.snapshot("account-1").reservations.map(r=>r.operationId)).toEqual(["eval-race"]);
});
it("rejects changing a queued operation's class during reservation",()=>{
 const slots=new SharedSlots(root()),queued=request("frozen-class");slots.enqueue(queued,true);
 expect(()=>slots.reserve({...queued,admissionClass:"evaluation"})).toThrow(/intent/);expect(slots.inspect("account-1")).toBeUndefined();
});


it("shares a persistent project call budget across accounts and all admission classes",()=>{
 const dir=root(),slots=new SharedSlots(dir),policy={concurrency:8,totalConcurrency:8,revision:1,sourceRef:"project:budget:1",existingScopes:[],budget:{maxCalls:2}};
 const req=(id:string,scope:string,kind:"business"|"stage"|"coordinator"|"evaluation")=>({...request(id),identityScopeId:scope,limit:8,admissionClass:kind,projectPolicy:policy});
 expect(slots.reserve(req("stage","a","stage")).status).toBe("reserved");slots.release("a","stage",{outcome:"completed",sourceRef:"native:stage:terminal"});
 expect(slots.reserve(req("coordinator","b","coordinator")).status).toBe("reserved");slots.markUnknown("b","coordinator","lost response");
 const fresh=new SharedSlots(dir);expect(fresh.reserve(req("evaluation","c","evaluation")).status).toBe("budget-exhausted");expect(fresh.reserve(req("business","c","business")).status).toBe("budget-exhausted");
 expect(fresh.projectUsage("project-1").calls.used).toBe(2);expect(fresh.projectUsage("project-1").tokens.coverage).toBe("not_collected");
 expect(fresh.reserve({...req("independent","c","business"),projectId:"another-project"}).status).toBe("reserved");
});
it("refunds only proven not-executed calls and retains metering through budget increases",()=>{
 const slots=new SharedSlots(root()),base={...request("never-sent"),projectPolicy:{concurrency:2,totalConcurrency:2,revision:1,sourceRef:"project:budget:1",existingScopes:[],budget:{maxCalls:1}}};
 slots.reserve(base);slots.release("account-1","never-sent",{outcome:"not-executed",sourceRef:"host:role-missing"});expect(slots.projectUsage("project-1").calls.used).toBe(0);
 expect(slots.reserve({...base,operationId:"actual-call"}).status).toBe("reserved");slots.release("account-1","actual-call",{outcome:"completed",sourceRef:"native:actual:terminal"});
 expect(slots.reserve({...base,operationId:"too-many"}).status).toBe("budget-exhausted");
 expect(slots.reserve({...base,operationId:"authorized-more",projectPolicy:{...base.projectPolicy,revision:2,sourceRef:"project:budget:2",budget:{maxCalls:2}}}).status).toBe("reserved");expect(slots.projectUsage("project-1").calls.used).toBe(2);
});
it("meters execution wall time without charging queue wait or treating unknown token/cost usage as zero",()=>{
 const slots=new SharedSlots(root()),clock=vi.spyOn(Date,"now");
 try{
  clock.mockReturnValue(1000);const first={...request("first"),projectPolicy:{concurrency:2,totalConcurrency:2,revision:1,sourceRef:"project:wall:1",existingScopes:[],budget:{maxWallTimeMs:100}}};
  slots.enqueue(first,false);clock.mockReturnValue(20_000);expect(slots.projectUsage("project-1").wallTimeMs.observed).toBe(0);
  slots.enqueue(first,true);slots.reserve(first);clock.mockReturnValue(20_101);slots.markUnknown("account-1","first","lost terminal");
  expect(slots.reserve({...first,operationId:"second"}).status).toBe("budget-exhausted");expect(slots.projectUsage("project-1").wallTimeMs.observed).toBe(101);
  const tokens={...first,projectId:"token-project",operationId:"token-call",projectPolicy:{...first.projectPolicy,budget:{maxTokens:1000}}};expect(slots.reserve(tokens).status).toBe("budget-unknown");
  expect(slots.reserve({...tokens,projectId:"cost-project",operationId:"cost-call",projectPolicy:{...tokens.projectPolicy,budget:{maxReportedCostUsd:1}}}).status).toBe("budget-unknown");
 }finally{clock.mockRestore();}
});
it("atomically holds a two-call project budget across eight independent accounts/processes",async()=>{
 const dir=root(),module=fileURLToPath(new URL("../src/shared-slots.ts",import.meta.url));
 const script=`import {SharedSlots} from ${JSON.stringify(module)};const slots=new SharedSlots(process.argv[1]);let result;for(let i=0;i<100;i++){result=slots.reserve({identityScopeId:"a-"+process.argv[2],projectId:"budget-project",ownerId:"h-"+process.argv[2],operationId:"o-"+process.argv[2],limit:8,projectPolicy:{concurrency:8,totalConcurrency:8,revision:1,sourceRef:"approved:budget",budget:{maxCalls:2}}});if(result.status!=="busy")break;await new Promise(r=>setTimeout(r,5));}process.stdout.write(JSON.stringify(result));`;
 const results=await Promise.all(Array.from({length:8},(_,i)=>new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script,dir,String(i)],{stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);child.on("error",reject);child.on("close",code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));})));
 expect(results.filter(r=>r.status==="reserved")).toHaveLength(2);expect(results.filter(r=>r.status==="budget-exhausted")).toHaveLength(6);expect(new SharedSlots(dir).projectUsage("budget-project").calls.used).toBe(2);
});

it("recovers a killed admission owner without refunding unknown native work or admitting duplicate recovery callers",async()=>{
 const dir=root(),module=fileURLToPath(new URL("../src/shared-slots.ts",import.meta.url));
 // Kill after an actual fsynced ledger publication while its host mutex is held.
 const crash=`import {SharedSlots} from ${JSON.stringify(module)};const s=new SharedSlots(process.argv[1]);s.reserve({identityScopeId:"account-1",projectId:"project-1",ownerId:"dead-host",operationId:"unknown-effect",limit:2});s.markUnknown("account-1","unknown-effect","native terminal lost");const write=s.write.bind(s);s.write=(...args)=>{write(...args);process.kill(process.pid,"SIGKILL")};s.configure("account-1",2,"confirmed-settings:1");`;
 const killed=await new Promise<{code:number|null;signal:string|null;error:string}>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",crash,dir],{stdio:["ignore","ignore","pipe"]});let error="";child.stderr.on("data",b=>error+=b);child.on("error",reject);child.on("close",(code,signal)=>resolve({code,signal,error}));});
 expect(killed.error).toBe("");expect(killed.signal).toBe("SIGKILL");
 const recover=`import {SharedSlots} from ${JSON.stringify(module)};const s=new SharedSlots(process.argv[1]);let r;for(let n=0;n<200;n++){r=s.reserve({identityScopeId:"account-1",projectId:"project-1",ownerId:"host-"+process.argv[2],operationId:"recovered-"+process.argv[2],limit:2});if(r.status!=="busy")break;await new Promise(r=>setTimeout(r,5));}process.stdout.write(JSON.stringify(r));`;
 const outcomes=await Promise.all(Array.from({length:8},(_,i)=>new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",recover,dir,String(i)],{stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);child.on("error",reject);child.on("close",code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));})));
 expect(outcomes.filter(r=>r.status==="reserved")).toHaveLength(1);expect(outcomes.filter(r=>r.status==="full")).toHaveLength(7);
 const records=new SharedSlots(dir).snapshot("account-1").reservations;expect(records).toHaveLength(2);expect(records.find(r=>r.operationId==="unknown-effect")).toMatchObject({status:"unknown",reason:"native terminal lost",ownerId:"dead-host"});
},15000);
