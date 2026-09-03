-- ═════════════════════════════════════════════════════════════════════════
-- 00106 — citations: the signal pull-through cannot give.
--
-- WHAT IS STILL MISSING AFTER 00103. `opened_count / read_count` measures
-- SELECTION — of all the times a lesson was surfaced, how often did something
-- deliberately reach for it. That is a real signal and it is the best one
-- available from read telemetry alone, but it systematically under-counts the
-- path lore is mostly consumed by: a lesson INJECTED at SessionStart is already
-- in the agent's context and never needs a second fetch to change what the
-- agent does. Its pull-through can be 0% while it is the single most
-- influential lesson in the store.
--
-- Every surface built on pull-through says so out loud (the Insights cost line
-- prints "this measures whether lore is looked up on purpose, not whether it
-- changed an outcome"). This migration is the other half: a way for the only
-- party that KNOWS whether a lesson was applied — the agent — to say so.
--
-- THE SHAPE. `memory.write` gains an optional `cited: string[]` of `scope::key`
-- references. The retrospective write an agent already makes at the end of a
-- run names the lessons that shaped it, and each name becomes a citation row
-- joined to the memory it cites, the memory it was written from, and the
-- `correlation_id` that groups the run (`usage_events` already carries that
-- key, and `/usage/runs` already enumerates it). One new optional field on an
-- existing verb, not a new tool: every entry in `tools/list` is context the
-- model pays for in every session, and this one has nothing to dispatch.
--
-- WHY A TABLE AND NOT JUST A COUNTER. The counter (`memories.cited_count`) is
-- what the dashboard reads and what a `max_cited_count` retention condition
-- would read, and it could have been the whole feature. The rows earn their
-- keep by answering the two questions a counter cannot: WHICH lesson credited
-- this one (so a load-bearing rule can be traced to the retrospectives that
-- kept invoking it) and WHICH RUN (so a citation joins to the same
-- `correlation_id` grouping `/usage/runs` already shows). A bare counter also
-- has no idempotency key, which is the next paragraph.
--
-- IDEMPOTENCY, AND WHY IT LEANS TOWARD UNDER-COUNTING. The unique key is
-- `(cited_memory_id, citing_memory_id, coalesce(correlation_id, ''))`: one
-- citation per cited lesson per citing lesson per run. A retried write inside
-- one run does not double-count. Two genuinely separate runs each count, which
-- is right — a lesson applied on Monday and again on Friday was applied twice.
-- A caller that sends NO correlation id collapses to a single citation for that
-- pair forever, which under-counts; that is the deliberate direction, because
-- an inflated influence number is worse than a conservative one on a surface
-- whose entire argument is that the existing numbers overstate.
--
-- THE `updated_at` EXEMPTION IS LOAD-BEARING (00102/00103). `cited_count` and
-- `last_cited_at` are the fifth and sixth columns of the derived set a READ-ish
-- path writes. Without adding them to the trigger's mask, recording a citation
-- would restamp the cited lesson's `updated_at` — reintroducing exactly the
-- bug 00102 fixed, on a new path, and making the freshness column lie again.
-- migrations.test.sql §105 AC-2 is that assertion.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. the counters on `memories` ─────────────────────────────────────────
alter table memories add column if not exists cited_count integer not null default 0;
alter table memories add column if not exists last_cited_at timestamptz;

alter table memories drop constraint if exists memories_cited_count_non_negative;
alter table memories add constraint memories_cited_count_non_negative
  check (cited_count >= 0);

comment on column memories.cited_count is
  'How many times an agent has explicitly CREDITED this lesson for shaping a run,
   via memory.write''s `cited` array (00106). Distinct from opened_count (00103),
   which counts deliberate FETCHES: a lesson injected at session start is already
   in context and can be applied without ever being fetched, so a lesson can have
   opened_count = 0 and a high cited_count. Never moved by any read. Not null,
   defaults to 0.';

comment on column memories.last_cited_at is
  'When this lesson was last explicitly credited by an agent (00106). Null until
   the first citation. Moved in the same statement as cited_count, off the same
   gate, so a count and its timestamp cannot disagree.';

-- ── 2. teach the trigger to mask them — BEFORE anything writes them ───────
-- 00102 exempted read_count/last_read_at/last_opened_at; 00103 added
-- opened_count. These are the fifth and sixth columns of the same derived set:
-- a citation is recorded ABOUT a lesson by a write to a DIFFERENT lesson, so
-- letting it restamp the cited row's `updated_at` would say "this lesson was
-- edited" when nobody touched its content. Asserted by §105 AC-2.
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

  -- 00102's exemption, extended by 00103 (opened_count) and 00106
  -- (cited_count/last_cited_at): a derived-counter write that is not an edit.
  v_counters_changed :=
       new.read_count     is distinct from old.read_count
    or new.last_read_at   is distinct from old.last_read_at
    or new.last_opened_at is distinct from old.last_opened_at
    or new.opened_count   is distinct from old.opened_count
    or new.cited_count    is distinct from old.cited_count
    or new.last_cited_at  is distinct from old.last_cited_at;

  -- Mask the derived columns and the one being decided.
  --
  -- `fts` MUST be masked too, for 00062's reason: it is a GENERATED column and
  -- Postgres computes generated columns AFTER BEFORE-row triggers, so
  -- `new.fts` is NULL here while `old.fts` holds the stored value. An unmasked
  -- comparison finds every update "changed", which silently turns this whole
  -- function back into `set_updated_at`. It fails in the safe direction (a bump
  -- that should not happen, never a missing bump), which is exactly why it
  -- needs a test rather than a reading — see migrations.test.sql §101/§105.
  v_new.embedding := null; v_new.embedding_model := null;
  v_new.read_count := null; v_new.last_read_at := null; v_new.last_opened_at := null;
  v_new.opened_count := null;
  v_new.cited_count := null; v_new.last_cited_at := null;
  v_new.updated_at := null; v_new.fts := null;

  v_old.embedding := null; v_old.embedding_model := null;
  v_old.read_count := null; v_old.last_read_at := null; v_old.last_opened_at := null;
  v_old.opened_count := null;
  v_old.cited_count := null; v_old.last_cited_at := null;
  v_old.updated_at := null; v_old.fts := null;

  if (v_embedding_changed or v_counters_changed)
     and v_new is not distinct from v_old then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;

  return new;
end;
$$;

comment on function lorekit_memories_set_updated_at() is
  'BEFORE UPDATE trigger on memories. Stamps updated_at = now() for a real
   content edit, and LEAVES IT ALONE for a write that only moves derived
   columns: the embedding pair (00062), the four read counters (00099/00102/
   00103) and the two citation counters (00106). Compares NEW to OLD with every
   derived column plus the generated `fts` masked out, so the exemption is a
   property of the whole row rather than a list of allowed callers.';

-- ── 3. the citation ledger ────────────────────────────────────────────────
create table if not exists memory_citations (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  cited_memory_id   uuid not null references memories(id) on delete cascade,
  -- SET NULL, not CASCADE: purging the retrospective that credited a lesson
  -- must not erase the evidence that the lesson was credited. The counter on
  -- `memories` would then disagree with the ledger, and the counter is the one
  -- the product reads.
  citing_memory_id  uuid references memories(id) on delete set null,
  correlation_id    text,
  created_at        timestamptz not null default now()
);

-- Same ceiling `usage_events.correlation_id` carries (00058), so a value that
-- groups a run there can always be stored here.
alter table memory_citations drop constraint if exists memory_citations_correlation_id_len;
alter table memory_citations add constraint memory_citations_correlation_id_len
  check (correlation_id is null or char_length(correlation_id) <= 200);

-- The idempotency key. `coalesce` because a NULL never equals a NULL in a
-- unique index, so without it an uncorrelated retry would insert a second row.
-- See the header for why collapsing the uncorrelated case is the deliberate
-- direction.
create unique index if not exists memory_citations_once_per_run_idx
  on memory_citations (cited_memory_id, citing_memory_id, coalesce(correlation_id, ''));

-- The two reads this table exists for: "who credited this lesson" and "what did
-- this run credit".
create index if not exists memory_citations_cited_idx
  on memory_citations (cited_memory_id, created_at desc);
create index if not exists memory_citations_user_correlation_idx
  on memory_citations (user_id, correlation_id)
  where correlation_id is not null;

alter table memory_citations enable row level security;
-- No policies, and the `memory_read_daily`/`usage_events` reasoning verbatim:
-- every access is through the SECURITY DEFINER function below. RLS on with zero
-- policies denies every direct PostgREST request, which is the backstop against
-- the one path that is neither service-role nor SECURITY DEFINER — an
-- anon/authenticated key querying the table directly.
revoke all on memory_citations from anon, authenticated;
grant select, insert on memory_citations to service_role;

comment on table memory_citations is
  'One row per (cited lesson, citing lesson, run): an agent explicitly crediting
   a lesson for shaping the run it just finished, recorded from memory.write''s
   `cited` array (00106). The influence signal pull-through (00103) cannot give,
   because a lesson injected at session start is applied without ever being
   fetched. Unique on (cited_memory_id, citing_memory_id, coalesce(correlation_id,
   '''')) so a retry inside one run counts once. Never read through PostgREST.';

-- ── 4. the writer ─────────────────────────────────────────────────────────
-- Takes the references as two PARALLEL ARRAYS rather than an array of composite
-- types, for the reason every other array-taking RPC here does: PostgREST maps
-- `text[]` cleanly from JSON and a composite type would need a matching
-- declared type on both sides of the wire.
create or replace function lorekit_record_memory_citations(
  p_user_id          uuid,
  p_citing_memory_id uuid,
  p_cited_scopes     text[],
  p_cited_keys       text[],
  p_correlation_id   text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer := 0;
begin
  if p_user_id is null
     or p_cited_scopes is null
     or array_length(p_cited_scopes, 1) is null
     or coalesce(array_length(p_cited_scopes, 1), 0) <> coalesce(array_length(p_cited_keys, 1), 0)
  then
    return 0;
  end if;

  -- Resolve refs → ids under the CALLER'S OWN tenancy, and nothing wider. This
  -- runs SECURITY DEFINER on a service-role connection where `auth.uid()` is
  -- NULL for the api_key tier, so the `user_id` predicate is the only thing
  -- standing between a citation and someone else's lore. A ref that resolves to
  -- nothing is silently skipped: it names a lesson this account cannot see, or
  -- one that has since been deleted, and neither is the write's problem.
  --
  -- Org-owned lore is deliberately NOT resolvable here yet. `memories.user_id`
  -- is the row's owner, and widening to `lorekit_member_org_ids` would let one
  -- member's retrospective move a counter on a shared lesson that other members
  -- read — a decision about shared state that belongs in its own change, with
  -- its own audit story. Under-counting again, deliberately.
  with refs as (
    select trim(s.scope) as scope, trim(k.key) as key
      from unnest(p_cited_scopes) with ordinality as s(scope, n)
      join unnest(p_cited_keys)   with ordinality as k(key, n) using (n)
     where trim(s.scope) <> '' and trim(k.key) <> ''
  ),
  resolved as (
    select distinct m.id
      from refs r
      join memories m
        on m.scope = r.scope
       and m.key = r.key
       and m.user_id = p_user_id
       and m.archived_at is null
     -- A lesson cannot cite itself. A retrospective that names its own key is
     -- a model echoing the write it is making, not evidence of anything.
     where p_citing_memory_id is null or m.id <> p_citing_memory_id
  ),
  ins as (
    insert into memory_citations (user_id, cited_memory_id, citing_memory_id, correlation_id)
    select p_user_id, resolved.id, p_citing_memory_id, p_correlation_id
      from resolved
    on conflict do nothing
    returning cited_memory_id
  ),
  bumped as (
    -- Only the rows that ACTUALLY inserted move a counter, which is what makes
    -- the counter and the ledger agree after a retry.
    select cited_memory_id, count(*)::integer as n from ins group by cited_memory_id
  ),
  upd as (
    update memories m
       set cited_count = m.cited_count + b.n,
           last_cited_at = now()
      from bumped b
     where m.id = b.cited_memory_id
    returning b.n
  )
  select coalesce(sum(n), 0)::integer into v_inserted from upd;

  return v_inserted;
exception
  when others then
    -- Never let a citation break the write it accompanies. Same posture as
    -- `lorekit_record_memory_reads` and `lorekit_record_usage_event`.
    return 0;
end;
$$;

comment on function lorekit_record_memory_citations(uuid, uuid, text[], text[], text) is
  'Records that the write identified by p_citing_memory_id credited each
   (p_cited_scopes[i], p_cited_keys[i]) lesson for shaping the run p_correlation_id
   groups, and bumps memories.cited_count/.last_cited_at for each citation that
   was actually new. Resolves references ONLY within p_user_id''s own active lore
   -- an unresolvable ref is skipped, and a self-citation is dropped. Returns how
   many citations were newly recorded (0 on a duplicate run, 0 on any error).
   Swallows its own errors: a citation must never break the write carrying it.';

grant execute on function lorekit_record_memory_citations(uuid, uuid, text[], text[], text)
  to authenticated, service_role;
