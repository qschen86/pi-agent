import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Change feed for the session list. The list is recomputed by the caller; this class only remembers a
 * fingerprint per entry, so any kind of change (status, title, archive, new turn, removal) becomes a
 * numbered change without hooking individual events. A cursor is a signed position and grants nothing:
 * the route still performs the same authorization as the plain directory read.
 */
export interface FeedEntry { id: string; [key: string]: unknown }
export type FeedResponse<E extends FeedEntry> = {
  protocolVersion: 1; epoch: string; cursor: string;
  mode: 'snapshot' | 'delta' | 'unchanged';
  /** Complete ordering of the list; entries not named here have left it. */
  order?: string[];
  /** Full entries that are new or different since the cursor (everything for a snapshot). */
  changed?: E[];
  resetReason?: 'no-cursor' | 'epoch' | 'expired' | 'invalid';
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

export class DirectoryFeed<E extends FeedEntry = FeedEntry> {
  private readonly epoch = randomUUID();
  private readonly signer = randomBytes(32);
  private seq = 0;
  private floor = 0;
  private prints = new Map<string, string>();
  private log: Array<{ seq: number; id: string }> = [];
  constructor(private readonly options: { maxLog?: number } = {}) {}

  private sign(seq: number): string {
    const data = Buffer.from(JSON.stringify({ v: 1, e: this.epoch, s: seq })).toString('base64url');
    return `${data}.${createHmac('sha256', this.signer).update(data).digest('base64url')}`;
  }
  private parse(cursor: string): { seq: number } | 'epoch' | 'invalid' {
    try {
      if (cursor.length > 512) return 'invalid';
      const [data, signature, ...extra] = cursor.split('.');
      if (!data || !signature || extra.length) return 'invalid';
      const expected = createHmac('sha256', this.signer).update(data).digest();
      const given = Buffer.from(signature, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
      const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as { v?: number; e?: string; s?: number };
      if (body.v !== 1 || !Number.isSafeInteger(body.s) || body.s! < 0) return 'invalid';
      return body.e === this.epoch ? { seq: body.s! } : 'epoch';
    } catch { return 'invalid'; }
  }
  /** Record what changed between the previous list and this one. */
  private observe(entries: E[]): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.id);
      const print = digest(entry);
      if (this.prints.get(entry.id) !== print) { this.prints.set(entry.id, print); this.log.push({ seq: ++this.seq, id: entry.id }); }
    }
    for (const id of [...this.prints.keys()]) if (!seen.has(id)) { this.prints.delete(id); this.log.push({ seq: ++this.seq, id }); }
    const max = this.options.maxLog ?? 5000;
    if (this.log.length > max) { const dropped = this.log.splice(0, this.log.length - max); this.floor = dropped.at(-1)!.seq; }
  }
  read(cursor: string | undefined, entries: E[]): FeedResponse<E> {
    this.observe(entries);
    const now = this.sign(this.seq), order = entries.map(e => e.id);
    const snapshot = (resetReason: FeedResponse<E>['resetReason']): FeedResponse<E> =>
      ({ protocolVersion: 1, epoch: this.epoch, cursor: now, mode: 'snapshot', order, changed: entries, resetReason });
    if (!cursor) return snapshot('no-cursor');
    const parsed = this.parse(cursor);
    if (parsed === 'epoch' || parsed === 'invalid') return snapshot(parsed);
    if (parsed.seq > this.seq || parsed.seq < this.floor) return snapshot('expired');
    if (parsed.seq === this.seq) return { protocolVersion: 1, epoch: this.epoch, cursor: now, mode: 'unchanged' };
    const ids = new Set(this.log.filter(item => item.seq > parsed.seq).map(item => item.id));
    const byId = new Map(entries.map(e => [e.id, e] as const));
    return { protocolVersion: 1, epoch: this.epoch, cursor: now, mode: 'delta', order, changed: [...ids].flatMap(id => byId.get(id) ?? []) };
  }
}
