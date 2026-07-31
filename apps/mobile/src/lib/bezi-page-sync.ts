export type BeziPageSyncState = {
  phase: "idle" | "syncing" | "ready" | "failed";
  message: string | null;
};

export type BeziPageSyncEvent =
  | { type: "started" }
  | { type: "completed" }
  | { type: "failed"; message: string };

export const initialBeziPageSyncState: BeziPageSyncState = {
  phase: "idle",
  message: null,
};

export function reduceBeziPageSyncState(
  _state: BeziPageSyncState,
  event: BeziPageSyncEvent,
): BeziPageSyncState {
  switch (event.type) {
    case "started":
      return { phase: "syncing", message: null };
    case "completed":
      return { phase: "ready", message: null };
    case "failed":
      return { phase: "failed", message: event.message };
  }
}

export function shouldBlockForPageSync(
  state: BeziPageSyncState,
  availableItemCount: number,
): boolean {
  return availableItemCount === 0 && state.phase !== "ready";
}
