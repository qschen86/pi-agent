import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TurnSink } from "../src/driver.js";
import { PiDriver } from "../src/pi.js";

/** Opt-in like the sandbox parity test: real Pi binary (PI_BIN to try a candidate build) and a scripted local model. */
describe.skipIf(process.env.PI_SANDBOX_PARITY !== "1" || process.platform !== "darwin")("real Pi steer", () => {
it("delivers a steer mid-turn, keys it to the platform message, and refuses steers after settling", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "steer-real-")));
  const source = join(root, "source"); mkdirSync(source); const ws = join(root, "ws"); mkdirSync(ws); writeFileSync(join(ws, "a.txt"), "hello");
  let n = 0; const userTexts: string[][] = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const c of req) text += c; const body = JSON.parse(text); n++;
    userTexts.push(body.messages.filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text).join("")));
    await new Promise(r => setTimeout(r, 1200));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = n === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } }] } : { role: "assistant", content: `answer ${n}` };
    res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: n === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  writeFileSync(join(source, "models.json"), JSON.stringify({ providers: { fx: { baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, api: "openai-completions", apiKey: "fake-key", models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }] } } }));
  writeFileSync(join(source, "settings.json"), "{}");
  const driver = new PiDriver({ binaryPath: process.env.PI_BIN ?? "/opt/homebrew/bin/pi", sourceAgentDir: source, sessionDir: join(root, "sessions"), readyTimeoutMs: 20000 });
  const delivered: string[] = [], events: any[] = []; let native = "";
  const sink = { nativeSession: (id: string) => { native = id; }, nativeTurn: () => {}, usage: () => {}, rateLimit: () => {}, event: (e: any) => events.push(e), status: () => {},
    steerDelivered: (id: string) => delivered.push(id), approval: async () => ({ approve: false, reason: "no" }) } as unknown as TurnSink;
  const cm = randomUUID();
  try {
    const h = await driver.startTurn({ workspace: ws, model: "fx/m", permissionMode: "pi-read-only", prompt: "first", clientMessageId: cm, presetSessionId: randomUUID() }, sink);
    await new Promise(r => setTimeout(r, 300));
    await h.steer!({ clientMessageId: "steer-one", prompt: "steered one" });
    const done = await h.done;
    let late = "accepted"; try { await h.steer!({ clientMessageId: "steer-late", prompt: "late" }); } catch (e) { late = (e as Error).message; }
    const hist = await driver.readHistory(native, { workspace: ws });
    expect(done.status).toBe("completed"); expect(delivered).toEqual(["steer-one"]); expect(late).toContain("本轮已在结束");
    // 模型第二次请求就带上了插话；流式与历史读回都用平台的 key
    expect(userTexts).toEqual([["first"], ["first", "steered one"]]);
    expect(events.filter(e => e.role === "user" && !e.partial).map(e => e.key)).toEqual([`user:${cm}`, "user:steer-one"]);
    expect(hist.events.filter(e => e.role === "user").map(e => e.key)).toEqual([`user:${cm}`, "user:steer-one"]);
  } finally { driver.shutdown(); server.close(); rmSync(root, { recursive: true, force: true }); }
}, 60000);
});
