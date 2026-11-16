import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach,expect,it} from "vitest";
import {SharedSlots} from "../src/shared-slots.js";
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
const fixture=fileURLToPath(new URL("./fixtures/admission-publication-crash.mts",import.meta.url));
for(const phase of ["journal","ledger","queue"])it(`recovers one admission and exactly one fairness increment after death following ${phase} publication`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"admission-publication-"));roots.push(root);
 const result=await new Promise<{signal:string|null;error:string}>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx",fixture,root,phase],{stdio:["ignore","ignore","pipe"]});let error="";child.stderr.on("data",b=>error+=b);child.on("error",reject);child.on("close",(_,signal)=>resolve({signal,error}));});
 expect(result).toEqual({signal:"SIGKILL",error:""});
 const slots=new SharedSlots(root),original=slots.snapshot("account-one").reservations;
 expect(original).toHaveLength(1);expect(original[0]).toMatchObject({operationId:"admitted-evaluation",ownerId:"crashed-owner",status:"reserved"});
 const queue=()=>JSON.parse(readFileSync(join(root,"admission-queue.json"),"utf8")).entries;
 expect(queue().find((e:any)=>e.operationId==="admitted-evaluation").status).toBe("admitted");
 expect(queue().find((e:any)=>e.operationId==="waiting-business").waitedAdmissions).toBe(1);
 expect(slots.reserve({identityScopeId:"account-one",projectId:"project-one",ownerId:"new-owner",operationId:"admitted-evaluation",limit:1}).status).toBe("owned");
 expect(slots.reserve({identityScopeId:"account-one",projectId:"project-one",ownerId:"crashed-owner",operationId:"waiting-business",limit:1}).status).toBe("full");
 expect(new SharedSlots(root).snapshot("account-one").reservations).toEqual(original);
 expect(queue().find((e:any)=>e.operationId==="waiting-business").waitedAdmissions).toBe(1);
},15000);

async function killedOwner(root:string):Promise<void>{
 const result=await new Promise<{signal:string|null;error:string}>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx",fixture,root,"ledger"],{stdio:["ignore","ignore","pipe"]});let error="";child.stderr.on("data",b=>error+=b);child.on("error",reject);child.on("close",(_,signal)=>resolve({signal,error}));});
 expect(result).toEqual({signal:"SIGKILL",error:""});
}
it("does not overwrite either destination if another source conflicts with a surviving admission",async()=>{
 const root=mkdtempSync(join(tmpdir(),"admission-source-conflict-"));roots.push(root);await killedOwner(root);
 const journal=join(root,"admission-publication.json"),queueFile=join(root,"admission-queue.json"),intent=readFileSync(journal,"utf8"),queue=JSON.parse(readFileSync(queueFile,"utf8"));
 queue.entries[0].ready=false;const foreign=JSON.stringify(queue);writeFileSync(queueFile,foreign);
 const ledgerFile=join(root,createHash("sha256").update("account-one").digest("hex")+".json"),ledger=readFileSync(ledgerFile,"utf8");
 expect(()=>new SharedSlots(root).snapshot("account-one")).toThrow(/source conflict/);
 expect(readFileSync(ledgerFile,"utf8")).toBe(ledger);expect(readFileSync(queueFile,"utf8")).toBe(foreign);expect(readFileSync(journal,"utf8")).toBe(intent);
},15000);
it("refuses a journal that double credits the waiting task without changing its held reservation",async()=>{
 const root=mkdtempSync(join(tmpdir(),"admission-invalid-journal-"));roots.push(root);await killedOwner(root);
 const journal=join(root,"admission-publication.json"),intent=JSON.parse(readFileSync(journal,"utf8"));intent.queue.after.entries[0].waitedAdmissions=2;writeFileSync(journal,JSON.stringify(intent));
 const ledgerFile=join(root,createHash("sha256").update("account-one").digest("hex")+".json"),ledger=readFileSync(ledgerFile,"utf8"),queue=readFileSync(join(root,"admission-queue.json"),"utf8");
 expect(()=>new SharedSlots(root).snapshot("account-one")).toThrow(/Invalid admission publication/);
 expect(readFileSync(ledgerFile,"utf8")).toBe(ledger);expect(readFileSync(join(root,"admission-queue.json"),"utf8")).toBe(queue);expect(JSON.parse(readFileSync(journal,"utf8")).transactionId).toBe(intent.transactionId);
},15000);
it("fences a live partial admission before recovering only after actual owner death",async()=>{
 const root=mkdtempSync(join(tmpdir(),"admission-live-owner-"));roots.push(root);const slots=new SharedSlots(root);
 const child=spawn(process.execPath,["--import","tsx",fixture,root,"hold-ledger"],{stdio:["ignore","pipe","pipe"]});let error="";child.stderr.on("data",b=>error+=b);
 const closed=new Promise<string|null>((resolve,reject)=>{child.on("error",reject);child.on("close",(_,signal)=>resolve(signal));});
 try{
  await new Promise<void>((resolve,reject)=>{child.stdout.once("data",()=>resolve());child.once("error",reject);child.once("close",()=>reject(new Error(error||"owner exited before partial admission")));});
  expect(slots.inspect("account-one")).toEqual({status:"busy"});expect(()=>slots.snapshot("account-one")).toThrow(/busy/);
  child.kill("SIGKILL");expect(await closed).toBe("SIGKILL");expect(error).toBe("");
  expect(slots.snapshot("account-one").reservations).toHaveLength(1);expect(JSON.parse(readFileSync(join(root,"admission-queue.json"),"utf8")).entries[0].waitedAdmissions).toBe(1);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await closed;}}
},15000);
it("credits fairness once when eight recovery processes race over one dead owner's journal",async()=>{
 const root=mkdtempSync(join(tmpdir(),"admission-recovery-race-"));roots.push(root);await killedOwner(root);
 const module=fileURLToPath(new URL("../src/shared-slots.ts",import.meta.url));
 const script=`import {SharedSlots} from ${JSON.stringify(module)};const store=new SharedSlots(process.argv[1]);for(let n=0;n<100;n++){const result=store.inspect("account-one");if(result&&!('status' in result)){process.stdout.write(JSON.stringify(result.reservations));process.exit(0);}await new Promise(r=>setTimeout(r,5));}throw new Error("recovery never became available");`;
 const recovered=await Promise.all(Array.from({length:8},()=>new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script,root],{stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);child.on("error",reject);child.on("close",code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));})));
 for(const records of recovered)expect(records).toMatchObject([{operationId:"admitted-evaluation",ownerId:"crashed-owner",status:"reserved"}]);
 expect(JSON.parse(readFileSync(join(root,"admission-queue.json"),"utf8")).entries[0].waitedAdmissions).toBe(1);
},15000);
