/** Frontend connection SDK. Production connects to a runtime process, not its tool implementations. */
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeGuardProvider } from "@pi-agent/runtime-contracts";
import { registeredRuntimeExecutable } from "./registration.js";
import { canonicalPath, isWithin } from "../../adapter-pi/src/runtime-guard-policy.js";
import { preparePiChatBoundary } from "./pi-boundary.js";
import { PiCommandExecutor } from "./pi-command-executor.js";
import { PI_ESCALATION_TITLE } from "./pi-approval-extension.js";
import type { PiClientOptions, PiRpcEvent } from "./pi-client.js";
import type { PiRuntimeSpec, RuntimeControlSink } from "./types.js";

export function resolveRuntimeInvocation(options?:{binaryPath?:string;args?:string[]}):{binaryPath:string;args?:string[]}{
  if(options?.binaryPath)return {binaryPath:options.binaryPath,args:options.args};
  const builtin=[fileURLToPath(new URL('../bin/pi-runtime.mjs',import.meta.url))];
  if(options?.args)return {binaryPath:process.execPath,args:[...builtin,...options.args]};
  const registered=registeredRuntimeExecutable();
  return registered?{binaryPath:registered}:{binaryPath:process.execPath,args:builtin};
}

export interface RuntimeConnection {
  endpoint: PiClientOptions;
  supervised: boolean;
  sessionDirectory?: string;
  fingerprint?: string;
  control(event: PiRpcEvent, respond: (id:string,response:{cancelled?:boolean;value?:string})=>void): boolean;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
export async function prepareRuntimeConnection(options:{spec:PiRuntimeSpec;controlRoot:string;invocation?:{binaryPath:string;args?:string[]};embedded?:{guard?:RuntimeGuardProvider;sink:RuntimeControlSink;token:string}}):Promise<RuntimeConnection>{
  const {spec,controlRoot}=options;
  if(!options.embedded){
    const file=join(controlRoot,'launch.json');writeFileSync(file,JSON.stringify(spec),{mode:0o600});
    const registered=options.invocation?undefined:registeredRuntimeExecutable();
    if(registered&&isWithin(canonicalPath(registered),canonicalPath(spec.workspace)))throw new Error('Registered runtime executable must be outside the workspace');
    const invocation=options.invocation??resolveRuntimeInvocation();
    return {endpoint:{binaryPath:invocation.binaryPath,args:[...(invocation.args??[]),'--mode','rpc','--launch-spec',file],cwd:spec.workspace,env:Object.fromEntries(Object.entries(process.env).filter((pair):pair is [string,string]=>typeof pair[1]==='string')),exitGraceMs:25000,gracefulShutdown:true},supervised:true,control:()=>false,cancel:async()=>{},dispose:async()=>{}};
  }
  // Embedded transport exists for deterministic adapter tests / injected guard conformance tests.
  const boundary=await preparePiChatBoundary({workspace:spec.workspace,mode:spec.mode,provider:spec.provider,model:spec.model,memorySource:spec.memorySource,sourceAgentDir:spec.sourceAgentDir,runtimeRoot:join(controlRoot,'runtime'),guardDir:join(controlRoot,'guard'),guard:options.embedded.guard,evaluation:spec.evaluation,roleInstructions:spec.roleInstructions,recordReadRoots:spec.recordReadRoots,capabilityGateway:spec.capabilityGateway,platformBrowser:spec.platformBrowser,worktree:spec.worktree,...(spec.webResearch?{webResearch:{sourceDomains:spec.webResearch.sourceDomains,...(spec.webResearch.budget?{budget:spec.webResearch.budget}:{})}}:{})});
  boundary.env.PI_CHAT_GATE_TOKEN=options.embedded.token;
  const args:string[]=[];
  if(spec.sessionFile){const file=join(boundary.env.TMPDIR,'session.jsonl');copyFileSync(spec.sessionFile,file);args.push('--session',file);}
  else args.push('--session-id',spec.sessionId,'--session-dir',join(boundary.env.TMPDIR,'sessions'));
  const wrapped=await boundary.wrap(spec.binary,['--mode','rpc',...boundary.argsPrefix,'--provider',spec.provider,'--model',spec.model,...args]);
  const executor=spec.mode==='pi-ask'&&!spec.evaluation?new PiCommandExecutor({workspace:spec.workspace,worktree:spec.worktree,env:boundary.env,runtimeRoot:join(controlRoot,'runtime'),guardDir:join(controlRoot,'guard'),guard:options.embedded.guard,readable:boundary.commandReadRoots,writable:boundary.commandWriteRoots,sink:options.embedded.sink}):undefined;
  return {endpoint:{binaryPath:wrapped.command,args:wrapped.args,cwd:spec.workspace,env:{...boundary.env,...wrapped.env}},supervised:false,sessionDirectory:boundary.env.TMPDIR,control:(event,respond)=>{
    if(event.type!=='extension_ui_request'||event.method!=='input'||event.title!==PI_ESCALATION_TITLE)return false;
    const id=String(event.id??'');if(!executor){respond(id,{cancelled:true});return true;}
    let request:unknown;try{request=JSON.parse(String(event.placeholder));}catch{respond(id,{cancelled:true});return true;}
    void executor.execute(request).then(result=>respond(id,{value:JSON.stringify(result)}));return true;
  },cancel:async()=>{await executor?.dispose();},dispose:async()=>{await executor?.dispose();await boundary.dispose();}};
}
