import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * "Last ended turn I have read" per session, shared by the phone and the desktop. A read position only
 * moves forward, so merging two devices is simply taking the larger number: no conflicts, any order.
 */
export class ReadState {
  private turns: Record<string, number> = {};
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try { const saved = JSON.parse(readFileSync(file, 'utf8')) as { turns?: Record<string, number> }; this.merge(saved.turns ?? {}, false); } catch { /* start empty */ }
    }
  }
  snapshot(): Record<string, number> { return { ...this.turns }; }
  /** Returns true when anything advanced. Unknown shapes are ignored rather than trusted. */
  merge(input: unknown, persist = true): boolean {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    let changed = false;
    for (const [id, value] of Object.entries(input as Record<string, unknown>).slice(0, 1000)) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1e9) continue;
      if ((this.turns[id] ?? -1) < (value as number)) { this.turns[id] = value as number; changed = true; }
    }
    const ids = Object.keys(this.turns);
    if (ids.length > 2000) { for (const id of ids.slice(0, ids.length - 2000)) delete this.turns[id]; changed = true; }
    if (changed && persist) this.save();
    return changed;
  }
  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, turns: this.turns }), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch { /* the in-memory state still serves this process */ }
  }
}
