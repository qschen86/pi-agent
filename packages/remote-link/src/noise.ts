import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** Noise Protocol Framework Rev 34: Noise_IK / Noise_IKpsk2 (25519 + ChaChaPoly + SHA256). */
export const DEFAULT_PROLOGUE = Buffer.from("heji-remote-v1", "utf8");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const EMPTY = Buffer.alloc(0);
const MAX_NONCE = (1n << 64n) - 2n;

export type NoiseErrorCode =
  | "invalid_key"
  | "low_order_point"
  | "handshake_order"
  | "handshake_payload_too_large"
  | "invalid_handshake"
  | "handshake_incomplete"
  | "handshake_closed"
  | "peer_revoked"
  | "decrypt_failed"
  | "nonce_exhausted"
  | "channel_closed";

export class NoiseError extends Error {
  constructor(public readonly code: NoiseErrorCode, message?: string) {
    super(message ?? code);
    this.name = "NoiseError";
  }
}

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hkdf2(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): [Buffer, Buffer] {
  const tempKey = hmacSha256(chainingKey, inputKeyMaterial);
  const out1 = hmacSha256(tempKey, Uint8Array.of(1));
  const out2 = hmacSha256(tempKey, Buffer.concat([out1, Uint8Array.of(2)]));
  tempKey.fill(0);
  return [out1, out2];
}

function hkdf3(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): [Buffer, Buffer, Buffer] {
  const tempKey = hmacSha256(chainingKey, inputKeyMaterial);
  const out1 = hmacSha256(tempKey, Uint8Array.of(1));
  const out2 = hmacSha256(tempKey, Buffer.concat([out1, Uint8Array.of(2)]));
  const out3 = hmacSha256(tempKey, Buffer.concat([out2, Uint8Array.of(3)]));
  tempKey.fill(0);
  return [out1, out2, out3];
}

function require32(bytes: Uint8Array | undefined, label: string): Buffer {
  if (!bytes || bytes.length !== 32) {
    throw new NoiseError("invalid_key", `${label} must be 32 bytes`);
  }
  return Buffer.from(bytes);
}

function makeNonce(n: bigint): Buffer {
  if (n < 0n || n > MAX_NONCE) throw new NoiseError("nonce_exhausted");
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(n, 4);
  return nonce;
}

function aeadEncrypt(key: Uint8Array, n: bigint, ad: Uint8Array, plaintext: Uint8Array): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, makeNonce(n), { authTagLength: 16 });
  if (ad.length > 0) cipher.setAAD(ad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ct, tag]);
}

function aeadDecrypt(key: Uint8Array, n: bigint, ad: Uint8Array, ciphertext: Uint8Array): Buffer {
  if (ciphertext.length < 16) throw new NoiseError("decrypt_failed");
  const ct = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  try {
    const decipher = createDecipheriv("chacha20-poly1305", key, makeNonce(n), { authTagLength: 16 });
    if (ad.length > 0) decipher.setAAD(ad, { plaintextLength: ct.length });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new NoiseError("decrypt_failed");
  }
}

export function generateStaticKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  return {
    privateKey: new Uint8Array(privDer.subarray(PKCS8_X25519_PREFIX.length)),
    publicKey: new Uint8Array(pubDer.subarray(SPKI_X25519_PREFIX.length)),
  };
}

export function x25519PublicFromPrivate(privateKey32: Uint8Array): Uint8Array {
  const priv = require32(privateKey32, "privateKey");
  const keyObj = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, priv]),
    format: "der",
    type: "pkcs8",
  });
  const pubDer = createPublicKey(keyObj).export({ type: "spki", format: "der" });
  return new Uint8Array(pubDer.subarray(SPKI_X25519_PREFIX.length));
}

export function x25519DH(privateKey32: Uint8Array, publicKey32: Uint8Array): Buffer {
  const priv = require32(privateKey32, "privateKey");
  const pub = require32(publicKey32, "publicKey");
  const privObj = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, priv]),
    format: "der",
    type: "pkcs8",
  });
  const pubObj = createPublicKey({
    key: Buffer.concat([SPKI_X25519_PREFIX, pub]),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey: privObj, publicKey: pubObj });
  // RFC 7748: reject all-zero shared secret from low-order points.
  let nonZero = 0;
  for (let i = 0; i < shared.length; i++) nonZero |= shared[i];
  if (nonZero === 0) {
    shared.fill(0);
    throw new NoiseError("low_order_point");
  }
  return shared;
}

class CipherState {
  private key: Buffer | null = null;
  private nonce = 0n;

  initializeKey(key: Uint8Array | null): void {
    this.key?.fill(0);
    this.key = key ? require32(key, "cipherKey") : null;
    this.nonce = 0n;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Buffer {
    if (!this.key) return Buffer.from(plaintext);
    const out = aeadEncrypt(this.key, this.nonce, ad, plaintext);
    this.nonce += 1n;
    return out;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Buffer {
    if (!this.key) return Buffer.from(ciphertext);
    const out = aeadDecrypt(this.key, this.nonce, ad, ciphertext);
    this.nonce += 1n;
    return out;
  }

  dispose(): void {
    this.key?.fill(0);
    this.key = null;
    this.nonce = 0n;
  }
}

class SymmetricState {
  private cipher = new CipherState();
  private ck: Buffer;
  private h: Buffer;

  constructor(protocolName: string) {
    const nameBytes = Buffer.from(protocolName, "ascii");
    this.h = nameBytes.length <= 32
      ? Buffer.concat([nameBytes, Buffer.alloc(32 - nameBytes.length)])
      : sha256(nameBytes);
    this.ck = Buffer.from(this.h);
  }

  get handshakeHash(): Uint8Array {
    return new Uint8Array(this.h);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(Buffer.concat([this.h, data]));
  }

  mixKey(ikm: Uint8Array): void {
    const [nextCk, tempK] = hkdf2(this.ck, ikm);
    this.ck.fill(0);
    this.ck = nextCk;
    this.cipher.initializeKey(tempK);
    tempK.fill(0);
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [nextCk, tempH, tempK] = hkdf3(this.ck, ikm);
    this.ck.fill(0);
    this.ck = nextCk;
    this.mixHash(tempH);
    tempH.fill(0);
    this.cipher.initializeKey(tempK);
    tempK.fill(0);
  }

  encryptAndHash(plaintext: Uint8Array): Buffer {
    const out = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(out);
    return out;
  }

  decryptAndHash(ciphertext: Uint8Array): Buffer {
    const out = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return out;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, EMPTY);
    const c1 = new CipherState();
    const c2 = new CipherState();
    c1.initializeKey(k1);
    c2.initializeKey(k2);
    k1.fill(0);
    k2.fill(0);
    return [c1, c2];
  }

  dispose(): void {
    this.cipher.dispose();
    this.ck.fill(0);
    this.h.fill(0);
  }
}

export class NoiseChannel {
  private closed = false;
  readonly handshakeHash: Uint8Array;
  readonly remoteStaticPublicKey: Uint8Array;

  constructor(
    private readonly sendCipher: CipherState,
    private readonly recvCipher: CipherState,
    handshakeHash: Uint8Array,
    remoteStaticPublicKey: Uint8Array,
  ) {
    this.handshakeHash = new Uint8Array(handshakeHash);
    this.remoteStaticPublicKey = new Uint8Array(remoteStaticPublicKey);
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (this.closed) throw new NoiseError("channel_closed");
    return new Uint8Array(this.sendCipher.encryptWithAd(EMPTY, plaintext));
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (this.closed) throw new NoiseError("channel_closed");
    return new Uint8Array(this.recvCipher.decryptWithAd(EMPTY, ciphertext));
  }

  safetyCode(): string {
    return deriveSafetyCode(this.handshakeHash);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sendCipher.dispose();
    this.recvCipher.dispose();
  }
}

/** 6-digit Short Authentication String derived from the Noise handshake transcript hash. */
export function deriveSafetyCode(handshakeHash: Uint8Array): string {
  const digest = sha256(Buffer.concat([Buffer.from(handshakeHash), Buffer.from("heji-sas-v1", "utf8")]));
  const num = digest.readUInt32BE(0) % 1_000_000;
  return String(num).padStart(6, "0");
}

export interface NoiseHandshakeOptions {
  role: "initiator" | "responder";
  staticPrivateKey: Uint8Array;
  /** Required for initiator; optional allowlist pin for responder. */
  remoteStaticPublicKey?: Uint8Array;
  /** Optional dynamic allowlist check on responder once initiator static public key is decrypted. */
  authorizeRemoteStatic?: (remoteStaticPublicKey: Uint8Array) => boolean;
  /** 32-byte one-time pre-shared key -> selects Noise_IKpsk2_25519_ChaChaPoly_SHA256. */
  psk?: Uint8Array;
  prologue?: Uint8Array;
  /** Deterministic ephemeral private key (for cross-platform test vectors only). */
  ephemeralPrivateKey?: Uint8Array;
}

export class NoiseHandshake {
  private readonly role: "initiator" | "responder";
  private readonly symmetric: SymmetricState;
  private readonly sPriv: Buffer;
  private readonly sPub: Buffer;
  private readonly ePriv: Buffer;
  private readonly ePub: Buffer;
  private readonly psk: Buffer | null;
  private readonly expectedRemoteS: Buffer | null;
  private readonly authorizeRemoteStatic?: (remoteStaticPublicKey: Uint8Array) => boolean;
  private remoteE: Buffer | null = null;
  private remoteS: Buffer | null = null;
  private step = 0;
  private closed = false;

  constructor(options: NoiseHandshakeOptions) {
    this.role = options.role;
    this.sPriv = require32(options.staticPrivateKey, "staticPrivateKey");
    this.sPub = Buffer.from(x25519PublicFromPrivate(this.sPriv));
    this.ePriv = options.ephemeralPrivateKey
      ? require32(options.ephemeralPrivateKey, "ephemeralPrivateKey")
      : Buffer.from(randomBytes(32));
    this.ePub = Buffer.from(x25519PublicFromPrivate(this.ePriv));
    this.psk = options.psk ? require32(options.psk, "psk") : null;
    this.expectedRemoteS = options.remoteStaticPublicKey
      ? require32(options.remoteStaticPublicKey, "remoteStaticPublicKey")
      : null;
    this.authorizeRemoteStatic = options.authorizeRemoteStatic;

    if (this.role === "initiator" && !this.expectedRemoteS) {
      throw new NoiseError("invalid_key", "initiator requires remoteStaticPublicKey");
    }
    if (this.role === "initiator") {
      this.remoteS = Buffer.from(this.expectedRemoteS!);
    }

    const pattern = this.psk ? "Noise_IKpsk2_25519_ChaChaPoly_SHA256" : "Noise_IK_25519_ChaChaPoly_SHA256";
    this.symmetric = new SymmetricState(pattern);
    this.symmetric.mixHash(options.prologue ?? DEFAULT_PROLOGUE);
    // Pre-message: <- s (responder static public key)
    this.symmetric.mixHash(this.role === "initiator" ? this.expectedRemoteS! : this.sPub);
  }

  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    return this.guard(() => {
      if (payload.length > 4096) throw new NoiseError("handshake_payload_too_large");
      const isInitiator = this.role === "initiator";
      if (this.step !== (isInitiator ? 0 : 1)) throw new NoiseError("handshake_order");

      const parts: Buffer[] = [this.ePub];
      this.symmetric.mixHash(this.ePub);
      if (this.psk) this.symmetric.mixKey(this.ePub);

      if (isInitiator) {
        this.mixDh(this.ePriv, this.remoteS!);
        parts.push(this.symmetric.encryptAndHash(this.sPub));
        this.mixDh(this.sPriv, this.remoteS!);
      } else {
        this.mixDh(this.ePriv, this.remoteE!);
        this.mixDh(this.ePriv, this.remoteS!);
        if (this.psk) this.symmetric.mixKeyAndHash(this.psk);
      }

      parts.push(this.symmetric.encryptAndHash(payload));
      this.step += 1;
      return new Uint8Array(Buffer.concat(parts));
    });
  }

  readMessage(message: Uint8Array): Uint8Array {
    return this.guard(() => {
      const isInitiator = this.role === "initiator";
      const minLen = isInitiator ? 48 : 96;
      if (this.step !== (isInitiator ? 1 : 0) || message.length < minLen || message.length > 4200) {
        throw new NoiseError("invalid_handshake");
      }

      this.remoteE = Buffer.from(message.subarray(0, 32));
      this.symmetric.mixHash(this.remoteE);
      if (this.psk) this.symmetric.mixKey(this.remoteE);

      let offset = 32;
      if (isInitiator) {
        this.mixDh(this.ePriv, this.remoteE);
        this.mixDh(this.sPriv, this.remoteE);
        if (this.psk) this.symmetric.mixKeyAndHash(this.psk);
      } else {
        this.mixDh(this.sPriv, this.remoteE);
        this.remoteS = this.symmetric.decryptAndHash(message.subarray(32, 80));
        offset = 80;
        if (this.expectedRemoteS && !timingSafeEqual(this.expectedRemoteS, this.remoteS)) {
          throw new NoiseError("peer_revoked");
        }
        if (this.authorizeRemoteStatic && !this.authorizeRemoteStatic(new Uint8Array(this.remoteS))) {
          throw new NoiseError("peer_revoked");
        }
        this.mixDh(this.sPriv, this.remoteS);
      }

      const payload = this.symmetric.decryptAndHash(message.subarray(offset));
      this.step += 1;
      return new Uint8Array(payload);
    });
  }

  finish(): NoiseChannel {
    return this.guard(() => {
      if (this.step !== 2 || !this.remoteS) throw new NoiseError("handshake_incomplete");
      const [c1, c2] = this.symmetric.split();
      const isInitiator = this.role === "initiator";
      const channel = new NoiseChannel(
        isInitiator ? c1 : c2,
        isInitiator ? c2 : c1,
        this.symmetric.handshakeHash,
        this.remoteS,
      );
      this.dispose();
      return channel;
    });
  }

  private mixDh(priv: Buffer, pub: Buffer): void {
    const shared = x25519DH(priv, pub);
    try {
      this.symmetric.mixKey(shared);
    } finally {
      shared.fill(0);
    }
  }

  private guard<T>(op: () => T): T {
    if (this.closed) throw new NoiseError("handshake_closed");
    try {
      return op();
    } catch (err) {
      this.dispose();
      if (err instanceof NoiseError) throw err;
      throw new NoiseError("invalid_handshake");
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.sPriv.fill(0);
    this.ePriv.fill(0);
    this.psk?.fill(0);
    this.symmetric.dispose();
  }
}
