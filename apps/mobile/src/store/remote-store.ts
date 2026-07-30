import { create } from "zustand";

export type ConnectionPhase =
  | "idle"
  | "requesting-ticket"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

type RemoteState = {
  selectedHostId: string | null;
  connectionPhase: ConnectionPhase;
  controllerDeviceId: string | null;
  leaseExpiresAt: string | null;
  selectHost: (hostId: string | null) => void;
  setConnectionPhase: (phase: ConnectionPhase) => void;
  setLease: (deviceId: string | null, expiresAt: string | null) => void;
  clearSession: () => void;
};

export const useRemoteStore = create<RemoteState>((set) => ({
  selectedHostId: null,
  connectionPhase: "idle",
  controllerDeviceId: null,
  leaseExpiresAt: null,
  selectHost: (selectedHostId) => set({ selectedHostId }),
  setConnectionPhase: (connectionPhase) => set({ connectionPhase }),
  setLease: (controllerDeviceId, leaseExpiresAt) =>
    set({ controllerDeviceId, leaseExpiresAt }),
  clearSession: () =>
    set({
      connectionPhase: "idle",
      controllerDeviceId: null,
      leaseExpiresAt: null,
    }),
}));

