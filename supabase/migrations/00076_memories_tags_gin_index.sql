-- ═════════════════════════════════════════════════════════════════════════
-- GIN index on memories.tags — fixes the occasional multi-second stall behind
-- the "web — elevated backend p95 latency" check (Dash0 issue 9019610890880570001).
--
-- WHAT WAS HAPPENING
--
-- `getOnboardingState()` (packages/web/src/lib/onboarding-server.ts), awaited
-- by every `/overview` render, issues two count-only reads against `memories`:
--
--   select id, { count: 'exact', head: true }
--   select id, { count: 'exact', head: true }.contains('tags', ['source::pr-webhook'])
--
-- The second predicate compiles to `tags @> ARRAY['source::pr-webhook']`. The
-- `tags` column (00001_memories.sql) has never had a supporting index — the
-- table has a GIN index on `fts`, a btree on `scope`, `user_id`, and
-- `(scope, key)`, but nothing on `tags` — so this containment check runs a
-- sequential scan over every row RLS leaves visible. Traced instances of
-- `GET /overview` (2026-08-24, service.name=web, service.namespace=lorekit)
-- show this exact fetch at 0.55–0.9s normally and spiking to 7.559s in the
-- trace that crossed the alert's 4s p95 threshold — a seq-scan signature, not
-- network variance, since the sibling unfiltered count on the same table
-- stayed under 0.8s throughout.
--
-- THE FIX
--
-- A standard GIN index on a `text[]` column supports `@>`/`<@`/`&&` directly
-- (default `array_ops` opclass) with no query-side change — the existing
-- `.contains(...)` call starts using it as soon as this migration applies.
-- `CONCURRENTLY` is deliberately NOT used: Supabase migrations run inside a
-- transaction and `CREATE INDEX CONCURRENTLY` cannot run inside one, and the
-- `memories` table is small enough today that a regular (briefly
-- lock-holding) build is the right trade-off, matching every other index in
-- 00001_memories.sql.
--
-- Scope note: this migration only fixes the missing index. The separate
-- architectural question — `onboarding-server.ts` reads `memories` directly
-- via supabase-js instead of through the `/memories` REST endpoint, per the
-- "Data access goes through a REST endpoint" rule in the root CLAUDE.md — is
-- out of scope for this fix; it is a pre-existing surface predating that rule
-- and migrating it is a larger, separate change.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists memories_tags_idx on memories using gin (tags);

comment on index memories_tags_idx is
  'GIN index supporting tags @> / <@ / && containment queries (e.g. '
  'onboarding-server.ts''s source::pr-webhook check), avoiding a sequential '
  'scan on every /overview render.';
