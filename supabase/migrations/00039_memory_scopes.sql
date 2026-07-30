-- lorekit_memory_scopes(p_user_id) — distinct visible scopes with their
-- active memory counts, for GET /memories/scopes (the REST equivalent of the
-- CLI's `listScopes()`, which returns an "unsupported" sentinel today).
--
-- Why an RPC and not a client-side dedupe: the obvious implementation is
-- `select scope from memories` followed by a Set() in TypeScript — which is
-- what packages/web/src/lib/queries/lore.ts does. That is silently wrong past
-- PostgREST's default row cap (db-max-rows): the query returns the first N
-- rows and the caller dedupes those, so a user with more memories than the cap
-- loses whole scopes with no error and no truncation signal. Aggregating in
-- Postgres is exact regardless of row count and returns one row per scope.
--
-- Visibility reuses lorekit_member_org_ids(p_user_id) — the SINGLE
-- tenant-visibility predicate source (00014_orgs.sql) — composed exactly as
-- the memories RLS read policies do (00015_memories_org_fk.sql):
--   user_id = <caller> OR org_id IN (select lorekit_member_org_ids(<caller>))
-- No hand-rolled membership check here; a soft-deleted org drops out of
-- lorekit_member_org_ids (00025) and therefore out of this result too.
--
-- The count matches what GET /memories returns by default
-- (supabase/functions/memories/handlers/list.ts): non-archived AND
-- non-expired. Archived rows are reachable via `?archived=true` and are
-- deliberately excluded from this count rather than split into a second
-- column — the endpoint answers "what can I list right now".
--
-- SECURITY DEFINER + STABLE, mirroring lorekit_memory_count (00035/00036):
-- read-only, keyed off an explicit p_user_id rather than a client-asserted
-- claim, so the api_key edge path (service-role, RLS-bypass) and the JWT path
-- get identical semantics.
--
-- The `p_user_id is null and auth.role() = 'service_role'` branch is the
-- service-role (CI) escape hatch, matching how every other read path treats
-- that credential — GET /memories applies no tenant filter for it. It is safe
-- because `auth.role()` reads the VERIFIED JWT role claim PostgREST sets, not
-- request input: an `authenticated` caller passing p_user_id => null gets
-- nothing back (user_id = null is NULL, and lorekit_member_org_ids(null) is
-- empty), so the function fails closed. Same predicate `rls_insert` (00001)
-- uses to recognise service-role.

-- plpgsql rather than a plain SQL body (unlike lorekit_member_org_ids) for one
-- specific reason: the caller contract includes the ORDER BY. A single-statement
-- SQL function is a candidate for inlining, and an inlined set-returning
-- function's internal ordering is not guaranteed to survive into the outer plan.
-- A plpgsql RETURN QUERY is never inlined, so `order by scope asc` is part of
-- the result rather than an accident of the planner. Same language choice as
-- lorekit_memory_count (00035/00036).
create or replace function lorekit_memory_scopes(p_user_id uuid)
returns table (scope text, count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
-- The RETURNS TABLE columns (scope, count) are also plpgsql OUT variables, so an
-- unqualified reference to either inside the query would be ambiguous. Every
-- reference below is table-qualified, and this directive makes the column win
-- regardless, so the body can never be mis-resolved against the OUT variables.
#variable_conflict use_column
begin
  return query
    select m.scope, count(*) as count
      from memories m
     where (
             (p_user_id is null and auth.role() = 'service_role')
             or m.user_id = p_user_id
             or m.org_id in (select lorekit_member_org_ids(p_user_id))
           )
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
     group by m.scope
     order by m.scope asc;
end;
$$;

-- NOT granted to `anon`, for the same reason lorekit_member_org_ids is not
-- (00014): the function takes a bare p_user_id, so an unauthenticated caller
-- with EXECUTE could enumerate any user's scope names — and scope names are
-- themselves sensitive (they embed repo and project names) — via a PostgREST
-- RPC call. `authenticated` is safe because the edge functions resolve
-- p_user_id from the verified credential, never from request input.
grant execute on function lorekit_memory_scopes(uuid) to authenticated, service_role;
