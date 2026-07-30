import { beforeEach, describe, expect, it } from "vitest";
import { useRemoteStore } from "./remote-store";

describe("remote session safety state", () => {
  beforeEach(() => {
    useRemoteStore.setState({
      selectedHostId: null,
      connectionPhase: "idle",
      controllerDeviceId: null,
      leaseExpiresAt: null,
    });
  });

  it("clears control ownership when a session ends", () => {
    useRemoteStore.getState().setConnectionPhase("connected");
    useRemoteStore
      .getState()
      .setLease("mobile-12345678", "2026-07-29T03:00:00.000Z");
    useRemoteStore.getState().clearSession();
    expect(useRemoteStore.getState()).toMatchObject({
      connectionPhase: "idle",
      controllerDeviceId: null,
      leaseExpiresAt: null,
    });
  });

  it("keeps host selection separate from a transient connection", () => {
    useRemoteStore.getState().selectHost("host-12345678");
    useRemoteStore.getState().setConnectionPhase("error");
    expect(useRemoteStore.getState().selectedHostId).toBe("host-12345678");
  });
});

