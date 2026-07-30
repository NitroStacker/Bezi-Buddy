import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const deviceIdSchema = z.string().min(8).max(128);
export const requestIdSchema = z.string().uuid();

export const pairingQrSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  relayUrl: z.string().url(),
  pairingId: z.string().uuid(),
  hostId: deviceIdSchema,
  hostName: z.string().min(1).max(80),
  claimCode: z.string().min(16).max(256),
  pairSecret: z.string().min(43).max(128),
  expiresAt: z.string().datetime(),
});

export type PairingQr = z.infer<typeof pairingQrSchema>;

export const capabilitySchema = z.enum([
  "bezi.native",
  "bezi.remote",
  "unity.semantic",
  "unity.remote",
  "stream.video",
  "stream.audio",
  "input.pointer",
  "input.keyboard",
]);

export const hostPresenceSchema = z.object({
  hostId: deviceIdSchema,
  hostName: z.string().min(1).max(80),
  online: z.boolean(),
  lastSeenAt: z.string().datetime(),
  companionVersion: z.string().max(40),
  capabilities: z.array(capabilitySchema),
  bezi: z.object({
    installed: z.boolean(),
    connected: z.boolean(),
    version: z.string().optional(),
  }),
  unity: z.object({
    instances: z.number().int().nonnegative(),
    activeProject: z.string().optional(),
    playing: z.boolean(),
    paused: z.boolean(),
  }),
});

export type HostPresence = z.infer<typeof hostPresenceSchema>;

const rpcBaseSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  requestId: requestIdSchema,
});

export const systemPayloadSchema = rpcBaseSchema.extend({
  type: z.enum([
    "system.hello",
    "system.capabilities",
    "system.presence",
    "system.lease.acquire",
    "system.lease.release",
    "system.lease.state",
    "system.error",
  ]),
  body: z.record(z.unknown()),
});

export const beziPayloadSchema = rpcBaseSchema.extend({
  type: z.string().regex(/^bezi\./),
  body: z.record(z.unknown()),
});

export const unityPayloadSchema = rpcBaseSchema.extend({
  type: z.string().regex(/^unity\./),
  idempotencyKey: z.string().uuid().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  body: z.record(z.unknown()),
});

export const streamPayloadSchema = rpcBaseSchema.extend({
  type: z.string().regex(/^stream\./),
  body: z.record(z.unknown()),
});

export const remotePayloadSchema = rpcBaseSchema.extend({
  type: z.string().regex(/^remote\./),
  body: z.record(z.unknown()),
});

export const decryptedPayloadSchema = z.union([
  systemPayloadSchema,
  beziPayloadSchema,
  unityPayloadSchema,
  streamPayloadSchema,
  remotePayloadSchema,
]);

export type DecryptedPayload = z.infer<typeof decryptedPayloadSchema>;

export const encryptedFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  hostId: deviceIdSchema,
  connectionId: z.string().uuid(),
  direction: z.enum(["mobile-to-host", "host-to-mobile"]),
  kind: z.enum(["control", "signaling"]),
  seq: z.number().int().nonnegative().safe(),
  nonce: z.string().min(16).max(64),
  ciphertext: z.string().min(16).max(6_000_000),
});

export type EncryptedFrame = z.infer<typeof encryptedFrameSchema>;

export const relayMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("relay.joined"),
    role: z.enum(["host", "viewer", "controller"]),
    deviceId: deviceIdSchema,
    connectionId: z.string().uuid(),
    sessionSalt: z.string().min(43).max(64),
  }),
  z.object({
    type: z.literal("relay.frame"),
    senderDeviceId: deviceIdSchema,
    frame: encryptedFrameSchema,
  }),
  z.object({
    type: z.literal("relay.lease"),
    holderDeviceId: deviceIdSchema.nullable(),
    expiresAt: z.string().datetime().nullable(),
  }),
  z.object({
    type: z.literal("relay.error"),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("relay.presence"),
    hostOnline: z.boolean(),
    viewers: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("relay.pong"),
    sentAt: z.string().datetime(),
  }),
]);

export type RelayMessage = z.infer<typeof relayMessageSchema>;

export const relayClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("relay.frame"),
    recipientDeviceId: deviceIdSchema.optional(),
    frame: encryptedFrameSchema,
  }),
  z.object({
    type: z.literal("relay.lease.request"),
    durationSeconds: z.number().int().min(5).max(60).default(30),
  }),
  z.object({
    type: z.literal("relay.lease.release"),
  }),
  z.object({
    type: z.literal("relay.ping"),
    sentAt: z.string().datetime(),
  }),
]);

export type RelayClientMessage = z.infer<typeof relayClientMessageSchema>;
