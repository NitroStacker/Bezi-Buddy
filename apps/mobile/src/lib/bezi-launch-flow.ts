export type BeziLaunchPhase =
  | "connecting"
  | "loading-workspaces"
  | "choose-workspace"
  | "choose-project"
  | "loading-threads"
  | "loading-thread"
  | "ready"
  | "error";

export type BeziLaunchOperation = "catalog" | "threads" | "thread";

type ResumableLaunchPhase = Exclude<
  BeziLaunchPhase,
  "connecting" | "ready" | "error"
>;

export type BeziLaunchError = {
  operation: BeziLaunchOperation;
  message: string;
};

export type BeziLaunchState = {
  phase: BeziLaunchPhase;
  workspaceId: string | null;
  projectId: string | null;
  error: BeziLaunchError | null;
  resumePhase: ResumableLaunchPhase | null;
  slow: boolean;
};

export type BeziLaunchEvent =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "catalog-ready" }
  | { type: "choose-workspace"; workspaceId: string }
  | { type: "back-to-workspaces" }
  | { type: "choose-project"; projectId: string }
  | { type: "threads-empty" }
  | { type: "threads-ready" }
  | { type: "thread-ready" }
  | {
      type: "failed";
      operation: BeziLaunchOperation;
      message: string;
    }
  | { type: "retry" }
  | { type: "slow" };

export const initialBeziLaunchState: BeziLaunchState = {
  phase: "connecting",
  workspaceId: null,
  projectId: null,
  error: null,
  resumePhase: null,
  slow: false,
};

export function reduceBeziLaunchState(
  state: BeziLaunchState,
  event: BeziLaunchEvent,
): BeziLaunchState {
  switch (event.type) {
    case "connected":
      if (state.phase !== "connecting") return state;
      return {
        ...state,
        phase: state.resumePhase ?? "loading-workspaces",
        resumePhase: null,
        error: null,
        slow: false,
      };

    case "disconnected": {
      if (state.phase === "ready" || state.phase === "connecting") return state;
      const resumePhase =
        state.phase === "error"
          ? state.error
            ? phaseForOperation(state.error.operation)
            : "loading-workspaces"
          : state.phase;
      return {
        ...state,
        phase: "connecting",
        resumePhase,
        error: null,
        slow: false,
      };
    }

    case "catalog-ready":
      if (state.phase !== "loading-workspaces") return state;
      return {
        ...state,
        phase: "choose-workspace",
        workspaceId: null,
        projectId: null,
        error: null,
        slow: false,
      };

    case "choose-workspace":
      if (state.phase !== "choose-workspace") return state;
      return {
        ...state,
        phase: "choose-project",
        workspaceId: event.workspaceId,
        projectId: null,
        error: null,
        slow: false,
      };

    case "back-to-workspaces":
      if (state.phase !== "choose-project") return state;
      return {
        ...state,
        phase: "choose-workspace",
        projectId: null,
        error: null,
        slow: false,
      };

    case "choose-project":
      if (state.phase !== "choose-project") return state;
      return {
        ...state,
        phase: "loading-threads",
        projectId: event.projectId,
        error: null,
        slow: false,
      };

    case "threads-empty":
      if (state.phase !== "loading-threads") return state;
      return {
        ...state,
        phase: "ready",
        error: null,
        slow: false,
      };

    case "threads-ready":
      if (state.phase !== "loading-threads") return state;
      return {
        ...state,
        phase: "loading-thread",
        error: null,
        slow: false,
      };

    case "thread-ready":
      if (state.phase !== "loading-thread") return state;
      return {
        ...state,
        phase: "ready",
        error: null,
        slow: false,
      };

    case "failed":
      if (state.phase === "ready") return state;
      return {
        ...state,
        phase: "error",
        error: {
          operation: event.operation,
          message: event.message,
        },
        resumePhase: null,
        slow: false,
      };

    case "retry":
      if (state.phase !== "error" || !state.error) return state;
      return {
        ...state,
        phase: phaseForOperation(state.error.operation),
        error: null,
        slow: false,
      };

    case "slow":
      if (
        state.phase !== "connecting" &&
        state.phase !== "loading-workspaces" &&
        state.phase !== "loading-threads" &&
        state.phase !== "loading-thread"
      ) {
        return state;
      }
      return { ...state, slow: true };
  }
}

export function isBeziLaunchPending(state: BeziLaunchState): boolean {
  return state.phase !== "ready";
}

export function shouldRequestCompletePageCatalog(
  phase: BeziLaunchPhase,
  lastCompleteRequestAt: number,
  now: number,
): boolean {
  return phase === "ready" && now - lastCompleteRequestAt >= 60_000;
}

function phaseForOperation(
  operation: BeziLaunchOperation,
): ResumableLaunchPhase {
  switch (operation) {
    case "catalog":
      return "loading-workspaces";
    case "threads":
      return "loading-threads";
    case "thread":
      return "loading-thread";
  }
}
