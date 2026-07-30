import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import {
  base64ToBytes,
  bytesToBase64,
  concatBytes,
  utf8,
  utf8Text,
} from "./encoding";
import {
  decryptedPayloadSchema,
  encryptedFrameSchema,
  PROTOCOL_VERSION,
  type DecryptedPayload,
  type EncryptedFrame,
} from "./schemas";

export type SessionKeys = {
  mobileToHost: Uint8Array;
  hostToMobile: Uint8Array;
};

export function deriveSessionKeys(input: {
  pairSecret: Uint8Array;
  sessionSalt: Uint8Array;
  hostId: string;
  mobileDeviceId: string;
}): SessionKeys {
  if (input.pairSecret.length < 32) {
    throw new Error("Pair secret must contain at least 256 bits");
  }
  const info = utf8(
    `bezi-remote/v${PROTOCOL_VERSION}/${input.hostId}/${input.mobileDeviceId}`,
  );
  const material = hkdf(
    sha256,
    input.pairSecret,
    input.sessionSalt,
    info,
    64,
  );
  return {
    mobileToHost: material.slice(0, 32),
    hostToMobile: material.slice(32, 64),
  };
}

export function createNonce(prefix: Uint8Array, sequence: number): Uint8Array {
  if (prefix.length !== 4) {
    throw new Error("Nonce prefix must be four bytes");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Sequence must be a non-negative safe integer");
  }
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(sequence), false);
  return concatBytes(prefix, counter);
}

function associatedData(
  frame: Pick<
    EncryptedFrame,
    "v" | "hostId" | "connectionId" | "direction" | "kind" | "seq"
  >,
): Uint8Array {
  return utf8(
    [
      frame.v,
      frame.hostId,
      frame.connectionId,
      frame.direction,
      frame.kind,
      frame.seq,
    ].join("|"),
  );
}

export function encryptPayload(input: {
  key: Uint8Array;
  noncePrefix: Uint8Array;
  sequence: number;
  hostId: string;
  connectionId: string;
  direction: EncryptedFrame["direction"];
  kind: EncryptedFrame["kind"];
  payload: DecryptedPayload;
}): EncryptedFrame {
  const payload = decryptedPayloadSchema.parse(input.payload);
  const nonce = createNonce(input.noncePrefix, input.sequence);
  const header = {
    v: PROTOCOL_VERSION,
    hostId: input.hostId,
    connectionId: input.connectionId,
    direction: input.direction,
    kind: input.kind,
    seq: input.sequence,
  } as const;
  const cipher = gcm(input.key, nonce, associatedData(header));
  const ciphertext = cipher.encrypt(utf8(JSON.stringify(payload)));
  return encryptedFrameSchema.parse({
    ...header,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  });
}

export function decryptPayload(
  key: Uint8Array,
  untrustedFrame: unknown,
): DecryptedPayload {
  const frame = encryptedFrameSchema.parse(untrustedFrame);
  const nonce = base64ToBytes(frame.nonce);
  const ciphertext = base64ToBytes(frame.ciphertext);
  const plain = gcm(key, nonce, associatedData(frame)).decrypt(ciphertext);
  return decryptedPayloadSchema.parse(JSON.parse(utf8Text(plain)));
}

export class ReplayWindow {
  readonly #width: number;
  #highest = -1;
  #seen = new Set<number>();

  constructor(width = 128) {
    if (!Number.isInteger(width) || width < 1) {
      throw new Error("Replay window width must be positive");
    }
    this.#width = width;
  }

  accept(sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return false;
    if (sequence <= this.#highest - this.#width) return false;
    if (this.#seen.has(sequence)) return false;
    this.#highest = Math.max(this.#highest, sequence);
    this.#seen.add(sequence);
    const floor = this.#highest - this.#width;
    for (const value of this.#seen) {
      if (value <= floor) this.#seen.delete(value);
    }
    return true;
  }
}
