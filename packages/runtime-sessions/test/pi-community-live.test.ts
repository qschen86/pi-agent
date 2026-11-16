/** Real driver + community package + Seatbelt; a local scripted model, no production keys. */
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { PiDriver } from "../src/pi.js";
import type { DriverApproval, TurnSink } from "../src/driver.js";
import {loadPiCommunityProfile} from '../../pi-runtime/src/pi-community-profile.js';
import { acquireBrowserProfile, initializeBrowserProfile } from '../../pi-runtime/src/browser-profile.js';

const modules=process.env.PI_COMMUNITY_MODULES;
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanups.splice(0))await fn();});
async function setup(tool:string,input:Record<string,unknown>,approve=true,browser=false,persistent=false,resumeFallback=false,sessionGrant=false,catalog=false,testing=false){
  const root=mkdtempSync('/private/tmp/picl-'),workspace=join(root,'workspace'),source=join(root,'source');
  mkdirSync(workspace);mkdirSync(source);
  const requests:any[]=[],approvals:DriverApproval[]=[],events:any[]=[],cookieRestored:boolean[]=[];let issueTool=true,native='',revokeDuringTurn=false,repeated=false;const liveGrantCounts:number[]=[];
  const server=createServer(async(req,res)=>{
    if(req.url==='/page'){cookieRestored.push(req.headers.cookie?.includes('pi_fixture=persisted')===true);res.setHeader('Set-Cookie','pi_fixture=persisted; Max-Age=3600; Path=/; HttpOnly');res.end('<title>Managed browser verified</title><h1>Managed browser verified</h1>');return;}
    if(req.method!=='POST'){res.writeHead(204);res.end();return;}
    let text='';for await(const c of req)text+=c;const body=JSON.parse(text);requests.push(body);
    if(!issueTool&&revokeDuringTurn&&!repeated){repeated=true;liveGrantCounts.push((await driver.permissionGrants(native,{workspace})).grants.length);await driver.permissionGrants(native,{workspace,revoke:{}});issueTool=true;}
    const delta=issueTool?{role:'assistant',tool_calls:[{index:0,id:'managed_probe_'+requests.length,type:'function',function:{name:tool,arguments:JSON.stringify(input)}}]}:{role:'assistant',content:'managed fixture completed'};issueTool=false;
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [d,finish]of [[delta,null],[{},delta.tool_calls?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'probe',object:'chat.completion.chunk',created:1,model:'probe',choices:[{index:0,delta:d,finish_reason:finish}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}`;
  if(browser)input.url=url+'/page';
  writeFileSync(join(source,'settings.json'),'{}');
  writeFileSync(join(source,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:url+'/v1',api:'openai-completions',apiKey:'local-fixture-only',models:[{id:'probe',name:'probe',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}]}}}));
  const profile=join(root,'profile.json');
  const browserProfile=join(root,'browser-profile');if(persistent)initializeBrowserProfile(browserProfile);
  writeFileSync(profile,JSON.stringify({version:1,permissionPackage:join(modules!,'@gotgenes/pi-permission-system'),...(testing?{testing:{packageRoot:process.env.PI_PLAYWRIGHT_TEST_ROOT,browserRoot:process.env.PI_PLAYWRIGHT_TEST_BROWSERS}}:{}),...(browser?{browser:{packageRoot:join(modules!,'@playwright/mcp'),executable:process.env.PI_COMMUNITY_CHROMIUM,...(persistent?{profileRoot:browserProfile}:{})}}:{})}));
  if(persistent)catalog=true;
  if(catalog){
    const persistentProfile=join(root,'persistent.json');cpSync(profile,persistentProfile);
    const base=JSON.parse(readFileSync(profile,'utf8'));delete base.browser.profileRoot;writeFileSync(profile,JSON.stringify(base));
    writeFileSync(join(root,'browser-profiles.json'),JSON.stringify({version:1,profiles:[{id:'work',label:'Fixture browser',profile:persistentProfile}]}),{mode:0o600});
  }
  const historicalProfile=join(root,'historical-profile.json');if(resumeFallback)cpSync(profile,historicalProfile);
  const driver=new PiDriver({binaryPath:'/opt/homebrew/bin/pi',sourceAgentDir:source,sessionDir:join(root,'sessions'),runtimeArgs:['--profile',profile,'--state-dir',join(root,'runtime-state'),...(resumeFallback?['--resume-profile',historicalProfile]:[])],...(process.env.PI_RUNTIME_TEST_EXECUTABLE?{runtimeExecutable:process.env.PI_RUNTIME_TEST_EXECUTABLE}:{}),readyTimeoutMs:15000});
  cleanups.push(async()=>{driver.shutdown();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});});
  const sink={nativeSession:(id:string)=>{native=id;},nativeTurn:()=>{},usage:()=>{},rateLimit:()=>{},event:(e:any)=>events.push(e),status:()=>{},approval:async(r:DriverApproval)=>{
    approvals.push(r);
    if(r.kind==='question'){const q=r.questions![0];return {approve:true,reason:'fixture',answers:{[q.id]:[approve?'Yes':'No']}};}
    return {approve,reason:'fixture',...(sessionGrant?{scope:'session' as const}:{})};
  }} as TurnSink;
  const run=async(resume=false,mode: "pi-ask" | "pi-read-only" | "pi-native" = "pi-ask")=>{issueTool=true;const handle=await driver.startTurn({...(catalog&&!resume?{browserProfileId:'work'}:{}),workspace,model:'fixture/probe',permissionMode:mode,prompt:'execute fixture',clientMessageId:randomUUID(),...(resume?{nativeSessionId:native}:{})},sink);return handle.done;};
  return {root,workspace,profile,run,requests,approvals,events,cookieRestored,browserProfile,driver,native:()=>native,liveGrantCounts,enableLiveRevoke:()=>{revokeDuringTurn=true;}};
}
describe.skipIf(!modules||process.platform!=='darwin')('managed Pi community through platform driver',()=>{
  it.skipIf(!process.env.PI_PLAYWRIGHT_TEST_ROOT).each(['commonjs','module'])('runs runtime-owned Playwright Test in a dependency-free %s project without a per-call prompt',async(type)=>{
    const t=await setup('mcp__playwright_test__test_run',{locations:['example.spec.ts']},true,false,false,false,false,false,true);
    writeFileSync(join(t.workspace,'package.json'),JSON.stringify({type}));
    writeFileSync(join(t.workspace,'playwright.config.ts'),"import {defineConfig} from '@playwright/test'; export default defineConfig({testDir:'.',workers:1,use:{headless:true}});");
    writeFileSync(join(t.workspace,'example.spec.ts'),"import {test,expect} from '@playwright/test'; test('runtime browser works',async({page})=>{await page.setContent('<title>Runtime Test</title>');await expect(page).toHaveTitle('Runtime Test');});");
    expect((await t.run()).status).toBe('completed');expect(t.approvals).toHaveLength(0);
    expect(t.requests.flatMap(r=>r.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content)).join('\n')).toContain('1 passed');expect(existsSync(join(t.workspace,'node_modules'))).toBe(false);
  },60000);

  it.skipIf(!process.env.PI_PLAYWRIGHT_TEST_ROOT)('runtime test execution needs no prompt and the OS guard still blocks outside-workspace writes',async()=>{
    const t=await setup('mcp__playwright_test__test_run',{},true,false,false,false,false,false,true);
    writeFileSync(join(t.workspace,'playwright.config.cjs'),"require('node:fs').writeFileSync('config-loaded.txt','loaded'); module.exports={testDir:'.',workers:1};");
    writeFileSync(join(t.workspace,'outside.spec.ts'),"import {test} from '@playwright/test'; import {writeFileSync} from 'node:fs'; test('boundary',()=>writeFileSync('../outside-test-write.txt','forbidden'));");
    expect((await t.run()).status).toBe('completed');expect(t.approvals).toHaveLength(0);
    expect(existsSync(join(t.workspace,'config-loaded.txt'))).toBe(true);
    expect(existsSync(join(t.root,'outside-test-write.txt'))).toBe(false);
    const output=t.requests.flatMap(r=>r.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content)).join('\n');
    expect(output).toMatch(/EPERM|EACCES|not permitted/);
    expect(t.requests[0].tools.filter((t:any)=>t.function.name.startsWith('mcp__')).map((t:any)=>t.function.name).sort()).toEqual(['mcp__playwright_test__test_list','mcp__playwright_test__test_run']);
  },60000);

  it.skipIf(!process.env.PI_PLAYWRIGHT_TEST_ROOT)('retains native assembly across a runtime testing tool upgrade using the operator archive',async()=>{
    const t=await setup('write',{path:'managed.txt',content:'same assembly'});
    expect((await t.run()).status).toBe('completed');
    const fingerprint=loadPiCommunityProfile(t.profile,t.workspace).fingerprint,old=join(t.root,'old-profile.json');cpSync(t.profile,old);
    const profile=JSON.parse(readFileSync(t.profile,'utf8'));profile.testing={packageRoot:process.env.PI_PLAYWRIGHT_TEST_ROOT,browserRoot:process.env.PI_PLAYWRIGHT_TEST_BROWSERS};writeFileSync(t.profile,JSON.stringify(profile));
    writeFileSync(join(t.root,'resume-profiles.json'),JSON.stringify({version:1,profiles:[{fingerprint,profile:old}]}),{mode:0o600});
    expect((await t.run(true)).status).toBe('completed');
    expect(t.requests.every(r=>r.tools.every((t:any)=>!t.function.name.startsWith('mcp__playwright_test__')))).toBe(true);
  },60000);

  it('revokes exact grants in a running supervisor and across resume through runtime control',async()=>{
    const t=await setup('bash',{command:'rm -f managed.txt'},true,false,false,false,true);
    writeFileSync(join(t.workspace,'managed.txt'),'fixture');t.enableLiveRevoke();
    expect((await t.run()).status).toBe('completed');
    expect(t.liveGrantCounts).toEqual([1]);expect(t.approvals).toHaveLength(2);
    const grants=await t.driver.permissionGrants(t.native(),{workspace:t.workspace});
    expect(grants.grants).toHaveLength(1);expect(grants.grants[0].tool).toBe('bash');
    expect((await t.run(true)).status).toBe('completed');expect(t.approvals).toHaveLength(2);
    await t.driver.permissionGrants(t.native(),{workspace:t.workspace,revoke:{id:grants.grants[0].id}});
    expect((await t.run(true)).status).toBe('completed');expect(t.approvals).toHaveLength(3);
  },60000);

  it.each([
    ['write', {path:'managed.txt',content:'verified'}],
    ['bash', {command:'ls -la; grep -n verified managed.txt | head -5; sed -n 1,3p managed.txt; printf built > build.txt'}],
    ['bash', {command:'npm run build; npm test'}],
    ['edit', {path:'managed.txt',oldText:'verified',newText:'edited'}],
  ] as const)('ordinary workspace %s runs without approval',async(tool,input)=>{
    const t=await setup(tool,{...input});
    writeFileSync(join(t.workspace,'managed.txt'),'verified');
    writeFileSync(join(t.workspace,'package.json'),JSON.stringify({scripts:{build:'node build.cjs',test:'node build.cjs'}}));
    writeFileSync(join(t.workspace,'build.cjs'),"require('node:fs').writeFileSync('build.txt','built')");
    expect((await t.run()).status).toBe('completed');
    expect(t.approvals).toHaveLength(0);
    expect(t.events.filter(e=>e.tool?.status==='failed')).toEqual([]);
    expect(readFileSync(join(t.workspace,'managed.txt'),'utf8')).toBe(tool==='edit'?'edited':'verified');
    if(tool==='bash')expect(readFileSync(join(t.workspace,'build.txt'),'utf8')).toBe('built');
  },40000);
  it.each([true,false])('one Web-compatible approval decides destructive deletion (%s)',async approve=>{
    const t=await setup('bash',{command:'rm -f managed.txt'},approve);
    writeFileSync(join(t.workspace,'managed.txt'),'verified');
    expect((await t.run()).status).toBe('completed');
    expect(existsSync(join(t.workspace,'managed.txt'))).toBe(!approve);
    expect(t.approvals).toHaveLength(1);expect(t.approvals[0]).toMatchObject({kind:'permissions',runtimeSessionScope:expect.any(String)});
  },40000);
  it('session approval survives worker restart only for the same request, once does not persist',async()=>{
    for(const sessionGrant of [true,false]) {
      const input={command:'rm -f managed.txt'};
      const t=await setup('bash',input,true,false,false,false,sessionGrant);
      expect((await t.run()).status).toBe('completed');
      expect((await t.run(true)).status).toBe('completed');
      expect(t.approvals).toHaveLength(sessionGrant?1:2);
      input.command='rm -f another.txt';
      expect((await t.run(true)).status).toBe('completed');
      expect(t.approvals).toHaveLength(sessionGrant?2:3);
    }
  },60000);
  it.each([
    'printf started > started.txt; rm -rf managed.txt',
    'printf started > started.txt; /bin/rm -f managed.txt',
    'printf started > started.txt; find . -name managed.txt -delete',
    'printf started > started.txt; /usr/bin/find . -name managed.txt -delete',
    'printf started > started.txt; npm --registry=http://127.0.0.1:1 publish --dry-run',
    'printf started > started.txt; npm --workspace fixture publish --dry-run --registry=http://127.0.0.1:1',
    'printf started > started.txt; pnpm --filter fixture publish --dry-run --registry=http://127.0.0.1:1',
    'printf started > started.txt; yarn npm publish --dry-run --registry=http://127.0.0.1:1',
    'printf started > started.txt; git reset --hard',
    'printf started > started.txt; git -C . clean -fd',
    'printf started > started.txt; git push --force origin main',
    'printf started > started.txt; chmod -R 777 .',
    'printf started > started.txt; sudo true',
    'printf started > started.txt; bash -c "rm -f managed.txt"',
  ])('denying a dangerous compound command prevents every side effect: %s',async command=>{
    const t=await setup('bash',{command},false);
    writeFileSync(join(t.workspace,'managed.txt'),'verified');
    expect((await t.run()).status).toBe('completed');
    expect(t.approvals.length).toBeGreaterThan(0);
    expect(existsSync(join(t.workspace,'started.txt'))).toBe(false);
    expect(readFileSync(join(t.workspace,'managed.txt'),'utf8')).toBe('verified');
  },40000);
  it('an unknown location outside the workspace is still a human decision for reading, and denial prevents access',async()=>{
    const t=await setup('read',{path:'../external.txt'},false);
    writeFileSync(join(t.root,'external.txt'),'outside');
    expect((await t.run()).status).toBe('completed');
    expect(t.approvals).toHaveLength(1);
    expect(t.approvals[0].action).toContain('external');
    expect(t.requests.flatMap(r=>r.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content)).join('\n')).not.toMatch(/^outside$/m);
  },40000);
  it('writing outside the workspace is refused at once, not asked about, because the OS guard would refuse it anyway',async()=>{
    const t=await setup('write',{path:'../external.txt',content:'changed'},true);
    writeFileSync(join(t.root,'external.txt'),'outside');
    expect((await t.run()).status).toBe('completed');
    expect(t.approvals).toHaveLength(0);
    expect(readFileSync(join(t.root,'external.txt'),'utf8')).toBe('outside');
    expect(t.requests.flatMap(r=>r.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content)).join('\n')).toMatch(/denied|not permitted|external_directory/i);
  },40000);
  it('listing git branches needs no approval, while branch deletion still asks',async()=>{
    const t=await setup('bash',{command:'git branch -a | head -3 && git branch --show-current'});
    execFileSync('git',['init','-q'],{cwd:t.workspace});
    expect((await t.run()).status).toBe('completed');
    expect(t.approvals).toHaveLength(0);
    expect(t.events.filter(e=>e.tool?.status==='failed').map(e=>e.tool?.output)).toEqual([]);
    const d=await setup('bash',{command:'git branch -D nothing-here'},false);
    execFileSync('git',['init','-q'],{cwd:d.workspace});
    expect((await d.run()).status).toBe('completed');
    expect(d.approvals).toHaveLength(1);
  },40000);
  it('reading the real home directory is refused without a prompt (the OS guard hides it anyway)',async()=>{
    const t=await setup('bash',{command:`ls ${JSON.stringify(homedir())}/Documents`});
    expect((await t.run()).status).toBe('completed');
    expect(t.approvals).toHaveLength(0);
    expect(t.requests.flatMap(r=>r.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content)).join('\n')).toMatch(/denied|not permitted|external_directory/i);
  },40000);
  it('Bash cannot modify its own permission configuration or workspace-external files',async()=>{
    const t=await setup('bash',{command:'printf changed > "$PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json"; printf outside > ../escape.txt'});
    expect((await t.run()).status).toBe('completed');
    expect(existsSync(join(t.root,'escape.txt'))).toBe(false);
    expect(t.approvals).toHaveLength(0);
    expect(t.events.some(e=>/denied|Operation not permitted/i.test(e.tool?.output??''))).toBe(true);
    expect(JSON.parse(readFileSync(t.profile,'utf8')).permissionPackage).toBe(join(modules!,'@gotgenes/pi-permission-system'));
  },40000);
  it('does not expose an unmanaged MCP tool',async()=>{
    const t=await setup('mcp__other__execute',{});
    expect((await t.run()).status).toBe('completed');expect(t.approvals).toHaveLength(0);
    expect(t.requests[0].tools.some((x:any)=>x.function.name==='mcp__other__execute')).toBe(false);
  },40000);
  it('changes permission modes on the same native history without changing its pinned assembly',async()=>{
    const t=await setup('read',{path:'managed.txt'});
    writeFileSync(join(t.workspace,'managed.txt'),'verified');
    expect((await t.run()).status).toBe('completed');
    const native=t.native();
    let before=t.requests.length;
    expect((await t.run(true,'pi-read-only')).status).toBe('completed');
    expect(t.native()).toBe(native);
    expect(t.requests[before].tools.some((x:any)=>x.function.name==='write')).toBe(false);
    before=t.requests.length;
    expect((await t.run(true,'pi-native')).status).toBe('completed');
    expect(t.native()).toBe(native);
    expect(t.requests[before].tools.some((x:any)=>x.function.name==='write')).toBe(true);
    expect((await t.run(true,'pi-ask')).status).toBe('completed');
    expect(t.native()).toBe(native);
  },60000);

  it('resumes the same assembly and refuses a changed operator profile before dispatch',async()=>{
    const t=await setup('write',{path:'managed.txt',content:'verified'});
    expect((await t.run()).status).toBe('completed');
    expect((await t.run(true)).status).toBe('completed');
    const before=t.requests.length;
    const profile=JSON.parse(readFileSync(t.profile,'utf8'));
    const copy=join(t.root,'copy/node_modules/@gotgenes/pi-permission-system');
    mkdirSync(join(copy,'..'),{recursive:true});cpSync(profile.permissionPackage,copy,{recursive:true});profile.permissionPackage=copy;
    writeFileSync(t.profile,JSON.stringify(profile));
    await expect(t.run(true)).rejects.toMatchObject({stage:'create',notExecuted:true,message:expect.stringMatching(/assembly changed/)});
    expect(t.requests.length).toBe(before);
  },40000);
  it.skipIf(!process.env.PI_COMMUNITY_CHROMIUM)('native MCP browser runs inside the runtime filesystem boundary with no prompt for the isolated profile',async()=>{
    const t=await setup('mcp__playwright__browser_navigate',{},true,true);
    expect((await t.run()).status).toBe('completed');
    expect(t.approvals).toHaveLength(0);
    expect(t.events.some(e=>e.tool?.output?.includes('Managed browser verified')),JSON.stringify(t.events.filter(e=>e.tool))).toBe(true);
    expect(t.requests[0].tools.some((x:any)=>x.function.name==='mcp__playwright__browser_run_code_unsafe')).toBe(false);
  },45000);
  it('an operator-pinned historical profile preserves existing sessions after the default assembly changes',async()=>{
    const t=await setup('write',{path:'managed.txt',content:'verified'},true,false,false,true);
    expect((await t.run()).status).toBe('completed');
    const value=JSON.parse(readFileSync(t.profile,'utf8')),copy=join(t.root,'new/node_modules/@gotgenes/pi-permission-system');
    mkdirSync(join(copy,'..'),{recursive:true});cpSync(value.permissionPackage,copy,{recursive:true});
    value.permissionPackage=copy;writeFileSync(t.profile,JSON.stringify(value));
    expect((await t.run(true)).status).toBe('completed');expect(t.approvals).toHaveLength(0);
  },45000);
  it.skipIf(!process.env.PI_COMMUNITY_CHROMIUM)('persistent browser cookie survives a new runtime process while isolated contexts do not; only the persistent profile asks before navigating',async()=>{
    for(const persistent of [true,false]){
      const t=await setup('mcp__playwright__browser_navigate',{},true,true,persistent);
      expect((await t.run()).status).toBe('completed');
      expect((await t.run()).status).toBe('completed');
      expect(t.events.filter(e=>e.tool?.status==='failed')).toEqual([]);
      expect(t.cookieRestored).toEqual([false,persistent]);
      expect(t.approvals).toHaveLength(persistent?2:0);
      if(persistent)expect(existsSync(join(t.browserProfile,'runtime.lock'))).toBe(false);
    }
  },90000);
  it.skipIf(!process.env.PI_COMMUNITY_CHROMIUM)('selects a persistent browser by ID and restores the pinned ID on native resume',async()=>{
    const t=await setup('mcp__playwright__browser_navigate',{},true,true,true,false,false,true);
    expect((await t.run()).status).toBe('completed');
    expect((await t.run(true)).status).toBe('completed');
    expect(t.cookieRestored).toEqual([false,true]);
    expect(t.events.filter(e=>e.tool?.status==='failed')).toEqual([]);
    expect(existsSync(join(t.browserProfile,'runtime.lock'))).toBe(false);
  },90000);

  it.skipIf(!process.env.PI_COMMUNITY_CHROMIUM)('rejects an occupied selected browser before model dispatch without stealing its lease',async()=>{
    const t=await setup('mcp__playwright__browser_navigate',{},true,true,true,false,false,true);
    const release=acquireBrowserProfile(t.browserProfile);
    try {await expect(t.run()).rejects.toMatchObject({notExecuted:true,message:expect.stringMatching(/busy|runtime.lock/)});expect(t.requests).toHaveLength(0);expect(existsSync(join(t.browserProfile,'runtime.lock'))).toBe(true);}
    finally {release();}
  },30000);

});
