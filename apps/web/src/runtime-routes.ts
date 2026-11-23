import { relationSources } from "./note-relation-service.js";
import type {RuntimeMemoryPort} from './memory/port.js';
import { deploymentProgress, readDeploymentRun } from "./deployment-progress.js";
import { createHash } from "node:crypto";
import { DeploymentInbox, type DeploymentSubmission } from "./deployment-inbox.js";
import type { NoteIterations } from "./note-iterations.js";
import { FilePreviewError, readPreviewFile, serveFilePreview, temporaryFileReferences, workspaceLocation } from './file-preview.js';
import type { RoomService } from "./room-service.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
/**
 * V2.8 外部 runtime 的 HTTP 接口（需求 §9）。
 *
 * 授权（§8 公网启用条件）：
 *  - 本机入口（127.0.0.1 / localhost，且没有反向代理的转发头）：控制与历史按设置可用
 *  - 对外入口：控制能力默认关闭（publicControl），历史读取另行开关（publicHistory），二者分别授权
 *  - 设置修改与部署排空只接受本机入口
 * 所有写操作还要经过 server.ts 的 Host / Origin 校验与对外登录（服务端会话可过期、可吊销）。
 */
import { DirectoryFeed } from "./directory-feed.js";
import { ReadState } from "./read-state.js";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AttachmentError, IMAGE_LIMITS, PlatformSkillSwitchError, RuntimeError, RUNTIME_KINDS, defaultPermissionMode, listPlatformSkills, permissionOption } from "@pi-agent/runtime-sessions";
import type { AuthFlowMode, DirectoryEntry, PermissionMode, RuntimeAuthFlowSnapshot, RuntimeAuthSubmitInput, RuntimeKind, RuntimeSessionManager, RuntimeSettings } from "@pi-agent/runtime-sessions";
import {factAuditQuery} from './memory/facts.js';
import { readFileSync } from "node:fs";
import { revealInFileManager } from "./reveal.js";
import { compressImage, compressedImageHeaders, imageSizeParam } from "./image-compress.js";
import { inlineHtmlAssets, resolveSessionAsset, resolveSessionFile, SESSION_FILE_CSP, SESSION_HTML_INTERACTIVE_CSP, staticHtmlForThumb } from "./runtime-files.js";
import { DeployConflictError, type DeployInfo, type DeployQueue } from "./deploy-queue.js";
import { readDeployHistory } from "./deploy-history.js";
import { createDeployAutoResolver } from "./deploy-auto-resolve.js";
import { needsDeployInfo, withReplyFallback } from "./quick-reply-deploy.js";
import { receiveUploadDiagnostics, uploadLog } from "./upload-diagnostics.js";
import {syncWindow, type SessionSyncJournal} from './session-sync.js';
import {sessionRestore} from './session-restore.js';
import type {RuntimeSyncSources} from './runtime-sync-source.js';
import {announceHandoff, streamLifetime} from './stream-lifetime.js';
import { deviceOfRequest, originKeys, turnOriginsAt } from './turn-origin.js';

export interface RuntimeAuthCapability {
  managedInstall: boolean;
  requiresNetworkGate: boolean;
  installed: boolean;
  enabled: boolean;
  isolatedCredentials: boolean;
  supportsApiKey: boolean;
  loginMode: AuthFlowMode;
}

export interface RuntimeAuthService {
  capabilities(): { isolatedCredentials: boolean; runtimes: Record<RuntimeKind, RuntimeAuthCapability> };
  networkCheck?(kind: RuntimeKind, apiKey?: string): Promise<Record<string, unknown>>;
  installComponent?(kind: RuntimeKind): Promise<{ installed: boolean; reused?: boolean; version?: string }>;
  startLogin(kind: RuntimeKind): Promise<RuntimeAuthFlowSnapshot>;
  loginStatus(kind: RuntimeKind, flowId?: string): RuntimeAuthFlowSnapshot | null;
  submitLogin(kind: RuntimeKind, flowId: string, input: RuntimeAuthSubmitInput): Promise<RuntimeAuthFlowSnapshot>;
  verifyLogin(kind: RuntimeKind, flowId?: string): Promise<RuntimeAuthFlowSnapshot>;
  cancelLogin(kind: RuntimeKind, flowId?: string): Promise<RuntimeAuthFlowSnapshot | null>;
  shutdown?(): void;
}

export interface RuntimeRouteContext {
  /** 本机可视化运行时安装与官方登录服务（仅 127.0.0.1 可用） */
  runtimeAuth?: RuntimeAuthService;
  validateRecordSources?: (refs: import("../../../packages/runtime-sessions/src/types.js").EntryRef[])=>Promise<import("../../../packages/runtime-sessions/src/types.js").EntryRef[]>;
  iterations?: NoteIterations;
  authPartition?: (c: Context) => string | null;
  /** 已读轮次的保存位置（手机与电脑共用）；不给就只在进程内保存 */
  readStateFile?: string;
  stillAuthenticated?: (c: Context) => boolean;
  sync?: {enabled:boolean;journal:SessionSyncJournal;sources:RuntimeSyncSources};
  /** 进程关停信号：SSE 流据此收尾，避免重启时连接被硬切 */
  shutdown?: AbortSignal;
  submissionsServing?: () => Promise<boolean>;
  rooms?: RoomService;
  isPublic: (c: Context) => boolean;
  actor: (c: Context) => string;
  /** 待办图片（已在本机）：发起会话时直接转成附件，不经手机下载再上传 */
  noteImage?: (id: string) => { bytes: Buffer; mimeType: string; name: string };
  /** 在系统文件管理器里显示文件（测试可替换） */
  revealFile?: (absPath: string) => Promise<void>;
  /** 会话页「空闲时部署」（只对工作目录在 pi-agent 仓库里的会话开放）；不给就不提供 */
  deployQueue?: DeployQueue;
  /** Codex reset 卡小结（张数 + 最近过期时刻）：和额度一起下发，页面不用再单独请求 */
  codexReset?: { badge(): { availableCount: number; soonestExpiry: string | null } };
  /** Pi 所用模型服务（DeepSeek、OpenRouter…）的账户余额；没有接入时不显示 */
  factAudit?: RuntimeMemoryPort['factAudit'];
  /** 平台公共记忆：按条目编号前缀取一句话，供会话侧栏「查阅记录」显示查了哪些条目；不给就只显示编号 */
  publicMemoryEntry?: (idPrefix: string) => { id: string; text: string; scope: string } | undefined;
  providerBalances?: (providers: string[]) => Promise<ProviderBalance[]>;
  /** 只读缓存的余额（不发请求）：会话列表底部的 runtime 摘要跟着目录一次读回去 */
  cachedBalances?: (providers: string[]) => ProviderBalance[];
  /**
   * 页面级通知（待办 / 额度 / 资源）：`app=1` 的实时流订阅它们，
   * 让浏览器只保留一条 SSE。返回取消订阅函数。
   */
  appUpdates?: (listener: (update: { kind: string; sessionId?: string }) => void) => () => void;
}

/** 一个模型服务的余额：值与单位、读取时间、是否非实时，或读不到的原因（字段同「外部资源」页） */
export interface ProviderBalance {
  provider: string;
  balance: { status: string; reason?: string; amounts?: Array<{ label: string; value: number; unit: string }>; fetchedAt?: string; stale?: boolean; consoleUrl?: string; source?: string };
}

/** Pi 模型 id 是 provider/model：取 provider */
const piProviderOf = (model: string | undefined): string | undefined => model && model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;


type Access = "control" | "history" | "local";

/** 带中间件的路由里 Hono 推断不出路径参数，这里统一取值 */
const param = (c: Context, k: string): string => (c.req.param as (k: string) => string | undefined)(k) ?? "";

export function mountRuntimeRoutes(app: Hono, mgr: RuntimeSessionManager, ctx: RuntimeRouteContext): void {
  const allowed = (c: Context, need: Access): string | null => {
    const pub = ctx.isPublic(c);
    if (need === "local") return pub ? "只能在本机入口（127.0.0.1）修改" : null;
    if (!pub) return null;
    const s = mgr.settings();
    if (need === "control" && !s.publicControl) return "对外入口未启用外部 runtime 控制（需在本机的运行时设置中开启）";
    if (need === "history" && !s.publicHistory && !s.publicControl) return "对外入口未启用外部会话查看（需在本机的运行时设置中开启）";
    return null;
  };
  const guard = (need: Access) => async (c: Context, next: () => Promise<void>) => {
    const why = allowed(c, need);
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    await next();
  };
  const run = async (c: Context, fn: () => Promise<unknown> | unknown, ok: 200 | 201 = 200) => {
    try { const result=await fn();return result instanceof Response ? result : c.json(result as object, ok); }
    catch (e) {
      if (e instanceof AttachmentError && e.decodeReason) uploadLog("decode_failed", { uploadId: c.res.headers.get("x-upload-id"), reason: e.decodeReason });
      if (e instanceof RuntimeError || e instanceof AttachmentError) return c.json({ error: e.message, code: e.code }, e.status);
      const err = e as { code?: string; message?: string; decision?: unknown };
      if (err.code === "RUNTIME_NETWORK_BLOCKED") return c.json({ error: err.message ?? "当前网络检查未通过，已停止操作", code: err.code, ...(err.decision ? { decision: err.decision } : {}) }, 409);
      if (err.code === 'SYNC_CURSOR') return c.json({error:err.message,code:err.code},400);
      if (err.code === "RT_STORE_BUSY") return c.json({ error: err.message, code: err.code }, 503);
      if (err.code === "RT_CONFLICT") return c.json({ error: err.message, code: err.code }, 409);
      if (err.code === "RT_NOT_FOUND") return c.json({ error: err.message, code: err.code }, 404);
      console.error("外部 runtime 接口出错：", e);
      return c.json({ error: err.message ?? String(e), code: "INTERNAL" }, 500);
    }
  };
  const kindOf = (v: string): RuntimeKind => {
    if (!(RUNTIME_KINDS as readonly string[]).includes(v)) throw new RuntimeError("runtime 只能是 codex、claude-code、pi 或 antigravity", 400, "RT_INPUT");
    return v as RuntimeKind;
  };
  /** 受管会话的读取：对外入口要求控制或查看任一已开启；已发现历史要求查看授权 */
  const canRead = (c: Context, _id: string): string | null => allowed(c, "history");
  /** 会话目录条目带上「空闲时部署」的排队 / 部署中状态（部署请求由 Web 服务登记，runtime 目录本身不知道） */
  const withDeploy = async <T extends { entries: DirectoryEntry[] }>(d: T): Promise<T> => {
    const q = ctx.deployQueue;
    const by = await q?.byNotifySession(mgr.activity());
    if (!q) return d;
    return { ...d, entries: d.entries.map((e) => {
      const r = by?.get(e.id);
      if (r) return { ...e, deploy: { state: r.startedAt ? "started" : "pending", sha: r.sha, subject: r.subject, requestedAt: r.requestedAt, ...(r.startedAt ? { startedAt: r.startedAt } : {}), id: r.id, notifySession: r.notifySession, ...(r.staging ? { staging: r.staging, stage: r.stage } : {}), ...(r.action ? { action: r.action } : {}), ...(r.progress ? { progress: r.progress } : {}), ...(r.wait ? { wait: { kind: r.wait.kind, short: r.wait.short, detail: r.wait.detail } } : {}) } };
      // 冲突自动解决中 / 需要人处理：列表上也要看得到（尤其是需要人的时候）
      const a = e.worktreeBranch ? q.autoResolveState(e.id) : undefined;
      return a && a.phase !== "queued" ? { ...e, deploy: { state: a.phase, sha: a.head ?? "", subject: a.phase === "needs-human" ? a.reason ?? "" : a.conflicts.join("、"), requestedAt: a.at } } : e;
    }) } as T;
  };

  let activeUploads = 0;
  app.post("/api/runtime-attachment-diagnostics", guard("control"), receiveUploadDiagnostics);
  // Binary uploads avoid base64 amplification in ordinary message JSON. Never read an unbounded body.
  app.post("/api/runtime-attachments", guard("control"), (c) => run(c, async () => {
    if (activeUploads >= 2) throw new RuntimeError("图片上传繁忙，请稍后重试", 503, "RT_UPLOAD_BUSY");
    activeUploads++;
    try {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > IMAGE_LIMITS.singleBytes) throw new AttachmentError("单图不能超过 10 MiB", 413);
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new AttachmentError("图片内容为空");
    const chunks: Uint8Array[] = []; let size = 0;
    // 手机上行慢但持续有数据时不应被杀：这是空闲超时，每收到一块就重置。
    let timer = setTimeout(() => void reader.cancel("upload idle timeout"), 30_000);
    const resetIdle = () => { clearTimeout(timer); timer = setTimeout(() => void reader.cancel("upload idle timeout"), 30_000); };
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        resetIdle();
        size += part.value.byteLength;
        if (size > IMAGE_LIMITS.singleBytes) { await reader.cancel(); throw new AttachmentError("单图不能超过 10 MiB", 413); }
        chunks.push(part.value);
      }
    } finally { clearTimeout(timer); reader.releaseLock(); }
    uploadLog("body_received", { uploadId: c.res.headers.get("x-upload-id"), bytes: size });
    const attachment = await mgr.attachments.upload(Buffer.concat(chunks), (c.req.header("content-type") ?? "").split(";")[0]!.trim(), c.req.query("name") ?? "图片", ctx.actor(c), c.req.query("draftId") ?? "", c.req.header("x-source-sha256") || undefined);
    uploadLog("stored", { uploadId: c.res.headers.get("x-upload-id"), attachmentId: attachment.attachmentId, bytes: attachment.byteSize, width: attachment.width, height: attachment.height, mime: attachment.mimeType });
    return attachment;
    } finally { activeUploads--; }
  }, 201));
  // 再次添加同一张图：浏览器先报原文件哈希，命中本人已存的图就直接建新草稿条目，不再传字节。
  app.post("/api/runtime-attachments/reuse", guard("control"), (c) => run(c, async () => {
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const attachment = mgr.attachments.reuse(String(b["sha256"] ?? ""), ctx.actor(c), String(b["draftId"] ?? ""));
    if (!attachment) return c.json({ error: "没有可复用的图片", code: "RT_ATTACHMENT_MISS" }, 404);
    uploadLog("reused", { attachmentId: attachment.attachmentId, bytes: attachment.byteSize });
    return { ...attachment, reused: true };
  }));
  // 从待办带图发起会话：图片本来就在本机，按待办图片 id 直接建附件（相同字节会链接到已存的那份）。
  app.post("/api/runtime-attachments/from-note", guard("control"), (c) => run(c, async () => {
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (!ctx.noteImage) throw new AttachmentError("待办图片不可用", 404);
    let image: ReturnType<NonNullable<typeof ctx.noteImage>>;
    try { image = ctx.noteImage(String(b["noteImageId"] ?? "")); } catch { throw new AttachmentError("待办图片不存在或已删除", 404); }
    const attachment = await mgr.attachments.upload(image.bytes, image.mimeType, image.name, ctx.actor(c), String(b["draftId"] ?? ""));
    uploadLog("from_note", { noteImageId: String(b["noteImageId"]), attachmentId: attachment.attachmentId, bytes: attachment.byteSize });
    return attachment;
  }, 201));
  app.get("/api/runtime-attachments/:attachmentId", async (c) => {
    try {
      const session = c.req.query("session"), why = allowed(c, session ? "history" : "control");
      if (why) throw new AttachmentError(why, 403);
      if (session) await mgr.view(session);
      const id = param(c, "attachmentId"), thumbnail = c.req.query("thumbnail") === "1";
      const read = mgr.attachments.read(id, ctx.actor(c), thumbnail, session);
      // ?size=view：放大查看用的压缩图（附件不可变，按 id 缓存）；原图仍是不带参数的地址
      const size = thumbnail ? undefined : imageSizeParam(c.req.query("size"));
      const result = size ? await compressImage(`attachment|${id}|${read.bytes.length}`, read.mimeType, size, () => read.bytes) : read;
      return c.body(new Uint8Array(result.bytes), 200, { ...("compressed" in result ? compressedImageHeaders(result) : {}), "Content-Type": result.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    } catch (e) { return run(c, () => { throw e; }); }
  });

  /* ------------------------------ 能力与设置 ------------------------------ */

  app.get("/api/runtime/access", (c) => {
    const pub = ctx.isPublic(c);
    const s = mgr.settings();
    return c.json({
      public: pub, control: !allowed(c, "control"), history: !allowed(c, "history"), canEditSettings: !pub,
      draining: mgr.isDraining(), host: mgr.store.host,
      ...(pub ? { publicControl: s.publicControl, publicHistory: s.publicHistory } : {})
    });
  });
  app.get("/api/runtime-settings", (c) => c.json(mgr.settings()));
  app.put("/api/runtime-settings", guard("local"), (c) => run(c, async () => {
    const body = await c.req.json<Partial<RuntimeSettings>>();
    const next: Partial<RuntimeSettings> = {};
    if (Array.isArray(body.workspaceRoots)) next.workspaceRoots = body.workspaceRoots.map(String).map((x) => x.trim()).filter(Boolean);
    if (body.workspaceRootsByRuntime && typeof body.workspaceRootsByRuntime === "object") {
      next.workspaceRootsByRuntime = {};
      for (const k of RUNTIME_KINDS) {
        const roots = body.workspaceRootsByRuntime[k];
        if (roots === undefined) continue;
        if (roots === null) { next.workspaceRootsByRuntime[k] = undefined; continue; }
        if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string" || !root.trim())) throw new RuntimeError("逐运行时根必须是目录字符串数组", 400, "RT_INPUT");
        next.workspaceRootsByRuntime[k] = roots.map((root) => root.trim());
      }
    }
    if (body.enabledModelsByRuntime && typeof body.enabledModelsByRuntime === "object") {
      next.enabledModelsByRuntime = {};
      for (const k of RUNTIME_KINDS) {
        const models = body.enabledModelsByRuntime[k];
        if (models === undefined) continue;
        if (models === null) { next.enabledModelsByRuntime[k] = undefined; continue; }
        if (!Array.isArray(models) || models.some((m) => typeof m !== "string" || !m.trim())) throw new RuntimeError("可选模型必须是模型 id 的字符串数组", 400, "RT_INPUT");
        next.enabledModelsByRuntime[k] = [...new Set(models.map((m) => m.trim()))];
      }
    }
    if (body.history && typeof body.history === "object") {
      next.history = { ...mgr.settings().history };
      for (const k of RUNTIME_KINDS) {
        const h = (body.history as Record<string, { enabled?: unknown; roots?: unknown }>)[k];
        if (h) {
          const orig = (h as { originators?: unknown }).originators;
          const originators = Array.isArray(orig) ? orig.map(String).map((x) => x.trim()).filter(Boolean) : [];
          next.history[k] = { enabled: h.enabled === true, roots: Array.isArray(h.roots) ? h.roots.map(String).map((x) => x.trim()).filter(Boolean) : [], ...(originators.length ? { originators } : {}) };
        }
      }
    }
    if (typeof body.publicControl === "boolean") next.publicControl = body.publicControl;
    if (typeof body.publicHistory === "boolean") next.publicHistory = body.publicHistory;
    if (body.maxRunningPerProfile !== undefined) next.maxRunningPerProfile = Number(body.maxRunningPerProfile);
    return mgr.updateSettings(next, ctx.actor(c));
  }));

  /**
   * 共享账号同时调用上限（并发会话上限）：和可选模型一样跟着控制权限走——对外入口开了控制就能调，
   * 其余设置（目录根、对外开关、历史授权）仍只收本机入口。范围 1–8 由 updateSettings 校验。
   */
  app.put("/api/runtime-settings/max-running", guard("control"), (c) => run(c, async () => {
    const body = await c.req.json<{ maxRunningPerProfile?: unknown }>().catch(() => ({} as { maxRunningPerProfile?: unknown }));
    if (typeof body.maxRunningPerProfile !== "number") throw new RuntimeError("maxRunningPerProfile 必须是 1–8 的整数", 400, "RT_INPUT");
    return mgr.updateSettings({ maxRunningPerProfile: body.maxRunningPerProfile }, ctx.actor(c));
  }));
  /**
   * 新建会话可选的模型：只在 runtime 报告的模型里收窄或放开，不扩大能力——对外入口开了控制本来就能用任何报告的模型，
   * 所以跟着控制权限走，不像其他设置那样只收本机入口。null = 恢复全部可选。
   */
  app.put("/api/runtime-profiles/:kind/models", guard("control"), (c) => run(c, async () => {
    const kind = kindOf(param(c, "kind"));
    const body = await c.req.json<{ models?: unknown }>().catch(() => ({} as { models?: unknown }));
    if (body.models === null) return mgr.updateSettings({ enabledModelsByRuntime: { [kind]: undefined } }, ctx.actor(c));
    if (!Array.isArray(body.models) || body.models.some((m) => typeof m !== "string" || !m.trim())) throw new RuntimeError("models 必须是模型 id 的字符串数组，或 null（恢复全部可选）", 400, "RT_INPUT");
    const reported = mgr.profile(kind)?.models.map((m) => m.id);
    const models = [...new Set((body.models as string[]).map((m) => m.trim()))];
    const unknown = reported ? models.filter((m) => !reported.includes(m)) : [];
    if (unknown.length) throw new RuntimeError(`该 runtime 没有报告这些模型：${unknown.join("、")}`, 400, "RT_INPUT");
    return mgr.updateSettings({ enabledModelsByRuntime: { [kind]: models } }, ctx.actor(c));
  }));
  /**
   * 新建会话默认配置（模型 / 推理强度 / 审批模式）：浏览器里没有最近一次选择时的兜底。
   * 和可选模型一样只在 runtime 报告的范围内取值，跟着控制权限走。null = 清除。
   */
  app.put("/api/runtime-profiles/:kind/session-defaults", guard("control"), (c) => run(c, async () => {
    const kind = kindOf(param(c, "kind"));
    const body = await c.req.json<{ defaults?: unknown }>().catch(() => ({} as { defaults?: unknown }));
    if (body.defaults === null) return mgr.updateSettings({ defaultSessionByRuntime: { [kind]: undefined } }, ctx.actor(c));
    const d = body.defaults as Record<string, unknown> | undefined;
    if (!d || typeof d !== "object" || ["model", "effort", "permissionMode"].some((k) => typeof d[k] !== "string")) throw new RuntimeError("defaults 必须包含字符串 model、effort、permissionMode（空串 = 运行时默认），或为 null（清除）", 400, "RT_INPUT");
    const model = (d.model as string).trim(), effort = (d.effort as string).trim(), permissionMode = (d.permissionMode as string).trim();
    const profile = mgr.profile(kind);
    if (!profile) throw new RuntimeError("先到运行时配置检查连接，再设置默认配置", 409, "RT_INPUT");
    if (model) {
      if (!profile.models.some((m) => m.id === model)) throw new RuntimeError(`该 runtime 没有报告模型 ${model}`, 400, "RT_INPUT");
      const allowed = mgr.settings().enabledModelsByRuntime?.[kind];
      if (allowed && !allowed.includes(model)) throw new RuntimeError(`模型 ${model} 没有在运行时配置中勾选，不能作为新建会话默认`, 400, "RT_INPUT");
    }
    if (effort) {
      const option = model ? profile.models.find((m) => m.id === model) : (profile.models.find((m) => m.isDefault) ?? (kind === "pi" ? profile.models[0] : undefined));
      if (!(option?.efforts ?? []).includes(effort)) throw new RuntimeError(`该模型不支持推理强度 ${effort}`, 400, "RT_INPUT");
    }
    if (permissionMode && (!permissionOption(kind, permissionMode) || (profile.permissionOptions && !profile.permissionOptions.some((x) => x.id === permissionMode)))) throw new RuntimeError(`该 runtime 没有审批模式 ${permissionMode}`, 400, "RT_INPUT");
    return mgr.updateSettings({ defaultSessionByRuntime: { [kind]: { model, effort, permissionMode } } }, ctx.actor(c));
  }));
  // 平台级技能目录：输入框 `/` 菜单读取。只给展示用字段，不含服务器上的目录路径与说明正文。
  // 被用户禁用的技能不出现在菜单里（与不存在一样）。
  app.get("/api/platform-skills", (c) => c.json({ skills: listPlatformSkills(undefined, mgr.platformSkillSwitches?.disabledIds()) }));
  // 技能开关：全部技能（含已禁用）+ enabled；只改启用状态，不动技能目录与它产生的数据。
  app.get("/api/platform-skills/switches", (c) => {
    c.header("Cache-Control", "private, no-store");
    return c.json(mgr.platformSkillSwitches?.get() ?? { version: 1, revision: 0, updatedAt: null, skills: listPlatformSkills().map((s) => ({ ...s, enabled: true })) });
  });
  app.put("/api/platform-skills/:id", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const switches = mgr.platformSkillSwitches;
    if (!switches) return c.json({ error: "这个实例没有开启技能开关", code: "SKILL_SWITCH_INVALID" }, 400);
    let body: { enabled?: unknown } = {};
    try { body = await c.req.json(); } catch { return c.json({ error: "请求不是合法的 JSON", code: "SKILL_SWITCH_INVALID" }, 400); }
    try { return c.json(switches.set(c.req.param("id"), body.enabled)); }
    catch (e) {
      if (e instanceof PlatformSkillSwitchError) return c.json({ error: e.message, code: e.code }, e.code === "SKILL_SWITCH_UNKNOWN" ? 404 : 400);
      throw e;
    }
  });
  app.get("/api/runtime-profiles", async (c) => {
    const profiles: Array<ReturnType<RuntimeSessionManager["profiles"]>[number] & { balances?: ProviderBalance[] }> = mgr.profiles();
    // Pi 没有订阅额度窗口：改为显示它所用模型服务的账户余额
    const pi = profiles.find((p) => p.runtimeKind === "pi");
    if (pi && ctx.providerBalances) {
      const providers = pi.models.map((m) => piProviderOf(m.id)).filter((p): p is string => !!p);
      try { const balances = await ctx.providerBalances(providers); if (balances.length) pi.balances = balances; } catch { /* 余额读不到不影响运行时列表 */ }
    }
    return c.json({ profiles, host: mgr.store.host, ...(ctx.codexReset ? { codexReset: ctx.codexReset.badge() } : {}) });
  });
  app.post("/api/runtime-profiles/:kind/probe", guard("control"), (c) => run(c, async () => {
    const b = await c.req.json<{ reloggedIn?: unknown }>().catch(() => ({} as { reloggedIn?: unknown }));
    return mgr.probe(kindOf(param(c, "kind")), { reloggedIn: b.reloggedIn === true });
  }));

  /* ------------------------------ 可视化运行时安装与官方登录（仅本机 127.0.0.1） ------------------------------ */

  app.get("/api/runtime-auth/capabilities", guard("local"), (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!ctx.runtimeAuth) return c.json({ available: false, isolatedCredentials: false, runtimes: {} });
    const caps = ctx.runtimeAuth.capabilities();
    return c.json({ available: true, ...caps });
  });
  app.post("/api/runtime-auth/:kind/network-check", guard("local"), (c) => run(c, async () => {
    const kind = kindOf(param(c, "kind"));
    if (!ctx.runtimeAuth?.networkCheck) throw new RuntimeError("当前实例不需要网络门禁检查", 400, "RT_UNSUPPORTED");
    const body = await c.req.json<{ apiKey?: unknown }>().catch(() => ({} as { apiKey?: unknown }));
    if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw new RuntimeError("网络检测 Key 格式无效", 400, "RT_INPUT");
    return ctx.runtimeAuth.networkCheck(kind, body.apiKey as string | undefined);
  }));
  app.post("/api/runtime-auth/:kind/install", guard("local"), (c) => run(c, async () => {
    const kind = kindOf(param(c, "kind"));
    if (!ctx.runtimeAuth?.installComponent) throw new RuntimeError("当前实例不支持在此托管安装组件", 400, "RT_UNSUPPORTED");
    const result = await ctx.runtimeAuth.installComponent(kind);
    return { ...result, capabilities: ctx.runtimeAuth.capabilities() };
  }));
  app.post("/api/runtime-auth/:kind/start", guard("local"), (c) => run(c, async () => {
    const kind = kindOf(param(c, "kind"));
    if (!ctx.runtimeAuth) throw new RuntimeError("当前实例不支持网页登录", 400, "RT_UNSUPPORTED");
    return ctx.runtimeAuth.startLogin(kind);
  }));
  app.get("/api/runtime-auth/:kind/status", guard("local"), (c) => run(c, async () => {
    const kind = kindOf(param(c, "kind"));
    if (!ctx.runtimeAuth) throw new RuntimeError("当前实例不支持网页登录", 400, "RT_UNSUPPORTED");
    const flowId = c.req.query("flowId") || undefined;
    return { flow: ctx.runtimeAuth.loginStatus(kind, flowId) };
  }));
  app.post("/api/runtime-auth/:kind/submit", guard("local"), (c) => run(c, async () => {
    const kind = kindOf(param(c, "kind"));
    if (!ctx.runtimeAuth) throw new RuntimeError("当前实例不支持网页登录", 400, "RT_UNSUPPORTED");
    const body = await c.req.json<{ flowId?: unknown; code?: unknown; provider?: unknown; apiKey?: unknown; modelId?: unknown }>().catch(() => ({} as Record<string, unknown>));
    if (typeof body.flowId !== "string" || !body.flowId.trim()) throw new RuntimeError("缺少登录会话编号", 400, "RT_INPUT");
    try {
      return await ctx.runtimeAuth.submitLogin(kind, body.flowId.trim(), {
        ...(typeof body.code === "string" ? { code: body.code } : {}),
        ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
        ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
        ...(typeof body.modelId === "string" ? { modelId: body.modelId } : {}),
      });
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(error instanceof Error ? error.message : "提交失败", 400, "RT_AUTH_INPUT");
    }
  }));
  app.post("/api/runtime-auth/:kind/verify", guard("local"), (c) => run(c, async () => {
    const kind = kindOf(param(c, "kind"));
    if (!ctx.runtimeAuth) throw new RuntimeError("当前实例不支持网页登录", 400, "RT_UNSUPPORTED");
    const body = await c.req.json<{ flowId?: unknown }>().catch(() => ({} as { flowId?: unknown }));
    return ctx.runtimeAuth.verifyLogin(kind, typeof body.flowId === "string" ? body.flowId : undefined);
  }));
  app.post("/api/runtime-auth/:kind/cancel", guard("local"), (c) => run(c, async () => {
    const kind = kindOf(param(c, "kind"));
    if (!ctx.runtimeAuth) throw new RuntimeError("当前实例不支持网页登录", 400, "RT_UNSUPPORTED");
    const body = await c.req.json<{ flowId?: unknown }>().catch(() => ({} as { flowId?: unknown }));
    return { flow: await ctx.runtimeAuth.cancelLogin(kind, typeof body.flowId === "string" ? body.flowId : undefined) };
  }));
  app.post("/api/runtime-profiles/:kind/rate-limits", guard("control"), (c) => run(c, async () => {
    const body = await c.req.json<{ automatic?: unknown }>().catch(() => ({} as { automatic?: unknown }));
    return { rateLimit: await mgr.refreshRateLimit(kindOf(param(c, "kind")), { automatic: body.automatic === true }) ?? null };
  }));
  app.get("/api/runtime-profiles/:kind/settings-preview", guard("control"), (c) => run(c, async () => {
    const kind = kindOf(param(c, "kind"));
    const cwd = c.req.query("cwd") ?? "";
    const p = mgr.profile(kind);
    if (!p) throw new RuntimeError("还没检查过这个 runtime", 409, "RT_PROFILE");
    const model = c.req.query("model");
    if (model !== undefined) mgr.checkSelectableModel(kind, model);
    // Claude：按所选目录解析项目级设置（允许规则、hooks、MCP）；Codex 的项目层随 AGENTS.md 与配置文件原生加载
    const drv = mgr.drivers[kind] as { settingsSummary?: (cwd: string) => Promise<string[]> };
    const lines = kind === "claude-code" && drv.settingsSummary && cwd.startsWith("/") ? await drv.settingsSummary(cwd) : p.configSummary;
    const savedMode = mgr.settings().defaultSessionByRuntime?.[kind]?.permissionMode;
    const fallbackMode = savedMode && permissionOption(kind, savedMode) && (!p.permissionOptions || p.permissionOptions.some((x) => x.id === savedMode)) ? savedMode : defaultPermissionMode(kind);
    const mode = c.req.query("permissionMode") || fallbackMode;
    const permissions = permissionOption(kind, mode);
    if (!permissions || (p.permissionOptions && !p.permissionOptions.some((x) => x.id === mode))) throw new RuntimeError("该运行时不支持所选权限模式，请重新检查连接", 400, "RT_INPUT");
    return { lines, permissions, permissionMode: mode, workspaceRoots: mgr.workspaceRoots(kind), profileVersion: p.checkedAt };
  }));
  /** 新建会话的文件夹浏览：只列允许根之内的子目录 */
  app.get("/api/runtime-profiles/:kind/folders", guard("control"), (c) => run(c, () => mgr.browseFolders(kindOf(param(c, "kind")), c.req.query("path") || undefined)));
  /** 增量索引：在授权范围内重新列出历史（只读，不写原文件） */
  app.post("/api/runtime-profiles/:kind/history-index", guard("history"), (c) => run(c, async () => {
    kindOf(param(c, "kind"));
    const d = await mgr.directory({ limit: 1, includeHistory: true });
    return { history: d.history };
  }));

  /* ------------------------------ 目录与查看 ------------------------------ */

  const directoryFeed = new DirectoryFeed<any>();
  const readState = new ReadState(ctx.readStateFile);
  app.get("/api/runtime/read-state", (c) => run(c, async () => {
    c.header('Cache-Control', 'private, no-store');
    if (allowed(c, "history")) throw new RuntimeError("未授予会话读取权限", 403, "RT_FORBIDDEN");
    return { turns: readState.snapshot() };
  }));
  app.post("/api/runtime/read-state", (c) => run(c, async () => {
    c.header('Cache-Control', 'private, no-store');
    if (allowed(c, "history")) throw new RuntimeError("未授予会话读取权限", 403, "RT_FORBIDDEN");
    const raw = await c.req.text();
    if (raw.length > 65536) throw new RuntimeError("请求过大", 400, "RT_TOO_LARGE");
    let body: unknown; try { body = JSON.parse(raw); } catch { throw new RuntimeError("请求无效", 400, "RT_BAD_REQUEST"); }
    readState.merge((body as { turns?: unknown } | null)?.turns);
    return { turns: readState.snapshot() };
  }));
  const readDirectory = async (c: Context, q: Record<string, string>) => {
    const pub = ctx.isPublic(c);
    const canHistory = !allowed(c, "history");
    if (pub && !canHistory) {
      // 对外入口没开查看：外部会话不出现
      return { entries: [], total: 0, history: {}, restricted: "对外入口未启用外部会话查看" };
    }
    const directory = await mgr.directory({
      ...(q["source"] ? { source: q["source"] } : {}), ...(q["status"] ? { status: q["status"] } : {}), ...(q["q"] ? { q: q["q"] } : {}),
      ...(q["runtime"] ? { runtime: q["runtime"] } : {}), ...(q["cursor"] ? { cursor: q["cursor"] } : {}), ...(q["archived"] ? { archived: q["archived"] } : {}),
      limit: Number(q["limit"] ?? 50)
    }, [], new Map(ctx.rooms?.list().map((room) => [room.roomId, room.workspace]))).then(withDeploy).then((d) => {
      // 成员会话的标题是建群时的样子；列表上的群名称以群当前的标题为准（建群后可以改名）
      const titles = new Map((ctx.rooms?.list() ?? []).map((room) => [room.roomId, room.title]));
      return titles.size ? { ...d, entries: d.entries.map((e) => (e.roomRef && titles.has(e.roomRef.roomId) ? { ...e, roomTitle: titles.get(e.roomRef.roomId) } : e)) } : d;
    });
    // 时钟上的预约计数：与预约弹窗同一口径（未归档、按每条会话的读取权限过滤），不随列表的搜索 / 运行筛选变化
    const scheduledCount = canHistory ? mgr.scheduledMessages().filter((m) => !canRead(c, m.platformSessionId)).length : 0;
    // 列表底部那三行弱化文字（每个 runtime 的额度 / 余额）搭目录这一次读带回去：
    // 列表首屏不多发请求，余额只用服务端缓存，不在这里向服务商读取。
    const withSchedule = { ...directory, scheduledCount, runtimes: runtimeSummary() };
    return withSchedule;
  };
  /** 每个 runtime 一句摘要：额度窗口与 Pi 模型服务的余额（同会话详情里的口径） */
  const runtimeSummary = () => {
    const profiles = mgr.profiles();
    const pi = profiles.find((p) => p.runtimeKind === "pi");
    const providers = pi ? [...new Set(pi.models.map((m) => piProviderOf(m.id)).filter((p): p is string => !!p))] : [];
    const balances = providers.length && ctx.cachedBalances ? ctx.cachedBalances(providers) : [];
    return profiles.map((p) => {
      const rl = p.rateLimit;
      return {
        runtimeKind: p.runtimeKind, state: p.state,
        ...(rl && rl.available && rl.windows?.length
          ? { rateLimit: { windows: rl.windows.map((w) => ({ label: w.label, ...(w.group ? { group: w.group } : {}), usedPercent: w.usedPercent ?? null, resetsAt: w.resetsAt ?? null })), sampledAt: rl.sampledAt ?? null, stale: !!rl.stale } }
          : {}),
        ...(p.runtimeKind === "pi" && balances.length ? { balances } : {})
      };
    });
  };
  const withCacheAccess = (c: Context, q: Record<string, string>, withSchedule: any) => {
    if (withSchedule.restricted) return withSchedule;
    const directory = withSchedule;
    if (q['cacheAccess'] !== '1') return withSchedule;
    c.header('Cache-Control','private, no-store');
    if(ctx.stillAuthenticated && !ctx.stillAuthenticated(c))throw new RuntimeError('请重新登录',401,'SYNC_AUTH');
    if(allowed(c,'history'))throw new RuntimeError('查看权限已变化',403,'RT_FORBIDDEN');
    return {...withSchedule,cacheAccess:{schema:1,partition:ctx.authPartition?.(c)??null,resources:[
      ...directory.entries.filter((e:any)=>e.href===`#/rt/${e.id}`).map((e:any)=>({kind:'rt',id:e.id})),
      ...(ctx.rooms?.list()??[]).map(room=>({kind:'room',id:room.roomId}))
    ]}};
  };
  app.get("/api/session-directory", (c) => run(c, async () => {
    const q = c.req.query();
    const dir = await readDirectory(c, q);
    // Codex reset 小结跟着目录一起下发：会话列表底部的额度方框直接画，不再单独请求
    return withCacheAccess(c, q, ctx.codexReset ? { ...dir, codexReset: ctx.codexReset.badge() } : dir);
  }));
  // The list as a numbered change feed: a client holding a cursor receives only what changed.
  app.get("/api/session-directory/feed", (c) => run(c, async () => {
    const q = { source: "chat", limit: "200", ...(c.req.query()["cacheAccess"] ? { cacheAccess: c.req.query()["cacheAccess"]! } : {}) };
    const full = withCacheAccess(c, q, await readDirectory(c, q)) as any;
    c.header('Cache-Control', 'private, no-store');
    // Restricted or paged lists have no stable ordering to follow: hand back the plain directory.
    // Codex reset 小结也带上：走增量 feed 的客户端（复用游标）同样能画右上角的小标
    const reset = ctx.codexReset ? { codexReset: ctx.codexReset.badge() } : {};
    if (full.restricted || full.nextCursor) return { protocolVersion: 1, mode: 'snapshot', plain: { ...full, ...reset } };
    const { entries, cacheAccess, ...meta } = full;
    return { ...directoryFeed.read(c.req.query()["cursor"], entries), meta: { ...meta, ...reset }, ...(cacheAccess ? { cacheAccess } : {}) };
  }));

  app.get("/api/runtime-usage", (c) => {
    const why = allowed(c, "history");
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? "14") || 14));
    let tz = c.req.query("tz") ?? "UTC";
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = "UTC"; }
    return c.json(mgr.usageSummary({ days, timeZone: tz }));
  });

  app.get('/api/runtime-sessions/:id/restore', (c) => run(c, async () => {
    c.header('Cache-Control','private, no-store');
    const id=param(c,'id');
    const check=()=>{
      if(ctx.stillAuthenticated&&!ctx.stillAuthenticated(c))throw new RuntimeError('请重新登录',401,'SYNC_AUTH');
      if(canRead(c,id))throw new RuntimeError('查看权限已变化',403,'RT_FORBIDDEN');
    };
    check();await mgr.view(id, { includeUsage: false });check();
    if(c.req.query('targetCursor')!==undefined)throw new RuntimeError('首次恢复不接受追页终点，请使用同步接口',400,'RESTORE_INPUT');
    const result=await sessionRestore({
      resource:{kind:'rt',id},partition:ctx.authPartition?.(c)??null,
      candidatePartition:c.req.query('candidatePartition'),cursor:c.req.query('cursor'),window:syncWindow(c.req.query(),'rt'),
      ...(ctx.sync?{sync:{enabled:ctx.sync.enabled,journal:ctx.sync.journal,source:ctx.sync.sources.source(id)}}:{})
    });
    check();await mgr.view(id, { includeUsage: false });check();return result;
  }));
  app.get('/api/runtime-sessions/:id/sync', (c) => run(c, async () => {
    c.header('Cache-Control','private, no-store');
    const id=param(c,'id');
    if(canRead(c,id))throw new RuntimeError('查看权限已变化',403,'RT_FORBIDDEN');
    if(!ctx.sync?.enabled)throw new RuntimeError('增量同步已关闭',503,'SYNC_DISABLED');
    await mgr.view(id, { includeUsage: false });
    const result=await ctx.sync.journal.sync({kind:'rt',id},ctx.sync.sources.source(id),syncWindow(c.req.query(),'rt'),c.req.query('cursor'),c.req.query('targetCursor'),c.req.query('resume')==='1');
    if(ctx.stillAuthenticated && !ctx.stillAuthenticated(c))throw new RuntimeError('请重新登录',401,'SYNC_AUTH');
    if(canRead(c,id))throw new RuntimeError('查看权限已变化',403,'RT_FORBIDDEN');
    return result;
  }));
  for (const endpoint of ['cache-access', 'bootstrap']) app.get(`/api/runtime-sessions/:id/${endpoint}`, (c) => {
    c.header('Cache-Control', 'private, no-store');
    const id = param(c, 'id'), why = canRead(c, id);
    if (why) return c.json({ error: why, code: 'RT_FORBIDDEN' }, 403);
    return run(c, async () => {
      await mgr.view(id, { includeUsage: false });
      if(ctx.stillAuthenticated && !ctx.stillAuthenticated(c))throw new RuntimeError('请重新登录',401,'SYNC_AUTH');
      if (canRead(c, id)) throw new RuntimeError('查看权限已变化', 403, 'RT_FORBIDDEN');
      return { schema: 1, resource: { kind: 'rt', id }, partition: ctx.authPartition?.(c) ?? null,
        ...(endpoint === 'bootstrap' ? { display: { allowed: true }, control: { requiresLatestState: true }, incremental: { supported: !!ctx.sync?.enabled, protocolVersion: 1 } } : {}) };
    });
  });
  app.get("/api/runtime-scheduled-messages", guard("history"), c => run(c, () => {
    c.header("Cache-Control", "private, no-store");
    return { messages: mgr.scheduledMessages().filter(m => !canRead(c, m.platformSessionId)) };
  }));
  app.get("/api/runtime-sessions/:id", (c) => {
    const why = canRead(c, param(c, "id"));
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    return run(c, async () => {
      const v: Awaited<ReturnType<RuntimeSessionManager["view"]>> & { balances?: ProviderBalance[] } = await mgr.view(param(c, "id"), { includeUsage: c.req.query("detail") !== "summary" });
      // Pi 会话：显示这次所用模型服务的账户余额
      const provider = v.session.runtimeKind === "pi" ? piProviderOf(v.session.effectiveModel || v.session.requestedModel || mgr.profile("pi")?.models.find((m) => m.isDefault)?.id) : undefined;
      if (provider && ctx.providerBalances) {
        try { const balances = await ctx.providerBalances([provider]); if (balances.length) v.balances = balances; } catch { /* 余额读不到不影响会话画面 */ }
      }
      return v;
    });
  });
  app.get('/api/runtime-sessions/:id/memory-fact-decisions',c=>{
    c.header('Cache-Control','private, no-store');const id=param(c,'id'),why=canRead(c,id);if(why)return c.json({error:why,code:'RT_FORBIDDEN'},403);
    return run(c,async()=>{
      let query;try{query=factAuditQuery(new URL(c.req.url).searchParams);}catch{throw new RuntimeError('无效校验查询',400,'RT_INPUT');}
      const binding=mgr.store.binding(id),empty={version:1,sourceId:'',ledgerIdentity:'',items:[],hasMore:false,nextCursor:null,supported:false,health:'unsupported'};
      if(!binding){await mgr.view(id);return empty;}if(binding.runtimeKind!=='pi'||binding.hostId!==mgr.store.host.hostId||!ctx.factAudit)return empty;
      let page;try{page=await ctx.factAudit(binding.workspace,id,query,c.req.raw.signal);}catch{throw new RuntimeError('校验记录暂时无法读取',503,'MEMORY_UNAVAILABLE');}
      if(ctx.stillAuthenticated&&!ctx.stillAuthenticated(c))throw new RuntimeError('请重新登录',401,'SYNC_AUTH');if(canRead(c,id))throw new RuntimeError('查看权限已变化',403,'RT_FORBIDDEN');
      const latest=mgr.store.binding(id);if(!latest||latest.workspace!==binding.workspace||latest.nativeSessionId!==binding.nativeSessionId||latest.runtimeKind!==binding.runtimeKind||latest.hostId!==binding.hostId)throw new RuntimeError('会话已变化，请刷新',409,'RT_CONFLICT');return page;
    });
  });
  app.get("/api/runtime-sessions/:id/usage", (c) => {
    const id = param(c, "id"), why = canRead(c, id);
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    return run(c, async () => {
      const view = await mgr.view(id);
      if (ctx.stillAuthenticated && !ctx.stillAuthenticated(c)) throw new RuntimeError("请重新登录", 401, "SYNC_AUTH");
      if (canRead(c, id)) throw new RuntimeError("查看权限已变化", 403, "RT_FORBIDDEN");
      return view.usage;
    });
  });
  /* ------------------------------ 会话里提到的图片 / HTML ------------------------------ */

  /** 会话工作目录：受管会话与授权历史都从会话画面取 */
  const sessionWorkspace = async (id: string): Promise<string | undefined> => (await mgr.view(id)).session.workspace;
  /** 批量检查路径：只返回本会话工作目录之内、真实存在的图片 / HTML（页面据此决定显示哪些预览卡片） */
  for (const endpoint of ["file-preview", "file-content"]) app.get(`/api/runtime-sessions/:id/${endpoint}`, guard("history"), async c => {
    try {
      const session = (await mgr.view(param(c, "id"))).session;
      if (session.hostId !== mgr.store.host.hostId) throw new RuntimeError("文件所在运行主机不可用", 409, "FILE_HOST_UNAVAILABLE");
      if (session.sourceMode === "external-discovered" && !mgr.settings().history[session.runtimeKind].enabled) throw new RuntimeError("历史来源已停用", 403, "RT_FORBIDDEN");
      const references = mgr.store.binding(session.platformSessionId) ? temporaryFileReferences(mgr.store.events(session.platformSessionId)) : [];
      return serveFilePreview(c, { workspace: session.workspace, roots: mgr.workspaceRoots(session.runtimeKind), referencedFiles: references }, endpoint === "file-content");
    } catch(e) { if(e instanceof RuntimeError) return c.json({error:e.message,code:e.code},e.status); return c.json({error:"会话不可用"},404); }
  });
  app.get("/api/runtime-sessions/:id/files/stat", (c) => {
    const why = canRead(c, param(c, "id"));
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    return run(c, async () => {
      const ws = await sessionWorkspace(param(c, "id"));
      const paths = [...new Set(c.req.queries("path") ?? [])].slice(0, 30);
      return { files: paths.map((p) => { const f = resolveSessionFile(ws, p); return f.ok ? { path: p, ok: true, rel: f.rel, kind: f.kind, size: f.size, mtime: f.mtime, absPath: f.real } : { path: p, ok: false, reason: f.reason }; }) };
    });
  });
  app.get("/api/runtime-sessions/:id/files/raw", async (c) => {
    const why = canRead(c, param(c, "id"));
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    let ws: string | undefined;
    try { ws = await sessionWorkspace(param(c, "id")); }
    catch (e) { return c.json({ error: (e as Error).message, code: "RT_NOT_FOUND" }, 404); }
    const f = resolveSessionFile(ws, c.req.query("path") ?? "");
    if (!f.ok) return c.json({ error: f.reason, code: "RT_FILE" }, 404);
    const sandboxed = f.kind === "html" || f.mediaType.startsWith("image/svg");
    const size = f.kind === "image" ? imageSizeParam(c.req.query("size")) : undefined;
    if (size) {
      const out = await compressImage(`${f.real}|${f.size}|${f.mtime}`, f.mediaType, size, () => readFileSync(f.real));
      return c.body(new Uint8Array(out.bytes), 200, {
        ...compressedImageHeaders(out), "content-type": out.mimeType, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-cache",
        "content-disposition": "inline", ...(sandboxed ? { "content-security-policy": SESSION_FILE_CSP } : {})
      });
    }
    return c.body(new Uint8Array(readFileSync(f.real)), 200, {
      "content-type": f.mediaType, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-cache",
      "content-disposition": "inline", ...(sandboxed ? { "content-security-policy": SESSION_FILE_CSP } : {})
    });
  });
  /**
   * HTML 交互预览：路径形式的地址，页面里相对引用的同目录资源（js / css / 图片 / 字体…）能按原样解析。
   * HTML 带交互沙箱 CSP（可执行脚本，不给同源权限）；其余资源同样只读工作目录之内。
   */
  app.get("/api/runtime-sessions/:id/files/view/*", async (c) => {
    const id = param(c, "id");
    const why = canRead(c, id);
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    const prefix = `/api/runtime-sessions/${encodeURIComponent(id)}/files/view/`;
    const pathname = new URL(c.req.url).pathname;
    if (!pathname.startsWith(prefix)) return c.json({ error: "路径无效", code: "RT_FILE" }, 404);
    let rel: string;
    try { rel = pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/"); }
    catch { return c.json({ error: "路径无效", code: "RT_FILE" }, 404); }
    let ws: string | undefined;
    try { ws = await sessionWorkspace(id); }
    catch (e) { return c.json({ error: (e as Error).message, code: "RT_NOT_FOUND" }, 404); }
    const f = resolveSessionAsset(ws, rel);
    if (!f.ok) return c.json({ error: f.reason, code: "RT_FILE" }, 404);
    const csp = f.kind === "html" ? SESSION_HTML_INTERACTIVE_CSP : f.mediaType.startsWith("image/svg") ? SESSION_FILE_CSP : undefined;
    // HTML：把同目录的脚本、样式与图片内联进去（沙箱页面再请求时不带登录 Cookie，对外域名上会被拦）
    const body = f.kind === "html" ? new TextEncoder().encode(inlineHtmlAssets(readFileSync(f.real, "utf8"), ws!, f.rel)) : new Uint8Array(readFileSync(f.real));
    return c.body(body, 200, {
      "content-type": f.mediaType, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-cache",
      ...(csp ? { "content-security-policy": csp } : {})
    });
  });

  /**
   * HTML 缩略图（消息里文件引用的一帧预览）：内联同目录的样式与图片、去掉脚本，用静态沙箱 CSP 下发。
   * 这一层只给「看起来像截图」的静态快照，不执行页面脚本、不向外请求；点开才走上面的交互预览。
   */
  app.get("/api/runtime-sessions/:id/files/thumb", guard("history"), async (c) => {
    let file: Awaited<ReturnType<typeof readPreviewFile>> | undefined;
    try {
      const session = (await mgr.view(param(c, "id"))).session;
      if (session.hostId !== mgr.store.host.hostId) throw new RuntimeError("文件所在运行主机不可用", 409, "FILE_HOST_UNAVAILABLE");
      if (session.sourceMode === "external-discovered" && !mgr.settings().history[session.runtimeKind].enabled) throw new RuntimeError("历史来源已停用", 403, "RT_FORBIDDEN");
      const references = mgr.store.binding(session.platformSessionId) ? temporaryFileReferences(mgr.store.events(session.platformSessionId)) : [];
      file = await readPreviewFile({ workspace: session.workspace, roots: mgr.workspaceRoots(session.runtimeKind), referencedFiles: references }, c.req.query("path") || "", c.req.queries("hint") ?? []);
      if (!/\.html?$/i.test(file.meta.path)) throw new RuntimeError("缩略预览只支持 HTML", 400, "FILE_UNSUPPORTED");
      const root = await workspaceLocation(session.workspace);
      const rel = relative(root, file.meta.path).split(sep).join("/");
      const bytes = await file.content(0, Math.max(0, file.meta.size) - 1);
      const html = staticHtmlForThumb(bytes.toString("utf8"), root, rel.startsWith("..") ? file.meta.name : rel);
      return c.body(new TextEncoder().encode(html), 200, {
        "Cache-Control": "private, no-cache", "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": SESSION_FILE_CSP, "Referrer-Policy": "no-referrer", "X-Frame-Options": "SAMEORIGIN"
      });
    } catch (e) {
      if (e instanceof RuntimeError || e instanceof FilePreviewError) return c.json({ error: e.message, code: e.code }, e.status);
      return c.json({ error: "缩略预览不可用", code: "FILE_UNAVAILABLE" }, 404);
    } finally { await file?.close(); }
  });

  /** 在本机的访达里显示（只显示、不打开）；只接受本机入口的 POST */
  app.post("/api/runtime-sessions/:id/files/reveal", guard("local"), (c) => run(c, async () => {
    const b = await c.req.json<{ path?: unknown }>().catch(() => ({} as { path?: unknown }));
    const f = resolveSessionFile(await sessionWorkspace(param(c, "id")), typeof b.path === "string" ? b.path : "");
    if (!f.ok) throw new RuntimeError(f.reason, 404, "RT_FILE");
    await (ctx.revealFile ?? revealInFileManager)(f.real);
    return { ok: true };
  }));

  app.get("/api/runtime-sessions/:id/images/:seq", async (c) => {
    const id = param(c, "id");
    const why = canRead(c, id);
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    const seq = Number(param(c, "seq"));
    if (!Number.isFinite(seq) || seq <= 0) return c.json({ error: "图片不存在" }, 404);
    try {
      const view = await mgr.view(id);
      const page = await mgr.messages(id, { before: seq + 1, limit: 200 });
      const event = page.events.find(e => e.seq === seq && e.kind === "image");
      if (view.session.runtimeKind !== "codex" || !event?.image?.path || event.image.status !== "completed") throw new RuntimeError("图片不存在", 404, "RT_NOT_FOUND");
      // 路径只能来自已授权会话的事件，且必须属于该原生会话的生成图片目录。
      const home = await realpath(process.env["CODEX_HOME"] || join(homedir(), ".codex"));
      const root = join(home, "generated_images", view.session.nativeSessionId!);
      const file = await realpath(event.image.path);
      if (!file.startsWith(root + sep)) throw new RuntimeError("图片不在该会话的生成目录内", 403, "RT_FORBIDDEN");
      const info = await stat(file);
      if (!info.isFile() || info.size > 25 * 1024 * 1024) throw new RuntimeError("图片无法读取", 404, "RT_NOT_FOUND");
      const bytes = await readFile(file);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new RuntimeError("图片格式不支持", 404, "RT_NOT_FOUND");
      const size = imageSizeParam(c.req.query("size"));
      const out = size ? await compressImage(`${file}|${info.size}|${info.mtimeMs}`, "image/png", size, () => bytes) : undefined;
      return c.body(new Uint8Array(out?.bytes ?? bytes), 200, { ...(out ? compressedImageHeaders(out) : {}), "Content-Type": out?.mimeType ?? "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    } catch (e) {
      if (e instanceof RuntimeError) return c.json({ error: e.message, code: e.code }, e.status);
      return c.json({ error: "图片文件不可用", code: "RT_NOT_FOUND" }, 404);
    }
  });

  app.get("/api/runtime-sessions/:id/image-index", (c) => {
    const why = canRead(c, param(c, "id"));
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    c.header("Cache-Control", "private, no-store");
    return run(c, () => mgr.imageIndex(param(c, "id")));
  });

  app.get("/api/runtime-sessions/:id/message-index", (c) => {
    const why = canRead(c, param(c, "id"));
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    c.header("Cache-Control", "private, no-store");
    return run(c, () => mgr.messageIndex(param(c, "id")));
  });

  /** 会话里用到的联网搜索 / 网页抓取记录（所有 runtime；从工具调用事件里挑出） */
  app.get("/api/runtime-sessions/:id/web-activity", (c) => {
    const why = canRead(c, param(c, "id"));
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    c.header("Cache-Control", "private, no-store");
    return run(c, () => mgr.webActivity(param(c, "id")));
  });

  /** 平台首轮注入的正文（目前只有公共记忆）：侧栏记忆卡片点开可查看当时实际注入的内容 */
  app.get("/api/runtime-sessions/:id/injections", (c) => {
    const why = canRead(c, param(c, "id"));
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    c.header("Cache-Control", "private, no-store");
    return run(c, async () => {
      const page = await mgr.injections(param(c, "id"));
      // 查阅记录里的条目编号 → 当时能对上的条目（已删除 / 改编号的对不上就不给，界面只显示编号）
      const entries: Record<string, { id: string; text: string; scope: string }> = {};
      if (ctx.publicMemoryEntry) for (const l of page.lookups) for (const op of l.ops) for (const prefix of op.ids) {
        if (prefix in entries) continue;
        try { const hit = ctx.publicMemoryEntry(prefix); if (hit) entries[prefix] = hit; } catch { /* 对不上就只显示编号 */ }
      }
      return { ...page, entries };
    });
  });

  app.get("/api/runtime-sessions/:id/messages", (c) => {
    const why = canRead(c, param(c, "id"));
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    const n = (k: string) => { const v = c.req.query(k); return v === undefined || v === "" ? undefined : Number(v); };
    return run(c, () => mgr.messages(param(c, "id"), {
      ...(n("before") !== undefined ? { before: n("before")! } : {}), ...(n("after") !== undefined ? { after: n("after")! } : {}),
      ...(n("limit") !== undefined ? { limit: n("limit")! } : {}), ...(c.req.query("kind") ? { kind: c.req.query("kind")! } : {})
    }));
  });

  /**
   * 断线续传：先补 after 之后的事件，再推送新事件；始终绑定目标会话 ID。
   * 同一条流也带目录、profile 与审批的变化通知（页面据此局部刷新）。
   */
  app.get("/api/runtime/stream", (c) => run(c, async () => {
    const id = c.req.query("session") ?? "";
    const watch: Array<{kind:'rt'|'room';id:string}> = [];
    if(c.req.query('watch')) {
      let parsed:unknown;try{parsed=JSON.parse(c.req.query('watch')!);}catch{throw new RuntimeError('非法订阅',400,'RT_INPUT');}
      if(!Array.isArray(parsed)||parsed.length>12)throw new RuntimeError('订阅最多 12 个会话',400,'RT_INPUT');
      for(const resource of parsed) {
        if(!resource||!['rt','room'].includes(resource.kind)||typeof resource.id!=='string'||resource.id.length>200)throw new RuntimeError('非法订阅',400,'RT_INPUT');
        if(canRead(c,resource.id))throw new RuntimeError('查看权限已变化',403,'RT_FORBIDDEN');
        if(resource.kind==='rt')await mgr.view(resource.id);else {if(!ctx.rooms)throw new RuntimeError('群聊不存在',404,'RT_NOT_FOUND');ctx.rooms.view(resource.id);}
        watch.push(resource);
      }
      if(ctx.stillAuthenticated&&!ctx.stillAuthenticated(c))throw new RuntimeError('请重新登录',401,'SYNC_AUTH');
    }
    if (id || c.req.query("comparison") || c.req.query("room")) { const why = canRead(c, id); if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403); }
    const roomId = c.req.query("room") ?? "";
    if (roomId) { try { ctx.rooms?.view(roomId); } catch { return c.json({ error: "群聊不存在", code: "RT_NOT_FOUND" }, 404); } }
    const noticesOnly=!!ctx.sync?.enabled&&c.req.query("sync")==="1";
    // app=1：同一条流也承载页面级通知（待办、余额、资源），页面不必再开 /api/stream。
    const appUpdates = c.req.query("app")==="1" ? ctx.appUpdates : undefined;
    const after = Number(c.req.query("after") ?? "0") || 0;
    return streamSSE(c, async (stream) => {
      let last = after;
      const lifetime=streamLifetime(stream,ctx.shutdown),finishStream=lifetime.finish;
      const send = (event: string, data: unknown) => {
        if(ctx.stillAuthenticated&&!ctx.stillAuthenticated(c)) {finishStream();void stream.close();return;}
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      const hint=(kind:'rt'|'room',resourceId:string)=>{
        if(watch.some(r=>r.kind===kind&&r.id===resourceId)&&!canRead(c,resourceId))send('sync-notice',{resource:{kind,id:resourceId},...(ctx.sync?.enabled?{noticeCoverage:ctx.sync.journal.noticeCoverage()}:{})});
      };
      if (id && mgr.store.binding(id) && !noticesOnly) {
        const backlog = await mgr.messages(id, { after, limit: 200 }).catch(() => null);
        for (const e of backlog?.events ?? []) { send("event", e); last = Math.max(last, e.seq); }
        if (backlog && backlog.events.length === 200) send("gap", { after: last });
      }
      // 对比页：订阅一组通道的事件（带会话 ID），用来实时显示各列的回复
      const groupId = c.req.query("comparison") ?? "";
      const laneIds = (): Set<string> => new Set((mgr.store.comparison(groupId)?.lanes ?? []).map((l) => l.platformSessionId).filter((x): x is string => !!x));
      let lanes = groupId ? laneIds() : new Set<string>();
      const onEvent = (u: { platformSessionId: string; event: { seq: number } }) => {
        hint('rt',u.platformSessionId);
        if (u.platformSessionId === id) send(noticesOnly?"sync-notice":"event", noticesOnly?{seq:u.event.seq}:u.event);
        if (lanes.has(u.platformSessionId)) send("lane-event", { platformSessionId: u.platformSessionId, event: u.event });
      };
      const onComparison = (u: { groupId: string }) => { if (u.groupId === groupId) { lanes = laneIds(); send("comparison", { groupId }); } };
      const onSession = (u: { platformSessionId: string }) => {hint('rt',u.platformSessionId);send("session", { id: u.platformSessionId, current: u.platformSessionId === id });};
      const onDir = (update?: { archiveChanged?: boolean }) => send("directory", update?.archiveChanged ? { archiveChanged: true } : {});
      const onProfiles = (update: { rateLimit?: boolean } = {}) => send("profiles", update);
      const onApprovals = () => send("approvals", { pending: mgr.pendingApprovals().length });
      const onRoom = (u: { roomId: string; type: string }) => {hint('room',u.roomId);if (u.roomId === roomId) send(u.type, { roomId });};
      // 与 /api/stream 的 update 同义：只转发 kind/sessionId，不带待办正文。
      const onAppUpdate = (u: { kind: string; sessionId?: string }) => send("update", { kind: u.kind, ...(u.sessionId ? { sessionId: u.sessionId } : {}) });
      const offAppUpdates = appUpdates ? appUpdates(onAppUpdate) : undefined;
      mgr.on("room", onRoom);
      mgr.on("comparison", onComparison);
      mgr.on("event", onEvent); mgr.on("session", onSession); mgr.on("directory", onDir); mgr.on("profiles", onProfiles); mgr.on("approvals", onApprovals);
      // All addressed listeners are installed before this barrier is issued.
      send("ready", { session: id || null, after: last,...(watch.length&&ctx.sync?.enabled?{noticeCoverage:ctx.sync.journal.noticeCoverage()}:{}) });
      const keepalive = setInterval(() => send("ping", {}), 15_000);
      await lifetime.done;
      clearInterval(keepalive);
      await announceHandoff(stream, ctx.shutdown);
      mgr.off("room", onRoom);
      mgr.off("comparison", onComparison);
      mgr.off("event", onEvent); mgr.off("session", onSession); mgr.off("directory", onDir); mgr.off("profiles", onProfiles); mgr.off("approvals", onApprovals);
      offAppUpdates?.();
    });
  }));

  /* ------------------------------ 控制 ------------------------------ */

  const createSubmission = async (b: Record<string, unknown>, actor: string) => {
    const kind = kindOf(String(b["runtimeKind"] ?? ""));
    // 已有同一幂等键的操作直接回放结果；新建才核对运行时配置里勾选的模型
    if (!mgr.store.operationByKey(String(b["idempotencyKey"] ?? "").trim())) mgr.checkSelectableModel(kind, typeof b["model"] === "string" ? b["model"] : undefined);
    const input = {
      idempotencyKey: String(b["idempotencyKey"] ?? ""), runtimeKind: kindOf(String(b["runtimeKind"] ?? "")),
      workspace: String(b["workspace"] ?? ""), prompt: String(b["prompt"] ?? ""),
      attachmentIds: b["attachmentIds"] as string[] | undefined,
      ...(b["recordSourceRefs"]!==undefined?{recordSourceRefs:relationSources(b["recordSourceRefs"])}:{}),
      ...(b["scheduledFor"] !== undefined ? { scheduledFor: b["scheduledFor"] as string } : {}),
      ...(typeof b["model"] === "string" && b["model"] ? { model: b["model"] } : {}),
      ...(typeof b["effort"] === "string" && b["effort"] ? { effort: b["effort"] } : {}),
      ...(b["permissionMode"] !== undefined ? { permissionMode: String(b["permissionMode"]) as PermissionMode } : {}),
      ...(typeof b["browserProfileId"] === "string" ? { browserProfileId: b["browserProfileId"] } : {}),
      ...(typeof b["title"] === "string" ? { title: b["title"] } : {}),
      ...(typeof b["noteId"] === "string" && b["noteId"].trim() ? { noteRef: { noteId: String(b["noteId"]).trim().slice(0, 200) } } : {}),
      ...(b["worktree"] === true ? { worktree: true } : {}),
      // 评测基线：首轮技能目录里不列这些技能（只能少列，不能多给权限）
      ...(Array.isArray(b["platformSkillsExclude"]) ? { platformSkillsExclude: (b["platformSkillsExclude"] as unknown[]).filter((x): x is string => typeof x === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(x)).slice(0, 8) } : {}),
      confirmedProfileVersion: String(b["confirmedProfileVersion"] ?? "")
    };
    if(ctx.validateRecordSources){if(input.recordSourceRefs)input.recordSourceRefs=await ctx.validateRecordSources(input.recordSourceRefs);}
    // 部署排空时也先把会话建出来：首条消息放进排队，等新进程起来再发，不让“创建”等整个部署。
    const firstMessageId = createHash("sha256").update(`first:${input.idempotencyKey}`).digest("hex").slice(0, 32);
    const queueFirstMessage = (session: { platformSessionId: string }, prompt: string) => {
      const current = mgr.store.binding(session.platformSessionId);
      // 正常创建（首轮已作为 turn 提交）或重放已有首轮：不重复排队
      if (input.scheduledFor !== undefined || !current || current.turns.length || current.outbox?.some(m => m.messageId === firstMessageId)) return;
      mgr.enqueueMessage(session.platformSessionId, {
        messageId: firstMessageId, prompt,
        ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.effort ? { effort: input.effort } : {})
      }, actor, { hold: mgr.isDraining() });
    };
    const taskId = b["recommendationId"];
    if (taskId !== undefined) {
      if (!ctx.iterations || typeof taskId !== "string" || b["noteId"] !== undefined) throw new RuntimeError("推荐任务引用无效", 400, "RT_INPUT");
      const create = async (ref: import("@pi-agent/runtime-sessions").RecommendationRef, prompt: string) => {
        const additional = input.prompt.replace(prompt, "").trim();
        const finalPrompt = additional ? `${prompt}\n\n人类补充要求：\n${additional}` : prompt;
        const r = await mgr.create({ ...input, noteRef: undefined, recommendationRef: ref, prompt: finalPrompt, deferWhenDraining: true }, actor);
        queueFirstMessage(r.session, finalPrompt);
        return r;
      };
      const existing = mgr.store.operationByKey(input.idempotencyKey.trim());
      if (existing) {
        const ref = mgr.store.binding(existing.platformSessionId)?.recommendationRef;
        if (!ref || ref.taskId !== taskId || ref.revision !== b["recommendationRevision"]) throw new RuntimeError("请求键已用于其他需求", 409, "RT_CONFLICT");
        const r = await create(ref, ref.requirement); ctx.iterations.reconcile(mgr.store.allBindings()); return r;
      }
      try { return await ctx.iterations.launch(taskId, b["recommendationRevision"], input.idempotencyKey, create); }
      catch (e) { if (e instanceof RuntimeError) throw e; throw new RuntimeError((e as Error).message, 409, "RT_CONFLICT"); }
    }
    const r = await mgr.create({ ...input, deferWhenDraining: true }, actor);
    queueFirstMessage(r.session, input.prompt);
    return r;
  };
  let submissionsExecuting = 0;
  const activity = () => { const a = mgr.activity(); return { ...a, deploymentInbox: 1, dispatching: a.dispatching + submissionsExecuting }; };
  const executeSubmission = async (entry: DeploymentSubmission, deferred = false) => {
    // 创建不再等部署：createSubmission 会只建会话并把首条消息放进排队。续聊/排队消息仍等部署完成。
    if (mgr.isDraining() && entry.action !== "create") throw new RuntimeError("部署完成后自动发送", 503, "RT_DRAINING");
    if (entry.public && !mgr.settings().publicControl) throw new RuntimeError("对外控制权限已关闭", 403, "RT_FORBIDDEN");
    submissionsExecuting++;
    try {
      if (entry.action === 'create') return await createSubmission(entry.body, entry.actor);
      const b = entry.body, id = entry.sessionId!;
      if (entry.action === 'outbox' || (deferred && !mgr.store.operationByKey(String(b['idempotencyKey'] ?? '')))) {
        const messageId = entry.action === 'outbox' ? String(b['messageId'] ?? '') : createHash('sha256').update(String(b['idempotencyKey'])).digest('hex').slice(0, 32);
        return { session: mgr.enqueueMessage(id, { messageId, prompt: String(b['prompt'] ?? ''), attachmentIds: b['attachmentIds'] as string[] | undefined, ...(b['scheduledFor'] !== undefined ? { scheduledFor: b['scheduledFor'] as string } : {}), ...(typeof b['effort'] === 'string' ? { effort: b['effort'] } : {}) }, entry.actor, { admittedReservation: deferred }), queued: true };
      }
      return await mgr.sendTurn(id, { idempotencyKey: String(b['idempotencyKey'] ?? ''), prompt: String(b['prompt'] ?? ''), attachmentIds: b['attachmentIds'] as string[] | undefined, expectedRevision: Number(b['expectedRevision']), ...(typeof b['effort'] === 'string' && b['effort'] ? { effort: b['effort'] } : {}) }, entry.actor);
    } finally { submissionsExecuting--; }
  };
  let inboxReady = false;
  void mgr.recovered.then(() => { inboxReady = true; });
  const inbox = new DeploymentInbox(join(mgr.store.dir, 'deployment-inbox'), entry => executeSubmission(entry, true), () => !inboxReady || mgr.isDraining() || !!ctx.shutdown?.aborted, ctx.submissionsServing, entry => mgr.attachments.retainDrafts(entry.body['attachmentIds'], entry.actor, entry.sessionId));
  const submit = async (c: Context, action: DeploymentSubmission['action'], sessionId?: string) => {
    const entry = { action, sessionId, body: await c.req.json<Record<string, unknown>>(), actor: ctx.actor(c), public: ctx.isPublic(c) };
    // 统计应用的「发起端」：这条消息从手机还是 PC 发来，按消息的操作键记下来（部署等待箱、排队转发后仍能对上）。
    if (action === 'create' || action === 'turn' || action === 'outbox') {
      turnOriginsAt(join(mgr.store.dir, 'turn-origins.jsonl')).record(originKeys(action, entry.body), deviceOfRequest(name => c.req.header(name)));
    }
    const queued = inbox.submit(entry);
    return queued && (queued as { deploymentQueued?: boolean }).deploymentQueued ? c.json(queued as object, 202) : queued ?? executeSubmission(entry);
  };
  if (ctx.shutdown) {
    const timer = setInterval(() => { void inbox.flush().catch(e => console.error('部署等待消息恢复失败', e)); }, 1000);
    timer.unref(); ctx.shutdown.addEventListener('abort', () => clearInterval(timer), { once: true });
  }
  app.get('/api/runtime-sessions/:id/deployment-queue', guard('control'), c => run(c, () => {
    const why = canRead(c, param(c, 'id'));
    if (why) throw new RuntimeError(why, 403, 'RT_FORBIDDEN');
    c.header('Cache-Control', 'private, no-store');
    return { messages: inbox.list(param(c, 'id'), ctx.actor(c)) };
  }));
  app.get('/api/runtime-submissions/:ticket', guard('control'), c => run(c, () => {
    c.header('Cache-Control', 'private, no-store');
    return inbox.status(param(c, 'ticket'), ctx.actor(c));
  }));
  app.post("/api/runtime-sessions", guard("control"), c => run(c, () => submit(c, 'create'), 201));
  /* ------------------------------ 对比组 ------------------------------ */

  // 2026-10-07 对比并入群聊（COMPARE-MERGE 第三步）：不再新建对比组，结论与采用不再可用
  app.post("/api/runtime-comparisons", guard("control"), (c) => run(c, () => { throw new RuntimeError("对比已并入群聊：新建群聊并 @ 多个成员，每一轮都能切到对比视图；已有对比组只能查看、归档或删除", 410, "RT_GONE"); }));
  app.get("/api/runtime-comparisons/workspace-info", guard("control"), (c) => run(c, () => {
    const kinds = (c.req.query("runtimes") ?? "").split(",").filter(Boolean).map(kindOf);
    return mgr.comparisonWorkspaceInfo(c.req.query("cwd") ?? "", kinds.length ? kinds : ["codex"]);
  }));
  app.get("/api/runtime-comparisons/:id", (c) => {
    const why = allowed(c, "history");
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    return run(c, () => mgr.comparisonView(param(c, "id")));
  });
  app.post("/api/runtime-comparisons/:id/verdict", guard("control"), (c) => run(c, () => { throw new RuntimeError("对比已并入群聊：新建群聊并 @ 多个成员，每一轮都能切到对比视图；已有对比组只能查看、归档或删除", 410, "RT_GONE"); }));
  app.post("/api/runtime-comparisons/:id/archive", guard("control"), (c) => run(c, async () => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    return mgr.archiveComparison(param(c, "id"), b["archived"] !== false, ctx.actor(c));
  }));
  app.delete("/api/runtime-comparisons/:id", guard("control"), (c) => run(c, async () => { await mgr.deleteComparison(param(c, "id"), ctx.actor(c)); return { ok: true, note: "已删除对比组、各通道的平台数据与 worktree；原生 transcript 未改动" }; }));
  /** L3：通道相对 base 的代码改动（worktree 隔离才有） */
  app.get("/api/runtime-comparisons/:id/lanes/:laneNo/diff", (c) => {
    const why = allowed(c, "history");
    if (why) return c.json({ error: why, code: "RT_FORBIDDEN" }, 403);
    return run(c, () => mgr.comparisonLaneDiff(param(c, "id"), Number(param(c, "laneNo"))));
  });
  /** 采用一条通道：必须带上查看时的 patchHash（二次确认） */
  app.post("/api/runtime-comparisons/:id/lanes/:laneNo/adopt", guard("control"), (c) => run(c, () => { throw new RuntimeError("对比已并入群聊：新建群聊并 @ 多个成员，每一轮都能切到对比视图；已有对比组只能查看、归档或删除", 410, "RT_GONE"); }));
  app.post("/api/runtime-sessions/:id/permission-mode", guard("control"), c => run(c, async () => {
    const b = await c.req.json<Record<string, unknown>>();
    return { session: mgr.updatePermissionMode(param(c, "id"), String(b["permissionMode"] ?? ""), b["expectedRevision"] as number, ctx.actor(c)) };
  }));
  app.post("/api/runtime-sessions/:id/stall-guard", guard("control"), (c) => run(c, async () => {
    const b = await c.req.json<Record<string, unknown>>();
    return { session: mgr.setStallGuardAutoAbort(param(c, "id"), b["autoAbort"] === true, ctx.actor(c)) };
  }));
  app.post("/api/runtime-sessions/:id/turns", guard("control"), c => run(c, () => submit(c, 'turn', param(c, 'id')), 201));
  /* 排队消息：本轮运行中先排队，正常结束后按顺序逐条发出；发出前可调整顺序、修改、撤销 */
  app.post("/api/runtime-sessions/:id/outbox", guard("control"), c => run(c, () => submit(c, 'outbox', param(c, 'id')), 201));
  app.post("/api/runtime-sessions/:id/outbox-order", guard("control"), (c) => run(c, async () => {
    const b = await c.req.json<Record<string, unknown>>();
    return { session: mgr.reorderQueuedMessages(param(c, "id"), b["order"], ctx.actor(c)) };
  }));
  app.post("/api/runtime-sessions/:id/outbox-resume", guard("control"), (c) => run(c, async () => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    return { session: mgr.resumeOutbox(param(c, "id"), ctx.actor(c), { onlyEditHold: b["onlyEditHold"] === true }) };
  }));
  /* 额度用尽后的自动续聊：到点前随时取消 */
  app.post("/api/runtime-sessions/:id/quota-resume-cancel", guard("control"), (c) => run(c, () => ({ session: mgr.cancelQuotaResume(param(c, "id"), ctx.actor(c)) })));
  app.post("/api/runtime-sessions/:id/outbox-hold", guard("control"), (c) => run(c, () => ({ session: mgr.holdOutboxForEdit(param(c, "id"), ctx.actor(c)) })));
  /* 插话（Pi / Codex / Claude Code）：把排队消息送进正在运行的这一轮；送达后才离开队列 */
  app.post("/api/runtime-sessions/:id/outbox/:messageId/steer", guard("control"), (c) => run(c, async () => ({ session: await mgr.steerQueuedMessage(param(c, "id"), param(c, "messageId"), ctx.actor(c)) })));
  app.post("/api/runtime-sessions/:id/outbox/:messageId", guard("control"), (c) => run(c, async () => {
    const b = await c.req.json<Record<string, unknown>>();
    return { session: mgr.editQueuedMessage(param(c, "id"), param(c, "messageId"), { prompt: String(b["prompt"] ?? ""), attachmentIds: b["attachmentIds"] as string[] | undefined, ...(b["scheduledFor"] !== undefined ? { scheduledFor: b["scheduledFor"] as string } : {}) }, ctx.actor(c)) };
  }));
  app.delete("/api/runtime-sessions/:id/outbox/:messageId", guard("control"), (c) => run(c, () => ({ session: mgr.removeQueuedMessage(param(c, "id"), param(c, "messageId"), ctx.actor(c)) })));
  /**
   * 快捷回复：最后一条助手回复里推荐的选择（deepseek-flash 提取）。一轮结束时服务端已经算好最终结果并存到会话记录上
   * （随会话详情 / 实时同步到达手机）；这个接口只在还没有存下来的结果时才现算，之后同一条消息直接返回存下来的。
   * POST 以经过同源校验，避免被跨站触发计费。
   */
  mgr.setQuickReplyFinalizer(async (id, result) => {
    const canFallback = result.state === "ready" || (result.state === "unavailable" && !!result.eventKey);
    if (!canFallback) return { result, cacheable: false };
    // 模型给了选项时也可能要补「部署」胶囊；只有确实要补才读部署状态（要跑 git）
    const wantDeploy = needsDeployInfo(result);
    if (!wantDeploy && result.replies.length) return { result, cacheable: true };
    const s = (await mgr.view(id)).session;
    if (s.sourceMode !== "platform-managed") return { result, cacheable: true };
    const turnStatus = s.turns.at(-1)?.status;
    // 一轮正常完成后，能从页面部署的会话先补平台「部署」：模型没提部署、或只给了别的建议时插到第一位；
    // 提取不到下一步时它就是唯一一条。都为空就补「继续 / 重试本轮」（都不经过模型）
    let deploy: DeployInfo | undefined;
    let cacheable = true;
    if (ctx.deployQueue && wantDeploy && turnStatus === "completed") {
      try {
        deploy = await ctx.deployQueue.info(s, mgr.activity());
        // 现在不能部署（主工作区被占用等）是暂时状态：不存下来，之后能部署了再重新算
        if (!deploy.eligible) cacheable = false;
      } catch { cacheable = false; /* 读不到部署状态就只走通用兜底，也不存 */ }
    }
    return { result: withReplyFallback(result, { completed: turnStatus === "completed", ...(turnStatus ? { turnStatus } : {}), deploy }), cacheable };
  });
  app.post("/api/runtime-sessions/:id/quick-replies", guard("control"), (c) => run(c, () => mgr.finalQuickReplies(param(c, "id"))));
  app.post("/api/runtime-sessions/:id/interrupt", guard("control"), (c) => run(c, () => mgr.interrupt(param(c, "id"), ctx.actor(c))));
  app.post("/api/runtime-sessions/:id/approvals/:approvalId", guard("control"), (c) => run(c, async () => {
    const b = await c.req.json<Record<string, unknown>>();
    if (typeof b["approve"] !== "boolean") throw new RuntimeError("approve 必须是布尔值", 400, "RT_INPUT");
    return mgr.decideApproval(param(c, "id"), param(c, "approvalId"), { approve: b["approve"], paramsDigest: String(b["paramsDigest"] ?? ""), turnNo: Number(b["turnNo"]), ...(b["scope"] === "session" ? { scope: "session" as const } : {}), ...(b["answers"] !== undefined ? { answers: b["answers"] } : {}) }, ctx.actor(c));
  }));
  app.get('/api/runtime-sessions/:id/permission-grants',guard('history'),c=>run(c,()=>mgr.permissionGrants(param(c,'id'))));
  app.post('/api/runtime-sessions/:id/permission-grants/revoke',guard('control'),c=>run(c,async()=>{
    const b=await c.req.json<Record<string,unknown>>();
    if(b.id!==undefined&&typeof b.id!=='string')throw new RuntimeError('授权 ID 无效',400,'RT_INPUT');
    if(Object.keys(b).some(k=>k!=='id'))throw new RuntimeError('只接受 runtime 授权 ID',400,'RT_INPUT');
    return mgr.revokeRuntimeGrant(param(c,'id'),ctx.actor(c),b.id as string|undefined);
  }));
  app.post("/api/runtime-sessions/:id/approval-grant/revoke", guard("control"), (c) => run(c, async () => ({ session: await mgr.revokeAllApprovalGrants(param(c, "id"), ctx.actor(c)) })));
  app.post("/api/runtime-sessions/:id/resume-writes", guard("control"), (c) => run(c, async () => {
    const b = await c.req.json<Record<string, unknown>>();
    return mgr.resumeWrites(param(c, "id"), Number(b["expectedRevision"]), ctx.actor(c));
  }));
  app.post("/api/runtime-sessions/:id/backfill", guard("control"), (c) => run(c, () => mgr.backfill(param(c, "id"))));
  app.post("/api/runtime-sessions/:id/archive", guard("control"), (c) => run(c, async () => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    // 归档会删掉会话分支；排队中的部署提交还只在那个分支上（部署成功后才进 main），删了就部署不了
    const q = b["archived"] !== false ? ctx.deployQueue?.branchDeployOf(param(c, "id")) : undefined;
    if (q) throw new RuntimeError(`这个会话的提交 ${q.sha.slice(0, 7)} ${q.startedAt ? "正在部署" : "还在排队等部署"}，它还没进 main，归档会删掉它所在的会话分支。等部署结束（结果会发回这个会话）再归档${q.startedAt ? "" : "，或先取消部署"}`, 409, "RT_DEPLOY_PENDING");
    return mgr.archive(param(c, "id"), b["archived"] !== false, ctx.actor(c));
  }));
  app.delete("/api/runtime-sessions/:id", guard("control"), (c) => run(c, () => { mgr.deletePlatformData(param(c, "id"), ctx.actor(c)); return { ok: true, note: "只删除了平台数据，原生 transcript 未改动" }; }));

  /* ------------------------------ 空闲时部署（会话页按钮） ------------------------------ */

  // 与续聊同一权限：能控制会话的人本来就能让会话自己执行 deploy-gui.sh --when-idle
  const autoResolver = ctx.deployQueue ? createDeployAutoResolver(mgr, ctx.deployQueue) : undefined;
  // 守候进程只改请求文件（开始部署、部署结束、冲突自动解决）：轮询指纹，变了就推「目录已变」，
  // 列表的「待部署 / 部署中」、会话头部和关联部署的快捷回复据此一起更新，不会各说各的
  let deploySig = ctx.deployQueue?.signature() ?? "";
  const deployWatch = ctx.deployQueue ? setInterval(() => {
    let sig: string;
    try { sig = ctx.deployQueue!.signature(); } catch { return; }
    if (sig !== deploySig) { deploySig = sig; mgr.emit("directory", {}); }
  }, 2_000) : undefined;
  deployWatch?.unref?.();
  ctx.shutdown?.addEventListener("abort", () => { autoResolver?.stop(); clearInterval(deployWatch); }, { once: true });
  const deployTarget = async (c: Context) => {
    if (!ctx.deployQueue) throw new RuntimeError("这个服务没有开启从页面部署", 404, "RT_NOT_FOUND");
    const s = (await mgr.view(param(c, "id"))).session;
    if (s.sourceMode !== "platform-managed") throw new RuntimeError("只读历史会话不能请求部署", 400, "RT_INPUT");
    return { q: ctx.deployQueue, s };
  };
  app.get("/api/runtime-sessions/:id/deploy", guard("control"), (c) => run(c, async () => {
    const { q, s } = await deployTarget(c);
    const activity = mgr.activity();
    const last = q.lastDeploy(s.platformSessionId);
    return { ...(await q.info(s, activity)), ...(last ? { last } : {}), activity };
  }));
  app.post("/api/runtime-sessions/:id/deploy", guard("control"), (c) => run(c, async () => {
    const { q, s } = await deployTarget(c);
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    // 只有界面自动触发的那一次才占用配额；手动点击重新部署不带这个标记，不受上限影响。
    // 自动重新部署带着失败通知里的提交：会话分支没有新提交 / 新改动时不对同一提交重试（手动点击不受影响）。
    if (b["autoRedeploy"] === true && typeof b["failedSha"] === "string" && /^[0-9a-f]{7,40}$/i.test(b["failedSha"])) {
      const cur = await q.info(s, mgr.activity());
      const head = cur.mode === "worktree" ? (cur.worktree && !cur.worktree.changes.length ? cur.worktree.head : undefined) : cur.main?.sha;
      if (head && head.startsWith(b["failedSha"].toLowerCase())) throw new RuntimeError("上次部署失败的提交没有变化，不自动重新部署；修改后再部署，或手动点击「重新部署」", 409, "RT_AUTO_REDEPLOY_SAME");
    }
    const claim = b["autoRedeploy"] === true ? mgr.claimAutoRedeploy(s.platformSessionId) : undefined;
    if (claim && !claim.allowed) throw new RuntimeError(`本会话自动重新部署已达 ${claim.limit} 次上限，可手动点击「重新部署」`, 409, "RT_AUTO_REDEPLOY_LIMIT");
    let result;
    try { result = await q.request({ session: s, expectedSha: String(b["expectedSha"] ?? ""), ...(typeof b["message"] === "string" ? { message: b["message"] } : {}) }); }
    catch (e) {
      // 部署没有登记成功：退回刚占用的自动部署配额。
      if (claim) mgr.releaseAutoRedeploy(s.platformSessionId);
      // 和 main 冲突：先让会话自己合并解决，结束后自动重新登记部署；自动处理不了才交给人（返回 needs-human 与原因）
      if (!(e instanceof DeployConflictError) || !autoResolver) throw e;
      const autoResolve = await autoResolver.begin(s, e, { manual: true });
      return { conflict: { message: e.message, conflicts: e.conflicts, ...(e.committed ? { committed: e.committed } : {}) }, ...(await q.info(s, mgr.activity())), autoResolve, activity: mgr.activity() };
    }
    mgr.noteDeployRequest(s.platformSessionId, ctx.actor(c), result, !!claim);
    return { ...result, ...(claim ? { autoRedeploy: claim } : {}), ...(await q.info(s, mgr.activity())), activity: mgr.activity() };
  }, 201));
  app.post("/api/runtime-sessions/:id/deploy-rollback", guard("control"), (c) => run(c, async () => {
    const { q, s } = await deployTarget(c);
    const b = await c.req.json<Record<string, unknown>>();
    const result = await q.rollback({ session: s, expectedLive: String(b["expectedLive"] || ""), expectedSha: String(b["expectedSha"] || "") });
    return { ...result, ...(await q.info(s, mgr.activity())), activity: mgr.activity() };
  }, 201));
  app.delete("/api/runtime-sessions/:id/deploy/:requestId", guard("control"), (c) => run(c, async () => {
    const { q, s } = await deployTarget(c);
    const info = await q.info(s);
    if (!info.requests.some(r => r.id === param(c, "requestId") && r.notifySession === s.platformSessionId)) throw new RuntimeError("没有这个会话的部署请求", 404, "RT_NOT_FOUND");
    return { cancelled: q.cancel(param(c, "requestId")), ...(await q.info(s, mgr.activity())), activity: mgr.activity() };
  }));

  /* ------------------------------ 平台设置：部署历史 ------------------------------ */

  // 只读守候进程追加的 history.log；会话标题从平台自己的会话绑定里补，点击可回到对应会话。
  app.get("/api/platform/deployments", guard("history"), (c) => run(c, async () => {
    const params = new URL(c.req.url).searchParams;
    const limit = Math.max(1, Math.min(500, Number(params.get("limit")) || 200));
    const offset = Math.max(0, Math.min(100000, Math.floor(Number(params.get("offset")) || 0)));
    let timeZone = params.get("tz") || undefined;
    if (timeZone) {
      try { timeZone = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone; }
      catch { timeZone = "UTC"; }
    }
    const bindings = new Map(mgr.store.allBindings().map((b) => [b.platformSessionId, b]));
    const history = readDeployHistory(undefined, {
      limit,
      offset,
      timeZone,
      runtimeFor: (sessionId) => (sessionId ? bindings.get(sessionId)?.runtimeKind : undefined),
    });
    const sessionOf = (id: string | null) => {
      const b = id ? bindings.get(id) : undefined;
      if (!id || !b) return null;
      return {
        id,
        title: b.title || "未命名会话",
        runtimeKind: b.runtimeKind,
        status: b.status,
        archived: !!b.archived,
        href: `#/rt/${encodeURIComponent(id)}`,
      };
    };
    return {
      ...history,
      progress: deploymentProgress({ id: params.get("requestId") || "", startedAt: params.get("startedAt") || undefined }, undefined, mgr.activity()),
      entries: history.entries.map((entry) => ({ ...entry, session: sessionOf(entry.sessionId) })),
      active: history.active.map((entry) => ({ ...entry, session: sessionOf(entry.sessionId) })),
    };
  }));

  // 已结束部署的流程步骤存档（部署结果通知里的「部署详情」用）；旧部署没有存档，run 为 null
  app.get("/api/platform/deployments/runs/:sha", guard("history"), (c) => run(c, async () => ({ run: readDeploymentRun(c.req.param("sha") ?? "") ?? null })));

  /* ------------------------------ 部署排空（仅本机） ------------------------------ */

  app.get("/api/runtime/activity", guard("local"), (c) => c.json(activity()));
  app.post("/api/runtime/drain", guard("local"), (c) => run(c, async () => {
    const b = await c.req.json<{ release?: boolean; force?: boolean; reason?: string; finishQueued?: boolean }>().catch(() => ({} as { release?: boolean; force?: boolean; reason?: string; finishQueued?: boolean }));
    if (b.release) { mgr.setDraining(false); return { ...activity(), released: true }; }
    mgr.setDraining(true, b.finishQueued === true);
    if (b.force) return { ...(await mgr.forceStop(b.reason || "强制部署：服务重启中断", "deploy")), ...mgr.activity() };
    return activity();
  }));
}
