-- ─── Google Calendar integration ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_integrations (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_access_token  TEXT,
  google_refresh_token TEXT,
  google_token_expiry  TIMESTAMPTZ,
  google_calendar_id   TEXT NOT NULL DEFAULT 'primary',
  gcal_sync_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  gcal_last_synced_at  TIMESTAMPTZ,
  gcal_synced_event_ids JSONB NOT NULL DEFAULT '[]',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_integration" ON user_integrations
  FOR ALL USING (user_id = auth.uid());

-- Track calendar→lead mapping to avoid duplicates
CREATE TABLE IF NOT EXISTS calendar_leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_event_id TEXT NOT NULL,
  deal_id         UUID REFERENCES deals(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, google_event_id)
);

ALTER TABLE calendar_leads ENABLE ROW LEVEL SECURITY;
