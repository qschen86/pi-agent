/** Whole-process evaluator boundary. Login, original-ID routing and formal qualification are separate gates. */
import {existsSync,lstatSync,mkdirSync,realpathSync,rmSync,symlinkSync,unlinkSync} from "node:fs";
import {relative,join} from "node:path";
import {canonicalPath,compileRuntimeGuardPolicy,isWithin,SeatbeltRuntimeGuard,verifyRuntimeGuard} from "@pi-agent/adapter-pi";
import type {RuntimeGuardProvider} from "@pi-agent/runtime-contracts";
import {allowlistedEnv} from "./codex-client.js";
import {normalizeEvaluation,type EvaluationBoundary} from "./evaluation.js";
export const CODEX_EVALUATION_ARGS=Object.freeze(["app-server","--strict-config",
  ...["hooks","memories","apps","plugins","multi_agent","browser_use","computer_use","code_mode_host"].flatMap(name=>["--disable",name]),
  "-c","project_doc_max_bytes=0"]);
/** nativeAuthFile: human-authorized original login, exposed read-only through a link; the platform never reads or copies it. */
export interface CodexBoundaryOptions {workspace:string;evaluation:EvaluationBoundary;runtimeRoot:string;guardDir:string;guard?:RuntimeGuardProvider;nativeAuthFile?:string;}
export interface CodexEvaluationBoundary {command:string;prefix:string[];args:string[];env:Record<string,string>;cwd:string;dispose():Promise<void>;}
export async function prepareCodexEvaluationBoundary(options:CodexBoundaryOptions):Promise<CodexEvaluationBoundary>{
 const evaluation=normalizeEvaluation(options.workspace,options.evaluation),workspace=canonicalPath(options.workspace),runtimeRoot=canonicalPath(options.runtimeRoot),guardDir=canonicalPath(options.guardDir);
 const overlap=(a:string,b:string)=>isWithin(a,b)||isWithin(b,a);
 if(overlap(runtimeRoot,workspace)||overlap(guardDir,workspace)||overlap(runtimeRoot,guardDir)||evaluation.inputRoots.some(input=>overlap(input,runtimeRoot)||overlap(input,guardDir)))throw new Error("Codex evaluation runtime, input, guard and workspace roots overlap");
 for(const reserved of [".codex",".agents"]){try{lstatSync(join(evaluation.reportDir,reserved));throw new Error("Codex report-local configuration is not allowed");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
 const guard=options.guard??new SeatbeltRuntimeGuard({systemTrust:true});if(!guard.available())throw new Error("Codex evaluation guard unavailable; cannot run without input protection");
 const home=join(runtimeRoot,"home"),codexHome=join(home,".codex"),tmp=join(runtimeRoot,"tmp");
 // No config import. Only the authorized login file is linked, after trusted stock bootstrap, and stays read-only.
 for(const directory of [runtimeRoot,home,codexHome,tmp]){mkdirSync(directory,{recursive:true,mode:0o700});if(lstatSync(directory).isSymbolicLink()||realpathSync(directory)!==directory)throw new Error("Codex private state path is a symlink or escaped its runtime root");}
 const authReadable:string[]=[];
 if(options.nativeAuthFile&&existsSync(options.nativeAuthFile)){
  const source=options.nativeAuthFile,st=lstatSync(source);
  if(!st.isFile()||realpathSync(source)!==canonicalPath(source))throw new Error("Codex native login source is not a plain file");
  const link=join(codexHome,"auth.json");
  try{const cur=lstatSync(link);if(!cur.isSymbolicLink())throw new Error("Codex private realm already holds its own credential file; refusing to replace it");unlinkSync(link);}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  symlinkSync(source,link);authReadable.push(realpathSync(source));
 }
 mkdirSync(evaluation.reportDir,{recursive:true,mode:0o700});mkdirSync(guardDir,{recursive:true,mode:0o700});
 const policy=compileRuntimeGuardPolicy({workspaceRoot:workspace,writeSubPaths:[relative(workspace,evaluation.reportDir)],runtimeWritable:[runtimeRoot],runtimeReadable:[guardDir,...evaluation.inputRoots,...authReadable]});
 policy.filesystem.hazardNames=[...policy.filesystem.hazardNames,".codex/config.toml",".codex/hooks.json",".codex/rules",".codex/skills",".codex/plugins",".agents/skills"];
 const prepared=await guard.prepare({policy,guardDir,runtimeTmp:tmp});let disposed=false;
 const dispose=async()=>{if(disposed)return;disposed=true;await prepared.dispose();rmSync(guardDir,{recursive:true,force:true});};
 try{const check=await verifyRuntimeGuard(prepared,{policy,guardDir,runtimeTmp:tmp});if(!check.passed)throw new Error(`Codex evaluation guard self-check failed: ${check.failures.join("; ")}`);
 const wrapped=await prepared.wrap("/usr/bin/env",[]);
 return{command:wrapped.command,prefix:wrapped.args,args:[...CODEX_EVALUATION_ARGS,"-c",`projects={${JSON.stringify(evaluation.reportDir)}={trust_level="untrusted"}}`],env:{...allowlistedEnv(),...wrapped.env,HOME:home,CODEX_HOME:codexHome,TMPDIR:tmp},cwd:evaluation.reportDir,dispose};
 }catch(error){await dispose();throw error;}
}
