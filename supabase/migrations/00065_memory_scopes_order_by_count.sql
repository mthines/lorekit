-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_scopes — order the per-scope rollup by COUNT, not scope name.
--
-- WHY: the Lore Explorer's scope chip strip renders `GET /memories/scopes` in
-- the order the endpoint returns (`fetchScopes` maps but never re-sorts), so the
-- endpoint's ORDER BY *is* the chip order. Alphabetical put a one-memory scope
-- ahead of the account's busiest one; sorting by count surfaces the scopes a
-- reader actually works in first.
--
-- This also makes the two catalog endpoints consistent: `lorekit_memory_tags`
-- (00050) already orders `count desc, label asc`. `/scopes` was the odd one out
-- at `scope asc`; both now lead with frequency and break ties by name.
--
-- Signature and return type are unchanged, so a plain `create or replace` (no
-- DROP) suffices — unlike 00049, which had to DROP to add a column. Everything
-- else is carried over verbatim from 00049: the service-role-gated actor guard,
-- the `lorekit_member_org_ids` visibility predicate, the active-rows-only
-- definition (non-archived AND non-expired), `last_activity`, plpgsql-not-SQL so
-- the ordering survives, and the revoked PUBLIC/anon grant.
--
-- `count desc` is emitted as `count(*) desc` rather than the output alias `count`
-- to stay unambiguous under `#variable_conflict use_column`; `scope asc` is the
-- deterministic tiebreaker so equal-count scopes keep a stable order.
-- ═════════════════════════════════════════════════════════════════════════

create or replace function lorekit_memory_scopes(p_user_id uuid)
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
     order by count(*) desc, m.scope asc;
end;
$$;

revoke execute on function lorekit_memory_scopes(uuid) from public, anon;
grant  execute on function lorekit_memory_scopes(uuid) to authenticated, service_role;

comment on function lorekit_memory_scopes(uuid) is
  'Per-scope active counts and last activity visible to the EFFECTIVE caller,
   ordered by count desc then scope asc (matching lorekit_memory_tags). Actor
   resolved by the 00046/00041 service-role-gated rule: a caller-supplied
   p_user_id is honoured only on a verified service-role connection, otherwise
   auth.uid() wins — so an authenticated caller can never enumerate another
   user''s scope names. p_user_id IS NULL under service-role is the CI escape
   hatch. last_activity is max(created_at) over the same counted rows.';
