/** Codex 记忆：~/.codex/memories（流水线产物）+ memories_1.sqlite（流水线状态，用复制件读）。只读，不碰 .git。 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileFingerprint, makeEntry, readHead, readStable, realWithin, unreadableEntry } from './common.js';
import type { NativeMemoryEntry, NativeMemorySnapshot, NativeSection } from './types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const MAX_FILES = 600;
const MAX_TOTAL_CHARS = 12 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const codexHome = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string => env['CODEX_HOME'] || join(home, '.codex');
export const codexMemoryRoot = (home = codexHome()): string => join(home, 'memories');

/** `# Task Group: 标题` 切分；第一个标题前的内容作为「前言」（有才出）。 */
export function splitTaskGroups(text: string): Array<{ title: string; body: string }> {
  const lines = text.split('\n');
  const groups: Array<{ title: string; start: number }> = [];
  lines.forEach((l, i) => {
    const m = /^# Task Group:\s*(.*\S)\s*$/.exec(l);
    if (m) groups.push({ title: m[1]!, start: i });
  });
  const out: Array<{ title: string; body: string }> = [];
  const preface = lines.slice(0, groups[0]?.start ?? lines.length).join('\n').trim();
  if (preface) out.push({ title: '前言', body: preface });
  groups.forEach((g, i) => out.push({ title: g.title, body: lines.slice(g.start, groups[i + 1]?.start ?? lines.length).join('\n').trimEnd() }));
  return out;
}

/** rollout_summaries 文件名：`2026-10-24T03-24-00-D7qj-slug.md` → slug */
export const rolloutSlug = (file: string): string => file.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}T[\d-]+-[A-Za-z0-9]{4}-/, '').replace(/_/g, ' ');

export interface CodexStage1Row { threadId: string; slug: string | null; generatedAt: string | null; sourceUpdatedAt: string | null; usageCount: number | null; lastUsage: string | null; selectedForPhase2: boolean }
export interface CodexJobRow { kind: string; status: string; finishedAt: string | null }
export interface CodexPipeline { stage1: CodexStage1Row[]; jobs: CodexJobRow[]; available: boolean }

const iso = (sec: unknown): string | null => typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null;

export class CodexMemoryReader {
  private cache = new Map<string, { fingerprint: string; entries: NativeMemoryEntry[] }>();
  private pipelineCache: { key: string; value: CodexPipeline } | null = null;
  constructor(private readonly home = codexHome(), private readonly now = () => new Date(), private readonly tmpRoot = tmpdir()) {}

  get root(): string { return codexMemoryRoot(this.home); }

  private fileEntries(path: string, rel: string, section: NativeSection, build: (text: string, mtime: string | null) => NativeMemoryEntry[]): NativeMemoryEntry[] {
    const fp = fileFingerprint(path);
    const cached = this.cache.get(path);
    if (cached && fp && cached.fingerprint === fp) return cached.entries;
    const r = readStable(path, MAX_FILE_BYTES);
    if (r.kind === 'missing') return [];
    const mtime = (() => { try { return statSync(path).mtime.toISOString(); } catch { return null; } })();
    if (r.kind !== 'ok') return [unreadableEntry({ id: rel, path: rel, section, title: rel, state: r.kind === 'too-large' ? 'too-large' : 'unstable', mtime })];
    const entries = build(r.text, mtime);
    this.cache.set(path, { fingerprint: r.fingerprint, entries });
    return entries;
  }

  read(): NativeMemorySnapshot {
    const capturedAt = this.now().toISOString();
    const base = { version: 1 as const, runtime: 'codex' as const, scopeKey: 'global', project: null, capturedAt };
    const root = this.root;
    if (!existsSync(root)) return { ...base, status: 'not-found', entries: [], notes: [] };
    const notes: string[] = [];
    const entries: NativeMemoryEntry[] = [];

    entries.push(...this.fileEntries(join(root, 'memory_summary.md'), 'memory_summary.md', 'summary', (text, mtime) =>
      [makeEntry({ id: 'memory_summary.md', path: 'memory_summary.md', section: 'summary', title: '记忆摘要（每次启动注入）', text, mtime })]));

    entries.push(...this.fileEntries(join(root, 'MEMORY.md'), 'MEMORY.md', 'memory', (text, mtime) => {
      const seen = new Map<string, number>();
      return splitTaskGroups(text).map(g => {
        const n = (seen.get(g.title) ?? 0) + 1;
        seen.set(g.title, n);
        return makeEntry({ id: `MEMORY.md#${g.title}${n > 1 ? `#${n}` : ''}`, path: 'MEMORY.md', section: 'memory', title: g.title, text: g.body, mtime });
      });
    }));

    for (const [dirRel, section] of [['rollout_summaries', 'rollout'], ['extensions/ad_hoc/notes', 'note']] as const) {
      const dir = join(root, dirRel);
      let names: string[] = [];
      try { names = readdirSync(dir).filter(f => !f.startsWith('.')).sort(); } catch { continue; }
      if (names.length > MAX_FILES) { notes.push(`${dirRel} 超过 ${MAX_FILES} 个文件，只读取前 ${MAX_FILES} 个`); names = names.slice(0, MAX_FILES); }
      for (const name of names) {
        const path = join(dir, name);
        if (!realWithin(root, path)) continue;
        const rel = `${dirRel}/${name}`;
        entries.push(...this.fileEntries(path, rel, section, (text, mtime) =>
          [makeEntry({ id: rel, path: rel, section, title: section === 'rollout' ? rolloutSlug(name) : name.replace(/\.[^.]+$/, ''), text, mtime })]));
      }
    }
    let total = 0;
    const kept: NativeMemoryEntry[] = [];
    for (const e of entries) { total += e.content.length; if (total > MAX_TOTAL_CHARS) { notes.push('记忆总量过大，已停止读取'); break; } kept.push(e); }
    const live = new Set([join(root, 'memory_summary.md'), join(root, 'MEMORY.md')]);
    for (const k of [...this.cache.keys()]) if (!live.has(k) && !existsSync(k)) this.cache.delete(k);
    return { ...base, status: 'ready', entries: kept, notes };
  }

  /**
   * 流水线状态：把 memories_1.sqlite（及 -wal）复制到平台私有临时目录再读。
   * 直接打开源库在 Codex 未运行时可能创建 -shm，那是在它的目录里写东西，所以不打开源。
   */
  pipeline(): CodexPipeline {
    const db = join(this.home, 'memories_1.sqlite');
    const fpDb = fileFingerprint(db);
    if (!fpDb) return { stage1: [], jobs: [], available: false };
    const key = `${fpDb}|${fileFingerprint(`${db}-wal`) ?? ''}`;
    if (this.pipelineCache?.key === key) return this.pipelineCache.value;
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(this.tmpRoot, 'pi-agent-codex-mem-'));
      const copy = join(dir, 'memories.sqlite');
      copyFileSync(db, copy);
      if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, `${copy}-wal`);
      const conn = new DatabaseSync(copy);
      try {
        conn.exec('PRAGMA query_only=1');
        const stage1 = (conn.prepare('SELECT thread_id, rollout_slug, generated_at, source_updated_at, usage_count, last_usage, selected_for_phase2 FROM stage1_outputs ORDER BY generated_at DESC LIMIT 5000').all() as Array<Record<string, unknown>>).map(r => ({
          threadId: String(r['thread_id']), slug: typeof r['rollout_slug'] === 'string' ? r['rollout_slug'] : null,
          generatedAt: iso(r['generated_at']), sourceUpdatedAt: iso(r['source_updated_at']),
          usageCount: typeof r['usage_count'] === 'number' ? r['usage_count'] : null, lastUsage: iso(r['last_usage']),
          selectedForPhase2: r['selected_for_phase2'] === 1
        }));
        const jobs = (conn.prepare("SELECT kind, status, finished_at FROM jobs WHERE kind = 'memory_consolidate_global' ORDER BY finished_at DESC LIMIT 20").all() as Array<Record<string, unknown>>).map(r => ({ kind: String(r['kind']), status: String(r['status']), finishedAt: iso(r['finished_at']) }));
        const value = { stage1, jobs, available: true };
        this.pipelineCache = { key, value };
        return value;
      } finally { conn.close(); }
    } catch {
      return { stage1: [], jobs: [], available: false };
    } finally {
      if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

/** 开关状态：只读取 config.toml 里 [memories] 两个键，其余一概不读不展示。 */
export function readCodexMemorySwitches(home = codexHome()): { generate: boolean | null; use: boolean | null } {
  const head = readHead(join(home, 'config.toml'), 256 * 1024);
  if (!head) return { generate: null, use: null };
  const m = /^\[memories\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(head);
  const body = m?.[1] ?? '';
  const flag = (k: string): boolean | null => { const r = new RegExp(`^\\s*${k}\\s*=\\s*(true|false)`, 'm').exec(body); return r ? r[1] === 'true' : null; };
  return { generate: flag('generate_memories'), use: flag('use_memories') };
}

export interface CodexInjection { at: string | null }

/** rollout 开头的开发者指令里出现 MEMORY_SUMMARY = 启动注入了 memory_summary.md。 */
export function scanCodexInjection(headText: string): CodexInjection | null {
  for (const line of headText.split('\n')) {
    if (!line.includes('MEMORY_SUMMARY') || !line.includes('"developer"')) continue;
    try {
      const o = JSON.parse(line) as { timestamp?: string; payload?: { type?: string; role?: string } };
      if (o.payload?.type === 'message' && o.payload.role === 'developer') return { at: o.timestamp ?? null };
    } catch { /* 半行 */ }
  }
  return null;
}

/** sessions/YYYY/MM/DD/rollout-<时间>-<原生会话 ID>.jsonl；从最新日期往回找，找不到（含已归档 .zst）返回 null。 */
export function findCodexRollout(nativeSessionId: string, home = codexHome()): string | null {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(nativeSessionId)) return null;
  const root = join(home, 'sessions');
  const list = (d: string): string[] => { try { return readdirSync(d).sort().reverse(); } catch { return []; } };
  for (const y of list(root)) for (const m of list(join(root, y))) for (const d of list(join(root, y, m))) {
    const hit = list(join(root, y, m, d)).find(f => f.endsWith(`-${nativeSessionId}.jsonl`));
    if (hit) return join(root, y, m, d, hit);
  }
  return null;
}

export function codexInjectionFromRollout(path: string | null, home = codexHome()): CodexInjection | null {
  if (!path) return null;
  const real = ['sessions', 'archived_sessions'].map(d => realWithin(join(home, d), path)).find(Boolean);
  if (!real) return null;
  const head = readHead(real, 512 * 1024);
  return head ? scanCodexInjection(head) : null;
}
