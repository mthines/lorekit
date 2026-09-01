-- Retention-policy sweep telemetry.
--
-- `lorekit_groom_sweep()` (00088, re-created in 00093) is the nightly
-- auto-archive pass — and it has ALWAYS been invisible end-to-end. pg_cron
-- calls it directly as a raw SQL statement, entirely inside Postgres: no
-- span, no metric, nothing distinguishes "ran and archived nothing" from
-- "did not run at all" from "failed silently". An operator staring at
-- unchanged data has no telemetry to tell those apart from here — the exact
-- report this migration exists to fix.
--
-- Mirrors the ALREADY-SOLVED identical problem one migration family over:
-- `lorekit_export_db_query_stats()` / the `profiling` Edge Function (00074,
-- docs/otel.md "Query-level profiling"). Same shape, applied to the sweep
-- instead of the stats scrape:
--
--   pg_cron (nightly, 03:17 UTC)
--     └── lorekit_export_groom_sweep()       ← inert without vault secrets
--           └── pg_net → POST /functions/v1/groom-sweep
--                 └── lorekit_groom_sweep_and_record()  ← THIS migration
--                       └── lorekit_groom_sweep()         ← UNCHANGED (00093)
--
-- `lorekit_groom_sweep_and_record()` does not touch `lorekit_groom_sweep()`'s
-- tested behaviour at all — it calls it exactly as pg_cron always has, then
-- records the result into a persistent counter row so the Edge Function can
-- export TRUE cumulative sums (matching db-query-metrics.ts's convention)
-- instead of a per-run delta needing its own reset-detection.

-- 1. groom_sweep_stats — a SINGLETON counter row. `id` is fixed to TRUE by
--    the check constraint so there is exactly one row, ever; every sweep
--    UPDATEs it rather than INSERTing a new one, the same "one row, updated
--    forever" shape pg_stat_statements itself uses for its own counters.
--    `started_at` is set once, at row creation, and becomes every exported
--    datapoint's `startTimeUnixNano` — the series start a cumulative counter
--    needs for a backend to read a reset (this table dropped and recreated)
--    as a new series rather than as negative traffic.
create table if not exists groom_sweep_stats (
  id                 boolean primary key default true check (id),
  runs_total         bigint not null default 0,
  archived_total     bigint not null default 0,
  policies_evaluated integer not null default 0,
  started_at         timestamptz not null default now(),
  last_run_at        timestamptz
);

insert into groom_sweep_stats (id) values (true) on conflict (id) do nothing;

comment on table groom_sweep_stats is
  'Singleton cumulative counters for the nightly retention-policy sweep — '
  'updated by lorekit_groom_sweep_and_record, read by the groom-sweep Edge '
  'Function to export lorekit.groom.sweep.{runs,archived} to Dash0.';

alter table groom_sweep_stats enable row level security;
-- No policy is created: this is an operator/service-role surface exactly
-- like retention_policies' RPCs are for CRUD, but here there is no owning
-- user at all (the sweep spans every user's auto+enabled policies), so no
-- `authenticated`-reachable policy is correct — only the SECURITY DEFINER
-- function below (and the service role, which bypasses RLS) may touch it.

-- 2. lorekit_groom_sweep_and_record — runs the existing, unchanged
--    `lorekit_groom_sweep()`, then atomically records this run's result into
--    `groom_sweep_stats` and returns the accumulated totals PLUS this run's
--    own snapshot (archived_this_run, policies_evaluated) for the Edge
--    Function's span attributes. The snapshot fields are deliberately NOT
--    part of the exported metrics (see groom-sweep-metrics.ts) — they are
--    per-run values, not cumulative counters, and mixing the two shapes in
--    one Sum metric would misread a run-over-run drop as a counter reset.
create or replace function lorekit_groom_sweep_and_record()
returns table (
  runs_total         bigint,
  archived_total     bigint,
  archived_this_run  integer,
  policies_evaluated integer,
  started_at         timestamptz,
  last_run_at        timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_archived  integer;
  v_policies  integer;
begin
  select lorekit_groom_sweep() into v_archived;

  select count(*) into v_policies
    from retention_policies where mode = 'auto' and enabled = true;

  return query
    update groom_sweep_stats
       set runs_total         = groom_sweep_stats.runs_total + 1,
           archived_total     = groom_sweep_stats.archived_total + coalesce(v_archived, 0),
           policies_evaluated = v_policies,
           last_run_at        = now()
     where id = true
    returning
      groom_sweep_stats.runs_total,
      groom_sweep_stats.archived_total,
      coalesce(v_archived, 0),
      v_policies,
      groom_sweep_stats.started_at,
      groom_sweep_stats.last_run_at;
end;
$$;

comment on function lorekit_groom_sweep_and_record() is
  'Runs lorekit_groom_sweep() unchanged, then records the result into '
  'groom_sweep_stats. Called by the groom-sweep Edge Function so every '
  'nightly sweep produces a span + cumulative Dash0 metrics.';

revoke all on function lorekit_groom_sweep_and_record() from public;
revoke all on function lorekit_groom_sweep_and_record() from anon, authenticated;
grant execute on function lorekit_groom_sweep_and_record() to service_role;

-- 3. lorekit_export_groom_sweep — pokes the `groom-sweep` Edge Function
--    through pg_net, IDENTICAL gating and shape to
--    lorekit_export_db_query_stats (00074): OFF by default until an operator
--    provisions two Vault secrets, so this migration turns nothing on by
--    itself and adds no new secret-handling code path to audit.
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/groom-sweep', 'lorekit_groom_sweep_url');
--   select vault.create_secret('<service-role-key>', 'lorekit_groom_sweep_key');
create or replace function lorekit_export_groom_sweep()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return 'skipped: pg_net not installed';
  end if;

  if to_regclass('vault.decrypted_secrets') is null then
    return 'disabled: vault unavailable';
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'lorekit_groom_sweep_url';
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'lorekit_groom_sweep_key';

  if v_url is null or v_key is null then
    return 'disabled: set the lorekit_groom_sweep_url and lorekit_groom_sweep_key vault secrets to enable';
  end if;

  -- Fire-and-forget, same reasoning as the query-stats poke: pg_net queues
  -- the request and returns immediately, so a cron tick never blocks on
  -- Dash0 being slow or unreachable. A dropped tick here loses one night's
  -- run count, never data — the cumulative counters keep going from wherever
  -- they last landed.
  perform net.http_post(
    url     := v_url,
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    timeout_milliseconds := 30000
  );

  return 'posted';
end;
$$;

comment on function lorekit_export_groom_sweep() is
  'Pokes the groom-sweep Edge Function to run the nightly retention sweep '
  'and export its telemetry to Dash0. Inert until the '
  'lorekit_groom_sweep_url + lorekit_groom_sweep_key vault secrets exist.';

revoke all on function lorekit_export_groom_sweep() from public;
revoke all on function lorekit_export_groom_sweep() from anon, authenticated;
grant execute on function lorekit_export_groom_sweep() to service_role;

-- 4. Reschedule the nightly job to call the new, observable entry point.
--    `cron.schedule()` upserts by job name (same name, same time as 00088:
--    'lorekit-groom-sweep', 03:17 UTC) so this REPLACES the command in
--    place — no unschedule step needed, and no gap in the schedule.
--    Guarded identically to 00088 so this migration still applies on an
--    instance without pg_cron.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'lorekit-groom-sweep',
      '17 3 * * *',
      $cron$select lorekit_export_groom_sweep()$cron$
    );
  end if;
end;
$$;
