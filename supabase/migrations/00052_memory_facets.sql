-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_facets(p_user_id, p_archived) — the value catalog for EVERY
-- filterable dimension, for GET /memories/facets.
--
-- WHY it exists: the Explorer grew from a labels-only picker into a
-- multi-dimension filter menu (labels, agent, trigger, repo, branch, pull
-- request). Each new dimension is another unbounded free-text column, so each
-- would otherwise repeat the exact bug 00039 and 00050 were written to fix —
-- `select <column> from memories` plus a browser-side tally is truncated
-- without warning past PostgREST's row cap, so a value used only by older
-- memories disappears from its own filter and every count is understated.
--
-- WHY one RPC and not six: the menu's headline affordance is cross-dimension
-- type-ahead ("type `main`, get `Branch → main`"), which needs every
-- dimension's values before the user has chosen a dimension. Six round trips
-- to render one list is six chances to render it half-populated.
--
-- WHY it overlaps lorekit_memory_tags (00050): that function is the
-- single-dimension label catalog `GET /memories/tags` serves to the CLI and to
-- older clients, and deleting it would be a breaking API change. Both read the
-- same rows under the same predicate, so their `tag` rows agree; the union
-- branch below is deliberately written in the same shape as 00050's body so
-- the agreement is visible rather than asserted.
--
-- Expiry, ordering, actor resolution, visibility and grants are 00050's rules
-- verbatim: the active partition additionally excludes expired rows and the
-- archived partition does not; ordering is count desc then value asc so a
-- picker never reshuffles under the cursor for equal counts; a caller-supplied
-- p_user_id is honoured only on a verified service-role connection; and
-- PUBLIC/anon get no EXECUTE (branch names, repo names and agent names are at
-- least as sensitive as the scope names 00039 withholds).
-- ═════════════════════════════════════════════════════════════════════════

create or replace function lorekit_memory_facets(
  p_user_id  uuid,
  p_archived boolean default false
)
returns table (facet text, value text, count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
begin
  return query
  with visible as (
    select m.tags, m.source_agent, m.trigger,
           m.origin_repo, m.origin_branch, m.origin_pr
      from memories m
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       and (
             case
               when p_archived then m.archived_at is not null
               else m.archived_at is null
                    and (m.expires_at is null or m.expires_at > now())
             end
           )
  ), cells as (
    -- Labels: unnest, not a GIN-assisted filter — a rollup of a text[] column
    -- means every visible row contributes each of its labels (00050).
    select 'tag'::text as facet, t.tag as value
      from visible v
      cross join lateral unnest(v.tags) as t(tag)
    union all
    select 'source_agent', v.source_agent from visible v
    union all
    select 'trigger', v.trigger from visible v
    union all
    select 'origin_repo', v.origin_repo from visible v
    union all
    select 'origin_branch', v.origin_branch from visible v
    -- A pull request number is rendered and filtered as text on the wire, so
    -- it is cast once here rather than in every consumer.
    union all
    select 'origin_pr', v.origin_pr::text from visible v
  )
  select c.facet, c.value, count(*) as count
    from cells c
   -- A null column is "this memory has no branch", not a value to offer: an
   -- option that matches by absence needs an `is not set` operator, which the
   -- list route does not have yet. Blank strings are dropped for 00050's
   -- reason — they are unrenderable and unselectable.
   where c.value is not null
     and btrim(c.value) <> ''
   group by c.facet, c.value
   order by c.facet asc, count(*) desc, c.value asc;
end;
$$;

revoke execute on function lorekit_memory_facets(uuid, boolean) from public, anon;
grant  execute on function lorekit_memory_facets(uuid, boolean) to authenticated, service_role;

comment on function lorekit_memory_facets(uuid, boolean) is
  'Value catalog with counts for every filterable memory dimension (tag,
   source_agent, trigger, origin_repo, origin_branch, origin_pr) over the
   partition selected by p_archived, visible to the EFFECTIVE caller. Same
   service-role-gated actor rule, tenant predicate and ordering as
   lorekit_memory_tags.';
