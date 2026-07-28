-- Performance optimisations for the hot read paths in tools.ts.
--
-- Analysis of the three most-called query patterns:
--
-- 1. toolRead  — SELECT … FROM memories WHERE scope=? AND key=?
--               AND archived_at IS NULL AND (expires_at IS NULL OR expires_at > now())
--    Existing  : memories_scope_key (scope, key) — hits the filter, but forces
--               a heap fetch + recheck for archived_at / expires_at on every row.
--    Fix       : Replace with a PARTIAL index that pre-filters active, non-expired
--               rows and adds user_id so api_key queries can satisfy the full
--               predicate from the index alone (index-only scan).
--
-- 2. toolList  — SELECT … FROM memories WHERE scope=? AND archived_at IS NULL
--               AND (expires_at IS NULL OR expires_at > now())
--               ORDER BY updated_at DESC LIMIT ?
--    Existing  : memories_scope_idx (scope) — covers the WHERE but not the ORDER.
--               Postgres sorts in-memory; large scopes cause a filesort.
--    Fix       : Add (scope, updated_at DESC) so the planner can satisfy the
--               order from the index and stop early after LIMIT rows.
--
-- 3. toolListArchived — WHERE scope=? AND archived_at IS NOT NULL
--                       ORDER BY archived_at DESC LIMIT ?
--    Existing  : No index covering (scope, archived_at).
--    Fix       : Add a PARTIAL index (archived_at IS NOT NULL) on (scope, archived_at DESC).
--
-- 4. memberOrgIds RPC — called on every api_key read (toolRead / toolList /
--               toolSearch / toolListArchived). The RPC itself is already fast,
--               but adding a covering index on org_members (user_id, org_id)
--               means the SECURITY DEFINER function never hits the heap.
--
-- 5. rate_limit_counters — the existing primary key (user_id, window_start) is
--               the look-up key, so the insert+read is already index-friendly.
--               Add a partial index to accelerate the reaper query
--               (lorekit_purge_rate_limit_counters) which deletes old windows.
--
-- All indexes are created with IF NOT EXISTS + CONCURRENTLY so they can be
-- added to a running production database without a table lock.

-- 1. Active-memories point-read covering index.
--    Covers: toolRead, and the cap trigger's active-row count.
create index if not exists memories_scope_key_active_idx
  on memories (scope, key, user_id)
  where archived_at is null;

-- 2. List-by-scope ordered index — eliminates the filesort for toolList.
create index if not exists memories_scope_updated_at_idx
  on memories (scope, updated_at desc)
  where archived_at is null;

-- 3. Archived list ordered index — eliminates the filesort for toolListArchived.
create index if not exists memories_scope_archived_at_idx
  on memories (scope, archived_at desc)
  where archived_at is not null;

-- 4. org_members covering index — eliminates heap fetch for memberOrgIds RPC.
create index if not exists org_members_user_org_idx
  on org_members (user_id, org_id);

-- 5. rate_limit_counters reaper partial index.
--    The reaper deletes rows WHERE window_start < now() - interval.
--    The existing window_start idx already covers this but a partial index
--    skips the live current-window rows, which shrinks index scans.
create index if not exists rate_limit_counters_old_windows_idx
  on rate_limit_counters (window_start)
  where window_start < now() - interval '1 hour';

-- 6. Schedule automatic expired-memory purge via pg_cron (when available).
--    Expired memories (expires_at < now()) are invisible to all read paths but
--    still occupy cap headroom and bloat the table. Purge them nightly.
--    lorekit_purge_all_expired_memories() is defined below.
create or replace function lorekit_purge_all_expired_memories()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from memories
   where expires_at is not null
     and expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function lorekit_purge_all_expired_memories() to service_role;

-- Schedule nightly at 03:00 UTC when pg_cron is available.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'lorekit-purge-expired-memories',
      '0 3 * * *',
      $cron$select lorekit_purge_all_expired_memories()$cron$
    );
  end if;
end;
$$;
