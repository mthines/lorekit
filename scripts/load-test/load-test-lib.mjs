/**
 * The pure half of the load test — everything worth unit-testing, lifted out of
 * the runner so it is not only observable as a wrong number in a report.
 *
 * The runner (`load-test.mjs`) owns provisioning, HTTP and cleanup. This file
 * owns the decisions that are silently wrong when wrong: how a target is
 * resolved, how an arrival schedule is built, how percentiles are computed, and
 * how two cumulative `pg_stat_statements` snapshots are differenced.
 */

/** Requests LoreKit's REST surface can be driven with, and their weights. */
export const DEFAULT_MIX = Object.freeze([
  // Reads dominate, matching how agents actually use lore: a SessionStart
  // injection reads, a retrospective writes once.
  { op: 'list', weight: 50 },
  { op: 'search', weight: 25 },
  { op: 'scopes', weight: 10 },
  // The one rate-limited REST route (`create.ts` checks the limit), kept in the
  // mix at a low weight ON PURPOSE: it is where a 429 should first appear, and
  // a load test that never writes never exercises the cap trigger either.
  { op: 'write', weight: 15 },
]);

/**
 * Resolve the target, refusing to guess.
 *
 * There is no default. A load test points at a real deployment and writes real
 * rows, so "forgot the flag" must fail rather than pick something — and
 * `production` must be typed in full rather than reached by omission.
 */
export function resolveTarget(argvTarget, env = {}) {
  const raw = (argvTarget ?? env.LOREKIT_LOAD_TARGET ?? '').trim().toLowerCase();
  if (!raw) {
    return { ok: false, error: 'No target. Pass --target preview|production (or set LOREKIT_LOAD_TARGET). There is deliberately no default.' };
  }
  if (raw !== 'preview' && raw !== 'production') {
    return { ok: false, error: `Unknown target "${raw}". Expected preview or production.` };
  }
  return { ok: true, target: raw };
}

/**
 * Build the arrival schedule: offsets in ms from t0, one per request.
 *
 * OPEN LOOP. The offsets are fixed up front from the requested rate, and the
 * driver fires each when its time comes regardless of whether earlier requests
 * have returned. A closed loop — N workers each looping "send, await, send" —
 * measures something else and flatters the server: when it slows down you send
 * fewer requests, so the offered load drops exactly when you most want it held
 * constant. That is coordinated omission, and it is why a closed-loop harness
 * reports a p99 far better than users experience.
 *
 * Evenly spaced rather than Poisson-distributed: a fixed interval makes two
 * runs comparable, which is the point of exporting them. Burstiness is a
 * different experiment.
 */
export function buildSchedule({ rps, durationSec }) {
  if (!(rps > 0) || !(durationSec > 0)) return [];
  const total = Math.round(rps * durationSec);
  const gapMs = 1000 / rps;
  return Array.from({ length: total }, (_, i) => Math.round(i * gapMs));
}

/**
 * Expand a weighted mix into a concrete op sequence of `length`.
 *
 * Deterministic rather than random draws: two runs of the same config issue the
 * same request sequence, so a difference between them is the system changing
 * rather than the dice.
 *
 * The ops are INTERLEAVED, not grouped. A naive `pool[i % pool.length]` over a
 * grouped expansion (50 `list`, then 25 `search`, then…) looks correct and is
 * badly wrong for short runs: a 75-request run over a 100-weight mix never
 * reaches the last two ops at all, so `scopes` and `write` are silently never
 * issued — and `write` is the only rate-limited route and the only one that
 * exercises the cap trigger. Found by running it; a 1000-request unit test
 * hides it completely.
 *
 * The interleave places each op's occurrences at evenly spaced fractions of the
 * cycle, so EVERY PREFIX approximates the requested weights.
 */
export function buildOpSequence(length, mix = DEFAULT_MIX) {
  if (length <= 0) return [];

  const slots = [];
  for (const { op, weight } of mix) {
    const w = Math.max(0, Math.round(weight));
    for (let j = 0; j < w; j += 1) {
      // Spread this op's w occurrences across [0, 1). `op` breaks ties so the
      // ordering is total and therefore reproducible.
      slots.push({ op, at: (j + 0.5) / w });
    }
  }
  if (!slots.length) return [];
  slots.sort((a, b) => (a.at - b.at) || a.op.localeCompare(b.op));

  return Array.from({ length }, (_, i) => slots[i % slots.length].op);
}

/**
 * Percentiles over a sample array, by nearest-rank on the sorted values.
 *
 * Nearest-rank (not interpolated): a latency percentile should be a value that
 * was actually observed. Interpolating invents a number between two real
 * measurements, which is misleading at small sample sizes — exactly where a
 * short load run lives.
 */
export function percentile(samples, p) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  // ceil(p * n) - 1, clamped: p=0 gives the min, p=1 gives the max.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * The outcome of one request: an explicit `outcome` when the driver set one,
 * otherwise derived from the HTTP status.
 *
 * MCP needs the explicit form and REST does not, which is the whole reason this
 * exists. JSON-RPC returns application errors inside a **200**, so a status-only
 * reading counts every failed tool call as a success — a run can report 100 %
 * ok having accomplished nothing. The MCP driver therefore classifies each
 * response (`classifyMcpResponse`) and records the verdict; REST has no such
 * ambiguity and keeps deriving it from the status, unchanged.
 */
export function outcomeOf(r) {
  if (r.outcome) return r.outcome;
  if (r.status === 429) return 'rate_limited';
  if (r.status >= 200 && r.status < 300) return 'ok';
  if (r.status >= 500 || r.status === 0) return 'error';
  return 'client_error';
}

/**
 * Summarise per-op results.
 *
 * `ok` counts successes only. `rateLimited` (429) is broken out because it is not
 * a failure — it is the guardrail working, and lumping it into errors would make
 * a correctly-throttled run look broken. `errors` is 5xx, transport failures,
 * and (on MCP) a JSON-RPC or tool-level error returned inside a 200.
 */
export function summarize(results) {
  const byOp = new Map();
  for (const r of results) {
    if (!byOp.has(r.op)) byOp.set(r.op, []);
    byOp.get(r.op).push(r);
  }

  const rows = [];
  for (const [op, rs] of [...byOp.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Latency percentiles over SUCCESSFUL requests only. A 429 returns in
    // microseconds and a transport failure may return instantly or after a
    // timeout; folding either into the latency distribution moves p95 for
    // reasons that have nothing to do with how fast the service is.
    const okLatencies = rs.filter((r) => outcomeOf(r) === 'ok').map((r) => r.ms);
    rows.push({
      op,
      count: rs.length,
      ok: rs.filter((r) => outcomeOf(r) === 'ok').length,
      rateLimited: rs.filter((r) => outcomeOf(r) === 'rate_limited').length,
      clientErrors: rs.filter((r) => outcomeOf(r) === 'client_error').length,
      errors: rs.filter((r) => outcomeOf(r) === 'error').length,
      p50: percentile(okLatencies, 0.5),
      p95: percentile(okLatencies, 0.95),
      p99: percentile(okLatencies, 0.99),
      max: okLatencies.length ? Math.max(...okLatencies) : null,
    });
  }
  return rows;
}

/** Aggregate totals across every op, for the headline line. */
export function totals(results) {
  const ok = results.filter((r) => outcomeOf(r) === 'ok');
  return {
    requests: results.length,
    ok: ok.length,
    rateLimited: results.filter((r) => outcomeOf(r) === 'rate_limited').length,
    errors: results.filter((r) => outcomeOf(r) === 'error').length,
    p50: percentile(ok.map((r) => r.ms), 0.5),
    p95: percentile(ok.map((r) => r.ms), 0.95),
    p99: percentile(ok.map((r) => r.ms), 0.99),
  };
}

/**
 * Diff two `lorekit_db_query_stats()` snapshots.
 *
 * The counters are CUMULATIVE since `stats_reset`, so a raw top-N is dominated
 * by whatever the database did before the run started. The delta is the only
 * view that describes THIS run, and it is the sharpest output the harness
 * produces: it turns "p95 was 240 ms" into "62 % of it was these three
 * statements".
 *
 * A statement present in `after` but not `before` counts fully — it first ran
 * during the load. A `stats_reset` mid-run would make deltas negative; those
 * are dropped rather than reported as negative work, since a reset means the
 * baseline is meaningless rather than that time went backwards.
 */
export function diffQueryStats(before, after) {
  const index = new Map((before ?? []).map((r) => [r.queryid, r]));
  const rows = [];

  for (const row of after ?? []) {
    const prev = index.get(row.queryid);
    const deltaMs = Number(row.total_exec_ms ?? 0) - Number(prev?.total_exec_ms ?? 0);
    const deltaCalls = Number(row.calls ?? 0) - Number(prev?.calls ?? 0);
    const deltaRows = Number(row.rows_returned ?? 0) - Number(prev?.rows_returned ?? 0);

    // No calls in the window means the statement did not participate, even if
    // it dominates the cumulative totals.
    if (deltaCalls <= 0) continue;
    // Negative time with positive calls is a counter reset, not a measurement.
    if (deltaMs < 0) continue;

    rows.push({
      queryid: row.queryid,
      query: row.query,
      toplevel: row.toplevel ?? null,
      calls: deltaCalls,
      totalMs: deltaMs,
      meanMs: deltaMs / deltaCalls,
      rows: deltaRows,
      isNew: !prev,
    });
  }

  return rows.sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * What share of measured request time the database can account for.
 *
 * Deliberately reported as a RATIO with both terms shown rather than a bare
 * percentage: the two are measured on different sides of the wire (client
 * wall-clock vs. server-side exec time) and over different populations, so it
 * is an indication of where to look, never an identity. A value above 1 is
 * possible and meaningful — it says the database did more work than the client
 * waited for, which is what concurrency looks like.
 */
export function dbShare(results, queryDiff) {
  const clientMs = results
    .filter((r) => r.status >= 200 && r.status < 300)
    .reduce((n, r) => n + r.ms, 0);
  const dbMs = queryDiff.reduce((n, r) => n + r.totalMs, 0);
  if (clientMs <= 0) return null;
  return { clientMs, dbMs, ratio: dbMs / clientMs };
}

// ── credential pre-flight ────────────────────────────────────────────────────

/**
 * Classify a Supabase API key WITHOUT calling anything.
 *
 * Supabase has two generations of key, and both are live on a project during
 * migration, so the dashboard offers both and picking the wrong one is easy:
 *
 *   * legacy — a JWT (`eyJ…`) whose payload carries `role` (`anon` /
 *     `service_role`) and `ref` (the project it belongs to).
 *   * current — an opaque `sb_publishable_…` (replaces `anon`) or
 *     `sb_secret_…` (replaces `service_role`). Nothing is decodable.
 *
 * The point of decoding rather than just trying the request: Supabase answers
 * every one of "wrong project", "anon key in the service slot" and "key
 * revoked" with the same `401 {"message":"Invalid API key"}`. That is a true
 * statement and a useless diagnostic — it cost a CI round-trip to learn
 * nothing. A legacy JWT is base64 and self-describing, so which of those it is
 * can be settled locally, before the first byte goes out.
 *
 * Never throws and never returns the key. `format: 'unknown'` is the honest
 * answer for anything unrecognised — a self-hosted or future key shape must not
 * be reported as invalid.
 */
export function describeSupabaseKey(key) {
  const raw = (key ?? '').trim();
  if (!raw) return { format: 'absent' };
  if (raw.startsWith('sb_secret_')) return { format: 'new-secret', privileged: true };
  if (raw.startsWith('sb_publishable_')) return { format: 'new-publishable', privileged: false };

  const parts = raw.split('.');
  if (parts.length !== 3) return { format: 'unknown' };
  try {
    // Base64URL, and JWT payloads are unpadded — Buffer needs the padding back.
    const pad = '='.repeat((4 - (parts[1].length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8'));
    const role = typeof claims.role === 'string' ? claims.role : undefined;
    return {
      format: 'legacy-jwt',
      role,
      ref: typeof claims.ref === 'string' ? claims.ref : undefined,
      privileged: role === 'service_role',
    };
  } catch {
    return { format: 'unknown' };
  }
}

/** The project ref in a hosted Supabase URL, or undefined for anything else. */
export function projectRefFromUrl(url) {
  const m = /^https?:\/\/([a-z0-9-]+)\.supabase\.(?:co|in)$/i.exec((url ?? '').trim().replace(/\/+$/, ''));
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Pre-flight the service-role credential against the URL it will be used on.
 *
 * Returns `{ errors, warnings }`. The split matters: an error is something that
 * CANNOT work and is worth refusing before provisioning users against a real
 * project; a warning is something merely unverifiable. An opaque `sb_secret_…`
 * key is entirely unverifiable offline, and that is fine — it must pass.
 *
 * Deliberately conservative. A check that rejects a valid configuration is
 * worse than the 401 it replaces, because the 401 at least came from the
 * authority on the question.
 */
export function checkServiceCredential({ serviceKey, anonKey, supabaseUrl }) {
  const errors = [];
  const warnings = [];
  const svc = describeSupabaseKey(serviceKey);
  const anon = describeSupabaseKey(anonKey);
  const urlRef = projectRefFromUrl(supabaseUrl);

  // Unmistakable: a key that is documented as browser-safe cannot create users.
  if (svc.format === 'new-publishable') {
    errors.push('SUPABASE_SERVICE_ROLE_KEY holds a `sb_publishable_…` key. That is the browser-safe key (the `anon` replacement) and cannot reach /auth/v1/admin. Use the `sb_secret_…` key, or the legacy `service_role` JWT.');
  }
  if (svc.format === 'legacy-jwt' && svc.role && svc.role !== 'service_role') {
    errors.push(`SUPABASE_SERVICE_ROLE_KEY holds a legacy JWT with role "${svc.role}", not "service_role". Copy the service_role key (Project Settings ▸ API), not the anon one.`);
  }
  // Both refs known and different: the key is valid, for another project. This
  // is the failure that reads as "Invalid API key" and sends you hunting the
  // key format when the key was never the problem.
  if (svc.format === 'legacy-jwt' && svc.ref && urlRef && svc.ref !== urlRef) {
    errors.push(`SUPABASE_SERVICE_ROLE_KEY belongs to project "${svc.ref}" but the target URL is project "${urlRef}". Copy the service_role key from the SAME project the ref points at — Supabase reports this as "Invalid API key", which looks like a bad key rather than a mismatched one.`);
  }
  if (anon.format === 'legacy-jwt' && anon.ref && urlRef && anon.ref !== urlRef) {
    errors.push(`SUPABASE_ANON_KEY belongs to project "${anon.ref}" but the target URL is project "${urlRef}".`);
  }
  if (anon.privileged === true) {
    errors.push('SUPABASE_ANON_KEY holds a privileged key (service_role / sb_secret). The keys look swapped.');
  }

  // Unverifiable rather than wrong — say so once and continue.
  if (svc.format === 'new-secret') {
    warnings.push('SUPABASE_SERVICE_ROLE_KEY is an opaque `sb_secret_…` key, so its project and role cannot be checked offline. A 401 from here means it is revoked, disabled, or from another project.');
  }
  if (svc.format === 'unknown') {
    warnings.push('SUPABASE_SERVICE_ROLE_KEY is in an unrecognised format — neither a JWT nor an `sb_*` key. Continuing, but check it was pasted whole.');
  }
  if (svc.format === 'legacy-jwt' && !svc.ref) {
    warnings.push('SUPABASE_SERVICE_ROLE_KEY is a legacy JWT with no `ref` claim, so it cannot be matched to the target project.');
  }

  return { errors, warnings };
}

// ── surface and auth tier ────────────────────────────────────────────────────

/**
 * Which transport to drive.
 *
 * These are genuinely different code paths, not skins on one handler — which is
 * why "the load test covers LoreKit" was never true of the REST arm alone:
 *
 *   rest — `/functions/v1/memories`, the `memories` function. What the DASHBOARD
 *          calls (`packages/web/src/lib/api/`) and what the CLI calls in remote
 *          mode.
 *   mcp  — `/functions/v1/mcp`, JSON-RPC. What AGENTS call. Its own handlers
 *          (`mcp/tools.ts`), its own auth span (`lorekit.mcp.auth`), and it
 *          rate-limits EVERY method where REST gates only writes.
 *
 * They converge at the RPC/SQL layer — both reach `memory_write` and the same
 * tables — so a database finding generalises. A transport or auth finding does
 * NOT: `lorekit.rest.auth` does not exist on the MCP path at all.
 */
export function resolveSurface(argvSurface, env = {}) {
  const raw = (argvSurface ?? env.LOREKIT_LOAD_SURFACE ?? 'rest').trim().toLowerCase();
  if (raw !== 'rest' && raw !== 'mcp') {
    return { ok: false, error: `Unknown surface "${raw}". Expected rest or mcp.` };
  }
  return { ok: true, surface: raw };
}

/**
 * Which auth tier to authenticate with — the second dimension, orthogonal to
 * the surface, because the pair is what identifies a real caller:
 *
 *   rest + jwt    the dashboard          (user JWT, RLS-enforced client)
 *   rest + token  the CLI in remote mode (`lk_*`, service-role client + a
 *                 mandatory user_id filter — a DIFFERENT branch of
 *                 `resolveRestAuth`, with a DB lookup on `api_tokens`)
 *   mcp  + token  agents                 (the flow that matters most)
 *
 * Defaults per surface pick the real-world pairing rather than a fixed value,
 * so `--surface mcp` alone drives what an agent actually does.
 */
export function resolveAuthMode(argvAuth, surface, env = {}) {
  const raw = (argvAuth ?? env.LOREKIT_LOAD_AUTH ?? '').trim().toLowerCase();
  if (!raw) return { ok: true, auth: surface === 'mcp' ? 'token' : 'jwt' };
  if (raw !== 'jwt' && raw !== 'token') {
    return { ok: false, error: `Unknown auth "${raw}". Expected jwt or token.` };
  }
  return { ok: true, auth: raw };
}

/** MCP tool name for each op in the mix. */
export const MCP_TOOL_FOR_OP = Object.freeze({
  list: 'memory.list',
  search: 'memory.search',
  scopes: 'memory.scopes',
  write: 'memory.write',
});

/**
 * The `params.arguments` payload for one op, per the tool catalog's schema.
 *
 * Getting an argument NAME wrong here does not fail loudly: MCP answers a bad
 * tool call with HTTP **200** carrying a JSON-RPC `error`, so a driver that
 * checks only the status code reports a clean run having measured nothing but
 * validation errors. `classifyMcpResponse` is the other half of that guard.
 *
 * Required args per the catalog: list→scope, search→q, write→scope/key/value,
 * scopes→none. `search` takes `scopes` (PLURAL, an array); `list` takes `scope`
 * (singular). They are not interchangeable.
 */
export function mcpArgumentsFor(op, { scope, key, value, q } = {}) {
  switch (op) {
    case 'list': return { scope, limit: 50 };
    case 'search': return { q: q ?? 'lesson', scopes: [scope], limit: 20 };
    case 'scopes': return {};
    case 'write': return { scope, key, value };
    default: throw new Error(`no MCP mapping for op "${op}"`);
  }
}

/**
 * Classify one MCP response. THE trap of this transport.
 *
 * JSON-RPC carries application errors INSIDE a 200, so status alone cannot tell
 * success from failure — a run that 200s on every request may have failed every
 * request. Meanwhile the rate limiter answers at the TRANSPORT layer with a real
 * 429 before JSON-RPC is reached, so both signals are live at once and must be
 * read in the right order.
 *
 * `isError` on a tool RESULT is distinct again: the call succeeded and the tool
 * reported a domain failure (a cap rejection, a permission denial). Counted as
 * an error, because it is one — but it is not a transport fault.
 */
export function classifyMcpResponse({ status, body }) {
  if (status === 429) return 'rate_limited';
  if (status === 0) return 'error';               // transport failure
  if (status < 200 || status >= 300) return 'error';
  if (!body || typeof body !== 'object') return 'error';
  if (body.error) return 'error';                 // JSON-RPC error in a 200
  if (body.result?.isError) return 'error';       // tool-level failure
  return 'ok';
}

// ── rate-limit headroom ──────────────────────────────────────────────────────

/**
 * How many of a surface's requests the per-user rate limiter actually counts.
 *
 * MCP checks the limit on EVERY method (`mcp/index.ts`, right after auth
 * resolves). REST checks it in only two handlers — `create.ts` and `purge.ts` —
 * so on REST only the WRITE share of the mix is limited and reads are ungated.
 * That asymmetry is why one users-per-rps rule cannot serve both.
 */
export function limitedShareOfMix(surface, mix = DEFAULT_MIX) {
  if (surface === 'mcp') return 1;
  const total = mix.reduce((n, m) => n + m.weight, 0);
  if (total <= 0) return 0;
  return mix.filter((m) => m.op === 'write').reduce((n, m) => n + m.weight, 0) / total;
}

/**
 * Does this configuration have the headroom to drive the requested rate without
 * the rate limiter deciding the result?
 *
 * WHY THIS IS A HARD GUARD AND NOT A WARNING
 * The harness's own defaults (20 rps across 5 users) are 4 rps/user, and the
 * default ceiling is 120 req/min = 2 rps/user. On MCP that is 2x over: half the
 * run would 429 and the percentiles would describe the guardrail, not the
 * service. A load test that silently measures its own throttling is worse than
 * no load test, because the number looks usable.
 *
 * Returns the users actually required so the caller can print a fix rather than
 * a complaint. `requestsPerMinute` is a parameter because the real ceiling is
 * `lorekit_get_limit(user_id, 'requests_per_minute')` and a `user_limits` row
 * can raise it — 120 is only the default.
 */
export function checkRateHeadroom({ surface, rps, users, mix = DEFAULT_MIX, requestsPerMinute = 120 }) {
  const share = limitedShareOfMix(surface, mix);
  const perUserCeiling = requestsPerMinute / 60;
  if (share === 0 || perUserCeiling <= 0) return { ok: true, requiredUsers: users, limitedRps: 0, perUserCeiling };
  const limitedRps = rps * share;
  const requiredUsers = Math.ceil(limitedRps / perUserCeiling);
  if (users >= requiredUsers) return { ok: true, requiredUsers, limitedRps, perUserCeiling };
  return {
    ok: false,
    requiredUsers,
    limitedRps,
    perUserCeiling,
    error:
      `${surface} rate-limits ${share === 1 ? 'every method' : `the write share (${(share * 100).toFixed(0)}%)`}, ` +
      `so ${rps} rps needs at least ${requiredUsers} users at ${requestsPerMinute} req/min/user ` +
      `(${limitedRps.toFixed(1)} limited rps ÷ ${perUserCeiling.toFixed(2)} per user) — got ${users}. ` +
      `Raise --users to ${requiredUsers}, or lower --rps to ${Math.floor(users * perUserCeiling / share)}.`,
  };
}

// ── stress mode (ramp) ───────────────────────────────────────────────────────

/**
 * The rungs of a stress ladder: multiply until the ceiling, inclusive.
 *
 * Geometric rather than linear because the interesting region is unknown by
 * orders of magnitude — a linear +10 rps walk spends its whole budget below the
 * knee. The ceiling is always included even when the factor overshoots it, so
 * `--max-rps` means what it says.
 */
export function buildRampRungs({ startRps, maxRps, factor = 2 }) {
  if (!(startRps > 0) || !(maxRps >= startRps) || !(factor > 1)) return [];
  const rungs = [];
  for (let r = startRps; r < maxRps; r *= factor) rungs.push(Math.round(r));
  rungs.push(Math.round(maxRps));
  return [...new Set(rungs)];
}

/**
 * Should the ladder stop after this rung?
 *
 * A rung is the LAST GOOD one when the next would tell us nothing new. Three
 * independent stop conditions, because saturation shows up differently:
 *
 *   - errors: the service is failing, not merely slow.
 *   - p99: latency has left the range anyone would ship.
 *   - 429s: we hit the guardrail, so further rungs measure the limiter. This is
 *     NOT a failure of the service — it is the reason `checkRateHeadroom`
 *     exists — but it does end the useful part of the ladder.
 *
 * `achievedRps` below the requested rate ends it too: the CLIENT saturated, so
 * a higher requested rate cannot actually be offered and every later rung would
 * silently measure the same load.
 */
export function rampVerdict(rung, { maxP99Ms = 5000, maxErrorRate = 0.01, maxRateLimitedRate = 0.01, minAchievedRatio = 0.9 } = {}) {
  const total = rung.count ?? 0;
  if (total === 0) return { stop: true, reason: 'no requests completed' };
  const errorRate = (rung.errors ?? 0) / total;
  const limitedRate = (rung.rateLimited ?? 0) / total;
  if (errorRate > maxErrorRate) return { stop: true, reason: `error rate ${(errorRate * 100).toFixed(1)}% > ${(maxErrorRate * 100).toFixed(1)}%` };
  if ((rung.p99 ?? 0) > maxP99Ms) return { stop: true, reason: `p99 ${rung.p99}ms > ${maxP99Ms}ms` };
  if (limitedRate > maxRateLimitedRate) return { stop: true, reason: `429 rate ${(limitedRate * 100).toFixed(1)}% > ${(maxRateLimitedRate * 100).toFixed(1)}% — the ladder is now measuring the rate limiter` };
  if (rung.requestedRps > 0 && (rung.achievedRps ?? 0) / rung.requestedRps < minAchievedRatio) {
    return { stop: true, reason: `achieved ${rung.achievedRps?.toFixed(1)} of ${rung.requestedRps} rps — the CLIENT saturated, not the service` };
  }
  return { stop: false };
}
