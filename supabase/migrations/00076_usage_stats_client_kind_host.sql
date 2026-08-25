-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_usage_stats — group by client, kind, host, not just tool/outcome/
-- scope_type.
--
-- THE GAP: `usage_events` has stored `client` (00054), `kind`/`host` (00056)
-- for a while, but `lorekit_usage_stats` groups by `tool_name, outcome,
-- scope_type` only. "Who is reading" (client) and "reads by agent family"
-- (kind × host) are both stored and both unanswerable from `/memories/usage`.
-- Meaningful only after `client` is actually populated on new traffic (the
-- default-usage-client-per-transport change this migration is stacked on) —
-- grouping by an always-null column is a query, not a feature.
--
-- WHY WIDENING THE GROUP-BY CANNOT BREAK THE SUMMARY: `summarizeUsageRows` /
-- `rollupByScopeType` (telemetry/usage-stats.ts) sum `event_count`/
-- `record_count` over ALL returned rows regardless of how many columns they are
-- grouped by. Widening a GROUP BY only ever REFINES existing groups into more,
-- smaller ones over the SAME underlying `usage_events` rows (no join, so no
-- fan-out) — the sum over the refined rows is definitionally identical to the
-- sum over the coarser ones. `usage-stats.spec.ts` pins this property directly:
-- summarizing the same event set grouped narrow vs wide must produce byte
-- identical summaries.
--
-- SIGNATURE CHANGE ⇒ DROP first, not CREATE OR REPLACE: the RETURN TABLE gains
-- three columns, which `CREATE OR REPLACE` cannot do ("cannot change return
-- type of existing function"). The 00044 four-argument signature is what is
-- dropped; 00043's three-argument one is already gone.
--
-- ROW-COUNT GROWTH: `client` (4 values) and `kind` (3 values) are closed and
-- cheap. `host` is OPEN free-text — a new host is a new agent, not a schema
-- change — and is the one dimension that can blow up a heavy account's result
-- set. Capped at 500 rows (`order by event_count desc`), so the biggest buckets
-- always survive a truncation. The function itself returns up to 501 rows (the
-- SAME "fetch one past the cap" sentinel `buildPage`/`_shared/api/paginate.ts`
-- already use elsewhere in this codebase) so the handler can tell "exactly 500
-- rows" apart from "truncated at 500" and report `truncated: true` rather than
-- silently looking complete. 500 is generous headroom over any observed
-- account (the pre-widening query was already bounded only by tool_name ×
-- outcome × scope_type, typically under 100 rows) while still being a real,
-- finite cap.
--
-- BUCKETING scope_type: unchanged by this migration — `scope_type` already
-- carries whatever legacy free-text values a wide window has; grouping by it
-- was already the caller's job to bucket (see `bucketScopeType` in the web
-- package), and adding new columns to the SAME row does not change that.
-- ═════════════════════════════════════════════════════════════════════════

drop function if exists lorekit_usage_stats(uuid, timestamptz, timestamptz, text);

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
  client            text,
  kind              text,
  host              text,
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
        e.client,
        e.kind,
        e.host,
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
     group by e.tool_name, e.outcome, e.scope_type, e.client, e.kind, e.host
     -- Biggest buckets first, so a 500-row truncation always drops the LEAST
     -- meaningful rows (a heavy account's long tail of one-off hosts) rather
     -- than an arbitrary slice.
     order by event_count desc, e.tool_name asc
     -- 500 + 1: the overflow row is the handler's truncation sentinel, never
     -- rendered — see the module docblock above.
     limit 501;
end;
$$;

revoke execute on function lorekit_usage_stats(uuid, timestamptz, timestamptz, text) from public;
grant execute on function lorekit_usage_stats(uuid, timestamptz, timestamptz, text)
  to authenticated, service_role;

comment on function lorekit_usage_stats(uuid, timestamptz, timestamptz, text) is
  'Usage events grouped by (tool_name, outcome, scope_type, client, kind, host)
   over the half-open [p_since, p_until) window, optionally filtered to one
   correlation_id. Self-only visibility with the service-role + NULL escape
   hatch. Returns up to 501 rows (event_count desc) as a backstop against an
   open host dimension on a heavy account -- the 501st row is the handler''s
   truncation sentinel (never rendered) so it can report whether the 500-row
   cap was hit.';
