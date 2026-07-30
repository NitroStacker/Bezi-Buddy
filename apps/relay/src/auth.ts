import type { AuthContext, Env } from "./env";
import { HttpError } from "./http";
import { timingSafeEqual } from "./security";

export function authenticate(request: Request, env: Env): AuthContext {
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(" ", 2);
  if (scheme !== "Bearer" || !token) {
    throw new HttpError(401, "unauthorized", "A bearer token is required");
  }

  // Stage A deliberately supports one manually provisioned owner. Replace this
  // branch with Clerk JWT verification before a public beta.
  if (
    env.ENVIRONMENT === "development" &&
    env.DEV_OWNER_TOKEN &&
    timingSafeEqual(token, env.DEV_OWNER_TOKEN)
  ) {
    return { ownerId: "development-owner" };
  }

  throw new HttpError(401, "unauthorized", "The bearer token is invalid");
}

