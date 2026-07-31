-- lorekit_usage_stats(p_user_id, p_since, p_until) — aggregate usage counts a
-- caller can read back about THEIR OWN activity, for GET /memories/usage.
--
-- usage_events (00034) already captures one row per MCP tool call and one per
-- REST route (tool_name, outcome, scope_type, auth_type, duration_ms, …). What
-- was missing was any way to READ those rows back as aggregates: the table had
-- an RLS select policy but no endpoint, RPC, tool or CLI consumed it. This is
-- that read side — "how many reads/writes today, per scope, per outcome" so a
-- human or agent can judge whether LoreKit is helping.
--
-- Aggregate in Postgres, not with a select + client-side reduce, for the same
-- reason as lorekit_memory_scopes (00039): a client-side rollup is silently
-- truncated past PostgREST's row cap, dropping whole buckets with no error. One
-- grouped row per (tool_name, outcome, scope_type) is exact at any volume, and
-- the group cardinality is bounded (tool_name × outcome × scope_type are all
-- bounded categoricals).
--
-- Visibility is self-only, matching the usage_events RLS select policy
-- (user_id = auth.uid()): a caller sees only their own events. The
-- `p_user_id is null and auth.role() = 'service_role'` branch is the CI /
-- service-role escape hatch, exactly as lorekit_memory_scopes uses it and safe
-- for the same reason — auth.role() reads the VERIFIED JWT role claim PostgREST
-- sets, never request input, so an `authenticated` caller passing p_user_id =>
-- null gets nothing back (user_id = null is NULL) and the function fails closed.
--
-- The [p_since, p_until) window is half-open and both bounds are optional
-- (NULL = unbounded), so the caller controls the period: p_since = start-of-day
-- answers "today", p_since = now()-7d answers "this week", both NULL is
-- all-time. total_duration_ms is summed for latency-per-bucket analysis.
--
-- SECURITY DEFINER + STABLE (read-only, keyed on an explicit p_user_id rather
-- than a client-asserted claim) and plpgsql rather than SQL for the same
-- ordering reason as lorekit_memory_scopes: a plpgsql RETURN QUERY is never
-- inlined, so the ORDER BY is part of the contract, not an accident of the
-- planner.
create or replace function lorekit_usage_stats(
  p_user_id uuid,
  p_since   timestamptz default null,
  p_until   timestamptz default null
)
returns table (
  tool_name         text,
  outcome           text,
  scope_type        text,
  event_count       bigint,
  total_duration_ms bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
-- The RETURNS TABLE columns double as OUT variables; qualify every reference and
-- make the column win on any residual ambiguity.
#variable_conflict use_column
begin
  return query
    select
        e.tool_name,
        e.outcome,
        e.scope_type,
        count(*)                        as event_count,
        coalesce(sum(e.duration_ms), 0) as total_duration_ms
      from usage_events e
     where (
             (p_user_id is null and auth.role() = 'service_role')
             or e.user_id = p_user_id
           )
       and (p_since is null or e.created_at >= p_since)
       and (p_until is null or e.created_at <  p_until)
     group by e.tool_name, e.outcome, e.scope_type
     order by event_count desc, e.tool_name asc;
end;
$$;

-- NOT granted to `anon`, matching lorekit_memory_scopes / lorekit_member_org_ids:
-- the function takes a bare p_user_id, so an unauthenticated caller with EXECUTE
-- could read any user's usage aggregates. `authenticated` is safe because the
-- edge functions resolve p_user_id from the verified credential, never request
-- input; `service_role` is the CI escape hatch.
grant execute on function lorekit_usage_stats(uuid, timestamptz, timestamptz)
  to authenticated, service_role;
