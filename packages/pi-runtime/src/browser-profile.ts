/** Dedicated browser state, owned by the runtime operator rather than a workspace. */
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { canonicalPath, isWithin } from '../../adapter-pi/src/runtime-guard-policy.js';

const MARKER='pi-runtime-browser-profile.json';
function privateDirectory(path:string):string {
  const stat=lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid())throw new Error('Browser profile must be a private operator-owned directory');
  return realpathSync(path);
}
export function initializeBrowserProfile(path:string):void {
  if(!isAbsolute(path)||existsSync(path))throw new Error('Browser profile initialization requires a new absolute directory');
  mkdirSync(path,{mode:0o700});
  mkdirSync(join(path,'data'),{mode:0o700});
  writeFileSync(join(path,MARKER),JSON.stringify({version:1,owner:'pi-runtime',purpose:'browser-profile'})+'\n',{mode:0o400,flag:'wx'});
}
export function validateBrowserProfile(path:string,workspace:string):string {
  if(!isAbsolute(path))throw new Error('Browser profile path must be absolute');
  const root=privateDirectory(path),cwd=canonicalPath(workspace);
  if(isWithin(root,cwd)||isWithin(cwd,root))throw new Error('Browser profile must be outside the workspace');
  const marker=join(root,MARKER),stat=lstatSync(marker);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid())throw new Error('Invalid browser profile ownership marker');
  const value=JSON.parse(readFileSync(marker,'utf8'));
  if(value.version!==1||value.owner!=='pi-runtime'||value.purpose!=='browser-profile')throw new Error('Unmanaged browser profile');
  if(privateDirectory(join(root,'data'))!==join(root,'data'))throw new Error('Browser profile data cannot be redirected');
  return root;
}
export function acquireBrowserProfile(root:string):()=>void {
  const path=join(root,'runtime.lock');let fd:number;
  try{fd=openSync(path,'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Browser profile is busy or has an unreleased runtime.lock; use another profile or inspect its owner process');throw e;}
  const inode=fstatSync(fd).ino;
  writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n');
  let released=false;
  return ()=>{if(released)return;released=true;closeSync(fd);try{if(lstatSync(path).ino===inode)unlinkSync(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};
}
