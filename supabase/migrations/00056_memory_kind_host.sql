-- ═════════════════════════════════════════════════════════════════════════
-- memories.kind + memories.host — the bucket TAXONOMY as first-class columns,
-- and the same two dimensions on usage_events so operations are attributable
-- to a family and an owner.
--
-- WHY: a loop's memory bucket has always encoded two facts in its tag string —
-- WHAT KIND of memory it is (a procedural `lesson`, a transient outcome `bus`,
-- or a durable per-repo `signal`) and WHICH HOST owns it (`reviewer`, `aw`, …).
-- Reading either meant parsing `loop::<host>-lessons` on the client. Promoting
-- them to columns lets a caller filter (`?kind=lesson`), lets usage analytics
-- group by kind/host, and lets the dashboard show the three families instead of
-- implying them. The authoritative vocabulary lives in agent-skills'
-- `agents/shared/rules/memory-buckets.md`.
--
-- kind is a closed 3-value vocabulary; host is open (a new host is a new agent,
-- not a migration). Following 00054's `client` precedent, neither is pinned by a
-- CHECK enumerating members — the Zod `MemoryWriteSchema` is the authoritative
-- gate for kind, and a length backstop bounds cardinality/storage without
-- turning "add a host" into a migration.
--
-- Forward-only and additive: both columns are nullable, and each RPC is DROPped
-- and recreated with its new params appended-and-defaulted, so every existing
-- row and every caller that omits them is unaffected. A memory written before
-- this migration has NULL kind/host; the app derives them from the legacy tag
-- (see tags.ts `inferKindHost`) so no data backfill is required.
-- ═════════════════════════════════════════════════════════════════════════

-- ── columns on memories ──────────────────────────────────────────────────────
alter table memories add column if not exists kind text;
alter table memories add column if not exists host text;

-- Length backstops (not the primary gate — see 00054). kind's closed vocabulary
-- is enforced by MemoryWriteSchema; host is open free-text like source_agent.
alter table memories drop constraint if exists memories_kind_len;
alter table memories add constraint memories_kind_len
  check (kind is null or (char_length(kind) between 1 and 32));
alter table memories drop constraint if exists memories_host_len;
alter table memories add constraint memories_host_len
  check (host is null or (char_length(host) between 1 and 64));

-- Index the family/owner read: "lessons for host reviewer", newest first.
create index if not exists memories_kind_host_idx
  on memories (kind, host)
  where kind is not null;

-- ── writer: memory_write gains p_kind + p_host ──────────────────────────────
-- DROP first (not CREATE OR REPLACE): adding params changes the signature, and a
-- bare CREATE would leave the 00048 15-arg overload behind and make calls
-- ambiguous. Body is 00048's verbatim plus the two columns in every branch.
-- kind/host use the origin_* "last KNOWN value wins" merge on update so a write
-- that does not know them (an older client) keeps the previously recorded value
-- rather than erasing it.
drop function if exists memory_write(uuid, text, text, text, text[], text, text, timestamptz, text, integer, boolean, text, text, text, integer);

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
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host
    )
    values (
      null, v_org_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host
    )
    on conflict (org_id, scope, key) where org_id is not null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
      updated_by    = p_user_id,
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
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host
    )
    values (
      null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      null, null, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host
    )
    on conflict (scope, key) where org_id is null and user_id is null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
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
      origin_repo, origin_branch, origin_commit, origin_pr, kind, host
    )
    values (
      p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at,
      p_origin_repo, p_origin_branch, p_origin_commit, p_origin_pr, p_kind, p_host
    )
    on conflict (user_id, scope, key) where org_id is null and user_id is not null and archived_at is null
    do update set
      value         = excluded.value,
      tags          = excluded.tags,
      source_agent  = excluded.source_agent,
      trigger       = excluded.trigger,
      updated_at    = now(),
      updated_by    = p_user_id,
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

-- ── usage_events: kind + host as tracked dimensions ─────────────────────────
alter table usage_events add column if not exists kind text;
alter table usage_events add column if not exists host text;

alter table usage_events drop constraint if exists usage_events_kind_len;
alter table usage_events add constraint usage_events_kind_len
  check (kind is null or (char_length(kind) between 1 and 32));
alter table usage_events drop constraint if exists usage_events_host_len;
alter table usage_events add constraint usage_events_host_len
  check (host is null or (char_length(host) between 1 and 64));

-- Index the family/owner analytics roll-up: "my events for kind X", newest first.
create index if not exists usage_events_user_kind_idx
  on usage_events (user_id, kind, created_at desc)
  where kind is not null;

-- ── writer: record_usage_event gains p_kind + p_host ────────────────────────
-- DROP first — adding params changes the signature (00054's 12-arg overload
-- would otherwise remain and make calls ambiguous). Body is 00054's verbatim
-- plus the two columns.
drop function if exists lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text, text);

create or replace function lorekit_record_usage_event(
  p_user_id        uuid    default null,
  p_org_id         uuid    default null,
  p_plan_name      text    default null,
  p_tool_name      text    default null,
  p_scope_type     text    default null,
  p_auth_type      text    default null,
  p_outcome        text    default null,
  p_duration_ms    integer default null,
  p_memory_count   integer default null,
  p_result_count   integer default null,
  p_correlation_id text    default null,
  p_client         text    default null,
  p_kind           text    default null,
  p_host           text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into usage_events (
    user_id, org_id, plan_name,
    tool_name, scope_type, auth_type,
    outcome, duration_ms, memory_count,
    result_count, correlation_id, client, kind, host
  ) values (
    p_user_id, p_org_id, p_plan_name,
    p_tool_name, p_scope_type, p_auth_type,
    p_outcome, p_duration_ms, p_memory_count,
    p_result_count, p_correlation_id, p_client, p_kind, p_host
  )
  returning id into v_id;
  return v_id;
exception
  when others then
    -- Never let telemetry writes break the primary operation.
    return null;
end;
$$;

grant execute on function lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text, text, text, text)
  to anon, authenticated, service_role;
