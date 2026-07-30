import { describe, expect, it } from "vitest";
import { decodeBase64Url, decodeHex } from "./session-encoding";

describe("secure relay encoding", () => {
  it("decodes the companion's unpadded base64url secret", () => {
    expect(Array.from(decodeBase64Url("AAECA_7_"))).toEqual([
      0, 1, 2, 3, 254, 255,
    ]);
  });

  it("accepts only a 256-bit hexadecimal session salt", () => {
    expect(decodeHex("0b".repeat(32))).toEqual(new Uint8Array(32).fill(11));
    expect(() => decodeHex("0b")).toThrow(/32 bytes/);
  });
});
