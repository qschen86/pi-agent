import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const DAY_MS = 86_400_000;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

export interface RoomTicket {
  roomId: string;
  credential: string;
  period: number;
}

export function currentRoomPeriod(now = Date.now()): number {
  return Math.floor(now / DAY_MS);
}

/** Derive an independent 32-byte room ticket seed from a shared secret (e.g. pairing secret or static DH). */
export function deriveRoomSeed(sharedSecret: Uint8Array, salt: Uint8Array = Buffer.alloc(0)): Uint8Array {
  if (sharedSecret.length < 32) throw new Error("sharedSecret must be at least 32 bytes");
  return new Uint8Array(hkdfSync("sha256", sharedSecret, salt, Buffer.from("heji-room-v1", "utf8"), 32));
}

export function createRoomTicket(roomSeed: Uint8Array, period = currentRoomPeriod()): RoomTicket {
  if (roomSeed.length !== 32) throw new Error("roomSeed must be 32 bytes");
  if (!Number.isSafeInteger(period) || period < 0) throw new Error("invalid period");
  const credential = createHmac("sha256", roomSeed).update(`cred:${period}`).digest("base64url");
  const roomId = createHash("sha256").update(`heji-room-v1:${period}:${credential}`).digest("base64url");
  return { roomId, credential, period };
}

/** Stateless validation executed by Relay (zero DB lookup). Allows +/- 1 UTC day boundary skew. */
export function validateRoomTicket(
  input: { roomId: string | null | undefined; credential: string | null | undefined; period: number },
  now = Date.now(),
): RoomTicket {
  if (
    typeof input.roomId !== "string" ||
    typeof input.credential !== "string" ||
    !BASE64URL_43.test(input.roomId) ||
    !BASE64URL_43.test(input.credential) ||
    !Number.isSafeInteger(input.period)
  ) {
    throw new Error("invalid_room_ticket");
  }
  const cur = currentRoomPeriod(now);
  if (Math.abs(input.period - cur) > 1) {
    throw new Error("expired_room_ticket");
  }
  const expected = createHash("sha256")
    .update(`heji-room-v1:${input.period}:${input.credential}`)
    .digest("base64url");
  if (!timingSafeEqual(Buffer.from(expected, "ascii"), Buffer.from(input.roomId, "ascii"))) {
    throw new Error("invalid_room_ticket");
  }
  return { roomId: input.roomId, credential: input.credential, period: input.period };
}
