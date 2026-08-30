-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_read_activity gains read_kind — the honesty fix for "Memories read".
--
-- THE PROBLEM: "Memories read: 494,839" in a live 30-day sample is 99.7% bulk
-- list/search output — the SessionStart hook injecting ~31 lessons per call,
-- ~16,000 times. Targeted `memory.read` accounts for 1,487 records. One
-- number carries two completely different behaviours: a hook priming context
-- and an agent deliberately opening a specific lesson.
--
-- THE FIX: split the series by `read_kind` — `'targeted'` for `memory.read`
-- (one exact scope+key), `'bulk'` for `memory.list` / `memory.search` /
-- `memory.list_archived` (every row a listing call returned).
--
-- WHICH "READ": this is `lorekit_read_activity`'s OWN narrow inline 4-tool
-- list (00053's `tool_name in ('memory.read', 'memory.list', 'memory.search',
-- 'memory.list_archived')`), extended in place with a `case` on the SAME
-- list — NOT `usage-stats.ts`'s broader `READ_TOOL_NAMES`, which also counts
-- `memory.scopes` / `memory.usage` / `org.list`. A card headlined "Memories
-- read" must not count `org.list`. The two definitions are deliberately
-- different elsewhere in this schema (see migration 00077's memory_read_daily,
-- which makes the identical choice for the identical reason) and this
-- migration does not blur them.
--
-- SIGNATURE CHANGE: the RETURNS TABLE gains a column, so DROP + recreate.
-- Body is 00069's verbatim (the `p_key_scopes` allowlist narrowing, the
-- dashboard-client exclusion, the half-open window, the UTC date_trunc
-- anchoring) plus the one `read_kind` case expression, folded into both the
-- SELECT list and the GROUP BY.
-- ═════════════════════════════════════════════════════════════════════════

drop function if exists lorekit_read_activity(uuid, text, timestamptz, timestamptz, text, text[]);

create or replace function lorekit_read_activity(
  p_user_id uuid,
  p_bucket  text        default 'day',
  p_since   timestamptz default null,
  p_until   timestamptz default null,
  p_scope   text        default null,
  -- The CALLING KEY's scope allowlist (00068). No org parameters: `usage_events`
  -- is a per-user ledger with no org_id, so there is no tenancy axis to narrow.
  p_key_scopes text[] default '{}'
)
returns table (bucket timestamptz, scope text, read_kind text, count bigint)
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
           case when ue.tool_name = 'memory.read' then 'targeted' else 'bulk' end as read_kind,
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
       -- The calling key's scope allowlist (00068). A NULL scope is an
       -- unattributable read: it names nothing, so it leaks nothing, and it is
       -- passed through rather than dropped.
       and (ue.scope is null or lorekit_api_token_scope_allowed(p_key_scopes, ue.scope))
       -- The optional per-scope filter. `=`, not `is not distinct from`: a
       -- caller asking for a named scope wants events attributed to it, never
       -- the unattributable NULL-scope remainder.
       and (p_scope is null or ue.scope = p_scope)
       and (p_since is null or ue.created_at >= p_since)
       and (p_until is null or ue.created_at <  p_until)
     group by 1, ue.scope,
       case when ue.tool_name = 'memory.read' then 'targeted' else 'bulk' end
    having sum(coalesce(ue.result_count, 0)) > 0
     -- Bucket, scope, THEN read_kind: extends 00051/00069's tiebreak with the
     -- new dimension rather than replacing it, so intra-bucket row order
     -- stays a total order now that a (bucket, scope) pair can hold two rows.
     order by 1 asc, ue.scope asc, read_kind asc;
end;
$$;

revoke execute on function lorekit_read_activity(uuid, text, timestamptz, timestamptz, text, text[])
  from public, anon;
grant  execute on function lorekit_read_activity(uuid, text, timestamptz, timestamptz, text, text[])
  to authenticated, service_role;

comment on function lorekit_read_activity(uuid, text, timestamptz, timestamptz, text, text[]) is
  'Memory RECORDS read per UTC hour/day, scope, AND read_kind
   (targeted = memory.read, bulk = memory.list/search/list_archived — this
   function''s own narrow 4-tool definition, NOT usage-stats.ts''s broader
   READ_TOOL_NAMES) over the half-open [p_since, p_until) window, excluding
   the dashboard client (00054) and narrowed to the calling key''s scope
   allowlist (00068/00069). One row per (bucket, scope, read_kind); retrieved
   + opened sum to the same total the pre-00080 function gave for the same
   window. Visibility is SELF-ONLY with the service-role + NULL escape hatch.';
