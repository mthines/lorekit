-- ═════════════════════════════════════════════════════════════════════════
-- Rebuild + verify memories_tags_idx — the GIN index 00076 added is not
-- preventing the seq-scan it was meant to fix.
--
-- WHAT'S HAPPENING (2026-08-28, service.name=web, service.namespace=lorekit)
--
-- The "web — elevated backend p95 latency" check fired again
-- (Dash0 issues 8667967338373977430 and 9019610890880570001), and the
-- offending trace reproduces EXACTLY the signature 00076 diagnosed and was
-- meant to close:
--
--   HEAD /rest/v1/memories?select=id                                    0.398s
--   HEAD /rest/v1/memories?select=id&tags=cs.%7Bsource%3A%3Apr-webhook%7D 101.697s
--
-- Same sibling-comparison signature as before — the unfiltered count stays
-- sub-second while the `tags @> ARRAY['source::pr-webhook']` containment
-- read (still `getOnboardingState()`, still awaited by every `/overview`
-- render) balloons to 100+ seconds. `memories_tags_idx` (00076) should be
-- serving this predicate; a query that should be an index scan is behaving
-- like a sequential scan again, four days after the fix merged.
--
-- WHAT THIS MIGRATION DOES
--
-- It does not change the query or the index definition — 00076's GIN index
-- on `tags` with the default `array_ops` opclass is still the right shape
-- for `@>`/`<@`/`&&`. This is a repair-and-verify pass for the cases that
-- would silently defeat an otherwise-correct index without any schema
-- change showing up in a diff:
--
--   1. The index exists but is marked INVALID (e.g. a prior CONCURRENTLY
--      build — none is used here or in 00076, but a manual out-of-band
--      rebuild could have left one) or has drifted from the heap due to
--      bloat, so the planner (correctly) stops trusting it.
--   2. Table/index statistics are stale, so the planner's cost estimate for
--      the containment scan no longer favours the index over a seq scan
--      even though the index itself is fine.
--
-- `REINDEX INDEX` rebuilds the index from scratch against the current heap,
-- resolving (1) unconditionally. `ANALYZE` refreshes the planner's
-- statistics on `memories`, resolving (2). Running both costs nothing when
-- neither was the problem — a fresh REINDEX of a healthy index is a no-op
-- in effect, and ANALYZE is always safe to re-run.
--
-- `CONCURRENTLY` is deliberately NOT used, matching 00076's own reasoning:
-- Supabase migrations run inside a transaction and neither
-- `REINDEX INDEX CONCURRENTLY` nor `CREATE INDEX CONCURRENTLY` can run
-- inside one. The `memories` table remains small enough that a regular
-- (briefly lock-holding) REINDEX is the right trade-off, consistent with
-- every other index build in this schema (00001_memories.sql, 00076).
--
-- `create index if not exists` is kept ahead of the REINDEX as a safety net
-- in case the index was dropped outright rather than merely degraded —
-- `REINDEX INDEX` errors on a missing index, so recreating it first keeps
-- this migration safely re-runnable regardless of which failure mode
-- produced today's regression.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists memories_tags_idx on memories using gin (tags);

reindex index memories_tags_idx;

analyze memories;

comment on index memories_tags_idx is
  'GIN index supporting tags @> / <@ / && containment queries (e.g. '
  'onboarding-server.ts''s source::pr-webhook check), avoiding a sequential '
  'scan on every /overview render. Rebuilt + ANALYZEd by 00086 after the '
  'same seq-scan signature reappeared four days after 00076 first added it '
  '(Dash0 issues 8667967338373977430 / 9019610890880570001).';
