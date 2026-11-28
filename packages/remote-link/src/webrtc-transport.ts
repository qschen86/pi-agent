import type { DataChannel, PeerConnection } from "node-datachannel";
import { DataChannelFragmenter, DataChannelReassembler } from "./fragment.js";
import type { BinaryFrameLink } from "./mux.js";
import {
  classifyCandidatePair,
  DEFAULT_STUN_SERVERS,
  type DirectPathKind,
  P2P_BACKPRESSURE_HIGH_WATER,
  P2P_BACKPRESSURE_LOW_WATER,
  P2P_DATA_CHANNEL_LABEL,
  P2P_PACKET_MAX_BYTES,
} from "./p2p-protocol.js";

type NodeDataChannelModule = typeof import("node-datachannel");
let cachedModulePromise: Promise<NodeDataChannelModule | null> | null = null;

async function loadNodeDataChannel(): Promise<NodeDataChannelModule | null> {
  if (!cachedModulePromise) {
    cachedModulePromise = import("node-datachannel")
      .then((mod) => mod)
      .catch(() => null);
  }
  return cachedModulePromise;
}

export interface WebRtcDirectLinkOptions {
  peerName: string;
  role: "offerer" | "answerer";
  iceServers?: readonly string[];
  onLocalDescription: (sdp: string, type: "offer" | "answer") => void;
  onLocalCandidate: (candidate: string, mid: string) => void;
  onOpen?: () => void;
  onClose?: (reason: string) => void;
}

/**
 * Node.js WebRTC DataChannel BinaryFrameLink backed by node-datachannel (libdatachannel, P0 selection).
 * Handles:
 * - Cloudflare public STUN (stun:stun.cloudflare.com:3478) ICE gathering & NAT hole punching
 * - Remote ICE candidate buffering until setRemoteDescription completes (P0 gotcha)
 * - 16 KiB fragmentation/reassembly for frames up to 256 KiB
 * - bufferedAmount high/low water backpressure queue
 * - Exception isolation inside native Node-API callbacks (prevents DEP0168 crashes)
 */
export class WebRtcDirectLink implements BinaryFrameLink {
  private pc: PeerConnection | null = null;
  private dc: DataChannel | null = null;
  private readonly fragmenter = new DataChannelFragmenter();
  private readonly reassembler: DataChannelReassembler;
  private readonly listeners = new Set<(frame: Uint8Array) => void>();
  private readonly pendingRemoteCandidates: Array<{ candidate: string; mid: string }> = [];
  private readonly sendQueue: Uint8Array[] = [];
  private remoteDescriptionApplied = false;
  private open = false;
  private closed = false;

  private constructor(
    private readonly mod: NodeDataChannelModule,
    private readonly options: WebRtcDirectLinkOptions,
  ) {
    this.reassembler = new DataChannelReassembler(
      (frame) => {
        for (const fn of [...this.listeners]) {
          try {
            fn(frame);
          } catch {
            /* isolate listener errors */
          }
        }
      },
      (err) => {
        this.close(`fragment_${err.code}`);
      },
    );

    const iceServers = [...(options.iceServers ?? DEFAULT_STUN_SERVERS)];
    const pc = new mod.PeerConnection(options.peerName, { iceServers });
    this.pc = pc;

    pc.onLocalDescription((sdp, type) => {
      try {
        if (this.closed) return;
        if (type === "offer" || type === "answer") {
          this.options.onLocalDescription(sdp, type);
        }
      } catch {
        /* shield native callback */
      }
    });

    pc.onLocalCandidate((candidate, mid) => {
      try {
        if (this.closed || !candidate) return;
        this.options.onLocalCandidate(candidate, mid);
      } catch {
        /* shield native callback */
      }
    });

    pc.onStateChange((state) => {
      try {
        if (this.closed) return;
        if (state === "failed" || state === "disconnected" || state === "closed") {
          this.close(`pc_${state}`);
        }
      } catch {
        /* shield native callback */
      }
    });

    if (options.role === "offerer") {
      const dc = pc.createDataChannel(P2P_DATA_CHANNEL_LABEL, { unordered: false });
      this.attachDataChannel(dc);
    } else {
      pc.onDataChannel((dc) => {
        try {
          if (this.closed) {
            dc.close();
            return;
          }
          this.attachDataChannel(dc);
        } catch {
          /* shield native callback */
        }
      });
    }
  }

  static async create(options: WebRtcDirectLinkOptions): Promise<WebRtcDirectLink> {
    const mod = await loadNodeDataChannel();
    if (!mod) throw new Error("node_datachannel_unavailable");
    return new WebRtcDirectLink(mod, options);
  }

  get isOpen(): boolean {
    return this.open && !this.closed;
  }

  setRemoteDescription(sdp: string, type: "offer" | "answer"): void {
    if (this.closed || !this.pc) return;
    this.pc.setRemoteDescription(sdp, type);
    this.remoteDescriptionApplied = true;
    while (this.pendingRemoteCandidates.length > 0) {
      const item = this.pendingRemoteCandidates.shift()!;
      try {
        this.pc.addRemoteCandidate(item.candidate, item.mid);
      } catch {
        /* ignore stale/malformed remote candidate */
      }
    }
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    if (this.closed || !this.pc || !candidate) return;
    if (!this.remoteDescriptionApplied) {
      this.pendingRemoteCandidates.push({ candidate, mid });
      return;
    }
    try {
      this.pc.addRemoteCandidate(candidate, mid);
    } catch {
      /* ignore invalid candidate */
    }
  }

  detectPathKind(): DirectPathKind {
    try {
      const pair = this.pc?.getSelectedCandidatePair();
      if (!pair) return "p2p";
      return classifyCandidatePair(pair.local?.type, pair.remote?.type);
    } catch {
      return "p2p";
    }
  }

  send(frame: Uint8Array): void {
    if (this.closed || !this.open || !this.dc) {
      throw new Error("webrtc_not_open");
    }
    const packets = this.fragmenter.fragment(frame, P2P_PACKET_MAX_BYTES);
    for (const pkt of packets) {
      this.sendQueue.push(pkt);
    }
    this.flushSendQueue();
  }

  onFrame(handler: (frame: Uint8Array) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.sendQueue.length = 0;
    this.pendingRemoteCandidates.length = 0;
    this.reassembler.dispose();
    const dc = this.dc;
    const pc = this.pc;
    this.dc = null;
    this.pc = null;
    try {
      dc?.close();
    } catch {
      /* ignore */
    }
    try {
      pc?.close();
    } catch {
      /* ignore */
    }
    this.listeners.clear();
    try {
      this.options.onClose?.(reason);
    } catch {
      /* ignore */
    }
  }

  private attachDataChannel(dc: DataChannel): void {
    this.dc = dc;
    try {
      dc.setBufferedAmountLowThreshold(P2P_BACKPRESSURE_LOW_WATER);
    } catch {
      /* ignore */
    }

    dc.onOpen(() => {
      try {
        if (this.closed) return;
        this.open = true;
        this.options.onOpen?.();
        this.flushSendQueue();
      } catch {
        /* shield native callback */
      }
    });

    dc.onBufferedAmountLow(() => {
      try {
        this.flushSendQueue();
      } catch {
        /* shield native callback */
      }
    });

    dc.onMessage((msg) => {
      try {
        if (this.closed) return;
        if (typeof msg === "string") return;
        const bytes = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
        this.reassembler.push(bytes);
      } catch {
        /* shield native callback */
      }
    });

    dc.onError((err) => {
      try {
        this.close(`dc_error:${err}`);
      } catch {
        /* shield native callback */
      }
    });

    dc.onClosed(() => {
      try {
        this.close("dc_closed");
      } catch {
        /* shield native callback */
      }
    });

    if (dc.isOpen()) {
      this.open = true;
      try {
        this.options.onOpen?.();
      } catch {
        /* ignore */
      }
    }
  }

  private flushSendQueue(): void {
    const dc = this.dc;
    if (this.closed || !this.open || !dc) return;
    while (this.sendQueue.length > 0) {
      if (dc.bufferedAmount() > P2P_BACKPRESSURE_HIGH_WATER) return;
      const pkt = this.sendQueue.shift()!;
      const ok = dc.sendMessageBinary(Buffer.from(pkt.buffer, pkt.byteOffset, pkt.byteLength));
      if (!ok) {
        this.close("dc_send_failed");
        return;
      }
    }
  }
}
