-- ═════════════════════════════════════════════════════════════════════════
-- Extend memory_write TTL to support seconds and minutes in addition to days.
--
-- Previously the RPC accepted p_ttl_days (integer days) and computed
-- expires_at = now() + p_ttl_days * INTERVAL '1 day'.
--
-- This migration replaces p_ttl_days with p_ttl_seconds (integer seconds)
-- so callers can set fine-grained expiry (e.g. 30 s, 5 min) without
-- being forced to round up to a whole day.
--
-- The application layer (mcp-core and the Deno edge function) normalises
-- all three user-visible units (ttl_days, ttl_minutes, ttl_seconds) to
-- seconds via parseTtl() before calling the RPC, so the DB only ever
-- receives an integer number of seconds.
--
-- Design:
--   p_ttl_seconds: when provided (>= 1), sets
--     expires_at = now() + p_ttl_seconds * INTERVAL '1 second'
--   On INSERT:  expires_at is computed from p_ttl_seconds (or NULL if omitted).
--   On UPDATE:  expires_at is refreshed ONLY when p_ttl_seconds is not null —
--               omitting it on an update leaves the existing expiry unchanged.
--   p_clear_ttl still wins over p_ttl_seconds when both are supplied.
--   Validation: p_ttl_seconds must be between 1 and 31 536 000 (365 days).
-- ═════════════════════════════════════════════════════════════════════════

drop function if exists memory_write(uuid, text, text, text, text[], text, text, timestamptz, text, integer, boolean);

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
  p_ttl_seconds  integer     default null,
  p_clear_ttl    boolean     default false
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
  -- Tri-state for the expires_at UPDATE branch:
  --   'clear'  → set to NULL
  --   'set'    → set to v_expires_at
  --   'keep'   → leave unchanged (CASE WHEN ... ELSE memories.expires_at END)
  v_ttl_action   text := 'keep';
begin
  if p_clear_ttl then
    -- Explicit clear wins over any p_ttl_seconds value.
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
      expires_at   = case v_ttl_action
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
      expires_at   = case v_ttl_action
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

grant execute on function memory_write(uuid, text, text, text, text[], text, text, timestamptz, text, integer, boolean)
  to anon, authenticated, service_role;
