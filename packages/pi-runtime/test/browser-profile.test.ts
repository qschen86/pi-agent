import {chmodSync,existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it} from 'vitest';
import {acquireBrowserProfile,initializeBrowserProfile,validateBrowserProfile} from '../src/browser-profile.js';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function setup(){const root=mkdtempSync(join(tmpdir(),'pi-browser-profile-'));roots.push(root);const workspace=join(root,'workspace'),profile=join(root,'profile');mkdirSync(workspace);initializeBrowserProfile(profile);return{root,workspace,profile};}
it('accepts only a dedicated private profile outside the workspace and keeps data across leases',()=>{
 const t=setup();expect(validateBrowserProfile(t.profile,t.workspace)).toBe(realpathSync(t.profile));
 const release=acquireBrowserProfile(t.profile);writeFileSync(join(t.profile,'data','fixture'),'persisted');release();release();
 expect(existsSync(join(t.profile,'data','fixture'))).toBe(true);const again=acquireBrowserProfile(t.profile);again();
 expect(()=>validateBrowserProfile(t.profile,t.root)).toThrow(/outside/);
 expect(()=>initializeBrowserProfile(t.profile)).toThrow(/new absolute/);
});
it('refuses concurrent and stale leases without stealing them',()=>{
 const t=setup(),release=acquireBrowserProfile(t.profile);
 expect(()=>acquireBrowserProfile(t.profile)).toThrow(/busy/);release();
 writeFileSync(join(t.profile,'runtime.lock'),'crash marker',{mode:0o600});
 expect(()=>acquireBrowserProfile(t.profile)).toThrow(/unreleased/);
});
it('rejects a normal browser directory, shared permissions, and redirected profile data',()=>{
 const t=setup();expect(()=>validateBrowserProfile(t.workspace,t.profile)).toThrow();
 chmodSync(t.profile,0o755);expect(()=>validateBrowserProfile(t.profile,t.workspace)).toThrow(/private/);chmodSync(t.profile,0o700);
 rmSync(join(t.profile,'data'),{recursive:true});symlinkSync(t.workspace,join(t.profile,'data'));
 expect(()=>validateBrowserProfile(t.profile,t.workspace)).toThrow(/private/);
});
