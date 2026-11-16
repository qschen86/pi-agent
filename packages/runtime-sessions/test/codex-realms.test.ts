import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import * as codex from "../src/codex.js";
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, {
            recursive: true, force: true
        });
});
function setup() {
    const root = mkdtempSync(join(tmpdir(), "codex-realms-"));
    roots.push(root);
    const workspace = join(root, "job"), input = join(root, "input"), reportDir = join(workspace, "report"), authority = join(root, "registry");
    for (const path of [input, reportDir])
        mkdirSync(path, {
            recursive: true
        });
    const spec = {
        workspace, evaluation: {
            inputRoots: [input], reportDir
        }, sourceHash: "sha256:" + "a".repeat(64)
    };
    const store = new codex.CodexRealmRegistry(authority);
    return {
        root, authority, spec, store, file: join(authority, "authority", "realms.json")
    };
}
it("persists the original platform/native identity and private runtime path across fresh registry objects", () => {
    const t = setup(), ticket = t.store.reserve("rt-original", t.spec), bound = t.store.bind(ticket, "native-original");
    const fresh = new codex.CodexRealmRegistry(t.authority);
    expect(fresh.resume("rt-original", t.spec, "native-original")).toMatchObject({
        nativeSessionId: "native-original", runtimeRoot: bound.runtimeRoot
    });
    expect(fresh.byNative("native-original")).toMatchObject({
        platformSessionId: "rt-original", runtimeRoot: bound.runtimeRoot
    });
    expect(fresh.byNative("not-recorded")).toBeUndefined();
});
it("holds a pending creation after restart rather than reserving a replacement native session", () => {
    const t = setup();
    t.store.reserve("rt-original", t.spec);
    const bytes = readFileSync(t.file, "utf8");
    const fresh = new codex.CodexRealmRegistry(t.authority);
    expect(() => fresh.reserve("rt-original", t.spec)).toThrow(/pending|reserved/i);
    expect(readFileSync(t.file, "utf8")).toBe(bytes);
    expect(() => fresh.resume("rt-original", t.spec, "invented-native")).toThrow();
});
it.each(["source", "input", "report", "native"])("refuses changed %s authority and preserves the original binding", kind => {
    const t = setup(), ticket = t.store.reserve("rt-original", t.spec);
    t.store.bind(ticket, "native-original");
    const before = readFileSync(t.file, "utf8"), changed = structuredClone(t.spec);
    if (kind === "source")
        changed.sourceHash = "sha256:" + "b".repeat(64);
    if (kind === "input") {
        const other = join(t.root, "other-input");
        mkdirSync(other);
        changed.evaluation.inputRoots = [other];
    }
    if (kind === "report")
        changed.evaluation.reportDir = join(t.spec.workspace, "different-report");
    expect(() => t.store.resume("rt-original", changed, kind === "native" ? "foreign-native" : "native-original")).toThrow();
    expect(readFileSync(t.file, "utf8")).toBe(before);
});
it("publishes native binding idempotently but never assigns one native ID to two platform sessions", () => {
    const t = setup(), a = t.store.reserve("rt-a", t.spec), b = t.store.reserve("rt-b", t.spec);
    expect(a.runtimeRoot).not.toBe(b.runtimeRoot);
    t.store.bind(a, "native-a");
    expect(t.store.bind(a, "native-a").nativeSessionId).toBe("native-a");
    const before = readFileSync(t.file, "utf8");
    expect(() => t.store.bind(b, "native-a")).toThrow();
    expect(() => t.store.bind(a, "replacement-native")).toThrow();
    expect(readFileSync(t.file, "utf8")).toBe(before);
    expect(t.store.byNative("native-a")?.platformSessionId).toBe("rt-a");
});
it("does not let a mutated creation ticket bind or redirect another realm", () => {
    const t = setup(), ticket = t.store.reserve("rt-original", t.spec), before = readFileSync(t.file, "utf8");
    for (const changed of [{
            ...ticket, attemptId: "00000000-0000-4000-8000-000000000000"
        }, {
            ...ticket, expectedHash: "sha256:" + "b".repeat(64)
        }, {
            ...ticket, runtimeRoot: join(t.root, "foreign-state")
        }])
        expect(() => t.store.bind(changed, "native-original")).toThrow();
    expect(readFileSync(t.file, "utf8")).toBe(before);
});
it("preserves corrupt authority instead of rebuilding an empty registry", () => {
    const t = setup();
    t.store.reserve("rt-original", t.spec);
    writeFileSync(t.file, "{broken");
    const before = readFileSync(t.file, "utf8");
    expect(() => new codex.CodexRealmRegistry(t.authority).byNative("native-original")).toThrow();
    expect(readFileSync(t.file, "utf8")).toBe(before);
});
it("rejects a linked authority file and leaves the foreign target unchanged", () => {
    const t = setup();
    t.store.reserve("rt-original", t.spec);
    const foreign = join(t.root, "foreign.json"), before = readFileSync(t.file, "utf8");
    writeFileSync(foreign, before);
    rmSync(t.file);
    symlinkSync(foreign, t.file);
    expect(() => t.store.byNative("native-original")).toThrow();
    expect(readFileSync(foreign, "utf8")).toBe(before);
});
it("rejects relocated authority instead of treating a copied registry as a new source", () => {
    const t = setup(), ticket = t.store.reserve("rt-original", t.spec);
    t.store.bind(ticket, "native-original");
    const other = join(t.root, "relocated");
    mkdirSync(join(other, "authority"), {
        recursive: true
    });
    writeFileSync(join(other, "authority", "realms.json"), readFileSync(t.file));
    expect(() => new codex.CodexRealmRegistry(other).byNative("native-original")).toThrow();
});
it("missing or linked private state is held rather than recreated on resume", () => {
    const t = setup(), ticket = t.store.reserve("rt-original", t.spec);
    t.store.bind(ticket, "native-original");
    const moved = ticket.runtimeRoot + "-moved";
    renameSync(ticket.runtimeRoot, moved);
    expect(() => t.store.resume("rt-original", t.spec, "native-original")).toThrow();
    symlinkSync(moved, ticket.runtimeRoot);
    expect(() => t.store.byNative("native-original")).toThrow();
});
it("rejects authority/runtime overlap with protected job input and report roots", () => {
    const t = setup(), inside = new codex.CodexRealmRegistry(join(t.spec.workspace, "report", "authority"));
    expect(() => inside.reserve("rt-original", t.spec)).toThrow();
});
it("missing authority does not mint a new registry even after all native state was removed", () => {
    const t = setup(), ticket = t.store.reserve("rt-original", t.spec);
    t.store.bind(ticket, "native-original");
    rmSync(t.file);
    rmSync(ticket.runtimeRoot, {
        recursive: true
    });
    expect(() => new codex.CodexRealmRegistry(t.authority)).toThrow(/missing|replacement/i);
});
it("four real host processes reserve and bind one original platform session at most once", async () => {
    const t = setup(), module = fileURLToPath(new URL("../src/codex-realms.ts", import.meta.url));
    const worker = `import {CodexRealmRegistry} from ${JSON.stringify(module)};const root=process.argv[1],spec=JSON.parse(process.argv[2]);let registry,ticket;for(let i=0;i<100;i++){try{registry??=new CodexRealmRegistry(root);ticket??=registry.reserve("rt-contended",spec);registry.bind(ticket,"native-contended");console.log("winner");break;}catch(error){if(error.code==="RT_CODEX_REALM_BUSY"){await new Promise(r=>setTimeout(r,10));continue;}if(error.code==="RT_CODEX_REALM_PENDING"){console.log("held");break;}throw error;}}`;
    const results = await Promise.all(Array.from({
        length: 4
    }, () => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", worker, t.authority, JSON.stringify(t.spec)], {
        timeout: 15000
    })));
    expect(results.filter(r => r.stdout.trim() === "winner")).toHaveLength(1);
    expect(results.filter(r => r.stdout.trim() === "held")).toHaveLength(3);
    expect(t.store.byNative("native-contended")?.platformSessionId).toBe("rt-contended");
});

function stockReceipt() {
 const files=[{path:"probe/SKILL.md",size:0,hash:"sha256:"+"a".repeat(64)}];
 return {files,hash:"sha256:"+createHash("sha256").update(JSON.stringify(files)).digest("hex")};
}
it("reclaims only a host-proved unexecuted original creation, preserving realm and stock after restart",()=>{
 const t=setup(),ticket=t.store.reserve("retry",t.spec);t.store.recordStock(ticket,stockReceipt());t.store.markUnexecuted(ticket);
 const fresh=new codex.CodexRealmRegistry(t.authority),next=fresh.continueUnexecuted("retry",t.spec);
 expect(next).toMatchObject({realmId:ticket.realmId,attemptId:ticket.attemptId,runtimeRoot:ticket.runtimeRoot});
 expect(next.creationClaimId).not.toBe(ticket.creationClaimId);expect(fresh.stock(next)).toEqual(stockReceipt());
 expect(()=>fresh.continueUnexecuted("retry",t.spec)).toThrow();
 expect(()=>fresh.markUnexecuted(ticket)).toThrow();expect(()=>fresh.markDispatched(ticket)).toThrow();expect(()=>fresh.bind(ticket,"late-native")).toThrow();
 fresh.markDispatched(next);const bytes=readFileSync(t.file,"utf8");expect(()=>fresh.markUnexecuted(next)).toThrow();expect(()=>fresh.continueUnexecuted("retry",t.spec)).toThrow();expect(readFileSync(t.file,"utf8")).toBe(bytes);
});
it("a crash before definitive unexecuted evidence and a missing stock receipt cannot authorize retry",()=>{
 const t=setup(),ticket=t.store.reserve("retry",t.spec);expect(()=>t.store.markUnexecuted(ticket)).toThrow();
 expect(()=>new codex.CodexRealmRegistry(t.authority).continueUnexecuted("retry",t.spec)).toThrow();
 t.store.recordStock(ticket,stockReceipt());const bytes=readFileSync(t.file,"utf8");expect(()=>t.store.continueUnexecuted("retry",t.spec)).toThrow();expect(readFileSync(t.file,"utf8")).toBe(bytes);
});
it.each(["source","input","report"])("changed %s facts cannot consume a ready original retry",kind=>{
 const t=setup(),ticket=t.store.reserve("retry",t.spec);t.store.recordStock(ticket,stockReceipt());t.store.markUnexecuted(ticket);const changed=structuredClone(t.spec),bytes=readFileSync(t.file,"utf8");
 if(kind==="source")changed.sourceHash="sha256:"+"b".repeat(64);if(kind==="report")changed.evaluation.reportDir=join(t.spec.workspace,"other");if(kind==="input"){const p=join(t.root,"other");mkdirSync(p);changed.evaluation.inputRoots=[p];}
 expect(()=>t.store.continueUnexecuted("retry",changed)).toThrow();expect(readFileSync(t.file,"utf8")).toBe(bytes);
});
it("a bound original native ID cannot be marked ready or reclaimed",()=>{const t=setup(),ticket=t.store.reserve("retry",t.spec);t.store.recordStock(ticket,stockReceipt());t.store.markDispatched(ticket);t.store.bind(ticket,"original");const bytes=readFileSync(t.file,"utf8");expect(()=>t.store.markUnexecuted(ticket)).toThrow();expect(()=>t.store.continueUnexecuted("retry",t.spec)).toThrow();expect(readFileSync(t.file,"utf8")).toBe(bytes);});

it("four fresh host processes consume one ready creation receipt at most once",async()=>{
 const t=setup(),ticket=t.store.reserve("retry-contended",t.spec);t.store.recordStock(ticket,stockReceipt());t.store.markUnexecuted(ticket);
 const module=fileURLToPath(new URL("../src/codex-realms.ts",import.meta.url));
 const worker=`import {CodexRealmRegistry} from ${JSON.stringify(module)};for(let i=0;i<100;i++){try{const r=new CodexRealmRegistry(process.argv[1]);r.continueUnexecuted("retry-contended",JSON.parse(process.argv[2]));console.log("winner");break;}catch(e){if(e.code==="RT_CODEX_REALM_BUSY"){await new Promise(r=>setTimeout(r,10));continue;}if(e.code==="RT_CODEX_REALM_PENDING"){console.log("held");break;}throw e;}}`;
 const results=await Promise.all(Array.from({length:4},()=>promisify(execFile)(process.execPath,["--import","tsx","--input-type=module","-e",worker,t.authority,JSON.stringify(t.spec)],{timeout:15000})));
 expect(results.filter(r=>r.stdout.trim()==="winner")).toHaveLength(1);expect(results.filter(r=>r.stdout.trim()==="held")).toHaveLength(3);
 expect(Object.values(JSON.parse(readFileSync(t.file,"utf8")).realms)).toHaveLength(1);
 expect(()=>t.store.markUnexecuted(ticket)).toThrow();
});
