PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'windows',
  refresh_hash TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '0.1.0',
  capability_hash TEXT
);

CREATE INDEX IF NOT EXISTS hosts_owner_idx ON hosts(owner_id, revoked_at);

CREATE TABLE IF NOT EXISTS mobile_devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS mobile_devices_owner_idx
  ON mobile_devices(owner_id, revoked_at);

CREATE TABLE IF NOT EXISTS host_pairings (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT REFERENCES mobile_devices(id),
  claimed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS host_pairings_expiry_idx
  ON host_pairings(expires_at, claimed_at);

CREATE TABLE IF NOT EXISTS session_tickets (
  ticket_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('host', 'viewer')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS session_tickets_expiry_idx
  ON session_tickets(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  host_id TEXT,
  actor_device_id TEXT,
  action_class TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_owner_time_idx
  ON audit_events(owner_id, created_at DESC);

