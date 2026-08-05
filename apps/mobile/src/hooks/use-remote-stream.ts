import { useCallback, useEffect, useRef, useState } from "react";
import type { WebRtcSignal } from "@/components/remote-surface";
import { useSession } from "@/context/session-context";

export function useRemoteStream(
  target: "bezi" | "unity",
  instanceId?: string | null,
  source?: "game" | "scene",
) {
  const { connected, send, subscribe } = useSession();
  const startRequest = useRef<string | null>(null);
  const activateRequest = useRef<string | null>(null);
  const activateTarget = useRef<string | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [activatedTarget, setActivatedTarget] = useState<string | null>(null);
  const [signal, setSignal] = useState<WebRtcSignal | undefined>();
  const targetKey = target === "unity" && instanceId ? `${instanceId}:${source ?? "game"}` : null;
  const targetReady = target !== "unity" || activatedTarget === targetKey;

  useEffect(() => {
    if (!connected) {
      startRequest.current = null;
      return;
    }
    if (target === "unity" && (!instanceId || !targetReady)) return;
    if (!viewerReady || startRequest.current) return;
    startRequest.current = send(
      "stream.start",
      {
        target,
        instanceId: instanceId ?? undefined,
        source: target === "unity" ? source ?? "game" : undefined,
        preset: target === "unity" ? (source === "scene" ? "balanced" : "game") : "editor",
      },
      { kind: "signaling" },
    );
  }, [connected, instanceId, send, source, target, targetReady, viewerReady]);

  useEffect(() => {
    if (
      target !== "unity" ||
      !connected ||
      !viewerReady ||
      !instanceId ||
      activateRequest.current ||
      targetReady
    ) {
      return;
    }
    activateTarget.current = targetKey;
    activateRequest.current = send(
      "unity.capture.view.activate",
      { instanceId, kind: source ?? "game" },
      { kind: "signaling" },
    );
  }, [connected, instanceId, send, source, target, targetKey, targetReady, viewerReady]);

  useEffect(() => {
    startRequest.current = null;
    activateRequest.current = null;
    activateTarget.current = null;
    setActivatedTarget(null);
    setSignal(undefined);
  }, [instanceId, source, target]);

  useEffect(
    () => () => {
      if (startRequest.current) {
        send(
          "stream.stop",
          { target, instanceId: instanceId ?? undefined, source },
          { kind: "signaling" },
        );
        startRequest.current = null;
      }
    },
    [instanceId, send, source, target],
  );

  useEffect(
    () =>
      subscribe((payload) => {
        if (payload.requestId === activateRequest.current) {
          if (payload.type === "unity.result" && payload.body.success === true) {
            activateRequest.current = null;
            setActivatedTarget(activateTarget.current);
            activateTarget.current = null;
          } else if (payload.type === "unity.error") {
            activateRequest.current = null;
            activateTarget.current = null;
          }
          return;
        }
        if (payload.requestId !== startRequest.current) return;
        if (payload.type === "stream.offer") {
          const sdp = payload.body.sdp;
          if (
            isRecord(sdp) &&
            typeof sdp.type === "string" &&
            typeof sdp.sdp === "string"
          ) {
            setSignal({
              type: "offer",
              sdp: { type: sdp.type as RTCSdpType, sdp: sdp.sdp },
            });
          }
        } else if (payload.type === "stream.ice") {
          const candidate = payload.body.candidate;
          if (isRecord(candidate)) {
            setSignal({
              type: "ice",
              candidate: candidate as RTCIceCandidateInit,
            });
          }
        } else if (payload.type === "stream.config") {
          const iceServers = payload.body.iceServers;
          if (Array.isArray(iceServers)) {
            setSignal({
              type: "config",
              iceServers: iceServers as RTCIceServer[],
            });
          }
        } else if (payload.type === "stream.error") {
          startRequest.current = null;
          setSignal(undefined);
        }
      }),
    [subscribe],
  );

  const onSignal = useCallback(
    (message: Record<string, unknown>) => {
      if (typeof message.type !== "string") return;
      if (message.type === "viewer.ready") {
        setViewerReady(true);
        return;
      }
      if (!connected) return;
      if (message.type === "viewer.answer" && isRecord(message.sdp)) {
        send(
          "stream.answer",
          { target, instanceId: instanceId ?? undefined, source, sdp: message.sdp },
          { kind: "signaling" },
        );
      } else if (message.type === "viewer.ice" && isRecord(message.candidate)) {
        send(
          "stream.ice",
          {
            target,
            instanceId: instanceId ?? undefined,
            source,
            candidate: message.candidate,
          },
          { kind: "signaling" },
        );
      }
    },
    [connected, instanceId, send, source, target],
  );

  return { signal, onSignal };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
