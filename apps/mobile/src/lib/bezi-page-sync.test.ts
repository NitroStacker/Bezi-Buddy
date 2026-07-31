import { describe, expect, it } from "vitest";
import {
  initialBeziPageSyncState,
  reduceBeziPageSyncState,
  shouldBlockForPageSync,
} from "./bezi-page-sync";

describe("Bezi page catalog sync", () => {
  it("shows syncing every time the Pages view is opened", () => {
    const ready = reduceBeziPageSyncState(initialBeziPageSyncState, {
      type: "completed",
    });

    expect(reduceBeziPageSyncState(ready, { type: "started" })).toEqual({
      phase: "syncing",
      message: null,
    });
  });

  it("reveals pages after success and offers retry after failure", () => {
    const syncing = reduceBeziPageSyncState(initialBeziPageSyncState, {
      type: "started",
    });
    expect(reduceBeziPageSyncState(syncing, { type: "completed" })).toEqual({
      phase: "ready",
      message: null,
    });

    const failed = reduceBeziPageSyncState(syncing, {
      type: "failed",
      message: "Desktop catalog unavailable",
    });
    expect(failed).toEqual({
      phase: "failed",
      message: "Desktop catalog unavailable",
    });
    expect(reduceBeziPageSyncState(failed, { type: "started" })).toEqual({
      phase: "syncing",
      message: null,
    });
  });

  it("keeps an existing page catalog visible while refresh runs or fails", () => {
    const syncing = reduceBeziPageSyncState(initialBeziPageSyncState, {
      type: "started",
    });
    const failed = reduceBeziPageSyncState(syncing, {
      type: "failed",
      message: "Refresh timed out",
    });

    expect(shouldBlockForPageSync(syncing, 0)).toBe(true);
    expect(shouldBlockForPageSync(syncing, 16)).toBe(false);
    expect(shouldBlockForPageSync(failed, 16)).toBe(false);
  });
});
