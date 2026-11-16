import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {join} from "node:path";
const root=process.argv[2]!,index=process.argv[3]!,wait=new Int32Array(new SharedArrayBuffer(4));
const rename=fs.renameSync;
fs.renameSync=(from,to)=>{if(String(to)===join(root,"data","runtime","identity-partitions.json")){fs.writeFileSync(join(root,`writing-${index}`),"");while(!fs.existsSync(join(root,"publish")))Atomics.wait(wait,0,0,5)}rename(from,to)};
syncBuiltinESMExports();
const {RuntimeSessionManager}=await import("../../src/manager.js");const {FakeDriver}=await import("../fake-driver.js");const {SharedSlots}=await import("../../src/shared-slots.js");
let manager:InstanceType<typeof RuntimeSessionManager>|undefined;
for(let n=0;n<1000;n++){try{manager=new RuntimeSessionManager({dataDir:join(root,"data"),skipRecovery:true,drivers:{codex:new FakeDriver("codex"),"claude-code":new FakeDriver("claude-code"),pi:new FakeDriver("pi")}});break}catch(error){if((error as {code?:string}).code!=="RT_STORE_BUSY")throw error;Atomics.wait(wait,0,0,5)}}
if(!manager)throw new Error("host initialization stayed busy");
fs.writeFileSync(join(root,`ready-${index}`),"");while(!fs.existsSync(join(root,"derive")))Atomics.wait(wait,0,0,5);
let identity:ReturnType<typeof manager.deriveIdentity>|undefined;
for(let n=0;n<1000;n++){try{identity=manager.deriveIdentity("claude-code",{authMode:"subscription",summary:"fixture",source:"fixture",fingerprint:"same-nonsecret-login-fingerprint"});break}catch(error){if((error as {code?:string}).code!=="RT_STORE_BUSY")throw error;Atomics.wait(wait,0,0,5)}}
if(!identity)throw new Error("identity stayed busy");const slots=new SharedSlots(join(root,"slots"));let result:{status:string}|undefined;
for(let n=0;n<1000;n++){result=slots.reserve({identityScopeId:identity.identityScopeId,projectId:`project-${index}`,operationId:`operation-${index}`,ownerId:`host-${index}`,limit:2});if(result.status!=="busy")break;Atomics.wait(wait,0,0,5)}
manager.shutdown();process.stdout.write(JSON.stringify({scope:identity.identityScopeId,status:result?.status}));
