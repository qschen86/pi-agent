import { randomBytes, randomUUID } from "node:crypto";
import {
  createEncryptedFrameLink,
  createPairingQrPayload,
  DEFAULT_STUN_SERVERS,
  deriveRoomSeed,
  type DirectPathKind,
  createRoomTicket,
  encodeDomainQr,
  encodePairingQr,
  MacRemoteAdapter,
  type NoiseChannel,
  NoiseHandshake,
  parseP2pControlMessage,
  type RelayConnectionState,
  RelayWebSocketLink,
  renderQrSvg,
  validateRelayUrl,
  WebRtcDirectLink,
  x25519DH,
} from "../../../packages/remote-link/src/index.js";
import type { AuthSessions } from "./auth-sessions.js";
import { normalizeDeviceId } from "./auth-sessions.js";
import {
  isOfficialRelayUrl,
  qualityTier,
  type RemoteConnectConfig,
  RemoteConnectStore,
  type RelayUsageView,
  type RemoteDevicePublicView,
  type RemoteDeviceRecord,
  type SavedRoute,
} from "./remote-connect-store.js";

export type RemoteConnectionUiState = "lan" | "p2p" | "relay" | "recovering" | "quota_exceeded" | "offline";

export interface ActivePairingView {
  pairId: string;
  status: "waiting_scan" | "awaiting_approval" | "approved" | "rejected" | "expired";
  qrText: string;
  qrSvg: string;
  relayUrl: string;
  expiresAt: number;
  deviceName?: string;
  platform?: string;
  safetyCode?: string;
}

interface PairingAttempt {
  pairId: string;
  status: ActivePairingView["status"];
  qrText: string;
  qrSvg: string;
  relayUrl: string;
  expiresAt: number;
  psk: Uint8Array;
  link: RelayWebSocketLink;
  timer: ReturnType<typeof setTimeout>;
  handshake: NoiseHandshake | null;
  channel: NoiseChannel | null;
  clientPublicKey?: Uint8Array;
  deviceName?: string;
  platform?: string;
  /** 手机安装标识：同一台手机重新配对时用它认人，避免列表里多一条设备。 */
  installId?: string;
  safetyCode?: string;
}

interface LiveDeviceTunnel {
  deviceId: string;
  relayUrl: string;
  link: RelayWebSocketLink;
  state: RelayConnectionState;
  peerOnline: boolean;
  channel: NoiseChannel | null;
  adapter: MacRemoteAdapter | null;
  unsubscribeData: (() => void) | null;
  directAttemptId: string | null;
  directLink: WebRtcDirectLink | null;
  directChannel: NoiseChannel | null;
  directAdapter: MacRemoteAdapter | null;
  directActive: boolean;
  directPathKind: DirectPathKind | null;
  pendingDirectIce: Array<{ candidate: string; mid: string }>;
  /** 最近几次往返延迟（毫秒）与最近一次大响应的传输速率；设备端不回 rtt_pong 时一直为空。 */
  rtts: number[];
  kbps: number | null;
  rttSeq: number;
  pendingRtt: Map<number, { sentAt: number; path: "lan" | "p2p" | "relay" }>;
  lastRttPath: "lan" | "p2p" | "relay" | null;
  lastQualityPersistAt: number;
}

/** 自有域名方式添加的手机在认证记录里的 userAgent 前缀（见 DevicePairing.exchange）。 */
const DOMAIN_DEVICE_UA_PREFIX = "Android: ";
/** 自有域名设备没有常驻通道，最近 2.5 分钟内有请求就算在线（认证记录每分钟最多刷新一次）。 */
const DOMAIN_DEVICE_ONLINE_MS = 150_000;
const RTT_KEEP = 5;
const QUALITY_PERSIST_MS = 120_000;
const DOMAIN_QR_TTL_MS = 300_000;

export interface DomainQrView {
  origin: string;
  qrText: string;
  qrSvg: string;
  expiresAt: number;
}

export interface RemoteConnectStatusSnapshot {
  enabled: boolean;
  relayMode: "official" | "custom";
  customRelayUrl: string;
  routes: SavedRoute[];
  effectiveRelayUrl: string;
  defaultRelayUrl: string;
  hostName: string;
  connectionState: RemoteConnectionUiState;
  connectionLabel: string;
  quotaNotice?: string;
  devices: RemoteDevicePublicView[];
  activePairing: ActivePairingView | null;
}

export interface RemoteConnectServiceOptions {
  store: RemoteConnectStore;
  /** Local Hono base URL, e.g. http://127.0.0.1:8788 */
  targetOrigin: string;
  auth?: AuthSessions;
  fetchImpl?: typeof fetch;
  pingIntervalMs?: number;
  iceServers?: readonly string[];
  /** 通道延迟探测间隔，默认 30 秒；0 关闭（测试用）。 */
  rttIntervalMs?: number;
}

const STATE_LABELS: Record<RemoteConnectionUiState, string> = {
  lan: "局域网直连",
  p2p: "P2P 直连",
  relay: "加密中继",
  recovering: "正在恢复",
  quota_exceeded: "今日额度已用完",
  offline: "离线",
};

/**
 * Coordinates Mac-side Remote Connect lifecycle (V1.2 §4.3–§4.5):
 * - One-time 10-minute QR pairing over Relay (Noise IKpsk2 + 6-digit safety code approval)
 * - Persistent per-device Relay rooms (Noise IK + MacRemoteAdapter -> local Hono)
 * - P2 WebRTC DataChannel NAT traversal (Cloudflare STUN + independent Noise IK + non-freezing stream switching)
 * - Immediate disconnect and AuthSessions revocation when a device is revoked
 */
export class RemoteConnectService {
  private readonly tunnels = new Map<string, LiveDeviceTunnel>();
  private activePairing: PairingAttempt | null = null;
  private closed = false;
  private readonly usageCache = new Map<string, { at: number; value: RelayUsageView | null; inflight: boolean }>();
  private rttTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: RemoteConnectServiceOptions) {
    this.cleanupDuplicateDevices();
    this.syncTunnels();
    const interval = options.rttIntervalMs ?? 30_000;
    if (interval > 0) {
      this.rttTimer = setInterval(() => this.probeAllRtt(), interval);
      this.rttTimer.unref?.();
    }
  }

  get store(): RemoteConnectStore {
    return this.options.store;
  }

  /**
   * 手机在列表里只应该出现一次：同一台手机（同一个安装标识）重新配对只更新原记录，
   * 中继记录与自有域名会话也按同一身份合并成一行。旧版本没存安装标识的按「名称 + 平台」归并。
   */
  private deviceIdentityKey(r: { name: string; platform: string; installId?: string }): string {
    return r.installId ? `install:${r.installId}` : `name:${r.name.trim().toLowerCase()}|${r.platform.trim().toLowerCase()}`;
  }

  private relayDeviceView(d: RemoteDeviceRecord): RemoteDevicePublicView {
    const t = this.tunnels.get(d.id);
    const online = Boolean(t?.peerOnline || t?.directActive);
    const pathKind: "lan" | "p2p" | "relay" | undefined = !online
      ? undefined
      : t?.directActive
        ? (t.directPathKind ?? "p2p")
        : "relay";
    const quality = this.qualityView(t, d);
    return {
      id: d.id,
      name: d.name,
      platform: d.platform,
      relayUrl: d.relayUrl,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      ...(d.revokedAt ? { revokedAt: d.revokedAt } : {}),
      online,
      ...(pathKind ? { pathKind } : {}),
      ...(d.revokedAt ? {} : this.usageFor(d)),
      route: isOfficialRelayUrl(d.relayUrl, this.options.store.defaultRelayUrl) ? "public_relay" : "custom_relay",
      routeHost: d.relayUrl.replace(/^wss?:\/\//i, "").split("/")[0],
      ...(quality ? { quality } : {}),
      memberIds: [d.id],
      routes: [{ route: isOfficialRelayUrl(d.relayUrl, this.options.store.defaultRelayUrl) ? "public_relay" : "custom_relay", online, lastSeenAt: d.lastSeenAt }],
      ...(d.installId ? { installId: d.installId } : {}),
    };
  }

  /** 把同一台手机的多条记录（中继记录 + 自有域名会话）合并成一行，撤销时整组失效。 */
  private mergeDeviceRows(rows: RemoteDevicePublicView[]): RemoteDevicePublicView[] {
    const groups = new Map<string, RemoteDevicePublicView[]>();
    for (const row of rows) {
      const key = this.deviceIdentityKey(row);
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
    const merged = [...groups.values()].map((members) => {
      if (members.length === 1) return members[0]!;
      // 主记录：优先有常驻通道的中继记录（它就是那台「已配对的设备」），再按最近活跃。
      const primary = [...members].sort((a, b) => {
        const ar = a.route === "domain" ? 1 : 0, br = b.route === "domain" ? 1 : 0;
        if (ar !== br) return ar - br;
        return b.lastSeenAt.localeCompare(a.lastSeenAt);
      })[0]!;
      const byRoute = new Map<RemoteDevicePublicView["routes"][number]["route"], RemoteDevicePublicView["routes"][number]>();
      for (const m of members) {
        for (const r of m.routes) {
          const known = byRoute.get(r.route);
          if (!known || r.lastSeenAt > known.lastSeenAt) byRoute.set(r.route, r);
        }
      }
      const routes = [...byRoute.values()].map((r) => ({ ...r, online: members.some((m) => m.routes.some((x) => x.route === r.route && x.online)) }));
      const installId = members.find((m) => m.installId)?.installId;
      return {
        ...primary,
        online: members.some((m) => m.online),
        lastSeenAt: members.reduce((max, m) => (m.lastSeenAt > max ? m.lastSeenAt : max), primary.lastSeenAt),
        createdAt: members.reduce((min, m) => (m.createdAt < min ? m.createdAt : min), primary.createdAt),
        memberIds: members.flatMap((m) => m.memberIds),
        routes,
        ...(installId ? { installId } : {}),
      };
    });
    return merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  status(): RemoteConnectStatusSnapshot {
    const state = this.options.store.readState();
    const effectiveRelayUrl = this.options.store.effectiveRelayUrl(state.config);
    const active: RemoteDevicePublicView[] = [];
    const revoked: RemoteDevicePublicView[] = [];
    for (const d of this.options.store.allDevices()) {
      const view = this.relayDeviceView(d);
      (d.revokedAt ? revoked : active).push(view);
    }
    active.push(...this.domainDevices());
    const devices: RemoteDevicePublicView[] = [...this.mergeDeviceRows(active), ...revoked];

    const connectionState = this.computeConnectionState(state.config.enabled);
    return {
      enabled: state.config.enabled,
      relayMode: state.config.relayMode,
      customRelayUrl: state.config.customRelayUrl,
      routes: state.config.routes,
      effectiveRelayUrl,
      defaultRelayUrl: this.options.store.defaultRelayUrl,
      hostName: state.config.hostName,
      connectionState,
      connectionLabel: STATE_LABELS[connectionState],
      ...(connectionState === "quota_exceeded"
        ? { quotaNotice: "公共中继今日免费额度（150 MB / 20,000 帧）已用完，次日 UTC 0 点自动重置；可切换到自建中继或自有域名线路。" }
        : {}),
      devices,
      activePairing: this.pairingView(),
    };
  }

  /**
   * 中继当日用量（每台设备一个房间）。状态接口是同步的，所以只读缓存；缓存过期就后台刷新，
   * 设置页本来每几秒轮询一次，下一次就能看到。公共中继返回限额与已用，自建中继没有这个接口，显示「无限额」。
   */
  private usageFor(d: { id: string; relayUrl: string; roomSeedHex: string }): { usage?: RelayUsageView } {
    const now = Date.now();
    const entry = this.usageCache.get(d.id);
    if (!entry || (now - entry.at > 30_000 && !entry.inflight)) {
      const slot = entry ?? { at: 0, value: null, inflight: false };
      slot.inflight = true;
      this.usageCache.set(d.id, slot);
      void this.fetchRelayUsage(d).then(
        (value) => { slot.value = value ?? slot.value; slot.at = Date.now(); slot.inflight = false; },
        () => { slot.at = Date.now(); slot.inflight = false; },
      );
    }
    return entry?.value ? { usage: entry.value } : {};
  }

  private async fetchRelayUsage(d: { relayUrl: string; roomSeedHex: string }): Promise<RelayUsageView | null> {
    const ticket = createRoomTicket(Buffer.from(d.roomSeedHex, "hex"));
    const base = d.relayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "");
    const url = `${base}/room/${ticket.roomId}/usage?period=${ticket.period}&credential=${ticket.credential}`;
    const res = await (this.options.fetchImpl ?? globalThis.fetch)(url, { signal: AbortSignal.timeout(8_000) });
    // 自建中继（Node 版）没有用量接口，也没有每日限额。
    if (res.status === 404 || res.status === 426) return { kind: "unlimited" };
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    if (typeof j["dailyRoomBytes"] !== "number" || typeof j["dailyRoomFrames"] !== "number") return { kind: "unlimited" };
    return {
      kind: "limited",
      day: String(j["day"] ?? ""),
      dayBytes: num(j["dayBytes"]),
      dayFrames: num(j["dayFrames"]),
      dailyRoomBytes: num(j["dailyRoomBytes"]),
      dailyRoomFrames: num(j["dailyRoomFrames"]),
      blocked: j["blocked"] === true,
      resetAt: num(j["resetAt"]),
    };
  }

  updateConfig(patch: Partial<RemoteConnectConfig>): RemoteConnectStatusSnapshot {
    this.options.store.updateConfig(patch);
    if (patch.enabled === false) {
      this.cancelActivePairing("rejected");
    }
    this.syncTunnels();
    return this.status();
  }

  /** 自有域名线路：二维码只带实例根地址，手机扫码后走原有的设备批准流程（电脑端核对六位码）。 */
  startDomainQr(origin: string): DomainQrView {
    const qrText = encodeDomainQr(origin, this.options.store.allowsLocalRelay);
    return {
      origin: qrText.slice("heji-domain:".length),
      qrText,
      qrSvg: renderQrSvg(qrText),
      expiresAt: Date.now() + DOMAIN_QR_TTL_MS,
    };
  }

  /** @param requestedRelayUrl 本次配对使用的中继地址；缺省沿用「高级设置」里的默认线路。 */
  startPairing(requestedRelayUrl?: string): ActivePairingView {
    if (this.closed) throw new Error("remote_connect_closed");
    const state = this.options.store.readState();
    if (!state.config.enabled) {
      this.options.store.updateConfig({ enabled: true });
    }
    this.cancelActivePairing("rejected");

    const freshState = this.options.store.readState();
    const relayUrl = requestedRelayUrl ? validateRelayUrl(requestedRelayUrl, this.options.store.allowsLocalRelay) : this.options.store.effectiveRelayUrl(freshState.config);
    const hostPub = Buffer.from(freshState.hostPublicKeyHex, "hex");
    const hostPriv = Buffer.from(freshState.hostPrivateKeyHex, "hex");
    const psk = new Uint8Array(randomBytes(32));

    const payload = createPairingQrPayload({
      relayUrl,
      hostPublicKey: hostPub,
      hostName: freshState.config.hostName,
      psk,
      allowLocalRelay: this.options.store.allowsLocalRelay,
    });
    const qrText = encodePairingQr(payload, this.options.store.allowsLocalRelay);
    const qrSvg = renderQrSvg(qrText);
    const pairId = `pair-${randomUUID().slice(0, 12)}`;
    const pairSeed = deriveRoomSeed(psk, Buffer.from("heji-pair-room-v1", "utf8"));

    const link = new RelayWebSocketLink({
      relayUrl,
      role: "host",
      roomSeed: pairSeed,
      pingIntervalMs: this.options.pingIntervalMs,
    });

    const timer = setTimeout(() => {
      if (this.activePairing?.pairId === pairId && this.activePairing.status !== "approved") {
        this.cancelActivePairing("expired");
      }
    }, Math.max(1000, payload.expiresAt - Date.now()));

    const attempt: PairingAttempt = {
      pairId,
      status: "waiting_scan",
      qrText,
      qrSvg,
      relayUrl,
      expiresAt: payload.expiresAt,
      psk,
      link,
      timer,
      handshake: null,
      channel: null,
    };
    this.activePairing = attempt;

    link.onFrame((frame) => {
      if (this.activePairing !== attempt || attempt.status !== "waiting_scan") return;
      try {
        const hs = new NoiseHandshake({
          role: "responder",
          staticPrivateKey: hostPriv,
          psk: attempt.psk,
        });
        const clientPayloadRaw = hs.readMessage(frame);
        let deviceName = "Android 设备";
        let platform = "android";
        let installId: string | undefined;
        if (clientPayloadRaw.length > 0) {
          const parsed = JSON.parse(Buffer.from(clientPayloadRaw).toString("utf8")) as {
            deviceName?: unknown;
            platform?: unknown;
            installId?: unknown;
          };
          if (typeof parsed.deviceName === "string" && parsed.deviceName.trim()) {
            deviceName = parsed.deviceName.trim().slice(0, 80);
          }
          if (typeof parsed.platform === "string" && parsed.platform.trim()) {
            platform = parsed.platform.trim().slice(0, 32);
          }
          installId = normalizeDeviceId(parsed.installId);
        }
        const m2 = hs.writeMessage(Buffer.from(JSON.stringify({ hostName: freshState.config.hostName }), "utf8"));
        const channel = hs.finish();
        attempt.handshake = hs;
        attempt.channel = channel;
        attempt.clientPublicKey = new Uint8Array(channel.remoteStaticPublicKey);
        attempt.deviceName = deviceName;
        attempt.platform = platform;
        if (installId) attempt.installId = installId;
        attempt.safetyCode = channel.safetyCode();
        attempt.status = "awaiting_approval";
        link.send(m2);
      } catch {
        // Invalid pairing handshake frame: ignore and keep waiting until expiry.
      }
    });

    this.syncTunnels();
    return this.pairingView()!;
  }

  approvePairing(pairId: string): RemoteDevicePublicView {
    const attempt = this.activePairing;
    if (!attempt || attempt.pairId !== pairId) {
      throw new Error("配对会话不存在或已过期");
    }
    if (attempt.status !== "awaiting_approval" || !attempt.channel || !attempt.clientPublicKey) {
      throw new Error("请先用手机扫码并核对六位安全码");
    }

    const state = this.options.store.readState();
    const hostPriv = Buffer.from(state.hostPrivateKeyHex, "hex");
    const staticShared = x25519DH(hostPriv, attempt.clientPublicKey);
    const roomSeed = deriveRoomSeed(staticShared);
    staticShared.fill(0);

    let authSessionId: string | undefined;
    let deviceToken: string | undefined;
    const installId = attempt.installId;
    const clientPublicKeyHex = Buffer.from(attempt.clientPublicKey).toString("hex");
    if (this.options.auth) {
      // 同一台手机重新配对：沿用原来的设备登录会话（只换令牌），不新增一条登录记录。
      const existing = this.options.store
        .activeDevices()
        .find((d) => (installId ? d.installId === installId : d.clientPublicKeyHex === clientPublicKeyHex));
      const current =
        existing?.authSessionId && this.options.auth.isActive(existing.authSessionId) ? existing.authSessionId : undefined;
      const userAgent = `Remote: ${attempt.deviceName ?? "Android"}`;
      const rotated = current ? this.options.auth.rotateDevice(current, userAgent) : undefined;
      const issued = rotated ?? this.options.auth.issue(userAgent, "device", installId ? { deviceId: installId } : {});
      authSessionId = issued.record.id;
      deviceToken = issued.token;
    }

    const { record: device } = this.options.store.addDevice({
      name: attempt.deviceName ?? "Android 设备",
      platform: attempt.platform ?? "android",
      clientPublicKeyHex,
      roomSeedHex: Buffer.from(roomSeed).toString("hex"),
      relayUrl: attempt.relayUrl,
      ...(installId ? { installId } : {}),
      authSessionId,
      deviceToken,
    });

    // Notify phone over the authenticated pairing Noise channel before tearing down the pairing room.
    try {
      const confirmation = Buffer.from(
        JSON.stringify({
          approved: true,
          deviceId: device.id,
          hostName: state.config.hostName,
          relayUrl: device.relayUrl,
        }),
        "utf8",
      );
      attempt.link.send(attempt.channel.encrypt(confirmation));
    } catch {
      /* client may reconnect directly to the persistent room */
    }

    attempt.status = "approved";
    clearTimeout(attempt.timer);
    attempt.psk.fill(0);
    // Allow confirmation frame to flush before closing pairing WS.
    const toCloseLink = attempt.link;
    const toCloseChannel = attempt.channel;
    setTimeout(() => {
      toCloseChannel.close();
      toCloseLink.close();
    }, 150);
    this.activePairing = null;

    this.syncTunnels();
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      relayUrl: device.relayUrl,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      online: Boolean(this.tunnels.get(device.id)?.peerOnline),
      route: isOfficialRelayUrl(device.relayUrl, this.options.store.defaultRelayUrl) ? "public_relay" : "custom_relay",
      memberIds: [device.id],
      routes: [{ route: isOfficialRelayUrl(device.relayUrl, this.options.store.defaultRelayUrl) ? "public_relay" : "custom_relay", online: Boolean(this.tunnels.get(device.id)?.peerOnline), lastSeenAt: device.lastSeenAt }],
      ...(device.installId ? { installId: device.installId } : {}),
    };
  }

  rejectPairing(pairId: string): void {
    if (this.activePairing?.pairId !== pairId) return;
    this.cancelActivePairing("rejected");
  }

  revokeDevice(deviceId: string): boolean {
    // 自有域名设备没有中继记录，id 是认证会话 id：吊销登录凭据即可。
    const ids = this.deviceGroupIds(deviceId);
    let any = false;
    for (const id of ids) any = this.revokeSingleDevice(id) || any;
    return any;
  }

  /** 同一台手机的整组记录（中继记录 + 自有域名会话），叠删设备时一起失效。 */
  private deviceGroupIds(deviceId: string): string[] {
    const status = this.status();
    const target = status.devices.find((d) => d.memberIds.includes(deviceId) || d.id === deviceId);
    return target ? target.memberIds : [deviceId];
  }

  private revokeSingleDevice(deviceId: string): boolean {
    if (deviceId.startsWith("auth:")) {
      return Boolean(this.options.auth?.revoke(deviceId.slice(5), "domain-device-revoked"));
    }
    const revoked = this.options.store.revokeDevice(deviceId);
    if (!revoked) return false;
    if (revoked.authSessionId && this.options.auth) {
      this.options.auth.revoke(revoked.authSessionId, "remote-device-revoked");
    }
    this.stopTunnel(deviceId);
    return true;
  }

  /**
   * 历史重复记录的清理（A 之前版本每次配对都新建一条，旧数据会堆很多行）：
   * 同一台手机只保留一条最近活跃的中继记录和一条最近活跃的自有域名会话，其余吐销。
   * 只跑一次（cleanupVersion 记在配置里），也可以用接口手动强制重跑。
   */
  cleanupDuplicateDevices(force = false): { relay: string[]; domain: string[]; skipped: boolean } {
    const before = this.options.store.readState().config;
    if (!force && (before.cleanupVersion ?? 0) >= 1) return { relay: [], domain: [], skipped: true };
    const relay: string[] = [];
    const domain: string[] = [];
    const keepNewest = <T extends { lastSeenAt: string }>(items: T[]): T[] =>
      [...items].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(1);

    const activeRelays = this.options.store.activeDevices();
    const relayGroups = new Map<string, typeof activeRelays>();
    for (const d of activeRelays) {
      const key = this.deviceIdentityKey(d);
      const bucket = relayGroups.get(key);
      if (bucket) bucket.push(d);
      else relayGroups.set(key, [d]);
    }
    for (const group of relayGroups.values()) {
      for (const stale of keepNewest(group)) {
        if (this.revokeSingleDevice(stale.id)) relay.push(stale.id);
      }
    }

    const auth = this.options.auth;
    if (auth) {
      const activeDomain = auth
        .list()
        .filter((r) => r.kind === "device" && r.active && (r.userAgent ?? "").startsWith(DOMAIN_DEVICE_UA_PREFIX));
      const domainGroups = new Map<string, typeof activeDomain>();
      for (const r of activeDomain) {
        const key = r.deviceId ? `install:${r.deviceId}` : `name:${(r.userAgent ?? "").toLowerCase()}`;
        const bucket = domainGroups.get(key);
        if (bucket) bucket.push(r);
        else domainGroups.set(key, [r]);
      }
      for (const group of domainGroups.values()) {
        for (const stale of keepNewest(group)) {
          if (auth.revoke(stale.id, "duplicate-device-cleanup")) domain.push(stale.id);
        }
      }
    }

    this.options.store.updateConfig({ cleanupVersion: 1 });
    return { relay, domain, skipped: false };
  }

  addRoute(input: { type: "custom_relay" | "domain"; url: string; name?: string }): SavedRoute {
    return this.options.store.addRoute(input);
  }

  removeRoute(routeId: string): boolean {
    return this.options.store.removeRoute(routeId);
  }

  /** 把已保存线路解析成配对用的中继地址；公共中继用内置地址。 */
  relayUrlForRoute(routeId: string | undefined): string | undefined {
    if (!routeId || routeId === "public") return this.options.store.defaultRelayUrl;
    const route = this.options.store.findRoute(routeId);
    if (!route || route.type !== "custom_relay") throw new Error("线路不存在或不是中继线路");
    return route.url;
  }

  domainUrlForRoute(routeId: string): string {
    const route = this.options.store.findRoute(routeId);
    if (!route || route.type !== "domain") throw new Error("线路不存在或不是自有域名线路");
    return route.url;
  }

  /** 自有域名方式配对的手机：来自认证记录，没有常驻通道，所以没有延迟数据。 */
  private domainDevices(): RemoteDevicePublicView[] {
    const auth = this.options.auth;
    if (!auth) return [];
    const now = Date.now();
    return auth
      .list()
      .filter((r) => r.kind === "device" && r.active && (r.userAgent ?? "").startsWith(DOMAIN_DEVICE_UA_PREFIX))
      .map((r) => {
        const online = now - Date.parse(r.lastSeenAt) < DOMAIN_DEVICE_ONLINE_MS;
        return {
          id: `auth:${r.id}`,
          name: (r.userAgent ?? "").slice(DOMAIN_DEVICE_UA_PREFIX.length) || "Android 设备",
          platform: "android" as const,
          relayUrl: "",
          createdAt: r.createdAt,
          lastSeenAt: r.lastSeenAt,
          online,
          route: "domain" as const,
          memberIds: [`auth:${r.id}`],
          routes: [{ route: "domain" as const, online, lastSeenAt: r.lastSeenAt }],
          ...(r.deviceId ? { installId: r.deviceId } : {}),
        };
      });
  }

  private qualityView(t: LiveDeviceTunnel | undefined, d: RemoteDeviceRecord): RemoteDevicePublicView["quality"] {
    const live = t && (t.rtts.length > 0 || t.kbps !== null) && (t.peerOnline || t.directActive);
    if (live) {
      const sorted = [...t.rtts].sort((a, b) => a - b);
      const rttMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
      const kbps = t.kbps ?? d.lastQuality?.kbps;
      const q = {
        ...(rttMs !== undefined ? { rttMs } : {}),
        ...(kbps !== undefined ? { kbps } : {}),
        ...(t.lastRttPath ? { pathKind: t.lastRttPath } : {}),
        at: new Date().toISOString(),
      };
      return { ...q, tier: qualityTier(q) };
    }
    if (d.lastQuality) return { ...d.lastQuality, tier: qualityTier(d.lastQuality) };
    return undefined;
  }

  private onTransfer(tunnel: LiveDeviceTunnel, bytes: number, ms: number): void {
    const kbps = Math.round(bytes / 1024 / (ms / 1000));
    tunnel.kbps = tunnel.kbps === null ? kbps : Math.round(tunnel.kbps * 0.5 + kbps * 0.5);
  }

  /** 通道刚建立后稍等片刻再测一次，让列表很快有数，不用等下一个周期。 */
  private kickRtt(tunnel: LiveDeviceTunnel): void {
    if ((this.options.rttIntervalMs ?? 30_000) <= 0) return;
    const t = setTimeout(() => this.probeRtt(tunnel), 800);
    t.unref?.();
  }

  private probeAllRtt(): void {
    for (const t of this.tunnels.values()) this.probeRtt(t);
  }

  private probeRtt(tunnel: LiveDeviceTunnel): void {
    if (this.closed || this.tunnels.get(tunnel.deviceId) !== tunnel) return;
    const useDirect = tunnel.directActive && tunnel.directAdapter;
    const adapter = useDirect ? tunnel.directAdapter : tunnel.adapter;
    if (!adapter) return;
    const path: "lan" | "p2p" | "relay" = useDirect ? (tunnel.directPathKind ?? "p2p") : "relay";
    const seq = ++tunnel.rttSeq;
    // 手机端没升级就不会回 pong：只留最近几条，避免无限堆积。
    for (const key of tunnel.pendingRtt.keys()) if (key < seq - 8) tunnel.pendingRtt.delete(key);
    tunnel.pendingRtt.set(seq, { sentAt: Date.now(), path });
    try {
      adapter.sendControl({ type: "rtt_ping", seq, ts: Date.now() });
    } catch {
      tunnel.pendingRtt.delete(seq);
    }
  }

  private onRttPong(tunnel: LiveDeviceTunnel, seq: number): void {
    const sent = tunnel.pendingRtt.get(seq);
    if (!sent) return;
    tunnel.pendingRtt.delete(seq);
    // 通道切换（中继 ↔ 直连）后旧路径的数据不再代表当前质量。
    if (tunnel.lastRttPath !== sent.path) tunnel.rtts = [];
    tunnel.lastRttPath = sent.path;
    tunnel.rtts.push(Math.max(1, Date.now() - sent.sentAt));
    if (tunnel.rtts.length > RTT_KEEP) tunnel.rtts.shift();
    const now = Date.now();
    if (now - tunnel.lastQualityPersistAt >= QUALITY_PERSIST_MS) {
      tunnel.lastQualityPersistAt = now;
      const sorted = [...tunnel.rtts].sort((a, b) => a - b);
      this.options.store.recordQuality(tunnel.deviceId, {
        rttMs: sorted[Math.floor(sorted.length / 2)],
        ...(tunnel.kbps !== null ? { kbps: tunnel.kbps } : {}),
        pathKind: sent.path,
        at: new Date(now).toISOString(),
      });
    }
  }

  syncTunnels(): void {
    if (this.closed) return;
    const state = this.options.store.readState();
    if (!state.config.enabled) {
      for (const id of [...this.tunnels.keys()]) this.stopTunnel(id);
      return;
    }

    const active = this.options.store.activeDevices();
    const activeIds = new Set(active.map((d) => d.id));
    for (const id of [...this.tunnels.keys()]) {
      if (!activeIds.has(id)) this.stopTunnel(id);
    }

    const hostPriv = Buffer.from(state.hostPrivateKeyHex, "hex");
    for (const device of active) {
      const existing = this.tunnels.get(device.id);
      if (existing && existing.relayUrl === device.relayUrl) continue;
      if (existing) this.stopTunnel(device.id);
      this.startDeviceTunnel(device, hostPriv);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.rttTimer) clearInterval(this.rttTimer);
    this.cancelActivePairing("rejected");
    for (const id of [...this.tunnels.keys()]) this.stopTunnel(id);
  }

  private resolveDeviceTokenFor(pubKey: Uint8Array): string | null {
    const hex = Buffer.from(pubKey).toString("hex");
    const rec = this.options.store.findActiveByPublicKey(hex);
    if (!rec) return null;
    this.options.store.touchDevice(rec.id);
    if (!this.options.auth) return "";
    if (!rec.deviceToken) return null;
    const inspected = this.options.auth.inspectFresh(rec.deviceToken);
    return inspected.ok ? rec.deviceToken : null;
  }

  private tearDownDirect(tunnel: LiveDeviceTunnel, reason = "direct_reset"): void {
    tunnel.directAttemptId = null;
    tunnel.directActive = false;
    tunnel.directPathKind = null;
    tunnel.pendingDirectIce.length = 0;
    const adapter = tunnel.directAdapter;
    const channel = tunnel.directChannel;
    const link = tunnel.directLink;
    tunnel.directAdapter = null;
    tunnel.directChannel = null;
    tunnel.directLink = null;
    adapter?.close(reason);
    channel?.close();
    link?.close(reason);
  }

  private startDeviceTunnel(device: RemoteDeviceRecord, hostPriv: Buffer): void {
    const roomSeed = Buffer.from(device.roomSeedHex, "hex");
    const expectedClientPub = Buffer.from(device.clientPublicKeyHex, "hex");

    const tunnel: LiveDeviceTunnel = {
      deviceId: device.id,
      relayUrl: device.relayUrl,
      link: null as unknown as RelayWebSocketLink,
      state: "connecting",
      peerOnline: false,
      channel: null,
      adapter: null,
      unsubscribeData: null,
      directAttemptId: null,
      directLink: null,
      directChannel: null,
      directAdapter: null,
      directActive: false,
      directPathKind: null,
      pendingDirectIce: [],
      rtts: [],
      kbps: null,
      rttSeq: 0,
      pendingRtt: new Map(),
      lastRttPath: null,
      lastQualityPersistAt: 0,
    };

    const dataListeners = new Set<(raw: Uint8Array) => void>();
    const tearDownAdapter = () => {
      dataListeners.clear();
      tunnel.adapter?.close("peer_reset");
      tunnel.adapter = null;
      tunnel.channel?.close();
      tunnel.channel = null;
    };

    const handleRelayControl = (raw: unknown) => {
      const msg = parseP2pControlMessage(raw);
      if (!msg) return;
      switch (msg.type) {
        case "rtt_pong": {
          this.onRttPong(tunnel, msg.seq);
          return;
        }
        case "p2p_offer": {
          void this.acceptP2pOffer(tunnel, device, hostPriv, expectedClientPub, msg.attemptId, msg.sdp, msg.iceServers);
          return;
        }
        case "p2p_ice": {
          if (tunnel.directAttemptId !== msg.attemptId) return;
          if (tunnel.directLink) {
            tunnel.directLink.addRemoteCandidate(msg.candidate, msg.mid);
          } else {
            tunnel.pendingDirectIce.push({ candidate: msg.candidate, mid: msg.mid });
          }
          return;
        }
        case "p2p_active": {
          if (tunnel.directAttemptId !== msg.attemptId) return;
          tunnel.directActive = msg.active;
          tunnel.directPathKind = msg.active ? (msg.pathKind ?? tunnel.directLink?.detectPathKind() ?? "p2p") : null;
          return;
        }
        case "p2p_close": {
          if (tunnel.directAttemptId === msg.attemptId) {
            this.tearDownDirect(tunnel, msg.reason ?? "peer_closed");
          }
          return;
        }
      }
    };

    const link = new RelayWebSocketLink({
      relayUrl: device.relayUrl,
      role: "host",
      roomSeed,
      pingIntervalMs: this.options.pingIntervalMs,
      onStateChange: (next) => {
        tunnel.state = next;
      },
      onPeerPresence: (online) => {
        tunnel.peerOnline = online;
        if (!online) tearDownAdapter();
      },
    });
    tunnel.link = link;
    this.tunnels.set(device.id, tunnel);

    link.onFrame((frame) => {
      if (tunnel.channel) {
        for (const fn of [...dataListeners]) {
          try {
            fn(frame);
          } catch {
            tearDownAdapter();
            break;
          }
        }
        return;
      }
      // Treat incoming frame as Noise IK message 1 from the paired phone.
      const latest = this.options.store.findActiveByPublicKey(device.clientPublicKeyHex);
      if (!latest) {
        this.stopTunnel(device.id);
        return;
      }
      try {
        const hs = new NoiseHandshake({
          role: "responder",
          staticPrivateKey: hostPriv,
          remoteStaticPublicKey: expectedClientPub,
        });
        hs.readMessage(frame);
        const m2 = hs.writeMessage();
        const channel = hs.finish();
        link.send(m2);

        this.options.store.touchDevice(device.id);
        tunnel.channel = channel;

        const encryptedLink = createEncryptedFrameLink(channel, {
          send: (ct) => link.send(ct),
          onFrame: (fn) => {
            dataListeners.add(fn);
            return () => dataListeners.delete(fn);
          },
          close: () => tearDownAdapter(),
        });

        tunnel.adapter = new MacRemoteAdapter(channel, encryptedLink, {
          targetOrigin: this.options.targetOrigin,
          fetchImpl: this.options.fetchImpl,
          resolveDeviceToken: (pubKey) => this.resolveDeviceTokenFor(pubKey),
          onControl: handleRelayControl,
          onTransfer: (bytes, ms) => this.onTransfer(tunnel, bytes, ms),
        });
        this.kickRtt(tunnel);
      } catch {
        // Ignore malformed/revoked handshake attempts.
      }
    });
  }

  private async acceptP2pOffer(
    tunnel: LiveDeviceTunnel,
    device: RemoteDeviceRecord,
    hostPriv: Buffer,
    expectedClientPub: Buffer,
    attemptId: string,
    offerSdp: string,
    offerIceServers?: string[],
  ): Promise<void> {
    if (this.closed || this.tunnels.get(device.id) !== tunnel) return;
    this.tearDownDirect(tunnel, "superseded");
    tunnel.directAttemptId = attemptId;

    const iceServers =
      this.options.iceServers ?? (offerIceServers && offerIceServers.length > 0 ? offerIceServers : DEFAULT_STUN_SERVERS);

    let directLink: WebRtcDirectLink;
    try {
      directLink = await WebRtcDirectLink.create({
        peerName: `heji-${device.id}`,
        role: "answerer",
        iceServers,
        onLocalDescription: (sdp, type) => {
          if (type !== "answer" || tunnel.directAttemptId !== attemptId) return;
          try {
            tunnel.adapter?.sendControl({ type: "p2p_answer", attemptId, sdp });
          } catch {
            /* relay might be reconnecting */
          }
        },
        onLocalCandidate: (candidate, mid) => {
          if (tunnel.directAttemptId !== attemptId) return;
          try {
            tunnel.adapter?.sendControl({ type: "p2p_ice", attemptId, candidate, mid });
          } catch {
            /* ignore */
          }
        },
        onClose: (reason) => {
          if (tunnel.directAttemptId === attemptId) {
            this.tearDownDirect(tunnel, reason);
          }
        },
      });
    } catch {
      if (tunnel.directAttemptId === attemptId) {
        this.tearDownDirect(tunnel, "webrtc_init_failed");
      }
      return;
    }

    if (this.closed || this.tunnels.get(device.id) !== tunnel || tunnel.directAttemptId !== attemptId) {
      directLink.close("stale_attempt");
      return;
    }

    tunnel.directLink = directLink;
    const directDataListeners = new Set<(raw: Uint8Array) => void>();

    directLink.onFrame((frame) => {
      if (tunnel.directAttemptId !== attemptId) return;
      if (tunnel.directChannel) {
        for (const fn of [...directDataListeners]) {
          try {
            fn(frame);
          } catch {
            this.tearDownDirect(tunnel, "direct_decrypt_error");
            break;
          }
        }
        return;
      }

      // First binary frame on DataChannel is an independent Noise IK handshake m1.
      const latest = this.options.store.findActiveByPublicKey(device.clientPublicKeyHex);
      if (!latest) {
        this.stopTunnel(device.id);
        return;
      }
      try {
        const hs = new NoiseHandshake({
          role: "responder",
          staticPrivateKey: hostPriv,
          remoteStaticPublicKey: expectedClientPub,
        });
        hs.readMessage(frame);
        const m2 = hs.writeMessage();
        const directChannel = hs.finish();
        directLink.send(m2);

        this.options.store.touchDevice(device.id);
        tunnel.directChannel = directChannel;

        const encryptedDirect = createEncryptedFrameLink(directChannel, {
          send: (ct) => directLink.send(ct),
          onFrame: (fn) => {
            directDataListeners.add(fn);
            return () => directDataListeners.delete(fn);
          },
          close: () => {
            if (tunnel.directAttemptId === attemptId) this.tearDownDirect(tunnel, "direct_closed");
          },
        });

        const directAdapter = new MacRemoteAdapter(directChannel, encryptedDirect, {
          targetOrigin: this.options.targetOrigin,
          fetchImpl: this.options.fetchImpl,
          resolveDeviceToken: (pubKey) => this.resolveDeviceTokenFor(pubKey),
          onTransfer: (bytes, ms) => this.onTransfer(tunnel, bytes, ms),
          onControl: (raw) => {
            const ctrl = parseP2pControlMessage(raw);
            if (!ctrl) return;
            if (ctrl.type === "rtt_pong") {
              this.onRttPong(tunnel, ctrl.seq);
            } else if (ctrl.type === "p2p_probe" && ctrl.attemptId === attemptId) {
              const pathKind = directLink.detectPathKind();
              try {
                directAdapter.sendControl({
                  type: "p2p_probe_ack",
                  attemptId,
                  seq: ctrl.seq,
                  len: ctrl.pad.length,
                  pathKind,
                });
              } catch {
                /* ignore */
              }
            } else if (ctrl.type === "p2p_keepalive") {
              try {
                directAdapter.sendControl({ type: "p2p_keepalive_ack", ts: ctrl.ts });
              } catch {
                /* ignore */
              }
            } else if (ctrl.type === "p2p_active" && ctrl.attemptId === attemptId) {
              tunnel.directActive = ctrl.active;
              tunnel.directPathKind = ctrl.active ? (ctrl.pathKind ?? directLink.detectPathKind()) : null;
            }
          },
        });
        tunnel.directAdapter = directAdapter;
        this.kickRtt(tunnel);
      } catch {
        this.tearDownDirect(tunnel, "direct_handshake_failed");
      }
    });

    try {
      directLink.setRemoteDescription(offerSdp, "offer");
      while (tunnel.pendingDirectIce.length > 0) {
        const cand = tunnel.pendingDirectIce.shift()!;
        directLink.addRemoteCandidate(cand.candidate, cand.mid);
      }
    } catch {
      this.tearDownDirect(tunnel, "invalid_offer");
    }
  }

  private stopTunnel(deviceId: string): void {
    const t = this.tunnels.get(deviceId);
    if (!t) return;
    this.tunnels.delete(deviceId);
    this.tearDownDirect(t, "revoked_or_stopped");
    t.unsubscribeData?.();
    t.adapter?.close("revoked_or_stopped");
    t.channel?.close();
    t.link.close();
  }

  private cancelActivePairing(reason: "rejected" | "expired"): void {
    const attempt = this.activePairing;
    if (!attempt) return;
    this.activePairing = null;
    clearTimeout(attempt.timer);
    if (attempt.channel && attempt.status === "awaiting_approval") {
      try {
        attempt.link.send(attempt.channel.encrypt(Buffer.from(JSON.stringify({ approved: false, reason }), "utf8")));
      } catch {
        /* ignore */
      }
    }
    attempt.status = reason;
    attempt.psk.fill(0);
    attempt.channel?.close();
    attempt.link.close();
  }

  private pairingView(): ActivePairingView | null {
    const a = this.activePairing;
    if (!a) return null;
    return {
      pairId: a.pairId,
      status: a.status,
      qrText: a.qrText,
      qrSvg: a.qrSvg,
      relayUrl: a.relayUrl,
      expiresAt: a.expiresAt,
      ...(a.deviceName ? { deviceName: a.deviceName } : {}),
      ...(a.platform ? { platform: a.platform } : {}),
      ...(a.safetyCode ? { safetyCode: a.safetyCode } : {}),
    };
  }

  private computeConnectionState(enabled: boolean): RemoteConnectionUiState {
    if (!enabled) return "offline";
    const list = [...this.tunnels.values()];
    if (list.some((t) => t.directActive && t.directPathKind === "lan")) {
      return "lan";
    }
    if (list.some((t) => t.directActive)) {
      return "p2p";
    }
    if (list.some((t) => t.peerOnline || t.state === "connected" || t.state === "peer_online")) {
      return "relay";
    }
    if (this.activePairing) {
      const ps = this.activePairing.link.connectionState;
      if (ps === "connected" || ps === "peer_online") return "relay";
      if (ps === "quota_exceeded") return "quota_exceeded";
      if (ps === "connecting" || ps === "reconnecting") return "recovering";
    }
    if (list.some((t) => t.state === "quota_exceeded")) {
      return "quota_exceeded";
    }
    if (list.some((t) => t.state === "connecting" || t.state === "reconnecting")) {
      return "recovering";
    }
    return "offline";
  }
}
