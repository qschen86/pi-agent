import type { OpenSourceRelease } from './open-source-release.js';
import { CommunicationsStore } from './communications-store.js';
import { LocalCliInventory } from './local-cli-resources.js';
import { mountLinkPreviewRoutes } from './link-preview.js';
import { mountCommunicationsRoutes } from './communications-routes.js';
import { readOnlyPermissionMode } from '../../../packages/runtime-sessions/src/permissions.js';
import type { CalendarEvent } from "./calendar.js";
import { RuntimeRecordAuth } from "./runtime-record-auth.js";
import { resolveRecordSources, relationSources } from "./note-relation-service.js";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdtempSync } from "node:fs";
import { entryKey, parseEntryKey } from "./note-relations.js";
import { RelationError, type RelationContext } from "./note-relation-types.js";
import {RuntimeMemoryPort} from './memory/port.js';
import { MemorySyncService } from './memory/service.js';
import { mountMemoryRoutes } from './memory/routes.js';
import { PublicMemoryService } from './memory/public/service.js';
import { PublicMemoryStore } from './memory/public/store.js';
import { buildCatalog, projectAliasesOf, canonicalProjectOf } from './memory/public/projects.js';
import { mountPublicMemoryRoutes } from './memory/public/routes.js';
import { PipelineService, needsInstantIntake, pipelineRoot } from './memory/public/pipeline/service.js';
import { mountArchitectureRoutes } from './memory/architecture/routes.js';
import { captureSessions } from './memory/public/pipeline/capture.js';
import { PipelineStore } from './memory/public/pipeline/store.js';
import { mountPipelineRoutes } from './memory/public/pipeline/routes.js';
import { gitTitleResolver } from './memory/public/pipeline/git-title.js';
import { createRuleJudge } from './memory/public/pipeline/rule-judge.js';
import { evidenceReaders } from './memory/public/pipeline/evidence-readers.js';
import { RoomService } from "./room-service.js";
import { mountRoomRoutes } from "./room-routes.js";
/**
 * 控制台 HTTP 层（Hono）：接口 + 实时推送（SSE）+ 静态页面。
 *
 * 只监听 127.0.0.1。但"只监听本机"不等于安全：你浏览的任何网页都能让浏览器
 * 向 localhost 发请求。所以：
 *   - 校验 Host（防 DNS 重绑定：恶意域名解析到 127.0.0.1 后冒充同源）
 *   - 写操作校验 Origin（防跨站请求伪造：别的网页替你发起任务、替你点批准）
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { Context } from "hono";
import type { IterationView } from "./note-iterations.js";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { ConsoleConflict, ConsoleError, ConsoleService } from "./console.js";
import type { PickFolderInput } from "./console.js";
import { NOTE_IMAGE_MAX_BYTES, type NoteImage } from "./notes.js";
import { noteCalendarEvents, eventsInRange } from "./calendar.js";
import { beijingDayStartMs } from "./platform-time.js";
import type { DeepSeekRuntimeSession } from "./deepseek-usage.js";
import { readBilling, todayCost } from "./platform-billing.js";
import { STATS_DEFAULT_DAYS, STATS_MAX_DAYS, StatsService } from "./stats.js";
import { turnOriginsAt } from "./turn-origin.js";
import { agentCalendarEvents, scanAgentScheduledTasks, type AgentCalendarScanOptions } from "./agent-calendar.js";
import { GoogleCalendarService } from "./google-calendar.js";
import { noteRefLookup } from "./note-ref-backfill.js";
import { AuthSessions, type AuthFailureReason } from "./auth-sessions.js";
import { RuntimeAuthFlowManager, allowlistedEnv, type RuntimeKind, type RuntimeSessionManager, type UsageRecord } from "@pi-agent/runtime-sessions";
import { mountRuntimeRoutes, type RuntimeAuthCapability, type RuntimeAuthService } from "./runtime-routes.js";
import { mountUploadRequestDiagnostics } from "./upload-diagnostics.js";
import { launchTimingLine, mountDocumentLog, mountSlowRequestLog } from "./slow-diagnostics.js";
import type { DeployQueue } from "./deploy-queue.js";
import {SessionSyncJournal} from './session-sync.js';
import {RuntimeSyncSources} from './runtime-sync-source.js';
import {announceHandoff, streamLifetime} from './stream-lifetime.js';
import {RoomSyncSources} from './room-sync-source.js';
import { WebPushService, type WebPushConfig } from "./web-push.js";
import { NoteReminders, scanNoteReminders } from "./note-reminders.js";
import type { NativeNotifications } from "./native-notifications.js";
import { mountNativeNotificationRoutes } from "./native-notification-routes.js";
import { fcmFromServiceAccount } from "./native-fcm.js";
import { mountAndroidReleaseRoutes } from "./android-release-routes.js";
import { resolveAndroidConfig } from "./android-config.js";
import { loadProbeKey, mountLanNetworkRoute, probePort } from "./lan-probe.js";
import { mountHostStatsRoute } from "./host-stats.js";
import type { CodexResetService } from "./codex-reset/service.js";
import { mountCodexResetRoutes } from "./codex-reset/routes.js";
import type { RuntimeUpdatesService } from "./runtime-updates/service.js";
import { mountRuntimeUpdatesRoutes } from "./runtime-updates/routes.js";
import { lanAppPort } from "./lan-gateway.js";
import { mountNotificationRoutes } from "./notification-routes.js";
import { runtimeQuotaServices } from "./resources.js";
import {STATIC} from "./static-asset-map.js";
import {StaticEncodings,selectEncoding} from "./static-encodings.js";
import {StaticRelease} from './static-release.js';
import {ArtifactLibrary, ARTIFACT_CSP} from './artifacts.js';
import { ArtifactCollections } from './artifact-collections.js';
import { ArtifactTagger } from './artifact-tagging.js';
import { mountArtifactCollectionRoutes } from './artifact-collection-routes.js';
import { readPreviewFile, temporaryFileReferences } from './file-preview.js';
import {EvalArtifacts, EVAL_CSP, evalEtag} from './eval-artifacts.js';
import { StockLedger } from './stock-ledger.js';
import { authenticateApiRequest } from './device-auth.js';
import { anonymousDevicePairRequest, mountDevicePairRoutes } from './device-pair-routes.js';
import { mountStockLedgerRoutes } from './stock-ledger-routes.js';
import { NavigationPreferences, NavigationPreferencesError } from './navigation-preferences.js';
import { LedgerChatService } from './ledger-chat.js';
import type { ModelInvocationPort } from '@pi-agent/model-port';
import { ArtifactShares } from './artifact-shares.js';
import { isSharePath, mountShareRoutes } from './share-routes.js';
import { challengeShareExtension } from './challenge-share.js';
import { appData } from './app-data.js';
import { AppSwitchError, AppSwitches } from './app-switches.js';
import { appOfArtifact, isPathOfApps } from './app-manifest.mjs';
import { ChallengeStore } from './challenge-store.js';
import { mountChallengeRoutes } from './challenge-routes.js';
import { ChallengeIconService } from './challenge-icon.js';
import { ChallengePoemService } from './challenge-poem.js';
import { WrongBookStore } from './wrong-book-store.js';
import { WrongBookService } from './wrong-book-service.js';
import { mountWrongBookRoutes } from './wrong-book-routes.js';
import { mountDiagramRoutes, type PlantUmlRenderer } from './diagram-render.js';
import { GameCompanionError, GameCompanionService } from './game-companion.js';
import type { ServerDiagnostics } from './diagnostics/server-diagnostics.js';
import { diagnosticsOf, mountDiagnosticsRoutes, mountRequestIds, requestIdOf } from './diagnostics/routes.js';
import { RepairSessions, type RuntimeLike as RepairRuntime } from './diagnostics/repair.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../public");

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
].join("; ");
// 登录页与浏览器标签页也要显示 pi 图标：这些品牌资源不放进登录门禁。
const PUBLIC_STATIC = new Set([
  "/favicon.svg", "/manifest.webmanifest", "/sw.js", "/image-intake-store.js", "/apple-touch-icon.png",
  "/icons/app-icon.svg", "/icons/app-icon-maskable.svg",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png",
  "/icons/icon-mark-192.png", "/icons/icon-mark-512.png", "/icons/app-icon-mark.svg"
]);
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  webmanifest: "application/manifest+json"
};

const SESSION_COOKIE = "pi_agent_session";
const DEVICE_SESSION_COOKIE = "pi_agent_device_session";

/**
 * 对外登录。maxFailures / windowMs：窗口内猜错这么多次，登录整体暂停到最早那次过期——不按来源 IP 算，
 * 经 frp 进来的请求来源都是本机，看不到真实 IP。failureDelayMs：每次猜错多等一会儿。
 */
export interface LoginOptions {
  password: string; maxFailures?: number; windowMs?: number; failureDelayMs?: number;
  /** V2.8：服务端登录会话的存放文件（不给则只在内存）；绝对期限与闲置期限 */
  sessionFile?: string; sessionTtlMs?: number; sessionIdleMs?: number;
}
const LOGIN_HEADERS = { "referrer-policy": "same-origin", "cache-control": "no-store" };

function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function imageShareReturn(c: Context): string {
  const ids = new URL(c.req.url).searchParams.getAll('shareId');
  return ids.length === 1 && /^[a-f0-9]{32}$/.test(ids[0] ?? '') ? ids[0]! : '';
}
function notificationReturn(c: Context): string {
  const id = c.req.query("notification-session") ?? "";
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : "";
}
/** 图标按内容版本取：标签页图标浏览器缓存很久，换图标后 URL 不变就不会刷新 */
const assetVersion = (file: string): string => { try { return createHash("sha256").update(readFileSync(join(PUBLIC_DIR, file))).digest("hex").slice(0, 12); } catch { return "0"; } };
function devicePairReturn(c: Context): string {
  const id = c.req.query("device-pair") ?? (new URL(c.req.url).pathname === "/device-pair" ? c.req.query("id") : "") ?? "";
  return /^[a-f0-9]{32}$/.test(id) ? id : "";
}
function loginPage(error?: string, session = "", shareId = "", pairId = ""): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · 合己 heji</title><meta name="theme-color" content="#f1f1f9"><link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg?v=${assetVersion("favicon.svg")}"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=${assetVersion("apple-touch-icon.png")}"><link rel="manifest" href="/manifest.webmanifest?v=${assetVersion("manifest.webmanifest")}" crossorigin="use-credentials"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="heji"><link rel="stylesheet" href="/styles.css"></head>
<body><main class="login-page"><form method="post" action="/login${pairId ? `?device-pair=${pairId}` : shareId ? `?shareId=${shareId}` : session ? `?notification-session=${session}` : ""}" class="login-card">
<h1>合己 heji</h1>${error ? `<p class="login-error">${error}</p>` : ""}
<label>密码 <input type="password" name="password" autocomplete="current-password" autofocus required></label>
<button type="submit">登录</button></form></main></body></html>`;
}

/**
 * publicHosts：经反向代理（Cloudflare Tunnel、frp）对外提供时的域名，Origin 按同域名放行。
 * login：对外域名上的请求必须先登录（cookie）；本机 127.0.0.1 / localhost 不受影响。
 * 不配 login 时对外域名不带任何鉴权，身份校验只能靠代理那一层（例如 Cloudflare Access）。
 */
/**
 * 启动对账：把关联会话已归档的待办标记完成。
 * 本特性上线前归档的会话不会再发 `archived` 事件，所以启动时按当前绑定补标一次；幂等，可在每次启动调用。
 * 不放进 createWebApp：它是服务启动的职责，且测试会用只实现了部分方法的 runtime 替身。
 */
export function reconcileArchivedNotes(svc: ConsoleService, runtime: RuntimeSessionManager): number {
  return svc.completeArchivedSessionNotes(runtime.archivedNoteIds()) + reconcileIterations(svc, runtime);
}

/** 推荐任务会话归档：来源待办一并标记完成；每个任务只处理一次，不让归档或启动失败。 */
function reconcileIterations(svc: ConsoleService, runtime: RuntimeSessionManager): number {
  try { return svc.noteIterations.reconcile(runtime.store.allBindings()); }
  catch (e) { console.error("推荐任务归档对账失败：", e); return 0; }
}

/**
 * 启动对账：从待办发起的会话历史上可能丢了 noteRef（删掉引用 chip 就把整条关联清空了，正文里还留着引用块）。
 * 按引用块的「记于」时间与首行文字反查待办（规则见 note-ref-backfill.ts），唯一命中才补。
 * 幂等，可在每次启动调用；不动已归档会话（它们的待办完成状态已单独对账）。
 */
export function reconcileSessionNoteRefs(svc: ConsoleService, runtime: RuntimeSessionManager): number {
  try {
    const { repaired } = runtime.backfillNoteRefs(noteRefLookup(svc.listNotes()));
    if (repaired.length) console.log(`补记会话关联待办：${repaired.map((r) => `${r.platformSessionId} → ${r.noteId}`).join("、")}`);
    return repaired.length;
  } catch (e) { console.error("会话关联待办对账失败：", e); return 0; }
}

export function createWebApp(svc: ConsoleService, options: { port?: number; dataDir?: string; googleCalendar?: GoogleCalendarService; publicHosts?: string[]; login?: LoginOptions; runtime?: RuntimeSessionManager; runtimeAuth?: RuntimeAuthService; rooms?: RoomService; revealFile?: (absPath: string) => Promise<void>; deployQueue?: DeployQueue;sessionSyncEnabled?:boolean;sessionSyncJournal?:SessionSyncJournal;shutdownSignal?:AbortSignal;submissionsServing?:()=>Promise<boolean>;proxyPort?:number;codexReset?:CodexResetService;runtimeUpdates?:RuntimeUpdatesService; webPush?: WebPushConfig; staticCompression?:boolean;staticEncodingDir?:string;staticReleaseDir?:string; shareFile?: string; evalDir?: string; gameCompanion?: GameCompanionService; plantUml?: PlantUmlRenderer;
  /** 股票页左侧记账助手用的模型端口（默认 DeepSeek Flash + 高推理；不传则页面提示暂时不可用） */
  ledgerChatPort?: ModelInvocationPort;
  /** 心愿挑战岛打卡纪念卡小诗（默认 DeepSeek Flash，关闭推理）。 */
  challengePoemPort?: ModelInvocationPort;
  /** 心愿挑战岛「自动配一个图标」：按名字挑一个 emoji（默认 DeepSeek Flash，关闭推理）。 */
  challengeIconPort?: ModelInvocationPort;
  /** 错题本：识图、出题、验题、讲解共用的模型端口；不传就只能浏览已有数据。 */
  wrongBookPort?: ModelInvocationPort;
  /** 可选应用开关（设置里启用 / 关闭）：edition 'full' 是完整实例（默认全开，保持现状）；'homebrew' 是公开版（默认只开基础）。不传按完整实例。 */
  openSourceRelease?: OpenSourceRelease;
  appSwitches?: { edition: 'full' | 'homebrew' };
  /** 产物智能打标：点「加入产物」时按内容选标签；不传则接口返回 503。 */
  artifactTagPort?: ModelInvocationPort;
  /** 异步生成人类阅读标题，记忆原文及检索不依赖此端口。 */
  memoryTitlePort?: ModelInvocationPort;
  /** Codex / Claude 记忆只读视图；null 关闭（测试用），不给则按账本目录自动创建 */
  /** Agent 日历：Codex automations / Pi launchd 定时任务的扫描目录（测试注入） */
  agentCalendar?: AgentCalendarScanOptions;
  /** V1.4 故障诊断：请求 ID、服务端事件、前端事件与证据包（main.ts 创建；不传则只有请求 ID） */
  memorySyncEnabled?: boolean; diagnostics?: ServerDiagnostics } = {}): Hono & { appSwitches: AppSwitches | null } {
  const app = new Hono();
  // 日历服务按需创建：通知等测试替身没有 dataDir，不应因为无关接口而报错。
  let googleCalendar: GoogleCalendarService | undefined = options.googleCalendar;
  const calendarService = (): GoogleCalendarService => {
    if (!googleCalendar) {
      const dir = options.dataDir ?? svc.dataDir;
      if (!dir) throw new ConsoleError("没有可用的日历数据目录");
      googleCalendar = new GoogleCalendarService({ dir });
    }
    return googleCalendar;
  };
  if(svc.noteRelations){svc.noteRelations.resolveExternal=ref=>calendarService().resolveRelationEntry(ref);svc.noteRelations.externalAuthorized=ref=>calendarService().relationAuthorized(ref);}
  let recordAuth:RuntimeRecordAuth|undefined;
  if(options.runtime?.setRecordAccessProvider){recordAuth=new RuntimeRecordAuth(mkdtempSync(join(tmpdir(),"pi-record-clients-")),`http://127.0.0.1:${options.proxyPort??options.port??8780}`);options.runtime.setRecordAccessProvider((binding,turn)=>recordAuth!.issue(binding.platformSessionId,turn));options.runtime.on('session',({platformSessionId}:{platformSessionId:string})=>{const binding=options.runtime!.store.binding(platformSessionId);recordAuth?.retain(platformSessionId,binding&&!binding.archived?binding.turns.filter(t=>t.status==='running'||t.status==='waiting-input').map(t=>t.clientMessageId):[]);});options.runtime.on("archived",({platformSessionId}:{platformSessionId:string})=>recordAuth?.revoke(platformSessionId));options.shutdownSignal?.addEventListener("abort",()=>recordAuth?.dispose(),{once:true});}
  const staticEncodings=new StaticEncodings(options.staticEncodingDir??join(PUBLIC_DIR,".precompressed"),options.staticCompression??process.env["PI_WEB_STATIC_COMPRESSION"]!=="0");
  const staticRelease=new StaticRelease(options.staticReleaseDir??join(PUBLIC_DIR,'.release'));
  const artifacts = new ArtifactLibrary();
  // 股票账户记账：页面与 agent 共用一套接口；写入后通过站内 SSE 让其它标签页刷新。
  // 只实现了部分方法的测试替身可能没有 dataDir；那种装配不挂记账接口，不影响生产。
  const ledgerDir = options.dataDir ?? svc.dataDir;
  // 产物里的「我的」内容：图片 / 视频 / md / html 打标签收进来，条目只记来源。
  const artifactCollections = ledgerDir ? new ArtifactCollections(appData(ledgerDir, 'artifacts').path('artifact-collections.json')) : null;
  const artifactTagger = options.artifactTagPort ? new ArtifactTagger(options.artifactTagPort) : null;
  const stockLedger = ledgerDir && options.appSwitches?.edition !== 'homebrew'
    ? new StockLedger(appData(ledgerDir, 'ledger').path('stock-ledger.json'), () => svc.emit('update', { sessionId: '', kind: 'ledger' }))
    : null;
  // 心愿挑战岛：打卡记录、照片、积分都落在 Mac Mini 的数据目录，换设备不会丢。
  const challenge = ledgerDir ? new ChallengeStore(ledgerDir) : null;
  // 卡上的四句小诗：只把心愿与相框主题发给模型，照片不出本机。
  const challengePoem = challenge ? new ChallengePoemService({ port: options.challengePoemPort }) : null;
  // 图标：同上，只把名字和类别发给模型。
  const challengeIcon = challenge ? new ChallengeIconService({ port: options.challengeIconPort }) : null;
  // 一级导航偏好是账号级配置：保存到服务端数据目录，登录的其它设备读取同一份。
  // 可选应用开关：同样是实例级配置，关闭只隐藏入口、拒绝请求、停后台任务，不删数据。
  const appSwitchEdition = options.appSwitches?.edition ?? 'full';
  const appSwitches = ledgerDir ? new AppSwitches(appData(ledgerDir, 'shell').path('app-switches.json'), { edition: appSwitchEdition, defaultOn: appSwitchEdition === 'full' ? 'all' : 'core' }) : null;
  const navigationPreferences = ledgerDir ? new NavigationPreferences(appData(ledgerDir, 'shell').path('navigation.json')) : null;
  const diagnostics = options.diagnostics;
  diagnostics?.attachRelease(() => staticRelease.manifest);
  // 诊断待办不进推荐整理器的合并池，直接成为单条推荐（V1.4 §7.2）
  if (diagnostics) svc.noteIterations.setDirectSingles((noteId) => diagnostics.findings.noteIds().has(noteId) || (diagnostics.errorStatsNoteIds?.().has(noteId) ?? false));
  // C 期：从诊断待办发起的会话拿到证据包副本，报告由平台校验后导入（V1.4 §8）
  if (diagnostics && options.runtime && !diagnostics.repair) { diagnostics.repair = new RepairSessions({ diagnostics, runtime: options.runtime as unknown as RepairRuntime }); diagnostics.repair.start(); }
  mountRequestIds(app, diagnostics);
  mountUploadRequestDiagnostics(app);
  mountSlowRequestLog(app, diagnostics ? { onSlow: (e) => diagnostics.slowRequest(e) } : {});
  mountDocumentLog(app);
  const port = options.port ?? 8788;
  const publicHosts = options.publicHosts ?? [];
  // 经前置代理访问时，本机请求的 Host/Origin 是代理端口（如 127.0.0.1:8780），也要放行。
  const localPorts = [port, ...(options.proxyPort && options.proxyPort !== port ? [options.proxyPort] : [])];
  const allowedHosts = new Set([...localPorts.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]), ...publicHosts]);
  const allowedOrigins = new Set([...localPorts.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]), ...publicHosts.flatMap((h) => [`https://${h}`, `http://${h}`])]);
  const publicHostSet = new Set(publicHosts);
  // V2.8：每次登录一个随机 token，服务端可让它过期、单独吊销（旧的密码派生固定 token 不再有效）
  const auth = options.login ? new AuthSessions({
    password: options.login.password,
    ...(options.login.sessionFile ? { file: options.login.sessionFile } : {}),
    ...(options.login.sessionTtlMs ? { ttlMs: options.login.sessionTtlMs } : {}),
    ...(options.login.sessionIdleMs ? { idleMs: options.login.sessionIdleMs } : {})
  }) : undefined;
  // 诊断：每次因登录无效拒绝请求都记一行（不含 token），同一原因/登录/路径每分钟最多一行。
  // 槽位与进程号用来对照部署时间线（两个槽位各自持有一份登录记录）。
  const authLogAt = new Map<string, number>();
  const logAuthFailure = (c: Context, kind: "api-401" | "page-login" | "sync-401", reason: AuthFailureReason | "session-changed", id?: string): void => {
    if (new URL(c.req.url).pathname.startsWith('/api/auth/device-pairs')) return;
    // 部署健康检查等本机探测不经过 Cloudflare，不带登录是预期的
    if (reason === "no-cookie" && !c.req.header("cf-connecting-ip")) return;
    const path = new URL(c.req.url).pathname, now = Date.now(), key = `${kind}|${reason}|${id ?? ""}|${path}`;
    if (now - (authLogAt.get(key) ?? 0) < 60_000) return;
    if (authLogAt.size > 500) authLogAt.clear();
    authLogAt.set(key, now);
    const ua = (c.req.header("user-agent") ?? "").replace(/\s+/g, " ").slice(0, 80);
    console.warn(`[auth-401] ${new Date(now).toISOString()} ${kind} ${c.req.method} ${path} reason=${reason}${id ? ` login=${id}` : ""} slot=${process.env["PI_AGENT_WEB_SLOT"] ?? "-"} pid=${process.pid} ua="${ua}"`);
  };
  /** 请求来自对外入口：Host 是对外域名，或经过反向代理（带转发头） */
  const isPublic = (c: Context) => getCookie(c, DEVICE_SESSION_COOKIE) !== undefined || c.req.header('authorization') !== undefined || publicHostSet.has(c.req.header("host") ?? "") || !!c.req.header("cf-connecting-ip") || !!c.req.header("x-forwarded-for");
  const maxFailures = options.login?.maxFailures ?? 10;
  const windowMs = options.login?.windowMs ?? 15 * 60_000;
  let failures: number[] = [];

  app.use("*", async (c, next) => {
    if (new URL(c.req.url).pathname.startsWith("/api/communications/")) c.header("Cache-Control", "private, no-store");
    const host = c.req.header("host");
    // 进程内测试请求不带 Host；真实浏览器请求一定带。
    if (host !== undefined && !allowedHosts.has(host)) return c.json({ error: "Host 不被允许" }, 403);
    const path = new URL(c.req.url).pathname;
    // 登录表单不查 Origin：登录只能登进这唯一一个账号，被别的网站代提交也没有危害
    const loginSubmit = options.login !== undefined && path === "/login" && publicHostSet.has(host ?? "");
    if (c.req.method !== "GET" && !loginSubmit) {
      const origin = c.req.header("origin");
      // 有的浏览器（隐私设置、no-referrer）把同源请求的 Origin 报成 "null"：改看浏览器自己加、网页伪造不了的 Sec-Fetch-Site
      const sameOriginNull = origin === "null" && c.req.header("sec-fetch-site") === "same-origin";
      if (origin !== undefined && !allowedOrigins.has(origin) && !sameOriginNull) {
        console.warn(`拒绝跨站请求：${c.req.method} ${path.startsWith("/api/auth/device-pairs") ? "/api/auth/device-pairs/[redacted]" : path}，Origin ${origin}，Sec-Fetch-Site ${c.req.header("sec-fetch-site") ?? "-"}，Host ${host ?? "-"}，UA ${c.req.header("user-agent") ?? "-"}`);
        return c.json({ error: "跨站请求被拒绝" }, 403);
      }
    }
    await next();
    // 不许被嵌入：否则别的网站能用透明 iframe 诱导你点「批准」（点击劫持，Origin 检查拦不住）。
    // CSP 是渲染模型输出的纵深防御：页面只认同源脚本与样式，内联脚本一律不执行。
    // 交付物的 HTML 预览自带更严的 CSP（v2.5 F03，只能被控制台自己嵌入）：不覆盖，框架限同源
    const own = c.res.headers.get("content-security-policy");
    c.res.headers.set("x-frame-options", own ? "SAMEORIGIN" : "DENY");
    if (!own) c.res.headers.set("content-security-policy", CSP);
    c.res.headers.set("x-content-type-options", "nosniff");
    // 登录页例外（same-origin）：no-referrer 下浏览器提交表单时 Origin 会变成 "null"，被上面的检查拒掉
    if (!c.res.headers.has("referrer-policy")) c.res.headers.set("referrer-policy", "no-referrer");
  });

  // Read diagnostics include downstream authorization, projection and JSON serialization.
  // No URL, cursor, partition or payload is exposed in the timing header.
  app.use("/api/*", async (c, next) => {
    const measured = c.req.method === "GET" && /^(?:\/api\/(?:runtime-sessions|rooms)\/[^/]+\/(?:bootstrap|restore|sync)|\/api\/session-directory|\/api\/session-sync\/capabilities)$/.test(new URL(c.req.url).pathname);
    if (!measured) return next();
    const start = performance.now();
    await next();
    if (!c.res.headers.has("Server-Timing")) c.res.headers.set("Server-Timing", `handler;dur=${(performance.now() - start).toFixed(2)}`);
  });

  app.post('/share-target', c => c.html('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>接收截图</title><p>请先打开应用完成更新，再重新分享或从相册上传。</p><a href="/#/notes">打开待办</a></html>', 200, { 'cache-control': 'no-store' }));

  // 对外域名的登录：放在上面的中间件之后，登录页同样带 CSP 等响应头
  app.use("*", async (c, next) => {
    const apiPath = new URL(c.req.url).pathname;
    const deviceCookie = getCookie(c, DEVICE_SESSION_COOKIE);
    if ((apiPath.startsWith('/api/') && c.req.header('authorization') !== undefined) || deviceCookie !== undefined) {
      if (!auth) return c.json({ error: '设备认证未启用' }, 401);
      const checked = authenticateApiRequest(auth, c.req.header('authorization') ?? `Bearer ${deviceCookie}`, undefined);
      if (!checked.ok || (c.req.header('authorization') === undefined && checked.record.kind !== 'device')) return c.json({ error: '请重新连接设备' }, 401);
      c.set('authSession' as never, checked.record.id as never);
      c.set('authSource' as never, 'bearer' as never);
      return next();
    }
    if (auth && anonymousDevicePairRequest(c.req.method, apiPath)) return next();
    if (!options.login || !auth || !publicHostSet.has(c.req.header("host") ?? "")) return next();
    const path = new URL(c.req.url).pathname;
    // 产物分享链接：有自己的分享密码与设备绑定（share-routes.ts），不走控制台登录
    if (isSharePath(path)) return next();
    if (path === "/styles.css" || PUBLIC_STATIC.has(path)) return next();
    if (path === "/login" && c.req.method === "POST") {
      const now = Date.now();
      failures = failures.filter((at) => now - at < windowMs);
      if (failures.length >= maxFailures) {
        const minutes = Math.ceil((failures[0]! + windowMs - now) / 60_000);
        return c.html(loginPage(`密码错误次数太多，登录已暂停，约 ${minutes} 分钟后再试`, notificationReturn(c), imageShareReturn(c), devicePairReturn(c)), 429, { ...LOGIN_HEADERS, "retry-after": String(minutes * 60) });
      }
      const body = await c.req.parseBody();
      const password = typeof body["password"] === "string" ? body["password"] : "";
      if (!sameSecret(password, options.login.password)) {
        failures.push(now);
        console.warn(`对外登录密码错误（${failures.length}/${maxFailures}，${Math.round(windowMs / 60_000)} 分钟内）`);
        await new Promise((r) => setTimeout(r, options.login?.failureDelayMs ?? 1000)); // 拖慢暴力猜密码
        return c.html(loginPage("密码不对", notificationReturn(c), imageShareReturn(c), devicePairReturn(c)), 401, LOGIN_HEADERS);
      }
      failures = [];
      const { token } = auth.issue(c.req.header("user-agent") ?? "");
      setCookie(c, SESSION_COOKIE, token, {
        path: "/", httpOnly: true, sameSite: "Lax", maxAge: auth.maxAgeSeconds,
        secure: c.req.header("origin")?.startsWith("https://") ?? false
      });
      const target = notificationReturn(c), shareId = imageShareReturn(c);
      return c.redirect(devicePairReturn(c) ? `/device-pair?id=${devicePairReturn(c)}` : shareId ? `/?shareId=${shareId}#/notes` : target ? `/?notification-session=${target}#/rt/${target}` : "/", 303);
    }
    const checked = auth.inspect(getCookie(c, SESSION_COOKIE));
    if (checked.ok) { c.set("authSession" as never, checked.record.id as never); return next(); }
    if (path === "/login") return c.html(loginPage(undefined, notificationReturn(c), imageShareReturn(c), devicePairReturn(c)), 200, LOGIN_HEADERS);
    if (path.startsWith("/api/")) { logAuthFailure(c, "api-401", checked.reason, checked.id); return c.json({ error: "请先登录" }, 401); }
    logAuthFailure(c, "page-login", checked.reason, checked.id);
    const target = notificationReturn(c), shareId = imageShareReturn(c);
    return c.redirect(devicePairReturn(c) ? `/login?device-pair=${devicePairReturn(c)}` : shareId ? `/login?shareId=${shareId}` : target ? `/login?notification-session=${target}` : "/login", 302);
  });

  // 已关闭的可选应用：它的接口与页面一律 404（入口在客户端同步隐藏，这里是服务端的兜底）。
  if (appSwitches) app.use('*', async (c, next) => {
    const off = appSwitches.disabledIds();
    if (off.size && isPathOfApps(new URL(c.req.url).pathname, off)) return c.json({ error: '这个应用没有启用，可以在设置 → 应用里打开', code: 'APP_DISABLED' }, 404);
    await next();
    // 把「已关闭清单」放进一个小 Cookie（只含应用 / 入口 / 路由模块的标识，不是凭据）：页面脚本同步读到，
    // 首次进入新设备时首帧就按它隐藏入口，不用先加载再刷新。清单变了才重写。
    const wanted = appSwitches.get().disabled;
    const value = JSON.stringify(wanted);
    const current = getCookie(c, 'pi_apps_off');
    const quiet = JSON.stringify({ apps: [], views: [], routeModules: [] });
    // setCookie / getCookie 自己做 URL 编解码，这里直接用原文
    if (current === undefined ? value !== quiet : current !== value) {
      setCookie(c, 'pi_apps_off', value, { path: '/', sameSite: 'Lax', maxAge: 31_536_000, httpOnly: false, secure: c.req.header('origin')?.startsWith('https://') ?? new URL(c.req.url).protocol === 'https:' });
    }
  });

  // V2.8：登录会话管理——退出、单独吊销、退出其他登录（服务端立即生效）
  const authId = (c: Context): string | undefined => c.get("authSession" as never) as string | undefined;
  const pairFile = options.login?.sessionFile ? `${options.login.sessionFile}.pairs.json` : ledgerDir ? appData(ledgerDir, 'auth').path('device-pairs.json') : undefined;
  if (auth && pairFile) mountDevicePairRoutes(app, auth, pairFile);
  const localIntakeBinding = randomBytes(32).toString('hex');
  mountLinkPreviewRoutes(app);
  app.get('/api/image-intake/access', c => {
    c.header('Cache-Control', 'private, no-store');
    return c.json({ binding: authId(c) ?? localIntakeBinding });
  });
  app.get("/api/auth/sessions", (c) => { c.header('Cache-Control', 'private, no-store'); return c.json({ enabled: !!auth, public: isPublic(c), current: authId(c) ?? null, sessions: auth ? auth.list() : [] }); });
  app.post('/api/auth/device-session/renew', c => {
    c.header('Cache-Control', 'private, no-store');
    const id = authId(c);
    if (!auth || !id) return c.json({error: '需要设备身份'}, 401);
    const record = auth.renewDevice(id);
    if (!record) return c.json({error: '设备身份不可续期'}, 403);
    return c.json({current: record.id, expiresAt: record.expiresAt});
  });
  app.get('/api/web-release', c => {
    c.header('Cache-Control', 'private, no-store');
    const m = staticRelease.manifest;
    if (!m) return c.json({ error: 'release unavailable' }, 404);
    // 大小按本次请求的 Accept-Encoding 选出的传输字节算（和真正下载时一致），bytes 是解压后的字节，用于下载进度。
    const accept = c.req.header('accept-encoding');
    const measure = (digest: string, body: Uint8Array) => {
      const reps = staticEncodings.get(digest, body), coding = selectEncoding(accept, reps) ?? 'identity';
      return { bytes: body.byteLength, transfer: (reps[coding] ?? reps.identity!).body.byteLength };
    };
    const sizes: Record<string, { bytes: number; transfer: number }> = {};
    for (const [url, digest] of Object.entries(m.assets)) { const body = staticRelease.get(url); if (body) sizes[url] = measure(digest, body); }
    const html = staticRelease.html;
    const version = (commit?: string, committedAt?: string) => ({ commit: commit && /^[a-f0-9]{40}$/.test(commit) ? commit : null, committedAt: committedAt && !Number.isNaN(Date.parse(committedAt)) ? committedAt : null });
    return c.json({
      schema: 1, release: m.release, previousRelease: m.previousRelease ?? null, assets: Object.keys(m.assets),
      sizes, document: html ? measure(createHash('sha256').update(html).digest('hex'), html) : null,
      version: { ...version(m.gitCommit, m.committedAt), dirty: !!m.dirty },
      previousVersion: m.previousRelease && m.previousVersion ? version(m.previousVersion.gitCommit, m.previousVersion.committedAt) : null,
    });
  });
  // PWA 冷启动上报：页面在启动完成时报一次，记一行 [launch]（走没走 app shell、首屏多少毫秒）。
  // 原来「杀掉重进」在日志里是空白，只能靠猜；字段固定有界，不含 UA / IP / URL。
  app.post("/api/launch-timing", async (c) => {
    c.header("Cache-Control", "private, no-store");
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "记录格式不对", code: "LAUNCH_TIMING_INPUT" }, 400); }
    const line = launchTimingLine(body);
    if (!line) return c.json({ error: "记录格式不对", code: "LAUNCH_TIMING_INPUT" }, 400);
    console.warn(`[launch] ${line}`);
    try { diagnostics?.launch(JSON.parse(line)); } catch { /* 诊断失败不影响上报 */ }
    return c.json({ ok: true });
  });
  mountDiagnosticsRoutes(app, diagnostics);
  app.post("/api/auth/logout", (c) => {
    const id = authId(c);
    if (auth && id) auth.revoke(id, "退出登录");
    setCookie(c, SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    setCookie(c, DEVICE_SESSION_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "Lax" });
    return c.json({ ok: true });
  });
  app.post("/api/auth/sessions/:id/revoke", (c) => {
    if (!auth) return c.json({ error: "没有启用对外登录" }, 400);
    return c.json({ ok: auth.revoke(c.req.param("id"), "手动吊销") });
  });
  app.post("/api/auth/revoke-others", (c) => {
    const id = authId(c);
    if (!auth || !id) return c.json({ error: "只能在对外登录状态下使用" }, 400);
    return c.json({ revoked: auth.revokeOthers(id) });
  });

  // 一级导航偏好（名称、位置、顺序、隐藏）：多端共用服务端这一份。
  if (navigationPreferences) {
    app.get("/api/navigation", (c) => {
      c.header("Cache-Control", "private, no-store");
      return c.json(navigationPreferences.get());
    });
    app.put("/api/navigation", async (c) => {
      c.header("Cache-Control", "private, no-store");
      let body: unknown;
      try { body = await c.req.json(); }
      catch { return c.json({ error: "导航配置不是合法的 JSON", code: "NAVIGATION_INPUT_INVALID" }, 400); }
      try {
        const saved = navigationPreferences.save(body);
        // 其它标签页 / 设备收到事件后重读服务端配置，不需要各自轮询。
        svc.emit("update", { sessionId: "", kind: "navigation" });
        return c.json(saved);
      } catch (e) {
        if (e instanceof NavigationPreferencesError) return c.json({ error: e.message, code: e.code }, 400);
        throw e;
      }
    });
  }

  // 可选应用开关：设置 → 应用。客户端据 disabled 隐藏入口、不加载对应的路由模块。
  if (appSwitches) {
    app.get('/api/apps', (c) => { c.header('Cache-Control', 'private, no-store'); return c.json(appSwitches.get()); });
    app.put('/api/apps/:id', async (c) => {
      c.header('Cache-Control', 'private, no-store');
      let body: { enabled?: unknown } = {};
      try { body = await c.req.json(); } catch { return c.json({ error: '请求不是合法的 JSON', code: 'APP_SWITCH_INVALID' }, 400); }
      try {
        const saved = appSwitches.set(c.req.param('id'), body.enabled);
        svc.emit('update', { sessionId: '', kind: 'apps' });
        return c.json(saved);
      } catch (e) {
        if (e instanceof AppSwitchError) return c.json({ error: e.message, code: e.code }, e.code === 'APP_SWITCH_UNKNOWN' ? 404 : 400);
        throw e;
      }
    });
  }

  const openSourceRelease = options.openSourceRelease;
  if (appSwitchEdition === 'full' && openSourceRelease) {
    // 管理员 = 浏览器密码登录，或经浏览器登录批准配对的设备（device-pair-routes 要求浏览器会话才能配对），
    // 以及不对外暴露的本地控制台。只认浏览器 cookie 会让手机上的原生 App 只能看到 403。
    const authorizeRelease = (c: Context) => {
      c.header('Cache-Control', 'private, no-store');
      return !!auth?.inspect(getCookie(c, SESSION_COOKIE)).ok || c.get('authSource' as never) === 'bearer' || !isPublic(c);
    };
    const releaseRequest = async (c: Context, action: () => Promise<unknown>) => {
      if (!authorizeRelease(c)) return c.json({ error: '请使用管理员登录访问开源发布' }, 403);
      try { return c.json(await action() as object); }
      catch (error) { return c.json({ error: String((error as Error).message).split('\n')[0]?.slice(0, 400) }, 409); }
    };
    app.get('/api/open-source-release', c => releaseRequest(c, () => openSourceRelease.inspect()));
    app.post('/api/open-source-release/analyze', c => releaseRequest(c, () => openSourceRelease.inspect(true)));
    app.post('/api/open-source-release/publish', c => releaseRequest(c, async () => {
      const body = await c.req.json<{ id?: string; selected?: unknown }>();
      return openSourceRelease.approve(body.id, body.selected);
    }));
    app.post('/api/open-source-release/dismiss', c => releaseRequest(c, async () => {
      const body = await c.req.json<{ id?: string }>();
      return openSourceRelease.dismiss(body.id);
    }));
    app.post('/api/open-source-release/retry', c => releaseRequest(c, async () => {
      const body = await c.req.json<{ id?: string }>();
      return openSourceRelease.retry(body.id);
    }));
  }

  // 小游戏里的「小马伙伴」：固定 DeepSeek Flash、关闭推理；人设与儿童安全边界都在服务端。
  const gameCompanion = options.gameCompanion ?? new GameCompanionService({ webProvider: () => svc.webResearchProvider() });
  app.post("/api/game-companion/chat", async (c) => {
    c.header("Cache-Control", "private, no-store");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "消息格式不对", code: "COMPANION_INPUT" }, 400);
    }
    const client = c.req.header("cf-connecting-ip") ?? authId(c) ?? "local";
    try {
      return c.json(await gameCompanion.chat(body, `game-companion:${client}`));
    } catch (e) {
      if (e instanceof GameCompanionError) return c.json({ error: e.message, code: e.code }, e.status);
      return c.json({ error: "小马伙伴暂时没准备好，等会儿再聊吧。", code: "COMPANION_UNAVAILABLE" }, 503);
    }
  });

  // Communications never inherit anonymous local or public-history access.
  if (ledgerDir && appSwitchEdition === 'full') {
    const commAuth = (c: Context) => auth ? authenticateApiRequest(auth, c.req.header('authorization') ?? (getCookie(c, DEVICE_SESSION_COOKIE) ? `Bearer ${getCookie(c, DEVICE_SESSION_COOKIE)}` : undefined), getCookie(c, SESSION_COOKIE)) : undefined;
    mountCommunicationsRoutes(app, new CommunicationsStore(appData(ledgerDir, 'communications').path('communications')), {
      // Local console access follows the same trust boundary as other local APIs.
      reader: c => !isPublic(c) || commAuth(c)?.ok === true,
      device: c => { const result = auth && authenticateApiRequest(auth, c.req.header('authorization'), undefined); return result && result.ok && result.source === 'bearer' && result.record.kind === 'device' ? result.record.id : undefined; }
    });
  }
  const androidConfig = resolveAndroidConfig(process.env, ledgerDir);
  mountAndroidReleaseRoutes(app, { dir: androidConfig.releaseDir, isPublic, canRead: c => !!authId(c) && (!isPublic(c) || !!(options.runtime?.settings().publicHistory || options.runtime?.settings().publicControl)) });
  // V3.52：局域网直连识别。探针本身在 main.ts 里监听；这里只给已登录设备读取候选地址、端口与验证密钥。测试不带数据目录时不开。
  if (ledgerDir) mountLanNetworkRoute(app, { canRead: c => !!authId(c) && (!isPublic(c) || !!(options.runtime?.settings().publicHistory || options.runtime?.settings().publicControl)), key: loadProbeKey(ledgerDir), port: probePort(process.env), appPort: lanAppPort(process.env) });
  // 连接状态弹层里的 Mac Mini 资源占比与网速；与局域网探测同一读取权限。
  mountHostStatsRoute(app, { canRead: c => !!authId(c) && (!isPublic(c) || !!(options.runtime?.settings().publicHistory || options.runtime?.settings().publicControl)) });
  if (options.runtime) {
    // 原生 FCM 队列在下面创建；日程提醒两个通道都要入队，任一失败不影响另一个。
    let nativeReminders: NativeNotifications | undefined;
    let noteReminderService: NoteReminders | undefined;
    if (options.webPush) {
      const runtime = options.runtime;
      const push = new WebPushService({ ...options.webPush, runtime, authorized: (owner, publicDevice) => {
        if (!publicDevice) return owner === "local";
        const settings = runtime.settings();
        return !!auth?.isActive(owner) && !!(settings.publicHistory || settings.publicControl);
      } });
      mountNotificationRoutes(app, push, {
        owner: c => authId(c) ?? (!isPublic(c) ? "local" : undefined), isPublic,
        canRead: c => !isPublic(c) || !!(runtime.settings().publicHistory || runtime.settings().publicControl)
      });
      // 日程提醒：记录里的提醒时间由 note-reminder 在新建 / 编辑时算好，这里只负责到点全端推送。
      // 测试里的轻量 svc 桩没有记录存储与事件总线，跳过（不影响通知路由本身）。
      const reminderPush = svc.notes && typeof svc.on === "function" ? new NoteReminders({
        notes: svc.notes,
        dir: join(options.webPush.dir, "note-reminders"),
        autoStart: false,
        send: (notice) => {
          let failure: unknown;
          try {
            push.remind({ id: notice.id, title: notice.title, body: notice.body, url: notice.url, at: notice.at, expires: notice.at + 15 * 60_000 });
          } catch (error) { failure = error; }
          try {
            nativeReminders?.enqueueReminder({ eventId: notice.id, title: notice.title, body: notice.body,
              route: notice.url.replace(/^\//, ""), at: notice.at, expiresAt: notice.at + 15 * 60_000 });
          } catch (error) { failure ??= error; }
          if (failure) throw failure;
        }
      }) : undefined;
      if (reminderPush) {
        noteReminderService = reminderPush;
        svc.on("update", (u: { kind?: string }) => { if (u.kind === "notes") reminderPush.wake(); });
        options.shutdownSignal?.addEventListener("abort", () => reminderPush.stop(), { once: true });
      }
    }
    let nativeSend: ReturnType<typeof fcmFromServiceAccount> | undefined;
    const nativeAccount=androidConfig.fcmServiceAccount;
    if(nativeAccount)try{const send=fcmFromServiceAccount(nativeAccount);nativeSend=appSwitches?(async(token,data,authorized)=>{if(!appSwitches.enabled('android'))throw new Error('Android 客户端已在设置里关闭');await send(token,data,authorized);}):send;}catch{console.error('原生推送配置无效，服务未启用');}
    nativeReminders = mountNativeNotificationRoutes(app, { runtime: options.runtime,
      ...(nativeSend && ledgerDir ? {config:{dir:appData(ledgerDir,'android').path('native-notifications'),send:nativeSend}}:{}),
      owner:c=>{if(!auth)return undefined;const result=authenticateApiRequest(auth,c.req.header('authorization'),undefined);return result.ok && result.record.kind==='device'?result.record.id:undefined;},
      authorized:owner=>!!auth?.isActive(owner),canRead:()=>!!(options.runtime?.settings().publicHistory || options.runtime?.settings().publicControl),shutdown:options.shutdownSignal });
    // 两个推送通道都就绪后再开始扫描。
    noteReminderService?.start();
    const rooms = options.rooms ?? new RoomService(options.runtime);
    const enabled=options.sessionSyncEnabled??process.env['PI_SESSION_SYNC']!=='0',journal=options.sessionSyncJournal??new SessionSyncJournal();
    const stillAuthenticated=(c:Context)=>{
      if (c.req.header('authorization') !== undefined || getCookie(c, DEVICE_SESSION_COOKIE) !== undefined) {
        if (!auth) return false;
        const device = authenticateApiRequest(auth, c.req.header('authorization') ?? `Bearer ${getCookie(c, DEVICE_SESSION_COOKIE)}`, undefined);
        return device.ok && device.record.id === authId(c);
      }
      if(!options.login||!isPublic(c)) return true;
      const checked=auth?.inspect(getCookie(c,SESSION_COOKIE));
      if(checked?.ok&&checked.record.id===authId(c)) return true;
      logAuthFailure(c,"sync-401",checked&&!checked.ok?checked.reason:"session-changed",checked?.ok?checked.record.id:checked?.id);
      return false;
    };
    app.get('/api/session-sync/capabilities', (c) => { c.header('Cache-Control', 'private, no-store'); return c.json({ protocolVersion: 1, persistence: { supported: true, schema: 1 }, incremental: { supported: enabled,protocolVersion:1 }, restore:{supported:true,schema:1} }); });
    mountRoomRoutes(app, rooms, { isPublic, actor: (c) => authId(c) ?? (isPublic(c) ? "public" : "local"), authPartition: (c) => authId(c) ?? null,stillAuthenticated,sync:{enabled,journal,sources:new RoomSyncSources(rooms)} });
    const sessionMemoryPort=new RuntimeMemoryPort();
    const resolveLocalRuntimeBin = (kind: Exclude<RuntimeKind, "pi">): string | undefined => {
      const home = homedir();
      const pathDirs = (process.env["PATH"] ?? "").split(":").filter(Boolean);
      if (kind === "codex") {
        const list = [
          process.env["PI_AGENT_CODEX_BIN"],
          "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
          "/Applications/Codex.app/Contents/Resources/codex",
          join(home, ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex",
          ...pathDirs.map((d) => join(d, "codex")),
        ];
        return list.find((p): p is string => !!p && existsSync(p));
      }
      if (kind === "antigravity") {
        const list = [
          process.env["PI_AGENT_AGY_BIN"],
          join(home, ".local/bin/agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy",
          ...pathDirs.map((d) => join(d, "agy")),
        ];
        return list.find((p): p is string => !!p && existsSync(p));
      }
      const list = [
        process.env["PI_AGENT_CLAUDE_BIN"],
        join(home, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
        ...pathDirs.map((d) => join(d, "claude")),
      ];
      return list.find((p): p is string => !!p && existsSync(p));
    };
    const defaultRuntimeAuth: RuntimeAuthService | undefined = options.runtimeAuth ?? (typeof options.runtime.probe === "function" ? (() => {
      const flows = new RuntimeAuthFlowManager({
        cwd: homedir(),
        resolveBinary: resolveLocalRuntimeBin,
        envFor: () => allowlistedEnv(),
        verifyProfile: (kind) => options.runtime!.probe(kind, { reloggedIn: true }),
      });
      options.shutdownSignal?.addEventListener("abort", () => flows.shutdown(), { once: true });
      const capOf = (kind: RuntimeKind): RuntimeAuthCapability => ({
        managedInstall: false,
        requiresNetworkGate: false,
        installed: kind === "pi" ? true : Boolean(resolveLocalRuntimeBin(kind)),
        enabled: true,
        isolatedCredentials: false,
        supportsApiKey: kind === "pi" || kind === "codex",
        loginMode: kind === "pi" ? "api-key" : kind === "codex" ? "callback" : kind === "antigravity" ? "code-paste" : "hybrid",
      });
      return {
        capabilities: () => ({
          isolatedCredentials: false,
          runtimes: {
            codex: capOf("codex"),
            "claude-code": capOf("claude-code"),
            pi: capOf("pi"),
            antigravity: capOf("antigravity"),
          },
        }),
        startLogin: (kind) => flows.start(kind),
        loginStatus: (kind, flowId) => flows.status(kind, flowId),
        submitLogin: (kind, flowId, input) => flows.submit(kind, flowId, input),
        verifyLogin: (kind, flowId) => flows.verify(kind, flowId),
        cancelLogin: (kind, flowId) => flows.cancel(kind, flowId),
        shutdown: () => flows.shutdown(),
      };
    })() : undefined);
    mountRuntimeRoutes(app, options.runtime, {
      ...(defaultRuntimeAuth ? { runtimeAuth: defaultRuntimeAuth } : {}),
      ...(options.codexReset ? { codexReset: options.codexReset } : {}),
      factAudit:(...args)=>sessionMemoryPort.factAudit(...args),
      publicMemoryEntry:prefix=>publicMemoryService?.entryByPrefix(prefix),
      iterations: svc.noteIterations,
      validateRecordSources: refs=>svc.noteRelations.verifySources(refs),
      rooms, isPublic, actor: (c) => authId(c) ?? (isPublic(c) ? "public" : "local"), authPartition: (c) => authId(c) ?? null,
      ...(ledgerDir ? { readStateFile: appData(ledgerDir, 'notifications').path('read-state.json') } : {}),
      stillAuthenticated,sync:{enabled,journal,sources:new RuntimeSyncSources(options.runtime)},
      ...(options.shutdownSignal ? { shutdown: options.shutdownSignal } : {}),
      ...(options.submissionsServing ? { submissionsServing: options.submissionsServing } : {}),
      ...(options.revealFile ? { revealFile: options.revealFile } : {}),
      ...(options.deployQueue ? { deployQueue: options.deployQueue } : {}),
      providerBalances: (providers) => svc.modelBalances(providers, { waitMs: 0 }),
      cachedBalances: (providers) => svc.modelBalancesCached(providers),
      // 页面级通知合并进 runtime 实时流：浏览器只保留一条 SSE（app=1）。
      appUpdates: (listener) => { svc.on("update", listener); return () => svc.off("update", listener); },
      noteImage: (id) => svc.noteImageOriginal(id),
    });
    // 归档会话时把从这条待办发起的关联待办标记完成（待办可能在别的入口被删掉，这里幂等且不抛错）
    const archiveRuntime = options.runtime;
    // 对话应用中已关联会话的待办（含已归档单条会话；推荐会话在“重新推荐”前）先过滤，不再进入推荐候选或触发 AI 分析
    svc.noteIterations?.setLinkedNotes(() => svc.noteIterations.linkedNoteIds(archiveRuntime.store.allBindings()));
    svc.noteIterations?.sync();
    // 直接从待办发起会话后立即调整推荐，不依赖列表读取或下一次后台轮询。
    archiveRuntime.on("session", (u: { platformSessionId: string }) => {
      if (!archiveRuntime.store.binding(u.platformSessionId)?.noteRef) return;
      svc.noteIterations?.sync();
      svc.noteIterations?.wake();
    });
    archiveRuntime.on("archived", (u: { platformSessionId: string; noteId?: string }) => {
      const binding = archiveRuntime.store.binding(u.platformSessionId);
      const noteId = u.noteId ?? binding?.noteRef?.noteId;
      if (noteId) svc.completeNoteFromSession(noteId);
      // 推荐任务是多条待办聚合的大待办：归档后它的全部来源待办同样标记完成
      if (binding?.recommendationRef) reconcileIterations(svc, archiveRuntime);
    });
  }

  let publicMemoryService: PublicMemoryService | undefined;
  const memorySync = options.runtime && ledgerDir ? new MemorySyncService({root:appData(ledgerDir,'memory').path('memory'),runtime:options.runtime,...(options.memorySyncEnabled === undefined ? {} : {enabled:options.memorySyncEnabled})}) : undefined;
  if(memorySync && options.runtime) {
    const runtime=options.runtime;
    // 平台公共记忆：条目由 v2 流水线从平台会话里提炼（见下方 PipelineService），这里是设置 / 新会话注入 / 按需索引 / 使用率。
    // 已知项目：来自所有会话的仓库根 / 工作目录（worktree 会话归到原仓库）
    const catalog=()=>buildCatalog([...runtime.store.allBindings()].reverse().map(b=>({workspace:b.workspace,repoRoot:b.worktree?.repoRoot})));
    const pipelineStore=new PipelineStore(pipelineRoot(ledgerDir!));
    publicMemoryService=new PublicMemoryService({
      store:new PublicMemoryStore(appData(ledgerDir!,'memory').path('memory-public')),
      topicsSource:()=>pipelineStore.topics(),
      projects:catalog,
      baseUrl:`http://127.0.0.1:${options.proxyPort??options.port??8788}`
    });
    // 新会话首轮注入：开关默认关；关闭或没有可注入条目时返回 null（manager 不动提示词）
    const injecting=publicMemoryService;
    if(typeof runtime.setPublicMemoryProvider==='function')runtime.setPublicMemoryProvider(ctx=>{const block=injecting.injectionFor(projectAliasesOf({workspace:ctx.workspace,repoRoot:ctx.repoRoot}));return block?{text:block.text,count:block.count,onDemand:block.onDemand,...(block.rules.length?{rules:block.rules}:{})}:null;});
    // 即时通道：明确记忆指令、引用纠正及随后确认，本轮结束只提炼当前会话。
    let instantPipeline:PipelineService|undefined;
    const onTurnEnded=(c:{platformSessionId:string;turnNo:number})=>{
      try{
        if (!instantPipeline || !ledgerDir) return;
        // 触发与提炼共用原始平台账本，避免原生回传覆盖来源，并复用引用修订及真人过滤。
        const session = captureSessions({ dataDir: ledgerDir, sessionIds: [c.platformSessionId], manualMarks: instantPipeline.store.manualMarks() }).sessions[0];
        const messages = session?.messages.filter(message => message.turnNo === c.turnNo) ?? [];
        // 用户已在这一轮的消息上手动「加入记忆」：那次已经提炼过，本轮结束不再自动提炼
        if (messages.some(message => message.manual)) return;
        if (!needsInstantIntake(messages.map(message => message.text)) && !messages.some(message => message.memoryRevision)) return;
        void instantPipeline.instant(c.platformSessionId).catch(e=>console.warn(`[memory-pipeline] 即时提炼异常：${(e as Error).message}`));
      }catch(e){console.warn(`[memory-pipeline] 即时提炼判断失败：${(e as Error).message}`);}   // manager 会吞观察者的异常，这里留下痕迹
    };
    // 强约束里 DeepSeek 写的规则（没有对应代码的）每轮结束由判定模型按四要素核对
    if(options.memoryTitlePort&&typeof runtime.setModelRuleJudge==='function')runtime.setModelRuleJudge(createRuleJudge(options.memoryTitlePort));
    if(typeof runtime.setEvidenceReaders==='function')runtime.setEvidenceReaders(evidenceReaders({releaseDir:androidConfig.releaseDir??(ledgerDir?appData(ledgerDir,'memory').foreign('android','android-release'):undefined)}));
    if(typeof runtime.setPublicMemoryObserver==='function')runtime.setPublicMemoryObserver({turnEnded:onTurnEnded,injected:c=>injecting.observeInjection({runtime:c.runtimeKind,sessionId:c.platformSessionId}),enforced:c=>injecting.recordEnforcement(c.topicId,c.pass),tool:c=>injecting.observeToolEvent({runtime:c.runtimeKind,sessionId:c.platformSessionId,key:c.key,...(c.name?{name:c.name}:{}),...(c.input?{input:c.input}:{})})});
    injecting.startMaintenance();
    const stopPublicMemory=()=>injecting.stop();
    options.shutdownSignal?.addEventListener('abort',stopPublicMemory,{once:true});runtime.on('shutdown',stopPublicMemory);
    mountPublicMemoryRoutes(app,publicMemoryService,{allowed:c=>!isPublic(c)||runtime.settings().publicControl});
    mountArchitectureRoutes(app,{allowed:c=>!isPublic(c)||runtime.settings().publicControl});
    // v2 流水线：直接从平台会话账本提炼（独立于各 runtime 的私有记忆）；每日定时运行默认关，手动触发随时可用
    if(options.memoryTitlePort&&ledgerDir){
      const pipeline=new PipelineService({dataDir:ledgerDir,root:pipelineRoot(ledgerDir),port:options.memoryTitlePort,enabled:()=>publicMemoryService?.settings().pipelineEnabled===true,log:m=>console.warn(`[memory-pipeline] ${m}`),
        onChange:()=>{try{publicMemoryService?.ensureIndex();}catch{/* 接口兜底 */}},
        // 进展标题：集成部署的“Merge commit …”换成会话自己的提交标题（到各项目的仓库根里查）
        resolveTitle:gitTitleResolver(()=>[...new Set([...runtime.store.allBindings()].map(b=>b.worktree?.repoRoot).filter((r):r is string=>!!r))])});
      instantPipeline=pipeline;
      mountPipelineRoutes(app,pipeline,{allowed:c=>!isPublic(c)||runtime.settings().publicControl});
      const stopPipeline=pipeline.startScheduler();
      options.shutdownSignal?.addEventListener('abort',stopPipeline,{once:true});runtime.on('shutdown',stopPipeline);
    }
    memorySync.start();
    options.shutdownSignal?.addEventListener('abort',memorySync.stop,{once:true});
    mountMemoryRoutes(app,memorySync,{isPublic,settings:()=>runtime.settings(),workspaceAllowed:workspace=>runtime.store.allBindings().some(b=>b.runtimeKind==='pi' && b.workspace===workspace && !b.worktree)});
  }

  /**
   * DeepSeek 汇总读取 Pi 受管会话的用量：用量文件和绑定文件没变（mtime/size 相同）就复用上次的汇总，
   * 连十几 MB 的 usage.json 都不用重新读。没有 runtime 时只用平台账本。
   */
  const deepseekRuntimeInput = (): [() => DeepSeekRuntimeSession[], string?] => {
    const runtime = options.runtime;
    if (!runtime) return [() => []];
    const stamp = (name: string): string => {
      try { const st = statSync(join(runtime.store.dir, name)); return `${st.mtimeMs}:${st.size}`; } catch { return "-"; }
    };
    return [() => {
      const bindings = runtime.store.allBindings();
      // allUsage 一次读完 usage.json；旧版 runtime-sessions 没有这个方法时按会话兜底。
      const store = runtime.store as typeof runtime.store & { allUsage?: () => Record<string, UsageRecord[]> };
      const usage = typeof store.allUsage === "function"
        ? store.allUsage()
        : Object.fromEntries(bindings.map((binding) => [binding.platformSessionId, runtime.store.usageFor(binding.platformSessionId)]));
      return bindings.map((binding) => ({ binding, records: usage[binding.platformSessionId] ?? [] }));
    }, `${stamp("usage.json")}|${stamp("bindings.json")}`];
  };

  // 会话列表「今天」卡片的消耗：Pi 按 DeepSeek 用量 × 单价，Claude Code / Codex 按订阅月费摊到每小时；统一折成美元。
  app.get("/api/platform/today-cost", (c) => {
    const settings = options.runtime?.settings();
    // 和资源页同一门槛：对外入口没有查看或控制授权时不给费用。
    if (isPublic(c) && (!settings || (!settings.publicHistory && !settings.publicControl))) return c.json({ error: "对外入口未开放查看权限", code: "RT_FORBIDDEN" }, 403);
    if (!ledgerDir) return c.json({ error: "没有可用的数据目录", code: "INTERNAL" }, 500);
    c.header("Cache-Control", "private, no-store");
    const [sessions, signature] = deepseekRuntimeInput();
    return handle(c, () => todayCost({
      billing: readBilling(ledgerDir), now: new Date(), dataDir: ledgerDir,
      apiUsd: { pi: svc.deepseekTodayCost(sessions, signature) }
    }));
  });

  // 统计应用：消耗 / 会话 / 部署的按日数据（北京时间），区间合计、拆解、趋势、热力图都由前端从这份按日明细算出来。
  const statsService = options.runtime && ledgerDir ? (() => {
    const runtime = options.runtime!, dataDir = ledgerDir;
    const stamp = (file: string): string => { try { const st = statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return "-"; } };
    const origins = turnOriginsAt(join(runtime.store.dir, "turn-origins.jsonl"));
    return new StatsService({
      bindings: () => runtime.store.allBindings(),
      usage: () => runtime.store.allUsage(),
      operations: () => runtime.store.allOperations(),
      origins,
      deepseekRows: (deviceOf) => svc.deepseekDailyRows(() => {
        const usage = runtime.store.allUsage();
        return runtime.store.allBindings().map((binding) => ({ binding, records: usage[binding.platformSessionId] ?? [] }));
      }, deviceOf),
      billing: () => readBilling(dataDir),
      dataDir,
      signature: () => [
        stamp(join(runtime.store.dir, "usage.json")), stamp(join(runtime.store.dir, "bindings.json")), stamp(join(runtime.store.dir, "turn-origins.jsonl")),
        stamp(appData(dataDir, "resources").path("deepseek-usage.jsonl")), stamp(appData(dataDir, "resources").foreign("shell", "runtime-billing.json")),
        stamp(join(process.env["PI_AGENT_GUI_ROOT"] ?? join(homedir(), ".pi-agent-gui"), "when-idle", "history.log"))
      ].join("|")
    });
  })() : undefined;
  app.get("/api/stats/:domain", (c) => {
    const domain = c.req.param("domain");
    if (domain !== "cost" && domain !== "sessions" && domain !== "deploys") return c.json({ error: "未知的统计类型", code: "RT_INPUT" }, 404);
    const settings = options.runtime?.settings();
    if (isPublic(c) && (!settings || (!settings.publicHistory && !settings.publicControl))) return c.json({ error: "对外入口未开放查看权限", code: "RT_FORBIDDEN" }, 403);
    if (!statsService) return c.json({ error: "统计服务不可用", code: "INTERNAL" }, 503);
    c.header("Cache-Control", "private, no-store");
    const days = Math.min(STATS_MAX_DAYS, Math.max(1, Number(c.req.query("days")) || STATS_DEFAULT_DAYS));
    return handle(c, () => statsService.get(domain, days));
  });

  // v2.5 F11：外部资源（只读）；余额只在你点刷新时向服务商的只读接口请求
  // 订阅额度（Claude / OpenAI）也是模型账号的额度，作为 model 行并入同一张表（与「新建会话」同源）；
  // 账户级信息：对外入口只在开了查看或控制授权时才随资源一起显示，本机入口照常显示。
  const localCliInventory = new LocalCliInventory();
  app.get("/api/resources", (c) => handle(c, async () => {
    const base = svc.resources();
    const runtime = options.runtime;
    // 资源页不能因为 runtime 存储恰好被写入而整页失败：读不到会话用量时仍显示平台账本。
    const deepseekUsage = svc.deepseekUsageView(...deepseekRuntimeInput());
    const canSyncMemory = !isPublic(c) || !!runtime?.settings().publicControl;
    const withUsage = { ...base, deepseekUsage, ...(publicMemoryService && canSyncMemory ? {publicMemory:true} : {}) };
    const settings = runtime?.settings();
    // 运行时配置里含本机绝对路径：对外入口没有查看或控制授权时不下发，和账号级信息同一门槛。
    if (isPublic(c) && (!runtime || !settings || (!settings.publicHistory && !settings.publicControl))) {
      const { runtimeConfigs: _runtimeConfigs, ...rest } = withUsage;
      return rest;
    }
    const withLocalClis = { ...withUsage, localClis: await localCliInventory.read() };
    if (!runtime || !settings) return withLocalClis;
    const runtimes = runtimeQuotaServices(runtime.profiles(), { canRefresh: !isPublic(c) || settings.publicControl });
    return runtimes.length ? { ...withLocalClis, services: [...base.services, ...runtimes] } : withLocalClis;
  }));
  app.post("/api/resources/:service/refresh", (c) => handle(c, async () => svc.refreshBalance(c.req.param("service"))));
  // 平台默认联网供应商：手动切换（auto/brave/deepseek）。对外入口沿用 runtime 控制授权。
  app.post("/api/resources/web-research/provider", (c) => {
    if (isPublic(c)) {
      const settings = options.runtime?.settings();
      if (!settings?.publicControl) return c.json({ error: "对外入口未启用 runtime 控制，不能切换联网供应商", code: "RESOURCE_FORBIDDEN" }, 403);
    }
    return handle(c, async () => {
      const body = await c.req.json<{ provider?: unknown }>().catch(() => ({} as { provider?: unknown }));
      return svc.setWebResearchProvider(body.provider);
    });
  });
  // 待办记录（大备忘录）：按时间顺序记下每次的小想法；新的在前。
  // 顺带给出每条记录关联的会话（从会话绑定里的 noteRef 反查），供待办页跳转查看。
  const iterationAction = (fn: () => unknown) => { try { return fn(); } catch (e) { throw new ConsoleError((e as Error).message); } };
  // 不带 limit 返回整份快照（兼容）；带 status / offset / limit 只返回一页，操作类接口同样按这组参数回写，不再回传整份。
  const iterationView = (c: Context): IterationView | undefined => {
    const limit = c.req.query("limit");
    const scope = c.req.query("scope");
    if (scope && !["window", "backup", "assessment"].includes(scope)) throw new Error("推荐视图无效");
    return limit === undefined && !scope ? undefined : { ...(scope ? { scope: scope as IterationView["scope"] } : {}), status: c.req.query("status") ?? "all", offset: Number(c.req.query("offset") ?? 0), limit: Number(limit ?? 10) };
  };
  const iterationReply = <T>(c: Context, run: () => T): T => { const out = run(); const view = iterationView(c); return view ? (svc.noteIterations.snapshot({ view }) as unknown as T) : out; };
  app.get("/api/note-iterations", (c) => handle(c, async () => {
    if (options.runtime) svc.noteIterations.reconcile(options.runtime.store.allBindings());
    return svc.noteIterations.snapshot({ view: iterationView(c) });
  }));
  app.get("/api/note-iterations/summary", (c) => handle(c, async () => {
    if (options.runtime) svc.noteIterations.reconcile(options.runtime.store.allBindings());
    return svc.noteIterations.summary(Number(c.req.query("limit") ?? 3) || 3);
  }));
  app.get("/api/note-iterations/runs", (c) => handle(c, async () => svc.noteIterations.runs(Number(c.req.query("limit") ?? 10) || 10)));
  app.post("/api/note-iterations/exposures", (c) => handle(c, async () => { const body = await c.req.json(); return iterationAction(() => svc.noteIterations.recordExposure(body)); }));
  app.get("/api/note-iterations/:id", (c) => handle(c, async () => iterationAction(() => svc.noteIterations.task(c.req.param("id")))));
  app.post("/api/note-iterations/retry", (c) => handle(c, async () => iterationReply(c, () => svc.noteIterations.retry())));
  app.post("/api/note-iterations/regroup", (c) => handle(c, async () => iterationReply(c, () => svc.noteIterations.regroup())));
  app.post("/api/note-iterations/:id/decision", (c) => handle(c, async () => {
    const body = await c.req.json(); return iterationReply(c, () => iterationAction(() => svc.noteIterations.decide(c.req.param("id"), body)));
  }));
  app.post("/api/note-iterations/:id/ignore", (c) => handle(c, async () => {
    const body = await c.req.json<{ revision?: unknown; reason?: unknown }>();
    return iterationReply(c, () => iterationAction(() => svc.noteIterations.ignore(c.req.param("id"), body.revision, body.reason)));
  }));
  app.post("/api/note-iterations/:id/done", (c) => handle(c, async () => {
    const body = await c.req.json<{ done?: unknown }>();
    return iterationReply(c, () => iterationAction(() => svc.noteIterations.setDone(c.req.param("id"), body.done, options.runtime?.store.allBindings() ?? [])));
  }));
  app.post("/api/note-iterations/:id/recommend-again", (c) => handle(c, async () => iterationReply(c, () => iterationAction(() => svc.noteIterations.release(c.req.param("id"), options.runtime?.store.allBindings() ?? [])))));
  app.post("/api/notes/:id/development", (c) => handle(c, async () => {
    const body = await c.req.json(); return iterationReply(c, () => iterationAction(() => svc.noteIterations.override(c.req.param("id"), body.inputHash, body.kind)));
  }));
  app.get("/api/note-categories", (c) => handle(c, async () => svc.noteCategories.snapshot()));
  app.post("/api/note-categories", (c) => handle(c, async () => {
    try { return svc.noteCategories.create(await c.req.json()); }
    catch (e) { throw new ConsoleError((e as Error).message); }
  }));
  app.post("/api/note-categories/:id", (c) => handle(c, async () => {
    try { return svc.noteCategories.manage(c.req.param("id"), await c.req.json()); }
    catch (e) { throw new ConsoleError((e as Error).message); }
  }));
  app.post("/api/notes/:id/classification", (c) => handle(c, async () => {
    try { return svc.noteCategories.decide(c.req.param("id"), await c.req.json()); }
    catch (e) { throw new ConsoleError((e as Error).message); }
  }, 200, true));
  app.get("/api/notes", (c) => handle(c, async () => {
    // 顺带给出每条记录关联的会话（从会话绑定里的 noteRef 反查），供待办页跳转查看。
    svc.noteRelations.scheduleExternalRefresh();
    const links = options.runtime?.noteSessions();
    // 诊断待办带一行状态（V1.4 §7.3）：结论以 finding 为准
    diagnostics?.findings.reloadIfChanged();
    const withDiagnostic = <T extends { id: string }>(n: T): T => { const d = diagnostics?.noteDecoration(n.id); return d ? { ...n, diagnostic: d } : n; };
    const withSessions = <T extends { id: string }>(notes: T[]): T[] => svc.noteRelations.decorate(notes).map((n) => withDiagnostic(links && links[n.id]?.length ? { ...n, sessions: links[n.id] } : n));
    const q = c.req.query();
    // 不传 limit 时保持原来的完整数组（会话提示按 id 读取等仍走这条）；
    // 待办页传 limit 走分页，响应里带 total / counts / categoryCounts / nextCursor。
    if (!q["limit"]) return withSessions(svc.listNotes());
    // 筛选条件跟分页一起下推到服务端：分类 / 完成状态命中的记录少时，不必把整份列表
    // 一页页拉完才显示结果。关联对话筛选用会话绑定反查出的 id 集合。
    // 分类支持多选（categories=a,b），同时兼容旧的单分类参数 category。
    const link = q["link"] === "linked" || q["link"] === "unlinked" ? q["link"] : "all";
    const page = svc.pageNotes({
      limit: q["limit"],
      hideDebug: q["hideDebug"],
      tabFilters: q["tabFilters"],
      linkedNoteIds: new Set(Object.keys(links ?? {})),
      ...(q["cursor"] ? { cursor: q["cursor"] } : {}),
      ...(q["status"] ? { status: q["status"] } : {}),
      ...(q["categories"] !== undefined ? { categories: q["categories"] } : q["category"] !== undefined ? { category: q["category"] } : {}),
      ...(link !== "all" ? { link } : {}),
      ...(q["kind"] ? { kind: q["kind"] } : {}),
      ...(q["q"] ? {
        q: q["q"],
        sessionTitles: new Map(Object.entries(links ?? {}).map(([id, list]) => [id, (list as Array<{ title?: string }>).map((s) => s.title ?? "").filter(Boolean)]))
      } : {})
    });
    return { ...page, notes: withSessions(page.notes) };
  }));
  // 单条读取：页面跟踪刚记下的内容被 AI 归到哪一类（归入日程后它会离开当前列表筛选）。
  app.get("/api/notes/:id{n-[^/]+}", (c) => handle(c, async () => {
    svc.noteRelations.scheduleExternalRefresh();
    const note = svc.getNote(c.req.param("id"));
    const links = options.runtime?.noteSessions()?.[note.id];
    c.header("cache-control", "private, no-store");
    diagnostics?.findings.reloadIfChanged();
    const diagnostic = diagnostics?.noteDecoration(note.id);
    return { ...note, ...(links?.length ? { sessions: links } : {}), ...(diagnostic ? { diagnostic } : {}) };
  }));
  app.post("/api/runtime-sessions/:id/records",c=>handle(c,async()=>{
    if(!recordAuth||!options.runtime)throw new RelationError("记录能力不可用",503);
    const id=c.req.param("id"),proof=recordAuth.verify(id,c.req.header("x-pi-record-capability"));
    const binding=options.runtime.store.binding(id);if(!binding||binding.archived)throw new RelationError("会话已归档或删除",403);
    if(binding.evaluation||binding.roomRef&&binding.permissionMode===readOnlyPermissionMode(binding.runtimeKind))throw new RelationError('当前会话只读，不能创建记录',403);
    if(!binding.turns.some(t=>t.clientMessageId===proof.turnId&&(t.status==='running'||t.status==='waiting-input')))throw new RelationError('原运行轮次已结束',403);
    const input=await c.req.json();if(input.actor!==undefined||input.evidence!==undefined||input.relations!==undefined)throw new RelationError("不能伪造来源证据");
    const refs=resolveRecordSources(binding,input.sourceRefs===undefined?undefined:relationSources(input.sourceRefs));
    return svc.noteRelations.create({...input,sourceRefs:refs},{actor:{kind:"runtime",scopeId:id},channel:"runtime",evidence:{sessionId:id,turnId:proof.turnId,toolCallId:String(input.idempotencyKey??"")}});
  },201));
  const relationContext = (c: Context): RelationContext => ({actor:{kind:"user",scopeId:authId(c)??"local"},channel:"web"});
  app.post("/api/notes", (c) => handle(c, async () => {
    const body = await c.req.json<Record<string, unknown>>();
    if (body.actor !== undefined || body.evidence !== undefined || body.relations !== undefined) throw new RelationError("不能伪造来源证据");
    if (body.sourceRefs !== undefined || body.idempotencyKey !== undefined) return svc.noteRelations.create(body, relationContext(c));
    return svc.addNote(body.text, body.images, body.schedule, { kind: body.kind, timeZone: body.timeZone, pinned: body.pinned, automation: body.automation });
  }, 201, true));
  const relationQuery=(c:Context)=>{let expanded;try{expanded=JSON.parse(c.req.query("expanded")??"[]");}catch{throw new RelationError("展开范围无效");}return {root:parseEntryKey(c.req.query("root")??""),expanded,revision:c.req.query("revision"),cursor:c.req.query("cursor")};};
  app.get("/api/note-relations/graph",c=>handle(c,async()=>{c.header("cache-control","private, no-store");return svc.noteRelations.graph(relationQuery(c));}));
  app.get("/api/note-relations/timeline",c=>handle(c,async()=>{c.header("cache-control","private, no-store");return svc.noteRelations.timeline(relationQuery(c));}));
  app.post("/api/note-relations", c => handle(c, async () => {const b=await c.req.json();return svc.noteRelations.relate(b.from,b.to,relationContext(c),b.idempotencyKey);},201));
  app.post("/api/note-relations/:id/revoke", c => handle(c, async () => {const b=await c.req.json();await svc.noteRelations.revoke(c.req.param("id"),b.reason,relationContext(c));return {ok:true};}));
  // 批量导入外部笔记（flomo 等）：保留原始记录时间；默认不触发 AI 分类与整理。
  app.post("/api/notes/import", (c) => handle(c, async () => {
    const body = await c.req.json<{ notes?: unknown; classify?: unknown }>().catch(() => ({} as { notes?: unknown; classify?: unknown }));
    if (body.classify !== undefined && typeof body.classify !== "boolean") throw new ConsoleError("classify 必须是布尔值");
    return svc.importNotes(body.notes, { classify: body.classify === true });
  }, 200, true));
  app.patch("/api/notes/:id", (c) => handle(c, async () => {
    type NotePatch = Parameters<typeof svc.updateNote>[1];
    const body = await c.req.json<NotePatch>().catch(() => ({} as NotePatch));
    return svc.updateNote(c.req.param("id"), body);
  }, 200, true));
  app.delete("/api/notes/:id", (c) => handle(c, async () => svc.deleteNote(c.req.param("id"))));
  // 待办图片：粘贴 / 相册选图后先上传，再把返回的 id 放进记录。二进制走流，不经过 base64。
  app.post("/api/notes/images", (c) => handle(c, async () => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > NOTE_IMAGE_MAX_BYTES) throw new ConsoleError("单张图片不能超过 10 MiB");
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new ConsoleError("图片内容为空");
    const chunks: Uint8Array[] = []; let size = 0;
    // 手机上行走得慢：每收到一块就重置空闲超时，避免正常上传被杀。
    let timer = setTimeout(() => void reader.cancel("upload idle timeout"), 30_000);
    const resetIdle = () => { clearTimeout(timer); timer = setTimeout(() => void reader.cancel("upload idle timeout"), 30_000); };
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        resetIdle();
        size += part.value.byteLength;
        if (size > NOTE_IMAGE_MAX_BYTES) { await reader.cancel(); throw new ConsoleError("单张图片不能超过 10 MiB"); }
        chunks.push(part.value);
      }
    } finally { clearTimeout(timer); reader.releaseLock(); }
    return svc.addNoteImage(Buffer.concat(chunks), (c.req.header("content-type") ?? "").split(";")[0]!.trim(), c.req.query("name") ?? "图片", c.req.header("x-source-sha256") || undefined);
  }, 201));
  // 同一张图再次添加：浏览器先报原文件哈希，命中就不传字节
  app.post("/api/notes/images/reuse", async (c) => {
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    let image: NoteImage | undefined;
    try { image = svc.reuseNoteImage(String(b["sha256"] ?? "")); } catch (e) { return handle(c, async () => { throw e; }); }
    return image ? c.json({ ...image, reused: true }) : c.json({ error: "没有可复用的图片" }, 404);
  });
  app.get("/api/notes/images/:id", (c) => {
    try {
      const result = svc.readNoteImage(c.req.param("id"), c.req.query("thumbnail") === "1");
      return c.body(new Uint8Array(result.bytes), 200, { "content-type": result.mimeType, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  /* --------------------------- 日历：本地 + Google 只读 --------------------------- */
  const googleInput = (fn: () => unknown) => {
    try { return fn(); } catch (e) { throw new ConsoleError((e as Error).message); }
  };
  const googleInputAsync = async (fn: () => Promise<unknown>) => {
    try { return await fn(); } catch (e) { throw new ConsoleError((e as Error).message); }
  };
  app.get("/api/google-calendar/status", (c) => handle(c, async () => {
    c.header("cache-control", "private, no-store");
    return calendarService().status();
  }));
  app.post("/api/google-calendar/settings", (c) => handle(c, async () => {
    const body = await c.req.json<{ clientId?: unknown; clientSecret?: unknown; calendarIds?: unknown; sharedUrls?: unknown }>().catch(() => ({}));
    return googleInput(() => calendarService().configure(body));
  }));
  app.post("/api/google-calendar/oauth/start", (c) => handle(c, async () => {
    const body = await c.req.json<{ redirectUri?: unknown }>().catch(() => ({} as { redirectUri?: unknown }));
    if (typeof body.redirectUri !== "string") throw new ConsoleError("缺少 OAuth 回调地址");
    let uri: URL;
    try { uri = new URL(body.redirectUri); } catch { throw new ConsoleError("OAuth 回调地址不合法"); }
    if (!allowedOrigins.has(uri.origin)) throw new ConsoleError("OAuth 回调地址不在允许的域名内");
    if (uri.pathname !== "/api/google-calendar/oauth/callback") throw new ConsoleError("OAuth 回调地址路径不正确");
    return googleInput(() => ({ url: calendarService().authorizationUrl(uri.toString()) }));
  }));
  app.get("/api/google-calendar/oauth/callback", async (c) => {
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const denied = c.req.query("error") ?? "";
    if (denied) return c.redirect(`/?google_calendar=error&reason=${encodeURIComponent(c.req.query("error_description") || denied)}#/notes`, 302);
    try {
      await calendarService().completeAuthorization(code, state);
      return c.redirect("/?google_calendar=connected#/notes", 302);
    } catch (e) {
      return c.redirect(`/?google_calendar=error&reason=${encodeURIComponent((e as Error).message)}#/notes`, 302);
    }
  });
  app.post("/api/google-calendar/disconnect", (c) => handle(c, async () => calendarService().disconnect()));
  app.get("/api/google-calendar/calendars", (c) => handle(c, async () => ({ calendars: await googleInputAsync(() => calendarService().calendars()) })));
  const calendarBounds = (c: Context): { fromIso: string; toIso: string } => {
    const from = Date.parse(c.req.query("from") ?? ""), to = Date.parse(c.req.query("to") ?? "");
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ConsoleError("日历时间范围不合法");
    if (to <= from) throw new ConsoleError("日历结束时间必须晚于开始时间");
    if (to - from > 366 * 24 * 60 * 60_000) throw new ConsoleError("一次最多读取一年内的日历");
    return { fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() };
  };
  const localCalendarEvents = (fromIso: string, toIso: string) =>
    svc.notes.list().flatMap((note) => noteCalendarEvents(note, { from: fromIso, to: toIso }));
  const agentRecordEvents = (fromIso: string, toIso: string) => localCalendarEvents(fromIso, toIso).filter(e => e.source === "agent");
  const humanCalendarEvents = (fromIso: string, toIso: string) => localCalendarEvents(fromIso, toIso).filter(e => e.source === "pi");
  // 本地与 Google 分开取：Google 慢或不可用时，本地日程先出来，不被外部网络拖住。
  // 待办页「最近日程」一行：还没结束的本地日程，按开始时间先后。
  // 日程没有完成状态：以前标记过 done 的记录也照时间显示，不因 done 被藏起来。
  const withCalendarRelations=(events:CalendarEvent[]):CalendarEvent[]=>{
    if(!svc.noteRelations)return events;
    for(const e of events)if(e.source==="google"&&e.calendarId&&typeof calendarService().relationRef==="function"){const ref=calendarService().relationRef(e);svc.noteRelations.externalNodes.set(entryKey(ref),{ref,state:"available",title:e.title,displayKind:"event",relationCount:0,checkedAt:new Date().toISOString()});}
    const idx=svc.noteRelations.index();return events.map(e=>{const ref=e.noteId?{kind:"note" as const,noteId:e.noteId}:e.source==="google"&&e.calendarId&&typeof calendarService().relationRef==="function"?calendarService().relationRef(e):undefined;return ref?{...e,relationRef:ref,relationCount:idx.nodes.get(entryKey(ref))?.relationCount??0,relationRevision:idx.revision}:e;});
  };
  const calendarRecords = (events: CalendarEvent[], from: string, to: string) => {
    const ids = new Set(eventsInRange(events, from, to).map(event => event.noteId).filter(Boolean));
    const links = options.runtime?.noteSessions();
    return svc.listNotes().filter(note => ids.has(note.id))
      .map(note => links?.[note.id]?.length ? { ...note, sessions: links[note.id] } : note);
  };
  // 日程提醒：未来 N 天内到点的提醒（人自己的日程）；页面「即将提醒」与调试都用它。
  app.get("/api/notes/reminders", (c) => handle(c, async () => {
    const days = Math.max(1, Math.min(30, Number(c.req.query("days")) || 8));
    const limit = Math.max(1, Math.min(20, Number(c.req.query("limit")) || 5));
    const now = Date.now();
    const reminders = scanNoteReminders(svc.notes.list(), now, now + days * 86_400_000, now).slice(0, limit)
      .map(({ key: _key, ...rest }) => rest);
    c.header("cache-control", "private, no-store");
    return { days, reminders };
  }));
  app.get("/api/notes/upcoming", (c) => handle(c, async () => {
    const limit = Math.max(1, Math.min(50, Number(c.req.query("limit")) || 10));
    const now = Date.now();
    const time = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? beijingDayStartMs(v) : Date.parse(v);
    const seen = new Set<string>();
    // 同一条待办重复几天时只占一行：取还没结束的最早一次（卡片点进去仍是同一条日程）。
    // 周期日程按「现在往后两年」展开，避免把一条每周日程当成一次已经过去的事件。
    const fromIso = new Date(now - 31 * 24 * 60 * 60_000).toISOString();
    const toIso = new Date(now + 2 * 366 * 24 * 60 * 60_000).toISOString();
    const events = svc.notes.list().flatMap((note) => noteCalendarEvents(note, { from: fromIso, to: toIso }))
      .filter((e) => e.source === "pi" && time(e.end) > now)
      .sort((a, b) => time(a.start) - time(b.start) || a.title.localeCompare(b.title))
      .filter((e) => {
        if (!e.noteId) return true;
        if (seen.has(e.noteId)) return false;
        seen.add(e.noteId);
        return true;
      });
    c.header("cache-control", "private, no-store");
    return { events: withCalendarRelations(events.slice(0, limit)), total: events.length };
  }));
  app.get("/api/calendar/local", (c) => handle(c, async () => {
    const { fromIso, toIso } = calendarBounds(c);
    c.header("cache-control", "private, no-store");
    const local = withCalendarRelations(humanCalendarEvents(fromIso, toIso));
    return { from: fromIso, to: toIso, local, records: calendarRecords(local, fromIso, toIso) };
  }));
  // Agent 日历：各平台的定时任务。只读；读不到的平台放进 warnings，不影响本地 / Google 日程。
  app.get("/api/calendar/agent", (c) => handle(c, async () => {
    const { fromIso, toIso } = calendarBounds(c);
    c.header("cache-control", "private, no-store");
    try {
      const scanned = scanAgentScheduledTasks(options.agentCalendar ?? {});
      const agent = withCalendarRelations([...agentCalendarEvents(scanned.tasks, fromIso, toIso), ...agentRecordEvents(fromIso, toIso)]);
      return { from: fromIso, to: toIso, agent, records: calendarRecords(agent, fromIso, toIso), tasks: scanned.tasks.length, warnings: scanned.warnings };
    } catch (e) {
      return { from: fromIso, to: toIso, agent: withCalendarRelations(agentRecordEvents(fromIso, toIso)), records: calendarRecords(agentRecordEvents(fromIso, toIso), fromIso, toIso), tasks: 0, warnings: [(e as Error).message || "Agent 定时任务读取失败"] };
    }
  }));
  app.get("/api/calendar/google", (c) => handle(c, async () => {
    const { fromIso, toIso } = calendarBounds(c);
    const google = await calendarService().events(fromIso, toIso, { force: c.req.query("force") === "1" });
    c.header("cache-control", "private, no-store");
    return { from: fromIso, to: toIso, google: withCalendarRelations(google.events), googleStatus: google.status, errors: google.errors, cached: google.cached };
  }));
  // 兼容一次性取完整日历的调用；页面本身用上面两个端点并行读取。
  app.get("/api/calendar", (c) => handle(c, async () => {
    const { fromIso, toIso } = calendarBounds(c);
    const google = await calendarService().events(fromIso, toIso, { force: c.req.query("force") === "1" });
    c.header("cache-control", "private, no-store");
    return {
      from: fromIso, to: toIso, local: withCalendarRelations(humanCalendarEvents(fromIso, toIso)),
      agent: (() => { try { return withCalendarRelations([...agentCalendarEvents(scanAgentScheduledTasks(options.agentCalendar ?? {}).tasks, fromIso, toIso), ...agentRecordEvents(fromIso, toIso)]); } catch { return withCalendarRelations(agentRecordEvents(fromIso, toIso)); } })(),
      google: withCalendarRelations(google.events),
      googleStatus: google.status,
      errors: google.errors,
      cached: google.cached
    };
  }));

  // 同样只有 POST：会在本机弹系统对话框；返回 null 表示用户取消
  app.post("/api/pick-folder", (c) => handle(c, async () => {
    const body = await c.req.json<PickFolderInput>();
    return { picked: await svc.pickFolder(body) };
  }));

  // 实时推送：会话事件、状态、审批变化都经这里通知页面刷新
  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const lifetime = streamLifetime(stream, options.shutdownSignal);
      const onUpdate = (u: { sessionId: string; kind: string }) => {
        void stream.writeSSE({ event: "update", data: JSON.stringify(u) });
      };
      svc.on("update", onUpdate);
      const keepalive = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 15_000);
      try {
        // Flush the response now so EventSource opens without waiting for the 15s keepalive.
        await stream.writeSSE({ event: "ping", data: "{}" });
        await lifetime.done;
        await announceHandoff(stream, options.shutdownSignal);
      } finally {
        clearInterval(keepalive);
        svc.off("update", onUpdate);
      }
    })
  );

  // V3.9 产物：小游戏直接在控制台里加载。版本号是运行时文件的内容哈希，
  // 页面拿它跟本地记录比对，决定要不要提示「有更新」（与顶栏前端更新同一套做法）。
  app.get("/api/artifacts", (c) => {
    c.header("Cache-Control", "private, no-store");
    const catalog = artifacts.catalog();
    const off = appSwitches?.disabledIds();
    // 关闭的应用（小游戏、心愿挑战岛、错题本）不再出现在产物目录里；数据与文件原样保留。
    return c.json(off?.size ? { ...catalog, items: catalog.items.filter((item) => { const owner = appOfArtifact(item.id); return !owner || !off.has(owner.id); }) } : catalog);
  });
  if (artifactCollections) mountArtifactCollectionRoutes(app, artifactCollections, {
    ...(options.runtime ? { readImage: async (source: import('./artifact-collections.js').ArtifactSource) => {
      if (source.type !== 'file') return null;
      const mgr = options.runtime!;
      const view = await mgr.view(source.sessionId);
      const session = view.session;
      if (session.sourceMode === 'external-discovered' && !mgr.settings().history[session.runtimeKind].enabled) throw new Error('历史来源已停用');
      const file = await readPreviewFile({ workspace: session.workspace, roots: mgr.workspaceRoots(session.runtimeKind),
        referencedFiles: mgr.store.binding(session.platformSessionId) ? temporaryFileReferences(mgr.store.events(session.platformSessionId)) : [] }, source.path, source.hints);
      if (file.meta.mode !== 'image') throw new Error('来源不是图片');
      return { bytes: new Uint8Array(await file.content(0, file.meta.size - 1)), mimeType: file.meta.type };
    } } : {}),
    // 测试替身没有运行时管理器时跳过校验；生产里加入已删除的会话直接拒绝。
    ...(options.runtime ? { sessionExists: (id: string) => { try { return !!options.runtime!.store.binding(id); } catch { return false; } } } : {}),
    ...(artifactTagger ? { tagging: artifactTagger } : {}),
  });
  if (stockLedger) mountStockLedgerRoutes(app, stockLedger, { chat: new LedgerChatService(stockLedger, options.ledgerChatPort) });
  // Codex reset 卡：每晚扫描一次（service 由 main.ts 创建并挂调度器），这里只挂读取与手动扫描。
  mountCodexResetRoutes(app, options.codexReset);
  // runtime 版本更新：每天检测 Pi / Claude Code / Codex 的新稳定版（只检测与提示，升级由人手动做）。
  mountRuntimeUpdatesRoutes(app, options.runtimeUpdates);
  if (challenge) mountChallengeRoutes(app, challenge, { ...(challengePoem ? { poem: challengePoem } : {}), ...(challengeIcon ? { icon: challengeIcon } : {}) });
  // 错题本：拍照识题、知识点掌握度、每周测验；数据在数据目录的 wrong-book/，每周按设置的时间自动出题。
  if (ledgerDir) {
    const wrongBook = new WrongBookService(new WrongBookStore(ledgerDir), { ...(options.wrongBookPort ? { port: options.wrongBookPort } : {}), ...(appSwitches ? { enabled: () => appSwitches.enabled('wrong-book') } : {}) });
    mountWrongBookRoutes(app, wrongBook);
    if (options.wrongBookPort) {
      wrongBook.start();
      options.shutdownSignal?.addEventListener('abort', () => wrongBook.stop(), { once: true });
    }
  }
  // 独立版里未发布的分享扩展只有空桩（返回 undefined）：列表里不能放 undefined，否则整套 API 一起挂。
  const challengeShare = challenge ? challengeShareExtension({ store: challenge, ...(challengePoem ? { poem: challengePoem } : {}), ...(challengeIcon ? { icon: challengeIcon } : {}) }) : undefined;
  mountShareRoutes(app, { artifacts, shares: new ArtifactShares(options.shareFile), publicHosts,
    extensions: challengeShare ? [challengeShare] : [] });
  // 消息里的 Mermaid / PlantUML 图表预览
  mountDiagramRoutes(app, options.plantUml ? { plantuml: options.plantUml } : {});

  // 评测产物：固定的 TestCase 集 + 各 runtime / 各版本跑出来的 HTML。结果页带 CSP sandbox（不透明源），
  // 只能被控制台自己嵌入；走和其他接口一样的登录。
  const evalArtifacts = new EvalArtifacts(options.evalDir);
  if (artifactCollections) artifactCollections.syncCatalog([
    { name: '小游戏', entries: artifacts.catalog().items.map((item) => ({ ref: 'game:' + item.id, name: item.name })) },
    { name: '评测产物', entries: evalArtifacts.catalog().suites.map((suite) => ({ ref: 'eval:' + suite.id, name: suite.name })) },
  ]);
  app.get("/api/eval-artifacts", (c) => { c.header("Cache-Control", "private, no-store"); return c.json(evalArtifacts.catalog()); });
  app.get("/evals/*", (c) => {
    const parts = new URL(c.req.url).pathname.slice("/evals/".length).split("/");
    const [suite = "", testCase = "", result = "", ...rest] = parts;
    let rel = "";
    try { rel = decodeURIComponent(rest.join("/")); } catch { return c.json({ error: "not found" }, 404); }
    const payload = evalArtifacts.read(suite, testCase, result, rel);
    if (!payload) return c.json({ error: "not found" }, 404);
    const etag = evalEtag(payload.body);
    const headers = {
      "content-type": payload.type,
      "cache-control": "private, no-cache",
      "content-security-policy": EVAL_CSP,
      "x-frame-options": "SAMEORIGIN",
      "x-content-type-options": "nosniff",
      "etag": etag,
    };
    const validators = c.req.header("if-none-match")?.split(",").map((tag) => tag.trim().replace(/^W\//, ""));
    if (validators?.some((tag) => tag === "*" || tag === etag)) return c.body(null, 304, headers);
    return c.body(new Uint8Array(payload.body), 200, headers);
  });

  app.get("/games/*", (c) => {
    const pathname = new URL(c.req.url).pathname;
    const parts = pathname.slice("/games/".length).split("/").filter(Boolean);
    const id = parts.shift() ?? "";
    let rel = "index.html";
    try { rel = decodeURIComponent(parts.join("/")) || "index.html"; } catch { return c.json({ error: "not found" }, 404); }
    let payload: { body: Buffer; type: string } | null;
    if (rel === "version.json") {
      const manifest = artifacts.versionManifest(id);
      payload = manifest ? { body: Buffer.from(JSON.stringify(manifest)), type: "application/json; charset=utf-8" } : null;
    } else {
      payload = artifacts.read(id, rel);
    }
    if (!payload) return c.json({ error: "not found" }, 404);
    const etag = `"${createHash("sha256").update(payload.body).digest("hex").slice(0, 32)}"`;
    const headers = {
      "content-type": payload.type,
      "cache-control": payload.type.startsWith("image/") ? "public, max-age=86400" : "private, no-cache",
      "content-security-policy": ARTIFACT_CSP,
      // 允许被同源的控制台页面嵌入（点击劫持仍被拦住）
      "x-frame-options": "SAMEORIGIN",
      "x-content-type-options": "nosniff",
      "etag": etag,
    };
    const validators = c.req.header("if-none-match")?.split(",").map((tag) => tag.trim().replace(/^W\//, ""));
    if (validators?.some((tag) => tag === "*" || tag === etag)) return c.body(null, 304, headers);
    return c.body(new Uint8Array(payload.body), 200, headers);
  });

  app.get("*", (c) => {
    const url = new URL(c.req.url);
    if (appSwitchEdition === 'homebrew' && /^\/open-source-release\.(?:js|css)$/.test(url.pathname)) return c.json({ error: "not found" }, 404);
    const archived = staticRelease.get(url.pathname);
    const file = archived ? url.pathname : STATIC[url.pathname];
    if (!file) return c.json({ error: "not found" }, 404);
    const ext = file.slice(file.lastIndexOf(".") + 1);
    const content = archived ?? (url.pathname==='/' ? staticRelease.html : url.pathname==='/sw.js' ? staticRelease.worker : undefined) ?? readFileSync(join(PUBLIC_DIR, file));
    if(url.pathname==='/' && staticRelease.manifest)c.header('X-Pi-Web-Release',staticRelease.manifest.release);
    const digest = createHash("sha256").update(content).digest("hex");
    const representations=staticEncodings.get(digest,content);
    const encoding=selectEncoding(c.req.header('accept-encoding'),representations);
    c.header('Vary','Accept-Encoding');
    if(!encoding)return c.json({error:'没有可接受的内容编码'},406,{'Cache-Control':'private, no-store'});
    const selected=representations[encoding]!;
    const versions = url.searchParams.getAll("v");
    // Content URLs identify decoded source bytes; ETags identify selected wire bytes.
    const versioned = !!archived || (ext === "js" || ext === "css") && versions.length === 1 && versions[0] === digest.slice(0, 12);
    const headers = {
      "content-type": MIME[ext] ?? "text/plain",
      "cache-control": versioned ? "private, max-age=31536000, immutable" : ext === "svg" || ext === "png" || ext === "webmanifest" ? "public, max-age=86400" : "private, no-cache",
      "etag": `"${selected.digest}"`,
      "content-length":String(selected.body.byteLength),
      ...(encoding==='identity'?{}:{'content-encoding':encoding})
    };
    const validators = c.req.header("if-none-match")?.split(",").map(tag => tag.trim().replace(/^W\//, ""));
    if (validators?.some(tag => tag === "*" || tag === headers.etag)) return c.body(null, 304, headers);
    if(c.req.method==='HEAD')return c.body(null,200,headers);
    return c.body(new Uint8Array(selected.body),200,headers);
  });

  // 没被 handle() 接住的异常（Hono 默认回 500 纯文本）：照旧回 500，同时记诊断事件。
  app.onError((err, c) => {
    try { diagnosticsOf(c)?.serverError({ method: c.req.method, path: new URL(c.req.url).pathname, status: 500, requestId: requestIdOf(c), error: err }); } catch { /* 诊断失败不影响响应 */ }
    console.error(err);
    return c.text("Internal Server Error", 500);
  });
  // 装配入口（main.ts）要用开关去管后台监听（局域网端口等），所以挂在返回值上。
  return Object.assign(app, { appSwitches });
}
async function handle(c: Context, fn: () => Promise<unknown>, okStatus: 200 | 201 = 200, timing = false): Promise<Response> {
  try {
    if (!timing && process.env.PI_AGENT_SERVER_TIMING !== "on") return c.json(await fn(), okStatus);
    const start = performance.now();
    const body = await fn();
    const projected = performance.now();
    const response = c.json(body, okStatus);
    const serialized = performance.now();
    response.headers.set("Server-Timing", `projection;dur=${(projected - start).toFixed(2)}, serialization;dur=${(serialized - projected).toFixed(2)}, handler;dur=${(serialized - start).toFixed(2)}`);
    return response;
  } catch (e) {
    // 输入/状态问题是调用方的问题（400/409），其余才是 500
    const err = e as { code?: string; message?: string; issues?: unknown[] };
    const status = e instanceof RelationError ? e.status : e instanceof ConsoleConflict ? 409 : e instanceof ConsoleError ? 400 : 500;
    // V1.4：服务端 500 记成结构化事件并生成证据包（400 / 409 是调用方的问题，不记）
    if (status === 500) { try { diagnosticsOf(c)?.serverError({ method: c.req.method, path: new URL(c.req.url).pathname, status, requestId: requestIdOf(c), error: e }); } catch { /* 诊断失败不影响响应 */ } }
    return c.json({
      error: err.message ?? String(e),
      code: err.code ?? "INTERNAL",
      // 校验失败时逐条列出问题，页面据此标到对应字段上
      ...(Array.isArray(err.issues) && err.issues.length > 0 ? { issues: err.issues } : {})
    }, status);
  }
}
