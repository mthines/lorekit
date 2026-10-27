-- ═════════════════════════════════════════════════════════════════════════
-- 00116 — API-token tenancy `orgs_only`: selected orgs, and NO personal rows.
--
-- THE GAP. Every tenancy (00068) could reach the token owner's personal rows:
-- `lorekit_api_token_org_allowed` answered `true` for `org_id IS NULL` before it
-- even looked at the tenancy, on the reasoning that a key never revokes its own
-- owner's memories. That is right for a key the owner keeps — and wrong for a
-- key the owner PUBLISHES. A project that ships a read-only token so its users
-- can read the project's org-owned lore (reaper-mcp's built-in mix knowledge)
-- also hands every user the owner's personal memories in the allowed scopes,
-- including archived ones.
--
-- THE MODE. `orgs_only` narrows orgs exactly like `selected` (org_ids, ≥ 1,
-- intersected with live membership) and additionally closes the personal
-- branch: reads see no personal row, and a write that would land on a personal
-- row is refused (LK002 key_personal_denied) instead of falling back to
-- personal. The other three tenancies are unchanged.
--
-- WHERE IT IS ENFORCED.
--   • `lorekit_api_token_org_allowed` — the one predicate every tenancy-aware
--     RPC already calls per row (list, scopes, tags, facets, pivot, activity,
--     relevant, delete, restore, …). No signature changes anywhere: every RPC
--     already threads `p_key_org_access` through.
--   • `memory_write` — its personal destination never consulted the predicate,
--     so it gains an explicit check (the only body change here).
--   • `lorekit_api_token_set_scoping` + the table CHECKs accept the new value.
--   The edge applies the same rule to its PostgREST reads (`tenant-scope.ts`),
--   and refuses `orgs_only` the operations that pick rows by owner rather than
--   by tenant (purge, quota, protect, policies, groom — `account-wide-tools.ts`).
--
-- UNKNOWN VALUES FAIL CLOSED. The personal branch now answers `true` only for
-- the three tenancies known to allow it, so a value this function does not
-- recognise (a BYOD install, a future migration) reaches nothing. The edge's
-- `normalizeKeyRestriction` maps an unknown value to `orgs_only` with no orgs —
-- the same "nothing" — so an older reader can never widen a newer value.
--
-- ROLLOUT. Apply this migration and deploy the edge together. Until both are
-- live no key can carry `orgs_only`: the CHECK below is what admits the value,
-- and the dashboard/API only offer it once the edge understands it.
-- ═════════════════════════════════════════════════════════════════════════

-- 1. The table CHECKs admit the new value.
alter table api_tokens
  drop constraint if exists api_tokens_org_access_valid;
alter table api_tokens
  add constraint api_tokens_org_access_valid
  check (org_access in ('all', 'personal', 'selected', 'orgs_only'));

-- `orgs_only`, like `selected`, names its orgs: an `orgs_only` key with no orgs
-- would reach nothing at all, and any other tenancy carrying org ids would be a
-- lie the next reader believes.
alter table api_tokens
  drop constraint if exists api_tokens_org_ids_match_access;
alter table api_tokens
  add constraint api_tokens_org_ids_match_access
  check ((org_access in ('selected', 'orgs_only')) = (cardinality(org_ids) > 0));

-- 2. The per-row predicate.
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
    -- A personal row (org_id IS NULL) is reachable under the three tenancies
    -- that keep the owner's own memories. NOT under `orgs_only` (00116), and not
    -- under a value this function does not recognise — that fails closed. A
    -- NULL tenancy is the pre-00068 "no key restriction" and stays reachable.
    when p_org_id is null
      then coalesce(p_org_access, 'all') in ('all', 'personal', 'selected')
    when p_org_access = 'all' then true
    when p_org_access = 'personal' then false
    -- `coalesce(…, false)` is load-bearing: a NULL ELEMENT in p_org_ids makes
    -- `= any(…)` evaluate to NULL, and an authorization predicate must answer
    -- true or false (see 00068).
    when p_org_access in ('selected', 'orgs_only')
      then coalesce(p_org_id = any(coalesce(p_org_ids, '{}'::uuid[])), false)
    else false
  end;
$$;

comment on function lorekit_api_token_org_allowed(text, uuid[], uuid) is
  'May a key with this tenancy reach a row owned by p_org_id (NULL = personal)? '
  'orgs_only (00116) reaches selected orgs and no personal row; an unknown '
  'tenancy reaches nothing. Authoritative over org_scope_bindings auto-routing.';

revoke execute on function lorekit_api_token_org_allowed(text, uuid[], uuid) from public, anon;
grant execute on function lorekit_api_token_org_allowed(text, uuid[], uuid) to authenticated, service_role;

-- 3. `lorekit_api_token_set_scoping` — the dashboard's write path accepts the
-- new value. Body copied from 00068; only the two tenancy re-statements change.

create or replace function lorekit_api_token_set_scoping(
  p_token_id uuid,
  p_scopes text[],
  p_org_access text,
  p_org_ids uuid[]
)
returns table (
  id uuid,
  scopes text[],
  org_access text,
  org_ids uuid[]
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_scopes   text[];
  v_org_ids  uuid[];
  v_owner    uuid;
  v_stray    uuid;
begin
  if v_actor is null then
    raise exception 'LK001: authentication required' using errcode = '28000';
  end if;

  -- These used to be `coalesce(p_scopes, '{}')` / `coalesce(p_org_ids, '{}')` in
  -- the declare block, which reopened the hole giving the arguments no DEFAULT
  -- was meant to close. No DEFAULT stops an OMITTED argument; the coalesce let
  -- an EXPLICIT null through and turned it into '{}' — and for `scopes`, '{}'
  -- means UNRESTRICTED (decision 1). So `set_scoping(id, null, 'all', '{}')`
  -- silently widened the key to every scope, which is exactly the fail-open
  -- partial update decision 5 refuses.
  --
  -- Refused rather than treated as "leave unchanged": that would make this a
  -- partial-update API that has to read and merge the current row, and decision
  -- 5 chose "state the full intended state on every call". Same reasoning, and
  -- now the same treatment, as the NULL `p_org_access` guard below.
  if p_scopes is null then
    raise exception 'LK004: scopes must not be null; pass an empty array to un-scope the key'
      using errcode = '22023';
  end if;

  if p_org_ids is null then
    raise exception 'LK004: org_ids must not be null; pass an empty array for a key with no orgs'
      using errcode = '22023';
  end if;

  v_scopes  := p_scopes;
  v_org_ids := p_org_ids;

  -- Ownership first, and by SELECT rather than by letting the UPDATE match zero
  -- rows: "you do not own this key" and "no such key" must be the same answer to
  -- the caller (no existence oracle), but they must be a real error rather than
  -- a silent no-op that the dashboard would render as success.
  select user_id into v_owner from api_tokens where api_tokens.id = p_token_id;
  if v_owner is null or v_owner <> v_actor then
    raise exception 'LK003: api token not found' using errcode = 'P0002';
  end if;

  -- Re-state the table's CHECKs here so a bad argument comes back as a legible
  -- LK004 the dashboard can render, not as a raw constraint-violation string
  -- naming an internal constraint. The CHECKs stay the authority — this is the
  -- error message, not the gate.
  if cardinality(v_scopes) > 50 then
    raise exception 'LK004: at most 50 scope patterns per key' using errcode = '22023';
  end if;

  if not lorekit_api_token_scopes_valid(v_scopes) then
    raise exception 'LK004: a scope pattern may contain only [a-z0-9._:/-], with an optional trailing "*" directly after a "/" or a "::"'
      using errcode = '22023';
  end if;

  if cardinality(v_org_ids) > 50 then
    raise exception 'LK004: at most 50 orgs per key' using errcode = '22023';
  end if;

  -- `is null or` is load-bearing, not defensive noise. `null not in (…)` is
  -- NULL, `if NULL` takes the false branch, and the `<>` guard below is NULL for
  -- the same reason — so a NULL tenancy would fall through BOTH re-statements
  -- and reach the UPDATE, where the column's NOT NULL rejects it as a raw 23502
  -- naming an internal constraint. That is the exact unreadable failure these
  -- re-statements exist to prevent. All three scoping arguments are now read
  -- raw and each carries its own explicit NULL refusal — `p_scopes` and
  -- `p_org_ids` above, this one here.
  --
  -- Refusing rather than coalescing to 'all' is deliberate: 'all' is the WIDEST
  -- tenancy, so defaulting a missing one would let an under-specified call widen
  -- the key — the same fail-open shape decision 5 refuses by giving the
  -- arguments no DEFAULT in the first place. That is also why the two arguments
  -- above are no longer coalesced: their default, '{}', means UNRESTRICTED.
  if p_org_access is null or p_org_access not in ('all', 'personal', 'selected', 'orgs_only') then
    raise exception 'LK004: org_access must be all, personal, selected or orgs_only'
      using errcode = '22023';
  end if;

  if (p_org_access in ('selected', 'orgs_only')) <> (cardinality(v_org_ids) > 0) then
    raise exception 'LK004: org_ids must be non-empty for org_access=selected or orgs_only and empty otherwise'
      using errcode = '22023';
  end if;

  -- A key cannot be pointed at an org its OWNER cannot reach. Without this the
  -- column would be a wish rather than a restriction: the request-time check
  -- intersects with the owner's real membership anyway, so an unreachable org id
  -- would sit in the row looking like access that was granted. Rejecting it here
  -- keeps the row honest and the failure legible.
  -- A NULL ELEMENT has to go first, because the membership guard below cannot
  -- see it: a NULL org id IS selected into v_stray (`m.org_id = null` is NULL,
  -- so `not exists` is true), but then `v_stray is not null` is false and the
  -- raise never fires. Two layers of three-valued logic cancelling out into
  -- "looks like a member". The CHECK is the authority; this is the legible
  -- LK004, same division of labour as the other re-statements above.
  if array_position(v_org_ids, null) is not null then
    raise exception 'LK004: org_ids must not contain a null element'
      using errcode = '22023';
  end if;

  select t.org_id into v_stray
  from unnest(v_org_ids) as t(org_id)
  where not exists (
    select 1 from lorekit_member_org_ids(v_actor) as m(org_id)
    where m.org_id = t.org_id
  )
  limit 1;
  if v_stray is not null then
    raise exception 'LK002: not a member of org %', v_stray using errcode = '42501';
  end if;

  -- Qualified in RETURNING, bare on the left of SET — the shape `memory_write`
  -- has used since 00007, which is what keeps the OUT parameter names from
  -- colliding with the identically-named columns.
  return query
  update api_tokens
     set scopes     = v_scopes,
         org_access = p_org_access,
         org_ids    = v_org_ids
   where api_tokens.id = p_token_id
     and api_tokens.user_id = v_actor
  returning api_tokens.id, api_tokens.scopes, api_tokens.org_access, api_tokens.org_ids;
end;
$$;

-- 4. `memory_write` — refuses a personal write from a key that may not reach
-- personal rows. Body copied from 00111; the only change is the marked block
-- after the org-routing resolution. Signature and RETURNS TABLE unchanged.

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
  p_host          text        default null,
  p_key_scopes     text[]     default '{}',
  p_key_org_access text       default 'all',
  p_key_org_ids    uuid[]     default '{}'
)
returns table (
  id               uuid,
  created_at       timestamptz,
  inserted         boolean,
  org_routed       boolean,
  binding_org_slug text,
  expires_at       timestamptz,
  scope            text,
  key              text,
  value            text,
  tags             text[],
  source_agent     text,
  trigger          text,
  updated_at       timestamptz,
  archived_at      timestamptz,
  origin_repo      text,
  origin_branch    text,
  origin_commit    text,
  origin_pr        integer,
  kind             text,
  host             text,
  seen_count       integer
)
language plpgsql
security definer
set search_path = public
as $$
-- See 00075's comment for why this directive is required (the OUT columns
-- `scope`/`key` collide with the bare column names in the `on conflict`
-- arbiter lists below).
#variable_conflict use_column
declare
  v_org_id       uuid;
  v_binding_org  uuid;
  v_binding_slug text;
  v_expires_at   timestamptz;
  v_ttl_action   text := 'keep';
begin
  if not lorekit_api_token_scope_allowed(p_key_scopes, p_scope) then
    raise exception using errcode = 'LK002',
      message = format('key_scope_denied: scope=%s', p_scope);
  end if;

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
    if not lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, v_org_id) then
      raise exception using errcode = 'LK002',
        message = format('key_org_denied: org=%s', p_org_slug);
    end if;
  else
    -- Wildcard-aware, most-specific-wins resolution. A binding matches
    -- p_scope either by exact string equality, or — when it ends in '*' — as
    -- an owner-wildcard prefix (the same LIKE-escaping `lorekit_api_token_
    -- scope_allowed` (00068) uses, since `%` and `\` cannot occur in a
    -- pattern that already passed the grammar gate above). Among matches:
    -- exact (is-wildcard = false) always sorts before any wildcard; among
    -- wildcards, the LONGER literal prefix (length desc) sorts first as the
    -- more specific match; the trailing `scope asc` is a determinism
    -- safeguard for a tie that provably cannot occur (see the header
    -- comment), not a reachable precedence branch.
    select b.org_id, o.slug into v_binding_org, v_binding_slug
    from org_scope_bindings b
    join orgs o on o.id = b.org_id
    where o.deleted_at is null
      and (
        b.scope = p_scope
        or (
          right(b.scope, 1) = '*'
          and p_scope like replace(left(b.scope, -1), '_', '\_') || '%'
        )
      )
    order by (right(b.scope, 1) = '*') asc, length(b.scope) desc, b.scope asc
    limit 1;

    if v_binding_org is not null
       and p_user_id is not null
       and lorekit_org_can(p_user_id, v_binding_org, 'write')
       and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, v_binding_org) then
      v_org_id := v_binding_org;
    end if;
  end if;

  -- 00116: a PERSONAL write is gated by the key's tenancy too. Every branch
  -- above either picked an org (and checked it) or left v_org_id NULL, which
  -- means "write a personal row" — the one destination no tenancy used to gate,
  -- because every tenancy could reach personal rows. `orgs_only` cannot, so
  -- refuse instead of silently falling back to personal: a token that was
  -- scoped to publish org lore must never grow its owner a personal row.
  if v_org_id is null
     and not lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, null) then
    raise exception using errcode = 'LK002',
      message = format('key_personal_denied: this token may not write personal memories (scope=%s)', p_scope);
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
      true as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count;

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
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count;

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
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count;
  end if;
end;
$$;

grant execute on function memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text, text[], text, uuid[]
) to anon, authenticated, service_role;
