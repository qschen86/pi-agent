import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as boundaryModule from "../../pi-runtime/src/pi-boundary.js";
import { PiCommandExecutor } from "../src/pi-command-executor.js";
import { PiDriver } from "../src/pi.js";
import { PiRpcClient, type PiClientOptions } from "../src/pi-client.js";
import type { StartTurnArgs, TurnSink } from "../src/driver.js";
import { tick } from "./fake-driver.js";

class NativeEndpoint extends PiRpcClient {
  calls: Array<{ type: string; params: Record<string, unknown> }> = [];
  replies: unknown[] = [];
  model = { provider: "test-provider", id: "model-one", name: "Test Model", reasoning: true };
  level = "low";
  messages: Record<string, unknown>[] = [];
  lazy = false;
  sessionId: string;
  sessionFile: string;
  constructor(readonly cfg: PiClientOptions, public failPrompt?: "reject" | "timeout") {
    super(cfg);
    this.sessionId = cfg.args.includes("--session-id") ? cfg.args[cfg.args.indexOf("--session-id") + 1] : randomUUID();
    this.sessionFile = cfg.args.includes("--session") ? cfg.args[cfg.args.indexOf("--session") + 1] : join(cfg.env.TMPDIR, "session.jsonl");
    if (!cfg.args.includes("--session")) writeFileSync(this.sessionFile, JSON.stringify({ type: "session", version: 3, id: this.sessionId, cwd: cfg.cwd, timestamp: new Date().toISOString() }) + "\n");
    else { const header = JSON.parse(requireHeader(this.sessionFile)); this.sessionId = header.id; }
  }
  override emit(name: string | symbol, ...args: unknown[]): boolean {
    const event = args[0] as { type?: string; message?: Record<string, unknown> } | undefined;
    if (name === "event" && event?.type === "message_end" && event.message) {
      this.messages.push(event.message);
      appendFileSync(this.sessionFile, JSON.stringify({ type: "message", id: `a${this.messages.length}`, parentId: this.messages.length > 1 ? `a${this.messages.length - 1}` : "u1", timestamp: new Date().toISOString(), message: event.message }) + "\n");
    }
    return super.emit(name, ...args);
  }
  inventoryOverride?: (payload: any) => any;
  /** 模拟审批扩展一直没有确认就绪 */
  silentGate = false;
  override async start() {
    if (!this.silentGate) this.emit("event", { type: "extension_ui_request", method: "notify", message: `pi-chat-gate:${this.cfg.env.PI_CHAT_GATE_TOKEN}` });
    if (this.cfg.env.PI_CHAT_PERMISSION_MODE === "pi-evaluation") {
      const tools=this.cfg.args[this.cfg.args.indexOf("--tools")+1].split(",");
      const payload={version:1,token:this.cfg.env.PI_CHAT_GATE_TOKEN,activeTools:tools,registeredTools:tools.map(name=>({name,source:"builtin"}))};
      this.emit("event", {type:"extension_ui_request",method:"notify",message:`pi-chat-evaluation-tools:${JSON.stringify(this.inventoryOverride?.(payload)??payload)}`});
    }
  }
  override async request(type: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ type, params });
    if (type === "get_state") return { sessionId: this.sessionId, sessionFile: this.sessionFile, model: this.model, thinkingLevel: this.level, isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 };
    if (type === "get_available_models") return { models: [this.model, { ...this.model, id: "model-two", name: "Second Model" }] };
    if (type === "get_available_thinking_levels") return { levels: this.model.id === "model-two" ? ["off"] : ["off", "low", "high"] };
    if (type === "set_model") { this.model = { ...this.model, id: String(params.modelId) }; return this.model; }
    if (type === "set_thinking_level") { this.level = String(params.level); return; }
    if (type === "get_messages") {
      const data = { messages: this.messages };
      if (Buffer.byteLength(JSON.stringify(data)) > 2 * 1024 * 1024) {
        const reason = "Pi RPC protocol error: JSONL frame exceeds 2097152-byte limit";
        this.emit("exit", { reason });
        throw new Error(reason);
      }
      return data;
    }
    if (type === "prompt") {
      if (this.failPrompt === "reject") throw new Error("Pi RPC request failed: model unavailable");
      appendFileSync(this.sessionFile, JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: params.message }, ...(Array.isArray(params.images) ? params.images : [])], timestamp: 1000 } }) + "\n");
      if (this.failPrompt === "timeout") throw new Error("Pi RPC timeout: prompt");
    }
    if (type === "abort") this.emit("event", { type: "agent_settled" });
  }
  override respondUi(id: string, response: { confirmed?: boolean; cancelled?: boolean }) { this.replies.push({ id, ...response }); }
  override stop() { this.emit("exit", { reason: "Pi RPC exit: stopped" }); }
}
import { readFileSync } from "node:fs";
function requireHeader(path: string) { return readFileSync(path, "utf8").split("\n")[0]; }
it("classifies readiness timeout as undispatched after stopping the Pi process", async () => {
  const t=setup();
  vi.spyOn(NativeEndpoint.prototype,"start").mockResolvedValue(undefined);
  const stopped=vi.spyOn(NativeEndpoint.prototype,"stop");
  await expect(t.driver.startTurn(t.args,t.sink)).rejects.toMatchObject({stage:"create",notExecuted:true});
  expect(stopped).toHaveBeenCalled();
  expect(t.endpoints.some(c=>c.calls.some(call=>call.type==="prompt"))).toBe(false);
});
const dirs: string[] = [], drivers: PiDriver[] = [];
afterEach(() => { vi.restoreAllMocks(); drivers.splice(0).forEach((d) => d.shutdown()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
function setup(failPrompt?: "reject" | "timeout", lazy = false, inventoryOverride?: (payload:any)=>any) {
  const dir = mkdtempSync(join(tmpdir(), "pi-driver-")); dirs.push(dir);
  const source = join(dir, "source"), workspace = join(dir, "workspace"), pkg = join(dir, "native");
  for (const p of [source, workspace, join(pkg, "dist", "bundle"), join(pkg, "dist", "core")]) mkdirSync(p, { recursive: true });
  writeFileSync(join(source, "auth.json"), JSON.stringify({ "test-provider": { type: "api_key", key: "synthetic-private-credential" } }));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.86.1" }));
  writeFileSync(join(pkg, "dist", "core", "agent-session.js"), 'this._emit({ type: "agent_settled" });');
  const binaryPath = join(pkg, "dist", "bundle", "cli.js"); writeFileSync(binaryPath, "// controlled native endpoint");
  const endpoints: NativeEndpoint[] = [];
  const driver = new PiDriver({ binaryPath, sourceAgentDir: source, sessionDir: join(dir, "sessions"), readyTimeoutMs: 1000, clientFactory: (cfg) => { const e = new NativeEndpoint(cfg, failPrompt); e.inventoryOverride=inventoryOverride; if (lazy && !cfg.args.includes("--session")) rmSync(e.sessionFile); endpoints.push(e); return e; } });
  drivers.push(driver);
  const native: string[] = [], events: unknown[] = [];
  const sink: TurnSink = { nativeSession: (id) => native.push(id), nativeTurn: () => {}, event: (e) => events.push(e), usage: () => {}, rateLimit: () => {}, status: () => {}, approval: async () => ({ approve: false, reason: "denied" }) };
  const args: StartTurnArgs = { workspace, model: "test-provider/model-one", effort: "low", permissionMode: "pi-native", prompt: "hello", clientMessageId: randomUUID(), presetSessionId: randomUUID() };
  return { dir, driver, endpoints, sink, args, native, events, clearFailure: () => { failPrompt = undefined; } };
}
it("probes model-specific efforts without sending a prompt and restores the default model", async () => {
  const t = setup(); const p = await t.driver.probe();
  expect(p.state).toBe("executable");
  expect(p.models).toMatchObject([{ id: "test-provider/model-one", efforts: ["off", "low", "high"] }, { id: "test-provider/model-two", efforts: ["off"] }]);
  expect(t.endpoints.flatMap((c) => c.calls).filter((c) => c.type === "prompt")).toHaveLength(0);
  expect(t.endpoints[0].calls.filter((c) => c.type === "set_model").at(-1)?.params).toEqual({ provider: "test-provider", modelId: "model-one" });
  expect(JSON.stringify(p)).not.toContain("synthetic-private-credential");
  expect(p.capabilities.roleInstructions.status).toBe("unsupported");
});
it("keeps the turn active through agent_end/retry until agent_settled", async () => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  let done = false; void h.done.then(() => { done = true; });
  c.emit("event", { type: "agent_end" }); c.emit("event", { type: "auto_retry_start" }); await tick();
  expect(done).toBe(false);
  c.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "你好" }], timestamp: 1001, stopReason: "stop" } });
  c.emit("event", { type: "agent_settled" });
  expect(await h.done).toMatchObject({status:"completed",terminalObserved:true});
  expect(await t.driver.fingerprint(t.native[0]!,{workspace:t.args.workspace})).toMatchObject({lastClientMessageId:t.args.clientMessageId,lastTurnStatus:"completed",terminalObserved:true,active:false});
  expect(t.events).toContainEqual(expect.objectContaining({ text: "你好", role: "assistant" }));
  expect(t.native[0]).toBe(t.args.presetSessionId);
  expect(await t.driver.findClientMessage(t.native[0], t.args.clientMessageId, { workspace: t.args.workspace })).toBe(true);
  const read = await t.driver.readHistory(t.native[0], { workspace: t.args.workspace });
  expect(read.events.find((e) => e.role === "user")?.key).toBe(`user:${t.args.clientMessageId}`);
  expect(read).not.toHaveProperty("userMessages");
  const next = await t.driver.startTurn({ ...t.args, nativeSessionId: t.native[0], presetSessionId: undefined, clientMessageId: randomUUID() }, t.sink);
  expect(t.native.at(-1)).toBe(t.native[0]);
  expect(t.endpoints.at(-1)!.cfg.args).toContain("--session");
  expect(t.endpoints.at(-1)!.cfg.args).not.toContain("--session-id");
  // 平台停止后等到进程组退出：结果如实为中断，并带上进程已结束的依据（名额据此释放）
  await next.interrupt(); expect(await next.done).toMatchObject({ status: "interrupted", processEnded: expect.stringContaining("进程组已退出") });
});
it.each(["reject", "timeout"] as const)("prompt %s preserves native identity and never resends", async (failure) => {
  const t = setup(failure);
  await expect(t.driver.startTurn(t.args, t.sink)).rejects.toMatchObject(failure === "reject" ? { stage: "dispatch", nativeSessionId: t.args.presetSessionId } : { message: expect.stringContaining("timeout") });
  expect(t.endpoints.flatMap((c) => c.calls).filter((c) => c.type === "prompt")).toHaveLength(1);
  expect(t.native[0]).toBe(t.args.presetSessionId);
});
it("prompt timeout stops the Pi process group and reports the verified exit without claiming the prompt was not executed", async () => {
  const t = setup("timeout");
  await expect(t.driver.startTurn(t.args, t.sink)).rejects.toMatchObject({ stage: "dispatch", notExecuted: false, processEnded: expect.stringContaining("进程组已退出"), message: expect.stringContaining("timeout") });
});
it("prompt rejection keeps the ambiguous stage error without process-exit evidence", async () => {
  const t = setup("reject");
  await expect(t.driver.startTurn(t.args, t.sink)).rejects.toMatchObject({ stage: "dispatch", notExecuted: false, processEnded: undefined });
});
it("unexpected process exit leaves the accepted turn unknown", async () => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink);
  t.endpoints.at(-1)!.emit("exit", { reason: "Pi RPC exit: crash" });
  expect((await h.done).status).toBe("unknown");
});
it("settles a history larger than the RPC frame limit without requesting all messages", async () => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  for (let i = 0; i < 3; i++) c.emit("event", { type: "message_end", message: {
    role: "toolResult", toolCallId: `large-${i}`, toolName: "bash",
    content: [{ type: "text", text: "x".repeat(768 * 1024) }], timestamp: 1001 + i
  } });
  c.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1005, stopReason: "stop" } });
  // Keep the large messages on the active durable branch, as in a real session.
  const rows = readFileSync(c.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (let i = 2; i < rows.length; i++) rows[i].parentId = rows[i - 1].id;
  writeFileSync(c.sessionFile, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  expect(Buffer.byteLength(readFileSync(c.sessionFile))).toBeGreaterThan(2 * 1024 * 1024);
  expect(Buffer.byteLength(JSON.stringify(c.messages))).toBeGreaterThan(2 * 1024 * 1024);
  c.emit("event", { type: "agent_settled" });
  expect(await h.done).toMatchObject({ status: "completed", terminalObserved: true });
  expect(c.calls.some(call => call.type === "get_messages")).toBe(false);
  const history = await t.driver.readHistory(t.native[0], { workspace: t.args.workspace });
  expect(history.coverage).toBe("complete");
  expect(history.events.filter(event => event.kind === "tool")).toHaveLength(3);
});
it.each([["error", "failed"], ["length", "completed"]])("preserves terminal stop reason %s", async (stopReason, status) => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  c.emit("event", { type: "message_end", message: { role: "assistant", content: [], timestamp: 1001, stopReason, ...(stopReason === "error" ? { errorMessage: "model invocation failed" } : {}) } });
  c.emit("event", { type: "agent_settled" });
  expect(await h.done).toMatchObject({ status, terminalObserved: true });
});
it("does not use an earlier assistant as terminal evidence when a tool result follows it", async () => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  c.emit("event", { type: "message_end", message: { role: "assistant", content: [], timestamp: 1001, stopReason: "stop" } });
  c.emit("event", { type: "message_end", message: { role: "toolResult", content: [], timestamp: 1002, toolCallId: "last-tool", toolName: "bash" } });
  c.emit("event", { type: "agent_settled" });
  expect(await h.done).toMatchObject({ status: "unknown", terminalObserved: false });
});
it.each(["missing", "different"])("requires the streamed terminal message in durable history: %s", async (change) => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  c.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1001, stopReason: "stop" } });
  const rows = readFileSync(c.sessionFile, "utf8").trim().split("\n");
  if (change === "missing") rows.pop();
  else { const last = JSON.parse(rows.at(-1)!); last.message.content[0].text = "different"; rows[rows.length - 1] = JSON.stringify(last); }
  writeFileSync(c.sessionFile, rows.join("\n") + "\n");
  c.emit("event", { type: "agent_settled" });
  expect(await h.done).toMatchObject({ status: "unknown", terminalObserved: false });
});
it("does not settle from a durable assistant without a current-turn message_end event", async () => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  const message = { role: "assistant", content: [], timestamp: 1001, stopReason: "stop" };
  c.messages.push(message);
  appendFileSync(c.sessionFile, JSON.stringify({ type: "message", id: "unobserved", parentId: "u1", message }) + "\n");
  c.emit("event", { type: "agent_settled" });
  expect(await h.done).toMatchObject({ status: "unknown", terminalObserved: false });
});
it.each(["isStreaming", "isCompacting", "pendingMessageCount"])("waits for an idle native state: %s", async (field) => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  c.emit("event", { type: "message_end", message: { role: "assistant", content: [], timestamp: 1001, stopReason: "stop" } });
  const request = c.request.bind(c);
  const spy = vi.spyOn(c, "request").mockImplementation(async (type, params) => {
    const result = await request(type, params);
    return type === "get_state" ? { ...result as object, [field]: field === "pendingMessageCount" ? 1 : true } : result;
  });
  let finished = false; void h.done.then(() => { finished = true; });
  c.emit("event", { type: "agent_settled" }); await tick();
  expect(finished).toBe(false);
  spy.mockRestore(); c.emit("event", { type: "agent_settled" });
  expect(await h.done).toMatchObject({ status: "completed", terminalObserved: true });
});
it("preserves bounded, redacted protocol exit details", async () => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink);
  t.endpoints.at(-1)!.emit("exit", { reason: "Pi RPC protocol error: JSONL frame exceeds 2097152-byte limit; API_KEY=synthetic-private" });
  const result = await h.done;
  expect(result.status).toBe("unknown");
  expect(result.reason).toContain("JSONL frame exceeds 2097152-byte limit");
  expect(result.reason).not.toContain("synthetic-private");
});
it("does not declare versions without the settled lifecycle executable", async () => {
  const t = setup(); rmSync(join(t.dir, "native", "dist", "core", "agent-session.js"));
  expect((await t.driver.probe()).state).toBe("incompatible");
});
it("projects reasoning, tool results and native usage with stable request identity", async () => {
  const t = setup(); const usage: unknown[] = []; t.sink.usage = (u) => usage.push(u);
  const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  c.emit("event", { type: "message_end", message: { role: "assistant", timestamp: 1002, provider: "test-provider", model: "model-one", content: [{ type: "thinking", thinking: "推理中" }, { type: "toolCall", id: "call-one", name: "read", arguments: { path: "README.md" } }], usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 0, totalTokens: 9 } } });
  c.emit("event", { type: "tool_execution_end", toolCallId: "call-one", toolName: "read", result: { content: [{ type: "text", text: "API_KEY=synthetic-private" }] }, isError: false });
  c.emit("event", { type: "agent_settled" }); await h.done;
  expect(t.events).toContainEqual(expect.objectContaining({ kind: "reasoning", text: "推理中" }));
  expect(t.events).toContainEqual(expect.objectContaining({ kind: "tool", key: "pi:tool:call-one", tool: expect.objectContaining({ output: "API_KEY=[已脱敏]", status: "completed" }) }));
  expect(usage).toContainEqual(expect.objectContaining({ input: 2, output: 3, cachedInput: 4, total: 9, counterMode: "delta", requestId: expect.stringContaining(t.args.presetSessionId!) }));
});
it("abort invalidates pending UI approval even if an old decision arrives afterwards", async () => {
  const t = setup(); let decide!: (value: { approve: boolean; reason: string }) => void;
  t.sink.approval = async (_req, signal) => new Promise((resolve) => { decide = resolve; signal?.addEventListener("abort", () => resolve({ approve: true, reason: "late decision" })); });
  const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  c.emit("event", { type: "extension_ui_request", id: "a1", method: "confirm", title: "Pi · write", message: JSON.stringify({ toolName: "write", toolCallId: "t1", input: { path: "x", content: "hi" } }) });
  await tick(); await h.interrupt(); decide?.({ approve: true, reason: "stale" }); await tick();
  expect(c.replies).not.toContainEqual(expect.objectContaining({ confirmed: true }));
  expect((await h.done).status).toBe("interrupted");
});

it("Pi 扩展的 select / input / confirm 对话框变成选项面板，答案按 Pi 的格式回传；跳过 = cancelled", async () => {
  const t = setup(); const asked: unknown[] = [];
  const answers: Array<string[] | undefined> = [["蓝色"], ["张三"], ["确认"], undefined];
  t.sink.approval = async (req) => { asked.push(req); const a = answers.shift(); return a ? { approve: true, reason: "", answers: { answer: a } } : { approve: false, reason: "skip" }; };
  const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  c.emit("event", { type: "extension_ui_request", id: "s1", method: "select", title: "选颜色", options: ["红色", "蓝色"] });
  c.emit("event", { type: "extension_ui_request", id: "i1", method: "input", title: "你的名字", placeholder: "姓名" });
  c.emit("event", { type: "extension_ui_request", id: "c1", method: "confirm", title: "继续吗", message: "会覆盖文件" });
  c.emit("event", { type: "extension_ui_request", id: "s2", method: "select", title: "再选一次", options: ["a", "b"] });
  await tick();
  expect(asked[0]).toMatchObject({ kind: "question", questions: [{ id: "answer", question: "选颜色", options: [{ label: "红色" }, { label: "蓝色" }] }] });
  expect(asked[1]).toMatchObject({ kind: "question", questions: [{ question: "你的名字", options: [], allowOther: true, placeholder: "姓名" }] });
  expect(c.replies).toContainEqual(expect.objectContaining({ id: "s1", value: "蓝色" }));
  expect(c.replies).toContainEqual(expect.objectContaining({ id: "i1", value: "张三" }));
  expect(c.replies).toContainEqual(expect.objectContaining({ id: "c1", confirmed: true }));
  expect(c.replies).toContainEqual(expect.objectContaining({ id: "s2", cancelled: true }));
  c.emit("event", { type: "agent_settled" }); await h.done;
});

it("retains a verified empty checkpoint when first prompt is rejected before native persistence", async () => {
  const t = setup("reject", true);
  await expect(t.driver.startTurn(t.args, t.sink)).rejects.toMatchObject({ stage: "dispatch" });
  expect(await t.driver.findClientMessage(t.native[0], t.args.clientMessageId, { workspace: t.args.workspace })).toBe(false);
  t.clearFailure();
  const h = await t.driver.startTurn({ ...t.args, nativeSessionId: t.native[0], clientMessageId: randomUUID() }, t.sink);
  expect(t.endpoints).toHaveLength(2);
  await h.interrupt(); expect((await h.done).status).toBe("interrupted");
});
it.each([undefined, "aborted", "unexpected"])("requires terminal assistant evidence: %s", async (reason) => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  if (reason) c.emit("event", { type: "message_end", message: { role: "assistant", content: [], timestamp: 2000, stopReason: reason } });
  c.emit("event", { type: "agent_settled" });
  expect((await h.done).status).toBe(reason === "aborted" ? "interrupted" : "unknown");
});
// Pi ≥1.1 settles with `aborted`; it is authoritative over the last stop reason.
it.each([
  ["abort during retry leaves an error message", true, "error", "interrupted"],
  ["abort before any assistant message", true, undefined, "interrupted"],
  ["normal completion", false, "stop", "completed"],
  ["provider failure", false, "error", "failed"],
  ["contradictory aborted message", false, "aborted", "unknown"]
] as const)("uses Pi's settled aborted flag: %s", async (_name, aborted, reason, status) => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  if (reason) c.emit("event", { type: "message_end", message: { role: "assistant", content: [], timestamp: 2000, stopReason: reason } });
  c.emit("event", { type: "agent_settled", aborted });
  const result = await h.done;
  expect(result.status).toBe(status);
  if (status === "unknown") expect(result).toMatchObject({ terminalObserved: false, reason: expect.stringContaining("not aborted") });
});
it("releases terminal promise even when boundary cleanup fails", async () => {
  const prepare = boundaryModule.preparePiChatBoundary;
  vi.spyOn(boundaryModule, "preparePiChatBoundary").mockImplementation(async (options) => {
    const boundary = await prepare(options);
    return { ...boundary, dispose: async () => { await boundary.dispose(); throw new Error("cleanup denied"); } };
  });
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  c.emit("event", { type: "message_end", message: { role: "assistant", content: [], timestamp: 2000, stopReason: "stop" } });
  c.emit("event", { type: "agent_settled" });
  const result = await Promise.race([h.done, tick(200).then(() => ({ status: "hung" }))]);
  expect(result.status).not.toBe("hung");
  expect(result).toHaveProperty("reason", expect.stringContaining("cleanup"));
  expect(result).toMatchObject({status:"unknown",terminalObserved:false});
  const restarted=new PiDriver({sessionDir:join(t.dir,"sessions"),sourceAgentDir:join(t.dir,"source")});drivers.push(restarted);
  expect(await restarted.fingerprint(t.native[0]!,{workspace:t.args.workspace})).toMatchObject({lastTurnStatus:"unknown",terminalObserved:false});
});

it("does not claim completion from RPC evidence absent from the durable transcript", async () => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  c.messages = [{ role: "assistant", content: [], timestamp: 3000, stopReason: "stop" }];
  c.emit("event", { type: "agent_settled" });
  expect((await h.done).status).toBe("unknown");
});

it("registers the read-only web tools for chat turns and drops them when a turn opts out", async () => {
  const t = setup();
  const h = await t.driver.startTurn(t.args, t.sink);
  const flags = t.endpoints.at(-1)!.cfg.args;
  const tools = flags[flags.indexOf("--tools") + 1].split(",");
  expect(tools).toEqual(["read", "grep", "find", "ls", "write", "edit", "bash", "web_search", "web_open"]);
  const entries = flags.flatMap((arg, index) => (arg === "--extension" ? [flags[index + 1]] : []));
  expect(entries.some((entry) => /web-research\.ts$/.test(entry))).toBe(true);
  await h.interrupt(); await h.done;
});
it("a turn can opt out of web research (no extension, no tools, no socket)", async () => {
  const t = setup();
  const h = await t.driver.startTurn({ ...t.args, webResearch: false }, t.sink);
  const flags = t.endpoints.at(-1)!.cfg.args;
  expect(flags[flags.indexOf("--tools") + 1].split(",")).toEqual(["read", "grep", "find", "ls", "write", "edit", "bash"]);
  expect(t.endpoints.at(-1)!.cfg.env["PI_WEB_RESEARCH_SOCKET"]).toBeUndefined();
  await h.interrupt(); await h.done;
});
it("injects role instructions through the native system channel on create and resume", async () => {
  const t = setup();
  mkdirSync(join(t.dir, "native", "dist", "cli"), { recursive: true });
  writeFileSync(join(t.dir, "native", "dist", "cli", "args.js"), 'arg === "--append-system-prompt"');
  const h = await t.driver.startTurn({ ...t.args, roleInstructions: "ROLE-MARKER" }, t.sink);
  const flags = t.endpoints.at(-1)!.cfg.args;
  expect(flags).toContain("--append-system-prompt");
  expect(flags[flags.indexOf("--append-system-prompt") + 1]).toMatch(/role-instructions\.md$/);
  expect(t.endpoints.at(-1)!.calls.find((c) => c.type === "prompt")?.params.message).toBe("hello");
  await h.interrupt(); await h.done;
  const next = await t.driver.startTurn({ ...t.args, nativeSessionId: t.native[0], clientMessageId: randomUUID(), roleInstructions: "ROLE-MARKER" }, t.sink);
  expect(t.endpoints.at(-1)!.cfg.args).toContain("--append-system-prompt");
  await next.interrupt(); await next.done;
});
it("rejects role injection when installed CLI has no verified append channel", async () => {
  const t = setup();
  await expect(t.driver.startTurn({ ...t.args, roleInstructions: "ROLE" }, t.sink)).rejects.toMatchObject({ stage: "create" });
});

const inventoryCases: Array<[string,(payload:any)=>any]>=[
 ["extra active tool",p=>({...p,activeTools:[...p.activeTools,"surprise-plugin"]})],
 ["missing active tool",p=>({...p,activeTools:p.activeTools.slice(1)})],
 ["extension overriding a builtin",p=>({...p,registeredTools:p.registeredTools.map((t:any)=>t.name==="write"?{...t,source:"extension"}:t)})],
 ["wrong nonce",p=>({...p,token:"different-startup-nonce"})]
];
for(const [name,change] of inventoryCases)it(`refuses protected Pi dispatch with ${name} before sending any user input`,async()=>{
 const t=setup(undefined,false,change),inputs=join(t.args.workspace,"inputs"),reportDir=join(t.args.workspace,"out");mkdirSync(inputs);mkdirSync(reportDir);
 await expect(t.driver.startTurn({...t.args,permissionMode:"pi-ask",evaluation:{inputRoots:[inputs],reportDir}},t.sink)).rejects.toMatchObject({stage:"create",notExecuted:true});
 expect(t.endpoints.flatMap(e=>e.calls).filter(c=>c.type==="prompt")).toHaveLength(0);expect(t.native).toHaveLength(0);
});
it("returns the exact nonce-checked native builtin inventory to the host before a protected prompt",async()=>{
 const t=setup(),inputs=join(t.args.workspace,"inputs"),reportDir=join(t.args.workspace,"out"),observations:any[]=[];mkdirSync(inputs);mkdirSync(reportDir);
 const h=await t.driver.startTurn({...t.args,permissionMode:"pi-ask",evaluation:{inputRoots:[inputs],reportDir}},{...t.sink,evaluationInventory:inventory=>observations.push(inventory)});
 expect(observations).toHaveLength(1);expect(observations[0]).toMatchObject({version:1,nativeSessionId:t.native[0],clientMessageId:t.args.clientMessageId,activeTools:["read","grep","find","ls","write","edit","bash"]});expect(JSON.stringify(observations)).not.toContain("token");
 const c=t.endpoints.at(-1)!;c.emit("event",{type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}],timestamp:1001,stopReason:"stop"}});c.emit("event",{type:"agent_settled"});expect(await h.done).toMatchObject({status:"completed",terminalObserved:true});
});

it("approval extension never ready: the turn is definitely not executed (no prompt; manager can release capacity and retry)", async () => {
  const t = setup();
  const driver = new PiDriver({ binaryPath: join(t.dir, "native", "dist", "bundle", "cli.js"), sourceAgentDir: join(t.dir, "source"), sessionDir: join(t.dir, "sessions"), readyTimeoutMs: 50,
    clientFactory: (cfg) => { const e = new NativeEndpoint(cfg); e.silentGate = true; t.endpoints.push(e); return e; } });
  drivers.push(driver);
  await expect(driver.startTurn(t.args, t.sink)).rejects.toMatchObject({ stage: "create", notExecuted: true, message: expect.stringContaining("did not confirm readiness") });
  expect(t.endpoints.flatMap((c) => c.calls).filter((c) => c.type === "prompt")).toHaveLength(0);
});
it("V3.4 sends RPC images and reconciles the complete native image input", async () => {
  const t=setup(),data=Buffer.from("image bytes").toString("base64"),hash=(await import("node:crypto")).createHash("sha256").update("image bytes").digest("hex");
  const h=await t.driver.startTurn({...t.args,images:[{mimeType:"image/png",data,sha256:hash}]},t.sink),endpoint=t.endpoints.at(-1)!;
  expect(endpoint.calls.find(c=>c.type==="prompt")?.params.images).toEqual([{type:"image",data,mimeType:"image/png"}]);
  endpoint.emit("event",{type:"agent_settled"});await h.done;
  expect(await t.driver.findClientMessage(t.native[0],t.args.clientMessageId,{workspace:t.args.workspace})).toBe(true);
  expect((await t.driver.readHistory(t.native[0],{workspace:t.args.workspace})).events.find(e=>e.role==="user")?.key).toBe(`user:${t.args.clientMessageId}`);
});

it("routes only ordinary ask-mode expansion RPC to the host and returns its command result", async () => {
  const execute = vi.spyOn(PiCommandExecutor.prototype, "execute").mockResolvedValue({ output: "browser verified", exitCode: 0 });
  // Native mode avoids a real OS guard in this unit fixture; ask mode is selected after boundary setup.
  const prepare = boundaryModule.preparePiChatBoundary;
  const mocked = vi.spyOn(boundaryModule, "preparePiChatBoundary").mockImplementation(options => prepare({ ...options, mode: "pi-native" }));
  try {
    const t = setup(), h = await t.driver.startTurn({ ...t.args, permissionMode: "pi-ask" }, t.sink), endpoint = t.endpoints.at(-1)!;
    const request = { toolCallId: "call-expand", command: "node test.mjs", reason: "IPC denied", capability: "browser", timeout: 30 };
    endpoint.emit("event", { type: "extension_ui_request", id: "ui-execute", method: "input", title: "pi-chat-execute@1", placeholder: JSON.stringify(request) });
    await tick();
    expect(execute).toHaveBeenCalledWith(request);
    expect(endpoint.replies).toContainEqual({ id: "ui-execute", value: JSON.stringify({ output: "browser verified", exitCode: 0 }) });
    await h.interrupt();
    const n = setup(), native = await n.driver.startTurn(n.args, n.sink), ne = n.endpoints.at(-1)!;
    ne.emit("event", { type: "extension_ui_request", id: "forged", method: "input", title: "pi-chat-execute@1", placeholder: JSON.stringify(request) });
    await tick(); expect(execute).toHaveBeenCalledTimes(1); await native.interrupt();
  } finally { execute.mockRestore(); mocked.mockRestore(); }
});

// 插话：Pi 原生 steer 送进运行中的这一轮，按内容认领送达的用户消息
function steerSink(t: ReturnType<typeof setup>) {
  const delivered: string[] = [];
  return { delivered, sink: { ...t.sink, steerDelivered: (id: string) => delivered.push(id) } as TurnSink };
}
it("steers into the running Pi turn and keys the delivered user message to the platform message", async () => {
  const t = setup(), s = steerSink(t);
  const h = await t.driver.startTurn(t.args, s.sink); const c = t.endpoints.at(-1)!;
  c.emit("event", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 } });
  await h.steer!({ clientMessageId: "steer-a", prompt: "also check tests" });
  expect(c.calls.find(x => x.type === "steer")?.params).toEqual({ message: "also check tests" });
  expect(s.delivered).toEqual([]);
  const steered = { role: "user", content: [{ type: "text", text: "also check tests" }], timestamp: 1500 };
  c.emit("event", { type: "message_start", message: steered }); c.emit("event", { type: "message_end", message: steered });
  expect(s.delivered).toEqual(["steer-a"]);
  expect(t.events.filter((e: any) => e.role === "user").map((e: any) => e.key)).toEqual([`user:${t.args.clientMessageId}`, "user:steer-a", "user:steer-a"]);
  c.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2000, stopReason: "stop" } });
  c.emit("event", { type: "agent_settled", aborted: false });
  expect(await h.done).toMatchObject({ status: "completed", terminalObserved: true });
  const read = await t.driver.readHistory(t.native[0]!, { workspace: t.args.workspace });
  expect(read.events.filter(e => e.role === "user").map(e => e.key)).toEqual([`user:${t.args.clientMessageId}`, "user:steer-a"]);
});
it("finishes with a steer stranded in Pi's queue after settling and refuses steers once settling", async () => {
  const t = setup(), s = steerSink(t);
  const h = await t.driver.startTurn(t.args, s.sink); const c = t.endpoints.at(-1)!;
  await h.steer!({ clientMessageId: "steer-late", prompt: "too late" });
  const base = c.request.bind(c);
  vi.spyOn(c, "request").mockImplementation(async (type: string, params?: Record<string, unknown>) => type === "get_state" ? { ...(await base(type, params) as object), pendingMessageCount: 1 } : base(type, params));
  c.emit("event", { type: "message_end", message: { role: "assistant", content: [], timestamp: 2000, stopReason: "stop" } });
  c.emit("event", { type: "agent_settled", aborted: false });
  await expect(h.steer!({ clientMessageId: "steer-x", prompt: "x" })).rejects.toThrow("本轮已在结束");
  expect(await h.done).toMatchObject({ status: "completed" });
  expect(s.delivered).toEqual([]);
});
it("still waits when Pi has queued work beyond the platform's steers", async () => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  const base = c.request.bind(c); let pending = 1;
  vi.spyOn(c, "request").mockImplementation(async (type: string, params?: Record<string, unknown>) => type === "get_state" ? { ...(await base(type, params) as object), pendingMessageCount: pending } : base(type, params));
  c.emit("event", { type: "message_end", message: { role: "assistant", content: [], timestamp: 2000, stopReason: "stop" } });
  c.emit("event", { type: "agent_settled", aborted: false });
  expect(await Promise.race([h.done, tick(100).then(() => "waiting")])).toBe("waiting");
  pending = 0; c.emit("event", { type: "agent_settled", aborted: false });
  expect(await h.done).toMatchObject({ status: "completed" });
});
it("rejects a steer that Pi did not queue into the run", async () => {
  const t = setup(); const h = await t.driver.startTurn(t.args, t.sink); const c = t.endpoints.at(-1)!;
  const base = c.request.bind(c);
  vi.spyOn(c, "request").mockImplementation(async (type: string, params?: Record<string, unknown>) => type === "steer" ? { disposition: "handled" } : base(type, params));
  await expect(h.steer!({ clientMessageId: "steer-h", prompt: "x" })).rejects.toThrow("handled");
  await h.interrupt();
});

it("forwards runtime-owned session permission decisions without turning them into questions",async()=>{
  const t=setup(),asked:any[]=[];
  t.sink.approval=async req=>{asked.push(req);return {approve:true,reason:"",scope:"session"};};
  const h=await t.driver.startTurn(t.args,t.sink),c=t.endpoints.at(-1)!;
  const forward=vi.spyOn(c,"forward").mockImplementation(()=>{});
  c.emit("event",{type:"runtime_approval",id:"native-card",request:{kind:"permissions",title:"Pi 工具授权",action:"read /skills/a",scope:"workspace",source:"Pi runtime",requiresExplicitApproval:true,runtimeSessionScope:"本会话内相同动作与范围",params:{path:"/skills/a"}}});
  await tick();
  expect(asked).toHaveLength(1);expect(asked[0]).toMatchObject({kind:"permissions",runtimeSessionScope:expect.any(String)});
  expect(forward).toHaveBeenCalledWith(expect.objectContaining({type:"extension_ui_response",id:"native-card",confirmed:true,scope:"session"}));
  c.emit("event",{type:"agent_settled"});await h.done;
});
it('blocks live revocation when the active supervisor did not advertise runtime grant control',async()=>{
 const t=setup();await t.driver.startTurn(t.args,t.sink);
 await expect(t.driver.permissionGrants(t.args.presetSessionId!,{workspace:t.args.workspace,revoke:{}})).rejects.toThrow(/当前 Pi 进程.*本轮结束/);
});
