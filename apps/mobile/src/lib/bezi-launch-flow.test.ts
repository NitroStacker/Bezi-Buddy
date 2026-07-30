import { describe, expect, it } from "vitest";
import {
  initialBeziLaunchState,
  isBeziLaunchPending,
  reduceBeziLaunchState,
} from "./bezi-launch-flow";

describe("Bezi launch flow", () => {
  it("waits for explicit workspace and project choices", () => {
    const loading = reduceBeziLaunchState(initialBeziLaunchState, {
      type: "connected",
    });
    const workspaceChoice = reduceBeziLaunchState(loading, {
      type: "catalog-ready",
    });

    expect(workspaceChoice).toMatchObject({
      phase: "choose-workspace",
      workspaceId: null,
      projectId: null,
    });

    const projectChoice = reduceBeziLaunchState(workspaceChoice, {
      type: "choose-workspace",
      workspaceId: "only-workspace",
    });
    expect(projectChoice).toMatchObject({
      phase: "choose-project",
      workspaceId: "only-workspace",
      projectId: null,
    });

    const threadsLoading = reduceBeziLaunchState(projectChoice, {
      type: "choose-project",
      projectId: "only-project",
    });
    expect(threadsLoading).toMatchObject({
      phase: "loading-threads",
      projectId: "only-project",
    });
  });

  it("supports returning from project choice without auto-selecting a project", () => {
    const state = {
      ...initialBeziLaunchState,
      phase: "choose-project" as const,
      workspaceId: "workspace-1",
    };
    expect(
      reduceBeziLaunchState(state, { type: "back-to-workspaces" }),
    ).toMatchObject({
      phase: "choose-workspace",
      workspaceId: "workspace-1",
      projectId: null,
    });
  });

  it("reveals the app immediately for a project without threads", () => {
    const state = {
      ...initialBeziLaunchState,
      phase: "loading-threads" as const,
      workspaceId: "workspace-1",
      projectId: "project-1",
    };
    const ready = reduceBeziLaunchState(state, { type: "threads-empty" });
    expect(ready.phase).toBe("ready");
    expect(isBeziLaunchPending(ready)).toBe(false);
  });

  it("waits for newest-thread history before revealing the app", () => {
    const state = {
      ...initialBeziLaunchState,
      phase: "loading-threads" as const,
      workspaceId: "workspace-1",
      projectId: "project-1",
    };
    const historyLoading = reduceBeziLaunchState(state, {
      type: "threads-ready",
    });
    expect(historyLoading.phase).toBe("loading-thread");
    expect(isBeziLaunchPending(historyLoading)).toBe(true);
    expect(
      reduceBeziLaunchState(historyLoading, { type: "thread-ready" }).phase,
    ).toBe("ready");
  });

  it("retries only the failed initial operation", () => {
    const state = {
      ...initialBeziLaunchState,
      phase: "loading-thread" as const,
      workspaceId: "workspace-1",
      projectId: "project-1",
    };
    const failed = reduceBeziLaunchState(state, {
      type: "failed",
      operation: "thread",
      message: "Could not open the newest thread.",
    });
    expect(failed).toMatchObject({
      phase: "error",
      error: { operation: "thread" },
    });
    expect(reduceBeziLaunchState(failed, { type: "retry" }).phase).toBe(
      "loading-thread",
    );
  });

  it("retains choices and resumes the interrupted request after reconnecting", () => {
    const loading = {
      ...initialBeziLaunchState,
      phase: "loading-threads" as const,
      workspaceId: "workspace-1",
      projectId: "project-1",
    };
    const disconnected = reduceBeziLaunchState(loading, {
      type: "disconnected",
    });
    expect(disconnected).toMatchObject({
      phase: "connecting",
      resumePhase: "loading-threads",
      workspaceId: "workspace-1",
      projectId: "project-1",
    });
    expect(
      reduceBeziLaunchState(disconnected, { type: "connected" }),
    ).toMatchObject({
      phase: "loading-threads",
      workspaceId: "workspace-1",
      projectId: "project-1",
    });
  });

  it("keeps the populated app ready during a foreground reconnect", () => {
    const ready = {
      ...initialBeziLaunchState,
      phase: "ready" as const,
      workspaceId: "workspace-1",
      projectId: "project-1",
    };

    const disconnected = reduceBeziLaunchState(ready, {
      type: "disconnected",
    });

    expect(disconnected).toEqual(ready);
    expect(
      reduceBeziLaunchState(disconnected, { type: "connected" }),
    ).toEqual(ready);
  });

  it("marks long-running requests without changing their phase", () => {
    const loading = reduceBeziLaunchState(initialBeziLaunchState, {
      type: "slow",
    });
    expect(loading).toMatchObject({ phase: "connecting", slow: true });
  });
});
