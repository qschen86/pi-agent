import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {RelationError} from './note-relation-types.js';
export interface RuntimeRecordAccess {contextFile:string;clientPath:string}
/** Plaintext exists only in the 0600 per-turn client transport artifact, never in server records. */
export class RuntimeRecordAuth {
 private readonly issued=new Map<string,{hash:Buffer;dir:string;turnId:string;at:number}>();
 constructor(private readonly root:string,private readonly origin:string){const u=new URL(origin);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw new Error('记录端点必须为本机 HTTP');mkdirSync(root,{recursive:true,mode:0o700});}
 issue(sessionId:string,turnId:string):RuntimeRecordAccess {
  this.revoke(sessionId);const dir=mkdtempSync(join(this.root,'record-')),contextFile=join(dir,'context.json'),capability=randomBytes(32).toString('base64url');
  writeFileSync(contextFile,JSON.stringify({origin:this.origin,sessionId,capability}),{mode:0o600,flag:'wx'});this.issued.set(sessionId,{hash:createHash('sha256').update(capability).digest(),dir,turnId,at:Date.now()});
  return {contextFile,clientPath:fileURLToPath(new URL('../../../scripts/runtime-record.mjs',import.meta.url))};
 }
 verify(sessionId:string,capability:unknown):{turnId:string}{
  const value=this.issued.get(sessionId);if(!value||typeof capability!=='string'||capability.length>200||Date.now()-value.at>7*86400000)throw new RelationError('记录能力无效或已过期',401);
  const hash=createHash('sha256').update(capability).digest();if(!timingSafeEqual(value.hash,hash))throw new RelationError('记录能力无效',401);return {turnId:value.turnId};
 }
 retain(sessionId:string,activeTurnIds:readonly string[]):void{const value=this.issued.get(sessionId);if(value&&!activeTurnIds.includes(value.turnId))this.revoke(sessionId);}
 revoke(sessionId:string):void{const v=this.issued.get(sessionId);if(v){rmSync(v.dir,{recursive:true,force:true});this.issued.delete(sessionId);}}
 dispose():void{for(const id of this.issued.keys())this.revoke(id);}
}
