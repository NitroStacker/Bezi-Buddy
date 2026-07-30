import {
  relayMessageSchema,
  type RelayMessage,
} from "@bezi-remote/protocol";

export class RelaySocket {
  readonly socket: WebSocket;

  constructor(
    url: string,
    handlers: {
      onMessage: (message: RelayMessage | Record<string, unknown>) => void;
      onState: (state: "connecting" | "open" | "closed" | "error") => void;
    },
  ) {
    handlers.onState("connecting");
    this.socket = new WebSocket(url);
    this.socket.onopen = () => handlers.onState("open");
    this.socket.onclose = () => handlers.onState("closed");
    this.socket.onerror = () => handlers.onState("error");
    this.socket.onmessage = (event) => {
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        const known = relayMessageSchema.safeParse(parsed);
        handlers.onMessage(
          known.success ? known.data : (parsed as Record<string, unknown>),
        );
      } catch {
        handlers.onMessage({
          type: "relay.error",
          code: "invalid_json",
          message: "Relay returned malformed JSON",
        });
      }
    };
  }

  requestControl(durationSeconds = 30): boolean {
    return this.sendIfOpen({ type: "relay.lease.request", durationSeconds });
  }

  releaseControl(): boolean {
    return this.sendIfOpen({ type: "relay.lease.release" });
  }

  send(message: unknown): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Relay socket is not connected");
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.CLOSING ||
      this.socket.readyState === WebSocket.CLOSED
    ) {
      return;
    }
    try {
      this.socket.close(1000, "client_close");
    } catch {
      // Closing is cleanup and must remain safe if the native socket changed
      // state between the readyState check and this call.
    }
  }

  private sendIfOpen(message: unknown): boolean {
    if (this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      // Lease changes are best-effort. The relay expires abandoned leases, and
      // a foreground reconnect will establish authoritative state.
      return false;
    }
  }
}
