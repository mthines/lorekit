-- ═════════════════════════════════════════════════════════════════════════
-- Perf: memory_write returns the full display row, so POST /memories no
-- longer needs a trailing SELECT to shape the response body.
--
-- Telemetry (docs/otel.md → server-side load-test attribution): every
-- POST /memories paid a SECOND edge→PostgREST round trip — a
-- `.from('memories').select(...).eq('id', row.id).single()` right after the
-- RPC returned — for the sole purpose of re-reading the row `memory_write`
-- had just inserted or updated, so the response body could match
-- `MemoryEntrySchema`. That hop measured ~206ms server-side wait despite the
-- underlying SQL taking single-digit milliseconds (`pg_stat_statements`) —
-- the edge→PostgREST hop cost, not the query, per CLAUDE.md's "central fact".
--
-- Every column `handlers/create.ts` re-fetched is already available inside
-- `memory_write`'s own INSERT/UPDATE — it is the same row, in the same
-- statement, before the round trip even starts. Returning them directly
-- removes the extra hop instead of re-deriving anything.
--
-- `org` (the joined org name/slug) is deliberately NOT added here: the
-- existing follow-up SELECT never requested it either (its literal column
-- list omits `org_id`/`orgs(...)`), so this migration is a strict return-set
-- superset of what the handler already read from the second query, not a new
-- widening of the write response's public contract.
-- ═════════════════════════════════════════════════════════════════════════

drop function if exists memory_write(
  uuid, text, text, text, text[], text, text, timestamptz, text,
  integer, boolean, text, text, text, integer, text, text, text[], text, uuid[]
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
  -- Everything else `handlers/create.ts`'s trailing SELECT used to fetch,
  -- straight off the row the INSERT/UPDATE already touched.
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
-- The new RETURNS TABLE columns (scope, key, value, tags, source_agent,
-- trigger, updated_at, archived_at, origin_*, kind, host, seen_count) are also
-- plpgsql OUT variables, and `scope`/`key` collide with the bare column names
-- used in the `on conflict (…, scope, key)` arbiter lists below — Postgres
-- parses an arbiter list as a general expression context, unlike an INSERT
-- column list or an UPDATE SET target, so it raises "column reference ...
-- is ambiguous" there without this. Every other reference in the body is
-- table-qualified already; this directive (the same one 00039/00043/00050/…
-- use for exactly this OUT-column shape) makes the column win regardless, so
-- the body can never be mis-resolved against the OUT variables.
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
    select b.org_id, o.slug into v_binding_org, v_binding_slug
    from org_scope_bindings b
    join orgs o on o.id = b.org_id
    where b.scope = p_scope and o.deleted_at is null;

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
