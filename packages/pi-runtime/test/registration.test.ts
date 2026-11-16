import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { registeredRuntimeExecutable } from '../src/registration.js';
import { prepareRuntimeConnection, resolveRuntimeInvocation } from '../src/connection.js';
const roots:string[]=[];afterEach(()=>{vi.unstubAllEnvs();roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
function setup(){const root=realpathSync(mkdtempSync(join(tmpdir(),'prt-reg-')));roots.push(root);const file=join(root,'connection.json'),executable=join(root,'pi-runtime');writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700});return {root,file,executable};}
it('uses only a valid absolute executable and refuses a broken registration',()=>{
 const t=setup();expect(registeredRuntimeExecutable(t.file)).toBeUndefined();
 writeFileSync(t.file,JSON.stringify({version:1,executable:t.executable}));expect(registeredRuntimeExecutable(t.file)).toBe(t.executable);
 chmodSync(t.executable,0o600);expect(()=>registeredRuntimeExecutable(t.file)).toThrow();chmodSync(t.executable,0o700);
 for(const raw of [{version:1,executable:'./workspace-script'},{version:1,executable:t.executable,profile:'untrusted'},null]){writeFileSync(t.file,JSON.stringify(raw));expect(()=>registeredRuntimeExecutable(t.file)).toThrow();}
});
it('uses registration as an RPC locator, honors explicit overrides and refuses workspace-owned executables',async()=>{
 const t=setup();vi.stubEnv('PI_RUNTIME_REGISTRATION',t.file);writeFileSync(t.file,JSON.stringify({version:1,executable:t.executable}));
 const workspace=join(t.root,'workspace'),controlRoot=join(t.root,'control');mkdirSync(workspace);mkdirSync(controlRoot);
 const spec={version:1 as const,binary:'/opt/pi',workspace,provider:'fixture',model:'fixture',mode:'pi-ask',sessionId:'12345678-1234-1234-1234-123456789abc'};
 expect((await prepareRuntimeConnection({spec,controlRoot})).endpoint.binaryPath).toBe(t.executable);
 expect((await prepareRuntimeConnection({spec,controlRoot,invocation:{binaryPath:'/explicit/runtime'}})).endpoint.binaryPath).toBe('/explicit/runtime');
 await expect(prepareRuntimeConnection({spec:{...spec,workspace:t.root},controlRoot})).rejects.toThrow('outside the workspace');
 writeFileSync(t.file,'bad json');await expect(prepareRuntimeConnection({spec,controlRoot})).rejects.toThrow();
});

it('uses the same invocation precedence for runtime discovery and launch',()=>{const t=setup();vi.stubEnv('PI_RUNTIME_REGISTRATION',t.file);expect(resolveRuntimeInvocation().binaryPath).toBe(process.execPath);writeFileSync(t.file,JSON.stringify({version:1,executable:t.executable}));expect(resolveRuntimeInvocation().binaryPath).toBe(t.executable);const local=resolveRuntimeInvocation({args:['--profile','/operator/profile.json']});expect(local.binaryPath).toBe(process.execPath);expect(local.args?.slice(-2)).toEqual(['--profile','/operator/profile.json']);expect(resolveRuntimeInvocation({binaryPath:'/explicit/runtime',args:['--profile','x']})).toEqual({binaryPath:'/explicit/runtime',args:['--profile','x']});});
