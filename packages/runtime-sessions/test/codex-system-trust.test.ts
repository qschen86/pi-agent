/** Certificate trust daemon discovery only: no credential/Keychain reads or network requests. */
import {mkdirSync,mkdtempSync,writeFileSync,realpathSync,rmSync} from "node:fs";
import {join} from "node:path";import {tmpdir} from "node:os";import {execFile} from "node:child_process";import {promisify} from "node:util";import {expect,it} from "vitest";
import {prepareCodexEvaluationBoundary} from "../src/codex-boundary.js";
import {compileRuntimeGuardPolicy,SeatbeltRuntimeGuard,verifyRuntimeGuard} from "@pi-agent/adapter-pi";
const run=promisify(execFile);
it.skipIf(process.platform!=="darwin")("Codex TLS can discover only explicit trust services while shared baseline and file boundaries remain restrictive",async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"codex-system-trust-"))),workspace=join(root,"job"),reportDir=join(workspace,"report"),input=join(root,"input"),runtimeRoot=join(root,"state"),tmp=join(runtimeRoot,"tmp"),source=join(tmp,"lookup.c"),binary=join(tmp,"lookup");for(const p of [reportDir,input,tmp])mkdirSync(p,{recursive:true});
 writeFileSync(source,'#include <servers/bootstrap.h>\n#include <mach/mach.h>\n#include <stdio.h>\nint main(int argc,char **argv){mach_port_t p=MACH_PORT_NULL;kern_return_t c=bootstrap_look_up(bootstrap_port,argv[1],&p);printf("%d\\n",c);if(p!=MACH_PORT_NULL)mach_port_deallocate(mach_task_self(),p);return 0;}\n');await run("/usr/bin/clang",[source,"-o",binary],{timeout:30000});
 const boundary=await prepareCodexEvaluationBoundary({workspace,evaluation:{inputRoots:[input],reportDir},runtimeRoot,guardDir:join(root,"codex-guard")});
 const policy=compileRuntimeGuardPolicy({workspaceRoot:workspace,writeSubPaths:["report"],runtimeWritable:[runtimeRoot],runtimeReadable:[input,join(root,"default-guard")]});const baseline=await new SeatbeltRuntimeGuard().prepare({policy,guardDir:join(root,"default-guard"),runtimeTmp:tmp});
 try{for(const name of ["com.apple.trustd","com.apple.trustd.agent"]){const plain=await baseline.wrap(binary,[name]);expect(Number((await run(plain.command,plain.args)).stdout.trim())).toBe(1100);expect(Number((await run(boundary.command,[...boundary.prefix,binary,name],{env:boundary.env,cwd:boundary.cwd})).stdout.trim())).toBe(0);}expect(Number((await run(binary,["com.apple.pasteboard.1"])).stdout.trim())).toBe(0);const pasteboard=await run(boundary.command,[...boundary.prefix,binary,"com.apple.pasteboard.1"],{env:boundary.env,cwd:boundary.cwd});expect(Number(pasteboard.stdout.trim())).not.toBe(0);expect((await verifyRuntimeGuard(baseline,{policy,guardDir:join(root,"default-guard"),runtimeTmp:tmp})).passed).toBe(true);}
 finally{await baseline.dispose();await boundary.dispose();rmSync(root,{recursive:true,force:true});}
});
