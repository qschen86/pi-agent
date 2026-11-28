import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PAIRING_QR_PREFIX = "heji-pair:";
export const PAIRING_TTL_MS = 600_000; // 10 minutes
export const DOMAIN_QR_PREFIX = "heji-domain:";
const MAX_QR_BYTES = 1500;

export interface PairingQrPayload {
  version: 1;
  expiresAt: number;
  hostPublicKey: Uint8Array;
  psk: Uint8Array;
  relayUrl: string;
  hostName: string;
}

export class PairingQrError extends Error {
  constructor(
    public readonly code:
      | "invalid_relay"
      | "invalid_host_name"
      | "invalid_pairing"
      | "pairing_expired",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PairingQrError";
  }
}

export function validateRelayUrl(value: string, allowLocal = false): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new PairingQrError("invalid_relay");
  }
  const wssOk = /^wss:\/\/[a-z0-9.[\]:-]+(?:\/[a-z0-9_./~-]*)?$/i.test(value);
  const localOk = allowLocal && /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(?:\/[a-z0-9_./~-]*)?$/.test(value);
  if (!wssOk && !localOk) {
    throw new PairingQrError("invalid_relay");
  }
  return value.replace(/\/$/, "");
}

export function validateHostName(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PairingQrError("invalid_host_name");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 200) throw new PairingQrError("invalid_host_name");
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) throw new PairingQrError("invalid_host_name");
  }
  return value.trim();
}

export function createPairingQrPayload(input: {
  relayUrl: string;
  hostPublicKey: Uint8Array;
  hostName: string;
  psk?: Uint8Array;
  now?: number;
  allowLocalRelay?: boolean;
}): PairingQrPayload {
  const now = input.now ?? Date.now();
  const psk = input.psk ? new Uint8Array(input.psk) : new Uint8Array(randomBytes(32));
  if (input.hostPublicKey.length !== 32 || psk.length !== 32) {
    throw new PairingQrError("invalid_pairing");
  }
  return {
    version: 1,
    expiresAt: now + PAIRING_TTL_MS,
    hostPublicKey: new Uint8Array(input.hostPublicKey),
    psk,
    relayUrl: validateRelayUrl(input.relayUrl, input.allowLocalRelay),
    hostName: validateHostName(input.hostName),
  };
}

/**
 * Compact binary format (V1.2 §4.3.2):
 * [1B version=1] [8B expiresAt uint64 BE] [32B hostPub] [32B psk]
 * [2B relayLen BE] [2B nameLen BE] [relay UTF-8] [hostName UTF-8] [8B SHA256 checksum]
 */
export function encodePairingQr(payload: PairingQrPayload, allowLocalRelay = false): string {
  if (payload.version !== 1 || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= 0) {
    throw new PairingQrError("invalid_pairing");
  }
  if (payload.hostPublicKey.length !== 32 || payload.psk.length !== 32) {
    throw new PairingQrError("invalid_pairing");
  }
  const relay = Buffer.from(validateRelayUrl(payload.relayUrl, allowLocalRelay), "utf8");
  const name = Buffer.from(validateHostName(payload.hostName), "utf8");

  const header = Buffer.alloc(1 + 8 + 32 + 32 + 2 + 2);
  header.writeUInt8(1, 0);
  header.writeBigUInt64BE(BigInt(payload.expiresAt), 1);
  Buffer.from(payload.hostPublicKey).copy(header, 9);
  Buffer.from(payload.psk).copy(header, 41);
  header.writeUInt16BE(relay.length, 73);
  header.writeUInt16BE(name.length, 75);

  const body = Buffer.concat([header, relay, name]);
  const checksum = createHash("sha256").update(body).digest().subarray(0, 8);
  return `${PAIRING_QR_PREFIX}${Buffer.concat([body, checksum]).toString("base64url")}`;
}

export function decodePairingQr(
  encoded: string,
  options: { now?: number; allowLocalRelay?: boolean } = {},
): PairingQrPayload {
  const now = options.now ?? Date.now();
  if (typeof encoded !== "string" || !encoded.startsWith(PAIRING_QR_PREFIX)) {
    throw new PairingQrError("invalid_pairing");
  }
  const b64 = encoded.slice(PAIRING_QR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(b64) || b64.length > Math.ceil((MAX_QR_BYTES * 4) / 3)) {
    throw new PairingQrError("invalid_pairing");
  }
  const raw = Buffer.from(b64, "base64url");
  if (raw.length < 77 + 8 || raw.length > MAX_QR_BYTES) {
    throw new PairingQrError("invalid_pairing");
  }
  const body = raw.subarray(0, raw.length - 8);
  const checksum = raw.subarray(raw.length - 8);
  const expected = createHash("sha256").update(body).digest().subarray(0, 8);
  if (!timingSafeEqual(expected, checksum)) {
    throw new PairingQrError("invalid_pairing");
  }
  if (body.readUInt8(0) !== 1) {
    throw new PairingQrError("invalid_pairing");
  }
  const relayLen = body.readUInt16BE(73);
  const nameLen = body.readUInt16BE(75);
  if (77 + relayLen + nameLen !== body.length) {
    throw new PairingQrError("invalid_pairing");
  }
  const expiresAtBig = body.readBigUInt64BE(1);
  if (expiresAtBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PairingQrError("invalid_pairing");
  }
  const expiresAt = Number(expiresAtBig);
  if (expiresAt <= now || expiresAt > now + PAIRING_TTL_MS + 60_000) {
    throw new PairingQrError("pairing_expired");
  }
  const hostPublicKey = new Uint8Array(body.subarray(9, 41));
  const psk = new Uint8Array(body.subarray(41, 73));
  const relayUrl = validateRelayUrl(body.subarray(77, 77 + relayLen).toString("utf8"), options.allowLocalRelay);
  const hostName = validateHostName(body.subarray(77 + relayLen).toString("utf8"));
  return { version: 1, expiresAt, hostPublicKey, psk, relayUrl, hostName };
}

/**
 * 自有域名线路的二维码：只携带实例根地址（公开信息），真正的授权靠手机上显示的六位码在电脑端核对批准。
 * 与手机端 InstanceUrl 同一口径：https，或本机回环的 http；不带账号、路径、查询和片段。
 */
export function normalizeDomainOrigin(value: string, allowLocal = false): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new PairingQrError("invalid_relay", "域名地址无效");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PairingQrError("invalid_relay", "域名地址无效");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const ok = url.protocol === "https:" || (allowLocal && loopback && url.protocol === "http:");
  if (!ok) throw new PairingQrError("invalid_relay", "自有域名必须使用 https://");
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new PairingQrError("invalid_relay", "请填写实例根地址，不要带路径或参数");
  }
  return url.origin;
}

export function encodeDomainQr(origin: string, allowLocal = false): string {
  return `${DOMAIN_QR_PREFIX}${normalizeDomainOrigin(origin, allowLocal)}`;
}
