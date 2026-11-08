# Migrations — review context

Facts a reviewer cannot recover from one migration file. The mechanical checklist lives in
`.agents/review/lenses/migration-*.md`; this file is the why, and the invariants those lenses enforce.
A migration that breaks an invariant below is a defect, not a style point.

## How a migration reaches production

- **Forward-only.** Each file is applied once, in one transaction, then never again. An edit to a merged
  file changes nothing on a database that already ran it. A fix is a new, higher-numbered file.
- **One transaction per file means every lock is held to the end of the file.** `CREATE INDEX CONCURRENTLY`
  and `REINDEX ... CONCURRENTLY` cannot run in a transaction, so they appear only in comments (00033, 00061,
  00076, 00086, 00096). Plain builds are deliberate here. 00061 carries a `LOCK WINDOW` note and the others explain the lock in prose; 00109, a plain build on `usage_events`, says nothing about it, which is the gap the lens closes.
  A `NOT VALID` constraint validated in the same file keeps its first lock until commit, so the
  `VALIDATE CONSTRAINT` belongs in a later file.
- **Migrations push before Edge Functions deploy, and rollback restores only functions** (`HEAD~1`). The
  previous commit's code therefore runs against the NEW schema during every rollout and after every rollback.
  Removing or renaming anything that code calls is a two-step expand/contract across two releases.
- **The shared `preview` project is pushed from open PR heads and never rolled back.** Orphan objects from
  an abandoned PR persist, so a migration must tolerate being re-applied over leftovers (`if not exists`).
- **Number gaps (00029, 00040, 00087, 00091, 00097) are grandfathered.** `check-migration-order.mjs` rejects
  an ADDED file numbered at or below the base branch's highest.

## Where the volume is

- **`usage_events` is the highest-volume table by construction.** One SessionStart hook call can write
  about 31 rows. Every index added there taxes every write, and a predicate no index serves scans the
  account's whole history. 00109 exists because `/memories/read-activity` hit `statement timeout` after
  about 20 s of pure database wait, concentrated on heavy accounts.
- **`audit_log` is append-only and grows without bound.** Pagination is keyset on `(created_at desc, id)`.
- **`memories` is capped (5000 active per user) and held to a size where a brief lock is accepted today**
  (00076, 00086). That is a bounded judgment, not a licence for a long lock, a rewrite or a backfill.
- **Indexes can look right and still not be used.** 00076 added `memories_tags_idx`, and the sequential-scan
  signature came back four days later (00086 rebuilt and `ANALYZE`d it). A new index is only proven by the
  query plan, so the header comment names the query it serves.

## Invariants (a violation is a defect)

1. A statement that takes ACCESS EXCLUSIVE on `memories`, `usage_events` or `audit_log` runs under a
   `lock_timeout`, and a table rewrite (`ALTER COLUMN TYPE`, a volatile-default `ADD COLUMN`) is never
   done in a migration on a populated table.
2. A backfill is bounded. An unbounded `UPDATE` or `DELETE` in one migration transaction holds row locks,
   bloats the table and can trip the statement timeout.
3. Every predicate and `ORDER BY` a new RPC or view uses has an index with matching leading columns
   (`user_id` or the tenant key first). Keyset paging orders on `(sort key, id)`; `OFFSET` is never used.
4. A list RPC is bounded, and a COUNT describes exactly the rows its list returns.
5. A partial-index predicate is immutable, and the query restates it verbatim or the planner skips the index.
6. Vector indexes are HNSW, not IVFFlat, and stay at or under 2000 dimensions (00060).
7. A new RLS policy writes `(select auth.uid())`, not a bare `auth.uid()`, so it is evaluated once per
   statement; tenant visibility reuses `lorekit_member_org_ids()`. Existing policies that still use the bare
   form are legacy, and a diff that does not touch them is not a finding.
8. Every `SECURITY DEFINER` function sets `search_path` and authorises inside its own body. The `lk_*`
   token path runs as service-role and bypasses RLS, so a definer RPC that trusts a caller-supplied
   user id is a cross-tenant hole.
9. A new function revokes execute from `public` and `anon` (00047 repaired the default grant).
10. A new table enables RLS and defines its policies in the same file.
11. A changed function signature drops the old one. A `CREATE OR REPLACE` with new arguments leaves a
    second overload and makes the RPC call ambiguous. Same-signature `CREATE OR REPLACE` (00110) is fine.
12. A read-recording function never restamps `updated_at` (00103); read counters and write timestamps are
    separate facts. A new trigger on a hot table does constant-time work per row.
13. No numeric limit is hardcoded; limits resolve through `lorekit_default_limit` / `lorekit_get_limit`.
14. A new business rule, RPC or trigger ships with assertions in `supabase/tests/migrations.test.sql`, and
    a changed table or column regenerates `supabase/functions/_shared/db/database.types.ts`.

## Deliberate patterns that look wrong

- **A plain `CREATE INDEX` with a long header comment.** The comment is the evidence the plan needs
  (`THE BUG` / `THE FIX` / `LOCK WINDOW`); do not ask for it to be shortened.
- **A non-concurrent `REINDEX` in 00086.** It takes ACCESS EXCLUSIVE and was accepted for a small `memories`;
  it is precedent for that table size only.
- **`SECURITY DEFINER` on write RPCs.** Authorisation is derived in the function body (actor guard,
  `lorekit_org_can`, scope allowlists); table RLS is intentionally not the gate for them (00073).
- **Aggregates computed in Postgres, not in the client.** A `select ... limit N` plus a client-side reduce
  is silently wrong for the accounts with the most data (00039).
