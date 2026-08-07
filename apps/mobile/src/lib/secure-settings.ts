import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { AndroidBootstrap } from "./android-bootstrap";
import { developmentOverride } from "./development-overrides";

const keys = {
  relayUrl: "bezi-remote.relay-url",
  ownerToken: "bezi-remote.owner-token",
  deviceId: "bezi-remote.device-id",
} as const;

export type SecureSettings = {
  relayUrl: string;
  ownerToken: string;
  deviceId: string;
};

export async function loadSecureSettings(): Promise<SecureSettings> {
  const [storedRelayUrl, ownerToken, storedDeviceId] = await Promise.all([
    SecureStore.getItemAsync(keys.relayUrl),
    SecureStore.getItemAsync(keys.ownerToken),
    SecureStore.getItemAsync(keys.deviceId),
  ]);
  const developmentDeviceId = developmentOverride(
    process.env.EXPO_PUBLIC_DEV_MOBILE_DEVICE_ID,
  );
  const deviceId =
    developmentDeviceId ?? storedDeviceId ?? `mobile-${Crypto.randomUUID()}`;
  if (!storedDeviceId && !developmentDeviceId) {
    await SecureStore.setItemAsync(keys.deviceId, deviceId);
  }
  return {
    relayUrl:
      developmentOverride(process.env.EXPO_PUBLIC_RELAY_URL) ??
      storedRelayUrl ??
      "http://127.0.0.1:8787",
    ownerToken:
      developmentOverride(process.env.EXPO_PUBLIC_DEV_OWNER_TOKEN) ??
      ownerToken ??
      "",
    deviceId,
  };
}

export async function saveRelayCredentials(
  relayUrl: string,
  ownerToken: string,
): Promise<void> {
  const normalized = relayUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(normalized)) {
    throw new Error("Relay URL must begin with http:// or https://");
  }
  if (ownerToken.length < 32) {
    throw new Error("Development owner token must be at least 32 characters");
  }
  await Promise.all([
    SecureStore.setItemAsync(keys.relayUrl, normalized),
    SecureStore.setItemAsync(keys.ownerToken, ownerToken),
  ]);
}

export async function saveAndroidBootstrap(
  bootstrap: AndroidBootstrap,
): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(keys.relayUrl, bootstrap.relayUrl.replace(/\/+$/, "")),
    SecureStore.setItemAsync(keys.ownerToken, bootstrap.ownerToken),
    SecureStore.setItemAsync(keys.deviceId, bootstrap.mobileDeviceId),
    SecureStore.setItemAsync(`bezi-remote.pair.${bootstrap.hostId}`, bootstrap.pairSecret),
  ]);
}

export async function savePairSecret(
  hostId: string,
  pairSecret: string,
): Promise<void> {
  await SecureStore.setItemAsync(`bezi-remote.pair.${hostId}`, pairSecret);
}

export async function getPairSecret(hostId: string): Promise<string | null> {
  const developmentHostId = developmentOverride(
    process.env.EXPO_PUBLIC_DEV_HOST_ID,
  );
  const developmentPairSecret = developmentOverride(
    process.env.EXPO_PUBLIC_DEV_PAIR_SECRET,
  );
  if (
    developmentHostId === hostId &&
    developmentPairSecret
  ) {
    return developmentPairSecret;
  }
  return SecureStore.getItemAsync(`bezi-remote.pair.${hostId}`);
}

export async function removePairSecret(hostId: string): Promise<void> {
  await SecureStore.deleteItemAsync(`bezi-remote.pair.${hostId}`);
}
