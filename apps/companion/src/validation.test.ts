import { describe, expect, it } from "vitest";
import { normalizeRelayUrl } from "./validation";

describe("normalizeRelayUrl", () => {
  it("allows HTTPS and removes a trailing slash", () => {
    expect(normalizeRelayUrl(" https://relay.example.com/ ")).toBe(
      "https://relay.example.com",
    );
  });

  it("allows HTTP only for local development", () => {
    expect(normalizeRelayUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(() => normalizeRelayUrl("http://relay.example.com")).toThrow();
  });
});

