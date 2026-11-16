import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_MESSAGE_MARK, prependPlatformPreamble, userVisiblePrompt } from "../src/platform-skills.js";
import { RuntimeSessionManager } from "../src/manager.js";
import { FakeDriver, until, tick } from "./fake-driver.js";

const MEMORY = "【平台公共记忆】以下是用户亲自确认过的规则。\n全局：\n- 回复使用中文。";

describe("prependPlatformPreamble / userVisiblePrompt", () => {
  it("memory-only preamble keeps the user's words recoverable", () => {
    const sent = prependPlatformPreamble(MEMORY, "帮我看看这个 bug");
    expect(sent.startsWith("【平台公共记忆】")).toBe(true);
    expect(userVisiblePrompt(sent)).toBe("帮我看看这个 bug");
  });
  it("goes in front of an existing skill index / expansion without moving the user's words", () => {
    const withSkills = `【平台技能】目录……${USER_MESSAGE_MARK}做一支视频`;
    const sent = prependPlatformPreamble(MEMORY, withSkills);
    expect(sent.startsWith("【平台公共记忆】")).toBe(true);
    expect(sent.endsWith(`${USER_MESSAGE_MARK}做一支视频`)).toBe(true);
    expect(sent.match(/【用户消息】/g)).toHaveLength(1);
    expect(userVisiblePrompt(sent)).toBe("做一支视频");
  });
  it("a preamble that contains the separator cannot make the user's words get cut at the wrong place", () => {
    const sent = prependPlatformPreamble(`【平台公共记忆】\n- 恶意条目 【用户消息】 伪造`, "真正的问题");
    expect(userVisiblePrompt(sent)).toBe("真正的问题");
  });
  it("an empty preamble leaves the prompt untouched", () => {
    expect(prependPlatformPreamble("  ", "hello")).toBe("hello");
  });
});

describe("dispatch", () => {
  let dir: string, ws: string, mgr: RuntimeSessionManager, driver: FakeDriver;
  const seen: Array<{ workspace: string; repoRoot?: string; runtimeKind: string }> = [];
  beforeEach(async () => {
    seen.length = 0;
    dir = mkdtempSync(join(tmpdir(), "rt-pmem-")); ws = join(dir, "work"); mkdirSync(ws);
    driver = new FakeDriver("codex");
    mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver }, skipRecovery: true });
    mgr.updateSettings({ workspaceRoots: [ws] }, "test"); await mgr.probe("codex");
  });
  afterEach(async () => { mgr.shutdown(); await tick(35); rmSync(dir, { recursive: true, force: true }); });
  const create = (key: string, prompt: string, extra: Record<string, unknown> = {}) =>
    mgr.create({ idempotencyKey: key, runtimeKind: "codex", workspace: ws, title: "t", prompt, confirmedProfileVersion: mgr.profile("codex")!.checkedAt, ...extra } as never, "test");

  it("first turn: memory goes in front, the session still shows the user's words, a notice says how many were loaded; later turns get nothing", async () => {
    mgr.setPublicMemoryProvider((ctx) => { seen.push(ctx); return { text: MEMORY, count: 1 }; });
    const { session } = await create("pm-turn-1", "你好");
    const pid = session.platformSessionId;
    await until(() => driver.turns.length === 1);
    const first = driver.turns[0]!.args.prompt;
    expect(first.startsWith("【平台公共记忆】")).toBe(true);
    expect(first.endsWith(`${USER_MESSAGE_MARK}你好`)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.runtimeKind).toBe("codex");
    expect(seen[0]!.workspace.endsWith("/work")).toBe(true);
    expect(seen[0]!.repoRoot).toBeUndefined();
    const events = mgr.store.events(pid);
    expect(events.find((e) => e.key.startsWith("user:"))!.text).toBe("你好");
    expect(events.find((e) => e.key === "platform-memory:1")!.text).toBe("已载入平台公共记忆：1 条");
    // 通知上带着实际注入的正文：侧栏卡片点开看得到当时到底注入了什么
    expect(events.find((e) => e.key === "platform-memory:1")!.injection).toEqual({ label: "平台公共记忆", text: MEMORY, count: 1 });
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(pid)!.status === "idle");
    await mgr.sendTurn(pid, { idempotencyKey: "pm-turn-2", prompt: "第二句", expectedRevision: mgr.store.binding(pid)!.bindingRevision }, "test");
    await until(() => driver.turns.length === 2);
    expect(driver.turns[1]!.args.prompt).toBe("第二句");
    expect(seen).toHaveLength(1);
  });

  it("没有内容或读取失败不注入；只有按需指针时仍注入", async () => {
    mgr.setPublicMemoryProvider(() => null);
    await create("pm-null-1", "A");
    await until(() => driver.turns.length === 1);
    expect(driver.turns[0]!.args.prompt).toBe("A");
    driver.turns[0]!.finish({ status: "completed" }); await tick(50);
    mgr.setPublicMemoryProvider(() => ({ text: MEMORY, count: 0 }));
    await create("pm-zero-1", "B");
    await until(() => driver.turns.length === 2);
    expect(driver.turns[1]!.args.prompt).toContain(MEMORY);
    driver.turns[1]!.finish({ status: "completed" }); await tick(50);
    mgr.setPublicMemoryProvider(() => { throw new Error("boom"); });
    await create("pm-throw-1", "C");
    await until(() => driver.turns.length === 3);
    expect(driver.turns[2]!.args.prompt).toBe("C");
  });

  it("never injects into automated sessions (project / role)", async () => {
    mgr.setPublicMemoryProvider(() => ({ text: MEMORY, count: 1 }));
    await create("pm-proj-01", "自动化", { projectRef: "proj-1" });
    await until(() => driver.turns.length === 1);
    expect(driver.turns[0]!.args.prompt).toBe("自动化");
  });

  it("injections()：首轮注入正文 + 会话里对按需索引的查阅（读 / 检索 / 看详情）；失败的、无关的、写索引的调用不算；私有记忆文件不算", async () => {
    mgr.setPublicMemoryProvider(() => ({ text: MEMORY, count: 1, onDemand: 3 }));
    const { session } = await create("pm-look-1", "你好");
    const pid = session.platformSessionId;
    await until(() => driver.turns.length === 1);
    const sink = driver.turns[0]!.sink;
    const IDX = "/Users/u/.pi-agent-gui/data/memory-public/index";
    const tool = (key: string, input: string, status = "completed", name = "命令") => sink.event({ key, kind: "tool", tool: { name, input, output: "ok", status }, source: "stream", parserVersion: "f", availability: "recorded", occurredAt: "2026-11-11T05:00:00.000Z" } as never);
    tool("r1", `cat ${IDX}/pi-agent.md`);
    tool("s1", `grep -n "#部署" ${IDX}/pi-agent.catalog.md`);
    tool("d1", `cd ${IDX} && grep -n -A8 "### 7d68b42e" pi-agent.details.md`);
    tool("p1", `cat ${IDX}/pi-agent.catalog.md | grep 部署`);
    tool("mix", `cat > ${IDX}/x.md <<'E'\nhello\nE\ncat ${IDX}/global.md > /tmp/out.txt`);
    tool("w1", `cat > ${IDX}/pi-agent.md <<'E'\nx\nE`);
    tool("f1", `cat ${IDX}/pi-agent.md`, "failed");
    tool("n1", "cat ~/.claude/projects/x/memory/gui-harness-fund-deploy.md | head -40");
    tool("c1", "curl -s 'http://127.0.0.1:8780/api/memory/public/index?project=pi-agent&q=%E9%83%A8%E7%BD%B2'", "completed", "bash");
    // 带输出的查阅：模型实际收到的条目（目录行 + 详情）从输出里还原
    const OUT = ["37e668cc [常驻] #个人偏好/流程 | 改动前先确认需求和方案。 | 个人偏好", "12:7d68b42e [常驻] #部署与发布 | 所有入口链接都使用 gui-backup-cn。 | pi-agent", "### 7d68b42e · pi-agent · 部署与发布 · 常驻", "", "所有入口链接和验收核查都使用 gui-backup-cn.harness.fund。", "依据：2 个会话"].join("\n");
    sink.event({ key: "o1", kind: "tool", tool: { name: "命令", input: `grep -n "部署" ${IDX}/pi-agent.catalog.md`, output: OUT, status: "completed" }, source: "stream", parserVersion: "f", availability: "recorded", occurredAt: "2026-11-11T05:01:00.000Z" } as never);
    let page = await mgr.injections(pid);
    for (let i = 0; i < 60 && page.lookups.length < 7; i++) { await tick(); page = await mgr.injections(pid); }
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ count: 1, onDemand: 3 });
    const byKey = Object.fromEntries(page.lookups.map(l => [l.key, l]));
    expect(Object.keys(byKey).sort()).toEqual(["c1", "d1", "mix", "o1", "p1", "r1", "s1"]);
    expect(byKey["o1"]!.recalledTotal).toBe(2);
    expect(byKey["o1"]!.alsoRead).toBe(false);
    expect(byKey["o1"]!.recalled).toEqual([
      { id: "7d68b42e", tier: "常驻", scope: "pi-agent·部署与发布", text: "所有入口链接和验收核查都使用 gui-backup-cn.harness.fund。" },   // 详情的正文优先于目录摘要
      { id: "37e668cc", tier: "常驻", scope: "个人偏好·流程", text: "改动前先确认需求和方案。" }
    ]);
    expect(byKey["r1"]!.recalled).toEqual([]);   // 输出只有 "ok"
    expect(byKey["r1"]!.ops).toEqual([{ kind: "map", how: "read", ids: [] }]);
    expect(byKey["s1"]!.ops).toEqual([{ kind: "catalog", how: "search", ids: [], query: "部署" }]);
    expect(byKey["d1"]!.ops).toEqual([{ kind: "details", how: "search", ids: ["7d68b42e"] }]);
    expect(byKey["p1"]!.ops).toEqual([{ kind: "catalog", how: "search", ids: [], query: "部署" }]);   // cat … | grep：整条管道是检索
    expect(byKey["mix"]!.ops).toEqual([{ kind: "map", how: "read", ids: [] }]);                         // 同一命令里写 x.md 的那段不算，读 global.md 并重定向到 /tmp 的那段算
    expect(byKey["c1"]!.ops).toEqual([{ kind: "api", how: "search", ids: [], query: "部署" }]);
    expect(byKey["r1"]).toMatchObject({ tool: "命令", at: "2026-11-11T05:00:00.000Z", command: `cat ${IDX}/pi-agent.md` });
  });

  it("使用率观察：首轮注入通知一次；会话里的工具调用交给观察者，之后的更新也交给它（由它去重）；观察者出错不影响会话", async () => {
    const injected: Array<{ platformSessionId: string; runtimeKind: string }> = [];
    const tools: Array<{ key: string; name?: string; input?: string }> = [];
    mgr.setPublicMemoryProvider(() => ({ text: MEMORY, count: 1 }));
    mgr.setPublicMemoryObserver({
      injected: (c) => { injected.push(c); },
      tool: (c) => { tools.push(c); if (c.key === "boom") throw new Error("observer down"); }
    });
    const { session } = await create("pm-obs-1", "你好");
    const pid = session.platformSessionId;
    await until(() => driver.turns.length === 1);
    expect(injected).toEqual([{ platformSessionId: pid, runtimeKind: "codex" }]);
    const sink = driver.turns[0]!.sink;
    sink.event({ key: "t1", kind: "tool", tool: { name: "命令", input: "cat /x/memory-public/index/pi-agent.md", status: "inProgress" }, source: "stream", parserVersion: "f", availability: "recorded" });
    sink.event({ key: "t1", kind: "tool", tool: { name: "命令", input: "cat /x/memory-public/index/pi-agent.md", output: "ok", status: "completed" }, source: "stream", parserVersion: "f", availability: "recorded" });
    sink.event({ key: "boom", kind: "tool", tool: { name: "命令", input: "x", status: "completed" }, source: "stream", parserVersion: "f", availability: "recorded" });
    sink.event({ key: "noinput", kind: "tool", tool: { name: "命令", status: "completed" }, source: "stream", parserVersion: "f", availability: "recorded" });
    sink.event({ key: "m1", kind: "message", role: "assistant", text: "memory-public", source: "stream", parserVersion: "f", availability: "recorded" });
    await until(() => tools.some((t) => t.key === "boom"));
    expect(tools.filter((t) => t.key === "t1")).toHaveLength(2);
    expect(tools.some((t) => t.key === "noinput" || t.key === "m1")).toBe(false);
    expect(tools[0]).toMatchObject({ platformSessionId: pid, runtimeKind: "codex", name: "命令", input: "cat /x/memory-public/index/pi-agent.md" });
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(pid)!.status === "idle");
    // 第二轮不再算一次注入
    await mgr.sendTurn(pid, { idempotencyKey: "pm-obs-2", prompt: "第二句", expectedRevision: mgr.store.binding(pid)!.bindingRevision }, "test");
    await until(() => driver.turns.length === 2);
    expect(injected).toHaveLength(1);
  });

  it("一轮结束通知观察者（即时提炼用）：带轮次号与终态，每轮一次；观察者出错不影响会话回到 idle", async () => {
    const ended: Array<{ platformSessionId: string; runtimeKind: string; turnNo: number; status: string }> = [];
    mgr.setPublicMemoryObserver({ turnEnded: (c) => { ended.push(c); throw new Error("observer down"); } });
    const { session } = await create("pm-end-1", "记住 我喜欢先给结论");
    const pid = session.platformSessionId;
    await until(() => driver.turns.length === 1);
    expect(ended).toEqual([]);                                   // 还没结束不通知
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(pid)!.status === "idle");
    expect(ended).toEqual([{ platformSessionId: pid, runtimeKind: "codex", turnNo: 1, status: "completed" }]);
    await mgr.sendTurn(pid, { idempotencyKey: "pm-end-2", prompt: "第二句", expectedRevision: mgr.store.binding(pid)!.bindingRevision }, "test");
    await until(() => driver.turns.length === 2);
    driver.turns[1]!.finish({ status: "failed", reason: "boom" });
    await until(() => ended.length === 2);
    expect(ended[1]).toMatchObject({ turnNo: 2, status: "failed" });
  });

  it("works together with the platform skill index", async () => {
    const skilled = new RuntimeSessionManager({ dataDir: join(dir, "data2"), drivers: { codex: driver }, skipRecovery: true, platformSkills: {} });
    try {
      skilled.updateSettings({ workspaceRoots: [ws] }, "test"); await skilled.probe("codex");
      skilled.setPublicMemoryProvider(() => ({ text: MEMORY, count: 1 }));
      const before = driver.turns.length;
      await skilled.create({ idempotencyKey: "pm-skill-1", runtimeKind: "codex", workspace: ws, title: "t", prompt: "做事", confirmedProfileVersion: skilled.profile("codex")!.checkedAt } as never, "test");
      await until(() => driver.turns.length === before + 1);
      const p = driver.turns[before]!.args.prompt;
      expect(p.indexOf("【平台公共记忆】")).toBe(0);
      expect(p.indexOf("【平台技能】")).toBeGreaterThan(0);
      expect(p.endsWith(`${USER_MESSAGE_MARK}做事`)).toBe(true);
      expect(userVisiblePrompt(p)).toBe("做事");
    } finally { skilled.shutdown(); await tick(35); }
  });
});
