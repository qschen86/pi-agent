/** Only invokes the operator-registered runtime. Never reads its profile or opens its database. */
import {validateFactAuditPage} from '../../../../packages/runtime-memory/src/facts-reader.js';
import type {FactAuditQuery,FactAuditPage} from '../../../../packages/runtime-memory/src/facts-contract.js';
import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { canonicalPath, isWithin } from '../../../../packages/adapter-pi/src/runtime-guard-policy.js';
import { registeredRuntimeExecutable } from '../../../../packages/pi-runtime/src/registration.js';
import { validateMemorySnapshot, type MemorySnapshot } from '../../../../packages/runtime-memory/src/index.js';
import { MemoryError } from './types.js';
export interface MemoryRead { global:MemorySnapshot; project:MemorySnapshot|null; projectError?:MemoryError }
export interface MemoryPort { read(workspace:string,repositoryRoot?:string,signal?:AbortSignal):Promise<MemoryRead> }
export class RuntimeMemoryPort implements MemoryPort {
 constructor(private readonly executable=()=>process.env['PI_AGENT_PI_RUNTIME']??registeredRuntimeExecutable()){}
 private async ready(workspace:string,repositoryRoot?:string,signal?:AbortSignal) {
  let executable:string|undefined;
  try{executable=this.executable();}catch{throw new MemoryError('not-configured');}
  if(!executable)throw new MemoryError('not-configured');
  if(!isAbsolute(executable) || !isAbsolute(workspace) || isWithin(canonicalPath(executable),canonicalPath(repositoryRoot??workspace)))throw new MemoryError('not-configured');
  const env:NodeJS.ProcessEnv={};
  for(const name of ['PATH','HOME','TMPDIR','LANG','LC_ALL'])if(process.env[name])env[name]=process.env[name];
  const invoke=(args:string[]):Promise<unknown>=>new Promise((resolveResult,reject)=>{
   execFile(executable!,[...args,'--cwd',resolve(workspace)],{env,shell:false,timeout:30000,maxBuffer:16*1024*1024,killSignal:'SIGKILL',signal,encoding:'utf8'},(error,stdout,stderr)=>{
    if(error){
     const code=error.killed?'timeout':/not configured/i.test(stderr)?'not-configured':/not initialized/i.test(stderr)?'not-initialized':'unavailable';
     reject(new MemoryError(code));return;
    }
    try{resolveResult(JSON.parse(stdout));}catch{reject(new MemoryError('invalid-output'));}
   });
  });
  const description=await invoke(['--describe']) as {runtime?:string;memory?:{readPort?:number;writeProvenance?:number}|null};
  if(!description || description.runtime!=='pi-runtime')throw new MemoryError('invalid-output');
  if(!description.memory)throw new MemoryError('not-configured');
  if(description.memory.readPort!==2)throw new MemoryError('invalid-output');
  return {invoke,description};
 }
 async factAudit(workspace:string,sessionId:string,query:Omit<FactAuditQuery,'project'|'includeGlobal'|'sessionId'>={},signal?:AbortSignal):Promise<FactAuditPage>{
  const {invoke,description}=await this.ready(workspace,undefined,signal);
  if((description.memory as {facts?:{auditPort?:number}}).facts?.auditPort!==1)return {version:1,sourceId:'',ledgerIdentity:'',items:[],nextCursor:null,hasMore:false,supported:false,health:'unsupported'};
  const scope=await invoke(['--memory-scope']) as {version:number;project:string|null};if(scope?.version!==1||!(scope.project===null||typeof scope.project==='string'))throw new MemoryError('invalid-output');
  const args=['--memory-facts-audit','--memory-session-id',sessionId,...(query.before?['--memory-facts-before',query.before]:[]),...(query.decision?['--memory-facts-result',query.decision]:[]),...(query.from?['--memory-facts-from',query.from]:[]),...(query.to?['--memory-facts-to',query.to]:[]),...(query.limit?['--memory-facts-limit',String(query.limit)]:[])];
  const page=await invoke(args);try{validateFactAuditPage(page,{...query,project:scope.project,includeGlobal:true,sessionId});}catch{throw new MemoryError('invalid-output');}return page;
 }
 async browse(workspace:string,project:string|null=null):Promise<{projects:string[];snapshots:MemorySnapshot[]}> {
  const {invoke,description}=await this.ready(workspace);
  if((description.memory as {browsePort?:number}).browsePort!==1)throw new MemoryError('invalid-output');
  const catalog=await invoke(['--memory-projects']) as {version:number;projects:string[]};
  if(catalog?.version!==1 || !Array.isArray(catalog.projects) || catalog.projects.length>500 || catalog.projects.some(p=>typeof p!=='string'||!p||/[\\/\0]/.test(p)||['.','..'].includes(p)))throw new MemoryError('invalid-output');
  const scope=project===null?'global':'project';
  const snapshot=await invoke(['--memory-snapshot',...(description.memory?.writeProvenance===1?['--memory-provenance']:[]),'--memory-snapshot-scope',scope,...(project===null?[]:['--memory-project',project])]) as MemorySnapshot;
  try{validateMemorySnapshot(snapshot);if(snapshot.scope!==scope || snapshot.project!==project)throw new Error();}catch{throw new MemoryError('invalid-output');}
  return {projects:catalog.projects,snapshots:[snapshot]};
 }
 async read(workspace:string,repositoryRoot?:string,signal?:AbortSignal):Promise<MemoryRead> {
  const {invoke,description}=await this.ready(workspace,repositoryRoot,signal);
  const provenance=description.memory?.writeProvenance===1?['--memory-provenance']:[];
  for(let attempt=0;attempt<2;attempt++){
   const scope=await invoke(['--memory-scope',...(repositoryRoot?['--memory-repository-root',repositoryRoot]:[])]) as {version:number;sourceId:string;project:string|null};
   if(!scope || scope.version!==1 || typeof scope.sourceId!=='string' || !scope.sourceId || !(scope.project===null || typeof scope.project==='string' && !!scope.project && !/[\\/\0]/.test(scope.project) && !['.','..'].includes(scope.project)))throw new MemoryError('invalid-output');
   const global=await invoke(['--memory-snapshot',...provenance,'--memory-snapshot-scope','global']) as MemorySnapshot;
   try{
    validateMemorySnapshot(global);
    if(global.scope!=='global' || global.project!==null || global.sourceId!==scope.sourceId)throw new Error();
   }catch{throw new MemoryError('invalid-output');}
   let project:MemorySnapshot|null=null,projectError:MemoryError|undefined;
   if(scope.project!==null){
    try{
     project=await invoke(['--memory-snapshot',...provenance,'--memory-project',scope.project,'--memory-snapshot-scope','project']) as MemorySnapshot;
     validateMemorySnapshot(project);
     if(project.scope!=='project' || project.project!==scope.project || project.sourceId!==scope.sourceId)throw new Error();
    }catch(e){project=null;projectError=e instanceof MemoryError?e:new MemoryError('invalid-output');}
   }
   if(project && global.databaseIdentity!==project.databaseIdentity){if(attempt===0)continue;throw new MemoryError('unavailable');}
   return {global,project,...(projectError?{projectError}:{})};
  }
  throw new MemoryError('unavailable');
 }
}
