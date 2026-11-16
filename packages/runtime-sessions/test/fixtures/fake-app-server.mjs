#!/usr/bin/env node
// 测试替身：按 Codex app-server v2 协议应答的最小 stdio 进程。
// 行为由 FAKE_SCENARIO 控制：normal（默认）、approval、slow（等待中断）
import { createInterface } from "node:readline";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
if(process.env.FAKE_BOOTSTRAP_SKILLS === "1") {const root=join(process.env.CODEX_HOME,"skills/probe");mkdirSync(root,{recursive:true});writeFileSync(join(root,"SKILL.md"),"trusted fixture stock");}

const scenario = process.env.FAKE_SCENARIO ?? "normal";
const threads = new Map();
const unsubscribed = [];
const instructions = [];
const elicitationResponses = [];
const evaluation = [];
const checkpoints = [];
const evaluatorPolicy = (params) => ({cwd: params.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: {type: "workspaceWrite", writableRoots: [params.cwd], networkAccess: true, excludeSlashTmp: true, excludeTmpdirEnvVar: true}, runtimeWorkspaceRoots: [params.cwd], instructionSources: []});
function policyResponse(params) {
 const r=evaluatorPolicy(params);
 if(scenario.startsWith("resume-") && (!params.threadId || !threads.get(params.threadId)?.turns.length))return r;
 if(scenario==="checkpoint-wide-policy" && params.threadId)r.runtimeWorkspaceRoots=["/foreign/workspace"];
 const mismatch=scenario.replace(/^resume-/, "");
 if(mismatch === "eval-implicit-cwd"){r.sandbox.writableRoots=[];r.runtimeWorkspaceRoots=[];}
 if(mismatch === "eval-input-write")r.sandbox.writableRoots.push(params.cwd.replace(/\/job\/report$/, "/input"));
 if(mismatch === "eval-network-denied")r.sandbox.networkAccess=false;
 if(mismatch === "eval-tmp-write")r.sandbox.excludeSlashTmp=false;
 if(mismatch === "eval-auto-review")r.approvalsReviewer="auto_review";
 if(mismatch === "eval-instructions")r.instructionSources=["/foreign/AGENTS.md"];
 if(mismatch === "eval-wide-roots")r.runtimeWorkspaceRoots=["/foreign/workspace"];
 if(mismatch === "eval-missing-policy")delete r.sandbox;
 return r;
}
let pendingApproval = null;
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const notify = (method, params) => send({ method, params });

function runTurn(threadId, turnId, input) {
  const t = threads.get(threadId);
  notify("turn/started", { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
  notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item: { type: "userMessage", id: `u-${turnId}`, clientId: input.clientUserMessageId, content: input.input } });
  notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: `a-${turnId}`, text: "", phase: null, memoryCitation: null, delivery: null, questions: null } });
  notify("item/agentMessage/delta", { threadId, turnId, itemId: `a-${turnId}`, delta: "正在" });
  notify("item/agentMessage/delta", { threadId, turnId, itemId: `a-${turnId}`, delta: "处理" });
  const finish = (status, extra = {}) => {
    notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: `a-${turnId}`, text: `完成：${input.input[0].text}`, phase: "final", memoryCitation: null, delivery: null, questions: null } });
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: { totalTokens: 150 * t.turns.length, inputTokens: 100 * t.turns.length, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 50 * t.turns.length, reasoningOutputTokens: 10 }, last: {}, modelContextWindow: 1000 } });
    const turn = t.turns.find((x) => x.id === turnId);
    turn.status = status;
    notify("turn/completed", { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status, error: extra.error ?? null, startedAt: 1, completedAt: 2, durationMs: 1 } });
  };
  if (scenario === "approval") {
    notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: { type: "commandExecution", id: `c-${turnId}`, command: "npm test", cwd: t.cwd, status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, processId: null, source: "agent", pluginId: null, scriptPath: null } });
    pendingApproval = { id: `srv-${turnId}`, finish, threadId, turnId };
    send({ id: pendingApproval.id, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId, turnId, itemId: `c-${turnId}`, startedAtMs: Date.now(), environmentId: null, command: "npm test", cwd: t.cwd, reason: "运行测试" } });
    return;
  }
  if (scenario === "user-input") {
    pendingApproval = { id: `srv-${turnId}`, finish, threadId, turnId, elicitation: true };
    send({ id: pendingApproval.id, method: "item/tool/requestUserInput", params: { threadId, turnId, itemId: `u-${turnId}`, isBlocking: true, questions: [
      { id: "db", header: "数据库", question: "用哪种数据库？", options: [{ label: "SQLite", description: "单文件" }, { label: "Postgres", description: "服务端" }], isOther: true },
      { id: "name", header: "项目名", question: "项目叫什么？", options: null }
    ] } });
    return;
  }
  if (scenario.startsWith("elicitation")) {
    pendingApproval = { id: `srv-${turnId}`, finish, threadId, turnId, elicitation: true };
    send({ id: pendingApproval.id, method: "mcpServer/elicitation/request", params: {
      threadId, turnId: scenario === "elicitation-null-turn" ? null : scenario === "elicitation-wrong-turn" ? "another-turn" : turnId,
      serverName: "cua_repl", mode: "form", message: 'Allow Computer Use to use "Finder"?',
      requestedSchema: { type: "object", properties: scenario === "elicitation-fields" ? { name: { type: "string" } } : scenario === "elicitation-form" ? {
        env: { type: "string", title: "环境", oneOf: [{ const: "prod", title: "生产" }, { const: "stg", title: "预发" }] },
        regions: { type: "array", title: "区域", items: { type: "string", enum: ["cn", "us"] } },
        dry: { type: "boolean", title: "只演练" },
        retries: { type: "integer", title: "重试次数" }
      } : scenario === "elicitation-nested" ? { cfg: { type: "object", properties: {} } } : {}, required: scenario === "elicitation-form" ? ["env", "regions"] : [] },
      _meta: { codex_approval_kind: "mcp_tool_call", connector_id: "computer-use", connector_name: "Computer Use", persist: ["session", "always"], riskLevel: "low", tool_name: "get_app", tool_params: { app: "com.apple.finder" } }
    } });
    if (scenario === "elicitation-resolved") setTimeout(() => {
      notify("serverRequest/resolved", { threadId, requestId: pendingApproval.id });
      pendingApproval = null;
      finish("completed");
    }, 20);
    return;
  }
  if (scenario === "slow" || scenario === "slow-steer-lost") { t.slow = finish; return; }
  if (scenario === "quota") { setTimeout(() => finish("failed", { error: { message: "You’ve hit your usage limit. Try again at 9:38 AM.", codexErrorInfo: "usageLimitExceeded" } }), 10); return; }
  setTimeout(() => finish("completed"), 10);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    // 客户端对服务端请求的答复
    if (pendingApproval && m.id === pendingApproval.id) {
      if (pendingApproval.elicitation) {
        const { finish } = pendingApproval;
        pendingApproval = null;
        elicitationResponses.push(m);
        setTimeout(() => finish("completed"), 5);
        return;
      }
      const { finish, threadId, turnId } = pendingApproval;
      pendingApproval = null;
      const accepted = m.result?.decision === "accept";
      notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item: { type: "commandExecution", id: `c-${turnId}`, command: "npm test", cwd: "/", status: accepted ? "completed" : "declined", commandActions: [], aggregatedOutput: accepted ? "ok" : null, exitCode: accepted ? 0 : null, durationMs: 1, processId: null, source: "agent", pluginId: null, scriptPath: null } });
      setTimeout(() => finish("completed"), 5);
    }
    return;
  }
  const reply = (result) => send({ id: m.id, result });
  const fail = (message) => send({ id: m.id, error: { code: -32600, message } });
  switch (m.method) {
    case "initialize": if (scenario === "delayed-init") { setTimeout(() => reply({ userAgent: "fake/0.0.1", codexHome: "/tmp/fake-codex", platformFamily: "unix", platformOs: "macos" }), 100); return; } return reply({ userAgent: "fake/0.0.1", codexHome: "/tmp/fake-codex", platformFamily: "unix", platformOs: "macos" });
    case "initialized": return;
    case "skills/list": return reply({data: []});
    case "account/read": if(scenario==="no-login")return reply({account:null});return reply({ account: { type: "chatgpt", email: "someone@example.com", planType: "plus" }, requiresOpenaiAuth: true, workspaceRouting: { chatgptAccountId: "acct-fake" } });
    case "model/list": return reply({ data: [{ id: "gpt-fake", displayName: "GPT Fake", isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low" }] });
    case "config/read": return reply({ config: { model: "gpt-fake", approval_policy: "never", sandbox_mode: "danger-full-access", mcp_servers: { demo: {} } } });
    case "account/rateLimits/read": return reply({ rateLimits: { primary: { usedPercent: 29, windowDurationMins: 300, resetsAt: 1790843529 }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1791335617 }, planType: "plus" }, accountId: "acct-fake" });
    case "thread/start": {
      if (!m.params.sandbox || !m.params.approvalPolicy) return fail("permissions must be explicit");
      const id = `${process.env.FAKE_THREAD_PREFIX ?? ""}thr-${threads.size + 1}`;
      threads.set(id, { id, cwd: m.params.cwd, turns: [] });
      if(scenario==="unknown-create")return fail("creation outcome unknown");
      instructions.push({ method: "thread/start", threadId: id, model: m.params.model, developerInstructions: m.params.developerInstructions ?? null, runtimeWorkspaceRoots: m.params.runtimeWorkspaceRoots, config: m.params.config, dynamicTools: m.params.dynamicTools, selectedCapabilityRoots: m.params.selectedCapabilityRoots, environments: m.params.environments, sandbox: m.params.sandbox, approvalPolicy: m.params.approvalPolicy, approvalsReviewer: m.params.approvalsReviewer });
      return reply({ thread: { id, parentThreadId: null }, model: scenario==="eval-model-ignored"?"gpt-other":(m.params.model ?? "gpt-fake"), reasoningEffort: "low", ...policyResponse(m.params) });
    }
    case "thread/resume": {
      const t = threads.get(m.params.threadId);
      if (!t) return fail("thread not found");
      instructions.push({ method: "thread/resume", threadId: t.id, model: m.params.model, developerInstructions: m.params.developerInstructions ?? null, runtimeWorkspaceRoots: m.params.runtimeWorkspaceRoots, config: m.params.config, dynamicTools: m.params.dynamicTools, selectedCapabilityRoots: m.params.selectedCapabilityRoots, environments: m.params.environments, sandbox: m.params.sandbox, approvalPolicy: m.params.approvalPolicy, approvalsReviewer: m.params.approvalsReviewer });
      return reply({ thread: { id: scenario==="checkpoint-foreign-resume"&&!t.turns.length?"foreign-thread":t.id }, model: scenario==="eval-model-ignored"||scenario==="resume-model-ignored"&&t.turns.length?"gpt-other":scenario==="resume-model-missing"&&t.turns.length?undefined:scenario==="checkpoint-model-ignored"?"gpt-other":scenario==="checkpoint-model-default"?(m.params.model??"gpt-other"):"gpt-fake", ...policyResponse(m.params) });
    }
    case "thread/archive":
    case "thread/unarchive": {checkpoints.push({method:m.method,threadId:m.params.threadId,hadInput:evaluation.length>0});if(scenario===`checkpoint-${m.method==="thread/archive"?"archive":"unarchive"}-error`)return fail("native checkpoint failed");return reply(m.method==="thread/unarchive"?{thread:{id:m.params.threadId}}:{});}
    case "debug/checkpoint": return reply({calls:checkpoints});
    case "debug/cwd": return reply({cwd: process.cwd()});
    case "debug/finish": { const t = threads.get(m.params.threadId); reply({}); if (t?.slow) { const f = t.slow; t.slow = null; f("completed"); } return; }
    case "debug/evaluation": return reply({ calls: evaluation });
    case "turn/start": {
      evaluation.push(m.params);
      const t = threads.get(m.params.threadId);
      if (!t) return fail("thread not found");
      const turnId = `turn-${t.id}-${t.turns.length + 1}`;
      t.turns.push({ id: turnId, status: "inProgress", clientId: m.params.clientUserMessageId, text: m.params.input[0].text });
      if (m.params.effort) t.effort = m.params.effort;
      reply({ turn: { id: turnId, status: "inProgress" } });
      setTimeout(() => runTurn(t.id, turnId, m.params), 5);
      return;
    }
    case "turn/steer": {
      // 与真实 Codex 一致：只接受仍在运行的那一轮；稍后作为同一轮的用户消息（带 clientId）送达
      const t = threads.get(m.params.threadId), turn = t?.turns.at(-1);
      if (!t?.slow || !turn || turn.id !== m.params.expectedTurnId) return fail("no active turn to steer");
      reply({ turnId: turn.id });
      if (scenario !== "slow-steer-lost") setTimeout(() => notify("item/completed", { threadId: t.id, turnId: turn.id, completedAtMs: Date.now(), item: { type: "userMessage", id: `u-${m.params.clientUserMessageId}`, clientId: m.params.clientUserMessageId, content: m.params.input } }), 10);
      return;
    }
    case "turn/interrupt": {
      const t = threads.get(m.params.threadId);
      reply({});
      if (t?.slow) { const f = t.slow; t.slow = null; f("interrupted"); }
      return;
    }
    case "thread/read": {
      const t = threads.get(m.params.threadId);
      if (!t) return fail("thread not found");
      return reply({ thread: { id: t.id, name: null, preview: t.turns[0]?.text ?? "", cwd: t.cwd, model: "gpt-fake", reasoningEffort: t.effort ?? "low", updatedAt: 5, path: null, status: { type: "idle" } } });
    }
    case "thread/turns/list": {
      const t = threads.get(m.params.threadId);
      if (!t) return fail("thread not found");
      const list = t.turns.map((x) => ({ id: x.id, status: x.status, error: null, startedAt: 1, completedAt: 2 }));
      return reply({ data: m.params.sortDirection === "desc" ? list.reverse().slice(0, m.params.limit ?? 100) : list, nextCursor: null });
    }
    case "thread/items/list": {
      const t = threads.get(m.params.threadId);
      if (!t) return fail("thread not found");
      const data = t.turns.flatMap((x) => [
        { turnId: x.id, item: { type: "userMessage", id: `u-${x.id}`, clientId: x.clientId, content: [{ type: "text", text: x.text }] }, startedAtMs: 1000, completedAtMs: 1000 },
        { turnId: x.id, item: { type: "agentMessage", id: `a-${x.id}`, text: `完成：${x.text}` }, startedAtMs: 2000, completedAtMs: 2000 }
      ]);
      return reply({ data: m.params.sortDirection === "desc" ? data.reverse() : data, nextCursor: null });
    }
    case "thread/unsubscribe": unsubscribed.push(m.params.threadId); return reply({ status: "unsubscribed" });
    case "debug/instructions": return reply({ calls: instructions });
    case "debug/elicitations": return reply({ responses: elicitationResponses });
    case "debug/unsubscribed": return reply({ threads: unsubscribed });
    case "thread/list": return reply({ data: [
      ...[...threads.values()].map((t) => ({ id: t.id, preview: t.turns[0]?.text ?? "", name: null, cwd: t.cwd, model: "gpt-fake", createdAt: 1, updatedAt: 2, parentThreadId: null, source: "appServer", originator: "pi_agent", status: { type: "idle" } })),
      { id: "desk-1", preview: "桌面会话", name: null, cwd: "/tmp", model: "gpt-fake", createdAt: 1, updatedAt: 3, parentThreadId: null, source: "vscode", originator: "Codex Desktop", status: { type: "notLoaded" } },
      { id: "old-1", preview: "无创建方", name: null, cwd: "/tmp", model: "gpt-fake", createdAt: 1, updatedAt: 3, parentThreadId: null, source: "vscode", originator: null, status: { type: "notLoaded" } }
    ], nextCursor: null });
    default: return fail(`unknown method ${m.method}`);
  }
});
