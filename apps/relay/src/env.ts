export interface Env {
  DB: D1Database;
  HOST_ROOMS: DurableObjectNamespace;
  ENVIRONMENT: "development" | "staging" | "production";
  PAIRING_TTL_SECONDS: string;
  DEV_OWNER_TOKEN?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
}

export type AuthContext = {
  ownerId: string;
};

