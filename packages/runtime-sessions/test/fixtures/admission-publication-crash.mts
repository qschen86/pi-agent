import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {join} from "node:path";
const root=fs.realpathSync(process.argv[2]!),phase=process.argv[3]!;
let armed=false;const rename=fs.renameSync;
fs.renameSync=(from,to)=>{
 rename(from,to);const target=String(to),kind=phase.replace("hold-","");
 const match=kind==="ledger"?/^[a-f0-9]{64}\.json$/.test(target.split("/").at(-1)!):target===join(root,kind==="journal"?"admission-publication.json":"admission-queue.json");
 if(armed&&match){if(phase.startsWith("hold-")){process.stdout.write("HELD");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);}process.kill(process.pid,"SIGKILL");}
};
syncBuiltinESMExports();
const {SharedSlots}=await import("../../src/shared-slots.js");
const slots=new SharedSlots(root),base={identityScopeId:"account-one",projectId:"project-one",ownerId:"crashed-owner",limit:1};
slots.enqueue({...base,operationId:"waiting-business",admissionClass:"business"},true);
const evaluation={...base,operationId:"admitted-evaluation",admissionClass:"evaluation" as const};slots.enqueue(evaluation,true);
armed=true;slots.reserve(evaluation);throw new Error("crash point not exercised");
