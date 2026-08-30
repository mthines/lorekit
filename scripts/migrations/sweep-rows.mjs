#!/usr/bin/env node
/**
 * Row-scaling sweep runner — boots a throwaway PostgreSQL cluster, applies the
 * bare-postgres bootstrap plus every migration, and runs
 * `supabase/tests/row-scaling-sweep.sql` against it.
 *
 * WHY A THROWAWAY CLUSTER
 * -----------------------
 * The sweep is a DATA-SHAPE experiment: it grows one user to 100k rows to find
 * where per-user cost bends. That permanently changes whatever it runs against
 * — index bloat survives a delete, and reclaiming it needs REINDEX or
 * VACUUM FULL. So it gets its own cluster, used once and thrown away, rather
 * than a shared preview project and never production (which shares the
 * `memories` table with real tenants).
 *
 * Local hardware is not Supabase hardware. The findings are the SHAPE of the
 * curve and the EXPLAIN plans, never the absolute milliseconds — which is
 * exactly what makes a disposable local cluster the right instrument.
 *
 * USAGE
 *   node scripts/sweep-rows.mjs
 *   node scripts/sweep-rows.mjs --rungs 1000,5000,25000 --iterations 40
 *   node scripts/sweep-rows.mjs --database-url postgresql://…   # bring your own
 *
 * OPTIONS
 *   --rungs <list>         focal-user row counts        (default 1000,5000,25000,100000)
 *   --users <n>            background users             (default 3)
 *   --background-rows <n>  rows per background user     (default 2000)
 *   --iterations <n>       timed repetitions per probe  (default 25)
 *   --port <n>             throwaway cluster port       (default 55433)
 *   --pgbin <path>         PostgreSQL bin directory     (default: probed)
 *   --database-url <url>   run against an existing DB and skip cluster setup.
 *                          It must already have the bootstrap + migrations
 *                          applied, and it WILL be grown by the sweep.
 *   --keep                 leave the cluster running afterwards, for poking
 *                          at `sweep_timings` by hand
 *
 * Zero dependencies: shells out to the `psql` / `initdb` / `pg_ctl` that ship
 * with the server package, matching the other scripts in this directory.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { exportSweep } from '../telemetry/sweep-telemetry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── argv ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    rungs: '1000,5000,25000,100000',
    users: '3',
    backgroundRows: '2000',
    iterations: '25',
    port: '55433',
    pgbin: null,
    databaseUrl: null,
    keep: false,
    dryRun: false,
  };
  const flags = {
    '--rungs': 'rungs',
    '--users': 'users',
    '--background-rows': 'backgroundRows',
    '--iterations': 'iterations',
    '--port': 'port',
    '--pgbin': 'pgbin',
    '--database-url': 'databaseUrl',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep') { opts.keep = true; continue; }
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    const key = flags[arg];
    if (!key) die(`Unknown argument: ${arg}\nRun with --help for usage.`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) die(`${arg} needs a value.`);
    opts[key] = value;
    i += 1;
  }
  return opts;
}

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// ── PostgreSQL discovery ─────────────────────────────────────────────────────

/**
 * Locate a PostgreSQL bin directory containing initdb.
 *
 * `psql` alone is not enough: a client-only install has psql but no server, and
 * that failure shows up much later as a confusing "could not connect". So the
 * probe is for `initdb`, which only ships with the server.
 */
function findPgBin(explicit) {
  if (explicit) {
    if (!existsSync(path.join(explicit, 'initdb'))) die(`No initdb in ${explicit}`);
    return explicit;
  }
  const candidates = [];
  const base = '/usr/lib/postgresql';
  if (existsSync(base)) {
    // Highest major version first — a box with 15 and 17 installed should use 17.
    for (const v of readdirSync(base).sort((a, b) => Number(b) - Number(a))) {
      candidates.push(path.join(base, v, 'bin'));
    }
  }
  candidates.push('/usr/local/pgsql/bin', '/opt/homebrew/bin', '/usr/bin');
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'initdb'))) return dir;
  }
  die(
    'Could not find a PostgreSQL server install (no `initdb`).\n'
    + '  Debian/Ubuntu: apt-get install postgresql-16 postgresql-16-pgvector\n'
    + '  macOS:         brew install postgresql@16 pgvector\n'
    + '  Or point at one with --pgbin, or skip cluster setup with --database-url.',
  );
}

// ── shell helpers ────────────────────────────────────────────────────────────

function run(cmd, args, { env, cwd, quiet } = {}) {
  const res = spawnSync(cmd, args, {
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf8',
    stdio: quiet ? 'pipe' : 'inherit',
  });
  if (res.error) die(`${cmd} failed to start: ${res.error.message}`);
  return res;
}

/**
 * Run a command as the `postgres` OS user when we are root.
 *
 * A PostgreSQL server refuses to start as root, so a container session running
 * as root has to drop privileges. When we are already a normal user, run
 * directly — `su` would prompt for a password.
 */
function asPostgres(pgbin, binary, args, opts = {}) {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const exe = path.join(pgbin, binary);
  if (!isRoot) return run(exe, args, opts);
  const quoted = args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
  return run('su', ['postgres', '-c', `${exe} ${quoted}`], opts);
}

// ── cluster lifecycle ────────────────────────────────────────────────────────

/**
 * A data directory the `postgres` user can actually reach.
 *
 * Not a scratchpad under /tmp/claude-*: those paths are mode-700 for the
 * invoking user, so `initdb` as `postgres` dies with "could not access
 * directory" — a permission error that reads like a bug in the script. /var/tmp
 * is world-traversable and survives the run for post-mortem poking.
 */
function dataDir(port) {
  return path.join('/var/tmp', `lorekit-sweep-${port}`);
}

function startCluster(pgbin, port) {
  const pgdata = dataDir(port);
  console.log(`\n▸ Booting a throwaway PostgreSQL cluster in ${pgdata} (port ${port})`);

  rmSync(pgdata, { recursive: true, force: true });
  mkdirSync(pgdata, { recursive: true });

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) {
    // `useradd` is a no-op failure if the user already exists; ignore it.
    run('id', ['-u', 'postgres'], { quiet: true }).status === 0
      || run('useradd', ['-m', 'postgres'], { quiet: true });
    run('chown', ['postgres', pgdata], { quiet: true });
    run('chmod', ['700', pgdata], { quiet: true });
  }

  let res = asPostgres(pgbin, 'initdb', ['-D', pgdata, '-U', 'postgres', '--auth=trust'], { quiet: true });
  if (res.status !== 0) die(`initdb failed:\n${res.stderr || res.stdout}`);

  // `listen_addresses=` (empty) means unix socket only — nothing is exposed on
  // the network, which is the right posture for a disposable local cluster.
  // pg_stat_statements is preloaded so the sweep's own statements are visible
  // to the same profiling RPC that ships in 00074.
  res = asPostgres(pgbin, 'pg_ctl', [
    '-D', pgdata,
    '-o', `-k /var/tmp -p ${port} -c listen_addresses= -c shared_preload_libraries=pg_stat_statements`,
    '-l', path.join(pgdata, 'server.log'),
    'start',
  ], { quiet: true });
  if (res.status !== 0) die(`pg_ctl start failed:\n${res.stderr || res.stdout}`);

  return { pgdata, url: `postgresql://postgres@/lorekit_sweep?host=/var/tmp&port=${port}` };
}

function stopCluster(pgbin, port, { keep }) {
  const pgdata = dataDir(port);
  if (keep) {
    console.log(
      `\n▸ Cluster left running (--keep). Poke at it with:\n`
      + `    psql -h /var/tmp -p ${port} -U postgres lorekit_sweep -c 'table sweep_timings limit 5'\n`
      + `  Stop it with:\n`
      + `    ${path.join(pgbin, 'pg_ctl')} -D ${pgdata} stop`,
    );
    return;
  }
  asPostgres(pgbin, 'pg_ctl', ['-D', pgdata, '-m', 'immediate', 'stop'], { quiet: true });
  rmSync(pgdata, { recursive: true, force: true });
  console.log('\n▸ Throwaway cluster stopped and removed.');
}

// ── schema ───────────────────────────────────────────────────────────────────

function psql(url, args, opts = {}) {
  return run('psql', [url, '-v', 'ON_ERROR_STOP=1', ...args], opts);
}

function applySchema(url, port) {
  const adminUrl = `postgresql://postgres@/postgres?host=/var/tmp&port=${port}`;
  let res = psql(adminUrl, ['-q', '-c', 'create database lorekit_sweep'], { quiet: true });
  if (res.status !== 0) die(`create database failed:\n${res.stderr || res.stdout}`);

  console.log('▸ Applying the bare-postgres bootstrap (roles, auth.users, claim readers)');
  res = psql(url, ['-q', '-f', path.join(repoRoot, 'supabase/tests/bare-postgres-bootstrap.sql')], { quiet: true });
  if (res.status !== 0) die(`bootstrap failed:\n${res.stderr || res.stdout}`);

  const migrationsDir = path.join(repoRoot, 'supabase/migrations');
  const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  console.log(`▸ Applying ${migrations.length} migrations`);
  for (const file of migrations) {
    res = psql(url, ['-q', '-f', path.join(migrationsDir, file)], { quiet: true });
    if (res.status !== 0) {
      die(
        `Migration ${file} failed:\n${res.stderr || res.stdout}\n`
        + 'If this mentions the `vector` extension, install pgvector:\n'
        + '  apt-get install postgresql-16-pgvector',
      );
    }
  }
}

// ── results readback ─────────────────────────────────────────────────────────

/**
 * Read the sweep's result tables back as one JSON document.
 *
 * One psql round-trip returning a single JSON value, rather than six
 * tab-separated queries parsed by hand: the timings carry floats and the plans
 * carry nested JSON, and a hand-rolled TSV parser is where a decimal separator
 * or an embedded tab silently corrupts a number nobody re-checks.
 *
 * `coalesce(json_agg(...), '[]')` on every list so an empty table yields `[]`
 * rather than SQL NULL, which would arrive as `null` and break every `.map`
 * downstream.
 */
function readResults(url) {
  const query = `
    select json_build_object(
      'timings', (select coalesce(json_agg(t), '[]'::json) from (
          select probe, rung,
                 percentile_cont(0.5)  within group (order by ms) as p50_ms,
                 percentile_cont(0.95) within group (order by ms) as p95_ms
            from sweep_timings group by probe, rung order by probe, rung) t),
      'growth', (select coalesce(json_agg(g), '[]'::json) from (
          with p50 as (
            select probe, rung, percentile_cont(0.5) within group (order by ms) as ms
              from sweep_timings group by probe, rung),
          bounds as (select probe, min(rung) lo, max(rung) hi from p50 group by probe)
          select b.probe, b.lo as from_rows, b.hi as to_rows,
                 lo.ms as p50_lo_ms, hi.ms as p50_hi_ms,
                 (hi.ms / nullif(lo.ms, 0)) as growth_x
            from bounds b
            join p50 lo on lo.probe = b.probe and lo.rung = b.lo
            join p50 hi on hi.probe = b.probe and hi.rung = b.hi
           order by growth_x desc nulls last) g),
      'phases', (select coalesce(json_agg(p), '[]'::json) from (
          select rung, started_at, ended_at from sweep_phases order by rung) p),
      'plans', (select coalesce(json_agg(pl), '[]'::json) from (
          select probe, rung, node_type from sweep_plans) pl),
      'indexes', (select coalesce(json_agg(i), '[]'::json) from (
          select index_name, bytes from sweep_index_sizes order by bytes desc) i),
      'meta', (select coalesce(json_agg(m), '[]'::json) from (
          select key, value from sweep_meta) m)
    )::text`;

  // -A -t: unaligned, tuples only — the output is exactly the JSON and nothing
  // else, so it parses without trimming decorations.
  const res = run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', query], { quiet: true });
  if (res.status !== 0) {
    console.error(`\n⚠ Could not read the sweep results back: ${res.stderr || res.stdout}`);
    return {};
  }
  try {
    return JSON.parse(res.stdout.trim());
  } catch (err) {
    console.error(`\n⚠ Sweep results were not valid JSON: ${err.message}`);
    return {};
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  // The usage block at the top of this file is the documentation; print it
  // rather than maintaining a second copy that can drift from it.
  console.log(
    '\nRow-scaling sweep — find where per-user cost bends.\n\n'
    + 'Usage: node scripts/sweep-rows.mjs [options]\n\n'
    + '  --rungs <list>         focal-user row counts        (default 1000,5000,25000,100000)\n'
    + '  --users <n>            background users             (default 3)\n'
    + '  --background-rows <n>  rows per background user     (default 2000)\n'
    + '  --iterations <n>       repetitions per probe        (default 25)\n'
    + '  --port <n>             throwaway cluster port       (default 55433)\n'
    + '  --pgbin <path>         PostgreSQL bin directory     (default: probed)\n'
    + '  --database-url <url>   use an existing DB (bootstrap + migrations already applied)\n'
    + '  --keep                 leave the cluster running afterwards\n\n'
    + 'Reads the SHAPE of the curve, not absolute ms — local hardware is not Supabase.\n',
  );
  process.exit(0);
}

for (const [flag, value] of [['--users', opts.users], ['--background-rows', opts.backgroundRows], ['--iterations', opts.iterations], ['--port', opts.port]]) {
  if (!/^\d+$/.test(value)) die(`${flag} must be a positive integer, got "${value}"`);
}
if (!/^\d+(,\d+)*$/.test(opts.rungs)) die(`--rungs must be a comma-separated list of integers, got "${opts.rungs}"`);

const sweepFile = path.join(repoRoot, 'supabase/tests/row-scaling-sweep.sql');
if (!existsSync(sweepFile)) die(`Missing ${sweepFile}`);

const byo = Boolean(opts.databaseUrl);
const pgbin = byo ? null : findPgBin(opts.pgbin);
let url = opts.databaseUrl;

if (byo) {
  console.log(
    '\n⚠ Running against the database you supplied. The sweep GROWS it —\n'
    + '  index bloat survives a delete. Never point this at production.',
  );
} else {
  const started = startCluster(pgbin, opts.port);
  url = started.url;
  applySchema(url, opts.port);
}

console.log(
  `\n▸ Sweeping rungs ${opts.rungs} `
  + `(${opts.users} background users × ${opts.backgroundRows} rows, `
  + `${opts.iterations} iterations/probe)\n`,
);

const started = Date.now();
const res = psql(url, [
  '-v', `rungs=${opts.rungs}`,
  '-v', `users=${opts.users}`,
  '-v', `background_rows=${opts.backgroundRows}`,
  '-v', `iterations=${opts.iterations}`,
  '-f', sweepFile,
]);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (res.status !== 0) {
  if (!byo) stopCluster(pgbin, opts.port, { keep: opts.keep });
  die(`Sweep failed after ${elapsed}s (psql exit ${res.status}).`);
}

// ── Ship the run to Dash0 ────────────────────────────────────────────────────
// Read BEFORE the cluster is torn down, obviously — but also before printing
// the closing summary, so a failed export is reported next to the numbers it
// failed to ship rather than scrolled off above them.
const results = readResults(url);
const report = await exportSweep(results, opts);

if (!byo) stopCluster(pgbin, opts.port, { keep: opts.keep });

console.log(`\n✓ Sweep completed in ${elapsed}s.`);
if (report.dryRun) {
  const dir = process.env.TMPDIR || '/tmp';
  const traces = path.join(dir, 'sweep-otlp-traces.json');
  const metrics = path.join(dir, 'sweep-otlp-metrics.json');
  writeFileSync(traces, JSON.stringify(report.traces, null, 2));
  writeFileSync(metrics, JSON.stringify(report.metrics, null, 2));
  console.log(
    `  Dry run — nothing was sent. Payloads written to:\n`
    + `    ${traces}\n    ${metrics}\n\n`
    + '  POST them yourself to check the ingress accepts the shape:\n'
    + `    curl -i -X POST "$OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces" \\\n`
    + '      -H "Authorization: Bearer $DASH0_TOKEN" \\\n'
    + '      -H "Content-Type: application/json" \\\n'
    + `      --data @${traces}`,
  );
} else if (report.exported) {
  console.log(
    `  Exported to Dash0: ${report.spans} spans, ${report.datapoints} datapoints.\n`
    + `    run_id   ${report.runId}\n`
    + `    trace_id ${report.traceId}\n`
    + `  Compare runs on service.name=sweep, keyed by vcs.ref.head.revision.`,
  );
} else if (report.reason) {
  // Not an error. No endpoint configured is the normal local case.
  console.log(
    `  Dash0 export skipped (${report.reason}). Set LOREKIT_TELEMETRY_TOKEN, or\n`
    + '  OTEL_EXPORTER_OTLP_ENDPOINT + OTEL_EXPORTER_OTLP_HEADERS, to record this run.',
  );
} else {
  console.log(`  ⚠ Dash0 export FAILED: ${report.errors.join('; ')}`);
}
console.log(
  '\n  Read the growth-factor table first: ~1.0x is indexed, and a probe that\n'
  + '  tracks the row multiple is doing a linear scan.\n',
);
