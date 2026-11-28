import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { generateStaticKeyPair, normalizeDomainOrigin, validateRelayUrl } from "../../../packages/remote-link/src/index.js";
import { withAuthFileLock } from "./auth-file-lock.js";

export const DEFAULT_OFFICIAL_RELAY_URL = "wss://relay.heji.pro";

export function defaultOfficialRelayUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["PI_REMOTE_DEFAULT_RELAY_URL"]?.trim();
  if (!raw) return DEFAULT_OFFICIAL_RELAY_URL;
  try {
    return validateRelayUrl(raw, env["PI_REMOTE_ALLOW_LOCAL_RELAY"] === "1");
  } catch {
    return DEFAULT_OFFICIAL_RELAY_URL;
  }
}

/** 旧版官方中继域名：已配对的设备仍按「公共中继」展示。 */
const LEGACY_OFFICIAL_RELAY_HOST = "heji-relay.example-user.workers.dev";

export function isOfficialRelayUrl(relayUrl: string, defaultRelayUrl: string): boolean {
  const hostOf = (u: string) => u.replace(/^wss?:\/\//i, "").split("/")[0]!.toLowerCase();
  const host = hostOf(relayUrl);
  return host === hostOf(defaultRelayUrl) || host === LEGACY_OFFICIAL_RELAY_HOST || host.endsWith(".heji-relay.workers.dev");
}

/** 用户保存的线路：自建中继（wss 地址）或自有域名（https 实例地址）。公共中继是内置线路，不入表。 */
export interface SavedRoute {
  id: string;
  type: "custom_relay" | "domain";
  name: string;
  url: string;
}

/** 最近一次实测的通道质量，离线后仍保留，列表里显示「最近」的网速。 */
export interface DeviceQuality {
  rttMs?: number;
  kbps?: number;
  pathKind?: "lan" | "p2p" | "relay";
  at: string;
}

export type QualityTier = "good" | "fair" | "poor" | "unknown";

/** 档位以延迟为主；实测吞吐低于 100 KB/s 再降一档。没有任何数据时是 unknown。 */
export function qualityTier(q: Pick<DeviceQuality, "rttMs" | "kbps"> | undefined): QualityTier {
  if (!q || (q.rttMs === undefined && q.kbps === undefined)) return "unknown";
  const order: QualityTier[] = ["good", "fair", "poor"];
  let level = q.rttMs === undefined ? 1 : q.rttMs < 150 ? 0 : q.rttMs < 400 ? 1 : 2;
  if (q.kbps !== undefined && q.kbps < 100) level = Math.min(2, level + 1);
  return order[level]!;
}

export interface RemoteDeviceRecord {
  id: string;
  name: string;
  platform: string;
  clientPublicKeyHex: string;
  roomSeedHex: string;
  relayUrl: string;
  /** 手机 App 的稳定安装标识：同一台手机重新配对只更新这一条，不新增记录。 */
  installId?: string;
  authSessionId?: string;
  deviceToken?: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
  lastQuality?: DeviceQuality;
}

export interface RemoteDevicePublicView {
  id: string;
  name: string;
  platform: string;
  relayUrl: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
  online: boolean;
  pathKind?: "lan" | "p2p" | "relay";
  /** 公共中继当日用量；自建中继没有限额，为 { kind: "unlimited" }；还没查到时缺省。 */
  usage?: RelayUsageView;
  /** 线路类型：公共中继 / 自建中继 / 自有域名。 */
  route: "public_relay" | "custom_relay" | "domain";
  /** 中继或域名的主机名，列表副标题用。 */
  routeHost?: string;
  quality?: DeviceQuality & { tier: QualityTier };
  /** 同一台手机的其他线路/历史会话都算这一行；撤销时整组一起失效。 */
  memberIds: string[];
  /** 这台手机现有的线路列表（公共中继 / 自建中继 / 自有域名），列表副标题用。 */
  routes: Array<{ route: "public_relay" | "custom_relay" | "domain"; online: boolean; lastSeenAt: string }>;
  /** 手机安装标识（不含密钥）；旧记录没有。 */
  installId?: string;
}

export type RelayUsageView =
  | {
      kind: "limited";
      day: string;
      dayBytes: number;
      dayFrames: number;
      dailyRoomBytes: number;
      dailyRoomFrames: number;
      blocked: boolean;
      resetAt: number;
    }
  | { kind: "unlimited" };

export interface RemoteConnectConfig {
  enabled: boolean;
  relayMode: "official" | "custom";
  customRelayUrl: string;
  hostName: string;
  routes: SavedRoute[];
  /** 历史重复设备清理跑过的版本号：1 = 已把旧版本产生的重复记录收完。 */
  cleanupVersion?: number;
}

interface StoredState {
  version: 1;
  hostPrivateKeyHex: string;
  hostPublicKeyHex: string;
  config: RemoteConnectConfig;
  devices: Record<string, RemoteDeviceRecord>;
}

export class RemoteConnectStore {
  private readonly allowLocalRelay: boolean;
  private readonly officialRelayUrl: string;

  constructor(
    private readonly file: string,
    opts: { allowLocalRelay?: boolean; officialRelayUrl?: string } = {},
  ) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.allowLocalRelay = opts.allowLocalRelay ?? process.env["PI_REMOTE_ALLOW_LOCAL_RELAY"] === "1";
    this.officialRelayUrl = opts.officialRelayUrl ?? defaultOfficialRelayUrl();
  }

  get defaultRelayUrl(): string {
    return this.officialRelayUrl;
  }

  get allowsLocalRelay(): boolean {
    return this.allowLocalRelay;
  }

  private transaction<T>(op: (state: StoredState) => T): T {
    return withAuthFileLock(this.file, () => {
      let state: StoredState;
      let mutated = false;
      if (existsSync(this.file)) {
        try {
          state = JSON.parse(readFileSync(this.file, "utf8")) as StoredState;
        } catch {
          state = this.createInitialState();
          mutated = true;
        }
      } else {
        state = this.createInitialState();
        mutated = true;
      }
      const before = JSON.stringify(state);
      this.normalize(state);
      const result = op(state);
      const after = JSON.stringify(state);
      if (mutated || before !== after) {
        const tmp = `${this.file}.tmp-${process.pid}`;
        writeFileSync(tmp, after, { mode: 0o600 });
        renameSync(tmp, this.file);
      }
      return result;
    });
  }

  /** 旧版本只有一条 customRelayUrl：并入线路表，老用户的自建线路不丢。 */
  private normalize(state: StoredState): void {
    const cfg = state.config;
    if (!Array.isArray(cfg.routes)) cfg.routes = [];
    if (typeof cfg.cleanupVersion !== "number") cfg.cleanupVersion = 0;
    if (cfg.customRelayUrl && !cfg.routes.some((r) => r.type === "custom_relay" && r.url === cfg.customRelayUrl)) {
      cfg.routes.push({ id: `rt-${randomUUID().slice(0, 8)}`, type: "custom_relay", name: routeNameOf(cfg.customRelayUrl), url: cfg.customRelayUrl });
    }
  }

  private createInitialState(): StoredState {
    const kp = generateStaticKeyPair();
    return {
      version: 1,
      hostPrivateKeyHex: Buffer.from(kp.privateKey).toString("hex"),
      hostPublicKeyHex: Buffer.from(kp.publicKey).toString("hex"),
      config: {
        enabled: false,
        relayMode: "official",
        customRelayUrl: "",
        hostName: hostname().replace(/\.local$/, "").slice(0, 60) || "Heji Mac",
        routes: [],
        cleanupVersion: 0,
      },
      devices: {},
    };
  }

  readState(): StoredState {
    return this.transaction((s) => structuredClone(s));
  }

  effectiveRelayUrl(config?: RemoteConnectConfig): string {
    const cfg = config ?? this.readState().config;
    if (cfg.relayMode === "custom" && cfg.customRelayUrl.trim()) {
      return validateRelayUrl(cfg.customRelayUrl.trim(), this.allowLocalRelay);
    }
    return this.officialRelayUrl;
  }

  updateConfig(patch: Partial<RemoteConnectConfig>): RemoteConnectConfig {
    return this.transaction((s) => {
      if (typeof patch.enabled === "boolean") s.config.enabled = patch.enabled;
      if (patch.relayMode === "official" || patch.relayMode === "custom") {
        s.config.relayMode = patch.relayMode;
      }
      if (typeof patch.customRelayUrl === "string") {
        const trimmed = patch.customRelayUrl.trim();
        if (trimmed) {
          s.config.customRelayUrl = validateRelayUrl(trimmed, this.allowLocalRelay);
        } else {
          s.config.customRelayUrl = "";
        }
      }
      if (s.config.relayMode === "custom" && !s.config.customRelayUrl) {
        throw new Error("请先填写有效的自建 Relay 地址（wss://）");
      }
      if (typeof patch.hostName === "string") {
        const trimmed = patch.hostName.trim();
        if (!trimmed || trimmed.length > 60 || /[\x00-\x1f\x7f]/.test(trimmed)) {
          throw new Error("设备名称无效");
        }
        s.config.hostName = trimmed;
      }
      if (typeof patch.cleanupVersion === "number" && Number.isFinite(patch.cleanupVersion)) {
        s.config.cleanupVersion = patch.cleanupVersion;
      }
      return structuredClone(s.config);
    });
  }

  addRoute(input: { type: "custom_relay" | "domain"; url: string; name?: string }): SavedRoute {
    return this.transaction((s) => {
      const url = input.type === "domain" ? normalizeDomainOrigin(input.url, this.allowLocalRelay) : validateRelayUrl(input.url.trim(), this.allowLocalRelay);
      const existing = s.config.routes.find((r) => r.type === input.type && r.url === url);
      if (existing) return structuredClone(existing);
      if (s.config.routes.length >= 20) throw new Error("线路太多了，请先移除不用的");
      const name = (input.name ?? "").trim().slice(0, 40);
      if (/[\x00-\x1f\x7f]/.test(name)) throw new Error("线路名称无效");
      const route: SavedRoute = { id: `rt-${randomUUID().slice(0, 8)}`, type: input.type, name: name || routeNameOf(url), url };
      s.config.routes.push(route);
      return structuredClone(route);
    });
  }

  removeRoute(routeId: string): boolean {
    return this.transaction((s) => {
      const idx = s.config.routes.findIndex((r) => r.id === routeId);
      if (idx < 0) return false;
      const [removed] = s.config.routes.splice(idx, 1);
      // 旧字段同步清掉，否则下次读取会把它当「老线路」重新并回来。
      if (removed!.type === "custom_relay" && s.config.customRelayUrl === removed!.url) {
        s.config.customRelayUrl = "";
        if (s.config.relayMode === "custom") s.config.relayMode = "official";
      }
      return true;
    });
  }

  findRoute(routeId: string): SavedRoute | null {
    const r = this.readState().config.routes.find((x) => x.id === routeId);
    return r ? structuredClone(r) : null;
  }

  recordQuality(deviceId: string, quality: DeviceQuality): void {
    this.transaction((s) => {
      const d = s.devices[deviceId];
      if (!d || d.revokedAt) return;
      d.lastQuality = { ...d.lastQuality, ...quality };
    });
  }

  addDevice(input: {
    name: string;
    platform: string;
    clientPublicKeyHex: string;
    roomSeedHex: string;
    relayUrl: string;
    installId?: string;
    authSessionId?: string;
    deviceToken?: string;
  }): { record: RemoteDeviceRecord; created: boolean } {
    return this.transaction((s) => {
      const now = new Date().toISOString();
      const name = input.name.trim().slice(0, 80) || "Android 设备";
      const platform = input.platform.trim().slice(0, 32) || "android";
      // 同一台手机重新配对：优先按安装标识，其次按客户端公钥。只合并还活着的记录，
      // 已撤销的保留在历史里（重新配对等于重新授权，不能偷偷复活）。
      const active = Object.values(s.devices).filter((d) => !d.revokedAt);
      const existing =
        (input.installId ? active.find((d) => d.installId === input.installId) : undefined) ??
        active.find((d) => d.clientPublicKeyHex === input.clientPublicKeyHex);
      if (existing) {
        existing.name = name;
        existing.platform = platform;
        existing.clientPublicKeyHex = input.clientPublicKeyHex;
        existing.roomSeedHex = input.roomSeedHex;
        existing.relayUrl = input.relayUrl;
        existing.lastSeenAt = now;
        if (input.installId) existing.installId = input.installId;
        if (input.authSessionId) existing.authSessionId = input.authSessionId;
        if (input.deviceToken) existing.deviceToken = input.deviceToken;
        return { record: structuredClone(existing), created: false };
      }
      const id = `rd-${randomUUID().slice(0, 12)}`;
      const record: RemoteDeviceRecord = {
        id,
        name,
        platform,
        clientPublicKeyHex: input.clientPublicKeyHex,
        roomSeedHex: input.roomSeedHex,
        relayUrl: input.relayUrl,
        ...(input.installId ? { installId: input.installId } : {}),
        ...(input.authSessionId ? { authSessionId: input.authSessionId } : {}),
        ...(input.deviceToken ? { deviceToken: input.deviceToken } : {}),
        createdAt: now,
        lastSeenAt: now,
      };
      s.devices[id] = record;
      return { record: structuredClone(record), created: true };
    });
  }

  touchDevice(deviceId: string): void {
    this.transaction((s) => {
      const d = s.devices[deviceId];
      if (!d || d.revokedAt) return;
      const now = Date.now();
      if (now - Date.parse(d.lastSeenAt) > 30_000) {
        d.lastSeenAt = new Date(now).toISOString();
      }
    });
  }

  findActiveByPublicKey(pubKeyHex: string): RemoteDeviceRecord | null {
    const s = this.readState();
    for (const d of Object.values(s.devices)) {
      if (!d.revokedAt && d.clientPublicKeyHex === pubKeyHex) return d;
    }
    return null;
  }

  revokeDevice(deviceId: string): RemoteDeviceRecord | null {
    return this.transaction((s) => {
      const d = s.devices[deviceId];
      if (!d || d.revokedAt) return null;
      d.revokedAt = new Date().toISOString();
      delete d.deviceToken;
      return structuredClone(d);
    });
  }

  activeDevices(): RemoteDeviceRecord[] {
    return Object.values(this.readState().devices).filter((d) => !d.revokedAt);
  }

  /** 按 id 批量撤销（同一台手机的重复记录/历史会话一起失效）。 */
  revokeDevices(deviceIds: readonly string[]): RemoteDeviceRecord[] {
    return this.transaction((s) => {
      const now = new Date().toISOString();
      const revoked: RemoteDeviceRecord[] = [];
      for (const id of deviceIds) {
        const d = s.devices[id];
        if (!d || d.revokedAt) continue;
        d.revokedAt = now;
        delete d.deviceToken;
        revoked.push(structuredClone(d));
      }
      return revoked;
    });
  }

  allDevices(): RemoteDeviceRecord[] {
    return Object.values(this.readState().devices).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

function routeNameOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "").slice(0, 40);
}
