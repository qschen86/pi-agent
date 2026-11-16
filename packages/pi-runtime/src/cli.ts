/** Terminal and JSONL frontends for the same runtime supervisor. No platform server is required. */
import {withMemoryLock} from './hermes-extension.js';
import {readFactAudit,readLegacyFactRows} from '../../runtime-memory/src/facts-reader.js';
import type {DecisionKind} from '../../runtime-memory/src/facts-contract.js';
import {scanLegacyFacts} from './facts/commands.js';
import {collectEvidence} from './facts/collectors.js';
import {loadEvidencePolicy} from './facts/evidence-policy.js';
import {openFactLedger} from './facts/ledger.js';
import { factPolicyState } from './facts/runtime.js';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PiRuntimeSupervisor } from './supervisor.js';
import { loadPiCommunityProfile } from './pi-community-profile.js';
import { selectHistoricalProfile } from './assembly-history.js';
import { listBrowserProfiles, selectBrowserProfile, assertBrowserProfileMode } from './browser-catalog.js';
import { CommunitySessionGrants } from './community-approval.js';
import { canonicalPath, isWithin } from '../../adapter-pi/src/runtime-guard-policy.js';
import { initializeBrowserProfile } from './browser-profile.js';
import { initializeHermesProfile, validateHermesProfile, detectHermesProject } from './hermes-profile.js';
import { HermesMemoryAdapter, type MemorySnapshotScope } from '../../runtime-memory/src/index.js';
import { defaultPiConfigDir } from '../../adapter-pi/src/pi-runtime-env.js';
import type { PiRpcEvent } from './pi-client.js';
import type { PiRuntimeSpec } from './types.js';

const args=process.argv.slice(2),option=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const profilePath=option('--profile')??process.env.PI_RUNTIME_PROFILE??join(dirname(fileURLToPath(import.meta.url)),'profile.json');
const profile=existsSync(profilePath)?resolve(profilePath):undefined;
const browserCatalog=option('--browser-catalog')??process.env.PI_RUNTIME_BROWSER_CATALOG??join(dirname(resolve(profilePath)),'browser-profiles.json');
if((option('--profile')||process.env.PI_RUNTIME_PROFILE)&&!profile)throw new Error('Requested runtime profile does not exist');
const binary=option('--pi-binary')??process.env.PI_RUNTIME_PI_BINARY??String(process.env.PATH??'').split(delimiter).map(p=>join(p,'pi')).find(existsSync);
if(args.includes('--help')){
  console.log('pi-runtime [--profile /path/profile.json] [--cwd /workspace] [--provider deepseek --model deepseek-flash] [--prompt text]\npi-runtime --mode rpc --launch-spec /path/launch.json\npi-runtime --describe\npi-runtime --browser-profiles [--browser-catalog /path/catalog.json]\npi-runtime --browser-profile <id>\npi-runtime --permission-grants --session /path/session.jsonl --cwd /workspace [--revoke-grant <id> | --revoke-all-grants]\npi-runtime --init-browser-profile /absolute/new-directory\nDefault: guarded pi-ask; terminal and RPC use the same runtime policy.');
 }else if(args.includes('--permission-grants')){
  const session=option('--session'),cwd=option('--cwd');
  if(!session||!cwd)throw new Error('Native session and workspace required for permission control');
  const rows=readFileSync(session,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
  const header=rows[0];
  if(header?.type!=='session'||typeof header.id!=='string'||!/^[a-f0-9-]{36}$/i.test(header.id)||typeof header.cwd!=='string'||canonicalPath(header.cwd)!==canonicalPath(cwd))throw new Error('Runtime permission history does not match session/workspace');
  const fingerprint=rows.reverse().find(r=>r.type==='custom'&&r.customType==='pi-runtime-assembly')?.data?.fingerprint??'legacy';
  if(fingerprint!=='legacy'&&(typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint)))throw new Error('Invalid runtime permission assembly');
  const stateFile=join(resolve(option('--state-dir')??process.env.PI_RUNTIME_STATE_DIR??join(homedir(),'.local/share/pi-runtime')),'permissions',header.id+'.json');
  if(isWithin(canonicalPath(stateFile),canonicalPath(cwd)))throw new Error('Runtime permission state must be outside workspace');
  const grants=new CommunitySessionGrants(stateFile,JSON.stringify([header.id,canonicalPath(cwd),fingerprint]));
  if(args.includes('--revoke-grant')&&args.includes('--revoke-all-grants'))throw new Error('Choose single or all grant revocation');
  if(args.includes('--revoke-grant')&&!option('--revoke-grant'))throw new Error('Runtime grant ID required');
  console.log(JSON.stringify(args.includes('--revoke-all-grants')?grants.revoke():args.includes('--revoke-grant')?grants.revoke(option('--revoke-grant')):grants.list()));
}else if(args.includes('--browser-profiles')){
  console.log(JSON.stringify({version:1,profiles:listBrowserProfiles(browserCatalog)}));
}else if(args.includes('--init-browser-profile')){
  const path=option('--init-browser-profile');if(!path)throw new Error('Browser profile path required');
  initializeBrowserProfile(path);console.log('Initialized dedicated Pi runtime browser profile');
}else if(args.includes('--init-memory-store')){
  const path=option('--init-memory-store');if(!path)throw new Error('Memory store path required');
  initializeHermesProfile(path);console.log('Initialized private Pi Hermes memory store');
}else if(args.includes('--memory-facts-audit')){
 const cwd=resolve(option('--cwd')??process.cwd()),assembled=profile?loadPiCommunityProfile(profile,cwd):undefined;if(!assembled?.profile.memory)throw new Error('Hermes memory is not configured');const root=validateHermesProfile(assembled.profile.memory.storeRoot,cwd).root;
 console.log(JSON.stringify(readFactAudit(join(root,'data/runtime-facts.sqlite'),{project:detectHermesProject(cwd,root),includeGlobal:!!option('--memory-session-id'),sessionId:option('--memory-session-id'),before:option('--memory-facts-before'),decision:option('--memory-facts-result') as DecisionKind|undefined,from:option('--memory-facts-from'),to:option('--memory-facts-to'),...(option('--memory-facts-limit')?{limit:Number(option('--memory-facts-limit'))}:{})})));
}else if(args.includes('--memory-facts-scan')||args.includes('--memory-facts-collect')){
 const cwd=resolve(option('--cwd')??process.cwd()),assembled=profile?loadPiCommunityProfile(profile,cwd):undefined;
 if(!assembled?.profile.memory)throw new Error('Hermes memory is not configured');const root=validateHermesProfile(assembled.profile.memory.storeRoot,cwd).root;
 if(args.includes('--memory-facts-scan')){console.log(JSON.stringify(scanLegacyFacts(readLegacyFactRows(join(root,'data/global/sessions.db'),detectHermesProject(cwd,root)))));}
 else {await withMemoryLock(join(root,'data/.runtime-memory.lock'),async()=>{const policy=loadEvidencePolicy(join(root,'facts-policy.json'));const ledger=openFactLedger(join(root,'data/runtime-facts.sqlite'),'readwrite');try{const draft=await collectEvidence({collectorId:option('--memory-facts-collect')??'',subjectId:option('--subject')??''},policy);console.log(JSON.stringify(ledger.recordEvidence(draft)));}finally{ledger.close();}});}
}else if(args.includes('--memory-snapshot')||args.includes('--memory-health')||args.includes('--memory-scope')||args.includes('--memory-projects')||args.includes('--memory-session-events')){
  const cwd=resolve(option('--cwd')??process.cwd());
  const assembled=profile?loadPiCommunityProfile(profile,cwd):undefined;
  if(!assembled?.profile.memory)throw new Error('Hermes memory is not configured');
  const memory=validateHermesProfile(assembled.profile.memory.storeRoot,cwd);
  if(args.includes('--memory-scope')) {
    console.log(JSON.stringify({version:1,sourceId:memory.sourceId,project:detectHermesProject(cwd,memory.root,option('--memory-repository-root'))}));
  } else {
  const scope=option('--memory-snapshot-scope')??'all';
  if(!['all','global','project'].includes(scope))throw new Error('Invalid memory snapshot scope');
  const adapter=new HermesMemoryAdapter({databasePath:join(memory.root,'data/global/sessions.db'),sourceId:memory.sourceId,project:option('--memory-project')??null,includeProvenance:args.includes('--memory-provenance')});
  if(args.includes('--memory-session-events'))console.log(JSON.stringify(adapter.readSessionEvents(option('--memory-session-id')??'',option('--memory-events-before'))));
  else if(args.includes('--memory-projects'))console.log(JSON.stringify({version:1,projects:adapter.listProjects()}));
  else console.log(JSON.stringify(args.includes('--memory-health')?await adapter.getHealth():await adapter.readSnapshot(scope as MemorySnapshotScope)));
  }
}else if(args.includes('--describe')){
  const cwd=resolve(option('--cwd')??process.cwd());
  const assembled=profile?loadPiCommunityProfile(profile,cwd):undefined;
  const version=binary?spawnSync(binary,['--version'],{encoding:'utf8',timeout:10000}).stdout.trim():undefined;
  console.log(JSON.stringify({runtime:'pi-runtime',platformBrowser:1,browserProfileSelection:1,permissionGrantControl:1,playwrightTest:assembled?.profile.testing?{version:'1.63.0',tools:['test_list','test_run']}:null,version:'0.1.0',piBinary:binary,piVersion:version,modes:['pi-read-only','pi-ask','pi-native'],assemblyFingerprint:assembled?.fingerprint??'legacy',community:!!assembled,browserConfigured:!!assembled?.profile.browser,browserState:assembled?.profile.browser?.profileRoot?'persistent':'isolated',memory:assembled?.profile.memory?{engine:'pi-hermes-memory',version:'0.9.10',adapter:'readonly-snapshot-v1',readPort:2,browsePort:1,writeProvenance:1,sessionEvents:1,...(factPolicyState(assembled.profile.memory.storeRoot)?.enabled?{facts:{version:1,enabled:true,writeGuard:1,auditPort:1}}:{}),startupPolicy:1,searchRetry:1,modes:['pi-ask','pi-native']}:null}));
}else{
  const rpc=option('--mode')==='rpc',specFile=option('--launch-spec');
  const source=defaultPiConfigDir();
  let defaults:Record<string,unknown>={};try{defaults=JSON.parse(readFileSync(join(source,'settings.json'),'utf8'));}catch{}
  const spec:PiRuntimeSpec=specFile?JSON.parse(readFileSync(specFile,'utf8')):{version:1,binary:binary??'',workspace:resolve(option('--cwd')??process.cwd()),provider:option('--provider')??String(defaults.defaultProvider??'deepseek'),model:option('--model')??String(defaults.defaultModel??'deepseek-flash'),mode:option('--permissions')??'pi-ask',sessionId:option('--session-id')??randomUUID(),sessionFile:option('--session'),sourceAgentDir:source};
  if(!rpc){
    const state=resolve(option('--state-dir')??join(homedir(),'.local/share/pi-runtime'));
    const resume=option('--session')??(option('--session-id')?join(state,'sessions',`${spec.sessionId}.jsonl`):undefined);
    if(resume){
      if(!existsSync(resume))throw new Error('Requested runtime session does not exist');
      const header=JSON.parse(readFileSync(resume,'utf8').split('\n')[0]!);
      spec.sessionId=header.id;spec.sessionFile=resolve(resume);
      if(!option('--cwd'))spec.workspace=header.cwd;
    }
    spec.historyDestination=join(state,'sessions',`${spec.sessionId}.jsonl`);
  }
  const selectedBrowser=selectBrowserProfile({catalogFile:browserCatalog,baseProfile:profile,requestedId:option('--browser-profile')??spec.browserProfileId,sessionFile:spec.sessionFile});
  assertBrowserProfileMode(selectedBrowser.id,spec);
  // Native memory is an explicit operator capability; keep old assembly fingerprints resumable.
  spec.nativeMemoryProfilePath=selectedBrowser.profile;
  spec.communityProfilePath=selectHistoricalProfile({profile:selectedBrowser.profile,sessionFile:spec.sessionFile,catalogFile:join(dirname(resolve(profilePath)),'resume-profiles.json'),workspace:spec.workspace});
  spec.browserProfileId=selectedBrowser.id;
  spec.permissionStatePath=join(resolve(option("--state-dir")??process.env.PI_RUNTIME_STATE_DIR??join(homedir(),".local/share/pi-runtime")),"permissions",`${spec.sessionId}.json`);
  // Only the operator's launcher/config may supply the historical assembly.
  spec.resumeCommunityProfilePath=option('--resume-profile')??process.env.PI_RUNTIME_RESUME_PROFILE;
  if(!spec.binary)throw new Error('Pi binary not found; configure PI_RUNTIME_PI_BINARY');
  const supervisor=new PiRuntimeSupervisor();
  let closing=false;
  const close=async(code=0)=>{if(closing)return;closing=true;await supervisor.stop();process.exitCode=code;if(rpc)process.stdin.destroy();};
  process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close(130);});
  if(rpc){
    supervisor.on('event',(event:PiRpcEvent)=>process.stdout.write(JSON.stringify(event)+'\n'));
    supervisor.once('exit',()=>{void close(1);});
    // Buffer commands until startup has checked the execution boundary.
    let ready=false;const queued:PiRpcEvent[]=[];let buffer='';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',(chunk:string)=>{buffer+=chunk;if(buffer.length>2*1024*1024){void close(1);return;}let i:number;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;try{const command=JSON.parse(line);if(!command||typeof command.type!=='string')throw new Error('Invalid RPC command');if(ready)supervisor.send(command);else{if(queued.length>=32)throw new Error('Startup queue exceeded');queued.push(command);}}catch{void close(1);}}});
    process.stdin.once('end',()=>{void close();});
    try{await supervisor.start(spec);ready=true;for(const command of queued)supervisor.send(command);}catch(error){process.stdout.write(JSON.stringify({type:'runtime_error',error:error instanceof Error?error.message:'Runtime startup failed',notExecuted:true})+'\n');await close(1);}
  }else{
    const terminal=createInterface({input:process.stdin,output:process.stderr});
    let settled: (()=>void)|undefined;
    supervisor.on('event',(event:PiRpcEvent)=>{
      if(event.type==='runtime_error'){console.error(String(event.error));settled?.();void close(1);}
      if(event.type==='message_end'){
        const message=event.message as {role?:string;content?:Array<{type:string;text?:string}>};
        if(message?.role==='assistant')console.log(message.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')??'');
      }
      if(event.type==='agent_settled')settled?.();
      if(event.type==='response'&&event.command==='prompt'&&event.success===false){console.error(String(event.error));settled?.();}
      if(event.type==='runtime_approval'||event.type==='extension_ui_request'&&['select','confirm','input','editor'].includes(String(event.method))){
        void(async()=>{
          try{
            if(event.type==='runtime_approval'){const request=event.request as {title:string;action:string;scope:string;runtimeSessionScope?:string};const answer=(await terminal.question(`${request.title}\n${request.action}\n${request.scope}\n${request.runtimeSessionScope ? "Deny / once / session? [N/y/s] " : "Allow once? [y/N] "}`)).trim().toLowerCase();supervisor.send({type:'extension_ui_response',id:event.id,confirmed:answer==='y'||!!request.runtimeSessionScope&&answer==='s',...(request.runtimeSessionScope&&answer==='s'?{scope:'session'}:{})});}
            else if(event.method==='select'){const choices=event.options as string[];console.error(String(event.title));choices.forEach((label,i)=>console.error(`${i+1}. ${label}`));const answer=Number(await terminal.question('Choose (empty cancels): '));supervisor.send({type:'extension_ui_response',id:event.id,...(choices[answer-1]?{value:choices[answer-1]}:{cancelled:true})});}
            else if(event.method==='confirm'){const answer=await terminal.question(`${event.title}\n${event.message??''}\n[y/N] `);supervisor.send({type:'extension_ui_response',id:event.id,confirmed:answer.trim().toLowerCase()==='y'});}
            else{const value=await terminal.question(`${event.title}: `);supervisor.send({type:'extension_ui_response',id:event.id,value});}
          }catch{supervisor.send({type:'extension_ui_response',id:event.id,cancelled:true});}
        })();
      }
    });
    try{
      await supervisor.start(spec);console.error(`Pi runtime session: ${spec.sessionId}\nHistory: ${spec.historyDestination}`);
      let prompt=option('--prompt');
      while(!closing){
        prompt??=await terminal.question('You> ');if(!prompt.trim()||prompt==='/exit')break;
        await new Promise<void>(resolveDone=>{settled=resolveDone;supervisor.send({id:randomUUID(),type:'prompt',message:prompt});});
        if(option('--prompt'))break;prompt=undefined;
      }
    }finally{terminal.close();await close();}
  }
}
