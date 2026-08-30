-- ═════════════════════════════════════════════════════════════════════════
-- Query-level profiling: read the top statements out of pg_stat_statements so
-- the `profiling` Edge Function can ship them to Dash0 as OTel metrics.
--
-- WHY THIS EXISTS, and why it is not a CPU profiler.
--
-- Dash0 collects profiles with a host-level eBPF agent. There is no host here:
-- every LoreKit runtime is managed serverless (Supabase Edge Functions on
-- managed Deno isolates, the dashboard on Vercel), so no agent can be attached
-- and no userland V8 profiler is exposed to sample from. A CPU profile would
-- also say little — these handlers are I/O-bound, so a sampled stack is mostly
-- "awaiting fetch".
--
-- The time actually goes into SQL, and Postgres already profiles itself.
-- `createTracedClient` gives us a CLIENT span per round-trip, which measures
-- each call from the CALLER's side (round-trip, including network); what it
-- cannot see is server-side cost per query SHAPE, aggregated across every
-- caller — which statement is expensive, how often it runs, whether a plan
-- regressed. That is what `pg_stat_statements` holds, and it is the closest
-- thing to a profile this architecture can produce. See docs/otel.md →
-- "Query-level profiling".
--
-- WHAT SHIPS HERE
--   1. `lorekit_db_query_stats()`  — the reader. Bounded, service-role only.
--   2. `lorekit_export_db_query_stats()` — the scheduled trigger that pokes the
--      Edge Function via pg_net. INERT until an operator provisions two Vault
--      secrets, so this migration turns nothing on by itself.
--
-- Requires the `pg_stat_statements` extension. Absent (or readable by nobody)
-- is handled as "no rows", never an error: profiling is an observability
-- surface and must not be able to fail a migration or a request.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The reader ───────────────────────────────────────────────────────────
--
-- Returns the top `p_limit` statements of the CURRENT database by cumulative
-- execution time, newest stats-reset timestamp attached.
--
-- The counters are cumulative since `stats_reset` and are exported as such —
-- OTel cumulative monotonic sums, with `stats_since` becoming each datapoint's
-- `startTimeUnixNano`. Dash0 then does the differencing itself and reads a
-- reset as a new series rather than as negative traffic. Computing deltas here
-- would mean persisting the previous snapshot and re-implementing reset
-- detection; see supabase/functions/_shared/telemetry/otlp-metrics.ts.
--
-- Dynamic SQL on purpose: a STATIC reference to
-- `extensions.pg_stat_statements` would make the whole function body
-- unresolvable on an instance where the extension is not installed, turning an
-- optional feature into a hard failure. The schema is resolved from
-- `pg_extension` rather than hardcoded to `extensions` (where Supabase puts
-- it) so a self-hosted instance that installed it into `public` also works.
create or replace function lorekit_db_query_stats(p_limit integer default 20)
returns table (
  queryid        text,
  query          text,
  toplevel       boolean,
  calls          bigint,
  total_exec_ms  double precision,
  rows_returned  bigint,
  stats_since    timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_schema text;
  v_limit  integer;
begin
  -- Hard cap. Every returned row becomes a metric SERIES in Dash0, so an
  -- unbounded p_limit is an unbounded cardinality bill. 200 is far above any
  -- real top-N and low enough to stay a rounding error.
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 200);

  select n.nspname
    into v_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_stat_statements';

  -- Not installed → no rows. The caller reports "0 datapoints", which is
  -- honest and actionable, instead of a 500 nobody can distinguish from a
  -- broken exporter.
  if v_schema is null then
    return;
  end if;

  return query execute format($fmt$
    select
      s.queryid::text,
      -- Collapse whitespace and truncate: this string becomes a metric
      -- ATTRIBUTE, and pg_stat_statements keeps the full normalised statement,
      -- which for a wide upsert runs to kilobytes. The queryid is the stable
      -- identity; the text is the human label.
      left(regexp_replace(btrim(s.query), '\s+', ' ', 'g'), 512),
      s.toplevel,
      s.calls,
      s.total_exec_time,
      s.rows,
      i.stats_reset
      from %1$I.pg_stat_statements s
      left join %1$I.pg_stat_statements_info i on true
      -- This database only. A shared cluster's other databases are somebody
      -- else's workload and would both mislead and inflate cardinality.
     where s.dbid = (select oid from pg_database where datname = current_database())
      -- Never profile the profiler — BOTH halves of it. Excluding only the
      -- view's own name is not enough: the exporter reaches this function
      -- through PostgREST, so `select * from lorekit_db_query_stats($1)` is
      -- itself a statement pg_stat_statements records, and at one scrape a
      -- minute it climbs its own top-N and then reports on itself forever. The
      -- pg_net poke is recorded too, for the same reason.
       and s.query not ilike '%%pg_stat_statements%%'
       and s.query not ilike '%%lorekit_db_query_stats%%'
       and s.query not ilike '%%lorekit_export_db_query_stats%%'
     order by s.total_exec_time desc
     limit %2$s
  $fmt$, v_schema, v_limit);
exception
  -- The closed set of "this instance cannot serve the read" failures, each
  -- swallowed to "no rows" for the reason above: an observability read must
  -- never be the thing that breaks. A genuine mistake in the statement itself
  -- (a typo, a wrong cast) is NOT in this set and still raises loudly — which
  -- is why this is an enumeration and not `when others`.
  --
  --   object_not_in_prerequisite_state — the extension is INSTALLED but not in
  --     `shared_preload_libraries`, so the view exists and raises on read.
  --     Supabase preloads it; a self-hosted instance that ran
  --     `create extension` without editing postgresql.conf lands exactly here,
  --     and it is the one failure mode the presence check above cannot see.
  --   insufficient_privilege — reading other roles' statements needs
  --     `pg_read_all_stats`. Without it Postgres normally just narrows the
  --     result to our own statements rather than erroring, but a locked-down
  --     instance can refuse outright.
  --   undefined_column / undefined_table — an extension version predating
  --     `toplevel` / `total_exec_time` / `pg_stat_statements_info` (pre-PG14),
  --     or the view dropped from under us.
  when object_not_in_prerequisite_state
    or insufficient_privilege
    or undefined_column
    or undefined_table then
    return;
end;
$$;

comment on function lorekit_db_query_stats(integer) is
  'Top-N statements of this database by cumulative exec time, for the profiling '
  'Edge Function. Cumulative counters + stats_reset; empty when '
  'pg_stat_statements is absent or unreadable.';

-- Service-role only. These are cross-tenant query shapes — the whole cluster's
-- workload aggregated — so this is an operator surface, never a tenant one.
-- `authenticated` and `anon` must NOT reach it, and PostgREST exposes any
-- function executable by them.
revoke all on function lorekit_db_query_stats(integer) from public;
revoke all on function lorekit_db_query_stats(integer) from anon, authenticated;
grant execute on function lorekit_db_query_stats(integer) to service_role;

-- ── 2. The scheduled trigger ────────────────────────────────────────────────
--
-- pg_cron cannot POST, so the DB pokes the `profiling` Edge Function through
-- pg_net and the function does the OTLP export. The function is where the
-- Dash0 credentials ALREADY live (OTEL_EXPORTER_OTLP_* Supabase secrets) and
-- where the one OTLP payload builder lives, so routing through it adds no new
-- secret surface for Dash0 and no second copy of the resource attributes.
--
-- OFF BY DEFAULT, deliberately — the same posture as the embedding pipeline
-- (docs/embeddings.md). Two Vault secrets are required and neither is created
-- here:
--
--   lorekit_profiling_url  — https://<ref>.supabase.co/functions/v1/profiling
--   lorekit_profiling_key  — the project's service-role key
--
--   select vault.create_secret('https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/profiling', 'lorekit_profiling_url');
--   select vault.create_secret('<service-role-key>', 'lorekit_profiling_key');
--
-- Until both exist this function returns 'disabled' and posts nothing. That
-- keeps the gate in ONE place: the cron job below is scheduled
-- unconditionally, so an operator turns profiling on by adding the secrets —
-- no migration re-run, no schedule edit.
create or replace function lorekit_export_db_query_stats()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_key text;
begin
  -- pg_net absent → nothing can be posted. Checked before Vault so the reason
  -- reported is the real blocker.
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return 'skipped: pg_net not installed';
  end if;

  -- Vault absent (a self-hosted instance without it) is the same "not
  -- configured" state as a missing secret, not an error.
  if to_regclass('vault.decrypted_secrets') is null then
    return 'disabled: vault unavailable';
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'lorekit_profiling_url';
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'lorekit_profiling_key';

  if v_url is null or v_key is null then
    return 'disabled: set the lorekit_profiling_url and lorekit_profiling_key vault secrets to enable';
  end if;

  -- Fire-and-forget by design: pg_net queues the request and returns an id.
  -- A cron tick must not block on Dash0, and the NEXT tick re-reads cumulative
  -- counters anyway — a dropped tick loses resolution, never data, which is
  -- the whole reason for exporting cumulative sums instead of deltas.
  perform net.http_post(
    url     := v_url,
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    timeout_milliseconds := 10000
  );

  return 'posted';
end;
$$;

comment on function lorekit_export_db_query_stats() is
  'Pokes the profiling Edge Function to export query stats to Dash0. Inert '
  'until the lorekit_profiling_url + lorekit_profiling_key vault secrets exist.';

revoke all on function lorekit_export_db_query_stats() from public;
revoke all on function lorekit_export_db_query_stats() from anon, authenticated;
grant execute on function lorekit_export_db_query_stats() to service_role;

-- Every minute. This is a metric SCRAPE, so the interval is the resolution of
-- every rate() over the result — the 15-minute and daily cadences used by the
-- reapers elsewhere in this schema would make the data useless for finding a
-- slow query. Cheap: one bounded read of an in-memory view plus one queued
-- HTTP request, and a no-op entirely while profiling is off.
--
-- Guarded so the migration still applies without pg_cron (the function can
-- then be driven by an external scheduler). Idempotent: cron.schedule() upserts
-- by job name.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'lorekit-export-db-query-stats',
      '* * * * *',
      $cron$select lorekit_export_db_query_stats()$cron$
    );
  end if;
end;
$$;
