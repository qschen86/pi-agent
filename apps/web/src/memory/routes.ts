import type { Context, Hono } from 'hono';
import type { MemorySyncService } from './service.js';
import { MemoryError } from './types.js';
export function mountMemoryRoutes(app:Hono,service:MemorySyncService,ctx:{isPublic:(c:Context)=>boolean;settings:()=>{publicHistory:boolean;publicControl:boolean};workspaceAllowed:(workspace:string)=>boolean}):void {
 const allowed=(c:Context,control=false)=>!ctx.isPublic(c) || (control?ctx.settings().publicControl:ctx.settings().publicHistory||ctx.settings().publicControl);
 app.get('/api/memory/status',c=>{
  c.header('Cache-Control','private, no-store');
  if(!allowed(c))return c.json({error:'查看权限未开启',code:'RT_FORBIDDEN'},403);
  return c.json(service.status());
 });
 app.post('/api/memory/sync',async c=>{
  c.header('Cache-Control','private, no-store');
  if(!allowed(c,true))return c.json({error:'控制权限未开启',code:'RT_FORBIDDEN'},403);
  try{
   const body=await c.req.json();
   if(!body || Array.isArray(body) || typeof body!=='object' || Object.keys(body).some(k=>!['workspace','sessionId'].includes(k)) || (typeof body.workspace==='string')===(typeof body.sessionId==='string'))throw new MemoryError('invalid-workspace');
   if(typeof body.sessionId==='string' && (body.sessionId.length>200 || !body.sessionId))throw new MemoryError('invalid-workspace');
   let job;
   if(typeof body.sessionId==='string')job=service.enqueueSession(body.sessionId);
   else{
    if(!ctx.workspaceAllowed(body.workspace))throw new MemoryError('invalid-workspace');
    job=service.enqueue({kind:'manual',workspace:body.workspace,at:new Date().toISOString()});
   }
   if(!job)throw new MemoryError('invalid-workspace');
   return c.json({job:{id:job.id,state:job.state}},202);
  }catch(error){
   const code=error instanceof MemoryError?error.code:'invalid-output';
   return c.json({error:code,code},code==='disabled'?409:code==='busy'||code==='storage-error'?503:400);
  }
 });
}
