import { MAX_FRAME_BYTES } from "./fragment.js";

export const MUX_VERSION = 1;
export const MUX_HEADER_BYTES = 12;
export const MUX_MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - MUX_HEADER_BYTES;
export const MUX_CHUNK_SIZE = 60 * 1024; // 60 KiB body chunk
export const INITIAL_STREAM_WINDOW = 512 * 1024; // 512 KiB per stream
export const INITIAL_CONN_WINDOW = 4 * 1024 * 1024; // 4 MiB total

export const MuxFrameType = {
  REQ_HEAD: 0x01,
  REQ_BODY: 0x02,
  RES_HEAD: 0x03,
  RES_BODY: 0x04,
  STREAM_RST: 0x05,
  WINDOW_UPDATE: 0x06,
  CTRL_JSON: 0x10,
} as const;

export type MuxFrameTypeValue = (typeof MuxFrameType)[keyof typeof MuxFrameType];

export const MuxFlags = {
  NONE: 0x0000,
  END_STREAM: 0x0001,
} as const;

export interface MuxFrame {
  version: number;
  type: MuxFrameTypeValue;
  flags: number;
  streamId: number;
  payload: Uint8Array;
}

export interface ReqHeadPayload {
  method: string;
  path: string;
  headers: Record<string, string>;
  requestId: string;
  hasBody: boolean;
}

export interface ResHeadPayload {
  status: number;
  headers: Record<string, string>;
  isSse: boolean;
}

export interface StreamRstPayload {
  code: string;
  message?: string;
}

export function encodeMuxFrame(frame: Omit<MuxFrame, "version"> & { version?: number }): Uint8Array {
  const version = frame.version ?? MUX_VERSION;
  if (frame.payload.length > MUX_MAX_PAYLOAD_BYTES) {
    throw new Error(`mux payload exceeds max (${frame.payload.length} > ${MUX_MAX_PAYLOAD_BYTES})`);
  }
  const buf = Buffer.allocUnsafe(MUX_HEADER_BYTES + frame.payload.length);
  buf.writeUInt8(version, 0);
  buf.writeUInt8(frame.type, 1);
  buf.writeUInt16BE(frame.flags, 2);
  buf.writeUInt32BE(frame.streamId >>> 0, 4);
  buf.writeUInt32BE(frame.payload.length >>> 0, 8);
  if (frame.payload.length > 0) {
    Buffer.from(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength).copy(buf, MUX_HEADER_BYTES);
  }
  return new Uint8Array(buf);
}

export function decodeMuxFrame(raw: Uint8Array): MuxFrame {
  if (raw.length < MUX_HEADER_BYTES || raw.length > MAX_FRAME_BYTES) {
    throw new Error("invalid_mux_frame_size");
  }
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = buf.readUInt8(0);
  if (version !== MUX_VERSION) throw new Error(`unsupported_mux_version:${version}`);
  const type = buf.readUInt8(1) as MuxFrameTypeValue;
  const flags = buf.readUInt16BE(2);
  const streamId = buf.readUInt32BE(4);
  const length = buf.readUInt32BE(8);
  if (MUX_HEADER_BYTES + length !== raw.length) {
    throw new Error("mux_length_mismatch");
  }
  return {
    version,
    type,
    flags,
    streamId,
    payload: new Uint8Array(raw.subarray(MUX_HEADER_BYTES)),
  };
}

export function encodeJsonPayload(obj: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(obj), "utf8"));
}

export function decodeJsonPayload<T>(payload: Uint8Array): T {
  return JSON.parse(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8")) as T;
}

export function encodeWindowUpdate(increment: number): Uint8Array {
  if (!Number.isInteger(increment) || increment <= 0) throw new Error("invalid_window_increment");
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(increment >>> 0, 0);
  return new Uint8Array(buf);
}

export function decodeWindowUpdate(payload: Uint8Array): number {
  if (payload.length !== 4) throw new Error("invalid_window_update");
  return Buffer.from(payload.buffer, payload.byteOffset, 4).readUInt32BE(0);
}

export interface BinaryFrameLink {
  send(frame: Uint8Array): void;
  onFrame(handler: (frame: Uint8Array) => void): () => void;
  close(): void;
}

export interface MuxRequestStream {
  readonly streamId: number;
  readonly head: ReqHeadPayload;
  readonly signal: AbortSignal;
  readonly body: ReadableStream<Uint8Array>;
  sendResponseHead(head: ResHeadPayload, endStream?: boolean): void;
  sendResponseBody(chunk: Uint8Array, endStream?: boolean): Promise<void>;
  reset(code: string, message?: string): void;
}

interface OutboundStream {
  streamId: number;
  sendWindow: number;
  waiters: Array<() => void>;
  abort: AbortController;
  onResHead?: (head: ResHeadPayload, endStream: boolean) => void;
  onResBody?: (chunk: Uint8Array, endStream: boolean) => void;
  onReset?: (rst: StreamRstPayload) => void;
  recvConsumed: number;
  closed: boolean;
}

interface InboundStream {
  streamId: number;
  sendWindow: number;
  waiters: Array<() => void>;
  abort: AbortController;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  recvConsumed: number;
  closed: boolean;
}

export interface MuxSessionOptions {
  link: BinaryFrameLink;
  onRequest?: (stream: MuxRequestStream) => void | Promise<void>;
  onControl?: (msg: unknown) => void;
}

/**
 * Bidirectional HTTP/SSE stream multiplexer with per-stream and connection-level flow control.
 */
export class MuxSession {
  private readonly outbound = new Map<number, OutboundStream>();
  private readonly inbound = new Map<number, InboundStream>();
  private nextClientStreamId = 1;
  private connSendWindow = INITIAL_CONN_WINDOW;
  private connRecvConsumed = 0;
  private connWaiters: Array<() => void> = [];
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: MuxSessionOptions) {
    this.unsubscribe = options.link.onFrame((raw) => this.handleRawFrame(raw));
  }

  sendControl(message: unknown): void {
    if (this.disposed) throw new Error("mux_closed");
    this.sendRaw({
      type: MuxFrameType.CTRL_JSON,
      flags: MuxFlags.NONE,
      streamId: 0,
      payload: encodeJsonPayload(message),
    });
  }

  /** Client side: open a new HTTP/SSE request stream. */
  openRequest(
    head: ReqHeadPayload,
    callbacks: {
      onResHead: (head: ResHeadPayload, endStream: boolean) => void;
      onResBody: (chunk: Uint8Array, endStream: boolean) => void;
      onReset: (rst: StreamRstPayload) => void;
    },
  ): {
    streamId: number;
    sendBody(chunk: Uint8Array, endStream?: boolean): Promise<void>;
    reset(code: string, message?: string): void;
  } {
    if (this.disposed) throw new Error("mux_closed");
    const streamId = this.nextClientStreamId;
    this.nextClientStreamId += 2; // odd IDs for client-initiated streams

    const entry: OutboundStream = {
      streamId,
      sendWindow: INITIAL_STREAM_WINDOW,
      waiters: [],
      abort: new AbortController(),
      onResHead: callbacks.onResHead,
      onResBody: callbacks.onResBody,
      onReset: callbacks.onReset,
      recvConsumed: 0,
      closed: false,
    };
    this.outbound.set(streamId, entry);

    this.sendRaw({
      type: MuxFrameType.REQ_HEAD,
      flags: head.hasBody ? MuxFlags.NONE : MuxFlags.END_STREAM,
      streamId,
      payload: encodeJsonPayload(head),
    });

    return {
      streamId,
      sendBody: (chunk, endStream = false) =>
        this.sendDataWithFlowControl(entry, MuxFrameType.REQ_BODY, chunk, endStream),
      reset: (code, message) => {
        if (entry.closed) return;
        entry.closed = true;
        entry.abort.abort();
        this.wakeWaiters(entry.waiters);
        this.outbound.delete(streamId);
        this.sendRaw({
          type: MuxFrameType.STREAM_RST,
          flags: MuxFlags.NONE,
          streamId,
          payload: encodeJsonPayload({ code, message } satisfies StreamRstPayload),
        });
      },
    };
  }

  get activeStreamCount(): number {
    return this.outbound.size + this.inbound.size;
  }

  close(reason = "session_closed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const s of this.outbound.values()) {
      s.closed = true;
      s.abort.abort();
      this.wakeWaiters(s.waiters);
      s.onReset?.({ code: reason });
    }
    for (const s of this.inbound.values()) {
      s.closed = true;
      s.abort.abort();
      this.wakeWaiters(s.waiters);
      try {
        s.controller?.error(new Error(reason));
      } catch {
        /* already closed */
      }
    }
    this.outbound.clear();
    this.inbound.clear();
    this.wakeWaiters(this.connWaiters);
  }

  private sendRaw(frame: Omit<MuxFrame, "version">): void {
    if (this.disposed) return;
    this.options.link.send(encodeMuxFrame(frame));
  }

  private async sendDataWithFlowControl(
    stream: { streamId: number; sendWindow: number; waiters: Array<() => void>; abort: AbortController; closed: boolean },
    type: typeof MuxFrameType.REQ_BODY | typeof MuxFrameType.RES_BODY,
    data: Uint8Array,
    endStream: boolean,
  ): Promise<void> {
    if (data.length === 0) {
      if (endStream && !stream.closed && !this.disposed) {
        this.sendRaw({ type, flags: MuxFlags.END_STREAM, streamId: stream.streamId, payload: new Uint8Array(0) });
      }
      return;
    }

    let offset = 0;
    while (offset < data.length) {
      if (this.disposed || stream.closed || stream.abort.signal.aborted) {
        throw new Error("stream_aborted");
      }
      const avail = Math.min(stream.sendWindow, this.connSendWindow);
      if (avail <= 0) {
        await new Promise<void>((resolve) => {
          if (stream.sendWindow <= 0) stream.waiters.push(resolve);
          else this.connWaiters.push(resolve);
        });
        continue;
      }
      const chunkLen = Math.min(avail, MUX_CHUNK_SIZE, data.length - offset);
      const slice = data.subarray(offset, offset + chunkLen);
      offset += chunkLen;
      stream.sendWindow -= chunkLen;
      this.connSendWindow -= chunkLen;
      const isLast = offset >= data.length && endStream;
      this.sendRaw({
        type,
        flags: isLast ? MuxFlags.END_STREAM : MuxFlags.NONE,
        streamId: stream.streamId,
        payload: slice,
      });
    }
  }

  private wakeWaiters(waiters: Array<() => void>): void {
    while (waiters.length > 0) {
      const fn = waiters.shift();
      fn?.();
    }
  }

  private creditReceive(stream: { streamId: number; recvConsumed: number }, bytes: number): void {
    if (bytes <= 0 || this.disposed) return;
    stream.recvConsumed += bytes;
    this.connRecvConsumed += bytes;
    if (stream.recvConsumed >= INITIAL_STREAM_WINDOW / 2) {
      const inc = stream.recvConsumed;
      stream.recvConsumed = 0;
      this.sendRaw({
        type: MuxFrameType.WINDOW_UPDATE,
        flags: MuxFlags.NONE,
        streamId: stream.streamId,
        payload: encodeWindowUpdate(inc),
      });
    }
    if (this.connRecvConsumed >= INITIAL_CONN_WINDOW / 2) {
      const inc = this.connRecvConsumed;
      this.connRecvConsumed = 0;
      this.sendRaw({
        type: MuxFrameType.WINDOW_UPDATE,
        flags: MuxFlags.NONE,
        streamId: 0,
        payload: encodeWindowUpdate(inc),
      });
    }
  }

  private handleRawFrame(raw: Uint8Array): void {
    if (this.disposed) return;
    const frame = decodeMuxFrame(raw);
    const end = (frame.flags & MuxFlags.END_STREAM) !== 0;

    switch (frame.type) {
      case MuxFrameType.CTRL_JSON: {
        if (frame.streamId === 0) this.options.onControl?.(decodeJsonPayload(frame.payload));
        return;
      }
      case MuxFrameType.WINDOW_UPDATE: {
        const inc = decodeWindowUpdate(frame.payload);
        if (frame.streamId === 0) {
          this.connSendWindow += inc;
          this.wakeWaiters(this.connWaiters);
        } else {
          const target = this.outbound.get(frame.streamId) ?? this.inbound.get(frame.streamId);
          if (target) {
            target.sendWindow += inc;
            this.wakeWaiters(target.waiters);
          }
        }
        return;
      }
      case MuxFrameType.REQ_HEAD: {
        const head = decodeJsonPayload<ReqHeadPayload>(frame.payload);
        const inboundEntry: InboundStream = {
          streamId: frame.streamId,
          sendWindow: INITIAL_STREAM_WINDOW,
          waiters: [],
          abort: new AbortController(),
          recvConsumed: 0,
          closed: false,
        };
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            inboundEntry.controller = controller;
            if (end || !head.hasBody) controller.close();
          },
          cancel: () => {
            inboundEntry.abort.abort();
          },
        });
        this.inbound.set(frame.streamId, inboundEntry);

        const reqStream: MuxRequestStream = {
          streamId: frame.streamId,
          head,
          signal: inboundEntry.abort.signal,
          body,
          sendResponseHead: (resHead, endStream = false) => {
            if (inboundEntry.closed || this.disposed) return;
            this.sendRaw({
              type: MuxFrameType.RES_HEAD,
              flags: endStream ? MuxFlags.END_STREAM : MuxFlags.NONE,
              streamId: frame.streamId,
              payload: encodeJsonPayload(resHead),
            });
            if (endStream) {
              inboundEntry.closed = true;
              this.inbound.delete(frame.streamId);
            }
          },
          sendResponseBody: async (chunk, endStream = false) => {
            await this.sendDataWithFlowControl(inboundEntry, MuxFrameType.RES_BODY, chunk, endStream);
            if (endStream) {
              inboundEntry.closed = true;
              this.inbound.delete(frame.streamId);
            }
          },
          reset: (code, message) => {
            if (inboundEntry.closed) return;
            inboundEntry.closed = true;
            inboundEntry.abort.abort();
            this.wakeWaiters(inboundEntry.waiters);
            this.inbound.delete(frame.streamId);
            this.sendRaw({
              type: MuxFrameType.STREAM_RST,
              flags: MuxFlags.NONE,
              streamId: frame.streamId,
              payload: encodeJsonPayload({ code, message } satisfies StreamRstPayload),
            });
          },
        };
        void Promise.resolve(this.options.onRequest?.(reqStream)).catch((err) => {
          reqStream.reset("handler_error", err instanceof Error ? err.message : String(err));
        });
        return;
      }
      case MuxFrameType.REQ_BODY: {
        const entry = this.inbound.get(frame.streamId);
        if (!entry || entry.closed) return;
        if (frame.payload.length > 0) {
          entry.controller?.enqueue(frame.payload);
          this.creditReceive(entry, frame.payload.length);
        }
        if (end) {
          try {
            entry.controller?.close();
          } catch {
            /* already closed */
          }
        }
        return;
      }
      case MuxFrameType.RES_HEAD: {
        const entry = this.outbound.get(frame.streamId);
        if (!entry || entry.closed) return;
        const head = decodeJsonPayload<ResHeadPayload>(frame.payload);
        entry.onResHead?.(head, end);
        if (end) {
          entry.closed = true;
          this.outbound.delete(frame.streamId);
        }
        return;
      }
      case MuxFrameType.RES_BODY: {
        const entry = this.outbound.get(frame.streamId);
        if (!entry || entry.closed) return;
        entry.onResBody?.(frame.payload, end);
        this.creditReceive(entry, frame.payload.length);
        if (end) {
          entry.closed = true;
          this.outbound.delete(frame.streamId);
        }
        return;
      }
      case MuxFrameType.STREAM_RST: {
        const rst = decodeJsonPayload<StreamRstPayload>(frame.payload);
        const out = this.outbound.get(frame.streamId);
        if (out) {
          out.closed = true;
          out.abort.abort();
          this.wakeWaiters(out.waiters);
          this.outbound.delete(frame.streamId);
          out.onReset?.(rst);
        }
        const inb = this.inbound.get(frame.streamId);
        if (inb) {
          inb.closed = true;
          inb.abort.abort();
          this.wakeWaiters(inb.waiters);
          this.inbound.delete(frame.streamId);
          try {
            inb.controller?.error(new Error(rst.code));
          } catch {
            /* already closed */
          }
        }
        return;
      }
    }
  }
}
