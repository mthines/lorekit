-- ═════════════════════════════════════════════════════════════════════════
-- 00114 — `exclude_tags`: "tagged a AND NOT tagged b".
--
-- THE GAP. A label filter is ONE condition: a list plus a mode — `all`
-- (containment), `any` (overlap) or `none` (no overlap). That can say "carries
-- perf", or "carries none of flaky", but never both at once, because the
-- second needs a different mode over a different list. The Explorer's detail
-- panel now offers "filter out" beside "filter in" on every tag chip, and a
-- reader who includes one label and excludes another expects both to hold.
--
-- THE CHANGE. One appended, null-defaulted parameter on each of the four
-- readers:
--
--     p_exclude_tags text[]   the row carries NONE of these labels
--
-- It is an independent conjunct — always ANDed, whatever `p_tags_mode` is —
-- and it reuses `lorekit_match_tags(…, 'none')`, so "carries none of" has
-- exactly one definition in the schema: NOT(overlap), never NOT(containment).
--
-- ── DESIGN ───────────────────────────────────────────────────────────────
--
-- NOT A NEW MODE. Folding the exclusion into `p_tags_mode` (an `all_except`,
-- say) would need a second value list on the same parameter, and would leave
-- `any` + exclusion inexpressible. A separate list composes with every mode.
--
-- THE TAG FACET NEVER SELF-EXCLUDES IT. Self-exclusion (00057) exists so a
-- drilled-in dimension keeps showing its alternatives: the count beside an
-- unselected label is what selecting it would yield. Selecting a label adds it
-- to the INCLUDE condition, and the result still carries none of the excluded
-- labels — so the exclusion belongs in every count, the tag facet's included.
-- It is a match flag there rather than a `base` predicate, so an excluded label
-- stays in the catalog at `count = 0` (00110's rule) and the menu can still
-- offer to un-exclude it. The pivot narrows `base` instead: a matrix emits no
-- zero cells, so the two are equivalent there.
--
-- A LONE EXCLUSION IS STILL `tags_mode => 'none'`. The dashboard only sends
-- `exclude_tags` when an include condition is ALSO active; on its own an
-- exclusion keeps travelling as it always has, so retention policies (which
-- never gain this parameter) and every existing link mean what they meant.
--
-- ── SIGNATURES ───────────────────────────────────────────────────────────
--
-- `create or replace` cannot change a signature, so each reader is dropped at
-- its EXACT 00113 argument list first and recreated with the parameter
-- appended — §108 and §113 assert exactly one overload of each survives.
--
-- §114 in `migrations.test.sql` is the executable proof.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. lorekit_memory_facets (00113 body + p_exclude_tags) ─────────────────

drop function if exists lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer
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
  p_min_opened_count   integer default null,
  -- 00114: labels the row must carry NONE of — an always-applied conjunct,
  -- independent of p_tags/p_tags_mode, so "tagged a AND NOT tagged b" is
  -- expressible. Appended, null-defaulted: null = not filtered.
  p_exclude_tags       text[]  default null
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
      -- 00114: `ok_tag` is the WHOLE tag predicate — the include condition AND
      -- the exclusion — because that is what every OTHER dimension's count must
      -- apply. The tag facet itself self-excludes the include condition (or
      -- folds it back in for co-occurrence) but never the exclusion, so it reads
      -- `ok_tag_exclusion` on its own.
      (lorekit_match_tags(m.tags, p_tags, p_tags_mode)
       and lorekit_match_tags(m.tags, p_exclude_tags, 'none'))                as ok_tag,
      lorekit_match_tags(m.tags,          p_exclude_tags,  'none')              as ok_tag_exclusion,
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
            and (not v_tag_cooccur or b.ok_tag)
            -- 00114: an excluded label is never self-excluded. Selecting another
            -- label still yields only rows carrying none of the excluded ones,
            -- and an excluded label stays listed at `count = 0` (00110's rule)
            -- rather than vanishing from the menu.
            and b.ok_tag_exclusion) as matched
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
  integer, integer, integer, integer,
  text[]) from public, anon;
grant execute on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer,
  text[]) to authenticated, service_role;

comment on function lorekit_memory_facets(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer,
  text[]) is
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
   is an upper bound. p_exclude_tags (00114) is an always-applied conjunct on
   every count, the tag facet''s included: never self-excluded, so an excluded
   label stays listed at count = 0.';

-- ── 2. lorekit_memory_activity (00113 body + p_exclude_tags) ───────────────

drop function if exists lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], integer, integer, integer, integer, integer,
  integer, integer, integer, integer
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
  p_min_opened_count   integer default null,
  -- 00114: labels the row must carry NONE of — an always-applied conjunct,
  -- independent of p_tags/p_tags_mode, so "tagged a AND NOT tagged b" is
  -- expressible. Appended, null-defaulted: null = not filtered.
  p_exclude_tags       text[]  default null
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
       and lorekit_match_tags(m.tags,          p_exclude_tags,  'none')
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
  integer, integer, integer, integer,
  text[]) from public, anon;
grant execute on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], integer, integer, integer, integer, integer,
  integer, integer, integer, integer,
  text[]) to authenticated, service_role;

comment on function lorekit_memory_activity(
  uuid, text, timestamptz, timestamptz, text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], integer, integer, integer, integer, integer,
  integer, integer, integer, integer,
  text[]) is
  'Memories created per UTC hour/day per scope, visible to the EFFECTIVE caller
   and narrowed by the calling key''s own scope/org restriction. Applies every
   dimension filter directly (no self-exclusion — this is a straight count),
   the five retention thresholds (00108) and the Explorer''s reverse directions
   (00113), so the Explorer''s stat cards describe the list beneath them.
   p_since/p_until already bound created_at, so no separate window parameter
   exists. p_exclude_tags (00114) is applied like every other filter.';

-- ── 3. lorekit_memory_pivot (00113 body + p_exclude_tags) ──────────────────

drop function if exists lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer
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
  p_min_opened_count   integer default null,
  -- 00114: labels the row must carry NONE of — an always-applied conjunct,
  -- independent of p_tags/p_tags_mode, so "tagged a AND NOT tagged b" is
  -- expressible. Appended, null-defaulted: null = not filtered.
  p_exclude_tags       text[]  default null
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
       -- 00114: in the population, not an axis-excludable `ok_*` flag — with a
       -- tag axis an excluded label must still yield no cell, and a matrix
       -- emits no zero cells, so narrowing `base` is the exact equivalent.
       and lorekit_match_tags(m.tags, p_exclude_tags, 'none')
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
  integer, integer, integer, integer,
  text[]) from public, anon;
grant execute on function lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer,
  text[]) to authenticated, service_role;

comment on function lorekit_memory_pivot(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer,
  text[]) is
  'Cross-tabulation of two facet dimensions with a count per cell, visible to
   the EFFECTIVE caller and narrowed by the calling key''s own scope/org
   restriction. BOTH axes are self-excluded from the dimension filters. The
   created_at window, the five retention thresholds (00108) and the Explorer''s
   reverse directions (00113) and p_exclude_tags (00114) are not self-excluded
   — they narrow the population, matching lorekit_memory_facets.';

-- ── 4. lorekit_memory_list (00113 body + p_exclude_tags) ───────────────────

drop function if exists lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer, integer
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
  p_cursor_count         integer     default null,
  -- 00114: labels the row must carry NONE of — an always-applied conjunct,
  -- independent of p_tags/p_tags_mode, so "tagged a AND NOT tagged b" is
  -- expressible. Appended, null-defaulted: null = not filtered.
  p_exclude_tags         text[]      default null
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
       and lorekit_match_tags(m.tags,          $45, 'none')
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
    p_cursor_count,
    p_exclude_tags;
end;
$$;

revoke execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer, integer,
  text[]) from public, anon;
grant execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer, integer,
  text[]) to authenticated, service_role;

comment on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer, integer,
  text[]) is
  'The keyset-paginated memory list behind GET /memories and POST /memories/list.
   Sorts by updated_at (default), created_at, or opened_count (00113) — each
   descending with id as the tie-break; p_cursor_ts carries the date sorts''
   keyset value and p_cursor_count the count sort''s. Applies the five retention
   thresholds and the Explorer''s reverse directions through the shared
   lorekit_match_retention, so its total_count agrees with _facets, _activity
   and _pivot under the same parameters. p_exclude_tags (00114): the row carries
   none of these labels, ANDed with whatever p_tags/p_tags_mode ask.';
