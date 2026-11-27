import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPairingQrPayload,
  createRoomTicket,
  DataChannelFragmenter,
  DataChannelReassembler,
  decodeMuxFrame,
  decodePairingQr,
  deriveRoomSeed,
  deriveSafetyCode,
  encodeMuxFrame,
  encodePairingQr,
  generateStaticKeyPair,
  MuxFlags,
  MuxFrameType,
  NoiseError,
  NoiseHandshake,
  validateRoomTicket,
  x25519PublicFromPrivate,
} from "../src/index.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

describe("remote-link protocol (Noise / QR / Ticket / Fragment / Mux)", () => {
  it("completes Noise IKpsk2 pairing handshake with matching 6-digit safety code and bidirectional AEAD", () => {
    const host = generateStaticKeyPair();
    const client = generateStaticKeyPair();
    const psk = new Uint8Array(randomBytes(32));

    const init = new NoiseHandshake({
      role: "initiator",
      staticPrivateKey: client.privateKey,
      remoteStaticPublicKey: host.publicKey,
      psk,
    });
    const resp = new NoiseHandshake({
      role: "responder",
      staticPrivateKey: host.privateKey,
      psk,
    });

    const hello = Buffer.from(JSON.stringify({ deviceName: "Vivo X300", platform: "android" }));
    const m1 = init.writeMessage(hello);
    const recvHello = resp.readMessage(m1);
    expect(Buffer.from(recvHello).toString("utf8")).toBe(hello.toString("utf8"));

    const ack = Buffer.from(JSON.stringify({ ok: true }));
    const m2 = resp.writeMessage(ack);
    const recvAck = init.readMessage(m2);
    expect(Buffer.from(recvAck).toString("utf8")).toBe(ack.toString("utf8"));

    const cChan = init.finish();
    const hChan = resp.finish();
    expect(hex(cChan.handshakeHash)).toBe(hex(hChan.handshakeHash));
    expect(cChan.safetyCode()).toMatch(/^\d{6}$/);
    expect(cChan.safetyCode()).toBe(hChan.safetyCode());
    expect(hex(hChan.remoteStaticPublicKey)).toBe(hex(client.publicKey));

    for (let i = 0; i < 16; i++) {
      const msg = Buffer.from(`ping-${i}`);
      const ct = cChan.encrypt(msg);
      expect(Buffer.from(hChan.decrypt(ct)).toString()).toBe(`ping-${i}`);
      const reply = Buffer.from(`pong-${i}`);
      const ct2 = hChan.encrypt(reply);
      expect(Buffer.from(cChan.decrypt(ct2)).toString()).toBe(`pong-${i}`);
    }

    // Tampered ciphertext must fail authentication.
    const ct = cChan.encrypt(Buffer.from("secret"));
    ct[0] ^= 0xff;
    expect(() => hChan.decrypt(ct)).toThrow(NoiseError);

    cChan.close();
    hChan.close();
  });

  it("rejects wrong PSK, revoked device public key, and low-order public keys", () => {
    const host = generateStaticKeyPair();
    const client = generateStaticKeyPair();

    // Wrong PSK
    const initWrongPsk = new NoiseHandshake({
      role: "initiator",
      staticPrivateKey: client.privateKey,
      remoteStaticPublicKey: host.publicKey,
      psk: new Uint8Array(32).fill(1),
    });
    const respWrongPsk = new NoiseHandshake({
      role: "responder",
      staticPrivateKey: host.privateKey,
      psk: new Uint8Array(32).fill(2),
    });
    const m1 = initWrongPsk.writeMessage(Buffer.from("hi"));
    respWrongPsk.readMessage(m1);
    const m2 = respWrongPsk.writeMessage(Buffer.from("ok"));
    expect(() => initWrongPsk.readMessage(m2)).toThrow(NoiseError);

    // Revoked peer in IK reconnect
    const initRevoked = new NoiseHandshake({
      role: "initiator",
      staticPrivateKey: client.privateKey,
      remoteStaticPublicKey: host.publicKey,
    });
    const respRevoked = new NoiseHandshake({
      role: "responder",
      staticPrivateKey: host.privateKey,
      authorizeRemoteStatic: () => false,
    });
    const m1Rev = initRevoked.writeMessage();
    expect(() => respRevoked.readMessage(m1Rev)).toThrowError(/peer_revoked/);
  });

  it("encodes and decodes pairing QR with checksum, expiry, and relay validation", () => {
    const host = generateStaticKeyPair();
    const now = 1_795_400_000_000;
    const payload = createPairingQrPayload({
      relayUrl: "wss://relay-cn.example.com",
      hostPublicKey: host.publicKey,
      hostName: "Kisen MacBook Pro",
      now,
    });
    const qr = encodePairingQr(payload);
    expect(qr.startsWith("heji-pair:")).toBe(true);
    expect(qr.length).toBeLessThan(220);

    const decoded = decodePairingQr(qr, { now: now + 5_000 });
    expect(decoded.relayUrl).toBe("wss://relay-cn.example.com");
    expect(decoded.hostName).toBe("Kisen MacBook Pro");
    expect(hex(decoded.hostPublicKey)).toBe(hex(host.publicKey));
    expect(hex(decoded.psk)).toBe(hex(payload.psk));

    // Expired QR
    expect(() => decodePairingQr(qr, { now: now + 601_000 })).toThrowError(/pairing_expired/);
    // Tampered QR
    const tampered = qr.slice(0, -2) + (qr.endsWith("AA") ? "BB" : "AA");
    expect(() => decodePairingQr(tampered, { now: now + 5_000 })).toThrowError(/invalid_pairing/);
    // Insecure ws:// rejected by default
    expect(() =>
      createPairingQrPayload({
        relayUrl: "ws://example.com/relay",
        hostPublicKey: host.publicKey,
        hostName: "Mac",
        now,
      }),
    ).toThrowError(/invalid_relay/);
  });

  it("validates stateless rolling Room Tickets with +/- 1 UTC day tolerance", () => {
    const seed = deriveRoomSeed(new Uint8Array(32).fill(0x42));
    const now = 1_795_400_000_000;
    const period = Math.floor(now / 86_400_000);
    const ticket = createRoomTicket(seed, period);
    expect(ticket.roomId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ticket.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(validateRoomTicket(ticket, now)).toEqual(ticket);
    expect(validateRoomTicket(ticket, now + 86_400_000)).toEqual(ticket);
    expect(() => validateRoomTicket(ticket, now + 2 * 86_400_000)).toThrowError(/expired_room_ticket/);
    expect(() => validateRoomTicket({ ...ticket, credential: "A".repeat(43) }, now)).toThrowError(
      /invalid_room_ticket/,
    );
  });

  it("fragments and reassembles 200 KiB frames across 64 KiB DataChannel packets (including out-of-order)", () => {
    const fragmenter = new DataChannelFragmenter();
    const received: Uint8Array[] = [];
    const reassembler = new DataChannelReassembler((f) => received.push(f));

    const payload1 = new Uint8Array(randomBytes(200 * 1024));
    const payload2 = new Uint8Array(randomBytes(70 * 1024));
    const pkts1 = fragmenter.fragment(payload1);
    const pkts2 = fragmenter.fragment(payload2);
    expect(pkts1.length).toBe(4);
    expect(pkts2.length).toBe(2);

    // Deliver frame 2 before frame 1 finishes to verify strict ordering.
    for (const p of pkts2) reassembler.push(p);
    expect(received.length).toBe(0);
    for (const p of [...pkts1].reverse()) reassembler.push(p);
    expect(received.length).toBe(2);
    expect(createHash("sha256").update(received[0]).digest("hex")).toBe(
      createHash("sha256").update(payload1).digest("hex"),
    );
    expect(createHash("sha256").update(received[1]).digest("hex")).toBe(
      createHash("sha256").update(payload2).digest("hex"),
    );
    reassembler.dispose();
  });

  it("matches deterministic cross-platform golden vectors shared with Android Kotlin tests", () => {
    const vectorPath = resolve(import.meta.dirname, "golden-vectors.json");
    const v = JSON.parse(readFileSync(vectorPath, "utf8")) as {
      hostStaticPriv: string;
      hostStaticPub: string;
      clientStaticPriv: string;
      clientStaticPub: string;
      initEphemeralPriv: string;
      respEphemeralPriv: string;
      psk: string;
      ikpsk2: {
        m1PayloadHex: string;
        m2PayloadHex: string;
        m1Hex: string;
        m2Hex: string;
        handshakeHashHex: string;
        safetyCode: string;
        c2sPlaintextHex: string;
        c2sCiphertextHex: string;
        s2cPlaintextHex: string;
        s2cCiphertextHex: string;
      };
      ik: {
        m1Hex: string;
        m2Hex: string;
        handshakeHashHex: string;
        safetyCode: string;
        c2sCiphertextHex: string;
      };
      qr: {
        expiresAt: number;
        relayUrl: string;
        hostName: string;
        encoded: string;
      };
      ticket: {
        roomSeedHex: string;
        period: number;
        credential: string;
        roomId: string;
      };
      mux: {
        frameHex: string;
        streamId: number;
        type: number;
        flags: number;
        payloadHex: string;
      };
    };

    expect(hex(x25519PublicFromPrivate(unhex(v.hostStaticPriv)))).toBe(v.hostStaticPub);
    expect(hex(x25519PublicFromPrivate(unhex(v.clientStaticPriv)))).toBe(v.clientStaticPub);

    // Verify IKpsk2 golden vector
    const init = new NoiseHandshake({
      role: "initiator",
      staticPrivateKey: unhex(v.clientStaticPriv),
      remoteStaticPublicKey: unhex(v.hostStaticPub),
      psk: unhex(v.psk),
      ephemeralPrivateKey: unhex(v.initEphemeralPriv),
    });
    const resp = new NoiseHandshake({
      role: "responder",
      staticPrivateKey: unhex(v.hostStaticPriv),
      psk: unhex(v.psk),
      ephemeralPrivateKey: unhex(v.respEphemeralPriv),
    });
    const m1 = init.writeMessage(unhex(v.ikpsk2.m1PayloadHex));
    expect(hex(m1)).toBe(v.ikpsk2.m1Hex);
    expect(hex(resp.readMessage(m1))).toBe(v.ikpsk2.m1PayloadHex);
    const m2 = resp.writeMessage(unhex(v.ikpsk2.m2PayloadHex));
    expect(hex(m2)).toBe(v.ikpsk2.m2Hex);
    expect(hex(init.readMessage(m2))).toBe(v.ikpsk2.m2PayloadHex);
    const cChan = init.finish();
    const hChan = resp.finish();
    expect(hex(cChan.handshakeHash)).toBe(v.ikpsk2.handshakeHashHex);
    expect(deriveSafetyCode(cChan.handshakeHash)).toBe(v.ikpsk2.safetyCode);
    expect(hex(cChan.encrypt(unhex(v.ikpsk2.c2sPlaintextHex)))).toBe(v.ikpsk2.c2sCiphertextHex);
    expect(hex(hChan.decrypt(unhex(v.ikpsk2.c2sCiphertextHex)))).toBe(v.ikpsk2.c2sPlaintextHex);
    expect(hex(hChan.encrypt(unhex(v.ikpsk2.s2cPlaintextHex)))).toBe(v.ikpsk2.s2cCiphertextHex);
    expect(hex(cChan.decrypt(unhex(v.ikpsk2.s2cCiphertextHex)))).toBe(v.ikpsk2.s2cPlaintextHex);
    cChan.close();
    hChan.close();

    // Verify IK golden vector
    const initIk = new NoiseHandshake({
      role: "initiator",
      staticPrivateKey: unhex(v.clientStaticPriv),
      remoteStaticPublicKey: unhex(v.hostStaticPub),
      ephemeralPrivateKey: unhex(v.initEphemeralPriv),
    });
    const respIk = new NoiseHandshake({
      role: "responder",
      staticPrivateKey: unhex(v.hostStaticPriv),
      ephemeralPrivateKey: unhex(v.respEphemeralPriv),
    });
    const ikM1 = initIk.writeMessage();
    expect(hex(ikM1)).toBe(v.ik.m1Hex);
    respIk.readMessage(ikM1);
    const ikM2 = respIk.writeMessage();
    expect(hex(ikM2)).toBe(v.ik.m2Hex);
    initIk.readMessage(ikM2);
    const cIk = initIk.finish();
    const hIk = respIk.finish();
    expect(hex(cIk.handshakeHash)).toBe(v.ik.handshakeHashHex);
    expect(cIk.safetyCode()).toBe(v.ik.safetyCode);
    expect(hex(cIk.encrypt(unhex(v.ikpsk2.c2sPlaintextHex)))).toBe(v.ik.c2sCiphertextHex);
    expect(hex(hIk.decrypt(unhex(v.ik.c2sCiphertextHex)))).toBe(v.ikpsk2.c2sPlaintextHex);
    cIk.close();
    hIk.close();

    // Verify QR golden vector
    const qrDecoded = decodePairingQr(v.qr.encoded, { now: v.qr.expiresAt - 60_000 });
    expect(qrDecoded.relayUrl).toBe(v.qr.relayUrl);
    expect(qrDecoded.hostName).toBe(v.qr.hostName);
    expect(hex(qrDecoded.hostPublicKey)).toBe(v.hostStaticPub);
    expect(hex(qrDecoded.psk)).toBe(v.psk);

    // Verify Ticket golden vector
    const ticket = createRoomTicket(unhex(v.ticket.roomSeedHex), v.ticket.period);
    expect(ticket.credential).toBe(v.ticket.credential);
    expect(ticket.roomId).toBe(v.ticket.roomId);

    // Verify Mux frame golden vector
    const muxRaw = encodeMuxFrame({
      type: MuxFrameType.REQ_HEAD,
      flags: MuxFlags.END_STREAM,
      streamId: v.mux.streamId,
      payload: unhex(v.mux.payloadHex),
    });
    expect(hex(muxRaw)).toBe(v.mux.frameHex);
    const muxDecoded = decodeMuxFrame(muxRaw);
    expect(muxDecoded.streamId).toBe(v.mux.streamId);
    expect(muxDecoded.type).toBe(v.mux.type);
    expect(muxDecoded.flags).toBe(v.mux.flags);
    expect(hex(muxDecoded.payload)).toBe(v.mux.payloadHex);
  });
});
