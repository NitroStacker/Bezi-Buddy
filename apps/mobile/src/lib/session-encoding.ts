export function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  throw new Error("This runtime does not provide base64 decoding");
}

export function decodeHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("Session salt must be 32 bytes of hexadecimal");
  }
  return Uint8Array.from(
    value.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)),
  );
}
