import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {CommunitySessionGrants} from '../src/community-approval.js';
import {controlPermissionGrants} from '../src/permission-control.js';
const exec=promisify(execFile);
it('controls legacy exact grants through the real CLI without starting a model, scoped by native history',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'pi-grant-cli-')));
 try{
  const ws=join(root,'work'),id=randomUUID(),session=join(root,'session.jsonl'),dir=join(root,'permissions'),file=join(dir,id+'.json');mkdirSync(ws);mkdirSync(dir,{mode:0o700});
  writeFileSync(session,JSON.stringify({type:'session',id,cwd:ws})+'\n'+JSON.stringify({type:'custom',customType:'pi-runtime-assembly',data:{fingerprint:'a'.repeat(64)}})+'\n');
  writeFileSync(file,JSON.stringify({version:1,identity:JSON.stringify([id,ws,'a'.repeat(64)]),keys:['b'.repeat(64),'c'.repeat(64)]}),{mode:0o600});
  const run=async(args:string[])=>(await exec(process.execPath,['packages/pi-runtime/bin/pi-runtime.mjs','--state-dir',root,...args],{timeout:10000})).stdout;
  const before=await controlPermissionGrants(run,session,ws);expect(before.grants).toHaveLength(2);expect(before.grants[0]).toMatchObject({tool:'unknown',grantedAt:null});
  const one=await controlPermissionGrants(run,session,ws,{id:'b'.repeat(64)});expect(one.grants.map(g=>g.id)).toEqual(['c'.repeat(64)]);
  await expect(controlPermissionGrants(run,session,root,{})).rejects.toThrow();
  expect(new CommunitySessionGrants(file,JSON.stringify([id,ws,'a'.repeat(64)])).has('c'.repeat(64))).toBe(true);
  expect((await controlPermissionGrants(run,session,ws,{})).grants).toEqual([]);
  expect(JSON.parse(readFileSync(file,'utf8')).revision).toBe(2);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
it('does not send unknown control flags to an old runtime',async()=>{
 const calls:string[][]=[];
 await expect(controlPermissionGrants(async args=>{calls.push(args);return '{}';},'/session','/work')).rejects.toThrow(/不支持/);
 expect(calls).toEqual([['--describe']]);
});
it('rejects symlinked grant state and malformed metadata rather than reusing cached authorization',()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-grant-invalid-'));
 try{
  const file=join(root,'grants.json'),key='a'.repeat(64),grants=new CommunitySessionGrants(file,'identity');grants.add(key);
  writeFileSync(file,'{}');expect(()=>grants.has(key)).toThrow();
  const target=join(root,'target');writeFileSync(target,'{}');rmSync(file);symlinkSync(target,file);expect(()=>new CommunitySessionGrants(file,'identity')).toThrow(/Unsafe/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
