import {spawnSync} from "node:child_process";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it} from "vitest";
import {CodexAppServerClient} from "../src/codex-client.js";
import {prepareCodexEvaluationBoundary as prepare} from "../src/codex-boundary.js";
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function layout(){const root=mkdtempSync(join(tmpdir(),"codex-boundary-"));roots.push(root);const workspace=join(root,"job"),input=join(root,"input"),reportDir=join(workspace,"reports");mkdirSync(input);mkdirSync(reportDir,{recursive:true});writeFileSync(join(input,"delivery.txt"),"original");symlinkSync(input,join(reportDir,"escape"));return{workspace,evaluation:{inputRoots:[input],reportDir},runtimeRoot:join(root,"state"),guardDir:join(root,"guard")};}
it.skipIf(process.platform!=="darwin")("protects a complete Codex process tree while retaining private original native state",async()=>{const options=layout(),boundary=await prepare(options);try{
 const run=(script:string,target:string)=>spawnSync(boundary.command,[...boundary.prefix,"/bin/sh","-c",script],{env:{...boundary.env,TARGET:target},encoding:"utf8"});const input=join(options.evaluation.inputRoots[0]!,"delivery.txt");
 expect(run('cat "$TARGET"',input).stdout).toBe("original");expect(run('printf pass > "$TARGET"',join(options.evaluation.reportDir,"report.json")).status).toBe(0);
 for(const script of ['sh -c \'printf forged > "$TARGET"\'','mv "$TARGET" "$TARGET.old"','chmod 777 "$TARGET"','printf forged > "$TARGET"; printf original > "$TARGET"'])expect(run(script,input).status).not.toBe(0);
 expect(run('printf forged > "$TARGET"',join(options.evaluation.reportDir,"escape/delivery.txt")).status).not.toBe(0);expect(run('printf forged > "$TARGET"',join(options.workspace,"authority.json")).status).not.toBe(0);
 expect(run('printf history > "$TARGET"',join(boundary.env.CODEX_HOME,"original-rollout.jsonl")).status).toBe(0);expect(readFileSync(input,"utf8")).toBe("original");await boundary.dispose();expect(readFileSync(join(boundary.env.CODEX_HOME,"original-rollout.jsonl"),"utf8")).toBe("history");expect(existsSync(options.guardDir)).toBe(false);
 }finally{await boundary.dispose();}});
it("refuses missing guards and overlapping mutable roots before spawning Codex",async()=>{const options=layout();await expect(prepare({...options,guard:{name:"none",available:()=>false,prepare:async()=>{throw new Error("must not run");}}})).rejects.toThrow(/guard unavailable/);await expect(prepare({...options,runtimeRoot:options.evaluation.inputRoots[0]})).rejects.toThrow(/overlap/);});
it("does not follow a private CODEX_HOME symlink into the immutable input",async()=>{const options=layout();mkdirSync(join(options.runtimeRoot,"home"),{recursive:true});symlinkSync(options.evaluation.inputRoots[0]!,join(options.runtimeRoot,"home/.codex"));await expect(prepare(options)).rejects.toThrow(/symlink|escaped/);expect(existsSync(join(options.evaluation.inputRoots[0]!,"config.toml"))).toBe(false);});

const nativeBinary="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
it.skipIf(process.platform!=="darwin"||!existsSync(nativeBinary))("the real native thread reports workspace-write for explicit report configuration under the outer guard",async()=>{
 const options=layout(),boundary=await prepare(options);const client=new CodexAppServerClient({binaryPath:boundary.command,args:[...boundary.prefix,nativeBinary,...boundary.args],cwd:boundary.cwd,env:boundary.env});let resolveExit!:()=>void;const exited=new Promise<void>(resolve=>resolveExit=resolve);client.once("exit",resolveExit);
 try{await client.start();const response=await client.request("thread/start",{cwd:boundary.cwd,sandbox:"workspace-write",approvalPolicy:"on-request",approvalsReviewer:"user",config:{"sandbox_workspace_write.writable_roots":[boundary.cwd],"project_doc_max_bytes":0,"sandbox_workspace_write.network_access":true,"sandbox_workspace_write.exclude_slash_tmp":true,"sandbox_workspace_write.exclude_tmpdir_env_var":true},dynamicTools:[],selectedCapabilityRoots:[],environments:[]}) as {thread:{id:string};cwd:string;sandbox:{type:string;networkAccess:boolean;excludeSlashTmp:boolean;excludeTmpdirEnvVar:boolean;writableRoots:string[]};instructionSources:string[]};
 expect(response.cwd).toBe(boundary.cwd);expect(response.sandbox).toMatchObject({type:"workspaceWrite",networkAccess:true,excludeSlashTmp:true,excludeTmpdirEnvVar:true});expect(response.sandbox.writableRoots).toEqual([]);expect(response.instructionSources).toEqual([]);const inventory=await client.request("mcpServerStatus/list",{threadId:response.thread.id,detail:"full",limit:100}) as {data:unknown[];nextCursor:null|string};expect(inventory).toMatchObject({data:[],nextCursor:null});await client.request("thread/unsubscribe",{threadId:response.thread.id});
 }finally{client.stop();await exited;await boundary.dispose();}
});

it("refuses pre-existing report-local Codex configuration before trusting the host-created report directory",async()=>{const options=layout();mkdirSync(join(options.evaluation.reportDir,".codex"));writeFileSync(join(options.evaluation.reportDir,".codex/config.toml"),'[mcp_servers.foreign]\ncommand="/usr/bin/true"\n');await expect(prepare(options)).rejects.toThrow(/report.*configuration/);expect(readFileSync(join(options.evaluation.inputRoots[0]!,"delivery.txt"),"utf8")).toBe("original");});
it.skipIf(process.platform!=="darwin")("does not let report tools introduce Codex config, hooks, or rules during a protected native session",async()=>{const options=layout(),boundary=await prepare(options);try{for(const relative of [".codex/config.toml",".codex/hooks.json",".codex/rules/override.md",".codex/skills/foreign/SKILL.md",".agents/skills/foreign/SKILL.md"]){const target=join(options.evaluation.reportDir,relative),result=spawnSync(boundary.command,[...boundary.prefix,"/bin/sh","-c",'mkdir -p "$(dirname "$1")"; printf foreign > "$1"',"probe",target],{env:boundary.env,encoding:"utf8"});expect(result.status).not.toBe(0);expect(existsSync(target)).toBe(false);}}finally{await boundary.dispose();}});

it("refuses pre-existing report-local agent skills before native context loading",async()=>{const options=layout();mkdirSync(join(options.evaluation.reportDir,".agents/skills/foreign"),{recursive:true});writeFileSync(join(options.evaluation.reportDir,".agents/skills/foreign/SKILL.md"),"Foreign evaluator instructions");await expect(prepare(options)).rejects.toThrow(/report.*configuration/);});
it.skipIf(process.platform!=="darwin")("links the authorized login read-only: the guarded process reads it but cannot change it",async()=>{
 const options=layout(),dir=mkdtempSync(join(tmpdir(),"codex-auth-"));roots.push(dir);const source=join(dir,"auth.json");writeFileSync(source,"{\"fixture\":true}");
 const boundary=await prepare({...options,nativeAuthFile:source});try{
  const link=join(boundary.env.CODEX_HOME,"auth.json"),run=(script:string)=>spawnSync(boundary.command,[...boundary.prefix,"/bin/sh","-c",script],{env:{...boundary.env,TARGET:link},encoding:"utf8"});
  expect(run('cat "$TARGET"').stdout).toBe("{\"fixture\":true}");
  expect(run('printf forged > "$TARGET"').status).not.toBe(0);expect(readFileSync(source,"utf8")).toBe("{\"fixture\":true}");
 }finally{await boundary.dispose();}
});
it("never replaces a credential file the private realm already owns",async()=>{
 const options=layout(),dir=mkdtempSync(join(tmpdir(),"codex-auth-"));roots.push(dir);const source=join(dir,"auth.json");writeFileSync(source,"{}");
 mkdirSync(join(options.runtimeRoot,"home",".codex"),{recursive:true});writeFileSync(join(options.runtimeRoot,"home",".codex","auth.json"),"own");
 await expect(prepare({...options,nativeAuthFile:source})).rejects.toThrow(/own credential/);expect(readFileSync(join(options.runtimeRoot,"home",".codex","auth.json"),"utf8")).toBe("own");
});
