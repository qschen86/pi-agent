import { afterEach, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexDriver } from "../src/codex.js";
import { CodexAppServerClient } from "../src/codex-client.js";
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.mjs");
const clients: CodexAppServerClient[] = [], drivers: CodexDriver[] = [];
afterEach(() => { drivers.splice(0).forEach(d => d.shutdown()); clients.splice(0).forEach(c => c.stop()); });
function driver(delayed = false) {
 const d = new CodexDriver({ binaryPath: process.execPath, clientFactory: () => {
  const client = new CodexAppServerClient({ binaryPath: process.execPath, args: [fixture], env: { ...process.env as Record<string, string>, FAKE_SCENARIO: delayed ? "delayed-init" : "normal" } }); clients.push(client); return client;
 } }); drivers.push(d); return d;
}
it("does not launch an app-server when a queued background read resumes after shutdown", async () => {
 const d = driver(); await d.rateLimits(); d.shutdown();
 await expect(d.rateLimits()).rejects.toThrow(/shut down/i);
 expect(clients).toHaveLength(1);
});
it("stops a starting app-server rather than publishing it after shutdown", async () => {
 const d = driver(true), read = d.rateLimits(); const result = read.then(() => "resolved", error => error.message as string);
 expect(clients[0]!.alive).toBe(true); d.shutdown();
 expect(await result).toMatch(/shut down|退出/i);
 await new Promise(r => setTimeout(r, 1700)); expect(clients[0]!.alive).toBe(false);
});
