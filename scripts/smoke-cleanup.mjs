#!/usr/bin/env node
/**
 * Smoke-artefact sweeper — removes what a PREVIOUS smoke run left behind.
 * ------------------------------------------------------------------------
 * The live smoke suites clean up after themselves in `afterAll` (see
 * `packages/mcp-server/src/smoke-cleanup.ts`). That covers a suite that FAILED;
 * it cannot cover a run that never reached the hook at all — a crashed vitest
 * worker, an OOM-killed runner, a cancelled workflow, a job timeout. Those runs
 * leave rows in a real tenant forever.
 *
 * This script is the second half of the contract: it sweeps by NAME PATTERN, so
 * it does not need to know anything about the run that produced the leftovers.
 * It is meant to run as an `if: always()` step after every smoke job, on both
 * the staging/preview and the production project.
 *
 *   node scripts/smoke-cleanup.mjs
 *   node scripts/smoke-cleanup.mjs --dry-run
 *   node scripts/smoke-cleanup.mjs --min-age-minutes 120 --strict
 *
 * Credentials (all optional — each section skips, loudly, without its own):
 *   LOREKIT_REST_BASE_URL   Base URL, e.g. https://<ref>.supabase.co/functions/v1
 *   LOREKIT_SMOKE_TOKEN     Service-role key, lk_* API token, or user JWT.
 *                           Sweeps MEMORIES (live + archived).
 *   LOREKIT_SMOKE_JWT       Supabase user JWT. Sweeps ORGS the smoke suites
 *                           created, hard-purging them via `lorekit_org_purge`
 *                           rather than leaving another soft-deleted row.
 *   LOREKIT_SWEEP_SERVICE_ROLE_KEY
 *                           Supabase service-role key. Only this can reach orgs
 *                           a previous run already SOFT-deleted: `deleted_at` is
 *                           not null, so `lorekit_member_org_ids` hides them from
 *                           every RLS read and no API surface can list them.
 *
 * SAFETY. Four independent guards stand between this script and real data:
 *   1. Names must match the anchored smoke pattern below — a closed set of
 *      labels the suites mint through, not a substring search for "smoke".
 *   2. Artefacts younger than `--min-age-minutes` (default 30) are LEFT ALONE,
 *      so a concurrently-running smoke suite is never swept out from under.
 *      Age comes from the SERVER's timestamp, not the client-minted name, so a
 *      skewed runner clock cannot make a live run's rows look sweepable.
 *   3. Anything cross-tenant is REFUSED unless `--allow-service-role` is
 *      passed — a service-role `LOREKIT_SMOKE_TOKEN`, and the soft-deleted-org
 *      phase, which is service-role by construction. Including under
 *      `--dry-run`, because enumerating every tenant's `scope::key` into a CI
 *      log is a disclosure in its own right. Service-role bypasses RLS and every
 *      handler's tenant filter, so a sweep on it spans every tenant in the
 *      project — fine on a throwaway stack, never implicitly on a shared one.
 *   4. `--dry-run` prints the plan and deletes nothing.
 *
 * EXIT CODE. 0 by default even when individual deletes fail — including on a
 * network error, which is why each phase is wrapped rather than left to reject
 * at top level. This is the LAST step of `smoke-production`, and that job
 * failing triggers `rollback-production`: a DNS blip in a cleanup step must
 * never redeploy the previous commit. Pass `--strict` to fail on any error —
 * useful when running it by hand.
 */

// ── the artefact pattern ──────────────────────────────────────────────────────
// MIRROR of SMOKE_ARTEFACT_PATTERN in packages/mcp-server/src/smoke-cleanup.ts.
// This script is intentionally zero-dependency and standalone (it must run from
// a bare checkout with no build step), so the pattern is copied rather than
// imported. `smoke-cleanup.spec.ts` fails if the two ever diverge.
const SMOKE_ARTEFACT_PATTERN = /^(?:memories-|byod-)?smoke-(\d{10,})(?:-[a-z0-9-]*)?$/;

/** The mint time encoded in a smoke artefact name, or null when unrecognised. */
function smokeArtefactTimestamp(name) {
  const m = SMOKE_ARTEFACT_PATTERN.exec(String(name ?? ''));
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Age of an artefact derived from its NAME alone — the fallback used when a row
 * carries no server timestamp. `-Infinity` for an unrecognised name, so it can
 * never clear an age threshold.
 *
 * Mirrors `smokeArtefactAgeMs` in packages/mcp-server/src/smoke-cleanup.ts.
 * A future-dated name yields a negative age and so is never swept: a runner
 * whose clock ran fast must not have its live rows treated as orphans.
 */
function nameAgeMs(name, now) {
  const mintedAt = smokeArtefactTimestamp(name);
  return mintedAt === null ? -Infinity : now - mintedAt;
}

// ── args + env ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, strict: false, allowServiceRole: false, minAgeMinutes: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--allow-service-role') args.allowServiceRole = true;
    else if (a === '--min-age-minutes') args.minAgeMinutes = Number(argv[++i]);
    else if (a.startsWith('--min-age-minutes=')) args.minAgeMinutes = Number(a.split('=')[1]);
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`error: unknown argument "${a}" (see --help)`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(args.minAgeMinutes) || args.minAgeMinutes < 0) {
    console.error('error: --min-age-minutes must be a non-negative number');
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    'usage: node scripts/smoke-cleanup.mjs [--dry-run] [--strict] [--allow-service-role]\n' +
      '                                     [--min-age-minutes N]\n' +
      '\n' +
      'Sweeps memories and orgs left behind by earlier smoke runs. Reads\n' +
      'LOREKIT_REST_BASE_URL, LOREKIT_SMOKE_TOKEN, LOREKIT_SMOKE_JWT and\n' +
      'LOREKIT_SWEEP_SERVICE_ROLE_KEY from the environment.\n' +
      '\n' +
      '  --dry-run             print the plan, delete nothing\n' +
      '  --strict              exit non-zero if anything could not be swept\n' +
      '  --allow-service-role  permit the cross-tenant phases: a service-role\n' +
      '                        LOREKIT_SMOKE_TOKEN, and the soft-deleted-org sweep\n' +
      '                        (service-role bypasses RLS, so both span EVERY tenant)\n' +
      '  --min-age-minutes N   leave artefacts younger than N alone (default 30)',
  );
  process.exit(0);
}

const BASE = (process.env.LOREKIT_REST_BASE_URL ?? 'http://127.0.0.1:54321/functions/v1').replace(/\/$/, '');
// PostgREST is the same gateway on a different mount point. If the base URL is
// not the documented `…/functions/v1`, the swap is a silent no-op and every
// PostgREST call 404s — so the mismatch is detected once, here, and the phases
// that need it skip with a reason instead of logging mystery failures.
const PGREST = BASE.replace(/\/functions\/v1$/, '/rest/v1');
const HAVE_PGREST = PGREST !== BASE;
const TOKEN = process.env.LOREKIT_SMOKE_TOKEN;
const JWT = process.env.LOREKIT_SMOKE_JWT;
const SERVICE_ROLE = process.env.LOREKIT_SWEEP_SERVICE_ROLE_KEY;

const NOW = Date.now();
const MIN_AGE_MS = args.minAgeMinutes * 60_000;
const PAGE_SIZE = 100;
// A safety stop, not a budget: the walk is READ-ONLY and pages until the API
// says there is no more, because a cap that is reached silently leaves the
// OLDEST orphans permanently unreachable (paging is newest-first and no cursor
// survives the run, so every future run would re-walk the same newest page set).
// Hitting this is therefore reported as a failure, not a shrug.
const PAGE_SAFETY_STOP = 1000;

/**
 * Scopes that are always swept, even when `/memories/scopes` does not list them.
 *
 * `lorekit_memory_scopes` counts only ACTIVE rows, so a scope whose remaining
 * smoke rows are all archived disappears from discovery — and archived residue
 * is precisely what the old soft-delete cleanup left behind. `global` is the one
 * scope every REST/MCP-reachable suite writes to, so it is swept unconditionally.
 *
 * The BYOD suite's four scopes are deliberately NOT listed. It targets a
 * different Supabase project entirely (`LOREKIT_BYOD_URL`) over MCP, not the
 * REST base this script sweeps — so naming them here would duplicate that
 * suite's `SCOPES` map with no parity guard while never matching a row. That
 * suite hard-deletes all four keys deterministically in its own `afterAll`.
 */
const ALWAYS_SWEEP_SCOPES = ['global'];

const plan = [];
const failures = [];

const record = (what, name, detail) => plan.push({ what, name, detail });
const fail = (what, name, reason) => failures.push({ what, name, reason });

/**
 * Is this credential a Supabase SERVICE-ROLE key?
 *
 * It matters because service-role bypasses RLS and every REST handler skips its
 * tenant filter for the `service` auth tier (`memories/handlers/list.ts`,
 * `remove.ts`, `lorekit_memory_scopes`). A sweep on that credential therefore
 * enumerates and deletes across EVERY tenant in the project, not just the smoke
 * user's — a blast radius nobody asks for by accident. Best-effort JWT payload
 * decode; an unparseable token is treated as not-service-role, which only ever
 * loses the warning, never adds one falsely.
 */
function isServiceRoleKey(token) {
  const payload = String(token ?? '').split('.')[1];
  if (!payload) return false;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return json?.role === 'service_role';
  } catch {
    return false;
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function req(url, { method = 'GET', token, apikey, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(apikey ? { apikey } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json',
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const memApi = (method, path) => req(`${BASE}/memories${path}`, { method, token: TOKEN });

// ── 1. memories ───────────────────────────────────────────────────────────────

/**
 * Scopes to sweep: everything `/memories/scopes` reports, UNIONED with the
 * scopes the suites are known to write to. The union matters — that endpoint
 * counts only active rows, so a scope left holding nothing but archived smoke
 * residue is invisible to discovery and would never be swept.
 */
async function discoverScopes() {
  const { status, data } = await memApi('GET', '/scopes');
  if (status !== 200 || !Array.isArray(data?.scopes)) {
    // Recorded as a failure, not warned: a narrowed sweep is a sweep that will
    // miss orphans in every scope it never looked at, and `--strict` exiting 0
    // on that would report a clean run that did not happen. Same treatment as
    // the page-safety stop below. The known scopes are still swept.
    fail('scope-discovery', BASE, `GET /memories/scopes → HTTP ${status}`);
    return [...ALWAYS_SWEEP_SCOPES];
  }
  const discovered = data.scopes.map((s) => s.scope).filter((s) => typeof s === 'string');
  return [...new Set([...ALWAYS_SWEEP_SCOPES, ...discovered])];
}

/**
 * How old is this row, in ms — measured from the SERVER's timestamps, falling
 * back to the epoch encoded in the name.
 *
 * The name's timestamp is minted by `Date.now()` on whatever machine ran the
 * suite, so a runner with a slow clock mints names that already look stale and a
 * concurrent sweeper would delete its live rows mid-run. The server's
 * `updated_at` comes from one clock — the database's — which is also the
 * sweeper's frame of reference for "is another run still working on this".
 * The name stays the authority on RECOGNITION; the server is the authority on AGE.
 */
function rowAgeMs(entry) {
  const stamp = Date.parse(entry.updated_at ?? entry.created_at ?? '');
  if (Number.isFinite(stamp)) return NOW - stamp;
  return nameAgeMs(entry.key, NOW);
}

/** Page through one scope/archived combination, returning the stale smoke keys. */
async function staleKeysIn(scope, archived) {
  const keys = [];
  let cursor = null;
  for (let page = 0; page < PAGE_SAFETY_STOP; page++) {
    const qs = `?scope=${encodeURIComponent(scope)}&archived=${archived}&limit=${PAGE_SIZE}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const { status, data } = await memApi('GET', `/${qs}`);
    if (status !== 200) {
      fail('memory-list', `${scope} (archived=${archived})`, `HTTP ${status}`);
      return keys;
    }
    for (const e of data.entries ?? []) {
      // Both guards, in order: the NAME decides whether this is ours to touch
      // at all, the AGE decides whether it belongs to a run still in flight.
      if (smokeArtefactTimestamp(e.key) === null) continue;
      if (rowAgeMs(e) < MIN_AGE_MS) continue;
      keys.push(e.key);
    }
    if (!data.hasMore || !data.nextCursor) return keys;
    cursor = data.nextCursor;
  }
  // Reported, not warned: paging is newest-first and no cursor survives the run,
  // so stopping early means the oldest orphans are unreachable on EVERY future
  // run too. That is a broken sweep, and it should look like one.
  fail('memory-list', `${scope} (archived=${archived})`, `exceeded ${PAGE_SAFETY_STOP} pages`);
  return keys;
}

async function sweepMemories() {
  if (!TOKEN) {
    console.log('memories — SKIPPED (LOREKIT_SMOKE_TOKEN is not set).');
    return;
  }
  if (isServiceRoleKey(TOKEN) && !args.allowServiceRole) {
    // Service-role bypasses RLS and every handler's tenant filter, so this sweep
    // would span EVERY tenant in the project. Legitimate against a throwaway
    // local stack (ci.yml), never something to do implicitly against a shared
    // one — so it takes an explicit flag.
    //
    // `--dry-run` does NOT exempt it. A dry run still ENUMERATES, and printing
    // `scope::key` for every tenant into a CI log is its own disclosure: scope
    // strings embed repo and project names, which is exactly why
    // `lorekit_memory_scopes` carries no `anon` grant. Read-only is not the
    // same as harmless.
    console.warn(
      'memories — REFUSED: LOREKIT_SMOKE_TOKEN is a service-role key.\n' +
        '  Service-role bypasses RLS, so this would read (and, without --dry-run, delete)\n' +
        '  smoke artefacts across EVERY tenant in the project, not just the smoke user\'s.\n' +
        '  Scope strings embed repo/project names, so even listing them is a disclosure.\n' +
        '  Use an lk_rw_* token, or pass --allow-service-role if that blast radius is\n' +
        '  intended (a throwaway stack).',
    );
    fail('memories', BASE, 'refused: service-role credential without --allow-service-role');
    return;
  }
  const scopes = await discoverScopes();
  console.log(`memories — scanning ${scopes.length} scope(s) at ${BASE}`);

  for (const scope of scopes) {
    // Live first: a hard delete removes the row outright, so a key swept here
    // cannot reappear in the archived pass.
    for (const archived of [false, true]) {
      const keys = await staleKeysIn(scope, archived);
      for (const key of keys) {
        if (args.dryRun) { record('memory', `${scope}::${key}`, archived ? 'archived' : 'live'); continue; }
        // `force=true` — a soft archive would leave the row in place, which is
        // exactly the leak this script exists to close.
        const { status } = await memApi(
          'DELETE',
          `/?scope=${encodeURIComponent(scope)}&key=${encodeURIComponent(key)}&force=true`,
        );
        // 404 = already gone (a concurrent sweep, or the run's own afterAll won
        // the race). That is the desired end state, not an error.
        if (status === 204 || status === 404) record('memory', `${scope}::${key}`, archived ? 'archived' : 'live');
        else fail('memory', `${scope}::${key}`, `HTTP ${status}`);
      }
    }
  }
}

// ── 2. orgs the smoke suites created (still live) ─────────────────────────────

async function sweepOrgs() {
  if (!JWT) {
    console.log('orgs — SKIPPED (LOREKIT_SMOKE_JWT is not set; the orgs suite only runs with one).');
    return;
  }
  if (!HAVE_PGREST) {
    console.log(`orgs — SKIPPED (cannot derive a PostgREST base from ${BASE}; expected it to end in /functions/v1).`);
    return;
  }
  const { status, data } = await req(`${BASE}/orgs/`, { token: JWT });
  if (status !== 200) {
    fail('org-list', BASE, `HTTP ${status}`);
    return;
  }
  const entries = data.entries ?? [];
  // Same split of responsibilities as the memories path: the NAME decides
  // whether the row is ours to touch, the SERVER's timestamp decides whether it
  // is old enough. ANDing in `isStaleSmokeArtefact` as well would re-introduce
  // the client clock as a veto — a slug minted by a runner whose clock ran fast
  // would then never be purged, however old the row actually is.
  const stale = entries.filter(
    (o) => o?.slug && o?.id && smokeArtefactTimestamp(o.slug) !== null && orgAgeMs(o) >= MIN_AGE_MS,
  );
  console.log(`orgs — ${stale.length} stale smoke org(s) of ${entries.length} visible`);

  for (const org of stale) {
    if (args.dryRun) { record('org', org.slug, org.id); continue; }
    // PURGE, not DELETE. `DELETE /orgs/:slug` maps to `lorekit_org_delete`, a
    // SOFT delete (migration 00025) — using it here would swap one leaked row
    // for another, permanently invisible one. `lorekit_org_purge` is the real
    // cascading delete, owner-gated on the same capability, and this JWT owns
    // every org it created.
    const { status: s, data: d } = await req(`${PGREST}/rpc/lorekit_org_purge`, {
      method: 'POST', token: JWT, apikey: JWT, body: { p_org_id: org.id },
    });
    if (s === 200 || s === 204) record('org', org.slug, org.id);
    else fail('org', org.slug, `purge → HTTP ${s}: ${JSON.stringify(d)}`);
  }
}

/** Server-side age of an org row, falling back to the epoch in its slug. */
function orgAgeMs(org) {
  const stamp = Date.parse(org.created_at ?? '');
  if (Number.isFinite(stamp)) return NOW - stamp;
  return nameAgeMs(org.slug, NOW);
}

// ── 3. orgs a previous run already soft-deleted ───────────────────────────────

async function sweepSoftDeletedOrgs() {
  if (!SERVICE_ROLE) {
    console.log(
      'soft-deleted orgs — SKIPPED (LOREKIT_SWEEP_SERVICE_ROLE_KEY is not set).\n' +
        '  A soft-deleted org is hidden from every RLS read, so only a service-role\n' +
        '  credential can find it. Set the key to sweep historical residue.',
    );
    return;
  }
  if (!args.allowServiceRole) {
    // This phase is service-role BY CONSTRUCTION — there is no other credential
    // that can see a soft-deleted org — which is exactly why it needs the same
    // opt-in the memories phase does, not an exemption from it. Setting the env
    // var says "I have the key"; the flag says "I accept that this reads and
    // deletes across every tenant in the project". Those are different claims,
    // and only the second one authorises a cross-tenant delete.
    console.warn(
      'soft-deleted orgs — REFUSED: this phase is inherently cross-tenant.\n' +
        '  It reads and deletes org rows across EVERY tenant in the project (service-role\n' +
        '  bypasses RLS). Pass --allow-service-role to confirm that is intended.',
    );
    fail('soft-deleted-orgs', PGREST, 'refused: cross-tenant phase without --allow-service-role');
    return;
  }
  if (!HAVE_PGREST) {
    console.log(`soft-deleted orgs — SKIPPED (cannot derive a PostgREST base from ${BASE}).`);
    return;
  }
  // Narrow in Postgres first (`like` + non-null deleted_at), then apply the
  // anchored pattern and the age guard in JS — the SQL wildcard is a prefilter,
  // never the authority on what counts as a smoke artefact. Ordered + paged so a
  // project with more residue than one page still gets fully swept; an
  // unordered `limit` would silently return an arbitrary subset forever.
  let offset = 0;
  let scanned = 0;
  let stale = [];
  for (let page = 0; page < PAGE_SAFETY_STOP; page++) {
    const { status, data } = await req(
      `${PGREST}/orgs?select=id,slug,deleted_at,created_at&deleted_at=not.is.null&slug=like.*smoke-*` +
        `&order=id.asc&limit=${PAGE_SIZE}&offset=${offset}`,
      { token: SERVICE_ROLE, apikey: SERVICE_ROLE },
    );
    if (status !== 200 || !Array.isArray(data)) {
      fail('soft-deleted-org-list', PGREST, `HTTP ${status}`);
      break;
    }
    scanned += data.length;
    // Same predicate as the live sweep above — id and slug both required, so a
    // malformed row can never become `id=eq.undefined` in a DELETE.
    // Recognition by name, age by the server clock — see sweepOrgs.
    stale = stale.concat(
      data.filter((o) => o?.slug && o?.id && smokeArtefactTimestamp(o.slug) !== null && orgAgeMs(o) >= MIN_AGE_MS),
    );
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    // Same treatment as staleKeysIn's stop: exhausting the safety limit means
    // the oldest residue was never looked at, and a silent exit would report
    // that as a clean scan.
    if (page === PAGE_SAFETY_STOP - 1) {
      fail('soft-deleted-org-list', PGREST, `exceeded ${PAGE_SAFETY_STOP} pages`);
    }
  }
  console.log(`soft-deleted orgs — ${stale.length} stale smoke org(s) of ${scanned} scanned`);

  for (const org of stale) {
    if (args.dryRun) { record('soft-deleted-org', org.slug, org.id); continue; }
    // A direct delete rather than `lorekit_org_purge`: that RPC authorises via
    // `auth.uid()`, which a service-role connection does not have, so it fails
    // closed. Service-role bypasses RLS and the FKs cascade to members/invites/
    // limits, which is exactly the purge semantics.
    const { status: s } = await req(`${PGREST}/orgs?id=eq.${encodeURIComponent(org.id)}`, {
      method: 'DELETE', token: SERVICE_ROLE, apikey: SERVICE_ROLE,
    });
    if (s === 200 || s === 204) record('soft-deleted-org', org.slug, org.id);
    else fail('soft-deleted-org', org.slug, `HTTP ${s}`);
  }
}

// ── run ───────────────────────────────────────────────────────────────────────

console.log(
  `LoreKit smoke sweep → ${BASE}\n` +
    `  min age: ${args.minAgeMinutes}m (younger artefacts belong to a run that may still be in flight)` +
    (args.dryRun ? '\n  DRY RUN — nothing will be deleted' : ''),
);

/**
 * Each phase is independently guarded, and the guard is load-bearing.
 *
 * An unhandled rejection at top level exits non-zero no matter what `--strict`
 * says, and this script is the LAST step of `smoke-production`, whose failure
 * triggers `rollback-production`. A DNS blip mid-sweep would therefore redeploy
 * the previous commit's edge functions. Every failure has to land in the
 * `failures` list and flow through the single exit below — that is the only
 * exit path.
 */
async function phase(name, fn) {
  try {
    await fn();
  } catch (err) {
    fail(name, BASE, err instanceof Error ? err.message : String(err));
  }
}

await phase('memories', sweepMemories);
await phase('orgs', sweepOrgs);
await phase('soft-deleted-orgs', sweepSoftDeletedOrgs);

console.log(
  `\n${args.dryRun ? 'Would remove' : 'Removed'} ${plan.length} artefact(s):` +
    (plan.length ? '\n' + plan.map((p) => `  - ${p.what} ${p.name} (${p.detail})`).join('\n') : ' none.'),
);

if (failures.length) {
  console.warn(
    `\n⚠ ${failures.length} item(s) could not be swept:\n` +
      failures.map((f) => `  - ${f.what} ${f.name}: ${f.reason}`).join('\n') +
      (args.strict ? '' : '\n  (non-fatal: this is a cleanup step, not a gate — rerun or pass --strict)'),
  );
}

process.exit(args.strict && failures.length ? 1 : 0);
