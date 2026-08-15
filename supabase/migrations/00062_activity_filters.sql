-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_activity — filter-aware (scope + dimension filters).
--
-- WHAT CHANGES: 00051's activity counted every visible memory in the window,
-- ignoring the Explorer's filter bar. The Explorer's stat header follows a
-- scope selection AND the dimension filters (label / agent / trigger / kind /
-- host / repo / branch / PR), and its numbers have to agree with the LIST under
-- them — the list already applies exactly these predicates (GET /memories). So
-- the written/scopes cards must count the same set the list shows.
--
-- HOW: the SAME per-dimension predicate as GET /memories and lorekit_memory_facets
-- (00057) — "OR within a dimension, AND across dimensions", each `*_mode`
-- choosing `in`/`nin` (and `tags` also `all`/`none`). Unlike the facets RPC there
-- is NO self-exclusion here: a straight count applies every filter directly, so
-- the CTE-of-flags collapses to a flat WHERE. `scope` is a hard filter (00057's
-- treatment). Every parameter is optional and defaulted, so a caller passing
-- only (p_user_id, p_bucket, p_since, p_until) gets byte-for-byte 00051's result.
--
-- Read-activity is deliberately NOT widened here: usage_events carries no
-- per-memory tag/agent/repo (only `scope`, 00058), so a dimension filter is
-- unanswerable for reads — the Read card stays scope-level by design.
--
-- Forward-only. The function is DROPped and recreated with a wider signature;
-- the handler is updated in lockstep. Bucket validation, the half-open
-- [p_since, p_until) window, the active-only + tenant predicate, and the
-- date_trunc anchoring are 00051 verbatim.
-- ═════════════════════════════════════════════════════════════════════════

drop function if exists lorekit_memory_activity(uuid, text, timestamptz, timestamptz);

create or replace function lorekit_memory_activity(
  p_user_id uuid,
  p_bucket  text        default 'day',
  p_since   timestamptz default null,
  p_until   timestamptz default null,
  -- Active filters, mirroring GET /memories' query params so the stat header can
  -- pass its filter bar verbatim. All optional: null/absent = not filtered.
  p_scope              text   default null,
  p_tags               text[] default null,
  p_tags_mode          text   default 'any',
  p_source_agent       text[] default null,
  p_source_agent_mode  text   default 'in',
  p_trigger            text[] default null,
  p_trigger_mode       text   default 'in',
  p_kind               text[] default null,
  p_kind_mode          text   default 'in',
  p_host               text[] default null,
  p_host_mode          text   default 'in',
  p_origin_repo        text[] default null,
  p_origin_repo_mode   text   default 'in',
  p_origin_branch      text[] default null,
  p_origin_branch_mode text   default 'in',
  p_origin_pr          text[] default null,
  p_origin_pr_mode     text   default 'in'
)
returns table (bucket timestamptz, scope text, count bigint)
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
  -- `origin_pr` is an INTEGER column: coerce the digits-only list numerically so
  -- this route matches GET /memories on the same input (00057's rationale). A
  -- non-numeric entry is dropped; a list reducing to empty applies no filter.
  v_origin_pr integer[] := (
    select array_agg(x::integer)
      from unnest(coalesce(p_origin_pr, '{}'::text[])) as x
     where x ~ '^[0-9]+$'
  );
begin
  if p_bucket is null or p_bucket not in ('hour', 'day') then
    raise exception 'invalid bucket %, expected hour or day', p_bucket
      using errcode = '22023';
  end if;

  return query
    select date_trunc(p_bucket, m.created_at at time zone 'UTC') at time zone 'UTC' as bucket,
           m.scope,
           count(*) as count
      from memories m
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
       and (p_since is null or m.created_at >= p_since)
       and (p_until is null or m.created_at <  p_until)
       -- Scope is a hard filter, always applied (00057's treatment).
       and (p_scope is null or m.scope = p_scope)
       -- Dimension filters — every one applied (no self-exclusion for a count).
       and (p_tags is null or case coalesce(p_tags_mode, 'any')
             when 'all'  then m.tags @> p_tags
             when 'none' then not (m.tags && p_tags)
             else m.tags && p_tags
           end)
       and (p_source_agent is null or case coalesce(p_source_agent_mode, 'in')
             when 'nin' then (m.source_agent is not null and m.source_agent <> all(p_source_agent))
             else m.source_agent = any(p_source_agent)
           end)
       and (p_trigger is null or case coalesce(p_trigger_mode, 'in')
             when 'nin' then (m.trigger is not null and m.trigger <> all(p_trigger))
             else m.trigger = any(p_trigger)
           end)
       and (p_kind is null or case coalesce(p_kind_mode, 'in')
             when 'nin' then (m.kind is not null and m.kind <> all(p_kind))
             else m.kind = any(p_kind)
           end)
       and (p_host is null or case coalesce(p_host_mode, 'in')
             when 'nin' then (m.host is not null and m.host <> all(p_host))
             else m.host = any(p_host)
           end)
       and (p_origin_repo is null or case coalesce(p_origin_repo_mode, 'in')
             when 'nin' then (m.origin_repo is not null and m.origin_repo <> all(p_origin_repo))
             else m.origin_repo = any(p_origin_repo)
           end)
       and (p_origin_branch is null or case coalesce(p_origin_branch_mode, 'in')
             when 'nin' then (m.origin_branch is not null and m.origin_branch <> all(p_origin_branch))
             else m.origin_branch = any(p_origin_branch)
           end)
       and (v_origin_pr is null or case coalesce(p_origin_pr_mode, 'in')
             when 'nin' then (m.origin_pr is not null and m.origin_pr <> all(v_origin_pr))
             else m.origin_pr = any(v_origin_pr)
           end)
     group by 1, m.scope
     order by 1 asc, m.scope asc;
end;
$$;

revoke execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text
) from public, anon;
grant execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text
) to authenticated, service_role;

comment on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text
) is
  'Memories created per UTC hour/day per scope over the half-open
   [p_since, p_until) window, visible to the EFFECTIVE caller, narrowed by the
   optional scope + dimension filters (00062) — the SAME predicate as
   GET /memories and lorekit_memory_facets, so the stat header agrees with the
   list. With no filters supplied the result is byte-for-byte 00051''s.';
