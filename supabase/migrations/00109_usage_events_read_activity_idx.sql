-- ═════════════════════════════════════════════════════════════════════════
-- 00109 — a covering index for lorekit_read_activity's own predicate.
--
-- THE BUG. `lorekit_read_activity` (00080) filters `usage_events` on
-- `user_id = v_actor AND tool_name IN ('memory.read', 'memory.list',
-- 'memory.search', 'memory.list_archived') AND created_at >= p_since AND
-- created_at < p_until` — and `GET /memories/read-activity` defaults that
-- window to 200 days when the caller passes no `since`/`until`
-- (`DEFAULT_WINDOW_DAYS`, read-activity.ts).
--
-- The only index that can serve that query is `usage_events_user_created_at_idx`
-- (00034) on `(user_id, created_at desc)` — it carries no `tool_name`, so
-- Postgres range-scans EVERY row the user wrote in the window and filters
-- `tool_name` afterward. `usage_events` is this schema's highest-volume table
-- by construction (00080's own comment: a single SessionStart hook can write
-- ~31 rows per call, ~16,000 times, in a 30-day sample) — so for an active
-- account a 200-day scan routinely touches hundreds of thousands of rows that
-- are never in the 4-tool read family at all (writes, org calls, etc.), all to
-- return a handful of read-family rows.
--
-- Observed in production: `GET /memories/read-activity` canceling with
-- "statement timeout" after ~20s of pure DB wait
-- (`lorekit.io.wait_ms` == the request's full duration), concentrated on
-- heavier accounts — exactly the profile a full per-user scan predicts.
--
-- THE FIX. A partial index scoped to the same 4-tool read family this
-- function already hardcodes, so Postgres can seek straight to the
-- `(user_id, created_at)` range within JUST those rows instead of scanning
-- the account's entire event history. Partial (not a plain 3-column index)
-- because the read family is a small, fixed slice of `tool_name`'s domain —
-- indexing the other tool names would bloat the index for no query that uses
-- them via this predicate.
-- ═════════════════════════════════════════════════════════════════════════

create index if not exists usage_events_user_tool_created_idx
  on usage_events (user_id, tool_name, created_at desc)
  where tool_name in ('memory.read', 'memory.list', 'memory.search', 'memory.list_archived');

comment on index usage_events_user_tool_created_idx is
  'Covers lorekit_read_activity''s (user_id, tool_name IN (4 read tools), created_at)
   predicate (00080) so the 200-day default window (read-activity.ts) does not
   force a full per-user scan of usage_events, this schema''s highest-volume
   table. Fixes production statement-timeout cancellations on
   GET /memories/read-activity for heavier accounts.';
