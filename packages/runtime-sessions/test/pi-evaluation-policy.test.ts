import {mkdirSync,mkdtempSync,writeFileSync,rmSync,symlinkSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {registeredRuntimeExecutable} from "../../pi-runtime/src/registration.js";
import {PiDriver} from "../src/pi.js";
import type {RuntimeDriver} from "../src/driver.js";
vi.mock("../../pi-runtime/src/registration.js",()=>({registeredRuntimeExecutable:vi.fn(()=>undefined)}));
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const flags=["--no-extensions","--no-skills","--no-context-files","--no-prompt-templates","--append-system-prompt","--tools"];
function installed(){
 const root=mkdtempSync(join(tmpdir(),"pi-policy-"));roots.push(root);const pkg=join(root,"native");
 for(const part of ["bundle/chunks","core","cli"])mkdirSync(join(pkg,"dist",part),{recursive:true});
 writeFileSync(join(pkg,"package.json"),JSON.stringify({name:"@earendil-works/pi-coding-agent",version:"0.86.1"}));
 writeFileSync(join(pkg,"dist","core","agent-session.js"),'this._emit({ type: "agent_settled" });');
 const args=join(pkg,"dist","cli","args.js");writeFileSync(args,flags.map(flag=>`if (arg === "${flag}") {}`).join("\n"));
 const binary=join(pkg,"dist","bundle","cli.js"),chunk=join(pkg,"dist","bundle","chunks","tools.js");writeFileSync(binary,"// controlled native package fixture");writeFileSync(chunk,"// original builtin tools");
 return{root,pkg,binary,chunk,args,driver:new PiDriver({binaryPath:binary}) as RuntimeDriver};
}
it.skipIf(process.platform!=="darwin")("declares source-pinned Pi evaluation channels without manufacturing a qualification receipt",()=>{
 const t=installed(),policy=t.driver.evaluationPolicy?.();expect(policy).toBeDefined();expect(policy!.version).toMatch(/^pi-evaluation@1:sha256:[a-f0-9]{64}$/);
 expect(policy!.channels).toEqual(["pi:builtin:read","pi:builtin:grep","pi:builtin:find","pi:builtin:ls","pi:builtin:write","pi:builtin:edit","pi:builtin:bash","pi:child-process","pi:host-approval-extension"]);
 expect(policy).not.toHaveProperty("qualified");expect(t.driver.evaluationPolicy?.()).toEqual(policy);
});
it.skipIf(process.platform!=="darwin")("invalidates the policy when native tool bytes change without a version change",()=>{
 const t=installed(),before=t.driver.evaluationPolicy?.();expect(before).toBeDefined();writeFileSync(t.chunk,"// changed native tools at the same version");const after=t.driver.evaluationPolicy?.();expect(after).toBeDefined();expect(after!.version).not.toBe(before!.version);
});
it.skipIf(process.platform!=="darwin")("does not declare complete channels when prompt template isolation is unavailable",()=>{
 const t=installed();expect(t.driver.evaluationPolicy?.()).toBeDefined();writeFileSync(t.args,readFileSync(t.args,"utf8").replace('if (arg === "--no-prompt-templates") {}',""));expect(t.driver.evaluationPolicy?.()).toBeUndefined();
});
it.skipIf(process.platform!=="darwin")("refuses a native program symlink that escapes its audited package",()=>{
 const t=installed(),outside=join(t.root,"outside.js");expect(t.driver.evaluationPolicy?.()).toBeDefined();writeFileSync(outside,"// foreign tool loader");symlinkSync(outside,join(t.pkg,"dist","bundle","chunks","extra.js"));expect(t.driver.evaluationPolicy?.()).toBeUndefined();
});
it("never qualifies an injected endpoint or custom guard as the production Pi boundary",()=>{
 const t=installed();const fakeClient=new PiDriver({binaryPath:t.binary,clientFactory:()=>{throw new Error("unused");}});const fakeGuard=new PiDriver({binaryPath:t.binary,guard:{name:"unknown",available:()=>true,prepare:async()=>{throw new Error("unused");}}});expect(fakeClient.evaluationPolicy?.()).toBeUndefined();expect(fakeGuard.evaluationPolicy?.()).toBeUndefined();
});
it("does not reuse source qualification for an external runtime executable",async()=>{
 const t=installed(),driver=new PiDriver({binaryPath:t.binary,runtimeExecutable:'/external/operator/pi-runtime'});
 expect(driver.evaluationPolicy()).toBeUndefined();
 await expect(driver.startTurn({workspace:t.root,evaluation:{reportDir:join(t.root,'report'),inputRoots:[t.root]}} as never,{} as never)).rejects.toMatchObject({stage:'create',notExecuted:true,message:expect.stringContaining('own evaluation qualification')});
});

it("does not reuse source qualification for a registered runtime",async()=>{
 const t=installed();vi.mocked(registeredRuntimeExecutable).mockReturnValue('/registered/pi-runtime');
 try {expect(t.driver.evaluationPolicy?.()).toBeUndefined();await expect(t.driver.startTurn({workspace:t.root,evaluation:{reportDir:join(t.root,'report'),inputRoots:[t.root]}} as never,{} as never)).rejects.toMatchObject({stage:'create',notExecuted:true});}
 finally {vi.mocked(registeredRuntimeExecutable).mockReturnValue(undefined);}
});
