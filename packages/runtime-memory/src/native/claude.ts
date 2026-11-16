/** Claude Code auto memory：~/.claude/projects/<项目路径转义>/memory/（MEMORY.md 索引 + 主题 .md）。只读。 */
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileFingerprint, makeEntry, readHead, readStable, realWithin, unreadableEntry } from './common.js';
import type { NativeMemoryEntry, NativeMemorySnapshot } from './types.js';

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const CLAUDE_INDEX = 'MEMORY.md';

export interface ClaudeMemoryProject { key: string; label: string; dir: string }

export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string => env['CLAUDE_CONFIG_DIR'] || join(home, '.claude');

/** 「-Users-kisen-Documents-pi-agent」→「Documents-pi-agent」：转义是有损的，只用作展示。 */
export const claudeProjectLabel = (key: string): string => key.replace(/^-Users-[^-]+-/, '').replace(/^-+/, '') || key;

export function listClaudeMemoryProjects(configDir = claudeConfigDir()): ClaudeMemoryProject[] {
  const root = join(configDir, 'projects');
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const out: ClaudeMemoryProject[] = [];
  for (const key of names.sort()) {
    const dir = join(root, key, 'memory');
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      if (readdirSync(dir).some(f => f.endsWith('.md'))) out.push({ key, label: claudeProjectLabel(key), dir });
    } catch { /* 没有记忆目录 */ }
  }
  return out;
}

/** 项目键只允许目录名本身，避免路径穿越。 */
export const validClaudeProjectKey = (key: string): boolean => /^[A-Za-z0-9._-]{1,300}$/.test(key) && key !== '.' && key !== '..';

export function claudeMemoryDir(key: string, configDir = claudeConfigDir()): string | null {
  if (!validClaudeProjectKey(key)) return null;
  const dir = join(configDir, 'projects', key, 'memory');
  return existsSync(dir) ? dir : null;
}

export function parseFrontmatter(text: string): { name: string | null; description: string | null; type: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { name: null, description: null, type: null, body: text };
  const field = (key: string): string | null => {
    const r = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm').exec(m[1]!);
    return r ? r[1]!.replace(/^["']|["']$/g, '') : null;
  };
  return { name: field('name'), description: field('description'), type: field('type'), body: text.slice(m[0].length) };
}

/** MEMORY.md 里指向的主题文件：`- [标题](file.md) — 说明` */
export const indexLinks = (text: string): string[] => [...text.matchAll(/\]\(([^)\s]+\.md)\)/g)].map(m => m[1]!).filter(f => !f.includes('/') && !f.includes('..'));

interface CacheItem { fingerprint: string; entry: NativeMemoryEntry }

/** 按文件身份缓存：文件没变就不重读（大目录反复解析会拖住事件循环）。 */
export class ClaudeMemoryReader {
  private cache = new Map<string, CacheItem>();
  constructor(private readonly now = () => new Date()) {}

  read(project: ClaudeMemoryProject): NativeMemorySnapshot {
    const capturedAt = this.now().toISOString();
    const base = { version: 1 as const, runtime: 'claude-code' as const, scopeKey: project.key, project: project.label, capturedAt };
    const notes: string[] = [];
    let names: string[];
    try { names = readdirSync(project.dir).filter(f => f.endsWith('.md')).sort(); } catch { return { ...base, status: 'not-found', entries: [], notes }; }
    if (names.length > MAX_FILES) { notes.push(`记忆文件超过 ${MAX_FILES} 个，只读取前 ${MAX_FILES} 个`); names = names.slice(0, MAX_FILES); }
    const entries: NativeMemoryEntry[] = [];
    let total = 0;
    const seen = new Set<string>();
    for (const name of names) {
      const path = join(project.dir, name);
      // 记忆目录里的 symlink 不跟随（防读到目录之外）
      if (!realWithin(project.dir, path) || lstatSync(path).isSymbolicLink()) continue;
      seen.add(path);
      const fp = fileFingerprint(path);
      const cached = this.cache.get(path);
      let entry: NativeMemoryEntry | undefined;
      if (cached && fp && cached.fingerprint === fp) entry = cached.entry;
      else {
        const r = readStable(path);
        const isIndex = name === CLAUDE_INDEX;
        const mtime = (() => { try { return statSync(path).mtime.toISOString(); } catch { return null; } })();
        if (r.kind === 'missing') continue;
        if (r.kind === 'ok') {
          const fm = parseFrontmatter(r.text);
          entry = makeEntry({
            id: name, path: name, section: isIndex ? 'index' : 'topic',
            title: isIndex ? '记忆索引 MEMORY.md' : fm.name || basename(name, '.md'),
            description: fm.description, kind: fm.type, text: r.text, mtime
          });
          this.cache.set(path, { fingerprint: r.fingerprint, entry });
        } else {
          entry = unreadableEntry({ id: name, path: name, section: isIndex ? 'index' : 'topic', title: basename(name, '.md'), state: r.kind === 'too-large' ? 'too-large' : 'unstable', mtime });
          if (r.kind === 'too-large') notes.push(`${name} 过大，未读取正文`);
        }
      }
      total += entry.content.length;
      if (total > MAX_TOTAL_BYTES) { notes.push('记忆总量过大，已停止读取'); break; }
      entries.push(entry);
    }
    for (const key of [...this.cache.keys()]) if (!seen.has(key) && key.startsWith(project.dir)) this.cache.delete(key);
    const index = entries.find(e => e.section === 'index');
    if (index?.state === 'ok') {
      const files = new Set(entries.map(e => e.path));
      const missing = indexLinks(index.content).filter(f => !files.has(f));
      if (missing.length) notes.push(`索引指向但文件不存在：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}`);
    }
    return { ...base, status: 'ready', entries, notes };
  }
}

export interface ClaudeInjection { at: string | null; path: string; lines: number; bytes: number; key: string }

/**
 * 会话启动时注入的 auto memory：原生记录里 `attachment.type=instructions`、`files[].type=AutoMem`。
 * 只在传入的文本（会话记录开头）里找；格式不认识就返回空，不报错。
 */
export function scanClaudeInjections(headText: string): ClaudeInjection[] {
  const out: ClaudeInjection[] = [];
  const seen = new Set<string>();
  for (const line of headText.split('\n')) {
    if (!line.includes('AutoMem')) continue;
    let o: { timestamp?: string; uuid?: string; attachment?: { type?: string; files?: Array<{ path?: string; type?: string; content?: string }> } };
    try { o = JSON.parse(line); } catch { continue; }
    if (o.attachment?.type !== 'instructions') continue;
    for (const f of o.attachment.files ?? []) {
      if (f.type !== 'AutoMem' || typeof f.path !== 'string') continue;
      const key = `${o.uuid ?? o.timestamp ?? out.length}|${f.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const content = typeof f.content === 'string' ? f.content : '';
      out.push({ at: o.timestamp ?? null, path: f.path, lines: content ? content.split('\n').filter(Boolean).length : 0, bytes: Buffer.byteLength(content), key });
    }
  }
  return out;
}

/** 原生会话记录路径：<配置目录>/projects/<任意项目键>/<nativeSessionId>.jsonl，realpath 后必须在 projects 之内。 */
export function findClaudeTranscript(nativeSessionId: string, configDir = claudeConfigDir()): string | null {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(nativeSessionId)) return null;
  const root = join(configDir, 'projects');
  let names: string[];
  try { names = readdirSync(root); } catch { return null; }
  for (const key of names) {
    const file = join(root, key, `${nativeSessionId}.jsonl`);
    if (existsSync(file)) return realWithin(root, file);
  }
  return null;
}

export function claudeInjectionsForSession(nativeSessionId: string, configDir = claudeConfigDir()): ClaudeInjection[] {
  const file = findClaudeTranscript(nativeSessionId, configDir);
  if (!file) return [];
  // 注入记录在会话开头；只读开头 1 MiB，不整文件解析
  const head = readHead(file, 1024 * 1024);
  return head ? scanClaudeInjections(head) : [];
}
