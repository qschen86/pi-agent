import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { RuntimeStore } from "../src/store.js";
import type { SessionBinding, OperationRecord, ApprovalRequest, UsageRecord } from "../src/types.js";
const dirs: string[]=[]; const root=()=>{const dir=mkdtempSync(join(tmpdir(),"store-concurrency-"));dirs.push(dir);return dir;};
afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));
const binding=(id:string):SessionBinding=>({platformSessionId:id,runtimeKind:"codex",runtimeProfileId:"profile",hostId:"host",identityScopeId:"account",nativeSessionId:"native-"+id,sourceMode:"platform-managed",executionMode:"runtime-native",title:id,workspace:"/tmp",permissionLabel:"protected",createdAt:{at:"2026-10-03T00:00:00Z",source:"platform"},lastActivityAt:{at:"2026-10-03T00:00:00Z",source:"platform"},bindingRevision:1,creationOperationId:"op-"+id,status:"unknown",observation:"live",turns:[],coverage:"unknown"});
const operation=(id:string):OperationRecord=>({operationId:id,idempotencyKey:"key-"+id,kind:"create",platformSessionId:"session",state:"unknown",createdAt:"2026-10-03T00:00:00Z",updatedAt:"2026-10-03T00:00:00Z",steps:[]});
it("preserves separately created bindings and discovers another store's native identity without restart",()=>{
 const dir=root(),a=new RuntimeStore(dir),b=new RuntimeStore(dir);a.putBinding(binding("one"));b.putBinding(binding("two"));
 expect(new RuntimeStore(dir).allBindings().map(x=>x.platformSessionId).sort()).toEqual(["one","two"]);
 expect(a.binding("two")?.status).toBe("unknown");expect(b.findByNative("codex","host","native-one")?.platformSessionId).toBe("one");
});
it("checks the persisted binding revision before calling a stale writer",()=>{
 const dir=root(),a=new RuntimeStore(dir);a.putBinding(binding("one"));const b=new RuntimeStore(dir);a.updateBinding("one",x=>{x.title="confirmed title"},1);
 let called=false;expect(()=>b.updateBinding("one",x=>{called=true;x.title="stale title"},1)).toThrow(/更新|冲突/);expect(called).toBe(false);
 expect(new RuntimeStore(dir).binding("one")).toMatchObject({title:"confirmed title",bindingRevision:2});
});
it("flushes only pending activity without reverting authority or resurrecting a deleted binding",()=>{
 const dir=root(),a=new RuntimeStore(dir);a.putBinding(binding("one"));const b=new RuntimeStore(dir);
 a.updateBinding("one",x=>{x.lastActivityAt={at:"2026-10-03T01:00:00Z",source:"runtime"}},undefined,{bump:false,persist:false});
 b.updateBinding("one",x=>{x.title="human title";x.requestedModel="confirmed-model"},1);b.putBinding(binding("two"));a.flushBindings();
 expect(new RuntimeStore(dir).binding("one")).toMatchObject({title:"human title",requestedModel:"confirmed-model",bindingRevision:2,lastActivityAt:{at:"2026-10-03T01:00:00Z",source:"runtime"}});
 expect(new RuntimeStore(dir).binding("two")).toBeDefined();
 a.updateBinding("one",x=>{x.lastActivityAt={at:"2026-10-03T02:00:00Z",source:"runtime"}},undefined,{bump:false,persist:false});b.deleteBinding("one");a.flushBindings();expect(new RuntimeStore(dir).binding("one")).toBeUndefined();
});
it("appends operation steps from current disk state and rejects competing idempotency identities",()=>{
 const dir=root(),a=new RuntimeStore(dir);a.putOperation(operation("one"));const b=new RuntimeStore(dir);
 a.stepOperation("one","native-turn","turn-one");b.stepOperation("one","terminal","observed", "confirmed");
 expect(new RuntimeStore(dir).operation("one")?.steps.map(s=>s.step)).toEqual(["native-turn","terminal"]);
 expect(a.operation("one")?.state).toBe("confirmed");b.putOperation(operation("two"));expect(a.operation("two")).toBeDefined();
 expect(()=>a.putOperation({...operation("other"),idempotencyKey:"key-one"})).toThrow(/幂等|冲突/);
 expect(new RuntimeStore(dir).allOperations()).toHaveLength(2);
});
it("rejects a second stale approval decision rather than overwriting the first",()=>{
 const dir=root(),a=new RuntimeStore(dir);const approval:ApprovalRequest={approvalId:"approval",platformSessionId:"session",turnNo:1,nativeRequestId:"native-request",kind:"command",title:"command",action:"read",scope:"input",source:"native",paramsDigest:"digest",createdAt:"2026-10-03T00:00:00Z",expiresAt:"2026-10-03T01:00:00Z",bindingRevision:1,state:"pending"};a.putApproval(approval);const b=new RuntimeStore(dir);
 const first=a.approval("approval")!,second=b.approval("approval")!;first.state="approved";a.putApproval(first);second.state="denied";
 expect(()=>b.putApproval(second)).toThrow(/更新|冲突/);expect(new RuntimeStore(dir).approval("approval")?.state).toBe("approved");
});
it("retains usage from separate writers while deduplicating the exact same request",()=>{
 const dir=root(),a=new RuntimeStore(dir),b=new RuntimeStore(dir);const usage=(id:string):UsageRecord=>({usageScope:"request",counterMode:"delta",raw:{tokens:3},total:3,semantics:"fixture",sourceRef:"native:"+id,requestId:id,sampledAt:"2026-10-03T00:00:00Z",reliability:"complete"});
 a.addUsage("session",usage("one"));b.addUsage("session",usage("two"));a.addUsage("session",usage("one"));
 expect(b.usageFor("session").map(x=>x.requestId).sort()).toEqual(["one","two"]);expect(new RuntimeStore(dir).usageFor("session")).toHaveLength(2);
});
it("does not replace corrupt binding authority with an empty table",()=>{
 const dir=root(),a=new RuntimeStore(dir);a.putBinding(binding("one"));const file=join(a.dir,"bindings.json");writeFileSync(file,"broken authority");
 expect(()=>new RuntimeStore(dir)).toThrow();expect(readFileSync(file,"utf8")).toBe("broken authority");
});
it("atomically retains eight process writers and one stable host identity",async()=>{
 const dir=root(),module=fileURLToPath(new URL("../src/store.ts",import.meta.url)),template=binding("template");
 const script=`import {RuntimeStore} from ${JSON.stringify(module)};let s;for(let n=0;n<200;n++){try{s=new RuntimeStore(process.argv[1]);s.putBinding({...${JSON.stringify(template)},platformSessionId:"session-"+process.argv[2],nativeSessionId:"native-"+process.argv[2]});break}catch(e){if(e.code!=="RT_STORE_BUSY")throw e;await new Promise(r=>setTimeout(r,5))}}if(!s.binding("session-"+process.argv[2]))throw new Error("not persisted");process.stdout.write(s.host.hostId);`;
 const hosts=await Promise.all(Array.from({length:8},(_,i)=>new Promise<string>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script,dir,String(i)],{stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);child.on("error",reject);child.on("close",code=>code===0?resolve(out):reject(new Error(err)));})));
 expect(new Set(hosts).size).toBe(1);expect(new RuntimeStore(dir).allBindings()).toHaveLength(8);
},15000);

it("does not regress newer activity or allow a bookkeeping patch to change native authority",()=>{
 const dir=root(),a=new RuntimeStore(dir);a.putBinding(binding("one"));const b=new RuntimeStore(dir);
 a.updateBinding("one",x=>{x.lastActivityAt={at:"2026-10-03T01:00:00Z",source:"runtime"}},undefined,{bump:false,persist:false});
 b.updateBinding("one",x=>{x.lastActivityAt={at:"2026-10-03T02:00:00Z",source:"runtime"}},undefined,{bump:false});a.flushBindings();
 expect(a.binding("one")?.lastActivityAt.at).toBe("2026-10-03T02:00:00Z");
 expect(()=>a.updateBinding("one",x=>{x.nativeSessionId="foreign-native"},undefined,{bump:false,persist:false})).toThrow();a.flushBindings();expect(new RuntimeStore(dir).binding("one")?.nativeSessionId).toBe("native-one");
});
it("rejects an old binding object even when bookkeeping did not bump its human revision",()=>{
 const dir=root(),a=new RuntimeStore(dir);a.putBinding(binding("one"));const b=new RuntimeStore(dir),stale=b.binding("one")!;
 a.updateBinding("one",x=>{x.statusReason="native terminal unconfirmed"},undefined,{bump:false});stale.title="stale overwrite";
 expect(()=>b.putBinding(stale)).toThrow(/冲突/);expect(new RuntimeStore(dir).binding("one")).toMatchObject({title:"one",statusReason:"native terminal unconfirmed",bindingRevision:1});
});

/** 另一个存活进程占着主机互斥锁一段时间，模拟部署切槽时旧槽还在写存储。 */
async function holdFromAnotherProcess(dir: string, holdMs: number) {
  const module = fileURLToPath(new URL("../src/host-mutex.ts", import.meta.url));
  const script = `import {withHostMutex} from ${JSON.stringify(module)};withHostMutex(process.argv[1],()=>{process.stdout.write("HELD");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${holdMs})});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dir], { stdio: ["ignore", "pipe", "pipe"] });
  let error = "";
  child.stderr.on("data", (b) => error += b);
  const closed = new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", () => resolve()); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("close", () => reject(new Error(error || "owner exited before acquisition")));
  });
  return closed;
}
it("waits out another live process's brief critical section instead of failing startup", async () => {
  const dir = root();
  const closed = await holdFromAnotherProcess(dir, 250);
  // 旧槽正在写存储：以前这里直接抛 RT_STORE_BUSY 退出进程，现在应短暂等待后正常起来。
  const store = new RuntimeStore(dir);
  store.putBinding(binding("one"));
  expect(new RuntimeStore(dir).allBindings().map((x) => x.platformSessionId)).toEqual(["one"]);
  await closed;
}, 20000);
it("retries a contended read path instead of throwing into a timer callback", async () => {
  const dir = root();
  new RuntimeStore(dir).putBinding(binding("one"));
  const closed = await holdFromAnotherProcess(dir, 250);
  expect(new RuntimeStore(dir).allBindings()).toHaveLength(1);
  await closed;
}, 20000);
it("fails immediately on an ownerless admission lock instead of waiting for it to clear", () => {
  const dir = root();
  const store = new RuntimeStore(dir);
  mkdirSync(join(store.dir, "admission.lock"));
  const started = Date.now();
  expect(() => store.putBinding(binding("two"))).toThrow(/其他宿主写入/);
  expect(Date.now() - started).toBeLessThan(200);
});
