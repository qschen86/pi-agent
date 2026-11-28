import type {Hono,Context} from 'hono';
import {CapabilityGateway,GatewayError} from '@pi-agent/capability-gateway';
import type {RuntimeSessionManager} from '@pi-agent/runtime-sessions';
import {defaultPermissionMode,readOnlyPermissionMode} from '@pi-agent/runtime-sessions';
export function mountCapabilityRoutes(app:Hono,gateway:()=>CapabilityGateway,runtime:RuntimeSessionManager|undefined,legacy:()=>unknown[],access:(c:Context,write:boolean)=>boolean=()=>true){
 const actor='platform-owner';
 const run=async(c:Context,work:()=>unknown|Promise<unknown>)=>{c.header('Cache-Control','private, no-store');if(!access(c,c.req.method!=='GET'))return c.json({ok:false,error:'当前入口未授权管理外部连接'},403);try{return c.json(await work() as never);}catch(e){return c.json({ok:false,code:e instanceof GatewayError?e.code:'INTERNAL_ERROR',error:e instanceof GatewayError?e.code:'外部连接服务暂不可用'},e instanceof GatewayError?400:500);}};
 app.get('/api/capabilities/connections',c=>run(c,()=>({connections:gateway().connections(),connectors:[{id:'github',name:'GitHub',installed:true},{id:'cloudflare',name:'Cloudflare',installed:true}],legacy:legacy()})));
 app.post('/api/capabilities/connections',c=>run(c,async()=>gateway().connect(await c.req.json(),actor)));
 app.delete('/api/capabilities/connections/:id',c=>run(c,()=>{gateway().disconnect(c.req.param('id'),actor);return {ok:true};}));
 app.get('/api/capabilities/sessions',c=>run(c,()=>({sessions:(runtime?.store.allBindings()??[]).filter(b=>b.capabilityGateway&&!b.archived&&!b.evaluation&&!b.roomRef).map(b=>({id:b.platformSessionId,title:b.title}))})));
 app.get('/api/capabilities/catalog',c=>run(c,()=>({capabilities:gateway().catalog()})));
 // Availability is advisory UI data; invocation still enforces the gateway policy independently.
 app.get('/api/capabilities/availability',c=>run(c,()=>{
  const sessionId=c.req.query('sessionId');
  const binding=sessionId?runtime?.store.binding(sessionId):undefined;
  if(sessionId&&!binding)return {available:false,reason:'会话未接入平台连接，请新建会话使用',connections:[]};
  const kind=binding?.runtimeKind??c.req.query('runtimeKind');
  if(kind!=='codex'&&kind!=='claude-code'&&kind!=='pi')return {available:false,reason:'此运行时尚未接入平台连接，请选择 Codex、Claude Code 或 Pi',connections:[]};
  const permission=binding?.permissionMode??c.req.query('permissionMode')??defaultPermissionMode(kind);
  if(permission===readOnlyPermissionMode(kind)||permission==='plan')return {available:false,reason:'当前只读或计划模式未装配外部连接，请切换权限模式后使用',connections:[]};
  if(binding&&(!binding.capabilityGateway||binding.archived||binding.evaluation||binding.roomRef||binding.sourceMode!=='platform-managed'))return {available:false,reason:'此会话未启用平台连接，请新建会话使用',connections:[]};
  const visible=gateway().search({sessionId:binding?.platformSessionId??'connection-preview',turnId:'availability'});
  return {available:true,connections:gateway().connections().filter(x=>x.status==='connected').map(connection=>({
   ...connection,resources:connection.resources.filter(r=>visible.some(x=>x.connectionId===connection.id&&x.resources.includes(r))),
  }))};
 }));
 app.get('/api/capabilities/grants',c=>run(c,()=>({grants:gateway().grants()})));
 app.post('/api/capabilities/grants',c=>run(c,async()=>{
  const raw=await c.req.json();const b=typeof raw.subject==='string'?runtime?.store.binding(raw.subject):undefined;
  if(!b?.capabilityGateway||b.evaluation||b.roomRef||b.archived)throw new GatewayError('SESSION_NOT_ENABLED');
  return gateway().grant(raw,actor);
 }));
 app.delete('/api/capabilities/grants/:id',c=>run(c,()=>{gateway().revoke(c.req.param('id'),actor);return {ok:true};}));
 app.get('/api/capabilities/audit',c=>run(c,()=>({records:gateway().audits(c.req.query('connectionId'),c.req.query('sessionId'))})));
 app.get('/api/capabilities/approvals',c=>run(c,()=>({approvals:gateway().store.list('approval_requests')})));
 // Browser calls get an authenticated owner context, never a request-selected runtime identity.
 app.post('/api/capabilities/invoke',c=>run(c,async()=>gateway().invoke({sessionId:actor,turnId:crypto.randomUUID()},await c.req.json())));
}
