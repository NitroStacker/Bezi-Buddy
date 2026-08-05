import { describe, expect, it } from "vitest";
import { parseAndroidBootstrapPayload } from "./android-bootstrap";

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

const fixture = {
  v: 1,
  relayUrl: "https://bright-proof.trycloudflare.com",
  ownerToken: "o".repeat(43),
  hostId: "host-proof-1234567890",
  mobileDeviceId: "mobile-proof-1234567890",
  pairSecret: "p".repeat(43),
  expiresAt: "2030-01-01T00:00:00.000Z",
};

describe("Android bootstrap links", () => {
  it("decodes a valid standalone pairing payload", () => {
    expect(parseAndroidBootstrapPayload(encode(fixture), Date.parse("2029-01-01"))).toEqual(fixture);
  });

  it("rejects expired payloads", () => {
    expect(() => parseAndroidBootstrapPayload(encode(fixture), Date.parse("2031-01-01"))).toThrow(
      "expired",
    );
  });

  it("requires an HTTPS relay", () => {
    expect(() =>
      parseAndroidBootstrapPayload(
        encode({ ...fixture, relayUrl: "http://127.0.0.1:8787" }),
        Date.parse("2029-01-01"),
      ),
    ).toThrow("HTTPS");
  });

  it("rejects malformed data without exposing parser details", () => {
    expect(() => parseAndroidBootstrapPayload("not-json", Date.now())).toThrow(
      "setup link is invalid",
    );
  });
});
