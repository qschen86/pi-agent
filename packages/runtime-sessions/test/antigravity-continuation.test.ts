import { createRequire } from "node:module";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readAntigravityContinuation } from "../src/antigravity-continuation.js";
import { AntigravityDriver } from "../src/antigravity.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dirs: string[] = [];
const drivers: AntigravityDriver[] = [];
afterEach(() => {
  for (const d of drivers.splice(0)) d.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
// Minimal native-shaped protobuf fixture, retaining task_notification's structured origin and execution group.
function vint(value: number): Buffer {
  const bytes: number[] = [];
  do { const n = value % 128; value = Math.floor(value / 128); bytes.push(n + (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function pb(values: Record<number, string | number | Buffer>): Buffer {
  return Buffer.concat(Object.entries(values).map(([key, v]) => {
    if (typeof v === "number") return Buffer.concat([vint(Number(key) * 8), vint(v)]);
    const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
    return Buffer.concat([vint(Number(key) * 8 + 2), vint(b.length), b]);
  }));
}
function fixture(sessionId = "session") {
  const home = mkdtempSync(join(tmpdir(), "agy-background-")); dirs.push(home);
  const conv = join(home, ".gemini", "antigravity-cli", "conversations"); mkdirSync(conv, { recursive: true });
  const path = join(conv, `${sessionId}.db`), db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)");
  const put = (idx: number, type: number, payload: Buffer, group = "prompt", status = 3, extraMeta: Record<number, string | number | Buffer> = {}) => db.prepare("INSERT OR REPLACE INTO steps VALUES (?, ?, ?, ?, ?)")
    .run(idx, type, status, pb({ 1: pb({ 1: 1795327210 + idx }), 12: group, ...extraMeta }), pb({ 1: type, 4: status, ...{ [type === 15 ? 20 : type === 101 ? 114 : 148]: payload } }));
  const task = (idx: number, opts: { daemonField?: boolean; daemonArg?: boolean; callId?: string } = {}) => {
    const payloadFields: Record<number, string | number | Buffer> = { 1: `${sessionId}/task-${idx}` };
    if (opts.daemonField) payloadFields[6] = 1;
    const extraMeta: Record<number, string | number | Buffer> = {};
    if (opts.daemonArg) extraMeta[4] = pb({ 1: opts.callId ?? `call-${idx}`, 2: "run_command", 3: JSON.stringify({ CommandLine: "npm run dev", IsDaemon: true }) });
    put(idx, 132, pb(payloadFields), "prompt", opts.daemonField || opts.daemonArg ? 2 : 3, extraMeta);
  };
  const notify = (idx: number, taskIdx: number, call = `call-${taskIdx}`, group = `task-${taskIdx}`, originSession = sessionId) => {
    put(idx, 101, pb({ 1: `任务 ${taskIdx} 完成`, 3: "task_notification", 4: pb({
      2: originSession, 3: `${sessionId}/task-${taskIdx}`, 12: pb({ 1: pb({ 1: sessionId, 2: taskIdx, 3: pb({ 1: call }) }) })
    }) }), group);
  };
  const reply = (idx: number, taskIdx: number, content = "测试通过", status = 3) => put(idx, 15, pb({ 1: content }), `task-${taskIdx}`, status);
  const bgTool = (idx: number, group: string, opts: { callId: string; name: string; args?: Record<string, unknown>; status?: number; output?: string; error?: string; bgTask?: boolean; daemon?: boolean }) => {
    const status = opts.status ?? 3;
    const payload: Record<number, string | number | Buffer> = { 1: 132, 4: status };
    if (opts.output) payload[140] = pb({ 2: pb({ 1: opts.output }) });
    if (opts.error) payload[31] = pb({ 2: opts.error });
    if (opts.bgTask) {
      const t: Record<number, string | number | Buffer> = { 1: `${sessionId}/task-${idx}` };
      if (opts.daemon) t[6] = 1;
      payload[148] = pb(t);
    }
    const meta4 = pb({ 1: opts.callId, 2: opts.name, 3: JSON.stringify(opts.args ?? {}) });
    db.prepare("INSERT OR REPLACE INTO steps VALUES (?, ?, ?, ?, ?)")
      .run(idx, 132, status, pb({ 1: pb({ 1: 1795327210 + idx }), 4: meta4, 12: group }), pb(payload));
  };
  put(0, 14, pb({ 1: "执行测试" })); task(1); put(2, 15, pb({ 1: "测试中" })); task(3); put(4, 15, pb({ 1: "等待后台结果" }));
  const driver = new AntigravityDriver({ home, fingerprintSettleMs: 1 });
  drivers.push(driver);
  const read = (previous = "s5i4", ids = ["call-1", "call-3"]) => driver.readContinuation(sessionId, { previous, toolCallIds: ids, endedAt: "2026-11-22T06:00:00.000Z" });
  const readDb = (previous = "s5i4", ids = ["call-1", "call-3"]) => readAntigravityContinuation(path, sessionId, previous, ids, "2026-11-22T06:00:00.000Z");
  return { home, path, db, driver, read, readDb, put, task, notify, reply, bgTool };
}

describe("Antigravity 本轮后台续写来源核对", () => {
  it("复现：两项后台测试完成后新增 4 条，按任务、工具调用与执行组回填，WAL 未 checkpoint 也可读", async () => {
    const f = fixture();
    try {
      f.notify(5, 1); f.reply(6, 1, "Android 通过"); f.notify(7, 3); f.reply(8, 3, "全部通过");
      // A new driver (host restart) needs only persisted native evidence and platform-owned tool call IDs.
      const result = await f.read();
      expect(result).toMatchObject({ fingerprint: "s9i8", active: false, pending: false });
      expect(result!.events.map(e => [e.kind, e.text])).toEqual([["notice", "任务 1 完成"], ["message", "Android 通过"], ["notice", "任务 3 完成"], ["message", "全部通过"]]);
      expect(result!.events.every(e => e.key.startsWith("antigravity:step:session:") && e.occurredAt && !e.partial)).toBe(true);
      expect((await f.read("s9i8"))!.events.map(e => e.key)).toEqual(result!.events.map(e => e.key));
    } finally { f.db.close(); }
  });

  it("任务仍待完成与同一回复的 partial → complete，不提前认为会话可以续聊", () => {
    const f = fixture();
    try {
      expect(f.readDb()).toMatchObject({ events: [], pending: true, active: false });
      f.notify(5, 1);
      expect(f.readDb()).toMatchObject({ active: true, pending: true });
      f.reply(6, 1, "正在汇报", 1);
      const partial = f.readDb();
      expect(partial!.events.at(-1)).toMatchObject({ text: "正在汇报", partial: true });
      f.reply(6, 1, "Android 通过");
      expect(f.readDb()).toMatchObject({ active: false, pending: true });
      // First notification already in baseline; second response must still carry its execution group.
      expect(f.readDb("s6i5")!.events.at(-1)?.text).toBe("Android 通过");
    } finally { f.db.close(); }
  });

  it("IsDaemon 常驻任务不计入 pending，避免永远拦住续聊；daemon 意外退出通知仍可正常归属", () => {
    const f = fixture();
    try {
      // 把原本两个任务改成常驻进程（分别覆盖 protobuf field 6 和 metadata.toolCall.IsDaemon 两种信号）
      f.task(1, { daemonField: true });
      f.task(3, { daemonArg: true });
      expect(f.readDb()).toMatchObject({ events: [], pending: false, active: false });
      // 同轮再挂一个普通后台任务时，pending 仍为 true
      f.task(5);
      expect(f.readDb("s6i5", ["call-1", "call-3", "call-5"])).toMatchObject({ pending: true, active: false });
      // 普通任务回报完成后，即使两个 daemon 仍未回报，pending 也归零；daemon 稍后退出通知也能安全归属
      f.notify(6, 5); f.reply(7, 5, "检查通过");
      expect(f.readDb("s6i5", ["call-1", "call-3", "call-5"])).toMatchObject({ fingerprint: "s8i7", pending: false, active: false });
      f.notify(8, 1); f.reply(9, 1, "服务已停止");
      expect(f.readDb("s8i7", ["call-1", "call-3", "call-5"])).toMatchObject({ fingerprint: "s10i9", pending: false, active: false });
    } finally { f.db.close(); }
  });

  it("仅承载该会话的 agy 进程仍存活时才上报 pending；进程退出或重启后不再永久拦截", async () => {
    const f = fixture("sess-0");
    try {
      const bin = join(f.home, "agy");
      writeFileSync(bin, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
  if (m.method === "session/new") return send({ id: m.id, result: { sessionId: "sess-0", modes: { currentModeId: "default" }, configOptions: [] } });
  if (m.method === "session/set_mode") return send({ id: m.id, result: {} });
  if (m.method === "session/prompt") return send({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } });
  send({ id: m.id, result: {} });
});
`);
      chmodSync(bin, 0o755);
      const liveDriver = new AntigravityDriver({ binaryPath: bin, home: f.home, fingerprintSettleMs: 1 });
      drivers.push(liveDriver);
      const sink: any = { nativeSession() {}, nativeTurn() {}, event() {}, usage() {}, rateLimit() {}, status() {}, approval: async () => ({ approve: true, reason: "ok" }) };
      const handle = await liveDriver.startTurn({ workspace: f.home, prompt: "go", clientMessageId: "m1" }, sink);
      expect((await handle.done).status).toBe("completed");
      // agy 进程在 linger 期间仍存活：未完成的普通后台任务正常上报 pending: true
      expect(await liveDriver.readContinuation("sess-0", { previous: "s5i4", toolCallIds: ["call-1", "call-3"], endedAt: "2026-11-22T06:00:00.000Z" }))
        .toMatchObject({ pending: true, active: false });
      // 模拟 agy 进程退出 / 平台重启：不再上报 pending 或 active
      liveDriver.shutdown();
      expect(await liveDriver.readContinuation("sess-0", { previous: "s5i4", toolCallIds: ["call-1", "call-3"], endedAt: "2026-11-22T06:00:00.000Z" }))
        .toMatchObject({ pending: false, active: false });
      // 新建 driver（模拟服务重启）读取同一库时也不被卡住，且已写盘的 partial 回复仍可回填并标非活跃
      f.notify(5, 1); f.reply(6, 1, "写到一半进程断了", 1);
      const afterRestart = await f.read();
      expect(afterRestart).toMatchObject({ fingerprint: "s7i6", pending: false, active: false });
      expect(afterRestart!.events.at(-1)?.text).toBe("写到一半进程断了");
    } finally { f.db.close(); }
  });

  it("复现：后台任务唤醒后在同一执行组继续调工具（含失败 status=7 与空文本规划步）不误判外部写入", () => {
    const f = fixture();
    try {
      f.notify(5, 1);
      f.reply(6, 1, ""); // 仅发起 tool_call 的规划步：无文本正文，不应投影出空白消息
      f.bgTool(7, "task-1", { callId: "call-read-1", name: "read_file", args: { Path: "/repo/a.ts" }, status: 3, output: "line 1" });
      f.reply(8, 1, "");
      f.bgTool(9, "task-1", { callId: "call-cmd-1", name: "run_command", args: { CommandLine: "npx vitest" }, status: 7, error: "permission check failed" });
      const res = f.readDb("s5i4", ["call-1"]);
      expect(res).toMatchObject({ fingerprint: "s10i9", active: false, pending: true }); // task-3 仍待完成
      expect(res!.events.map(e => [e.kind, e.kind === "tool" ? `${e.tool?.name}:${e.tool?.status}:${e.tool?.input}` : e.text])).toEqual([
        ["notice", "任务 1 完成"],
        ["tool", "读取文件:completed:/repo/a.ts"],
        ["tool", "命令:failed:npx vitest"],
      ]);
      expect(res!.events.at(-1)?.tool?.output).toContain("permission check failed");
      expect(res!.events.at(-1)?.partial).toBe(false);
    } finally { f.db.close(); }
  });

  it("后台唤醒工具执行中保持 active，基线推进后同执行组后续回复与链式新后台任务均可继续归属", () => {
    const f = fixture();
    try {
      // 去掉 task-3 让 pending 仅受当前链影响
      f.db.prepare("DELETE FROM steps WHERE idx IN (3, 4)").run();
      f.notify(5, 1);
      f.reply(6, 1, "");
      // 1) 工具还在运行中（status=2）：active=true
      f.bgTool(7, "task-1", { callId: "call-chain", name: "run_command", args: { CommandLine: "npm test" }, status: 2 });
      const running = f.readDb("s3i2", ["call-1"]);
      expect(running).toMatchObject({ fingerprint: "s6i7", active: true, pending: false });
      expect(running!.events.at(-1)).toMatchObject({ kind: "tool", partial: true, tool: { status: "inProgress" } });
      // 2) 工具转为新的后台任务（status=6 + field 148）：active=false 但 pending=true，基线可推进到 s6i7
      f.bgTool(7, "task-1", { callId: "call-chain", name: "run_command", args: { CommandLine: "npm test" }, status: 6, bgTask: true });
      const bgPending = f.readDb("s3i2", ["call-1"]);
      expect(bgPending).toMatchObject({ fingerprint: "s6i7", active: false, pending: true });
      // 3) 基线已推进到 s6i7 后，同执行组的文本回复以及新后台任务的完成通知都能被结构化证明链放行
      f.reply(8, 1, "等待新测试完成");
      expect(f.readDb("s6i7", ["call-1"])).toMatchObject({ fingerprint: "s7i8", active: false, pending: true });
      f.notify(9, 7, "call-chain", "task-7");
      f.reply(10, 7, "第二轮后台测试全部通过");
      const done = f.readDb("s7i8", ["call-1"]);
      expect(done).toMatchObject({ fingerprint: "s9i10", active: false, pending: false });
      expect(done!.events.at(-1)?.text).toBe("第二轮后台测试全部通过");
    } finally { f.db.close(); }
  });

  it("实时续写先到、SQLite 后落盘：接收不依赖补读，落盘追上后才交接并记录去重游标", async () => {
    const f = fixture("sess-0");
    const bin = join(f.home, "agy");
    writeFileSync(bin, `#!/usr/bin/env node
const readline = require("node:readline");
const send = m => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...m})+"\\n");
readline.createInterface({input:process.stdin}).on("line", line => {
  const m=JSON.parse(line);
  if(m.method==="initialize") return send({id:m.id,result:{protocolVersion:1}});
  if(m.method==="session/new") return send({id:m.id,result:{sessionId:"sess-0",modes:{currentModeId:"default"},configOptions:[]}});
  if(m.method==="session/prompt") {
    send({id:m.id,result:{stopReason:"end_turn"}});
    setTimeout(()=>send({method:"session/update",params:{sessionId:"sess-0",update:{sessionUpdate:"agent_message_chunk",content:{text:"全部通过"}}}}),20);
    return;
  }
  send({id:m.id,result:{}});
});
`);
    chmodSync(bin, 0o755);
    const live = new AntigravityDriver({ binaryPath: bin, home: f.home }); drivers.push(live);
    const events: any[] = [];
    const sink: any = { nativeSession() {}, nativeTurn() {}, event(e: any) { events.push(e); }, usage() {}, rateLimit() {}, status() {}, approval: async () => ({approve:true}) };
    try {
      const h = await live.startTurn({workspace:f.home,prompt:"go",clientMessageId:"original"},sink);
      await h.done;
      for(let i=0;i<80 && !events.length;i++) await new Promise(r=>setTimeout(r,10));
      expect(events).toMatchObject([{text:"全部通过",source:"stream",partial:true}]);
      // Even after native tasks finish, a snapshot without the streamed final reply cannot settle the channel.
      f.notify(5,1); f.reply(6,1,"第一项通过"); f.notify(7,3); f.reply(8,3,"旧回复");
      expect(await live.readContinuation("sess-0",{previous:"s5i4",toolCallIds:["call-1","call-3"],endedAt:"2026-11-22T06:00:00Z"})).toMatchObject({active:true});
      expect(live.continuationState("sess-0")?.active).toBe(true);
      f.reply(8,3,"全部通过");
      expect(await live.readContinuation("sess-0",{previous:"s5i4",toolCallIds:["call-1","call-3"],endedAt:"2026-11-22T06:00:00Z"})).toMatchObject({active:false,pending:false,streamedKeys:["antigravity:step:sess-0:8"]});
      expect(live.continuationState("sess-0")?.active).toBe(false);
      expect(events.at(-1)).toMatchObject({text:"全部通过",partial:false});
      // A later identical native reply that was not streamed must remain in recovery.
      f.reply(9,3,"全部通过");
      const later = await live.readContinuation("sess-0",{previous:"s9i8",toolCallIds:["call-1","call-3"],endedAt:"2026-11-22T06:00:00Z"});
      expect(later!.streamedKeys).not.toContain("antigravity:step:sess-0:9");
      expect(later!.events.some(e=>e.key==="antigravity:step:sess-0:9")).toBe(true);
      live.shutdown(); await h.continuationDone;
      // A fresh process uses the persisted native proof, not a blanket trust in the previous connection.
      expect(await f.read("s9i8")).toMatchObject({active:false,pending:false});
    } finally { f.db.close(); }
  });

  it("原生提醒插入已证明的执行组时保留来源链，推进基线后仍能核对后续回复", () => {
    const f = fixture();
    try {
      f.notify(5, 1); f.reply(6, 1);
      const reminder = (idx: number, session = "session", group = "task-1") => f.put(idx, 101,
        pb({ 1: "runtime reminder", 3: "work_efficiently_reminder" }), group, 3,
        { 3: 5, 20: pb({ 2: idx, 4: session }) });
      reminder(7); f.reply(8, 1, "后续回复");
      expect(f.readDb()).toMatchObject({ fingerprint: "s9i8", active: false });
      f.reply(9, 1, "再次续写");
      expect(f.readDb("s9i8")!.events.at(-1)?.text).toBe("再次续写");
      reminder(7, "foreign");
      expect(f.readDb()).toBeUndefined();
      reminder(7, "session", "foreign-group");
      expect(f.readDb()).toBeUndefined();
    } finally { f.db.close(); }
  });

  it.each(["user", "unknown", "assistant", "foreign-task", "foreign-session", "foreign-group", "foreign-group-tool", "unmeta-tool", "unowned-call", "malformed", "missing-task", "old-turn-task"])("%s 混入新增记录时整批拒绝，不放行部分合法记录", async kind => {
    const f = fixture();
    try {
      f.notify(5, 1); f.reply(6, 1);
      if (kind === "user") f.put(7, 14, pb({ 1: "外部用户续聊" }));
      if (kind === "unknown") f.put(7, 999, Buffer.alloc(0));
      if (kind === "assistant") f.reply(7, 99);
      if (kind === "foreign-task") f.notify(7, 999);
      if (kind === "foreign-session") f.notify(7, 3, "call-3", "task-3", "other-session");
      if (kind === "foreign-group") f.reply(6, 3);
      if (kind === "foreign-group-tool") f.bgTool(7, "task-99", { callId: "c-bad", name: "run_command", args: { CommandLine: "id" } });
      if (kind === "unmeta-tool") f.put(7, 132, pb({ 1: "bad" }), "task-1");
      if (kind === "unowned-call") f.notify(7, 3, "unowned");
      if (kind === "malformed") f.put(7, 101, Buffer.from([255]));
      if (kind === "missing-task") f.db.prepare("DELETE FROM steps WHERE idx=1").run();
      if (kind === "old-turn-task") f.put(2, 14, pb({ 1: "新的用户轮次" }));
      expect(await f.read()).toBeUndefined();
    } finally { f.db.close(); }
  });

  it("不凭通知正文、旧格式指纹或没有平台工具证据放行", async () => {
    const f = fixture();
    try {
      f.put(5, 101, pb({ 1: 'sender=session/task-1 Task id "session/task-1" finished with result: OK', 3: "task_notification" }), "task-1");
      f.reply(6, 1);
      expect(await f.read()).toBeUndefined();
      expect(await f.read("123:456:0")).toBeUndefined();
      expect(await f.read("s5i4", [])).toBeUndefined();
      expect(await f.driver.readContinuation("../session", { previous: "s5i4", toolCallIds: ["call-1"], endedAt: "2026-11-22T06:00:00Z" })).toBeUndefined();
    } finally { f.db.close(); }
  });
});
