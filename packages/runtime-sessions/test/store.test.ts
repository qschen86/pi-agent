import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { mergeEvent, RuntimeStore } from "../src/store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
it("loads legacy history without losing settings and keeps Pi history unauthorized", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-legacy-")); dirs.push(dir);
  const store = new RuntimeStore(dir);
  writeFileSync(join(store.dir, "settings.json"), JSON.stringify({
    workspaceRoots: ["/tmp"], publicControl: true,
    history: { codex: { enabled: true, roots: ["/tmp"], originators: ["Codex Desktop"] }, "claude-code": { enabled: false, roots: [] } }
  }));
  expect(store.settings()).toMatchObject({
    workspaceRoots: ["/tmp"], publicControl: true,
    history: { pi: { enabled: false, roots: [] }, codex: { enabled: true, roots: ["/tmp"], originators: ["Codex Desktop"] } }
  });
});
it("completes partial legacy history entries instead of dropping default roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-partial-")); dirs.push(dir);
  const store = new RuntimeStore(dir);
  writeFileSync(join(store.dir, "settings.json"), JSON.stringify({ history: { codex: { enabled: true } } }));
  expect(store.settings().history.codex).toEqual({ enabled: true, roots: [] });
});

/** 平台回显 + 原生投影回读共用 key：source=platform 不能被覆盖（公共记忆即时通道按它取本轮用户原话）。 */
const userEvent = (source: "platform" | "stream" | "history", text = "记住，不要直接给我apk包，直接发布") =>
  ({ key: "user:msg-1", kind: "message" as const, role: "user" as const, text, source, parserVersion: "v", availability: "recorded" as const, recordedAt: new Date().toISOString(), occurredAt: new Date().toISOString(), turnNo: 1 });
it("keeps source=platform when the native projection re-reads the same user message", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-platform-source-")); dirs.push(dir);
  const store = new RuntimeStore(dir);
  store.upsertEvent("s1", userEvent("platform"));
  store.upsertEvent("s1", userEvent("stream"));
  expect(store.events("s1").filter(e => e.key === "user:msg-1")).toMatchObject([{ source: "platform", text: "记住，不要直接给我apk包，直接发布", turnNo: 1 }]);
});
it("keeps source=platform after reload no matter which of the duplicate records landed last", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-platform-reload-")); dirs.push(dir);
  const store = new RuntimeStore(dir);
  store.upsertEvent("s1", userEvent("platform")); store.upsertEvent("s1", userEvent("stream"));   // 平台先落盘、回读后落盘（线上顺序）
  expect(new RuntimeStore(dir).events("s1").find(e => e.key === "user:msg-1")?.source).toBe("platform");
  writeFileSync(join(store.dir, "events", "s2.jsonl"), [userEvent("stream"), userEvent("platform")].map(e => JSON.stringify({ ...e, seq: 1 })).join("\n") + "\n");
  expect(new RuntimeStore(dir).events("s2").find(e => e.key === "user:msg-1")?.source).toBe("platform");
});
it("mergeEvent still takes text and attachments from the native re-read while keeping the platform source", () => {
  const old = { ...userEvent("platform"), seq: 3, attachments: [{ attachmentId: "a1" }] as never };
  const merged = mergeEvent(old, { ...userEvent("history"), text: "记住，不要直接给我apk包，直接发布\n[image]" });
  expect(merged).toMatchObject({ source: "platform", seq: 3, text: "记住，不要直接给我apk包，直接发布" });
  expect(merged.attachments).toEqual(old.attachments);
});
