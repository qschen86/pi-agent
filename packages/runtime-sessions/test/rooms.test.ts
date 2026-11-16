import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { RuntimeSessionManager, sessionPurpose } from "../src/manager.js";
import { FakeDriver, until, tick } from "./fake-driver.js";

const dirs: string[] = [];
const managers: RuntimeSessionManager[] = [];
afterEach(async () => { managers.forEach((m) => m.shutdown()); await tick(30); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });

it("群聊先绑定、不运行；第一条人类投递才创建原生会话，角色每轮注入，列表用途为 room", async () => {
  const dir = mkdtempSync(`${tmpdir()}/room-binding-`); dirs.push(dir);
  const driver = new FakeDriver("pi");
  const mgr = new RuntimeSessionManager({ dataDir: dir, drivers: { pi: driver }, skipRecovery: true }); managers.push(mgr);
  mgr.updateSettings({ workspaceRoots: [dir] }, "t"); await mgr.probe("pi");
  const input = { idempotencyKey: "room-member-123", runtimeKind: "pi" as const, workspace: dir, prompt: "等待人类 @", permissionMode: "pi-read-only" as const, confirmedProfileVersion: mgr.profile("pi")!.checkedAt, roomRef: { roomId: "room-1", memberId: "member-1" }, deferFirstTurn: true, role: { definitionRef: "room-member@1", templateVersion: "1", instructions: "你是群聊成员，全部只读" } };
  mgr.preflightCreate(input);
  const { session } = await mgr.create(input, "t");
  await tick(); expect(driver.startCalls).toBe(0); expect(session.turns).toEqual([]);
  expect(sessionPurpose(session)).toBe("room");
  await expect(mgr.sendTurn(session.platformSessionId, { idempotencyKey: "outside-room-123", prompt: "绕过时间线", expectedRevision: session.bindingRevision }, "t")).rejects.toMatchObject({ code: "ROOM_OWNED" });
  expect(() => mgr.archive(session.platformSessionId, true, "t")).toThrow(/群聊/);
  expect(() => mgr.deletePlatformData(session.platformSessionId, "t")).toThrow(/群聊/);
  await mgr.sendTurn(session.platformSessionId, { idempotencyKey: "room-message-123", prompt: "给出方案", expectedRevision: session.bindingRevision, roomDelivery: true }, "t");
  await until(() => driver.turns.length === 1);
  expect(driver.turns[0]!.args.roleInstructions).toBe(input.role.instructions);
  expect(driver.turns[0]!.args.permissionMode).toBe("pi-read-only");
  driver.turns[0]!.finish({ status: "completed" }); await until(() => session.turns[0]?.status === "completed");
  await mgr.sendTurn(session.platformSessionId, { idempotencyKey: "room-message-456", prompt: "答辩", expectedRevision: session.bindingRevision, roomDelivery: true }, "t");
  await until(() => driver.turns.length === 2);
  expect(driver.turns[1]!.args.roleInstructions).toBe(input.role.instructions);
  driver.turns[1]!.finish({ status: "completed" });
  expect((await mgr.directory({ source: "chat", includeHistory: false })).entries[0]?.roomRef).toEqual(input.roomRef);
});
