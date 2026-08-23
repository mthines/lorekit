#!/usr/bin/env node
/**
 * LoreKit load and stress test — drives a chosen surface at a fixed arrival rate
 * (or up a ladder of rates), then attributes the latency to specific SQL
 * statements.
 *
 * TWO DIMENSIONS: SURFACE x AUTH TIER
 * -----------------------------------
 * The pair identifies a real caller, and all three pairings are genuinely
 * different code paths — the REST-only arm this started as was never
 * whole-system coverage:
 *
 *   rest + jwt    the DASHBOARD (packages/web/src/lib/api/)
 *   rest + token  the CLI in remote mode — `lk_*` takes a different branch of
 *                 `resolveRestAuth`, reached via a DB lookup on `api_tokens`
 *   mcp  + token  AGENTS — its own handlers (mcp/tools.ts), its own auth span
 *                 (`lorekit.mcp.auth`, which `lorekit.rest.auth` is NOT), and it
 *                 rate-limits EVERY method where REST gates only writes
 *
 * They converge at the RPC/SQL layer, so a DATABASE finding generalises across
 * them. A transport or auth finding does not.
 *
 * THE CONSTRAINT THAT SHAPES THE MCP ARM
 * MCP checks the rate limit on every method — 120/min/user = 2 rps — so rate is
 * bought with USERS, not with a bigger number. 20 rps needs 10 users; 100 needs
 * 50. `checkRateHeadroom` REFUSES a configuration that cannot fit, because a run
 * that silently measures its own throttling produces a number that looks usable.
 * Full reasoning in docs/benchmarking.md.
 *
 * WHAT MAKES THE NUMBERS TRUSTWORTHY
 *  - OPEN LOOP. The arrival schedule is fixed up front, so a slowing server
 *    cannot reduce the offered load (see `buildSchedule`).
 *  - On MCP, the OUTCOME is read from the JSON-RPC body, not the status code:
 *    that transport returns application errors inside a 200, so a status-only
 *    reading scores every failed tool call as a success.
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

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  DEFAULT_MIX,
  MCP_TOOL_FOR_OP,
  buildOpSequence,
  buildRampRungs,
  buildSchedule,
  checkRateHeadroom,
  checkServiceCredential,
  classifyMcpResponse,
  dbShare,
  diffQueryStats,
  mcpArgumentsFor,
  rampVerdict,
  resolveAuthMode,
  resolveSurface,
  resolveTarget,
  summarize,
  totals,
} from './load-test-lib.mjs';
import { exportLoad } from './load-telemetry.mjs';

// ── argv ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    rps: '20', duration: '60', users: '5', seed: '50', target: null,
    surface: null, auth: null, maxRps: null,
    dryRun: false, keepUsers: false, ramp: false,
  };
  const flags = {
    '--target': 'target', '--rps': 'rps', '--duration': 'duration',
    '--users': 'users', '--seed': 'seed',
    '--surface': 'surface', '--auth': 'auth', '--max-rps': 'maxRps',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') { opts.dryRun = true; continue; }
    if (argv[i] === '--keep-users') { opts.keepUsers = true; continue; }
    if (argv[i] === '--ramp') { opts.ramp = true; continue; }
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

/**
 * One measured MCP request. Like `timed`, but it PARSES the body.
 *
 * It has to. JSON-RPC returns application errors inside a 200, so unlike REST
 * the status code does not determine the outcome — draining the body unread (as
 * `timed` does, deliberately, to avoid holding the socket) would make every
 * failed tool call indistinguishable from a success. The body is small here: a
 * tool result, not a page of rows.
 */
async function timedMcp(op, url, init, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    const outcome = classifyMcpResponse({ status: res.status, body });
    const detail = outcome === 'error'
      ? (body?.error?.message ?? body?.result?.content?.[0]?.text ?? `HTTP ${res.status}`)
      : undefined;
    return { op, status: res.status, ms: performance.now() - t0, outcome, error: detail?.slice(0, 200) };
  } catch (err) {
    return { op, status: 0, ms: performance.now() - t0, outcome: 'error', error: `${err.name}: ${err.message}` };
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
/**
 * Seed lore so reads measure a populated table.
 *
 * ALWAYS over REST with a JWT, whatever surface is being driven. Seeding is
 * setup, not measurement — and pointing it at the surface `endpoint` would POST
 * REST-shaped bodies at the JSON-RPC function on `--surface mcp`, seeding
 * nothing and leaving every subsequent read to measure an empty table while the
 * report looked healthy. Same failure class as the doubled `/memories` path this
 * harness shipped with once already.
 */
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

/**
 * Mint an `lk_rw_*` API token for a provisioned user.
 *
 * WHY THE HARNESS MINTS ITS OWN
 * The token tiers are not cosmetic: `lk_*` takes a different branch of
 * `resolveRestAuth`/`mcp/auth.ts` than a dashboard JWT — a service-role client
 * with a mandatory `user_id` filter, reached via a DB lookup on `api_tokens`.
 * Agents hold these, so driving MCP or the CLI's remote path with a JWT would
 * measure a code path nobody runs in production.
 *
 * Inserted directly with the service-role key. The table's RLS insert policy is
 * `user_id = auth.uid()`, which a service-role connection bypasses — the same
 * reason the harness can provision users at all. The row is deleted with the
 * user (`on delete cascade`).
 *
 * The hash contract is fixed by `mcp/auth.ts`: plain SHA-256 HEX of the full
 * token string, looked up against `api_tokens.token_hash`. Not a salted hash,
 * not base64 — a mismatch here 401s every request in the run.
 */
async function mintApiToken({ supabaseUrl, serviceKey, userId, runId }) {
  // `lk_{perm}_{32 alphanumerics}`, per 00002_api_tokens.sql.
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(32);
  const suffix = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  const token = `lk_rw_${suffix}`;
  const hash = createHash('sha256').update(token).digest('hex');

  await json(`${supabaseUrl}/rest/v1/api_tokens`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      user_id: userId,
      name: `loadtest-${runId}`,
      // First 12 chars + "..." — the display form, capped at 16 by a CHECK.
      token_prefix: `${token.slice(0, 12)}...`,
      token_hash: hash,
      permissions: ['read', 'write'],
    }),
  });
  return token;
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
async function drive({ endpoint, users, schedule, ops, headers, correlationId, requestFn }) {
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
    inFlight.push(requestFn({ endpoint, op, user, headers: h, i, correlationId }));
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

/**
 * The MCP counterpart: one JSON-RPC `tools/call` over POST.
 *
 * MCP is STATELESS here — `mcp-handler.ts` dispatches `tools/call` on its own,
 * with `initialize` handled but never a precondition — so no handshake is
 * replayed per request. One `initialize` per user would be protocol-polite and
 * would measure nothing, so it is omitted rather than inflating the request
 * count with a method no agent repeats.
 *
 * Every request carries the rate limiter's full attention: unlike REST, MCP
 * checks the limit on EVERY method, which is why `checkRateHeadroom` refuses a
 * configuration that cannot fit under it.
 */
function mcpRequest({ endpoint, op, headers, i, correlationId }) {
  const scope = SCOPES[i % SCOPES.length];
  const args = mcpArgumentsFor(op, {
    scope,
    // Unique per request for the same reason as the REST arm: an upsert UPDATE
    // would skip the cap trigger and measure the wrong write.
    key: `loadtest-${correlationId}-m-${i}`,
    value: `Load write ${i}.`,
    q: 'merged intervals',
  });
  return timedMcp(op, endpoint, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: i + 1,
      method: 'tools/call',
      params: { name: MCP_TOOL_FOR_OP[op], arguments: args },
    }),
  });
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
  --surface <s>      rest | mcp                        (default rest)
                     rest = dashboard/CLI path, mcp = the AGENT path
  --auth <a>         jwt | token                       (default: mcp->token, rest->jwt)
                     rest+token is the CLI's remote path (api_key tier)
  --ramp             stress mode: step the rate until saturation
  --max-rps <n>      the ramp's ceiling (required with --ramp)
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

const surfaceResult = resolveSurface(opts.surface, process.env);
if (!surfaceResult.ok) die(surfaceResult.error);
const surface = surfaceResult.surface;

const authResult = resolveAuthMode(opts.auth, surface, process.env);
if (!authResult.ok) die(authResult.error);
const authMode = authResult.auth;

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
  // Carried into the telemetry: without these two, an MCP run and a REST run
  // land in the SAME Dash0 series and average together, which is the one
  // comparison this harness exists to make.
  surface,
  authTier: authMode,
  rps: Number(opts.rps),
  durationSec: Number(opts.duration),
  users: Number(opts.users),
};
// REFUSE a configuration the rate limiter would decide. MCP checks the limit on
// every method (2 rps/user at the 120/min default), so the harness's own
// defaults — 20 rps across 5 users — are 2x over on that surface: half the run
// would 429 and the percentiles would describe the guardrail, not the service. A
// load test that silently measures its own throttling is worse than none,
// because the number looks usable. Fails with the users actually required.
const peakRps = opts.ramp && opts.maxRps ? Number(opts.maxRps) : run.rps;
const headroom = checkRateHeadroom({ surface, rps: peakRps, users: run.users });
if (!headroom.ok) die(headroom.error);

const runId = randomUUID().slice(0, 8);
const correlationId = `load-${runId}`;
// The `memories` FUNCTION base. Every op path is relative to this, so it must
// NOT be re-suffixed with `/memories`: `…/functions/v1/memories/memories`
// matches the router's `/:id` route with id="memories" rather than the list
// route, and the run measures error responses while looking healthy.
const endpoint = surface === 'mcp'
  ? `${supabaseUrl}/functions/v1/mcp`
  : `${supabaseUrl}/functions/v1/memories`;
const requestFn = surface === 'mcp' ? mcpRequest : request;

// Both functions declare `verify_jwt = false` (supabase/config.toml), so the
// gateway does not gate them and the function does its own auth — which is why
// an `lk_*` token needs no accompanying `apikey`, exactly as the CLI sends it
// (`packages/cli/src/mcp.mjs`). The JWT arm keeps the anon key because that is
// what the dashboard sends.
const headers = (user) => ({
  ...(authMode === 'token'
    ? { Authorization: `Bearer ${user.token}` }
    : { Authorization: `Bearer ${user.jwt}`, apikey: anonKey }),
  'X-LoreKit-Client': surface === 'mcp' ? 'mcp' : 'cli',
  // Marks the run's server spans synthetic, so they filter apart from real
  // traffic instead of polluting a production view.
  'X-LoreKit-Deployment-Environment': 'test',
});

log(`\n▸ Load test → ${target}  (${supabaseUrl})`);
log(`  surface ${surface} · auth ${authMode}${surface === 'mcp' ? ' · agent path' : authMode === 'token' ? ' · CLI remote path' : ' · dashboard path'}`);
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
    if (authMode === 'token') {
      // Minted per user, not shared: the rate limiter counts per (user, window),
      // so one token across N users would concentrate the whole run on a single
      // counter row and measure lock serialization production never sees — the
      // same reason users are scaled rather than having their limits raised.
      log(`  minting an lk_rw_ token per user (${authMode} tier)`);
      for (const u of users) {
        u.token = await mintApiToken({ supabaseUrl, serviceKey, userId: u.id, runId });
      }
    }
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
  const seeded = await seedLore({
    endpoint: `${supabaseUrl}/functions/v1/memories`,
    users,
    perUser: Number(opts.seed),
    runId,
    // The JWT tier explicitly: a freshly minted `lk_*` token would also work,
    // but the JWT is present on every run and keeps seeding independent of
    // whichever tier is under test.
    headers: (u) => ({ Authorization: `Bearer ${u.jwt}`, apikey: anonKey, 'X-LoreKit-Deployment-Environment': 'test' }),
  });
  log(`  ${seeded} rows written`);

  log('▸ Baseline query-stats snapshot');
  const before = await snapshotQueryStats({ supabaseUrl, serviceKey });

  // ── the drive phase, one rung or a ladder ──────────────────────────────────
  // A single rung IS a load test; a ladder of rungs is the stress test. Both
  // reuse the same provisioned users and the same seeded rows, so a difference
  // between rungs is the offered rate and nothing else.
  const rungs = opts.ramp
    ? buildRampRungs({ startRps: run.rps, maxRps: Number(opts.maxRps) })
    : [run.rps];
  if (opts.ramp && !rungs.length) die('--ramp needs --max-rps >= --rps.');
  if (opts.ramp) log(`▸ Stress ladder: ${rungs.join(' → ')} rps, ${run.durationSec}s per rung\n`);

  const startMs = Date.now();
  let results = [];
  let wallMs = 0;
  const ladder = [];

  for (const rungRps of rungs) {
    const schedule = buildSchedule({ rps: rungRps, durationSec: run.durationSec });
    const ops = buildOpSequence(schedule.length, DEFAULT_MIX);
    log(`▸ Driving ${schedule.length} requests at ${rungRps} rps (open loop)`);
    const r = await drive({ endpoint, users, schedule, ops, headers, correlationId, requestFn });

    const rungAgg = totals(r.results);
    const rungAchieved = r.results.length / (r.wallMs / 1000);
    const rung = {
      requestedRps: rungRps,
      achievedRps: rungAchieved,
      count: rungAgg.requests,
      ok: rungAgg.ok,
      errors: rungAgg.errors,
      rateLimited: rungAgg.rateLimited,
      p50: rungAgg.p50, p95: rungAgg.p95, p99: rungAgg.p99,
    };
    const verdict = rampVerdict(rung);
    ladder.push({ ...rung, stopped: verdict.stop, reason: verdict.reason });

    // The LAST rung's results are the ones reported and exported in detail:
    // on a single-rung run that is the run, and on a ladder it is the most
    // interesting rung reached. Earlier rungs live in the ladder table.
    results = r.results;
    wallMs = r.wallMs;

    const ms = (v) => (v == null ? '-' : v.toFixed(1));
    log(`  ${rungRps} rps → achieved ${rungAchieved.toFixed(1)} · p50 ${ms(rung.p50)}ms · p99 ${ms(rung.p99)}ms · ${rung.errors} err · ${rung.rateLimited} 429`);
    if (verdict.stop) {
      log(`  ⤵ ladder stops here: ${verdict.reason}`);
      break;
    }
  }
  log('');
  const endMs = Date.now();

  if (opts.ramp) {
    const lastGood = [...ladder].reverse().find((r) => !r.stopped);
    log('── Stress ladder ───────────────────────────────────────────────');
    log('   req rps   achieved       p50       p99    err    429');
    for (const r of ladder) {
      const f = (v) => (v == null ? '-' : v.toFixed(1));
      log(`   ${String(r.requestedRps).padStart(7)}   ${r.achievedRps.toFixed(1).padStart(8)}   ${f(r.p50).padStart(7)}   ${f(r.p99).padStart(7)}   ${String(r.errors).padStart(4)}   ${String(r.rateLimited).padStart(4)}${r.stopped ? '   ← stopped' : ''}`);
    }
    log(lastGood
      ? `\n   Highest sustained rate: ${lastGood.requestedRps} rps (p99 ${lastGood.p99?.toFixed(1)}ms)`
      : '\n   No rung passed — the first rate was already past saturation.');
    log('');
  }

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
    summary, agg, queryDiff, share, correlationId, ladder, dryRun: opts.dryRun,
  });

  if (exported.dryRun) {
    log('\n▸ Dry run — nothing sent. Payload summary:');
    log(`    spans      ${exported.traces.resourceSpans[0].scopeSpans[0].spans.length}`);
    log(`    metrics    ${exported.metrics.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name).join(', ')}`);
  } else if (exported.exported) {
    log(`\n▸ Exported to Dash0: ${exported.datapoints} datapoints · trace ${exported.traceId}`);
    log(`  Filter: service.name=load, lorekit.load.surface=${surface}, lorekit.load.auth_tier=${authMode}`);
    log(`  Join the server side on lorekit.correlation_id=${correlationId}`);
    if (ladder.length > 1) log(`  Ladder: lorekit.load.rung.duration by rps · lorekit.load.max_sustained_rps`);
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
