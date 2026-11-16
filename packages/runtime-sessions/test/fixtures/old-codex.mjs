#!/usr/bin/env node
// 测试替身：一个"旧版" codex——有版本号，能生成协议描述，但描述里没有 turn/interrupt 与 thread/resume
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("codex-cli 0.1.0-old"); process.exit(0); }
if (a[0] === "app-server" && a[1] === "generate-json-schema") {
  const out = a[a.indexOf("--out") + 1];
  mkdirSync(out, { recursive: true });
  const methods = ["initialize", "thread/start", "turn/start", "thread/list", "thread/read", "thread/items/list", "thread/turns/list", "account/read", "model/list", "account/rateLimits/read"];
  writeFileSync(join(out, "ClientRequest.json"), JSON.stringify({ oneOf: methods.map((m) => ({ properties: { method: { enum: [m] } } })) }));
  writeFileSync(join(out, "ServerNotification.json"), JSON.stringify({ oneOf: ["turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta", "thread/tokenUsage/updated"].map((m) => ({ properties: { method: { enum: [m] } } })) }));
  writeFileSync(join(out, "ServerRequest.json"), JSON.stringify({ oneOf: ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].map((m) => ({ properties: { method: { enum: [m] } } })) }));
  process.exit(0);
}
if (a[0] === "app-server") await import("./fake-app-server.mjs");
