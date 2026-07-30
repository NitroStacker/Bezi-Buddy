import { z } from "zod";
import { authenticate } from "./auth";
import type { Env } from "./env";
import { errorResponse, HttpError, json, readJson } from "./http";
import { HostRoom } from "./room";
import {
  isExpired,
  randomToken,
  sha256Base64Url,
  timingSafeEqual,
} from "./security";

export { HostRoom };

const pairStartSchema = z.object({
  pairingId: z.string().uuid(),
  hostId: z.string().min(8).max(128),
  hostName: z.string().min(1).max(80),
  codeHash: z.string().min(32).max(128),
  expiresAt: z.string().datetime(),
  companionVersion: z.string().min(1).max(40).default("0.1.0"),
});

const pairClaimSchema = z.object({
  claimCode: z.string().min(16).max(256),
  mobileDeviceId: z.string().min(8).max(128),
  deviceName: z.string().min(1).max(80),
  keyFingerprint: z.string().min(8).max(128),
});

const ticketSchema = z.object({
  deviceId: z.string().min(8).max(128),
  role: z.enum(["host", "viewer"]),
});

const routes = {
  pairings: /^\/v1\/pairings$/,
  pairing: /^\/v1\/pairings\/([^/]+)$/,
  claim: /^\/v1\/pairings\/([^/]+)\/claim$/,
  hosts: /^\/v1\/hosts$/,
  host: /^\/v1\/hosts\/([^/]+)$/,
  ticket: /^\/v1\/hosts\/([^/]+)\/session-ticket$/,
  connect: /^\/v1\/hosts\/([^/]+)\/connect$/,
  turn: /^\/v1\/turn-credentials$/,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error.status, error.code, error.message);
      }
      if (error instanceof z.ZodError) {
        return errorResponse(400, "invalid_request", "Request validation failed");
      }
      console.error("relay.request_failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
      return errorResponse(500, "internal_error", "The relay could not process the request");
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, version: 1, environment: env.ENVIRONMENT });
  }

  const connectMatch = url.pathname.match(routes.connect);
  if (request.method === "GET" && connectMatch) {
    const id = env.HOST_ROOMS.idFromName(connectMatch[1]!);
    return env.HOST_ROOMS.get(id).fetch(request);
  }

  const auth = authenticate(request, env);

  const pairingMatch = url.pathname.match(routes.pairing);
  if (request.method === "GET" && pairingMatch) {
    const pairing = await env.DB.prepare(
      `SELECT host_id, expires_at, claimed_by, claimed_at
       FROM host_pairings
       WHERE id = ?1 AND owner_id = ?2`,
    )
      .bind(pairingMatch[1]!, auth.ownerId)
      .first<{
        host_id: string;
        expires_at: string;
        claimed_by: string | null;
        claimed_at: string | null;
      }>();
    if (!pairing || (isExpired(pairing.expires_at) && !pairing.claimed_at)) {
      throw new HttpError(404, "pairing_unavailable", "Pairing is unavailable");
    }
    return json({
      hostId: pairing.host_id,
      expiresAt: pairing.expires_at,
      claimedBy: pairing.claimed_by,
      claimedAt: pairing.claimed_at,
    });
  }

  if (request.method === "POST" && routes.pairings.test(url.pathname)) {
    const body = pairStartSchema.parse(await readJson(request));
    if (isExpired(body.expiresAt) || Date.parse(body.expiresAt) > Date.now() + 10 * 60_000) {
      throw new HttpError(400, "invalid_expiry", "Pairing expiry must be within ten minutes");
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO hosts
          (id, owner_id, name, platform, created_at, last_seen_at, version)
         VALUES (?1, ?2, ?3, 'windows', ?4, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          last_seen_at = excluded.last_seen_at,
          version = excluded.version,
          revoked_at = NULL`,
      ).bind(body.hostId, auth.ownerId, body.hostName, now, body.companionVersion),
      env.DB.prepare(
        `INSERT INTO host_pairings
          (id, host_id, owner_id, code_hash, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(
        body.pairingId,
        body.hostId,
        auth.ownerId,
        body.codeHash,
        body.expiresAt,
        now,
      ),
    ]);
    await audit(env, auth.ownerId, body.hostId, body.hostId, "pairing.created", "success");
    return json({ pairingId: body.pairingId, expiresAt: body.expiresAt }, { status: 201 });
  }

  const claimMatch = url.pathname.match(routes.claim);
  if (request.method === "POST" && claimMatch) {
    const pairingId = claimMatch[1]!;
    const body = pairClaimSchema.parse(await readJson(request));
    const pairing = await env.DB.prepare(
      `SELECT host_id, owner_id, code_hash, expires_at, attempts, claimed_at
       FROM host_pairings WHERE id = ?1`,
    )
      .bind(pairingId)
      .first<{
        host_id: string;
        owner_id: string;
        code_hash: string;
        expires_at: string;
        attempts: number;
        claimed_at: string | null;
      }>();
    if (
      !pairing ||
      pairing.owner_id !== auth.ownerId ||
      pairing.claimed_at ||
      isExpired(pairing.expires_at) ||
      pairing.attempts >= 5
    ) {
      throw new HttpError(404, "pairing_unavailable", "Pairing is unavailable");
    }
    const actualHash = await sha256Base64Url(body.claimCode);
    if (!timingSafeEqual(actualHash, pairing.code_hash)) {
      await env.DB.prepare(
        "UPDATE host_pairings SET attempts = attempts + 1 WHERE id = ?1",
      )
        .bind(pairingId)
        .run();
      throw new HttpError(404, "pairing_unavailable", "Pairing is unavailable");
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mobile_devices
          (id, owner_id, name, key_fingerprint, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          key_fingerprint = excluded.key_fingerprint,
          revoked_at = NULL`,
      ).bind(
        body.mobileDeviceId,
        auth.ownerId,
        body.deviceName,
        body.keyFingerprint,
        now,
      ),
      env.DB.prepare(
        `UPDATE host_pairings SET claimed_by = ?1, claimed_at = ?2
         WHERE id = ?3 AND claimed_at IS NULL`,
      ).bind(body.mobileDeviceId, now, pairingId),
    ]);
    await audit(
      env,
      auth.ownerId,
      pairing.host_id,
      body.mobileDeviceId,
      "pairing.claimed",
      "success",
    );
    return json({ hostId: pairing.host_id, pairedAt: now });
  }

  if (request.method === "GET" && routes.hosts.test(url.pathname)) {
    const result = await env.DB.prepare(
      `SELECT id, name, platform, last_seen_at, version, capability_hash
       FROM hosts
       WHERE owner_id = ?1 AND revoked_at IS NULL
       ORDER BY last_seen_at DESC`,
    )
      .bind(auth.ownerId)
      .all();
    return json({ hosts: result.results });
  }

  const ticketMatch = url.pathname.match(routes.ticket);
  if (request.method === "POST" && ticketMatch) {
    const hostId = ticketMatch[1]!;
    const body = ticketSchema.parse(await readJson(request));
    const host = await env.DB.prepare(
      "SELECT id FROM hosts WHERE id = ?1 AND owner_id = ?2 AND revoked_at IS NULL",
    )
      .bind(hostId, auth.ownerId)
      .first();
    if (!host) throw new HttpError(404, "host_not_found", "Host was not found");
    if (body.role === "host" && body.deviceId !== hostId) {
      throw new HttpError(403, "invalid_host_identity", "Host ticket identity is invalid");
    }
    if (body.role === "viewer") {
      const pairedDevice = await env.DB.prepare(
        `SELECT mobile_devices.id
         FROM mobile_devices
         INNER JOIN host_pairings
           ON host_pairings.claimed_by = mobile_devices.id
         WHERE mobile_devices.id = ?1
           AND mobile_devices.owner_id = ?2
           AND mobile_devices.revoked_at IS NULL
           AND host_pairings.host_id = ?3
           AND host_pairings.claimed_at IS NOT NULL
         LIMIT 1`,
      )
        .bind(body.deviceId, auth.ownerId, hostId)
        .first();
      if (!pairedDevice) {
        throw new HttpError(
          403,
          "device_not_paired",
          "The mobile device is not paired with this host",
        );
      }
    }

    const ticket = randomToken();
    const ticketHash = await sha256Base64Url(ticket);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO session_tickets
        (ticket_hash, owner_id, host_id, device_id, role, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        ticketHash,
        auth.ownerId,
        hostId,
        body.deviceId,
        body.role,
        expiresAt,
        now.toISOString(),
      )
      .run();
    return json({ ticket, expiresAt });
  }

  const hostMatch = url.pathname.match(routes.host);
  if (request.method === "DELETE" && hostMatch) {
    const hostId = hostMatch[1]!;
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      `UPDATE hosts SET revoked_at = ?1
       WHERE id = ?2 AND owner_id = ?3 AND revoked_at IS NULL`,
    )
      .bind(now, hostId, auth.ownerId)
      .run();
    if (result.meta.changes !== 1) {
      throw new HttpError(404, "host_not_found", "Host was not found");
    }
    await audit(env, auth.ownerId, hostId, null, "host.revoked", "success");
    return new Response(null, { status: 204 });
  }

  if (request.method === "POST" && routes.turn.test(url.pathname)) {
    if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
      throw new HttpError(503, "turn_unconfigured", "TURN is not configured");
    }
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.TURN_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: 900 }),
      },
    );
    if (!response.ok) {
      throw new HttpError(502, "turn_failed", "TURN credential generation failed");
    }
    return json(await response.json());
  }

  return errorResponse(404, "not_found", "Route was not found");
}

async function audit(
  env: Env,
  ownerId: string,
  hostId: string | null,
  actorDeviceId: string | null,
  actionClass: string,
  outcome: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events
      (id, owner_id, host_id, actor_device_id, action_class, outcome, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      crypto.randomUUID(),
      ownerId,
      hostId,
      actorDeviceId,
      actionClass,
      outcome,
      new Date().toISOString(),
    )
    .run();
}
