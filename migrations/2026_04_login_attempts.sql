-- Migration: Persistent brute-force tracking
-- Replaces in-memory Map with Supabase-backed storage
-- Safe to run multiple times (idempotent)

CREATE TABLE IF NOT EXISTS login_attempts (
  email_key  TEXT PRIMARY KEY,
  attempts   JSONB NOT NULL DEFAULT '[]',
  lock_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-cleanup: remove rows older than 2 hours
CREATE INDEX IF NOT EXISTS idx_login_attempts_updated 
  ON login_attempts (updated_at);

-- Row-level security: service role only (not exposed to anon)
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;

-- Only service role can access (no anon/authenticated policy = denied by default)
-- This table is accessed exclusively through the backend service role key
