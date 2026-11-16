import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeDriver, claudeUsageLimits, projectSessionMessage } from "../src/claude.js";
import type { ClaudeSdkPort } from "../src/claude.js";
import { CodexAppServerClient } from "../src/codex-client.js";
import { CodexDriver, projectItem } from "../src/codex.js";
import type { ApprovalDecision, DriverApproval, DriverEvent, TurnSink } from "../src/driver.js";
import { bounded, redact } from "../src/redact.js";
import type { UsageRecord } from "../src/types.js";
import { summarizeUsage, dailyUsage } from "../src/usage.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.mjs");

function recordingSink(decide: (r: DriverApproval) => ApprovalDecision = () => ({ approve: true, reason: "" })) {
  const out = { native: [] as string[], turns: [] as string[], events: [] as DriverEvent[], usage: [] as UsageRecord[], approvals: [] as DriverApproval[], statuses: [] as string[], models: [] as string[] };
  const sink: TurnSink = {
    nativeSession: (id, info) => { out.native.push(id); if (info.effectiveModel) out.models.push(info.effectiveModel); },
    nativeTurn: (id) => { out.turns.push(id); },
    event: (e) => { out.events.push(e); },
    usage: (u) => { out.usage.push(u); },
    approval: async (r) => { out.approvals.push(r); return decide(r); },
    rateLimit: () => {},
    status: (s) => { out.statuses.push(s); }
  };
  return { sink, out };
}

const drivers: CodexDriver[] = [];
const codexFixtureRoots: string[] = [];
afterEach(async () => { for (const d of drivers.splice(0)) d.shutdown(); await new Promise(r => setTimeout(r, 30)); for (const root of codexFixtureRoots.splice(0)) rmSync(root,{recursive:true,force:true}); });

function codexDriver(scenario: string): CodexDriver {
  const root = mkdtempSync(join(tmpdir(), "codex-fixture-")); codexFixtureRoots.push(root);
  const d = new CodexDriver({
    binaryPath: process.execPath, evaluationRoot: join(root,"realms"),
    clientFactory: (_bin, options) => new CodexAppServerClient({ binaryPath: process.execPath, args: [FAKE], cwd: options?.cwd, env: { ...(options?.env ?? process.env as Record<string,string>), FAKE_SCENARIO: scenario, ...(options?.cwd === options?.env?.TMPDIR && options ? {FAKE_BOOTSTRAP_SKILLS:"1"} : {}) } })
  });
  drivers.push(d);
  return d;
}

describe("Codex 驱动 × 协议替身（F02）", () => {
  it.each([
    ["read-only", "read-only", "never", "user"],
    ["ask", "workspace-write", "on-request", "user"],
    ["auto-review", "workspace-write", "on-request", "auto_review"],
    ["full-access", "danger-full-access", "never", "user"]
  ] as const)("权限 %s 在 thread/start 与 resume 中实际传给 Codex", async (permissionMode, sandbox, approvalPolicy, approvalsReviewer) => {
    const d = codexDriver("normal");
    const client = await (d as unknown as { ensureClient: () => Promise<CodexAppServerClient> }).ensureClient();
    const { sink } = recordingSink();
    const h = await d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "perm-1", permissionMode }, sink);
    await h.done;
    const h2 = await d.startTurn({ nativeSessionId: "thr-1", workspace: "/tmp", prompt: "y", clientMessageId: "perm-2", permissionMode }, sink);
    await h2.done;
    const r = await client.request("debug/instructions", {}) as { calls: Array<Record<string, unknown>> };
    expect(r.calls).toHaveLength(2);
    for (const entry of r.calls) expect(entry).toMatchObject({ sandbox, approvalPolicy, approvalsReviewer });
  });

  it("创建 thread、发 turn、流式合并、用量快照、续聊沿原 ID、历史回读同 key", async () => {
    const d = codexDriver("normal");
    const { sink, out } = recordingSink();
    const h = await d.startTurn({ workspace: "/tmp", prompt: "第一轮", clientMessageId: "cm-1", model: "gpt-fake" }, sink);
    expect(out.native).toEqual(["thr-1"]);
    expect(out.models).toEqual(["gpt-fake"]);
    expect(out.turns).toEqual(["turn-thr-1-1"]);
    const r = await h.done;
    expect(r.status).toBe("completed");
    expect(r.terminalObserved).toBe(true);
    const partials = out.events.filter((e) => e.key === "codex:item:a-turn-thr-1-1" && e.partial);
    expect(partials.at(-1)!.text).toBe("正在处理");
    const final = out.events.filter((e) => e.key === "codex:item:a-turn-thr-1-1" && !e.partial).at(-1)!;
    expect(final.text).toBe("完成：第一轮");
    // 平台发的用户消息按 clientId 合并
    expect(out.events.some((e) => e.key === "user:cm-1" && e.role === "user")).toBe(true);
    expect(out.usage.at(-1)).toMatchObject({ usageScope: "session", counterMode: "cumulative", input: 100, cachedInput: 40, output: 50, total: 150, requestCount: 1 });
    // 本轮结束即退订，释放 Codex 的单写入者锁，不挡 CLI / Desktop
    const client = (d as unknown as { client: CodexAppServerClient }).client;
    await new Promise((r) => setTimeout(r, 20));
    expect(((await client.request("debug/unsubscribed", {})) as { threads: string[] }).threads).toContain("thr-1");
    // 续聊
    const { sink: s2, out: o2 } = recordingSink();
    const h2 = await d.startTurn({ nativeSessionId: "thr-1", workspace: "/tmp", prompt: "第二轮", clientMessageId: "cm-2" }, s2);
    expect(o2.native).toEqual(["thr-1"]);
    await h2.done;
    // 历史回读：同 key、带时间戳、按顺序
    const hist = await d.readHistory("thr-1");
    const keys = hist.events.map((e) => e.key);
    expect(keys).toContain("user:cm-1");
    expect(keys).toContain("codex:item:a-turn-thr-1-1");
    expect(hist.events.find((e) => e.key === "user:cm-2")!.occurredAt).toBe(new Date(1000).toISOString());
    expect(await d.findClientMessage("thr-1", "cm-2")).toBe(true);
    expect(await d.findClientMessage("thr-1", "nope")).toBe(false);
    const fp = await d.fingerprint("thr-1");
    expect(fp!.value).toBe("tturn-thr-1-2:completed");
    expect(fp).toMatchObject({lastTurnId:"turn-thr-1-2",lastTurnStatus:"completed",terminalObserved:true,active:false});
  });

  it("推理强度：模型报告可选值；turn/start 带上 effort，生效值从 thread/read 读回", async () => {
    const d = codexDriver("normal");
    const client = await (d as unknown as { ensureClient: () => Promise<CodexAppServerClient> }).ensureClient();
    const list = await client.request("model/list", {}) as { data: Array<{ supportedReasoningEfforts: unknown[] }> };
    expect(list.data[0]!.supportedReasoningEfforts).toHaveLength(2);
    const efforts: string[] = [];
    const { sink } = recordingSink();
    const orig = sink.nativeSession;
    sink.nativeSession = (id, info) => { if (info.effectiveEffort) efforts.push(`${info.effectiveEffort}@${info.effortSource}`); orig(id, info); };
    const h = await d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "ce-1", effort: "high" }, sink);
    await h.done;
    await new Promise((r) => setTimeout(r, 30));
    expect(efforts).toEqual(["high@thread/read（本轮开始后）", "high@thread/read（本轮结束时）"]);
    // 不指定：thread/start 回报的默认值
    const e2: string[] = [];
    const s2 = recordingSink().sink;
    s2.nativeSession = (_id, info) => { if (info.effectiveEffort) e2.push(`${info.effectiveEffort}@${info.effortSource}`); };
    await (await d.startTurn({ workspace: "/tmp", prompt: "y", clientMessageId: "ce-2" }, s2)).done;
    await new Promise((r) => setTimeout(r, 30));
    expect(e2).toEqual(["low@thread/start 响应", "low@thread/read（本轮结束时）"]);
  });

  it("审批经平台：拒绝传回 decline，命令未执行", async () => {
    const d = codexDriver("approval");
    const { sink, out } = recordingSink(() => ({ approve: false, reason: "no" }));
    const h = await d.startTurn({ workspace: "/tmp", prompt: "跑测试", clientMessageId: "cm-a" }, sink);
    await h.done;
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0]).toMatchObject({ kind: "command", action: "npm test" });
    expect(out.statuses).toContain("waiting-input");
    const cmd = out.events.filter((e) => e.key === "codex:item:c-turn-thr-1-1").at(-1)!;
    expect(cmd.tool!.status).toBe("declined");
  });

  it("插话：turn/steer 锁定这一轮，本轮出现带同一 clientId 的用户消息才算送达；本轮结束后拒绝", async () => {
    const d = codexDriver("slow");
    const client = await (d as unknown as { ensureClient: () => Promise<CodexAppServerClient> }).ensureClient();
    const delivered: string[] = [];
    const { sink, out } = recordingSink();
    const h = await d.startTurn({ workspace: "/tmp", prompt: "A", clientMessageId: "orig" }, { ...sink, steerDelivered: (id) => { delivered.push(id); out.events.push({ key: `delivered:${id}` } as DriverEvent); } });
    await new Promise((r) => setTimeout(r, 30));
    await h.steer!({ clientMessageId: "steer-x", prompt: "顺便检查测试" });
    await expect.poll(() => delivered).toEqual(["steer-x"]);
    // 先通知平台出队，再写入同 key 的用户消息
    const keys = out.events.map(e => e.key);
    expect(keys.indexOf("delivered:steer-x")).toBeLessThan(keys.indexOf("user:steer-x"));
    expect(out.events.find(e => e.key === "user:steer-x")).toMatchObject({ role: "user", text: "顺便检查测试" });
    await client.request("debug/finish", { threadId: out.native[0] });
    expect((await h.done).status).toBe("completed");
    await expect(h.steer!({ clientMessageId: "steer-late", prompt: "x" })).rejects.toThrow("本轮已在结束");
  });

  it("插话被收下但本轮没送达：不报送达（平台据此退回排队）", async () => {
    const d = codexDriver("slow-steer-lost");
    const client = await (d as unknown as { ensureClient: () => Promise<CodexAppServerClient> }).ensureClient();
    const delivered: string[] = [];
    const { sink, out } = recordingSink();
    const h = await d.startTurn({ workspace: "/tmp", prompt: "A", clientMessageId: "orig2" }, { ...sink, steerDelivered: (id) => delivered.push(id) });
    await new Promise((r) => setTimeout(r, 30));
    await h.steer!({ clientMessageId: "steer-y", prompt: "y" });
    await client.request("debug/finish", { threadId: out.native[0] });
    expect((await h.done).status).toBe("completed");
    expect(delivered).toEqual([]);
  });

  it("中断只发 turn/interrupt，共享进程里的其他 thread 不受影响", async () => {
    const d = codexDriver("slow");
    const a = recordingSink();
    const b = recordingSink();
    const ha = await d.startTurn({ workspace: "/tmp", prompt: "A", clientMessageId: "ca" }, a.sink);
    const hb = await d.startTurn({ workspace: "/tmp", prompt: "B", clientMessageId: "cb" }, b.sink);
    await new Promise((r) => setTimeout(r, 30));
    await ha.interrupt();
    expect((await ha.done).status).toBe("interrupted");
    let bDone = false;
    void hb.done.then(() => { bDone = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(bDone).toBe(false);
    await hb.interrupt();
    expect((await hb.done).status).toBe("interrupted");
  });

  it("探测：按协议描述核对能力，身份用稳定账号 ID，读取额度与配置摘要", async () => {
    const d = codexDriver("normal");
    // 协议描述由真实 CLI 生成：替身进程不支持 generate-json-schema，能力为 unknown，不能判为可执行
    const p = await d.probe();
    expect(p.identity).toMatchObject({ stableAccountId: "acct-fake", authMode: "chatgpt" });
    expect(p.models[0]).toMatchObject({ efforts: ["low", "high"], defaultEffort: "low" });
    expect(p.identity!.summary).toContain("s***@example.com");
    expect(p.rateLimit!.windows.map((w) => w.label)).toEqual(["5 小时窗口", "周窗口"]);
    expect(p.configSummary.join("\n")).toContain("demo");
    expect(p.state).toBe("incompatible");
  });

  it("进程退出：活动 turn 记为 interrupted，不伪造成功", async () => {
    const d = codexDriver("slow");
    const { sink } = recordingSink();
    const h = await d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "c" }, sink);
    d.shutdown();
    const r = await h.done;
    expect(r.status).toBe("interrupted");
    expect(r.reason).toContain("app-server 退出");
    expect(r.processEnded).toContain("app-server 进程已退出");
  });
});

describe("缺失、旧版与额度不足（V28-15）", () => {
  const OLD = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "old-codex.mjs");
  it("指定的 codex 不存在：未安装，不换用别的 codex", async () => {
    const d = new CodexDriver({ binaryPath: "/nonexistent/bin/codex" });
    const p = await d.probe();
    expect(p.state).toBe("not-installed");
    expect(p.stateReason).toContain("/nonexistent/bin/codex");
  });
  it("旧版 codex：按它自己的协议描述判定缺 thread/resume 与 turn/interrupt → 不兼容，禁止创建", async () => {
    const d = new CodexDriver({ binaryPath: OLD });
    drivers.push(d);
    const p = await d.probe();
    expect(p.binaryVersion).toBe("codex-cli 0.1.0-old");
    expect(p.capabilities.resume.status).toBe("unsupported");
    expect(p.capabilities.interrupt.status).toBe("unsupported");
    expect(p.capabilities.create.status).toBe("supported");
    expect(p.state).toBe("incompatible");
    expect(p.stateReason).toMatch(/resume.*interrupt|interrupt.*resume/);
  });
  it("额度用尽：turn 结果带结构化错误码 usageLimitExceeded", async () => {
    const d = codexDriver("quota");
    const { sink } = recordingSink();
    const r = await (await d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "cq" }, sink)).done;
    expect(r).toMatchObject({ status: "failed", code: "usageLimitExceeded" });
    expect(r.reason).toContain("usage limit");
  });
});

describe("Codex 历史按创建方过滤", () => {
  it("只列指定创建方的会话；没有创建方记录的不算匹配；不给过滤则全部列出", async () => {
    const d = codexDriver("normal");
    const all = await d.listHistory({ roots: ["/tmp"], limit: 100 });
    expect(all.items.map((i) => i.nativeSessionId).sort()).toEqual(["desk-1", "old-1"]);
    const only = await d.listHistory({ roots: ["/tmp"], limit: 100, originators: ["Codex Desktop", "codex_work_desktop"] });
    expect(only.items.map((i) => i.nativeSessionId)).toEqual(["desk-1"]);
    expect(only.items[0]).toMatchObject({ originator: "Codex Desktop" });
    expect(only.items[0]!.sourceLabel).toContain("Codex Desktop");
  });
});

describe("Codex rollout 用量回退与路径边界（F10 / V28-12）", () => {
  it("只读授权根内的 rollout，读末尾 token_count；越界与坏行安全", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      mkdirSync(join(home, "sessions"), { recursive: true });
      const f = join(home, "sessions", "r.jsonl");
      writeFileSync(f, [
        JSON.stringify({ type: "session_meta", payload: { creator_account_id: "acct-9" } }),
        "{坏行",
        JSON.stringify({ timestamp: "2026-09-30T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 } } } }),
        '{"type":"event_msg","payload":{"type":"token_count"' // 半行
      ].join("\n"));
      const d = new CodexDriver({ codexHome: home });
      const u = d.rolloutUsage(f);
      expect(u.record).toMatchObject({ input: 10, cachedInput: 4, output: 3, total: 13, counterMode: "cumulative", requestCount: 1 });
      expect(u.requestCount).toBe(1);
      expect(d.creatorAccountId(f)).toBe("acct-9");
      const outside = join(home, "elsewhere.jsonl");
      writeFileSync(outside, "{}");
      expect(d.rolloutUsage(outside).note).toContain("不在授权根内");
      expect(d.rolloutUsage(join(home, "sessions", "missing.jsonl")).note).toContain("不可用");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("Codex 记录投影", () => {
  it("累计快照带 requestCount 时，用量汇总直接采用（不再依赖单请求 delta）", () => {
    const at = new Date().toISOString();
    const s = summarizeUsage([
      { usageScope: "session", counterMode: "cumulative", raw: {}, input: 900, output: 100, total: 1000, requestCount: 7, semantics: "x", sourceRef: "codex:thread/tokenUsage/updated", sampledAt: at, reliability: "complete" }
    ]);
    expect(s.requestCount).toBe(7);
    expect(s.totals).toMatchObject({ input: 900, output: 100, total: 1000 });
  });
  it("可中断等待展示请求时长与生命周期，不再标记未采集", () => {
    const item = { type: "sleep", id: "sleep-1", durationMs: 60000 };
    expect(projectItem(item, "t", { partial: true, source: "stream" })).toMatchObject({
      kind: "notice", availability: "recorded", partial: true,
      text: "正在等待（请求 60 秒，可被新消息打断）"
    });
    expect(projectItem(item, "t", { partial: false, source: "history" })).toMatchObject({
      kind: "notice", availability: "recorded", partial: false,
      text: "等待已结束（请求 60 秒，可被新消息打断）"
    });
    expect(projectItem({ ...item, durationMs: 1500 }, "t", { partial: false, source: "history" })!.text).toContain("1.5 秒");
    for (const durationMs of [undefined, -1, "60000", Infinity]) {
      expect(projectItem({ ...item, durationMs }, "t", { partial: false, source: "history" })!.text).toBe("等待已结束（请求时长未提供，可被新消息打断）");
    }
  });
  it("未知类型保留为 unknown；推理只显示摘要；命令输出截断与脱敏", () => {
    expect(projectItem({ type: "brandNewThing", id: "z" }, "t", { partial: false, source: "history" })!.kind).toBe("unknown");
    expect(projectItem({ type: "reasoning", id: "r", summary: [], content: ["secret chain"] }, "t", { partial: false, source: "history" })).toMatchObject({ availability: "not_collected" });
    const big = "x".repeat(20_000) + " OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const e = projectItem({ type: "commandExecution", id: "c", command: "echo", status: "completed", aggregatedOutput: `token sk-proj-abcdefghijklmnopqrstuvwxyz123456 ${big}`, exitCode: 0 }, "t", { partial: false, source: "history" })!;
    expect(e.tool!.output!.length).toBeLessThan(9000);
    expect(e.tool!.output).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(e.truncated!.originalChars).toBeGreaterThan(20_000);
  });
});

/* ------------------------------ Claude ------------------------------ */

function fakeSdk(script: (prompt: AsyncIterable<unknown>, options: Record<string, unknown>) => AsyncGenerator<Record<string, unknown>>): ClaudeSdkPort & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    query: ((p: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      calls.push(p.options);
      const gen = script(p.prompt, p.options);
      return Object.assign(gen, {
        interrupt: async () => { (gen as unknown as { interrupted: boolean }).interrupted = true; },
        close: () => {},
        initializationResult: async () => ({ account: { email: "q@example.com", subscriptionType: "Claude Pro", apiProvider: "firstParty" }, models: [{ value: "default", displayName: "Default" }, { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5", supportsEffort: true, supportedEffortLevels: ["low", "high"] }] }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true, subscription_type: "pro", rate_limits: { five_hour: { utilization: 23, resets_at: "2026-10-01T05:00:00Z" }, seven_day: { utilization: 41, resets_at: null } } })
      });
    }) as unknown as ClaudeSdkPort["query"],
    listSessions: (async () => [
      { sessionId: "s-in", summary: "授权内", lastModified: 2000, cwd: "/tmp" },
      { sessionId: "s-out", summary: "授权外", lastModified: 1000, cwd: "/var/elsewhere-not-authorized" }
    ]) as unknown as ClaudeSdkPort["listSessions"],
    getSessionMessages: (async () => [
      { type: "user", uuid: "u1", session_id: "s", message: { role: "user", content: "看看这个" }, parent_tool_use_id: null, parent_agent_id: null, timestamp: "2026-09-30T01:00:00Z" },
      { type: "assistant", uuid: "a1", session_id: "s", message: { id: "msg_1", model: "claude-x", content: [{ type: "thinking", thinking: "", signature: "sig" }], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100 } }, parent_tool_use_id: null, parent_agent_id: null, timestamp: "2026-09-30T01:00:01Z" },
      { type: "assistant", uuid: "a2", session_id: "s", message: { id: "msg_1", model: "claude-x", content: [{ type: "text", text: "<script>alert(1)</script>好的" }], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100 } }, parent_tool_use_id: null, parent_agent_id: null, timestamp: "2026-09-30T01:00:02Z" },
      { type: "assistant", uuid: "a3", session_id: "s", message: { id: "msg_1", model: "claude-x", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100 } }, parent_tool_use_id: null, parent_agent_id: null, timestamp: "2026-09-30T01:00:03Z" },
      { type: "user", uuid: "u2", session_id: "s", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }] }, parent_tool_use_id: null, parent_agent_id: null, timestamp: "2026-09-30T01:00:04Z" }
    ]) as unknown as ClaudeSdkPort["getSessionMessages"],
    getSessionInfo: (async () => ({ sessionId: "s", summary: "x", lastModified: 1, fileSize: 10, cwd: "/tmp" })) as unknown as ClaudeSdkPort["getSessionInfo"]
  };
}

describe("Claude 插话（追加到输入流，合并进本轮）", () => {
  const ORIG = "11111111-1111-4111-8111-111111111111", STEER = "22222222-2222-4222-8222-222222222222";
  it("合并进来时（command_lifecycle started）即报送达；本轮结果出来后拒绝新插话", async () => {
    const seen: unknown[] = [];
    const sdk = fakeSdk(async function* (prompt, options) {
      const it = prompt[Symbol.asyncIterator]();
      seen.push((await it.next()).value);
      yield { type: "system", subtype: "init", session_id: options["sessionId"], model: "m" };
      const steer = (await it.next()).value as { uuid: string; message: { content: unknown } };
      seen.push(steer);
      yield { type: "command_lifecycle", command_uuid: steer.uuid, state: "queued" };
      yield { type: "command_lifecycle", command_uuid: steer.uuid, state: "started" };
      yield { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "alpha BANANA" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "alpha BANANA", user_message_uuids: [ORIG, steer.uuid] };
      await it.next();
    });
    const d = new ClaudeDriver({ sdk });
    const { sink, out } = recordingSink(); const delivered: string[] = [];
    const h = await d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: ORIG }, { ...sink, steerDelivered: (id) => { delivered.push(id); out.events.push({ key: `delivered:${id}` } as DriverEvent); } });
    await h.steer!({ clientMessageId: STEER, prompt: "加一句 BANANA" });
    await expect.poll(() => delivered).toEqual([STEER]);
    expect(seen[1]).toMatchObject({ type: "user", uuid: STEER, message: { role: "user", content: "加一句 BANANA" } });
    // 送达先于本轮的最终回复
    const at = (pred: (e: DriverEvent) => boolean) => out.events.findIndex(pred);
    await expect.poll(() => at(e => e.role === "assistant" && e.kind === "message")).toBeGreaterThan(-1);
    expect(at(e => e.key === `delivered:${STEER}`)).toBeLessThan(at(e => e.role === "assistant" && e.kind === "message"));
    await expect.poll(async () => { try { await h.steer!({ clientMessageId: "33333333-3333-4333-8333-333333333333", prompt: "late" }); return "accepted"; } catch (e) { return (e as Error).message; } }).toContain("本轮已在结束");
    expect((await h.done).status).toBe("completed");
  });

  it("结果出来时插话还没合并：保持本轮运行，等 Claude 处理完它（result 带它的 uuid）才收尾", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const sdk = fakeSdk(async function* (prompt, options) {
      const it = prompt[Symbol.asyncIterator]();
      await it.next();
      yield { type: "system", subtype: "init", session_id: options["sessionId"], model: "m" };
      await gate;
      const steer = (await it.next()).value as { uuid: string };
      yield { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "first" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "first", user_message_uuids: [ORIG] };
      await new Promise(r => setTimeout(r, 2000)); // 超过平台 1.5 秒的静默收尾窗口
      yield { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "follow-up" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "follow-up", user_message_uuids: [steer.uuid] };
      await it.next();
    });
    const d = new ClaudeDriver({ sdk });
    const { sink } = recordingSink(); const delivered: string[] = [];
    const h = await d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: ORIG }, { ...sink, steerDelivered: (id) => delivered.push(id) });
    await h.steer!({ clientMessageId: STEER, prompt: "late but accepted" });
    release();
    const r = await h.done;
    expect(r.status).toBe("completed");
    expect(delivered).toEqual([STEER]);
  });
});

describe("Claude 驱动 × SDK 替身（F03）", () => {
  it.each(["default", "acceptEdits", "plan", "bypassPermissions"] as const)("Claude 创建时的 %s 传给 SDK，续聊保持模式", async (permissionMode) => {
    const sdk = fakeSdk(async function* (_prompt, options) {
      yield { type: "system", subtype: "init", session_id: options["sessionId"] ?? options["resume"], model: "m" };
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    });
    const d = new ClaudeDriver({ sdk });
    const { sink } = recordingSink();
    const first = await d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "cc-1", permissionMode }, sink);
    await first.done;
    const nativeId = String(sdk.calls[0]!["sessionId"]);
    const next = await d.startTurn({ nativeSessionId: nativeId, workspace: "/tmp", prompt: "y", clientMessageId: "cc-2", permissionMode }, sink);
    await next.done;
    for (const options of sdk.calls) {
      expect(options["permissionMode"]).toBe(permissionMode);
      if (permissionMode === "bypassPermissions") expect(options["allowDangerouslySkipPermissions"]).toBe(true);
    }
    d.shutdown();
  });

  it("预分配 ID、default 权限、环境允许列表；流式片段与完整消息同 key；canUseTool 只放行一次", async () => {
    const sdk = fakeSdk(async function* (prompt, options) {
      const it = (prompt as AsyncIterable<{ uuid: string; message: { content: string } }>)[Symbol.asyncIterator]();
      const first = await it.next();
      yield { type: "system", subtype: "init", session_id: options["sessionId"], model: "claude-sonnet-5" };
      yield { type: "stream_event", event: { type: "message_start", message: { id: "msg_A" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "收到" } } };
      yield { type: "assistant", message: { id: "msg_A", model: "claude-sonnet-5", content: [{ type: "text", text: `收到：${first.value!.message.content}` }], usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 } }, parent_tool_use_id: null };
      // 最终输出 token 在 message_delta 里；之后再来的旧快照不能把它改小
      yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } } };
      yield { type: "assistant", message: { id: "msg_A", model: "claude-sonnet-5", content: [{ type: "text", text: "补充" }], usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 } }, parent_tool_use_id: null };
      const canUse = options["canUseTool"] as (n: string, i: unknown, o: Record<string, unknown>) => Promise<{ behavior: string; updatedPermissions?: unknown }>;
      const decision = await canUse("Bash", { command: "rm -rf /tmp/x" }, { signal: new AbortController().signal, toolUseID: "toolu_9", requestId: "req_9", title: "Claude 想运行 rm" });
      yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.31, resetsAt: 1790843529 } };
      yield { type: "result", subtype: "success", is_error: false, uuid: "res-1", usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.01, result: decision.behavior };
    });
    const d = new ClaudeDriver({ sdk });
    const rl: unknown[] = [];
    const { sink, out } = recordingSink((r) => ({ approve: r.action.startsWith("Bash"), reason: "" }));
    sink.rateLimit = (s) => { rl.push(s); };
    const h = await d.startTurn({ platformSessionId: "ps-claude-1", workspace: "/tmp", prompt: "你好", clientMessageId: "11111111-1111-1111-1111-111111111111", presetSessionId: "22222222-2222-2222-2222-222222222222", effort: "high" }, sink);
    const r = await h.done;
    expect(r.status).toBe("completed");
    const opts = sdk.calls[0]!;
    expect(opts["sessionId"]).toBe("22222222-2222-2222-2222-222222222222");
    expect(opts["permissionMode"]).toBe("default");
    expect(opts["effort"]).toBe("high");
    expect(opts["allowDangerouslySkipPermissions"]).toBeUndefined();
    const env = opts["env"] as Record<string, string>;
    expect(Object.keys(env).some((k) => /API_KEY|TOKEN|SECRET/.test(k))).toBe(false);
    // 会话里的命令（deploy-gui.sh --when-idle）据此回发部署结果
    expect(env["PI_AGENT_RUNTIME_SESSION_ID"]).toBe("ps-claude-1");
    expect(out.native).toEqual(["22222222-2222-2222-2222-222222222222"]);
    expect(out.models).toEqual(["claude-sonnet-5"]);
    const texts = out.events.filter((e) => e.key === "claude:text:msg_A:0");
    expect(texts[0]!.partial).toBe(true);
    expect(texts.at(-1)).toMatchObject({ partial: false, text: "收到：你好" });
    expect(out.approvals[0]!.title).toBe("Claude 想运行 rm");
    const reqs = out.usage.filter((u) => u.usageScope === "request");
    expect(reqs.at(-1)).toMatchObject({ requestId: "msg_A", input: 3, output: 40, cachedInput: 10, cacheCreation: 2 });
    expect(summarizeUsage(reqs).totals.output).toBe(40);
    expect((rl[0] as { windows: Array<{ usedPercent: number }> }).windows[0]!.usedPercent).toBe(31);
  });

  it("AskUserQuestion 变成选项面板：答案以题干为键写进 updatedInput.answers，多选逗号连接，跳过则拒绝", async () => {
    const asked = { questions: [
      { question: "用哪个库？", header: "库", multiSelect: false, options: [{ label: "dayjs", description: "轻量" }, { label: "luxon", description: "完整" }] },
      { question: "要哪些功能？", header: "功能", multiSelect: true, options: [{ label: "时区", description: "" }, { label: "相对时间", description: "" }] }
    ] };
    const results: Array<Record<string, unknown>> = [];
    const sdk = fakeSdk(async function* (prompt, options) {
      await (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: options["sessionId"], model: "claude-sonnet-5" };
      const canUse = options["canUseTool"] as (n: string, i: unknown, o: Record<string, unknown>) => Promise<Record<string, unknown>>;
      results.push(await canUse("AskUserQuestion", asked, { signal: new AbortController().signal, toolUseID: "toolu_q1", requestId: "req_q1" }));
      results.push(await canUse("AskUserQuestion", asked, { signal: new AbortController().signal, toolUseID: "toolu_q2" }));
      results.push(await canUse("AskUserQuestion", { questions: [] }, { signal: new AbortController().signal, toolUseID: "toolu_q3" }));
      yield { type: "result", subtype: "success", is_error: false, uuid: "res-q", usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const d = new ClaudeDriver({ sdk });
    let n = 0;
    const { sink, out } = recordingSink((r) => n++ === 0 ? { approve: true, reason: "", answers: { q1: ["luxon"], q2: ["时区", "相对时间"] } } : { approve: false, reason: "用户跳过" });
    const h = await d.startTurn({ workspace: "/tmp", prompt: "选库", clientMessageId: "33333333-3333-3333-3333-333333333333" }, sink);
    expect((await h.done).status).toBe("completed");
    expect(out.approvals).toHaveLength(2); // 空题目不会到平台
    expect(out.approvals[0]).toMatchObject({ kind: "question", questions: [
      { id: "q1", header: "库", multiSelect: false, allowOther: true, options: [{ label: "dayjs", description: "轻量" }, { label: "luxon", description: "完整" }] },
      { id: "q2", multiSelect: true }
    ] });
    expect(results[0]).toMatchObject({ behavior: "allow", updatedInput: { questions: asked.questions, answers: { "用哪个库？": "luxon", "要哪些功能？": "时区, 相对时间" } } });
    expect(results[1]).toMatchObject({ behavior: "deny", message: "用户跳过" });
    expect(results[2]).toMatchObject({ behavior: "deny" });
  });

  it("恢复时先来上一轮后台任务的 result：本轮不提前结束，以带本轮 uuid 的 result 为准，进程退出才结束", async () => {
    const sdk = fakeSdk(async function* (_prompt, options) {
      yield { type: "system", subtype: "init", session_id: options["resume"], model: "claude-sonnet-5" };
      // 上一轮后台任务的结算：不属于本轮
      yield { type: "result", subtype: "success", is_error: false, uuid: "r-old", user_message_uuids: ["previous-turn"], usage: { input_tokens: 1, output_tokens: 1 } };
      yield { type: "system", subtype: "session_state_changed", state: "running" };
      yield { type: "assistant", message: { id: "msg_B", model: "claude-sonnet-5", content: [{ type: "text", text: "1 2 3" }], usage: { input_tokens: 2, output_tokens: 9 } }, parent_tool_use_id: null };
      yield { type: "result", subtype: "error_during_execution", is_error: true, uuid: "r-mine", user_message_uuids: ["cm-mine"], errors: ["boom"], usage: { input_tokens: 2, output_tokens: 9 } };
    });
    const d = new ClaudeDriver({ sdk });
    const { sink, out } = recordingSink();
    const h = await d.startTurn({ nativeSessionId: "sess-1", workspace: "/tmp", prompt: "数数", clientMessageId: "cm-mine" }, sink);
    const r = await h.done;
    expect(r).toMatchObject({ status: "failed", reason: "boom" });
    // 本轮的回答在结束前已投影
    expect(out.events.some((e) => e.key === "claude:text:msg_B:0" && e.text === "1 2 3")).toBe(true);
  });

  it("本轮结果之后还有后台任务：保持运行，任务完成、Claude 回复后才结束", async () => {
    let inputClosedAt = 0; let bgDoneAt = 0;
    const sdk = fakeSdk(async function* (prompt, options) {
      const it = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await it.next();
      void it.next().then(() => { inputClosedAt = Date.now(); });
      yield { type: "system", subtype: "init", session_id: options["sessionId"], model: "m" };
      yield { type: "system", subtype: "task_started", task_id: "t1", is_backgrounded: true, description: "sleep 20" };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "bash", description: "sleep" }] };
      yield { type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "后台运行中" }] }, parent_tool_use_id: null };
      yield { type: "result", subtype: "success", is_error: false, uuid: "r1", user_message_uuids: ["cm-bg"] };
      await new Promise((r) => setTimeout(r, 1800)); // 比静默窗口长：后台任务未结束不能关输入
      bgDoneAt = Date.now();
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
      yield { type: "system", subtype: "task_notification", task_id: "t1", status: "completed", output_file: "/tmp/x", summary: "slept" };
      yield { type: "assistant", message: { id: "msg_2", content: [{ type: "text", text: "slept" }] }, parent_tool_use_id: null };
      yield { type: "result", subtype: "success", is_error: false, uuid: "r2" };
      while (!inputClosedAt) await new Promise((r) => setTimeout(r, 20)); // 真 CLI：输入关闭才退出
    });
    const d = new ClaudeDriver({ sdk });
    const { sink, out } = recordingSink();
    const h = await d.startTurn({ workspace: "/tmp", prompt: "后台 sleep", clientMessageId: "cm-bg" }, sink);
    const r = await h.done;
    expect(r.status).toBe("completed");
    expect(inputClosedAt).toBeGreaterThan(bgDoneAt);
    expect(out.events.some((e) => e.key === "claude:text:msg_2:0" && e.text === "slept")).toBe(true);
    expect(out.events.filter((e) => e.key === "claude:task:t1").at(-1)!.text).toContain("后台任务完成");
    const tasks = out.events.filter(e => e.key === "claude:task:t1");
    expect(tasks[0].backgroundTask).toMatchObject({ id: "t1", status: "running", description: "sleep 20" });
    expect(tasks.at(-1)!.backgroundTask).toMatchObject({ status: "completed", startedAt: tasks[0].backgroundTask!.startedAt, description: "sleep 20" });
    expect(Date.parse(tasks.at(-1)!.backgroundTask!.endedAt!)).toBeGreaterThanOrEqual(Date.parse(tasks[0].backgroundTask!.startedAt!));
  }, 15_000);

  it("续聊用 resume 沿原 ID；返回另一个 ID 时拒绝改绑", async () => {
    const sdk = fakeSdk(async function* () { yield { type: "system", subtype: "init", session_id: "different", model: "m" }; });
    const d = new ClaudeDriver({ sdk });
    const { sink } = recordingSink();
    await expect(d.startTurn({ nativeSessionId: "orig", workspace: "/tmp", prompt: "x", clientMessageId: "c" }, sink)).rejects.toThrow(/不静默改绑/);
    expect(sdk.calls[0]!["resume"]).toBe("orig");
  });

  it("进程启动即失败：抛出带阶段的错误", async () => {
    const sdk = fakeSdk(async function* () { throw new Error("not logged in"); });
    const d = new ClaudeDriver({ sdk });
    const { sink } = recordingSink();
    await expect(d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "c" }, sink)).rejects.toMatchObject({ stage: "create" });
  });

  it("历史：授权根过滤；拆块记录按 message.id 序号合并；同一请求的用量只计一次；HTML 原样当文本", async () => {
    const d = new ClaudeDriver({ sdk: fakeSdk(async function* () { /* 无 */ }) });
    const list = await d.listHistory({ roots: ["/tmp"], limit: 10 });
    expect(list.items.map((i) => i.nativeSessionId)).toEqual(["s-in"]);
    expect(list.items[0]!.status).toBe("unknown");
    const h = await d.readHistory("s-in", { workspace: "/tmp" });
    const keys = h.events.map((e) => e.key);
    expect(keys).toEqual(["user:u1", "claude:text:msg_1:0", "claude:text:msg_1:1", "claude:tool:toolu_1", "claude:tool:toolu_1"]);
    expect(h.events[1]).toMatchObject({ kind: "reasoning", availability: "redacted" });
    expect(h.events[2]!.text).toBe("<script>alert(1)</script>好的");
    const s = summarizeUsage(h.usage);
    expect(s.totals).toMatchObject({ input: 5, output: 7, cachedInput: 100 });
    expect(s.requestCount).toBe(1);
  });

  it("does not report an account identity when SDK initialization has no login", async () => {
    const sdk = fakeSdk(async function* () {});
    const query = sdk.query;
    sdk.query = ((args: Parameters<typeof query>[0]) => {
      const q = query(args);
      q.initializationResult = async () => ({ account: { apiProvider: "firstParty", tokenSource: "none", apiKeySource: "none" }, models: [] }) as never;
      return q;
    }) as typeof query;
    const d = new ClaudeDriver({ sdk });
    d.settingsSummary = async () => ["fake"];
    const p = await d.probe();
    expect(p.state).toBe("needs-login");
    expect(p.identity).toBeUndefined();
  });

  it.each([
    ["fresh endpoint", { rate_limits_available: true, rate_limits: { model_scoped: [], five_hour: { utilization: 20, resets_at: null } }, subscription_type: "pro" }, true],
    ["cached usage", { rate_limits_available: true, rate_limits: { five_hour: { utilization: 20, resets_at: null } }, subscription_type: "pro" }, false],
    ["unavailable usage", { rate_limits_available: false, rate_limits: null, subscription_type: "pro" }, false],
    ["403", new Error("403 Request not allowed"), false],
    ["401", new Error("401 OAuth access token has expired"), false],
    ["network failure", new Error("fetch failed"), false]
  ])("only proves authentication from a fresh usage endpoint response: %s", async (_name, response, verified) => {
    const sdk = fakeSdk(async function* () {}), query = sdk.query;
    sdk.query = ((args: Parameters<typeof query>[0]) => {
      const q = query(args);
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => {
        if (response instanceof Error) throw response;
        return response as never;
      };
      return q;
    }) as typeof query;
    const d = new ClaudeDriver({ sdk });
    d.settingsSummary = async () => ["fake"];
    expect((await d.probe()).authVerified === true).toBe(verified);
  });

  it("探测：订阅登录、模型列表、额度（实验接口，0-100）", async () => {
    const d = new ClaudeDriver({ sdk: fakeSdk(async function* () { /* 无 */ }) });
    d.settingsSummary = async () => ["fake"];
    const p = await d.probe();
    expect(p.state).toBe("executable");
    expect(p.identity!.stableAccountId).toBeUndefined();
    expect(p.identity!.summary).toContain("q***@example.com");
    expect(p.models.map((m) => m.id)).toEqual(["default", "sonnet"]);
    expect(p.models[1]!.efforts).toEqual(["low", "high"]);
    expect(p.models[0]!.efforts).toBeUndefined();
    expect(p.rateLimit).toMatchObject({ experimental: true, available: true });
    expect(p.rateLimit!.windows[0]).toMatchObject({ label: "5 小时窗口", usedPercent: 23 });
  });
});

describe("脱敏、截断与用量口径（V28-13/14/17）", () => {
  it("常见密钥被遮住，正文保留", () => {
    const r = redact("export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwx\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123\nghp_abcdefghijklmnopqrstuvwxyz0123 普通文本");
    expect(r.text).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(r.text).toContain("普通文本");
    expect(r.redactions).toBeGreaterThanOrEqual(3);
    const b = bounded("a".repeat(100), 10);
    expect(b.truncated!.originalChars).toBe(100);
  });

  it("没有请求时间的累计值不分到今天；跨日按请求时间归属", () => {
    const rec = (id: string, at: string | undefined, input: number): UsageRecord => ({ usageScope: "request", counterMode: "delta", raw: {}, input, output: 1, requestId: id, semantics: "", sourceRef: id, sampledAt: "x", reliability: "complete", ...(at ? { occurredAt: at } : {}) });
    const snap: UsageRecord = { usageScope: "session", counterMode: "cumulative", raw: {}, input: 999, semantics: "", sourceRef: "s", sampledAt: "2026-09-30T10:00:00Z", reliability: "complete" };
    const d = dailyUsage([rec("a", "2026-09-29T23:30:00-07:00", 10), rec("b", "2026-09-30T00:30:00-07:00", 20), rec("b", "2026-09-30T00:30:00-07:00", 20), snap], "America/Los_Angeles");
    expect(d.days).toEqual([{ day: "2026-09-29", input: 10, output: 1 }, { day: "2026-09-30", input: 20, output: 1 }]);
    expect(d.unattributed).toBe(1);
  });

  it("Claude 额度：不适用的认证方式显式不可用", () => {
    expect(claudeUsageLimits({ rate_limits_available: false, rate_limits: null, subscription_type: null })).toMatchObject({ available: false });
  });

  it("系统记录与压缩边界", () => {
    const out = projectSessionMessage({ type: "system", uuid: "s1", session_id: "s", message: { subtype: "compact_boundary" }, parent_tool_use_id: null, parent_agent_id: null } as never, new Map());
    expect(out.events[0]!.kind).toBe("compaction");
  });
});

describe("V3.0 角色指令的驱动通道", () => {
  it("Codex：thread/start 与 thread/resume 都带 developerInstructions；不带角色时不发该字段", async () => {
    const d = codexDriver("normal");
    const { sink } = recordingSink();
    await (await d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "ri-1", roleInstructions: "你是核查员" }, sink)).done;
    await (await d.startTurn({ nativeSessionId: "thr-1", workspace: "/tmp", prompt: "y", clientMessageId: "ri-2", roleInstructions: "你是核查员" }, recordingSink().sink)).done;
    await (await d.startTurn({ workspace: "/tmp", prompt: "z", clientMessageId: "ri-3" }, recordingSink().sink)).done;
    const client = (d as unknown as { client: CodexAppServerClient }).client;
    const { calls } = await client.request("debug/instructions", {}) as { calls: Array<{ method: string; developerInstructions: string | null }> };
    expect(calls.map((c) => `${c.method}:${c.developerInstructions}`)).toEqual(["thread/start:你是核查员", "thread/resume:你是核查员", "thread/start:null"]);
  });

  it("Claude：systemPrompt 用 claude_code 预设并附加角色；不带角色时不设 systemPrompt", async () => {
    const sdk = fakeSdk(async function* (_prompt, options) {
      yield { type: "system", subtype: "init", session_id: options["sessionId"] ?? options["resume"], model: "m" };
      yield { type: "result", subtype: "success", is_error: false, uuid: "r", user_message_uuids: ["cm-r"], usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const d = new ClaudeDriver({ sdk });
    await (await d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "cm-r", roleInstructions: "你是演示稿设计者" }, recordingSink().sink)).done;
    await (await d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "cm-r" }, recordingSink().sink)).done;
    expect(sdk.calls[0]!["systemPrompt"]).toEqual({ type: "preset", preset: "claude_code", append: "你是演示稿设计者" });
    expect(sdk.calls[1]!["systemPrompt"]).toBeUndefined();
  });
});

describe("Claude 进程非零退出时保留结构化错误码", () => {
  it("assistant 的 rate_limit 错误随失败结果带出（额度判定依据）", async () => {
    const sdk = fakeSdk(async function* (_prompt, options) {
      yield { type: "system", subtype: "init", session_id: options["sessionId"], model: "m" };
      yield { type: "assistant", error: "rate_limit", message: { id: "msg_L", model: "m", content: [{ type: "text", text: "You've hit your session limit" }], usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null };
      throw new Error("Claude Code process exited with code 1");
    });
    const d = new ClaudeDriver({ sdk });
    const r = await (await d.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "cm-q" }, recordingSink().sink)).done;
    expect(r).toMatchObject({ status: "failed", code: "rate_limit", processEnded: expect.stringContaining("exited with code 1") });
  });
  it.each(["current", "other", "missing", "background"])("SDK rewritten error result requires exact turn and no background work: %s", async (scenario) => {
    const sdk = fakeSdk(async function* (_prompt, options) {
      yield { type: "system", subtype: "init", session_id: options["sessionId"], model: "m" };
      yield { type: "assistant", error: "rate_limit", message: { id: "limit", content: [{ type: "text", text: "session limit" }] }, parent_tool_use_id: null };
      if (scenario === "background") yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "still-running" }] };
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["session limit"],
        ...(scenario === "missing" ? {} : { user_message_uuids: [scenario === "other" ? "other-turn" : "cm-error"] }) };
      throw new Error("Claude Code returned an error result: session limit");
    });
    const driver = new ClaudeDriver({ sdk });
    const result = await (await driver.startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "cm-error" }, recordingSink().sink)).done;
    expect(result).toMatchObject({ status: "failed", code: "rate_limit" });
    expect(result.terminalObserved === true).toBe(scenario === "current");
    expect(result.processEnded).toBeUndefined();
    driver.shutdown();
  });
  it("只有 SDK 报告的进程退出才算进程已结束；其他异常仍占名额", async () => {
    const sdk = fakeSdk(async function* (_prompt, options) {
      yield { type: "system", subtype: "init", session_id: options["sessionId"], model: "m" };
      throw new Error("transport closed unexpectedly");
    });
    const r = await (await new ClaudeDriver({ sdk }).startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "cm-t" }, recordingSink().sink)).done;
    expect(r.status).toBe("failed");
    expect(r.processEnded).toBeUndefined();
  });
});

describe("Claude 中断后无响应：平台关闭进程", () => {
  function hangingSdk(endOnClose: boolean) {
    let closed!: () => void;
    const closedP = new Promise<void>((res) => { closed = res; });
    const sdk = fakeSdk(async function* (_prompt, options) {
      yield { type: "system", subtype: "init", session_id: options["sessionId"], model: "m" };
      // 模拟卡在后台任务里、不理会 interrupt 的轮次
      await (endOnClose ? closedP : new Promise<void>(() => {}));
    });
    const query = sdk.query;
    sdk.query = ((p: unknown) => Object.assign((query as unknown as (p: unknown) => object)(p), { close: () => closed() })) as unknown as typeof sdk.query;
    return sdk;
  }
  afterEach(() => { vi.useRealTimers(); });

  it("关闭后消息流结束：算进程已结束（释放共享名额），不留结果未知", async () => {
    vi.useFakeTimers();
    const h = await new ClaudeDriver({ sdk: hangingSdk(true) }).startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "cm-k" }, recordingSink().sink);
    await h.interrupt();
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await h.done;
    expect(r).toMatchObject({ status: "interrupted", reason: "已按请求停止（进程已关闭）", processEnded: expect.stringContaining("SDK 消息流结束") });
  });

  it("关闭后消息流仍不结束：按结果未知收尾，不声称进程已结束", async () => {
    vi.useFakeTimers();
    const h = await new ClaudeDriver({ sdk: hangingSdk(false) }).startTurn({ workspace: "/tmp", prompt: "x", clientMessageId: "cm-h" }, recordingSink().sink);
    await h.interrupt();
    let settled = false;
    void h.done.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(8_000);
    const r = await h.done;
    expect(r.status).toBe("interrupted");
    expect(r.processEnded).toBeUndefined();
  });
});


it("Codex evaluator pins report-only cwd and sandbox on create and resume with tmp writes disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-evaluation-"));
  try {
    const workspace = join(root, "job"), input = join(root, "input"), reportDir = join(workspace, "report");
    mkdirSync(input); mkdirSync(reportDir, { recursive: true });
    const d = codexDriver("normal"), { sink } = recordingSink();
    const args = { platformSessionId: "eval-session", workspace, prompt: "evaluate", clientMessageId: "eval-one", evaluation: { inputRoots: [input], reportDir } };
    const h = await d.startTurn(args, sink); await h.done;
    const h2 = await d.startTurn({ ...args, nativeSessionId: "thr-1", clientMessageId: "eval-two" }, sink); await h2.done;
    const client = await (d as unknown as { clientForNative: (id:string) => Promise<CodexAppServerClient> }).clientForNative("thr-1");
    const { calls } = await client.request("debug/evaluation", {}) as { calls: Array<any> };
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.cwd).toMatch(/job\/report$/);
      expect(call.approvalPolicy).toBe("on-request");
      expect(call.approvalsReviewer).toBe("user");
      expect(call.environments).toEqual([{environmentId:"local",cwd:call.cwd,runtimeWorkspaceRoots:[call.cwd]}]);
      expect(call.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: [call.cwd], networkAccess: true, excludeSlashTmp: true, excludeTmpdirEnvVar: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "darwin")("Claude evaluator SDK spawn hook protects allowed tools and reuses native state on resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-driver-evaluation-"));
  try {
    const inputDir = join(root, "input"), workspace = join(root, "job"), reportDir = join(workspace, "reports");
    mkdirSync(inputDir); mkdirSync(reportDir, { recursive: true });
    const inputFile = join(inputDir, "delivery.txt"); writeFileSync(inputFile, "original");
    const sdk = fakeSdk(async function* (_prompt, options) {
      const spawnProcess = options["spawnClaudeCodeProcess"] as (options: any) => import("node:child_process").ChildProcess;
      const env = options["env"] as Record<string, string>;
      const child = spawnProcess({ command: "/bin/sh", args: ["-c", 'printf forged > "$INPUT"; printf pass > "$REPORT"; printf state > "$CLAUDE_CONFIG_DIR/native-state"'], cwd: workspace, env: { ...env, INPUT: inputFile, REPORT: join(reportDir, "report.json") }, signal: new AbortController().signal });
      await new Promise<void>((resolve, reject) => { child.on("exit", () => resolve()); child.on("error", reject); });
      yield { type: "system", subtype: "init", session_id: options["sessionId"] ?? options["resume"], model: "m" };
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    });
    const d = new ClaudeDriver({ sdk, evaluationRoot: join(root, "native") }), { sink } = recordingSink();
    const args = { workspace, prompt: "evaluate", clientMessageId: "cc-evaluation", evaluation: { inputRoots: [inputDir], reportDir } };
    const first = await d.startTurn(args, sink); await first.done;
    const id = String(sdk.calls[0]["sessionId"]);
    const second = await d.startTurn({ ...args, nativeSessionId: id, clientMessageId: "cc-resume" }, sink); await second.done;
    expect(readFileSync(inputFile, "utf8")).toBe("original");
    expect(readFileSync(join(reportDir, "report.json"), "utf8")).toBe("pass");
    const env = sdk.calls[0]["env"] as Record<string, string>;
    expect(readFileSync(join(env.CLAUDE_CONFIG_DIR, "native-state"), "utf8")).toBe("state");
    expect((sdk.calls[1]["env"] as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(env.CLAUDE_CONFIG_DIR);
    expect(sdk.calls[0]["settingSources"]).toEqual([]);
    expect(sdk.calls[0]["strictMcpConfig"]).toBe(true);
    d.shutdown();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Protocol substitutes prove host dispatch decisions, not native evaluator qualification.
it.each(["eval-input-write", "eval-network-denied", "eval-tmp-write", "eval-auto-review", "eval-instructions", "eval-wide-roots", "eval-missing-policy"].flatMap(scenario => [scenario, `resume-${scenario}`]))("Codex refuses model input when native effective protection differs: %s", async scenario => {
 const root=mkdtempSync(join(tmpdir(),"codex-eval-effective-"));
 try {
  const workspace=join(root,"job"), input=join(root,"input"), reportDir=join(workspace,"report");mkdirSync(input);mkdirSync(reportDir,{recursive:true});
  const d=codexDriver(scenario),{sink,out}=recordingSink();
  const args={platformSessionId:"eval-session",workspace,prompt:"protected input",clientMessageId:"effective-one",evaluation:{inputRoots:[input],reportDir}};
  if(scenario.startsWith("resume-"))await(await d.startTurn(args,sink)).done;
  await expect(d.startTurn({...args,...(scenario.startsWith("resume-")?{nativeSessionId:"thr-1",clientMessageId:"effective-two"}:{})},sink)).rejects.toMatchObject({stage:"create",nativeSessionId:"thr-1",notExecuted:true});
  const client=await(d as unknown as {clientForNative:(id:string)=>Promise<CodexAppServerClient>}).clientForNative("thr-1");
  expect((await client.request("debug/evaluation",{}) as {calls:unknown[]}).calls).toHaveLength(scenario.startsWith("resume-")?1:0);expect(out.native).toContain("thr-1");
 } finally {rmSync(root,{recursive:true,force:true});}
});
it("Codex evaluator constrains thread context on both create and original-ID resume",async()=>{
 const root=mkdtempSync(join(tmpdir(),"codex-eval-context-"));
 try {
  const workspace=join(root,"job"),input=join(root,"input"),reportDir=join(workspace,"report");mkdirSync(input);mkdirSync(reportDir,{recursive:true});
  const d=codexDriver("normal"),{sink}=recordingSink(),args={platformSessionId:"eval-session",workspace,prompt:"evaluate",clientMessageId:"ctx-one",evaluation:{inputRoots:[input],reportDir},roleInstructions:"confirmed evaluator role"};
  await(await d.startTurn(args,sink)).done;await(await d.startTurn({...args,nativeSessionId:"thr-1",clientMessageId:"ctx-two"},sink)).done;
  const client=await(d as unknown as {clientForNative:(id:string)=>Promise<CodexAppServerClient>}).clientForNative("thr-1");const {calls}=await client.request("debug/instructions",{}) as {calls:Array<any>};
  expect(calls).toHaveLength(3);
  for(const call of calls){expect(call.runtimeWorkspaceRoots).toEqual([realpathSync(reportDir)]);expect(call.developerInstructions).toBe("confirmed evaluator role");expect(call.config).toMatchObject({"project_doc_max_bytes":0,"features.hooks":false,"features.memories":false,"sandbox_workspace_write.network_access":true,"sandbox_workspace_write.exclude_slash_tmp":true,"sandbox_workspace_write.exclude_tmpdir_env_var":true});}
  expect(calls[0].dynamicTools).toEqual([]);expect(calls[0].selectedCapabilityRoots).toEqual([]);expect(calls[0].environments).toEqual([]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

it("Codex accepts the actual native implicit-cwd sandbox without requiring redundant write roots",async()=>{
 const root=mkdtempSync(join(tmpdir(),"codex-eval-implicit-"));
 try{const workspace=join(root,"job"),input=join(root,"input"),reportDir=join(workspace,"report");mkdirSync(input);mkdirSync(reportDir,{recursive:true});const d=codexDriver("eval-implicit-cwd"),{sink,out}=recordingSink();
 const result=await(await d.startTurn({platformSessionId:"eval-session",workspace,prompt:"evaluate",clientMessageId:"implicit-one",evaluation:{inputRoots:[input],reportDir}},sink)).done;expect(result.status).toBe("completed");expect(out.native).toContain("thr-1");
 }finally{rmSync(root,{recursive:true,force:true});}
});

describe("V3.3 只读工具限制", () => {
  it("Claude 群聊禁用写入/命令/子代理及环境 MCP，审批也不能提升为写权限", async () => {
    let decision: unknown;
    const sdk = fakeSdk(async function* (_prompt, options) {
      decision = await (options["canUseTool"] as any)("Write", { file_path: "/tmp/denied", content: "no" }, { toolUseID: "write1", signal: new AbortController().signal });
      yield { type: "system", subtype: "init", session_id: options["sessionId"], model: "m" };
      yield { type: "result", subtype: "success", is_error: false, uuid: "r", user_message_uuids: ["cm-ro"], usage: {} };
    });
    const d = new ClaudeDriver({ sdk }); const { sink, out } = recordingSink();
    await (await d.startTurn({ workspace: "/tmp", prompt: "尝试写入", clientMessageId: "cm-ro", permissionMode: "plan", readOnlyRoom: true }, sink)).done;
    expect(sdk.calls[0].tools).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    expect(sdk.calls[0].strictMcpConfig).toBe(true); expect(sdk.calls[0].mcpServers).toEqual({});
    expect(sdk.calls[0].disallowedTools).toContain("ExitPlanMode"); expect((decision as any).behavior).toBe("deny"); expect(out.approvals).toHaveLength(0);
  });

});

it("V3.4 Codex sends ordered native image content rather than paths", async () => {
  const d=codexDriver("normal"), {sink}=recordingSink();
  const images=[{mimeType:"image/png" as const,data:"aGVsbG8=",sha256:"a"},{mimeType:"image/jpeg" as const,data:"d29ybGQ=",sha256:"b"}];
  const h=await d.startTurn({workspace:"/tmp",prompt:"look",images,clientMessageId:"images-1",permissionMode:"read-only"},sink);
  const client=await (d as any).ensureClient(); const calls=await client.request("debug/evaluation");
  expect(calls.calls.at(-1).input).toEqual([{type:"text",text:"look",text_elements:[]},{type:"image",url:"data:image/png;base64,aGVsbG8="},{type:"image",url:"data:image/jpeg;base64,d29ybGQ="}]);
  await h.done;
});
it("V3.4 Claude sends native base64 image blocks and preserves order", async () => {
  let content:unknown;
  const sdk=fakeSdk(async function*(prompt,options){const first=await prompt[Symbol.asyncIterator]().next();content=(first.value as any).message.content;yield {type:"system",subtype:"init",session_id:options.sessionId,model:"claude-sonnet-5"};yield {type:"result",subtype:"success",is_error:false,uuid:"image-result",user_message_uuids:[(first.value as any).uuid],usage:{input_tokens:2,output_tokens:2}};});
  const d=new ClaudeDriver({sdk}),{sink}=recordingSink();
  const h=await d.startTurn({workspace:"/tmp",prompt:"",images:[{mimeType:"image/png",data:"aGVsbG8=",sha256:"a"}],clientMessageId:"claude-img",presetSessionId:"image-session"},sink);await h.done;
  expect(content).toEqual([{type:"image",source:{type:"base64",media_type:"image/png",data:"aGVsbG8="}}]);d.shutdown();
});
it('Claude registers the platform browser and denies screenshot scripts in PreToolUse before approvals',async()=>{
 const sdk=fakeSdk(async function*(_prompt,options){yield {type:'system',subtype:'init',session_id:options.sessionId,model:'m'};yield {type:'result',subtype:'success',session_id:options.sessionId,is_error:false,result:'done',duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1},modelUsage:{},permission_denials:[],uuid:'r'};});
 const d=new ClaudeDriver({sdk}),{sink}=recordingSink();
 const handle=await d.startTurn({workspace:'/tmp',prompt:'x',clientMessageId:'browser-policy',platformBrowser:{socketPath:'/tmp/browser.sock',bridgePath:'/host/bridge.mjs',hookPath:'/host/policy.mjs'}},sink);
 const options=sdk.calls[0] as any;
 expect(options.mcpServers.platform_browser.args).toEqual(['/host/bridge.mjs','/tmp/browser.sock']);
 const result=await options.hooks.PreToolUse[0].hooks[0]({hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{file_path:'/tmp/capture.mjs',content:'await page.screenshot()'}},'call',{});
 expect(result.hookSpecificOutput.permissionDecision).toBe('deny');await handle.done;d.shutdown();
});
