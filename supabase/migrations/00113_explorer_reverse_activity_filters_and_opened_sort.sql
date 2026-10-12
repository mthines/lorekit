-- ═════════════════════════════════════════════════════════════════════════
-- 00113 — the Explorer's reverse directions, and a "most chosen" sort.
--
-- THE GAP. Every age/activity condition the four readers accept points ONE
-- way, because they were built for retention policies: `max_seen_count`,
-- `max_read_count`, `max_opened_count` ("N or fewer"), and `unseen_days`
-- ("not opened for N days"). Those are exactly the questions a groomer asks
-- before archiving. They cannot ask the opposite question — "which lessons are
-- used the MOST?", "what did an agent open this week?" — so the Explorer could
-- show you the dead weight but never the load-bearing lore.
--
-- THE CHANGE. Four more conditions, each the mirror of one that exists:
--
--     min_seen_count       written at least N times        (↔ max_seen_count)
--     min_read_count       delivered at least N times      (↔ max_read_count)
--     min_opened_count     deliberately fetched ≥ N times  (↔ max_opened_count)
--     opened_within_days   last fetched within N days      (↔ unseen_days)
--
-- plus `p_sort => 'opened_count'` on `lorekit_memory_list`, so "most chosen
-- first" is an ORDER rather than a threshold the reader has to guess.
--
-- They are READ conditions only. `GroomConditionsSchema` does not gain them and
-- no groom RPC is touched: archiving "everything chosen at least 10 times" is
-- not a retention policy anyone wants, and a policy that could express it would
-- be one careless edit away from archiving the most useful lore in the store.
--
-- ── DESIGN ───────────────────────────────────────────────────────────────
--
-- SAME HELPER, WIDENED. The four new conditions go into
-- `lorekit_match_retention` rather than a second helper, for the reason 00108
-- created it: every reader composes ONE predicate, so a count cannot disagree
-- with the list it describes (docs/decisions.md, "A COUNT must describe the
-- rows its LIST returns"). Its signature changes, so the 14-argument form is
-- created first, every caller is recreated against it, and the 10-argument
-- form is dropped last.
--
-- `opened_within_days` IS NOT `unseen_days` NEGATED. `unseen_days` ages a
-- never-opened lesson from `created_at` (00100) so that "unopened for 90 days"
-- can find the lore nothing ever touched. Applying that same fallback here
-- would make a lesson written yesterday and never opened match "opened within
-- 7 days" — a claim about an agent's behaviour that no agent made. So a null
-- `last_opened_at` never satisfies it.
--
-- THE FLOORS USE `>=` AND START AT THE FIRST VALUE THAT NARROWS at the API
-- (the schemas' bound): 1 for the read counters, since `>= 0` matches every
-- row, and 2 for `min_seen_count`, since `seen_count >= 1` is a table
-- constraint (00059). Accepting a no-op floor would put a pill on screen that
-- narrows nothing.
--
-- THE COUNT SORT GETS ITS OWN CURSOR PARAMETER. The keyset predicate compares
-- the sort column against the last row's value; the date sorts carry it in
-- `p_cursor_ts timestamptz`, and an integer column needs an integer bound, so
-- `p_cursor_count` is appended and the format() splices in whichever
-- placeholder ($29 or $44) the sort needs. Ties break on `id desc`, exactly as
-- the date sorts do, so a page boundary inside a run of equal counts is stable.
--
-- ── SIGNATURES ───────────────────────────────────────────────────────────
--
-- Appended, null-defaulted parameters on all four readers, so every existing
-- named-argument caller is unaffected. `create or replace` cannot change a
-- signature (00108's header), so each reader is dropped at its EXACT previous
-- argument list first — §108's AC-7 and §113 assert that exactly one overload
-- of each survives.
--
-- §113 in `migrations.test.sql` is the executable proof.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. The predicate, widened ───────────────────────────────────────────────

-- The five retention thresholds plus the Explorer's four reverse directions, as
-- one row-level test. Every parameter is independently optional (null = not
-- filtered), and all null is a constant `true` the planner discards.
--
-- `immutable` + `parallel safe` + `language sql` for 00108's reason: the result
-- depends only on the arguments, which is what lets the planner fold the call
-- into an index-usable expression. It still reads no clock — the caller
-- resolves `opened_within_days` to an instant exactly as it does the two
-- existing day counts.
create or replace function lorekit_match_retention(
  -- The row's own counters.
  p_created_at        timestamptz,
  p_last_opened_at    timestamptz,
  p_seen_count        integer,
  p_read_count        integer,
  p_opened_count      integer,
  -- The policy-expressible conditions (00108), day counts already resolved.
  p_created_cutoff    timestamptz,
  p_unseen_cutoff     timestamptz,
  p_max_seen_count    integer,
  p_max_read_count    integer,
  p_max_opened_count  integer,
  -- 00113: the Explorer's reverse directions. Never carried by a policy.
  p_opened_since      timestamptz,
  p_min_seen_count    integer,
  p_min_read_count    integer,
  p_min_opened_count  integer
)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(
    (p_created_cutoff is null or p_created_at <= p_created_cutoff)
    -- 00100: a lesson NEVER opened ages from its creation date, so the lore
    -- nothing ever opened is findable by an "unopened for N days" filter.
    and (p_unseen_cutoff is null or coalesce(p_last_opened_at, p_created_at) <= p_unseen_cutoff)
    -- `<=`, so a threshold of 0 is meaningful (00105).
    and (p_max_seen_count   is null or p_seen_count   <= p_max_seen_count)
    and (p_max_read_count   is null or p_read_count   <= p_max_read_count)
    and (p_max_opened_count is null or p_opened_count <= p_max_opened_count)
    -- 00113: deliberately WITHOUT 00100's fallback — a never-opened lesson was
    -- not "opened within N days", however recently it was written. Spelled out
    -- rather than left to the null comparison so the exclusion is visibly the
    -- intent and not an accident of three-valued logic.
    and (p_opened_since is null
         or (p_last_opened_at is not null and p_last_opened_at >= p_opened_since))
    and (p_min_seen_count   is null or p_seen_count   >= p_min_seen_count)
    and (p_min_read_count   is null or p_read_count   >= p_min_read_count)
    and (p_min_opened_count is null or p_opened_count >= p_min_opened_count),
    false);
$$;

comment on function lorekit_match_retention(
  timestamptz, timestamptz, integer, integer, integer,
  timestamptz, timestamptz, integer, integer, integer,
  timestamptz, integer, integer, integer
) is
  'Does a memory satisfy an age/activity condition set? The five thresholds of
   GroomConditionsSchema (00108) plus the Explorer''s four reverse directions
   (00113: opened-since cutoff, min seen/read/opened counts), as one inlinable
   row test shared by lorekit_memory_list, _facets, _activity and _pivot so a
   count cannot disagree with the list it describes. Takes CUTOFF INSTANTS
   rather than day counts so it stays immutable and reads no clock. A null
   argument is "not filtered". Holds 00100''s never-opened rule for unseen
   days, and deliberately NOT for opened-since: a never-opened lesson was not
   opened recently.';

-- The family's ACL (00066/00108): a NEW function starts from EXECUTE-to-public,
-- and Supabase's default privileges grant `anon` separately (00077).
revoke execute on function lorekit_match_retention(
  timestamptz, timestamptz, integer, integer, integer,
  timestamptz, timestamptz, integer, integer, integer,
  timestamptz, integer, integer, integer
) from public, anon;
grant  execute on function lorekit_match_retention(
  timestamptz, timestamptz, integer, integer, integer,
  timestamptz, timestamptz, integer, integer, integer,
  timestamptz, integer, integer, integer
) to authenticated, service_role;

-- ── 2. lorekit_memory_facets (00110 body) ─────────────────────────────────

drop function if exists lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer
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
  p_max_opened_count   integer default null,
  -- 00113: the Explorer's reverse directions — "opened within N days" and the
  -- three "at least N" floors. Appended, null-defaulted. Read routes only: a
  -- retention policy cannot carry them.
  p_opened_within_days integer default null,
  p_min_seen_count     integer default null,
  p_min_read_count     integer default null,
  p_min_opened_count   integer default null
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
  v_created_cutoff timestamptz := case
    when p_min_age_days is null then null else now() - (p_min_age_days * interval '1 day')
  end;
  v_unseen_cutoff timestamptz := case
    when p_unseen_days is null then null else now() - (p_unseen_days * interval '1 day')
  end;
  -- 00113: the "opened within N days" lower bound, resolved once per call for
  -- the same reason as the two cutoffs above.
  v_opened_since timestamptz := case
    when p_opened_within_days is null then null else now() - (p_opened_within_days * interval '1 day')
  end;
  -- 00110: only `label`/tag has an `all` (AND / set-containment) mode — see
  -- the module header. Every other dimension, and the tag facet in `in`/`nin`
  -- mode, keep self-exclusion (unchanged).
  v_tag_cooccur boolean := (p_tags_mode = 'all');
begin
  return query
  with base as (
    select
      m.tags, m.source_agent, m.trigger, m.kind, m.host,
      m.origin_repo, m.origin_branch, m.origin_pr,
      m.org_id, o.slug as org_slug,
      -- Per-dimension match flag, from the shared predicates so it cannot
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
             v_created_cutoff, v_unseen_cutoff, p_max_seen_count, p_max_read_count, p_max_opened_count,
             v_opened_since, p_min_seen_count, p_min_read_count, p_min_opened_count
           )
  ), cells as (
    -- 00110: every branch now scans the FULL `base` population (not just rows
    -- that already satisfy the other flags) and carries a `matched` boolean
    -- instead of a row-level WHERE — the `group by` below therefore enumerates
    -- every value the dimension has, and the final `count` reflects only the
    -- ones actually matching. This is what keeps a non-matching value at
    -- `count = 0` instead of dropping it.
    select 'tag'::text as facet, t.tag as value,
           (b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
            and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner
            -- Co-occurrence: fold the tag dimension's OWN flag back in only in
            -- `all` mode, so another label's count becomes "carries the
            -- selection AND this label" rather than the plain self-excluded
            -- total. `not v_tag_cooccur` keeps `in`/`nin` mode's existing
            -- self-exclusion untouched.
            and (not v_tag_cooccur or b.ok_tag)) as matched
      from base b
      cross join lateral unnest(b.tags) as t(tag)
    union all
    select 'source_agent', b.source_agent,
           (b.ok_tag and b.ok_trigger and b.ok_kind and b.ok_host
            and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner)
      from base b
     where b.source_agent is not null
    union all
    select 'trigger', b.trigger,
           (b.ok_tag and b.ok_source_agent and b.ok_kind and b.ok_host
            and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner)
      from base b
     where b.trigger is not null
    union all
    select 'kind', b.kind,
           (b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_host
            and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner)
      from base b
     where b.kind is not null
    union all
    select 'host', b.host,
           (b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind
            and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner)
      from base b
     where b.host is not null
    union all
    select 'origin_repo', b.origin_repo,
           (b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
            and b.ok_origin_branch and b.ok_origin_pr and b.ok_owner)
      from base b
     where b.origin_repo is not null
    union all
    select 'origin_branch', b.origin_branch,
           (b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
            and b.ok_origin_repo and b.ok_origin_pr and b.ok_owner)
      from base b
     where b.origin_branch is not null
    union all
    select 'origin_pr', b.origin_pr::text,
           (b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
            and b.ok_origin_repo and b.ok_origin_branch and b.ok_owner)
      from base b
     where b.origin_pr is not null
    union all
    -- Owner is the ONE dimension self-excluded here (every other flag, NOT
    -- ok_owner), so a drilled-in owner still lists the alternative owner.
    select 'owner', case when b.org_id is null then 'personal' else b.org_slug end,
           (b.ok_tag and b.ok_source_agent and b.ok_trigger and b.ok_kind and b.ok_host
            and b.ok_origin_repo and b.ok_origin_branch and b.ok_origin_pr)
      from base b
  )
  select c.facet, c.value, count(*) filter (where c.matched) as count
    from cells c
   where c.value is not null
     and btrim(c.value) <> ''
   group by c.facet, c.value
   order by c.facet asc, count(*) filter (where c.matched) desc, c.value asc;
end;
$$;

revoke execute on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer
) from public, anon;
grant execute on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer
) to authenticated, service_role;

comment on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer
) is
  'Value catalog with counts for every filterable memory dimension (tag,
   source_agent, trigger, kind, host, origin_repo, origin_branch, origin_pr,
   owner) over the partition selected by p_archived, visible to the EFFECTIVE
   caller and narrowed by the calling key''s own scope/org restriction. Each
   dimension is counted with every OTHER dimension filter applied (cross-group
   AND). WITHIN a dimension: self-exclusion (drill-down, 00057) for every
   scalar dimension and for label/tag in `in`/`nin` (OR) mode; CO-OCCURRENCE
   for label/tag in `all` (AND) mode (00110). Every dimension enumerates its
   FULL value set so a value with zero matches still returns `count = 0`
   (00110). The created_at window, the five retention thresholds (00108) and
   the Explorer''s reverse directions (00113: opened_within_days and the three
   min_* floors) are NOT self-excluded: they narrow the population every facet
   value is drawn from, so a count matches the list under the same parameters.
   q/key/expiring_within_days remain unmirrored, so with those active a count
   is an upper bound.';

-- ── 3. lorekit_memory_activity (00108 body) ───────────────────────────────

drop function if exists lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], integer, integer, integer, integer, integer
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
  p_max_opened_count   integer default null,
  -- 00113: the Explorer's reverse directions — "opened within N days" and the
  -- three "at least N" floors. Appended, null-defaulted. Read routes only: a
  -- retention policy cannot carry them.
  p_opened_within_days integer default null,
  p_min_seen_count     integer default null,
  p_min_read_count     integer default null,
  p_min_opened_count   integer default null
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
  -- 00113: the "opened within N days" lower bound, resolved once per call for
  -- the same reason as the two cutoffs above.
  v_opened_since timestamptz := case
    when p_opened_within_days is null then null else now() - (p_opened_within_days * interval '1 day')
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
             v_created_cutoff, v_unseen_cutoff, p_max_seen_count, p_max_read_count, p_max_opened_count,
             v_opened_since, p_min_seen_count, p_min_read_count, p_min_opened_count
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
  text[], text, uuid[], integer, integer, integer, integer, integer,
  integer, integer, integer, integer
) from public, anon;
grant execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], integer, integer, integer, integer, integer,
  integer, integer, integer, integer
) to authenticated, service_role;

comment on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], integer, integer, integer, integer, integer,
  integer, integer, integer, integer
) is
  'Memories created per UTC hour/day per scope, visible to the EFFECTIVE caller
   and narrowed by the calling key''s own scope/org restriction. Applies every
   dimension filter directly (no self-exclusion — this is a straight count),
   the five retention thresholds (00108) and the Explorer''s reverse directions
   (00113), so the Explorer''s stat cards describe the list beneath them.
   p_since/p_until already bound created_at, so no separate window parameter
   exists.';

-- ── 4. lorekit_memory_pivot (00108 body) ──────────────────────────────────

drop function if exists lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer
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
  p_max_opened_count   integer default null,
  -- 00113: the Explorer's reverse directions — "opened within N days" and the
  -- three "at least N" floors. Appended, null-defaulted. Read routes only: a
  -- retention policy cannot carry them.
  p_opened_within_days integer default null,
  p_min_seen_count     integer default null,
  p_min_read_count     integer default null,
  p_min_opened_count   integer default null
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
  -- 00113: the "opened within N days" lower bound, resolved once per call for
  -- the same reason as the two cutoffs above.
  v_opened_since timestamptz := case
    when p_opened_within_days is null then null else now() - (p_opened_within_days * interval '1 day')
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
             v_created_cutoff, v_unseen_cutoff, p_max_seen_count, p_max_read_count, p_max_opened_count,
             v_opened_since, p_min_seen_count, p_min_read_count, p_min_opened_count
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
  integer, integer,
  integer, integer, integer, integer
) from public, anon;
grant execute on function lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer
) to authenticated, service_role;

comment on function lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer
) is
  'Cross-tabulation of two facet dimensions with a count per cell, visible to
   the EFFECTIVE caller and narrowed by the calling key''s own scope/org
   restriction. BOTH axes are self-excluded from the dimension filters. The
   created_at window, the five retention thresholds (00108) and the Explorer''s
   reverse directions (00113) are not self-excluded — they narrow the
   population, matching lorekit_memory_facets.';

-- ── 5. lorekit_memory_list (00108 body) ───────────────────────────────────
--
-- The signature changes (four filters + the integer cursor), so unlike 00108
-- this is a drop-and-create. 00105 recreated it with a bare `grant`, which
-- left the default-privilege EXECUTE for `anon` in place (00077's subject);
-- the revoke below restores what 00092/00094 established and what its three
-- siblings carry. It returns nothing to anon either way — the visibility
-- predicate admits no row for a null actor — but a security-definer reader
-- reachable from the anonymous surface is a difference nobody should have to
-- re-derive.

drop function if exists lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer
);

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
  p_max_opened_count     integer     default null,
  -- 00113: the Explorer's reverse directions, appended and null-defaulted.
  p_opened_within_days   integer     default null,
  p_min_seen_count       integer     default null,
  p_min_read_count       integer     default null,
  p_min_opened_count     integer     default null,
  -- 00113: the keyset cursor for `p_sort => 'opened_count'`. An integer sort
  -- needs an integer cursor; `p_cursor_ts` keeps serving the two date sorts.
  p_cursor_count         integer     default null
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
  -- 00113: `opened_count` joins the two date sorts. Anything else still falls
  -- back to `updated_at`, so an unknown value cannot reach the format() below.
  v_sort text := case
    when p_sort in ('created_at', 'opened_count') then p_sort else 'updated_at'
  end;
  -- Which bound parameter carries the keyset value: the integer cursor ($44)
  -- for the count sort, the timestamp cursor ($29) for the date sorts. A fixed
  -- placeholder chosen here, never caller text, so splicing it is safe.
  v_cursor text := case when v_sort = 'opened_count' then '$44' else '$29' end;
  -- Resolved once per call so lorekit_match_retention stays immutable (00108).
  v_created_cutoff timestamptz := case
    when p_min_age_days is null then null else now() - (p_min_age_days * interval '1 day')
  end;
  v_unseen_cutoff timestamptz := case
    when p_unseen_days is null then null else now() - (p_unseen_days * interval '1 day')
  end;
  -- 00113: the "opened within N days" lower bound, resolved once per call for
  -- the same reason as the two cutoffs above.
  v_opened_since timestamptz := case
    when p_opened_within_days is null then null else now() - (p_opened_within_days * interval '1 day')
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
             $35, $36, $37, $38, $39,
             $40, $41, $42, $43
           )
       and (
             %2$s is null
             or m.%1$I < %2$s
             or (m.%1$I = %2$s and m.id < $30)
           )
     order by m.%1$I desc, m.id desc
     limit $31
  $q$, v_sort, v_cursor)
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
    p_max_opened_count,
    v_opened_since, p_min_seen_count, p_min_read_count, p_min_opened_count,
    p_cursor_count;
end;
$$;

revoke execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer, integer
) from public, anon;
grant execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer, integer
) to authenticated, service_role;

comment on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer, integer
) is
  'The keyset-paginated memory list behind GET /memories and POST /memories/list.
   Sorts by updated_at (default), created_at, or opened_count (00113) — each
   descending with id as the tie-break; p_cursor_ts carries the date sorts''
   keyset value and p_cursor_count the count sort''s. Applies the five retention
   thresholds and the Explorer''s reverse directions through the shared
   lorekit_match_retention, so its total_count agrees with _facets, _activity
   and _pivot under the same parameters.';

-- ── 6. Retire the 10-argument helper ─────────────────────────────────────
--
-- Last, once every caller above composes the 14-argument form. The callers
-- are plpgsql, whose bodies are resolved at call time and carry no catalog
-- dependency, so nothing blocks the drop; leaving it would be a second
-- predicate for someone to call by mistake.
drop function if exists lorekit_match_retention(
  timestamptz, timestamptz, integer, integer, integer,
  timestamptz, timestamptz, integer, integer, integer
);
