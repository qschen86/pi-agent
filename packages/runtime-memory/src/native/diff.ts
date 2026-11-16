import type { NativeMemoryEntry, NativeMemorySnapshot } from './types.js';

export interface NativeDelta { kind: 'add' | 'update' | 'delete'; entry: NativeMemoryEntry | null; previous: NativeMemoryEntry | null }

/**
 * 两份快照的差异。无法读取（过大 / 正在变化）的条目不参与：既不算删除也不算修改，
 * 目录整体消失（not-found）也不产生删除——避免把一次读取失败记成「全部被删」。
 */
export function diffNativeSnapshots(previous: NativeMemorySnapshot, next: NativeMemorySnapshot): NativeDelta[] {
  if (previous.status !== 'ready' || next.status !== 'ready') return [];
  const before = new Map(previous.entries.map(e => [e.id, e]));
  const after = new Map(next.entries.map(e => [e.id, e]));
  const out: NativeDelta[] = [];
  for (const [id, e] of after) {
    const p = before.get(id);
    if (e.state !== 'ok') continue;
    if (!p) out.push({ kind: 'add', entry: e, previous: null });
    else if (p.state === 'ok' && p.hash !== e.hash) out.push({ kind: 'update', entry: e, previous: p });
  }
  for (const [id, p] of before) if (!after.has(id) && p.state === 'ok') out.push({ kind: 'delete', entry: null, previous: p });
  return out;
}

/** 不可读条目沿用上一份快照里的版本，这样它恢复可读时能比较出真实变化。 */
export function carryUnreadable(previous: NativeMemorySnapshot | null, next: NativeMemorySnapshot): NativeMemorySnapshot {
  if (!previous || previous.status !== 'ready') return next;
  const before = new Map(previous.entries.map(e => [e.id, e]));
  return { ...next, entries: next.entries.map(e => (e.state !== 'ok' && before.get(e.id)?.state === 'ok' ? before.get(e.id)! : e)) };
}
