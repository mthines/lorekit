-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_pivot — the TWO-dimensional facet count.
--
-- ── WHY ──────────────────────────────────────────────────────────────────
-- `lorekit_memory_facets` (00052/00057, helper-ised in 00066) answers "how
-- many memories carry each value, per dimension" — a ONE-dimensional pivot.
-- The Explorer's new matrix instrument asks the next question: "how many
-- carry value X of dimension A *and* value Y of dimension B", which is the
-- same aggregate with a second group-by.
--
-- The alternative the dashboard could reach for is one facets call per row
-- value with that value pushed into the filters — an N+1 whose N is chosen by
-- the UI, over the largest table in the schema. The rule in
-- `packages/web/CLAUDE.md` is explicit that an aggregate the dashboard needs
-- belongs in Postgres behind an endpoint, so this is that endpoint's function.
--
-- ── SELF-EXCLUSION ON *BOTH* AXES, AND WHY IT IS THE FEATURE ─────────────
-- 00057 established that a facet is counted with every OTHER active filter
-- applied but not its own, so the dimension you are standing in still lists
-- everything you could switch to. A matrix has TWO dimensions in that
-- position, so both are excluded.
--
-- This is not a nicety. Count a matrix under its own axes' filters and the
-- instant you click a cell every other cell reads zero — the grid blacks
-- itself out and there is no second click. The instrument is only navigable
-- because the counts answer "what would selecting this cell yield", which is
-- exactly what excluding the two axes computes.
--
-- ── ONE ROW-VISIBILITY PREDICATE, COPIED FROM NOWHERE ───────────────────
-- The base CTE is `lorekit_memory_facets`' verbatim: the same tenant test
-- (`lorekit_member_org_ids`, as the memories RLS read policies compose it),
-- the same calling-key restriction (00068/00069 — `origin_repo` is a
-- repository name by construction, so an unnarrowed pivot leaks exactly what
-- the scope catalog hides), the same archived/expired partition, and the same
-- per-dimension flags from the shared `lorekit_match_*` helpers. A pivot that
-- narrowed differently from the facet menu beside it would be a second
-- implementation of the same question.
--
-- ── THE VALUE PROJECTION IS A FUNCTION, NOT A CASE PER AXIS ─────────────
-- `tag` is the one dimension whose column holds MANY values per row, so it
-- needs `unnest` while the other eight are scalars. With two axes that is
-- four combinations to spell out inline. `lorekit_memory_facet_value` returns
-- a SETOF instead — one row for a scalar, N for tags — so each axis is one
-- `cross join lateral` and the axes cannot be handled asymmetrically.
--
-- A memory carrying two tags therefore contributes to two cells on a `tag`
-- axis. That is the same double-count `lorekit_memory_facets` already does
-- through its own `unnest`, so a matrix row total agrees with the facet count
-- for that value rather than disagreeing by the multi-tag rows.
-- ═════════════════════════════════════════════════════════════════════════

-- ── The per-facet value projection ──────────────────────────────────────
-- Takes the already-selected columns rather than a row id, so it stays
-- `immutable` and inlinable and never re-reads `memories`.
create or replace function lorekit_memory_facet_value(
  p_facet         text,
  p_tags          text[],
  p_source_agent  text,
  p_trigger       text,
  p_kind          text,
  p_host          text,
  p_origin_repo   text,
  p_origin_branch text,
  p_origin_pr     integer,
  p_org_id        uuid,
  p_org_slug      text
)
returns setof text
language sql
immutable
parallel safe
as $$
  -- The eight scalar dimensions. A null column yields a null value, which the
  -- caller drops — the same "a null column value yields NO facet row" omission
  -- `lorekit_memory_facets` has, so the two agree on absence.
  select case p_facet
           when 'source_agent'  then p_source_agent
           when 'trigger'       then p_trigger
           when 'kind'          then p_kind
           when 'host'          then p_host
           when 'origin_repo'   then p_origin_repo
           when 'origin_branch' then p_origin_branch
           when 'origin_pr'     then p_origin_pr::text
           -- Owner is a computed identity, not a column: `personal` for a row
           -- with no org, else the org's slug (00064).
           when 'owner'         then case when p_org_id is null then 'personal' else p_org_slug end
         end
   where p_facet <> 'tag'
  union all
  select t.tag
    from unnest(coalesce(p_tags, '{}'::text[])) as t(tag)
   where p_facet = 'tag';
$$;

revoke execute on function lorekit_memory_facet_value(
  text, text[], text, text, text, text, text, text, integer, uuid, text
) from public, anon;
grant execute on function lorekit_memory_facet_value(
  text, text[], text, text, text, text, text, text, integer, uuid, text
) to authenticated, service_role;

comment on function lorekit_memory_facet_value(
  text, text[], text, text, text, text, text, text, integer, uuid, text
) is
  'The value(s) a memory row carries for one facet name: exactly one row for
   the eight scalar dimensions (null when the column is null), and one row per
   label for `tag`. Lets lorekit_memory_pivot treat both axes identically
   instead of spelling out the scalar/array combinations.';


-- ── The pivot ───────────────────────────────────────────────────────────
create or replace function lorekit_memory_pivot(
  p_row_facet          text,
  p_col_facet          text,
  p_user_id            uuid    default null,
  p_archived           boolean default false,
  p_scope              text    default null,
  p_limit              integer default 400,
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
  p_origin_pr_mode     text    default 'in',
  p_owner              text[]  default null,
  p_owner_mode         text    default 'in',
  -- The CALLING KEY's restriction (00068), defaulted to unrestricted.
  p_key_scopes         text[]  default '{}',
  p_key_org_access     text    default 'all',
  p_key_org_ids        uuid[]  default '{}'
)
returns table (row_value text, col_value text, count bigint)
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
      m.org_id, o.slug as org_slug,
      lorekit_match_tags(m.tags,          p_tags,          p_tags_mode)          as ok_tag,
      lorekit_match_text(m.source_agent,  p_source_agent,  p_source_agent_mode)  as ok_source_agent,
      lorekit_match_text(m.trigger,       p_trigger,       p_trigger_mode)       as ok_trigger,
      lorekit_match_text(m.kind,          p_kind,          p_kind_mode)          as ok_kind,
      lorekit_match_text(m.host,          p_host,          p_host_mode)          as ok_host,
      lorekit_match_text(m.origin_repo,   p_origin_repo,   p_origin_repo_mode)   as ok_origin_repo,
      lorekit_match_text(m.origin_branch, p_origin_branch, p_origin_branch_mode) as ok_origin_branch,
      lorekit_match_int (m.origin_pr,     v_origin_pr,     p_origin_pr_mode)     as ok_origin_pr,
      -- Owner stays inline for lorekit_memory_facets' reason: it is a
      -- LEFT JOIN-computed identity, not one of the three column helpers.
      (p_owner is null or case coalesce(p_owner_mode, 'in')
         when 'nin' then (
           (case when m.org_id is null then 'personal' else o.slug end) is not null
           and (case when m.org_id is null then 'personal' else o.slug end) <> all(p_owner)
         )
         else (
           ('personal' = any(p_owner) and m.org_id is null)
           or (m.org_id is not null and o.slug = any(p_owner))
         )
       end) as ok_owner
      from memories m
      left join orgs o on o.id = m.org_id
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
       and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, m.org_id)
       and (
             case
               when p_archived then m.archived_at is not null
               else m.archived_at is null
                    and (m.expires_at is null or m.expires_at > now())
             end
           )
       and (p_scope is null or m.scope = p_scope)
  )
  select rv.value, cv.value, count(*)::bigint
    from base b
    cross join lateral lorekit_memory_facet_value(
      p_row_facet, b.tags, b.source_agent, b.trigger, b.kind, b.host,
      b.origin_repo, b.origin_branch, b.origin_pr, b.org_id, b.org_slug
    ) as rv(value)
    cross join lateral lorekit_memory_facet_value(
      p_col_facet, b.tags, b.source_agent, b.trigger, b.kind, b.host,
      b.origin_repo, b.origin_branch, b.origin_pr, b.org_id, b.org_slug
    ) as cv(value)
   -- Each dimension's own filter applies UNLESS it is one of the two axes —
   -- see the self-exclusion note at the top. One line per dimension so adding
   -- a tenth is one line here, not a re-derivation.
   where (p_row_facet = 'tag'           or p_col_facet = 'tag'           or b.ok_tag)
     and (p_row_facet = 'source_agent'  or p_col_facet = 'source_agent'  or b.ok_source_agent)
     and (p_row_facet = 'trigger'       or p_col_facet = 'trigger'       or b.ok_trigger)
     and (p_row_facet = 'kind'          or p_col_facet = 'kind'          or b.ok_kind)
     and (p_row_facet = 'host'          or p_col_facet = 'host'          or b.ok_host)
     and (p_row_facet = 'origin_repo'   or p_col_facet = 'origin_repo'   or b.ok_origin_repo)
     and (p_row_facet = 'origin_branch' or p_col_facet = 'origin_branch' or b.ok_origin_branch)
     and (p_row_facet = 'origin_pr'     or p_col_facet = 'origin_pr'     or b.ok_origin_pr)
     and (p_row_facet = 'owner'         or p_col_facet = 'owner'         or b.ok_owner)
     -- A null column value yields no cell, matching lorekit_memory_facets.
     and rv.value is not null
     and cv.value is not null
   group by rv.value, cv.value
   -- Densest cells first, so a caller that has to truncate keeps the ones
   -- worth drawing. Deterministic tie-break so a page boundary is stable.
   order by count(*) desc, rv.value asc, cv.value asc
   limit greatest(p_limit, 0);
end;
$$;

revoke execute on function lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
) from public, anon;
grant execute on function lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
) to authenticated, service_role;

comment on function lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
) is
  'Two-dimensional facet counts: how many visible memories carry each
   (row_facet value, col_facet value) pair. Same row visibility, key
   restriction, archived/expired partition and dimension predicates as
   lorekit_memory_facets, with BOTH axes self-excluded from the filters so a
   drilled-in matrix still shows every cell you could move to. Ordered count
   desc, row asc, col asc and bounded by p_limit.';
