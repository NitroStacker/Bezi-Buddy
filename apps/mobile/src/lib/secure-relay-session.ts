import {
  ReplayWindow,
  decryptPayload,
  deriveSessionKeys,
  encryptPayload,
  type DecryptedPayload,
  type EncryptedFrame,
  type RelayMessage,
} from "@bezi-remote/protocol";
import * as Crypto from "expo-crypto";
import { RelayClient, type RelaySocket } from "./relay-client";
import { getPairSecret, type SecureSettings } from "./secure-settings";
import { decodeBase64Url, decodeHex } from "./session-encoding";

export type SecureSessionState =
  | "requesting-ticket"
  | "connecting"
  | "connected"
  | "closed"
  | "error";

export type SecureSessionHandlers = {
  onPayload: (payload: DecryptedPayload) => void;
  onRelayMessage?: (message: RelayMessage | Record<string, unknown>) => void;
  onState: (state: SecureSessionState, detail?: string) => void;
};

/**
 * Owns one encrypted phone-to-host session. The relay sees routing metadata and
 * opaque AES-GCM frames only; the pairing secret never leaves SecureStore.
 */
export class SecureRelaySession {
  private socket: RelaySocket | null = null;
  private connectionId: string | null = null;
  private outboundKey: Uint8Array | null = null;
  private inboundKey: Uint8Array | null = null;
  private readonly noncePrefix = Crypto.getRandomBytes(4);
  private readonly replay = new ReplayWindow();
  private sequence = 0;

  private constructor(
    private readonly hostId: string,
    private readonly settings: SecureSettings,
    private readonly pairSecret: Uint8Array,
    private readonly handlers: SecureSessionHandlers,
  ) {}

  static async connect(
    client: RelayClient,
    hostId: string,
    settings: SecureSettings,
    handlers: SecureSessionHandlers,
  ): Promise<SecureRelaySession> {
    handlers.onState("requesting-ticket");
    const encodedSecret = await getPairSecret(hostId);
    if (!encodedSecret) {
      throw new Error("This phone no longer has the host pairing secret");
    }
    const session = new SecureRelaySession(
      hostId,
      settings,
      decodeBase64Url(encodedSecret),
      handlers,
    );
    session.socket = await client.openHostSocket(hostId, {
      onState: (state) => {
        if (state === "open") handlers.onState("connecting");
        else if (state === "closed") handlers.onState("closed");
        else if (state === "error") handlers.onState("error", "Relay socket failed");
      },
      onMessage: (message) => session.handleRelayMessage(message),
    });
    return session;
  }

  send(payload: DecryptedPayload, kind: EncryptedFrame["kind"] = "control"): void {
    if (!this.socket || !this.connectionId || !this.outboundKey) {
      throw new Error("The secure session handshake is not complete");
    }
    const frame = encryptPayload({
      key: this.outboundKey,
      noncePrefix: this.noncePrefix,
      sequence: this.sequence++,
      hostId: this.hostId,
      connectionId: this.connectionId,
      direction: "mobile-to-host",
      kind,
      payload,
    });
    this.socket.send({ type: "relay.frame", frame });
  }

  requestControl(durationSeconds = 30): void {
    this.socket?.requestControl(durationSeconds);
  }

  releaseControl(): void {
    this.socket?.releaseControl();
  }

  close(): void {
    this.releaseControl();
    this.socket?.close();
    this.socket = null;
    this.connectionId = null;
    this.outboundKey?.fill(0);
    this.inboundKey?.fill(0);
    this.pairSecret.fill(0);
  }

  private handleRelayMessage(
    message: RelayMessage | Record<string, unknown>,
  ): void {
    this.handlers.onRelayMessage?.(message);
    if (message.type === "relay.joined") {
      const joined = message as Extract<RelayMessage, { type: "relay.joined" }>;
      if (joined.deviceId !== this.settings.deviceId) {
        this.handlers.onState("error", "Relay joined with the wrong device identity");
        this.close();
        return;
      }
      const keys = deriveSessionKeys({
        pairSecret: this.pairSecret,
        sessionSalt: decodeHex(joined.sessionSalt),
        hostId: this.hostId,
        mobileDeviceId: this.settings.deviceId,
      });
      this.connectionId = joined.connectionId;
      this.outboundKey = keys.mobileToHost;
      this.inboundKey = keys.hostToMobile;
      this.handlers.onState("connected");
      this.send(
        {
          v: 1,
          requestId: Crypto.randomUUID(),
          type: "system.hello",
          body: {
            deviceId: this.settings.deviceId,
            renderer: "webview-webrtc",
            client: "expo-go-proof",
          },
        },
        "signaling",
      );
      return;
    }
    if (message.type !== "relay.frame") return;
    const routed = message as Extract<RelayMessage, { type: "relay.frame" }>;
    const frame = routed.frame;
    if (
      routed.senderDeviceId !== this.hostId ||
      frame.hostId !== this.hostId ||
      frame.connectionId !== this.connectionId ||
      frame.direction !== "host-to-mobile" ||
      !this.inboundKey
    ) {
      this.handlers.onState("error", "Rejected a frame with invalid routing metadata");
      return;
    }
    try {
      const payload = decryptPayload(this.inboundKey, frame);
      if (!this.replay.accept(frame.seq)) {
        this.handlers.onState("error", "Rejected a replayed or stale frame");
        return;
      }
      this.handlers.onPayload(payload);
    } catch {
      this.handlers.onState("error", "Rejected a tampered encrypted frame");
    }
  }
}
