import { describe, expect, it } from "vitest";
import {
  THREAD_FOLLOW_IDLE_MS,
  threadFollowResumeDelay,
} from "./thread-follow";

describe("thread follow", () => {
  it("waits for 15 seconds of scroll inactivity before resuming", () => {
    expect(threadFollowResumeDelay(1_000, 1_000)).toBe(THREAD_FOLLOW_IDLE_MS);
    expect(threadFollowResumeDelay(1_000, 15_999)).toBe(1);
    expect(threadFollowResumeDelay(1_000, 16_000)).toBe(0);
  });

  it("restarts the full cooldown after another interaction", () => {
    expect(threadFollowResumeDelay(10_000, 10_000)).toBe(THREAD_FOLLOW_IDLE_MS);
    expect(threadFollowResumeDelay(10_000, 20_000)).toBe(5_000);
  });

  it("does not resume early if the device clock moves backward", () => {
    expect(threadFollowResumeDelay(10_000, 9_000)).toBe(THREAD_FOLLOW_IDLE_MS);
  });
});
