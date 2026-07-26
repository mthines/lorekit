-- memory_write gains org-owned writes: a trailing p_org_slug selector, author
-- attribution, and an authorization-gated org branch.
--
-- org_id is authorization-derived INSIDE the RPC, never trusted from the
-- caller (R1/R7): when p_org_slug is supplied, this resolves the slug to an
-- org_id and requires lorekit_org_can(p_user_id, org_id, 'write') — a
-- non-member or a viewer raises SQLSTATE 'LK002' (a distinct signal from the
-- memory-cap LK001) and writes no row. A caller passing any slug it is not a
-- write-capable member of is rejected regardless of what it claims.
--
-- An unresolvable slug raises a distinct 'unknown_org' error (not LK002) so
-- the caller can tell "no such org" from "not permitted" (see plan.md Edge
-- Cases).
--
-- Author attribution: every branch now sets created_by/updated_by = the
-- writer (null for the service branch, since it has no writer identity). On
-- an org upsert-clobber, created_by/created_at are preserved (matching the
-- existing personal-clobber created_at semantics) while updated_by/updated_at
-- advance to the clobbering writer.
--
-- Adding a trailing parameter changes the function signature, so
-- CREATE OR REPLACE alone would leave the old 8-arg overload behind and make
-- PostgREST calls ambiguous — drop the old signature first (same shape as
-- 00009/00011). Forward-only.

drop function if exists memory_write(uuid, text, text, text, text[], text, text, timestamptz);

create or replace function memory_write(
  p_user_id      uuid,
  p_scope        text,
  p_key          text,
  p_value        text,
  p_tags         text[]      default '{}',
  p_source_agent text        default null,
  p_trigger      text        default null,
  p_created_at   timestamptz default null,
  p_org_slug     text        default null
)
returns table (id uuid, created_at timestamptz, inserted boolean)
language plpgsql
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if p_org_slug is not null then
    -- Qualify orgs.id explicitly: the RETURNS TABLE's `id` output column
    -- would otherwise make a bare `select id` ambiguous inside this function.
    select o.id into v_org_id from orgs o where o.slug = p_org_slug;
    if v_org_id is null then
      raise exception using
        errcode = 'P0001',
        message = format('unknown_org: %s', p_org_slug);
    end if;

    if not lorekit_org_can(p_user_id, v_org_id, 'write') then
      raise exception using
        errcode = 'LK002',
        message = format('org_permission_denied: org=%s', p_org_slug);
    end if;

    -- Org-owned write: (org_id, scope, key) partial index for
    -- org_id IS NOT NULL. user_id stays NULL so the row is never counted
    -- against the writer's personal cap or personal RLS partition (R3/R9);
    -- created_by/updated_by record the writer instead.
    return query
    insert into memories (
      user_id, org_id, scope, key, value, tags, source_agent, trigger,
      created_at, updated_at, created_by, updated_by
    )
    values (
      null, v_org_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
      coalesce(p_created_at, now()), coalesce(p_created_at, now()), p_user_id, p_user_id
    )
    on conflict (org_id, scope, key) where org_id is not null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now(),
      updated_by   = p_user_id
      -- created_by/created_at are NOT in this SET list: they are preserved
      -- from the original row on clobber, matching the existing
      -- created_at-preservation semantics (00009).
    returning memories.id, memories.created_at, (xmax::text = '0') as inserted;

  elsif p_user_id is null then
    -- service-role / CI writes: (scope, key) partial index for
    -- org_id IS NULL AND user_id IS NULL. No writer identity to attribute.
    return query
    insert into memories (user_id, scope, key, value, tags, source_agent, trigger, created_at, updated_at, created_by, updated_by)
    values (null, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
            coalesce(p_created_at, now()), coalesce(p_created_at, now()), null, null)
    on conflict (scope, key) where org_id is null and user_id is null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now()
    returning memories.id, memories.created_at, (xmax::text = '0') as inserted;
  else
    -- user-scoped writes (api_key / user): (user_id, scope, key) partial
    -- index for org_id IS NULL AND user_id IS NOT NULL.
    return query
    insert into memories (user_id, scope, key, value, tags, source_agent, trigger, created_at, updated_at, created_by, updated_by)
    values (p_user_id, p_scope, p_key, p_value, p_tags, p_source_agent, p_trigger,
            coalesce(p_created_at, now()), coalesce(p_created_at, now()), p_user_id, p_user_id)
    on conflict (user_id, scope, key) where org_id is null and user_id is not null and archived_at is null
    do update set
      value        = excluded.value,
      tags         = excluded.tags,
      source_agent = excluded.source_agent,
      trigger      = excluded.trigger,
      updated_at   = now(),
      updated_by   = p_user_id
    returning memories.id, memories.created_at, (xmax::text = '0') as inserted;
  end if;
end;
$$;

grant execute on function memory_write(uuid, text, text, text, text[], text, text, timestamptz, text)
  to anon, authenticated, service_role;
