-- ═════════════════════════════════════════════════════════════════════════
-- usage_events.client — WHICH SURFACE made the call — and the read-activity
-- metric that stops counting the dashboard's own reads.
--
-- THE BUG: reloading the dashboard made the Overview's "Memories read" card go
-- up, every time. The dashboard is a CLIENT of LoreKit's own REST API (a
-- deliberate decision — see CLAUDE.md), so rendering the Lore Explorer issues a
-- real `GET /memories`, the router records a real `usage_events` row with a
-- real `result_count`, and `lorekit_read_activity` (00053) sums it. The card
-- was therefore measuring "records this account read INCLUDING the ones the
-- page fetched in order to draw this very card" — a metric that responds to
-- looking at it. Visualising your lore is not consuming it; the card is meant
-- to answer "how much have my agents read".
--
-- THE FIX, in two halves:
--
--   1. Record WHO called. `usage_events` already carried `auth_type` (HOW the
--      caller authenticated) and `tool_name` (WHAT they asked for) but nothing
--      for WHICH SURFACE — and neither existing column can stand in. A
--      dashboard read and an agent read over a Supabase JWT are both
--      `auth_type = 'jwt'` calling `memory.list`; distinguishing them by
--      auth tier would be a guess that silently mis-attributes the moment an
--      agent authenticates with a JWT. So: a new nullable `client` column,
--      filled from the client-supplied `X-LoreKit-Client` header at the ONE
--      recording site each surface already has (`_shared/api/router.ts`,
--      `mcp/mcp-handler.ts`) and validated against a closed vocabulary by the
--      pure `parseUsageClient` (`_shared/telemetry/usage-stats.ts`). Unattributed stays
--      NULL — the 00044 posture: a telemetry dimension can never fail the
--      call it is measuring.
--
--   2. Exclude the dashboard from the read METRIC, not from the LEDGER. The
--      events are still written in full, so `GET /memories/usage` still totals
--      every read and the exclusion is reversible with one more migration.
--      Only `lorekit_read_activity` — the series behind the "Memories read"
--      card — filters `client is distinct from 'dashboard'`.
--
-- The exclusion is inlined in the RPC rather than parameterised, mirroring how
-- 00053 inlines its read-tool list and 00045 inlines `memory.expired`: it is
-- the definition of the metric, not a caller's choice. Keep the literal in step
-- with `DASHBOARD_CLIENT` in `packages/mcp-core/src/usage-stats.ts` by hand —
-- there is no mechanism to share a TS constant with a migration.
--
-- Forward-only and additive: the column is nullable and the writer's new
-- parameter is trailing + defaulted, so every existing row and every caller
-- that omits it is unaffected.
-- ═════════════════════════════════════════════════════════════════════════

-- ── the column ──────────────────────────────────────────────────────────────
alter table usage_events add column if not exists client text;

-- Bound the value as a BACKSTOP, not as the primary gate — exactly the reason
-- 00044 gives for `usage_events_correlation_id_len`. The authoritative closed
-- vocabulary is `parseUsageClient`; a CHECK enumerating the members would turn
-- adding a surface into a migration, while an unbounded column would let a
-- malformed header inflate analytics cardinality. A short length cap gives the
-- storage/cardinality guarantee without pinning the vocabulary in SQL.
alter table usage_events drop constraint if exists usage_events_client_len;
alter table usage_events add constraint usage_events_client_len
  check (client is null or (char_length(client) between 1 and 32));

-- Index the read this exists for: "my read events, excluding one client,
-- newest first". Partial on the non-null rows because a NULL client carries no
-- information to filter on.
create index if not exists usage_events_user_client_idx
  on usage_events (user_id, client, created_at desc)
  where client is not null;

-- ── writer: add a trailing p_client ─────────────────────────────────────────
-- DROP first (not CREATE OR REPLACE): adding a parameter changes the signature,
-- and a bare CREATE would leave the 00044 overload behind and make every call
-- ambiguous. Body is 00044's verbatim plus the one column.
drop function if exists lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text);

create or replace function lorekit_record_usage_event(
  p_user_id        uuid    default null,
  p_org_id         uuid    default null,
  p_plan_name      text    default null,
  p_tool_name      text    default null,
  p_scope_type     text    default null,
  p_auth_type      text    default null,
  p_outcome        text    default null,
  p_duration_ms    integer default null,
  p_memory_count   integer default null,
  p_result_count   integer default null,
  p_correlation_id text    default null,
  p_client         text    default null
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
    outcome, duration_ms, memory_count,
    result_count, correlation_id, client
  ) values (
    p_user_id, p_org_id, p_plan_name,
    p_tool_name, p_scope_type, p_auth_type,
    p_outcome, p_duration_ms, p_memory_count,
    p_result_count, p_correlation_id, p_client
  )
  returning id into v_id;
  return v_id;
exception
  when others then
    -- Never let telemetry writes break the primary operation.
    return null;
end;
$$;

grant execute on function lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text, text)
  to anon, authenticated, service_role;

-- ── reader: the "Memories read" series stops counting the dashboard ─────────
-- CREATE OR REPLACE, not DROP: the signature is unchanged from 00053, so every
-- caller (`GET /memories/read-activity`) is untouched. Everything else — the
-- bucket validation, the half-open window, the self-only visibility with the
-- service-role escape hatch, the read-tool list, the sparse `having` — is
-- 00053's verbatim.
create or replace function lorekit_read_activity(
  p_user_id uuid,
  p_bucket  text        default 'day',
  p_since   timestamptz default null,
  p_until   timestamptz default null
)
returns table (bucket timestamptz, count bigint)
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
begin
  if p_bucket is null or p_bucket not in ('hour', 'day') then
    raise exception 'invalid bucket %, expected hour or day', p_bucket
      using errcode = '22023';
  end if;

  return query
    select date_trunc(p_bucket, ue.created_at at time zone 'UTC') at time zone 'UTC' as bucket,
           sum(coalesce(ue.result_count, 0))::bigint as count
      from usage_events ue
     where (
             (v_actor is null and auth.role() = 'service_role')
             or ue.user_id = v_actor
           )
       and ue.tool_name in ('memory.read', 'memory.list', 'memory.search',
                            'memory.list_archived')
       -- The dashboard reading lore in order to DRAW this chart is not a read
       -- the chart should report. `is distinct from` (not `<>`) because the
       -- column is nullable and `null <> 'dashboard'` is null, which would
       -- silently drop every unattributed event — including every row written
       -- before this migration.
       and ue.client is distinct from 'dashboard'
       and (p_since is null or ue.created_at >= p_since)
       and (p_until is null or ue.created_at <  p_until)
     group by 1
    having sum(coalesce(ue.result_count, 0)) > 0
     order by 1 asc;
end;
$$;

revoke execute on function lorekit_read_activity(uuid, text, timestamptz, timestamptz) from public, anon;
grant  execute on function lorekit_read_activity(uuid, text, timestamptz, timestamptz) to authenticated, service_role;

comment on function lorekit_read_activity(uuid, text, timestamptz, timestamptz) is
  'Memory RECORDS read (sum of usage_events.result_count over memory.read /
   memory.list / memory.search / memory.list_archived — permissions.ts''s
   READ_TOOLS) per UTC hour/day over the half-open [p_since, p_until) window,
   EXCLUDING events attributed to the dashboard client (00054): browsing your
   own lore in the web UI is visualisation, not consumption, so it must not
   inflate the "Memories read" card it is drawing. Unattributed (NULL client)
   events are counted. Visibility is SELF-ONLY with the same service-role +
   NULL escape hatch as lorekit_usage_stats — usage is a per-user ledger and is
   never org-shared. p_bucket is validated against (hour, day). Buckets with no
   records read are omitted.';
