/**
 * 产物分享链接：把某个产物（小游戏）分享给控制台之外的人。
 *
 *  - 只有控制台主人能创建（管理接口在 /api 下，受控制台登录与 Cloudflare Access 保护）
 *  - 访问需要主人创建时设定的密码；服务端只存 scrypt 哈希
 *  - 被分享人不能再分享：他只拿到这一个产物，看不到控制台；而且链接绑定设备——
 *    输对密码的前 maxDevices 台设备（默认 1 台）拿到设备凭据，之后别的设备即使有链接和密码也打不开
 *  - 主人可以撤销链接、重置设备绑定；可设有效期
 *
 * 部署期间蓝绿两个槽位会同时运行：每次读写都直接读盘，不在内存里缓存状态。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface ShareDevice { tokenHash: string; firstAt: string; lastAt: string; userAgent: string }

export interface ArtifactShare {
  id: string;
  artifactId: string;
  label: string;
  /** scrypt$<salt>$<hash>（base64url） */
  passwordHash: string;
  /**
   * 明文密码，只为了主人自己再复制一条带密码的邀请链接（/share/<id>/?pw=）。
   * 文件权限 0600；读接口 /api/artifact-shares 只在控制台登录后可用。
   * 这次改动之前创建的分享没有这个字段，只能重新生成一条。
   */
  password?: string;
  createdAt: string;
  expiresAt: string | null;
  maxDevices: number;
  devices: ShareDevice[];
  revokedAt?: string;
  opens: number;
  lastOpenAt?: string;
  /** 最近的密码错误时间（用于限流），只留窗口内的 */
  failures: number[];
  /** 已绑满设备后，又有新设备输对密码的次数——说明链接被转发了 */
  blockedDevices: number;
}

export type SharePublic = Omit<ArtifactShare, "passwordHash" | "devices" | "failures"> & {
  devices: Array<Omit<ShareDevice, "tokenHash">>;
  status: "active" | "revoked" | "expired";
};

export type UnlockResult =
  | { ok: true; token: string; share: ArtifactShare }
  | { ok: false; reason: "not-found" | "wrong-password" | "locked" | "device-limit"; retryAfterSec?: number };

export const SHARE_ID_RE = /^[A-Za-z0-9_-]{20,40}$/;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60_000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function checkPassword(password: string, stored: string): boolean {
  const [kind, salt, key] = stored.split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

export class ShareInputError extends Error {}

export class ArtifactShares {
  private memory: Record<string, ArtifactShare> = {};

  constructor(private readonly file?: string, private readonly now: () => number = Date.now) {}

  private load(): Record<string, ArtifactShare> {
    if (!this.file) return this.memory;
    if (!existsSync(this.file)) return {};
    try { return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, ArtifactShare>; } catch { return {}; }
  }

  private save(all: Record<string, ArtifactShare>): void {
    if (!this.file) { this.memory = all; return; }
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private mutate<T>(fn: (all: Record<string, ArtifactShare>) => T): T {
    const all = this.load();
    const out = fn(all);
    this.save(all);
    return out;
  }

  private statusOf(s: ArtifactShare): SharePublic["status"] {
    if (s.revokedAt) return "revoked";
    if (s.expiresAt && Date.parse(s.expiresAt) <= this.now()) return "expired";
    return "active";
  }

  toPublic(s: ArtifactShare): SharePublic {
    const { passwordHash: _p, failures: _f, devices, ...rest } = s;
    return { ...rest, devices: devices.map(({ tokenHash: _t, ...d }) => d), status: this.statusOf(s) };
  }

  create(input: { artifactId: string; password: string; label?: string; expiresInDays?: number | null; maxDevices?: number }): ArtifactShare {
    const password = String(input.password ?? "");
    if (password.length < 4 || password.length > 64) throw new ShareInputError("密码需要 4～64 个字符");
    const maxDevices = input.maxDevices ?? 1;
    if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 5) throw new ShareInputError("可用设备数只能是 1～5");
    const days = input.expiresInDays ?? null;
    if (days !== null && (!Number.isFinite(days) || days <= 0 || days > 365)) throw new ShareInputError("有效期只能是 1～365 天，或不限");
    const now = this.now();
    const share: ArtifactShare = {
      id: randomBytes(18).toString("base64url"),
      artifactId: input.artifactId,
      label: String(input.label ?? "").trim().slice(0, 40),
      password,
      passwordHash: hashPassword(password),
      createdAt: new Date(now).toISOString(),
      expiresAt: days === null ? null : new Date(now + days * 86400_000).toISOString(),
      maxDevices,
      devices: [],
      opens: 0,
      failures: [],
      blockedDevices: 0,
    };
    this.mutate((all) => { all[share.id] = share; });
    return share;
  }

  list(artifactId?: string): SharePublic[] {
    return Object.values(this.load())
      .filter((s) => !artifactId || s.artifactId === artifactId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => this.toPublic(s));
  }

  /** 可访问的分享（没撤销、没过期） */
  get(id: string): ArtifactShare | null {
    if (!SHARE_ID_RE.test(id)) return null;
    const s = this.load()[id];
    return s && this.statusOf(s) === "active" ? s : null;
  }

  revoke(id: string): boolean {
    return this.mutate((all) => {
      const s = all[id];
      if (!s || s.revokedAt) return false;
      s.revokedAt = new Date(this.now()).toISOString();
      return true;
    });
  }

  /** 解除所有设备绑定：已绑定的设备需要重新输密码，先输对的设备重新占名额 */
  resetDevices(id: string): boolean {
    return this.mutate((all) => {
      const s = all[id];
      if (!s) return false;
      s.devices = [];
      s.blockedDevices = 0;
      return true;
    });
  }

  remove(id: string): boolean {
    return this.mutate((all) => {
      if (!all[id]) return false;
      delete all[id];
      return true;
    });
  }

  /** 这台设备有没有已绑定的凭据 */
  authorize(id: string, token: string | undefined): ArtifactShare | null {
    if (!token || token.length > 200) return null;
    const share = this.get(id);
    if (!share) return null;
    const h = sha(token);
    const device = share.devices.find((d) => d.tokenHash === h);
    if (!device) return null;
    // 最后使用时间每分钟最多写一次
    if (this.now() - Date.parse(device.lastAt) > 60_000) {
      this.mutate((all) => {
        const d = all[id]?.devices.find((x) => x.tokenHash === h);
        if (d) d.lastAt = new Date(this.now()).toISOString();
      });
    }
    return share;
  }

  /** 记一次打开（进入游戏首页） */
  touchOpen(id: string): void {
    this.mutate((all) => {
      const s = all[id];
      if (!s) return;
      s.opens += 1;
      s.lastOpenAt = new Date(this.now()).toISOString();
    });
  }

  unlock(id: string, password: string, userAgent: string): UnlockResult {
    if (!this.get(id)) return { ok: false, reason: "not-found" };
    return this.mutate((all): UnlockResult => {
      const s = all[id]!;
      const now = this.now();
      s.failures = (s.failures ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
      if (s.failures.length >= MAX_FAILURES) {
        return { ok: false, reason: "locked", retryAfterSec: Math.ceil((s.failures[0]! + FAILURE_WINDOW_MS - now) / 1000) };
      }
      if (!checkPassword(String(password ?? "").slice(0, 200), s.passwordHash)) {
        s.failures.push(now);
        return { ok: false, reason: "wrong-password" };
      }
      s.failures = [];
      if (s.devices.length >= s.maxDevices) {
        s.blockedDevices = (s.blockedDevices ?? 0) + 1;
        return { ok: false, reason: "device-limit" };
      }
      const token = randomBytes(32).toString("base64url");
      const at = new Date(now).toISOString();
      s.devices.push({ tokenHash: sha(token), firstAt: at, lastAt: at, userAgent: userAgent.replace(/\s+/g, " ").slice(0, 160) });
      return { ok: true, token, share: s };
    });
  }
}
