import { z } from "zod";
import { decodeBase64Url } from "./session-encoding";

export const androidBootstrapSchema = z.object({
  v: z.literal(1),
  relayUrl: z.string().url().refine((value) => value.startsWith("https://"), {
    message: "Android bootstrap relay must use HTTPS",
  }),
  ownerToken: z.string().min(32).max(512),
  hostId: z.string().min(8).max(128),
  mobileDeviceId: z.string().min(8).max(128),
  pairSecret: z.string().min(43).max(128),
  expiresAt: z.string().datetime(),
});

export type AndroidBootstrap = z.infer<typeof androidBootstrapSchema>;

export function parseAndroidBootstrapPayload(
  payload: string,
  now = Date.now(),
): AndroidBootstrap {
  if (!payload || payload.length > 4_096) {
    throw new Error("The Android setup link is missing or too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
  } catch {
    throw new Error("The Android setup link is invalid");
  }
  const bootstrap = androidBootstrapSchema.parse(parsed);
  if (Date.parse(bootstrap.expiresAt) <= now) {
    throw new Error("This Android setup link has expired. Relaunch Bezi Buddy on the PC.");
  }
  return bootstrap;
}
