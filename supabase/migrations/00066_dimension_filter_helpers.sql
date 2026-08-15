-- ═════════════════════════════════════════════════════════════════════════
-- Reusable dimension-filter predicates — one definition of what each mode
-- means, composed by every aggregate that narrows memories by dimension.
--
-- WHY: two aggregate functions apply the SAME per-dimension predicate — the
-- facet catalog `lorekit_memory_facets` (00057) and the write series
-- `lorekit_memory_activity` (00063), both later extended with the owner
-- dimension in 00064 — and each spelled it out INLINE, once per dimension.
-- `lorekit_memory_facets` carried eight `case` flags in its base CTE;
-- `lorekit_memory_activity` carried the same eight again in a flat WHERE.
-- Sixteen near-identical copies of a rule that is easy to get subtly wrong:
--
--     `nin` means `value is not null and value <> all(filter)`
--
-- The null test is load-bearing and non-obvious. `m.source_agent <> all(...)`
-- alone is NULL for a row with no agent, which reads as false, so "agent is not
-- aw" would silently drop every memory nobody attributed — the rows most likely
-- to be the ones you are hunting for. Written out sixteen times, one copy
-- eventually loses it, and the two callers disagree about a filter neither
-- author touched.
--
-- So the predicate becomes three tiny functions and every caller composes them.
-- They are `language sql` + `immutable` + a single expression, which is what
-- makes PostgreSQL INLINE them into the calling query: the planner still sees a
-- plain boolean expression over the column and can still use an index. A
-- plpgsql helper would have been a per-row function call and a planner barrier.
--
-- ── What this migration DELIBERATELY does NOT change ────────────────────────
--
-- This is a pure refactor. `lorekit_memory_facets` and `lorekit_memory_activity`
-- keep their 00064 SIGNATURES verbatim (including `p_owner` / `p_owner_mode`)
-- and their 00064 BEHAVIOUR to the row — only the eight text/tags/int dimension
-- predicates change, from inline `case` blocks to helper calls that are
-- identical to them. The owner dimension stays INLINE: it is not a scalar
-- text/tags/int column but a LEFT JOIN-computed identity (`personal` / org
-- slug), so it is not one of the three helpers. `migrations.test.sql` §68 /
-- §69 (incl. the owner §69c) is the executable proof that behaviour did not
-- move; §80 (added here) pins the helpers directly.
--
-- `create or replace` (not drop): the signatures are unchanged, so the body is
-- swapped in place and the 00064 grants persist. The revoke/grant is re-stated
-- for the same self-documenting reason every prior migration re-states it.
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
-- would disagree about one query string. The digits-only coercion (dropping a
-- non-numeric entry, applying no filter when the list reduces to empty) happens
-- at the CALLER, so this helper only ever receives an already-numeric array.
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

-- These are pure predicates that touch no data, so the default PUBLIC EXECUTE is
-- harmless — but this repo revokes PUBLIC/anon on every function it ships rather
-- than relying on the default, so match that pattern here too. It does not
-- affect inlining (which depends on the sql/immutable/single-expression shape,
-- not on the grant), and the SECURITY DEFINER callers reach them as their owner.
revoke execute on function lorekit_match_text(text, text[], text)        from public, anon;
revoke execute on function lorekit_match_tags(text[], text[], text)      from public, anon;
revoke execute on function lorekit_match_int(integer, integer[], text)   from public, anon;
grant  execute on function lorekit_match_text(text, text[], text)        to authenticated, service_role;
grant  execute on function lorekit_match_tags(text[], text[], text)      to authenticated, service_role;
grant  execute on function lorekit_match_int(integer, integer[], text)   to authenticated, service_role;

-- ── 2. lorekit_memory_facets — composes the helpers ─────────────────────────
--
-- Signature UNCHANGED from 00064 (so no caller moves) and behaviour unchanged:
-- this replaces the eight inline `case` flags in the base CTE with the helper
-- calls they are now identical to. The point is that there is one definition of
-- what `nin` means rather than two — the whole reason the helpers exist, and
-- undermined by leaving this function as the second copy. Owner stays inline:
-- it is a LEFT JOIN-computed identity, not one of the three column helpers.
--
-- Everything else — the actor rule, the tenant predicate (lorekit_member_org_ids),
-- the archived partition, the LEFT JOIN orgs, the owner predicate + owner-dimension
-- self-exclusion, the null/blank drop and the ordering — is 00064's verbatim.
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
  p_origin_pr_mode     text    default 'in',
  -- Owner dimension (00064). `personal` plus one slug per member org with
  -- visible rows. All optional: null/absent = not filtered.
  p_owner              text[]  default null,
  p_owner_mode         text    default 'in'
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
      m.org_id, o.slug as org_slug,
      -- Per-dimension match flag, now from the shared predicates so it cannot
      -- drift from lorekit_memory_activity's. A null filter is "not filtered" →
      -- the helper returns true, so an untouched dimension never narrows.
      lorekit_match_tags(m.tags,          p_tags,          p_tags_mode)          as ok_tag,
      lorekit_match_text(m.source_agent,  p_source_agent,  p_source_agent_mode)  as ok_source_agent,
      lorekit_match_text(m.trigger,       p_trigger,       p_trigger_mode)       as ok_trigger,
      lorekit_match_text(m.kind,          p_kind,          p_kind_mode)          as ok_kind,
      lorekit_match_text(m.host,          p_host,          p_host_mode)          as ok_host,
      lorekit_match_text(m.origin_repo,   p_origin_repo,   p_origin_repo_mode)   as ok_origin_repo,
      lorekit_match_text(m.origin_branch, p_origin_branch, p_origin_branch_mode) as ok_origin_branch,
      lorekit_match_int (m.origin_pr,     v_origin_pr,     p_origin_pr_mode)     as ok_origin_pr,
      -- Owner: the computed identity is `personal` (org_id null) or the org slug.
      -- Stays inline — it is not one of the three column helpers (00064).
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
      -- A personal row has no org, so this is a LEFT join; org rows resolve to
      -- their slug. Visible org rows are always the caller's own orgs (the
      -- visibility predicate below admits them only via lorekit_member_org_ids),
      -- so `o.slug` is never a slug the caller cannot see.
      left join orgs o on o.id = m.org_id
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
    select 'tag'::text as facet, t.tag as value
      from base b
      cross join lateral unnest(b.tags) as t(tag)
     where b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'source_agent', b.source_agent from base b
     where b.ok_tag and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'trigger', b.trigger from base b
     where b.ok_tag and b.ok_source_agent and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'kind', b.kind from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'host', b.host from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'origin_repo', b.origin_repo from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
    union all
    select 'origin_branch', b.origin_branch from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_pr and b.ok_owner
    union all
    select 'origin_pr', b.origin_pr::text from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_owner
    union all
    -- Owner is the ONE dimension self-excluded here (every other flag, NOT
    -- ok_owner), so a drilled-in owner still lists the alternative owner.
    select 'owner', case when b.org_id is null then 'personal' else b.org_slug end from base b
     where b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
       and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr
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
  text[], text, text[], text, text[], text, text[], text, text[], text
) from public, anon;
grant execute on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text
) to authenticated, service_role;

comment on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text
) is
  'Value catalog with counts for every filterable memory dimension (tag,
   source_agent, trigger, kind, host, origin_repo, origin_branch, origin_pr,
   owner) over the partition selected by p_archived, visible to the EFFECTIVE
   caller. `owner` (00064) is `personal` for org_id-null rows, else the org
   slug. Counts are DRILL-DOWN (00057): each dimension is counted with every
   OTHER active filter applied but not its own (self-exclusion), so the numbers
   match what adding that value would yield. The eight text/tags/int dimension
   predicates come from lorekit_match_text / _tags / _int (00066) so their
   semantics cannot drift from lorekit_memory_activity; owner stays inline. With
   no filters supplied the result is 00052''s global catalog plus the owner
   dimension. Same service-role-gated actor rule and ordering as
   lorekit_memory_tags.';

-- ── 3. lorekit_memory_activity — composes the same helpers ──────────────────
--
-- Signature UNCHANGED from 00064. Unlike the facet catalog there is NO
-- self-exclusion here: a straight count applies every filter directly, so the
-- eight dimension predicates collapse to a flat WHERE. Replacing the inline
-- `case` blocks with the helper calls keeps the series byte-identical to 00064
-- and provably in step with the facet catalog. Owner stays inline. Bucket
-- validation, the half-open [p_since, p_until) window, the active-only + tenant
-- predicate, the LEFT JOIN orgs and the date_trunc anchoring are 00064 verbatim.
create or replace function lorekit_memory_activity(
  p_user_id uuid,
  p_bucket  text        default 'day',
  p_since   timestamptz default null,
  p_until   timestamptz default null,
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
  p_origin_pr_mode     text   default 'in',
  -- Owner dimension (00064) — the SAME predicate as lorekit_memory_facets and
  -- GET /memories, so the stat header agrees with the list under an owner pill.
  p_owner              text[] default null,
  p_owner_mode         text   default 'in'
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
      -- LEFT join for the owner predicate — a personal row has no org (00064).
      left join orgs o on o.id = m.org_id
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
       -- Dimension filters — AND across, OR within, from the shared predicates
       -- (00066) so the semantics cannot drift from lorekit_memory_facets. No
       -- self-exclusion here: a straight count applies every one directly.
       and lorekit_match_tags(m.tags,          p_tags,          p_tags_mode)
       and lorekit_match_text(m.source_agent,  p_source_agent,  p_source_agent_mode)
       and lorekit_match_text(m.trigger,       p_trigger,       p_trigger_mode)
       and lorekit_match_text(m.kind,          p_kind,          p_kind_mode)
       and lorekit_match_text(m.host,          p_host,          p_host_mode)
       and lorekit_match_text(m.origin_repo,   p_origin_repo,   p_origin_repo_mode)
       and lorekit_match_text(m.origin_branch, p_origin_branch, p_origin_branch_mode)
       and lorekit_match_int (m.origin_pr,     v_origin_pr,     p_origin_pr_mode)
       -- Owner: `personal` for org_id-null rows, else the org slug (00064).
       and (p_owner is null or case coalesce(p_owner_mode, 'in')
             when 'nin' then (
               (case when m.org_id is null then 'personal' else o.slug end) is not null
               and (case when m.org_id is null then 'personal' else o.slug end) <> all(p_owner)
             )
             else (
               ('personal' = any(p_owner) and m.org_id is null)
               or (m.org_id is not null and o.slug = any(p_owner))
             )
           end)
     group by 1, m.scope
     order by 1 asc, m.scope asc;
end;
$$;

revoke execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text
) from public, anon;
grant execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text
) to authenticated, service_role;

comment on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text
) is
  'Memories created per UTC hour/day per scope over the half-open
   [p_since, p_until) window, visible to the EFFECTIVE caller, narrowed by the
   optional scope + dimension filters (00063) plus the owner dimension (00064,
   `personal` / org slug). The eight text/tags/int dimension predicates come
   from lorekit_match_text / _tags / _int (00066) — the SAME predicates
   lorekit_memory_facets composes and the SAME behaviour GET /memories has, so
   the stat header agrees with the list. With no filters supplied the result is
   byte-for-byte 00051''s.';
