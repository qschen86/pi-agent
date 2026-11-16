import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withHostMutex } from '../../../../../packages/runtime-sessions/src/host-mutex.js';
import { atomicWrite } from '../store.js';

/**
 * 按需查阅的命中统计，供「哪些记忆从来没被用到」的判断使用（后续用来自动归档）。
 * 单独放在 hits.json：计数不进 knowledge.json，所以不会改动条目的 updatedAt / 版本号，
 * 也不会触发索引重写，更不会让审查页的乐观版本校验（409）因为一次查阅而失败。
 * `entries`：条目级命中——走接口的 `?q=` 命中，以及 agent 用 `### 编号` 读详情文件的命中（v3.79 起由平台观察会话工具事件得到）。
 * `usage`：会话级使用率——每个 runtime 收到了多少次首轮指针（分母）、有多少个会话真的查过、各类查阅各几次（分子）。
 * 只统计经平台派发的会话；识别不出的查阅按「没查」算，所以是下限，不是精确值。
 */
export interface HitEntry { count: number; lastAt: string; firstAt: string }
export type UsageKind = 'map' | 'catalog' | 'details' | 'api';
export interface RecentLookup { at: string; runtime: string; kinds: UsageKind[]; query?: string; ids?: string[] }
export interface UsageStats {
  /** runtime → 收到公共记忆首轮注入的会话数 */
  injected: Record<string, number>;
  /** runtime → 查过的会话 id（去重；上限 UsageSessionCap，满了丢最旧的） */
  sessions: Record<string, string[]>;
  /** runtime → 查阅类型 → 次数（同一事件只计一次） */
  lookups: Record<string, Partial<Record<UsageKind, number>>>;
  recent: RecentLookup[];
}
export interface HitData { version: 1; since: string; entries: Record<string, HitEntry>; usage?: UsageStats }
export const USAGE_SESSION_CAP = 500;
export const USAGE_RECENT_CAP = 50;

type UsageOp =
  | { t: 'inject'; runtime: string; session: string }
  | { t: 'lookup'; runtime: string; session: string; kinds: UsageKind[]; at: string; query?: string; ids?: string[] };

export const emptyUsage = (): UsageStats => ({ injected: {}, sessions: {}, lookups: {}, recent: [] });

function applyOps(d: HitData, ops: readonly UsageOp[]): void {
  if (!ops.length) return;
  const u = d.usage ??= emptyUsage();
  for (const op of ops) {
    if (op.t === 'inject') { u.injected[op.runtime] = (u.injected[op.runtime] ?? 0) + 1; continue; }
    const l = u.lookups[op.runtime] ??= {};
    for (const k of op.kinds) l[k] = (l[k] ?? 0) + 1;
    const ss = u.sessions[op.runtime] ??= [];
    if (!ss.includes(op.session)) { ss.push(op.session); if (ss.length > USAGE_SESSION_CAP) ss.shift(); }
    u.recent.push({ at: op.at, runtime: op.runtime, kinds: op.kinds, ...(op.query ? { query: op.query } : {}), ...(op.ids?.length ? { ids: op.ids } : {}) });
    if (u.recent.length > USAGE_RECENT_CAP) u.recent.splice(0, u.recent.length - USAGE_RECENT_CAP);
  }
}

const FLUSH_MS = 2_000;

export class HitLog {
  private pending = new Map<string, { n: number; at: string }>();
  private pendingOps: UsageOp[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private since: string;
  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) { this.since = this.now().toISOString(); }

  private get file(): string { return join(this.root, 'hits.json'); }

  record(ids: readonly string[]): void {
    if (!ids.length) return;
    const at = this.now().toISOString();
    for (const id of new Set(ids)) { const p = this.pending.get(id); this.pending.set(id, { n: (p?.n ?? 0) + 1, at }); }
    this.arm();
  }

  private arm(): void {
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, FLUSH_MS); this.timer.unref?.(); }
  }

  /** 一个 runtime 会话拿到了公共记忆首轮注入（使用率的分母）。 */
  recordInjection(runtime: string, session: string): void { this.pendingOps.push({ t: 'inject', runtime, session }); this.arm(); }
  /** 一次文件 / 接口查阅（使用率的分子）。条目命中另走 record()。 */
  recordLookup(runtime: string, session: string, kinds: readonly UsageKind[], extra: { query?: string; ids?: readonly string[] } = {}): void {
    if (!kinds.length) return;
    this.pendingOps.push({ t: 'lookup', runtime, session, kinds: [...kinds], at: this.now().toISOString(), ...(extra.query ? { query: extra.query } : {}), ...(extra.ids?.length ? { ids: [...extra.ids] } : {}) });
    this.arm();
  }

  private load(): HitData {
    try {
      if (existsSync(this.file)) {
        const d = JSON.parse(readFileSync(this.file, 'utf8')) as HitData;
        if (d && d.version === 1 && d.entries && typeof d.entries === 'object') return d;
      }
    } catch { /* 损坏的统计文件直接重新开始：它只是参考数据 */ }
    return { version: 1, since: this.since, entries: {} };
  }

  /** 读取已落盘的统计 + 尚未落盘的增量。 */
  read(): HitData {
    const d = this.load();
    for (const [id, p] of this.pending) {
      const e = d.entries[id];
      d.entries[id] = e ? { ...e, count: e.count + p.n, lastAt: p.at } : { count: p.n, firstAt: p.at, lastAt: p.at };
    }
    applyOps(d, this.pendingOps);
    return d;
  }

  flush(): void {
    if (!this.pending.size && !this.pendingOps.length) return;
    const batch = this.pending;
    const ops = this.pendingOps;
    this.pending = new Map();
    this.pendingOps = [];
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const r = withHostMutex(this.root, () => {
        const d = this.load();
        for (const [id, p] of batch) {
          const e = d.entries[id];
          d.entries[id] = e ? { ...e, count: e.count + p.n, lastAt: p.at } : { count: p.n, firstAt: p.at, lastAt: p.at };
        }
        applyOps(d, ops);
        atomicWrite(this.file, JSON.stringify(d) + '\n');
        return true;
      });
      if (!r || (typeof r === 'object' && 'status' in r)) throw new Error('busy');
    } catch {
      // 统计写不进去不影响查阅：把增量放回去，下次再试
      for (const [id, p] of batch) { const c = this.pending.get(id); this.pending.set(id, { n: (c?.n ?? 0) + p.n, at: c && c.at > p.at ? c.at : p.at }); }
      this.pendingOps = [...ops, ...this.pendingOps];
      if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 30_000); this.timer.unref?.(); }
    }
  }

  stop(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } this.flush(); }
}
