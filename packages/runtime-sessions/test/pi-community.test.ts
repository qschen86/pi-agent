import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadPiCommunityProfile, PI_BROWSER_TOOLS, PI_BROWSER_PASSIVE_TOOLS, communityPermissionConfig } from "../src/pi-community-profile.js";
import { createPiToolGate } from "../src/pi-approval-extension.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, {recursive:true,force:true})));
function setup() {
  const root = mkdtempSync(join(tmpdir(), "pi-profile-test-")); roots.push(root);
  const workspace=join(root,"workspace"), pkg=join(root,"node_modules/@gotgenes/pi-permission-system"), profile=join(root,"profile.json");
  mkdirSync(workspace);mkdirSync(join(pkg,"src"),{recursive:true});
  writeFileSync(join(pkg,"package.json"),JSON.stringify({name:"@gotgenes/pi-permission-system",version:"40.2.2"}));
  writeFileSync(join(pkg,"src/index.ts"),"");writeFileSync(join(pkg,"src/service.ts"),"");
  writeFileSync(profile,JSON.stringify({version:1,permissionPackage:pkg}));
  return {root,workspace,pkg,profile};
}
it("requires the pinned package and an installation outside the workspace, including symlink targets",()=>{
  const t=setup();expect(loadPiCommunityProfile(t.profile,t.workspace).fingerprint).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(join(t.pkg,"package.json"),JSON.stringify({name:"@gotgenes/pi-permission-system",version:"41.0.0"}));
  expect(()=>loadPiCommunityProfile(t.profile,t.workspace)).toThrow(/40.2.2/);
  const alias=join(t.workspace,"alias.json");symlinkSync(t.profile,alias);
  // A resolved host-owned file is acceptable; an actual workspace file is not.
  expect(()=>loadPiCommunityProfile(alias,t.workspace)).toThrow(/40.2.2/);
  writeFileSync(join(t.workspace,"profile.json"),JSON.stringify({version:1,permissionPackage:t.pkg}));
  expect(()=>loadPiCommunityProfile(join(t.workspace,"profile.json"),t.workspace)).toThrow(/outside/);
});
it("fails closed on unknown profile fields",()=>{
  const t=setup();writeFileSync(t.profile,JSON.stringify({version:1,permissionPackage:t.pkg,extensions:["unsafe"]}));
  expect(()=>loadPiCommunityProfile(t.profile,t.workspace)).toThrow(/Unknown/);
});
it("community gate requires initialization, blocks unlisted tools and never adds a duplicate approval",async()=>{
  let ready=false,asked=0;
  const gate=createPiToolGate("pi-ask",{tools:[PI_BROWSER_TOOLS[0]],ready:()=>ready});
  const ctx={hasUI:true,ui:{confirm:async()=>{asked++;return true;}}};
  const call=(name:string,id=name)=>({toolName:name,toolCallId:id,input:{}});
  expect(await gate(call("write"),ctx)).toMatchObject({block:true});
  ready=true;
  expect(await gate(call("write"),ctx)).toBeUndefined();
  expect(await gate(call("write"),ctx)).toMatchObject({block:true});
  expect(await gate(call(PI_BROWSER_TOOLS[0]),ctx)).toBeUndefined();
  expect(await gate(call("mcp__other__execute"),ctx)).toMatchObject({block:true});
  expect(asked).toBe(0);
});

it('assembles runtime-owned Playwright Test, runs its tools under the OS guard without per-call prompts, and installs nothing into the workspace',()=>{
  const t=setup(),toolchain=join(t.root,'test-toolchain/node_modules/@playwright/test');
  mkdirSync(toolchain,{recursive:true});writeFileSync(join(toolchain,'package.json'),JSON.stringify({name:'@playwright/test',version:'1.63.0'}));writeFileSync(join(toolchain,'cli.js'),'');
  writeFileSync(t.profile,JSON.stringify({version:1,permissionPackage:t.pkg,testing:{packageRoot:toolchain}}));
  const p=loadPiCommunityProfile(t.profile,t.workspace);
  expect(p.tools).toContain('mcp__playwright_test__test_run');expect(p.tools).toContain('mcp__playwright_test__test_list');
  const config=communityPermissionConfig(p.tools);expect((config.permission.mcp as Record<string,string>)['mcp__playwright_test__test_run']).toBe('allow');
  expect(p.readable).toContain(realpathSync(join(t.root,'test-toolchain/node_modules')));
  const first=p.fingerprint;writeFileSync(join(toolchain,'cli.js'),'changed');expect(loadPiCommunityProfile(t.profile,t.workspace).fingerprint).not.toBe(first);
  const local=join(t.workspace,'node_modules/@playwright/test');mkdirSync(local,{recursive:true});writeFileSync(join(local,'package.json'),JSON.stringify({name:'@playwright/test',version:'1.63.0'}));
  writeFileSync(t.profile,JSON.stringify({version:1,permissionPackage:t.pkg,testing:{packageRoot:local}}));expect(()=>loadPiCommunityProfile(t.profile,t.workspace)).toThrow(/outside/);
});

it('keeps old native sessions on their exact operator assembly when new runtime tools are installed',async()=>{
  const t=setup(),old=join(t.root,'old.json'),history=join(t.root,'history.jsonl'),catalog=join(t.root,'resume-profiles.json');
  const fingerprint=loadPiCommunityProfile(t.profile,t.workspace).fingerprint;
  writeFileSync(old,JSON.stringify({version:1,permissionPackage:t.pkg}));
  writeFileSync(history,JSON.stringify({type:'custom',customType:'pi-runtime-assembly',data:{fingerprint}})+'\n');
  const other=join(t.root,'other/node_modules/@gotgenes/pi-permission-system');mkdirSync(join(other,'src'),{recursive:true});
  writeFileSync(join(other,'package.json'),JSON.stringify({name:'@gotgenes/pi-permission-system',version:'40.2.2'}));writeFileSync(join(other,'src/index.ts'),'');writeFileSync(join(other,'src/service.ts'),'');
  writeFileSync(t.profile,JSON.stringify({version:1,permissionPackage:other}));
  writeFileSync(catalog,JSON.stringify({version:1,profiles:[{fingerprint,profile:old}]}),{mode:0o600});
  const {selectHistoricalProfile}=await import('../../pi-runtime/src/assembly-history.js');
  expect(selectHistoricalProfile({profile:t.profile,sessionFile:history,catalogFile:catalog,workspace:t.workspace})).toBe(old);
  writeFileSync(old,JSON.stringify({version:1,permissionPackage:other}));
  expect(()=>selectHistoricalProfile({profile:t.profile,sessionFile:history,catalogFile:catalog,workspace:t.workspace})).toThrow(/historical/i);
});

describe('community permission policy', () => {
  const tools = [...PI_BROWSER_TOOLS, 'mcp__playwright_test__test_list', 'mcp__playwright_test__test_run'];
  const scope = { home: '/Users/me', readRoots: ['/private/tmp/rt/home', '/Users/me/repo/.git'], writeRoots: ['/private/tmp/rt/tmp'] };

  it('does not prompt for browser and test tools in the isolated profile', () => {
    const mcp = communityPermissionConfig(tools, scope).permission.mcp as Record<string, string>;
    expect(mcp['*']).toBe('deny');
    for (const tool of tools) expect(mcp[tool]).toBe('allow');
  });
  it('keeps page-driving browser tools behind a human for a persistent profile, but not observation', () => {
    const mcp = communityPermissionConfig(tools, { ...scope, persistentBrowser: true }).permission.mcp as Record<string, string>;
    for (const tool of PI_BROWSER_PASSIVE_TOOLS) expect(mcp[tool]).toBe('allow');
    for (const tool of ['navigate', 'click', 'type', 'evaluate', 'file_upload', 'fill_form']) expect(mcp[`mcp__playwright__browser_${tool}`]).toBe('ask');
    expect(mcp['mcp__playwright_test__test_run']).toBe('allow');
  });
  it('refuses, rather than asks about, paths the OS guard would reject anyway', () => {
    const { permission } = communityPermissionConfig(tools, scope) as any;
    expect(permission.external_directory).toBeUndefined();
    // last match wins: allow everything, deny home, re-allow the sandbox's own readable roots
    const read = permission.external_directory_read as Record<string, string>, keys = Object.keys(read);
    expect(keys.slice(-6)).toEqual(['/Users/me', '/Users/me/*', '/private/tmp/rt/home', '/private/tmp/rt/home/*', '/Users/me/repo/.git', '/Users/me/repo/.git/*']);
    expect(read['*']).toBe('ask'); // unknown places stay a human decision
    expect(read['/usr/*']).toBe('allow'); expect(read['/opt/*']).toBe('allow');
    expect(keys.indexOf('/Users/me')).toBeGreaterThan(keys.indexOf('/opt/*'));
    expect(read['/Users/me/*']).toBe('deny');
    expect(permission.external_directory_read['/Users/me/repo/.git/*']).toBe('allow');
    expect(permission.external_directory_write).toEqual({ '*': 'deny', '/private/tmp/rt/tmp': 'allow', '/private/tmp/rt/tmp/*': 'allow' });
    expect(Object.values(permission.external_directory_write)).not.toContain('ask');
  });
  it('drops roots that could be read as glob patterns instead of widening them', () => {
    const { permission } = communityPermissionConfig(tools, { home: '/Users/me', readRoots: ['/x/*'], writeRoots: ['/y/a?b', 'relative'] }) as any;
    expect(permission.external_directory_read).not.toHaveProperty('/x/*/*');
    expect(permission.external_directory_write).toEqual({ '*': 'deny' });
  });
  it('allows only read-only git branch spellings and keeps the rest asking', () => {
    const bash = communityPermissionConfig(tools, scope).permission.bash as Record<string, string>;
    const keys = Object.keys(bash);
    for (const form of ['git branch', 'git branch -a', 'git branch --show-current']) {
      expect(bash[form]).toBe('allow');
      expect(keys.indexOf(form)).toBeGreaterThan(keys.indexOf('git branch *'));
    }
    expect(bash['git branch *']).toBe('ask');
    expect(bash['git branch -D']).toBeUndefined();
    for (const rule of ['rm *', 'git push *', 'git reset *', 'sudo *']) expect(bash[rule]).toBe('ask');
  });
});

it("community permissions expose codemode but keep nested bash rules (dangerous commands still ask)", () => {
  const { permission } = communityPermissionConfig([]);
  expect(permission["*"]).toBe("deny");
  expect(permission.codemode).toBe("allow");
  expect((permission.bash as Record<string, string>)["rm *"]).toBe("ask");
});
