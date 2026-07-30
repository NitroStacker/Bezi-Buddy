export function json(
  value: unknown,
  init: ResponseInit & { status?: number } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return json({ error: { code, message } }, { status });
}

export async function readJson<T>(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Payload is too large");
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Payload is too large");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

