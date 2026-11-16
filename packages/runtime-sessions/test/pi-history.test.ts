import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readPiSession, listPiSessions } from "../src/pi-history.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-history-")); dirs.push(root);
  const workspace = join(root, "allowed"), outside = join(root, "outside"); mkdirSync(workspace); mkdirSync(outside);
  const file = join(root, "session.jsonl");
  const entries = [
    { type: "session", version: 3, id: "session-1", cwd: workspace, timestamp: "2026-10-01T00:00:00Z" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "discarded branch" }], timestamp: 1001, stopReason: "stop" } },
    { type: "message", id: "a2", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "API_KEY=synthetic-secret" }], timestamp: 1002, stopReason: "stop" } }
  ];
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { root, workspace, outside, file };
}
it("follows the active branch, redacts secrets and retains partial records after a bad line", () => {
  const t = fixture(); appendFileSync(t.file, "bad unfinished line\n");
  const read = readPiSession(t.file);
  expect(read.coverage).toBe("partial");
  expect(read.events.filter((e) => e.kind === "message").map((e) => e.text)).toEqual(["hello", "API_KEY=[已脱敏]"]);
  expect(read.status).toBe("unknown"); // An assistant message is not a durable agent_settled record.
});
it("changing the title leaves the conversation fingerprint unchanged", () => {
  const t = fixture(); const before = readPiSession(t.file).fingerprint;
  appendFileSync(t.file, JSON.stringify({ type: "session_info", id: "name", parentId: "a2", name: "新标题", timestamp: "2026-10-01T01:00:00Z" }) + "\n");
  const after = readPiSession(t.file);
  expect(after.title).toBe("新标题"); expect(after.fingerprint).toBe(before);
});
it("lists only sessions whose real workspace is in authorized roots", () => {
  const t = fixture();
  writeFileSync(join(t.root, "other.jsonl"), JSON.stringify({ type: "session", id: "outside", cwd: t.outside }) + "\n");
  expect(listPiSessions([t.root], [t.workspace], 20).items.map((s) => s.nativeSessionId)).toEqual(["session-1"]);
  expect(listPiSessions([t.root], [], 20).items).toEqual([]);
});
