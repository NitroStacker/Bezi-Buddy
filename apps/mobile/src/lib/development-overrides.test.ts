import { describe, expect, it } from "vitest";
import { developmentOverride } from "./development-overrides";

describe("development credential overrides", () => {
  it("keeps proof credentials available to development clients", () => {
    expect(developmentOverride("proof-value", true)).toBe("proof-value");
  });

  it("does not override saved credentials in installed release clients", () => {
    expect(developmentOverride("proof-value", false)).toBeUndefined();
  });
});
