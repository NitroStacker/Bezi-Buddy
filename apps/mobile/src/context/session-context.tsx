import {
  decryptedPayloadSchema,
  type DecryptedPayload,
  type EncryptedFrame,
  type RelayMessage,
} from "@bezi-remote/protocol";
import * as Crypto from "expo-crypto";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { RelayClient } from "@/lib/relay-client";
import {
  SecureRelaySession,
  type SecureSessionHandlers,
} from "@/lib/secure-relay-session";
import { loadSecureSettings } from "@/lib/secure-settings";
import { useRemoteStore } from "@/store/remote-store";

type SendOptions = {
  kind?: EncryptedFrame["kind"];
  idempotencyKey?: string;
  expectedRevision?: number;
};

type PayloadListener = (payload: DecryptedPayload) => void;

type SessionContextValue = {
  connected: boolean;
  hasControl: boolean;
  capabilities: DecryptedPayload | null;
  lastPayload: DecryptedPayload | null;
  subscribe: (listener: PayloadListener) => () => void;
  send: (
    type: DecryptedPayload["type"],
    body: Record<string, unknown>,
    options?: SendOptions,
  ) => string | null;
  takeControl: (durationSeconds?: number) => void;
  releaseControl: () => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: PropsWithChildren) {
  const selectedHostId = useRemoteStore((state) => state.selectedHostId);
  const selectHost = useRemoteStore((state) => state.selectHost);
  const connectionPhase = useRemoteStore((state) => state.connectionPhase);
  const controllerDeviceId = useRemoteStore((state) => state.controllerDeviceId);
  const setConnectionPhase = useRemoteStore((state) => state.setConnectionPhase);
  const setLease = useRemoteStore((state) => state.setLease);
  const clearSession = useRemoteStore((state) => state.clearSession);
  const session = useRef<SecureRelaySession | null>(null);
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<DecryptedPayload | null>(null);
  const [lastPayload, setLastPayload] = useState<DecryptedPayload | null>(null);
  const [foregroundEpoch, setForegroundEpoch] = useState(0);
  const payloadListeners = useRef(new Set<PayloadListener>());
  const hasControlRef = useRef(false);
  const hasControl =
    mobileDeviceId !== null && controllerDeviceId === mobileDeviceId;
  hasControlRef.current = hasControl;

  useEffect(() => {
    if (selectedHostId) return;
    let disposed = false;
    void loadSecureSettings()
      .then(async (settings) => {
        if (!settings.ownerToken || !settings.relayUrl) return;
        const hosts = await new RelayClient(settings).listHosts();
        if (!disposed && hosts[0]) selectHost(hosts[0].id);
      })
      .catch(() => {
        // The unpaired proof opens in preview mode without blocking navigation.
      });
    return () => {
      disposed = true;
    };
  }, [selectHost, selectedHostId]);

  useEffect(() => {
    if (!selectedHostId || selectedHostId === "preview-host") {
      session.current?.close();
      session.current = null;
      clearSession();
      setCapabilities(null);
      setLastPayload(null);
      return;
    }

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    let generation = 0;

    const connect = async () => {
      const attemptGeneration = ++generation;
      try {
        setConnectionPhase(retryAttempt === 0 ? "requesting-ticket" : "reconnecting");
        const settings = await loadSecureSettings();
        if (disposed || attemptGeneration !== generation) return;
        setMobileDeviceId(settings.deviceId);
        const handlers: SecureSessionHandlers = {
          onPayload: (payload) => {
            if (disposed || attemptGeneration !== generation) return;
            setLastPayload(payload);
            if (payload.type === "system.capabilities") {
              setCapabilities(payload);
            }
            for (const listener of payloadListeners.current) {
              try {
                listener(payload);
              } catch {
                // One screen listener must never interrupt the encrypted session.
              }
            }
          },
          onRelayMessage: (message) => {
            if (disposed || attemptGeneration !== generation) return;
            handleRelayMetadata(message, setLease);
          },
          onState: (state) => {
            if (disposed || attemptGeneration !== generation) return;
            if (state === "connected") {
              retryAttempt = 0;
              setConnectionPhase("connected");
            } else if (state === "connecting" || state === "requesting-ticket") {
              setConnectionPhase(state);
            } else if (state === "closed" || state === "error") {
              setConnectionPhase(state === "error" ? "error" : "reconnecting");
              scheduleRetry();
            }
          },
        };
        const nextSession = await SecureRelaySession.connect(
          new RelayClient(settings),
          selectedHostId,
          settings,
          handlers,
        );
        if (disposed || attemptGeneration !== generation) {
          nextSession.close();
          return;
        }
        session.current = nextSession;
      } catch {
        if (disposed || attemptGeneration !== generation) return;
        setConnectionPhase("error");
        scheduleRetry();
      }
    };

    const scheduleRetry = () => {
      if (disposed || retryTimer) return;
      retryAttempt += 1;
      const delay = Math.min(5_000, 750 * 2 ** Math.min(retryAttempt, 3));
      retryTimer = setTimeout(() => {
        retryTimer = null;
        generation += 1;
        const staleSession = session.current;
        session.current = null;
        staleSession?.close();
        void connect();
      }, delay);
    };

    void connect();
    return () => {
      disposed = true;
      generation += 1;
      if (retryTimer) clearTimeout(retryTimer);
      const staleSession = session.current;
      session.current = null;
      staleSession?.close();
      setLease(null, null);
    };
  }, [
    clearSession,
    foregroundEpoch,
    selectedHostId,
    setConnectionPhase,
    setLease,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        try {
          session.current?.releaseControl();
        } catch {
          // Background cleanup must never surface a native red error screen.
        }
        setLease(null, null);
      } else {
        // iOS may suspend or discard a WebSocket while backgrounded without a
        // reliable close event. Recreate the session when the app returns.
        setForegroundEpoch((current) => current + 1);
      }
    });
    return () => subscription.remove();
  }, [setLease]);

  const send = useCallback(
    (
      type: DecryptedPayload["type"],
      body: Record<string, unknown>,
      options: SendOptions = {},
    ): string | null => {
      if (!session.current) return null;
      if ((options.kind ?? "control") === "control" && !hasControlRef.current) {
        return null;
      }
      try {
        const requestId = Crypto.randomUUID();
        const payload = decryptedPayloadSchema.parse({
          v: 1,
          requestId,
          type,
          body,
          idempotencyKey: options.idempotencyKey,
          expectedRevision: options.expectedRevision,
        });
        session.current.send(payload, options.kind);
        return requestId;
      } catch {
        return null;
      }
    },
    [],
  );

  const subscribe = useCallback((listener: PayloadListener) => {
    payloadListeners.current.add(listener);
    return () => {
      payloadListeners.current.delete(listener);
    };
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      connected: connectionPhase === "connected",
      capabilities,
      hasControl,
      lastPayload,
      send,
      subscribe,
      takeControl: (durationSeconds = 30) => {
        try {
          session.current?.requestControl(durationSeconds);
        } catch {
          // A foreground reconnect will restore the ability to request control.
        }
      },
      releaseControl: () => {
        try {
          session.current?.releaseControl();
        } catch {
          // Release is best-effort and the relay lease expires automatically.
        }
      },
    }),
    [
      capabilities,
      connectionPhase,
      hasControl,
      lastPayload,
      send,
      subscribe,
    ],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

function handleRelayMetadata(
  message: RelayMessage | Record<string, unknown>,
  setLease: (deviceId: string | null, expiresAt: string | null) => void,
): void {
  if (message.type !== "relay.lease") return;
  const lease = message as Extract<RelayMessage, { type: "relay.lease" }>;
  setLease(lease.holderDeviceId, lease.expiresAt);
}
