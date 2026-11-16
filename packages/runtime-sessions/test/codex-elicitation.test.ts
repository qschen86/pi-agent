import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { CodexAppServerClient } from "../src/codex-client.js";
import { CodexDriver } from "../src/codex.js";
import type { DriverApproval, TurnSink } from "../src/driver.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-app-server.mjs");
const drivers: CodexDriver[] = [];
afterEach(() => drivers.splice(0).forEach(d => d.shutdown()));

function setup(scenario: string, approve = true) {
  const client = new CodexAppServerClient({ binaryPath: process.execPath, args: [fixture], env: { ...process.env as Record<string, string>, FAKE_SCENARIO: scenario } });
  const driver = new CodexDriver({ binaryPath: process.execPath, clientFactory: () => client });
  drivers.push(driver);
  const approvals: DriverApproval[] = [];
  const statuses: string[] = [];
  const sink: TurnSink = {
    nativeSession() {}, nativeTurn() {}, event() {}, usage() {}, rateLimit() {},
    status: s => { statuses.push(s); },
    approval: async r => { approvals.push(r); return { approve, reason: "test" }; }
  };
  const start = () => driver.startTurn({ workspace: "/tmp", prompt: "查看 Finder", clientMessageId: "finder", permissionMode: "auto-review" }, sink);
  const responses = async () => (await client.request("debug/elicitations", {}) as { responses: Array<Record<string, unknown>> }).responses;
  return { sink, approvals, statuses, start, responses };
}

it.each([[true, "accept", {}], [false, "decline", null]] as const)("Finder 授权通过现有审批，允许=%s 按 MCP 协议回传", async (approve, action, content) => {
  const t = setup("elicitation", approve);
  expect((await (await t.start()).done).status).toBe("completed");
  expect(t.approvals).toHaveLength(1);
  expect(t.approvals[0]).toMatchObject({ kind: "tool", nativeTurnId: "turn-thr-1-1", action: expect.stringContaining("Finder"), scope: expect.stringContaining("com.apple.finder") });
  expect(t.approvals[0]!.params).toMatchObject({ serverName: "cua_repl", _meta: { tool_params: { app: "com.apple.finder" } } });
  expect(t.statuses).toContain("waiting-input");
  expect((await t.responses())[0]).toMatchObject({ result: { action, content, _meta: null } });
});

it("MCP 未关联 turn 时绑定当前活动轮次", async () => {
  const t = setup("elicitation-null-turn");
  await (await t.start()).done;
  expect(t.approvals[0]?.nativeTurnId).toBe("turn-thr-1-1");
  expect((await t.responses())[0]).toMatchObject({ result: { action: "accept" } });
});

it.each(["elicitation-wrong-turn", "elicitation-nested"])("%s 不得变成空表单授权", async scenario => {
  const t = setup(scenario);
  await (await t.start()).done;
  expect(t.approvals).toHaveLength(0);
  expect((await t.responses())[0]).toHaveProperty("error");
});

it("request_user_input：选项面板的答案按题目 id 回传，其他=自填文本", async () => {
  const t = setup("user-input");
  t.sink.approval = async r => { t.approvals.push(r); return { approve: true, reason: "", answers: { db: ["我想用 DuckDB"], name: ["pi"] } }; };
  expect((await (await t.start()).done).status).toBe("completed");
  expect(t.approvals[0]).toMatchObject({ kind: "question", questions: [
    { id: "db", header: "数据库", multiSelect: false, allowOther: true, options: [{ label: "SQLite", description: "单文件" }, { label: "Postgres", description: "服务端" }] },
    { id: "name", allowOther: true, options: [] }
  ] });
  expect(t.statuses).toContain("waiting-input");
  expect((await t.responses())[0]).toMatchObject({ result: { answers: { db: { answers: ["我想用 DuckDB"] }, name: { answers: ["pi"] } } } });
});

it("request_user_input 被跳过时回传空答案而不是报错", async () => {
  const t = setup("user-input", false);
  await (await t.start()).done;
  expect((await t.responses())[0]).toMatchObject({ result: { answers: {} } });
});

it("MCP 表单：字符串字段与枚举/多选/布尔/整数交给人类填写，并还原成表单类型", async () => {
  const t = setup("elicitation-form");
  t.sink.approval = async r => { t.approvals.push(r); return { approve: true, reason: "", answers: { env: ["预发"], regions: ["cn", "us"], retries: ["3"] } }; };
  await (await t.start()).done;
  expect(t.approvals[0]).toMatchObject({ kind: "question", questions: [{ id: "env" }, { id: "regions", multiSelect: true }, { id: "dry", optional: true }, { id: "retries", optional: true }] });
  expect((await t.responses())[0]).toMatchObject({ result: { action: "accept", content: { env: "stg", regions: ["cn", "us"], retries: 3 } } });
});

it("MCP 表单里的整数字段填了非数字：取消而不是把垃圾交给 MCP", async () => {
  const t = setup("elicitation-form");
  t.sink.approval = async () => ({ approve: true, reason: "", answers: { env: ["生产"], regions: ["cn"], retries: ["abc"] } });
  await (await t.start()).done;
  expect((await t.responses())[0]).toMatchObject({ result: { action: "cancel", content: null } });
});

it("原生请求撤回后终止审批等待，不再发送授权", async () => {
  const t = setup("elicitation-resolved");
  let aborted = false;
  t.sink.approval = async (r, signal) => {
    t.approvals.push(r);
    return new Promise(resolve => signal!.addEventListener("abort", () => {
      aborted = true;
      resolve({ approve: false, reason: "withdrawn" });
    }, { once: true }));
  };
  await (await t.start()).done;
  expect(t.approvals).toHaveLength(1);
  expect(aborted).toBe(true);
  expect(await t.responses()).toEqual([]);
});
