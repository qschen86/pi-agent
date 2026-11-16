import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuthSessions } from './auth-sessions.js';
import { withAuthFileLock } from './auth-file-lock.js';
export interface PairView { pairId: string; deviceName: string; userCode: string; expiresAt: number }
export type ExchangeResult = { state: 'pending' | 'expired-or-consumed' } | { state: 'ready'; token: string; sessionId: string; expiresAt: string };
interface PairRecord extends PairView { proofHash: string; approvedBy?: string }
interface Store { pairs: Record<string, PairRecord>; starts: Array<{ sourceHash: string; at: number }> }
export class PairingError extends Error {
 constructor(public readonly status: 400 | 403 | 410 | 429, public readonly code: string) { super(code); }
}
export class DevicePairing {
 constructor(private readonly opts: { file: string; auth: AuthSessions }) { mkdirSync(dirname(opts.file), { recursive: true, mode: 0o700 }); }
 private transaction<T>(operation: (store: Store) => T): T {
  return withAuthFileLock(this.opts.file, () => {
   const s: Store = existsSync(this.opts.file) ? JSON.parse(readFileSync(this.opts.file, 'utf8')) as Store : { pairs: {}, starts: [] };
   const now = Date.now();
   for (const [id, p] of Object.entries(s.pairs)) if (p.expiresAt <= now) delete s.pairs[id];
   s.starts = s.starts.filter(x => x.at > now - 60_000);
   const result = operation(s);
   const tmp = `${this.opts.file}.tmp-${process.pid}`;
   writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); renameSync(tmp, this.opts.file);
   return result;
  });
 }
 start(input: { deviceName: string; proofHash: string }, source: string): PairView {
  if (typeof input.deviceName !== 'string' || !input.deviceName.trim() || input.deviceName.length > 80 || /[\x00-\x1f\x7f]/.test(input.deviceName) || !/^[a-f0-9]{64}$/.test(input.proofHash)) throw new PairingError(400, 'PAIR_INPUT');
  return this.transaction(s => {
   const sourceHash = createHash('sha256').update(source).digest('hex');
   if (Object.keys(s.pairs).length >= 100 || s.starts.filter(x => x.sourceHash === sourceHash).length >= 5) throw new PairingError(429, 'PAIR_LIMIT');
   const p: PairRecord = { pairId: randomBytes(16).toString('hex'), deviceName: input.deviceName.trim(), proofHash: input.proofHash, userCode: String(randomInt(1_000_000)).padStart(6, '0'), expiresAt: Date.now() + 300_000 };
   s.pairs[p.pairId] = p; s.starts.push({ sourceHash, at: Date.now() });
   return this.publicView(p);
  });
 }
 private publicView(p: PairRecord): PairView { return { pairId: p.pairId, deviceName: p.deviceName, userCode: p.userCode, expiresAt: p.expiresAt }; }
 view(id: string): PairView | undefined { return this.transaction(s => s.pairs[id] ? this.publicView(s.pairs[id]!) : undefined); }
 approve(id: string, browserSessionId: string): void {
  this.transaction(s => {
   const p = s.pairs[id]; if (!p) throw new PairingError(410, 'PAIR_EXPIRED');
   if (!this.opts.auth.isActive(browserSessionId)) throw new PairingError(403, 'PAIR_BROWSER_REQUIRED');
   p.approvedBy ??= browserSessionId;
  });
 }
 exchange(id: string, proof: string): ExchangeResult {
  if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof)) throw new PairingError(403, 'PAIR_PROOF');
  return this.transaction(s => {
   const p = s.pairs[id]; if (!p) return { state: 'expired-or-consumed' };
   const hash = createHash('sha256').update(proof).digest();
   if (!timingSafeEqual(hash, Buffer.from(p.proofHash, 'hex'))) throw new PairingError(403, 'PAIR_PROOF');
   if (!p.approvedBy) return { state: 'pending' };
   if (!this.opts.auth.isActive(p.approvedBy)) { delete s.pairs[id]; return { state: 'expired-or-consumed' }; }
   const { token, record } = this.opts.auth.issue(`Android: ${p.deviceName}`, "device");
   delete s.pairs[id];
   return { state: 'ready', token, sessionId: record.id, expiresAt: record.expiresAt };
  });
 }
}
