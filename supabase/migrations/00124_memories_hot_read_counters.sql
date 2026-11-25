-- 00124 — cut the Disk IO that read counting costs.
--
-- WHY. Supabase warned that the hosted project was depleting its Disk IO
-- budget. The steady writer behind it is `lorekit_record_memory_reads` (00104):
-- every memory a list, search or read RETURNS gets an `UPDATE memories` that
-- moves read_count / last_read_at (and, on a targeted agent read,
-- opened_count / last_opened_at). A bulk read of 20 lessons is 20 row updates.
--
-- Those updates were never HOT. Postgres can only update a row in place
-- (a heap-only tuple, no index writes) when NO indexed column changes and the
-- page has room. `read_count` and `opened_count` are indexed by 00085 and 00104,
-- so every counter bump wrote a new entry into EVERY index on `memories`:
-- the HNSW embedding index, the fts / trigram / tags GIN indexes and ~17
-- btrees. It also left a dead tuple in each of them for autovacuum, and
-- vacuuming an HNSW index is itself expensive.
--
-- WHAT.
--   1. Drop the two counter indexes (step 3 below). With them gone, no column a counter
--      update moves is indexed (asserted by migrations.test.sql §124 AC-1), so
--      the update qualifies for HOT. Their only consumers are the
--      `max_read_count` / `max_opened_count` conditions and the opened-count
--      sort, all of which are already narrowed to ONE user's rows (the memory
--      cap bounds that at 5000) by `memories_user_idx` and friends, so a
--      filter or sort over the counter is an in-memory step, not a scan.
--   2. fillfactor 85 (step 4) on `memories`, so a page keeps room for the new tuple a
--      HOT update needs. It applies to pages written from now on; existing
--      full pages gain room as HOT pruning reclaims their dead tuples. No
--      VACUUM FULL here: that would lock the table on production.
--   3. `rate_limit_counters` becomes UNLOGGED (step 1). It is written on every
--      authenticated request and holds only the current minute's counters; an
--      unlogged table skips the WAL for it. After a crash an unlogged table is
--      truncated, which here means a user's current window restarts at zero —
--      harmless. No table references it, so the change is allowed.
--   4. The pg_stat_statements export (00074, step 2) runs every 5 minutes instead of
--      every minute. Each tick writes a pg_cron run record and a pg_net
--      request/response row. The exported values are cumulative counters, so a
--      coarser tick loses resolution, never data (00074's own argument).
--
-- NOT CHANGED. The counter columns, `lorekit_record_memory_reads`, every
-- reader and every RPC signature are untouched. "A read must never restamp
-- `updated_at`" (00103/00104) still holds: the trigger already preserves the
-- stamp on a counter-only update, which is also what keeps the update HOT
-- (`updated_at` is indexed).

-- LOCK WINDOW. This file is one transaction, so every lock is held until it
-- ends. `set unlogged` rewrites `rate_limit_counters` under ACCESS EXCLUSIVE;
-- the table holds only the last hour of one-row-per-user windows (purged every
-- 15 minutes by 00004), so the rewrite is a few thousand rows at most, and
-- requests wait on it for milliseconds. `drop index` takes ACCESS EXCLUSIVE on
-- `memories` and `set (fillfactor)` SHARE UPDATE EXCLUSIVE; both are catalog
-- changes with no rewrite. They come LAST so `memories` is locked for the
-- shortest stretch, and `lock_timeout` makes a queued lock fail the push fast
-- instead of stalling every request behind it.
set local lock_timeout = '5s';

-- 1. the per-request rate-limit counter needs no WAL ───────────────────────────
alter table rate_limit_counters set unlogged;

-- 2. export query stats every 5 minutes ─────────────────────────────────────────
-- Guarded like 00074 so the migration applies without pg_cron; cron.schedule()
-- upserts by job name, so this replaces the schedule in place.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'lorekit-export-db-query-stats',
      '*/5 * * * *',
      $cron$select lorekit_export_db_query_stats()$cron$
    );
  end if;
end;
$$;

-- 3. counter indexes ──────────────────────────────────────────────────────────
drop index if exists memories_user_read_count_idx;
drop index if exists memories_user_opened_count_idx;

-- 4. leave room for HOT updates ────────────────────────────────────────────────
alter table memories set (fillfactor = 85);
