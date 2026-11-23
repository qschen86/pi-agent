import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityDriver, antigravityQuotaNotice, antigravityUsage, parseAntigravityQuota, parseModels, readStepsFingerprint, stepsFingerprint, toolEvent } from "../src/antigravity.js";
import { COMPARE_WORKTREE_PERMISSION_MODES, defaultPermissionMode, effectivePermissionMode, permissionOptions } from "../src/permissions.js";
import { screenshotReportProblems, startPlatformBrowser, verifyScreenshotReceipt } from "../src/platform-browser.js";

/** 一个说 ACP 的假 agy：行为由同目录的 mode 文件控制（驱动只给子进程传白名单环境变量），不依赖真实账号。 */
const FAKE_AGY = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv[2] === "--version") { console.log("9.9.9"); process.exit(0); }
const mode = (() => { try { return require("node:fs").readFileSync(__dirname + "/mode", "utf8").trim(); } catch { return ""; } })();
if (process.argv[2] === "-p") {
  require("node:fs").writeFileSync(__dirname + "/quota-call.json", JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,cwd:process.cwd()}));
  if(mode === "quota-timeout") { setInterval(()=>{},1000); return; }
  if(mode === "quota-invalid-json") { console.log("not JSON"); process.exit(0); }
  if(mode === "quota-command-failure") { console.error("private stderr must not reach the page"); process.exit(1); }
  console.log(JSON.stringify({status:"SUCCESS",num_turns:0,command:{name:"usage",data:{groups:[
    {name:"Gemini Models",buckets:[{window:"weekly",remaining_fraction:0.9976076483726501,reset_time:"2026-11-28T17:49:54Z"},{window:"5h",remaining_fraction:0.75,reset_time:"2026-11-22T06:42:20Z"}]},
    {name:"Claude and GPT models",buckets:[{window:"weekly",remaining_fraction:0,reset_time:null},{window:"5h",remaining_fraction:1,reset_time:"2026-11-22T06:57:49Z"}]},
    {name:"Gemini 4 Argon",buckets:[{window:"weekly",remaining_fraction:0.5,reset_time:"2026-11-29T01:57:49Z"}]}
  ]}}})); process.exit(0);
}
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const created = new Set();
const bypassFlag = process.argv.includes("--dangerously-skip-permissions");
let nextServerId = 1000, pendingPrompt, cancelled = false;
const models = { availableModels: ["gemini-4-neon-high","gemini-4-neon-low","gemini-4-neon-medium","gpt-oss-120b-medium"].map((modelId) => ({ modelId, name: modelId })) };
const sessionResult = (sessionId) => ({ sessionId, models,
  modes: { currentModeId: "default", availableModes: [] },
  configOptions: [
    { id: "model", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }, { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }] },
    { id: "thought_level", currentValue: "high", options: [] }
  ], _meta: { antigravity: { tier: { name: "Google AI Pro", id: "g1-pro-tier" } } } });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (mode === "record-process" && ["session/new","session/resume","session/set_mode","session/prompt"].includes(m.method)) {
    require("node:fs").appendFileSync(__dirname + "/process-requests", JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), bypass: bypassFlag, method: m.method, params: m.params }) + "\\n");
  }
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } }, agentInfo: { name: "Fake ACP", version: "1" } } });
  if (mode === "record-mcp" && ["session/new","session/resume"].includes(m.method)) {
    require("node:fs").appendFileSync(__dirname + "/mcp-requests", JSON.stringify({method:m.method, params:m.params}) + "\\n");
  }
  if (["session/new","session/resume"].includes(m.method) && m.params && Array.isArray(m.params.mcpServers) && m.params.mcpServers[0]) {
    globalThis.lastMcpServer = m.params.mcpServers[0];
  }
  if (m.method === "session/new") {
    if (mode === "needs-login") return send({ id: m.id, error: { code: -32000, message: "authentication required: please login" } });
    const id = "sess-" + created.size; created.add(id); return send({ id: m.id, result: sessionResult(id) });
  }
  if (m.method === "session/resume") { created.add(m.params.sessionId); return send({ id: m.id, result: sessionResult(m.params.sessionId) }); }
  if (m.method === "session/set_mode" || m.method === "session/set_config_option") return send({ id: m.id, result: {} });
  if (m.method === "session/cancel") { cancelled = true; if (pendingPrompt) send({ id: pendingPrompt, result: { stopReason: "cancelled", usage: { inputTokens: 5, outputTokens: 1 } } }); return; }
  if (m.method === "session/prompt") {
    const sid = m.params.sessionId;
    if (mode === "hang") { pendingPrompt = m.id; update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } }); return; }
    if (mode === "crash") { process.exit(3); }
    if (mode === "quota") return send({ id: m.id, error: { code: -32000, message: "RESOURCE_EXHAUSTED: quota exceeded" } });
    if (mode === "quota-notice") {
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h24m19s.\\n" } });
      return send({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } } });
    }
    if (mode === "bg-stream") {
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "foreground" } });
      send({ id: m.id, result: { stopReason: "end_turn" } });
      setTimeout(() => {
        update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "background thought" } });
        update(sid, { sessionUpdate: "tool_call", toolCallId: "bg-tool", name: "run_command", status: "in_progress", rawInput: { CommandLine: "npm test" } });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "bg-tool", status: "completed", rawOutput: { output: "passed" } });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "background reply" } });
        update("foreign-session", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "foreign reply" } });
      }, 30);
      return;
    }
    if (mode === "bg-permission") {
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "waiting for background task" } });
      send({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 3 } } });
      setTimeout(() => {
        const permId = nextServerId++;
        send({ id: permId, method: "session/request_permission", params: { sessionId: sid, toolCall: { toolCallId: "bg-t1", kind: "execute", rawInput: { CommandLine: "npx vitest" } }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
        readline.createInterface({ input: process.stdin }).on("line", (l2) => {
          const r = JSON.parse(l2);
          if (r.id !== permId) return;
          require("node:fs").writeFileSync(__dirname + "/bg-perm-result.json", JSON.stringify(r.result));
        });
      }, 25);
      return;
    }
    if (mode === "browser-screenshot") {
      const srv = globalThis.lastMcpServer;
      const { spawn } = require("node:child_process");
      const child = spawn(srv.command, srv.args, { stdio: ["pipe", "pipe", "inherit"] });
      update(sid, { sessionUpdate: "tool_call", toolCallId: "pb1", name: "mcp_platform_browser_642a3c28_browser", kind: "other", status: "in_progress", rawInput: { action: "screenshot" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser", arguments: { action: "screenshot" } } }) + "\\n");
      readline.createInterface({ input: child.stdout }).on("line", () => {
        child.kill();
        // 真实 agy 对 MCP 工具的 session/update 不带 rawOutput：驱动从宿主日志补齐 receipt 输出
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "pb1", name: "mcp_platform_browser_642a3c28_browser", kind: "other", status: "completed", rawInput: { action: "screenshot" } });
        send({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } } });
      });
      return;
    }
    update(sid, { sessionUpdate: "session_info_update", title: "Fake Title" });
    update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", name: "run_command", kind: "execute", status: "in_progress", rawInput: { CommandLine: "echo hi" } });
    if (bypassFlag) {
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", kind: "execute", status: "completed", rawInput: { CommandLine: "echo hi" }, rawOutput: { output: "hi", exit_code: 0 } });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
      return send({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50, thoughtTokens: 5, totalTokens: 170 } } });
    }
    const permId = nextServerId++;
    send({ id: permId, method: "session/request_permission", params: { sessionId: sid, toolCall: { toolCallId: "t1", kind: "execute", rawInput: { CommandLine: "echo hi" } }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
    const promptId = m.id;
    readline.createInterface({ input: process.stdin }).on("line", (l2) => {
      const r = JSON.parse(l2);
      if (r.id !== permId) return;
      const allowed = r.result && r.result.outcome && r.result.outcome.optionId === "allow";
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", kind: "execute", status: allowed ? "completed" : "failed", rawInput: { CommandLine: "echo hi" }, rawOutput: { output: allowed ? "hi" : "denied", exit_code: allowed ? 0 : 1 } });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "do" } });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ne" } });
      send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50, thoughtTokens: 5, totalTokens: 170 } } });
    });
    return;
  }
  if (m.method === "session/list") return send({ id: m.id, result: { sessions: [{ sessionId: "sess-0", cwd: "/work/a", title: "A", updatedAt: "2026-01-01T00:00:00Z" }, { sessionId: "sess-9", cwd: "/other/b", title: "B" }] } });
  if (m.method === "session/load") {
    const sid = m.params.sessionId;
    update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } });
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi " } });
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" } });
    return send({ id: m.id, result: sessionResult(sid) });
  }
  send({ id: m.id, result: {} });
});
`;

const dirs: string[] = [];
describe("Antigravity quota JSON validation", () => {
  const payload = (bucket: unknown) => ({status:"SUCCESS",num_turns:0,command:{name:"usage",data:{groups:[{name:"Gemini",buckets:[bucket]}]}}});
  it.each([-0.1, 1.1, "0.5", null, NaN])("拒绝无效比例 %s", remaining => {
    expect(() => parseAntigravityQuota(payload({window:"5h",remaining_fraction:remaining,reset_time:null}))).toThrow("比例无效");
  });
  it("拒绝非只读、空组、无效日期和部分损坏的结果", () => {
    expect(() => parseAntigravityQuota({...payload({}),num_turns:1})).toThrow("只读额度");
    expect(() => parseAntigravityQuota({status:"SUCCESS",num_turns:0,command:{name:"usage",data:{groups:[]}}})).toThrow("未提供模型组");
    expect(() => parseAntigravityQuota(payload({window:"5h",remaining_fraction:0.5,reset_time:"bad date"}))).toThrow("重置时间无效");
    const p=payload({window:"5h",remaining_fraction:0.5,reset_time:null});
    p.command.data.groups.push({name:"bad group",buckets:[]});
    expect(() => parseAntigravityQuota(p)).toThrow("格式不完整");
  });
});
const drivers: AntigravityDriver[] = [];
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
/** 造一个 agy 形状的会话库：conversations/{id}.db，带 steps 表 */
function conversationDb(home: string, id: string, steps: number): string {
  const conv = join(home, ".gemini", "antigravity-cli", "conversations"); mkdirSync(conv, { recursive: true });
  const dbPath = join(conv, `${id}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE steps (idx integer primary key, step_type integer not null default 0)");
  const insert = db.prepare("insert into steps (idx, step_type) values (?, ?)");
  for (let i = 0; i < steps; i++) insert.run(i, 1);
  db.close();
  return dbPath;
}
function setup(mode = "") {
  const dir = mkdtempSync(join(tmpdir(), "agy-test-"));
  dirs.push(dir);
  const bin = join(dir, "agy");
  writeFileSync(bin, FAKE_AGY); chmodSync(bin, 0o755);
  writeFileSync(join(dir, "mode"), mode);
  const driver = new AntigravityDriver({ binaryPath: bin, home: dir, stateDir: join(dir, "probe") });
  drivers.push(driver);
  return { driver, dir };
}
afterEach(() => { for (const d of drivers.splice(0)) d.shutdown(); });

function sinkOf(approve = true) {
  const events: any[] = []; const usage: any[] = []; const native: any[] = []; const approvals: any[] = [];
  const sink: any = {
    nativeSession: (id: string, info: any) => native.push({ id, ...info }), nativeTurn() {}, event: (e: any) => events.push(e), usage: (u: any) => usage.push(u), rateLimit() {}, status() {},
    approval: async (a: any) => { approvals.push(a); return { approve, reason: "t" }; }
  };
  return { sink, events, usage, native, approvals };
}

describe("antigravity driver (fake agy over ACP)", () => {
  it("probe 读出套餐、模型与能力，并复用同一条探测会话", async () => {
    const { driver } = setup();
    const p = await driver.probe();
    expect(p.state).toBe("executable");
    expect(p.binaryVersion).toBe("9.9.9");
    expect(p.identity?.summary).toContain("Google AI Pro");
    expect(p.authVerified).toBe(true);
    expect(p.capabilities.rateLimits.status).toBe("supported");
    expect(p.capabilities.resume.status).toBe("supported");
    expect(p.capabilities.roleInstructions.status).toBe("supported");
    expect(p.models.map((m) => m.id)).toEqual(["gemini-4-neon", "gpt-oss-120b-medium"]);
    expect(p.models[0]).toMatchObject({ isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "high" });
    expect(p.models[1]!.efforts).toBeUndefined();
    expect(p.permissionOptions!.map((o) => o.id)).toEqual(["default", "acceptEdits", "auto", "plan", "bypassPermissions"]);
    expect(p.permissions).toMatchObject({ id: "auto", label: "自动审批" });
    expect(defaultPermissionMode("antigravity")).toBe("auto");
    expect(effectivePermissionMode({ runtimeKind: "antigravity", evaluation: {} })).toBe("default");
    expect(COMPARE_WORKTREE_PERMISSION_MODES.antigravity).toEqual(["plan", "default", "acceptEdits", "auto"]);
    expect(permissionOptions("antigravity").some((o) => o.id === "bypassPermissions")).toBe(true);
    const again = await driver.probe();
    expect(again.state).toBe("executable");
  });

  it("auto 模式走普通进程并切到 native auto；Full access 走独立免审批 ACP 进程且与普通进程隔离", async () => {
    const { driver, dir } = setup("record-process");
    const s1 = sinkOf(true);
    expect((await (await driver.startTurn({ workspace: "/work/a", prompt: "first", clientMessageId: "m-auto", permissionMode: "auto" }, s1.sink)).done).status).toBe("completed");
    expect(s1.approvals).toHaveLength(1);

    const s2 = sinkOf(true);
    expect((await (await driver.startTurn({ workspace: "/work/a", prompt: "second", clientMessageId: "m-bypass", nativeSessionId: "sess-0", permissionMode: "bypassPermissions" }, s2.sink)).done).status).toBe("completed");
    expect(s2.approvals).toHaveLength(0);

    const s3 = sinkOf(true);
    expect((await (await driver.startTurn({ workspace: "/work/a", prompt: "third", clientMessageId: "m-ro", permissionMode: "bypassPermissions", readOnlyRoom: true }, s3.sink)).done).status).toBe("completed");
    expect(s3.approvals).toHaveLength(0);
    expect([...s3.events].reverse().find((e) => e.kind === "tool").tool.status).toBe("failed");

    const log = readFileSync(join(dir, "process-requests"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const autoSet = log.find((e) => e.method === "session/set_mode" && e.params.modeId === "auto");
    expect(autoSet).toMatchObject({ bypass: false, argv: ["acp", "--process-per-session"] });
    const bypassResume = log.find((e) => e.method === "session/resume" && e.params.sessionId === "sess-0");
    expect(bypassResume).toMatchObject({ bypass: true, argv: ["acp", "--process-per-session", "--dangerously-skip-permissions"] });
    expect(bypassResume.pid).not.toBe(autoSet.pid);
    // 群聊只读即便传入 bypassPermissions 也绝不走免审批进程
    const roPrompt = log.filter((e) => e.method === "session/prompt").at(-1);
    expect(roPrompt).toMatchObject({ bypass: false, pid: autoSet.pid });
  });

  it("额度经只读 CLI JSON 读取，保留模型组、精度和重置时间", async () => {
    const { driver, dir } = setup();
    const quota = (await driver.rateLimits())!;
    expect(JSON.parse(readFileSync(join(dir, "quota-call.json"), "utf8"))).toEqual({args:["-p","/usage","--output-format","json"],home:dir,cwd:join(dir,"probe")});
    expect(quota.available).toBe(true);
    expect(quota.windows).toHaveLength(5);
    expect(quota.windows[0]).toMatchObject({group:"Gemini Models",label:"周窗口",resetsAt:"2026-11-28T17:49:54.000Z",windowMinutes:10080});
    expect(quota.windows[0]!.usedPercent).toBeCloseTo(0.2392351627, 8);
    expect(quota.windows[1]).toMatchObject({usedPercent:25,windowMinutes:300});
    expect(quota.windows[2]).toMatchObject({group:"Claude and GPT models",usedPercent:100,resetsAt:null});
    expect(quota.windows[3]!.usedPercent).toBe(0);
    expect(quota.windows[4]).toMatchObject({group:"Gemini 4 Argon",usedPercent:50});
  });

  it.each(["quota-invalid-json", "quota-command-failure"])("%s：读取失败抛错，不生成空快照覆盖缓存", async mode => {
    const { driver } = setup(mode);
    await expect(driver.rateLimits()).rejects.toThrow(/Antigravity/);
    await expect(driver.rateLimits()).rejects.not.toThrow(/private stderr/);
  });

  it("额度命令超时会结束子进程并报错", async () => {
    const { dir } = setup("quota-timeout");
    const driver = new AntigravityDriver({binaryPath:join(dir,"agy"),home:dir,stateDir:join(dir,"probe"),quotaTimeoutMs:150});
    await expect(driver.rateLimits()).rejects.toThrow("额度读取超时");
  });

  it("未登录：session/new 被拒绝时报待登录并给出登录命令", async () => {
    const { driver } = setup("needs-login");
    const p = await driver.probe();
    expect(p.state).toBe("needs-login");
    expect(p.stateReason).toContain("agy acp --login");
  });

  it("找不到 agy：未安装", async () => {
    const driver = new AntigravityDriver({ binaryPath: "/nonexistent/agy", home: "/nonexistent" });
    const prev = process.env["PATH"]; process.env["PATH"] = "/nonexistent";
    try { expect((await driver.probe()).state).toBe("not-installed"); } finally { process.env["PATH"] = prev; }
  });

  it("新建会话 → 审批 → 工具与消息事件 → 用量", async () => {
    const { driver } = setup();
    const s = sinkOf(true);
    const h = await driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m1", permissionMode: "default", model: "gpt-oss-120b-medium", roleInstructions: "be nice" }, s.sink);
    const r = await h.done;
    expect(r).toMatchObject({ status: "completed", terminalObserved: true });
    expect(s.native[0]).toMatchObject({ id: "sess-0", effectiveModel: "gpt-oss-120b-medium" });
    expect(s.native.some((n) => n.title)).toBe(false); // agy 自动起的标题不覆盖平台标题
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0]).toMatchObject({ kind: "command", action: "echo hi", source: "antigravity session/request_permission" });
    const final = s.events.filter((e) => !e.partial);
    expect(final.find((e) => e.kind === "message")?.text).toBe("done");
    expect(final.find((e) => e.kind === "reasoning")?.text).toBe("thinking");
    const tool = [...s.events].reverse().find((e) => e.kind === "tool");
    expect(tool.tool).toMatchObject({ name: "命令", input: "echo hi", output: "hi", status: "completed", exitCode: 0 });
    expect(s.usage[0]).toMatchObject({ usageScope: "turn", counterMode: "delta", input: 100, output: 20, cachedInput: 50, reasoningOutput: 5, total: 170, requestId: "m1" });
  });

  it("registers a fresh platform MCP connection on create and resume", async () => {
    const { driver, dir } = setup("record-mcp");
    const { sink } = sinkOf();
    const start = {
      workspace: dir, prompt: "read a shared conversation", clientMessageId: "share-first",
      roleInstructions: "Try native tools first, then ask the shared reader.",
      platformBrowser: { socketPath: "/first.sock", bridgePath: "/host/bridge.mjs", hookPath: "/host/hook.mjs" },
    };
    expect((await (await driver.startTurn(start, sink)).done).status).toBe("completed");
    const next = {
      ...start, clientMessageId: "share-next", nativeSessionId: "sess-0",
      platformBrowser: { ...start.platformBrowser, socketPath: "/next.sock" },
    };
    expect((await (await driver.startTurn(next, sink)).done).status).toBe("completed");
    const [created, resumed] = readFileSync(join(dir, "mcp-requests"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const server = (socketPath: string) => ({
      name: "platform_browser", command: process.execPath, args: ["/host/bridge.mjs", socketPath], env: [],
    });
    expect(created).toMatchObject({
      method: "session/new", params: { mcpServers: [server("/first.sock")],
        _meta: { antigravity: { systemPrompt: { append: start.roleInstructions } } } },
    });
    expect(resumed).toMatchObject({
      method: "session/resume", params: { sessionId: "sess-0", mcpServers: [server("/next.sock")] },
    });
  });

  it("platform_browser 截图：ACP 不回传 MCP rawOutput 时仍关联 receiptId 并通过截图来源校验", async () => {
    const { driver, dir } = setup("browser-screenshot");
    const s = sinkOf();
    const page = { screenshot: async () => Buffer.from("png-bytes"), viewportSize: () => ({ width: 390, height: 844 }), url: () => "http://127.0.0.1:8780/" };
    const fakeBrowser = { newContext: async () => ({ setDefaultTimeout() {}, newPage: async () => page }), close: async () => {} } as never;
    const pb = await startPlatformBrowser({ sessionId: "rt-agy-shot", turnId: "t1", workspace: dir, outputDir: join(dir, ".platform-browser", "rt-agy-shot"), event: (e) => s.events.push(e), launch: async () => fakeBrowser });
    try {
      const h = await driver.startTurn({ workspace: dir, prompt: "take screenshot", clientMessageId: "t1", platformBrowser: pb.access }, s.sink);
      expect((await h.done).status).toBe("completed");
      expect(pb.receipts).toHaveLength(1);
      const receipt = pb.receipts[0]!;
      expect(verifyScreenshotReceipt(receipt, "rt-agy-shot", s.events)).toBe(true);
      expect(screenshotReportProblems(`| 维度 | 改前 | 改后 |\n|---|---|---|\n| 手机 390 | ![改前](${receipt.path}) | ![改后](${receipt.path}) |`, "rt-agy-shot", dir, s.events)).toEqual([]);
    } finally {
      await pb.dispose();
    }
  });

  it("拒绝审批：工具失败但本轮正常结束", async () => {
    const { driver } = setup();
    const s = sinkOf(false);
    const h = await driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m1" }, s.sink);
    expect((await h.done).status).toBe("completed");
    expect([...s.events].reverse().find((e) => e.kind === "tool").tool.status).toBe("failed");
  });

  it("只读群聊成员：执行类权限请求不经人直接拒绝", async () => {
    const { driver } = setup();
    const s = sinkOf(true);
    const h = await driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m1", permissionMode: "plan", readOnlyRoom: true }, s.sink);
    expect((await h.done).status).toBe("completed");
    expect(s.approvals).toHaveLength(0);
    expect([...s.events].reverse().find((e) => e.kind === "tool").tool.status).toBe("failed");
  });

  it("end_turn 后实时接收原轮次的思考、工具和回复，保留资源直至退出，隔离其他会话和进程", async () => {
    const { driver } = setup("bg-stream"), s = sinkOf();
    const h = await driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "original" }, s.sink);
    await h.done;
    let closed = false;
    void h.continuationDone!.then(() => { closed = true; });
    expect(closed).toBe(false);
    for (let i = 0; i < 80 && !s.events.some(e => e.text === "background reply"); i++) await new Promise(r => setTimeout(r, 10));
    expect(s.events.some(e => e.kind === "reasoning" && e.text === "background thought")).toBe(true);
    expect(s.events.filter(e => e.tool?.output === "passed")).toHaveLength(1);
    expect(s.events.filter(e => e.text === "background reply")).toHaveLength(1);
    expect(s.events.every(e => e.key.includes(":original:"))).toBe(true);
    expect(s.events.some(e => e.text === "foreign reply")).toBe(false);
    (driver as any).onNotification({}, { method: "session/update", params: { sessionId: "sess-0", update: { sessionUpdate: "agent_message_chunk", content: { text: "foreign process" } } } });
    expect(s.events.some(e => e.text?.includes("foreign process"))).toBe(false);
    expect(driver.continuationState("sess-0")).toMatchObject({ clientMessageId: "original", active: true });
    await expect(driver.startTurn({ workspace: "/work/a", nativeSessionId: "sess-0", prompt: "next", clientMessageId: "next" }, sinkOf().sink)).rejects.toThrow("后台续写");
    driver.shutdown();
    await h.continuationDone;
    expect(closed).toBe(true);
    expect(driver.continuationState("sess-0")).toBeUndefined();
    expect(s.events.at(-1)).toMatchObject({ text: "background reply", partial: false });
  });

  it("正常续聊交接时关闭旧轮次资源，新消息使用新轮次的 sink", async () => {
    const { driver } = setup(), first = sinkOf(), second = sinkOf();
    const h1 = await driver.startTurn({ workspace: "/work/a", prompt: "one", clientMessageId: "one" }, first.sink);
    await h1.done;
    const h2 = await driver.startTurn({ workspace: "/work/a", nativeSessionId: "sess-0", prompt: "two", clientMessageId: "two" }, second.sink);
    await h1.continuationDone;
    await h2.done;
    expect(second.events.every(e => e.key.includes(":two:"))).toBe(true);
    expect(first.events.every(e => e.key.includes(":one:"))).toBe(true);
  });

  it("后台任务唤醒期权限请求不再静默 cancel：继续走会话审批回调，并支持只读拒绝与 shutdown 中止", async () => {
    // 1) 正常会话：本轮 end_turn 后同一进程内再发 session/request_permission，仍交由 sink.approval 放行
    const { driver, dir } = setup("bg-permission");
    const s = sinkOf(true);
    const h = await driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m1" }, s.sink);
    expect((await h.done).status).toBe("completed");
    const resultFile = join(dir, "bg-perm-result.json");
    for (let i = 0; i < 40 && !statSync(resultFile, { throwIfNoEntry: false }); i++) await new Promise((r) => setTimeout(r, 25));
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0].action).toBe("npx vitest");
    expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });

    // 2) 只读群聊成员：后台唤醒期执行类请求依然直接 reject，不打扰人
    const ro = setup("bg-permission");
    const sRo = sinkOf(true);
    const hRo = await ro.driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m2", permissionMode: "plan", readOnlyRoom: true }, sRo.sink);
    expect((await hRo.done).status).toBe("completed");
    const roFile = join(ro.dir, "bg-perm-result.json");
    for (let i = 0; i < 40 && !statSync(roFile, { throwIfNoEntry: false }); i++) await new Promise((r) => setTimeout(r, 25));
    expect(sRo.approvals).toHaveLength(0);
    expect(JSON.parse(readFileSync(roFile, "utf8"))).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });

    // 3) 后台审批挂起时 shutdown：AbortSignal 立即触发，不悬空
    const ab = setup("bg-permission");
    let aborted = false;
    let seen = false;
    const sAb: any = {
      nativeSession() {}, nativeTurn() {}, event() {}, usage() {}, rateLimit() {}, status() {},
      approval: (_a: any, signal?: AbortSignal) => new Promise((_res, rej) => {
        seen = true;
        signal?.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); }, { once: true });
      })
    };
    const hAb = await ab.driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m3" }, sAb);
    expect((await hAb.done).status).toBe("completed");
    for (let i = 0; i < 40 && !seen; i++) await new Promise((r) => setTimeout(r, 25));
    expect(seen).toBe(true);
    ab.driver.shutdown();
    expect(aborted).toBe(true);
  });

  it("沿原会话 ID 续聊", async () => {
    const { driver } = setup();
    const s = sinkOf();
    const h = await driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m1" }, s.sink);
    await h.done;
    const s2 = sinkOf();
    const h2 = await driver.startTurn({ workspace: "/work/a", prompt: "again", clientMessageId: "m2", nativeSessionId: "sess-0" }, s2.sink);
    expect(s2.native[0]!.id).toBe("sess-0");
    await h2.done;
  });

  it("中断：session/cancel 后结果为 cancelled", async () => {
    const { driver } = setup("hang");
    const s = sinkOf();
    const h = await driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m1" }, s.sink);
    await new Promise((r) => setTimeout(r, 100));
    await h.interrupt();
    expect(await h.done).toMatchObject({ status: "cancelled", terminalObserved: true });
  });

  it("agy 进程中途退出：本轮为 interrupted 且记下进程已结束", async () => {
    const { driver } = setup("crash");
    const s = sinkOf();
    const h = await driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m1" }, s.sink);
    const r = await h.done;
    expect(r.status).toBe("interrupted");
    expect(r.processEnded).toContain("agy 进程已退出");
    expect(r.terminalObserved).toBeUndefined();
  });

  it("额度错误：保留错误正文给平台识别，并算已观察到终态", async () => {
    const { driver } = setup("quota");
    const s = sinkOf();
    const h = await driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m1" }, s.sink);
    const r = await h.done;
    expect(r).toMatchObject({ status: "failed", terminalObserved: true });
    expect(r.reason).toContain("quota");
  });

  it("额度告警以 end_turn 文本返回时也识别为额度失败，不误判本轮完成", async () => {
    const { driver } = setup("quota-notice");
    const s = sinkOf();
    const h = await driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m1" }, s.sink);
    const r = await h.done;
    expect(r).toMatchObject({ status: "failed", code: "usageLimitExceeded", terminalObserved: true });
    expect(r.reason).toContain("Individual quota reached");
    expect(r.reason).toContain("Resets in 2h24m19s");
    expect(s.events.some((e) => !e.partial && e.kind === "message" && e.text.includes("Individual quota reached"))).toBe(true);
  });

  it("评测任务不支持：未执行", async () => {
    const { driver } = setup();
    await expect(driver.startTurn({ workspace: "/work/a", prompt: "go", clientMessageId: "m1", evaluation: {} as never }, sinkOf().sink)).rejects.toMatchObject({ stage: "create", notExecuted: true });
  });

  it("历史：列表按目录根过滤，回放合并连续片段", async () => {
    const { driver } = setup();
    const list = await driver.listHistory({ roots: ["/work"], limit: 10 });
    expect(list.items.map((i) => i.nativeSessionId)).toEqual(["sess-0"]);
    const h = await driver.readHistory("sess-0", { workspace: "/work/a" });
    expect(h.coverage).toBe("partial");
    expect(h.events.map((e) => `${e.role}:${e.text}`)).toEqual(["user:hello", "assistant:hi there"]);
  });

  it("指纹只看 steps 的条数与最大 idx：WAL checkpoint 不算外部写入，追加记录才算", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-fp-")); dirs.push(dir);
    const db = conversationDb(dir, "abc", 3);
    const driver = new AntigravityDriver({ home: dir, fingerprintSettleMs: 1 });
    const base = (await driver.fingerprint("abc", {}))!.value;
    expect(base).toBe("s3i2");
    // 模拟 agy 收尾：往别的表写一大块，然后 WAL checkpoint（主库变大、mtime 推后、WAL 归零）——真实误报就是这个形状
    const before = statSync(db);
    const conn = new DatabaseSync(db);
    conn.exec("CREATE TABLE IF NOT EXISTS gen_metadata (idx integer primary key, data blob)");
    conn.prepare("insert or replace into gen_metadata (idx, data) values (?, ?)").run(1, Buffer.alloc(200_000, 7));
    conn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    conn.close();
    const after = statSync(db);
    expect(after.size).not.toBe(before.size);
    expect(Math.floor(after.mtimeMs)).not.toBe(Math.floor(before.mtimeMs));
    expect((await driver.fingerprint("abc", {}))!.value).toBe(base);
    // 外部续聊：WAL 里还没 checkpoint 的新记录也要算进去
    const live = new DatabaseSync(db);
    live.exec("PRAGMA journal_mode = WAL");
    live.prepare("insert into steps (idx, step_type) values (?, ?)").run(3, 1);
    expect((await driver.fingerprint("abc", {}))!.value).toBe("s4i3");
    live.close();
    expect((await driver.fingerprint("abc", {}))!.value).toBe("s4i3");
  });

  it("读不到库时沿用上次指纹并带 note，不返回 undefined、不判外部写入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-fp-")); dirs.push(dir);
    const db = conversationDb(dir, "abc", 2);
    const driver = new AntigravityDriver({ home: dir, fingerprintSettleMs: 1 });
    expect((await driver.fingerprint("abc", {}))!.value).toBe("s2i1");
    rmSync(db);
    expect(await driver.fingerprint("abc", {})).toEqual({ value: "s2i1", note: expect.stringContaining("沿用上次指纹") });
    // 进程重启后内存缓存没了：按绑定里上次记录的值沿用
    const fresh = new AntigravityDriver({ home: dir, fingerprintSettleMs: 1 });
    expect(await fresh.fingerprint("abc", { previous: "s2i1" })).toEqual({ value: "s2i1", note: expect.stringContaining("沿用上次指纹") });
    expect(await fresh.fingerprint("abc", {})).toBeUndefined();
    expect(await fresh.fingerprint("../escape", { previous: "s2i1" })).toBeUndefined();
  });

  it("上一版文件元数据指纹（主库大小:mtime:WAL）语式不可比：标 migrated 让管理器只重建基线", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-fp-")); dirs.push(dir);
    conversationDb(dir, "abc", 5);
    const driver = new AntigravityDriver({ home: dir, fingerprintSettleMs: 1 });
    expect(await driver.fingerprint("abc", { previous: "7569408:1795319074598:32857616" })).toEqual({ value: "s5i4", migrated: true });
    expect(await driver.fingerprint("abc", { previous: "s5i4" })).toEqual({ value: "s5i4" });
  });

  it("空库与缺表：空库给 s0i-1，缺 steps 表按读不到处理", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-fp-")); dirs.push(dir);
    const conv = join(dir, ".gemini", "antigravity-cli", "conversations"); mkdirSync(conv, { recursive: true });
    const empty = join(conv, "empty.db");
    const conn = new DatabaseSync(empty);
    conn.exec("CREATE TABLE steps (idx integer primary key, step_type integer)");
    conn.close();
    const noSteps = join(conv, "nosteps.db");
    new DatabaseSync(noSteps).close();
    const driver = new AntigravityDriver({ home: dir, fingerprintSettleMs: 1 });
    expect((await driver.fingerprint("empty", {}))!.value).toBe("s0i-1");
    expect(await driver.fingerprint("nosteps", {})).toBeUndefined();
    expect(await driver.fingerprint("missing", {})).toBeUndefined();
  });

  it("findClientMessage 明确返回未知，不猜", async () => {
    expect(await setup().driver.findClientMessage()).toBeUndefined();
  });
});

describe("antigravity 纯函数", () => {
  it("parseModels：推理强度来自 availableModels 的后缀变体", () => {
    const out = parseModels({
      models: { availableModels: [{ modelId: "a-low" }, { modelId: "a-xhigh" }, { modelId: "a-medium" }] },
      configOptions: [{ id: "model", currentValue: "a", options: [{ value: "a", name: "A" }] }, { id: "thought_level", currentValue: "xhigh" }]
    }, false);
    expect(out).toEqual([{ id: "a", label: "A", inputModalities: ["text"], isDefault: true, efforts: ["low", "medium", "xhigh"], defaultEffort: "xhigh" }]);
  });

  it("antigravityUsage：缺输入输出时不记，缓存写入为 0 时不带 cacheCreation", () => {
    expect(antigravityUsage({}, "r", undefined, "t")).toBeUndefined();
    const u = antigravityUsage({ inputTokens: 1, outputTokens: 2, cachedWriteTokens: 0 }, "r", "m", "t")!;
    expect(u).toMatchObject({ input: 1, output: 2, model: "m", reliability: "complete" });
    expect(u.cacheCreation).toBeUndefined();
  });

  it("toolEvent：文件编辑展示路径与 diff，进行中状态归一；平台浏览器 MCP 工具名归一为 platform_browser.browser", () => {
    const e = toolEvent({ kind: "edit", status: "pending", rawInput: { Path: "/a/b" }, content: [{ type: "diff", path: "/a/b", newText: "x" }] }, { key: "k", source: "stream", parserVersion: "p", partial: false, availability: "recorded" }, "stream");
    expect(e.tool).toMatchObject({ name: "文件修改", input: "/a/b", output: "/a/b\nx", status: "inProgress" });
    const pb = toolEvent({ kind: "other", name: "mcp_platform_browser_642a3c28_browser", status: "completed", rawInput: { action: "screenshot" }, rawOutput: { output: "{\"ok\":true,\"receiptId\":\"r-1\"}" } }, { key: "k2", source: "stream", parserVersion: "p", partial: false, availability: "recorded" }, "stream");
    expect(pb.tool).toMatchObject({ name: "platform_browser.browser", status: "completed", output: "{\"ok\":true,\"receiptId\":\"r-1\"}" });
  });

  it("antigravityQuotaNotice：只识别单行系统额度告警，不误判正常回复", () => {
    expect(antigravityQuotaNotice("\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h24m19s.\n"))
      .toBe("⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h24m19s.");
    expect(antigravityQuotaNotice("刚才看到了 Individual quota reached 的报错，原因是额度用尽。\n下一行解释细节")).toBeUndefined();
    expect(antigravityQuotaNotice("已完成检查，目前 quota 还有余量。")).toBeUndefined();
  });
});
