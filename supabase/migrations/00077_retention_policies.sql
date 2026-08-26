-- Retention policies: scoped, saved rules that AUTO-ARCHIVE (never hard-delete)
-- matching lessons. The automated generalization of the manual TTL/expiry
-- grooming that already exists (purge_expired_memories, the lorekit-groom
-- skill). v1 is PERSONAL-owned (user_id-keyed) only — org-owned policies are
-- explicitly deferred to a later phase.
--
-- ONE candidate function (lorekit_groom_candidates) is the single source of
-- truth for "what matches" — preview, run-now, and the nightly sweep all
-- resolve the SAME candidates, so a previewed count always equals what a run
-- archives. Archiving reuses the existing soft-archive mechanism
-- (archived_at, 00003_archive.sql) — a policy NEVER hard-deletes; hard purge
-- stays exactly where it is (memory.purge / memory.purge_expired, manual,
-- confirm-or---yes).
--
-- ── "unseen_days" and memories.last_seen_at ─────────────────────────────────
-- LoreKit does not yet track per-memory READ activity (usage_events records
-- reads in aggregate, not per row). Rather than wiring real read-tracking
-- through every read handler — a much larger change than this migration's
-- scope — `last_seen_at` ships here as a nullable column that starts out NULL
-- for every row (nothing sets it yet) and is reserved for that follow-up.
-- lorekit_groom_candidates treats a NULL last_seen_at as negative infinity,
-- so "unseen for N days" is unconditionally TRUE for a never-seen row — this
-- is the literal reading of "unseen_days includes never-seen lessons" and
-- requires no additional wiring to be correct today (every row is
-- "never-seen" until read-tracking lands). Wiring memory.read/list/search to
-- bump it is deliberately left as a follow-up, noted in
-- docs/adding-an-operation.md's worked-example feature.

-- 1. retention_policies — one row per saved rule.
create table if not exists retention_policies (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users on delete cascade,
  scope          text not null,
  name           text not null,
  -- 'review'  — surfaced in the dashboard for a human to run manually.
  -- 'auto'    — swept nightly by lorekit_groom_sweep, IF enabled=true.
  mode           text not null default 'review' check (mode in ('review', 'auto')),
  -- Auto mode starts DISABLED per policy — a saved rule must be explicitly
  -- turned on before it archives anything unattended.
  enabled        boolean not null default false,
  min_age_days   integer check (min_age_days is null or min_age_days > 0),
  unseen_days    integer check (unseen_days is null or unseen_days > 0),
  max_seen_count integer check (max_seen_count is null or max_seen_count >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists retention_policies_user_id_idx on retention_policies (user_id);

alter table retention_policies enable row level security;

-- Owner-only, full CRUD via RLS — unlike memories, there is no org-shared
-- read path yet (v1 is personal-owned), so a single policy suffices.
create policy "rls_retention_policies_owner"
  on retention_policies for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace trigger retention_policies_updated_at
  before update on retention_policies
  for each row execute function set_updated_at();

-- 2. memories.protected — excluded from every grooming candidate set,
--    regardless of policy. memories.last_seen_at — see header note above.
alter table memories add column if not exists protected boolean not null default false;
alter table memories add column if not exists last_seen_at timestamptz;

-- 3. lorekit_groom_candidates — THE single source of truth for "what
--    matches" a set of conditions. Called directly by groom.preview, and by
--    lorekit_groom_run below (never a second query). SECURITY DEFINER so it
--    can be called by an unprivileged token's resolved user_id, matching the
--    purge_archived_memories / restore_memory precedent — the explicit
--    p_user_id parameter (never auth.uid()) is what lets an api_key caller's
--    resolved user reach it.
--
--    Scope matching: p_scope = 'global' matches every memory; an exact scope
--    match always matches; a 'repo::owner/repo' policy additionally matches
--    every 'branch::owner/repo::*' memory (a branch scope's repo portion IS
--    the containing repo scope's value) — the "::"-delimited hierarchy the
--    plan's Decisions describe. 'project::*' and 'branch::*' policies match
--    only their exact scope, since no narrower scope type nests under them.
create or replace function lorekit_groom_candidates(
  p_user_id        uuid,
  p_scope          text,
  p_min_age_days   integer default null,
  p_unseen_days    integer default null,
  p_max_seen_count integer default null
)
returns table (id uuid, scope text, key text)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.scope, m.key
    from memories m
   where m.user_id = p_user_id
     and m.archived_at is null
     and m.protected = false
     and (
       p_scope = 'global'
       or m.scope = p_scope
       or (
         p_scope like 'repo::%'
         -- starts_with (not LIKE) so `_`/`%` in the repo name are literal, not
         -- wildcards — an over-match bug this repo hit before (#231, #260).
         and starts_with(m.scope, 'branch::' || substring(p_scope from 7) || '::')
       )
     )
     and (p_min_age_days is null or m.created_at <= now() - (p_min_age_days * interval '1 day'))
     and (p_unseen_days is null or coalesce(m.last_seen_at, '-infinity'::timestamptz) <= now() - (p_unseen_days * interval '1 day'))
     and (p_max_seen_count is null or m.seen_count <= p_max_seen_count)
   order by m.scope, m.key;
$$;

grant execute on function lorekit_groom_candidates(uuid, text, integer, integer, integer)
  to authenticated, service_role;

-- 4. lorekit_groom_run — archives every candidate in ONE transaction (this
--    function's body), returns the count + the archived keys, and NEVER
--    deletes a row. Deliberately does NOT write audit_log itself — LoreKit's
--    audit capture model is app-layer, explicit recordAudit calls right after
--    the primary operation succeeds (CLAUDE.md "Audit logging is captured at
--    the app layer"), not a DB-side insert. Both callers (the MCP groom.run
--    tool and the REST POST /groom/run handler) write one 'memory.archive'
--    audit row per key in the returned `keys` array after this RPC returns.
create or replace function lorekit_groom_run(
  p_user_id        uuid,
  p_scope          text,
  p_min_age_days   integer default null,
  p_unseen_days    integer default null,
  p_max_seen_count integer default null
)
returns table (archived integer, keys jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids   uuid[];
  v_keys  jsonb;
  v_count integer := 0;
begin
  select coalesce(array_agg(c.id), '{}'),
         coalesce(jsonb_agg(jsonb_build_object('scope', c.scope, 'key', c.key)), '[]'::jsonb)
    into v_ids, v_keys
    from lorekit_groom_candidates(p_user_id, p_scope, p_min_age_days, p_unseen_days, p_max_seen_count) c;

  if array_length(v_ids, 1) is null then
    return query select 0, '[]'::jsonb;
    return;
  end if;

  update memories m
     set archived_at = now()
   where m.id = any(v_ids)
     and m.archived_at is null; -- defensive; candidates are already unarchived
  get diagnostics v_count = row_count;

  return query select v_count, v_keys;
end;
$$;

grant execute on function lorekit_groom_run(uuid, text, integer, integer, integer)
  to authenticated, service_role;

-- 5. lorekit_groom_sweep — the nightly cron target. Archives ONLY for
--    policies with mode='auto' AND enabled=true; 'review' policies and
--    disabled 'auto' policies are left untouched (they surface in the
--    dashboard for a human to run via groom.run instead). Returns the total
--    number of memories archived across every swept policy.
create or replace function lorekit_groom_sweep()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_policy retention_policies%rowtype;
  v_result record;
  v_total  integer := 0;
begin
  for v_policy in
    select * from retention_policies where mode = 'auto' and enabled = true
  loop
    select * into v_result
      from lorekit_groom_run(
        v_policy.user_id, v_policy.scope,
        v_policy.min_age_days, v_policy.unseen_days, v_policy.max_seen_count
      );
    v_total := v_total + coalesce(v_result.archived, 0);
  end loop;

  return v_total;
end;
$$;

grant execute on function lorekit_groom_sweep() to service_role;

-- 6. lorekit_memory_protect — toggle memories.protected for one lesson.
--    SECURITY DEFINER, mirroring archive_memory/restore_memory (00003):
--    it runs as the table owner but only touches the row addressed by the
--    caller's own resolved user_id.
create or replace function lorekit_memory_protect(
  p_user_id   uuid,
  p_scope     text,
  p_key       text,
  p_protected boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update memories
     set protected = p_protected
   where user_id    = p_user_id
     and scope       = p_scope
     and key         = p_key
     and archived_at is null
  returning id into v_id;

  return v_id is not null;
end;
$$;

grant execute on function lorekit_memory_protect(uuid, text, text, boolean)
  to authenticated, service_role;

-- 7. Policy CRUD RPCs — SECURITY DEFINER, owner-scoped by explicit p_user_id
--    (never auth.uid()), matching every mutation RPC above. Routing CRUD
--    through RPCs rather than the generated PostgREST/postgrest-js Database
--    types is deliberate: `retention_policies` is a brand-new table the
--    generated `database.types.ts` mirror does not know about, and every
--    other mutable resource in this schema (memories, orgs, api_tokens) is
--    already reached through a SECURITY DEFINER function rather than a raw
--    `.from(table)` call for the same api_key/service-role-bypasses-RLS
--    reason — this is the existing pattern, not a new one.
create or replace function lorekit_policy_list(p_user_id uuid)
returns setof retention_policies
language sql
stable
security definer
set search_path = public
as $$
  select * from retention_policies where user_id = p_user_id order by created_at desc;
$$;

grant execute on function lorekit_policy_list(uuid) to authenticated, service_role;

-- Every policy-CRUD RPC below RETURNS SETOF (zero or one row) rather than a
-- bare composite. A plpgsql function declared `returns retention_policies`
-- that never assigns its %rowtype OUT variable still returns a NON-NULL
-- composite with every field null — not SQL NULL — so a caller checking
-- "found" by nullability would misread a not-found UPDATE/DELETE as a hit.
-- SETOF sidesteps that ambiguity entirely: zero matching rows is a zero-length
-- result set, one match is a one-row set, and the postgrest-js caller reads
-- `data[0]` with no `.single()`/`.maybeSingle()` needed (TracedRpcQuery only
-- exposes `.single()`, which errors on a zero-row result — the wrong shape for
-- an expected "not found").
create or replace function lorekit_policy_create(
  p_user_id        uuid,
  p_scope          text,
  p_name           text,
  p_mode           text default 'review',
  p_enabled        boolean default false,
  p_min_age_days   integer default null,
  p_unseen_days    integer default null,
  p_max_seen_count integer default null
)
returns setof retention_policies
language sql
security definer
set search_path = public
as $$
  insert into retention_policies (user_id, scope, name, mode, enabled, min_age_days, unseen_days, max_seen_count)
  values (p_user_id, p_scope, p_name, p_mode, p_enabled, p_min_age_days, p_unseen_days, p_max_seen_count)
  returning *;
$$;

grant execute on function lorekit_policy_create(uuid, text, text, text, boolean, integer, integer, integer)
  to authenticated, service_role;

-- Partial update via a JSONB patch: a key ABSENT from p_patch leaves the
-- column unchanged; a key present with a JSON null CLEARS it (sets the
-- column to NULL); a key present with a value SETS it. The `?` (has-key)
-- operator is what makes "absent" and "present-but-null" distinguishable —
-- `coalesce(p_patch->>'x', x)` alone could never clear a field. Zero rows
-- back means p_id does not exist or is not owned by p_user_id — "not found".
create or replace function lorekit_policy_update(
  p_user_id uuid,
  p_id      uuid,
  p_patch   jsonb
)
returns setof retention_policies
language sql
security definer
set search_path = public
as $$
  update retention_policies
     set name           = case when p_patch ? 'name'           then p_patch ->> 'name'                    else name end,
         mode            = case when p_patch ? 'mode'           then p_patch ->> 'mode'                    else mode end,
         enabled         = case when p_patch ? 'enabled'        then (p_patch ->> 'enabled')::boolean       else enabled end,
         min_age_days    = case when p_patch ? 'min_age_days'   then (p_patch ->> 'min_age_days')::integer  else min_age_days end,
         unseen_days     = case when p_patch ? 'unseen_days'    then (p_patch ->> 'unseen_days')::integer   else unseen_days end,
         max_seen_count  = case when p_patch ? 'max_seen_count' then (p_patch ->> 'max_seen_count')::integer else max_seen_count end
   where id = p_id and user_id = p_user_id
  returning *;
$$;

grant execute on function lorekit_policy_update(uuid, uuid, jsonb) to authenticated, service_role;

create or replace function lorekit_policy_delete(p_user_id uuid, p_id uuid)
returns setof retention_policies
language sql
security definer
set search_path = public
as $$
  delete from retention_policies
   where id = p_id and user_id = p_user_id
  returning *;
$$;

grant execute on function lorekit_policy_delete(uuid, uuid) to authenticated, service_role;

-- 8. Nightly sweep schedule — guarded so this migration still applies on an
--    instance without pg_cron (see the identical guard in
--    00003_archive.sql / 00004_limits.sql's rate-limit reaper). 03:17 UTC to
--    land off the hour, away from other scheduled jobs.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'lorekit-groom-sweep',
      '17 3 * * *',
      $cron$select lorekit_groom_sweep()$cron$
    );
  end if;
end;
$$;
