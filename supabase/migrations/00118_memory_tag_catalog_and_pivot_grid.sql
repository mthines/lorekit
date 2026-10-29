-- ═════════════════════════════════════════════════════════════════════════
-- 00118 — `lorekit_memory_tag_catalog` and `lorekit_memory_pivot_grid`: the
-- label catalog and the pivot grid as ONE value each, so PostgREST's row cap
-- cannot cut them. 00117's fix, applied to the two remaining set-returning
-- reads whose size grows with the data.
--
-- THE CAP. PostgREST returns at most `max_rows` (1000 — supabase/config.toml)
-- rows from a set-returning function, silently. 00117 found it cutting the
-- facet catalog in production. The same read shape sits behind two more routes:
--
--   GET /memories/tags  — `lorekit_memory_tags`, one row per distinct label,
--                         ordered count desc. An account with more than 1000
--                         labels lost its RAREST ones: exactly the labels a
--                         catalog exists to surface, since a common label is
--                         one you already know.
--
--   /memories/pivot     — `lorekit_memory_pivot`, one row per (row, col) pair,
--                         ordered count desc and capped by `p_limit`. The route
--                         allows `limit` up to 2000 (PIVOT_LIMIT_MAX) and asks
--                         for `limit + 1` to detect truncation, so any limit
--                         above 999 met PostgREST's 1000 first. Worse than a
--                         short grid: the handler compared 1000 rows against the
--                         requested limit and reported `truncated: false` on a
--                         grid that WAS cut — the one signal meant to say so.
--
-- THE FIX. Each wrapper returns its function's rows as one `jsonb` array. A
-- scalar result is one row to PostgREST, so `max_rows` never applies; the
-- pivot's own `p_limit` becomes the only limit, and `truncated` is true again
-- exactly when it cut. The handlers call these; neither REST response changes.
--
-- ── DESIGN (00117's, verbatim) ───────────────────────────────────────────
--
-- WRAPPERS, NOT REWRITES. `lorekit_memory_tags` and `lorekit_memory_pivot` keep
-- their signatures, rows and every rule documented on them. migrations.test.sql
-- reads both as sets (`lorekit_memory_tags` also backs §69 AC-7's agreement with
-- the facet catalog), and the BYOD bootstrap carries them. Only the SHAPE of the
-- answer changes, so each catalog is still decided in exactly one place.
--
-- SAME PARAMETERS, SAME NAMES, SAME DEFAULTS. The handlers pass named arguments,
-- so the switch is a rename at the call site. §118 asserts each pair of
-- argument lists is identical and that every parameter is forwarded: a new
-- dimension added to the set form and not here fails CI.
--
-- SECURITY INVOKER. Tenancy, the key restriction and the actor rule stay in the
-- security-definer set forms, which read the caller's JWT claims exactly as
-- before. The caller needs EXECUTE on both halves, which `authenticated` and
-- `service_role` have and `anon` has on neither.
--
-- ORDER IS EXPLICIT. Each `jsonb_agg(... order by ...)` restates its inner
-- order rather than trusting a function scan to preserve it. Both are total:
-- `tag` is unique after its `group by`, and so is `(row_value, col_value)`.
--
-- §118 in `migrations.test.sql` is the executable proof.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. lorekit_memory_tag_catalog ─────────────────────────────────────────

create or replace function lorekit_memory_tag_catalog(
  p_user_id        uuid,
  p_archived       boolean default false,
  p_key_scopes     text[]  default '{}',
  p_key_org_access text    default 'all',
  p_key_org_ids    uuid[]  default '{}'
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
           jsonb_agg(
             jsonb_build_object('tag', t.tag, 'count', t.count)
             order by t.count desc, t.tag asc
           ),
           '[]'::jsonb
         )
    from lorekit_memory_tags(
           p_user_id        => p_user_id,
           p_archived       => p_archived,
           p_key_scopes     => p_key_scopes,
           p_key_org_access => p_key_org_access,
           p_key_org_ids    => p_key_org_ids
         ) as t;
$$;

revoke execute on function lorekit_memory_tag_catalog(uuid, boolean, text[], text, uuid[])
  from public, anon;
grant  execute on function lorekit_memory_tag_catalog(uuid, boolean, text[], text, uuid[])
  to authenticated, service_role;

comment on function lorekit_memory_tag_catalog(uuid, boolean, text[], text, uuid[]) is
  'lorekit_memory_tags as ONE jsonb array of {tag, count}, ordered count desc,
   tag asc — identical rows, identical parameters. Exists because PostgREST caps
   a set-returning result at max_rows (1000) and a scalar result is not capped:
   read through PostgREST, an account with more than 1000 labels lost its
   rarest ones. Security invoker: tenancy and the key restriction stay in
   lorekit_memory_tags. Backs GET /memories/tags (00118).';

-- ── 2. lorekit_memory_pivot_grid ──────────────────────────────────────────

create or replace function lorekit_memory_pivot_grid(
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
             jsonb_build_object('row_value', g.row_value, 'col_value', g.col_value, 'count', g.count)
             order by g.count desc, g.row_value asc, g.col_value asc
           ),
           '[]'::jsonb
         )
    from lorekit_memory_pivot(
           p_row_facet          => p_row_facet,
           p_col_facet          => p_col_facet,
           p_user_id            => p_user_id,
           p_archived           => p_archived,
           p_scope              => p_scope,
           p_limit              => p_limit,
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
         ) as g;
$$;

revoke execute on function lorekit_memory_pivot_grid(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer,
  text[]) from public, anon;
grant execute on function lorekit_memory_pivot_grid(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer,
  text[]) to authenticated, service_role;

comment on function lorekit_memory_pivot_grid(
  text, text, uuid, boolean, text, integer, text[], text, text[], text, text[], text,
  text[], text, text[], text, text[], text, text[], text, text[], text, text[], text,
  text[], text, uuid[], timestamptz, timestamptz, integer, integer, integer,
  integer, integer,
  integer, integer, integer, integer,
  text[]) is
  'lorekit_memory_pivot as ONE jsonb array of {row_value, col_value, count},
   ordered count desc, row_value asc, col_value asc — identical rows (p_limit
   included), identical parameters. Exists because PostgREST caps a
   set-returning result at max_rows (1000): with the route''s limit above 999
   the grid was cut there and the handler reported truncated=false. A scalar
   result is not capped, so p_limit is the only limit. Security invoker:
   tenancy and the key restriction stay in lorekit_memory_pivot. Backs
   GET/POST /memories/pivot (00118).';
