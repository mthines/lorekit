-- ═════════════════════════════════════════════════════════════════════════
-- 00108 — the retention conditions reach the AGGREGATE reads, not just the list.
--
-- THE BUG. `lorekit_memory_list` has accepted the five retention thresholds
-- since 00105 (`p_min_age_days`, `p_unseen_days`, `p_max_seen_count`,
-- `p_max_read_count`, `p_max_opened_count`). The three functions that COUNT the
-- same population did not:
--
--     lorekit_memory_facets     the filter menu's per-value counts
--     lorekit_memory_activity   the Explorer's five stat cards
--     lorekit_memory_pivot      the Explorer's matrix
--
-- So setting any threshold moved the list and left every number describing it
-- unchanged. A user filtering to "never opened, older than 5 days" saw a short
-- list above a menu still offering `source::manual 150` — a count for a
-- population that filter had already excluded. The dimension filters were
-- always mirrored (00057/00064/00069), which is why the discrepancy read as a
-- facet bug rather than a missing parameter: a label pill moved the counts, a
-- threshold did not.
--
-- The `created_since`/`created_until` window had the identical gap and is fixed
-- with it. `lorekit_memory_activity` needs no new window — its own
-- `p_since`/`p_until` already bound `created_at`.
--
-- `q`, `p_key` and `expiring_within_days` stay unmirrored, for the reason
-- `ListFacetsQuerySchema` records: mirroring `q` means a second LIKE-escaper
-- inside plpgsql and mirroring `expiring_within_days` a second `now`-relative
-- boundary. A filter value is encoded exactly one way in this repo. The
-- thresholds carry no such cost — see the helper below.
--
-- ── DESIGN ───────────────────────────────────────────────────────────────
--
-- ONE HELPER, `lorekit_match_retention`, in 00066's inlinable-predicate family
-- (`lorekit_match_text` / `_tags` / `_int`). Four callers had five nearly
-- identical `and (p_x is null or …)` lines each; they now have one call each,
-- and migration 00100's never-opened rule — `coalesce(last_opened_at,
-- created_at)`, so a lesson nobody has EVER opened ages from its creation
-- rather than being immune — lives in exactly one place instead of four.
--
-- IT TAKES CUTOFF TIMESTAMPS, NOT DAY COUNTS. `now() - (n * interval '1 day')`
-- inside the helper would make it `stable` rather than `immutable`, costing the
-- inlining that keeps callers on index access, and would read the clock once
-- per ROW instead of once per call. Each caller resolves its own cutoffs in its
-- declare block, so the `now`-relative boundary is still computed exactly once
-- per query — the same discipline the unmirrored `expiring_within_days`
-- argument above is protecting.
--
-- IN THE `base` CTE's WHERE, NEVER AN `ok_*` SELF-EXCLUSION FLAG. `facets` and
-- `pivot` count each dimension with every OTHER filter applied but not its own,
-- so that a value's count is what selecting it would yield. That trick is
-- meaningful only for a dimension the caller can select a value FROM. A
-- threshold has no value catalog — "count this threshold with every filter but
-- itself" describes nothing — so it belongs in the row-visibility predicate
-- every facet value is derived from, alongside `p_scope` and `p_archived`.
--
-- ── SIGNATURES ───────────────────────────────────────────────────────────
--
-- The new parameters are APPENDED, null-defaulted, following 00101/00105. That
-- changes each function's signature, and `create or replace` CANNOT change a
-- signature — it would leave the old overload in place beside the new one, and
-- two overloads make every PostgREST named-argument call to that name fail as
-- ambiguous (the footgun 00092's header documents). So each of the three is
-- dropped at its EXACT old signature first.
--
-- `lorekit_memory_list` keeps its 00105 signature verbatim — only its body
-- changes, to compose the helper in place of its five inline lines — so it is a
-- true `create or replace` with no drop and its grants persist.
--
-- §108 in `migrations.test.sql` is the executable proof, including the case
-- that motivated the whole change: a threshold that narrows the list must
-- narrow the facet counts by the same rows.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. The predicate ────────────────────────────────────────────────────────

-- The five retention thresholds as one row-level test.
--
-- Every parameter is independently optional: a null threshold is "not
-- filtered" and matches everything, so an untouched condition never narrows.
-- All five null (the overwhelmingly common case) is a constant `true` the
-- planner discards.
--
-- `immutable` + `parallel safe` + `language sql`, exactly as 00066's three
-- helpers, and for the same two reasons: the result depends only on the
-- arguments, and that is what lets the planner fold the call into an
-- index-usable expression rather than treating it as an opaque filter.
create or replace function lorekit_match_retention(
  -- The row's own counters.
  p_created_at        timestamptz,
  p_last_opened_at    timestamptz,
  p_seen_count        integer,
  p_read_count        integer,
  p_opened_count      integer,
  -- The filter, with both day counts already resolved to absolute instants by
  -- the caller. Null = that condition is not applied.
  p_created_cutoff    timestamptz,
  p_unseen_cutoff     timestamptz,
  p_max_seen_count    integer,
  p_max_read_count    integer,
  p_max_opened_count  integer
)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(
    (p_created_cutoff is null or p_created_at <= p_created_cutoff)
    -- 00100: a lesson NEVER opened ages from its creation date. Without the
    -- coalesce a null `last_opened_at` makes the comparison NULL, which
    -- excludes the row — so the lore nothing has ever opened would be the one
    -- lore an "unopened for N days" filter could never find.
    and (p_unseen_cutoff is null or coalesce(p_last_opened_at, p_created_at) <= p_unseen_cutoff)
    -- `<=`, so a threshold of 0 is meaningful: `max_opened_count => 0` is
    -- "nothing ever chose to open it" (00105), not "no filter".
    and (p_max_seen_count   is null or p_seen_count   <= p_max_seen_count)
    and (p_max_read_count   is null or p_read_count   <= p_max_read_count)
    and (p_max_opened_count is null or p_opened_count <= p_max_opened_count),
    false);
$$;

comment on function lorekit_match_retention(
  timestamptz, timestamptz, integer, integer, integer,
  timestamptz, timestamptz, integer, integer, integer
) is
  'Does a memory satisfy a retention-policy condition set? The five thresholds
   of GroomConditionsSchema, as one inlinable row test shared by
   lorekit_memory_list, _facets, _activity and _pivot so a count cannot
   disagree with the list it describes (00108). Takes CUTOFF INSTANTS rather
   than day counts so it stays immutable and reads no clock: the caller
   resolves now()-relative bounds once per query. A null threshold is "not
   filtered". Holds migration 00100''s never-opened rule
   (coalesce(last_opened_at, created_at)) in one place.';

-- The same revoke/grant pair 00066's three helpers carry. A `create or replace`
-- of a NEW function starts from the default ACL, which is EXECUTE to public —
-- so without this line the helper would be the one member of the
-- `lorekit_match_*` family reachable by `anon`. It reads no table and would
-- leak nothing, but a predicate helper with a different ACL from its three
-- siblings is a difference someone has to re-derive later.
revoke execute on function lorekit_match_retention(
  timestamptz, timestamptz, integer, integer, integer,
  timestamptz, timestamptz, integer, integer, integer
) from public, anon;
grant  execute on function lorekit_match_retention(
  timestamptz, timestamptz, integer, integer, integer,
  timestamptz, timestamptz, integer, integer, integer
) to authenticated, service_role;

-- ── 2. lorekit_memory_facets ────────────────────────────────────────────────

drop function if exists lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
);

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
  p_owner_mode         text    default 'in',
  -- The CALLING KEY's restriction (00068), defaulted to unrestricted.
  p_key_scopes         text[]  default '{}',
  p_key_org_access     text    default 'all',
  p_key_org_ids        uuid[]  default '{}',
  -- 00108: the created_at window and the five retention thresholds, so a count
  -- describes the same rows the list shows. Appended, null-defaulted.
  p_created_since      timestamptz default null,
  p_created_until      timestamptz default null,
  p_min_age_days       integer default null,
  p_unseen_days        integer default null,
  p_max_seen_count     integer default null,
  p_max_read_count     integer default null,
  p_max_opened_count   integer default null
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
  -- Resolved ONCE per call, so lorekit_match_retention can stay immutable and
  -- the clock is read once rather than once per row (00108).
  v_created_cutoff timestamptz := case
    when p_min_age_days is null then null else now() - (p_min_age_days * interval '1 day')
  end;
  v_unseen_cutoff timestamptz := case
    when p_unseen_days is null then null else now() - (p_unseen_days * interval '1 day')
  end;
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
       -- The calling key's restriction, applied ONCE here in the row-visibility
       -- predicate every emitted facet value is derived from — `origin_repo` is
       -- a repository name by construction, so an unnarrowed facet list leaks
       -- exactly what the scope catalog hides.
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
       -- 00108. Here rather than as an `ok_*` flag: these narrow the population
       -- every facet value is drawn from, they are not a dimension that can be
       -- self-excluded. Half-open window, matching lorekit_memory_list.
       and (p_created_since is null or m.created_at >= p_created_since)
       and (p_created_until is null or m.created_at <  p_created_until)
       and lorekit_match_retention(
             m.created_at, m.last_opened_at, m.seen_count, m.read_count, m.opened_count,
             v_created_cutoff, v_unseen_cutoff, p_max_seen_count, p_max_read_count, p_max_opened_count
           )
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
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer
) from public, anon;
grant execute on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer
) to authenticated, service_role;

comment on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer
) is
  'Value catalog with counts for every filterable memory dimension (tag,
   source_agent, trigger, kind, host, origin_repo, origin_branch, origin_pr,
   owner) over the partition selected by p_archived, visible to the EFFECTIVE
   caller and narrowed by the calling key''s own scope/org restriction. Each
   dimension is counted with every OTHER dimension filter applied but not its
   own (drill-down self-exclusion, 00057). The created_at window and the five
   retention thresholds (00108) are NOT self-excluded: they narrow the
   population every facet value is drawn from, so a count matches the list
   under the same parameters. q/key/expiring_within_days remain unmirrored, so
   with those active a count is an upper bound.';

-- ── 3. lorekit_memory_activity ──────────────────────────────────────────────

drop function if exists lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
);

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
  p_owner              text[] default null,
  p_owner_mode         text   default 'in',
  -- The CALLING KEY's restriction (00068), defaulted to unrestricted.
  p_key_scopes         text[] default '{}',
  p_key_org_access     text   default 'all',
  p_key_org_ids        uuid[] default '{}',
  -- 00108: the five retention thresholds. No created_at window is added — this
  -- function's own p_since/p_until already bound created_at, and a second
  -- window would be two ways to say one thing.
  p_min_age_days       integer default null,
  p_unseen_days        integer default null,
  p_max_seen_count     integer default null,
  p_max_read_count     integer default null,
  p_max_opened_count   integer default null
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
  v_created_cutoff timestamptz := case
    when p_min_age_days is null then null else now() - (p_min_age_days * interval '1 day')
  end;
  v_unseen_cutoff timestamptz := case
    when p_unseen_days is null then null else now() - (p_unseen_days * interval '1 day')
  end;
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
       -- The calling key's own restriction, ANDed on top of the caller's
       -- visibility and never instead of it (the lorekit_memory_scopes rule).
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
       and lorekit_api_token_org_allowed(p_key_org_access, p_key_org_ids, m.org_id)
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
       -- 00108: the same thresholds the list applies, so the Explorer's stat
       -- cards describe the rows underneath them.
       and lorekit_match_retention(
             m.created_at, m.last_opened_at, m.seen_count, m.read_count, m.opened_count,
             v_created_cutoff, v_unseen_cutoff, p_max_seen_count, p_max_read_count, p_max_opened_count
           )
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
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], integer, integer, integer, integer, integer
) from public, anon;
grant execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], integer, integer, integer, integer, integer
) to authenticated, service_role;

comment on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], integer, integer, integer, integer, integer
) is
  'Memories created per UTC hour/day per scope, visible to the EFFECTIVE caller
   and narrowed by the calling key''s own scope/org restriction. Applies every
   dimension filter directly (no self-exclusion — this is a straight count) and,
   since 00108, the same five retention thresholds lorekit_memory_list applies,
   so the Explorer''s stat cards describe the list beneath them. p_since/p_until
   already bound created_at, so no separate window parameter exists.';

-- ── 4. lorekit_memory_pivot ─────────────────────────────────────────────────

drop function if exists lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[]
);

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
  p_key_org_ids        uuid[]  default '{}',
  -- 00108: the created_at window and the five retention thresholds.
  p_created_since      timestamptz default null,
  p_created_until      timestamptz default null,
  p_min_age_days       integer default null,
  p_unseen_days        integer default null,
  p_max_seen_count     integer default null,
  p_max_read_count     integer default null,
  p_max_opened_count   integer default null
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
  v_created_cutoff timestamptz := case
    when p_min_age_days is null then null else now() - (p_min_age_days * interval '1 day')
  end;
  v_unseen_cutoff timestamptz := case
    when p_unseen_days is null then null else now() - (p_unseen_days * interval '1 day')
  end;
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
       -- 00108. Row-visibility, not an `ok_*` flag — see lorekit_memory_facets.
       and (p_created_since is null or m.created_at >= p_created_since)
       and (p_created_until is null or m.created_at <  p_created_until)
       and lorekit_match_retention(
             m.created_at, m.last_opened_at, m.seen_count, m.read_count, m.opened_count,
             v_created_cutoff, v_unseen_cutoff, p_max_seen_count, p_max_read_count, p_max_opened_count
           )
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
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer
) from public, anon;
grant execute on function lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer
) to authenticated, service_role;

comment on function lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer
) is
  'Cross-tabulation of two facet dimensions with a count per cell, visible to
   the EFFECTIVE caller and narrowed by the calling key''s own scope/org
   restriction. BOTH axes are self-excluded from the dimension filters, so a
   caller that turns a cell into a filter still gets every other cell back. The
   created_at window and the five retention thresholds (00108) are not
   self-excluded — they narrow the population, matching lorekit_memory_facets.';

-- ── 5. lorekit_memory_list — compose the helper, signature unchanged ────────
--
-- A true `create or replace`: the 00105 signature is kept VERBATIM, so no drop
-- is needed and the 00105 grants persist. Only the five inline threshold lines
-- change, into one call, which is what puts 00100's never-opened rule in one
-- place across all four functions. `$35`/`$36` now carry resolved CUTOFFS
-- rather than day counts — the parameter list and every position are
-- unchanged, so no caller moves.
create or replace function lorekit_memory_list(
  p_user_id              uuid,
  p_archived             boolean     default false,
  p_scope                text        default null,
  p_key                  text        default null,
  p_key_prefix           text        default null,
  p_q                    text        default null,
  p_created_since        timestamptz default null,
  p_created_until        timestamptz default null,
  p_expires_after        timestamptz default null,
  p_expires_on_or_before timestamptz default null,
  p_tags                 text[]      default null,
  p_tags_mode            text        default 'any',
  p_source_agent         text[]      default null,
  p_source_agent_mode    text        default 'in',
  p_trigger              text[]      default null,
  p_trigger_mode         text        default 'in',
  p_kind                 text[]      default null,
  p_kind_mode            text        default 'in',
  p_host                 text[]      default null,
  p_host_mode            text        default 'in',
  p_origin_repo          text[]      default null,
  p_origin_repo_mode     text        default 'in',
  p_origin_branch        text[]      default null,
  p_origin_branch_mode   text        default 'in',
  p_origin_pr            text[]      default null,
  p_origin_pr_mode       text        default 'in',
  p_owner                text[]      default null,
  p_owner_mode           text        default 'in',
  p_sort                 text        default 'updated_at',
  p_cursor_ts            timestamptz default null,
  p_cursor_id            uuid        default null,
  p_limit                integer     default 51,
  p_key_scopes           text[]      default '{}',
  p_key_org_access       text        default 'all',
  p_key_org_ids          uuid[]      default '{}',
  p_min_age_days         integer     default null,
  p_unseen_days          integer     default null,
  p_max_seen_count       integer     default null,
  p_max_read_count       integer     default null,
  p_max_opened_count     integer     default null
)
returns table (
  id             uuid,
  scope          text,
  key            text,
  value          text,
  tags           text[],
  source_agent   text,
  trigger        text,
  created_at     timestamptz,
  updated_at     timestamptz,
  expires_at     timestamptz,
  archived_at    timestamptz,
  origin_repo    text,
  origin_branch  text,
  origin_commit  text,
  origin_pr      integer,
  kind           text,
  host           text,
  seen_count     integer,
  read_count     integer,
  opened_count   integer,
  last_read_at   timestamptz,
  last_opened_at timestamptz,
  org_id         uuid,
  created_by     uuid,
  updated_by     uuid,
  org_name       text,
  org_slug       text,
  total_count    integer
)
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
     where x ~ '^0*[0-9]{1,9}$'
  );
  v_sort text := case when p_sort = 'created_at' then 'created_at' else 'updated_at' end;
  -- Resolved once per call so lorekit_match_retention stays immutable (00108).
  v_created_cutoff timestamptz := case
    when p_min_age_days is null then null else now() - (p_min_age_days * interval '1 day')
  end;
  v_unseen_cutoff timestamptz := case
    when p_unseen_days is null then null else now() - (p_unseen_days * interval '1 day')
  end;
begin
  return query execute format($q$
    select
      m.id, m.scope, m.key, m.value, m.tags, m.source_agent, m.trigger,
      m.created_at, m.updated_at, m.expires_at, m.archived_at,
      m.origin_repo, m.origin_branch, m.origin_commit, m.origin_pr,
      m.kind, m.host, m.seen_count,
      m.read_count, m.opened_count, m.last_read_at, m.last_opened_at,
      m.org_id, m.created_by, m.updated_by,
      o.name as org_name, o.slug as org_slug,
      (count(*) over ())::integer as total_count
      from memories m
      left join orgs o on o.id = m.org_id
     where (
             ($1 is null and auth.role() = 'service_role')
             or m.user_id = $1
             or m.org_id in (select lorekit_member_org_ids($1))
           )
       and lorekit_api_token_scope_allowed($32, m.scope)
       and lorekit_api_token_org_allowed($33, $34, m.org_id)
       and (
             case
               when $2 then m.archived_at is not null
               else m.archived_at is null
                    and (m.expires_at is null or m.expires_at > now())
             end
           )
       and ($3 is null or m.scope = $3)
       and ($4 is null or m.key = $4)
       and ($5 is null or m.key ilike $5 || '%%')
       and ($6 is null or m.key ilike '%%' || $6 || '%%' or m.value ilike '%%' || $6 || '%%')
       and ($7 is null or m.created_at >= $7)
       and ($8 is null or m.created_at < $8)
       and ($9  is null or m.expires_at > $9)
       and ($10 is null or m.expires_at <= $10)
       and lorekit_match_tags(m.tags,          $11, $12)
       and lorekit_match_text(m.source_agent,  $13, $14)
       and lorekit_match_text(m.trigger,       $15, $16)
       and lorekit_match_text(m.kind,          $17, $18)
       and lorekit_match_text(m.host,          $19, $20)
       and lorekit_match_text(m.origin_repo,   $21, $22)
       and lorekit_match_text(m.origin_branch, $23, $24)
       and lorekit_match_int (m.origin_pr,     $25, $26)
       and ($27 is null or case coalesce($28, 'in')
             when 'nin' then (
               (case when m.org_id is null then 'personal' else o.slug end) is not null
               and (case when m.org_id is null then 'personal' else o.slug end) <> all($27)
             )
             else (
               ('personal' = any($27) and m.org_id is null)
               or (m.org_id is not null and o.slug = any($27))
             )
           end)
       and lorekit_match_retention(
             m.created_at, m.last_opened_at, m.seen_count, m.read_count, m.opened_count,
             $35, $36, $37, $38, $39
           )
       and (
             $29 is null
             or m.%1$I < $29
             or (m.%1$I = $29 and m.id < $30)
           )
     order by m.%1$I desc, m.id desc
     limit $31
  $q$, v_sort)
  using
    v_actor, coalesce(p_archived, false), p_scope, p_key, p_key_prefix, p_q,
    p_created_since, p_created_until, p_expires_after, p_expires_on_or_before,
    p_tags, p_tags_mode,
    p_source_agent, p_source_agent_mode,
    p_trigger, p_trigger_mode,
    p_kind, p_kind_mode,
    p_host, p_host_mode,
    p_origin_repo, p_origin_repo_mode,
    p_origin_branch, p_origin_branch_mode,
    v_origin_pr, p_origin_pr_mode,
    p_owner, p_owner_mode,
    p_cursor_ts, p_cursor_id,
    greatest(coalesce(p_limit, 51), 1),
    coalesce(p_key_scopes, '{}'::text[]),
    coalesce(p_key_org_access, 'all'),
    coalesce(p_key_org_ids, '{}'::uuid[]),
    v_created_cutoff, v_unseen_cutoff, p_max_seen_count, p_max_read_count,
    p_max_opened_count;
end;
$$;

grant execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer
) to authenticated, service_role;
