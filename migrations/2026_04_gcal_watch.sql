-- Google Calendar Watch API — 2026-04

-- Watch API channel columns
ALTER TABLE user_integrations
  ADD COLUMN IF NOT EXISTS gcal_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS gcal_resource_id TEXT,
  ADD COLUMN IF NOT EXISTS gcal_sync_token TEXT,
  ADD COLUMN IF NOT EXISTS gcal_channel_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gcal_watch_active BOOLEAN DEFAULT FALSE;

-- Encrypted token columns (plain columns kept for backward compat during migration)
ALTER TABLE user_integrations
  ADD COLUMN IF NOT EXISTS google_access_token_enc TEXT,
  ADD COLUMN IF NOT EXISTS google_refresh_token_enc TEXT;

-- In-app notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT,
  read BOOLEAN DEFAULT FALSE,
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_user_unread ON notifications(user_id, read, created_at DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_notifications" ON notifications FOR ALL USING (user_id = auth.uid());

-- GCal columns on deals
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS google_event_id TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
