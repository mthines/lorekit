-- Fix memory count consistency (bug fix).
--
-- Root cause: lorekit_memory_count (00035) only counted personal memories
-- (WHERE user_id = p_user_id AND archived_at IS NULL), while the dashboard
-- query fetched all memories visible under RLS — including org-owned rows
-- (user_id IS NULL, org_id set) and archived rows. The two numbers diverged
-- for any user who (a) belongs to an org or (b) has archived memories.
--
-- Correct definition: active (archived_at IS NULL), non-expired memories that
-- the user owns personally OR through org membership. This matches what the
-- dashboard should show and what the enforcement cap cares about (the cap is
-- per-personal-user or per-org, not a combined total, but the displayed count
-- should reflect what the user sees).
--
-- The dashboard-side fix (filter archived rows, add org memberships to the
-- count) lives in the Next.js query layer — no migration needed there.
--
-- This migration drops and recreates lorekit_memory_count with:
--   * personal count: user_id = p_user_id AND archived_at IS NULL
--   * org count: org_id IN (lorekit_member_org_ids(p_user_id)) AND archived_at IS NULL
--   * total: personal + org (what the user sees in the dashboard)
-- Both personal and org counts are returned so the UI can decide what to show.

create or replace function lorekit_memory_count(p_user_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_personal_count integer;
  v_org_count      integer;
  v_limit          integer;
  v_plan_name      text;
  v_org_ids        uuid[];
begin
  -- Resolve org memberships once.
  select array_agg(org_id)
    into v_org_ids
    from org_members om
    join orgs o on o.id = om.org_id
   where om.user_id = p_user_id
     and o.deleted_at is null;

  -- Personal active memories.
  select count(*)
    into v_personal_count
    from memories
   where user_id = p_user_id
     and archived_at is null;

  -- Org-owned active memories across all orgs the user belongs to.
  if v_org_ids is not null and cardinality(v_org_ids) > 0 then
    select count(*)
      into v_org_count
      from memories
     where org_id = any(v_org_ids)
       and archived_at is null;
  else
    v_org_count := 0;
  end if;

  -- Resolve effective personal limit and plan name.
  v_limit := lorekit_get_limit(p_user_id, 'max_memories');

  select coalesce(up.plan_name, 'free')
    into v_plan_name
    from user_plans up
   where up.user_id = p_user_id;

  if v_plan_name is null then
    v_plan_name := 'free';
  end if;

  return jsonb_build_object(
    'count',          v_personal_count + v_org_count,
    'personal_count', v_personal_count,
    'org_count',      v_org_count,
    'limit',          v_limit,
    'plan',           v_plan_name
  );
end;
$$;

grant execute on function lorekit_memory_count(uuid)
  to anon, authenticated, service_role;
