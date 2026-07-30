import { describe, expect, it } from "vitest";
import {
  decryptPayload,
  deriveSessionKeys,
  encryptPayload,
  ReplayWindow,
} from "./crypto";
import { base64ToBytes, bytesToBase64, utf8 } from "./encoding";

const pairSecret = new Uint8Array(32).fill(7);
const sessionSalt = new Uint8Array(32).fill(11);

describe("encoding", () => {
  it("round-trips base64 without Node globals", () => {
    const value = utf8("Bezi Remote ✓");
    expect(base64ToBytes(bytesToBase64(value))).toEqual(value);
  });
});

describe("session encryption", () => {
  const keys = deriveSessionKeys({
    pairSecret,
    sessionSalt,
    hostId: "host-12345678",
    mobileDeviceId: "mobile-12345678",
  });

  const frame = encryptPayload({
    key: keys.mobileToHost,
    noncePrefix: new Uint8Array([1, 2, 3, 4]),
    sequence: 4,
    hostId: "host-12345678",
    connectionId: "94e41b83-0d80-48ca-927c-5234d17d61d9",
    direction: "mobile-to-host",
    kind: "control",
    payload: {
      v: 1,
      requestId: "6a55dfb0-3af1-43db-8f77-409a8a931965",
      type: "system.lease.acquire",
      body: { durationSeconds: 30 },
    },
  });

  it("round-trips an authenticated payload", () => {
    expect(decryptPayload(keys.mobileToHost, frame)).toMatchObject({
      type: "system.lease.acquire",
      body: { durationSeconds: 30 },
    });
  });

  it("rejects tampered ciphertext", () => {
    const bytes = base64ToBytes(frame.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() =>
      decryptPayload(keys.mobileToHost, {
        ...frame,
        ciphertext: bytesToBase64(bytes),
      }),
    ).toThrow();
  });

  it("derives direction-specific keys", () => {
    expect(keys.mobileToHost).not.toEqual(keys.hostToMobile);
  });
});

describe("ReplayWindow", () => {
  it("accepts reordering but rejects duplicates and expired sequences", () => {
    const window = new ReplayWindow(4);
    expect(window.accept(5)).toBe(true);
    expect(window.accept(3)).toBe(true);
    expect(window.accept(3)).toBe(false);
    expect(window.accept(9)).toBe(true);
    expect(window.accept(5)).toBe(false);
  });
});
