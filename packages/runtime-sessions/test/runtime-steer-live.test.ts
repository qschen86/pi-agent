/**
 * 真实 Codex / Claude Code 的插话送达（消耗真实账号额度，默认不跑）：
 *   RT_STEER_LIVE=1 npx vitest run packages/runtime-sessions/test/runtime-steer-live.test.ts
 * 两边语义与 Pi 一致：当前工具执行完、下一次调用模型前合并进本轮；本轮结束后拒绝。测试会话跑完即删。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeDriver } from "../src/claude.js";
import { CodexDriver } from "../src/codex.js";
import type { DriverEvent, RuntimeDriver, StartTurnArgs, TurnSink } from "../src/driver.js";

const PROMPT = "Run the shell command `sleep 6; cat a.txt` and then reply with only its output.";
const STEER = "Additionally, append the word BANANA at the end of your reply.";
const dirs: string[] = [];
afterEach(() => {
  for (const ws of dirs.splice(0)) {
    rmSync(ws, { recursive: true, force: true });
    const tag = basename(ws);
    // Claude：按工作目录命名的项目目录；Codex：当天 rollout 里记着这个工作目录的会话
    const claude = join(homedir(), ".claude", "projects");
    if (existsSync(claude)) for (const d of readdirSync(claude)) if (d.endsWith(tag)) rmSync(join(claude, d), { recursive: true, force: true });
    const day = new Date(), codex = join(homedir(), ".codex", "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    if (existsSync(codex)) for (const f of readdirSync(codex)) if (readFileSync(join(codex, f), "utf8").slice(0, 4000).includes(tag)) rmSync(join(codex, f), { force: true });
  }
});

async function steerScenario(driver: RuntimeDriver, args: Omit<StartTurnArgs, "workspace" | "prompt" | "clientMessageId">) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "rt-steer-live-"))); dirs.push(ws);
  writeFileSync(join(ws, "a.txt"), "alpha");
  const order: string[] = [], delivered: string[] = [], steerId = randomUUID();
  const sink = { nativeSession: () => {}, nativeTurn: () => {}, usage: () => {}, rateLimit: () => {}, status: () => {},
    event: (e: DriverEvent) => { if (e.role === "assistant" && e.kind === "message" && !e.partial) order.push(`assistant:${e.text}`); },
    steerDelivered: (id: string) => { delivered.push(id); order.push("delivered"); },
    approval: async () => ({ approve: true, reason: "live test" }) } as unknown as TurnSink;
  const h = await driver.startTurn({ ...args, workspace: ws, prompt: PROMPT, clientMessageId: randomUUID() }, sink);
  await new Promise(r => setTimeout(r, 3000));
  await h.steer!({ clientMessageId: steerId, prompt: STEER });
  const done = await h.done;
  await expect(h.steer!({ clientMessageId: randomUUID(), prompt: "late" })).rejects.toThrow("本轮已在结束");
  expect(done.status).toBe("completed");
  expect(delivered).toEqual([steerId]);
  // 送达先于采纳了插话的那条回复
  const reply = order.findIndex(x => x.includes("BANANA"));
  expect(reply).toBeGreaterThan(-1);
  expect(order.indexOf("delivered")).toBeLessThan(reply);
}

describe.skipIf(process.env.RT_STEER_LIVE !== "1")("real runtime steer", () => {
  it("Codex turn/steer", async () => {
    const d = new CodexDriver({});
    try { await steerScenario(d, { permissionMode: "read-only", effort: "low" }); } finally { d.shutdown(); }
  }, 180_000);
  it("Claude Code streamed input", async () => {
    const d = new ClaudeDriver({});
    try { await steerScenario(d, { model: "haiku", permissionMode: "default" }); } finally { d.shutdown(); }
  }, 180_000);
});
