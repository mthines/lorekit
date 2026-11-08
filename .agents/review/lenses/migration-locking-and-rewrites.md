---
for: pr-reviewer
lens-version: 1
applies-to: "supabase/migrations/*.sql"
---

# Migration locking and rewrites — Review Lens

## Trigger

Any added or changed `supabase/migrations/*.sql`. Each file is ONE transaction, so every lock a statement takes is held until the file ends, and production reads and writes queue behind it.

## Checklist

- [ ] `create index concurrently` / `reindex ... concurrently` is absent as a statement (it cannot run in a transaction and fails the push); a plain build on `usage_events`, `audit_log` or `memories` carries a comment naming what blocks and why that is acceptable (`LOCK WINDOW`, as in 00061).
- [ ] An `alter table` on `memories`, `usage_events`, `audit_log` or another table that grows without bound opens with `set local lock_timeout` so a queued ACCESS EXCLUSIVE lock fails fast instead of stalling every request behind it.
- [ ] No `alter column ... type`, no `add column` with a volatile default (`now()`, `gen_random_uuid()`, `random()`), and no `add column ... not null` without a constant default on a populated table (each rewrites the table under ACCESS EXCLUSIVE).
- [ ] A new `check` or foreign-key constraint on a populated table is `not valid`, and its `validate constraint` sits in a LATER migration file (validating in the same file keeps the first lock until commit).
- [ ] No unbounded `update`, `delete` or `insert ... select` over a growing table; a backfill is bounded, batched out of band, or the table is shown to be tiny, and an `analyze` follows a large backfill or a new index.
- [ ] No `drop` or `rename` of a column, table, function or argument that the PREVIOUS commit's edge functions or dashboard still call (migrations push before functions deploy, and rollback restores only functions); the removal is a later contract migration.
- [ ] A new trigger on `memories` or `usage_events` does constant-time work per row, never a scan or an aggregate over the table, and the comment names the write path it adds cost to.
- [ ] A merged migration is not edited in place; a fix is a new, higher-numbered file (an edit never re-runs on a database that already applied it).

## Severity hints

- **Must-fix**: `concurrently` as a statement, a table rewrite, a same-file `validate constraint`, an unbounded backfill, a drop that breaks the previous release, an edited merged migration.
- **Should-fix**: missing `lock_timeout`, missing lock-window comment, missing `analyze`.
