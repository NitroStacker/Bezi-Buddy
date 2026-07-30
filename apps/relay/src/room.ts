import {
  encryptedFrameSchema,
  relayClientMessageSchema,
  type RelayMessage,
} from "@bezi-remote/protocol";
import type { Env } from "./env";
import { errorResponse } from "./http";
import { isExpired, sha256Base64Url } from "./security";

type SocketMeta = {
  deviceId: string;
  role: "host" | "viewer";
};

type Lease = {
  holderDeviceId: string;
  expiresAt: string;
} | null;

export class HostRoom implements DurableObject {
  private lease: Lease = null;
  private sessionSalt = "";
  private connectionId = "";

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      this.lease = (await this.state.storage.get<Lease>("lease")) ?? null;
      this.sessionSalt =
        (await this.state.storage.get<string>("sessionSalt")) ?? "";
      this.connectionId =
        (await this.state.storage.get<string>("connectionId")) ?? "";
      if (!this.sessionSalt) {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        this.sessionSalt = Array.from(bytes, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        await this.state.storage.put("sessionSalt", this.sessionSalt);
      }
      if (!this.connectionId) {
        this.connectionId = crypto.randomUUID();
        await this.state.storage.put("connectionId", this.connectionId);
      }
      if (this.lease && isExpired(this.lease.expiresAt)) {
        this.lease = null;
        await this.state.storage.delete("lease");
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "websocket_required", "Expected a WebSocket upgrade");
    }

    const url = new URL(request.url);
    const ticket = url.searchParams.get("ticket");
    const hostMatch = url.pathname.match(/^\/v1\/hosts\/([^/]+)\/connect$/);
    const hostId = hostMatch?.[1];
    if (!ticket || !hostId) {
      return errorResponse(401, "missing_ticket", "Session ticket is required");
    }

    const ticketHash = await sha256Base64Url(ticket);
    const record = await this.env.DB.prepare(
      `SELECT host_id, device_id, role, expires_at, consumed_at
       FROM session_tickets WHERE ticket_hash = ?1`,
    )
      .bind(ticketHash)
      .first<{
        host_id: string;
        device_id: string;
        role: "host" | "viewer";
        expires_at: string;
        consumed_at: string | null;
      }>();

    if (!record || record.consumed_at || isExpired(record.expires_at)) {
      return errorResponse(401, "invalid_ticket", "Session ticket is invalid or expired");
    }
    if (record.host_id !== hostId) {
      return errorResponse(403, "host_mismatch", "Ticket was issued for another host");
    }

    const consumed = await this.env.DB.prepare(
      `UPDATE session_tickets SET consumed_at = ?1
       WHERE ticket_hash = ?2 AND consumed_at IS NULL`,
    )
      .bind(new Date().toISOString(), ticketHash)
      .run();
    if (consumed.meta.changes !== 1) {
      return errorResponse(401, "ticket_consumed", "Session ticket has already been used");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const meta: SocketMeta = { deviceId: record.device_id, role: record.role };
    this.state.acceptWebSocket(server, [JSON.stringify(meta)]);

    const joined: RelayMessage = {
      type: "relay.joined",
      role: record.role,
      deviceId: record.device_id,
      connectionId: this.connectionId,
      sessionSalt: this.sessionSalt,
    };
    server.send(JSON.stringify(joined));
    this.sendLease(server);
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 6_100_000) {
      this.sendError(socket, "invalid_message", "Expected a bounded text message");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError(socket, "invalid_json", "Message must be valid JSON");
      return;
    }

    const result = relayClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      console.error("relay.invalid_message", {
        issues: result.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      this.sendError(socket, "invalid_message", "Message did not match protocol v1");
      return;
    }

    const meta = this.meta(socket);
    if (result.data.type === "relay.ping") {
      socket.send(JSON.stringify({ type: "relay.pong", sentAt: result.data.sentAt }));
      return;
    }
    if (result.data.type === "relay.lease.request") {
      await this.requestLease(socket, meta, result.data.durationSeconds);
      return;
    }
    if (result.data.type === "relay.lease.release") {
      await this.releaseLease(meta.deviceId);
      return;
    }
    if (result.data.type !== "relay.frame") {
      this.sendError(socket, "invalid_message", "Relay message type is unsupported");
      return;
    }

    const routedFrame = result.data;
    const frame = encryptedFrameSchema.parse(routedFrame.frame);
    if (meta.role === "host" && frame.direction !== "host-to-mobile") {
      this.sendError(socket, "direction_mismatch", "Host frame direction is invalid");
      return;
    }
    if (meta.role === "viewer" && frame.direction !== "mobile-to-host") {
      this.sendError(socket, "direction_mismatch", "Viewer frame direction is invalid");
      return;
    }
    if (
      meta.role === "viewer" &&
      frame.kind === "control" &&
      this.activeLease()?.holderDeviceId !== meta.deviceId
    ) {
      this.sendError(socket, "lease_required", "Take Control is required");
      return;
    }

    const candidates = this.state.getWebSockets().filter((peer) => {
      if (peer === socket) return false;
      const peerMeta = this.meta(peer);
      return meta.role === "host"
        ? peerMeta.role === "viewer"
        : peerMeta.role === "host";
    });
    const recipients =
      meta.role === "host" && routedFrame.recipientDeviceId
        ? candidates.filter(
            (peer) => this.meta(peer).deviceId === routedFrame.recipientDeviceId,
          )
        : candidates;
    if (meta.role === "host" && !routedFrame.recipientDeviceId && recipients.length > 1) {
      this.sendError(
        socket,
        "recipient_required",
        "Host frames must name a recipient when multiple viewers are connected",
      );
      return;
    }
    if (meta.role === "host" && routedFrame.recipientDeviceId && recipients.length === 0) {
      this.sendError(socket, "recipient_offline", "The target mobile device is not connected");
      return;
    }
    const message: RelayMessage = {
      type: "relay.frame",
      senderDeviceId: meta.deviceId,
      frame,
    };
    const encoded = JSON.stringify(message);
    for (const peer of recipients) {
      peer.send(encoded);
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const meta = this.meta(socket);
    if (this.lease?.holderDeviceId === meta.deviceId) {
      await this.releaseLease(meta.deviceId);
    }
    this.broadcastPresence();
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  async alarm(): Promise<void> {
    if (!this.activeLease()) await this.clearLease();
  }

  private async requestLease(
    socket: WebSocket,
    meta: SocketMeta,
    durationSeconds: number,
  ): Promise<void> {
    if (meta.role !== "viewer") {
      this.sendError(socket, "viewer_required", "Only a viewer can request control");
      return;
    }
    const current = this.activeLease();
    if (current && current.holderDeviceId !== meta.deviceId) {
      this.sendError(socket, "lease_busy", "Another device currently has control");
      return;
    }
    const expiresAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
    this.lease = { holderDeviceId: meta.deviceId, expiresAt };
    await this.state.storage.put("lease", this.lease);
    await this.state.storage.setAlarm(Date.parse(expiresAt));
    this.broadcastLease();
  }

  private async releaseLease(deviceId: string): Promise<void> {
    if (this.lease?.holderDeviceId !== deviceId) return;
    await this.clearLease();
  }

  private async clearLease(): Promise<void> {
    this.lease = null;
    await this.state.storage.delete("lease");
    await this.state.storage.deleteAlarm();
    this.broadcastLease();
  }

  private activeLease(): Lease {
    if (this.lease && isExpired(this.lease.expiresAt)) this.lease = null;
    return this.lease;
  }

  private meta(socket: WebSocket): SocketMeta {
    const raw = this.state.getTags(socket)[0];
    if (!raw) throw new Error("Socket metadata is missing");
    return JSON.parse(raw) as SocketMeta;
  }

  private sendLease(socket: WebSocket): void {
    const lease = this.activeLease();
    const message: RelayMessage = {
      type: "relay.lease",
      holderDeviceId: lease?.holderDeviceId ?? null,
      expiresAt: lease?.expiresAt ?? null,
    };
    socket.send(JSON.stringify(message));
  }

  private broadcastLease(): void {
    for (const socket of this.state.getWebSockets()) this.sendLease(socket);
  }

  private broadcastPresence(): void {
    const sockets = this.state.getWebSockets();
    const hosts = sockets.filter((socket) => this.meta(socket).role === "host").length;
    const message = JSON.stringify({
      type: "relay.presence",
      hostOnline: hosts > 0,
      viewers: sockets.length - hosts,
    });
    for (const socket of sockets) socket.send(message);
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    const payload: RelayMessage = { type: "relay.error", code, message };
    socket.send(JSON.stringify(payload));
  }
}
