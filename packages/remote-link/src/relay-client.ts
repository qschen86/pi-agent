import type { BinaryFrameLink } from "./mux.js";
import { createRoomTicket, currentRoomPeriod } from "./ticket.js";

export const RELAY_PING_TEXT = "heji:ping";
export const RELAY_PONG_TEXT = "heji:pong";
export const RELAY_ONLINE_TEXT = "heji:online";
export const RELAY_OFFLINE_TEXT = "heji:offline";
export const RELAY_QUOTA_CLOSE_CODE = 4029;
const QUOTA_RECONNECT_MS = 15 * 60_000;
const RATE_LIMIT_RECONNECT_MS = 10_000;

export type RelayConnectionState =
  | "connecting"
  | "connected"
  | "peer_online"
  | "reconnecting"
  | "quota_exceeded"
  | "closed";

export interface RelayClientOptions {
  relayUrl: string;
  role: "host" | "client";
  roomSeed: Uint8Array;
  pingIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onStateChange?: (state: RelayConnectionState) => void;
  onPeerPresence?: (online: boolean) => void;
  onQuotaExceeded?: (reason: string) => void;
}

/**
 * Node >= 24 native WebSocket Relay client (V1.2 §4.4):
 * - Computes stateless rolling UTC-day room ticket automatically on each (re)connect.
 * - Sends "heji:ping" every 25s (matched by Node Relay & CF DO setWebSocketAutoResponse).
 * - Exposes BinaryFrameLink for Noise + Mux layers.
 */
export class RelayWebSocketLink implements BinaryFrameLink {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(frame: Uint8Array) => void>();
  private closed = false;
  private peerOnline = false;
  private reconnectDelay: number;
  private currentPeriod = -1;
  private state: RelayConnectionState = "connecting";

  constructor(private readonly options: RelayClientOptions) {
    this.reconnectDelay = options.reconnectBaseMs ?? 1000;
    this.connect();
  }

  get connectionState(): RelayConnectionState {
    return this.state;
  }

  get isPeerOnline(): boolean {
    return this.peerOnline;
  }

  send(frame: Uint8Array): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay_not_connected");
    }
    this.ws.send(frame);
  }

  onFrame(handler: (frame: Uint8Array) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.setState("closed");
    if (this.peerOnline) {
      this.peerOnline = false;
      this.options.onPeerPresence?.(false);
    }
    try {
      this.ws?.close(1000, "closed");
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.listeners.clear();
  }

  private setState(next: RelayConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connect(): void {
    if (this.closed) return;
    this.clearTimers();
    const period = currentRoomPeriod();
    this.currentPeriod = period;
    const ticket = createRoomTicket(this.options.roomSeed, period);
    const base = this.options.relayUrl.replace(/\/$/, "");
    const url = `${base}/room/${ticket.roomId}?role=${this.options.role}&period=${ticket.period}&credential=${ticket.credential}`;

    this.setState(this.state === "reconnecting" ? "reconnecting" : "connecting");
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.closed || this.ws !== ws) {
        ws.close();
        return;
      }
      this.reconnectDelay = this.options.reconnectBaseMs ?? 1000;
      this.setState("connected");
      const interval = this.options.pingIntervalMs ?? 25_000;
      this.pingTimer = setInterval(() => {
        if (this.closed || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        // Roll over seamlessly when UTC day changes (server tolerates +/-1 day).
        if (currentRoomPeriod() !== this.currentPeriod) {
          ws.close(1000, "period_rollover");
          return;
        }
        try {
          ws.send(RELAY_PING_TEXT);
        } catch {
          /* close handler will reconnect */
        }
      }, interval);
    });

    ws.addEventListener("message", (ev) => {
      if (this.closed || this.ws !== ws) return;
      if (typeof ev.data === "string") {
        if (ev.data === RELAY_PONG_TEXT) return;
        if (ev.data === RELAY_ONLINE_TEXT) {
          this.setState("peer_online");
          if (!this.peerOnline) {
            this.peerOnline = true;
            this.options.onPeerPresence?.(true);
          }
        } else if (ev.data === RELAY_OFFLINE_TEXT) {
          this.setState("connected");
          if (this.peerOnline) {
            this.peerOnline = false;
            this.options.onPeerPresence?.(false);
          }
        }
        return;
      }
      const bytes = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(0);
      for (const fn of [...this.listeners]) {
        try {
          fn(bytes);
        } catch {
          /* isolate listener errors */
        }
      }
    });

    const handleDown = (ev?: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.peerOnline) {
        this.peerOnline = false;
        this.options.onPeerPresence?.(false);
      }
      if (this.closed) return;
      const code = typeof ev?.code === "number" ? ev.code : 0;
      const reason = typeof ev?.reason === "string" ? ev.reason : "";
      if (code === RELAY_QUOTA_CLOSE_CODE) {
        if (reason.includes("rate_limited")) {
          this.setState("reconnecting");
          this.reconnectDelay = Math.max(this.reconnectDelay, RATE_LIMIT_RECONNECT_MS);
          this.reconnectTimer = setTimeout(() => this.connect(), RATE_LIMIT_RECONNECT_MS);
          return;
        }
        this.setState("quota_exceeded");
        this.options.onQuotaExceeded?.(reason || "daily_quota_exceeded");
        this.reconnectTimer = setTimeout(() => this.connect(), QUOTA_RECONNECT_MS);
        return;
      }
      this.setState("reconnecting");
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.options.reconnectMaxMs ?? 30_000, Math.round(delay * 1.7));
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };

    ws.addEventListener("close", (ev) => handleDown(ev), { once: true });
    ws.addEventListener("error", () => {
      try { ws.close(); } catch { /* ignore */ }
    }, { once: true });
  }
}
