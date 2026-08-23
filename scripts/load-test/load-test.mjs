#!/usr/bin/env node
/**
 * LoreKit load test — drives the REST surface at a fixed arrival rate, then
 * attributes the latency to specific SQL statements.
 *
 * WHY REST, AND WHY NOT MCP OR THE CLI
 * ------------------------------------
 * REST and MCP converge on the same handlers and the same SQL, so the expensive
 * part is shared — and REST reads are the only surface that can actually be
 * pushed: MCP checks the rate limit on EVERY method (120/min/user = 2 rps), so a
 * load script pointed at it measures the rate limiter. The CLI is a REST client
 * and adds no server-side path; load-testing it measures node startup on the
 * runner. Full reasoning in docs/benchmarking.md.
 *
 * WHAT MAKES THE NUMBERS TRUSTWORTHY
 *  - OPEN LOOP. The arrival schedule is fixed up front, so a slowing server
 *    cannot reduce the offered load (see `buildSchedule`).
 *  - Percentiles over successful requests only; 429 is counted separately
 *    because it is the guardrail working, not a failure.
 *  - Users are SCALED rather than having their limits raised: the rate-limit
 *    counter is one row per (user, window), so concentrating load on one user
 *    builds a hot row production never sees.
 *  - The real output is the `pg_stat_statements` DELTA across the run, which
 *    turns "p95 was 240 ms" into "these three statements were 62 % of it".
 *
 * SAFETY
 *  - No default target. `--target production` must be typed in full.
 *  - Every provisioned user is deleted in a `finally`, and deletion cascades to
 *    their memories and their `user_limits` row.
 *  - Users are named with the anchored `loadtest-` prefix so
 *    `scripts/smoke-cleanup.mjs`-style sweeps can find any residue.
 *
 * USAGE
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     node scripts/load-test.mjs --target preview --rps 20 --duration 120 --users 5
 *
 *   Add NODE_USE_ENV_PROXY=1 in a cloud sandbox, or the Dash0 export returns
 *   `403 Host not in allowlist` for a host that is allowlisted (root CLAUDE.md,
 *   sandbox baseline point 6).
 */

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_MIX,
  buildOpSequence,
  buildSchedule,
  checkServiceCredential,
  dbShare,
  diffQueryStats,
  resolveTarget,
  summarize,
  totals,
} from './load-test-lib.mjs';
import { exportLoad } from '../telemetry/load-telemetry.mjs';

// ── argv ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { rps: '20', duration: '60', users: '5', seed: '50', target: null, dryRun: false, keepUsers: false };
  const flags = {
    '--target': 'target', '--rps': 'rps', '--duration': 'duration',
    '--users': 'users', '--seed': 'seed',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') { opts.dryRun = true; continue; }
    if (argv[i] === '--keep-users') { opts.keepUsers = true; continue; }
    if (argv[i] === '--help' || argv[i] === '-h') { opts.help = true; continue; }
    const key = flags[argv[i]];
    if (!key) die(`Unknown argument: ${argv[i]} (try --help)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) die(`${argv[i]} needs a value.`);
    opts[key] = value;
    i += 1;
  }
  return opts;
}

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const log = (msg) => console.log(msg);

// ── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * One measured request. Never throws: a transport failure is DATA (status 0),
 * not a reason to abandon a run that is minutes in.
 */
async function timed(op, url, init, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    // Drain the body: leaving it unread can hold the socket and skew the next
    // request's latency, which is the kind of self-inflicted noise that makes a
    // load test's p95 unreproducible.
    await res.arrayBuffer().catch(() => {});
    return { op, status: res.status, ms: performance.now() - t0 };
  } catch (err) {
    return { op, status: 0, ms: performance.now() - t0, error: `${err.name}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function json(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ── provisioning ─────────────────────────────────────────────────────────────

/**
 * Create N confirmed users and sign each in for a JWT.
 *
 * The same Auth-admin-API shape `scripts/mint-smoke-jwt.mjs` uses for its
 * single ephemeral user — not imported, because that script is a CLI with no
 * exports and refactoring it is not this change's job.
 *
 * Passwords are per-run random and never printed: they exist for the length of
 * one sign-in and the user is deleted at the end.
 */
async function provisionUsers({ supabaseUrl, serviceKey, anonKey, count, runId }) {
  const admin = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const users = [];

  for (let i = 0; i < count; i += 1) {
    const email = `loadtest-${runId}-${i}@lorekit.test`;
    const password = `Lk-${randomUUID()}`;
    const created = await json(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ email, password, email_confirm: true }),
    });

    const session = await json(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!session?.access_token) throw new Error(`No access_token for ${email}`);

    users.push({ id: created.id, email, jwt: session.access_token });
  }

  // Raise `max_memories` — and ONLY that. Writes accumulate across runs and a
  // run that dies on the cap has measured nothing; a higher ceiling distorts
  // nothing. `requests_per_minute` is deliberately left at its default: raising
  // it would let one user absorb the whole load and turn the per-user counter
  // row into a hot row production never sees.
  await json(`${supabaseUrl}/rest/v1/user_limits`, {
    method: 'POST',
    headers: { ...admin, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(users.map((u) => ({ user_id: u.id, max_memories: 1_000_000 }))),
  });

  return users;
}

/** Delete the provisioned users. Cascades to their memories and user_limits row. */
async function deleteUsers({ supabaseUrl, serviceKey, users }) {
  const admin = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  let removed = 0;
  for (const u of users) {
    try {
      await json(`${supabaseUrl}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: admin });
      removed += 1;
    } catch (err) {
      // Report and keep going: one stuck user must not prevent deleting the
      // rest, and residue is worse than a noisy log.
      console.error(`  ⚠ could not delete ${u.email}: ${err.message}`);
    }
  }
  return removed;
}

/** Seed a little lore per user, so reads return rows instead of measuring an empty table. */
async function seedLore({ endpoint, users, perUser, runId, headers }) {
  let written = 0;
  for (const u of users) {
    for (let i = 0; i < perUser; i += 1) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { ...headers(u), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: SCOPES[i % SCOPES.length],
          key: `loadtest-${runId}-seed-${i}`,
          value: `Seed lesson ${i} for load run ${runId}. Merged intervals, never summed.`,
          tags: ['loadtest', runId],
        }),
      });
      await res.arrayBuffer().catch(() => {});
      if (res.ok) written += 1;
    }
  }
  return written;
}

const SCOPES = ['global', 'project::loadtest', 'repo::mthines/lorekit', 'branch::mthines/lorekit::main'];

// ── query stats ──────────────────────────────────────────────────────────────

/**
 * Snapshot `lorekit_db_query_stats()` through PostgREST with the service-role
 * key — the same RPC the `profiling` edge function reads.
 *
 * Returns `[]` rather than throwing when it is unavailable: on a project
 * without `pg_stat_statements` (or without migration 00074 deployed) the load
 * test still produces client-side percentiles, which is most of its value. A
 * missing attribution is a degraded run, not a failed one.
 */
async function snapshotQueryStats({ supabaseUrl, serviceKey }) {
  try {
    return await json(`${supabaseUrl}/rest/v1/rpc/lorekit_db_query_stats`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_limit: 200 }),
    }) ?? [];
  } catch (err) {
    console.error(`  ⚠ query-stats snapshot unavailable: ${err.message.slice(0, 160)}`);
    return [];
  }
}

// ── the drive phase ──────────────────────────────────────────────────────────

/**
 * Fire the schedule. Requests are launched on their planned offset and awaited
 * together at the end, which is what makes this open-loop: a slow response
 * delays nothing but itself.
 */
async function drive({ endpoint, users, schedule, ops, headers, correlationId }) {
  const started = performance.now();
  const inFlight = [];

  for (let i = 0; i < schedule.length; i += 1) {
    const due = schedule[i];
    const drift = due - (performance.now() - started);
    // Only sleep when actually ahead of schedule. If we are behind, fire
    // immediately — falling further behind is itself a finding, and it shows up
    // as the achieved rate below the requested one.
    if (drift > 1) await new Promise((r) => setTimeout(r, drift));

    const user = users[i % users.length];
    const op = ops[i];
    const h = { ...headers(user), 'X-LoreKit-Correlation-Id': correlationId };
    inFlight.push(request({ endpoint, op, user, headers: h, i, correlationId }));
  }

  const results = await Promise.all(inFlight);
  return { results, wallMs: performance.now() - started };
}

function request({ endpoint, op, headers, i, correlationId }) {
  switch (op) {
    case 'list':
      return timed(op, `${endpoint}?scope=${encodeURIComponent(SCOPES[i % SCOPES.length])}&limit=50`, { headers });
    case 'search':
      return timed(op, `${endpoint}/search`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: 'merged intervals', limit: 25 }),
      });
    case 'scopes':
      return timed(op, `${endpoint}/scopes`, { headers });
    case 'write':
      return timed(op, endpoint, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: SCOPES[i % SCOPES.length],
          // Unique per request, so every write is an INSERT that goes through
          // the cap trigger — an upsert UPDATE would skip it entirely and the
          // write path would measure the wrong thing.
          key: `loadtest-${correlationId}-w-${i}`,
          value: `Load write ${i}.`,
          tags: ['loadtest', correlationId],
        }),
      });
    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────

const ms = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}`);

function report({ run, summary, agg, queryDiff, share, achievedRps }) {
  log('\n════════════════════════════════════════════════════════════════');
  log(` Load test — ${run.target}, ${run.rps} rps requested / ${achievedRps.toFixed(1)} achieved, ${run.users} users`);
  log('════════════════════════════════════════════════════════════════\n');

  log('  op        count      ok    429    err       p50       p95       p99');
  log('  ' + '─'.repeat(64));
  for (const r of summary) {
    log(
      `  ${r.op.padEnd(9)} ${String(r.count).padStart(5)} ${String(r.ok).padStart(7)}`
      + ` ${String(r.rateLimited).padStart(6)} ${String(r.errors).padStart(6)}`
      + ` ${ms(r.p50).padStart(9)} ${ms(r.p95).padStart(9)} ${ms(r.p99).padStart(9)}`,
    );
  }
  log('  ' + '─'.repeat(64));
  log(
    `  ${'TOTAL'.padEnd(9)} ${String(agg.requests).padStart(5)} ${String(agg.ok).padStart(7)}`
    + ` ${String(agg.rateLimited).padStart(6)} ${String(agg.errors).padStart(6)}`
    + ` ${ms(agg.p50).padStart(9)} ${ms(agg.p95).padStart(9)} ${ms(agg.p99).padStart(9)}   (ms)`,
  );

  if (achievedRps < run.rps * 0.9) {
    log(
      `\n  ⚠ Achieved rate is ${((achievedRps / run.rps) * 100).toFixed(0)} % of requested.`
      + '\n    Either the target is saturating or THIS RUNNER is. A shared 2-core'
      + '\n    runner saturates first — distrust the client-side percentiles above'
      + '\n    and read the server-side numbers instead.',
    );
  }

  if (!queryDiff.length) {
    log('\n  No query attribution: pg_stat_statements is unavailable, or migration');
    log('  00074 is not deployed to this target. Client percentiles above still hold.');
    return;
  }

  log('\n── Where the time went, server-side (delta over this run) ──────\n');
  if (share) {
    log(`  db exec ${(share.dbMs / 1000).toFixed(2)} s ÷ client wall ${(share.clientMs / 1000).toFixed(2)} s = ${share.ratio.toFixed(2)}`);
    log('  (above 1 means concurrency — the DB did more work than any one client waited for)\n');
  }
  log('     total ms    calls    mean ms  statement');
  log('  ' + '─'.repeat(74));
  for (const r of queryDiff.slice(0, 10)) {
    const q = (r.query ?? '').slice(0, 46);
    log(
      `  ${r.totalMs.toFixed(1).padStart(11)} ${String(r.calls).padStart(8)}`
      + ` ${r.meanMs.toFixed(3).padStart(10)}  ${q}${r.isNew ? ' [new]' : ''}`,
    );
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  log(`
LoreKit load test — open-loop REST driver with SQL attribution.

  --target <preview|production>   REQUIRED. No default, and production must be
                                  typed in full.
  --rps <n>          arrival rate                     (default 20)
  --duration <s>     drive duration in seconds        (default 60)
  --users <n>        provisioned users; each gets its own 120 rpm budget (5)
  --seed <n>         lore rows seeded per user        (default 50)
  --dry-run          build the OTLP payloads, send nothing
  --keep-users       skip cleanup (for debugging; leaves real rows behind)

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY.
     LOREKIT_TELEMETRY_TOKEN (or OTEL_EXPORTER_OTLP_*) to export to Dash0.
     NODE_USE_ENV_PROXY=1 in a cloud sandbox.
`);
  process.exit(0);
}

const targetResult = resolveTarget(opts.target, process.env);
if (!targetResult.ok) die(targetResult.error);
const target = targetResult.target;

for (const [flag, v] of [['--rps', opts.rps], ['--duration', opts.duration], ['--users', opts.users], ['--seed', opts.seed]]) {
  if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) die(`${flag} must be a positive number, got "${v}"`);
}

const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
if (!supabaseUrl) die('SUPABASE_URL is required.');
if (!serviceKey) die('SUPABASE_SERVICE_ROLE_KEY is required — provisioning users needs the Auth admin API.');
if (!anonKey) die('SUPABASE_ANON_KEY is required — signing a user in uses the anon key.');

// Settle what can be settled offline. Supabase answers "wrong project", "anon
// key in the service slot" and "revoked key" with the same
// `401 {"message":"Invalid API key"}`, so a live 401 does not say which — and
// finding out costs a CI round-trip that provisions nothing.
const cred = checkServiceCredential({ serviceKey, anonKey, supabaseUrl });
for (const w of cred.warnings) log(`  ! ${w}`);
if (cred.errors.length) die(`credential check failed:\n  - ${cred.errors.join('\n  - ')}`);

const run = {
  target,
  rps: Number(opts.rps),
  durationSec: Number(opts.duration),
  users: Number(opts.users),
};
const runId = randomUUID().slice(0, 8);
const correlationId = `load-${runId}`;
// The `memories` FUNCTION base. Every op path is relative to this, so it must
// NOT be re-suffixed with `/memories`: `…/functions/v1/memories/memories`
// matches the router's `/:id` route with id="memories" rather than the list
// route, and the run measures error responses while looking healthy.
const endpoint = `${supabaseUrl}/functions/v1/memories`;
const headers = (user) => ({
  Authorization: `Bearer ${user.jwt}`,
  apikey: anonKey,
  'X-LoreKit-Client': 'cli',
  // Marks the run's server spans synthetic, so they filter apart from real
  // traffic instead of polluting a production view.
  'X-LoreKit-Deployment-Environment': 'test',
});

log(`\n▸ Load test → ${target}  (${supabaseUrl})`);
log(`  ${run.rps} rps × ${run.durationSec}s across ${run.users} users · correlation_id ${correlationId}`);
if (target === 'production') {
  log('  ⚠ PRODUCTION: this writes real rows into the shared memories table and');
  log('    consumes real Dash0 ingest quota.');
}

let users = [];
try {
  log(`\n▸ Provisioning ${run.users} users`);
  try {
    users = await provisionUsers({ supabaseUrl, serviceKey, anonKey, count: run.users, runId });
  } catch (err) {
    // The pre-flight above already ruled out the two decidable causes of a 401
    // (wrong project, wrong role). If one still arrives, the remaining causes
    // are both invisible from here — so name them rather than leaving the
    // operator with Supabase's "Double check your … API key" hint, which points
    // at the key's FORMAT and is the one thing that is not wrong.
    if (/→ 401\b/.test(err?.message ?? '') && cred.errors.length === 0) {
      log('\n  The credential pre-flight passed, so the key is the right role for the right');
      log('  project. A 401 here leaves two causes, neither visible offline:');
      log('    1. The key was rotated or revoked — re-copy it from Project Settings ▸ API.');
      log('    2. Legacy API keys are DISABLED on this project, which rejects a legacy');
      log('       `service_role` JWT as "Invalid API key". Use the `sb_secret_…` key instead.');
    }
    throw err;
  }

  log(`▸ Seeding ${opts.seed} lore rows per user`);
  const seeded = await seedLore({ endpoint, users, perUser: Number(opts.seed), runId, headers });
  log(`  ${seeded} rows written`);

  log('▸ Baseline query-stats snapshot');
  const before = await snapshotQueryStats({ supabaseUrl, serviceKey });

  const schedule = buildSchedule({ rps: run.rps, durationSec: run.durationSec });
  const ops = buildOpSequence(schedule.length, DEFAULT_MIX);
  log(`▸ Driving ${schedule.length} requests (open loop)\n`);

  const startMs = Date.now();
  const { results, wallMs } = await drive({ endpoint, users, schedule, ops, headers, correlationId });
  const endMs = Date.now();

  log('▸ Final query-stats snapshot');
  const after = await snapshotQueryStats({ supabaseUrl, serviceKey });

  const summary = summarize(results);
  const agg = totals(results);
  const queryDiff = diffQueryStats(before, after);
  const share = dbShare(results, queryDiff);
  const achievedRps = results.length / (wallMs / 1000);

  report({ run, summary, agg, queryDiff, share, achievedRps });

  const exported = await exportLoad({
    run: { ...run, startMs, endMs },
    summary, agg, queryDiff, share, correlationId, dryRun: opts.dryRun,
  });

  if (exported.dryRun) {
    log('\n▸ Dry run — nothing sent. Payload summary:');
    log(`    spans      ${exported.traces.resourceSpans[0].scopeSpans[0].spans.length}`);
    log(`    metrics    ${exported.metrics.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name).join(', ')}`);
  } else if (exported.exported) {
    log(`\n▸ Exported to Dash0: ${exported.datapoints} datapoints · trace ${exported.traceId}`);
    log(`  Compare runs on service.name=load; join the server side on`);
    log(`  lorekit.correlation_id=${correlationId}`);
  } else if (exported.reason) {
    log(`\n▸ Dash0 export skipped (${exported.reason}).`);
  } else {
    log(`\n  ⚠ Dash0 export FAILED: ${exported.errors.join('; ')}`);
  }

  // A run that produced 5xx has found something, and CI should notice.
  if (agg.errors > 0) {
    console.error(`\n✗ ${agg.errors} request(s) failed with 5xx or a transport error.`);
    process.exitCode = 1;
  }
} finally {
  // In a `finally` so an exception mid-run still removes the users. Residue is
  // real rows in a real project, and on production it is somebody's tenant.
  if (users.length && !opts.keepUsers) {
    log(`\n▸ Cleanup: deleting ${users.length} users (cascades to their memories)`);
    const removed = await deleteUsers({ supabaseUrl, serviceKey, users });
    log(`  ${removed}/${users.length} removed`);
    if (removed < users.length) {
      console.error(`  ⚠ ${users.length - removed} user(s) left behind — they match loadtest-${runId}-*`);
      process.exitCode = 1;
    }
  } else if (opts.keepUsers && users.length) {
    log(`\n▸ --keep-users: ${users.length} users left in place, matching loadtest-${runId}-*`);
  }
}
