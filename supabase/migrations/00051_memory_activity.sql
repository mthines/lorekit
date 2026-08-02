-- ═════════════════════════════════════════════════════════════════════════
-- lorekit_memory_activity(p_user_id, p_bucket, p_since, p_until) — memories
-- created per UTC hour/day per scope, for GET /memories/activity.
--
-- WHY: the dashboard's stat cards (24h / 7d / 30d sparkbars + period-over-
-- period change) and the contribution heatmap both need "how many memories,
-- when, in which scope". Both were computed client-side from a raw
-- `select scope, created_at ... limit 1000` — truncated without warning past
-- the cap, and shipping up to 1000 rows to a browser to produce ~60 numbers.
--
-- Bucketing in Postgres is exact at any volume and the payload is bounded by
-- (buckets × active scopes) rather than by memory count. `date_trunc` anchors
-- each bucket at the START of the UTC hour/day, which is precisely where the
-- client's own bucket boundaries fall (`Math.floor(t / HOUR_MS) * HOUR_MS` and
-- `Date.UTC(y, m, d)` in packages/web/src/lib/aggregations.ts), so a client
-- tallying these rows gets the same numbers it got from raw rows.
--
-- The [p_since, p_until) window is half-open, matching lorekit_usage_stats
-- (00043). Both bounds are optional; the CALLER is responsible for choosing a
-- window, and the edge handler defaults it rather than leaving it unbounded.
--
-- p_bucket is a bounded categorical ('hour' | 'day'), validated here as well as
-- at the edge. It is passed to date_trunc as a plpgsql function ARGUMENT, not
-- interpolated into SQL text, so there is no injection surface — this function
-- builds no dynamic SQL at all (no EXECUTE, no format()). The check earns its
-- place anyway: date_trunc on an unknown field raises an opaque 22023 from
-- inside the query, so validating up front turns that into a named, testable
-- error (AC-5 in supabase/tests/migrations.test.sql). Anything else raises.
--
-- Actor resolution, visibility, grants, and plpgsql-for-ordering are the
-- 00046/00047 rule verbatim.
-- ═════════════════════════════════════════════════════════════════════════

create or replace function lorekit_memory_activity(
  p_user_id uuid,
  p_bucket  text        default 'day',
  p_since   timestamptz default null,
  p_until   timestamptz default null
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
    select date_trunc(p_bucket, m.created_at at time zone 'UTC') at time zone 'UTC' as bucket,
           m.scope,
           count(*) as count
      from memories m
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
       and (p_since is null or m.created_at >= p_since)
       and (p_until is null or m.created_at <  p_until)
     group by 1, m.scope
     order by 1 asc, m.scope asc;
end;
$$;

revoke execute on function lorekit_memory_activity(uuid, text, timestamptz, timestamptz) from public, anon;
grant  execute on function lorekit_memory_activity(uuid, text, timestamptz, timestamptz) to authenticated, service_role;

comment on function lorekit_memory_activity(uuid, text, timestamptz, timestamptz) is
  'Memories created per UTC hour/day per scope over the half-open
   [p_since, p_until) window, visible to the EFFECTIVE caller. Same
   service-role-gated actor rule and tenant predicate as
   lorekit_memory_scopes. p_bucket is validated against (hour, day).';
