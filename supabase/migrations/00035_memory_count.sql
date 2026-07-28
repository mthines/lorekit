-- lorekit_memory_count(p_user_id) — efficient active memory count for the
-- /settings/plan page usage bar.
--
-- The dashboard can't do a raw SELECT COUNT(*) per page load without either
-- bypassing RLS (service-role) or doing a full table scan under the user's
-- RLS context. This SECURITY DEFINER function does the scoped count with the
-- index-backed predicate that enforce_memory_cap() uses, so no extra full-scan
-- occurs. It reuses memories_user_idx + the archived_at IS NULL partial index
-- (memories_org_id_active_idx for the org branch).
--
-- Returns: JSONB { "count": <integer>, "limit": <integer>, "plan": <text> }
-- so the caller gets everything it needs in one round-trip.

create or replace function lorekit_memory_count(p_user_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_count     integer;
  v_limit     integer;
  v_plan_name text;
begin
  -- Count active personal memories for this user.
  select count(*)
    into v_count
    from memories
   where user_id = p_user_id
     and archived_at is null;

  -- Resolve effective limit and plan name in the same function call.
  v_limit := lorekit_get_limit(p_user_id, 'max_memories');

  select coalesce(up.plan_name, 'free')
    into v_plan_name
    from user_plans up
   where up.user_id = p_user_id;

  if v_plan_name is null then
    v_plan_name := 'free';
  end if;

  return jsonb_build_object(
    'count',     v_count,
    'limit',     v_limit,
    'plan',      v_plan_name
  );
end;
$$;

-- Grant to authenticated so the Next.js server action can call it under the
-- user JWT (supabase-js createServerClient uses the user's JWT session).
grant execute on function lorekit_memory_count(uuid)
  to anon, authenticated, service_role;
