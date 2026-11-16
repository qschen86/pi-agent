import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { withHostMutex } from "../src/host-mutex.js";
const dirs: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), "host-mutex-")); dirs.push(dir); return dir; };
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, {recursive: true, force: true})));
const module = fileURLToPath(new URL("../src/host-mutex.ts", import.meta.url));
it("holds a live host critical section and recovers only after its OS-observed death, even with unfinished metadata", async () => {
 const dir = root();
 const script = `import {withHostMutex} from ${JSON.stringify(module)};withHostMutex(process.argv[1],()=>{process.stdout.write("HELD");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000)});`;
 const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dir], {stdio: ["ignore", "pipe", "pipe"]});
 let error = ""; child.stderr.on("data", b => error += b);
 const closed = new Promise<string|null>((resolve, reject) => { child.on("error", reject); child.on("close", (_, signal) => resolve(signal)); });
 try {
  await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("close", () => reject(new Error(error || "owner exited before acquisition"))); });
  let entered = false;
  expect(withHostMutex(dir, () => { entered = true; })).toEqual({status: "busy"}); expect(entered).toBe(false);
  child.kill("SIGKILL"); expect(await closed).toBe("SIGKILL"); expect(error).toBe("");
  // Also cover death while publishing the choosing record, before a valid JSON body.
  const intents = join(dir, "admission-intents"), owner = readdirSync(intents).find(name => name.endsWith(".json"))!;
  writeFileSync(join(intents, owner), "");
  expect(withHostMutex(dir, () => "recovered")).toBe("recovered"); expect(readFileSync(join(intents, owner), "utf8")).toBe("");
 } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
}, 10000);
it("keeps unknown ownership and legacy ownerless locks fenced", () => {
 const dir = root(); mkdirSync(join(dir, "admission.lock"));
 expect(withHostMutex(dir, () => "unsafe")).toEqual({status: "busy"});
 rmSync(join(dir, "admission.lock"), {recursive: true}); const intents = join(dir, "admission-intents"); mkdirSync(intents);
 writeFileSync(join(intents, "unrecognized-owner.json"), "{}");
 expect(withHostMutex(dir, () => "unsafe")).toEqual({status: "busy"});
 expect(readFileSync(join(intents, "unrecognized-owner.json"), "utf8")).toBe("{}");
});
