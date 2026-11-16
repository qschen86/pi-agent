import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';
import type { MemoryEntry } from '../index.js';
import type { NativeMemoryEntry, NativeSection } from './types.js';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const eventId = (...parts: Array<string | number | null | undefined>): string =>
  sha256(parts.map(p => String(p ?? '')).join('\u0000')).slice(0, 32);

export const MAX_ENTRY_BYTES = 256 * 1024;
export const MAX_CONTENT_CHARS = 64 * 1024;

export type StableRead =
  | { kind: 'ok'; text: string; fingerprint: string }
  | { kind: 'too-large'; size: number; fingerprint: string }
  | { kind: 'unstable' }
  | { kind: 'missing' };

export const fileFingerprint = (path: string): string | null => {
  try {
    const s = statSync(path);
    return `${s.dev}:${s.ino}:${s.size}:${Math.trunc(s.mtimeMs)}`;
  } catch { return null; }
};

/**
 * 只读且稳定地读一个文件：前后 stat 不一致（对方正在写）就重读一次，仍不稳定则放弃，
 * 绝不把半份内容当成变动。以 O_RDONLY 打开，不写、不改时间戳。
 */
export function readStable(path: string, maxBytes = MAX_ENTRY_BYTES): StableRead {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      const before = fstatSync(fd);
      const fp = `${before.dev}:${before.ino}:${before.size}:${Math.trunc(before.mtimeMs)}`;
      if (!before.isFile()) return { kind: 'missing' };
      if (before.size > maxBytes) return { kind: 'too-large', size: before.size, fingerprint: fp };
      const buf = Buffer.alloc(before.size);
      let off = 0;
      while (off < buf.length) {
        const n = readSync(fd, buf, off, buf.length - off, off);
        if (n === 0) break;
        off += n;
      }
      const after = fstatSync(fd);
      if (off !== before.size || after.size !== before.size || Math.trunc(after.mtimeMs) !== Math.trunc(before.mtimeMs)) continue;
      return { kind: 'ok', text: buf.toString('utf8'), fingerprint: fp };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unstable' };
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  return { kind: 'unstable' };
}

/** 读文件开头至多 maxBytes（原生会话记录的注入记录都在开头）。 */
export function readHead(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.toString('utf8', 0, off);
  } catch { return null; } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** realpath 后必须仍在 root 之内（防 symlink 逃逸）；root 本身不存在返回 null。 */
export function realWithin(root: string, path: string): string | null {
  try {
    const r = realpathSync(root), p = realpathSync(path);
    return p === r || p.startsWith(r + sep) ? p : null;
  } catch { return null; }
}

export function clipContent(text: string): { content: string; truncated: boolean } {
  return text.length > MAX_CONTENT_CHARS ? { content: text.slice(0, MAX_CONTENT_CHARS), truncated: true } : { content: text, truncated: false };
}

export function makeEntry(input: {
  id: string; path: string; section: NativeSection; title: string; description?: string | null; kind?: string | null;
  text: string; mtime?: string | null;
}): NativeMemoryEntry {
  const { content, truncated } = clipContent(input.text);
  return {
    id: input.id, path: input.path, section: input.section, title: input.title,
    description: input.description ?? null, kind: input.kind ?? null,
    content, hash: sha256(input.text), truncated, state: 'ok', mtime: input.mtime ?? null
  };
}

/** 无法读取（过大 / 正在变化）的条目：保留身份，不伪造内容，也不参与差异。 */
export function unreadableEntry(input: { id: string; path: string; section: NativeSection; title: string; state: 'too-large' | 'unstable'; mtime?: string | null }): NativeMemoryEntry {
  return { id: input.id, path: input.path, section: input.section, title: input.title, description: null, kind: null, content: '', hash: '', truncated: false, state: input.state, mtime: input.mtime ?? null };
}

export const asMemoryEntry = (e: { id: string; project: string | null; target: string; category: string | null; content: string; created: string }): MemoryEntry => ({
  id: e.id, project: e.project, target: e.target, category: e.category, content: e.content,
  failure_reason: null, tool_state: null, corrected_to: null, created: e.created
});
