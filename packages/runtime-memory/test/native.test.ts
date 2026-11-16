import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClaudeMemoryReader, CodexMemoryReader, carryUnreadable, diffNativeSnapshots,
  listClaudeMemoryProjects, readCodexMemorySwitches, scanClaudeInjections, scanCodexInjection, shellMemoryAccess,
  splitTaskGroups
} from '../src/native/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'native-mem-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** 目录树指纹：路径、大小、mtime、权限。读取路径跑完后它必须一字不差。 */
function tree(root: string): string {
  const rows: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name), s = statSync(p);
      rows.push(`${relative(root, p)}|${s.isDirectory() ? 'd' : s.size}|${Math.trunc(s.mtimeMs)}|${s.mode}|${s.isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex') : ''}`);
      if (s.isDirectory()) walk(p);
    }
  };
  walk(root);
  return rows.join('\n');
}

const HOME = '/Users/tester';

describe('shellMemoryAccess', () => {
  const roots = [`${HOME}/.codex/memories`];
  it('classifies read / search / write / delete and ignores mentions', () => {
    expect(shellMemoryAccess(`sed -n '147,190p' ${HOME}/.codex/memories/MEMORY.md`, roots, HOME)).toEqual([{ path: `${HOME}/.codex/memories/MEMORY.md`, op: 'read', lines: '147–190' }]);
    expect(shellMemoryAccess(`/bin/zsh -lc "rg -n 'Hermes|冲突' ~/.codex/memories/MEMORY.md"`, roots, HOME)).toEqual([{ path: `${HOME}/.codex/memories/MEMORY.md`, op: 'search', query: 'Hermes|冲突' }]);
    expect(shellMemoryAccess(`rm $HOME/.codex/memories/extensions/ad_hoc/notes/a.md`, roots, HOME)[0]?.op).toBe('delete');
    expect(shellMemoryAccess(`echo hi > ${HOME}/.codex/memories/x.md`, roots, HOME)[0]?.op).toBe('write');
    expect(shellMemoryAccess(`sed -i 's/a/b/' ${HOME}/.codex/memories/x.md`, roots, HOME)[0]?.op).toBe('write');
    expect(shellMemoryAccess(`cp ${HOME}/.codex/memories/a.md /tmp/a.md`, roots, HOME)[0]?.op).toBe('read');
    expect(shellMemoryAccess(`echo "see ${HOME}/.codex/memories"`, roots, HOME)).toEqual([]);
    expect(shellMemoryAccess('rg foo /tmp/other', roots, HOME)).toEqual([]);
  });
});

describe('Claude memory', () => {
  function fixture(): { config: string; dir: string } {
    const config = tmp(), dir = join(config, 'projects', '-Users-tester-Documents-app', 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — hook\n- [B](gone.md) — hook\n');
    writeFileSync(join(dir, 'a.md'), '---\nname: topic-a\ndescription: about a\nmetadata:\n  type: project\n---\nbody a\n');
    return { config, dir };
  }

  it('reads entries read-only, leaves the tree untouched and skips unchanged files via cache', () => {
    const { config, dir } = fixture();
    const outside = join(tmp(), 'secret.md'); writeFileSync(outside, 'secret');
    symlinkSync(outside, join(dir, 'link.md'));
    const before = tree(config);
    const [project] = listClaudeMemoryProjects(config);
    expect(project).toMatchObject({ key: '-Users-tester-Documents-app', label: 'Documents-app' });
    const reader = new ClaudeMemoryReader(() => new Date('2026-10-27T00:00:00Z'));
    const snap = reader.read(project!);
    expect(snap.status).toBe('ready');
    expect(snap.entries.map(e => e.id)).toEqual(['MEMORY.md', 'a.md']);
    expect(snap.entries[1]).toMatchObject({ title: 'topic-a', description: 'about a', kind: 'project', section: 'topic' });
    expect(snap.notes.join()).toContain('gone.md');
    expect(reader.read(project!).entries[1]).toBe(snap.entries[1]); // 同一对象 = 命中缓存
    expect(tree(config)).toBe(before);
  });

  it('parses AutoMem injections and rejects unknown formats quietly', () => {
    const line = JSON.stringify({ timestamp: '2026-10-27T01:00:00Z', uuid: 'u1', attachment: { type: 'instructions', files: [{ type: 'AutoMem', path: '/c/projects/k/memory/MEMORY.md', content: '- a\n- b\n' }, { type: 'Project', path: '/x/CLAUDE.md', content: 'x' }] } });
    expect(scanClaudeInjections(`${line}\n{broken\n{"attachment":{"type":"other"}}`)).toEqual([expect.objectContaining({ path: '/c/projects/k/memory/MEMORY.md', lines: 2, at: '2026-10-27T01:00:00Z' })]);
    expect(scanClaudeInjections('nonsense AutoMem')).toEqual([]);
  });
});

describe('Codex memory', () => {
  function fixture(): { home: string } {
    const home = tmp(), root = join(home, 'memories');
    mkdirSync(join(root, 'rollout_summaries'), { recursive: true });
    mkdirSync(join(root, 'extensions/ad_hoc/notes'), { recursive: true });
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref');
    writeFileSync(join(root, 'memory_summary.md'), 'summary text');
    writeFileSync(join(root, 'MEMORY.md'), 'preface\n\n# Task Group: Alpha\nbody a\n\n# Task Group: Beta\nbody b\n# Task Group: Alpha\nbody a2\n');
    writeFileSync(join(root, 'rollout_summaries', '2026-10-24T03-24-00-D7qj-hide_sidebar.md'), 'rs');
    writeFileSync(join(root, 'extensions/ad_hoc/notes', 'n1.md'), 'note');
    writeFileSync(join(root, 'raw_memories.md'), 'raw');
    return { home };
  }

  it('splits task groups, entries are stable and the tree is untouched', () => {
    expect(splitTaskGroups('# Task Group: X\nb').map(g => g.title)).toEqual(['X']);
    const { home } = fixture();
    const before = tree(home);
    const snap = new CodexMemoryReader(home, () => new Date('2026-10-27T00:00:00Z')).read();
    expect(snap.entries.map(e => e.id)).toEqual([
      'memory_summary.md', 'MEMORY.md#前言', 'MEMORY.md#Alpha', 'MEMORY.md#Beta', 'MEMORY.md#Alpha#2',
      'rollout_summaries/2026-10-24T03-24-00-D7qj-hide_sidebar.md', 'extensions/ad_hoc/notes/n1.md'
    ]);
    expect(snap.entries.find(e => e.section === 'rollout')?.title).toBe('hide sidebar');
    expect(tree(home)).toBe(before);
  });

  it('reads pipeline state from a copy and never creates files next to the source database', () => {
    const { home } = fixture();
    const db = join(home, 'memories_1.sqlite');
    const conn = new DatabaseSync(db);
    conn.exec('PRAGMA journal_mode=WAL');
    conn.exec('CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, source_updated_at INTEGER NOT NULL, raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL, rollout_slug TEXT, generated_at INTEGER NOT NULL, usage_count INTEGER, last_usage INTEGER, selected_for_phase2 INTEGER NOT NULL DEFAULT 0, selected_for_phase2_source_updated_at INTEGER)');
    conn.exec('CREATE TABLE jobs (kind TEXT NOT NULL, job_key TEXT NOT NULL, status TEXT NOT NULL, finished_at INTEGER, PRIMARY KEY (kind, job_key))');
    conn.prepare("INSERT INTO stage1_outputs VALUES ('t1', 1793000000, 'SECRET RAW', 'SECRET SUM', 'slug-1', 1793094428, 3, 1793094500, 1, NULL)").run();
    conn.prepare("INSERT INTO jobs VALUES ('memory_consolidate_global', 'global', 'done', 1793094600)").run();
    const before = tree(home), names = readdirSync(home).sort();
    const reader = new CodexMemoryReader(home, undefined, tmp());
    const p = reader.pipeline();
    // the writer (Codex) is still running: its sidecars must be exactly as before
    expect(readdirSync(home).sort()).toEqual(names);
    expect(tree(home)).toBe(before);
    conn.close();
    expect(p.available).toBe(true);
    expect(p.stage1[0]).toMatchObject({ threadId: 't1', slug: 'slug-1', usageCount: 3, selectedForPhase2: true });
    expect(JSON.stringify(p)).not.toContain('SECRET');
    expect(p.jobs[0]).toMatchObject({ status: 'done' });
  });

  it('reports missing database as unavailable', () => {
    expect(new CodexMemoryReader(tmp()).pipeline().available).toBe(false);
  });

  it('reads only the two memory switches from config.toml', () => {
    const home = tmp();
    writeFileSync(join(home, 'config.toml'), 'model = "x"\n[memories]\ngenerate_memories = true\nuse_memories = false\n[desktop]\nfoo = 1\n');
    expect(readCodexMemorySwitches(home)).toEqual({ generate: true, use: false });
    expect(readCodexMemorySwitches(tmp())).toEqual({ generate: null, use: null });
  });

  it('detects the startup injection', () => {
    const line = JSON.stringify({ timestamp: '2026-10-27T09:46:47.723Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: 'MEMORY_SUMMARY below' }] } });
    expect(scanCodexInjection(`{"x":1}\n${line}`)).toEqual({ at: '2026-10-27T09:46:47.723Z' });
    expect(scanCodexInjection('{"payload":{"role":"user","text":"MEMORY_SUMMARY"}}')).toBeNull();
  });
});

describe('snapshot diff', () => {
  const snap = (entries: Array<[string, string, 'ok' | 'too-large']>, status: 'ready' | 'not-found' = 'ready') => ({
    version: 1 as const, runtime: 'codex' as const, scopeKey: 'global', project: null, capturedAt: 'x', status, notes: [],
    entries: entries.map(([id, hash, state]) => ({ id, path: id, section: 'memory' as const, title: id, description: null, kind: null, content: hash, hash, truncated: false, state, mtime: null }))
  });
  it('reports add / update / delete, ignores unreadable entries and a vanished directory', () => {
    const a = snap([['a', '1', 'ok'], ['b', '1', 'ok'], ['c', '1', 'ok']]);
    const b = snap([['a', '2', 'ok'], ['c', '1', 'ok'], ['d', '1', 'ok']]);
    expect(diffNativeSnapshots(a, b).map(d => `${d.kind}:${(d.entry ?? d.previous)!.id}`).sort()).toEqual(['add:d', 'delete:b', 'update:a']);
    expect(diffNativeSnapshots(a, snap([], 'not-found'))).toEqual([]);
    const big = snap([['a', '', 'too-large'], ['b', '1', 'ok'], ['c', '1', 'ok']]);
    expect(diffNativeSnapshots(a, big)).toEqual([]);
    expect(carryUnreadable(a, big).entries[0]!.hash).toBe('1');
  });
});

describe('never writes to the observed trees', () => {
  it('native sources import no filesystem write primitives', () => {
    const dir = new URL('../src/native/', import.meta.url);
    const forbidden = /\b(writeFileSync|appendFileSync|unlinkSync|renameSync|mkdirSync|chmodSync|utimesSync|symlinkSync|truncateSync|writeSync|createWriteStream|rmSync|copyFileSync|mkdtempSync|rmdirSync)\b/;
    for (const f of readdirSync(dir)) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      expect(text, f).not.toMatch(/child_process|execFile|spawn\(|git /);
      if (f === 'codex.ts') {
        // the only writes: a private temp copy of the pipeline database, never inside the observed tree
        const used = new Set(text.match(new RegExp(forbidden.source, 'g')));
        expect([...used].sort()).toEqual(['copyFileSync', 'mkdtempSync', 'rmSync']);
        expect(text).toContain("mkdtempSync(join(this.tmpRoot, 'pi-agent-codex-mem-'))");
        expect(text).toContain('copyFileSync(db, copy)');
      } else expect(text, f).not.toMatch(forbidden);
    }
  });
});
