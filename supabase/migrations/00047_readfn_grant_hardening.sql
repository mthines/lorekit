-- ═════════════════════════════════════════════════════════════════════════
-- Read-function grant hardening — the "clearly-safe" half of the deferred
-- security-review sweep (docs/tasks/security-review-deferred-findings.md).
--
-- Same root cause as 00046: PostgreSQL grants EXECUTE to PUBLIC by default, and
-- only 00041/00046 ever revoked it — so a set of SECURITY DEFINER functions
-- that take a bare `p_user_id` (or are service-role-only) stayed anon-reachable
-- over PostgREST, leaking other users' data or letting anon call service-only
-- procedures. This migration closes the CLEARLY-SAFE subset:
--
--   * lorekit_memory_scopes / lorekit_memory_count — edge-called reads that
--     trust p_user_id → get the 00046/00041 actor guard (honour p_user_id only
--     under a verified service-role connection, else auth.uid()) AND lose the
--     PUBLIC/anon grant, closing both the anon and the authenticated cross-user
--     read.
--   * lorekit_find_user_by_github_id + the three installation RPCs +
--     lorekit_purge_old_usage_events + lorekit_purge_all_expired_memories —
--     service-role / webhook / cron only → simply lose PUBLIC EXECUTE.
--
-- DELIBERATELY OUT OF SCOPE (left for a separate, carefully-tested pass):
-- functions embedded in RLS policies or the insert/rate-limit hot path
-- (lorekit_member_org_ids, lorekit_org_role/_can, lorekit_check_rate_limit,
-- lorekit_purge_rate_limit_counters, lorekit_get_limit/_org_limit/default_limit,
-- lorekit_record_usage_event) — a wrong grant/actor change there is a
-- production-availability incident. See the findings doc, "[rls/hot-path]".
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. lorekit_memory_scopes — actor guard (preserves the CI escape hatch) ──
create or replace function lorekit_memory_scopes(p_user_id uuid)
returns table (scope text, count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  -- Honour a caller-supplied p_user_id only on a verified service-role
  -- connection (the edge resolves the token owner and passes it); an
  -- authenticated caller is pinned to its own auth.uid(), closing the
  -- cross-user scope-name enumeration. A NULL actor under service-role is the
  -- CI escape hatch, preserved by the first visibility branch below.
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
begin
  return query
    select m.scope, count(*) as count
      from memories m
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
     group by m.scope
     order by m.scope asc;
end;
$$;

revoke execute on function lorekit_memory_scopes(uuid) from public, anon;
grant  execute on function lorekit_memory_scopes(uuid) to authenticated, service_role;

comment on function lorekit_memory_scopes(uuid) is
  'Per-scope active counts visible to the EFFECTIVE caller. Actor resolved by
   the 00046/00041 service-role-gated rule: a caller-supplied p_user_id is
   honoured only on a verified service-role connection, otherwise auth.uid()
   wins — so an authenticated caller can never enumerate another user''s scope
   names. p_user_id IS NULL under service-role is the CI escape hatch.';

-- ── 2. lorekit_memory_count — actor guard ───────────────────────────────────
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
  v_actor          uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
begin
  -- Resolve org memberships once (for the resolved actor).
  select array_agg(org_id)
    into v_org_ids
    from org_members om
    join orgs o on o.id = om.org_id
   where om.user_id = v_actor
     and o.deleted_at is null;

  -- Personal active memories.
  select count(*)
    into v_personal_count
    from memories
   where user_id = v_actor
     and archived_at is null;

  -- Org-owned active memories across all orgs the actor belongs to.
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
  v_limit := lorekit_get_limit(v_actor, 'max_memories');

  select coalesce(up.plan_name, 'free')
    into v_plan_name
    from user_plans up
   where up.user_id = v_actor;

  if v_plan_name is null then
    v_plan_name := 'free';
  end if;

  return jsonb_build_object(
    'count',          coalesce(v_personal_count, 0) + coalesce(v_org_count, 0),
    'personal_count', coalesce(v_personal_count, 0),
    'org_count',      v_org_count,
    'limit',          v_limit,
    'plan',           v_plan_name
  );
end;
$$;

revoke execute on function lorekit_memory_count(uuid) from public, anon;
grant  execute on function lorekit_memory_count(uuid) to authenticated, service_role;

comment on function lorekit_memory_count(uuid) is
  'Personal + org memory counts, limit and plan for the EFFECTIVE caller. Same
   service-role-gated actor rule as lorekit_memory_scopes (00047) — an
   authenticated caller cannot read another user''s counts or plan tier.';

-- ── 3. Service-role / webhook / cron-only functions — drop PUBLIC EXECUTE ────
-- These take no p_user_id (or are procedures the app never calls as a normal
-- user), so no actor guard applies; they should simply not be anon-reachable.
-- They were granted `to service_role` only, but the default PUBLIC grant was
-- never revoked. `find_user_by_github_id` also loses authenticated (it maps a
-- GitHub id to an internal user UUID — a deanonymisation oracle).
revoke execute on function lorekit_find_user_by_github_id(text)                                   from public, anon, authenticated;
revoke execute on function lorekit_installation_upsert(bigint, bigint, text, text, uuid, text, text[]) from public, anon, authenticated;
revoke execute on function lorekit_installation_remove_repos(bigint, text[])                       from public, anon, authenticated;
revoke execute on function lorekit_installation_remove(bigint)                                     from public, anon, authenticated;
revoke execute on function lorekit_purge_old_usage_events(interval)                                from public, anon, authenticated;
revoke execute on function lorekit_purge_all_expired_memories()                                    from public, anon, authenticated;
