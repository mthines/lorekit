-- Usage-event dimensions for G1 (real record counts) + G2 (per-PR/session
-- correlation), and the matching read-side extension of lorekit_usage_stats.
--
-- G1 — "read 600 MEMORIES today", not "600 read CALLS": usage_events counted one
-- row per tool call but never how many records that call returned. Add
-- result_count (nullable — only reads/expiry populate it) and sum it in the
-- stats RPC as record_count, distinct from the call count.
--
-- G2 — "5 memories during THIS PR": add a nullable, bounded correlation_id the
-- write paths fill from a client-supplied X-LoreKit-Correlation-Id header, and
-- let lorekit_usage_stats filter by it.
--
-- Forward-only and additive: both columns are nullable so every existing row and
-- every caller that omits them is unaffected; the two RPCs are DROPped and
-- recreated with trailing DEFAULT params so PostgREST's named-argument
-- resolution keeps every current caller working.

-- ── G1/G2 columns ───────────────────────────────────────────────────────────
alter table usage_events add column if not exists result_count integer;
alter table usage_events add column if not exists correlation_id text;

-- Bound the correlation id (cardinality + storage). char_length, not octet, is
-- fine for the printable-ASCII set the app validator (parseCorrelationId)
-- enforces; the DB check is the backstop, not the primary gate.
alter table usage_events drop constraint if exists usage_events_correlation_id_len;
alter table usage_events add constraint usage_events_correlation_id_len
  check (correlation_id is null or char_length(correlation_id) <= 200);

-- Index the grouped/filtered read: "my events for correlation X, newest first".
create index if not exists usage_events_user_correlation_idx
  on usage_events (user_id, correlation_id, created_at desc)
  where correlation_id is not null;

-- ── writer: add p_result_count + p_correlation_id ───────────────────────────
-- DROP first (not CREATE OR REPLACE): adding params changes the signature, and a
-- bare CREATE would leave the old overload behind and make calls ambiguous.
drop function if exists lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer);

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
  p_correlation_id text    default null
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
    result_count, correlation_id
  ) values (
    p_user_id, p_org_id, p_plan_name,
    p_tool_name, p_scope_type, p_auth_type,
    p_outcome, p_duration_ms, p_memory_count,
    p_result_count, p_correlation_id
  )
  returning id into v_id;
  return v_id;
exception
  when others then
    -- Never let telemetry writes break the primary operation.
    return null;
end;
$$;

grant execute on function lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text)
  to anon, authenticated, service_role;

-- ── reader: record_count column + correlation filter ────────────────────────
-- DROP the 00043 3-arg version and recreate with a trailing p_correlation_id and
-- an added record_count in the returned rows. Everything else — self-only
-- visibility, the service-role escape hatch, the plpgsql-not-SQL ordering
-- rationale, the grant surface — is unchanged from 00043.
drop function if exists lorekit_usage_stats(uuid, timestamptz, timestamptz);

create or replace function lorekit_usage_stats(
  p_user_id        uuid,
  p_since          timestamptz default null,
  p_until          timestamptz default null,
  p_correlation_id text        default null
)
returns table (
  tool_name         text,
  outcome           text,
  scope_type        text,
  event_count       bigint,
  record_count      bigint,
  total_duration_ms bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  return query
    select
        e.tool_name,
        e.outcome,
        e.scope_type,
        count(*)                          as event_count,
        coalesce(sum(e.result_count), 0)  as record_count,
        coalesce(sum(e.duration_ms), 0)   as total_duration_ms
      from usage_events e
     where (
             (p_user_id is null and auth.role() = 'service_role')
             or e.user_id = p_user_id
           )
       and (p_since is null or e.created_at >= p_since)
       and (p_until is null or e.created_at <  p_until)
       and (p_correlation_id is null or e.correlation_id = p_correlation_id)
     group by e.tool_name, e.outcome, e.scope_type
     order by event_count desc, e.tool_name asc;
end;
$$;

grant execute on function lorekit_usage_stats(uuid, timestamptz, timestamptz, text)
  to authenticated, service_role;
