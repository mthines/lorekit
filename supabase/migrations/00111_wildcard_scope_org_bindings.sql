-- ═════════════════════════════════════════════════════════════════════════
-- Wildcard scope → org bindings: bind a WHOLE prefix (`repo::owner/*`,
-- `branch::owner/repo::*`) to an org instead of one concrete scope at a time,
-- and resolve writes under a MOST-SPECIFIC-WINS rule when several bindings
-- could match.
--
-- ── What changes, and why ───────────────────────────────────────────────
--
-- 1. `lorekit_scope_bind` gains a SQL-side grammar gate: the pattern must
--    satisfy `lorekit_api_token_scopes_valid` (00068) — the SAME charset and
--    wildcard-position rule already enforced for API-token scope allowlists,
--    reused rather than forked so the two authorities can never drift. The
--    gate sits AFTER the `manage_scopes` authorization check, so an
--    authorized owner submitting a malformed pattern is refused by the
--    grammar, not the auth layer — and a non-admin is still refused by auth
--    first, unchanged. `lorekit_scope_unbind` needs no grammar gate: deleting
--    a row by its exact stored string can't insert a bad one.
--
-- 2. `memory_write`'s no-explicit-org branch changes from a single-row
--    equijoin (`where b.scope = p_scope`) to a wildcard-aware match:
--
--      where o.deleted_at is null
--        and (b.scope = p_scope
--             or (right(b.scope, 1) = '*'
--                 and p_scope like replace(left(b.scope, -1), '_', '\_') || '%'))
--      order by (right(b.scope, 1) = '*') asc, length(b.scope) desc, b.scope asc
--      limit 1
--
--    Precedence, in the ORDER BY: an EXACT string always beats ANY wildcard
--    (`false < true` on the first key); among wildcards, the LONGER literal
--    prefix wins (more specific); ties break on the scope string itself,
--    ascending, purely for determinism — two distinct wildcard prefixes of
--    EQUAL length cannot both match one `p_scope` (prefix containment forces
--    different lengths), and two identical exact strings can't coexist (the
--    unique index on `scope`), so the third key is a documented safeguard,
--    never a reachable branch. The LIKE escaping mirrors
--    `lorekit_api_token_scope_allowed` (00068) byte-for-byte — the pattern's
--    own CHECK already excludes `%` and `\`, so the escape only neutralises a
--    literal `_`.
--
--    Every other branch of `memory_write` (explicit `p_org_slug`, the
--    service-role write, the personal fallback, the returned columns) is
--    copied VERBATIM from 00075 — the current definition (confirmed by
--    grepping every `memory_write` definer) — so this migration's diff is
--    exactly the matcher above.
--
-- 3. Overlapping bindings are ALLOWED — an exact scope and a wildcard, or two
--    wildcards of different depth, may coexist, even bound to different
--    orgs. Only an IDENTICAL pattern STRING bound to a second org still
--    raises `scope_bound_elsewhere` (the existing unique index on `scope` is
--    unchanged — it was never a uniqueness-of-match constraint, only a
--    uniqueness-of-literal-row one).
--
-- No REST route, OpenAPI path, `rest-tool-name` mapping, or new audit action
-- is added — bindings stay the dashboard-RPC-only exempt surface, and
-- wildcards reuse the existing `scope.bind` / `scope.unbind` audit actions.
-- ═════════════════════════════════════════════════════════════════════════

-- 0. `org_scope_bindings.scope` gets the SAME shape gate at the table level,
--    not only inside `lorekit_scope_bind`. Without this, a row inserted
--    before this migration under the old (non-empty-only) validation — or by
--    any future direct INSERT that bypasses the RPC — could hold a scope
--    string ending in `*` with no charset guarantee, and the LIKE-escaping in
--    `memory_write`'s matcher below is only injection-safe because it relies
--    on this exact shape (no `%`/`\` in a valid pattern). A CHECK makes any
--    such row fail this migration LOUDLY at deploy time instead of silently
--    starting to behave as a live wildcard the moment 00111 ships.
alter table org_scope_bindings
  drop constraint if exists org_scope_bindings_scope_shape;
alter table org_scope_bindings
  add constraint org_scope_bindings_scope_shape
  check (lorekit_api_token_scopes_valid(array[scope]));

-- 1. `lorekit_scope_bind` — add the grammar gate after the auth gate.
create or replace function lorekit_scope_bind(p_org_id uuid, p_scope text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_existing_org uuid;
  v_id uuid;
begin
  if p_scope is null or length(trim(p_scope)) = 0 then
    raise exception using errcode = 'P0001', message = 'scope is required';
  end if;

  if not lorekit_org_can(v_actor, p_org_id, 'manage_scopes') then
    raise exception using errcode = 'LK002',
      message = format('org_permission_denied: org=%s capability=manage_scopes', p_org_id);
  end if;

  -- Grammar gate, deliberately AFTER the authorization gate above so the two
  -- layers are independently provable: an unauthorized actor is refused by
  -- auth regardless of pattern shape, and an authorized actor with a bad
  -- pattern is refused here. Reuses 00068's shape validator verbatim — this
  -- is a SHAPE check (charset + wildcard position), not full canonical-scope
  -- validation; the dashboard's `validateScopeBindingPattern` does the
  -- stronger check for a non-wildcard string before this RPC is ever called.
  if not lorekit_api_token_scopes_valid(array[p_scope]) then
    raise exception using errcode = 'P0001',
      message = format('invalid_scope_pattern: %s', p_scope);
  end if;

  select org_id, id into v_existing_org, v_id from org_scope_bindings where scope = p_scope;
  if v_existing_org = p_org_id then
    -- Already bound to this org — idempotent no-op; return the existing id.
    return v_id;
  elsif v_existing_org is not null then
    raise exception using errcode = 'P0001',
      message = format('scope_bound_elsewhere: %s', p_scope);
  end if;

  insert into org_scope_bindings (org_id, scope, created_by)
  values (p_org_id, p_scope, v_actor)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function lorekit_scope_bind(uuid, text) is
  'Bind a scope pattern (exact or owner wildcard, e.g. repo::owner/*) to an '
  'org. Admin/owner only (manage_scopes); pattern must pass '
  'lorekit_api_token_scopes_valid or raises invalid_scope_pattern.';

-- 2. `memory_write` — wildcard-aware most-specific-wins binding resolution.
-- Signature and RETURNS TABLE shape are UNCHANGED from 00075, so no `drop`.
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
