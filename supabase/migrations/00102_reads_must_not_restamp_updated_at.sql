-- ═════════════════════════════════════════════════════════════════════════
-- 00102 — a READ must not rewrite `updated_at`.
--
-- THE BUG, observed in production on 2026-09-03:
--
--     BEFORE  updated_at = 2026-09-03T17:49:09.236723+00:00
--     GET     /memories?scope=repo::mthines/agent-skills&limit=100
--     AFTER   updated_at = 2026-09-03T17:50:04.978342+00:00
--
-- No write of any kind was issued. `lorekit_record_memory_reads` (00099) does
--
--     update memories m set read_count = m.read_count + 1, last_read_at = now()
--
-- to record that a read happened, and that UPDATE fires the BEFORE-row trigger
-- `lorekit_memories_set_updated_at`, which stamps `updated_at = now()`. Because
-- a single `memory.list` page carries ~55 rows and every one of them gets the
-- counter bump, ONE bulk read restamps ~55 memories.
--
-- WHAT IT COST, measured on the same account the day this was written:
--   * 0 of 2,475 sampled memories had an `updated_at` older than 14 days,
--     against a median row age of 22 days and a maximum of 77 — freshness was
--     unreadable because every row looked touched-just-now.
--   * `updated_at` is the DEFAULT SORT for both the dashboard Explorer and
--     `memory.list order=recency`, so the ordering agents receive lore in was
--     being driven by which rows happened to be read most recently — that is,
--     by nothing.
--   * The detail sheet's "Last updated" field was showing a last-READ time
--     under a last-WRITTEN label.
--
-- THE FIX is the one migration 00062 already established for the embedding
-- columns, applied to the read counters: a DERIVED column must not rewrite the
-- recency signal that search, `relevant`, the keyset index and lesson-rank all
-- read. 00062's function is EXTENDED rather than replaced, so `memories` keeps
-- exactly one BEFORE UPDATE trigger and the two exemptions are stated in one
-- place instead of racing each other.
--
-- The predicate keeps 00062's shape for the reason its comment gives: mask the
-- derived columns plus `updated_at`, then compare the WHOLE rows, so a column
-- added to `memories` later is covered automatically where an explicit
-- "did any real column change" list would silently stop covering it.
--
-- The `v_*_changed` preconditions are equally load-bearing, and for 00062's
-- reason: without them the rule degrades to "nothing meaningful changed →
-- preserve", which also catches a plain NO-OP re-write — and `memory_write`
-- upserts, so an agent re-saving an identical lesson would stop refreshing
-- `updated_at`. Preserve only when a derived column ACTUALLY moved and nothing
-- else did.
--
-- `set_updated_at` itself is still LEFT ALONE — six other tables share it
-- (`user_limits`, `orgs`, `org_limits`, `plans`, `user_plans`,
-- `retention_policies`) and none of them has counters or this problem.
-- ═════════════════════════════════════════════════════════════════════════

create or replace function lorekit_memories_set_updated_at()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_new memories := new;
  v_old memories := old;
  v_embedding_changed boolean;
  v_counters_changed  boolean;
begin
  -- 00062's exemption: an embedding write.
  v_embedding_changed :=
       new.embedding is distinct from old.embedding
    or new.embedding_model is distinct from old.embedding_model;

  -- This migration's exemption: a read-counter write from
  -- `lorekit_record_memory_reads`. `last_opened_at` is included because a
  -- TARGETED read moves it in the same statement as `read_count`; leaving it
  -- unmasked would make every targeted read look like a real edit.
  v_counters_changed :=
       new.read_count     is distinct from old.read_count
    or new.last_read_at   is distinct from old.last_read_at
    or new.last_opened_at is distinct from old.last_opened_at;

  -- Mask the derived columns and the one being decided.
  --
  -- `fts` MUST be masked too, for 00062's reason: it is a GENERATED column and
  -- Postgres computes generated columns AFTER BEFORE-row triggers run, so
  -- `new.fts` is NULL here while `old.fts` holds the stored value. An unmasked
  -- comparison finds every update "changed", which silently turns this whole
  -- function back into `set_updated_at`. It fails in the safe direction (a bump
  -- that should not happen, never a missing bump), which is exactly why it
  -- needs a test rather than a reading — see migrations.test.sql §101.
  v_new.embedding := null; v_new.embedding_model := null;
  v_new.read_count := null; v_new.last_read_at := null; v_new.last_opened_at := null;
  v_new.updated_at := null; v_new.fts := null;

  v_old.embedding := null; v_old.embedding_model := null;
  v_old.read_count := null; v_old.last_read_at := null; v_old.last_opened_at := null;
  v_old.updated_at := null; v_old.fts := null;

  if (v_embedding_changed or v_counters_changed)
     and v_new is not distinct from v_old then
    -- A derived column moved and nothing else did. Preserve the row's real
    -- recency rather than restamping it.
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;

  return new;
end;
$$;

-- The trigger already points here (00062); recreated so a fresh database and a
-- migrated one land in the same state regardless of which migrations ran.
create or replace trigger memories_updated_at
  before update on memories
  for each row execute function lorekit_memories_set_updated_at();

comment on function lorekit_memories_set_updated_at() is
  'BEFORE UPDATE on memories: bumps updated_at like set_updated_at, EXCEPT when the only change is '
  'a DERIVED column — the embedding pair (00062) or the read counters read_count/last_read_at/'
  'last_opened_at (00102). Neither may rewrite the recency signal that search, relevant, the keyset '
  'index, lesson-rank and BOTH default sorts (Explorer, memory.list order=recency) all read. Before '
  '00102 a single bulk memory.list restamped every row on the page, so updated_at reported '
  'last-READ under a last-WRITTEN name and recency ordering was effectively arbitrary.';
