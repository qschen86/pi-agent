import type { Context, Hono } from 'hono';
import { compress } from 'hono/compress';
import { PublicMemoryError, type PublicErrorCode } from './types.js';
import type { PublicMemoryService } from './service.js';
import { projectAliasesOf } from './projects.js';

const STATUS: Record<PublicErrorCode, 400 | 404 | 409 | 503> = {
  'invalid-input': 400, 'not-found': 404, conflict: 409, busy: 409, disabled: 409, 'storage-error': 503
};

type Body = Record<string, unknown>;
const SETTING_KEYS = ['injectEnabled', 'pipelineEnabled'];

/**
 * 公共记忆 API（设置、注入预览、按需查阅索引、使用率）。条目的读写在 pipeline/routes.ts。
 * 公共记忆正文属于敏感数据：已登录本机，或公网需「控制」权限（读与写同口径）。
 */
export function mountPublicMemoryRoutes(app: Hono, service: PublicMemoryService, ctx: { allowed: (c: Context) => boolean }): void {
  // 手机常在 3G 上读这些 JSON（中文文本，压缩后只剩 1/4）：只对本组接口开 gzip，客户端不带 Accept-Encoding 时原样返回。
  app.use('/api/memory/public', compress());
  app.use('/api/memory/public/*', compress());
  const guard = (c: Context): Response | undefined => {
    c.header('Cache-Control', 'private, no-store');
    if (!ctx.allowed(c)) return c.json({ error: '控制权限未开启', code: 'RT_FORBIDDEN' }, 403);
    return undefined;
  };
  const fail = (c: Context, e: unknown): Response => {
    const code: PublicErrorCode = e instanceof PublicMemoryError ? e.code : 'storage-error';
    const message = e instanceof PublicMemoryError && e.message !== e.code ? e.message : undefined;
    return c.json({ error: message ?? code, code }, STATUS[code]);
  };
  const body = async (c: Context, keys: string[]): Promise<Body> => {
    const b = await c.req.json().catch(() => { throw new PublicMemoryError('invalid-input'); }) as unknown;
    if (!b || Array.isArray(b) || typeof b !== 'object' || Object.keys(b).some(k => k !== 'expectedVersion' && !keys.includes(k))) throw new PublicMemoryError('invalid-input');
    return b as Body;
  };

  /** 按需查阅索引（给 agent 读的 Markdown）：project 缺省 = 全局。文件读不到时（如 Pi 沙盒不让读家目录）用 curl 取同样内容。 */
  app.get('/api/memory/public/index', c => {
    const denied = guard(c); if (denied) return denied;
    try {
      const project = c.req.query('project') ?? null;
      if (project !== null && (!project.trim() || project.length > 200 || /[\r\n\u0000]/.test(project))) throw new PublicMemoryError('invalid-input');
      const part = c.req.query('part');
      if (part !== undefined && !['map', 'catalog', 'details'].includes(part)) throw new PublicMemoryError('invalid-input');
      const q = c.req.query('q');
      if (q !== undefined && (q.length > 80 || /[\r\n\u0000]/.test(q))) throw new PublicMemoryError('invalid-input');
      return c.body(service.indexMarkdown(project, { ...(part ? { part: part as 'map' | 'catalog' | 'details' } : {}), ...(q ? { q } : {}) }), 200, { 'content-type': 'text/markdown; charset=utf-8' });
    } catch (e) { return fail(c, e); }
  });
  /** 会话级使用率（每个 runtime：收到注入 / 查过 / 各类查阅次数）。 */
  app.get('/api/memory/public/usage', c => {
    const denied = guard(c); if (denied) return denied;
    try { return c.json(service.usageSummary()); } catch (e) { return fail(c, e); }
  });
  /** 按需查阅命中统计（只含走 ?q= 接口与平台观察到的查阅；直接读索引文件且识别不出的看不到）。 */
  app.get('/api/memory/public/hits', c => {
    const denied = guard(c); if (denied) return denied;
    try { return c.json(service.hitStats()); } catch (e) { return fail(c, e); }
  });
  /** 设置页要用的少量数据：开关、项目列表、乐观并发版本。 */
  app.get('/api/memory/public', c => {
    const denied = guard(c); if (denied) return denied;
    try { return c.json(service.view()); } catch (e) { return fail(c, e); }
  });
  app.post('/api/memory/public/settings', async c => {
    const denied = guard(c); if (denied) return denied;
    try {
      const b = await body(c, SETTING_KEYS);
      if (!SETTING_KEYS.some(k => k in b)) throw new PublicMemoryError('invalid-input');
      if (typeof b['expectedVersion'] !== 'string' || !/^[a-f0-9]{64}$/.test(b['expectedVersion'])) throw new PublicMemoryError('invalid-input', '缺少当前设置版本，请刷新后重试');
      const settings = service.updateSettings(b['expectedVersion'], { ...('injectEnabled' in b ? { injectEnabled: b['injectEnabled'] as boolean } : {}), ...('pipelineEnabled' in b ? { pipelineEnabled: b['pipelineEnabled'] as boolean } : {}) });
      return c.json({ settings });
    } catch (e) { return fail(c, e); }
  });
  /** 强约束的检查统计（记忆页详情用）：topicId → 通过 / 违规次数。 */
  app.get('/api/memory/public/enforcement', c => {
    const denied = guard(c); if (denied) return denied;
    try { return c.json({ stats: service.enforcementStats() }); } catch (e) { return fail(c, e); }
  });
  /** 预览：给定项目名，如果现在开始一个该项目的新会话，会注入什么（忽略开关，便于开启前检查）。 */
  app.post('/api/memory/public/injection-preview', async c => {
    const denied = guard(c); if (denied) return denied;
    try {
      const b = await body(c, ['project']);
      const project = b['project'];
      if (project !== null && (typeof project !== 'string' || !project || project.length > 200)) throw new PublicMemoryError('invalid-input');
      const aliases = project ? projectAliasesOf({ workspace: `/${project}` }) : [];
      const block = service.injectionFor(aliases, { force: true });
      return c.json({ enabled: service.settings().injectEnabled, block });
    } catch (e) { return fail(c, e); }
  });
}
