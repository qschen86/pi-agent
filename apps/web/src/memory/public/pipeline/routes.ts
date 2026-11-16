import type { Context, Hono } from 'hono';
import { compress } from 'hono/compress';
import { PipelineError, type PipelineService } from './service.js';

/**
 * 公共记忆 v2 流水线的接口。和旧公共记忆同一口径：已登录本机，或公网需「控制」权限。
 * GET  /api/memory/public/pipeline        状态 + 公共层主题（material=1 时含素材层）+ 归属待判定。证据带平台会话 id 与用户原话。
 * POST /api/memory/public/pipeline/run    手动触发一次增量运行（后台执行，立即返回 202；已在运行则 202 + running）。
 * GET  /api/memory/public/pipeline/status     只读运行状态（上次运行、每日定时、下次运行），设置页用，不带主题数据。
 * GET  /api/memory/public/pipeline/feed-unread   「动态」里未读的变动数（任何类型，不含你自己的裁决）{count, since, latestAt}；已读记录在服务端，多端共用。
 * POST /api/memory/public/pipeline/feed-seen {upTo?}   标「动态」已读到 upTo（缺省现在；只往后推）。
 * GET  /api/memory/public/pipeline/changes?limit=&before=&kind=&source=&from=&to=&since=&excludeSource=   变更日志（新的在前，before=上一页最后一条的 id）；runs = 每次定时/手动运行的汇总。
 * POST /api/memory/public/pipeline/remember {sessionId,key}   用户在消息上点「加入记忆」：记下这条并立刻提炼该会话 → {added,queued,error}；本轮结束的自动提炼随之跳过。
 * GET  /api/memory/public/pipeline/remember?sessionId=   这个会话里已手动加入的消息 key → {keys}。
 * POST /api/memory/public/pipeline/topics/:id/resolve {choice:'adopt'|'keep'}   裁决一条待确认的冲突。
 * POST /api/memory/public/pipeline/topics/:id/scope {domain,project,sub,module,note}   人改一条已生效条目的归类（写 override.scope；项目记忆还能换模块）。
 * POST /api/memory/public/pipeline/topics/:id/constraint/draft   开始给这条记忆写校验规则（DeepSeek 开推理，后台跑）；GET 同路径查进度 / 取草稿。
 * POST /api/memory/public/pipeline/topics/:id/constraint {level:'hard'|'soft'|'needs-rule', rule?, note?}   人改一条记忆的约束类型（强 / 软约束 / 待补规则；强约束必须带确认过的校验规则四要素）。
 * DELETE /api/memory/public/pipeline/topics/:id {note}   人删一条记忆（主题移除、成员观察退役，记 removed 变更）。
 * POST /api/memory/public/pipeline/scopes/:id/resolve {domain,project,sub,note}  人判定一条归属不确定的观察。
 */
export function mountPipelineRoutes(app: Hono, service: PipelineService, ctx: { allowed: (c: Context) => boolean }): void {
  app.use('/api/memory/public/pipeline', compress());
  const guard = (c: Context): Response | undefined => {
    c.header('Cache-Control', 'private, no-store');
    return ctx.allowed(c) ? undefined : c.json({ error: '控制权限未开启', code: 'RT_FORBIDDEN' }, 403);
  };
  app.get('/api/memory/public/pipeline', c => {
    const denied = guard(c); if (denied) return denied;
    try { return c.json({ status: service.status(), topics: service.topics({ material: c.req.query('material') === '1' }), scopes: service.pendingScopes(), feedUnread: service.feedUnread() }); }
    catch (e) { return c.json({ error: (e as Error).message, code: 'storage-error' }, 503); }
  });
  app.get('/api/memory/public/pipeline/status', c => {
    const denied = guard(c); if (denied) return denied;
    try { return c.json({ status: service.status() }); }
    catch (e) { return c.json({ error: (e as Error).message, code: 'storage-error' }, 503); }
  });
  app.get('/api/memory/public/pipeline/review', c => {
    const denied = guard(c); if (denied) return denied;
    return c.json({ review: service.manualReview(), running: service.isRunning() });
  });
  app.post('/api/memory/public/pipeline/review', async c => {
    const denied = guard(c); if (denied) return denied;
    try { return c.json({ review: service.startManualReview(await c.req.json()) }, 202); }
    catch (e) {
      if (e instanceof PipelineError) return c.json({ error: e.message, code: e.code }, e.code === 'busy' ? 409 : 400);
      return c.json({ error: '无法启动整理，请检查输入或存储状态', code: 'review-error' }, 503);
    }
  });
  app.post('/api/memory/public/pipeline/review/apply', async c => {
    const denied = guard(c); if (denied) return denied;
    const body = await c.req.json().catch(() => ({}));
    try { return c.json({ review: service.applyManualReview(body?.id, body?.unitIds) }); }
    catch (e) {
      if (e instanceof PipelineError) return c.json({ error: e.message, code: e.code }, e.code === 'not-found' ? 404 : e.code === 'busy' ? 409 : 400);
      return c.json({ error: (e as Error).message, code: 'storage-error' }, 503);
    }
  });
  app.get('/api/memory/public/pipeline/feed-unread', c => {
    const denied = guard(c); if (denied) return denied;
    try { return c.json(service.feedUnread()); }
    catch (e) { return c.json({ error: (e as Error).message, code: 'storage-error' }, 503); }
  });
  app.post('/api/memory/public/pipeline/feed-seen', async c => {
    const denied = guard(c); if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { upTo?: unknown };
    try { return c.json(service.markFeedSeen(body.upTo)); }
    catch (e) { if (e instanceof PipelineError) return c.json({ error: e.message, code: e.code }, 400); return c.json({ error: (e as Error).message, code: 'storage-error' }, 503); }
  });
  app.get('/api/memory/public/pipeline/changes', c => {
    const denied = guard(c); if (denied) return denied;
    try {
      const limit = Number(c.req.query('limit') ?? '');
      return c.json(service.changes({ kind: c.req.query('kind'), source: c.req.query('source'), from: c.req.query('from'), to: c.req.query('to'), ...(c.req.query('since') ? { since: c.req.query('since') } : {}), ...(c.req.query('excludeSource') ? { excludeSource: c.req.query('excludeSource') } : {}), ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}), ...(c.req.query('before') ? { before: c.req.query('before')! } : {}) }));
    } catch (e) { if (e instanceof PipelineError) return c.json({ error: e.message, code: e.code }, 400); return c.json({ error: (e as Error).message, code: 'storage-error' }, 503); }
  });
  app.get('/api/memory/public/pipeline/remember', c => {
    const denied = guard(c); if (denied) return denied;
    return c.json({ keys: service.manualKeys(c.req.query('sessionId') ?? '') });
  });
  app.post('/api/memory/public/pipeline/remember', async c => {
    const denied = guard(c); if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { sessionId?: unknown; key?: unknown };
    try { return c.json(await service.rememberMessage(body.sessionId, body.key)); }
    catch (e) {
      if (e instanceof PipelineError) return c.json({ error: e.message, code: e.code }, e.code === 'not-found' ? 404 : e.code === 'busy' ? 409 : 400);
      return c.json({ error: (e as Error).message, code: 'storage-error' }, 503);
    }
  });
  app.post('/api/memory/public/pipeline/topics/:id/resolve', async c => {
    const denied = guard(c); if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { choice?: unknown };
    try { return c.json({ change: service.resolveConflict(c.req.param('id'), body.choice as 'adopt' | 'keep') }); }
    catch (e) {
      if (e instanceof PipelineError) return c.json({ error: e.message, code: e.code }, e.code === 'not-found' ? 404 : e.code === 'busy' ? 409 : 400);
      return c.json({ error: (e as Error).message, code: 'storage-error' }, 503);
    }
  });
  app.post('/api/memory/public/pipeline/scopes/:id/resolve', async c => {
    const denied = guard(c); if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { domain?: unknown; project?: unknown; sub?: unknown; module?: unknown; note?: unknown };
    try {
      return c.json(service.resolveScope(c.req.param('id'), { domain: body.domain, project: body.project, sub: body.sub, module: body.module, note: body.note }));
    } catch (e) {
      if (e instanceof PipelineError) return c.json({ error: e.message, code: e.code }, e.code === 'not-found' ? 404 : e.code === 'busy' ? 409 : 400);
      return c.json({ error: (e as Error).message, code: 'storage-error' }, 503);
    }
  });
  app.post('/api/memory/public/pipeline/topics/:id/scope', async c => {
    const denied = guard(c); if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { domain?: unknown; project?: unknown; sub?: unknown; module?: unknown; tier?: unknown; note?: unknown };
    try {
      const r = service.rescopeTopic(c.req.param('id'), { domain: body.domain, project: body.project, sub: body.sub, module: body.module, tier: body.tier, note: body.note });
      return c.json({ change: r.change, topicId: r.topicId, merged: r.merged });
    } catch (e) {
      if (e instanceof PipelineError) return c.json({ error: e.message, code: e.code }, e.code === 'not-found' ? 404 : e.code === 'busy' ? 409 : 400);
      return c.json({ error: (e as Error).message, code: 'storage-error' }, 503);
    }
  });
  const fail = (c: Context, e: unknown): Response => {
    if (e instanceof PipelineError) return c.json({ error: e.message, code: e.code }, e.code === 'not-found' ? 404 : e.code === 'busy' ? 409 : 400);
    return c.json({ error: (e as Error).message, code: 'storage-error' }, 503);
  };
  app.post('/api/memory/public/pipeline/topics/:id/constraint/draft', c => {
    const denied = guard(c); if (denied) return denied;
    try { return c.json({ job: service.startRuleDraft(c.req.param('id')) }, 202); } catch (e) { return fail(c, e); }
  });
  app.get('/api/memory/public/pipeline/topics/:id/constraint/draft', c => {
    const denied = guard(c); if (denied) return denied;
    return c.json({ job: service.ruleDraftJob(c.req.param('id')) ?? null });
  });
  app.post('/api/memory/public/pipeline/topics/:id/constraint', async c => {
    const denied = guard(c); if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { level?: unknown; rule?: unknown; note?: unknown };
    try { return c.json({ change: service.setConstraint(c.req.param('id'), { level: body.level, rule: body.rule, note: body.note }) }); }
    catch (e) { return fail(c, e); }
  });
  app.delete('/api/memory/public/pipeline/topics/:id', async c => {
    const denied = guard(c); if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { note?: unknown };
    try { return c.json({ change: service.removeTopic(c.req.param('id'), { note: body.note }) }); }
    catch (e) {
      if (e instanceof PipelineError) return c.json({ error: e.message, code: e.code }, e.code === 'not-found' ? 404 : e.code === 'busy' ? 409 : 400);
      return c.json({ error: (e as Error).message, code: 'storage-error' }, 503);
    }
  });
  app.post('/api/memory/public/pipeline/run', c => {
    const denied = guard(c); if (denied) return denied;
    const already = service.isRunning();
    void service.run('manual');
    return c.json({ started: !already, running: true }, 202);
  });
}
