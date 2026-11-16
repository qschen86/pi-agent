import {mkdirSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,expect,it} from "vitest";
import {RuntimeSessionManager} from "../src/manager.js";
import {PI_TOOL_NAMES} from "../src/pi-evaluation-policy.js";
import {FakeDriver,tick,until} from "./fake-driver.js";
import type {EvaluationToolInventory} from "../src/driver.js";
let root:string,driver:FakeDriver,runtime:RuntimeSessionManager,created:Awaited<ReturnType<RuntimeSessionManager["create"]>>;
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),"pi-inventory-audit-"));const workspace=join(root,"workspace");mkdirSync(join(workspace,"inputs"),{recursive:true});mkdirSync(join(workspace,"out"));driver=new FakeDriver("pi");driver.evaluationPolicy=()=>({version:"fixture@1",channels:["fixture"]});
 runtime=new RuntimeSessionManager({dataDir:join(root,"data"),drivers:{pi:driver},skipRecovery:true});runtime.updateSettings({workspaceRoots:[workspace]},"host");await runtime.probe("pi");
 created=await runtime.create({idempotencyKey:"inventory-audit",runtimeKind:"pi",workspace,prompt:"fixture",confirmedProfileVersion:runtime.profile("pi")!.checkedAt,evaluation:{inputRoots:[join(workspace,"inputs")],reportDir:join(workspace,"out")},evaluationPolicyHash:runtime.evaluationPolicy("pi")!.policyHash},"host");await until(()=>driver.turns.length===1);
});
afterEach(async()=>{runtime.shutdown();await tick(30);rmSync(root,{recursive:true,force:true});});
const records=()=>readFileSync(join(root,"data","runtime","audit.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line)).filter(e=>e.type==="evaluation-tool-inventory");
function inventory():EvaluationToolInventory{const t=driver.turns[0]!;return{version:1,nativeSessionId:t.nativeId,clientMessageId:t.args.clientMessageId,activeTools:[...PI_TOOL_NAMES],registeredTools:PI_TOOL_NAMES.map(name=>({name,source:"builtin"}))};}
it("persists the native inventory under its exact original operation and strips the handshake nonce",()=>{
 driver.turns[0]!.sink.evaluationInventory?.({...inventory(),token:"private-startup-nonce"} as EvaluationToolInventory);
 expect(records()).toMatchObject([{platformSessionId:created.session.platformSessionId,operationId:created.operation.operationId,turnNo:1,evaluationPolicyHash:runtime.evaluationPolicy("pi")!.policyHash,inventory:inventory()}]);expect(JSON.stringify(records())).not.toContain("private-startup-nonce");
});
it("rejects another native session or client message rather than recording it as this turn's evidence",()=>{
 const sink=driver.turns[0]!.sink;
 expect(()=>sink.evaluationInventory?.({...inventory(),nativeSessionId:"other-session"})).toThrow(/source/);
 expect(()=>sink.evaluationInventory?.({...inventory(),clientMessageId:"other-client-message"})).toThrow(/source/);
 expect(records()).toHaveLength(0);
});
