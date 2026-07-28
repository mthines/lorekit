-- Usage events — structured telemetry for post-processing and plan analysis.
--
-- Captures every significant MCP tool call outcome as a lightweight structured
-- row so you can answer questions like:
--   * How many writes/reads/searches per user per day? (→ plan sizing)
--   * What fraction of writes hit the cap? (→ conversion signal)
--   * What is the p50/p95 memory count at cap-hit time? (→ plan threshold)
--   * How many active memories does a median user hold? (→ free-plan ceiling)
--   * Which scope types are most used? (→ product prioritisation)
--   * What is the rate-limit hit rate per plan? (→ plan RPM calibration)
--
-- Design decisions:
--   * Append-only (no UPDATE/DELETE RLS policies). Rows age out via a pg_cron
--     job (lorekit_purge_old_usage_events) or a retention policy.
--   * user_id is stored pseudonymously (the Supabase UUID, never email/handle).
--   * No memory key/value/scope string is stored — just bounded categorical
--     attributes (tool_name, scope_type, outcome, plan_name) that are safe for
--     aggregation dashboards without privacy review.
--   * auth_type discriminates api_key vs JWT vs service writes so you can filter
--     out internal/CI traffic in analytics.
--   * duration_ms tracks wall-clock handler time for latency-percentile analysis.
--
-- RLS: users can read their own rows (self-service "my usage" views); service-
-- role writes; no user insert/update/delete.

create table if not exists usage_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users on delete set null,  -- null for service-role
  org_id        uuid references orgs(id) on delete set null,    -- null for personal writes
  plan_name     text,                                            -- plan at time of event
  tool_name     text not null,                                   -- e.g. 'memory.write'
  scope_type    text,                                            -- 'global'|'project'|'repo'|'branch'|null
  auth_type     text not null,                                   -- 'api_key'|'jwt'|'service'
  outcome       text not null,                                   -- 'ok'|'cap_exceeded'|'rate_limited'|'permission_denied'|'error'
  duration_ms   integer,                                         -- wall-clock handler time
  memory_count  integer,                                         -- active memories at time of event (write path only)
  created_at    timestamptz not null default now()
);

alter table usage_events enable row level security;

-- Users can read their own usage rows (self-service dashboard).
create policy "rls_usage_events_select"
  on usage_events for select
  using (user_id = auth.uid());

-- Service-role can insert (the only write path — no user insert policy).
-- (service_role bypasses RLS by default in Supabase; this is documentation.)

-- Covering indexes for the most common analytics queries:
--   * Per-user time-series: (user_id, created_at) for daily/weekly rollups.
--   * Funnel by tool + outcome: (tool_name, outcome, created_at).
--   * Plan analysis: (plan_name, outcome, created_at).
create index if not exists usage_events_user_created_at_idx
  on usage_events (user_id, created_at desc);

create index if not exists usage_events_tool_outcome_idx
  on usage_events (tool_name, outcome, created_at desc);

create index if not exists usage_events_plan_outcome_idx
  on usage_events (plan_name, outcome, created_at desc);

-- Reaper: hard-delete usage events older than p_older_than (default 90 days).
-- Called by pg_cron. Returns the count of deleted rows.
create or replace function lorekit_purge_old_usage_events(
  p_older_than interval default interval '90 days'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from usage_events
   where created_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function lorekit_purge_old_usage_events(interval) to service_role;

-- Schedule quarterly cleanup (retain 90 days) — runs weekly on Sundays at 02:00 UTC.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'lorekit-purge-old-usage-events',
      '0 2 * * 0',
      $cron$select lorekit_purge_old_usage_events()$cron$
    );
  end if;
end;
$$;

-- Helper RPC: record one usage event. Accepts nullable fields gracefully.
-- Called from the edge function and Node server after each tool call completes.
-- Returns the new row's id for correlation.
create or replace function lorekit_record_usage_event(
  p_user_id      uuid default null,
  p_org_id       uuid default null,
  p_plan_name    text default null,
  p_tool_name    text default null,
  p_scope_type   text default null,
  p_auth_type    text default null,
  p_outcome      text default null,
  p_duration_ms  integer default null,
  p_memory_count integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into usage_events (
    user_id, org_id, plan_name,
    tool_name, scope_type, auth_type,
    outcome, duration_ms, memory_count
  ) values (
    p_user_id, p_org_id, p_plan_name,
    p_tool_name, p_scope_type, p_auth_type,
    p_outcome, p_duration_ms, p_memory_count
  )
  returning id into v_id;
  return v_id;
exception
  when others then
    -- Never let telemetry writes break the primary operation.
    return null;
end;
$$;

grant execute on function lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer)
  to anon, authenticated, service_role;
