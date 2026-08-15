-- ═════════════════════════════════════════════════════════════════════════
-- memories.seen_count — RECURRENCE as a real column, counted by the writer.
--
-- WHY: recurrence is already the load-bearing signal in LoreKit's own guidance.
-- `packages/cli/skill/lorekit-setup/rules/self-improvement-loops.md` gates
-- promotion on `seen_count >= 3`, `lorekit-groom`'s volatile-key rule exists
-- precisely because a per-sighting identifier in the key "never dedups and
-- leaves seen_count frozen at 1", and `lessons-view.mjs`'s LINT_RULES cites the
-- same field. None of it was ever true: the counter lived only as hand-written
-- text inside a lesson body's `<!-- meta: seen_count=1 ... -->` comment, so
-- nothing incremented it, nothing could read it, and every consumer above was
-- describing a column that did not exist.
--
-- This makes it real, and puts the increment where the recurrence actually
-- happens: the upsert. A write whose (tenant, scope, key) already resolves to a
-- live row IS the second sighting of that lesson — that is the definition the
-- skill documents ("a recurrence resolves to an UPDATE that increments
-- seen_count by 1"), so the RPC counts it rather than trusting a caller to pass
-- a number it would have to read back first.
--
-- Forward-only and additive. The column is NOT NULL DEFAULT 1 — one sighting is
-- what an existing row has demonstrably had, so the backfill is the default and
-- no data migration is required. `memory_write` keeps its 00056 signature
-- unchanged (no new parameter — the count is derived, never supplied), so every
-- existing caller is untouched and this is a CREATE OR REPLACE rather than the
-- DROP-first dance a signature change forces.
--
-- No index: no read path filters or orders on seen_count yet. Same call as
-- 00048 made for the origin_* columns — add one with the query that needs it.
-- ═════════════════════════════════════════════════════════════════════════

-- ── column on memories ──────────────────────────────────────────────────────
alter table memories add column if not exists seen_count integer not null default 1;

-- A sighting count is >= 1 by construction: the row exists because it was
-- written at least once. The backstop makes a corrupt/hand-edited 0 or negative
-- value fail loudly here rather than silently sinking a lesson's salience in
-- whatever ranks on this column later.
alter table memories drop constraint if exists memories_seen_count_positive;
alter table memories add constraint memories_seen_count_positive
  check (seen_count >= 1);

-- ── writer: memory_write counts the recurrence ──────────────────────────────
-- Body is 00056's verbatim plus `seen_count` in every branch. The signature is
-- IDENTICAL to 00056's, so CREATE OR REPLACE is safe and leaves no ambiguous
-- overload behind — unlike 00048/00056, this migration adds no parameter.
--
-- Insert branches set 1 explicitly rather than leaning on the column default,
-- so the first-sighting value is visible in the same statement that the
-- increment is, and the two cannot drift if the default is ever changed.
--
-- The increment is `memories.seen_count + 1`, NOT `excluded.seen_count + 1`:
-- `excluded` is the row the INSERT proposed, which always carries the literal 1
-- and would pin every recurrence at 2.
--
-- Reviving an ARCHIVED key is deliberately NOT a recurrence. Every conflict
-- predicate below is partial on `archived_at is null` (00016), so a write
-- against an archived key inserts a fresh row and starts at 1 — the lesson was
-- retired and is being learned again, which is the honest reading and matches
-- the existing created_at semantics on that path.
create or replace function memory_write(
  p_user_id       uuid,
  p_scope         text,
  p_key           text,
  p_value         text,
  p_tags          text[]      default '{}',
  p_source_agent  text        default null,
  p_trigger       text        default null,
  p_created_at    timestamptz default null,
  p_org_slug      text        default null,
  p_ttl_seconds   integer     default null,
  p_clear_ttl     boolean     default false,
  p_origin_repo   text        default null,
  p_origin_branch text        default null,
  p_origin_commit text        default null,
  p_origin_pr     integer     default null,
  p_kind          text        default null,
  p_host          text        default null
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
  v_org_id       uuid;
  v_binding_org  uuid;
  v_binding_slug text;
  v_expires_at   timestamptz;
  v_ttl_action   text := 'keep';
begin
  if p_clear_ttl then
    v_ttl_action := 'clear';
  elsif p_ttl_seconds is not null then
    if p_ttl_seconds < 1 or p_ttl_seconds > 31536000 then
      raise exception using errcode = 'P0001',
        message = format('ttl_seconds must be between 1 and 31536000, got %s', p_ttl_seconds);
    end if;
    v_expires_at  := now() + (p_ttl_seconds * interval '1 second');
    v_ttl_action  := 'set';
  end if;

  if p_org_slug is not null then
    select o.id into v_org_id from orgs o where o.slug = p_org_slug and o.deleted_at is null;
    if v_org_id is null then
      raise exception using errcode = 'P0001', message = format('unknown_org: %s', p_org_slug);
    end if;
    if not lorekit_org_can(p_user_id, v_org_id, 'write') then
      raise exception using errcode = 'LK002', message = format('org_permission_denied: org=%s', p_org_slug);
    end if;
  else
    select b.org_id, o.slug into v_binding_org, v_binding_slug
    from org_scope_bindings b
    join orgs o on o.id = b.org_id
    where b.scope = p_scope and o.deleted_at is null;

    if v_binding_org is not null
       and p_user_id is not null
       and lorekit_org_can(p_user_id, v_binding_org, 'write') then
      v_org_id := v_binding_org;
    end if;
  end if;

  if v_org_id is not null then
    return query
    insert into memories (
      user_id, org_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count
    )
    values (
      null, v_org_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1
    )
    on conflict (org_id, scope, key) where org_id is not null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
      updated_by    = p_user_id,
      seen_count    = memories.seen_count + 1,
      origin_repo   = coalesce(excluded.origin_repo,   memories.origin_repo),
      origin_branch = coalesce(excluded.origin_branch, memories.origin_branch),
      origin_commit = coalesce(excluded.origin_commit, memories.origin_commit),
      origin_pr     = coalesce(excluded.origin_pr,     memories.origin_pr),
      kind          = coalesce(excluded.kind,          memories.kind),
      host          = coalesce(excluded.host,          memories.host),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      true as org_routed, v_binding_slug as binding_org_slug, memories.expires_at;

  elsif p_user_id is null then
    return query
    insert into memories (
      user_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count
    )
    values (
      null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      null, null, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1
    )
    on conflict (scope, key) where org_id is null and user_id is null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
      seen_count    = memories.seen_count + 1,
      origin_repo   = coalesce(excluded.origin_repo,   memories.origin_repo),
      origin_branch = coalesce(excluded.origin_branch, memories.origin_branch),
      origin_commit = coalesce(excluded.origin_commit, memories.origin_commit),
      origin_pr     = coalesce(excluded.origin_pr,     memories.origin_pr),
      kind          = coalesce(excluded.kind,          memories.kind),
      host          = coalesce(excluded.host,          memories.host),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at;

  else
    return query
    insert into memories (
      user_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count
    )
    values (
      p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1
    )
    on conflict (user_id, scope, key) where org_id is null and user_id is not null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
      updated_by    = p_user_id,
      seen_count    = memories.seen_count + 1,
      origin_repo   = coalesce(excluded.origin_repo,   memories.origin_repo),
      origin_branch = coalesce(excluded.origin_branch, memories.origin_branch),
      origin_commit = coalesce(excluded.origin_commit, memories.origin_commit),
      origin_pr     = coalesce(excluded.origin_pr,     memories.origin_pr),
      kind          = coalesce(excluded.kind,          memories.kind),
      host          = coalesce(excluded.host,          memories.host),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at;
  end if;
end;
$$;

grant execute on function memory_write(uuid, text, text, text, text[], text, text, timestamptz, text, integer, boolean, text, text, text, integer, text, text)
  to anon, authenticated, service_role;
