import type { Hono,Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { RuntimeSessionManager,ProjectedEvent } from '@pi-agent/runtime-sessions';
import { NativeNotifications,type NativePushConfig } from './native-notifications.js';
export const NATIVE_SESSION_TTL_MS = 30 * 60_000;
export function mountNativeNotificationRoutes(app:Hono,options:{config?:NativePushConfig;runtime:RuntimeSessionManager;owner:(c:Context)=>string|undefined;authorized:(owner:string)=>boolean;canRead:()=>boolean;shutdown?:AbortSignal}):NativeNotifications|undefined {
 const runtime=options.runtime;
 const readable=(id:string)=>{const b=runtime.store.binding(id);return options.canRead() && !!b && !b.archived && !b.evaluation && b.sourceMode==='platform-managed';};
 const push=options.config?new NativeNotifications({...options.config,authorized:owner=>options.authorized(owner)&&options.canRead(),readable}):undefined;
 app.use('/api/native-notifications/*',bodyLimit({maxSize:8192}));
 app.use('/api/native-notifications/*',async(c,next)=>{
  c.header('Cache-Control','private, no-store');if(!options.owner(c))return c.json({error:'需要有效的设备身份'},401);
  if(!options.canRead())return c.json({error:'未授予会话读取权限'},403);await next();
 });
 app.get('/api/native-notifications/capabilities',c=>c.json({supported:!!push,transport:'fcm',reason:push?undefined:'正式客户端推送服务尚未配置'}));
 app.get('/api/native-notifications/device',c=>{try{return c.json(push?.status(options.owner(c)!)??{registered:false});}catch{return c.json({error:'设备状态暂不可用'},503);}});
 app.put('/api/native-notifications/device',async c=>{
  if(!push)return c.json({error:'推送服务尚未配置'},503);
  if(Number(c.req.header('content-length')??0)>8192)return c.json({error:'注册数据过大'},413);
  try{const raw=await c.req.text();if(raw.length>8192)return c.json({error:'注册数据过大'},413);const j=JSON.parse(raw) as {token?:unknown};if(typeof j.token!=='string')return c.json({error:'注册数据无效'},400);const binding=push.register(options.owner(c)!,j.token);return c.json({registered:true,binding});}
  catch{return c.json({error:'注册未完成'},400);}
 });
 app.post('/api/native-notifications/activate',async c=>{
  if(!push)return c.json({error:'推送服务尚未配置'},503);
  try{const raw=await c.req.text();if(raw.length>4096)return c.json({error:'请求过大'},413);const j=JSON.parse(raw) as {binding?:unknown};if(typeof j.binding!=='string'||j.binding.length>100)return c.json({error:'绑定无效'},400);push.activate(options.owner(c)!,j.binding);return c.json({active:true,binding:j.binding});}
  catch{return c.json({error:'绑定已变化，请重新开启'},409);}
 });
 app.delete('/api/native-notifications/device',c=>{try{push?.unregister(options.owner(c)!);return c.json({registered:false});}catch{return c.json({error:'注销暂未完成'},503);}});
 // No test-send endpoint: live pushes remain a separately authorized real-device acceptance step.
 if(!push)return;
 const collectSession=(id:string)=>{
  if(!readable(id))return;const b=runtime.store.binding(id)!;
  for(const turn of b.turns.slice(-20))if((turn.status==='completed'||turn.status==='failed')&&turn.endedAt){const at=Date.parse(turn.endedAt);push.enqueue({eventId:`turn:${id}:${turn.turnNo}:${turn.status}`,sessionId:id,kind:turn.status,at,expiresAt:at+NATIVE_SESSION_TTL_MS});}
  for(const a of runtime.pendingApprovals().filter(a=>a.platformSessionId===id)){
   const at=Date.parse(a.createdAt);push.enqueue({eventId:`approval:${a.approvalId}`,sessionId:id,kind:'approval',at,expiresAt:Math.min(a.expiresAt?Date.parse(a.expiresAt):Infinity,at+NATIVE_SESSION_TTL_MS)});
  }
 };
 const onSession=(u:{platformSessionId:string})=>{try{collectSession(u.platformSessionId);}catch{/* Durable recovery retries without logging tokens or content. */}};
 const onEvent=(u:{platformSessionId:string;event:ProjectedEvent})=>{if(u.event.kind==='approval')onSession(u);};
 runtime.on('session',onSession);runtime.on('event',onEvent);
 let recovery=0;
 const tick=()=>{try{if(++recovery%15===1)for(const b of runtime.store.allBindings().slice().sort((a,b)=>b.lastActivityAt.at.localeCompare(a.lastActivityAt.at)).slice(0,100))collectSession(b.platformSessionId);void push.flush().catch(()=>{});}catch{/* Retry next tick. */}};
 const timer=setInterval(tick,2000);timer.unref();
 options.shutdown?.addEventListener('abort',()=>{clearInterval(timer);runtime.off('session',onSession);runtime.off('event',onEvent);},{once:true});
 return push;
}
