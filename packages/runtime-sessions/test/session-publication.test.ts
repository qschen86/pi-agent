import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { RuntimeStore } from "../src/store.js";
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));
for(const kind of ["create","turn"] as const)it(`recovers the exact ${kind} binding and operation after process death between file publications`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),"session-publication-"));dirs.push(dir);const fixture=fileURLToPath(new URL("./fixtures/session-publication-crash.mts",import.meta.url));
 const result=await new Promise<{signal:string|null;error:string}>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx",fixture,dir,kind],{stdio:["ignore","ignore","pipe"]});let error="";child.stderr.on("data",b=>error+=b);child.on("error",reject);child.on("close",(_,signal)=>resolve({signal,error}));});
 expect(result.error).toBe("");expect(result.signal).toBe("SIGKILL");
 const store=new RuntimeStore(join(dir,"data")),binding=store.allBindings()[0]!;expect(store.allBindings()).toHaveLength(1);
 const operation=store.operationByKey(kind==="create"?"crash-create-key":"crash-turn-key");expect(operation).toBeDefined();expect(store.allOperations()).toHaveLength(kind==="create"?1:2);
 expect(operation).toMatchObject({platformSessionId:binding.platformSessionId,kind,state:"prepared",turnNo:kind==="create"?1:2});
 expect(binding.turns).toHaveLength(kind==="create"?1:2);const turn=binding.turns.at(-1)!;expect(turn).toMatchObject({operationId:operation!.operationId,turnNo:operation!.turnNo,status:"queued"});expect(turn.clientMessageId).toMatch(/^[a-f0-9-]{36}$/);
 if(kind==="create")expect(binding.nativeSessionId).toBeUndefined();else expect(binding.nativeSessionId).toMatch(/^native-/);
 const again=new RuntimeStore(join(dir,"data"));expect(again.operationByKey(operation!.idempotencyKey)?.operationId).toBe(operation!.operationId);expect(again.binding(binding.platformSessionId)?.turns.at(-1)?.clientMessageId).toBe(turn.clientMessageId);
},15000);
it("rejects an invalid runtime in a surviving journal without publishing its missing operation",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"session-publication-invalid-"));dirs.push(dir);const fixture=fileURLToPath(new URL("./fixtures/session-publication-crash.mts",import.meta.url));
 await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx",fixture,dir,"create"],{stdio:["ignore","ignore","pipe"]});let err="";child.stderr.on("data",b=>err+=b);child.on("error",reject);child.on("close",(_,signal)=>signal==="SIGKILL"&&!err?resolve():reject(new Error(err||String(signal))));});
 const runtime=join(dir,"data","runtime"),journal=join(runtime,"session-publication.json"),bindings=join(runtime,"bindings.json");
 const intent=JSON.parse(readFileSync(journal,"utf8")),records=JSON.parse(readFileSync(bindings,"utf8"));intent.binding.after.runtimeKind="unsupported-runtime";records[intent.binding.after.platformSessionId].runtimeKind="unsupported-runtime";
 writeFileSync(journal,JSON.stringify(intent));writeFileSync(bindings,JSON.stringify(records));
 expect(()=>new RuntimeStore(join(dir,"data"))).toThrow();expect(()=>readFileSync(join(runtime,"operations.json"),"utf8")).toThrow();expect(JSON.parse(readFileSync(journal,"utf8")).transactionId).toBe(intent.transactionId);
},15000);
it("keeps a conflicting operation and surviving journal intact instead of overwriting another source",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"session-publication-conflict-"));dirs.push(dir);const fixture=fileURLToPath(new URL("./fixtures/session-publication-crash.mts",import.meta.url));
 await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx",fixture,dir,"create"],{stdio:["ignore","ignore","pipe"]});let err="";child.stderr.on("data",b=>err+=b);child.on("error",reject);child.on("close",(_,signal)=>signal==="SIGKILL"&&!err?resolve():reject(new Error(err||String(signal))));});
 const runtime=join(dir,"data","runtime"),journal=join(runtime,"session-publication.json"),operations=join(runtime,"operations.json"),intent=JSON.parse(readFileSync(journal,"utf8"));
 const foreign={...intent.operation.after,idempotencyKey:"foreign-operation-key",state:"unknown"},source=JSON.stringify({[foreign.operationId]:foreign});writeFileSync(operations,source);
 expect(()=>new RuntimeStore(join(dir,"data"))).toThrow(/冲突/);expect(readFileSync(operations,"utf8")).toBe(source);expect(JSON.parse(readFileSync(journal,"utf8")).transactionId).toBe(intent.transactionId);
},15000);
it("blocks an observer from consuming a live half-publication and recovers after the actual owner dies",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"session-publication-live-"));dirs.push(dir);const observer=new RuntimeStore(join(dir,"data")),fixture=fileURLToPath(new URL("./fixtures/session-publication-crash.mts",import.meta.url));
 const child=spawn(process.execPath,["--import","tsx",fixture,dir,"hold-create"],{stdio:["ignore","pipe","pipe"]});let error="";child.stderr.on("data",b=>error+=b);
 const closed=new Promise<string|null>((resolve,reject)=>{child.on("error",reject);child.on("close",(_,signal)=>resolve(signal));});
 try{
  await new Promise<void>((resolve,reject)=>{child.stdout.once("data",()=>resolve());child.once("error",reject);child.once("close",()=>reject(new Error(error||"owner exited before partial publication")));});
  expect(()=>observer.allBindings()).toThrow(expect.objectContaining({code:"RT_STORE_BUSY"}));expect(()=>observer.operationByKey("crash-create-key")).toThrow(expect.objectContaining({code:"RT_STORE_BUSY"}));
  child.kill("SIGKILL");expect(await closed).toBe("SIGKILL");expect(error).toBe("");
  const operation=observer.operationByKey("crash-create-key")!;expect(operation).toBeDefined();expect(observer.binding(operation.platformSessionId)?.creationOperationId).toBe(operation.operationId);expect(observer.allBindings()).toHaveLength(1);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await closed;}}
},15000);
