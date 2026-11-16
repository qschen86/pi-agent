import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeSessionManager } from "../src/manager.js";
import { CodexDriver } from "../src/codex.js";
import { CodexAppServerClient } from "../src/codex-client.js";
import { FakeDriver } from "./fake-driver.js";
const dirs:string[]=[];afterEach(()=>{vi.useRealTimers();dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true}));});
function manager(codex:CodexDriver|FakeDriver=new FakeDriver("codex")){
 const dir=mkdtempSync(join(tmpdir(),"manager-store-busy-"));dirs.push(dir);
 const m=new RuntimeSessionManager({dataDir:dir,skipRecovery:true,drivers:{codex,"claude-code":new FakeDriver("claude-code"),pi:new FakeDriver("pi")}});
 m.store.putBinding({platformSessionId:"session",runtimeKind:"codex",runtimeProfileId:"profile",hostId:m.store.host.hostId,identityScopeId:"account",nativeSessionId:"native",sourceMode:"platform-managed",executionMode:"runtime-native",title:"test",workspace:dir,permissionLabel:"ask",createdAt:{at:"2026-10-03T00:00:00Z",source:"platform"},lastActivityAt:{at:"2026-10-03T00:00:00Z",source:"platform"},bindingRevision:1,creationOperationId:"operation",status:"unknown",observation:"live",turns:[],coverage:"unknown"});
 // Exercise the production stream-ingestion path that arms a bookkeeping flush.
 (m as any).ingest("session",{key:"message",kind:"message",text:"test",occurredAt:"2026-10-03T01:00:00Z",source:"stream",parserVersion:"test",availability:"recorded"});
 return m;
}
it("retries a contended activity flush and later persists it without crashing the timer callback",async()=>{
 vi.useFakeTimers();const m=manager(),lock=join(m.store.dir,"admission.lock");mkdirSync(lock);
 try{
  await expect(vi.advanceTimersByTimeAsync(2000)).resolves.toBeDefined();
  const persisted=()=>JSON.parse(readFileSync(join(m.store.dir,"bindings.json"),"utf8")).session;
  expect(persisted().lastActivityAt.at).toBe("2026-10-03T00:00:00Z");rmSync(lock,{recursive:true});await vi.advanceTimersByTimeAsync(2000);
  expect(persisted().lastActivityAt.at).toBe("2026-10-03T01:00:00Z");expect(persisted().bindingRevision).toBe(1);
 }finally{rmSync(lock,{recursive:true,force:true});m.shutdown();}
});
it("stops the actual app-server subprocess even when shutdown bookkeeping cannot acquire storage",async()=>{
 const fixture=fileURLToPath(new URL("./fixtures/fake-app-server.mjs",import.meta.url));
 const client=new CodexAppServerClient({binaryPath:process.execPath,args:[fixture],env:process.env as Record<string,string>});
 const driver=new CodexDriver({binaryPath:process.execPath,clientFactory:()=>client});await driver.rateLimits();expect(client.alive).toBe(true);
 const m=manager(driver),lock=join(m.store.dir,"admission.lock");mkdirSync(lock);
 try{expect(()=>m.shutdown()).not.toThrow();await new Promise(r=>setTimeout(r,1700));expect(client.alive).toBe(false);}
 finally{rmSync(lock,{recursive:true,force:true});m.shutdown();driver.shutdown();client.stop();}
},10000);
