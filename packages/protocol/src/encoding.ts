const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const packed = (first << 16) | (second << 8) | third;
    output += alphabet[(packed >>> 18) & 63];
    output += alphabet[(packed >>> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(packed >>> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[packed & 63] : "=";
  }
  return output;
}

export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/\s/g, "");
  if (clean.length % 4 !== 0) {
    throw new Error("Invalid base64 length");
  }

  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((clean.length / 4) * 3 - padding);
  let offset = 0;

  for (let index = 0; index < clean.length; index += 4) {
    const a = alphabet.indexOf(clean[index] ?? "");
    const b = alphabet.indexOf(clean[index + 1] ?? "");
    const c = clean[index + 2] === "=" ? 0 : alphabet.indexOf(clean[index + 2] ?? "");
    const d = clean[index + 3] === "=" ? 0 : alphabet.indexOf(clean[index + 3] ?? "");
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new Error("Invalid base64 character");
    }
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < output.length) output[offset++] = (packed >>> 16) & 255;
    if (offset < output.length) output[offset++] = (packed >>> 8) & 255;
    if (offset < output.length) output[offset++] = packed & 255;
  }

  return output;
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function utf8Text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

export function concatBytes(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

