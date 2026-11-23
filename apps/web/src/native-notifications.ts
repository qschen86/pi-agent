import { createHash,randomUUID } from 'node:crypto';
import { existsSync,mkdirSync,readFileSync,writeFileSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import { withAuthFileLock } from './auth-file-lock.js';
import { FcmFailure } from './native-fcm.js';
export type NativeKind='completed'|'failed'|'approval'|'reminder';
export interface NativeEvent {eventId:string;sessionId:string;kind:NativeKind;at:number;expiresAt:number;title?:string;body?:string;route?:string}
/** 日程提醒的深链：记录页或某一天的那条记录（与 Web Push / Service Worker 同一口径）。 */
export const NATIVE_REMINDER_ROUTE=/^#\/notes(?:\/widget\/\d{4}-\d{2}-\d{2}(?:\/[A-Za-z0-9_-]+)?)?$/;
interface Device {owner:string;token:string;binding:string;since:number;ready:boolean;lastSuccess?:number;lastError?:string}
interface Job {id:string;owner:string;binding:string;event:NativeEvent;attempts:number;due:number;lease?:number}
interface State {version:1;devices:Record<string,Device>;jobs:Record<string,Job>;seen:Record<string,number>}
export interface NativePushConfig {dir:string;send:(token:string,data:Record<string,string>,authorized:()=>boolean)=>Promise<void>;now?:()=>number}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export class NativeNotifications {
 private readonly now:()=>number;private busy=false;
 constructor(private readonly options:NativePushConfig & {authorized:(owner:string)=>boolean;readable:(sessionId:string)=>boolean}){this.now=options.now??Date.now;mkdirSync(options.dir,{recursive:true,mode:0o700});}
 private tx<T>(run:(s:State)=>T):T {
  const file=join(this.options.dir,'native-push.json');return withAuthFileLock(file,()=>{
   const state:State=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{version:1,devices:{},jobs:{},seen:{}};
   if(state.version!==1||!state.devices||!state.jobs||!state.seen)throw Error('notification storage');
   const before=JSON.stringify(state);const result=run(state);
   if(JSON.stringify(state)!==before){const temp=file+`.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(state),{mode:0o600});renameSync(temp,file);}
   return result;
  });
 }
 register(owner:string,token:string):string {
  if(!this.options.authorized(owner)||!/^[A-Za-z0-9_:.-]{80,4096}$/.test(token))throw Error('invalid binding');
  return this.tx(s=>{
   if(!s.devices[owner] && Object.keys(s.devices).length>=100)throw Error('device limit');
   const old=s.devices[owner];if(old?.token===token)return old.binding;
   const pending=Object.values(s.jobs).filter(j=>j.owner===owner && j.event.expiresAt>this.now());
   // FCM tokens must have one owner; re-login replaces former registration and pending jobs.
   for(const [id,d]of Object.entries(s.devices))if(id===owner||d.token===token){delete s.devices[id];for(const [key,j]of Object.entries(s.jobs))if(j.owner===id)delete s.jobs[key];}
   const binding=randomUUID();s.devices[owner]={owner,token,binding,since:old?.since??this.now(),ready:false};
   for(const j of pending){const id=digest(`${owner}|${j.event.eventId}`);s.jobs[id]={...j,id,binding,attempts:0,due:this.now(),lease:undefined};}
   return binding;
  });
 }
 activate(owner:string,binding:string):void{
  if(!this.options.authorized(owner))throw Error('inactive owner');
  this.tx(s=>{const d=s.devices[owner];if(!d||d.binding!==binding)throw Error('stale binding');d.ready=true;});
 }
 unregister(owner:string):void{this.tx(s=>{delete s.devices[owner];for(const[id,j]of Object.entries(s.jobs))if(j.owner===owner)delete s.jobs[id];});}
 status(owner:string){return this.tx(s=>{const d=s.devices[owner];return d&&this.options.authorized(owner)?{registered:true,binding:d.binding,ready:d.ready,lastSuccess:d.lastSuccess,lastError:d.lastError}:{registered:false};});}
 enqueue(event:NativeEvent):void {
  const reminder=event.kind==='reminder';
  const valid=reminder
   ? event.sessionId===''&&NATIVE_REMINDER_ROUTE.test(event.route??'')&&!!event.title?.trim()&&!!event.body?.trim()
     &&event.title.length<=120&&event.body.length<=300
   : /^[A-Za-z0-9_-]{1,200}$/.test(event.sessionId)&&['completed','failed','approval'].includes(event.kind)&&this.options.readable(event.sessionId);
  if(!valid||event.eventId.length>512||!Number.isFinite(event.at)||!Number.isFinite(event.expiresAt)||event.expiresAt<=this.now()||event.at>this.now()+30000)return;
  this.tx(s=>{
   for(const[id,until]of Object.entries(s.seen))if(until<this.now())delete s.seen[id];
   for(const[id,j]of Object.entries(s.jobs))if(j.event.expiresAt<=this.now())delete s.jobs[id];
   for(const d of Object.values(s.devices)){
    // 提醒与具体会话无关：发给所有已激活通知的设备；会话通知仍只给订阅过该会话的设备。
    if(event.at<d.since||!this.options.authorized(d.owner))continue;
    const id=digest(`${d.owner}|${event.eventId}`);
    if(s.seen[id]||s.jobs[id]||Object.keys(s.jobs).length>=1000)continue;
    s.jobs[id]={id,owner:d.owner,binding:d.binding,event,attempts:0,due:this.now()};
   }
  });
 }
 /** 日程提醒：到点发给所有已开启通知的原生设备（与 Web Push 并发，互不依赖）。 */
 enqueueReminder(input:{eventId:string;title:string;body:string;route:string;at:number;expiresAt:number}):void {
  this.enqueue({eventId:input.eventId,sessionId:'',kind:'reminder',at:input.at,expiresAt:input.expiresAt,title:input.title,body:input.body,route:input.route});
 }
 async flush():Promise<void>{
  if(this.busy)return;this.busy=true;
  try{for(let count=0;count<25;count++){
   const claimed=this.tx(s=>{
    for(const[id,j]of Object.entries(s.jobs)){
     const d=s.devices[j.owner];
     const readable=j.event.kind==='reminder'||this.options.readable(j.event.sessionId);
     if(!d||d.binding!==j.binding||j.event.expiresAt<=this.now()||!this.options.authorized(j.owner)||!readable){delete s.jobs[id];continue;}
     if(!d.ready)continue;
     if(j.due>this.now()||(j.lease??0)>this.now())continue;
     j.lease=this.now()+45000;return {job:structuredClone(j),device:structuredClone(d)};
    }
    return undefined;
   });
   if(!claimed)return;
   const {job,device}=claimed;
   const authorized=()=>this.options.authorized(job.owner)&&(job.event.kind==='reminder'||this.options.readable(job.event.sessionId))&&this.status(job.owner).binding===job.binding && this.status(job.owner).ready===true;
   let failure:unknown;
   const data:Record<string,string>={eventId:job.event.eventId,sessionId:job.event.sessionId,kind:job.event.kind,binding:job.binding,expiresAt:String(job.event.expiresAt)};
   if(job.event.kind==='reminder'){data.title=job.event.title??'';data.body=job.event.body??'';data.route=job.event.route??'';}
   try{if(!authorized())throw new FcmFailure();await this.options.send(device.token,data,authorized);}catch(e){failure=e;}
   this.tx(s=>{
    const current=s.jobs[job.id],d=s.devices[job.owner];if(!current||!d||d.binding!==job.binding)return;
    if(!failure){d.lastSuccess=this.now();delete d.lastError;s.seen[job.id]=Math.max(job.event.expiresAt,this.now()+86400000);delete s.jobs[job.id];}
    else if(failure instanceof FcmFailure && failure.unregistered){delete s.devices[job.owner];delete s.jobs[job.id];}
    else{d.lastError='投递未确认';current.attempts++;delete current.lease;current.due=this.now()+Math.min(300000,10000*2**current.attempts);if(current.attempts>=5)delete s.jobs[job.id];}
   });
  }}finally{this.busy=false;}
 }
}
