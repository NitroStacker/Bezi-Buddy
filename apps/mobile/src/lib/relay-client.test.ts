import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelaySocket } from "./relay-socket";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;
  throwOnSend = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string) {}

  send(value: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("socket is closed");
    }
    if (this.throwOnSend) throw new Error("socket closed during send");
    this.sent.push(value);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("RelaySocket lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats lease cleanup as a no-op while disconnected", () => {
    const relay = createRelaySocket();

    expect(relay.releaseControl()).toBe(false);
    expect(relay.requestControl()).toBe(false);
    expect(() => relay.releaseControl()).not.toThrow();
  });

  it("sends lease changes while open", () => {
    const relay = createRelaySocket();
    const socket = relay.socket as unknown as FakeWebSocket;
    socket.readyState = FakeWebSocket.OPEN;

    expect(relay.requestControl(45)).toBe(true);
    expect(relay.releaseControl()).toBe(true);
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "relay.lease.request", durationSeconds: 45 },
      { type: "relay.lease.release" },
    ]);
  });

  it("absorbs a socket close that races an open-state lease release", () => {
    const relay = createRelaySocket();
    const socket = relay.socket as unknown as FakeWebSocket;
    socket.readyState = FakeWebSocket.OPEN;
    socket.throwOnSend = true;

    expect(relay.releaseControl()).toBe(false);
    expect(() => relay.releaseControl()).not.toThrow();
  });

  it("keeps encrypted frame delivery strict while making close idempotent", () => {
    const relay = createRelaySocket();
    const socket = relay.socket as unknown as FakeWebSocket;

    expect(() => relay.send({ type: "relay.frame" })).toThrow(
      "Relay socket is not connected",
    );

    socket.readyState = FakeWebSocket.OPEN;
    relay.close();
    relay.close();
    expect(socket.closeCalls).toBe(1);
  });
});

function createRelaySocket() {
  return new RelaySocket("ws://relay.test", {
    onMessage: vi.fn(),
    onState: vi.fn(),
  });
}
