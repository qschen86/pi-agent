import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SharedSlots } from "../src/shared-slots.js";
const roots: string[] = [];
function setup() { const dir = mkdtempSync(join(tmpdir(), "native-budget-")); roots.push(dir); return { dir, slots: new SharedSlots(dir) }; }
afterEach(() => roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const req = (operationId: string) => ({ operationId, identityScopeId: "account", projectId: "project", ownerId: "host", limit: 4, projectPolicy: { concurrency: 4, totalConcurrency: 4, revision: 1, sourceRef: "human:1", existingScopes: [] } });
const receipt = (tokens = 17) => ({ version: 1 as const, runtimeKind: "codex" as const, nativeSessionId: "thread", nativeTurnId: "turn", clientMessageId: "client", sourceRef: "native:thread:turn:usage", tokens });
const terminal = { outcome: "completed" as const, sourceRef: "native:turn:terminal" };
it("preserves exact turn usage across restart and duplicate terminal observations without adding session totals", () => {
 const { dir, slots } = setup(); slots.reserve(req("one"));
 slots.recordUsage("account", "one", { ...receipt(), reportedCostUsd: 0.125 }); slots.release("account", "one", terminal);
 const fresh = new SharedSlots(dir); fresh.recordUsage("account", "one", { ...receipt(), reportedCostUsd: 0.125 });
 expect(fresh.projectUsage("project").tokens).toMatchObject({ coverage: "complete", observed: 17, pendingCalls: 0 });
 expect(fresh.projectUsage("project").reportedCostUsd).toMatchObject({ coverage: "complete", observed: 0.125, pendingCalls: 0 });
 expect(() => fresh.recordUsage("account", "one", receipt(99))).toThrow(/Conflicting/);
 expect(fresh.projectUsage("project").tokens.observed).toBe(17);
});
it("keeps unsupported currency unknown while independently reconciling tokens", () => {
 const { slots } = setup(); slots.reserve(req("one")); slots.recordUsage("account", "one", receipt()); slots.release("account", "one", terminal);
 expect(slots.projectUsage("project").tokens).toMatchObject({ coverage: "complete", observed: 17 });
 expect(slots.projectUsage("project").reportedCostUsd).toMatchObject({ coverage: "not_collected", pendingCalls: 1 });
 expect(slots.projectUsage("project").reportedCostUsd.observed).toBeUndefined();
});
it("does not make missing or still running native calls free after a partial report", () => {
 const { slots } = setup(); slots.reserve(req("one")); slots.recordUsage("account", "one", receipt()); slots.release("account", "one", terminal);
 slots.reserve(req("two")); slots.markUnknown("account", "two", "transport lost");
 expect(slots.projectUsage("project").tokens).toMatchObject({ coverage: "partial", observed: 17, pendingCalls: 1 });
 slots.release("account", "two", { outcome: "not-executed", sourceRef: "native:never-sent" });
 expect(slots.projectUsage("project").tokens).toMatchObject({ coverage: "complete", observed: 17, pendingCalls: 0 });
});
it("rejects unknown zero defaults and refunding a call which has native usage", () => {
 const { slots } = setup(); slots.reserve(req("one"));
 for (const bad of [{ ...receipt(), tokens: -1 }, { ...receipt(), tokens: 1.5 }, { ...receipt(), reportedCostUsd: NaN }, { ...receipt(), sourceRef: "" }, { ...receipt(), nativeTurnId: "" }, { ...receipt(), sessionTotal: 900 }]) expect(() => slots.recordUsage("account", "one", bad)).toThrow();
 slots.recordUsage("account", "one", { ...receipt(0), reportedCostUsd: 0 });
 expect(() => slots.release("account", "one", { outcome: "not-executed", sourceRef: "false-refund" })).toThrow(/usage/);
 slots.release("account", "one", terminal);
 expect(slots.projectUsage("project").tokens).toMatchObject({ coverage: "complete", observed: 0 });
});
it("fails closed when persisted native usage is corrupt", () => {
 const { dir, slots } = setup(); slots.reserve(req("one")); slots.recordUsage("account", "one", receipt()); slots.release("account", "one", terminal);
 const file = readdirSync(dir).find(name => /^[a-f0-9]{64}\.json$/.test(name))!;
 const path = join(dir, file), data = JSON.parse(readFileSync(path, "utf8")); data.reservations[0].usage.tokens = -2; writeFileSync(path, JSON.stringify(data));
 expect(() => new SharedSlots(dir).projectUsage("project")).toThrow(/ledger/);
});
it("keeps an empty project uncollected rather than inventing a native zero receipt", () => {
 const { slots } = setup(); expect(slots.projectUsage("project")).toMatchObject({ tokens: { coverage: "not_collected", pendingCalls: 0 }, reportedCostUsd: { coverage: "not_collected", pendingCalls: 0 } });
 expect(slots.projectUsage("project").tokens.observed).toBeUndefined();
});
