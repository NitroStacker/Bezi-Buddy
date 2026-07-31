import { describe, expect, it } from "vitest";
import {
  areBeziHistoriesEqual,
  buildBeziLineDiff,
  decideBeziHistorySync,
  parseBeziSessions,
  parseLoadedBeziHistory,
  reduceBeziSessionUpdate,
  resolveBeziHistoryReconciliation,
  statusFromBeziUpdate,
  type BeziChatEntry,
} from "./bezi-session";

describe("Bezi session history", () => {
  it("parses and sorts live ACP session metadata", () => {
    expect(
      parseBeziSessions([
        {
          sessionId: "older",
          cwd: "R:\\Game",
          title: "Older thread",
          updatedAt: "2026-07-01T00:00:00Z",
        },
        {
          sessionId: "newer",
          threadId: "thread-newer",
          cwd: "R:\\Game",
          title: "Newer thread",
          updatedAt: "2026-07-02T00:00:00Z",
        },
      ]).map((session) => session.id),
    ).toEqual(["newer", "older"]);
    expect(
      parseBeziSessions([
        { sessionId: "newer", threadId: "thread-newer", title: "Newest" },
      ])[0]?.threadId,
    ).toBe("thread-newer");
  });

  it("keeps replayed messages separated by Bezi activity", () => {
    const updates = [
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Build the camera." },
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Inspecting the current scene." },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I found the existing rig." },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Edit FixedFollowCamera.cs",
        status: "pending",
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Edit FixedFollowCamera.cs",
        status: "completed",
        content: [{ type: "diff", path: "FixedFollowCamera.cs", newText: "..." }],
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The camera now follows correctly." },
      },
    ];
    const result = updates.reduce<BeziChatEntry[]>(
      reduceBeziSessionUpdate,
      [],
    );
    expect(result.map((entry) => entry.role)).toEqual([
      "user",
      "activity",
      "assistant",
      "activity",
      "assistant",
    ]);
    expect(result[3]).toMatchObject({
      id: "tool-1",
      text: "Edit FixedFollowCamera.cs",
      activityKind: "code",
      status: "completed",
      files: [
        {
          path: "FixedFollowCamera.cs",
          newText: "...",
          oldText: "",
          additions: 1,
          deletions: 0,
        },
      ],
    });
    expect(result[1]).toMatchObject({
      activityKind: "thought",
      detail: "Inspecting the current scene.",
    });
  });

  it("joins consecutive chunks from one streamed message", () => {
    const first = reduceBeziSessionUpdate([], {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello " },
    });
    const second = reduceBeziSessionUpdate(first, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world" },
    });
    expect(second).toHaveLength(1);
    expect(second[0].text).toBe("Hello world");
  });

  it("coalesces anonymous thought chunks in large replayed histories", () => {
    const result = [
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Inspecting " },
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "the canvas." },
      },
    ].reduce<BeziChatEntry[]>(reduceBeziSessionUpdate, []);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: "activity",
      activityKind: "thought",
      detail: "Inspecting the canvas.",
    });
  });

  it("does not duplicate an optimistically rendered user prompt", () => {
    const result = reduceBeziSessionUpdate(
      [{ id: "request-1", role: "user", text: "Make the camera smoother." }],
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Make the camera smoother." },
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Make the camera smoother.");
  });

  it("supports agents that return embedded history in load results", () => {
    expect(
      parseLoadedBeziHistory({
        messages: [
          { id: "u1", role: "user", content: [{ type: "text", text: "Hi" }] },
          { id: "a1", role: "agent", content: { type: "text", text: "Hello" } },
        ],
      }),
    ).toMatchObject([
      { id: "u1", role: "user", text: "Hi" },
      { id: "a1", role: "assistant", text: "Hello" },
    ]);
  });

  it("atomically replaces history after replay without erasing on an empty resync", () => {
    const replay = [{ id: "a1", role: "assistant" as const, text: "Synced" }];
    expect(resolveBeziHistoryReconciliation([], replay, false)).toEqual(replay);
    expect(resolveBeziHistoryReconciliation([], [], false)).toBeNull();
    expect(resolveBeziHistoryReconciliation([], [], true)).toEqual([]);
  });

  it("reconciles missed desktop changes and verifies live changes after quieting", () => {
    expect(
      decideBeziHistorySync({
        previousRevision: "1",
        nextRevision: "2",
        pendingRevision: null,
        lastLiveEventAt: 0,
        now: 10_000,
      }),
    ).toEqual({ action: "reconcile", pendingRevision: null });

    const duringLiveStream = decideBeziHistorySync({
      previousRevision: "1",
      nextRevision: "2",
      pendingRevision: null,
      lastLiveEventAt: 9_500,
      now: 10_000,
    });
    expect(duringLiveStream).toEqual({
      action: "wait",
      pendingRevision: "2",
    });
    expect(
      decideBeziHistorySync({
        previousRevision: "2",
        nextRevision: "2",
        pendingRevision: duringLiveStream.pendingRevision,
        lastLiveEventAt: 9_500,
        now: 13_000,
      }),
    ).toEqual({ action: "reconcile", pendingRevision: null });
  });

  it("detects unchanged snapshots and exposes agent activity status", () => {
    const history = [{ id: "a1", role: "assistant" as const, text: "Hello" }];
    expect(areBeziHistoriesEqual(history, [...history])).toBe(true);
    expect(
      areBeziHistoriesEqual(history, [{ ...history[0], text: "Updated" }]),
    ).toBe(false);
    expect(
      statusFromBeziUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Inspecting" },
      }),
    ).toEqual({ label: "Thinking", active: true });
    expect(
      statusFromBeziUpdate({
        sessionUpdate: "tool_call",
        title: "Edit Camera.cs",
        status: "in_progress",
      }),
    ).toEqual({
      label: "Working",
      detail: "Edit Camera.cs",
      active: true,
    });
    expect(
      statusFromBeziUpdate({
        sessionUpdate: "session_info_update",
        status: "cancelled",
      }),
    ).toEqual({
      label: "Cancelled",
      detail: "Stopped in Bezi",
      active: false,
    });
    expect(
      statusFromBeziUpdate({
        type: "turn_ended",
        stopReason: "aborted",
      }),
    ).toEqual({
      label: "Stopped",
      detail: "The Bezi turn ended early",
      active: false,
    });
  });

  it("builds full line-level script diffs for the mobile viewer", () => {
    expect(
      buildBeziLineDiff({
        path: "Camera.cs",
        oldText: "one\ntwo\nthree",
        newText: "one\nupdated\nthree\nfour",
        additions: 2,
        deletions: 1,
      }),
    ).toEqual([
      { kind: "context", text: "one", oldNumber: 1, newNumber: 1 },
      { kind: "removed", text: "two", oldNumber: 2 },
      { kind: "added", text: "updated", newNumber: 2 },
      { kind: "context", text: "three", oldNumber: 3, newNumber: 3 },
      { kind: "added", text: "four", newNumber: 4 },
    ]);
  });
});
