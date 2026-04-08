-- Migration: Performance indexes
-- À jouer dans Supabase SQL Editor (idempotent)

CREATE INDEX IF NOT EXISTS idx_debriefs_user_id_call_date
  ON debriefs (user_id, call_date DESC);

CREATE INDEX IF NOT EXISTS idx_deals_user_id_status
  ON deals (user_id, status);

CREATE INDEX IF NOT EXISTS idx_teams_owner_id
  ON teams (owner_id);

CREATE INDEX IF NOT EXISTS idx_users_team_id
  ON users (team_id);

CREATE INDEX IF NOT EXISTS idx_objectives_closer_id
  ON objectives (closer_id);
