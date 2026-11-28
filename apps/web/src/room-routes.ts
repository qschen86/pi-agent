import { checkPreviewFiles, serveFilePreview, temporaryFileReferences } from './file-preview.js';
import type { Context, Hono } from "hono";
import { RuntimeError } from "@pi-agent/runtime-sessions";
import type { RoomService } from "./room-service.js";
import type { RoomCreateInput, RoomMemberInput, RoomPostInput, RoomSettings } from "./room-types.js";
import {syncWindow,type SessionSyncJournal} from './session-sync.js';
import {sessionRestore} from './session-restore.js';
import type {RoomSyncSources} from './room-sync-source.js';

export function mountRoomRoutes(app: Hono, rooms: RoomService, ctx: { isPublic: (c: Context) => boolean; actor: (c: Context) => string; authPartition?: (c: Context) => string | null;stillAuthenticated?: (c:Context)=>boolean;sync?:{enabled:boolean;journal:SessionSyncJournal;sources:RoomSyncSources} }): void {
  const guard = (write: boolean) => async (c: Context, next: () => Promise<void>) => {
    const settings = rooms.mgr.settings();
    if (ctx.isPublic(c) && !(write ? settings.publicControl : settings.publicHistory || settings.publicControl)) return c.json({ error: write ? "对外入口未开启 runtime 控制" : "对外入口未开启 runtime 查看", code: "RT_FORBIDDEN" }, 403);
    await next();
  };
  const run = async (c: Context, fn: () => unknown | Promise<unknown>, status: 200 | 201 = 200) => {
    try { await rooms.ready; return c.json(await fn() as object, status); }
    catch (e) {
      if (e instanceof RuntimeError) return c.json({ error: e.message, code: e.code }, e.status);
      if ((e as {code?:string}).code === 'SYNC_CURSOR') return c.json({error:(e as Error).message,code:'SYNC_CURSOR'},400);
      if (e instanceof SyntaxError || e instanceof TypeError) return c.json({ error: "请求格式无效", code: "ROOM_INPUT" }, 400);
      console.error("群聊接口失败", e); return c.json({ error: "群聊存储或服务失败", code: "INTERNAL" }, 500);
    }
  };
  app.get("/api/rooms", guard(false), (c) => run(c, () => ({ rooms: rooms.list() })));
  app.post("/api/rooms", guard(true), (c) => run(c, async () => rooms.create(await c.req.json<RoomCreateInput>(), ctx.actor(c)), 201));
  const readCheck = (c:Context) => {
    if(ctx.stillAuthenticated && !ctx.stillAuthenticated(c))throw new RuntimeError('请重新登录',401,'SYNC_AUTH');
    const settings=rooms.mgr.settings();if(ctx.isPublic(c)&&!settings.publicHistory&&!settings.publicControl)throw new RuntimeError('查看权限已变化',403,'RT_FORBIDDEN');
  };
  app.get('/api/rooms/:id/restore',guard(false),(c)=>run(c,async()=>{
    c.header('Cache-Control','private, no-store');readCheck(c);
    const id=c.req.param('id')??'';rooms.view(id,{limit:1});
    if(c.req.query('targetCursor')!==undefined)throw new RuntimeError('首次恢复不接受追页终点，请使用同步接口',400,'RESTORE_INPUT');
    const result=await sessionRestore({
      resource:{kind:'room',id},partition:ctx.authPartition?.(c)??null,
      candidatePartition:c.req.query('candidatePartition'),cursor:c.req.query('cursor'),window:syncWindow(c.req.query(),'room'),
      ...(ctx.sync?{sync:{enabled:ctx.sync.enabled,journal:ctx.sync.journal,source:ctx.sync.sources.source(id)}}:{})
    });
    readCheck(c);rooms.view(id,{limit:1});return result;
  }));
  app.get('/api/rooms/:id/sync',guard(false),(c)=>run(c,async()=>{
    c.header('Cache-Control','private, no-store');
    const id=c.req.param('id')??'';rooms.view(id,{limit:1});readCheck(c);
    if(!ctx.sync?.enabled)throw new RuntimeError('增量同步已关闭',503,'SYNC_DISABLED');
    const result=await ctx.sync.journal.sync({kind:'room',id},ctx.sync.sources.source(id),syncWindow(c.req.query(),'room'),c.req.query('cursor'),c.req.query('targetCursor'),c.req.query('resume')==='1');
    readCheck(c);rooms.view(id,{limit:1});return result;
  }));
  for (const endpoint of ['cache-access', 'bootstrap']) app.get(`/api/rooms/:id/${endpoint}`, guard(false), (c) => run(c, () => {
    readCheck(c);
    c.header('Cache-Control', 'private, no-store');
    const id = c.req.param('id') ?? ''; rooms.view(id, { limit: 1 });
    return { schema: 1, resource: { kind: 'room', id }, partition: ctx.authPartition?.(c) ?? null,
      ...(endpoint === 'bootstrap' ? { display: { allowed: true }, control: { requiresLatestState: true }, incremental: { supported: !!ctx.sync?.enabled, protocolVersion: 1 } } : {}) };
  }));
  app.get("/api/rooms/:id", guard(false), (c) => run(c, () => rooms.view((c.req.param("id") ?? ""), { ...(c.req.query("before") ? { before: Number(c.req.query("before")) } : {}), ...(c.req.query("limit") ? { limit: Number(c.req.query("limit")) } : {}) })));
  /** 讨论室文件引用的授权范围：指定成员就按该成员的工作目录和引用，否则按讨论室工作目录 + 全体成员的根 */
  const previewScope = async (c: Context) => {
    await rooms.ready;
    const view = rooms.view(c.req.param("id") ?? ""), memberId = c.req.query("memberId");
    const member = memberId ? view.members.find(m => m.memberId === memberId) : undefined;
    if (memberId && !member) throw new RuntimeError("成员不属于本讨论室",404,"RT_NOT_FOUND");
    const session = member ? (await rooms.mgr.view(member.platformSessionId)).session : undefined;
    if (session && session.hostId !== rooms.mgr.store.host.hostId) throw new RuntimeError("文件所在运行主机不可用",409,"FILE_HOST_UNAVAILABLE");
    const roots = session ? rooms.mgr.workspaceRoots(session.runtimeKind) : view.members.flatMap(m => rooms.mgr.workspaceRoots(m.binding.runtimeKind));
    const references = member ? temporaryFileReferences(rooms.mgr.store.events(member.platformSessionId)) : [];
    return {workspace:session?.workspace ?? view.room.workspace,roots,referencedFiles:references};
  };
  for (const endpoint of ["file-preview", "file-content"]) app.get(`/api/rooms/:id/${endpoint}`, guard(false), async c => {
    try {return serveFilePreview(c, await previewScope(c), endpoint === "file-content");}
    catch(e) {if(e instanceof RuntimeError)return c.json({error:e.message,code:e.code},e.status);return c.json({error:"讨论室不可用"},404);}
  });
  app.get("/api/rooms/:id/file-check", guard(false), async c => {
    c.header("Cache-Control", "private, no-store");
    try {return c.json(await checkPreviewFiles(await previewScope(c), c.req.queries("ref") ?? []));}
    catch(e) {if(e instanceof RuntimeError)return c.json({error:e.message,code:e.code},e.status);return c.json({error:"讨论室不可用"},404);}
  });
  app.post("/api/rooms/:id/messages", guard(true), (c) => run(c, async () => rooms.post((c.req.param("id") ?? ""), await c.req.json<RoomPostInput>(), ctx.actor(c)), 201));
  app.post("/api/rooms/:id/messages/:seq/deliveries/:memberId/retry", guard(true), (c) => run(c, () => rooms.retry((c.req.param("id") ?? ""), Number(c.req.param("seq")), (c.req.param("memberId") ?? ""), ctx.actor(c))));
  app.get("/api/rooms/:id/rounds/:seq", guard(false), (c) => run(c, () => rooms.round((c.req.param("id") ?? ""), Number(c.req.param("seq")))));
  app.post("/api/rooms/:id/rounds/:seq/verdict", guard(true), (c) => run(c, async () => {
    const b = await c.req.json<{ memberId: string | null; note?: string }>();
    if (!b || !(b.memberId === null || typeof b.memberId === "string")) throw new RuntimeError("memberId 必须是成员 ID 或 null（都不满意）", 400, "ROOM_INPUT");
    return rooms.setRoundVerdict((c.req.param("id") ?? ""), Number(c.req.param("seq")), b, ctx.actor(c));
  }));
  app.get("/api/rooms/:id/members/:memberId/diff", guard(false), (c) => run(c, () => rooms.memberDiff((c.req.param("id") ?? ""), (c.req.param("memberId") ?? ""))));
  app.post("/api/rooms/:id/members/:memberId/adopt", guard(true), (c) => run(c, async () => {
    const b = await c.req.json<{ patchHash?: string }>();
    return rooms.adoptMember((c.req.param("id") ?? ""), (c.req.param("memberId") ?? ""), String(b?.patchHash ?? ""), ctx.actor(c));
  }));
  app.post("/api/rooms/:id/members", guard(true), (c) => run(c, async () => rooms.addMember((c.req.param("id") ?? ""), await c.req.json<RoomMemberInput>(), ctx.actor(c)), 201));
  app.delete("/api/rooms/:id/members/:memberId", guard(true), (c) => run(c, () => rooms.removeMember((c.req.param("id") ?? ""), (c.req.param("memberId") ?? ""), ctx.actor(c))));
  app.patch("/api/rooms/:id/title", guard(true), (c) => run(c, async () => rooms.rename((c.req.param("id") ?? ""), (await c.req.json<{ title?: unknown }>()).title, ctx.actor(c))));
  app.patch("/api/rooms/:id/settings", guard(true), (c) => run(c, async () => rooms.updateSettings((c.req.param("id") ?? ""), await c.req.json<Partial<RoomSettings>>(), ctx.actor(c))));
  app.post("/api/rooms/:id/archive", guard(true), (c) => run(c, async () => { const b = await c.req.json<{ archived: boolean }>(); if (typeof b.archived !== "boolean") throw new RuntimeError("archived 必须是布尔值", 400, "ROOM_INPUT"); return rooms.archive((c.req.param("id") ?? ""), b.archived, ctx.actor(c)); }));
  app.delete("/api/rooms/:id", guard(true), (c) => run(c, () => rooms.delete((c.req.param("id") ?? ""), ctx.actor(c))));
}
