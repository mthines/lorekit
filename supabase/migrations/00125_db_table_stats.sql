-- 00125 — per-table counters for the query-profiling export.
--
-- WHY. 00124 made read-counter updates on `memories` HOT to cut the project's
-- Disk IO. Whether that worked — and which table the IO goes to — lives in
-- `pg_stat_user_tables` / `pg_statio_user_tables`, which nothing exported:
-- checking meant an operator pasting SQL into the Supabase editor. The
-- `profiling` Edge Function (00074) already ships `pg_stat_statements` to Dash0
-- on a pg_cron tick; this adds a second reader it calls on the same tick, so
-- the HOT ratio (rate(tup_hot_upd) / rate(tup_upd)), dead tuples and disk block
-- reads per table become `lorekit.db.table.*` metrics beside
-- `lorekit.db.query.*`.
--
-- WHAT. `lorekit_db_table_stats()` — one row per table in a FIXED allowlist,
-- service-role only. Same posture as `lorekit_db_query_stats()`:
--   * an operator surface: the counters describe the cluster, not a caller's
--     data, so `anon` / `authenticated` cannot execute it;
--   * bounded: every row becomes a metric SERIES in Dash0, so the table list is
--     a constant here, never "every table" (a new table would silently grow the
--     bill) and never caller-supplied;
--   * cumulative: the counters are exported as they are, with the database's
--     `stats_reset` as each series start, so Dash0 does the differencing and
--     reads a reset as a new series (00074, otlp-metrics.ts).
--
-- The allowlist is the tables written on the request path: `memories` (writes
-- and the 00124 read counters), `memory_read_daily` (the daily read rollup),
-- `rate_limit_counters` (every authenticated request, UNLOGGED since 00124),
-- `audit_log`, `usage_events`, `api_tokens` and `memory_citations`. A table in
-- the list that does not exist (BYOD, an older schema) simply returns no row.
--
-- Turned on by the same two Vault secrets as the query export
-- (`lorekit_profiling_url`, `lorekit_profiling_key` — see 00074). This
-- migration turns nothing on by itself.
--
-- LOCK WINDOW. Creates one function and sets its grants: catalog rows only, no
-- lock on any table.

create or replace function lorekit_db_table_stats()
returns table (
  table_name        text,
  n_tup_ins         bigint,
  n_tup_upd         bigint,
  n_tup_hot_upd     bigint,
  n_tup_del         bigint,
  n_live_tup        bigint,
  n_dead_tup        bigint,
  seq_scan          bigint,
  idx_scan          bigint,
  autovacuum_count  bigint,
  heap_blks_read    bigint,
  heap_blks_hit     bigint,
  idx_blks_read     bigint,
  idx_blks_hit      bigint,
  stats_since       timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.relname::text,
    s.n_tup_ins,
    s.n_tup_upd,
    s.n_tup_hot_upd,
    s.n_tup_del,
    s.n_live_tup,
    s.n_dead_tup,
    s.seq_scan,
    -- NULL for a table with no index; 0 is the honest cumulative value.
    coalesce(s.idx_scan, 0),
    s.autovacuum_count,
    io.heap_blks_read,
    io.heap_blks_hit,
    coalesce(io.idx_blks_read, 0),
    coalesce(io.idx_blks_hit, 0),
    -- Table counters reset with the database's stats (pg_stat_reset()), so
    -- the database's reset time is each series' start. NULL until a reset has
    -- ever happened; the mapper reads that as "since the epoch".
    (select d.stats_reset from pg_stat_database d where d.datname = current_database())
  from pg_stat_user_tables s
  join pg_statio_user_tables io on io.relid = s.relid
  where s.schemaname = 'public'
    and s.relname in (
      'memories',
      'memory_read_daily',
      'rate_limit_counters',
      'audit_log',
      'usage_events',
      'api_tokens',
      'memory_citations'
    )
  order by s.relname;
$$;

comment on function lorekit_db_table_stats() is
  'Cumulative pg_stat_user_tables + pg_statio_user_tables counters for a fixed '
  'allowlist of request-path tables, for the profiling Edge Function.';

-- Service-role only — the same grant shape as lorekit_db_query_stats (00074).
revoke all on function lorekit_db_table_stats() from public;
revoke all on function lorekit_db_table_stats() from anon, authenticated;
grant execute on function lorekit_db_table_stats() to service_role;
