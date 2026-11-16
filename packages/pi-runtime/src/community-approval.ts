/** Adapter for the pinned community permission dialog. Ordinary Pi questions stay untouched. */
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { withPermissionMutex } from './permission-mutex.js';
import { parsePermissionGrantList, type PermissionGrant, type PermissionGrantList } from './permission-control.js';
import type { PiRpcEvent } from './pi-client.js';

export function communityApproval(event: PiRpcEvent) {
  if (event.type !== 'extension_ui_request' || event.method !== 'select' || typeof event.title !== 'string' || !event.title.startsWith('Permission Required\n')) return;
  const options = event.options;
  if (!Array.isArray(options) || options.some(x => typeof x !== 'string') || options[0] !== 'Yes' || !options.includes('No') || !options.includes('No, provide reason')) return;
  // The first session option is the proven direction; never choose the optional wider read+write grant.
  const session = options[1];
  if (typeof session !== 'string' || !(session === 'Yes, for this session' || /^Yes, allow .+ for this session$/.test(session))) return;
  const action = event.title.slice('Permission Required\n'.length);
  return { action, session, tool: /^tool\s*:\s*([^\s]+)\s*$/m.exec(action)?.[1] ?? 'unknown', key: createHash('sha256').update(JSON.stringify({title:event.title, options})).digest('hex') };
}

/** Supervisor-owned grants: every decision reads the current, atomically published revision. */
export class CommunitySessionGrants {
  private memory: PermissionGrantList = {version:1,revision:0,grants:[]};
  constructor(private file: string | undefined, private identity: string) { this.read(); }
  private read(): PermissionGrantList {
    if (!this.file) return structuredClone(this.memory);
    let stat;
    try { stat=lstatSync(this.file); } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,revision:0,grants:[]};throw error; }
    if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)||stat.size>2*1024*1024)throw new Error('Unsafe runtime permission grants');
    const data=JSON.parse(readFileSync(this.file,'utf8'));
    if(data.identity!==this.identity)throw new Error('Invalid runtime permission grants identity');
    if(data.version===1 && Array.isArray(data.keys) && data.keys.length<=1000 && data.keys.every((k:unknown)=>typeof k==='string'&&/^[a-f0-9]{64}$/.test(k))){
      return {version:1,revision:0,grants:[...new Set<string>(data.keys)].map(id=>({id,tool:'unknown',action:'历史精确请求授权',scope:'',grantedAt:null}))};
    }
    if(data.version!==2)throw new Error('Invalid runtime permission grants');
    return parseStoredGrants(data);
  }
  list(): PermissionGrantList { return this.read(); }
  has(key:string) { return this.read().grants.some(g=>g.id===key); }
  private update(change:(state:PermissionGrantList)=>boolean):boolean {
    const save=()=>{
      const state=this.read();if(!change(state))return false;
      if(!this.file){this.memory=state;return true;}
      const temporary=this.file+'.tmp-'+randomUUID();
      try{
        const fd=openSync(temporary,'wx',0o600);
        try{const data=JSON.stringify({version:2,identity:this.identity,revision:state.revision,grants:state.grants});if(Buffer.byteLength(data)>2*1024*1024)throw new Error('Runtime permission storage limit reached');writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}
        renameSync(temporary,this.file);
        const directory=openSync(dirname(this.file),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
      }finally{rmSync(temporary,{force:true});}
      return true;
    };
    if(!this.file)return save();
    const root=dirname(this.file);mkdirSync(root,{recursive:true,mode:0o700});
    const stat=lstatSync(root);if(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o077))throw new Error('Unsafe runtime permission directory');
    const lockRoot=this.file+'.control';mkdirSync(lockRoot,{recursive:true,mode:0o700});
    const lockStat=lstatSync(lockRoot);if(!lockStat.isDirectory()||lockStat.uid!==process.getuid?.()||(lockStat.mode&0o077))throw new Error('Unsafe runtime permission control');
    const result=withPermissionMutex(lockRoot,save);if(typeof result!=='boolean')throw new Error('Runtime permission store busy; retry');return result;
  }
  add(key:string,detail?:Pick<PermissionGrant,'tool'|'action'|'scope'>,expectedRevision?:number):boolean {
    if(!/^[a-f0-9]{64}$/.test(key))throw new Error('Invalid runtime grant ID');
    return this.update(state=>{
      if(expectedRevision!==undefined&&expectedRevision!==state.revision)return false;
      if(state.grants.some(g=>g.id===key))return true;
      if(state.grants.length>=1000)throw new Error('Runtime permission grant limit reached');
      state.grants.push({id:key,tool:(detail?.tool??'unknown').slice(0,160),action:(detail?.action??'精确请求授权').slice(0,1000),scope:(detail?.scope??'').slice(0,4096),grantedAt:new Date().toISOString()});return true;
    });
  }
  revoke(id?:string):PermissionGrantList {
    if(id!==undefined&&!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid runtime grant ID');
    this.update(state=>{state.grants=id===undefined?[]:state.grants.filter(g=>g.id!==id);state.revision++;if(!Number.isSafeInteger(state.revision))throw new Error('Runtime permission revision exhausted');return true;});
    return this.list();
  }
}
function parseStoredGrants(data:Record<string,unknown>):PermissionGrantList {
  // The same bounded wire validator is used by terminal and platform clients.
  return parsePermissionGrantList({version:1,revision:data.revision,grants:data.grants});
}
