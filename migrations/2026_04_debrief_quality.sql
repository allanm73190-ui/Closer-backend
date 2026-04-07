-- ─────────────────────────────────────────────────────────────────────────────
-- Lot 1 — Debrief Quality v1
-- Idempotent / additive. Safe to run multiple times.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Colonnes qualité sur debriefs
alter table if exists debriefs
  add column if not exists submitted_at timestamptz default now(),
  add column if not exists overall_quality_score integer,
  add column if not exists quality_flags jsonb default '[]'::jsonb,
  add column if not exists quality_breakdown jsonb default '{}'::jsonb,
  add column if not exists validation_status text default 'pending',
  add column if not exists validated_at timestamptz,
  add column if not exists validated_by uuid,
  add column if not exists debrief_mode text default 'full';

-- Backfill submitted_at si NULL (sécurité)
update debriefs set submitted_at = coalesce(submitted_at, created_at, now())
where submitted_at is null;

create index if not exists idx_debriefs_validation_status on debriefs (validation_status);
create index if not exists idx_debriefs_overall_quality on debriefs (overall_quality_score);

-- 2. Table debrief_reviews
create table if not exists debrief_reviews (
  id uuid primary key default gen_random_uuid(),
  debrief_id uuid not null references debriefs(id) on delete cascade,
  reviewer_id uuid not null,
  status text not null check (status in ('validated','corrected','rejected')),
  review_note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_debrief_reviews_debrief on debrief_reviews (debrief_id);
create index if not exists idx_debrief_reviews_reviewer on debrief_reviews (reviewer_id);
