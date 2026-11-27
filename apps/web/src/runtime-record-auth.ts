import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync,rmSync,readFileSync,lstatSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,sep} from 'node:path';import {fileURLToPath} from 'node:url';
import {RelationError} from './note-relation-types.js';
export interface RuntimeRecordAccess {contextFile:string;clientPath:string}
/**
 * 记录入口的目录与脚本路径都会写进系统提示；这两段只要随进程 / 部署槽变化，模型缓存就从系统提示前部断开、整段历史按全价重算。
 * 所以根目录按当前用户固定（不再每个进程 mkdtemp），脚本路径里的 slots/<槽> 换成始终指向当前槽的 <根>/current 别名。
 */
export function stableRecordRoot():string{
 const root=join(tmpdir(),'pi-record-clients-'+(process.getuid?.()??'user'));mkdirSync(root,{recursive:true,mode:0o700});
 const st=lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink()||(process.getuid&&st.uid!==process.getuid())||(st.mode&0o077)!==0)throw new Error('记录入口目录不安全：'+root);
 return root;
}
export function stableRecordClientPath(real:string,isSymlink:(path:string)=>boolean=p=>{try{return lstatSync(p).isSymbolicLink();}catch{return false;}}):string{
 const marker=sep+'slots'+sep,at=real.lastIndexOf(marker);if(at<0)return real;
 const rest=real.slice(at+marker.length),cut=rest.indexOf(sep);if(cut<=0)return real;
 const base=real.slice(0,at),alias=join(base,'current');
 return isSymlink(alias)?join(alias,rest.slice(cut+1)):real;
}
/** Plaintext exists only in the 0600 per-turn client transport artifact (stable per-session path, rotated content), never in server records. */
export class RuntimeRecordAuth {
 private readonly issued=new Map<string,{hash:Buffer;dir:string;turnId:string;at:number}>();
 constructor(private readonly root:string,private readonly origin:string){const u=new URL(origin);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw new Error('记录端点必须为本机 HTTP');mkdirSync(root,{recursive:true,mode:0o700});}
 issue(sessionId:string,turnId:string):RuntimeRecordAccess {
  // 目录名只由会话 id 决定：路径会写进系统提示，每回合换名会让模型缓存从系统提示前部断开、整段历史按全价重算。
  // 每回合轮换的只有 context.json 里的 capability（不进提示）。
  const dir=join(this.root,'record-'+createHash('sha256').update(sessionId).digest('hex').slice(0,16)),contextFile=join(dir,'context.json'),capability=randomBytes(32).toString('base64url');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const tmp=join(dir,`context.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp,JSON.stringify({origin:this.origin,sessionId,capability}),{mode:0o600,flag:'wx'});renameSync(tmp,contextFile);
  this.issued.set(sessionId,{hash:createHash('sha256').update(capability).digest(),dir,turnId,at:Date.now()});
  return {contextFile,clientPath:stableRecordClientPath(fileURLToPath(new URL('../../../scripts/runtime-record.mjs',import.meta.url)))};
 }
 verify(sessionId:string,capability:unknown):{turnId:string}{
  const value=this.issued.get(sessionId);if(!value||typeof capability!=='string'||capability.length>200||Date.now()-value.at>7*86400000)throw new RelationError('记录能力无效或已过期',401);
  const hash=createHash('sha256').update(capability).digest();if(!timingSafeEqual(value.hash,hash))throw new RelationError('记录能力无效',401);return {turnId:value.turnId};
 }
 retain(sessionId:string,activeTurnIds:readonly string[]):void{const value=this.issued.get(sessionId);if(value&&!activeTurnIds.includes(value.turnId))this.revoke(sessionId);}
 revoke(sessionId:string):void{
  const v=this.issued.get(sessionId);if(!v)return;this.issued.delete(sessionId);
  // 根目录跨进程共用：新进程可能已为同一会话重新签发，只清理仍属于自己的那份，别删掉新进程刚写好的入口。
  try{const now=JSON.parse(readFileSync(join(v.dir,'context.json'),'utf8')).capability;if(typeof now!=='string'||!timingSafeEqual(createHash('sha256').update(now).digest(),v.hash))return;}catch{}
  rmSync(v.dir,{recursive:true,force:true});
 }
 dispose():void{for(const id of this.issued.keys())this.revoke(id);}
}
