/** Runtime parent process: owns execution policy, workers and privileged command approval. */
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { canonicalPath, isWithin } from "../../adapter-pi/src/runtime-guard-policy.js";
import { preparePiChatBoundary, type PiChatBoundary } from "./pi-boundary.js";
import { PiRpcClient, type PiRpcEvent } from "./pi-client.js";
import { PiCommandExecutor } from "./pi-command-executor.js";
import { PI_ESCALATION_TITLE } from "./pi-approval-extension.js";
import { isPiPermissionMode } from "./policy.js";
import type { PiRuntimeSpec, RuntimeApproval } from "./types.js";
import { communityApproval, CommunitySessionGrants } from './community-approval.js';
import { loadPiCommunityProfile } from './pi-community-profile.js';

export class PiRuntimeSupervisor extends EventEmitter {
  private root?: string;
  private boundary?: PiChatBoundary;
  private client?: PiRpcClient;
  private executor?: PiCommandExecutor;
  private closing?: Promise<void>;
  private history?: {source:string;destination:string};
  private checkpoint() { if(this.history && existsSync(this.history.source)){const temporary=this.history.destination+".tmp";copyFileSync(this.history.source,temporary);renameSync(temporary,this.history.destination);} }
  private checkOpen() { if(this.closing) throw new Error("Runtime startup cancelled"); }
  private pending = new Map<string,(allowed:boolean,reason?:string,scope?:string)=>void>();
  private publish(event: PiRpcEvent) { this.emit("event",event); }
  async start(spec: PiRuntimeSpec): Promise<void> {
    if (this.root || this.closing || spec.version !== 1 || !/^[a-f0-9-]{36}$/i.test(spec.sessionId) || !isAbsolute(spec.workspace) || !isAbsolute(spec.binary) || !isPiPermissionMode(spec.mode) || !spec.provider || !spec.model) throw new Error("Invalid or repeated runtime launch");
    if (spec.webResearch !== undefined) {
      const web = spec.webResearch as { sourceDomains?: unknown; budget?: unknown } | null;
      const budget = web?.budget as Record<string, unknown> | undefined;
      if (!web || typeof web !== "object" || !Array.isArray(web.sourceDomains) || web.sourceDomains.length === 0 || web.sourceDomains.some((d) => typeof d !== "string" || !d.trim())) throw new Error("Invalid web research authorization");
      if (budget !== undefined && (typeof budget !== "object" || budget === null || Object.entries(budget).some(([key, value]) => !["searches", "opens", "maxResults", "maxPageChars", "maxTotalChars"].includes(key) || !Number.isInteger(value) || (value as number) < 1))) throw new Error("Invalid web research budget");
    }
    const root=this.root=mkdtempSync(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'prt-'));
    try{
    // Native history owns its assembly identity, including when moved between frontends.
    let resumeFingerprint: string|undefined;
    let recordBrowserSelection = !spec.sessionFile;
    if(spec.sessionFile){
      const rows=readFileSync(spec.sessionFile,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
      const header=rows[0];
      recordBrowserSelection=rows.some(r=>r.type==='custom'&&r.customType==='pi-runtime-browser');
      if(header?.id!==spec.sessionId||canonicalPath(header.cwd)!==canonicalPath(spec.workspace))throw new Error('Runtime history does not match session/workspace');
      resumeFingerprint=rows.reverse().find(r=>r.type==='custom'&&r.customType==='pi-runtime-assembly')?.data?.fingerprint ?? 'legacy';
    }
      let profile=resumeFingerprint==='legacy'?undefined:spec.communityProfilePath;
      if(resumeFingerprint&&resumeFingerprint!=='legacy'&&profile&&spec.resumeCommunityProfilePath){
        const current=loadPiCommunityProfile(profile,spec.workspace);
        if(current.fingerprint!==resumeFingerprint){
          const historical=loadPiCommunityProfile(spec.resumeCommunityProfilePath,spec.workspace);
          if(historical.fingerprint!==resumeFingerprint)throw new Error('Pi runtime assembly changed; historical operator profile does not match');
          profile=spec.resumeCommunityProfilePath;
        }
      }
      const boundary=this.boundary=await preparePiChatBoundary({workspace:spec.workspace,worktree:spec.worktree,mode:spec.mode,provider:spec.provider,model:spec.model,memorySource:spec.memorySource,sourceAgentDir:spec.sourceAgentDir,runtimeRoot:join(root,'runtime'),guardDir:join(root,'guard'),roleInstructions:spec.roleInstructions,recordReadRoots:spec.recordReadRoots,capabilityGateway:spec.capabilityGateway,platformBrowser:spec.platformBrowser,evaluation:spec.evaluation,communityProfilePath:profile,nativeMemoryProfilePath:spec.nativeMemoryProfilePath ?? spec.communityProfilePath,...(spec.webResearch?{webResearch:{sourceDomains:spec.webResearch.sourceDomains,...(spec.webResearch.budget?{budget:spec.webResearch.budget}:{})}}:{})});
      this.checkOpen();
      // Mode selects the active tool boundary; it does not replace the pinned installation.
      // Read-only/native turns keep community permissions dormant and validate their identity.
      // Native memory is independently enabled by the current operator profile.
      const fingerprint=boundary.communityFingerprint ?? (resumeFingerprint && resumeFingerprint !== 'legacy' && profile
        ? loadPiCommunityProfile(profile,spec.workspace).fingerprint : 'legacy');
      if((resumeFingerprint&&resumeFingerprint!==fingerprint)||(spec.expectedFingerprint&&spec.expectedFingerprint!==fingerprint))throw new Error('Pi runtime assembly changed; restore its configuration or create a new session');
      if(spec.permissionStatePath && isWithin(canonicalPath(spec.permissionStatePath),canonicalPath(spec.workspace)))throw new Error('Runtime permission state must be outside the workspace');
      const communityGrants = new CommunitySessionGrants(spec.permissionStatePath, JSON.stringify([spec.sessionId, canonicalPath(spec.workspace), fingerprint]));
      boundary.env.PI_CHAT_GATE_TOKEN=randomUUID();boundary.env.PI_RUNTIME_ASSEMBLY=fingerprint;
      if(recordBrowserSelection)boundary.env.PI_RUNTIME_BROWSER_PROFILE=spec.browserProfileId??"isolated";
      const sessionArgs:string[]=[];
      if(spec.sessionFile){const file=join(boundary.env.TMPDIR,'session.jsonl');copyFileSync(spec.sessionFile,file);sessionArgs.push('--session',file);}
      else sessionArgs.push('--session-id',spec.sessionId,'--session-dir',join(boundary.env.TMPDIR,'sessions'));
      if(spec.mode==='pi-ask'&&!spec.evaluation)this.executor=new PiCommandExecutor({workspace:spec.workspace,worktree:spec.worktree,env:boundary.env,runtimeRoot:join(root,'runtime'),guardDir:join(root,'guard'),readable:boundary.commandReadRoots,writable:boundary.commandWriteRoots,sink:{approval:(request,signal)=>this.ask(request,signal),status:status=>this.publish({type:'runtime_status',status})}});
      const wrapped=await boundary.wrap(spec.binary,['--mode','rpc',...boundary.argsPrefix,'--provider',spec.provider,'--model',spec.model,...sessionArgs]);
      this.checkOpen();
      const client=this.client=new PiRpcClient({binaryPath:wrapped.command,args:wrapped.args,cwd:spec.workspace,env:{...boundary.env,...wrapped.env},detached:false,passthroughResponses:true,exitGraceMs:15000,gracefulShutdown:true});
      let ready!:()=>void,reject!: (error:Error)=>void,evaluationInventory:unknown;
      const initialized=new Promise<void>((yes,no)=>{ready=yes;reject=no;});
      let permissionInputs: unknown[]=[];
      client.on('event',(event:PiRpcEvent)=>{
        if(event.type==='message_end'){const message=event.message as {role?:string;content?:Array<{type:string;name?:string;arguments?:unknown}>};if(message?.role==='assistant')permissionInputs=(message.content??[]).filter(c=>c.type==='toolCall').map(c=>({name:c.name,arguments:c.arguments}));}
        if(event.type==='extension_ui_request'&&event.method==='notify'&&event.message===`pi-chat-gate:${boundary.env.PI_CHAT_GATE_TOKEN}`){ready();return;}
        if(spec.evaluation&&event.type==='extension_ui_request'&&event.method==='notify'&&String(event.message).startsWith('pi-chat-evaluation-tools:')){try{evaluationInventory=JSON.parse(String(event.message).slice('pi-chat-evaluation-tools:'.length));if((evaluationInventory as {token?:string})?.token!==boundary.env.PI_CHAT_GATE_TOKEN)throw new Error('Invalid runtime inventory token');ready();}catch{reject(new Error('Invalid runtime inventory'));}return;}
        if(event.type==='extension_error')reject(new Error('Pi runtime extension initialization failed'));
        const permission = boundary.communityFingerprint && communityApproval(event);
        if (permission) {
          const id = String(event.id ?? '');
          // Dialog text may be elided by the community renderer. Bind reuse to full native tool inputs too.
          const grantKey=createHash('sha256').update(JSON.stringify([permission.key,permissionInputs.length?permissionInputs:randomUUID()])).digest('hex');
          const grantRevision=communityGrants.list().revision;
          if (communityGrants.has(grantKey)) { client.respondUi(id, {value:'Yes'}); return; }
          void this.ask({nativeRequestId:id,kind:'permissions',title:'Pi 工具授权',action:permission.action,scope:spec.workspace,source:'Pi runtime · community permissions',requiresExplicitApproval:true,runtimeSessionScope:'仅限当前动作、参数与范围，持续到本会话结束',params:{title:event.title,options:event.options,inputs:permissionInputs}},new AbortController().signal).then(decision=>{
            if(this.closing)return;
            try {
              if(decision.approve && decision.scope==='session')communityGrants.add(grantKey,{tool:permission.tool,action:permission.action,scope:spec.workspace},grantRevision);
              client.respondUi(id,{value:decision.approve?'Yes':'No'});
            } catch { client.respondUi(id,{value:'No'}); }
          });
          return;
        }
        if(event.type==='extension_ui_request'&&event.method==='confirm'){
          let params:Record<string,unknown>|undefined;try{params=JSON.parse(String(event.message));}catch{}
          if(params&&typeof params.toolCallId==='string'){
            const id=String(event.id??'');
            if(!['write','edit','bash'].includes(String(params.toolName))){client.respondUi(id,{confirmed:false});return;}
            const signal=new AbortController();
            void this.ask({nativeRequestId:id,kind:params.toolName==='bash'?'command':'file-change',title:String(event.title),action:JSON.stringify(params.input).slice(0,6000),scope:spec.workspace,source:'Pi runtime approval extension',requiresExplicitApproval:true,params},signal.signal).then(decision=>{if(!this.closing)client.respondUi(id,{confirmed:decision.approve});});return;
          }
        }
        if(event.type==='extension_ui_request'&&event.method==='input'&&event.title===PI_ESCALATION_TITLE){
          const id=String(event.id??'');
          let request:unknown;try{request=JSON.parse(String(event.placeholder));}catch{client.respondUi(id,{cancelled:true});return;}
          if(!this.executor){client.respondUi(id,{cancelled:true});return;}
          void this.executor.execute(request).then(result=>{if(!this.closing)client.respondUi(id,{value:JSON.stringify(result)});});return;
        }
        if(event.type==='agent_settled')this.checkpoint();
        this.publish(event);
      });
      client.on('exit',({reason})=>{reject(new Error(reason));if(!this.closing){this.publish({type:'runtime_error',error:reason});void this.stop().then(()=>this.emit('exit'));}});
      await client.start();
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([initialized,new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new Error('Pi runtime initialization timed out')),45000);})]);}finally{clearTimeout(timer);}
      const state=await client.request('get_state') as {sessionId?:string;sessionFile?:string};
      if(state.sessionId!==spec.sessionId||!state.sessionFile||!isWithin(canonicalPath(state.sessionFile),canonicalPath(boundary.env.TMPDIR)))throw new Error('Pi runtime session location is invalid');
      this.checkOpen();
      if(spec.historyDestination){mkdirSync(dirname(spec.historyDestination),{recursive:true,mode:0o700});this.history={source:state.sessionFile,destination:spec.historyDestination};this.checkpoint();}
      this.publish({type:'runtime_ready',version:1,capabilityGateway:spec.capabilityGateway?1:undefined,platformBrowser:spec.platformBrowser?1:undefined,permissionGrantControl:1,sessionId:spec.sessionId,workspace:canonicalPath(spec.workspace),sessionDirectory:boundary.env.TMPDIR,fingerprint,...(evaluationInventory?{inventory:evaluationInventory}:{})});
    }catch(error){await this.stop();await this.boundary?.dispose();rmSync(root,{recursive:true,force:true});throw error;}
  }
  private ask(request:RuntimeApproval,signal:AbortSignal):Promise<{approve:boolean;reason:string;scope?:string}>{
    if(signal.aborted)return Promise.resolve({approve:false,reason:'Runtime cancelled'});
    const id=`runtime-approval-${randomUUID()}`;
    return new Promise(resolve=>{
      const finish=(approved:boolean,reason?:string,scope?:string)=>{signal.removeEventListener('abort',abort);this.pending.delete(id);resolve({scope,approve:approved&&!signal.aborted,reason:reason?.slice(0,1000)||(approved?'Runtime approval received':'Runtime approval denied or cancelled')});};
      const abort=()=>finish(false);
      this.pending.set(id,finish);signal.addEventListener('abort',abort,{once:true});
      this.publish({type:'runtime_approval',id,request:{...request,nativeRequestId:id}});
    });
  }
  send(message:PiRpcEvent):void{
    if(message.type==='extension_ui_response'&&this.pending.has(String(message.id))){this.pending.get(String(message.id))!(message.confirmed===true&&!message.cancelled,typeof message.reason==='string'?message.reason:undefined,message.scope==='session'?'session':undefined);return;}
    if(message.type==='abort'){for(const finish of [...this.pending.values()])finish(false);void this.executor?.dispose();}
    this.client?.forward(message);
  }
  stop():Promise<void>{
    return this.closing??=(async()=>{
      for(const finish of [...this.pending.values()])finish(false);
      await this.executor?.dispose();
      try{await this.boundary?.closeBrowser?.();}
      finally{
        this.client?.stop();await this.client?.waitForExit();
        this.checkpoint();
        await this.boundary?.dispose();if(this.root)rmSync(this.root,{recursive:true,force:true});
      }
    })();
  }
}
