/**
 * 与 pi-background-bash-live 同一套脚本，但经已安装的独立运行时（PI_TEST_RELEASE_RUNTIME=<release>/bin/pi-runtime）
 * 走 pi.ts 的真实连接路径。线上 Pi 会话用的是这一份发布物，仓库源码改了不等于线上生效。
 *
 * 真实 Pi 走真实运行边界（guard 目录、OS 沙箱、闸门）跑 bash 后台运行：脚本化的本地 provider 依次发出
 * 「bash background:true → bash_output 等待 → 终止未结束的任务」，验证任务确实在后台跑、能等到结束、
 * 输出与退出码回到模型手里，并且 pi 退出后没有残留进程。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { prepareRuntimeConnection } from "../../pi-runtime/src/connection.js";
import { PiRpcClient } from "../../pi-runtime/src/pi-client.js";

const PI = "/opt/homebrew/bin/pi";
const MARK = `bgmark-${process.pid}`;
/** 已安装的独立运行时（bin/pi-runtime）。设了它才跑：验证的是发布出去的 runtime.mjs，而不是仓库源码。 */
const RELEASE = process.env["PI_TEST_RELEASE_RUNTIME"];

it.skipIf(!existsSync(PI) || !RELEASE)("已安装的运行时里：后台启动 → bash_output 等到结束 → 终止一个长任务、另一个留给 pi 退出时带走；无残留", async () => {
  const root = mkdtempSync(join(tmpdir(), "bg-pi-")), workspace = join(root, "work"), source = join(root, "source");
  mkdirSync(workspace); mkdirSync(source);
  const calls: Array<{ name: string; args: string }> = [];
  const results: string[] = [];
  // 脚本：按已收到的 tool 结果数决定下一步
  const script: Array<{ name: string; args: object } | string> = [
    { name: "bash", args: { command: `echo started; sleep 1; echo finished-${MARK}`, background: true } },
    { name: "bash", args: { command: `sleep 600 # ${MARK}`, background: true } },
    // 这一个故意不终止：pi 退出时必须把它带走
    { name: "bash", args: { command: `sleep 601 # ${MARK}`, background: true } },
    { name: "bash_output", args: { id: "job-1", wait_seconds: 20 } },
    { name: "bash_kill", args: { id: "job-2" } },
    "all done"
  ];
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const toolMsgs = body.messages.filter((m: { role: string }) => m.role === "tool");
    results.splice(0, results.length, ...toolMsgs.map((m: { content: unknown }) => JSON.stringify(m.content)));
    const step = script[toolMsgs.length]!;
    const delta = typeof step === "string" ? { role: "assistant", content: step } : { role: "assistant", tool_calls: [{ index: 0, id: `call_${toolMsgs.length}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] };
    if (typeof step !== "string") calls.push({ name: step.name, args: JSON.stringify(step.args) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [d, finish] of [[delta, null], [{}, typeof step === "string" ? "stop" : "tool_calls"]] as const) {
      res.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: d, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + "\n\n");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((yes) => provider.listen(0, "127.0.0.1", yes));
  writeFileSync(join(source, "settings.json"), "{}");
  writeFileSync(join(source, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, api: "openai-completions", apiKey: "synthetic-only", models: [{ id: "probe", name: "probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }] } } }));
  const controlRoot = mkdtempSync(join("/private/tmp", "bg-release-"));
  let timer: NodeJS.Timeout | undefined, client: PiRpcClient | undefined;
  try {
    const sessionId = randomUUID();
    const connection = await prepareRuntimeConnection({ controlRoot, invocation: { binaryPath: RELEASE! }, spec: { version: 1, binary: PI, workspace, provider: "fixture", model: "probe", mode: "pi-native", sessionId, sourceAgentDir: source } as never });
    client = new PiRpcClient(connection.endpoint);
    const done = new Promise<void>((yes, no) => {
      timer = setTimeout(() => no(new Error("Pi fixture timed out")), 60_000);
      client!.on("event", (e: any) => {
        if (e.type === "runtime_error") no(new Error(e.error));
        if (e.type === "message_end" && JSON.stringify(e.message).includes("all done")) yes();
      });
    });
    await client.start();
    await new Promise((r) => setTimeout(r, 1500));
    await client.request("set_model", { provider: "fixture", modelId: "probe" });
    await client.request("prompt", { message: "run the scripted background jobs" });
    await done;
    expect(calls.map((c) => c.name)).toEqual(["bash", "bash", "bash", "bash_output", "bash_kill"]);
    const [start1, start2, start3, waited, killed] = results;
    expect(start1).toContain("job-1");
    expect(start2).toContain("job-2");
    expect(start3).toContain("job-3");
    // bash_output 等到 job-1 结束就返回，带上输出和退出码
    expect(waited).toContain("已结束");
    expect(waited).toContain(`finished-${MARK}`);
    expect(waited).toContain("退出码 0");
    expect(killed).toContain("已终止");
  } finally {
    clearTimeout(timer);
    if (client) { client.stop(); await client.waitForExit().catch(() => {}); }
    provider.closeAllConnections();
    await new Promise<void>((yes) => provider.close(() => yes()));
    rmSync(root, { recursive: true, force: true });
    rmSync(controlRoot, { recursive: true, force: true });
  }
  // pi 退出后不能留下后台进程
  await new Promise((r) => setTimeout(r, 500));
  // 被 bash_kill 终止的（600）和没人管的（601）都不能留下
  let leftover = "";
  try { leftover = execFileSync("pgrep", ["-f", `sleep 60[01] # ${MARK}`], { encoding: "utf8" }); } catch { /* 没有匹配 = 没有残留 */ }
  expect(leftover.trim()).toBe("");
}, 90_000);
