-- ═════════════════════════════════════════════════════════════════════════
-- Reusable dimension-filter predicates, and the write-activity series that
-- finally honours them.
--
-- WHY: the Explorer's stats header counts what the filter bar does not narrow.
-- `GET /memories` filters on eight dimensions; `GET /memories/activity` — the
-- series behind the header's "Memories written" and "Scopes active" cards —
-- took only a window, so a reader could filter the list to `kind=lesson` and
-- read a headline counting everything. Two numbers on one screen describing
-- different populations is worse than one number, because nothing on screen
-- says which is which.
--
-- 00057 already taught `lorekit_memory_facets` the same trick and spelled the
-- predicate out inline, once per dimension — eight near-identical `case`
-- blocks. Teaching a second function the same trick the same way would make it
-- sixteen, and the thing being copied is exactly the sort that drifts silently:
--
--     `nin` means `value is not null and value <> all(filter)`
--
-- The null test is load-bearing and non-obvious. `m.source_agent <> all(...)`
-- alone is NULL for a row with no agent, which reads as false, so "agent is not
-- aw" would silently drop every memory nobody attributed — the rows most likely
-- to be the ones you are hunting for. Written out sixteen times, one of them
-- eventually loses it.
--
-- So the predicate becomes three tiny functions and every caller composes them.
-- They are `language sql` + `immutable` + a single expression, which is what
-- makes PostgreSQL INLINE them into the calling query: the planner still sees a
-- plain boolean expression over the column and can still use an index. A
-- plpgsql helper would have been a per-row function call and a planner barrier.
--
-- ── What this deliberately does NOT do ──────────────────────────────────────
--
-- `GET /memories/read-activity` and `GET /memories/usage` are NOT given
-- dimension filters, and that is a decision rather than an omission. Both read
-- `usage_events`, which has `kind`/`host` columns (00056) — but:
--
--   1. They are never written. `recordUsageEvent` (`_shared/usage.ts`) does not
--      pass `p_kind`/`p_host` to the writer RPC, so every row in the table has
--      NULL in both. A filter over them would return nothing, always. (The
--      writer is fixed alongside this migration, so this stops being true for
--      rows written from now on — which is precisely why point 2 matters.)
--   2. Even populated, they would mean the wrong thing. A usage event's `kind`
--      is resolved from the CALL'S ARGUMENTS (`resolveKindHost(toolArgs)`), so
--      it records "this read mentioned kind=lesson", not "this read returned
--      lesson records". Filtering a records-read series by it would answer a
--      question nobody asked, in a way no caption could honestly describe.
--
-- The Explorer's header therefore shows Written and Scopes narrowing with the
-- filter bar while Read and Expired stay account-level, and says so on the
-- cards. An honest asymmetry beats a uniform lie.
--
-- Forward-only: the helpers are new, `lorekit_memory_activity` gains trailing
-- defaulted parameters (every existing caller is unaffected), and
-- `lorekit_memory_facets` is re-created with an IDENTICAL signature and
-- identical behaviour — only its body changes, to compose the helpers instead
-- of restating them.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. The three predicates ─────────────────────────────────────────────────

-- A scalar text column against a value list. Covers source_agent, trigger,
-- kind, host, origin_repo and origin_branch — every single-valued text
-- dimension the filter bar offers.
--
-- `immutable`, not `stable`: the result depends only on the arguments. That is
-- also what lets the planner fold it into an index-usable expression.
create or replace function lorekit_match_text(
  p_value  text,
  p_filter text[],
  p_mode   text
)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(
    p_filter is null
    or case coalesce(p_mode, 'in')
         -- The null test that is the whole reason this function exists: a row
         -- with no value must NOT satisfy "is not one of these". Without it the
         -- comparison is NULL, which filters the row out — silently hiding
         -- every unattributed row from a negated filter.
         when 'nin' then (p_value is not null and p_value <> all(p_filter))
         else p_value = any(p_filter)
       end,
    false);
$$;

comment on function lorekit_match_text(text, text[], text) is
  'Does a scalar text column satisfy a value-list filter? `nin` negates and
   requires the value to be NON-NULL, so an unattributed row is excluded from a
   negated filter rather than silently dropped by NULL logic. A null filter is
   "not filtered" and matches everything. Inlinable (sql/immutable), so callers
   keep index access.';

-- A `text[]` column (memories.tags) against a label list. Three modes rather
-- than two, because a column holding MANY values admits containment: `all` is
-- @>, `any` is &&, and `none` is the negation of `any`.
create or replace function lorekit_match_tags(
  p_value  text[],
  p_filter text[],
  p_mode   text
)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(
    p_filter is null
    or case coalesce(p_mode, 'any')
         when 'all'  then p_value @> p_filter
         -- NOT(carries any), never NOT(carries all): the latter would also
         -- admit a row carrying all but one of the named labels.
         when 'none' then not (p_value && p_filter)
         else p_value && p_filter
       end,
    false);
$$;

comment on function lorekit_match_tags(text[], text[], text) is
  'Does a label array satisfy a label filter? `all` is containment (@>), `any`
   is overlap (&&), `none` is the negation of `any` — never the negation of
   `all`, which would admit a row carrying all but one named label. A null
   filter matches everything. Inlinable.';

-- An integer column (memories.origin_pr) against a value list.
--
-- Separate from the text helper because the column is an INTEGER and the
-- comparison must be numeric: `GET /memories` sends the digits bare to the
-- integer column, so Postgres reads `007` as 7 and matches PR 7. Comparing
-- `origin_pr::text` would match nothing for that same input and the two routes
-- would disagree about one query string.
create or replace function lorekit_match_int(
  p_value  integer,
  p_filter integer[],
  p_mode   text
)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(
    p_filter is null
    or case coalesce(p_mode, 'in')
         when 'nin' then (p_value is not null and p_value <> all(p_filter))
         else p_value = any(p_filter)
       end,
    false);
$$;

comment on function lorekit_match_int(integer, integer[], text) is
  'Integer counterpart of lorekit_match_text, for memories.origin_pr. Numeric
   comparison so `007` matches PR 7, exactly as GET /memories does. Inlinable.';

-- ── 2. Write activity, now filterable ───────────────────────────────────────
--
-- DROP first: the parameter list grows, and a bare CREATE would leave the
-- 4-argument 00051 overload behind and make every named-argument call
-- ambiguous. Every added parameter is trailing and defaulted, so a caller that
-- passes only the original four is unaffected — and `GET /memories/activity`
-- without filters returns exactly what it returned before.
drop function if exists lorekit_memory_activity(uuid, text, timestamptz, timestamptz);

create or replace function lorekit_memory_activity(
  p_user_id uuid,
  p_bucket  text        default 'day',
  p_since   timestamptz default null,
  p_until   timestamptz default null,
  -- The filter mirror, named exactly as `lorekit_memory_facets` (00057) names
  -- it, which is in turn exactly what `GET /memories` calls these params. One
  -- vocabulary across the list, the catalog and the series means a caller can
  -- forward its filter state verbatim to all three.
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
  -- Resolved once, exactly as 00057 does: non-numeric entries are DROPPED
  -- rather than raising (the list arrives from a hand-editable URL and one bad
  -- entry should narrow the filter, not break the page), and a list that
  -- reduces to empty applies no filter at all — `array_agg` over no rows is
  -- NULL, which every helper reads as "not filtered".
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
       -- Scope is a hard filter here exactly as it is on the list route.
       and (p_scope is null or m.scope = p_scope)
       -- AND across dimensions, OR within one — the model the filter bar
       -- renders, expressed by composing the shared predicates rather than by
       -- restating eight `case` blocks.
       and lorekit_match_tags(m.tags,          p_tags,          p_tags_mode)
       and lorekit_match_text(m.source_agent,  p_source_agent,  p_source_agent_mode)
       and lorekit_match_text(m.trigger,       p_trigger,       p_trigger_mode)
       and lorekit_match_text(m.kind,          p_kind,          p_kind_mode)
       and lorekit_match_text(m.host,          p_host,          p_host_mode)
       and lorekit_match_text(m.origin_repo,   p_origin_repo,   p_origin_repo_mode)
       and lorekit_match_text(m.origin_branch, p_origin_branch, p_origin_branch_mode)
       and lorekit_match_int (m.origin_pr,     v_origin_pr,     p_origin_pr_mode)
     group by 1, m.scope
     order by 1 asc, m.scope asc;
end;
$$;

revoke execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz,
  text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text
) from public, anon;
grant execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz,
  text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text
) to authenticated, service_role;

comment on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz,
  text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text
) is
  'Memories created per UTC hour/day per scope over the half-open
   [p_since, p_until) window, narrowed by the same eight dimensions
   GET /memories filters on (OR within a dimension, AND across dimensions).
   Every filter parameter is optional and trailing; with none supplied the
   result is 00051''s verbatim. Predicates come from lorekit_match_text /
   _tags / _int so the semantics cannot drift from lorekit_memory_facets.';

-- ── 3. The facet catalog composes the same predicates ───────────────────────
--
-- Signature UNCHANGED (so no caller moves) and behaviour unchanged: this
-- replaces eight inline `case` blocks with the helper calls they are now
-- identical to. The point is that there is one definition of what `nin` means
-- rather than two — which is the whole reason the helpers exist, and would be
-- undermined by leaving this function as the second copy.
--
-- Everything else — the actor rule, the tenant predicate, the archived
-- partition, the self-exclusion counting, the ordering and the grants — is
-- 00057's verbatim.
create or replace function lorekit_memory_facets(
  p_user_id            uuid,
  p_archived           boolean default false,
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
      lorekit_match_tags(m.tags,          p_tags,          p_tags_mode)          as ok_tag,
      lorekit_match_text(m.source_agent,  p_source_agent,  p_source_agent_mode)  as ok_source_agent,
      lorekit_match_text(m.trigger,       p_trigger,       p_trigger_mode)       as ok_trigger,
      lorekit_match_text(m.kind,          p_kind,          p_kind_mode)          as ok_kind,
      lorekit_match_text(m.host,          p_host,          p_host_mode)          as ok_host,
      lorekit_match_text(m.origin_repo,   p_origin_repo,   p_origin_repo_mode)   as ok_origin_repo,
      lorekit_match_text(m.origin_branch, p_origin_branch, p_origin_branch_mode) as ok_origin_branch,
      lorekit_match_int (m.origin_pr,     v_origin_pr,     p_origin_pr_mode)     as ok_origin_pr
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
       and (p_scope is null or m.scope = p_scope)
  ), cells as (
    select 'tag'::text as facet, t.value, count(*)::bigint as count
      from base b, unnest(b.tags) as t(value)
     where b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
     group by t.value
    union all
    select 'source_agent', b.source_agent, count(*)::bigint
      from base b
     where b.source_agent is not null
       and b.ok_tag and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
     group by b.source_agent
    union all
    select 'trigger', b.trigger, count(*)::bigint
      from base b
     where b.trigger is not null
       and b.ok_tag and b.ok_source_agent and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
     group by b.trigger
    union all
    select 'kind', b.kind, count(*)::bigint
      from base b
     where b.kind is not null
       and b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
     group by b.kind
    union all
    select 'host', b.host, count(*)::bigint
      from base b
     where b.host is not null
       and b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
     group by b.host
    union all
    select 'origin_repo', b.origin_repo, count(*)::bigint
      from base b
     where b.origin_repo is not null
       and b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_branch and b.ok_origin_pr
     group by b.origin_repo
    union all
    select 'origin_branch', b.origin_branch, count(*)::bigint
      from base b
     where b.origin_branch is not null
       and b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_pr
     group by b.origin_branch
    union all
    select 'origin_pr', b.origin_pr::text, count(*)::bigint
      from base b
     where b.origin_pr is not null
       and b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch
     group by b.origin_pr
  )
  select c.facet, c.value, c.count
    from cells c
   order by c.facet asc, c.count desc, c.value asc;
end;
$$;
