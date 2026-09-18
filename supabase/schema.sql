-- MacroWorld — Supabase schema (S1)
-- Persistence model: meals as INDIVIDUAL ROWS (one insert per meal), replacing the
-- single Firestore document per user that was rewritten wholesale on every change.
--
-- Tenancy is keyed by EMAIL, not the Supabase user id. Reason: data is migrated from
-- Firebase BEFORE users have Supabase accounts (Supabase issues brand-new uids). The
-- Google email is stable across both systems, so migrated rows are tagged by email and
-- become readable the instant the user signs in with that email — no uid-mapping dance.
-- Google emails are verified, which makes the email a safe tenant key here.
--
-- Run this in the Supabase SQL editor (or via the CLI) against the `macro-tracker` project.
-- Idempotent-ish: safe to re-run; drops/creates policies explicitly.

-- ── Helper: current signed-in user's email, lowercased ───────────────────────
create or replace function public.current_email() returns text
  language sql stable as $$ select lower(auth.jwt() ->> 'email') $$;

-- ── profiles: one row per user (goals + body profile + game state) ───────────
create table if not exists public.profiles (
  email      text primary key,
  user_id    uuid references auth.users on delete cascade,
  goals      jsonb,
  profile    jsonb,
  game       jsonb,
  updated_at timestamptz not null default now()
);

-- ── meals: ONE ROW PER LOGGED MEAL ───────────────────────────────────────────
create table if not exists public.meals (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  user_id    uuid references auth.users on delete cascade,
  client_id  bigint,            -- original Date.now() id from the app; used for dedup + row ops
  date_key   text not null,     -- 'YYYY-MM-DD' local-day bucket (preserves existing bucketing)
  logged_at  timestamptz,
  name       text,
  protein    numeric,
  carbs      numeric,
  fat        numeric,
  calories   numeric,
  serving    text,
  image_hash text,
  dish       text,
  sprite_id  text,
  created_at timestamptz not null default now(),
  unique (email, client_id)     -- one row per (user, original meal id): migration + insert are idempotent
);
create index if not exists meals_email_date_idx on public.meals (email, date_key);

-- ── sprites: METADATA only; the PNG bytes live in the Storage bucket 'sprites' ─
create table if not exists public.sprites (
  email        text not null,
  sprite_id    text not null,
  user_id      uuid references auth.users on delete cascade,
  storage_path text not null,   -- e.g. '<email>/<sprite_id>.png' inside the 'sprites' bucket
  created_at   timestamptz not null default now(),
  primary key (email, sprite_id)
);

-- ── Row-Level Security: a user sees ONLY rows whose email matches their JWT ────
alter table public.profiles enable row level security;
alter table public.meals    enable row level security;
alter table public.sprites  enable row level security;

drop policy if exists own_profiles on public.profiles;
create policy own_profiles on public.profiles for all
  using (email = public.current_email())
  with check (email = public.current_email());

drop policy if exists own_meals on public.meals;
create policy own_meals on public.meals for all
  using (email = public.current_email())
  with check (email = public.current_email());

drop policy if exists own_sprites on public.sprites;
create policy own_sprites on public.sprites for all
  using (email = public.current_email())
  with check (email = public.current_email());

-- ── Storage bucket for sprite PNGs (private; per-user folder = email) ──────────
insert into storage.buckets (id, name, public)
  values ('sprites', 'sprites', false)
  on conflict (id) do nothing;

-- Storage RLS: a user reads/writes only objects under their own '<email>/' folder.
drop policy if exists own_sprite_objects on storage.objects;
create policy own_sprite_objects on storage.objects for all
  using (bucket_id = 'sprites' and (storage.foldername(name))[1] = public.current_email())
  with check (bucket_id = 'sprites' and (storage.foldername(name))[1] = public.current_email());

-- ── save_failures: durable, per-user record of any persistence failure ────────
-- Purpose: proactively catch a recurrence of the silent meal-loss class across all
-- users without waiting for a report. Written best-effort from the client whenever a
-- meal or sprite save is dropped, errors, or returns no row. Never blocks the user.
-- Per-user RLS keeps each user to their own rows; audit ALL rows with the service_role
-- key (bypasses RLS): select email, kind, reason, at from save_failures order by at desc;
create table if not exists public.save_failures (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  kind       text not null,          -- 'meal' | 'sprite'
  reason     text not null,          -- 'skipped-no-owner' | 'error' | 'no-row-returned'
  client_id  bigint,                 -- meal's original id (null for sprites)
  sprite_id  text,                   -- sprite id (null for meals)
  detail     text,                   -- error message or meal name, for context
  at         timestamptz not null default now()
);
create index if not exists save_failures_email_at_idx on public.save_failures (email, at desc);

alter table public.save_failures enable row level security;

drop policy if exists own_save_failures on public.save_failures;
create policy own_save_failures on public.save_failures for all
  using (email = public.current_email())
  with check (email = public.current_email());
