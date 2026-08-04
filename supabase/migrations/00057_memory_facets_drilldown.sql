-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_facets — drill-down (filter-aware) counts + kind/host.
--
-- WHAT CHANGES: 00052's facets were GLOBAL — every dimension's counts were the
-- total over all visible memories, ignoring whatever the user had already
-- selected. A drill-down filter menu wants the opposite: once you pick
-- `kind=lesson`, the counts shown for `host`, `source_agent`, … should narrow
-- to "how many LESSON memories also carry this host", so the numbers you see
-- are what you'd actually get by adding that filter.
--
-- THE SELF-EXCLUSION RULE (the easy thing to get wrong): when counting a
-- dimension D's values, apply every OTHER active filter but NOT D's own. If D's
-- own selection were applied to D's own counts, D would collapse to just the
-- value(s) already picked and every other value would read 0 — you could never
-- see what else you could switch to. This is "OR within a dimension, AND across
-- dimensions", the exact model ListMemoriesQuerySchema's `*_mode` filters use.
--
-- HOW: compute each dimension's match flag ONCE per row in `base` (does this row
-- satisfy that dimension's filter?), then a dimension's cells require the AND of
-- all the OTHER flags. A dimension the user has not filtered on has a flag that
-- is trivially true, so its counts fall back to the fully-filtered set — which
-- is exactly right.
--
-- ALSO: adds `kind` and `host` (migration 00056) as two new dimensions.
--
-- Forward-only. The function is DROPped and recreated with a wider signature;
-- every new parameter is optional and defaulted, and the handler is updated in
-- lockstep. With no filters supplied every flag is true and the result is
-- byte-for-byte 00052's global catalog, so callers that pass only
-- (p_user_id, p_archived) are unaffected.
-- ═════════════════════════════════════════════════════════════════════════

drop function if exists lorekit_memory_facets(uuid, boolean);

create or replace function lorekit_memory_facets(
  p_user_id            uuid,
  p_archived           boolean default false,
  -- Active filters, mirroring GET /memories' query params so the menu can pass
  -- its current filter state verbatim. All optional: null/absent = not filtered.
  p_scope              text    default null,
  p_tags               text[]  default null,
  p_tags_mode          text    default 'any',
  p_source_agent       text[]  default null,
  p_source_agent_mode  text    default 'in',
  p_trigger            text[]  default null,
  p_trigger_mode       text    default 'in',
  p_kind               text[]  default null,
  p_kind_mode          text    default 'in',
  p_host               text[]  default null,
  p_host_mode          text    default 'in',
  p_origin_repo        text[]  default null,
  p_origin_repo_mode   text    default 'in',
  p_origin_branch      text[]  default null,
  p_origin_branch_mode text    default 'in',
  p_origin_pr          text[]  default null,
  p_origin_pr_mode     text    default 'in'
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
  -- `origin_pr` is an INTEGER column, so it must be compared numerically, not as
  -- text: `GET /memories` sends the digits-only list bare to the integer column
  -- (`applyScalarFilter(..., { quote: false })`), where Postgres reads `007` as
  -- 7 and matches PR 7. A `m.origin_pr::text = any(...)` comparison here would
  -- match nothing for the same input, so the two routes would disagree on the
  -- same query string. Non-numeric entries are DROPPED rather than raising, and
  -- a list that reduces to empty applies no filter at all (`array_agg` over no
  -- rows is NULL) — the list route's documented behaviour, verbatim.
  v_origin_pr integer[] := (
    select array_agg(x::integer)
      from unnest(coalesce(p_origin_pr, '{}'::text[])) as x
     where x ~ '^[0-9]+$'
  );
begin
  return query
  with base as (
    select
      m.tags, m.source_agent, m.trigger, m.kind, m.host,
      m.origin_repo, m.origin_branch, m.origin_pr,
      -- Per-dimension match flag: is this row kept by THIS dimension's filter?
      -- A null filter is "not filtered" → trivially true, so an untouched
      -- dimension never narrows anything.
      (p_tags is null or case coalesce(p_tags_mode, 'any')
         when 'all'  then m.tags @> p_tags
         when 'none' then not (m.tags && p_tags)
         else m.tags && p_tags
       end) as ok_tag,
      (p_source_agent is null or case coalesce(p_source_agent_mode, 'in')
         when 'nin' then (m.source_agent is not null and m.source_agent <> all(p_source_agent))
         else m.source_agent = any(p_source_agent)
       end) as ok_source_agent,
      (p_trigger is null or case coalesce(p_trigger_mode, 'in')
         when 'nin' then (m.trigger is not null and m.trigger <> all(p_trigger))
         else m.trigger = any(p_trigger)
       end) as ok_trigger,
      (p_kind is null or case coalesce(p_kind_mode, 'in')
         when 'nin' then (m.kind is not null and m.kind <> all(p_kind))
         else m.kind = any(p_kind)
       end) as ok_kind,
      (p_host is null or case coalesce(p_host_mode, 'in')
         when 'nin' then (m.host is not null and m.host <> all(p_host))
         else m.host = any(p_host)
       end) as ok_host,
      (p_origin_repo is null or case coalesce(p_origin_repo_mode, 'in')
         when 'nin' then (m.origin_repo is not null and m.origin_repo <> all(p_origin_repo))
         else m.origin_repo = any(p_origin_repo)
       end) as ok_origin_repo,
      (p_origin_branch is null or case coalesce(p_origin_branch_mode, 'in')
         when 'nin' then (m.origin_branch is not null and m.origin_branch <> all(p_origin_branch))
         else m.origin_branch = any(p_origin_branch)
       end) as ok_origin_branch,
      (v_origin_pr is null or case coalesce(p_origin_pr_mode, 'in')
         when 'nin' then (m.origin_pr is not null and m.origin_pr <> all(v_origin_pr))
         else m.origin_pr = any(v_origin_pr)
       end) as ok_origin_pr
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
       -- Scope is a hard filter, not a facet dimension, so it is always applied.
       and (p_scope is null or m.scope = p_scope)
  ), cells as (
    -- Each dimension's cells are counted over rows kept by every OTHER
    -- dimension's filter (self-exclusion), so a dimension's own selection never
    -- suppresses its own alternative values.
    select 'tag'::text as facet, t.tag as value
      from base b
      cross join lateral unnest(b.tags) as t(tag)
     where b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
    union all
    select 'source_agent', b.source_agent from base b
     where b.ok_tag and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
    union all
    select 'trigger', b.trigger from base b
     where b.ok_tag and b.ok_source_agent and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
    union all
    select 'kind', b.kind from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
    union all
    select 'host', b.host from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
    union all
    select 'origin_repo', b.origin_repo from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_branch and b.ok_origin_pr
    union all
    select 'origin_branch', b.origin_branch from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_pr
    union all
    select 'origin_pr', b.origin_pr::text from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch
  )
  select c.facet, c.value, count(*) as count
    from cells c
   where c.value is not null
     and btrim(c.value) <> ''
   group by c.facet, c.value
   order by c.facet asc, count(*) desc, c.value asc;
end;
$$;

revoke execute on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text
) from public, anon;
grant execute on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text
) to authenticated, service_role;

comment on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text
) is
  'Value catalog with counts for every filterable memory dimension (tag,
   source_agent, trigger, kind, host, origin_repo, origin_branch, origin_pr)
   over the partition selected by p_archived, visible to the EFFECTIVE caller.
   Counts are DRILL-DOWN (00057): each dimension is counted with every OTHER
   active filter applied but not its own (self-exclusion), so the numbers match
   what adding that value would yield. With no filters supplied the result is
   00052''s global catalog. Same service-role-gated actor rule and ordering as
   lorekit_memory_tags.';
