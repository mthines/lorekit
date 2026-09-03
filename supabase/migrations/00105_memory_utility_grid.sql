-- ═════════════════════════════════════════════════════════════════════════
-- 00105 — the delivered × chosen grid, and what delivery costs.
--
-- WHAT THIS REPLACES. `lorekit_memory_read_ranking` (00085) ranks by
-- `read_count` alone, and 99.80% of recorded reads are bulk ride-alongs in a
-- `memory.list`/`memory.search` page. So the "cold" end of that ranking — the
-- end the Insights page nominates for pruning — is populated by NARROW SCOPES,
-- not by unused lore: a `branch` lesson is delivered a handful of times however
-- useful it is, while a `global` one is delivered on every session however
-- useless. Ranking two lessons by a number that mostly encodes their scope is
-- the defect; dividing by the deliveries cancels it, because scope breadth
-- appears in both halves.
--
-- 00085 IS NOT DROPPED. `/read-ranking` still answers "what is read most", a
-- real question, and it is a live REST route. This adds the grid beside it.
--
-- TWO FUNCTIONS, TWO WINDOWS, DELIBERATELY.
--
--   `lorekit_memory_utility_census` counts, per quadrant, over the LIFETIME
--   counters on `memories`. It must agree with the per-lesson chip the
--   dashboard renders from those same two columns, so it reads the same source.
--
--   `lorekit_memory_delivery_cost` sums over `memory_read_daily`, which is the
--   only source that can be WINDOWED ("this month"). It reports reads and an
--   estimated token volume.
--
-- Mixing them would produce a page where the headline and the grid silently
-- describe different periods. Each caller captions its own.
--
-- NO THRESHOLD IS HARDCODED HERE. `p_min_deliveries` / `p_min_age_days` /
-- `p_chosen_pull_through` / `p_broad_reach` arrive as parameters from
-- `LESSON_UTILITY_THRESHOLDS` in `@lorekit/schemas`, which is also what the
-- TypeScript chip reads. This is the `lorekit_get_limit` posture: the numbers
-- live in ONE place and the SQL encodes only the SHAPE of the rule (four
-- quadrants from two booleans, plus an evidence floor). A SQL default is
-- supplied so a hand-run query is not unusable, but it is a fallback, never
-- the authority — a drift between the two would put a lesson in one quadrant
-- on the card and another in the census.
--
-- TOKENS ARE ESTIMATED, never tokenized: `length(value) / 4`. The headline is
-- an order of magnitude, and shipping a BPE tokenizer into an edge function to
-- sharpen a number nobody acts on to the digit is the wrong trade. Every
-- surface that renders it says "estimated".
--
-- VISIBILITY is the same org-shared + own-rows predicate every per-user
-- analytics RPC in this family uses (`lorekit_memory_scopes`,
-- `lorekit_memory_read_ranking`, `lorekit_read_activity`), with the same
-- service-role + NULL-actor escape hatch and the same
-- `lorekit_api_token_scope_allowed` narrowing for a scoped key (00068/00069).
--
-- INDEXES: `memories_user_read_count_idx` (00085) and
-- `memories_user_opened_count_idx` (00103) already cover the census scan;
-- `memory_read_daily`'s primary key covers the cost sum's join.
-- ═════════════════════════════════════════════════════════════════════════

-- ── the quadrant expression, in ONE place ────────────────────────────────
--
-- Both functions below need "which quadrant is this row in", and the census
-- needs it twice (count and filter). An immutable helper keeps the rule from
-- being written out three times and drifting between them — the same reason
-- `isGroomCandidate` is one pure function rather than a predicate inlined per
-- caller.
--
-- Returns the SAME five names `LessonUtilitySchema` declares, so a rename on
-- either side is caught by `migrations.test.sql` §104 rather than silently
-- producing a quadrant no client knows how to render.
create or replace function lorekit_lesson_utility(
  p_read_count          integer,
  p_opened_count        integer,
  p_created_at          timestamptz,
  p_min_deliveries      integer     default 10,
  p_min_age_days        integer     default 7,
  p_chosen_pull_through numeric     default 0.02,
  p_broad_reach         integer     default 100,
  p_now                 timestamptz default now()
)
returns text
language sql
immutable
as $$
  select case
    -- The evidence floor comes FIRST, and both halves of it are needed: a
    -- lesson delivered 5,000 times in its first day has volume but no chance
    -- to have been chosen, and a 400-day-old lesson delivered 3 times has age
    -- but no denominator. Either alone would hand out a confident verdict the
    -- data cannot support.
    when p_created_at > p_now - make_interval(days => p_min_age_days) then 'unproven'
    when coalesce(p_read_count, 0) < p_min_deliveries then 'unproven'
    when coalesce(p_opened_count, 0)::numeric / nullif(p_read_count, 0) >= p_chosen_pull_through then
      case when p_read_count >= p_broad_reach then 'load-bearing' else 'specialist' end
    else
      case when p_read_count >= p_broad_reach then 'noise-tax' else 'dormant' end
  end;
$$;

comment on function lorekit_lesson_utility(integer, integer, timestamptz, integer, integer, numeric, integer, timestamptz) is
  'Where one lesson sits on the delivered x chosen grid: load-bearing /
   specialist / noise-tax / dormant / unproven. Pull-through is
   opened_count / read_count -- a proper fraction, so scope breadth cancels.
   Thresholds are PARAMETERS (LESSON_UTILITY_THRESHOLDS in @lorekit/schemas is
   the authority); the defaults here are a fallback for a hand-run query, not
   a second source of truth.';

-- ── the census ───────────────────────────────────────────────────────────
create or replace function lorekit_memory_utility_census(
  p_user_id             uuid,
  p_scope               text    default null,
  p_key_scopes          text[]  default '{}',
  p_min_deliveries      integer default 10,
  p_min_age_days        integer default 7,
  p_chosen_pull_through numeric default 0.02,
  p_broad_reach         integer default 100
)
returns table (
  utility text,
  n       bigint
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
begin
  return query
    -- LEFT JOIN off the five names rather than grouping the rows: a quadrant
    -- with no members must come back as 0, not be absent. An absent key reads
    -- to a client as "not measured", and "you have no noise tax" is a very
    -- different answer from "we did not look".
    select q.utility, coalesce(c.n, 0)::bigint
      from unnest(array['load-bearing', 'specialist', 'noise-tax', 'dormant', 'unproven']) as q(utility)
      left join (
        select lorekit_lesson_utility(
                 m.read_count, m.opened_count, m.created_at,
                 p_min_deliveries, p_min_age_days, p_chosen_pull_through, p_broad_reach, now()
               ) as utility,
               count(*) as n
          from memories m
         where (
                 (v_actor is null and auth.role() = 'service_role')
                 or m.user_id = v_actor
                 or m.org_id in (select lorekit_member_org_ids(v_actor))
               )
           and m.archived_at is null
           and (m.expires_at is null or m.expires_at > now())
           and (p_scope is null or m.scope = p_scope)
           and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
         group by 1
      ) c on c.utility = q.utility;
end;
$$;

revoke execute on function lorekit_memory_utility_census(uuid, text, text[], integer, integer, numeric, integer) from public, anon;
grant  execute on function lorekit_memory_utility_census(uuid, text, text[], integer, integer, numeric, integer) to authenticated, service_role;

comment on function lorekit_memory_utility_census(uuid, text, text[], integer, integer, numeric, integer) is
  'How many active lessons sit in each quadrant of the delivered x chosen grid,
   account-wide and ALL-TIME (the lifetime counters on memories, the same two
   columns the per-lesson chip reads, so the two cannot disagree). Every one of
   the five names is always returned, 0 included -- an absent key would read as
   "not measured".';

-- ── the rows for one quadrant ────────────────────────────────────────────
create or replace function lorekit_memory_utility_rows(
  p_user_id             uuid,
  p_utility             text,
  p_scope               text    default null,
  p_limit               integer default 20,
  p_key_scopes          text[]  default '{}',
  p_min_deliveries      integer default 10,
  p_min_age_days        integer default 7,
  p_chosen_pull_through numeric default 0.02,
  p_broad_reach         integer default 100
)
returns table (
  id             uuid,
  scope          text,
  key            text,
  read_count     integer,
  opened_count   integer,
  last_opened_at timestamptz,
  created_at     timestamptz
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
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  if p_utility is null
     or p_utility not in ('load-bearing', 'specialist', 'noise-tax', 'dormant', 'unproven') then
    raise exception 'invalid utility %, expected one of load-bearing, specialist, noise-tax, dormant, unproven', p_utility
      using errcode = '22023';
  end if;

  return query
    select m.id, m.scope, m.key, m.read_count, m.opened_count, m.last_opened_at, m.created_at
      from memories m
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       and m.archived_at is null
       and (m.expires_at is null or m.expires_at > now())
       and (p_scope is null or m.scope = p_scope)
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
       and lorekit_lesson_utility(
             m.read_count, m.opened_count, m.created_at,
             p_min_deliveries, p_min_age_days, p_chosen_pull_through, p_broad_reach, now()
           ) = p_utility
     -- Most-delivered first WITHIN a quadrant, because that is the order the
     -- action wants: the noise-tax row costing the most context is the one to
     -- prune first, and the load-bearing row reaching the most sessions is the
     -- one to promote first. `id desc` is the stable tiebreak every other
     -- ranked read in this family uses.
     order by m.read_count desc, m.opened_count desc, m.id desc
     limit v_limit;
end;
$$;

revoke execute on function lorekit_memory_utility_rows(uuid, text, text, integer, text[], integer, integer, numeric, integer) from public, anon;
grant  execute on function lorekit_memory_utility_rows(uuid, text, text, integer, text[], integer, integer, numeric, integer) to authenticated, service_role;

comment on function lorekit_memory_utility_rows(uuid, text, text, integer, text[], integer, integer, numeric, integer) is
  'The active lessons in one quadrant of the delivered x chosen grid, most-
   delivered first. Same visibility and scoped-key narrowing as
   lorekit_memory_read_ranking. p_limit is clamped to [1, 100]; an unknown
   quadrant name raises 22023 rather than returning nothing.';

-- ── what delivery cost, over a window ────────────────────────────────────
create or replace function lorekit_memory_delivery_cost(
  p_user_id    uuid,
  p_since      timestamptz default null,
  p_until      timestamptz default null,
  p_scope      text        default null,
  p_key_scopes text[]      default '{}'
)
returns table (
  delivered_reads  bigint,
  chosen_reads     bigint,
  delivered_tokens bigint,
  chosen_tokens    bigint
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
begin
  return query
    -- `coalesce` on the aggregates, not on the row: `sum` over no rows is
    -- NULL, and a client reading `delivered_tokens: null` as 0 is the kind of
    -- accidental agreement that breaks the first time a caller is stricter.
    -- An account with no recorded reads gets four honest zeroes.
    select
      coalesce(sum(d.count), 0)::bigint,
      coalesce(sum(d.count) filter (where d.read_kind = 'targeted'), 0)::bigint,
      coalesce(sum(d.count * ceil(length(m.value) / 4.0)), 0)::bigint,
      coalesce(sum(d.count * ceil(length(m.value) / 4.0)) filter (where d.read_kind = 'targeted'), 0)::bigint
      from memory_read_daily d
      join memories m on m.id = d.memory_id
     where (
             (v_actor is null and auth.role() = 'service_role')
             or m.user_id = v_actor
             or m.org_id in (select lorekit_member_org_ids(v_actor))
           )
       -- Archived lore is deliberately INCLUDED: it was delivered while it was
       -- live, and the point of this figure is what the reads actually cost.
       -- Excluding it would make the bill drop retroactively every time
       -- something is pruned, which is exactly backwards as a feedback signal.
       and (p_scope is null or m.scope = p_scope)
       and lorekit_api_token_scope_allowed(p_key_scopes, m.scope)
       -- HALF-OPEN `[since, until)`, the same asymmetry `/activity` and
       -- `/read-activity` use, so two adjacent windows partition the reads
       -- instead of both claiming the boundary day. The comparison is at DAY
       -- grain because `memory_read_daily` is a daily rollup and no finer
       -- answer exists — which makes `until` exclusive of the whole day it
       -- names. A caller wanting "through right now" therefore passes NO
       -- `until` (the default) rather than `now()`, which would drop today.
       and (p_since is null or d.day >= p_since::date)
       and (p_until is null or d.day <  p_until::date);
end;
$$;

revoke execute on function lorekit_memory_delivery_cost(uuid, timestamptz, timestamptz, text, text[]) from public, anon;
grant  execute on function lorekit_memory_delivery_cost(uuid, timestamptz, timestamptz, text, text[]) to authenticated, service_role;

comment on function lorekit_memory_delivery_cost(uuid, timestamptz, timestamptz, text, text[]) is
  'Reads and ESTIMATED tokens of lore delivered over a window, and how much of
   that was a deliberate (targeted) fetch. Windowed over memory_read_daily --
   a DIFFERENT source from lorekit_memory_utility_census, which reads the
   lifetime counters; each caller must caption its own window. The window is
   half-open [since, until) at DAY grain, so p_until excludes the whole day it
   names -- pass NULL, not now(), for "through right now". Tokens are
   length(value)/4, never tokenized: render them as estimates. Archived lore is
   included, because it cost context while it was live.';
