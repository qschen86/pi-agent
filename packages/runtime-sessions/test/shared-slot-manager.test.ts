import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,rmdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {RuntimeSessionManager} from '../src/manager.js';
import type {RuntimeKind} from '../src/types.js';
import type {StartTurnArgs,TurnSink} from '../src/driver.js';
import {SharedSlots} from '../src/shared-slots.js';
import {FakeDriver,tick,until} from './fake-driver.js';
const roots:string[]=[], managers:RuntimeSessionManager[]=[];
afterEach(async()=>{managers.splice(0).forEach(m=>m.shutdown());await tick(30);roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
class DeferredInterruptDriver extends FakeDriver {
 override async startTurn(args:StartTurnArgs,sink:TurnSink){const handle=await super.startTurn(args,sink);return{...handle,interrupt:async()=>{}};}
}
class UnconfirmedDriver extends FakeDriver {
 override async startTurn(args:StartTurnArgs,sink:TurnSink){const handle=await super.startTurn(args,sink);return{...handle,done:handle.done.then(result=>({...result,terminalObserved:false}))};}
}
async function setup(deferInterrupt=false,unconfirmed=false,kind:RuntimeKind="codex"){
 const root=mkdtempSync(join(tmpdir(),'shared-manager-'));roots.push(root);const ws=join(root,'workspace');mkdirSync(ws);
 const slots=join(root,'slots');const make=async(id:string)=>{
  const dataDir=join(root,id);mkdirSync(join(dataDir,'runtime'),{recursive:true});
  writeFileSync(join(dataDir,'runtime','host.json'),JSON.stringify({hostId:'shared-test-host',label:'test'}));
  const driver=unconfirmed && id==='a' ? new UnconfirmedDriver(kind) : deferInterrupt && id==='a' ? new DeferredInterruptDriver(kind) : new FakeDriver(kind);
  const manager=new RuntimeSessionManager({dataDir,drivers:{[kind]:driver},skipRecovery:true,sharedSlotsDir:slots});managers.push(manager);
  manager.updateSettings({workspaceRoots:[ws]},'test');await manager.probe(kind);
  const create=(key:string)=>manager.create({idempotencyKey:key,runtimeKind:kind,workspace:ws,prompt:key,projectRef:'project-'+id,confirmedProfileVersion:manager.profile(kind)!.checkedAt},'test');
  return{manager,driver,create};
 };return{a:await make('a'),b:await make('b'),slots};
}
it('holds unknown native work across managers and wakes another queue only after observed terminal completion',async()=>{
 const{a,b,slots}=await setup();expect(a.manager.profile('codex')!.identity!.identityScopeId).toBe(b.manager.profile('codex')!.identity!.identityScopeId);
 await a.create('first-operation');await a.create('second-operation');await until(()=>a.driver.turns.length===2);
 const queued=await b.create('third-operation');await tick(50);expect(b.driver.startCalls).toBe(0);expect(b.manager.store.operation(queued.operation.operationId)!.state).toBe('queued');
 a.driver.turns[0]!.finish({status:'unknown',reason:'lost terminal result'});await tick(50);expect(b.driver.startCalls).toBe(0);
 a.driver.turns[1]!.finish({status:'completed'});await until(()=>b.driver.startCalls===1);
 const ledger=new SharedSlots(slots).snapshot(a.manager.profile('codex')!.identity!.identityScopeId);
 expect(ledger.reservations.filter(r=>r.status==='unknown')).toHaveLength(1);expect(ledger.reservations.filter(r=>r.status!=='released')).toHaveLength(2);
});
it('does not release a shared reservation merely because forceStop projects an interrupted state',async()=>{
 const{a,b,slots}=await setup(true);await a.create('first-operation');await a.create('second-operation');await until(()=>a.driver.turns.length===2);
 // Native interrupt has acknowledged the request but neither native turn has ended.
 await a.manager.forceStop('deploy request','test');expect(a.manager.store.allBindings().every(binding=>binding.status==='unknown')).toBe(true);await b.create('third-operation');await tick(50);expect(b.driver.startCalls).toBe(0);
 expect(a.manager.activity().unknownOps).toBe(2);
 const scope=a.manager.profile('codex')!.identity!.identityScopeId;expect(new SharedSlots(slots).snapshot(scope).reservations.filter(r=>r.status==='unknown')).toHaveLength(2);
 a.driver.turns[0]!.finish({status:'interrupted'});await until(()=>b.driver.startCalls===1);
});

it('holds transport interruptions without a native terminal observation',async()=>{
 const{a,b}=await setup(false,true);await a.create('first-operation');await a.create('second-operation');await until(()=>a.driver.turns.length===2);
 a.driver.turns[0]!.finish({status:'interrupted',reason:'connection exited without native terminal'});await tick(30);
 await b.create('third-operation');await tick(150);expect(b.driver.startCalls).toBe(0);
});
it('queues a continuation of the same native session until its earlier uncertain turn is resolved',async()=>{
 const{a}=await setup(false,true);const first=await a.create('first-operation');await until(()=>a.driver.turns.length===1);
 a.driver.turns[0]!.finish({status:'interrupted',reason:'transport lost'});await tick(30);
 const binding=a.manager.store.binding(first.session.platformSessionId)!;
 await a.manager.sendTurn(binding.platformSessionId,{idempotencyKey:'continuation-operation',prompt:'continue',expectedRevision:binding.bindingRevision},'test');
 await tick(150);expect(a.driver.startCalls).toBe(1);
});

it('projects the queued operation timestamp and reason instead of pretending the continuation has started',async()=>{
 const{a}=await setup(false,true,'pi');const first=await a.create('original');await until(()=>a.driver.turns.length===1);
 a.driver.turns[0]!.finish({status:'unknown',reason:'transport lost'});await tick(30);
 const binding=a.manager.store.binding(first.session.platformSessionId)!;
 const next=await a.manager.sendTurn(binding.platformSessionId,{idempotencyKey:'queued-continuation',prompt:'continue',expectedRevision:binding.bindingRevision},'test');
 const entry=(await a.manager.directory()).entries.find(e=>e.id===binding.platformSessionId)!;
 expect(entry.latestTurn).toMatchObject({status:'queued',queuedAt:next.operation.createdAt});
 expect(entry.latestTurn?.startedAt).toBeUndefined();
 expect(entry.statusReason).toContain('排队中');
});

it('waits for driver cleanup and durable release before a graceful shutdown completes',async()=>{
 const{a,slots}=await setup(false,true,'pi');const first=await a.create('shutdown-original');await until(()=>a.driver.turns.length===1);
 a.driver.shutdown=()=>{setTimeout(()=>a.driver.turns[0]!.finish({status:'unknown',reason:'no terminal',processEnded:'verified process exit'}),1700);};
 await a.manager.shutdownAndWait();
 const binding=a.manager.store.binding(first.session.platformSessionId)!;
 expect(new SharedSlots(slots).snapshot(binding.identityScopeId).reservations[0]!.status).toBe('released');
 expect(binding.turns[0]!.status).toBe('unknown');
 const native=new FakeDriver('pi');const restarted=new RuntimeSessionManager({dataDir:dirname(a.manager.store.dir),drivers:{pi:native},sharedSlotsDir:slots,skipRecovery:true});managers.push(restarted);
 const saved=restarted.store.binding(binding.platformSessionId)!;
 await restarted.sendTurn(saved.platformSessionId,{idempotencyKey:'after-restart',prompt:'continue',expectedRevision:saved.bindingRevision},'test');
 await until(()=>native.startCalls===1);
});

it('a shutdown deadline does not invent process exit evidence or release an uncertain reservation',async()=>{
 const{a,slots}=await setup(false,true);const first=await a.create('hung-shutdown');await until(()=>a.driver.turns.length===1);
 await a.manager.shutdownAndWait(20);
 const binding=a.manager.store.binding(first.session.platformSessionId)!;
 expect(new SharedSlots(slots).snapshot(binding.identityScopeId).reservations[0]!.status).toBe('unknown');
 expect(a.manager.store.operation(first.operation.operationId)!.steps.some(s=>s.step==='process-ended')).toBe(false);
});

it('replays a durable process exit observation after a crash before slot release without inventing a native result',async()=>{
 const{a,slots}=await setup(false,true,'pi');const first=await a.create('exit-observation');await until(()=>a.driver.turns.length===1);
 a.driver.turns[0]!.finish({status:'unknown',reason:'terminal lost'});await tick(30);
 a.manager.store.stepOperation(first.operation.operationId,'process-ended','host observed exact executing process exit');
 a.manager.shutdown();
 const native=new FakeDriver('pi');const restarted=new RuntimeSessionManager({dataDir:dirname(a.manager.store.dir),drivers:{pi:native},sharedSlotsDir:slots});managers.push(restarted);await restarted.recovered;
 const binding=restarted.store.binding(first.session.platformSessionId)!;
 expect(new SharedSlots(slots).snapshot(binding.identityScopeId).reservations[0]!.status).toBe('released');
 expect(binding.turns[0]!.status).toBe('unknown');expect(native.startCalls).toBe(0);
 await restarted.sendTurn(binding.platformSessionId,{idempotencyKey:'continue-exited',prompt:'continue',expectedRevision:binding.bindingRevision},'test');
 await until(()=>native.startCalls===1);
});

it.each(['codex','pi'] as const)('reconciles the exact %s native terminal and releases an uncertain operation without replay',async(kind)=>{
 const{a,slots}=await setup(false,true,kind);const created=await a.create('uncertain-original-operation');await until(()=>a.driver.turns.length===1);
 const turn=a.driver.turns[0]!;turn.finish({status:'interrupted',reason:'connection lost'});await tick(30);
 a.driver.fingerprint=async()=>({value:'native-terminal-proof',lastTurnStatus:'completed',lastTurnId:turn.turnId,lastClientMessageId:turn.args.clientMessageId,active:false,terminalObserved:true});
 await a.manager.reconcileSharedReservations();
 const binding=a.manager.store.binding(created.session.platformSessionId)!;
 expect(new SharedSlots(slots).snapshot(binding.identityScopeId).reservations[0]!.status).toBe('released');
 expect(binding.turns[0]!.status).toBe('completed');expect(a.driver.startCalls).toBe(1);
 expect(a.manager.store.operation(created.operation.operationId)!.steps.some(s=>s.step==='shared-slot-reconciled')).toBe(true);
 await a.manager.reconcileSharedReservations();expect(a.driver.startCalls).toBe(1);
 await a.manager.sendTurn(binding.platformSessionId,{idempotencyKey:'verified-continuation',prompt:'continue',expectedRevision:a.manager.store.binding(binding.platformSessionId)!.bindingRevision},'test');
 await until(()=>a.driver.turns.length===2);expect(a.driver.turns[1]!.args.nativeSessionId).toBe(turn.nativeId);
});
it.each(['different-turn','still-active','unobserved','not-delivered','different-account'] as const)('keeps an uncertain lease held when reconciliation source is %s',async(fault)=>{
 const{a,slots}=await setup(false,true);const created=await a.create('uncertain-original-operation');await until(()=>a.driver.turns.length===1);
 const turn=a.driver.turns[0]!;turn.finish({status:'interrupted'});await tick(30);
 a.driver.fingerprint=async()=>({value:'source',lastTurnStatus:'completed',lastTurnId:fault==='different-turn'?'other-turn':turn.turnId,active:fault==='still-active',terminalObserved:fault!=='unobserved'});
 if(fault==='not-delivered')a.driver.delivered.set(`${turn.nativeId}|${turn.args.clientMessageId}`,false);
 if(fault==='different-account')a.driver.stableAccountId='another-account';
 await a.manager.reconcileSharedReservations();
 const binding=a.manager.store.binding(created.session.platformSessionId)!;
 expect(new SharedSlots(slots).snapshot(binding.identityScopeId).reservations[0]!.status).toBe('unknown');expect(a.driver.startCalls).toBe(1);
});

it.each(['codex','pi'] as const)('recovers an exact %s terminal after manager recreation without creating a replacement session',async(kind)=>{
 const{a,slots}=await setup(false,true,kind);const created=await a.create('restart-original-operation');await until(()=>a.driver.turns.length===1);
 const turn=a.driver.turns[0]!;turn.finish({status:'interrupted',reason:'connection lost'});await tick(30);a.manager.shutdown();
 const native=new FakeDriver(kind);native.fingerprint=async()=>({value:'durable-exact-terminal',lastTurnStatus:'completed',lastTurnId:turn.turnId,lastClientMessageId:turn.args.clientMessageId,active:false,terminalObserved:true});
 native.delivered.set(`${turn.nativeId}|${turn.args.clientMessageId}`,true);
 const restarted=new RuntimeSessionManager({dataDir:dirname(a.manager.store.dir),drivers:{[kind]:native},sharedSlotsDir:slots});managers.push(restarted);await restarted.recovered;
 const binding=restarted.store.binding(created.session.platformSessionId)!;
 expect(binding.nativeSessionId).toBe(turn.nativeId);expect(binding.turns[0]!.status).toBe('completed');expect(native.startCalls).toBe(0);
 expect(new SharedSlots(slots).snapshot(binding.identityScopeId).reservations[0]!.status).toBe('released');
});
it('does not release Pi work based on a settled journal entry for another client message',async()=>{
 const{a,slots}=await setup(false,true,'pi');const created=await a.create('pi-original-operation');await until(()=>a.driver.turns.length===1);
 const turn=a.driver.turns[0]!;turn.finish({status:'interrupted'});await tick(30);
 a.driver.fingerprint=async()=>({value:'unrelated-journal-entry',lastTurnStatus:'completed',lastClientMessageId:'another-client-message',active:false,terminalObserved:true});
 await a.manager.reconcileSharedReservations();
 const binding=a.manager.store.binding(created.session.platformSessionId)!;expect(new SharedSlots(slots).snapshot(binding.identityScopeId).reservations[0]!.status).toBe('unknown');expect(a.driver.startCalls).toBe(1);
});

it('does not expose an unobserved driver completion as an accepted native terminal',async()=>{
 const{a}=await setup(false,true);const created=await a.create('unverified-completion');await until(()=>a.driver.turns.length===1);
 a.driver.turns[0]!.finish({status:'completed'});await tick(30);
 const binding=a.manager.store.binding(created.session.platformSessionId)!;expect(binding.status).toBe('unknown');expect(binding.turns[0]!.status).toBe('unknown');
});

it('keeps a corrupted account held while reconciling another authenticated account',async()=>{
 const{a,slots}=await setup(false,true);const first=await a.create('first-account-operation');await until(()=>a.driver.turns.length===1);a.driver.turns[0]!.finish({status:'interrupted'});await tick(30);
 const firstScope=a.manager.store.binding(first.session.platformSessionId)!.identityScopeId;
 a.driver.stableAccountId='second-account';await a.manager.probe('codex');const second=await a.create('second-account-operation');await until(()=>a.driver.turns.length===2);a.driver.turns[1]!.finish({status:'interrupted'});await tick(30);
 a.driver.fingerprint=async(nativeId)=>({value:'correct-second-account-terminal',lastTurnStatus:'completed',lastTurnId:a.driver.turns.find(t=>t.nativeId===nativeId)!.turnId,active:false,terminalObserved:true});
 const file=readdirSync(slots).filter(f=>f.endsWith('.json')).map(f=>join(slots,f)).find(f=>JSON.parse(readFileSync(f,'utf8')).identityScopeId===firstScope)!;writeFileSync(file,'corrupted-authoritative-ledger');
 await a.manager.reconcileSharedReservations();
 const secondBinding=a.manager.store.binding(second.session.platformSessionId)!;expect(new SharedSlots(slots).snapshot(secondBinding.identityScopeId).reservations[0]!.status).toBe('released');expect(readFileSync(file,'utf8')).toBe('corrupted-authoritative-ledger');expect(a.driver.startCalls).toBe(2);
});

it('keeps an ambiguous dispatch failure unknown even when a native session was registered',async()=>{
 const{a,slots}=await setup();a.driver.failNext={stage:'dispatch',message:'acknowledgement lost',nativeId:'registered-native',notExecuted:false};
 const created=await a.create('ambiguous-dispatch');await until(()=>!!a.manager.store.binding(created.session.platformSessionId)!.turns[0]!.endedAt);
 const binding=a.manager.store.binding(created.session.platformSessionId)!;expect(binding.nativeSessionId).toBe('registered-native');expect(binding.status).toBe('unknown');expect(binding.turns[0]!.status).toBe('unknown');expect(a.manager.store.operation(created.operation.operationId)!.state).toBe('unknown');
 expect(new SharedSlots(slots).snapshot(binding.identityScopeId).reservations[0]!.status).toBe('unknown');
});

it('releases capacity when a dispatch error carries a verified process exit, yet the turn stays unknown and is never resent',async()=>{
 const{a,slots}=await setup();a.driver.failNext={stage:'dispatch',message:'Pi RPC timeout: prompt',nativeId:'registered-native',notExecuted:false,processEnded:'Pi RPC 进程组已退出（平台停止并等到退出）'};
 const created=await a.create('timeout-process-ended');await until(()=>!!a.manager.store.binding(created.session.platformSessionId)!.turns[0]!.endedAt);
 const binding=a.manager.store.binding(created.session.platformSessionId)!;
 expect(binding.turns[0]!.status).toBe('unknown');expect(binding.status).toBe('unknown');
 const op=a.manager.store.operation(created.operation.operationId)!;expect(op.state).toBe('unknown');expect(op.steps.some(s=>s.step==='process-ended')).toBe(true);
 await until(()=>new SharedSlots(slots).snapshot(binding.identityScopeId).reservations[0]!.status==='released');
 expect(a.manager.activity().unknownOps).toBe(0);expect(a.driver.startCalls).toBe(1);
});

function usageFor(turn: import("./fake-driver.js").FakeTurn, tokens = 23) {
 return { version: 1 as const, runtimeKind: "codex" as const, nativeSessionId: turn.nativeId, nativeTurnId: turn.turnId, clientMessageId: turn.args.clientMessageId, sourceRef: `native:${turn.nativeId}:${turn.turnId}:usage`, tokens, reportedCostUsd: 0.01 };
}
it("accounts exact native turn receipts and adds only the new continuation turn", async () => {
 const { a } = await setup(); const created = await a.create("metered-create"); await until(() => a.driver.turns.length === 1);
 const first = a.driver.turns[0]!; first.finish({ status: "completed", usageReceipt: usageFor(first) });
 await until(() => a.manager.store.binding(created.session.platformSessionId)!.status === "idle");
 expect(a.manager.projectExecutionUsage("project-a").tokens).toMatchObject({ coverage: "complete", observed: 23 });
 const binding = a.manager.store.binding(created.session.platformSessionId)!;
 await a.manager.sendTurn(binding.platformSessionId, { idempotencyKey: "metered-continue", prompt: "continue", expectedRevision: binding.bindingRevision }, "test");
 await until(() => a.driver.turns.length === 2); const second = a.driver.turns[1]!;
 expect(a.manager.projectExecutionUsage("project-a").tokens).toMatchObject({ coverage: "partial", observed: 23, pendingCalls: 1 });
 second.finish({ status: "completed", usageReceipt: usageFor(second, 7) });
 await until(() => a.manager.store.binding(binding.platformSessionId)!.status === "idle");
 expect(a.manager.projectExecutionUsage("project-a").tokens).toMatchObject({ coverage: "complete", observed: 30, pendingCalls: 0 });
 expect(a.manager.projectExecutionUsage("project-a").reportedCostUsd.observed).toBe(0.02);
});
it.each(["nativeSessionId", "nativeTurnId", "clientMessageId", "runtimeKind"])("refuses native usage attributed to another %s without treating it as zero", async field => {
 const { a } = await setup(); const created = await a.create("bad-meter-source"); await until(() => a.driver.turns.length === 1);
 const turn = a.driver.turns[0]!; turn.finish({ status: "completed", usageReceipt: { ...usageFor(turn), [field]: field === "runtimeKind" ? "pi" : "foreign" } });
 await until(() => a.manager.store.binding(created.session.platformSessionId)!.status === "idle");
 expect(a.manager.projectExecutionUsage("project-a").tokens).toMatchObject({ coverage: "not_collected", pendingCalls: 1 });
 expect(a.manager.projectExecutionUsage("project-a").tokens.observed).toBeUndefined();
});
it("retries durable native usage before terminal release after a busy shared ledger and host restart", async () => {
 const { a, slots } = await setup(); const created = await a.create("busy-meter-source"); await until(() => a.driver.turns.length === 1);
 const turn = a.driver.turns[0]!; mkdirSync(join(slots, "admission.lock"));
 turn.finish({ status: "completed", usageReceipt: usageFor(turn) });
 await until(() => a.manager.store.binding(created.session.platformSessionId)!.status === "idle");
 expect(a.manager.store.operation(created.operation.operationId)!.steps.some(s => s.step === "native-turn-usage")).toBe(true);
 a.manager.shutdown(); rmdirSync(join(slots, "admission.lock"));
 const driver = new FakeDriver("codex"); const restarted = new RuntimeSessionManager({ dataDir: dirname(a.manager.store.dir), drivers: { codex: driver }, sharedSlotsDir: slots, skipRecovery: true }); managers.push(restarted);
 await until(() => new SharedSlots(slots).snapshot(a.manager.store.binding(created.session.platformSessionId)!.identityScopeId).reservations[0]!.status === "released");
 expect(restarted.projectExecutionUsage("project-a").tokens).toMatchObject({ coverage: "complete", observed: 23 });
 expect(driver.startCalls).toBe(0);
});

it("keeps usage from an unobserved terminal unknown even if the driver supplies numeric values", async () => {
 const { a } = await setup(false, true); const created = await a.create("unconfirmed-meter"); await until(() => a.driver.turns.length === 1);
 const turn = a.driver.turns[0]!; turn.finish({ status: "completed", usageReceipt: usageFor(turn) });
 await until(() => a.manager.store.binding(created.session.platformSessionId)!.status === "unknown");
 expect(a.manager.projectExecutionUsage("project-a").tokens).toMatchObject({ coverage: "not_collected", pendingCalls: 1 });
 expect(a.manager.store.operation(created.operation.operationId)!.steps.some(s => s.step === "native-turn-usage")).toBe(false);
});
it('releases capacity once the host observed the executing process exit, even without a native terminal record',async()=>{
 const{a,b,slots}=await setup(false,true);const first=await a.create('first-operation');await a.create('second-operation');await until(()=>a.driver.turns.length===2);
 const queued=await b.create('third-operation');await tick(50);expect(b.driver.startCalls).toBe(0);
 // Claude CLI exited with a non-zero code: failed, no native terminal record, but the process is gone
 a.driver.turns[0]!.finish({status:'failed',reason:'Claude Code process exited with code 1',processEnded:'Claude Code 进程已退出：exited with code 1'});
 await until(()=>b.driver.startCalls===1);
 const pid=first.session.platformSessionId,binding=a.manager.store.binding(pid)!;
 expect(binding.turns[0]!.status).toBe('failed');expect(binding.status).toBe('idle');
 expect(a.manager.store.operation(binding.turns[0]!.operationId)!.steps.some(s=>s.step==='process-ended')).toBe(true);
 // Result itself unknown but the process ended: capacity released, result still reported as unknown
 a.driver.turns[1]!.finish({status:'unknown',reason:'transcript persistence unconfirmed',processEnded:'Pi RPC 进程组已退出'});await tick(50);
 const second=a.manager.store.allBindings().find(x=>x.platformSessionId!==pid)!;
 expect(second.turns[0]!.status).toBe('unknown');expect(second.turns[0]!.statusReason).toContain('名额已释放');
 expect(b.manager.activity().unknownOps).toBe(0);
 const scope=a.manager.profile('codex')!.identity!.identityScopeId;
 expect(new SharedSlots(slots).snapshot(scope).reservations.filter(r=>r.status!=='released').map(r=>r.operationId)).toEqual([queued.operation.operationId]);
 // The failed turn can be continued explicitly: nothing is still running
 await a.manager.sendTurn(pid,{idempotencyKey:'continue-after-exit',prompt:'continue',expectedRevision:a.manager.store.binding(pid)!.bindingRevision},'test');
 await until(()=>a.driver.startCalls===3);
});

it('an unknown operation whose reservation was released with a terminal proof no longer counts as pending for deploys',async()=>{
 const{a,slots}=await setup(false,true);const first=await a.create('first-operation');await until(()=>a.driver.turns.length===1);
 a.driver.turns[0]!.finish({status:'unknown',reason:'lost terminal result'});await tick(50);
 expect(a.manager.activity().unknownOps).toBe(1);
 const scope=a.manager.profile('codex')!.identity!.identityScopeId;
 new SharedSlots(slots).release(scope,first.operation.operationId,{outcome:'not-executed',sourceRef:'manual:test verified no native process'});
 expect(a.manager.activity().unknownOps).toBe(0);
});
