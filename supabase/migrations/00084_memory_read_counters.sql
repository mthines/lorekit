-- ═════════════════════════════════════════════════════════════════════════
-- Per-memory read counters + daily rollup — closing the structural gap:
-- `usage_events` records HOW MANY records a call touched, never WHICH. There
-- is no `memory_id` on the read ledger and none of the tables in this schema
-- is a per-memory read table, so "is this lesson earning its place" is absent
-- from the data, not merely unsurfaced.
--
-- THE CHEAP SHAPE, deliberately NOT a per-read event table: at the observed
-- ~495K read records/month for a SINGLE account, an event table would be the
-- highest-volume table in the schema by an order of magnitude on day one and
-- would need retention + rollup from the start. Counters are bounded by
-- memories × days × read_kind instead of by traffic, and answer everything
-- except the finest-grained "show me every individual read event" question.
--
--   1. `memories.read_count` / `.last_read_at` — the two numbers a reader
--      wants on the detail sheet without any join: "how many times, and when
--      last". `not null default 0` so every existing memory starts at a real,
--      countable zero rather than a NULL that reads as "unknown".
--
--   2. `memory_read_daily(memory_id, day, read_kind, count)` — the
--      per-context breakdown a bare counter cannot answer ("read this week vs
--      last month"). `read_kind` distinguishes `targeted` (`memory.read`, one
--      exact scope+key) from `bulk` (`memory.list` / `memory.search` /
--      `memory.list_archived`, every row a listing call returned) — reusing
--      `lorekit_read_activity`'s OWN narrow 4-tool "read" definition, not the
--      broader `READ_TOOL_NAMES` in `usage-stats.ts` (which also counts
--      `memory.scopes` / `memory.usage` / `org.list` — none of which touch a
--      single memory row, so none of them ever call the writer below at all).
--      This is the DOCUMENTED choice migration 00053 already forces every
--      "split by read definition" decision to make explicit; see
--      `lorekit_record_memory_reads`'s comment.
--
--      Deliberately WITHOUT a `session_kind` dimension (local/CI/PR
--      automation): that requires deriving `session_kind` at the point of the
--      call, which is separate, not-yet-shipped work. Adding it later is a
--      column addition to this same table, not a redesign — `read_kind`
--      alone already answers "opened vs skimmed", the question this migration
--      exists to unlock.
--
-- WRITE PATH: `lorekit_record_memory_reads(p_memory_ids uuid[], p_read_kind
-- text)`, called once per request with every memory id that request actually
-- returned — a bulk `list` returning 31 rows is ONE call with a 31-element
-- array, never 31 statements. Same fail-safe contract as
-- `lorekit_record_usage_event`: a counter update must never fail the read it
-- is measuring, so the whole body is wrapped in `when others` and swallows
-- any error rather than propagating it. No-ops on an empty/null array (a
-- call that matched nothing touched no memory) and skips ids under
-- concurrent deletion via `on conflict do nothing`-style tolerance (see the
-- function body).
--
-- CUTOVER: every existing memory starts at `read_count = 0`, which is
-- indistinguishable from "never read" — it is really "never read SINCE this
-- migration". Consumers (the Wave E "hot/cold lore" work) MUST carry this
-- migration's deployment date through their copy as the cutover, or the very
-- first cold-lore view flags the entire pre-existing library as unused. This
-- migration does not itself claim a cutover date — deployment time is server
-- history, not migration-file content — but the requirement is recorded here
-- so the consuming PR cannot skip it.
--
-- RETENTION on `memory_read_daily`: follows `usage_events`'
-- `lorekit_purge_old_usage_events` precedent (a scheduled pg_cron sweep) —
-- deferred to the PR that actually schedules it, since this migration adds no
-- pg_cron job of its own and an unbounded promise here would be undeliverable.
-- The table is additive-only and its own row count is bounded by
-- memories × days × 2 (read_kind), which grows far slower than usage_events.
--
-- CASCADE: `on delete cascade` from `memories` — an archived memory KEEPS its
-- counters (archiving never deletes the row), a PURGED memory's rollup rows
-- are removed with it, so no orphaned `memory_read_daily` row can ever
-- outlive the memory it counted reads for.
-- ═════════════════════════════════════════════════════════════════════════

-- ── memories: the two counters ───────────────────────────────────────────
alter table memories add column if not exists read_count integer not null default 0;
alter table memories add column if not exists last_read_at timestamptz;

-- A non-negative backstop, matching the `usage_events.scope_count` (00076)
-- reasoning: the app-side increment is the primary gate, this is insurance
-- against a direct insert/update putting a negative count on a row a "most
-- read" ranking will sort by.
alter table memories drop constraint if exists memories_read_count_non_negative;
alter table memories add constraint memories_read_count_non_negative
  check (read_count >= 0);

-- ── memory_read_daily: the per-context rollup ────────────────────────────
create table if not exists memory_read_daily (
  memory_id  uuid    not null references memories(id) on delete cascade,
  day        date    not null,
  read_kind  text    not null,
  count      integer not null default 0,
  primary key (memory_id, day, read_kind)
);

-- Bounded, closed, app-code vocabulary — the `client`/`scope_type` CHECK
-- pattern (migration 00054), not an enumerating gate: `read_kind` is closed to
-- exactly two values today (`targeted`/`bulk`), and this CHECK is the
-- backstop against a third value smuggling itself into a grouped column, not
-- the primary authority for what the values mean.
alter table memory_read_daily drop constraint if exists memory_read_daily_read_kind_check;
alter table memory_read_daily add constraint memory_read_daily_read_kind_check
  check (read_kind in ('targeted', 'bulk'));

alter table memory_read_daily drop constraint if exists memory_read_daily_count_non_negative;
alter table memory_read_daily add constraint memory_read_daily_count_non_negative
  check (count >= 0);

-- The one read this table exists for: "this memory's read history, most
-- recent day first" (the per-memory consumption panel on the detail sheet).
-- The primary key already covers memory_id lookups; this orders them.
create index if not exists memory_read_daily_memory_day_idx
  on memory_read_daily (memory_id, day desc);

alter table memory_read_daily enable row level security;
-- No policies: this table is never read or written through PostgREST/RLS —
-- every access is through the SECURITY DEFINER functions below (the write) and
-- the ranked RPC a later PR adds (the read), exactly like `usage_events`. RLS
-- enabled with zero policies denies every direct PostgREST request by default,
-- which is the point: a service-role or SECURITY DEFINER context bypasses RLS
-- entirely, so this is a backstop against the one path that is not one of those
-- — an anon/authenticated key querying the table directly.

revoke all on memory_read_daily from anon, authenticated;
grant select, insert, update on memory_read_daily to service_role;

-- ── the writer ────────────────────────────────────────────────────────────
create or replace function lorekit_record_memory_reads(
  p_memory_ids uuid[],
  p_read_kind  text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_memory_ids is null or array_length(p_memory_ids, 1) is null then
    return;
  end if;

  -- ONE statement for every id, not one per id — the hot-path requirement a
  -- bulk `list` returning 31 rows imposes. `unnest` turns the array into a rowset
  -- the UPDATE can join against directly.
  update memories m
     set read_count = m.read_count + 1,
         last_read_at = now()
    from unnest(p_memory_ids) as ids(id)
   where m.id = ids.id;

  -- Upsert today's rollup row per memory — one INSERT, conflict-aggregated,
  -- same shape as the update above. `current_date` is UTC-anchored the same
  -- way `usage_events`' other date_trunc'd reads are (`at time zone 'UTC'`),
  -- so a rollup day boundary agrees with every other UTC-bucketed series in
  -- this schema.
  insert into memory_read_daily (memory_id, day, read_kind, count)
  select ids.id, (now() at time zone 'UTC')::date, p_read_kind, 1
    from unnest(p_memory_ids) as ids(id)
  on conflict (memory_id, day, read_kind)
  do update set count = memory_read_daily.count + 1;
exception
  when others then
    -- Never let a counter write break the read it is measuring.
    return;
end;
$$;

revoke execute on function lorekit_record_memory_reads(uuid[], text) from public, anon;
grant execute on function lorekit_record_memory_reads(uuid[], text) to authenticated, service_role;

comment on function lorekit_record_memory_reads(uuid[], text) is
  'Increments memories.read_count/.last_read_at and today''s memory_read_daily
   row (UTC day, keyed by read_kind) for every memory id a read call actually
   returned, in ONE statement regardless of array size. read_kind is
   targeted (memory.read) or bulk (memory.list / memory.search /
   memory.list_archived) -- lorekit_read_activity''s own narrow "read"
   definition, not usage-stats.ts''s broader READ_TOOL_NAMES. Fail-safe: never
   throws, so a counter-write failure cannot fail the read it measures. No-op
   on a null/empty array.';
