-- ═══════════════════════════════════════════════════════════════════════════
-- Run `migrations.test.sql` against a BARE PostgreSQL cluster (no Docker)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
-- ---------------
-- `migrations.test.sql` is the only thing in this repo that exercises the raw
-- migration logic — triggers, RPCs, RLS, the capability matrix, the actor
-- override. Until now the ONLY way to run it was `supabase start`, which needs
-- Docker. In a container without a Docker socket (most cloud dev sandboxes, and
-- every agent session) that made the file unrunnable, so a broken assertion
-- could only be discovered by pushing and reading a CI log. That is a slow loop
-- for the file most likely to contain a subtle mistake.
--
-- This script provides the pieces the SUPABASE PLATFORM normally supplies, so
-- the migrations can be applied to an ordinary `initdb` cluster.
--
-- ⚠ FIDELITY — READ THIS BEFORE TRUSTING A GREEN RUN
-- --------------------------------------------------
-- This is a STAND-IN, not Supabase. It reproduces only what the migrations
-- actually reference, and the definitions below are written to match documented
-- Supabase behaviour — but they are OUR definitions, not the platform's.
--
--   * A FAILURE here is strong evidence: the migrations or the test are wrong.
--   * A PASS here is good evidence, NOT a substitute for CI. Anything that
--     depends on real GoTrue/PostgREST behaviour beyond "auth.uid() reads the
--     `sub` claim and auth.role() reads the `role` claim" is not covered.
--
-- CI's `Integration smoke (local Supabase)` job remains authoritative. Treat
-- this as the fast inner loop, and never as the reason to skip a push.
--
-- What is deliberately NOT reproduced: GoTrue itself, PostgREST (the tests call
-- SQL directly, which is the point — see migrations.test.sql's header), Storage,
-- Realtime, and the `extensions`-schema placement Supabase uses for pgvector on
-- hosted projects.
--
-- USAGE
-- -----
--   PGBIN=/usr/lib/postgresql/16/bin          # or wherever initdb lives
--   PGDATA=$(mktemp -d)/pg                    # must be readable by the pg user
--   $PGBIN/initdb -D "$PGDATA" -U postgres --auth=trust
--   $PGBIN/pg_ctl -D "$PGDATA" -o '-p 55432' -l "$PGDATA/../pg.log" start
--
--   DB=postgresql://postgres@127.0.0.1:55432/lk
--   psql postgresql://postgres@127.0.0.1:55432/postgres -c 'create database lk'
--   psql "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/bare-postgres-bootstrap.sql
--   for f in supabase/migrations/*.sql; do
--     psql "$DB" -v ON_ERROR_STOP=1 -q -f "$f" || echo "FAILED: $f"
--   done
--   psql "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/migrations.test.sql
--
-- `migrations.test.sql` wraps itself in one transaction and ends in `rollback`,
-- so it is re-runnable against the same database as many times as you like —
-- which is what makes guard-biting an assertion cheap.
--
-- Requires the `vector` extension (pgvector) for 00060/00062. On Debian/Ubuntu:
-- `apt-get install postgresql-16-pgvector`. Everything else (`pg_trgm`) ships
-- with the standard server package.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Roles ──────────────────────────────────────────────────────────────────
-- Cluster-wide, so this is idempotent across databases in one cluster.
-- `service_role` is BYPASSRLS, matching Supabase: that is what makes it the
-- tier the edge functions use for api_key auth, and why every raw read on that
-- path needs its own tenant predicate.
do $boot$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$boot$;

grant anon, authenticated, service_role to postgres;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- ── auth.users ─────────────────────────────────────────────────────────────
-- Reduced to the columns the migrations and migrations.test.sql reference. The
-- real table has many more; adding one here is fine, but a test that needs a
-- column GoTrue populates with real semantics (confirmation timestamps, MFA
-- factors) is a test that belongs in CI instead.
create table if not exists auth.users (
  instance_id        uuid,
  id                 uuid primary key,
  aud                text,
  role               text,
  email              text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data  jsonb default '{}'::jsonb,
  last_sign_in_at    timestamptz,
  deleted_at         timestamptz,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- ── auth.identities ────────────────────────────────────────────────────────
-- Only `lorekit_find_user_by_github_id` (00037) reads this: GitHub's numeric
-- account id is stored as TEXT in `provider_id`.
create table if not exists auth.identities (
  provider_id     text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  identity_data   jsonb not null default '{}'::jsonb,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  primary key (provider, provider_id)
);

-- ── The three claim readers ────────────────────────────────────────────────
-- THE LOAD-BEARING PART, and the one place a mistake here would quietly
-- invalidate a whole class of test.
--
-- In real Supabase these read the claims PostgREST has already
-- CRYPTOGRAPHICALLY VERIFIED and placed in `request.jwt.claims`. That is the
-- entire basis of 00041's security argument: `auth.role()` is not a request
-- field a client can set, it is a verified claim. These definitions preserve
-- exactly that shape — they read the same GUCs and nothing else — so a test
-- that forges claims with `set_config` is simulating a verified JWT, which is
-- the same thing the existing sections of migrations.test.sql already do.
--
-- Both the modern (`request.jwt.claims`, a JSON object) and legacy
-- (`request.jwt.claim.<name>`, flat strings) forms are honoured, because
-- migrations.test.sql uses the former and some Supabase versions set the latter.
-- `request.jwt.claims` is the ONLY whole-claims GUC. There is no singular
-- `request.jwt.claim` holding the object — the legacy form is per-field
-- (`request.jwt.claim.<name>`), which is why only `auth.uid()`/`auth.role()`
-- below have a legacy arm and this one does not.
create or replace function auth.jwt() returns jsonb
language sql stable as $fn$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$fn$;

create or replace function auth.uid() returns uuid
language sql stable as $fn$
  select nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    (auth.jwt() ->> 'sub')
  ), '')::uuid
$fn$;

create or replace function auth.role() returns text
language sql stable as $fn$
  select nullif(coalesce(
    current_setting('request.jwt.claim.role', true),
    (auth.jwt() ->> 'role')
  ), '')::text
$fn$;

grant execute on function auth.jwt(), auth.uid(), auth.role()
  to anon, authenticated, service_role;

-- Supabase places some extensions in a dedicated schema; 00060's comment notes
-- it. Created so a migration that qualifies a type that way still resolves.
create schema if not exists extensions;

-- Supabase Vault's decrypted view. 00074's §85 (PROF-5) branches on
-- `to_regclass('vault.decrypted_secrets') is null` inside a single boolean
-- expression (`if ... is null or not exists (select ... from
-- vault.decrypted_secrets ...)`) — and a relation named in a FROM clause has
-- to resolve at PARSE time even when OR's left side would short-circuit it at
-- runtime, so migrations.test.sql cannot even be parsed without this relation
-- existing. An empty table is sufficient: `lorekit_export_db_query_stats()`
-- (00074) already treats "no matching secret rows" as the same disabled state
-- as "no vault at all", which is exactly the case with zero rows.
create schema if not exists vault;
create table if not exists vault.decrypted_secrets (
  name              text,
  decrypted_secret  text
);
