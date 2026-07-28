-- ═════════════════════════════════════════════════════════════════════════
-- Memory TTL (time-to-live) — per-row auto-expiry for transient memories.
--
-- Adds an optional `expires_at` column to the memories table. When set, the
-- row is treated as invisible by all active-memory read paths once the
-- timestamp passes, without requiring the caller to manually archive or
-- delete it. Expired rows are physically removed by the new
-- `purge_expired_memories` RPC (called by the MCP `memory.purge` tool or a
-- scheduled job) — the existing `purge_archived_memories` RPC is unchanged.
--
-- Design choices:
--   • `expires_at` is nullable — omitting it means the memory lives forever
--     (current default behaviour, fully backward-compatible).
--   • The active-read filter is extended to:
--       archived_at IS NULL AND (expires_at IS NULL OR expires_at > now())
--     NOTE: The RLS policies on the memories table perform the archived_at
--     check. The expires_at check is applied at the query layer (toolRead,
--     toolList, toolSearch, etc.) via an additional .or() filter, keeping
--     the RLS policies lean (they cannot call now() cheaply in a policy).
--   • Expired rows remain physically present until purged so the sweep is a
--     cheap index scan, not a table scan, and no data is silently lost.
--   • On UPDATE (upsert conflict): p_ttl_days IS NOT NULL → refreshes
--     expires_at; p_ttl_days IS NULL → leaves existing expires_at unchanged
--     so a value-only update never accidentally clears an existing TTL.
-- ═════════════════════════════════════════════════════════════════════════

-- 1. Add the expiry column (nullable, no default → backward-compatible).
alter table memories
  add column if not exists expires_at timestamptz;

-- 2. Partial index for fast expiry sweeps (only non-null expires_at rows).
create index if not exists memories_expires_at_idx
  on memories (expires_at)
  where expires_at is not null;

-- 3. Recreate memory_write with an optional p_ttl_days parameter.
--
--    p_ttl_days: when provided (>= 1), sets expires_at = now() + p_ttl_days * INTERVAL '1 day'.
--    On INSERT:  expires_at is computed from p_ttl_days (or left NULL if omitted).
--    On UPDATE:  expires_at is refreshed ONLY when p_ttl_days is not null —
--                omitting it on an update leaves the existing expiry unchanged.
--    The return type grows an additive `expires_at` column so callers can
--    surface the computed expiry. Changing RETURNS TABLE shape requires DROP first.
drop function if exists memory_write(uuid, text, text, text, text[], text, text, timestamptz, text);

create or replace function memory_write(
  p_user_id      uuid,
  p_scope        text,
  p_key          text,
  p_value        text,
  p_tags         text[]      default '{}',
  p_source_agent text        default null,
  p_trigger      text        default null,
  p_created_at   timestamptz default null,
  p_org_slug     text        default null,
  p_ttl_days     integer     default null
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
begin
  -- Validate TTL: must be a positive integer when supplied.
  if p_ttl_days is not null then
    if p_ttl_days < 1 or p_ttl_days > 365 then
      raise exception using errcode = 'P0001',
        message = format('ttl_days must be between 1 and 365, got %s', p_ttl_days);
    end if;
    v_expires_at := now() + (p_ttl_days * interval '1 day');
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
      created_at, updated_at, created_by, updated_by, expires_at
    )
    values (
      null, v_org_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()),
      p_user_id, p_user_id, v_expires_at
    )
    on conflict (org_id, scope, key) where org_id is not null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now(),
      updated_by   = p_user_id,
      expires_at   = case when p_ttl_days is not null then v_expires_at else memories.expires_at end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      true as org_routed, v_binding_slug as binding_org_slug, memories.expires_at;

  elsif p_user_id is null then
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
      expires_at   = case when p_ttl_days is not null then v_expires_at else memories.expires_at end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at;

  else
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
      expires_at   = case when p_ttl_days is not null then v_expires_at else memories.expires_at end
    returning
      memories.id, memories.created_at, (xmax::text = '0') as inserted,
      false as org_routed, v_binding_slug as binding_org_slug, memories.expires_at;
  end if;
end;
$$;

grant execute on function memory_write(uuid, text, text, text, text[], text, text, timestamptz, text, integer)
  to anon, authenticated, service_role;

-- 4. New purge_expired_memories RPC — hard-deletes active rows whose
--    expires_at is in the past. Separate from purge_archived_memories so
--    each sweep is independently callable and narrowly indexed.
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
     and archived_at is null   -- archived rows stay with purge_archived_memories
  ;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Intentionally excludes anon: an unauthenticated caller could supply any
-- p_user_id and hard-delete another user's expired rows (no auth.uid() check
-- inside the function body). Authenticated + service_role are sufficient.
grant execute on function purge_expired_memories(uuid) to authenticated, service_role;

comment on column memories.expires_at is
  'Optional timestamp after which the row is treated as invisible by active-read
   paths. NULL means the row never expires. Physically deleted by
   purge_expired_memories() or the MCP memory.purge tool.';
