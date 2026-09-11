-- ═════════════════════════════════════════════════════════════════════════
-- 00110 — within-group facet counting: co-occurrence for AND mode, and a
-- stable (zero-stays) value set for every dimension.
--
-- THE BUG (two, related). `lorekit_memory_facets` (00108) counts each
-- dimension against every OTHER dimension's filter, self-excluding its own —
-- the drill-down convention that lets you widen or switch within the
-- dimension you are standing in. Two consequences of doing this
-- unconditionally:
--
--   1. Selecting a `label` in `all` (AND / "includes all") mode still
--      self-excluded the tag dimension, so every OTHER label's count ignored
--      the selection entirely rather than answering "how many memories carry
--      BOTH the selected label(s) AND this one" — the question an AND
--      selection actually poses.
--   2. A value that had ZERO matching rows under the active filters simply
--      never appeared: the old `cells` CTE filtered rows to the matching set
--      BEFORE grouping, so a value only visible on now-excluded rows vanished
--      from the menu instead of reading as `count: 0`. A vanishing option
--      reads as "this value no longer exists"; a `0` reads as "not with your
--      current selection" — the honest answer.
--
-- ── DESIGN (Decision D5) ─────────────────────────────────────────────────
--
-- `v_tag_cooccur := (p_tags_mode = 'all')` — co-occurrence is gated on AND
-- mode. It is meaningless for a scalar column (`host = X` intersected with
-- `host = Y` is always empty — a memory has one host) and wrong for OR
-- multi-select (there you want what ADDING a value yields, i.e. the current
-- self-exclusion), so every scalar dimension and every non-`all` tag mode
-- keep self-exclusion exactly as 00108 left it. Only the tag branch's OWN
-- flag (`b.ok_tag`) is conditionally folded back in.
--
-- Every branch now enumerates its full candidate set from `base` — the
-- unfiltered-by-dimension population `base` already restricts to
-- visibility / archived / tenant-scope / created-window / retention — and
-- computes its count with `count(*) filter (where <predicate>)`, so a value
-- with zero matching rows still gets a `group by` row (via the `cells` CTE's
-- unconditional membership) with `count = 0`, instead of being absent.
--
-- Response shape, RPC signature and grants are UNCHANGED (Decision D6) — only
-- the `cells` CTE's body and the final aggregation change from
-- "filter-then-group" to "group-then-filter-count". `migrations.test.sql`
-- §110 is the executable proof, including the AND vs. OR distinction and the
-- cross-group AND that must still narrow every dimension's counts.
-- ═════════════════════════════════════════════════════════════════════════

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
  v_created_cutoff timestamptz := case
    when p_min_age_days is null then null else now() - (p_min_age_days * interval '1 day')
  end;
  v_unseen_cutoff timestamptz := case
    when p_unseen_days is null then null else now() - (p_unseen_days * interval '1 day')
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
             v_created_cutoff, v_unseen_cutoff, p_max_seen_count, p_max_read_count, p_max_opened_count
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

-- Signature is IDENTICAL to 00108's — a true `create or replace`, no drop
-- needed, and the 00108 grants persist untouched. Comment refreshed to
-- describe the new within-group semantics.
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
   dimension is counted with every OTHER dimension filter applied (cross-group
   AND). WITHIN a dimension: self-exclusion (drill-down, 00057) for every
   scalar dimension and for label/tag in `in`/`nin` (OR) mode; CO-OCCURRENCE
   (intersection with the tag selection) for label/tag in `all` (AND) mode
   (00110). Every dimension enumerates its FULL value set so a value with zero
   matches under the active filters still returns `count = 0` instead of being
   omitted (00110). The created_at window and the five retention thresholds
   (00108) are NOT self-excluded: they narrow the population every facet value
   is drawn from, so a count matches the list under the same parameters.
   q/key/expiring_within_days remain unmirrored, so with those active a count
   is an upper bound.';
