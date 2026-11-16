/**
 * 启动控制台：npm run web
 * 只监听 127.0.0.1；数据默认放在仓库的 .pi-agent/web（已被 git 忽略）。
 *
 * 先绑定端口再初始化：初始化期间返回 503（见 startup-gate.ts），否则重启空窗里
 * 反向代理会拿到 connection refused（502）。重模块用动态 import 推迟到端口就绪之后。
 */
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { createStartupGate, type AppFetch } from "./startup-gate.js";
import { createDeploymentGate } from "./deployment-gate.js";

// 启动耗时追踪：PI_AGENT_BOOT_TRACE=on 时把各阶段（相对于进程启动）打到 stderr。
const bootTrace = process.env["PI_AGENT_BOOT_TRACE"] === "on";
const mark = (label: string) => { if (bootTrace) process.stderr.write(`[boot] ${label} ${process.uptime().toFixed(3)}s\n`); };
mark("imports-done");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const port = Number(process.env["PI_AGENT_WEB_PORT"] ?? 8788);
// 让 runtime 里的平台技能（例如股票记账 CLI）找得到启动本会话的这个控制台，而不是另一个实例。
process.env["PI_AGENT_CONSOLE_PORT"] = String(port);
// 前置代理端口（装了监督进程时存在）：只用于把本机 Host/Origin 也列入白名单。
const proxyPort = Number(process.env["PI_AGENT_WEB_PROXY_PORT"] ?? "") || undefined;
const dataDir = process.env["PI_AGENT_WEB_DATA"] ?? join(REPO, ".pi-agent", "web");
// 经反向代理对外的域名（逗号分隔，如 gui.harness.fund）
const publicHosts = (process.env["PI_AGENT_WEB_PUBLIC_HOSTS"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
// 对外域名的登录密码：从文件读（文件里只放密码），不进环境变量与 launchd 配置
const passwordFile = process.env["PI_AGENT_WEB_PASSWORD_FILE"];
const password = passwordFile ? readFileSync(passwordFile, "utf8").trim() : undefined;
if (passwordFile && !password) throw new Error(`PI_AGENT_WEB_PASSWORD_FILE 是空的：${passwordFile}`);

// pi 的状态目录（provider 配置与密钥来源）；不设就用 ~/.pi/agent
const piConfigDir = process.env["PI_AGENT_PI_CONFIG"];

// 先占住端口：初始化期间回 503，而不是 connection refused。
const gate = createStartupGate();
const deployment = createDeploymentGate({ standby: process.env["PI_AGENT_WEB_STANDBY"] === "1", slot: process.env["PI_AGENT_WEB_SLOT"], sha: process.env["PI_AGENT_WEB_SHA"], token: process.env["PI_AGENT_WEB_BOOT_TOKEN"] });
const server = serve({ fetch: deployment.wrap(gate.fetch), port, hostname: "127.0.0.1" });
// 让事件循环跑一拍，真正建立监听，这样启动期就能接受连接（否则同步初始化会把 listen 拖到几秒后，代理仍撞 connection refused）。
await new Promise<void>((r) => setImmediate(r));
mark("listening");
const http = server as Server;
http.on("error", (e) => { console.error("HTTP 服务错误：", e); process.exit(1); });

// 关停：初始化期间只关端口；就绪后转交真正的优雅关停。
let stopping = false;
let realStop: (() => void) | undefined;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (realStop) { realStop(); return; }
  try { http.close(); } catch { /* 还没监听 */ }
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

try {
  // 重模块推迟到端口绑定之后加载，缩短“没在监听”的窗口。
  const { ConsoleService } = await import("./console.js");
  const { RuntimeSessionManager } = await import("@pi-agent/runtime-sessions");
  const { createWebApp, reconcileArchivedNotes, reconcileSessionNoteRefs } = await import("./server.js");
  const { piModelPort } = await import("@pi-agent/model-port");
  const { GameCompanionService } = await import("./game-companion.js");
  const { recordDeepSeekPort } = await import("./deepseek-usage.js");
  const { createDeployQueue, isDeployedSlot } = await import("./deploy-queue.js");
  const { SessionSyncJournal } = await import("./session-sync.js");
  const { createGracefulShutdown } = await import("./graceful-shutdown.js");
  const { startEventLoopLagMonitor } = await import("./slow-diagnostics.js");
  const { ServerDiagnostics, diagnosticsDir } = await import("./diagnostics/server-diagnostics.js");
  const { DiagnosticTriage } = await import("./diagnostics/triage.js");
  const { diagnosticNotes, errorStatsNotes } = await import("./diagnostics/notes-adapter.js");

  const { FixVerifier } = await import("./diagnostics/verify.js");
  mark("imports-heavy");

  deployment.prepared();
  await deployment.activation;

  const svc = new ConsoleService({ dataDir, repoRoot: REPO, pi: { ...(piConfigDir ? { configDir: piConfigDir } : {}) } });
  mark("console-service");
  // V1.4 故障诊断（docs/requirements/autonomous-diagnostics）：前后端事件、链路证据包。PI_AGENT_DIAGNOSTICS=off 关闭采集。
  const diagnostics = process.env["PI_AGENT_DIAGNOSTICS"] === "off" ? undefined : new ServerDiagnostics({ dir: diagnosticsDir(dataDir) });
  // Codex reset 卡：每晚北京时间 23:30 扫一次，数据在 <dataDir>/codex-reset/（docs/requirements/codex-reset-nightly）
  const { CodexResetService, startCodexResetScheduler } = await import("./codex-reset/service.js");
  const codexReset = new CodexResetService({ dir: join(dataDir, "codex-reset"), log: (m) => console.warn(`[codex-reset] ${m}`) });
  // 未捕获异常 / 未处理的 Promise 拒绝：只记录，不改变进程原来的退出行为（monitor 钩子不会吞掉异常）。
  if (diagnostics) process.on("uncaughtExceptionMonitor", (error, origin) => diagnostics.processError(error, origin));
  // V2.8：Codex / Claude Code 原生会话（生命周期方案 A：runtime 进程随本服务；重启后按原生记录核对）
  // platformSkills：展开 /技能名 + 会话首轮技能目录（docs/requirements/platform-skills）；只在这里开启，测试与脚本默认不动提示词
  const runtime = new RuntimeSessionManager({
    dataDir, platformSkills: {},
    // 会话标题与快捷回复都走这个端口：顺手把 DeepSeek 用量记进资源页的消耗账本。
    titlePort: recordDeepSeekPort(piModelPort({ ...(piConfigDir ? { piConfigDir } : {}) }), svc.deepseekUsage)
  });
  mark("runtime-manager");
  // 启动对账：把关联会话已归档的待办标记完成（历史遗留；新归档由 createWebApp 里的事件监听处理）
  reconcileArchivedNotes(svc, runtime);
  mark("reconcile-notes");
  // 启动对账：正文里还留着引用块却没有 noteRef 的会话（删过引用 chip 的历史遗留）按「记于」时间反查待办补上
  reconcileSessionNoteRefs(svc, runtime);
  mark("reconcile-note-refs");
  // V3.7：增量同步基线落库。重启后内容未变的会话可以续用游标，避免所有客户端在重启窗口里同时全量重读。
  const syncJournal = new SessionSyncJournal({}, { dir: join(dataDir, "session-sync") });
  // 关停信号：SSE 流订阅它主动收尾，而不是让 SIGTERM 直接把在途连接硬切。
  const shutdown = new AbortController();
  // 会话页「空闲时部署」只在线上服务（从 ~/.pi-agent-gui/slots/ 的槽位运行）里开启：开发实例不能触发线上部署
  const deployQueue = isDeployedSlot(process.cwd()) ? createDeployQueue() : undefined;
  const app = createWebApp(svc, { port, publicHosts, runtime, sessionSyncJournal: syncJournal, shutdownSignal: shutdown.signal, codexReset,
    // Resume durable messages only after the proxy serves this healthy process.
    submissionsServing: async () => {
      if (!proxyPort) return true;
      try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/__deployment`, { signal: AbortSignal.timeout(1500) });
        const identity = await response.json() as { pid?: number; phase?: string };
        return response.ok && identity.pid === process.pid && identity.phase === 'ready';
      } catch { return false; }
    },
    // 小马伙伴：DeepSeek Flash 关闭推理；每次对话独立、无工具、无会话。
    gameCompanion: new GameCompanionService({
      port: recordDeepSeekPort(piModelPort({ ...(piConfigDir ? { piConfigDir } : {}) }), svc.deepseekUsage),
      webProvider: () => svc.webResearchProvider()
    }),
    // 打卡纪念卡上的四句小诗：同一套 DeepSeek 凭据，用量记入「产物 · 打卡小诗」。
    challengePoemPort: recordDeepSeekPort(piModelPort({ ...(piConfigDir ? { piConfigDir } : {}) }), svc.deepseekUsage),
    // 挑战目标的图标：按名字挑一个 emoji，用量记入「产物 · 目标图标」。
    challengeIconPort: recordDeepSeekPort(piModelPort({ ...(piConfigDir ? { piConfigDir } : {}) }), svc.deepseekUsage),
    // 错题本：同一套 DeepSeek 凭据（Flash + 高推理），用量记入「产物 · 错题本」。
    wrongBookPort: recordDeepSeekPort(piModelPort({ ...(piConfigDir ? { piConfigDir } : {}) }), svc.deepseekUsage),
    // 产物智能打标：同一条 DeepSeek Flash 调用，用量记入「产物 · 智能打标」。
    artifactTagPort: recordDeepSeekPort(piModelPort({ ...(piConfigDir ? { piConfigDir } : {}) }), svc.deepseekUsage),
    // 记忆阅读标题独立生成，不进入 Hermes 的记忆消费。
    memoryTitlePort: recordDeepSeekPort(piModelPort({ ...(piConfigDir ? { piConfigDir } : {}) }), svc.deepseekUsage),
    // 股票页左侧记账助手：默认 DeepSeek Flash + 高推理。
    ledgerChatPort: recordDeepSeekPort(piModelPort({ ...(piConfigDir ? { piConfigDir } : {}) }), svc.deepseekUsage),
    ...(proxyPort ? { proxyPort } : {}),
    webPush: { dir: join(dataDir, "notifications"), subject: process.env["PI_WEB_PUSH_SUBJECT"] ?? `https://${publicHosts[0] ?? "localhost"}` },
    shareFile: join(dataDir, "artifact-shares.json"),
    evalDir: process.env["PI_AGENT_EVAL_DIR"] ?? join(dataDir, "eval-artifacts"),
    ...(deployQueue ? { deployQueue } : {}), ...(password ? { login: { password, sessionFile: join(dataDir, "auth-sessions.json") } } : {}),
    ...(diagnostics ? { diagnostics } : {}) });
  mark("web-app");
  const stopCodexReset = startCodexResetScheduler({ service: codexReset, log: (m) => console.warn(`[codex-reset] ${m}`) });
  shutdown.signal.addEventListener("abort", stopCodexReset, { once: true });
  await runtime.recovered;
  gate.ready(app.fetch as unknown as AppFetch);
  deployment.ready();
  // V3.52：局域网探针（只回答 HMAC，不含数据）。PI_AGENT_LAN_PROBE_PORT=off 关闭；开发实例不开；已激活的槽位才会走到这里，旧槽位占着端口时自动重试接手。
  const { loadProbeKey, probePort, startLanProbe } = await import("./lan-probe.js");
  const lanPort = probePort(process.env);
  if (lanPort !== undefined && isDeployedSlot(process.cwd())) startLanProbe({ port: lanPort, key: loadProbeKey(dataDir) });
  // V3.53：局域网入口（明文 HTTP，只收私网来源且必须带设备凭据；PI_AGENT_LAN_APP_PORT=off 关闭）。同一个应用，权限与公网访问相同。
  const { lanAppPort, startLanApp } = await import("./lan-gateway.js");
  const lanApp = lanAppPort(process.env);
  if (lanApp !== undefined && isDeployedSlot(process.cwd())) startLanApp({ port: lanApp, appPort: port, fetch: app.fetch as never });
  // 切换后旧进程收尾：SSE 立即结束，其余在途请求最多再等 10 秒（手机走备用入口时一个响应体可能要传好几秒，3 秒会把它截断）。
  // 请求都结束就立刻退出，这个上限只在有慢响应时才会用满；监督进程的等待预算（grace + 32s）已覆盖。
  const graceMs = Math.max(0, Number(process.env["PI_AGENT_SHUTDOWN_GRACE_MS"] ?? 10_000) || 0);
  let stopRanking = () => {};
  let stopErrorStats = () => {};
  const graceful = createGracefulShutdown(http, {
    shutdown,
    graceMs,
    onFinish: async () => {
      try { syncJournal.flush(); } catch { /* 落库失败不阻止退出 */ }
      svc.noteCategories.stop(); svc.noteIterations.stop(); svc.noteKinds.stop(); stopErrorStats(); stopRanking(); diagnostics?.stop();
      try { await runtime.shutdownAndWait(); }
      catch (error) { console.error("Runtime shutdown persistence failed:", error); }
      finally { process.exit(0); }
    }
  });
  startEventLoopLagMonitor(diagnostics ? { onLag: (lag) => diagnostics.lag(lag) } : {});
  // B 期：每晚 DeepSeek 分诊 + 自动建 debug 待办；用户上报即时分诊。只在前置代理实际转发给本进程时跑（notes.json 只有一个写者）。
  const servingThisProcess = async () => {
    if (!proxyPort) return true;
    try { const d = await fetch(`http://127.0.0.1:${proxyPort}/__deployment`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json() as Promise<{ pid?: number; phase?: string }>); return d.pid === process.pid && d.phase === "ready"; }
    catch { return false; }
  };
  // 推荐排序：每天北京时间 03:00 按最近的忽略/启动/完成行为校准算法权重；只有当前在线槽位跑。
  const { startRankingScheduler } = await import("./note-ranking.js");
  stopRanking = startRankingScheduler({ update: () => svc.noteIterations.updateRanking(), isServing: servingThisProcess, log: (m) => console.warn(`[notes] ${m}`) });
  if (diagnostics) {
    const triage = new DiagnosticTriage({
      store: diagnostics.store, findings: diagnostics.findings, repoRoot: REPO,
      port: recordDeepSeekPort(piModelPort({ ...(piConfigDir ? { piConfigDir } : {}) }), svc.deepseekUsage),
      notes: diagnosticNotes(svc, (m) => { console.warn(`[diagnostics] ${m}`); diagnostics.store.noteError(new Error(m)); })
    });
    diagnostics.triage = triage;
    diagnostics.verifier = new FixVerifier({ store: diagnostics.store, findings: diagnostics.findings, repoRoot: REPO });
    diagnostics.onBundle = (info) => {
      if (!info.manual) return;
      void (async () => { if (await servingThisProcess()) await triage.triageReport(info.id); })().catch((e) => { console.warn(`[diagnostics] 上报分诊失败：${(e as Error).message}`); diagnostics.store.noteError(e); });
    };
    // 每晚错误统计（23:50 北京时间）：工具 / 部署 / 记忆强约束报错增量入库，跨 runtime 重复的建待办
    const { ErrorStatsStore } = await import("./error-stats/store.js");
    const { ErrorStatsService, startErrorStatsScheduler } = await import("./error-stats/service.js");
    const { enforcementRule } = await import("@pi-agent/runtime-sessions");
    const jointIssues = () => {
      const issues = diagnostics.findings.all().filter(f => f.noteId && f.triage && !["ignored", "verified", "note_deleted"].includes(f.status)).map(f => ({ noteId: f.noteId!, title: f.triage!.title, cause: f.triage!.likelyCause }));
      for (const [fp, todo] of Object.entries(errorStats.store.state.todos)) {
        const a = errorStats.store.state.assessments[fp];
        if (a && !todo.closedAt) issues.push({ noteId: todo.noteId, title: a.title, cause: a.rootCause });
      }
      return issues.filter((i, n, all) => all.findIndex(j => j.noteId === i.noteId) === n && (() => { try { return !svc.getNote(i.noteId).done; } catch { return false; } })()).slice(-40);
    };
    triage.jointIssues = jointIssues;
    triage.jointEvidence = () => JSON.stringify([...errorStats.store.stats().values()].sort((a, b) => b.last - a.last).slice(0, 15).map(s => ({ fingerprint: s.fingerprint, total: s.total, first: s.first, last: s.last, samples: Object.values(s.runtimes).map(x => x?.sample?.slice(0, 240)) })));
    const errorStats: import("./error-stats/service.js").ErrorStatsService = new ErrorStatsService({
      jointIssues,
      jointEvidence: () => JSON.stringify(diagnostics.findings.all().slice(-15).map(f => ({ fingerprint: f.fingerprint, bundles: f.bundleIds, title: f.triage?.title, cause: f.triage?.likelyCause, noteId: f.noteId }))),
      analyzeDiagnostics: async (run) => {
        try { await diagnostics.verifier!.run(); } catch (e) { diagnostics.store.noteError(e); }
        const result = await triage.runNightly(run.trigger === "manual");
        const latest = diagnostics.findings.runs().at(-1);
        if (latest && latest.startedAt >= run.startedAt) run.costUsd += latest.costUsd;
        const findings = diagnostics.findings.all().filter(f => f.triage && f.triage.at >= run.startedAt);
        run.assessments = findings.map(f => ({ title: f.triage!.title, verdict: f.triage!.verdict === "fix" ? "do" : f.triage!.verdict === "no_fix" ? "skip" : "unsure", confidence: f.triage!.confidence, reason: f.triage!.likelyCause, ...(f.noteId ? { noteId: f.noteId } : {}) }));
        run.created = result.created;
        run.createdTodos = result.created.map(noteId => ({ noteId, title: findings.find(f => f.noteId === noteId)?.summary ?? "链路故障" }));
        run.note = `联合分析：链路分诊 ${result.triaged} 个问题${result.skipped ? `（${result.skipped}）` : ""}；工具 / 部署 / 记忆错误统计`;
        if (result.skipped && !["done-today", "disabled"].includes(result.skipped)) throw new Error(result.skipped);
      },
      store: new ErrorStatsStore({ dir: diagnosticsDir(dataDir) }), runtimeDir: join(dataDir, "runtime"),
      port: recordDeepSeekPort(piModelPort({ ...(piConfigDir ? { piConfigDir } : {}) }), svc.deepseekUsage),
      notes: errorStatsNotes(svc, (m) => console.warn(`[error-stats] ${m}`)), ruleTitle: (id) => enforcementRule(id)?.title, ruleInfo: (id) => enforcementRule(id), repoRoot: REPO,
      ...(Number(process.env["PI_AGENT_ERROR_STATS_BUDGET_USD"]) > 0 ? { assessBudgetUsd: Number(process.env["PI_AGENT_ERROR_STATS_BUDGET_USD"]) } : {}),
      log: (m) => console.warn(`[error-stats] ${m}`)
    });
    diagnostics.errorStatsNoteIds = () => errorStats.store.noteIds();
    diagnostics.errorStats = errorStats;
    stopErrorStats = startErrorStatsScheduler({ service: errorStats, isServing: servingThisProcess, log: (m) => console.warn(`[error-stats] ${m}`) });

  }
  // 部署实际生效（前置代理确认在给这个进程转发请求）后记一条 release ↔ commit；只构建或排队不算上线。
  if (diagnostics) void (async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const live = proxyPort ? await fetch(`http://127.0.0.1:${proxyPort}/__deployment`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json() as Promise<{ pid?: number; phase?: string }>).then((d) => d.pid === process.pid && d.phase === "ready") : true;
        if (live) {
          diagnostics.recordActivation();
          // 新 release 生效：马上核对一次哪些修复已经上线（待上线 → 观察中）
          void diagnostics.verifier?.run().catch((e) => diagnostics.store.noteError(e));
          return;
        }
      } catch { /* 代理暂时没回应：稍后再看 */ }
      await new Promise((r) => setTimeout(r, 5000).unref());
    }
  })();
  realStop = graceful;
  if (stopping) graceful(); // 初始化期间收到 SIGTERM：立刻按已就绪路径收尾
  mark("ready");
  console.log(`pi-agent 控制台：http://127.0.0.1:${port}${publicHosts.length ? `，对外 ${publicHosts.map((h) => `https://${h}`).join("、")}${password ? "（需登录）" : ""}` : ""}  （数据目录 ${dataDir}）`);
} catch (e) {
  console.error("pi-agent 启动失败：", e instanceof Error ? e.stack ?? e.message : e);
  try { http.close(); } catch { /* 尽力而为 */ }
  process.exit(1);
}
