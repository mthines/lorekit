-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_usage_runs — enumerate the runs `?correlation_id=` can only filter.
--
-- THE GAP: `GET /memories/usage?correlation_id=` filters TO one run, but
-- nothing ENUMERATES which runs exist — a user has no way to discover which
-- correlation ids to even ask about. This is the payoff view: a browsable
-- list of runs (local sessions, CI jobs, PR automations — migration 00082's
-- session_kind), each showing what it read, from which scopes, how long it
-- took, and whether it wrote anything back.
--
-- WHICH "READ"/"WRITE": the BROADER usage-stats.ts READ_TOOL_NAMES /
-- WRITE_TOOL_NAMES vocabulary (memory.scopes/usage/org.list included on the
-- read side) — a run summary answers "what did this run do overall", not the
-- narrower "memories read" card question lorekit_read_activity/
-- memory_read_daily answer. Spelled out as a literal list here (this is SQL,
-- not TypeScript, so the two cannot share a runtime import) and named
-- explicitly in the function comment so a future reader does not assume it
-- matches the narrow one.
--
-- NO ORG AXIS: usage_events is a per-user ledger with no org_id column to
-- narrow by — same posture as lorekit_usage_stats/lorekit_read_activity.
--
-- KEYSET PAGINATION, NOT OFFSET: follows the Audit Logs precedent
-- (`lib/pagination/keyset.ts`/`cursor.ts` on the web side) — an opaque
-- (last_seen, correlation_id) cursor, and the RPC applies its OWN user_id
-- filter so a forged cursor cannot widen visibility, only mis-page the
-- caller's own rows. Grouping happens BEFORE the keyset predicate (a CTE),
-- since the sort key (last_seen = max(created_at)) only exists post-aggregate.
--
-- WINDOW: bounded by the CALLER (the REST handler defaults to a bounded
-- window when none is given, the UNBOUNDED_STATS_RANGE posture
-- `lib/queries/explorer-stats.ts` already established) — an all-time
-- enumeration over the highest-volume table in the schema is the performance
-- cliff that posture exists to avoid.
--
-- INDEX: `usage_events_user_correlation_idx (user_id, correlation_id,
-- created_at desc) where correlation_id is not null` (00044) already orders
-- exactly what this function groups and filters on, so the GROUP BY can walk
-- it as a sorted scan rather than a hash aggregate over the whole table. No
-- new index added — the existing one is the right shape for this query,
-- verification of the actual plan is deferred to CI's Integration smoke job
-- (this sandbox has no live Postgres to EXPLAIN against).
-- ═════════════════════════════════════════════════════════════════════════

create or replace function lorekit_usage_runs(
  p_user_id             uuid,
  p_since               timestamptz default null,
  p_until               timestamptz default null,
  p_cursor_last_seen    timestamptz default null,
  p_cursor_correlation_id text      default null,
  p_limit               integer     default 20
)
returns table (
  correlation_id  text,
  session_kind    text,
  first_seen      timestamptz,
  last_seen       timestamptz,
  read_events     bigint,
  records_read    bigint,
  write_events    bigint,
  distinct_scopes bigint,
  total_duration_ms bigint
)
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
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  -- usage-stats.ts's READ_TOOL_NAMES / WRITE_TOOL_NAMES, spelled out here
  -- since SQL cannot import the TypeScript source of truth. Keep in step by
  -- hand if that list ever changes.
  v_read_tools  text[] := array['memory.read', 'memory.list', 'memory.search',
                                 'memory.scopes', 'memory.list_archived',
                                 'memory.usage', 'org.list', 'org.get',
                                 'member.list', 'member.invite_list'];
  v_write_tools text[] := array['memory.write', 'memory.delete', 'memory.archive',
                                 'memory.restore', 'memory.purge', 'memory.purge_expired',
                                 'org.create', 'org.rename', 'org.delete',
                                 'member.role_change', 'member.remove',
                                 'member.invite', 'member.revoke'];
begin
  return query
    with runs as (
      select
          ue.correlation_id,
          -- A run is assumed internally consistent (one CLI invocation's
          -- environment does not change mid-run); max() is a simplification
          -- for the rare case a correlation id is reused across differing
          -- session_kind values, not a claim that every event agreed.
          max(ue.session_kind) as session_kind,
          min(ue.created_at) as first_seen,
          max(ue.created_at) as last_seen,
          count(*) filter (where ue.tool_name = any(v_read_tools)) as read_events,
          coalesce(sum(ue.result_count) filter (where ue.tool_name = any(v_read_tools)), 0) as records_read,
          count(*) filter (where ue.tool_name = any(v_write_tools)) as write_events,
          count(distinct ue.scope) filter (where ue.scope is not null) as distinct_scopes,
          coalesce(sum(ue.duration_ms), 0) as total_duration_ms
        from usage_events ue
       where (
               (v_actor is null and auth.role() = 'service_role')
               or ue.user_id = v_actor
             )
         and ue.correlation_id is not null
         and (p_since is null or ue.created_at >= p_since)
         and (p_until is null or ue.created_at <  p_until)
       group by ue.correlation_id
    )
    select r.correlation_id, r.session_kind, r.first_seen, r.last_seen,
           r.read_events, r.records_read, r.write_events, r.distinct_scopes,
           r.total_duration_ms
      from runs r
     where p_cursor_last_seen is null
        or (r.last_seen, r.correlation_id) < (p_cursor_last_seen, p_cursor_correlation_id)
     order by r.last_seen desc, r.correlation_id desc
     limit v_limit;
end;
$$;

revoke execute on function lorekit_usage_runs(uuid, timestamptz, timestamptz, timestamptz, text, integer) from public, anon;
grant  execute on function lorekit_usage_runs(uuid, timestamptz, timestamptz, timestamptz, text, integer)
  to authenticated, service_role;

comment on function lorekit_usage_runs(uuid, timestamptz, timestamptz, timestamptz, text, integer) is
  'Enumerates runs (distinct correlation_id values) with per-run session_kind,
   first/last seen, read/write event and record counts, distinct scopes
   touched, and total duration. Uses usage-stats.ts''s BROADER
   READ_TOOL_NAMES/WRITE_TOOL_NAMES (not lorekit_read_activity''s narrower
   4-tool "read" definition) -- a run summary answers "what did this run do
   overall". Keyset-paginated on (last_seen desc, correlation_id desc); the
   caller supplies the previous page''s last row as the cursor. Self-only
   visibility, same escape hatch as lorekit_usage_stats. No org axis --
   usage_events is a per-user ledger.';
