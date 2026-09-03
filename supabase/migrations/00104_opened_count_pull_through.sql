-- ═════════════════════════════════════════════════════════════════════════
-- 00104 — `opened_count`: the numerator that makes lore value comparable.
--
-- THE PROBLEM. All three counters a memory carries are ABSOLUTE COUNTS ON THE
-- SUPPLY SIDE — how often the system produced this lesson:
--
--   seen_count     (00059) how many times it was WRITTEN.  88.4% of a live
--                          2,475-row sample sit at exactly 1, so it has almost
--                          no variance to rank by.
--   read_count     (00084) how many times it was READ — but 99.80% of recorded
--                          reads are BULK ride-alongs in a list/search page, so
--                          this ranks SCOPE BREADTH, not usefulness. A `global`
--                          lesson is delivered on every session; a `branch`
--                          lesson almost never. Sorting by it puts every global
--                          lesson on top whether or not anything used it.
--   last_opened_at (00099) when an agent last deliberately fetched THIS lesson.
--                          The honest signal — and a bare timestamp, with no
--                          count and no denominator to compare rows by.
--
-- Value lives on the DEMAND side: given that a lesson was offered, did anything
-- take it up? That is a RATIO, and a ratio cancels the confound — scope breadth
-- appears in both numerator and denominator and divides away. A `global` lesson
-- delivered 1,300 times and opened twice scores 0.15%; a `branch` lesson
-- delivered 3 times and opened twice scores 67%. For the first time those two
-- numbers are comparable, and the second is obviously the more valuable.
--
-- PULL-THROUGH is defined here as `opened_count / read_count` — targeted opens
-- over TOTAL reads, not over bulk reads. A proper fraction in [0, 1]: bounded,
-- so it sorts; and defined for a lesson that has only ever been fetched
-- deliberately (which `targeted / bulk` would divide by zero on).
--
-- WHY A COLUMN, when `memory_read_daily(memory_id, day, read_kind, count)`
-- (00084) has stored the split since the counters shipped:
--
--   1. It has to be FILTERABLE at scale. `max_opened_count` (00105) is a
--      retention condition, and `lorekit_groom_candidates` runs it over a whole
--      scope. A per-memory aggregate over the rollup cannot be indexed; a
--      column can, and gets `memories_user_opened_count_idx` below, mirroring
--      00085's index on `read_count`.
--   2. It cannot DISAGREE with `last_opened_at`. Both move in the SAME
--      statement under the SAME gate inside `lorekit_record_memory_reads`, so
--      "opened 4 times" and "last opened on ..." are always the same event
--      stream. Deriving one from the rollup and reading the other from the row
--      is two sources for one fact.
--
-- The rollup is still the authority on HISTORY, which is what the backfill
-- below reads: every targeted read ever recorded, so the column ships exact
-- rather than starting every lesson at zero.
--
-- ORDER IS LOAD-BEARING IN THIS FILE. The trigger is taught to mask
-- `opened_count` BEFORE the backfill runs. Reversed, the backfill's UPDATE
-- would restamp `updated_at` on every memory that has ever been opened — the
-- exact whole-store recency wipe 00103 was written to stop, and unrecoverable
-- once done.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. the column ─────────────────────────────────────────────────────────
alter table memories add column if not exists opened_count integer not null default 0;

comment on column memories.opened_count is
  'How many times an agent DELIBERATELY fetched this exact lesson -- the count
   whose timestamp is last_opened_at (00099), moved by the same gate in the same
   statement: read_kind = targeted AND client in (mcp, cli). Never moved by a
   bulk list/search ride-along or by a human browsing the dashboard. Divided by
   read_count (00084, which counts every read) it gives PULL-THROUGH: of all the
   times this lesson was surfaced, how often was it a deliberate fetch. That
   ratio is comparable across scopes where the raw counts are not, because scope
   breadth cancels. Not null, defaults to 0; backfilled from memory_read_daily
   by 00104.';

-- ── 2. teach the trigger to mask it — BEFORE the backfill ─────────────────
-- 00103 exempted read_count/last_read_at/last_opened_at from restamping
-- `updated_at`; opened_count is the fourth column of that same derived set and
-- moves in the same statement, so omitting it here would defeat 00103 for every
-- TARGETED read. Asserted by migrations.test.sql §101 AC-2b, which does exactly
-- that read and checks the stamp did not move.
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

  -- 00103's exemption, extended by 00104 with opened_count: a read-counter
  -- write from `lorekit_record_memory_reads`.
  v_counters_changed :=
       new.read_count     is distinct from old.read_count
    or new.last_read_at   is distinct from old.last_read_at
    or new.last_opened_at is distinct from old.last_opened_at
    or new.opened_count   is distinct from old.opened_count;

  -- Mask the derived columns and the one being decided.
  --
  -- `fts` MUST be masked too, for 00062's reason: it is a GENERATED column and
  -- Postgres computes generated columns AFTER BEFORE-row triggers, so
  -- `new.fts` is NULL here while `old.fts` holds the stored value. An unmasked
  -- comparison finds every update "changed", which silently turns this whole
  -- function back into `set_updated_at`. It fails in the safe direction (a bump
  -- that should not happen, never a missing bump), which is exactly why it
  -- needs a test rather than a reading — see migrations.test.sql §101.
  v_new.embedding := null; v_new.embedding_model := null;
  v_new.read_count := null; v_new.last_read_at := null; v_new.last_opened_at := null;
  v_new.opened_count := null;
  v_new.updated_at := null; v_new.fts := null;

  v_old.embedding := null; v_old.embedding_model := null;
  v_old.read_count := null; v_old.last_read_at := null; v_old.last_opened_at := null;
  v_old.opened_count := null;
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

comment on function lorekit_memories_set_updated_at() is
  'BEFORE UPDATE on memories: bumps updated_at like set_updated_at, EXCEPT when the only change is '
  'a DERIVED column — the embedding pair (00062) or the read counters read_count/last_read_at/'
  'last_opened_at (00103) and opened_count (00104). None may rewrite the recency signal that '
  'search, relevant, the keyset index, lesson-rank and BOTH default sorts (Explorer, memory.list '
  'order=recency) all read. Before 00103 a single bulk memory.list restamped every row on the page, '
  'so updated_at reported last-READ under a last-WRITTEN name and recency ordering was arbitrary.';

-- ── 3. backfill from the rollup ───────────────────────────────────────────
-- Every targeted read `memory_read_daily` has ever recorded, so the column is
-- exact from day one instead of restarting the whole store at zero — the
-- cutover problem 00101 had to document for `read_count` and this one does not.
-- Runs AFTER the trigger above, so it preserves `updated_at` (see the header).
update memories m
   set opened_count = t.n
  from (
    select memory_id, sum(count)::integer as n
      from memory_read_daily
     where read_kind = 'targeted'
     group by memory_id
  ) t
 where m.id = t.memory_id
   and m.opened_count is distinct from t.n;

-- ── 4. the index the retention condition and the ranking need ─────────────
-- Mirrors `memories_user_read_count_idx` (00085) so `max_opened_count` (00105)
-- and any "never chosen" query are served the same way `max_read_count` is.
create index if not exists memories_user_opened_count_idx
  on memories (user_id, opened_count)
  where archived_at is null;

-- ── 5. the writer ─────────────────────────────────────────────────────────
-- Same signature, so `create or replace` is enough — no drop needed. The
-- increment is gated on EXACTLY the condition that sets `last_opened_at`,
-- written as one shared `case` so the pair cannot drift apart.
create or replace function lorekit_record_memory_reads(
  p_memory_ids uuid[],
  p_read_kind  text,
  p_client     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Resolved ONCE, outside the statement: `p_read_kind`/`p_client` are call
  -- arguments, not per-row values, so "is this a targeted agent open" is one
  -- boolean for the whole batch rather than a predicate re-evaluated per row —
  -- and, more importantly, the count and the timestamp below cannot be gated
  -- on two expressions that drift.
  v_opened boolean := p_read_kind = 'targeted' and p_client in ('mcp', 'cli');
begin
  if p_memory_ids is null or array_length(p_memory_ids, 1) is null then
    return;
  end if;

  -- ONE statement for every id, not one per id — the hot-path requirement a
  -- bulk `list` returning 31 rows imposes. `unnest` turns the array into a rowset
  -- the UPDATE can join against directly.
  update memories m
     set read_count = m.read_count + 1,
         last_read_at = now(),
         -- Narrower than the two columns above: only a TARGETED read
         -- attributed to an agent surface counts as "opened". `p_client` is
         -- validated app-side (`parseUsageClient`) before it reaches here, so
         -- this is a closed two-value check, not a free-text comparison.
         last_opened_at = case when v_opened then now() else m.last_opened_at end,
         opened_count   = m.opened_count + case when v_opened then 1 else 0 end
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

comment on function lorekit_record_memory_reads(uuid[], text, text) is
  'Increments memories.read_count/.last_read_at and today''s memory_read_daily
   row (UTC day, keyed by read_kind) for every memory id a read call actually
   returned, in ONE statement regardless of array size. Also sets
   memories.last_opened_at (00099) and increments memories.opened_count (00104)
   when read_kind = targeted AND client in (mcp, cli) -- an agent deliberately
   reaching for this one lesson, as opposed to it riding along in a page. Those
   two move together off one shared gate so a count and its timestamp can never
   disagree. Swallows its own errors: a counter must never break the read it is
   measuring.';

-- ── 6. surface the counters on the list RPC ───────────────────────────────
-- `lorekit_memory_list` returned NONE of the four read counters, so the lesson
-- CARD could not show any of them and comparing two lessons meant opening two
-- detail sheets. Adding them to `returns table` is a return-TYPE change, so the
-- function must be dropped first; the parameter list is unchanged, so the drop
-- signature is 00101's verbatim.
drop function if exists lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer
);

create or replace function lorekit_memory_list(
  p_user_id              uuid,
  p_archived             boolean     default false,
  p_scope                text        default null,
  p_key                  text        default null,
  p_key_prefix           text        default null,
  p_q                    text        default null,
  p_created_since        timestamptz default null,
  p_created_until        timestamptz default null,
  p_expires_after        timestamptz default null,
  p_expires_on_or_before timestamptz default null,
  p_tags                 text[]      default null,
  p_tags_mode            text        default 'any',
  p_source_agent         text[]      default null,
  p_source_agent_mode    text        default 'in',
  p_trigger              text[]      default null,
  p_trigger_mode         text        default 'in',
  p_kind                 text[]      default null,
  p_kind_mode            text        default 'in',
  p_host                 text[]      default null,
  p_host_mode            text        default 'in',
  p_origin_repo          text[]      default null,
  p_origin_repo_mode     text        default 'in',
  p_origin_branch        text[]      default null,
  p_origin_branch_mode   text        default 'in',
  p_origin_pr            text[]      default null,
  p_origin_pr_mode       text        default 'in',
  p_owner                text[]      default null,
  p_owner_mode           text        default 'in',
  p_sort                 text        default 'updated_at',
  p_cursor_ts            timestamptz default null,
  p_cursor_id            uuid        default null,
  p_limit                integer     default 51,
  p_key_scopes           text[]      default '{}',
  p_key_org_access       text        default 'all',
  p_key_org_ids          uuid[]      default '{}',
  p_min_age_days         integer     default null,
  p_unseen_days          integer     default null,
  p_max_seen_count       integer     default null,
  p_max_read_count       integer     default null
)
returns table (
  id             uuid,
  scope          text,
  key            text,
  value          text,
  tags           text[],
  source_agent   text,
  trigger        text,
  created_at     timestamptz,
  updated_at     timestamptz,
  expires_at     timestamptz,
  archived_at    timestamptz,
  origin_repo    text,
  origin_branch  text,
  origin_commit  text,
  origin_pr      integer,
  kind           text,
  host           text,
  seen_count     integer,
  read_count     integer,
  opened_count   integer,
  last_read_at   timestamptz,
  last_opened_at timestamptz,
  org_id         uuid,
  created_by     uuid,
  updated_by     uuid,
  org_name       text,
  org_slug       text,
  total_count    integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end;
  v_origin_pr integer[] := (
    select array_agg(x::integer)
      from unnest(coalesce(p_origin_pr, '{}'::text[])) as x
     where x ~ '^0*[0-9]{1,9}$'
  );
  v_sort text := case when p_sort = 'created_at' then 'created_at' else 'updated_at' end;
begin
  return query execute format($q$
    select
      m.id, m.scope, m.key, m.value, m.tags, m.source_agent, m.trigger,
      m.created_at, m.updated_at, m.expires_at, m.archived_at,
      m.origin_repo, m.origin_branch, m.origin_commit, m.origin_pr,
      m.kind, m.host, m.seen_count,
      m.read_count, m.opened_count, m.last_read_at, m.last_opened_at,
      m.org_id, m.created_by, m.updated_by,
      o.name as org_name, o.slug as org_slug,
      (count(*) over ())::integer as total_count
      from memories m
      left join orgs o on o.id = m.org_id
     where (
             ($1 is null and auth.role() = 'service_role')
             or m.user_id = $1
             or m.org_id in (select lorekit_member_org_ids($1))
           )
       and lorekit_api_token_scope_allowed($32, m.scope)
       and lorekit_api_token_org_allowed($33, $34, m.org_id)
       and (
             case
               when $2 then m.archived_at is not null
               else m.archived_at is null
                    and (m.expires_at is null or m.expires_at > now())
             end
           )
       and ($3 is null or m.scope = $3)
       and ($4 is null or m.key = $4)
       and ($5 is null or m.key ilike $5 || '%%')
       and ($6 is null or m.key ilike '%%' || $6 || '%%' or m.value ilike '%%' || $6 || '%%')
       and ($7 is null or m.created_at >= $7)
       and ($8 is null or m.created_at < $8)
       and ($9  is null or m.expires_at > $9)
       and ($10 is null or m.expires_at <= $10)
       and lorekit_match_tags(m.tags,          $11, $12)
       and lorekit_match_text(m.source_agent,  $13, $14)
       and lorekit_match_text(m.trigger,       $15, $16)
       and lorekit_match_text(m.kind,          $17, $18)
       and lorekit_match_text(m.host,          $19, $20)
       and lorekit_match_text(m.origin_repo,   $21, $22)
       and lorekit_match_text(m.origin_branch, $23, $24)
       and lorekit_match_int (m.origin_pr,     $25, $26)
       and ($27 is null or case coalesce($28, 'in')
             when 'nin' then (
               (case when m.org_id is null then 'personal' else o.slug end) is not null
               and (case when m.org_id is null then 'personal' else o.slug end) <> all($27)
             )
             else (
               ('personal' = any($27) and m.org_id is null)
               or (m.org_id is not null and o.slug = any($27))
             )
           end)
       and ($35 is null or m.created_at <= now() - ($35 * interval '1 day'))
       and ($36 is null or coalesce(m.last_opened_at, m.created_at) <= now() - ($36 * interval '1 day'))
       and ($37 is null or m.seen_count <= $37)
       and ($38 is null or m.read_count <= $38)
       and (
             $29 is null
             or m.%1$I < $29
             or (m.%1$I = $29 and m.id < $30)
           )
     order by m.%1$I desc, m.id desc
     limit $31
  $q$, v_sort)
  using
    v_actor, coalesce(p_archived, false), p_scope, p_key, p_key_prefix, p_q,
    p_created_since, p_created_until, p_expires_after, p_expires_on_or_before,
    p_tags, p_tags_mode,
    p_source_agent, p_source_agent_mode,
    p_trigger, p_trigger_mode,
    p_kind, p_kind_mode,
    p_host, p_host_mode,
    p_origin_repo, p_origin_repo_mode,
    p_origin_branch, p_origin_branch_mode,
    v_origin_pr, p_origin_pr_mode,
    p_owner, p_owner_mode,
    p_cursor_ts, p_cursor_id,
    greatest(coalesce(p_limit, 51), 1),
    coalesce(p_key_scopes, '{}'::text[]),
    coalesce(p_key_org_access, 'all'),
    coalesce(p_key_org_ids, '{}'::uuid[]),
    p_min_age_days, p_unseen_days, p_max_seen_count, p_max_read_count;
end;
$$;

grant execute on function lorekit_memory_list(
  uuid, boolean, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, text[], text, text[], text, text[], text, text[], text, text[],
  text, text[], text, text[], text, text[], text, text[], text, text,
  timestamptz, uuid, integer, text[], text, uuid[], integer, integer, integer,
  integer
) to authenticated, service_role;
