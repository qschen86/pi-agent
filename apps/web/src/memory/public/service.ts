import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../store.js';
import { PublicMemoryStore, mutationVersion } from './store.js';
import { HitLog, type UsageStats } from './hits.js';
import { classifyIndexRead } from '../../../../../packages/runtime-sessions/src/platform-memory-lookups.js';
import { indexFileNames } from './index-files.js';
import { buildInjection } from './pipeline/injection.js';
import { moduleOfTopic, renderTopicCatalog, renderTopicDetails, renderTopicMap, renderTopicSearch, searchTopics, topicIndexFiles, topicSid, TOPIC_SEARCH_LIMIT } from './pipeline/topic-index.js';
import type { Topic } from './pipeline/types.js';
import { PublicMemoryError, type PublicData } from './types.js';
import type { ActiveRule } from '../../../../../packages/runtime-sessions/src/memory-enforcement.js';
import type { ProjectCatalog } from './projects.js';

export interface PublicMemoryOptions {
  store: PublicMemoryStore;
  /** 公共记忆条目（流水线提炼的 + 人工维护的）。注入与按需索引都读它。 */
  topicsSource: () => Topic[];
  /** 已知项目（设置页的预览项目下拉）。 */
  projects?: () => ProjectCatalog;
  now?: () => Date;
  /** agent 在本机访问平台的地址（索引兜底用 curl）。默认 http://127.0.0.1:8780 */
  baseUrl?: string;
}

export interface InjectionBlock { text: string; count: number; /** 强约束且有检测规则的条目，注入时登记到会话 */ rules: ActiveRule[]; global: number; project: number; chars: number; estTokens: number; withoutBrief: number; onDemand: number; indexPath: string | null; indexAvailable: boolean; indexError: string | null }

/**
 * 平台公共记忆的服务层：设置（注入开关 / 每日提炼开关）、新会话首轮注入、按需查阅索引（文件 + 接口兜底）、使用率统计。
 * 条目的提炼与维护在 pipeline/（PipelineService）；这里只读条目。
 */
export class PublicMemoryService {
  private readonly store: PublicMemoryStore;
  private readonly now: () => Date;
  private readonly hitLog: HitLog;
  private indexTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private indexError: string | null = null;
  private readonly seenLookups = new Set<string>();

  constructor(private readonly opts: PublicMemoryOptions) {
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date());
    this.store.onChange = () => this.scheduleIndex();
    this.hitLog = new HitLog(this.store.root, this.now);
  }

  /* ------------------------------ 使用率 ------------------------------ */

  /** 按需查阅的命中统计：接口 ?q= 的条目命中 + 平台观察到的文件 / 接口查阅。 */
  hitStats(): ReturnType<HitLog['read']> { return this.hitLog.read(); }

  /** 会话级使用率：每个 runtime 收到注入的会话数、其中查过的会话数、各类查阅次数。下限，不是精确值。 */
  usageSummary(): { since: string; runtimes: Array<{ runtime: string; injected: number; sessionsWithLookup: number; lookups: Record<string, number>; rate: number | null }>; recent: UsageStats['recent'] } {
    const d = this.hitLog.read();
    const u = d.usage;
    const names = new Set([...Object.keys(u?.injected ?? {}), ...Object.keys(u?.lookups ?? {})]);
    const runtimes = [...names].sort().map(runtime => {
      const injected = u?.injected[runtime] ?? 0;
      const sessionsWithLookup = u?.sessions[runtime]?.length ?? 0;
      const lookups: Record<string, number> = {};
      for (const [k, n] of Object.entries(u?.lookups[runtime] ?? {})) if (n) lookups[k] = n;
      // 查过的会话里可能有不在注入计数内的（例如统计开启前就已启动的会话）：分母取较大者，避免比率超过 100%
      const denom = Math.max(injected, sessionsWithLookup);
      return { runtime, injected, sessionsWithLookup, lookups, rate: denom ? sessionsWithLookup / denom : null };
    });
    return { since: d.since, runtimes, recent: u?.recent ?? [] };
  }

  /** 观察会话的一次工具调用：若是在查公共记忆索引，记使用率；读详情按编号记条目命中。只读观察，永不抛错。 */
  observeToolEvent(ctx: { runtime: string; sessionId: string; key: string; name?: string; input?: string }): void {
    try {
      const input = ctx.input;
      if (!input || (!input.includes('memory-public') && !input.includes('/api/memory/public/index'))) return;
      const dedup = `${ctx.sessionId}|${ctx.key}`;
      if (this.seenLookups.has(dedup)) return;
      const read = classifyIndexRead(ctx.name, input);
      if (!read) return;
      this.seenLookups.add(dedup);
      if (this.seenLookups.size > 4000) { const first = this.seenLookups.values().next().value; if (first !== undefined) this.seenLookups.delete(first); }
      this.hitLog.recordLookup(ctx.runtime, ctx.sessionId, read.kinds, { ...(read.query ? { query: read.query } : {}), ids: read.ids });
      if (read.ids.length) {
        const all = this.opts.topicsSource();
        this.hitLog.record(read.ids.map(p => all.find(t => topicSid(t).startsWith(p) || t.id.startsWith(p))?.id).filter((x): x is string => !!x));
      }
    } catch { /* 统计失败不影响会话 */ }
  }

  /** 观察到一个会话拿到了公共记忆首轮注入。 */
  /** 强约束的检查结果统计：topicId → 通过 / 违规次数。单独文件，不碰条目与索引。 */
  private get enforcementFile(): string { return join(this.store.root, 'enforcement.json'); }
  enforcementStats(): Record<string, { pass: number; fail: number; lastAt: string }> {
    try { return JSON.parse(readFileSync(this.enforcementFile, 'utf8')) as Record<string, { pass: number; fail: number; lastAt: string }>; } catch { return {}; }
  }
  recordEnforcement(topicId: string, pass: boolean): void {
    try {
      const all = this.enforcementStats(), cur = all[topicId] ?? { pass: 0, fail: 0, lastAt: '' };
      all[topicId] = { pass: cur.pass + (pass ? 1 : 0), fail: cur.fail + (pass ? 0 : 1), lastAt: this.now().toISOString() };
      atomicWrite(this.enforcementFile, JSON.stringify(all));
    } catch { /* 统计失败不影响会话 */ }
  }

  observeInjection(ctx: { runtime: string; sessionId: string }): void {
    try { this.hitLog.recordInjection(ctx.runtime, ctx.sessionId); } catch { /* 同上 */ }
  }

  /** 按索引里的编号前缀（`### 7d68b42e`）找到条目，给会话侧栏的查阅记录显示一句话；素材层不在索引里，不返回。 */
  entryByPrefix(prefix: string): { id: string; text: string; scope: string } | undefined {
    if (!/^[0-9a-f]{4,12}$/.test(prefix)) return undefined;
    const t = this.opts.topicsSource().find(x => x.tier !== 'material' && topicSid(x).startsWith(prefix));
    if (!t) return undefined;
    const text = `${t.condition ? `${t.condition}：` : ''}${t.statement}`.replace(/\s+/g, ' ').trim();
    return { id: topicSid(t), text: Array.from(text).length > 120 ? `${Array.from(text).slice(0, 119).join('')}…` : text, scope: t.domain === 'personal' ? '个人偏好' : `${t.project ?? ''}·${moduleOfTopic(t)}` };
  }

  /* ------------------------------ 设置 ------------------------------ */

  settings(): PublicData['settings'] { return this.store.read().settings; }

  /** 设置页要用的少量数据：开关、项目列表、乐观并发版本。 */
  view(): Record<string, unknown> {
    const data = this.store.read();
    return { version: 1, mutationVersion: mutationVersion(data), settings: data.settings, projects: this.opts.projects?.().names ?? [] };
  }

  /** 改一个或多个开关；expectedVersion 与当前版本不一致就拒绝（409）。 */
  updateSettings(expectedVersion: string, patch: Partial<PublicData['settings']>): PublicData['settings'] {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && typeof v !== 'boolean') throw new PublicMemoryError('invalid-input', `${k} 需为布尔值`);
    return this.store.change(d => {
      if (patch.injectEnabled !== undefined) d.settings.injectEnabled = patch.injectEnabled;
      if (patch.pipelineEnabled !== undefined) d.settings.pipelineEnabled = patch.pipelineEnabled;
      return { ...d.settings };
    }, expectedVersion);
  }

  /* ------------------------------ 按需查阅索引 ------------------------------ */

  get indexDir(): string { return join(this.store.root, 'index'); }
  indexPath(project: string | null): string { return join(this.indexDir, indexFileNames(project).map); }

  /**
   * 给 agent 读的 Markdown（接口兜底用）。project 为空 = 全局。
   * q 给了就做关键词 / #模块搜索并直接返回命中条目的详情；否则按 part 返回 map（默认，很短）/ catalog / details。
   */
  indexMarkdown(project: string | null, opts: { part?: 'map' | 'catalog' | 'details'; q?: string } = {}): string {
    const topics = this.opts.topicsSource().filter(t => t.tier !== 'material');
    const at = topics.reduce((m, t) => (t.signals.lastAt > m ? t.signals.lastAt : m), '');
    if (opts.q && opts.q.trim()) { const hits = searchTopics(project, topics, opts.q); this.hitLog.record(hits.slice(0, TOPIC_SEARCH_LIMIT).map(t => t.id)); return renderTopicSearch(project, hits, opts.q); }
    if (opts.part === 'catalog') return renderTopicCatalog(project, topics);
    if (opts.part === 'details') return renderTopicDetails(project, topics);
    return renderTopicMap(project, topics, at);
  }

  private scheduleIndex(): void {
    if (this.stopped || this.indexTimer) return;
    this.indexTimer = setTimeout(() => { this.indexTimer = undefined; try { this.ensureIndex(); } catch { /* exposed via indexError */ } }, 150);
    this.indexTimer.unref?.();
  }

  /** 启动时生成一次索引文件（之后随条目变化由流水线 onChange 触发 ensureIndex）。 */
  startMaintenance(): void {
    this.stopped = false;
    try { this.ensureIndex(); } catch { /* 文件指针不可用时接口兜底仍然可用 */ }
  }

  stop(): void {
    this.stopped = true;
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = undefined;
    this.store.onChange = undefined;
    this.hitLog.stop();
  }

  /** 重新生成 index/ 下的文件；内容没变不重写，不再有条目的项目文件删除。 */
  ensureIndex(): void {
    try { this.store.readLocked(() => this.writeIndex()); this.indexError = null; }
    catch (e) { this.indexError = e instanceof PublicMemoryError ? e.code : 'index-write-error'; throw e; }
  }

  private writeIndex(): void {
    const files = topicIndexFiles(this.opts.topicsSource());
    const dir = this.indexDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [name, text] of files) {
      const file = join(dir, name);
      let same = false;
      try { same = existsSync(file) && readFileSync(file, 'utf8') === text; } catch { /* 重写 */ }
      if (!same) atomicWrite(file, text);
    }
    for (const name of readdirSync(dir)) if (name.endsWith('.md') && !files.has(name)) unlinkSync(join(dir, name));
  }

  /* ------------------------------ 注入 ------------------------------ */

  /**
   * 新会话首轮要注入的公共记忆块（个人偏好 + 该项目的目标 + 常驻条目，放不下的退到按需查阅），见 pipeline/injection.ts。
   * projects 是这个会话的项目可能出现的所有名字（见 projects.ts）。
   * 开关关闭、没有可注入也没有可查阅的条目时返回 null。force 用于预览（忽略开关）。
   */
  injectionFor(projects: readonly string[], opts: { force?: boolean } = {}): InjectionBlock | null {
    if (!this.store.read().settings.injectEnabled && !opts.force) return null;
    const topics = this.opts.topicsSource();
    const names = new Set(projects);
    const project = [...new Set(topics.filter(t => t.tier !== 'material' && t.domain === 'project' && t.project && names.has(t.project)).map(t => t.project!))][0] ?? null;
    const r = buildInjection(topics, project, { indexDir: this.indexDir, baseUrl: this.opts.baseUrl ?? 'http://127.0.0.1:8780' });
    const resident = r.personal.length + r.goal.length + r.project.length + r.enforced.length;
    if (!resident && !r.onDemand.length) return null;
    try { this.ensureIndex(); } catch { /* 接口兜底 */ }
    return { text: r.text, count: resident, rules: r.rules, global: r.personal.length + r.enforced.filter(t => t.domain === 'personal').length, project: r.goal.length + r.project.length + r.enforced.filter(t => t.domain === 'project').length, chars: r.chars, estTokens: r.estTokens, withoutBrief: 0, onDemand: r.onDemand.length, indexPath: this.indexError ? null : this.indexPath(project), indexAvailable: !this.indexError, indexError: this.indexError };
  }
}
