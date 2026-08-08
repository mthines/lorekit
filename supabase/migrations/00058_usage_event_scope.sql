-- ═════════════════════════════════════════════════════════════════════════
-- usage_events.scope — WHICH SCOPE a call touched — and the read-activity
-- series grouped by it.
--
-- THE GAP: reads already carry `scope_type` (00034: `global` / `project` /
-- `repo` / `branch`), which answers "how much do I read at repo level" but not
-- "how much do I read from `repo::mthines/lorekit`". `scope_type` is a
-- deliberately low-cardinality telemetry dimension and cannot be widened into
-- the exact string without changing what it means, so per-scope read totals —
-- the number the Explorer's stats header needs beside its per-scope WRITE
-- totals (`lorekit_memory_activity`, 00051) — were simply unanswerable. Writes
-- have had the exact scope since 00051; reads have not.
--
-- THE FIX, mirroring 00054's structure exactly (that migration added `client`
-- the same way, and for the same class of reason):
--
--   1. A new nullable `scope` column on `usage_events`, filled at the ONE
--      recording site each surface already has (`_shared/api/router.ts`,
--      `mcp/mcp-handler.ts`) from the caller-supplied scope, normalised through
--      the canonical validator by the pure `safeValidateScope`. Unresolvable or
--      absent stays NULL — the 00044/00054 posture: a telemetry dimension can
--      never fail the call it is measuring.
--
--   2. `lorekit_read_activity` returns one row per `(bucket, scope)` instead of
--      one per `bucket`, exactly the shape `lorekit_memory_activity` (00051)
--      already returns for writes, plus an optional `p_scope` FILTER.
--
-- WHY A FILTER PARAMETER AND NOT A COMPANION "per-scope total" RPC: the buckets
-- are additive (a sum of `result_count`), so the filtered buckets' SUM *is* the
-- per-scope headline. A second function would be a second definition of the
-- same number, free to drift from the bars it is drawn above — the property
-- 00053 exists to protect.
--
-- BACKWARD COMPATIBILITY of the grouped shape: the sole consumer today is
-- `packages/web/src/lib/aggregations.ts`'s `computeCountTrend`, which sums
-- `row.count` into UTC time-slots and reads no other field. Splitting one row
-- per bucket into N rows per bucket therefore produces the identical trend —
-- the same argument 00051 made for the write series.
--
-- DEFERRED (R10): `purge_expired_memories` (00045) is deliberately UNTOUCHED.
-- It records one `memory.expired` event per purge run, but the run is per-USER
-- and spans every scope that user owns, so there is no single scope to
-- attribute it to — splitting that event per scope is a separate change with
-- its own shape decision, not the cheap case this migration handles.
--
-- Forward-only and additive throughout: the column is nullable, the writer's
-- new parameter is trailing + defaulted, and the reader's is trailing +
-- defaulted, so every existing row and every existing caller is unaffected.
-- ═════════════════════════════════════════════════════════════════════════

-- ── the column ──────────────────────────────────────────────────────────────
alter table usage_events add column if not exists scope text;

-- Bound the value as a BACKSTOP, not as the primary gate — the same reasoning
-- 00044 gives for `usage_events_correlation_id_len` and 00054 for
-- `usage_events_client_len`. The authoritative validator is `safeValidateScope`
-- (the canonical `validateScope` wrapped to return null instead of throwing); a
-- CHECK re-encoding the scope grammar in SQL would be a second, drift-prone
-- copy of it, while an unbounded column would let a malformed value inflate
-- analytics cardinality. 200 chars is the same ceiling `memories.scope` uses.
--
-- BACKSTOP means the recording side clamps FIRST: `safeValidateScope` returns
-- null above `USAGE_SCOPE_MAX` (= 200), so a grammatical but over-long scope is
-- recorded as unattributed instead of reaching this CHECK. It has to — the
-- violation would be raised inside `lorekit_record_usage_event`, whose `when
-- others` handler swallows it and returns null, dropping the WHOLE event rather
-- than just the scope dimension. Same clamp-then-check pairing 00044 has between
-- `parseCorrelationId` and `usage_events_correlation_id_len`.
alter table usage_events drop constraint if exists usage_events_scope_len;
alter table usage_events add constraint usage_events_scope_len
  check (scope is null or (char_length(scope) between 1 and 200));

-- Index the read this exists for: "my read events under THIS scope, newest
-- first". Partial on the non-null rows because a NULL scope carries no
-- information to filter on — the same shape as 00054's client index.
create index if not exists usage_events_user_scope_created_idx
  on usage_events (user_id, scope, created_at desc)
  where scope is not null;

-- ── writer: add a trailing p_scope ──────────────────────────────────────────
-- DROP first (not CREATE OR REPLACE): adding a parameter changes the signature,
-- and a bare CREATE would leave the previous overload behind and make every
-- call ambiguous. The signature dropped here is the FOURTEEN-argument one from
-- 00056 (which added `p_kind`/`p_host`), not 00054's twelve — a stale drop
-- target is silent, leaving both overloads live and every named-argument call
-- ambiguous at runtime. Body is 00056's verbatim plus the one column.
drop function if exists lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text, text, text, text);

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
  p_client         text    default null,
  p_kind           text    default null,
  p_host           text    default null,
  p_scope          text    default null
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
    result_count, correlation_id, client, kind, host,
    scope
  ) values (
    p_user_id, p_org_id, p_plan_name,
    p_tool_name, p_scope_type, p_auth_type,
    p_outcome, p_duration_ms, p_memory_count,
    p_result_count, p_correlation_id, p_client, p_kind, p_host,
    p_scope
  )
  returning id into v_id;
  return v_id;
exception
  when others then
    -- Never let telemetry writes break the primary operation.
    return null;
end;
$$;

grant execute on function lorekit_record_usage_event(uuid, uuid, text, text, text, text, text, integer, integer, integer, text, text, text, text, text)
  to anon, authenticated, service_role;

-- ── reader: one row per (bucket, scope), plus an optional scope filter ──────
-- DROP first: the RETURN TYPE gains a column, which CREATE OR REPLACE cannot
-- do ("cannot change return type of existing function"), and the parameter list
-- gains a trailing entry. Everything else — the bucket validation, the
-- half-open window, the self-only visibility with the service-role escape
-- hatch, the read-tool list, the dashboard exclusion, the sparse `having` — is
-- 00053/00054's verbatim.
drop function if exists lorekit_read_activity(uuid, text, timestamptz, timestamptz);

create or replace function lorekit_read_activity(
  p_user_id uuid,
  p_bucket  text        default 'day',
  p_since   timestamptz default null,
  p_until   timestamptz default null,
  p_scope   text        default null
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
begin
  if p_bucket is null or p_bucket not in ('hour', 'day') then
    raise exception 'invalid bucket %, expected hour or day', p_bucket
      using errcode = '22023';
  end if;

  return query
    select date_trunc(p_bucket, ue.created_at at time zone 'UTC') at time zone 'UTC' as bucket,
           ue.scope as scope,
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
       -- The optional per-scope filter. `=`, not `is not distinct from`: a
       -- caller asking for a named scope wants events attributed to it, never
       -- the unattributable NULL-scope remainder. Omitting the parameter
       -- returns every scope INCLUDING those NULL rows, so the unfiltered
       -- account total stays complete.
       and (p_scope is null or ue.scope = p_scope)
       and (p_since is null or ue.created_at >= p_since)
       and (p_until is null or ue.created_at <  p_until)
     group by 1, ue.scope
    having sum(coalesce(ue.result_count, 0)) > 0
     order by 1 asc;
end;
$$;

revoke execute on function lorekit_read_activity(uuid, text, timestamptz, timestamptz, text) from public, anon;
grant  execute on function lorekit_read_activity(uuid, text, timestamptz, timestamptz, text) to authenticated, service_role;

comment on function lorekit_read_activity(uuid, text, timestamptz, timestamptz, text) is
  'Memory RECORDS read (sum of usage_events.result_count over memory.read /
   memory.list / memory.search / memory.list_archived — permissions.ts''s
   READ_TOOLS) per UTC hour/day AND per scope over the half-open
   [p_since, p_until) window, EXCLUDING events attributed to the dashboard
   client (00054). One row per (bucket, scope), mirroring
   lorekit_memory_activity (00051); scope is NULL for events whose scope could
   not be resolved, and those rows are counted in the unfiltered result.
   p_scope restricts the result to one exact scope, whose buckets SUM to the
   per-scope headline — the metric is additive, so no companion total function
   exists to drift from it. Visibility is SELF-ONLY with the same service-role +
   NULL escape hatch as lorekit_usage_stats — usage is a per-user ledger and is
   never org-shared. p_bucket is validated against (hour, day). Buckets with no
   records read are omitted.';
