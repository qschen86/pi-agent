import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RuntimeStore } from "../src/store.js";
import { defaultPermissionMode, effectivePermissionMode } from "../src/permissions.js";
import type { SessionBinding } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function store() { const dir = mkdtempSync(join(tmpdir(), "pi-native-default-")); dirs.push(dir); return new RuntimeStore(dir); }
function binding(id: string, extra: Partial<SessionBinding> = {}): SessionBinding {
  return { platformSessionId: id, runtimeKind: "pi", runtimeProfileId: "p", hostId: "h", identityScopeId: "i",
    sourceMode: "platform-managed", executionMode: "runtime-native", title: id, workspace: "/tmp/chat", permissionMode: "pi-ask", permissionLabel: "操作前询问",
    createdAt: { at: "2026-10-10T00:00:00Z", source: "platform" }, lastActivityAt: { at: "2026-10-10T00:00:00Z", source: "platform" },
    bindingRevision: 1, creationOperationId: "op", status: "idle", turns: [], observation: "live", coverage: "complete", ...extra };
}
it("ordinary Pi defaults to native permissions", () => { expect(defaultPermissionMode("pi")).toBe("pi-native"); });
it("migrates legacy ordinary Pi once and preserves future explicit ask choices", () => {
  const s = store(); s.putBinding(binding("legacy"));
  expect(s.migratePiNativePermissions()).toEqual(["legacy"]);
  expect(s.binding("legacy")).toMatchObject({ permissionMode: "pi-native", permissionLabel: "原生工具权限", piPermissionPolicyVersion: 1, bindingRevision: 2 });
  s.updateBinding("legacy", b => { b.permissionMode = "pi-ask"; b.permissionLabel = "操作前询问"; });
  expect(s.migratePiNativePermissions()).toEqual([]);
  expect(s.binding("legacy")!.permissionMode).toBe("pi-ask");
});
it("preserves read-only, evaluation, group, project and active sessions", () => {
  const s = store();
  const rows = [binding("ro", { permissionMode: "pi-read-only" }), binding("eval", { evaluation: { reportDir: "/tmp/chat/report", inputRoots: ["/tmp/input"] } }),
    binding("room", { roomRef: { roomId: "r", memberId: "m" } }), binding("project", { projectRef: "p" }),
    binding("compare", { comparisonRef: { groupId: "g", laneNo: 1 } }), binding("running", { status: "running" }),
    binding("codex", { runtimeKind: "codex", permissionMode: "ask" })];
  rows.forEach(b => s.putBinding(b)); expect(s.migratePiNativePermissions()).toEqual([]);
  for (const b of rows) expect(s.binding(b.platformSessionId)).toEqual(b);
});

it("keeps dedicated legacy contexts guarded when their permission mode is absent", () => {
  expect(effectivePermissionMode({runtimeKind:"pi",evaluation:{}})).toBe("pi-ask");
  expect(effectivePermissionMode({runtimeKind:"pi",roomRef:{}})).toBe("pi-ask");
  expect(effectivePermissionMode({runtimeKind:"pi",permissionMode:"pi-read-only"})).toBe("pi-read-only");
});
it("migrates completed ordinary sessions and excludes imported history", () => {
  const s = store(); s.putBinding(binding("done", {status:"completed",permissionMode:undefined}));
  s.putBinding(binding("history", {sourceMode:"external-discovered",permissionMode:undefined}));
  expect(s.migratePiNativePermissions()).toEqual(["done"]);
});
