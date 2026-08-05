import { describe, expect, it } from "vitest";
import { isExpired, sha256Base64Url, timingSafeEqual } from "../src/security";
import { mobileBootstrapResponse } from "../src/mobile-bootstrap";

describe("relay security helpers", () => {
  it("hashes claim codes deterministically without preserving plaintext", async () => {
    const hash = await sha256Base64Url("correct horse battery staple");
    expect(hash).toBe(await sha256Base64Url("correct horse battery staple"));
    expect(hash).not.toContain("horse");
  });

  it("compares secrets and handles different lengths", () => {
    expect(timingSafeEqual("same-secret", "same-secret")).toBe(true);
    expect(timingSafeEqual("same-secret", "other")).toBe(false);
  });

  it("treats invalid and past timestamps as expired", () => {
    expect(isExpired("not-a-date")).toBe(true);
    expect(isExpired("2020-01-01T00:00:00.000Z")).toBe(true);
    expect(isExpired("2999-01-01T00:00:00.000Z")).toBe(false);
  });
});

describe("Android bootstrap landing page", () => {
  it("keeps credentials in the browser fragment and disables caching", async () => {
    const response = mobileBootstrapResponse();
    const body = await response.text();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(body).toContain("location.hash");
    expect(body).toContain("beziremote://bootstrap");
    expect(body).not.toContain("ownerToken");
  });
});
