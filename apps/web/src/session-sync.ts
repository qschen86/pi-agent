import {createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export type SyncResource = {kind:'rt'|'room';id:string};
export type NoticeCoverage = {version:1;instance:string;order:number};
export type SyncWindow = {limit:number;before?:number;kind?:string};
export type SyncItem = {id:string;seq:number;revision:number;value:Record<string,unknown>};
export type SyncChange = {revision:number;op:'upsert'|'delete';id:string;item?:SyncItem;reason?:'window'};
export interface SourceSnapshot {items:SyncItem[];state:Record<string,unknown>;window:Record<string,unknown>;version:number}
export interface SyncSource {read(range:SyncWindow):Promise<SourceSnapshot>;isComplete():boolean;hasItem?(id:string):boolean}
export interface SyncResponse {
 resource:SyncResource;protocolVersion:1;epoch:string;mode:'snapshot'|'delta'|'unchanged'|'reset-required';
 baseCursor?:string;nextCursor?:string;targetCursor?:string;items?:SyncItem[];changes?:SyncChange[];
 state?:Record<string,unknown>;stateVersion?:number;window?:Record<string,unknown>;hasMore:boolean;resetReason?:string;
 noticeCoverage?:NoticeCoverage;
}
interface Entry {position:number;at:number;bytes:number;change?:SyncChange}
interface Cut {items:SyncItem[];state:Record<string,unknown>;window:Record<string,unknown>;version:number;position:number;bytes:number}
interface Log {incarnation:string;range:string;cut:Cut;entries:Entry[];cuts:Map<number,Cut>;floor:number;used:number;fingerprint:string}
class SyncError extends Error {status=400;code='SYNC_CURSOR'}
/**
 * 落库的基线元数据：只存内容指纹、位置与状态，不存正文。
 * 重启后第一次同步时若源内容指纹一致，就按原位置重建基线，客户端的游标继续有效，无需全量重读。
 */
export interface PersistedSyncLog {range:string;incarnation:string;position:number;floor:number;used:number;fingerprint:string;state:Record<string,unknown>;window:Record<string,unknown>}
interface PersistedJournal {version:1;epoch:string;signer:string;logs:PersistedSyncLog[]}
export interface SessionSyncPersistence {dir:string}

/** Signed logical cuts; a cursor never authorizes access. Sources must prove item revisions complete. */
export class SessionSyncJournal {
 // Process-local ordering only; never persisted and never an authorization token.
 private noticeInstance=randomUUID();
 private noticeOrder=0;
 noticeCoverage():NoticeCoverage{return {version:1,instance:this.noticeInstance,order:++this.noticeOrder};}
 private epoch:string = randomUUID();
 private signer = randomBytes(32);
 private logs = new Map<string,Log>();
 private flights = new Map<string,Promise<unknown>>();
 /** 上次落库的基线，等待重启后第一次同步时按内容指纹决定能否续用 */
 private resume = new Map<string,PersistedSyncLog>();
 private dir?:string;
 private file?:string;
 private timer?:ReturnType<typeof setTimeout>;
 private limits: {maxEntries:number;maxBytes:number;maxTotalBytes:number;ttl:number;pageSize:number;maxPageBytes:number;maxResources:number};
 constructor(options:Partial<SessionSyncJournal['limits']>={}, persistence:SessionSyncPersistence|null = null) {
  this.limits={maxEntries:10000,maxBytes:16*1024*1024,maxTotalBytes:128*1024*1024,ttl:86400000,pageSize:100,maxPageBytes:1024*1024,maxResources:500,...options};
  if(persistence?.dir){this.dir=persistence.dir;this.file=join(persistence.dir,'journal.json');this.restore();}
 }
 private key(resource:SyncResource,range:SyncWindow){return JSON.stringify([resource.kind,resource.id,range.limit,range.before??null,range.kind??null]);}
 private cursor(resource:SyncResource,range:string,position:number){const data=Buffer.from(JSON.stringify({v:1,e:this.epoch,r:resource,w:range,g:this.logs.get(range)!.incarnation,p:position})).toString('base64url');return `${data}.${createHmac('sha256',this.signer).update(data).digest('base64url')}`;}
 private parse(cursor:string,resource:SyncResource,range:string): {position:number;incarnation?:string;reset?:string} {
  try {
   if(cursor.length>4096)throw new Error();const [data,signature,...extra]=cursor.split('.');if(!data||!signature||extra.length)throw new Error();
   const c=JSON.parse(Buffer.from(data,'base64url').toString());
   if(c.v!==1||c.r?.kind!==resource.kind||c.r?.id!==resource.id||!Number.isSafeInteger(c.p)||c.p<0||typeof c.e!=='string'||typeof c.w!=='string'||typeof c.g!=='string')throw new Error();
   // 密钥随基线一起落库，跨重启仍然有效；只有真正换了密钥（落库丢失/损坏）才要求重新取基线。
   if(c.e!==this.epoch)return {position:c.p,reset:'epoch'};
   const wanted=createHmac('sha256',this.signer).update(data).digest(),actual=Buffer.from(signature,'base64url');
   if(actual.length!==wanted.length||!timingSafeEqual(actual,wanted))throw new Error();
   return {position:c.p,incarnation:c.g,...(c.w!==range?{reset:'range'}:{})};
  }catch{throw new SyncError('非法游标或资源不匹配');}
 }
 stats(){return {resources:this.logs.size,entries:[...this.logs.values()].reduce((n,l)=>n+l.entries.length,0),bytes:[...this.logs.values()].reduce((n,l)=>n+l.entries.reduce((a,e)=>a+e.bytes,0)+[...l.cuts.values()].reduce((a,c)=>a+c.bytes,0),0)};}
 invalidate(resource:SyncResource,_reason:string){
  const prefix=JSON.stringify([resource.kind,resource.id]).slice(0,-1)+',';
  let changed=false;
  for(const key of [...this.logs.keys()])if(key.startsWith(prefix)){this.logs.delete(key);changed=true;}
  for(const key of [...this.resume.keys()])if(key.startsWith(prefix)){this.resume.delete(key);changed=true;}
  if(changed)this.schedulePersist();
 }
 /** 源内容指纹：只取跨进程稳定的部分（正文 id/seq/value + 状态 + 窗口）。
  *  item.revision 是进程内自增的变化计数，重启后归零，不能进指纹；客户端排序用的是落库的变化位置。 */
 private content(snapshot:SourceSnapshot){return JSON.stringify({items:snapshot.items.map(i=>({id:i.id,seq:i.seq,value:i.value})),state:snapshot.state,window:snapshot.window});}
 private remember(range:string):boolean {
  const log=this.logs.get(range);
  if(!log)return false; // 失败或未建立基线的请求不清除已落库的续用信息
  const next:PersistedSyncLog={range,incarnation:log.incarnation,position:log.cut.position,floor:log.floor,used:log.used,fingerprint:log.fingerprint,state:log.cut.state,window:log.cut.window};
  const prev=this.resume.get(range);
  this.resume.set(range,next);
  if(this.resume.size>this.limits.maxResources)this.prune();
  // 指纹已包含正文、状态与窗口；位置/实例/下界未变就不必重新落库。
  return !prev||prev.incarnation!==next.incarnation||prev.position!==next.position||prev.floor!==next.floor||prev.fingerprint!==next.fingerprint;
 }
 private prune():void {
  const entries=[...this.resume.values()].sort((a,b)=>a.used-b.used);
  for(let i=0;i<entries.length-this.limits.maxResources;i++)this.resume.delete(entries[i]!.range);
 }
 private schedulePersist():void {
  if(!this.file||this.timer)return;
  this.timer=setTimeout(()=>{this.timer=undefined;this.flush();},2000);
  this.timer.unref?.();
 }
 /** 落库当前基线元数据；关停前调用，保证重启后游标仍可续用。 */
 flush():void {
  if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
  if(!this.file||!this.dir)return;
  try {
   mkdirSync(this.dir,{recursive:true});
   const data:PersistedJournal={version:1,epoch:this.epoch,signer:this.signer.toString('base64'),logs:[...this.resume.values()]};
   const tmp=`${this.file}.tmp`;
   writeFileSync(tmp,JSON.stringify(data),{mode:0o600});
   renameSync(tmp,this.file);
  }catch(e){console.warn('增量同步基线落库失败：',e instanceof Error?e.message:e);}
 }
 private restore():void {
  let raw:unknown;
  try{raw=JSON.parse(readFileSync(this.file!,'utf8'));}catch{return;}
  if(!raw||typeof raw!=='object')return;
  const data=raw as Partial<PersistedJournal>;
  const signer=typeof data.signer==='string'?Buffer.from(data.signer,'base64'):Buffer.alloc(0);
  if(signer.length!==32)return; // 落库损坏：保持随机密钥，退化为每次重取基线
  if(typeof data.epoch==='string'&&data.epoch)this.epoch=data.epoch;
  this.signer=signer;
  if(!Array.isArray(data.logs))return;
  for(const entry of data.logs){
   const log=entry as Partial<PersistedSyncLog>;
   if(!log||typeof log.range!=='string'||typeof log.incarnation!=='string'||!Number.isSafeInteger(log.position)||(log.position??-1)<0||
      !Number.isSafeInteger(log.floor)||(log.floor??-1)<0||typeof log.fingerprint!=='string'||!log.fingerprint||!Number.isFinite(log.used)||
      !log.state||typeof log.state!=='object'||!log.window||typeof log.window!=='object')continue;
   this.resume.set(log.range,log as PersistedSyncLog);
  }
  this.prune();
 }
 private trim(log:Log){
  let bytes=log.entries.reduce((n,e)=>n+e.bytes,0);
  while(log.entries.length && (log.entries.length>this.limits.maxEntries || bytes+log.cut.bytes>this.limits.maxBytes || Date.now()-log.entries[0]!.at>this.limits.ttl)) {const e=log.entries.shift()!;bytes-=e.bytes;log.floor=e.position;}
  for(const [p] of log.cuts)if(p<log.floor&&p!==log.cut.position)log.cuts.delete(p);
  // Full target cuts are budgeted; evict old targets before they consume unbounded state/body memory.
  let total=bytes+[...log.cuts.values()].reduce((n,c)=>n+c.bytes,0);
  for(const [p,c] of log.cuts){if(total<=this.limits.maxBytes)break;if(p===log.cut.position)continue;log.cuts.delete(p);total-=c.bytes;log.floor=Math.max(log.floor,p);}
  let global=[...this.logs.values()].reduce((n,l)=>n+l.entries.reduce((a,e)=>a+e.bytes,0)+[...l.cuts.values()].reduce((a,c)=>a+c.bytes,0),0);
  for(const [key,l] of this.logs){if(global<=this.limits.maxTotalBytes)break;global-=l.entries.reduce((n,e)=>n+e.bytes,0)+[...l.cuts.values()].reduce((n,c)=>n+c.bytes,0);this.logs.delete(key);}
 }
 async sync(resource:SyncResource,source:SyncSource,window:SyncWindow,cursor?:string,targetCursor?:string,resume=false):Promise<SyncResponse>{
  const key=this.key(resource,window),previous=this.flights.get(key)??Promise.resolve();
  const next=previous.catch(()=>{}).then(()=>this.readCut(resource,source,window,cursor,targetCursor,resume));this.flights.set(key,next);
  try{return await next;}finally{if(this.flights.get(key)===next)this.flights.delete(key);}
 }
 private async readCut(resource:SyncResource,source:SyncSource,window:SyncWindow,cursor?:string,targetCursor?:string,resume=false):Promise<SyncResponse>{
  const range=this.key(resource,window);
  const noticeCoverage=this.noticeCoverage();
  try{return {...await this.readCutAt(range,resource,source,window,cursor,targetCursor,resume),noticeCoverage};}
  finally{if(this.remember(range))this.schedulePersist();}
 }
 private async readCutAt(range:string,resource:SyncResource,source:SyncSource,window:SyncWindow,cursor?:string,targetCursor?:string,resume=false):Promise<SyncResponse>{
  const response:SyncResponse={resource,protocolVersion:1,epoch:this.epoch,mode:'reset-required',hasMore:false};
  const base=cursor?this.parse(cursor,resource,range):undefined,target=targetCursor?this.parse(targetCursor,resource,range):undefined;
  if(base?.reset||target?.reset)return {...response,resetReason:base?.reset||target?.reset};
  if(!source.isComplete())return {...response,resetReason:'untracked-source'};
  let snapshot:SourceSnapshot;
  try{snapshot=await source.read(window);}catch(e){if((e as {code?:string}).code==='SYNC_BUSY')return {...response,resetReason:'busy'};throw e;}
  if(!source.isComplete())return {...response,resetReason:'untracked-source'};
  const content=this.content(snapshot),fingerprint=createHash('sha256').update(content).digest('base64url'),bytes=Buffer.byteLength(content);
  let log=this.logs.get(range);
  if(!log){
   const saved=this.resume.get(range);
   if(cursor && saved && saved.fingerprint===fingerprint && bytes<=this.limits.maxBytes){
    // 进程重启后的第一个请求：源内容与上次落库时一致，旧游标仍然有效。按原位置重建基线，避免所有会话同时全量重读。
    const cut:Cut={...structuredClone(snapshot),position:saved.position,bytes};
    log={incarnation:saved.incarnation,range,cut,entries:[],cuts:new Map([[saved.position,cut]]),floor:saved.position,used:Date.now(),fingerprint};
    this.logs.set(range,log);
   }
  }
  if(!log){
   const cut:Cut={...structuredClone(snapshot),position:0,bytes};
   if(cut.bytes>this.limits.maxBytes)return {...response,resetReason:'oversized-baseline'};
   log={incarnation:randomUUID(),range,cut,entries:[],cuts:new Map([[0,cut]]),floor:0,used:Date.now(),fingerprint};this.logs.set(range,log);
   if(cursor)return {...response,resetReason:'log-missing'};
  }else if(log.cut.version!==snapshot.version || JSON.stringify(log.cut.state)!==JSON.stringify(snapshot.state) || JSON.stringify(log.cut.window)!==JSON.stringify(snapshot.window)){
   const before=new Map(log.cut.items.map(i=>[i.id,i])),after=new Map(snapshot.items.map(i=>[i.id,i]));
   const changes:Array<Omit<SyncChange,'revision'>>=[];
   for(const old of before.values())if(!after.has(old.id))changes.push({op:'delete',id:old.id,...(source.hasItem?.(old.id)?{reason:'window' as const}:{})});
   for(const item of after.values()){const old=before.get(item.id);if(!old||old.revision!==item.revision||old.seq!==item.seq)changes.push({op:'upsert',id:item.id,item:structuredClone(item)});}
   let p=log.cut.position;
   for(const change of changes){const c={...change,revision:++p};log.entries.push({position:p,at:Date.now(),bytes:Buffer.byteLength(JSON.stringify(c)),change:c});}
   // State/window-only changes also have their own position.
   log.entries.push({position:++p,at:Date.now(),bytes:32});
   const cut:Cut={...structuredClone(snapshot),position:p,bytes};log.cut=cut;log.cuts.set(p,cut);log.fingerprint=fingerprint;
  }
  log.used=Date.now();this.logs.delete(range);this.logs.set(range,log);this.trim(log);
  if(log.cut.bytes>this.limits.maxBytes)this.logs.delete(range);
  if(!this.logs.has(range))return {...response,resetReason:'budget'};
  if(!cursor){const next=this.cursor(resource,range,log.cut.position);return {...response,mode:'snapshot',items:log.cut.items,state:log.cut.state,stateVersion:log.cut.position,window:log.cut.window,nextCursor:next,targetCursor:next};}
  if(base?.incarnation!==log.incarnation||target&&target.incarnation!==log.incarnation)return {...response,resetReason:'log-recreated'};
  const end=target?.position??log.cut.position;
  if(!base||base.position<log.floor||base.position>log.cut.position||end<base.position||!log.cuts.has(end))return {...response,resetReason:'cursor-expired'};
  const cut=log.cuts.get(end)!;
  const all=log.entries.filter(e=>e.position>base.position&&e.position<=end),page:Entry[]=[];let bytes2=0;
  for(const entry of all){if(entry.bytes>this.limits.maxPageBytes)return {...response,resetReason:'oversized-change'};if(page.length>=this.limits.pageSize||bytes2+entry.bytes>this.limits.maxPageBytes)break;page.push(entry);bytes2+=entry.bytes;}
  const position=page.at(-1)?.position??base.position,hasMore=position<end,next=this.cursor(resource,range,position);
  return {...response,mode:base.position===end?'unchanged':'delta',baseCursor:cursor,nextCursor:next,targetCursor:this.cursor(resource,range,end),changes:page.flatMap(e=>e.change?[e.change]:[]),hasMore,...(!hasMore && (resume || base.position!==end) ? {state:cut.state,stateVersion:end,window:cut.window}:{})};
 }
}
export function syncWindow(query:Record<string,string>,kind:'rt'|'room'):SyncWindow {
 const limit=Number(query.limit??(kind==='rt'?100:50));const before=query.before===undefined?undefined:Number(query.before);
 if(![50,100,200].includes(limit)||!Number.isFinite(limit)||(kind==='room'&&limit!==50)||before!==undefined&&(!Number.isFinite(before)||before<0)||query.kind!==undefined&&!['tool','conversation'].includes(query.kind))throw new SyncError('非法同步窗口');
 return {limit,...(before!==undefined?{before}:{}),...(query.kind?{kind:query.kind}:{})};
}
