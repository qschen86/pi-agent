import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withHostMutex } from '../../../../../../packages/runtime-sessions/src/host-mutex.js';
import { atomicWrite } from '../../store.js';
import { settleConstraint } from './constraint.js';
import { currentModule } from './modules.js';
import { bothMaterial } from './topics.js';
import { emptyPipelineState, type PipelineState, type Topic } from './types.js';

/** 观察、主题、人定归属、人判定样例里的模块 id 改成现行的；已是现行的不动。 */
export function retireModules(state: PipelineState): void {
  for (const o of Object.values(state.observations)) if (o.module) o.module = currentModule(o.module)!;
  for (const o of Object.values(state.pendingObservations ?? {})) if (o.module) o.module = currentModule(o.module)!;
  for (const l of state.humanScopeLabels ?? []) if (l.module) l.module = currentModule(l.module);
  for (const t of Object.values(state.topics)) {
    if (t.module) t.module = currentModule(t.module)!;
    if (t.override?.scope?.module) t.override.scope.module = currentModule(t.override.scope.module);
  }
}

const FILE = 'pipeline.json', LOCK = 'pipeline.run.lock', STALE_LOCK_MS = 30 * 60_000, FEED_SEEN_FILE = 'feed-seen.json', MANUAL_MARKS_FILE = 'manual-marks.json';

/**
 * 流水线的持久层：memory-public/pipeline.json。目录 0700、文件 0600、原子写；写入在 withHostMutex 内。
 * 运行本身可能持续几分钟（模型调用），所以不在互斥锁内跑；用一个“运行锁”文件保证同一时间只有一个进程在跑
 * （蓝绿两个槽位都可能有定时器），锁超过 30 分钟视为遗留、可以接管。
 * 文件损坏时拒绝覆盖（抛错），不当成空库——里面有已经落盘的归属决定。
 */
export class PipelineStore {
  constructor(readonly root: string) {}
  private file(): string { return join(this.root, FILE); }

  private cache: { key: string; topics: Topic[] } | null = null;
  /** 只要主题列表（注入 / 索引每次都读）：按文件身份（大小 + 修改时间）缓存，文件没变就不重新解析。读不到 / 损坏时返回空，不抛——注入宁可少，不能让新会话起不来。 */
  topics(): Topic[] {
    try {
      const st = statSync(this.file()), key = `${st.size}:${st.mtimeMs}`;
      if (this.cache?.key === key) return this.cache.topics;
      const topics = Object.values(this.read().topics);
      this.cache = { key, topics };
      return topics;
    } catch { return this.cache?.topics ?? []; }
  }

  read(): PipelineState {
    if (!existsSync(this.file())) return emptyPipelineState();
    const raw = JSON.parse(readFileSync(this.file(), 'utf8')) as Partial<PipelineState>;
    if (raw.version !== 1 || !raw.observations || !raw.topics || !raw.assignment || !raw.sessions) throw new Error('pipeline.json 格式不认识，拒绝覆盖');
    const state = { ...emptyPipelineState(), ...raw } as PipelineState;
    retireModules(state);
    for (const t of Object.values(state.topics)) settleConstraint(t);   // 强约束必须有规则：没有的读出来就是「待补规则」，下次写入时落盘
    return state;
  }

  /** 把已并入别的模块的旧模块 id（如 mobile → ui）永久改写到文件里；读取时本来就会改写，这里只是落盘并留一份备份。返回是否改了。调用者负责持运行锁。 */
  persistRetiredModules(): boolean {
    if (!existsSync(this.file())) return false;
    const before = readFileSync(this.file(), 'utf8');
    if (!/"module":"mobile"/.test(before)) return false;
    const backup = join(this.root, 'pipeline.json.bak-retire-mobile');
    if (!existsSync(backup)) writeFileSync(backup, before, { mode: 0o600 });
    this.write(this.read());
    return true;
  }

  /**
   * 「动态」已读到哪一刻（ISO）。单独一个小文件，不进 pipeline.json：标已读不该抢运行锁（流水线跑几分钟，期间标已读会失败），
   * 也不该重写整份几 MB 的状态。读不到 / 损坏当作还没读过。
   */
  feedSeenAt(): string | null {
    try {
      const v = (JSON.parse(readFileSync(join(this.root, FEED_SEEN_FILE), 'utf8')) as { at?: unknown }).at;
      return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
    } catch { return null; }
  }
  /**
   * 用户在消息上点了「加入记忆」的记录：会话 id → 账本 key 列表。和 feed-seen 一样是单独的小文件：点按钮不该等流水线跑完（运行锁），
   * 也不该重写整份状态。读不到 / 损坏当作没有。
   */
  manualMarks(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    try {
      const raw = JSON.parse(readFileSync(join(this.root, MANUAL_MARKS_FILE), 'utf8')) as Record<string, unknown>;
      for (const [sid, keys] of Object.entries(raw)) if (Array.isArray(keys)) out.set(sid, new Set(keys.filter((k): k is string => typeof k === 'string')));
    } catch { /* 没有记录 */ }
    return out;
  }
  /** 记下一条；已记过返回 false。 */
  markManual(sessionId: string, key: string): boolean {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const r = withHostMutex(this.root, () => {
      const marks = this.manualMarks(), set = marks.get(sessionId) ?? new Set<string>();
      if (set.has(key)) return false;
      set.add(key); marks.set(sessionId, set);
      atomicWrite(join(this.root, MANUAL_MARKS_FILE), JSON.stringify(Object.fromEntries([...marks].map(([sid, s]) => [sid, [...s]]))));
      return true;
    });
    if (typeof r !== 'boolean') throw new Error('pipeline 存储繁忙');
    return r;
  }

  /** 只往后推，不往回退：两端同时标已读时以较晚的为准。返回推进后的值。 */
  markFeedSeen(at: string): string {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const r = withHostMutex(this.root, () => {
      const cur = this.feedSeenAt();
      const next = cur && Date.parse(cur) >= Date.parse(at) ? cur : at;
      if (next !== cur) atomicWrite(join(this.root, FEED_SEEN_FILE), JSON.stringify({ at: next }));
      return next;
    });
    if (typeof r !== 'string') throw new Error('pipeline 存储繁忙');
    return r;
  }

  /** 两边都在素材层的待裁决冲突不影响任何会话，清掉（先留一份备份）。返回清掉几条。调用者负责持运行锁。 */
  dropMaterialConflicts(): number {
    if (!existsSync(this.file())) return 0;
    const state = this.read();
    const stale = Object.values(state.topics).filter(t => t.pending && bothMaterial(t, state.topics[t.pending.withTopicId]));
    if (!stale.length) return 0;
    const backup = join(this.root, 'pipeline.json.bak-material-conflicts');
    if (!existsSync(backup)) writeFileSync(backup, readFileSync(this.file(), 'utf8'), { mode: 0o600 });
    for (const t of stale) delete t.pending;
    this.write(state);
    return stale.length;
  }

  write(state: PipelineState): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const r = withHostMutex(this.root, () => { atomicWrite(this.file(), JSON.stringify(state)); return true; });
    if (typeof r !== 'boolean') throw new Error('pipeline 存储繁忙');
  }

  /** 抢运行锁；抢不到返回 null。返回的函数释放锁。 */
  acquire(now = Date.now()): (() => void) | null {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, LOCK);
    try { writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx', mode: 0o600 }); }
    catch {
      let stale = false;
      try { stale = now - statSync(lock).mtimeMs > STALE_LOCK_MS; } catch { stale = true; }
      if (!stale) return null;
      try { unlinkSync(lock); writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx', mode: 0o600 }); } catch { return null; }
    }
    return () => { try { unlinkSync(lock); } catch { /* 已被接管 */ } };
  }
}
