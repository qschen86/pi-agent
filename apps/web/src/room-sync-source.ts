import {join} from 'node:path';
import type {RoomService} from './room-service.js';
import type {SyncSource} from './session-sync.js';
import {fileVersion} from './runtime-sync-source.js';
export class RoomSyncSources {
 private fingerprint:string;private version:number;private untracked=false;
 constructor(private rooms:RoomService){this.fingerprint=this.file();this.version=rooms.projectionVersion();}
 private file(){return fileVersion(join(this.rooms.mgr.store.dir,'rooms.json'));}
 source(id:string):SyncSource{return {
  hasItem:key=>this.rooms.projectionContains(id,key),
  isComplete:()=>{
   const next=this.file(),version=this.rooms.projectionVersion();
   if(next!==this.fingerprint && version===this.version)this.untracked=true;
   this.fingerprint=next;this.version=version;
   return !this.untracked && this.rooms.projectionComplete();
  },
  read:async(range)=>{
   await this.rooms.ready;const view=this.rooms.view(id,range),{messages,...state}=view;
   state.latestReplies = state.latestReplies.map(m => ({seq:m.seq,kind:m.kind,memberId:m.memberId} as typeof m));
   return {items:messages.map(m=>({id:String(m.seq),seq:m.seq,revision:this.rooms.projectionRevision(m),value:m as unknown as Record<string,unknown>})),state:state as unknown as Record<string,unknown>,window:{total:view.total,hasMore:view.hasMore,firstSeq:messages[0]?.seq,lastSeq:messages.at(-1)?.seq},version:this.rooms.projectionVersion()};
  }
 };}
}
