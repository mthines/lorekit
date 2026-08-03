-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_read_activity(p_user_id, p_bucket, p_since, p_until) — memory
-- RECORDS read per UTC hour/day, for GET /memories/read-activity.
--
-- WHY: the Overview's third stat card claims to measure reads, but no
-- reads-over-time series existed, so it charted memories WRITTEN under a
-- "scopes active" headline — a chart whose bars measured one thing and whose
-- number measured another. Reads are already recorded: every MCP tool call and
-- every REST route writes one `usage_events` row (00034), and 00044 added
-- `result_count`, the RECORDS a call touched. Summing that over the read tools
-- is an additive metric, so the sparkbar's bars add up to the headline — the
-- property every card on that page is now held to.
--
-- Modelled on lorekit_memory_activity (00051): same bucket validation, same
-- half-open [p_since, p_until) window, same date_trunc anchoring so a JS client
-- bucketing by UTC hour/day tallies identically.
--
-- Visibility is SELF-ONLY, unlike 00051. Usage is a per-user ledger: there is
-- no org sharing of read events (a co-member's reads are not the caller's
-- activity, and usage_events has no org_id at all), so this uses the same
-- self-only predicate + service-role escape hatch as lorekit_usage_stats
-- (00043) and deliberately does NOT join lorekit_member_org_ids — that function
-- is the tenant predicate for `memories` visibility, not for usage.
--
-- The read-tool list is an inline literal, mirroring how 00045 filters
-- `memory.expired` inline. `packages/mcp-core/src/permissions.ts`'s READ_TOOLS
-- carries the same four strings, but it is the MCP permission gate, not a SQL
-- artefact, and there is no mechanism to share a TS constant with a migration.
-- Keep the two in step by hand if a read tool is ever added.
--
-- It mirrors READ_TOOLS — the memory read-FAMILY — and deliberately NOT
-- `usage-stats.ts`'s broader READ_TOOL_NAMES, which additionally classifies
-- `memory.scopes`, `memory.usage`, `org.list`, `org.get`, `member.list` and
-- `member.invite_list` as reads. Those are analytics and org listings, not
-- memory records, so `GET /usage`'s `records_read` is legitimately LARGER than
-- the sum here; a card headlined "Memories read" must not count `org.list`.
--
-- `having sum(...) > 0` keeps the payload sparse: only buckets that actually
-- read something come back, exactly as 00051's aggregate is sparse.
-- ═════════════════════════════════════════════════════════════════════════

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
   READ_TOOLS) per UTC hour/day over the half-open
   [p_since, p_until) window. Visibility is SELF-ONLY with the same
   service-role + NULL escape hatch as lorekit_usage_stats — usage is a
   per-user ledger and is never org-shared. p_bucket is validated against
   (hour, day). Buckets with no records read are omitted.';
