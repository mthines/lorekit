-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_usage_stats — group by client, kind, host too.
--
-- THE GAP: `usage_events` has stored `client` (00054), `kind`/`host` (00056)
-- for months, and `GET /memories/usage` exposes none of them. "Who is
-- reading" (client) and "which agent family" (kind × host) are both
-- unanswerable from the API despite the columns already existing — the exact
-- shape of dead data 00056's own history warns about (kind/host sat NULL for
-- a release because nothing wired them into the write payload; this is the
-- READ half of the same mistake, just without the bug — the columns are
-- populated, only unexposed).
--
-- SIGNATURE CHANGE: the RETURNS TABLE gains three columns, so this is a DROP
-- + recreate (matching 00054/00058/00076's own precedent on this exact
-- function), not a bare CREATE OR REPLACE, which cannot change a return type
-- and would leave the four-column overload live for an ambiguous call.
--
-- CORRECTNESS: widening the GROUP BY only ever REFINES existing buckets —
-- summing `event_count` over the new, finer-grained rows reproduces the
-- exact total the old query gave, because no join or row duplication is
-- introduced. `summarizeUsageRows`/`rollupByScopeType` (usage-stats.ts) need
-- no code change for this reason; their own unit tests gain a regression
-- case proving a row set split across client/kind/host still summarises
-- identically to the un-split version.
--
-- SCOPE_TYPE BUCKETING: unchanged from 00044 — legacy free-text values pass
-- through verbatim on this RPC (bucketing happens at READ time in the web
-- client, per the global constraint on this work; this RPC's job is to
-- return the true grouped rows, not to pre-judge which values are "known").
--
-- HOST CARDINALITY: `host` is OPEN free-text (a new host is a new agent, not
-- a migration) — the one dimension of the three that can blow up a busy
-- account's row count. Bounded here to the top 20 hosts by event count
-- within the query's own window; anything outside that top 20 collapses to
-- the literal `'other'` (NULL host stays NULL — a scopeless/hostless call is
-- not "some other host", it has none). This is a per-QUERY top-20, computed
-- fresh from the window's own data, not a global config — a different window
-- can legitimately show a different top 20.
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
    with visible as (
      select e.*
        from usage_events e
       where (
               (p_user_id is null and auth.role() = 'service_role')
               or e.user_id = p_user_id
             )
         and (p_since is null or e.created_at >= p_since)
         and (p_until is null or e.created_at <  p_until)
         and (p_correlation_id is null or e.correlation_id = p_correlation_id)
    ),
    top_hosts as (
      select v.host
        from visible v
       where v.host is not null
       group by v.host
       order by count(*) desc, v.host asc
       limit 20
    )
    select
        v.tool_name,
        v.outcome,
        v.scope_type,
        v.client,
        v.kind,
        case
          when v.host is null then null
          when v.host in (select th.host from top_hosts th) then v.host
          else 'other'
        end as host,
        count(*)                          as event_count,
        coalesce(sum(v.result_count), 0)  as record_count,
        coalesce(sum(v.duration_ms), 0)   as total_duration_ms
      from visible v
     group by v.tool_name, v.outcome, v.scope_type, v.client, v.kind,
       case
         when v.host is null then null
         when v.host in (select th.host from top_hosts th) then v.host
         else 'other'
       end
     order by event_count desc, v.tool_name asc;
end;
$$;

revoke execute on function lorekit_usage_stats(uuid, timestamptz, timestamptz, text) from public;
grant execute on function lorekit_usage_stats(uuid, timestamptz, timestamptz, text)
  to authenticated, service_role;

comment on function lorekit_usage_stats(uuid, timestamptz, timestamptz, text) is
  'Usage events grouped by (tool_name, outcome, scope_type, client, kind, host)
   over the half-open [p_since, p_until) window, self-only visibility with the
   service-role + NULL actor escape hatch. host is bounded to the window''s own
   top 20 by event count; anything else collapses to ''other'' (NULL host stays
   NULL). Summing event_count over every row reproduces the pre-00079 total —
   the extra dimensions only refine existing buckets, never duplicate rows.';
