/**
 * 卡住看门狗：单个工具连续运行到阈值就插提醒，到 abortMs 自动中止本轮；关掉自动中止后只提醒。
 * 阈值用毫秒注入，所以测试跑得快；生产值是 2/5/10 分钟提醒、20 分钟自动中止。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeSessionManager } from "../src/manager.js";
import { FakeDriver, tick, until } from "./fake-driver.js";

let dir: string, ws: string, codex: FakeDriver, mgr: RuntimeSessionManager;
const THRESHOLDS = { shellMs: [60, 150], browserMs: [200, 320], abortMs: 600, tickMs: 20 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rt-stall-"));
  ws = join(dir, "work", "proj");
  mkdirSync(ws, { recursive: true });
  codex = new FakeDriver("codex");
  mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex }, skipRecovery: true, stallGuard: THRESHOLDS });
  mgr.updateSettings({ workspaceRoots: [join(dir, "work")] }, "test");
  await mgr.probe("codex");
});
afterEach(async () => { mgr.shutdown(); await tick(30); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
async function start() {
  const p = mgr.profile("codex")!;
  const { session } = await mgr.create({ idempotencyKey: `k-${Date.now()}-${n++}`, runtimeKind: "codex", workspace: ws, prompt: "跑个长命令", confirmedProfileVersion: p.checkedAt }, "test");
  await until(() => codex.turns.length >= 1);
  return { id: session.platformSessionId, turn: codex.turns.at(-1)! };
}
const tool = (key: string, input: string, status: string, name = "bash") => ({ key, kind: "tool" as const, tool: { name, input, status }, source: "stream" as const, parserVersion: "fake", availability: "recorded" as const });
const notices = (id: string) => mgr.store.events(id).filter((e) => e.kind === "notice" && /已运行|没有新输出|超出命令/.test(e.text ?? ""));
const progress = (key: string, output: string) => ({ key, kind: "tool" as const, partial: true, tool: { name: "bash", output, status: "running" }, source: "stream" as const, parserVersion: "fake", availability: "recorded" as const });

describe("卡住看门狗", () => {
  it("按阈值逐档提醒，工具结束后不再有新的提醒", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("t1", "find . -name x", "inProgress"));
    await until(() => notices(id).length >= 2);
    const seen = notices(id);
    // 两档都到点了：同一轮扫描里各插一条，key 按阈值区分
    expect(seen.map((e) => e.key)).toEqual(["stall:t1:60", "stall:t1:150"]);
    expect(seen[0]!.text).toContain("bash 已运行");
    expect(seen[0]!.text).toContain("find . -name x");
    expect(seen[1]!.text).toContain("find . -name x");
    turn.sink.event({ ...tool("t1", "find . -name x", "completed"), tool: { name: "bash", output: "ok", status: "completed", exitCode: 0 } });
    await tick(200);
    expect(notices(id).length).toBe(2);
    expect(turn.interrupted).toBe(false);
  });

  it("到自动中止阈值就停掉本轮，并写明为什么", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("t2", "find /Users/example -name x", "inProgress"));
    await until(() => turn.interrupted);
    await until(() => mgr.store.events(id).some((e) => e.kind === "notice" && (e.text ?? "").includes("已自动中止")));
    const abort = mgr.store.events(id).find((e) => e.kind === "notice" && (e.text ?? "").includes("已自动中止"))!;
    expect(abort.text).toContain("bash 连续运行");
    expect(abort.text).toContain("「授权」入口关掉");
    await until(() => ["cancelled", "interrupted", "stopping"].includes(mgr.store.binding(id)?.status ?? ""));
  });

  it("关掉自动中止后只提醒，不打断本轮", async () => {
    const { id, turn } = await start();
    mgr.setStallGuardAutoAbort(id, false, "test");
    turn.sink.event(tool("t3", "tail -f /tmp/x.log", "inProgress"));
    await until(() => notices(id).length >= 2);
    await tick(Math.round(THRESHOLDS.abortMs * 2));
    expect(turn.interrupted).toBe(false);
    expect(mgr.store.events(id).some((e) => (e.text ?? "").includes("已自动中止"))).toBe(false);
    expect(mgr.setStallGuardAutoAbort(id, true, "test").stallGuardAutoAbort).toBe(true);
  });

  it("浏览器工具的门槛比 shell 宽：shell 早该提醒时浏览器工具还没到点", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("t4", "打开页面", "inProgress", "platform_browser"));
    // shell 第一档 60ms 已过、浏览器第一档 200ms 未到
    await tick(120);
    expect(notices(id).length).toBe(0);
    await until(() => notices(id).length >= 1);
    expect(notices(id)[0]!.text).toContain("platform_browser 已运行");
  });

  it("本轮结束就清掉计时，空闲会话不再有看门狗事件", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("t5", "tail -f /tmp/x.log", "inProgress"));
    await until(() => notices(id).length >= 1);
    turn.finish({ status: "completed" });
    await until(() => mgr.store.binding(id)?.status === "idle");
    // 收尾事件（快捷回复等）落定后再取基线
    await tick(500);
    const count = () => mgr.store.events(id).filter((e) => e.kind === "notice").length;
    const before = count();
    await tick(Math.round(THRESHOLDS.abortMs * 2));
    expect(count()).toBe(before);
  });

  it("入参是 JSON 时提醒里只显示命令本身", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("t6", JSON.stringify({ command: "npm test -- --run" }), "inProgress"));
    await until(() => notices(id).length >= 1);
    const text = notices(id)[0]!.text!;
    expect(text).toContain("npm test -- --run");
    expect(text).not.toContain("{ \"command\"");
    expect(text).not.toContain("{\"command\"");
  });

  it("输出一直在流就不算卡住：不提醒、不自动中止", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("t7", "npm test", "inProgress"));
    // 总时长远超第一档 60ms 和中止阈值 600ms，但每 30ms 都有新输出
    for (let i = 0; i < 30; i++) { turn.sink.event(progress("t7", `line ${i}`)); await tick(30); }
    expect(notices(id).length).toBe(0);
    expect(turn.interrupted).toBe(false);
  });

  it("输出停下来之后按静默时长提醒，并写明是没有新输出", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("t8", "npm test", "inProgress"));
    turn.sink.event(progress("t8", "line 1"));
    await until(() => notices(id).length >= 1);
    expect(notices(id)[0]!.text).toContain("没有新输出");
    // 输出恢复后档位重置，再静默会重新提醒
    const first = notices(id).length;
    turn.sink.event(progress("t8", "line 2"));
    await until(() => notices(id).length > first);
  });

  it("命令开头写明的 sleep 不算卡住：等够了还没结束才提醒", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("t9", JSON.stringify({ command: "sleep 0.4; tail -3 /tmp/x.log" }), "inProgress"));
    // 常规第一档是 60ms，但 sleep 0.4 秒内都在预期里
    await tick(300);
    expect(notices(id).length).toBe(0);
    await until(() => notices(id).length >= 1);
    expect(notices(id)[0]!.text).toContain("超出命令里写明的等待时间");
  });

  it("只认命令开头的 sleep：后面才出现的 sleep 不豁免", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("t10", JSON.stringify({ command: "npm test; sleep 5" }), "inProgress"));
    await until(() => notices(id).length >= 1);
    expect(notices(id)[0]!.text).toContain("已运行");
  });

  it("bash_output 的 wait_seconds 算声明的等待：等够了还没返回才提醒", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("t11", JSON.stringify({ id: "job-1", wait_seconds: 0.4 }), "inProgress", "bash_output"));
    await tick(300);
    expect(notices(id).length).toBe(0);
    await until(() => notices(id).length >= 1);
    expect(notices(id)[0]!.text).toContain("超出命令里写明的等待时间");
  });
});
