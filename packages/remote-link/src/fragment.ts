/**
 * L2 DataChannel fragmentation & reassembly (V1.2 §3.2 & §4.5.1).
 * Header (8 bytes): [4B frameId uint32 BE] [2B seq uint16 BE] [2B total uint16 BE]
 */
export const MAX_FRAME_BYTES = 256 * 1024; // 256 KiB logical frame cap
export const DC_FRAGMENT_BYTES = 64 * 1024; // 64 KiB max packet on DataChannel
export const DC_FRAGMENT_HEADER_BYTES = 8;
export const DC_FRAGMENT_PAYLOAD_BYTES = DC_FRAGMENT_BYTES - DC_FRAGMENT_HEADER_BYTES;
const MAX_FRAGMENTS = Math.ceil(MAX_FRAME_BYTES / DC_FRAGMENT_PAYLOAD_BYTES);
const MAX_PENDING_FRAMES = 32;
const MAX_PENDING_BYTES = 2 * MAX_FRAME_BYTES;

export class FragmentError extends Error {
  constructor(
    public readonly code: "frame_too_large" | "invalid_fragment" | "capacity_exceeded" | "fragment_timeout",
  ) {
    super(code);
    this.name = "FragmentError";
  }
}

export class DataChannelFragmenter {
  private nextId = 1;

  fragment(frame: Uint8Array, maxPacketBytes = DC_FRAGMENT_BYTES): Uint8Array[] {
    if (frame.length > MAX_FRAME_BYTES) throw new FragmentError("frame_too_large");
    if (maxPacketBytes <= DC_FRAGMENT_HEADER_BYTES || maxPacketBytes > DC_FRAGMENT_BYTES) {
      throw new FragmentError("invalid_fragment");
    }
    const payloadMax = maxPacketBytes - DC_FRAGMENT_HEADER_BYTES;
    const total = Math.max(1, Math.ceil(frame.length / payloadMax));
    const frameId = this.nextId;
    this.nextId = (this.nextId + 1) >>> 0;
    if (this.nextId === 0) this.nextId = 1;

    const packets: Uint8Array[] = [];
    for (let seq = 0; seq < total; seq++) {
      const start = seq * payloadMax;
      const slice = frame.subarray(start, Math.min(frame.length, start + payloadMax));
      const packet = Buffer.allocUnsafe(DC_FRAGMENT_HEADER_BYTES + slice.length);
      packet.writeUInt32BE(frameId, 0);
      packet.writeUInt16BE(seq, 4);
      packet.writeUInt16BE(total, 6);
      Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).copy(packet, DC_FRAGMENT_HEADER_BYTES);
      packets.push(new Uint8Array(packet));
    }
    return packets;
  }
}

interface Assembly {
  readonly total: number;
  readonly chunks: Array<Uint8Array | undefined>;
  received: number;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

export class DataChannelReassembler {
  private readonly assemblies = new Map<number, Assembly>();
  private readonly completed = new Map<number, Uint8Array>();
  private expectedFrameId = 1;
  private pendingBytes = 0;

  constructor(
    private readonly onFrame: (frame: Uint8Array) => void,
    private readonly onError?: (err: FragmentError) => void,
    private readonly reassemblyTimeoutMs = 10_000,
  ) {}

  push(packet: Uint8Array): void {
    if (packet.length < DC_FRAGMENT_HEADER_BYTES || packet.length > DC_FRAGMENT_BYTES) {
      this.fail(new FragmentError("invalid_fragment"));
      return;
    }
    const view = new DataView(packet.buffer, packet.byteOffset, DC_FRAGMENT_HEADER_BYTES);
    const frameId = view.getUint32(0, false);
    const seq = view.getUint16(4, false);
    const total = view.getUint16(6, false);
    const distance = (frameId - this.expectedFrameId) >>> 0;
    if (
      frameId === 0 ||
      total < 1 ||
      total > MAX_FRAGMENTS ||
      seq >= total ||
      distance >= MAX_PENDING_FRAMES ||
      this.completed.has(frameId)
    ) {
      this.fail(new FragmentError("invalid_fragment"));
      return;
    }

    const payload = packet.subarray(DC_FRAGMENT_HEADER_BYTES);
    let assembly = this.assemblies.get(frameId);
    if (!assembly) {
      const timer = setTimeout(() => this.fail(new FragmentError("fragment_timeout")), this.reassemblyTimeoutMs);
      assembly = { total, chunks: new Array(total), received: 0, bytes: 0, timer };
      this.assemblies.set(frameId, assembly);
    }
    if (assembly.total !== total || assembly.chunks[seq] !== undefined) {
      this.fail(new FragmentError("invalid_fragment"));
      return;
    }

    const copy = new Uint8Array(payload);
    assembly.chunks[seq] = copy;
    assembly.received += 1;
    assembly.bytes += copy.length;
    this.pendingBytes += copy.length;
    if (assembly.bytes > MAX_FRAME_BYTES || this.pendingBytes > MAX_PENDING_BYTES) {
      this.fail(new FragmentError("capacity_exceeded"));
      return;
    }

    if (assembly.received !== total) return;
    clearTimeout(assembly.timer);
    this.assemblies.delete(frameId);

    const assembled = new Uint8Array(assembly.bytes);
    let offset = 0;
    for (const chunk of assembly.chunks) {
      if (!chunk) {
        this.fail(new FragmentError("invalid_fragment"));
        return;
      }
      assembled.set(chunk, offset);
      offset += chunk.length;
    }
    this.completed.set(frameId, assembled);
    this.flush();
  }

  private flush(): void {
    while (true) {
      const frame = this.completed.get(this.expectedFrameId);
      if (!frame) return;
      this.completed.delete(this.expectedFrameId);
      this.pendingBytes -= frame.length;
      this.expectedFrameId = (this.expectedFrameId + 1) >>> 0;
      if (this.expectedFrameId === 0) this.expectedFrameId = 1;
      this.onFrame(frame);
    }
  }

  private fail(err: FragmentError): void {
    this.dispose();
    if (this.onError) this.onError(err);
    else throw err;
  }

  dispose(): void {
    for (const a of this.assemblies.values()) clearTimeout(a.timer);
    this.assemblies.clear();
    this.completed.clear();
    this.pendingBytes = 0;
  }
}
