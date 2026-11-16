import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const root=process.argv[2]!,kind=process.argv[3]!;
let armed=false;const rename=fs.renameSync;
fs.renameSync=(from,to)=>{rename(from,to);if(armed&&String(to)===join(root,"data","runtime","bindings.json")){if(kind==="hold-create"){process.stdout.write("HELD");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000)}process.kill(process.pid,"SIGKILL")}};
syncBuiltinESMExports();
const {RuntimeSessionManager}=await import("../../src/manager.js");
const {FakeDriver,until}=await import("../fake-driver.js");
const driver=new FakeDriver("codex"),workspace=join(root,"workspace");fs.mkdirSync(workspace,{recursive:true});
const manager=new RuntimeSessionManager({dataDir:join(root,"data"),skipRecovery:true,drivers:{codex:driver,"claude-code":new FakeDriver("claude-code"),pi:new FakeDriver("pi")}});
manager.updateSettings({workspaceRoots:[workspace]},"test");const profile=await manager.probe("codex");
if(kind==="create"||kind==="hold-create"){
 armed=true;await manager.create({runtimeKind:"codex",workspace,prompt:"test",idempotencyKey:"crash-create-key",confirmedProfileVersion:profile.checkedAt},"human");
}else{
 const created=await manager.create({runtimeKind:"codex",workspace,prompt:"first",idempotencyKey:"initial-create-key",confirmedProfileVersion:profile.checkedAt},"human");
 await until(()=>driver.turns.length===1);driver.turns[0]!.finish({status:"completed"});await until(()=>manager.store.binding(created.session.platformSessionId)!.status==="idle");
 const revision=manager.store.binding(created.session.platformSessionId)!.bindingRevision;armed=true;
 await manager.sendTurn(created.session.platformSessionId,{prompt:"next",idempotencyKey:"crash-turn-key",expectedRevision:revision},"human");
}
throw new Error("crash point was not exercised");
