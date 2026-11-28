import {it,expect,afterEach,vi} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {CapabilityGateway,GatewayStore,FileVault,RestAdapters} from '@pi-agent/capability-gateway';
import {startCapabilityAccess} from '../src/capability-access.js';
import {RuntimeSessionManager} from '../src/manager.js';
import {FakeDriver,until,tick} from './fake-driver.js';
const cleanup:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
function setup(){const root=mkdtempSync(join(tmpdir(),'gateway-runtime-')),workspace=join(root,'work');mkdirSync(workspace);const store=new GatewayStore(join(root,'db.sqlite'));cleanup.push(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const gateway=new CapabilityGateway(store,new FileVault(join(root,'vault')),new RestAdapters(vi.fn(async()=>new Response(JSON.stringify({login:'fixture',name:'fixture'}))) as unknown as typeof fetch));return {root,workspace,store,gateway};}
function rpc(path:string,req:unknown):Promise<any>{return new Promise((yes,no)=>{const s=createConnection(path);let buffer='';s.on('connect',()=>s.write(JSON.stringify(req)+'\n'));s.on('data',c=>{buffer+=c;if(buffer.includes('\n')){s.destroy();yes(JSON.parse(buffer.split('\n')[0]));}});s.on('error',no);});}
it('private socket binds host identity and disappears on disposal',async()=>{const t=setup();const conn=await t.gateway.connect({provider:'github',label:'fixture',token:'synthetic-only',resources:['repo:a/b']},'owner');t.gateway.grant({subject:'trusted',connectionId:conn.id,capabilities:['github.repo.read'],resources:['repo:a/b'],approval:'AUTO'},'owner');
 const access=await startCapabilityAccess(t.gateway,{sessionId:'trusted',turnId:'turn'});cleanup.push(()=>access.dispose());
 expect(await rpc(access.access.socketPath,{tool:'capability_search',params:{}})).toMatchObject({ok:true,result:[{connectionId:conn.id}]});
 expect(await rpc(access.access.socketPath,{tool:'capability_search',params:{sessionId:'other'}})).toMatchObject({ok:false});
 await access.dispose();expect(existsSync(access.access.socketPath)).toBe(false);
});
it.each([false,true])('manager only mounts the gateway for explicitly enabled sessions (%s)',async enabled=>{
 const t=setup(),driver=new FakeDriver('codex'),manager=new RuntimeSessionManager({dataDir:join(t.root,'sessions'),drivers:{codex:driver},skipRecovery:true});cleanup.push(async()=>{manager.shutdown();await tick(30);});manager.setCapabilityGateway(t.gateway);manager.updateSettings({workspaceRoots:[t.workspace]},'test');await manager.probe('codex');
 const result=await manager.create({runtimeKind:'codex',workspace:t.workspace,prompt:'hello',idempotencyKey:'gateway-enabled-'+enabled,confirmedProfileVersion:manager.profile('codex')!.checkedAt,capabilityGateway:enabled},'test');await until(()=>driver.turns.length===1);
 expect(!!driver.turns[0].args.capabilityGateway).toBe(enabled);expect(!!manager.store.binding(result.session.platformSessionId)!.capabilityGateway).toBe(enabled);driver.turns[0].finish({status:'completed'});await until(()=>manager.store.binding(result.session.platformSessionId)?.status==='idle');
});
it('read-only session cannot mount even if its opt-in bit is set',async()=>{
 const t=setup(),driver=new FakeDriver('codex'),manager=new RuntimeSessionManager({dataDir:join(t.root,'sessions'),drivers:{codex:driver},skipRecovery:true});cleanup.push(async()=>{manager.shutdown();await tick(30);});manager.setCapabilityGateway(t.gateway);manager.updateSettings({workspaceRoots:[t.workspace]},'test');await manager.probe('codex');
 await manager.create({runtimeKind:'codex',workspace:t.workspace,prompt:'hello',idempotencyKey:'read-only-gateway',confirmedProfileVersion:manager.profile('codex')!.checkedAt,permissionMode:'read-only',capabilityGateway:true},'test');await until(()=>driver.turns.length===1);expect(driver.turns[0].args.capabilityGateway).toBeUndefined();driver.turns[0].finish({status:'completed'});
});
it('continuation replaces the closed turn socket and observes grants added after creation',async()=>{
 const t=setup(),driver=new FakeDriver('codex'),manager=new RuntimeSessionManager({dataDir:join(t.root,'sessions'),drivers:{codex:driver},skipRecovery:true});cleanup.push(async()=>{manager.shutdown();await tick(30);});manager.setCapabilityGateway(t.gateway);manager.updateSettings({workspaceRoots:[t.workspace]},'test');await manager.probe('codex');
 const created=await manager.create({runtimeKind:'codex',workspace:t.workspace,prompt:'hello',idempotencyKey:'continuation-gateway',confirmedProfileVersion:manager.profile('codex')!.checkedAt,capabilityGateway:true},'test');await until(()=>driver.turns.length===1);
 const id=created.session.platformSessionId,first=driver.turns[0].args.capabilityGateway!;
 expect(await rpc(first.socketPath,{tool:'capability_search',params:{}})).toMatchObject({ok:true,result:[]});
 driver.turns[0].finish({status:'completed'});await until(()=>manager.store.binding(id)?.status==='idle');expect(existsSync(first.socketPath)).toBe(false);
 const conn=await t.gateway.connect({provider:'github',label:'fixture',token:'synthetic-only',resources:['repo:a/b']},'owner');const grant=t.gateway.grant({subject:id,connectionId:conn.id,capabilities:['github.repo.read'],resources:['repo:a/b'],approval:'AUTO'},'owner');
 await manager.sendTurn(id,{idempotencyKey:'continuation-second',prompt:'continue',expectedRevision:manager.store.binding(id)!.bindingRevision},'test');await until(()=>driver.turns.length===2);
 const second=driver.turns[1].args.capabilityGateway!;expect(second.socketPath).not.toBe(first.socketPath);expect(driver.turns[1].args.nativeSessionId).toBe(driver.turns[0].nativeId);
 expect(await rpc(second.socketPath,{tool:'capability_search',params:{}})).toMatchObject({ok:true,result:[{connectionId:conn.id}]});
 t.gateway.revoke(grant.id,'owner');expect(await rpc(second.socketPath,{tool:'capability_search',params:{}})).toMatchObject({ok:true,result:[]});
 await manager.interrupt(id,'test');await until(()=>!existsSync(second.socketPath));
});
it('host single-operation approval cannot use a session-wide grant and revocation while waiting blocks execution',async()=>{
 const t=setup(),driver=new FakeDriver('codex'),manager=new RuntimeSessionManager({dataDir:join(t.root,'sessions'),drivers:{codex:driver},skipRecovery:true});cleanup.push(async()=>{manager.shutdown();await tick(30);});manager.setCapabilityGateway(t.gateway);manager.updateSettings({workspaceRoots:[t.workspace]},'test');await manager.probe('codex');
 const created=await manager.create({runtimeKind:'codex',workspace:t.workspace,prompt:'hello',idempotencyKey:'single-approval',confirmedProfileVersion:manager.profile('codex')!.checkedAt,capabilityGateway:true},'test');await until(()=>driver.turns.length===1);
 const id=created.session.platformSessionId,conn=await t.gateway.connect({provider:'github',label:'fixture',token:'synthetic-only',resources:['repo:a/b']},'owner');const grant=t.gateway.grant({subject:id,connectionId:conn.id,capabilities:['github.pr.create'],resources:['repo:a/b'],approval:'AUTO'},'owner');
 const result=rpc(driver.turns[0].args.capabilityGateway!.socketPath,{tool:'capability_invoke',params:{connectionId:conn.id,capabilityId:'github.pr.create',resource:'repo:a/b',input:{title:'test',head:'feature',base:'main'}}});await until(()=>manager.pendingApprovals().length===1);
 const approval=manager.pendingApprovals()[0];expect(approval.requiresExplicitApproval).toBe(true);expect(approval.action).toContain('feature');
 t.gateway.revoke(grant.id,'owner');
 expect(()=>manager.decideApproval(id,approval.approvalId,{approve:true,paramsDigest:approval.paramsDigest,turnNo:approval.turnNo,scope:'session'},'test')).toThrow();
 manager.decideApproval(id,approval.approvalId,{approve:true,paramsDigest:approval.paramsDigest,turnNo:approval.turnNo},'test');expect(await result).toMatchObject({ok:false,code:'POLICY_DENIED'});driver.turns[0].finish({status:'completed'});
});
