-- EXODIA DIGITAL chatbot database (Cloudflare D1, free plan).
-- Run once in the Cloudflare dashboard: Storage & Databases > D1 > your database > Console.
-- Safe to run again: it only creates what is missing.

-- Inquiries and consultation REQUESTS. Nothing here is a confirmed appointment.
CREATE TABLE IF NOT EXISTS leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),          -- UTC
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  business_type   TEXT NOT NULL,
  service         TEXT NOT NULL,
  details         TEXT NOT NULL,
  preferred_date  TEXT,                                              -- requested date only (YYYY-MM-DD, PH time)
  preferred_time  TEXT CHECK (preferred_time IN ('morning', 'afternoon', 'evening')),
  request_type    TEXT NOT NULL CHECK (request_type IN ('inquiry', 'consultation_request')),
  status          TEXT NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested', 'contacted', 'confirmed', 'closed')),
  consent_at      TEXT NOT NULL,
  consent_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at);
CREATE INDEX IF NOT EXISTS idx_leads_email   ON leads (email);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads (status);

-- Daily Workers AI neuron counter (UTC day, same as Cloudflare's reset).
CREATE TABLE IF NOT EXISTS ai_usage (
  day        TEXT PRIMARY KEY,          -- YYYY-MM-DD (UTC)
  used       REAL NOT NULL DEFAULT 0,   -- neurons from real token usage (or worst case when unverified)
  reserved   REAL NOT NULL DEFAULT 0,   -- neurons reserved for calls in progress
  requests   INTEGER NOT NULL DEFAULT 0,
  unverified INTEGER NOT NULL DEFAULT 0,
  locked     INTEGER NOT NULL DEFAULT 0 -- 1 = AI off for the rest of this day
);

-- Rate-limit counters keyed by a salted hash of the visitor IP (no raw IPs).
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT NOT NULL,
  window_start INTEGER NOT NULL,        -- unix seconds
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- Best-effort email status per lead (owner notification + customer receipt). No personal data.
-- Statuses: pending, sending (lease_until = unix seconds), sent, failed, unknown, skipped, disabled.
CREATE TABLE IF NOT EXISTS lead_notifications (
  ref                  TEXT PRIMARY KEY,                             -- leads.ref
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),      -- UTC
  owner_status         TEXT NOT NULL
                       CHECK (owner_status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'disabled')),
  customer_status      TEXT NOT NULL
                       CHECK (customer_status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'skipped', 'disabled')),
  customer_skip_reason TEXT,                                         -- same-address-24h, daily-cap, gmail-quota
  attempts             INTEGER NOT NULL DEFAULT 0,
  lease_until          INTEGER NOT NULL DEFAULT 0,
  last_code            TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per run of the daily cleanup Worker.
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at              TEXT NOT NULL DEFAULT (datetime('now')),
  leads_deleted       INTEGER NOT NULL,
  rate_limits_deleted INTEGER NOT NULL,
  usage_deleted       INTEGER NOT NULL
);
