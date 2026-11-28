-- 00126 — `memory_write(p_edit)`: a maintenance edit that is not a sighting.
--
-- WHY. Every write to an existing scope+key is counted as the next sighting:
-- the upsert sets `seen_count = seen_count + 1` (00059, kept by 00120). That is
-- right for an agent re-learning a lesson, and wrong for a groomer fixing one in
-- place (trimming whitespace, stripping a hidden-metadata header, re-tagging):
-- the fix records a recurrence that never happened, and `seen_count >= 3` is
-- what marks a lesson for promotion into a permanent rule.
--
-- WHAT. One new trailing parameter, `p_edit boolean default false`. With it
-- set, the function UPDATES the caller's live row for scope+key and returns it,
-- or raises `memory_not_found` (P0002) when there is none; it never inserts and
-- never touches `seen_count` or `created_at`. Every gate before the write is
-- shared with a plain write (actor, key scope, org routing and tenancy,
-- supersedes, expected_version). Without the flag the function is 00120's.
--
-- `PATCH /memories/:id` already edits by id without counting a sighting; this
-- is the same edit addressed by scope+key, which is how agents and the CLI name
-- a lesson.

-- memory_write ─────────────────────────────────────────────────────────────

drop function if exists memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text,
  jsonb, text, uuid, text[], text, uuid[], integer
);

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
  p_attributes    jsonb       default null,
  p_content_type  text        default null,
  p_supersedes    uuid        default null,
  p_key_scopes     text[]     default '{}',
  p_key_org_access text       default 'all',
  p_key_org_ids    uuid[]     default '{}',
  p_expected_version integer  default null, -- 00120
  p_edit           boolean    default false -- 00126
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
  seen_count       integer,
  attributes       jsonb,
  content_type     text,
  supersedes       uuid,
  version          integer  -- 00120
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
  v_current_version integer;  -- 00120
  v_was_expired  boolean;     -- 00120
begin
  -- The actor is the verified caller, never a request field (the rule 00046
  -- applied to archive/restore/purge). This function is SECURITY DEFINER and
  -- granted to anon/authenticated, so without this a PostgREST caller names
  -- any p_user_id. A caller-supplied id is honoured only on a verified
  -- service-role connection (the edge/MCP api_key path resolves the token
  -- owner and passes it) or a direct connection with no JWT role at all; an
  -- anon or authenticated caller acts as `auth.uid()`, and no identity is refused.
  if auth.role() is distinct from 'service_role' and auth.role() is not null then
    if auth.uid() is null then
      raise exception using errcode = 'LK002', message = 'not_authenticated';
    end if;
    p_user_id := auth.uid();
  end if;

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

  -- 00119: a `supersedes` link may only name a memory with the SAME OWNER
  -- as the row being written — the caller's own personal memory for a personal
  -- write, a memory of the same org for an org write — inside this key's scope
  -- allowlist. Same-owner rather than "any memory the caller can read" so an
  -- org row never exposes the id of its writer's personal memory to every
  -- other member. An unreachable id fails EXACTLY like a nonexistent one, so
  -- the link cannot be used to probe for other tenants' memory ids. The
  -- service-role tier (p_user_id null) may link to any existing memory.
  if p_supersedes is not null and not exists (
    select 1
      from memories m
     where m.id = p_supersedes
       and (
         p_user_id is null
         or (
           lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
           and case
                 when v_org_id is not null then m.org_id = v_org_id
                 else m.org_id is null and m.user_id = p_user_id
               end
         )
       )
  ) then
    raise exception using errcode = 'P0001',
      message = format('supersedes_not_found: %s', p_supersedes);
  end if;

  -- 00120: optimistic concurrency. `p_expected_version` is the version the
  -- caller last read; 0 means "this key must not exist yet". The live row this
  -- write would upsert (the same owner + scope + key the conflict target below
  -- names) is locked FOR UPDATE, so nothing can move its version between this
  -- check and the upsert. A key with no live row is version 0. The `where` on
  -- every `do update` below re-states the check, which is what closes the one
  -- race the lock cannot: two writers that both expected 0 and both found no
  -- row. The second one's insert lands on the first one's row, the `where` is
  -- false, nothing is written, and it gets the same conflict.
  --
  -- EXPIRED counts as absent. Every read hides a row whose `expires_at` has
  -- passed, so a caller that read the key saw nothing: its version is 0 here
  -- and in the `where` guards, the same liveness the reads use. The expired
  -- row is still the conflict target (the unique indexes are partial on
  -- `archived_at` only), so the write UPDATES it in place, and its version
  -- CONTINUES counting from the expired row's (+1 on a content change) rather
  -- than restarting at 1: the row keeps its id, created_at and seen_count, so
  -- it is the same record coming back, and restarting would need the bump
  -- trigger to second-guess liveness on every update. A caller therefore
  -- expects 0 and may read back a version above 1.
  --
  -- A write that names no TTL keeps the row's `expires_at`, which here is in
  -- the PAST: the revived record would stay hidden and the nightly purge would
  -- delete it. So when the gate passed on an expired row and the write names no
  -- TTL, the TTL is cleared — what a brand-new insert without a TTL gets (null).
  -- Scoped to writes that pass p_expected_version; a plain write to an expired
  -- key keeps its past `expires_at` as before.
  if p_expected_version is not null then
    if p_expected_version < 0 then
      raise exception using errcode = '22023',
        message = format('expected_version must be >= 0, got %s', p_expected_version);
    end if;
    select case when m.expires_at is not null and m.expires_at <= now() then 0
                else m.version end,
           m.expires_at is not null and m.expires_at <= now()
      into v_current_version, v_was_expired
      from memories m
     where m.scope = p_scope
       and m.key = p_key
       and m.archived_at is null
       and case
             when v_org_id is not null then m.org_id = v_org_id
             when p_user_id is null then m.org_id is null and m.user_id is null
             else m.org_id is null and m.user_id = p_user_id
           end
       for update;
    v_current_version := coalesce(v_current_version, 0);
    if v_current_version <> p_expected_version then
      raise exception using errcode = 'LK003',
        message = format('version_conflict: expected_version=%s current_version=%s',
                         p_expected_version, v_current_version);
    end if;
    if coalesce(v_was_expired, false) and v_ttl_action = 'keep' then
      v_ttl_action := 'clear';
    end if;
  end if;

  -- 00126: a maintenance EDIT. It changes an existing live lesson and is not a
  -- sighting, so `seen_count` is left as stored (a plain write to the same key
  -- is the next sighting and still adds 1). It never creates a row: a key with
  -- no live row (none, archived, or expired, the same liveness every read and
  -- the version gate above use) raises `memory_not_found`. `created_at` is not
  -- touched. A field the edit omits keeps its stored value: tags (sent as NULL),
  -- source_agent, trigger, provenance, kind, host, content_type and supersedes;
  -- attributes merge as on a write. `expected_version` still applies, and the
  -- version trigger still counts a content change.
  if p_edit then
    return query
    update memories as m set
      value         = p_value,
      tags          = coalesce(p_tags, m.tags),
      source_agent  = coalesce(p_source_agent,  m.source_agent),
      trigger       = coalesce(p_trigger,       m.trigger),
      updated_at    = now(),
      updated_by    = coalesce(p_user_id,       m.updated_by),
      origin_repo   = coalesce(p_origin_repo,   m.origin_repo),
      origin_branch = coalesce(p_origin_branch, m.origin_branch),
      origin_commit = coalesce(p_origin_commit, m.origin_commit),
      origin_pr     = coalesce(p_origin_pr,     m.origin_pr),
      kind          = coalesce(p_kind,          m.kind),
      host          = coalesce(p_host,          m.host),
      attributes    = jsonb_strip_nulls(m.attributes || coalesce(p_attributes, '{}'::jsonb)),
      content_type  = coalesce(p_content_type,  m.content_type),
      supersedes    = coalesce(p_supersedes,    m.supersedes),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else m.expires_at
                      end
     where m.scope = p_scope
       and m.key = p_key
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
       and case
             when v_org_id is not null then m.org_id = v_org_id
             when p_user_id is null then m.org_id is null and m.user_id is null
             else m.org_id is null and m.user_id = p_user_id
           end
       and (p_expected_version is null or p_expected_version = m.version)
    returning
      m.id, m.created_at, false as inserted,
      (v_org_id is not null) as org_routed, v_binding_slug as binding_org_slug, m.expires_at,
      m.scope, m.key, m.value, m.tags,
      m.source_agent, m.trigger, m.updated_at, m.archived_at,
      m.origin_repo, m.origin_branch, m.origin_commit, m.origin_pr,
      m.kind, m.host, m.seen_count,
      m.attributes, m.content_type, m.supersedes,
      m.version;
    if not found then
      raise exception using errcode = 'P0002',
        message = format('memory_not_found: scope=%s key=%s', p_scope, p_key);
    end if;
    return;
  end if;

  -- A plain write never stores NULL tags: NULL is the edit's "keep" marker.
  p_tags := coalesce(p_tags, '{}');

  if v_org_id is not null then
    return query
    insert into memories (
      user_id, org_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count,
      attributes, content_type, supersedes
    )
    values (
      null, v_org_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1,
      jsonb_strip_nulls(coalesce(p_attributes, '{}'::jsonb)),
      coalesce(p_content_type, 'text/markdown'), p_supersedes
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
      attributes    = jsonb_strip_nulls(memories.attributes || coalesce(p_attributes, '{}'::jsonb)),
      content_type  = coalesce(p_content_type,         memories.content_type),
      supersedes    = coalesce(p_supersedes,           memories.supersedes),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    where p_expected_version is null  -- 00120: the same expired-is-0 rule as the gate
       or p_expected_version = case when memories.expires_at is not null and memories.expires_at <= now()
                                    then 0 else memories.version end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      true as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count,
      memories.attributes, memories.content_type, memories.supersedes,
      memories.version;  -- 00120

  elsif p_user_id is null then
    return query
    insert into memories (
      user_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count,
      attributes, content_type, supersedes
    )
    values (
      null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      null, null, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1,
      jsonb_strip_nulls(coalesce(p_attributes, '{}'::jsonb)),
      coalesce(p_content_type, 'text/markdown'), p_supersedes
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
      attributes    = jsonb_strip_nulls(memories.attributes || coalesce(p_attributes, '{}'::jsonb)),
      content_type  = coalesce(p_content_type,         memories.content_type),
      supersedes    = coalesce(p_supersedes,           memories.supersedes),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    where p_expected_version is null  -- 00120: the same expired-is-0 rule as the gate
       or p_expected_version = case when memories.expires_at is not null and memories.expires_at <= now()
                                    then 0 else memories.version end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count,
      memories.attributes, memories.content_type, memories.supersedes,
      memories.version;  -- 00120

  else
    return query
    insert into memories (
      user_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by, expires_at,
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host, seen_count,
      attributes, content_type, supersedes
    )
    values (
      p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host, 1,
      jsonb_strip_nulls(coalesce(p_attributes, '{}'::jsonb)),
      coalesce(p_content_type, 'text/markdown'), p_supersedes
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
      attributes    = jsonb_strip_nulls(memories.attributes || coalesce(p_attributes, '{}'::jsonb)),
      content_type  = coalesce(p_content_type,         memories.content_type),
      supersedes    = coalesce(p_supersedes,           memories.supersedes),
      expires_at    = case v_ttl_action
                        when 'clear' then null
                        when 'set'   then v_expires_at
                        else memories.expires_at
                      end
    where p_expected_version is null  -- 00120: the same expired-is-0 rule as the gate
       or p_expected_version = case when memories.expires_at is not null and memories.expires_at <= now()
                                    then 0 else memories.version end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at,
      memories.scope, memories.key, memories.value, memories.tags,
      memories.source_agent, memories.trigger, memories.updated_at, memories.archived_at,
      memories.origin_repo, memories.origin_branch, memories.origin_commit, memories.origin_pr,
      memories.kind, memories.host, memories.seen_count,
      memories.attributes, memories.content_type, memories.supersedes,
      memories.version;  -- 00120
  end if;

  -- 00120: the `do update ... where` above declined the write (a concurrent
  -- writer moved the version after the gate, or created the row a 0 expected
  -- to be absent). Nothing was written; report the version that won.
  if p_expected_version is not null and not found then
    select case when m.expires_at is not null and m.expires_at <= now() then 0
                else m.version end
      into v_current_version
      from memories m
     where m.scope = p_scope
       and m.key = p_key
       and m.archived_at is null
       and case
             when v_org_id is not null then m.org_id = v_org_id
             when p_user_id is null then m.org_id is null and m.user_id is null
             else m.org_id is null and m.user_id = p_user_id
           end;
    raise exception using errcode = 'LK003',
      message = format('version_conflict: expected_version=%s current_version=%s',
                       p_expected_version, coalesce(v_current_version, 0));
  end if;
end;
$$;


revoke execute on function memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text,
  jsonb, text, uuid, text[], text, uuid[], integer, boolean
) from public;
-- anon keeps 00119's grant: the body refuses it with LK002 not_authenticated.
grant execute on function memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text,
  jsonb, text, uuid, text[], text, uuid[], integer, boolean
) to anon, authenticated, service_role;
