import { describe, expect, it } from "vitest";
import {
  isThreadAtEnd,
  shouldPauseThreadFollow,
  threadDistanceFromEnd,
} from "./thread-follow";

describe("thread follow", () => {
  it("pauses only after a deliberate drag toward older messages", () => {
    expect(shouldPauseThreadFollow(640, 620)).toBe(true);
    expect(shouldPauseThreadFollow(640, 636)).toBe(false);
    expect(shouldPauseThreadFollow(640, 680)).toBe(false);
  });

  it("recognizes returning to the newest message", () => {
    expect(isThreadAtEnd(threadDistanceFromEnd(1_200, 600, 600))).toBe(true);
    expect(isThreadAtEnd(threadDistanceFromEnd(1_200, 600, 570))).toBe(false);
  });

  it("treats short timelines as already at the end", () => {
    expect(threadDistanceFromEnd(400, 600, 0)).toBe(0);
  });
});
