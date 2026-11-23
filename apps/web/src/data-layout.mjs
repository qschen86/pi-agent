// 数据目录布局（需求 v3.123）：
//   flat：<dataDir>/<名字>，现有实例的布局；
//   apps：<dataDir>/apps/<应用 id>/<名字>，每个应用一个子目录，新实例（公开版）从第一天就用它。
// 布局由 <dataDir>/.data-layout 标记文件决定，没有标记就是 flat——所以现有实例不会被动到。
// 从 flat 迁到 apps 用 planMigration / applyMigration（先干跑看清单；带日志，可 rollbackMigration 原样退回）。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPS, dataName } from './app-manifest.mjs';

export const LAYOUT_MARKER = '.data-layout';
export const MIGRATION_JOURNAL = '.data-layout-migration.json';

const cache = new Map();
/** 读取（并缓存）一个数据目录的布局。布局只会在离线迁移时变化，所以进程内缓存即可；迁移工具会清缓存。 */
export function layoutOf(dataDir) {
  let value = cache.get(dataDir);
  if (value === undefined) {
    try { value = readFileSync(join(dataDir, LAYOUT_MARKER), 'utf8').trim() === 'apps' ? 'apps' : 'flat'; } catch { value = 'flat'; }
    cache.set(dataDir, value);
  }
  return value;
}
export function resetLayoutCache() { cache.clear(); ensured.clear(); }

/** 某个应用在该数据目录里的根：flat 就是 dataDir 本身，apps 是 <dataDir>/apps/<id>。 */
export function appRoot(dataDir, appId) {
  return layoutOf(dataDir) === 'apps' ? join(dataDir, 'apps', appId) : dataDir;
}

const ensured = new Set();
/** apps 布局下保证应用的根目录存在（存储常直接写 <根>/xxx.tmp，不会先建父目录）；flat 布局根就是数据目录，不用管。 */
export function ensureAppRoot(dataDir, appId) {
  const root = appRoot(dataDir, appId);
  if (layoutOf(dataDir) === 'apps' && !ensured.has(root)) { mkdirSync(root, { recursive: true, mode: 0o700 }); ensured.add(root); }
  return root;
}

/** 把一个全新（空）的数据目录标成 apps 布局；非空目录保持原布局，返回是否写了标记。 */
export function adoptAppsLayout(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (existsSync(join(dataDir, LAYOUT_MARKER))) return layoutOf(dataDir) === 'apps';
  if (readdirSync(dataDir).length) return false;
  writeFileSync(join(dataDir, LAYOUT_MARKER), 'apps\n', { mode: 0o600 });
  resetLayoutCache();
  return true;
}

/**
 * 迁移计划：flat → apps。每个应用登记的数据条目，只要根目录里存在就搬到 apps/<id>/<名字>；
 * 清单里没有的顶层条目原地不动并列在 untouched 里（历史备份、别的工具的文件等）。
 */
export function planMigration(dataDir, apps = APPS) {
  if (layoutOf(dataDir) === 'apps') throw new Error('这个数据目录已经是按应用分目录的布局');
  if (existsSync(join(dataDir, MIGRATION_JOURNAL))) throw new Error('上一次迁移没有收尾（存在迁移日志），请先执行回滚再重新迁移');
  const moves = [], owned = new Set();
  for (const app of apps) for (const entry of app.data) {
    const name = dataName(entry);
    owned.add(name);
    if (existsSync(join(dataDir, name))) moves.push({ app: app.id, name, from: name, to: join('apps', app.id, name) });
  }
  const untouched = readdirSync(dataDir).filter(name => name !== LAYOUT_MARKER && name !== 'apps' && !owned.has(name)).sort();
  return { moves, untouched };
}

/** 执行迁移：逐项 rename（同一文件系统内原子），先写日志再动手，最后写布局标记。 */
export function applyMigration(dataDir, apps = APPS) {
  const plan = planMigration(dataDir, apps);
  const journal = { schema: 1, startedAt: new Date().toISOString(), status: 'in-progress', moves: plan.moves, done: [] };
  const journalFile = join(dataDir, MIGRATION_JOURNAL);
  const save = () => writeFileSync(journalFile, JSON.stringify(journal, null, 1), { mode: 0o600 });
  save();
  for (const move of plan.moves) {
    mkdirSync(join(dataDir, 'apps', move.app), { recursive: true, mode: 0o700 });
    if (existsSync(join(dataDir, move.to))) throw new Error(`目标已存在，迁移中止（可回滚）：${move.to}`);
    renameSync(join(dataDir, move.from), join(dataDir, move.to));
    journal.done.push(move.from);
    save();
  }
  writeFileSync(join(dataDir, LAYOUT_MARKER), 'apps\n', { mode: 0o600 });
  journal.status = 'done'; journal.finishedAt = new Date().toISOString(); save();
  resetLayoutCache();
  return { moved: plan.moves.length, untouched: plan.untouched };
}

/** 回滚：把日志里已经搬过的条目原样搬回，删掉标记和空的应用目录，删除日志。中途失败的迁移也能回滚。 */
export function rollbackMigration(dataDir) {
  const journalFile = join(dataDir, MIGRATION_JOURNAL);
  if (!existsSync(journalFile)) throw new Error('没有迁移日志，不需要回滚');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  let restored = 0;
  for (const move of [...journal.moves].reverse()) {
    if (existsSync(join(dataDir, move.to)) && !existsSync(join(dataDir, move.from))) { renameSync(join(dataDir, move.to), join(dataDir, move.from)); restored++; }
  }
  rmSync(join(dataDir, LAYOUT_MARKER), { force: true });
  // rmdir：只删空目录，不为空（里面有别的东西）就保留
  for (const app of (existsSync(join(dataDir, 'apps')) ? readdirSync(join(dataDir, 'apps')) : []).filter(name => journal.moves.some(move => move.app === name))) { try { rmdirSync(join(dataDir, 'apps', app)); } catch { /* 不为空就保留 */ } }
  try { rmdirSync(join(dataDir, 'apps')); } catch { /* 不为空就保留 */ }
  rmSync(journalFile);
  resetLayoutCache();
  return { restored };
}
