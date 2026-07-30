import {
  pairingQrSchema,
  type PairingQr,
  type RelayMessage,
} from "@bezi-remote/protocol";
import * as Crypto from "expo-crypto";
import { savePairSecret, type SecureSettings } from "./secure-settings";
import { RelaySocket } from "./relay-socket";

export { RelaySocket } from "./relay-socket";

export type RelayHost = {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string;
  version: string;
  capabilityHash?: string;
};

type ApiError = {
  error?: { code?: string; message?: string };
};

export class RelayClient {
  constructor(private readonly settings: SecureSettings) {}

  async health(): Promise<{ ok: boolean; environment: string }> {
    return this.request("/health", { authenticated: false });
  }

  async listHosts(): Promise<RelayHost[]> {
    const response = await this.request<{
      hosts: {
        id: string;
        name: string;
        platform: string;
        last_seen_at: string;
        version: string;
        capability_hash?: string;
      }[];
    }>("/v1/hosts");
    return response.hosts.map((host) => ({
      id: host.id,
      name: host.name,
      platform: host.platform,
      lastSeenAt: host.last_seen_at,
      version: host.version,
      capabilityHash: host.capability_hash,
    }));
  }

  async claimPairing(untrusted: unknown, deviceName: string): Promise<string> {
    const pairing = pairingQrSchema.parse(untrusted);
    if (Date.parse(pairing.expiresAt) <= Date.now()) {
      throw new Error("This pairing code has expired");
    }
    if (normalizeUrl(pairing.relayUrl) !== normalizeUrl(this.settings.relayUrl)) {
      throw new Error("The QR code belongs to a different relay");
    }
    const keyFingerprint = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      pairing.pairSecret,
    );
    const response = await this.request<{ hostId: string; pairedAt: string }>(
      `/v1/pairings/${pairing.pairingId}/claim`,
      {
        method: "POST",
        body: {
          claimCode: pairing.claimCode,
          mobileDeviceId: this.settings.deviceId,
          deviceName,
          keyFingerprint,
        },
      },
    );
    await savePairSecret(response.hostId, pairing.pairSecret);
    return response.hostId;
  }

  async revokeHost(hostId: string): Promise<void> {
    await this.request(`/v1/hosts/${encodeURIComponent(hostId)}`, {
      method: "DELETE",
    });
  }

  async openHostSocket(
    hostId: string,
    handlers: {
      onMessage: (message: RelayMessage | Record<string, unknown>) => void;
      onState: (state: "connecting" | "open" | "closed" | "error") => void;
    },
  ): Promise<RelaySocket> {
    const ticket = await this.request<{ ticket: string; expiresAt: string }>(
      `/v1/hosts/${encodeURIComponent(hostId)}/session-ticket`,
      {
        method: "POST",
        body: { deviceId: this.settings.deviceId, role: "viewer" },
      },
    );
    const socketUrl = new URL(
      `/v1/hosts/${encodeURIComponent(hostId)}/connect`,
      this.settings.relayUrl,
    );
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("ticket", ticket.ticket);
    return new RelaySocket(socketUrl.toString(), handlers);
  }

  private async request<T = unknown>(
    path: string,
    options: {
      method?: "GET" | "POST" | "DELETE";
      body?: unknown;
      authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.authenticated !== false) {
      if (!this.settings.ownerToken) {
        throw new Error("Enter the development owner token in Settings");
      }
      headers.authorization = `Bearer ${this.settings.ownerToken}`;
    }
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(new URL(path, this.settings.relayUrl), {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as ApiError;
      throw new Error(error.error?.message ?? `Relay request failed (${response.status})`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}

export function parsePairingCode(value: string): PairingQr {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) return pairingQrSchema.parse(JSON.parse(trimmed));
  const url = new URL(trimmed);
  if (url.protocol !== "beziremote:" || url.hostname !== "pair") {
    throw new Error("This is not a Bezi Remote pairing code");
  }
  const payload = url.searchParams.get("payload");
  if (!payload) throw new Error("Pairing payload is missing");
  return pairingQrSchema.parse(JSON.parse(decodeURIComponent(payload)));
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}
