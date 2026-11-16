/**
 * 对外登录的服务端会话（V2.8 §8 公网启用条件）。
 *
 * 以前的凭据由密码派生、固定不变：cookie 有 Max-Age，但服务端无法让某一个登录过期或单独吊销。
 * 现在每次登录发一个随机 token，服务端只存它的哈希、签发时间、到期时间与吊销时间：
 *   - 绝对期限（默认 30 天）与闲置期限（默认 7 天）到了即失效
 *   - 可以单独吊销某个登录，不影响其他有效登录；改密码让全部登录失效
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { withAuthFileLock } from './auth-file-lock.js';

export interface AuthSessionRecord {
  id: string;
  tokenHash: string;
  /** 签发时的密码指纹：改密码后旧登录全部失效 */
  passwordTag: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string;
  revokeReason?: string;
  userAgent: string;
  kind?: "browser" | "device";
}

export type AuthFailureReason = "no-cookie" | "malformed" | "unknown" | "unknown-in-memory" | "revoked" | "password-changed" | "expired" | "idle";

export interface AuthSessionOptions { file?: string; ttlMs?: number; idleMs?: number; password: string }

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const DEVICE_WINDOW_MS = 90 * 24 * 3600_000;

export class AuthSessions {
  private records: Record<string, AuthSessionRecord> = {};
  private readonly ttlMs: number;
  private readonly idleMs: number;
  private readonly passwordTag: string;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: AuthSessionOptions) {
    this.ttlMs = opts.ttlMs ?? 30 * 24 * 3600_000;
    this.idleMs = opts.idleMs ?? 7 * 24 * 3600_000;
    this.passwordTag = hash(`pi-agent-password-tag|${opts.password}`).slice(0, 16);
    if (opts.file && existsSync(opts.file)) {
      try { this.records = JSON.parse(readFileSync(opts.file, "utf8")) as Record<string, AuthSessionRecord>; } catch { this.records = {}; }
    }
  }

  get maxAgeSeconds(): number { return Math.floor(this.ttlMs / 1000); }

  issue(userAgent: string, kind: "browser" | "device" = "browser"): { token: string; record: AuthSessionRecord } {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const record: AuthSessionRecord = {
      id: `ls-${randomUUID().slice(0, 12)}`, tokenHash: hash(token), passwordTag: this.passwordTag,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + (kind === 'device' ? DEVICE_WINDOW_MS : this.ttlMs)).toISOString(), lastSeenAt: new Date(now).toISOString(),
      kind, userAgent: userAgent.slice(0, 160)
    };
    this.records[record.id] = record;
    this.prune();
    this.save(true);
    return { token, record };
  }

  /** 有效则返回记录并刷新最后使用时间；过期、闲置超时、吊销、改过密码都返回 undefined */
  check(token: string | undefined): AuthSessionRecord | undefined {
    const result = this.inspect(token);
    return result.ok ? result.record : undefined;
  }

  /** Device traffic must observe credentials issued/revoked in the other serving slot. */
  inspectFresh(token: string | undefined): ReturnType<AuthSessions['inspect']> {
    if (this.opts.file) {
      try {
        this.records = JSON.parse(readFileSync(this.opts.file, 'utf8')) as Record<string, AuthSessionRecord>;
      } catch { return { ok: false, reason: 'unknown' }; }
    }
    return this.inspect(token);
  }

  /** 同 check，但失败时说明原因（只用于诊断日志，不含 token） */
  inspect(token: string | undefined): { ok: true; record: AuthSessionRecord } | { ok: false; reason: AuthFailureReason; id?: string } {
    if (!token) return { ok: false, reason: "no-cookie" };
    if (token.length > 200) return { ok: false, reason: "malformed" };
    const h = hash(token);
    const r = Object.values(this.records).find((x) => x.tokenHash === h);
    if (!r) return { ok: false, reason: this.opts.file && this.knownOnDisk(h) ? "unknown-in-memory" : "unknown" };
    if (r.revokedAt) return { ok: false, reason: "revoked", id: r.id };
    if (r.passwordTag !== this.passwordTag) return { ok: false, reason: "password-changed", id: r.id };
    const now = Date.now();
    if (Date.parse(r.expiresAt) <= now) return { ok: false, reason: "expired", id: r.id };
    if (Date.parse(r.lastSeenAt) + (r.kind === 'device' ? DEVICE_WINDOW_MS : this.idleMs) <= now) return { ok: false, reason: "idle", id: r.id };
    // 最后使用时间每分钟最多落盘一次
    if (now - Date.parse(r.lastSeenAt) > 60_000) { r.lastSeenAt = new Date(now).toISOString(); this.save(false); }
    return { ok: true, record: r };
  }

  /** 内存里没有、磁盘上却有：说明另一个进程（如部署时的另一槽位）在本进程读盘后签发了它 */
  private knownOnDisk(tokenHash: string): boolean {
    try {
      const disk = JSON.parse(readFileSync(this.opts.file!, "utf8")) as Record<string, AuthSessionRecord>;
      return Object.values(disk).some((x) => x.tokenHash === tokenHash);
    } catch { return false; }
  }

  revoke(id: string, reason: string): boolean {
    if (this.opts.file) this.inspectFresh(undefined);
    const r = this.records[id];
    if (!r || r.revokedAt) return false;
    r.revokedAt = new Date().toISOString();
    r.revokeReason = reason;
    this.save(true);
    return true;
  }

  /** Explicit foreground renewal. Stable identity keeps push bindings and revocation intact. */
  renewDevice(id: string): AuthSessionRecord | undefined {
    const renew = () => {
      if (this.opts.file) this.records = JSON.parse(readFileSync(this.opts.file, 'utf8')) as Record<string, AuthSessionRecord>;
      const r = this.records[id], now = Date.now();
      if (!r || r.kind !== 'device' || r.revokedAt || r.passwordTag !== this.passwordTag ||
          Date.parse(r.expiresAt) <= now || Date.parse(r.lastSeenAt) + DEVICE_WINDOW_MS <= now) return undefined;
      r.expiresAt = new Date(now + DEVICE_WINDOW_MS).toISOString(); r.lastSeenAt = new Date(now).toISOString();
      if (this.opts.file) {
        const temp = `${this.opts.file}.renew-${process.pid}`;
        writeFileSync(temp, JSON.stringify(this.records, null, 1), {mode: 0o600}); renameSync(temp, this.opts.file);
      }
      return {...r};
    };
    return this.opts.file ? withAuthFileLock(this.opts.file, renew) : renew();
  }

  /** Background delivery must validate a login without extending its idle lifetime. */
  isActive(id: string): boolean {
    let r = this.records[id];
    if (this.opts.file && existsSync(this.opts.file)) {
      try {
        const disk = JSON.parse(readFileSync(this.opts.file, "utf8")) as Record<string, AuthSessionRecord>;
        const saved = disk[id];
        if (!saved || saved.revokedAt) return false;
        r = r && Date.parse(r.lastSeenAt) > Date.parse(saved.lastSeenAt) ? r : saved;
      } catch { return false; }
    }
    const now = Date.now();
    return !!r && !r.revokedAt && r.passwordTag === this.passwordTag && Date.parse(r.expiresAt) > now && Date.parse(r.lastSeenAt) + (r.kind === 'device' ? DEVICE_WINDOW_MS : this.idleMs) > now;
  }

  revokeOthers(keepId: string): number {
    if (this.opts.file) this.inspectFresh(undefined);
    let n = 0;
    for (const r of Object.values(this.records)) if (r.id !== keepId && !r.revokedAt) { r.revokedAt = new Date().toISOString(); r.revokeReason = "在别处退出其他登录"; n++; }
    this.save(true);
    return n;
  }

  list(): Array<Omit<AuthSessionRecord, "tokenHash" | "passwordTag"> & { active: boolean }> {
    if (this.opts.file) this.inspectFresh(undefined);
    const now = Date.now();
    return Object.values(this.records).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map(({ tokenHash: _t, passwordTag, ...r }) => ({
      ...r, active: !r.revokedAt && passwordTag === this.passwordTag && Date.parse(r.expiresAt) > now && Date.parse(r.lastSeenAt) + (r.kind === 'device' ? DEVICE_WINDOW_MS : this.idleMs) > now
    }));
  }

  /** 只留近 90 天的记录（含已吊销的，作审计） */
  private prune(): void {
    const cutoff = Date.now() - 90 * 24 * 3600_000;
    for (const [id, r] of Object.entries(this.records)) if (Date.parse(r.expiresAt) < cutoff) delete this.records[id];
  }

  private save(now: boolean): void {
    if (!this.opts.file) return;
    this.dirty = true;
    const write = () => {
      this.flushTimer = undefined;
      if (!this.dirty || !this.opts.file) return;
      this.dirty = false;
      withAuthFileLock(this.opts.file, () => {
        const disk = existsSync(this.opts.file!) ? JSON.parse(readFileSync(this.opts.file!, 'utf8')) as Record<string, AuthSessionRecord> : {};
        for (const [id, incoming] of Object.entries(this.records)) {
          const old = disk[id];
          // Revocations are monotonic; a stale slot must never resurrect one.
          disk[id] = old?.revokedAt ? old : { ...incoming, ...(old && Date.parse(old.lastSeenAt) > Date.parse(incoming.lastSeenAt) ? { lastSeenAt: old.lastSeenAt } : {}), ...(old?.kind === 'device' && Date.parse(old.expiresAt) > Date.parse(incoming.expiresAt) ? {expiresAt: old.expiresAt} : {}) };
        }
        this.records = disk;
        this.prune();
        const tmp = `${this.opts.file}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(this.records, null, 1), { mode: 0o600 });
        renameSync(tmp, this.opts.file!);
      });
    };
    if (now) { if (this.flushTimer) clearTimeout(this.flushTimer); write(); }
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        try { write(); }
        catch {
          // A last-seen update is best effort. Issue/revoke still fail synchronously.
          this.dirty = true;
          console.error('登录活动时间暂未保存，将在后续访问重试');
        }
      }, 5000);
      this.flushTimer.unref();
    }
  }
}
