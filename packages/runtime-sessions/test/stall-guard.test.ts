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

  /* ---- 修复：等用户不算卡住、Codex 形态、并行工具、残留清理（docs/requirements/stall-guard-fixes） ---- */
  const aborted = (id: string) => mgr.store.events(id).filter((e) => e.kind === "notice" && (e.text ?? "").includes("已自动中止"));
  const askApproval = (turn: { sink: { approval(r: never): unknown } }, nativeRequestId = "ap-1") =>
    turn.sink.approval({ nativeRequestId, kind: "permissions", title: "使用工具 Bash", action: "npm test", scope: "workspace", source: "test", params: { nativeRequestId }, requiresExplicitApproval: true } as never);
  const pendingApproval = (id: string) => mgr.pendingApprovals().find((p) => p.platformSessionId === id)!;

  it("提问类工具不登记计时：挂起超过自动中止阈值也不提醒、不中止", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("q1", JSON.stringify({ questions: [{ question: "下一步？" }] }), "inProgress", "AskUserQuestion"));
    turn.sink.event(tool("q2", JSON.stringify({ questions: [] }), "inProgress", "request_user_input"));
    await tick(THRESHOLDS.abortMs * 2);
    expect(notices(id).length).toBe(0);
    expect(turn.interrupted).toBe(false);
  });

  it("等审批期间暂停计时，批准后从暂停处接着算", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("w1", "npm test", "inProgress"));
    void askApproval(turn);
    await until(() => mgr.pendingApprovals().some((p) => p.platformSessionId === id));
    // 等审批的时间远超提醒与中止阈值：不提醒、不中止
    await tick(THRESHOLDS.abortMs * 2);
    expect(notices(id).length).toBe(0);
    expect(turn.interrupted).toBe(false);
    const p = pendingApproval(id);
    mgr.decideApproval(id, p.approvalId, { approve: true, paramsDigest: p.paramsDigest, turnNo: p.turnNo }, "owner");
    // 批准之后计时重新开始，工具仍没结束才提醒
    await until(() => notices(id).length >= 1);
    expect(notices(id)[0]!.text).toContain("npm test");
  });

  it("Codex 形态：item/started 是 partial 事件，也要开始计时；completed 后清除", async () => {
    const { id, turn } = await start();
    turn.sink.event({ ...tool("c1", "npm test", "inProgress", "命令"), partial: true });
    await until(() => notices(id).length >= 1);
    expect(notices(id)[0]!.text).toContain("命令 已运行");
    await until(() => turn.interrupted);
    expect(aborted(id).length).toBe(1);
    // 另一个命令：started 后很快 completed，不应提醒
    const before = notices(id).length;
    turn.sink.event({ ...tool("c2", "ls", "inProgress", "命令"), partial: true });
    turn.sink.event({ ...tool("c2", "ls", "completed", "命令"), tool: { name: "命令", input: "ls", status: "completed", exitCode: 0 } });
    await tick(THRESHOLDS.abortMs);
    expect(notices(id).filter((e) => e.key.includes("c2")).length).toBe(0);
    expect(notices(id).length).toBeGreaterThanOrEqual(before);
  });

  it("状态为空的非 partial 工具事件（Codex 的网页搜索）和历史回放事件都不登记", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("e1", "某个搜索", "", "网页搜索"));
    turn.sink.event({ ...tool("h1", "npm test", "inProgress"), source: "history" as never });
    await tick(THRESHOLDS.abortMs * 2);
    expect(notices(id).length).toBe(0);
    expect(turn.interrupted).toBe(false);
  });

  it("并行工具各自计时：先开始的卡住、后开始的已结束，仍然提醒并中止", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("p1", "npm run build", "inProgress"));
    turn.sink.event(tool("p2", "ls", "inProgress"));
    turn.sink.event({ ...tool("p2", "ls", "completed"), tool: { name: "bash", input: "ls", status: "completed", exitCode: 0 } });
    await until(() => notices(id).length >= 1);
    expect(notices(id)[0]!.key).toBe("stall:p1:60");
    await until(() => turn.interrupted);
    expect(aborted(id).length).toBe(1);
    expect(aborted(id)[0]!.text).toContain("npm run build");
  });

  it("并行工具都卡住时只中止一次，提醒各自成条", async () => {
    const { id, turn } = await start();
    turn.sink.event(tool("m1", "npm run a", "inProgress"));
    turn.sink.event(tool("m2", "npm run b", "inProgress"));
    await until(() => turn.interrupted);
    await tick(THRESHOLDS.abortMs / 2);
    expect(aborted(id).length).toBe(1);
    const keys = notices(id).map((e) => e.key);
    expect(keys).toContain("stall:m1:60");
    expect(keys).toContain("stall:m2:60");
  });

  it("工具登记之后才出现的助手消息说明工具已返回：残留的计时被清掉", async () => {
    const { id, turn } = await start();
    // 没有配对完成事件的工具（有的 runtime 会丢）
    turn.sink.event(tool("r1", "npm test", "inProgress"));
    turn.sink.event({ key: "msg1", kind: "message", role: "assistant", text: "测试跑完了", source: "stream", parserVersion: "fake", availability: "recorded" } as never);
    await tick(THRESHOLDS.abortMs * 2);
    expect(notices(id).length).toBe(0);
    expect(turn.interrupted).toBe(false);
  });

  it("助手消息先于工具出现（同一条回复里先说话再调工具）不清掉新登记的工具", async () => {
    const { id, turn } = await start();
    turn.sink.event({ key: "msg2", kind: "message", role: "assistant", text: "我来跑一下测试", source: "stream", parserVersion: "fake", availability: "recorded" } as never);
    turn.sink.event(tool("r2", "npm test", "inProgress"));
    await until(() => notices(id).length >= 1);
    expect(notices(id)[0]!.key).toBe("stall:r2:60");
  });
});
