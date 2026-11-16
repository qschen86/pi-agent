import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { PiRpcClient, stripMirroredToolResultImages, type PiRpcEvent } from "../src/pi-client.js";

const clients: PiRpcClient[] = [];
async function client() {
  const c = new PiRpcClient({ binaryPath: process.execPath, args: [fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url))], cwd: process.cwd(), env: {}, requestTimeoutMs: 1000 });
  clients.push(c); await c.start(); return c;
}
afterEach(() => clients.splice(0).forEach((c) => c.stop()));
it("correlates out-of-order responses by request ID", async () => {
  const c = await client();
  const slow = c.request("slow");
  expect(await c.request("fast")).toEqual({ value: "fast" });
  expect(await slow).toEqual({ value: "slow" });
});
it("rejects failure, timeout and all pending requests on process exit", async () => {
  const c = await client();
  await expect(c.request("fail")).rejects.toThrow("model unavailable");
  await expect(c.request("never", {}, 10)).rejects.toThrow(/timeout/i);
  const waiting = expect(c.request("never")).rejects.toThrow(/exit/i);
  const quit = expect(c.request("quit")).rejects.toThrow(/exit/i);
  await Promise.all([waiting, quit]);
});
it("frames only on LF, preserving split UTF-8 and literal Unicode separators", async () => {
  const c = await client(); const events: unknown[] = [];
  c.on("event", (e) => events.push(e));
  await c.request("unicode");
  expect(events).toEqual([{ type: "message_update", text: "半行🧪\u2028分隔\u2029完整" }]);
});
it.each(["malformed", "huge"])("rejects invalid JSONL protocol: %s", async (type) => {
  const c = await client();
  await expect(c.request(type)).rejects.toThrow(type === "huge" ? /JSONL frame exceeds 2097152-byte limit/ : /protocol/i);
  expect(c.alive).toBe(false);
});
it("drops oversized agent_end/turn_end screenshot frames and keeps the run alive", async () => {
  const c = await client(); const events: Record<string, unknown>[] = [];
  const settled = new Promise<void>((resolve, reject) => {
    c.on("event", (e) => { events.push(e); if (e.type === "agent_settled") resolve(); });
    c.once("exit", (e: { reason: string }) => reject(new Error(e.reason)));
  });
  await c.request("screenshot_run"); await settled;
  expect(events.map((e) => e.type)).toEqual(["message_end", "agent_settled"]);
  expect((events[0] as { message: { content: { type: string }[] } }).message.content[1].type).toBe("image");
  expect(c.alive).toBe(true);
  expect(await c.request("after")).toEqual({ value: "after" });
});
it("drops an oversized summary frame that arrives whole in one chunk, but only when type leads", () => {
  const shot = { type: "image", mimeType: "image/png", data: "A".repeat(2 * 1024 * 1024) };
  const feed = (frame: Record<string, unknown>) => {
    const c = new PiRpcClient({ binaryPath: "unused", args: [], cwd: process.cwd(), env: {} });
    const events: string[] = []; let exit = "";
    c.on("event", (e) => events.push(e.type)); c.on("exit", (e: { reason: string }) => { exit = e.reason; });
    (c as unknown as { receive(chunk: Buffer): void }).receive(Buffer.from(`${JSON.stringify(frame)}\n${JSON.stringify({ type: "agent_settled" })}\n`));
    return { events, exit };
  };
  expect(feed({ type: "agent_end", messages: [{ role: "toolResult", content: [shot] }] })).toEqual({ events: ["agent_settled"], exit: "" });
  expect(feed({ messages: [{ role: "toolResult", content: [shot] }], type: "agent_end" }).exit).toMatch(/JSONL frame exceeds/);
});
it("still rejects oversized frames the platform consumes", async () => {
  const c = await client();
  const exit = new Promise<{ reason: string }>((resolve) => c.once("exit", resolve));
  await c.request("huge_message_end");
  expect((await exit).reason).toMatch(/JSONL frame exceeds 2097152-byte limit/);
  expect(c.alive).toBe(false);
});
it("survives a read whose mirrored screenshot makes tool_execution_end oversized", async () => {
  // A full-page PNG is 1.3 MB of base64, mirrored into structuredContent: the tool frame is
  // 2.6 MB while the toolResult message that follows stays under the limit.
  const c = await client(); const events: Record<string, unknown>[] = [];
  const settled = new Promise<void>((resolve, reject) => {
    c.on("event", (e) => { events.push(e); if (e.type === "agent_settled") resolve(); });
    c.once("exit", (e: { reason: string }) => reject(new Error(e.reason)));
  });
  await c.request("read_screenshot"); await settled;
  expect(events.map((e) => e.type)).toEqual(["tool_execution_start", "message_end", "agent_settled"]);
  const message = (events[1] as { message: { content: { type: string; data?: string }[] } }).message;
  expect(message.content.map((part) => part.type)).toEqual(["text", "image"]);
  expect(Buffer.byteLength(JSON.stringify(events[1]))).toBeLessThan(2097152);
  expect(c.alive).toBe(true);
  expect(await c.request("after")).toEqual({ value: "after" });
});
it("forwards a mirrored image block once and keeps its note", () => {
  const image = { type: "image", mimeType: "image/png", data: "AAA" };
  const event: PiRpcEvent = {
    type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "Read image file [image/png]" }, image], structuredContent: { type: "image", mimeType: "image/png", data: "AAA", note: "Read image file [image/png]" } }
  };
  stripMirroredToolResultImages(event);
  const result = event.result as { content: unknown[]; structuredContent: unknown };
  expect(result.content[1]).toEqual(image);
  expect(result.structuredContent).toBe("Read image file [image/png]");
});
it("keeps a structured image that content does not carry", () => {
  const event: PiRpcEvent = {
    type: "message_end",
    message: { role: "toolResult", toolName: "screenshot", content: [{ type: "image", mimeType: "image/png", data: "AAA" }], structuredContent: { type: "image", mimeType: "image/jpeg", data: "BBB" } }
  };
  stripMirroredToolResultImages(event);
  expect((event.message as { structuredContent: { data: string } }).structuredContent.data).toBe("BBB");
});
it("forwards retry and settled events after agent_end without inventing completion", async () => {
  const c = await client(); const events: string[] = [];
  const settled = new Promise<void>((resolve) => c.on("event", (e) => { events.push(e.type); if (e.type === "agent_settled") resolve(); }));
  await c.request("prompt", { message: "hi" }); await settled;
  expect(events).toEqual(["agent_end", "auto_retry_start", "agent_start", "agent_settled"]);
});
it("sends approval responses with the exact UI request ID", async () => {
  const c = await client();
  const response = new Promise<unknown>((resolve) => c.once("event", resolve));
  c.respondUi("approval-17", { confirmed: false, cancelled: true });
  expect(await response).toMatchObject({ id: "approval-17", confirmed: false, cancelled: true, requestType: "extension_ui_response" });
});
it("waits for the process to close before callers remove its writable runtime directory", async () => {
  const c = await client(); await c.request("linger");
  c.stop(); const start = Date.now();
  await c.waitForExit();
  expect(Date.now() - start).toBeGreaterThanOrEqual(30);
});
it.skipIf(process.platform==='win32')('lets a supervisor flush its worker before reaping the process group',async()=>{
  const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'pi-supervisor-close-')),marker=join(dir,'flushed');
  const worker=`const fs=require('fs');process.on('message',()=>{fs.writeFileSync(${JSON.stringify(marker)},'flushed');process.exit(0)});process.send('ready');`;
  const parent=`const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:['ignore','ignore','ignore','ipc']});let ready=false,request;function reply(){if(ready&&request)process.stdout.write(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data:{}})+'\\n')}child.on('message',()=>{ready=true;reply()});process.stdin.on('data',b=>{request=JSON.parse(b);reply()});process.on('SIGTERM',()=>{child.once('exit',()=>process.exit(0));child.send('flush')});`;
  const c=new PiRpcClient({binaryPath:process.execPath,args:['-e',parent],cwd:dir,env:{},gracefulShutdown:true});clients.push(c);
  try{await c.start();await c.request('ready');c.stop();await c.waitForExit();expect(readFileSync(marker,'utf8')).toBe('flushed');}
  finally{c.stop();await c.waitForExit();rmSync(dir,{recursive:true,force:true});}
});
