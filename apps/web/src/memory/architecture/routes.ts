import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context, Hono } from 'hono';

/**
 * 平台记忆架构图的版本（docs/requirements/memory-architecture-page）：versions/vNNN.json 是每一版的快照，随代码一起部署。
 * 门禁 scripts/check-memory-architecture.mjs 保证记忆应用代码变了就有新版本；对比（新增 / 修改 / 删除）在页面里按节点 id 做。
 * 内容是平台内部架构，口径同公共记忆：已登录本机，或公网需「控制」权限。
 */
export const ARCHITECTURE_DIR = fileURLToPath(new URL('./versions/', import.meta.url));
const ID = /^v\d{3,}$/;

export interface ArchitectureMeta { id: string; seq: number; date: string; title: string; notes: string[] }

export function listArchitecture(dir = ARCHITECTURE_DIR): { latest: string | null; versions: ArchitectureMeta[] } {
  if (!existsSync(dir)) return { latest: null, versions: [] };
  const versions = readdirSync(dir).filter(f => /^v\d{3,}\.json$/.test(f)).sort().map(f => {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ArchitectureMeta;
    return { id: j.id, seq: j.seq, date: j.date, title: j.title, notes: j.notes };
  });
  return { latest: versions.at(-1)?.id ?? null, versions };
}

export function readArchitecture(id: string, dir = ARCHITECTURE_DIR): unknown | null {
  if (!ID.test(id)) return null;
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  const { sourceHash: _omit, ...rest } = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  return rest;
}

export function mountArchitectureRoutes(app: Hono, ctx: { allowed: (c: Context) => boolean }, dir = ARCHITECTURE_DIR): void {
  const guard = (c: Context): Response | undefined => {
    c.header('Cache-Control', 'private, no-store');
    if (!ctx.allowed(c)) return c.json({ error: '控制权限未开启', code: 'RT_FORBIDDEN' }, 403);
    return undefined;
  };
  app.get('/api/memory/architecture', c => guard(c) ?? c.json(listArchitecture(dir)));
  app.get('/api/memory/architecture/:id', c => {
    const denied = guard(c); if (denied) return denied;
    const v = readArchitecture(c.req.param('id'), dir);
    return v ? c.json(v) : c.json({ error: '没有这个版本', code: 'not-found' }, 404);
  });
}
