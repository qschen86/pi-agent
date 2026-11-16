import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { evaluationHistoryStore } from "../src/claude-evaluation-history.js";
it("the real SDK reads an evaluator's private native transcript and ignores unfinished tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-history-")), id = randomUUID();
  try {
    const projects = join(root, id, "config", "projects"), dir = join(projects, "job"); mkdirSync(dir, { recursive: true });
    const entries = [
      { type: "user", uuid: "u1", parentUuid: null, sessionId: id, cwd: "/job", timestamp: "2026-10-02T00:00:00Z", message: { role: "user", content: "evaluate" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: id, timestamp: "2026-10-02T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "evaluation complete" }] } }
    ];
    writeFileSync(join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + '\n{"unfinished":');
    const store = evaluationHistoryStore(root, id)!;
    const msgs = await getSessionMessages(id, { sessionStore: store });
    expect(msgs.map((m) => m.uuid)).toEqual(["u1", "a1"]);
    expect(msgs[1].message).toMatchObject({ content: [{ type: "text", text: "evaluation complete" }] });
    await expect(store.append({ projectKey: "job", sessionId: id }, [])).rejects.toThrow(/cannot write/);
    expect(await store.load({ projectKey: "job", sessionId: randomUUID() })).toBeNull();
    rmSync(dir, { recursive: true });
    const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    symlinkSync(outside, dir);
    expect(await store.load({ projectKey: "job", sessionId: id })).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
