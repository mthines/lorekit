-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_scopes — add `last_activity` to the per-scope rollup.
--
-- WHY: the dashboard's Scope Health cards show, per scope, a total and "last
-- activity". Both were derived client-side from a `select scope, created_at
-- ... limit 1000` in packages/web/src/lib/queries/dashboard.ts — the exact
-- shape 00039 exists to replace. That query is silently wrong twice over: past
-- the row cap it drops whole scopes (00039's rationale) and, because the cap
-- is applied to `created_at desc` rows, it also understates the total for
-- every scope that survives.
--
-- Returning max(created_at) alongside the count makes the endpoint answer the
-- whole question exactly, at any volume, in one round trip. It is the same
-- grouped scan — `max()` over a column already being read — so there is no new
-- cost.
--
-- Forward-only: the return type changes, so the function must be DROPped
-- first (`create or replace` cannot add a column to a RETURNS TABLE). Callers
-- that select `scope`/`count` are unaffected; the new column is additive and
-- the CLI's RemoteStore.listScopes() ignores unknown fields.
--
-- Everything else is carried over verbatim from 00047: the service-role-gated
-- actor guard, the visibility predicate composed from lorekit_member_org_ids,
-- the active-rows-only definition (non-archived AND non-expired), the
-- `order by scope asc` contract, plpgsql-not-SQL so that ordering survives, and
-- the revoked PUBLIC/anon grant.
-- ═════════════════════════════════════════════════════════════════════════

drop function if exists lorekit_memory_scopes(uuid);

create function lorekit_memory_scopes(p_user_id uuid)
returns table (scope text, count bigint, last_activity timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
-- The RETURNS TABLE columns are also plpgsql OUT variables, so an unqualified
-- reference to any of them inside the query would be ambiguous. Every reference
-- below is table-qualified, and this directive makes the column win regardless.
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
    select m.scope, count(*) as count, max(m.created_at) as last_activity
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
  'Per-scope active counts and last activity visible to the EFFECTIVE caller.
   Actor resolved by the 00046/00041 service-role-gated rule: a caller-supplied
   p_user_id is honoured only on a verified service-role connection, otherwise
   auth.uid() wins — so an authenticated caller can never enumerate another
   user''s scope names. p_user_id IS NULL under service-role is the CI escape
   hatch. last_activity is max(created_at) over the same counted rows.';
