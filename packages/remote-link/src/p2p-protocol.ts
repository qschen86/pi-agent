/**
 * Heji Remote Connect P2 signaling, probe, keepalive & path classification protocol (V1.2 §4.5).
 * Carried as JSON payloads inside encrypted Mux CTRL_JSON frames (streamId = 0).
 */

export const DEFAULT_STUN_SERVERS: readonly string[] = [
  "stun:stun.cloudflare.com:3478",
  "stun:stun.l.google.com:19302",
];

export const P2P_DATA_CHANNEL_LABEL = "heji-p2p";
/** Conservative SCTP packet size safe across libdatachannel (Mac) and org.webrtc (Android). */
export const P2P_PACKET_MAX_BYTES = 16 * 1024;
export const P2P_BACKPRESSURE_HIGH_WATER = 512 * 1024;
export const P2P_BACKPRESSURE_LOW_WATER = 128 * 1024;

export const P2P_PROBE_ROUNDS = 3;
export const P2P_PROBE_LARGE_BYTES = 4096;
export const P2P_SETTLE_DELAY_MS = 400;
export const P2P_SSE_DRAIN_GRACE_MS = 3_000;
export const P2P_KEEPALIVE_INTERVAL_MS = 10_000;
export const P2P_KEEPALIVE_TIMEOUT_MS = 22_000;
export const P2P_CIRCUIT_BREAKER_THRESHOLD = 2;
export const P2P_EARLY_DROP_WINDOW_MS = 5_000;
export const P2P_RETRY_BACKOFF_MS: readonly number[] = [5_000, 30_000, 60_000, 120_000, 300_000];

export type DirectPathKind = "lan" | "p2p";

export interface P2pOfferMessage {
  type: "p2p_offer";
  attemptId: string;
  sdp: string;
  iceServers?: string[];
}

export interface P2pAnswerMessage {
  type: "p2p_answer";
  attemptId: string;
  sdp: string;
}

export interface P2pIceMessage {
  type: "p2p_ice";
  attemptId: string;
  candidate: string;
  mid: string;
}

export interface P2pCloseMessage {
  type: "p2p_close";
  attemptId: string;
  reason?: string;
}

export interface P2pProbeMessage {
  type: "p2p_probe";
  attemptId: string;
  seq: number;
  pad: string;
}

export interface P2pProbeAckMessage {
  type: "p2p_probe_ack";
  attemptId: string;
  seq: number;
  len: number;
  pathKind: DirectPathKind;
}

export interface P2pActiveMessage {
  type: "p2p_active";
  attemptId: string;
  active: boolean;
  pathKind?: DirectPathKind;
}

export interface P2pKeepaliveMessage {
  type: "p2p_keepalive";
  ts: number;
}

export interface P2pKeepaliveAckMessage {
  type: "p2p_keepalive_ack";
  ts: number;
}

/** 主机发起的往返探测：手机原样回 rtt_pong，主机据此统计当前通道的延迟。 */
export interface RttPingMessage {
  type: "rtt_ping";
  seq: number;
  ts: number;
}

export interface RttPongMessage {
  type: "rtt_pong";
  seq: number;
  ts: number;
}

export type P2pControlMessage =
  | P2pOfferMessage
  | P2pAnswerMessage
  | P2pIceMessage
  | P2pCloseMessage
  | P2pProbeMessage
  | P2pProbeAckMessage
  | P2pActiveMessage
  | P2pKeepaliveMessage
  | P2pKeepaliveAckMessage
  | RttPingMessage
  | RttPongMessage;

export function parseP2pControlMessage(raw: unknown): P2pControlMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const type = obj["type"];
  if (typeof type !== "string") return null;

  switch (type) {
    case "p2p_offer":
      if (typeof obj["attemptId"] === "string" && typeof obj["sdp"] === "string") {
        const iceServers = Array.isArray(obj["iceServers"])
          ? obj["iceServers"].filter((s): s is string => typeof s === "string" && s.startsWith("stun:"))
          : undefined;
        return { type, attemptId: obj["attemptId"], sdp: obj["sdp"], ...(iceServers ? { iceServers } : {}) };
      }
      return null;
    case "p2p_answer":
      if (typeof obj["attemptId"] === "string" && typeof obj["sdp"] === "string") {
        return { type, attemptId: obj["attemptId"], sdp: obj["sdp"] };
      }
      return null;
    case "p2p_ice":
      if (
        typeof obj["attemptId"] === "string" &&
        typeof obj["candidate"] === "string" &&
        typeof obj["mid"] === "string"
      ) {
        return { type, attemptId: obj["attemptId"], candidate: obj["candidate"], mid: obj["mid"] };
      }
      return null;
    case "p2p_close":
      if (typeof obj["attemptId"] === "string") {
        return {
          type,
          attemptId: obj["attemptId"],
          ...(typeof obj["reason"] === "string" ? { reason: obj["reason"] } : {}),
        };
      }
      return null;
    case "p2p_probe":
      if (
        typeof obj["attemptId"] === "string" &&
        typeof obj["seq"] === "number" &&
        typeof obj["pad"] === "string"
      ) {
        return { type, attemptId: obj["attemptId"], seq: obj["seq"], pad: obj["pad"] };
      }
      return null;
    case "p2p_probe_ack":
      if (
        typeof obj["attemptId"] === "string" &&
        typeof obj["seq"] === "number" &&
        typeof obj["len"] === "number" &&
        (obj["pathKind"] === "lan" || obj["pathKind"] === "p2p")
      ) {
        return { type, attemptId: obj["attemptId"], seq: obj["seq"], len: obj["len"], pathKind: obj["pathKind"] };
      }
      return null;
    case "p2p_active":
      if (typeof obj["attemptId"] === "string" && typeof obj["active"] === "boolean") {
        const pathKind = obj["pathKind"] === "lan" || obj["pathKind"] === "p2p" ? obj["pathKind"] : undefined;
        return { type, attemptId: obj["attemptId"], active: obj["active"], ...(pathKind ? { pathKind } : {}) };
      }
      return null;
    case "p2p_keepalive":
      if (typeof obj["ts"] === "number") return { type, ts: obj["ts"] };
      return null;
    case "p2p_keepalive_ack":
      if (typeof obj["ts"] === "number") return { type, ts: obj["ts"] };
      return null;
    case "rtt_ping":
    case "rtt_pong":
      if (typeof obj["seq"] === "number" && typeof obj["ts"] === "number") return { type, seq: obj["seq"], ts: obj["ts"] };
      return null;
    default:
      return null;
  }
}

/**
 * Classifies an active ICE selected candidate pair as local LAN vs NAT P2P.
 * Host-to-host pairs over private/link-local addresses are reported as "lan".
 */
export function classifyCandidatePair(localType?: string, remoteType?: string): DirectPathKind {
  if (localType?.toLowerCase() === "host" && remoteType?.toLowerCase() === "host") {
    return "lan";
  }
  return "p2p";
}
