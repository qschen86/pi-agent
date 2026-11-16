import {spawn} from "node:child_process";
import {mkdtempSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach,expect,it} from "vitest";
import {until,tick} from "./fake-driver.js";
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));
it("mints one opaque native account partition across eight processes so a two-call cap cannot become eight",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"identity-partition-race-"));dirs.push(dir);const fixture=fileURLToPath(new URL("./fixtures/identity-partition-race.mts",import.meta.url));
 const children=Array.from({length:8},(_,i)=>spawn(process.execPath,["--import","tsx",fixture,dir,String(i)],{stdio:["ignore","pipe","pipe"]}));
 const outcomes=children.map(child=>new Promise<{scope:string;status:string}>((resolve,reject)=>{let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);child.on("error",reject);child.on("close",code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));}));
 const collected=Promise.all(outcomes);void collected.catch(()=>{});
 try{
  await until(()=>readdirSync(dir).filter(n=>n.startsWith("ready-")).length===8,10000);writeFileSync(join(dir,"derive"),"");
  await until(()=>readdirSync(dir).some(n=>n.startsWith("writing-")),5000);await tick(200);writeFileSync(join(dir,"publish"),"");
  const results=await collected;expect(new Set(results.map(r=>r.scope)).size).toBe(1);expect(results.filter(r=>r.status==="reserved")).toHaveLength(2);expect(results.filter(r=>r.status==="full")).toHaveLength(6);
 }finally{writeFileSync(join(dir,"derive"),"");writeFileSync(join(dir,"publish"),"");for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await collected.catch(()=>{});}
},20000);
