import type { BinaryFrameLink, MuxRequestStream, ResHeadPayload } from "./mux.js";
import { MuxSession } from "./mux.js";
import type { NoiseChannel } from "./noise.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Headers that must never be forged by the remote client over the tunnel. */
const BLOCKED_INBOUND_HEADERS = new Set([
  "authorization",
  "cookie",
  "origin",
  "referer",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "cf-connecting-ip",
  "x-heji-local-gate",
]);

export interface MacRemoteAdapterOptions {
  /** Base URL of local Hono server, e.g. http://127.0.0.1:8780 */
  targetOrigin: string;
  /**
   * Resolve peer authorization on every request:
   * - return a non-empty string -> authorized with Bearer device token (when auth enabled)
   * - return "" -> authorized without Bearer header (local Mac server without login password)
   * - return null -> revoked / denied (returns 401 DEVICE_REVOKED immediately)
   */
  resolveDeviceToken: (remoteStaticPublicKey: Uint8Array) => string | null;
  /** Optional custom fetch implementation (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /** Optional handler for encrypted CTRL_JSON signaling/probe messages (streamId = 0). */
  onControl?: (msg: unknown) => void;
  /**
   * 一次较大的非 SSE 响应发送完毕时回调（字节数、发送耗时），主机据此估算最近的传输速率。
   * 只统计 ≥16 KiB 的响应：小响应的耗时被延迟主导，反映不了带宽。
   */
  onTransfer?: (bytes: number, elapsedMs: number) => void;
}

const TRANSFER_SAMPLE_MIN_BYTES = 16 * 1024;

/**
 * Wraps a raw binary transport with an established NoiseChannel to form a BinaryFrameLink.
 */
export function createEncryptedFrameLink(
  channel: NoiseChannel,
  transport: BinaryFrameLink,
): BinaryFrameLink {
  return {
    send(plaintextFrame: Uint8Array) {
      transport.send(channel.encrypt(plaintextFrame));
    },
    onFrame(handler: (plaintextFrame: Uint8Array) => void) {
      return transport.onFrame((ciphertextFrame) => {
        handler(channel.decrypt(ciphertextFrame));
      });
    },
    close() {
      channel.close();
      transport.close();
    },
  };
}

/**
 * Mac-side Remote Connect adapter (V1.2 §3.1 & §4.2):
 * Decodes multiplexed HTTP/SSE streams from an authenticated Noise channel,
 * verifies device authorization on every request, forwards to local Hono server,
 * and streams back JSON / SSE / binary / Range responses without buffering SSE.
 */
export class MacRemoteAdapter {
  private readonly session: MuxSession;
  private readonly targetOrigin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly channel: NoiseChannel,
    encryptedLink: BinaryFrameLink,
    private readonly options: MacRemoteAdapterOptions,
  ) {
    this.targetOrigin = options.targetOrigin.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.session = new MuxSession({
      link: encryptedLink,
      onRequest: (stream) => this.handleRequest(stream),
      onControl: options.onControl,
    });
  }

  sendControl(message: unknown): void {
    this.session.sendControl(message);
  }

  get activeStreams(): number {
    return this.session.activeStreamCount;
  }

  close(reason = "adapter_closed"): void {
    this.session.close(reason);
  }

  private async handleRequest(stream: MuxRequestStream): Promise<void> {
    const { head } = stream;

    // Validate path strictly: must be origin-relative, no scheme/authority injection.
    if (!head.path.startsWith("/") || head.path.startsWith("//") || /[\r\n]/.test(head.path)) {
      stream.sendResponseHead({ status: 400, headers: { "content-type": "application/json" }, isSse: false });
      await stream.sendResponseBody(Buffer.from(JSON.stringify({ error: "INVALID_PATH" })), true);
      return;
    }

    // Re-check device authorization on every request so revocation takes effect immediately.
    const deviceToken = this.options.resolveDeviceToken(this.channel.remoteStaticPublicKey);
    if (deviceToken === null) {
      stream.sendResponseHead({ status: 401, headers: { "content-type": "application/json" }, isSse: false });
      await stream.sendResponseBody(Buffer.from(JSON.stringify({ error: "DEVICE_REVOKED" })), true);
      return;
    }

    const forwardHeaders = new Headers();
    for (const [k, v] of Object.entries(head.headers)) {
      const lower = k.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower) || BLOCKED_INBOUND_HEADERS.has(lower)) continue;
      forwardHeaders.set(lower, v);
    }
    if (deviceToken.length > 0) forwardHeaders.set("authorization", `Bearer ${deviceToken}`);
    if (head.requestId) forwardHeaders.set("x-heji-request-id", head.requestId);

    const method = head.method.toUpperCase();
    const allowBody = head.hasBody && method !== "GET" && method !== "HEAD";

    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers: forwardHeaders,
      redirect: "manual",
      signal: stream.signal,
    };
    if (allowBody) {
      init.body = stream.body;
      init.duplex = "half";
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.targetOrigin}${head.path}`, init);
    } catch (err) {
      if (stream.signal.aborted) return;
      stream.reset("upstream_error", err instanceof Error ? err.message : String(err));
      return;
    }

    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) return;
      // fetch 读出来的 body 已经按 content-encoding 解压过；头还留着的话，手机 WebView 会对
      // 解压后的内容再解压一次，脚本和样式全部 ERR_CONTENT_DECODING_FAILED，页面就停在白屏。
      if (lower === "content-encoding") return;
      outHeaders[lower] = value;
    });

    const contentType = (outHeaders["content-type"] ?? "").toLowerCase();
    const isSse = contentType.startsWith("text/event-stream");

    const resHead: ResHeadPayload = {
      status: response.status,
      headers: outHeaders,
      isSse,
    };

    if (!response.body || method === "HEAD" || response.status === 204 || response.status === 304) {
      stream.sendResponseHead(resHead, true);
      return;
    }

    stream.sendResponseHead(resHead, false);
    const reader = response.body.getReader();
    const startedAt = Date.now();
    let sentBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          await stream.sendResponseBody(new Uint8Array(0), true);
          if (!isSse && sentBytes >= TRANSFER_SAMPLE_MIN_BYTES) {
            this.options.onTransfer?.(sentBytes, Math.max(1, Date.now() - startedAt));
          }
          break;
        }
        if (value && value.length > 0) {
          await stream.sendResponseBody(value, false);
          sentBytes += value.length;
        }
      }
    } catch (err) {
      if (!stream.signal.aborted) {
        stream.reset("stream_read_error", err instanceof Error ? err.message : String(err));
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
  }
}
