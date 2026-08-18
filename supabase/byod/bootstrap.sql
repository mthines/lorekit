-- LoreKit BYOD Bootstrap Schema
-- Apply this file to your own Supabase project to enable LoreKit memory.* tools.
--
-- Usage:
--   psql "$DATABASE_URL" -f supabase/byod/bootstrap.sql
--   # or via lorekit CLI:
--   lorekit bootstrap
--
-- This is a subset of the full LoreKit schema. Org sharing, audit logs,
-- webhook secrets, and billing tables are NOT included — those require
-- the hosted LoreKit product.
--
-- Billing note:
--   Memories stored in your own database are NOT counted against LoreKit's
--   hosted memory-count billing. LoreKit has no visibility into your private
--   database and cannot meter memories stored there. BYOD users are on a
--   flat-rate or open-source tier. You are responsible for configuring memory
--   limits and rate limiting in your own project.
--
-- Schema upgrades:
--   When LoreKit ships schema changes that affect the memory.* tools, you will
--   need to apply updates manually. Run `lorekit doctor` to check compatibility.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Extensions
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Shared trigger function
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. memories table
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists memories (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users on delete cascade,
  -- org_id is accepted in the schema for compatibility with the hosted write RPC
  -- signature, but BYOD does not enforce org membership (no orgs table).
  org_id       text,
  scope        text not null,
  key          text not null,
  value        text not null check (length(value) <= 65536),
  tags         text[] not null default '{}',
  source_agent text,
  trigger      text,
  -- Author attribution columns (additive, nullable).
  created_by   uuid references auth.users on delete set null,
  updated_by   uuid references auth.users on delete set null,
  -- Generated FTS column for full-text search.
  fts          tsvector generated always as (
    to_tsvector('english', coalesce(key, '') || ' ' || coalesce(value, ''))
  ) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Soft-delete: archived rows are hidden from normal reads.
  archived_at  timestamptz,
  -- Optional TTL: when set, the row is treated as invisible after this timestamp.
  expires_at   timestamptz
);

-- Indexes
create index if not exists memories_fts_idx        on memories using gin(fts);
create index if not exists memories_scope_idx      on memories (scope);
create index if not exists memories_user_idx       on memories (user_id);
create index if not exists memories_scope_key      on memories (scope, key);
create index if not exists memories_archived_at_idx on memories (archived_at)
  where archived_at is not null;
create index if not exists memories_expires_at_idx  on memories (expires_at)
  where expires_at is not null;

-- Partial unique indexes (matching the hosted schema's ON CONFLICT predicates).
-- Drop the old plain unique constraint if it exists from a previous install.
alter table memories drop constraint if exists memories_user_scope_key_unique;

create unique index if not exists memories_user_scope_key_active_unique
  on memories (user_id, scope, key)
  where org_id is null and user_id is not null and archived_at is null;

create unique index if not exists memories_null_user_scope_key_active_unique
  on memories (scope, key)
  where org_id is null and user_id is null and archived_at is null;

-- Enable RLS
alter table memories enable row level security;

-- RLS: users can read their own active (non-archived) rows.
drop policy if exists "rls_read" on memories;
create policy "rls_read"
  on memories for select
  using (
    archived_at is null
    and user_id = auth.uid()
  );

-- RLS: users can read their own archived rows (dashboard archive view).
drop policy if exists "rls_read_archived" on memories;
create policy "rls_read_archived"
  on memories for select
  using (
    archived_at is not null
    and user_id = auth.uid()
  );

-- RLS: users can insert their own rows; service_role bypasses via superuser.
drop policy if exists "rls_insert" on memories;
create policy "rls_insert"
  on memories for insert
  with check (
    user_id = auth.uid()
    or auth.role() = 'service_role'
  );

-- RLS: users can update their own rows.
drop policy if exists "rls_update" on memories;
create policy "rls_update"
  on memories for update
  using (
    user_id = auth.uid()
    or auth.role() = 'service_role'
  );

-- RLS: users can delete their own rows.
drop policy if exists "rls_delete" on memories;
create policy "rls_delete"
  on memories for delete
  using (
    user_id = auth.uid()
    or auth.role() = 'service_role'
  );

-- Trigger to keep updated_at current.
drop trigger if exists memories_updated_at on memories;
create trigger memories_updated_at
  before update on memories
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. api_tokens table
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users on delete cascade not null,
  name         text not null check (length(name) >= 1 and length(name) <= 100),
  -- First 12 chars + "..." for display — safe to store, max 16 chars.
  token_prefix text not null check (length(token_prefix) <= 16),
  -- SHA-256 hex of the full token — used for lookup on every request.
  token_hash   text not null unique,
  -- Array of granted permissions: 'read' | 'write'.
  permissions  text[] not null default '{"read","write"}',
  -- Scoping (migration 00068). EMPTY scopes = unrestricted; org_access is a
  -- tri-state and org_ids is non-empty iff org_access = 'selected'.
  scopes       text[] not null default '{}',
  org_access   text   not null default 'all',
  org_ids      uuid[] not null default '{}',
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);

-- `create table if not exists` above is a no-op on an install that predates
-- 00068, so the columns are added separately for that case.
alter table api_tokens
  add column if not exists scopes     text[] not null default '{}',
  add column if not exists org_access text   not null default 'all',
  add column if not exists org_ids    uuid[] not null default '{}';

create index if not exists api_tokens_user_idx on api_tokens(user_id);
create index if not exists api_tokens_hash_idx on api_tokens(token_hash);

-- Shape gate for the scope allowlist. A CHECK cannot hold a subquery, and
-- "every element satisfies P" needs one — hence the immutable helper.
create or replace function lorekit_api_token_scopes_valid(p_patterns text[])
returns boolean
language sql
immutable
as $$
  select p_patterns is null or not exists (
    select 1
    from unnest(p_patterns) as t(pattern)
    where (t.pattern ~ '^[a-z0-9._:/-]+(/|::)\*$' or t.pattern ~ '^[a-z0-9._:/-]+$') is not true
       or (length(t.pattern) <= 200) is not true
  );
$$;

alter table api_tokens drop constraint if exists api_tokens_scopes_len;
alter table api_tokens add constraint api_tokens_scopes_len
  check (cardinality(scopes) <= 50);

alter table api_tokens drop constraint if exists api_tokens_scopes_shape;
alter table api_tokens add constraint api_tokens_scopes_shape
  check (lorekit_api_token_scopes_valid(scopes));

alter table api_tokens drop constraint if exists api_tokens_org_access_valid;
alter table api_tokens add constraint api_tokens_org_access_valid
  check (org_access in ('all', 'personal', 'selected'));

alter table api_tokens drop constraint if exists api_tokens_org_ids_match_access;
alter table api_tokens add constraint api_tokens_org_ids_match_access
  check ((org_access = 'selected') = (cardinality(org_ids) > 0));

alter table api_tokens drop constraint if exists api_tokens_org_ids_len;
alter table api_tokens add constraint api_tokens_org_ids_len
  check (cardinality(org_ids) <= 50);

-- `{null}` has cardinality 1, so neither CHECK above catches a NULL element,
-- and a NULL org id on an authorization column is "unknown", not "none".
-- Mirrored from 00068.
alter table api_tokens drop constraint if exists api_tokens_org_ids_not_null;
alter table api_tokens add constraint api_tokens_org_ids_not_null
  check (array_position(org_ids, null) is null);

-- The two request-time predicates. Kept byte-identical to the CURRENT hosted
-- definitions — `lorekit_api_token_scope_allowed` as re-issued by 00069 §8,
-- `lorekit_api_token_org_allowed` as first issued by 00068 — a BYOD install
-- that answers these differently is a BYOD install with a different
-- authorization boundary. Mirror the LATEST definition, never the one the
-- column was introduced with: 00068's looser scope predicate treated any
-- trailing `*` as a prefix wildcard, so a stored mid-token `*` WIDENED the key.
--
-- `lorekit_api_token_set_scoping` is deliberately NOT mirrored: it validates
-- org ids against `lorekit_member_org_ids`, and this file has no orgs by design
-- (see the header). The org columns are still created so the row shape the
-- transports select is identical on both deployments — with no orgs, every row
-- is personal and `lorekit_api_token_org_allowed` returns true regardless of
-- the tenancy, so the tri-state is inert rather than wrong.
create or replace function lorekit_api_token_scope_allowed(
  p_patterns text[],
  p_scope text
)
returns boolean
language sql
immutable
as $$
  select case
    when p_patterns is null or cardinality(p_patterns) = 0 then true
    when p_scope is null then false
    else exists (
      select 1
      from unnest(p_patterns) as pattern
      -- SCOPE_PATTERN's shape, verbatim (00069 §8). A `*` is a wildcard only
      -- directly after `/` or `::`; a pattern that fails this test is DROPPED
      -- rather than matched, so a stored mid-token wildcard can only ever
      -- narrow the key. The guard is needed even though `api_tokens_scopes_shape`
      -- exists, because the column can hold a value the CHECK never saw — a
      -- BYOD install bootstrapped before this file grew the constraint, or a
      -- constraint dropped by hand.
      where pattern ~ '^[a-z0-9._:/-]+((/|::)\*)?$'
        and case
          when right(pattern, 1) = '*'
            -- Escape LIKE's single-character wildcard in the literal prefix so
            -- `repo::my_org/*` stays owner-exact instead of also matching
            -- `repo::myXorg/...`. `%` and `\` cannot occur — the shape test's
            -- charset excludes them.
            then p_scope like replace(left(pattern, -1), '_', '\_') || '%'
          else p_scope = pattern
        end
    )
  end;
$$;

create or replace function lorekit_api_token_org_allowed(
  p_org_access text,
  p_org_ids uuid[],
  p_org_id uuid
)
returns boolean
language sql
immutable
as $$
  select case
    when p_org_id is null then true
    when p_org_access = 'all' then true
    when p_org_access = 'personal' then false
    -- `coalesce(…, false)`: a NULL element in p_org_ids makes `= any(…)` NULL,
    -- and an authorization predicate must never return NULL. Kept identical to
    -- 00068 — see the rationale there.
    when p_org_access = 'selected'
      then coalesce(p_org_id = any(coalesce(p_org_ids, '{}'::uuid[])), false)
    else false
  end;
$$;

-- The GRANTS are part of the mirror, not decoration: a `create function` is
-- PUBLIC-executable by default, so omitting these left a BYOD install with three
-- authorization predicates any role could call. Byte-for-byte bodies with
-- different grants is not a mirror.
revoke execute on function lorekit_api_token_scopes_valid(text[]) from public, anon;
revoke execute on function lorekit_api_token_scope_allowed(text[], text) from public, anon;
revoke execute on function lorekit_api_token_org_allowed(text, uuid[], uuid) from public, anon;
grant execute on function lorekit_api_token_scopes_valid(text[]) to authenticated, service_role;
grant execute on function lorekit_api_token_scope_allowed(text[], text) to authenticated, service_role;
grant execute on function lorekit_api_token_org_allowed(text, uuid[], uuid) to authenticated, service_role;

alter table api_tokens enable row level security;

drop policy if exists "rls_api_tokens_select" on api_tokens;
create policy "rls_api_tokens_select"
  on api_tokens for select
  using (user_id = auth.uid());

drop policy if exists "rls_api_tokens_insert" on api_tokens;
create policy "rls_api_tokens_insert"
  on api_tokens for insert
  with check (user_id = auth.uid());

drop policy if exists "rls_api_tokens_delete" on api_tokens;
create policy "rls_api_tokens_delete"
  on api_tokens for delete
  using (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Limits: default config, per-user overrides, cap trigger
-- ─────────────────────────────────────────────────────────────────────────────

-- 4a. Single source of truth for default limits.
--     BYOD users are responsible for adjusting these in their own project.
create or replace function lorekit_default_limit(p_key text)
returns integer
language sql
immutable
as $$
  select case p_key
    when 'max_memories'         then 5000
    when 'requests_per_minute'  then 120
    else null
  end;
$$;

-- 4b. Per-user override table.
create table if not exists user_limits (
  user_id             uuid primary key references auth.users on delete cascade,
  max_memories        integer,
  requests_per_minute integer,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table user_limits enable row level security;

drop policy if exists "rls_user_limits_select" on user_limits;
create policy "rls_user_limits_select"
  on user_limits for select
  using (user_id = auth.uid());

drop trigger if exists user_limits_updated_at on user_limits;
create trigger user_limits_updated_at
  before update on user_limits
  for each row execute function set_updated_at();

-- 4c. Resolve effective limit for a user.
create or replace function lorekit_get_limit(p_user_id uuid, p_key text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_override integer;
begin
  if p_key = 'max_memories' then
    select max_memories into v_override from user_limits where user_id = p_user_id;
  elsif p_key = 'requests_per_minute' then
    select requests_per_minute into v_override from user_limits where user_id = p_user_id;
  end if;

  return coalesce(v_override, lorekit_default_limit(p_key));
end;
$$;

-- 4d. Memory cap trigger — counts active (non-archived) rows and rejects the
--     insert at/over the limit. Service-role (user_id IS NULL) is exempt.
create or replace function enforce_memory_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_count integer;
begin
  if new.user_id is null then
    return new; -- service-role / CI writes are exempt from the cap
  end if;

  v_limit := lorekit_get_limit(new.user_id, 'max_memories');

  select count(*) into v_count
    from memories
   where user_id = new.user_id
     and archived_at is null;

  if v_count >= v_limit then
    raise exception using
      errcode = 'LK001',
      message = format('memory_cap_exceeded: limit=%s', v_limit);
  end if;

  return new;
end;
$$;

drop trigger if exists memories_enforce_cap on memories;
create trigger memories_enforce_cap
  before insert on memories
  for each row execute function enforce_memory_cap();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Rate limiting
-- ─────────────────────────────────────────────────────────────────────────────

-- 5a. Rate-limit counter table.
create table if not exists rate_limit_counters (
  user_id      uuid not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (user_id, window_start)
);

create index if not exists rate_limit_counters_window_idx
  on rate_limit_counters (window_start);

alter table rate_limit_counters enable row level security;
-- No policies: only touched via the SECURITY DEFINER RPC below.

-- 5b. Atomic fixed-window rate-limit check.
create or replace function lorekit_check_rate_limit(
  p_user_id        uuid,
  p_window_seconds integer default 60
)
returns table(
  allowed             boolean,
  current_count       integer,
  limit_value         integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_limit        integer;
  v_count        integer;
  v_retry_after  integer;
begin
  v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_limit := lorekit_get_limit(p_user_id, 'requests_per_minute');

  insert into rate_limit_counters (user_id, window_start, count)
  values (p_user_id, v_window_start, 1)
  on conflict (user_id, window_start)
  do update set count = rate_limit_counters.count + 1
  returning rate_limit_counters.count into v_count;

  v_retry_after := ceil(extract(epoch from (v_window_start + (p_window_seconds || ' seconds')::interval - now())))::integer;
  if v_retry_after < 0 then
    v_retry_after := 0;
  end if;

  return query select (v_count <= v_limit), v_count, v_limit, v_retry_after;
end;
$$;

-- 5c. Reaper for stale rate-limit windows.
create or replace function lorekit_purge_rate_limit_counters(
  p_older_than interval default interval '1 hour'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from rate_limit_counters
   where window_start < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Archive / restore / purge RPCs
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function archive_memory(
  p_user_id  uuid,
  p_scope    text,
  p_key      text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update memories
     set archived_at = now()
   where user_id = p_user_id
     and scope    = p_scope
     and key      = p_key
     and archived_at is null
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function restore_memory(
  p_user_id  uuid,
  p_scope    text,
  p_key      text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update memories
     set archived_at = null
   where user_id = p_user_id
     and scope    = p_scope
     and key      = p_key
     and archived_at is not null
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function purge_archived_memories(
  p_user_id        uuid,
  p_retention_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from memories
   where user_id     = p_user_id
     and archived_at is not null
     and archived_at < now() - (p_retention_days * interval '1 day')
  ;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function purge_expired_memories(
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from memories
   where user_id     = p_user_id
     and expires_at  is not null
     and expires_at  < now()
     and archived_at is null
  ;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. memory_write RPC
--
--    Accepts the same parameters as the hosted memory_write (migration 00031)
--    so no tool-handler code needs to change.
--
--    BYOD note: p_org_slug is accepted for parameter-signature compatibility
--    but is silently ignored — org ownership requires the hosted product's org
--    management RPCs and orgs table. Writes always land in the personal
--    (user-scoped) partition. A comment in the return is added for callers that
--    inspect org_routed.
--
--    The three key-restriction parameters (00068/00069) are NOT optional
--    cosmetics. PostgREST resolves an RPC by argument NAME, so `create.ts`
--    sending p_key_scopes / p_key_org_access / p_key_org_ids at a BYOD install
--    whose function lacks them misses the function entirely (PGRST202) and
--    surfaces as an opaque 500. And the scope allowlist is the LAST gate on the
--    write path a caller cannot route around — the edge holds the service-role
--    key, so the dispatcher's refusal is advisory by construction. Without it a
--    BYOD install got the columns and the CHECKs with no SQL-layer enforcement
--    at all. Guard kept byte-identical to 00069 §1.
-- ─────────────────────────────────────────────────────────────────────────────

-- Every earlier signature is dropped, newest first: `create or replace` keys on
-- the argument list, so growing the parameter list leaves the previous one
-- behind as an overload that PostgREST would still resolve for a caller sending
-- the old argument names.
drop function if exists memory_write(uuid, text, text, text, text[], text, text, timestamptz, text, integer, boolean);
drop function if exists memory_write(uuid, text, text, text, text[], text, text, timestamptz, text, integer);
drop function if exists memory_write(uuid, text, text, text, text[], text, text, timestamptz);
drop function if exists memory_write(uuid, text, text, text, text[], text, text);

create or replace function memory_write(
  p_user_id      uuid,
  p_scope        text,
  p_key          text,
  p_value        text,
  p_tags         text[]      default '{}',
  p_source_agent text        default null,
  p_trigger      text        default null,
  p_created_at   timestamptz default null,
  p_org_slug     text        default null,  -- accepted but ignored in BYOD (no orgs table)
  p_ttl_days     integer     default null,
  p_clear_ttl    boolean     default false,
  -- The CALLING KEY's restriction (00068/00069), defaulted to unrestricted so
  -- every existing BYOD caller keeps its behaviour with no call-site change.
  p_key_scopes     text[] default '{}',
  -- The tenancy pair is accepted for signature compatibility and is INERT here:
  -- BYOD has no orgs, so every row is personal and
  -- `lorekit_api_token_org_allowed` returns true regardless of the tenancy.
  -- Accepting it is what stops PostgREST's by-name resolution from missing this
  -- function; ignoring it is correct rather than lax.
  p_key_org_access text   default 'all',
  p_key_org_ids    uuid[] default '{}'
)
returns table (
  id               uuid,
  created_at       timestamptz,
  inserted         boolean,
  org_routed       boolean,
  binding_org_slug text,
  expires_at       timestamptz
)
language plpgsql
set search_path = public
as $$
declare
  v_expires_at timestamptz;
  -- Tri-state for the expires_at UPDATE branch:
  --   'clear'  → set to NULL
  --   'set'    → set to v_expires_at
  --   'keep'   → leave unchanged
  v_ttl_action text := 'keep';
begin
  -- p_org_slug is intentionally ignored in BYOD.
  -- Org-owned writes require the hosted LoreKit product.

  -- The scope allowlist, checked FIRST and for every branch — 00069 §1
  -- verbatim. LK002 is the code `translateDbError` already maps to a 403 on
  -- REST and a forbidden error on MCP, so no second mapping is needed.
  if not lorekit_api_token_scope_allowed(p_key_scopes, p_scope) then
    raise exception using errcode = 'LK002',
      message = format('key_scope_denied: scope=%s', p_scope);
  end if;

  if p_clear_ttl then
    v_ttl_action := 'clear';
  elsif p_ttl_days is not null then
    if p_ttl_days < 1 or p_ttl_days > 365 then
      raise exception using errcode = 'P0001',
        message = format('ttl_days must be between 1 and 365, got %s', p_ttl_days);
    end if;
    v_expires_at  := now() + (p_ttl_days * interval '1 day');
    v_ttl_action  := 'set';
  end if;

  if p_user_id is null then
    -- service-role / CI writes: (scope, key) partial index for null user_id
    return query
    insert into memories (
      user_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at
    )
    values (
      null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      null, null, v_expires_at
    )
    on conflict (scope, key) where org_id is null and user_id is null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now(),
      expires_at   = case v_ttl_action
                       when 'clear' then null
                       when 'set'   then v_expires_at
                       else memories.expires_at
                     end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, null::text as binding_org_slug, memories.expires_at;

  else
    -- user-scoped writes: (user_id, scope, key) partial index
    return query
    insert into memories (
      user_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at
    )
    values (
      p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at
    )
    on conflict (user_id, scope, key) where org_id is null and user_id is not null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now(),
      updated_by   = p_user_id,
      expires_at   = case v_ttl_action
                       when 'clear' then null
                       when 'set'   then v_expires_at
                       else memories.expires_at
                     end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, null::text as binding_org_slug, memories.expires_at;
  end if;
end;
$$;

grant execute on function memory_write(uuid, text, text, text, text[], text, text, timestamptz, text, integer, boolean, text[], text, uuid[])
  to anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. memory_delete RPC
--
--    Personal-only variant (no org gating — BYOD has no orgs table).
--    p_org_slug is accepted for signature compatibility but ignored.
-- ─────────────────────────────────────────────────────────────────────────────

-- The pre-00069 signature is DROPPED rather than replaced: `create or replace`
-- keys on the argument list, so adding parameters would leave two overloads and
-- PostgREST would resolve the old one for a caller that omits them.
drop function if exists memory_delete(uuid, text, text, text, boolean);

create or replace function memory_delete(
  p_user_id  uuid,
  p_org_slug text    default null,  -- accepted but ignored in BYOD
  p_scope    text    default null,
  p_key      text    default null,
  p_force    boolean default false,
  -- Same three as memory_write, for the same two reasons: PostgREST resolves by
  -- argument NAME (remove.ts sends all three), and this RPC chooses its own
  -- rows, so `applyKeyScopeFilter` never sees them and the allowlist has
  -- nowhere else to be enforced.
  p_key_scopes     text[] default '{}',
  p_key_org_access text   default 'all',   -- inert in BYOD (no orgs)
  p_key_org_ids    uuid[] default '{}'     -- inert in BYOD (no orgs)
)
returns table (deleted boolean, archived boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- p_org_slug is intentionally ignored in BYOD.
  -- Org-gated deletes require the hosted LoreKit product.

  -- 00069 §7 verbatim: the allowlist, before either branch.
  if not lorekit_api_token_scope_allowed(p_key_scopes, p_scope) then
    raise exception using errcode = 'LK002',
      message = format('key_scope_denied: scope=%s', p_scope);
  end if;

  if p_force then
    delete from memories
     where user_id = p_user_id and scope = p_scope and key = p_key;
    get diagnostics v_count = row_count;

    return query select (v_count > 0), false;
  else
    update memories
       set archived_at = now()
     where user_id = p_user_id and scope = p_scope and key = p_key and archived_at is null;
    get diagnostics v_count = row_count;

    return query select false, (v_count > 0);
  end if;
end;
$$;

grant execute on function memory_delete(uuid, text, text, text, boolean, text[], text, uuid[]) to anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Grants
-- ─────────────────────────────────────────────────────────────────────────────

grant usage on schema public to anon, authenticated, service_role;
grant all on table memories to anon, authenticated, service_role;
grant all on table api_tokens to anon, authenticated, service_role;
grant all on table user_limits to anon, authenticated, service_role;
grant all on table rate_limit_counters to anon, authenticated, service_role;

grant execute on function lorekit_default_limit(text) to anon, authenticated, service_role;
grant execute on function lorekit_get_limit(uuid, text) to anon, authenticated, service_role;
grant execute on function lorekit_check_rate_limit(uuid, integer) to anon, authenticated, service_role;
grant execute on function lorekit_purge_rate_limit_counters(interval) to anon, authenticated, service_role;
grant execute on function archive_memory(uuid, text, text) to anon, authenticated, service_role;
grant execute on function restore_memory(uuid, text, text) to anon, authenticated, service_role;
grant execute on function purge_archived_memories(uuid, integer) to anon, authenticated, service_role;
grant execute on function purge_expired_memories(uuid) to authenticated, service_role;

comment on table memories is
  'LoreKit agent memories. BYOD install — personal rows only (no org sharing).';
comment on column memories.expires_at is
  'Optional timestamp after which the row is treated as invisible by active-read
   paths. NULL means the row never expires. Physically deleted by
   purge_expired_memories() or the MCP memory.purge tool.';
comment on column memories.org_id is
  'Accepted for hosted-schema compatibility; org-owned writes require the hosted
   LoreKit product. In BYOD this column is always NULL.';
