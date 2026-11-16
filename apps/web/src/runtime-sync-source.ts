import {statSync} from 'node:fs';
import {join} from 'node:path';
import type {ProjectedEvent, RuntimeSessionManager} from '@pi-agent/runtime-sessions';
import type {SyncSource, SyncWindow} from './session-sync.js';
export function fileVersion(path:string):string {try{const s=statSync(path,{bigint:true});return `${s.ino}:${s.size}:${s.mtimeNs}`;}catch{return 'missing';}}
export class RuntimeSyncSources {
 private revisions=new WeakMap<ProjectedEvent,number>();private versions=new Map<string,number>();private files=new Map<string,string>();private untracked=new Set<string>();
 constructor(private mgr:RuntimeSessionManager){mgr.store.subscribeProjectionChanges(c=>{
  if(c.type==='before-event'){this.check(c.sessionId);return;}
  if(c.type==='reset'){this.untracked.add(c.sessionId);return;}
  const version=(this.versions.get(c.sessionId)??0)+1;this.versions.set(c.sessionId,version);if(c.event)this.revisions.set(c.event,version);this.files.set(c.sessionId,this.fingerprint(c.sessionId));
 });}
 private fingerprint(id:string){return fileVersion(join(this.mgr.store.dir,'events',`${id}.jsonl`));}
 private check(id:string){const next=this.fingerprint(id),old=this.files.get(id);if(old!==undefined&&old!==next){this.untracked.add(id);this.mgr.store.reloadProjection(id);}this.files.set(id,next);}
 source(id:string):SyncSource{return {
  hasItem:key=>this.mgr.store.events(id).some(e=>e.key===key),
  isComplete:()=>{this.check(id);return !!this.mgr.store.binding(id)&&!this.untracked.has(id);},
  read:async(range:SyncWindow)=>{
   for(let attempt=0;attempt<3;attempt++){
    this.check(id);const version=this.versions.get(id)??0;
    const [page,view]=await Promise.all([this.mgr.messages(id,range),this.mgr.view(id,{includeUsage:false})]);
    if(version!==(this.versions.get(id)??0))continue;
    // Account quota/profile are independent resources, excluded from resource sync.
    const {rateLimit:_rateLimit,profile:_profile,usage:_usage,...state}=view;
    return {items:page.events.map(e=>({id:e.key,seq:e.seq,revision:this.revisions.get(e)??0,value:e as unknown as Record<string,unknown>})),state:state as unknown as Record<string,unknown>,window:{total:page.total,hasMoreBefore:page.hasMoreBefore,firstSeq:page.firstSeq,lastSeq:page.lastSeq,coverage:page.coverage,notes:page.notes},version};
   }
   throw Object.assign(new Error('基线变化过快'),{code:'SYNC_BUSY'});
  }
 };}
}
