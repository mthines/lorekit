-- ═════════════════════════════════════════════════════════════════════════
-- 00117 — `lorekit_memory_facet_catalog`: the facet catalog as ONE value, so
-- PostgREST's row cap cannot cut it.
--
-- THE BUG. `GET`/`POST /memories/facets` read `lorekit_memory_facets`, a
-- set-returning function, through PostgREST. PostgREST caps every set it
-- returns at `max_rows` (1000 — supabase/config.toml), silently: no error, no
-- header the edge handler checks, just the first 1000 rows. The function
-- orders its rows `facet asc`, and `tag` and `trigger` sort LAST of the nine
-- dimensions, so they are the ones that fall off. In production every facets
-- response for a large account came back with exactly 1000 rows, and the
-- Explorer's Tag and Trigger menus said "No values yet" while every memory in
-- the list beside them carried tags.
--
-- 00110 made it reachable sooner (a value whose count drops to zero under the
-- other filters keeps its row), but the cap was always there: any account with
-- more than 1000 distinct (dimension, value) pairs lost its last dimensions.
--
-- THE FIX. This function returns the SAME rows as one `jsonb` array. A scalar
-- result is one row to PostgREST, so `max_rows` never applies, and the catalog
-- is exact at any size — the property 00052 promised and the cap broke. The
-- facets handler calls this instead of `lorekit_memory_facets`; the REST
-- response (`{ facets: [{ facet, value, count }] }`) does not change.
--
-- ── DESIGN ───────────────────────────────────────────────────────────────
--
-- A WRAPPER, NOT A REWRITE. `lorekit_memory_facets` keeps its signature, its
-- rows and every rule documented on it (drill-down, co-occurrence, the
-- exclusion, the retention population). 85 assertions in migrations.test.sql
-- and the CLI-facing `lorekit_memory_tags` agreement (§69 AC-7) read it as a
-- set, and none of that is what was wrong. This function only changes the
-- SHAPE of the answer, so there is exactly one place that decides what the
-- catalog contains.
--
-- SAME PARAMETERS, SAME NAMES, SAME DEFAULTS. The handler passes named
-- arguments, so the switch is a rename at the call site. §117 asserts the two
-- argument lists are identical: a dimension added to `lorekit_memory_facets`
-- without being added here fails CI instead of being silently unfilterable.
--
-- SECURITY INVOKER. Tenancy, the key restriction and the actor rule all live
-- in `lorekit_memory_facets` (security definer), which reads the caller's JWT
-- claims exactly as before — a wrapper adds no second predicate to drift. The
-- caller needs EXECUTE on both, which `authenticated` and `service_role` have
-- and `anon` has on neither.
--
-- ORDER IS EXPLICIT. `jsonb_agg(... order by ...)` restates the inner order
-- (facet asc, count desc, value asc) rather than trusting a function scan to
-- preserve it; `(facet, value)` is unique after the inner `group by`, so the
-- order is total.
--
-- §117 in `migrations.test.sql` is the executable proof.
-- ═════════════════════════════════════════════════════════════════════════

create or replace function lorekit_memory_facet_catalog(
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
  p_owner              text[]  default null,
  p_owner_mode         text    default 'in',
  p_key_scopes         text[]  default '{}',
  p_key_org_access     text    default 'all',
  p_key_org_ids        uuid[]  default '{}',
  p_created_since      timestamptz default null,
  p_created_until      timestamptz default null,
  p_min_age_days       integer default null,
  p_unseen_days        integer default null,
  p_max_seen_count     integer default null,
  p_max_read_count     integer default null,
  p_max_opened_count   integer default null,
  p_opened_within_days integer default null,
  p_min_seen_count     integer default null,
  p_min_read_count     integer default null,
  p_min_opened_count   integer default null,
  p_exclude_tags       text[]  default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
           jsonb_agg(
             jsonb_build_object('facet', f.facet, 'value', f.value, 'count', f.count)
             order by f.facet asc, f.count desc, f.value asc
           ),
           '[]'::jsonb
         )
    from lorekit_memory_facets(
           p_user_id            => p_user_id,
           p_archived           => p_archived,
           p_scope              => p_scope,
           p_tags               => p_tags,
           p_tags_mode          => p_tags_mode,
           p_source_agent       => p_source_agent,
           p_source_agent_mode  => p_source_agent_mode,
           p_trigger            => p_trigger,
           p_trigger_mode       => p_trigger_mode,
           p_kind               => p_kind,
           p_kind_mode          => p_kind_mode,
           p_host               => p_host,
           p_host_mode          => p_host_mode,
           p_origin_repo        => p_origin_repo,
           p_origin_repo_mode   => p_origin_repo_mode,
           p_origin_branch      => p_origin_branch,
           p_origin_branch_mode => p_origin_branch_mode,
           p_origin_pr          => p_origin_pr,
           p_origin_pr_mode     => p_origin_pr_mode,
           p_owner              => p_owner,
           p_owner_mode         => p_owner_mode,
           p_key_scopes         => p_key_scopes,
           p_key_org_access     => p_key_org_access,
           p_key_org_ids        => p_key_org_ids,
           p_created_since      => p_created_since,
           p_created_until      => p_created_until,
           p_min_age_days       => p_min_age_days,
           p_unseen_days        => p_unseen_days,
           p_max_seen_count     => p_max_seen_count,
           p_max_read_count     => p_max_read_count,
           p_max_opened_count   => p_max_opened_count,
           p_opened_within_days => p_opened_within_days,
           p_min_seen_count     => p_min_seen_count,
           p_min_read_count     => p_min_read_count,
           p_min_opened_count   => p_min_opened_count,
           p_exclude_tags       => p_exclude_tags
         ) as f;
$$;

revoke execute on function lorekit_memory_facet_catalog(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer,
  text[]) from public, anon;
grant execute on function lorekit_memory_facet_catalog(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer,
  text[]) to authenticated, service_role;

comment on function lorekit_memory_facet_catalog(
  uuid, boolean, text, text[], text, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer,
  text[]) is
  'lorekit_memory_facets as ONE jsonb array of {facet, value, count}, ordered
   facet asc, count desc, value asc — identical rows, identical parameters.
   Exists because PostgREST caps a set-returning result at max_rows (1000) and
   a scalar result is not capped: read through PostgREST, the set form silently
   dropped the dimensions that sort last (tag, trigger) for large accounts.
   Security invoker: tenancy and the key restriction stay in
   lorekit_memory_facets. Backs GET/POST /memories/facets (00117).';
