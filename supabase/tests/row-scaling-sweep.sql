-- ═══════════════════════════════════════════════════════════════════════════
-- Row-scaling sweep — where does per-user cost start to bend?
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
-- ---------------
-- The 5000-memory cap (`lorekit_default_limit('max_memories')`) is a chosen
-- number, not a measured one. It was set as an abuse guardrail — docs/limits.md:
-- "so any single account can't exhaust storage" — and storage is a cost
-- question. But the cap is ALSO a performance parameter, for a reason that is
-- not obvious from reading it:
--
--   `enforce_memory_cap()` (00018_org_limits.sql, superseding 00004) runs
--
--       select count(*) from memories where user_id = ? and archived_at is null
--
--   on EVERY INSERT. So the cost of enforcing the cap is O(rows that user
--   already has), paid by every single write. Raising the cap does not just
--   permit more data — it makes each insert progressively more expensive.
--
-- And the index situation makes that worse than it looks. There is no
-- `(user_id) where archived_at is null` index:
--
--   * `memories_archived_at_idx`    (archived_at) where archived_at IS NOT NULL
--                                   — the INVERSE predicate. Useless here.
--   * `memories_org_id_active_idx`  (org_id) where archived_at is null
--                                   — partial AND active, but keyed on ORG.
--
-- So the ORG branch of the trigger is index-backed and the PERSONAL branch is
-- not. `00035_memory_count.sql`'s comment ("reuses memories_user_idx + the
-- archived_at IS NULL partial index") reads as more reassuring than it is: the
-- only active partial index is org-keyed. This sweep exists to settle that with
-- EXPLAIN instead of by reading comments, and to find the row count where it
-- starts to matter.
--
-- WHAT IT MEASURES, AND WHAT IT DOES NOT
-- --------------------------------------
-- It sweeps ONE dimension: rows belonging to ONE user (the "focal" user), which
-- is the dimension the cap actually governs. Background users are seeded once at
-- a fixed size so the table and its indexes hold realistic content, but they do
-- NOT grow with the rungs. That keeps seeding linear and, more importantly,
-- keeps the result attributable: a knee here is a per-user effect.
--
-- TOTAL table size is a SECOND dimension and this does not sweep it. Raise
-- `-v users=…` / `-v background_rows=…` to move it. Per-user cost and
-- whole-table cost are different questions with different fixes (a partial
-- index vs. partitioning), and mixing them into one number answers neither.
--
-- This is a LOCAL experiment. It is not Supabase hardware, so treat the SHAPE
-- of the curve and the EXPLAIN plans as the findings, never the absolute
-- milliseconds. It also permanently changes the table it runs against (index
-- bloat survives a delete), so run it somewhere disposable — never production,
-- and preferably not a shared preview project.
--
-- USAGE
-- -----
--   scripts/sweep-rows.mjs does all of this for you against a throwaway
--   cluster. To drive it by hand, against a database that already has the
--   bootstrap + every migration applied:
--
--     psql "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/row-scaling-sweep.sql
--
--   Parameters (all optional):
--     -v rungs=1000,5000,25000,100000   focal-user row counts to measure at
--     -v users=3                        background users
--     -v background_rows=2000           rows per background user (fixed)
--     -v iterations=25                  timed repetitions per probe
--
-- Unlike `migrations.test.sql` this does NOT roll back: the seeded rows are the
-- experiment. It cleans up its own users at the end (cascade), but the table it
-- leaves behind has been grown and re-analyzed.
-- ═══════════════════════════════════════════════════════════════════════════

\if :{?rungs}
\else
  \set rungs '1000,5000,25000,100000'
\endif
\if :{?users}
\else
  \set users 3
\endif
\if :{?background_rows}
\else
  \set background_rows 2000
\endif
\if :{?iterations}
\else
  \set iterations 25
\endif

\timing off
\set ON_ERROR_STOP on

-- Config lands in a table rather than being interpolated into the DO block:
-- psql does not substitute variables inside dollar-quoted strings, so a
-- `:'rungs'` in the middle of `$$ … $$` would arrive literally.
drop table if exists sweep_config;
create table sweep_config (
  rungs           int[]   not null,
  users           int     not null,
  background_rows int     not null,
  iterations      int     not null
);
insert into sweep_config
values (
  string_to_array(:'rungs', ',')::int[],
  :'users'::int,
  :'background_rows'::int,
  :'iterations'::int
);

drop table if exists sweep_timings;
create table sweep_timings (
  rung  int  not null,   -- focal user's row count when the probe ran
  probe text not null,
  ms    double precision not null
);

-- The four tables below exist so the run is MACHINE-readable, not just
-- printable. `scripts/sweep-telemetry.mjs` reads them as JSON and ships the
-- result to Dash0, which is what makes two runs comparable — a terminal table
-- answers "how slow is it" once, a time series answers "did the index help".
drop table if exists sweep_phases;
create table sweep_phases (
  rung       int not null,
  started_at timestamptz not null,
  ended_at   timestamptz
);

-- The actionable half of the result. A plan's top NODE TYPE is the
-- low-cardinality dimension worth tracking over time: "Seq Scan" becoming
-- "Index Only Scan" is the whole point of adding an index, and it is visible in
-- one attribute instead of a diff of plan text.
drop table if exists sweep_plans;
create table sweep_plans (
  probe     text not null,
  rung      int  not null,
  node_type text,
  plan      jsonb
);

drop table if exists sweep_index_sizes;
create table sweep_index_sizes (
  index_name text not null,
  bytes      bigint not null
);

drop table if exists sweep_meta;
create table sweep_meta (
  key   text not null,
  value text not null
);

-- Fixed UUIDs so a re-run replaces its own data instead of accumulating it.
-- `f0…` is the focal user; `b0…` are the background users.
\set focal '''f0000000-0000-4000-8000-000000000001'''

-- ── Seed the cast ───────────────────────────────────────────────────────────
do $sweep$
declare
  cfg     record;
  v_focal uuid := 'f0000000-0000-4000-8000-000000000001';
  i       int;
begin
  select * into cfg from sweep_config;

  -- Remove any previous run's rows (cascade takes the memories with them).
  delete from auth.users where id = v_focal;
  delete from auth.users where email like 'sweep-bg-%@test.local';

  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', v_focal, 'authenticated',
          'authenticated', 'sweep-focal@test.local', now(), now());

  for i in 1..cfg.users loop
    insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
            'authenticated', format('sweep-bg-%s@test.local', i), now(), now());
  end loop;

  -- The focal user needs a cap override, or the PROBE inserts trip LK001 the
  -- moment the rung exceeds the 5000 default. This is the real mechanism
  -- (`user_limits`, 00004), not a test-only bypass.
  insert into user_limits (user_id, max_memories)
  values (v_focal, 100000000)
  on conflict (user_id) do update set max_memories = excluded.max_memories;
end
$sweep$;

-- ── Background population, seeded once ──────────────────────────────────────
-- The cap trigger is disabled for BULK SEEDING only. Seeding is setup, not
-- measurement — and leaving it on would make seeding O(n²): every one of the
-- n inserts would run a count over the rows already inserted. It is re-enabled
-- before any probe runs, so every measured insert pays the real trigger.
alter table memories disable trigger memories_enforce_cap;

do $sweep$
declare
  cfg  record;
  u    uuid;
begin
  select * into cfg from sweep_config;

  for u in select id from auth.users where email like 'sweep-bg-%@test.local' loop
    insert into memories (user_id, scope, key, value, tags)
    select
      u,
      -- A realistic spread of scope shapes; `scope` is indexed and grouped on.
      (array['global',
             'project::sweep',
             'repo::mthines/lorekit',
             'branch::mthines/lorekit::main'])[1 + (g % 4)],
      format('bg-lesson-%s', g),
      -- Long enough that the trigram + FTS indexes carry realistic content;
      -- a 20-char value would understate GIN maintenance cost.
      format('Background lesson %s. The traced client opens a client span per '
             'round trip so the waterfall attributes request time to a '
             'statement rather than to the handler as a whole. Sequence %s.', g, g),
      array['sweep', 'background']
    from generate_series(1, cfg.background_rows) g;
  end loop;
end
$sweep$;

-- ── The sweep ───────────────────────────────────────────────────────────────
do $sweep$
declare
  cfg        record;
  v_focal    uuid := 'f0000000-0000-4000-8000-000000000001';
  v_rung     int;
  v_have     int;
  v_iter     int;
  t0         timestamptz;
  v_sink     int;
  v_sink_txt text;
  v_probe_id uuid;
begin
  select * into cfg from sweep_config;

  foreach v_rung in array cfg.rungs loop
    insert into sweep_phases (rung, started_at) values (v_rung, clock_timestamp());

    -- ── grow the focal user to this rung (trigger still disabled) ──────────
    select count(*) into v_have from memories where user_id = v_focal;
    if v_have < v_rung then
      insert into memories (user_id, scope, key, value, tags)
      select
        v_focal,
        (array['global',
               'project::sweep',
               'repo::mthines/lorekit',
               'branch::mthines/lorekit::main'])[1 + (g % 4)],
        format('focal-lesson-%s', g),
        format('Focal lesson %s. Merged intervals never summed, because two '
               'concurrent forty millisecond queries would otherwise claim '
               'eighty milliseconds of wait in a request that waited forty. '
               'Sequence %s.', g, g),
        array['sweep', 'focal']
      from generate_series(v_have + 1, v_rung) g;
    end if;

    -- Plans are only as good as the stats behind them. Without this the
    -- planner keeps costing against the row count from the previous rung and
    -- every measurement after the first is against a stale plan.
    analyze memories;

    -- ── Phase A: everything that runs with the cap trigger ENABLED ─────────
    -- The trigger is toggled ONCE per phase, never per iteration: `alter table
    -- … disable trigger` takes an ACCESS EXCLUSIVE lock and invalidates cached
    -- plans, so doing it inside the timing loop would measure the DDL as much
    -- as the insert.
    alter table memories enable trigger memories_enforce_cap;

    for v_iter in 1..(cfg.iterations + 5) loop
      -- ── PROBE: the cap trigger's own count, in isolation ────────────────
      -- Exactly the statement enforce_memory_cap() runs on the personal
      -- branch. Prediction: grows linearly in the focal user's row count,
      -- because no index covers (user_id) where archived_at is null.
      t0 := clock_timestamp();
      select count(*) into v_sink
        from memories where user_id = v_focal and archived_at is null;
      if v_iter > 5 then
        insert into sweep_timings values (v_rung, 'cap_count (trigger predicate)',
          extract(epoch from (clock_timestamp() - t0)) * 1000);
      end if;

      -- ── PROBE: the same count on the ORG branch ─────────────────────────
      -- Backed by memories_org_id_active_idx. Included as the CONTROL: if the
      -- personal count bends and this one does not, the missing partial index
      -- is the cause rather than table size. `org_id` is a uuid (00015 altered
      -- it from text), and the value deliberately matches no row — the point is
      -- the ACCESS PATH, and a miss on a partial index is the cheapest way to
      -- show the planner using it.
      t0 := clock_timestamp();
      select count(*) into v_sink
        from memories where org_id = '0f000000-0000-4000-8000-00000000000f'::uuid
          and archived_at is null;
      if v_iter > 5 then
        insert into sweep_timings values (v_rung, 'cap_count (org branch, indexed)',
          extract(epoch from (clock_timestamp() - t0)) * 1000);
      end if;

      -- ── PROBE: a real insert, trigger ON ────────────────────────────────
      -- Cap count + ~18 indexes, three of them GIN (fts, key_trgm,
      -- value_trgm). This is what a user's write actually costs.
      v_probe_id := gen_random_uuid();
      t0 := clock_timestamp();
      insert into memories (id, user_id, scope, key, value, tags)
      values (v_probe_id, v_focal, 'project::sweep',
              format('probe-insert-%s', v_probe_id),
              'Probe insert measuring cap enforcement plus index maintenance.',
              array['sweep', 'probe']);
      if v_iter > 5 then
        insert into sweep_timings values (v_rung, 'insert (trigger ON)',
          extract(epoch from (clock_timestamp() - t0)) * 1000);
      end if;
      delete from memories where id = v_probe_id;

      -- ── PROBE: point read on the active unique index ────────────────────
      t0 := clock_timestamp();
      select value into v_sink_txt
        from memories
       where user_id = v_focal and scope = 'project::sweep'
         and key = format('focal-lesson-%s', 1 + (v_iter % 100))
         and archived_at is null
       limit 1;
      if v_iter > 5 then
        insert into sweep_timings values (v_rung, 'point read (scope+key)',
          extract(epoch from (clock_timestamp() - t0)) * 1000);
      end if;

      -- ── PROBE: the Explorer's list page ─────────────────────────────────
      t0 := clock_timestamp();
      perform id, key, value from memories
       where user_id = v_focal and scope = 'repo::mthines/lorekit'
         and archived_at is null
       order by updated_at desc
       limit 50;
      if v_iter > 5 then
        insert into sweep_timings values (v_rung, 'scope list (order by updated_at, 50)',
          extract(epoch from (clock_timestamp() - t0)) * 1000);
      end if;

      -- ── PROBE: full-text search (the GIN index) ─────────────────────────
      t0 := clock_timestamp();
      perform id, key from memories
       where user_id = v_focal
         and fts @@ websearch_to_tsquery('english', 'merged intervals')
         and archived_at is null
       limit 50;
      if v_iter > 5 then
        insert into sweep_timings values (v_rung, 'fts search',
          extract(epoch from (clock_timestamp() - t0)) * 1000);
      end if;

      -- ── PROBE: keyset page (memories_user_created_at_id_idx) ────────────
      t0 := clock_timestamp();
      perform id, key from memories
       where user_id = v_focal and archived_at is null
       order by created_at desc, id desc
       limit 50;
      if v_iter > 5 then
        insert into sweep_timings values (v_rung, 'keyset page (50)',
          extract(epoch from (clock_timestamp() - t0)) * 1000);
      end if;
    end loop;

    -- ── Phase B: the same insert with the cap trigger DISABLED ─────────────
    -- Isolates index maintenance from cap enforcement. The DIFFERENCE between
    -- 'insert (trigger ON)' above and this is what the cap costs per write.
    alter table memories disable trigger memories_enforce_cap;

    for v_iter in 1..(cfg.iterations + 5) loop
      v_probe_id := gen_random_uuid();
      t0 := clock_timestamp();
      insert into memories (id, user_id, scope, key, value, tags)
      values (v_probe_id, v_focal, 'project::sweep',
              format('probe-notrig-%s', v_probe_id),
              'Probe insert measuring index maintenance alone.',
              array['sweep', 'probe']);
      if v_iter > 5 then
        insert into sweep_timings values (v_rung, 'insert (trigger OFF)',
          extract(epoch from (clock_timestamp() - t0)) * 1000);
      end if;
      delete from memories where id = v_probe_id;
    end loop;

    update sweep_phases set ended_at = clock_timestamp()
     where rung = v_rung and ended_at is null;

    raise notice 'rung % done (focal user has % active rows)',
      v_rung, (select count(*) from memories where user_id = v_focal and archived_at is null);
  end loop;

  -- Never leave the cap unenforced, even though this database is disposable:
  -- a half-run sweep followed by a hand query should not silently be able to
  -- exceed the cap.
  alter table memories enable trigger memories_enforce_cap;
end
$sweep$;

-- ── Report ──────────────────────────────────────────────────────────────────
\echo ''
\echo '════════════════════════════════════════════════════════════════════'
\echo ' Row-scaling sweep — p50 / p95 ms per probe, by focal-user row count'
\echo '════════════════════════════════════════════════════════════════════'
\echo ''

select
  probe,
  rung                                                                as rows,
  round(percentile_cont(0.5)  within group (order by ms)::numeric, 3) as p50_ms,
  round(percentile_cont(0.95) within group (order by ms)::numeric, 3) as p95_ms,
  count(*)                                                           as n
from sweep_timings
group by probe, rung
order by probe, rung;

\echo ''
\echo '── Growth factor: p50 at the largest rung ÷ p50 at the smallest ─────'
\echo '   ~1.0 = flat (indexed). Tracking the row multiple = a linear scan.'
\echo ''

with p50 as (
  select probe, rung,
         percentile_cont(0.5) within group (order by ms) as ms
    from sweep_timings group by probe, rung
), bounds as (
  select probe, min(rung) as lo, max(rung) as hi from p50 group by probe
)
select
  b.probe,
  b.lo                                        as from_rows,
  b.hi                                        as to_rows,
  round((b.hi::numeric / b.lo), 1)            as row_multiple,
  round(lo.ms::numeric, 3)                    as p50_lo_ms,
  round(hi.ms::numeric, 3)                    as p50_hi_ms,
  round((hi.ms / nullif(lo.ms, 0))::numeric, 1) as growth_x
from bounds b
join p50 lo on lo.probe = b.probe and lo.rung = b.lo
join p50 hi on hi.probe = b.probe and hi.rung = b.hi
order by growth_x desc nulls last;

-- ── Capture the plans, the index sizes and the run metadata ─────────────────
-- Recorded into tables BEFORE the printed EXPLAINs below, so the machine-
-- readable copy and the human-readable one describe the same state.
do $sweep$
declare
  v_focal   uuid := 'f0000000-0000-4000-8000-000000000001';
  v_top       int;
  v_plan      text;
  v_probe     text;
  v_sql       text;
  v_node_type text;
  v_pairs   text[][] := array[
    ['cap_count (trigger predicate)',
     format('select count(*) from memories where user_id = %L and archived_at is null', 'f0000000-0000-4000-8000-000000000001')],
    ['cap_count (org branch, indexed)',
     'select count(*) from memories where org_id = ''0f000000-0000-4000-8000-00000000000f''::uuid and archived_at is null']
  ];
  i int;
begin
  select max(rungs[array_upper(rungs, 1)]) into v_top from sweep_config;

  for i in 1..array_length(v_pairs, 1) loop
    v_probe := v_pairs[i][1];
    v_sql   := v_pairs[i][2];
    -- `format json` so the node type is a field lookup rather than a regex over
    -- plan text, which would break the first time the plan shape changed.
    execute 'explain (analyze, buffers, format json) ' || v_sql into v_plan;

    -- Record the topmost SCAN node, not the outermost node. Every one of these
    -- probes is a `count(*)`, so the outermost node is always `Aggregate` —
    -- which is constant, and therefore useless as the dimension that is
    -- supposed to show "Seq Scan became Index Only Scan". `$.**` descends in
    -- document order, so the first match is the highest scan in the tree: for a
    -- bitmap plan that is `Bitmap Heap Scan`, which is where the heap cost
    -- actually is.
    select nt into v_node_type
      from jsonb_array_elements_text(
             jsonb_path_query_array(v_plan::jsonb, '$.**."Node Type"')) as nt
     where nt like '%Scan%'
     limit 1;

    insert into sweep_plans (probe, rung, node_type, plan)
    values (
      v_probe,
      v_top,
      -- Fall back to the outermost node rather than null: a plan with no scan
      -- at all (an index-only aggregate, a result cache) is a finding in its
      -- own right and should not arrive as a missing attribute.
      coalesce(v_node_type, v_plan::jsonb -> 0 -> 'Plan' ->> 'Node Type'),
      v_plan::jsonb
    );
  end loop;

  insert into sweep_index_sizes (index_name, bytes)
  select indexrelname, pg_relation_size(indexrelid)
    from pg_stat_user_indexes where relname = 'memories';

  insert into sweep_meta (key, value) values
    ('rows_total',    (select count(*)::text from memories)),
    ('table_bytes',   pg_total_relation_size('memories')::text),
    ('indexes_bytes', pg_indexes_size('memories')::text),
    ('focal_rows',    (select count(*)::text from memories
                        where user_id = v_focal and archived_at is null)),
    ('pg_version',    current_setting('server_version'));
end
$sweep$;

\echo ''
\echo '── EXPLAIN: the cap trigger predicate at the largest rung ───────────'
\echo '   Watch for a heap filter on archived_at rather than an index-only'
\echo '   scan. That is the missing (user_id) where archived_at is null index.'
\echo ''

explain (analyze, buffers, verbose off)
select count(*) from memories
 where user_id = 'f0000000-0000-4000-8000-000000000001' and archived_at is null;

\echo ''
\echo '── EXPLAIN: the org branch, for comparison (indexed) ────────────────'
\echo ''

explain (analyze, buffers)
select count(*) from memories
 where org_id = '0f000000-0000-4000-8000-00000000000f'::uuid and archived_at is null;

\echo ''
\echo '── Index sizes (write amplification lives here) ─────────────────────'
\echo ''

select
  indexrelname                                          as index,
  pg_size_pretty(pg_relation_size(indexrelid))          as size,
  idx_scan                                              as scans
from pg_stat_user_indexes
where relname = 'memories'
order by pg_relation_size(indexrelid) desc;

select pg_size_pretty(pg_total_relation_size('memories')) as memories_total,
       pg_size_pretty(pg_indexes_size('memories'))        as indexes_total,
       (select count(*) from memories)                    as rows_total;

-- ── Clean up the cast, keep the timings ─────────────────────────────────────
-- The users go (cascade takes their memories); `sweep_timings` stays so the
-- numbers can be re-queried without re-running the sweep.
delete from auth.users where id = 'f0000000-0000-4000-8000-000000000001';
delete from auth.users where email like 'sweep-bg-%@test.local';

\echo ''
\echo 'Sweep complete. Seeded users removed; sweep_timings retained.'
\echo 'Local hardware — read the SHAPE and the plans, not the absolute ms.'
