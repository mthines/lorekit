/**
 * LoreKit memories REST API — integration smoke test
 * ---------------------------------------------------
 * Exercises the `memories` Edge Function end-to-end against a live LoreKit
 * instance. Runs in CI (and locally) when the required environment variables
 * are present; skips gracefully otherwise.
 *
 * Required env vars:
 *   LOREKIT_SMOKE_TOKEN      Bearer token (service-role key, lk_* API token, or user JWT)
 *   LOREKIT_REST_BASE_URL    Base URL, e.g. https://<ref>.supabase.co/functions/v1
 *                            Defaults to http://localhost:54321/functions/v1
 *
 * Run standalone:
 *   LOREKIT_SMOKE_TOKEN=<token> LOREKIT_REST_BASE_URL=<url> \
 *     pnpm nx test mcp-server -- --reporter=verbose --testPathPattern=memories-api.integration
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  createSmokeNamespace,
  describeSweepFailures,
  runBestEffortCleanup,
  sweepSmokeArtefacts,
  type SmokeNamespace,
} from './smoke-cleanup.js';
import { testRunHeaders } from './smoke-telemetry.js';

const BASE = (process.env['LOREKIT_REST_BASE_URL'] ?? 'http://localhost:54321/functions/v1').replace(/\/$/, '');
const TOKEN = process.env['LOREKIT_SMOKE_TOKEN'];
const SKIP = !TOKEN;

/**
 * PostgREST base, derived from the Edge-Function base by swapping the mount
 * point (`…/functions/v1` → `…/rest/v1`). Both are served by the same Supabase
 * gateway, locally and hosted, so this needs no extra environment variable.
 */
const PGREST = BASE.replace(/\/functions\/v1$/, '/rest/v1');

/**
 * Every memory key this file writes is minted through `NS`, which REGISTERS it
 * at mint time. Cleanup then derives its work set from what was actually minted
 * instead of from ids captured mid-test — the old approach lost a row whenever a
 * test threw before its `createdId… =` line, and silently missed keys (`KEY_F`,
 * `…-audit`) that were only ever deleted inside the test that created them.
 *
 * Adding a key here is therefore self-cleaning by construction: `NS.name(...)`
 * is the only way to spell one, and `afterAll` sweeps the whole namespace.
 */
const NS = createSmokeNamespace('memories');
const KEY_PREFIX = NS.prefix;
const SCOPE = 'global';
const KEY_A = NS.name('a');
const KEY_B = NS.name('b');
// Restore / hard-delete keys. Kept separate from A/B so the archive-and-restore
// round trip can't perturb the CRUD assertions above it.
const KEY_R = NS.name('restore');
const KEY_F = NS.name('force');

type JsonObj = Record<string, unknown>;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${BASE}/memories${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...testRunHeaders(),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

/**
 * Read a table directly through PostgREST. `apikey` + `Authorization` are both
 * required by the gateway; with the service-role key this bypasses RLS, which
 * is what makes `audit_log` / `usage_events` readable at all (their SELECT
 * policies are `user_id = auth.uid()`, and a service credential has no uid).
 */
async function pgRest(pathAndQuery: string): Promise<{ status: number; rows: JsonObj[] }> {
  const res = await fetch(`${PGREST}${pathAndQuery}`, {
    headers: {
      apikey: TOKEN ?? '',
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let rows: JsonObj[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) rows = parsed as JsonObj[];
  } catch { /* leave rows empty; the status is the signal */ }
  return { status: res.status, rows };
}

/** Create a memory and return its id — used by the restore / force-delete cases. */
async function create(key: string, value = 'v'): Promise<string> {
  const { status, data } = await api('POST', '/', { scope: SCOPE, key, value });
  expect(status, `create ${key}: expected 201; got ${status}: ${JSON.stringify(data)}`).toBe(201);
  return (data as JsonObj).id as string;
}

/** The keys currently listed under `?archived=<flag>` for this run's scope. */
async function listKeys(archived: boolean): Promise<unknown[]> {
  const { status, data } = await api('GET', `/?scope=${SCOPE}&archived=${archived}&limit=100`);
  expect(status, `list archived=${archived}: got ${status}: ${JSON.stringify(data)}`).toBe(200);
  return ((data as JsonObj).entries as JsonObj[]).map((e) => e.key);
}

// A generous per-test timeout: these suites run against a LIVE endpoint (the
// deploy pipeline points them at the hosted preview project), and the archive /
// restore cases chain 4–5 sequential HTTP round-trips. At hosted latency
// (~0.5–1.3s each) that overruns vitest's 5s default, even though every call
// succeeds; locally each round-trip is sub-ms so this never bites. 30s is the
// ceiling per test, not an expected duration.
const REMOTE_TEST_TIMEOUT = 30_000;
// Best-effort teardown self-bounds below the hook ceiling above, so a slow
// sweep against a laggy live endpoint warns and yields instead of timing out
// the hook and failing a green run. Kept under REMOTE_TEST_TIMEOUT with margin.
const CLEANUP_SOFT_TIMEOUT = 20_000;

/**
 * Hard-delete one key by its NATURAL key.
 *
 * Addressed by scope+key, not by id, on purpose: an id is only known if the
 * create assertion that captured it ran to completion, which is exactly the
 * case a failing test breaks. The key is known from the moment it is minted.
 *
 * `force=true` removes the row outright — a soft archive would leave it in the
 * table, which is the leak this cleanup exists to close. A 404 means the row is
 * already gone (the test deleted it, or a sweep beat us to it); that is the
 * desired end state, so it is a success, not an error.
 */
async function hardDeleteKey(key: string): Promise<void> {
  const { status, data } = await api(
    'DELETE',
    `/?scope=${SCOPE}&key=${encodeURIComponent(key)}&force=true`,
  );
  if (status !== 204 && status !== 404) {
    throw new Error(`DELETE ${key} → HTTP ${status}: ${JSON.stringify(data)}`);
  }
}

/** Sweep the keys one namespace minted, reporting (never throwing) what it could not remove. */
async function sweepMintedKeys(ns: SmokeNamespace, context: string): Promise<void> {
  const report = await sweepSmokeArtefacts(ns.minted(), hardDeleteKey);
  const warning = describeSweepFailures(report, context);
  if (warning) console.warn(warning);
}

describe.skipIf(SKIP)('LoreKit memories API — smoke tests (integration)', { timeout: REMOTE_TEST_TIMEOUT }, () => {
  let createdIdA = '';
  let createdIdR = '';

  afterAll(async () => {
    // Sweeps the whole namespace, not a list of captured ids. The old hook
    // deleted four ids and therefore missed `…-force`, `…-org-id-form` and every
    // key whose test threw before the assignment; those rows accumulated in the
    // live project on every deploy.
    //
    // The sweep runs with bounded concurrency (see sweepSmokeArtefacts), and
    // runBestEffortCleanup soft-bounds it below the hook ceiling — so a laggy
    // live endpoint can never make cleanup time out the hook and fail a run
    // whose assertions all passed. Anything left is caught by the always-on
    // scripts/smoke-cleanup.mjs sweep.
    await runBestEffortCleanup(() => sweepMintedKeys(NS, 'memories REST smoke'), {
      softTimeoutMs: CLEANUP_SOFT_TIMEOUT,
      context: 'memories REST smoke',
    });
  }, REMOTE_TEST_TIMEOUT);

  // 1. list — baseline ────────────────────────────────────────────────────────
  it('GET /memories — returns a paged response', async () => {
    const { status, data } = await api('GET', '/');
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const d = data as JsonObj;
    expect(Array.isArray(d.entries), 'entries should be an array').toBe(true);
    expect(typeof d.hasMore).toBe('boolean');
  });

  // 2. create ─────────────────────────────────────────────────────────────────
  it('POST /memories — creates entry A', async () => {
    const { status, data } = await api('POST', '/', {
      scope: SCOPE, key: KEY_A, value: 'rest-smoke-alpha',
    });
    expect(status, `expected 201; got ${status}: ${JSON.stringify(data)}`).toBe(201);
    const d = data as JsonObj;
    expect(typeof d.id).toBe('string');
    expect(d.scope).toBe(SCOPE);
    expect(d.key).toBe(KEY_A);
    createdIdA = d.id as string;
  });

  // 3. create second ──────────────────────────────────────────────────────────
  it('POST /memories — creates entry B with tags', async () => {
    const { status, data } = await api('POST', '/', {
      scope: SCOPE, key: KEY_B,
      value: `rest-smoke-beta unique-phrase-${KEY_PREFIX}`,
      tags: ['smoke', 'rest'],
    });
    expect(status, `expected 201; got ${status}: ${JSON.stringify(data)}`).toBe(201);
    const d = data as JsonObj;
    expect(Array.isArray(d.tags)).toBe(true);
  });

  // 4. get by id ──────────────────────────────────────────────────────────────
  it('GET /memories/:id — returns entry A', async () => {
    expect(createdIdA, 'createdIdA must be set').toBeTruthy();
    const { status, data } = await api('GET', `/${createdIdA}`);
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const d = data as JsonObj;
    expect(d.id).toBe(createdIdA);
    expect(d.value).toBe('rest-smoke-alpha');
  });

  // 4a. created_at round-trip ─────────────────────────────────────────────────
  //
  // `POST /memories` used to pass `p_created_at: null` unconditionally, so an
  // explicit `created_at` was accepted by the schema, sent by the CLI, and then
  // silently discarded — `lorekit migrate`'s backdating was a no-op over REST.
  // These two cases pin both halves of the contract: a valid past date is
  // HONOURED (not replaced by now()), and a future date is REFUSED with a 400
  // (not silently dropped, and not a 500).
  it('POST /memories — honours an explicit past created_at', async () => {
    const backdated = '2020-03-04T05:06:07.000Z';
    const key = NS.name('backdated');

    const { status, data } = await api('POST', '/', {
      scope: SCOPE, key, value: 'migrated-from-elsewhere', created_at: backdated,
    });
    expect(status, `expected 201; got ${status}: ${JSON.stringify(data)}`).toBe(201);
    const id = (data as JsonObj).id as string;

    // The distinguishing assertion: a dropped override would give us now().
    const roundTrip = new Date((data as JsonObj).created_at as string).toISOString();
    expect(roundTrip, `created_at was not honoured: ${JSON.stringify(data)}`).toBe(backdated);

    // And it is persisted, not just echoed back by the write path.
    const got = await api('GET', `/${id}`);
    expect(got.status, `expected 200; got ${got.status}`).toBe(200);
    expect(new Date((got.data as JsonObj).created_at as string).toISOString()).toBe(backdated);
  });

  it('POST /memories — rejects a future created_at with a 400', async () => {
    // Well past the 60s clock-skew allowance in parseCreatedAt.
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { status, data } = await api('POST', '/', {
      scope: SCOPE, key: NS.name('future'), value: 'from-the-future', created_at: future,
    });
    expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
    expect((data as JsonObj).error, JSON.stringify(data)).toBeTruthy();
    expect(String((data as JsonObj).error).toLowerCase()).toContain('future');
  });

  it('POST /memories — rejects an unparseable created_at with a 400', async () => {
    const { status, data } = await api('POST', '/', {
      scope: SCOPE, key: NS.name('badcreated'), value: 'nope', created_at: 'not-a-date',
    });
    expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
    expect((data as JsonObj).error, JSON.stringify(data)).toBeTruthy();
  });

  // 5. update ─────────────────────────────────────────────────────────────────
  it('PATCH /memories/:id — updates entry A value', async () => {
    expect(createdIdA).toBeTruthy();
    const { status, data } = await api('PATCH', `/${createdIdA}`, { value: 'rest-smoke-alpha-updated' });
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    expect((data as JsonObj).value).toBe('rest-smoke-alpha-updated');
  });

  // 6. list with scope filter ─────────────────────────────────────────────────
  it('GET /memories?scope=global — includes both keys', async () => {
    const { status, data } = await api('GET', `/?scope=${SCOPE}&limit=100`);
    expect(status).toBe(200);
    const entries = (data as JsonObj).entries as JsonObj[];
    const keys = entries.map((e) => e.key);
    expect(keys, `expected ${KEY_A}`).toContain(KEY_A);
    expect(keys, `expected ${KEY_B}`).toContain(KEY_B);
  });

  // 7. search ─────────────────────────────────────────────────────────────────
  it('POST /memories/search — finds entry B by unique phrase', async () => {
    const { status, data } = await api('POST', '/search', {
      q: `unique-phrase-${KEY_PREFIX}`,
    });
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const entries = (data as JsonObj).entries as JsonObj[];
    const found = entries.some((e) => e.key === KEY_B);
    expect(found, `expected ${KEY_B} in results; got: ${JSON.stringify(entries)}`).toBe(true);
  });

  // 7a. search with an AND filter ─────────────────────────────────────────────
  it('POST /memories/search — AND filter narrows to this run\'s keys', async () => {
    const { status, data } = await api('POST', '/search', {
      filter: {
        and: [
          { field: 'scope', op: 'is', value: SCOPE },
          { field: 'key', op: 'starts_with', value: KEY_PREFIX },
        ],
      },
      limit: 100,
    });
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const entries = (data as JsonObj).entries as JsonObj[];
    const keys = entries.map((e) => e.key);
    expect(keys).toContain(KEY_A);
    expect(keys).toContain(KEY_B);
    // Every returned row must satisfy the filter — proves it was applied, not ignored.
    expect(entries.every((e) => String(e.key).startsWith(KEY_PREFIX)), JSON.stringify(keys)).toBe(true);
  });

  // 7b. search with an OR filter ──────────────────────────────────────────────
  it('POST /memories/search — OR filter matches either branch', async () => {
    const { status, data } = await api('POST', '/search', {
      filter: {
        or: [
          { field: 'key', op: 'is', value: KEY_A },
          { field: 'key', op: 'is', value: KEY_B },
        ],
      },
      limit: 100,
    });
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const keys = ((data as JsonObj).entries as JsonObj[]).map((e) => e.key);
    expect(keys).toContain(KEY_A);
    expect(keys).toContain(KEY_B);
    expect(keys.every((k) => k === KEY_A || k === KEY_B), JSON.stringify(keys)).toBe(true);
  });

  // 7c. search with an OR nested inside an AND ────────────────────────────────
  it('POST /memories/search — OR nested in AND excludes non-matching siblings', async () => {
    const { status, data } = await api('POST', '/search', {
      filter: {
        and: [
          { field: 'key', op: 'starts_with', value: KEY_PREFIX },
          { or: [{ field: 'key', op: 'ends_with', value: '-b' }] },
        ],
      },
      limit: 100,
    });
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const keys = ((data as JsonObj).entries as JsonObj[]).map((e) => e.key);
    expect(keys).toContain(KEY_B);
    expect(keys).not.toContain(KEY_A);
  });

  // 7d. filter that matches nothing ───────────────────────────────────────────
  it('POST /memories/search — filter with no matches returns an empty page', async () => {
    const { status, data } = await api('POST', '/search', {
      filter: { field: 'key', op: 'is', value: `${KEY_PREFIX}-does-not-exist` },
    });
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    expect((data as JsonObj).entries).toEqual([]);
  });

  // 7e. non-whitelisted field is dropped, never applied ───────────────────────
  it('POST /memories/search — non-whitelisted filter field is ignored, not an error', async () => {
    const { status, data } = await api('POST', '/search', {
      filter: {
        and: [
          { field: 'key', op: 'starts_with', value: KEY_PREFIX },
          { field: 'user_id', op: 'is', value: '00000000-0000-0000-0000-000000000000' },
        ],
      },
      limit: 100,
    });
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    // The bogus field is dropped; the whitelisted sibling still applies.
    const keys = ((data as JsonObj).entries as JsonObj[]).map((e) => e.key);
    expect(keys).toContain(KEY_A);
  });

  // 7f. search requires at least one of q / scopes / filter ───────────────────
  it('POST /memories/search — returns 400 when no q, scopes or filter is given', async () => {
    const { status, data } = await api('POST', '/search', { limit: 10 });
    expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
    expect((data as JsonObj).error).toBeTruthy();
  });

  // 8. delete (archive) ───────────────────────────────────────────────────────
  it('DELETE /memories/:id — archives entry A (204)', async () => {
    expect(createdIdA).toBeTruthy();
    const { status } = await api('DELETE', `/${createdIdA}`);
    expect(status, `expected 204`).toBe(204);
  });

  // 9. get after archive ──────────────────────────────────────────────────────
  it('GET /memories/:id — returns 404 after archive', async () => {
    expect(createdIdA).toBeTruthy();
    const { status } = await api('GET', `/${createdIdA}`);
    expect(status).toBe(404);
  });

  // 9b. natural-key archive ───────────────────────────────────────────────────
  // The CLI addresses lore by scope+key, never by UUID, so this is the route
  // `lorekit delete` / `lorekit archive` actually calls.
  it('DELETE /memories?scope=&key= — archives entry B by natural key (204)', async () => {
    const { status } = await api('DELETE', `/?scope=${SCOPE}&key=${encodeURIComponent(KEY_B)}`);
    expect(status, `expected 204`).toBe(204);
    const { data } = await api('GET', `/?scope=${SCOPE}&key=${encodeURIComponent(KEY_B)}&limit=1`);
    expect((data as JsonObj).entries).toEqual([]);
  });

  it('DELETE /memories — returns 400 without scope+key', async () => {
    const { status } = await api('DELETE', '/');
    expect(status, 'expected 400, not 405 (the route must exist)').toBe(400);
  });

  // ── Org-scoped delete (?org=<slug>) ────────────────────────────────────────
  // The org form routes through the role-gated `memory_delete` RPC (00020)
  // instead of a direct query. These cases assert the parts that hold for ANY
  // credential and ANY org membership — the shape of the contract, not a
  // particular tenant's data:
  //
  //   * `/:id` + `org` is refused outright (the RPC has no id parameter),
  //   * `org` without `scope`+`key` is refused,
  //   * a well-formed org delete never 400s and never 405s — it resolves to
  //     403 (role denied), 404 (no such row / unknown org) or 204 (done).
  //
  // Asserting a concrete 204 would need this run to own an org AND write
  // org-owned lore into it, which LOREKIT_SMOKE_TOKEN is not guaranteed to be
  // able to do (a service-role key resolves no actor at all). Pinning the
  // outcome set keeps the test honest for every credential while still failing
  // on the regressions that matter: an unregistered param silently ignored, a
  // 500, or the personal branch being taken by mistake.

  it('DELETE /memories/:id?org= — 400, because the org form is addressed by scope+key', async () => {
    const id = await create(NS.name('org-id-form'));
    try {
      const { status, data } = await api('DELETE', `/${id}?org=lorekit-smoke-nonexistent`);
      expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
      expect(String((data as JsonObj).error)).toMatch(/scope\+key|scope and key/i);

      // Load-bearing: the 400 must be a refusal, NOT a refusal-after-deleting.
      // Silently ignoring `org` here would archive the caller's personal row.
      const got = await api('GET', `/${id}`);
      expect(got.status, 'the row must be untouched by the rejected request').toBe(200);
    } finally {
      await api('DELETE', `/${id}?force=true`).catch(() => undefined);
    }
  });

  it('DELETE /memories?org= — 400 without scope and key', async () => {
    const { status, data } = await api('DELETE', '/?org=lorekit-smoke-nonexistent');
    expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
    expect((data as JsonObj).error).toBeTruthy();
  });

  it('DELETE /memories?org= — rejects an empty org rather than falling back to the personal branch', async () => {
    const { status, data } = await api('DELETE', `/?scope=${SCOPE}&key=whatever&org=`);
    expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
  });

  it.each([
    ['soft-archive', ''],
    ['hard-delete', '&force=true'],
  ])('DELETE /memories?scope=&key=&org= (%s) — routes to the role-gated RPC, never 400/405/500', async (_label, forceQs) => {
    const { status, data } = await api(
      'DELETE',
      `/?scope=${SCOPE}&key=${encodeURIComponent(NS.name('org'))}&org=lorekit-smoke-nonexistent${forceQs}`,
    );
    // 404: unknown org / no matching row. 403: LK002, the caller lacks the
    // archive/hard_delete capability. 204: it really did delete something.
    expect([204, 403, 404], `got ${status}: ${JSON.stringify(data)}`).toContain(status);
    // A 400 would mean the param was never registered; a 405 that the route
    // does not exist; a 500 that LK002 escaped translateDbError.
    expect(status).not.toBe(400);
    expect(status).not.toBe(405);
    expect(status).not.toBe(500);
    if (status === 403) expect((data as JsonObj).code).toBe('org_permission_denied');
  });

  // 10. invalid body ──────────────────────────────────────────────────────────
  it('POST /memories — returns 400 for missing required fields', async () => {
    const { status, data } = await api('POST', '/', { value: 'no-scope-or-key' });
    expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
    expect((data as JsonObj).error).toBeTruthy();
  });

  // ── Archived listing ────────────────────────────────────────────────────────
  // `?archived=true` is the `memory.list-archived` equivalent — there is no
  // dedicated route, and until now nothing proved the flag actually flips the
  // filter rather than being silently ignored.
  it('GET /memories?archived=true — lists an archived key, ?archived=false does not', async () => {
    createdIdR = await create(KEY_R, 'restore-me');

    expect(await listKeys(false), 'a fresh key must be listed as live').toContain(KEY_R);

    const { status } = await api('DELETE', `/${createdIdR}`);
    expect(status, 'archive should be 204').toBe(204);

    expect(await listKeys(true), 'archived=true must list the archived key').toContain(KEY_R);
    expect(await listKeys(false), 'archived=false must exclude the archived key').not.toContain(KEY_R);
  });

  // ── Restore ─────────────────────────────────────────────────────────────────
  it('POST /memories/restore — restores by scope+key and the row is live again', async () => {
    const { status, data } = await api('POST', '/restore', { scope: SCOPE, key: KEY_R });
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    expect(data).toEqual({ restored: true });

    expect(await listKeys(false), 'the restored key must be live again').toContain(KEY_R);
    expect(await listKeys(true), 'the restored key must no longer be archived').not.toContain(KEY_R);

    // And it is readable by id again — restore un-archives the same row, it
    // does not create a new one.
    const got = await api('GET', `/${createdIdR}`);
    expect(got.status, `expected 200; got ${got.status}`).toBe(200);
  });

  it('POST /memories/:id/restore — returns 404 for a row that is not archived', async () => {
    // KEY_R is live at this point (restored just above), so there is nothing to
    // restore: the `.not(archived_at, is, null)` guard must match zero rows.
    const { status, data } = await api('POST', `/${createdIdR}/restore`);
    expect(status, `expected 404; got ${status}: ${JSON.stringify(data)}`).toBe(404);
  });

  it('POST /memories/restore — returns 400 for a malformed body', async () => {
    const { status, data } = await api('POST', '/restore', { scope: SCOPE });
    expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
    expect((data as JsonObj).error).toBeTruthy();
  });

  // ── Hard delete ─────────────────────────────────────────────────────────────
  it('DELETE /memories/:id?force=true — hard-deletes (not archives) the row', async () => {
    const id = await create(KEY_F, 'delete-me-for-real');

    const del = await api('DELETE', `/${id}?force=true`);
    expect(del.status, `expected 204; got ${del.status}: ${JSON.stringify(del.data)}`).toBe(204);

    const got = await api('GET', `/${id}`);
    expect(got.status, 'the row must be gone').toBe(404);

    // The distinguishing assertion: an ARCHIVE would still show up here.
    expect(await listKeys(true), 'a force-deleted key must not be archived').not.toContain(KEY_F);
    expect(await listKeys(false)).not.toContain(KEY_F);
  });

  // ── Scopes ──────────────────────────────────────────────────────────────────
  it('GET /memories/scopes — includes this run\'s scope with a count >= 1', async () => {
    const { status, data } = await api('GET', '/scopes');
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const scopes = (data as JsonObj).scopes as Array<{ scope: string; count: number }>;
    expect(Array.isArray(scopes), JSON.stringify(data)).toBe(true);
    const row = scopes.find((s) => s.scope === SCOPE);
    expect(row, `expected scope ${SCOPE} in ${JSON.stringify(scopes)}`).toBeDefined();
    expect(typeof row!.count).toBe('number');
    expect(row!.count).toBeGreaterThanOrEqual(1);
    // Sorted ascending — the documented contract of the endpoint.
    expect(scopes.map((s) => s.scope)).toEqual([...scopes.map((s) => s.scope)].sort());
  });

  // ── List filters: ?tags= and ?q= ────────────────────────────────────────────
  //
  // These two filters had NO executing coverage on any surface until now, and
  // the gap was not theoretical: `?tags=` threw a TypeError on every request at
  // `5c9799f` while the whole mocked suite stayed green, because the Storybook
  // MSW handler reimplements both filters instead of calling `handleList`. A
  // mock that reimplements a filter can only ever confirm itself, so the check
  // belongs here, against a live PostgREST.
  //
  // Each case pins the property that a plausible-but-wrong implementation would
  // break, not merely that a row comes back:
  //
  //   * `tags_mode=all` is containment (@>), `any` is overlap (&&) — swapping
  //     them still returns rows, just the wrong ones;
  //   * a label carrying a double quote survives the Postgres array literal —
  //     the quoting `pgArrayLiteral` exists for;
  //   * `%` in `q` is DATA, so it must not widen the pattern;
  //   * a comma / parenthesis in `q` must match literally — that is the
  //     PostgREST-reserved-character path, which percent-encoding got wrong
  //     (`%2C` arrives as literal text after `URLSearchParams` re-encodes it)
  //     and unquoted interpolation gets wrong in the other direction (the value
  //     terminates its own clause).
  describe('list filters', () => {
    const KEY_TAGGED_BOTH = NS.name('filters-both');
    const KEY_TAGGED_ONE = NS.name('filters-one');
    const KEY_QUOTED_LABEL = NS.name('filters-quoted-label');
    const KEY_PERCENT = NS.name('filters-percent');
    const KEY_PLAIN_HUNDRED = NS.name('filters-hundred');
    const KEY_RESERVED = NS.name('filters-reserved');

    // Namespaced so a concurrent run (or leftovers from an earlier one) cannot
    // satisfy an assertion that this run's write was supposed to satisfy.
    const LABEL_X = `${KEY_PREFIX}-x`;
    const LABEL_Y = `${KEY_PREFIX}-y`;
    const LABEL_QUOTED = `${KEY_PREFIX}-needs "quoting"`;
    const RESERVED_PHRASE = `${KEY_PREFIX} a,b(c).d`;

    /** Create with labels, returning nothing — the sweep owns the cleanup. */
    async function createTagged(key: string, value: string, tags: string[]): Promise<void> {
      const { status, data } = await api('POST', '/', { scope: SCOPE, key, value, tags });
      expect(status, `create ${key}: expected 201; got ${status}: ${JSON.stringify(data)}`).toBe(201);
    }

    /** Keys returned by `GET /memories` with an arbitrary query string. */
    async function listWith(query: string): Promise<string[]> {
      const { status, data } = await api('GET', `/?scope=${SCOPE}&limit=100&${query}`);
      expect(status, `GET /?${query} → ${status}: ${JSON.stringify(data)}`).toBe(200);
      return ((data as JsonObj).entries as JsonObj[]).map((e) => String(e.key));
    }

    beforeAll(async () => {
      if (SKIP) return;
      await createTagged(KEY_TAGGED_BOTH, 'carries both labels', [LABEL_X, LABEL_Y]);
      await createTagged(KEY_TAGGED_ONE, 'carries one label', [LABEL_X]);
      await createTagged(KEY_QUOTED_LABEL, 'label with a double quote', [LABEL_QUOTED]);
      await createTagged(KEY_PERCENT, `${KEY_PREFIX} 100% coverage`, []);
      await createTagged(KEY_PLAIN_HUNDRED, `${KEY_PREFIX} 1000 coverage`, []);
      await createTagged(KEY_RESERVED, RESERVED_PHRASE, []);
    }, REMOTE_TEST_TIMEOUT);

    it('?tags= with tags_mode=all requires EVERY label (containment)', async () => {
      const keys = await listWith(
        `tags=${encodeURIComponent(`${LABEL_X},${LABEL_Y}`)}&tags_mode=all`,
      );
      expect(keys, 'the row carrying both labels must match').toContain(KEY_TAGGED_BOTH);
      expect(keys, 'a row carrying only one of them must not').not.toContain(KEY_TAGGED_ONE);
    });

    it('?tags= with tags_mode=any (the default) matches EITHER label (overlap)', async () => {
      const keys = await listWith(`tags=${encodeURIComponent(`${LABEL_X},${LABEL_Y}`)}`);
      expect(keys).toContain(KEY_TAGGED_BOTH);
      expect(keys, 'overlap must also return the single-label row').toContain(KEY_TAGGED_ONE);
    });

    it('?tags= matches a label containing a double quote', async () => {
      // `memories.tags` is free text with no CHECK, so this label is reachable.
      // A bare `join(',')` array serialisation mangles it into other labels and
      // the row silently stops matching its own filter.
      const keys = await listWith(`tags=${encodeURIComponent(LABEL_QUOTED)}&tags_mode=all`);
      expect(keys, `expected ${KEY_QUOTED_LABEL} for label ${LABEL_QUOTED}`).toContain(KEY_QUOTED_LABEL);
      expect(keys).not.toContain(KEY_TAGGED_BOTH);
    });

    it('?tags= naming a label nothing carries returns an empty page, not everything', async () => {
      const keys = await listWith(`tags=${encodeURIComponent(`${KEY_PREFIX}-absent`)}&tags_mode=all`);
      expect(keys).toEqual([]);
    });

    it('?q= matches a substring of the value', async () => {
      const keys = await listWith(`q=${encodeURIComponent('carries both labels')}`);
      expect(keys).toContain(KEY_TAGGED_BOTH);
      expect(keys).not.toContain(KEY_QUOTED_LABEL);
    });

    it('?q= matches a substring of the key', async () => {
      const keys = await listWith(`q=${encodeURIComponent(KEY_QUOTED_LABEL)}`);
      expect(keys, 'the OR arm over `key` must apply too').toContain(KEY_QUOTED_LABEL);
    });

    it('?q= treats % as data, not a LIKE wildcard', async () => {
      const keys = await listWith(`q=${encodeURIComponent(`${KEY_PREFIX} 100%`)}`);
      expect(keys, 'the row whose value literally contains "100%"').toContain(KEY_PERCENT);
      // The discriminator: unescaped, `…100%%` would also match "1000 coverage".
      expect(keys, 'an unescaped % would widen the pattern to this row too').not.toContain(
        KEY_PLAIN_HUNDRED,
      );
    });

    it('?q= matches PostgREST-reserved characters literally', async () => {
      const keys = await listWith(`q=${encodeURIComponent('a,b(c).d')}`);
      expect(
        keys,
        'a comma, parentheses and a dot must reach ILIKE as data — this is the case both prior encodings got wrong',
      ).toContain(KEY_RESERVED);
      expect(keys).not.toContain(KEY_TAGGED_BOTH);
    });

    it('?q= with a value that tries to close the clause and add a predicate matches nothing', async () => {
      // If the value escaped its quoting, this would parse as a second
      // disjunct rather than as text nobody wrote.
      const keys = await listWith(`q=${encodeURIComponent('",or(key.eq.' + KEY_TAGGED_BOTH + ')')}`);
      expect(keys, `injection attempt must not return rows: ${JSON.stringify(keys)}`).toEqual([]);
    });

    it('?q= combines with ?tags= as AND, not OR', async () => {
      const keys = await listWith(
        `tags=${encodeURIComponent(LABEL_X)}&tags_mode=all&q=${encodeURIComponent('carries one label')}`,
      );
      expect(keys).toEqual([KEY_TAGGED_ONE]);
    });

    it('?tags_mode=none excludes every named label (the negation of `any`)', async () => {
      const keys = await listWith(
        `tags=${encodeURIComponent(LABEL_X)}&tags_mode=none&q=${encodeURIComponent(KEY_PREFIX)}`,
      );
      expect(keys, 'a row carrying the label must be excluded').not.toContain(KEY_TAGGED_BOTH);
      expect(keys).not.toContain(KEY_TAGGED_ONE);
      expect(keys, 'a row carrying no label at all must survive').toContain(KEY_PERCENT);
    });
  });

  // ── Dimension filters + the facet catalog ────────────────────────────────────
  // The Explorer's filter bar and the CLI both address these; the Storybook MSW
  // handler REIMPLEMENTS them, so a green story says nothing about the handler.
  // This is the only place the real `in` / `not.in` composition, the value
  // quoting, and the AND-across-dimensions rule are executed.
  describe('dimension filters and /facets', () => {
    const AGENT_A = `${KEY_PREFIX}-agent-a`;
    const AGENT_B = `${KEY_PREFIX}-agent-b`;
    const TRIGGER = `${KEY_PREFIX}-trigger`;
    // A `.` and a `()` — the PostgREST-reserved characters that are actually
    // REACHABLE over `?origin_branch=`. A comma is not: the param is split on
    // commas by `parseTagsParam` before it ever reaches the quoting, so a
    // comma-bearing value arrives as two values and matches nothing.
    const BRANCH_RESERVED = `${KEY_PREFIX}/br.anch(1)`;
    const KEY_A = NS.name('dim-a');
    const KEY_B = NS.name('dim-b');
    const KEY_RESERVED_BRANCH = NS.name('dim-reserved-branch');

    async function createWith(key: string, body: JsonObj): Promise<void> {
      const { status, data } = await api('POST', '/', { scope: SCOPE, key, value: 'v', ...body });
      expect(status, `create ${key}: expected 201; got ${status}: ${JSON.stringify(data)}`).toBe(201);
    }

    async function listWith(query: string): Promise<string[]> {
      const { status, data } = await api('GET', `/?scope=${SCOPE}&limit=100&${query}`);
      expect(status, `GET /?${query} → ${status}: ${JSON.stringify(data)}`).toBe(200);
      return ((data as JsonObj).entries as JsonObj[]).map((e) => String(e.key));
    }

    beforeAll(async () => {
      if (SKIP) return;
      await createWith(KEY_A, {
        source_agent: AGENT_A,
        trigger: TRIGGER,
        origin_repo: 'mthines/lorekit',
        origin_branch: 'main',
        origin_pr: 311,
      });
      await createWith(KEY_B, { source_agent: AGENT_B, trigger: TRIGGER });
      await createWith(KEY_RESERVED_BRANCH, {
        source_agent: AGENT_A,
        origin_repo: 'mthines/lorekit',
        origin_branch: BRANCH_RESERVED,
      });
    }, REMOTE_TEST_TIMEOUT);

    it('?source_agent= matches one value', async () => {
      const keys = await listWith(`source_agent=${encodeURIComponent(AGENT_B)}`);
      expect(keys).toEqual([KEY_B]);
    });

    it('?source_agent= with several values is a disjunction', async () => {
      const keys = await listWith(`source_agent=${encodeURIComponent(`${AGENT_A},${AGENT_B}`)}`);
      expect(keys).toContain(KEY_A);
      expect(keys).toContain(KEY_B);
    });

    it('?source_agent_mode=nin negates the whole set', async () => {
      const keys = await listWith(
        `source_agent=${encodeURIComponent(AGENT_A)}&source_agent_mode=nin&trigger=${encodeURIComponent(TRIGGER)}`,
      );
      expect(keys, 'the excluded agent must be gone').not.toContain(KEY_A);
      expect(keys, 'the other agent under the same trigger must survive').toContain(KEY_B);
    });

    it('two dimensions AND together', async () => {
      const both = await listWith(
        `source_agent=${encodeURIComponent(AGENT_A)}&origin_branch=main`,
      );
      expect(both).toEqual([KEY_A]);
      const contradiction = await listWith(
        `source_agent=${encodeURIComponent(AGENT_B)}&origin_branch=main`,
      );
      expect(contradiction, 'AND, not OR — nothing satisfies both').toEqual([]);
    });

    it('?origin_branch= matches a branch containing PostgREST-reserved characters', async () => {
      // `origin_branch` is free text and deliberately NOT lowercased, so a `.`
      // or a `()` is reachable. Unquoted, the `in.()` operand terminates early
      // and the row stops matching its own filter. A comma is NOT reachable
      // here — `parseTagsParam` splits the param on it first — so it is the
      // `q` filter, not this one, that has to carry a literal comma.
      const keys = await listWith(`origin_branch=${encodeURIComponent(BRANCH_RESERVED)}`);
      expect(keys, `expected ${KEY_RESERVED_BRANCH} for branch ${BRANCH_RESERVED}`).toContain(
        KEY_RESERVED_BRANCH,
      );
      expect(keys).not.toContain(KEY_A);
    });

    it('?origin_pr= filters the integer column', async () => {
      const keys = await listWith('origin_pr=311');
      expect(keys).toContain(KEY_A);
      expect(keys).not.toContain(KEY_B);
    });

    it('?origin_pr= with a non-numeric entry narrows rather than 400ing', async () => {
      const { status } = await api('GET', `/?scope=${SCOPE}&limit=100&origin_pr=${encodeURIComponent('311,oops')}`);
      expect(status, 'a hand-edited URL must not break the page').toBe(200);
    });

    it('GET /facets enumerates every dimension with counts', async () => {
      const { status, data } = await api('GET', '/facets');
      expect(status, `GET /facets → ${status}: ${JSON.stringify(data)}`).toBe(200);
      const facets = (data as JsonObj).facets as JsonObj[];
      expect(Array.isArray(facets)).toBe(true);

      const find = (facet: string, value: string) =>
        facets.find((f) => f.facet === facet && f.value === value);

      expect(find('source_agent', AGENT_A), JSON.stringify(facets.slice(0, 20))).toBeTruthy();
      expect(Number(find('source_agent', AGENT_A)?.count)).toBeGreaterThanOrEqual(2);
      expect(find('trigger', TRIGGER)).toBeTruthy();
      expect(find('origin_branch', BRANCH_RESERVED), 'a reserved-character value must survive the trip').toBeTruthy();
      // The integer column arrives as a string, so a client never has to guess.
      expect(find('origin_pr', '311')?.value).toBe('311');
    });

    it('GET /facets?facets= narrows to the named dimensions', async () => {
      const { status, data } = await api('GET', '/facets?facets=trigger');
      expect(status).toBe(200);
      const facets = (data as JsonObj).facets as JsonObj[];
      expect(facets.every((f) => f.facet === 'trigger'), JSON.stringify(facets)).toBe(true);
    });

    it('GET /facets with an unknown dimension name narrows to nothing, it does not 400', async () => {
      const { status, data } = await api('GET', '/facets?facets=nope');
      expect(status, 'the param is re-read on every keystroke in the menu').toBe(200);
      expect((data as JsonObj).facets).toEqual([]);
    });
  });

  // ── Usage statistics ─────────────────────────────────────────────────────────
  // GET /memories/usage aggregates usage_events through lorekit_usage_stats. Like
  // /scopes the concrete numbers depend on the credential (a service-role smoke
  // token records no usage events but reads all via the CI escape hatch; an lk_* /
  // JWT token sees only its own), so these assert the response CONTRACT and that
  // the params the route registers are accepted end to end — NOT that a particular
  // row exists. Without this nothing exercised the route: a 500 would mean the
  // p_correlation_id RPC arg drifted, a 400 that a documented param was rejected,
  // a 405 that the literal route was swallowed by /:id.
  interface UsageBody {
    range: { since: string | null; until: string | null };
    correlation_id: string | null;
    summary: JsonObj;
    by_tool: JsonObj[];
    by_scope_type: JsonObj[];
  }
  function expectUsageShape(data: unknown): UsageBody {
    const d = data as UsageBody;
    expect(typeof d.summary, JSON.stringify(data)).toBe('object');
    for (const k of ['total_events', 'reads', 'writes', 'other', 'records_read', 'expired']) {
      expect(typeof d.summary[k], `summary.${k}: ${JSON.stringify(data)}`).toBe('number');
    }
    expect(typeof d.summary.by_outcome).toBe('object');
    expect(Array.isArray(d.by_tool), JSON.stringify(data)).toBe(true);
    expect(Array.isArray(d.by_scope_type), JSON.stringify(data)).toBe(true);
    return d;
  }

  it('GET /memories/usage — returns the aggregate usage summary shape', async () => {
    const { status, data } = await api('GET', '/usage');
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    expectUsageShape(data);
  });

  it('GET /memories/usage?period=7d — accepts the rolling-window param', async () => {
    const { status, data } = await api('GET', '/usage?period=7d');
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const d = expectUsageShape(data);
    expect(d.range.since, 'a 7d window must set a since bound').not.toBeNull();
  });

  it('GET /memories/usage?period=nope — rejects an unknown period with 400', async () => {
    const { status, data } = await api('GET', '/usage?period=nope');
    expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
    expect((data as JsonObj).error, JSON.stringify(data)).toBeTruthy();
  });

  it('GET /memories/usage?correlation_id= — applies the G2 filter (p_correlation_id resolves)', async () => {
    // A well-formed but unmatched correlation id: the RPC arg must resolve (no
    // 500) and the filter must narrow to nothing — proving p_correlation_id is
    // wired, not silently ignored. The value is within parseCorrelationId's
    // charset, so it is a real filter, not a degrade-to-null.
    const { status, data } = await api('GET', `/usage?correlation_id=${KEY_PREFIX}-no-such-pr`);
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const d = expectUsageShape(data);
    expect(d.correlation_id, 'the applied correlation id must be echoed back').toBe(`${KEY_PREFIX}-no-such-pr`);
    expect(d.by_tool, 'an unmatched correlation id must aggregate to nothing').toEqual([]);
  });

  it('GET /memories/usage?correlation_id=<malformed> — 400, not a silent widen to account-wide totals', async () => {
    // `pr+42` (the '+' is out of parseCorrelationId's charset) passes the schema
    // but is not a valid filter. A read must fail loud rather than degrade to
    // null and return unfiltered totals dressed up as one PR's.
    const { status, data } = await api('GET', '/usage?correlation_id=pr%2B42');
    expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
    expect((data as JsonObj).error, JSON.stringify(data)).toBeTruthy();
  });

  // ── Purge ───────────────────────────────────────────────────────────────────
  // Both purge endpoints are user-scoped. LOREKIT_SMOKE_TOKEN may legitimately be
  // either a user-scoped `lk_*` token or the service-role key, and the two have
  // DIFFERENT correct answers — 200 with a count, or 403 because a service-role
  // credential names no user to purge. Asserting the full contract of whichever
  // branch applies keeps this meaningful either way; anything else (a 500, a 405
  // from an unregistered route, a non-numeric count) still fails.
  function expectPurgeResult(status: number, data: unknown): void {
    if (status === 403) {
      expect((data as JsonObj).code, JSON.stringify(data)).toBe('forbidden');
      return;
    }
    expect(status, `expected 200 or 403; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    expect(typeof (data as JsonObj).purged, JSON.stringify(data)).toBe('number');
    expect((data as JsonObj).purged as number).toBeGreaterThanOrEqual(0);
  }

  it('POST /memories/purge — returns a numeric purged count', async () => {
    const { status, data } = await api('POST', '/purge', { retention_days: 365 });
    expectPurgeResult(status, data);
  });

  it('POST /memories/purge-expired — returns a numeric purged count', async () => {
    const { status, data } = await api('POST', '/purge-expired');
    expectPurgeResult(status, data);
  });
});

/**
 * Audit-trail read-back — the assertion the CRUD suite above cannot make
 * ------------------------------------------------------------------------
 * Every test above proves the REST surface RESPONDED correctly. None proves
 * the side effect that is invisible from the response: an `audit_log` row.
 * `recordAudit` is deliberately non-throwing, so a mutation whose audit insert
 * is rejected (by RLS, by the action CHECK, by anything) returns exactly the
 * same 200/201/204 as one whose audit row landed. That is precisely how the
 * `github_app.installation_linked` rows were lost for the life of the feature,
 * and how a JWT-authenticated REST mutation lost every row until `auditUserId`
 * was fixed. So: mutate, then READ THE ROW BACK.
 *
 * Readability is CAPABILITY-PROBED, not assumed. In CI the smoke token is the
 * local service-role key (`.github/workflows/ci.yml` → `steps.supabase.outputs
 * .service_role_key`), which bypasses RLS and can read `audit_log` through
 * PostgREST. With an `lk_*` API token it cannot — `lk_*` is a LoreKit token,
 * not a Postgres credential, and the gateway rejects it outright. In that case
 * these tests skip with a LOUD console warning naming the reason, so a reduced
 * run is visible in the log rather than passing silently as a full one.
 *
 * The writes are fire-and-forget relative to the HTTP response, so every
 * read-back polls briefly rather than reading once.
 */
describe.skipIf(SKIP)('LoreKit memories API — audit trail read-back (integration)', { timeout: REMOTE_TEST_TIMEOUT }, () => {
  // Its OWN namespace, so this suite's hook sweeps only this suite's key.
  // Sharing `NS` coupled the two: the CRUD hook issued a DELETE for AUDIT_KEY
  // before this suite had created it, and this hook re-deleted every CRUD key.
  // Both were harmless (a 404 counts as removed) but neither was intended.
  //
  // Two namespaces minted in the same millisecond share a PREFIX, which is fine
  // — names collide only on the same suffix, and no suffix is minted twice.
  const AUDIT_NS = createSmokeNamespace('memories');
  const AUDIT_KEY = AUDIT_NS.name('audit');
  /** Set by the capability probe in beforeAll. */
  let auditReadable = false;
  let probeStatus = 0;
  /** Everything in this block happens after this instant. */
  const startedAt = new Date().toISOString();
  let auditId = '';

  /** Poll `audit_log` for a row matching `query` (a PostgREST filter string). */
  async function findAuditRow(query: string, attempts = 12): Promise<JsonObj | undefined> {
    for (let i = 0; i < attempts; i++) {
      const { rows } = await pgRest(
        `/audit_log?${query}&created_at=gte.${startedAt}&order=created_at.desc&limit=5`,
      );
      if (rows.length > 0) return rows[0];
      await new Promise((r) => setTimeout(r, 250));
    }
    return undefined;
  }


  /**
   * Poll, then narrow. Returning a definite row (throwing with a useful
   * message when the poll times out) keeps the assertions below free of
   * non-null assertions AND makes a timeout report WHICH row was missing.
   */
  async function requireAuditRow(query: string, what: string): Promise<JsonObj> {
    const row = await findAuditRow(query);
    if (!row) throw new Error(`no ${what} audit row found (query: ${query})`);
    return row;
  }

  beforeAll(async () => {
    const probe = await pgRest('/audit_log?select=id&limit=1');
    probeStatus = probe.status;
    auditReadable = probe.status === 200;
    if (!auditReadable) {
      console.warn(
        '\n  ⚠ AUDIT READ-BACK SKIPPED — audit_log is NOT readable with this credential.\n' +
          `    Probe: GET ${PGREST}/audit_log → HTTP ${probe.status}.\n` +
          '    Cause: LOREKIT_SMOKE_TOKEN is not the Supabase service-role key (an lk_* LoreKit\n' +
          '    API token is not a Postgres credential, and a user JWT only sees its own rows).\n' +
          '    Effect: this run does NOT verify that any audit row was actually written —\n' +
          '    the CRUD suite above still passed, but the audit side effect is UNVERIFIED.\n' +
          '    Fix: run with the service-role key, as .github/workflows/ci.yml does.\n',
      );
    }
  });

  afterAll(async () => {
    // By key, not by `auditId`: the id is only set once the create test has
    // asserted its way to the end, so a failure anywhere before that left the
    // row behind. The key exists from the moment it was minted.
    await runBestEffortCleanup(() => sweepMintedKeys(AUDIT_NS, 'memories REST audit read-back'), {
      softTimeoutMs: CLEANUP_SOFT_TIMEOUT,
      context: 'memories REST audit read-back',
    });
  }, REMOTE_TEST_TIMEOUT);

  it('the audit_log capability probe ran and reported a definite result', () => {
    // Anti-vacuity: proves beforeAll executed and reached a decision, so a
    // silently-never-run probe cannot leave every test below "skipped" by
    // accident rather than by the documented reason.
    expect(probeStatus, 'the probe never issued a request').toBeGreaterThan(0);
    expect(auditReadable).toBe(probeStatus === 200);
  });

  it('POST /memories writes a memory.create audit row', async ({ skip }) => {
    if (!auditReadable) skip();
    auditId = await create(AUDIT_KEY, 'audit-me');

    const found = await requireAuditRow(`action=eq.memory.create&target=eq.${encodeURIComponent(AUDIT_KEY)}`, 'memory.create');
    expect(found.action).toBe('memory.create');
    expect(found.resource_type).toBe('memory');
    expect(found.resource_id).toBe(auditId);
    expect(found.target).toBe(AUDIT_KEY);
    expect((found.metadata as JsonObj).key).toBe(AUDIT_KEY);
    expect((found.metadata as JsonObj).scope).toBe(SCOPE);
  });

  it('PATCH /memories/:id writes a memory.update audit row', async ({ skip }) => {
    if (!auditReadable) skip();
    expect(auditId, 'the create step must have run').toBeTruthy();
    const { status } = await api('PATCH', `/${auditId}`, { value: 'audit-me-updated' });
    expect(status).toBe(200);

    const found = await requireAuditRow(`action=eq.memory.update&target=eq.${encodeURIComponent(AUDIT_KEY)}`, 'memory.update');
    expect(found.resource_id).toBe(auditId);
  });

  it('DELETE /memories/:id writes a memory.archive audit row (not memory.delete)', async ({ skip }) => {
    if (!auditReadable) skip();
    const { status } = await api('DELETE', `/${auditId}`);
    expect(status).toBe(204);

    const found = await requireAuditRow(`action=eq.memory.archive&target=eq.${encodeURIComponent(AUDIT_KEY)}`, 'memory.archive');
    expect((found.metadata as JsonObj).force, 'a soft archive must record force=false').toBe(false);

    // The distinguishing assertion: a soft archive must NOT look like a hard
    // delete in the trail.
    const wrong = await findAuditRow(`action=eq.memory.delete&target=eq.${encodeURIComponent(AUDIT_KEY)}`, 1);
    expect(wrong, 'an archive must not be recorded as memory.delete').toBeUndefined();
  });

  it('POST /memories/restore writes a memory.restore audit row', async ({ skip }) => {
    if (!auditReadable) skip();
    const { status } = await api('POST', '/restore', { scope: SCOPE, key: AUDIT_KEY });
    expect(status).toBe(200);

    const found = await requireAuditRow(`action=eq.memory.restore&target=eq.${encodeURIComponent(AUDIT_KEY)}`, 'memory.restore');
    expect((found.metadata as JsonObj).scope).toBe(SCOPE);
  });

  it('every audit row this run wrote carries an action the CHECK admits', async ({ skip }) => {
    if (!auditReadable) skip();
    // Scoped to the `memory.` namespace, not just to `created_at`: the orgs
    // suite runs against the same database in the same window and writes
    // `org.*` / `member.*` rows, which a timestamp-only filter would sweep in.
    // Nothing is lost by the scoping — a memory route recording an action
    // outside its own namespace is caught by the per-route assertions above,
    // each of which names the exact action it requires.
    const { rows } = await pgRest(
      `/audit_log?created_at=gte.${startedAt}&action=like.memory.*&select=action&limit=200`,
    );
    // A constraint-rejected action would never appear here at all, so this
    // asserts the complement: the actions that DID land are the expected set,
    // i.e. nothing was silently substituted.
    expect(rows.length, 'this run wrote no audit rows at all').toBeGreaterThan(0);
    const actions = new Set(rows.map((r) => r.action as string));
    for (const a of actions) expect(a).toMatch(/^[a-z_]+\.[a-z_]+$/);

    // Every mutation this suite performs, and the action each one must record.
    // `memory.delete` belongs here because the suite hard-deletes: the
    // `?force=true` cases assert it directly, and `afterAll` cleans up with
    // force so it does not leave rows behind. Any action OUTSIDE this set means
    // a handler recorded something other than what its route promises.
    const PRODUCIBLE = ['memory.archive', 'memory.create', 'memory.delete', 'memory.restore', 'memory.update'];
    expect([...actions].sort(), `unexpected action(s) recorded by this run`).toEqual(
      PRODUCIBLE.filter((a) => actions.has(a)).sort(),
    );
  });

  /**
   * `usage_events` and the service-role caller — the NEGATIVE that is actually
   * true.
   *
   * The router records a usage event only when `analyticsUserId(auth) !== null`,
   * i.e. for `api_key` and JWT callers. A service-role caller resolves to
   * `null` and records NOTHING. Asserting "a usage_events row exists" under the
   * CI credential would therefore be an assertion that can only ever fail, and
   * asserting it "if any exist" would be one that can only ever be vacuous. So
   * the branch is chosen from an OBSERVED fact — whether the audit rows this
   * run wrote carry a null actor, which is the service-role signature — and
   * each branch asserts the full contract of its own case.
   */
  it('records no usage_events for a service-role caller, and does record them otherwise', async ({ skip }) => {
    if (!auditReadable) skip();
    // Both queries are namespace-scoped for the same reason as the assertion
    // above: the orgs suite shares this database and this time window, and it
    // runs under a JWT, so its rows would both mis-classify the caller here and
    // satisfy the usage assertion on another suite's evidence.
    const { rows: auditRows } = await pgRest(
      `/audit_log?created_at=gte.${startedAt}&action=like.memory.*&select=user_id&limit=200`,
    );
    expect(auditRows.length, 'no audit rows to classify the caller from').toBeGreaterThan(0);
    const isServiceRole = auditRows.every((r) => r.user_id === null);

    const { status, rows: usageRows } = await pgRest(
      `/usage_events?created_at=gte.${startedAt}&tool_name=like.memory.*&select=tool_name,auth_type&limit=200`,
    );
    expect(status, 'usage_events must be readable with the same credential').toBe(200);

    if (isServiceRole) {
      // The real, non-vacuous negative: a service-role caller is deliberately
      // untracked, so this run must have produced ZERO usage events despite
      // having just issued several successful REST calls.
      expect(usageRows, 'a service-role caller must record no usage events').toEqual([]);
    } else {
      // A resolved-user caller (lk_* token or JWT) must record them.
      expect(usageRows.length, 'a non-service caller must record usage events').toBeGreaterThan(0);
      for (const r of usageRows) expect(['api_key', 'jwt']).toContain(r.auth_type);
      expect(usageRows.map((r) => r.tool_name)).toContain('memory.write');
    }
  });
});

/**
 * Per-scope read attribution — `usage_events.scope` + `GET
 * /memories/read-activity?scope=` (migration 00058).
 *
 * Two layers, deliberately separated by how much of the stack each can prove:
 *
 *   1. The CONTRACT, asserted unconditionally: every returned bucket carries a
 *      `scope` key (nullable), a `?scope=` filter returns only that scope, and
 *      an ungrammatical `?scope=` is a 400 rather than a silently-ignored
 *      filter. This is the half a caller depends on, and it holds on every
 *      credential.
 *
 *   2. The live ROUND TRIP — write, read, and see that read attributed to the
 *      minted scope — which only works when this credential actually causes a
 *      usage event to be recorded. It does not always: the router records one
 *      only for a resolved non-service user (`analyticsUserId`), so a
 *      service-role smoke token writes NO usage row at all, by design. Rather
 *      than assert something that is credential-dependent, a probe decides, and
 *      an anti-vacuity test asserts the probe reached a DEFINITE result — so a
 *      never-run probe cannot quietly turn the round trip into a green skip.
 *
 * The scope is minted, not borrowed: the rest of this file writes to `global`,
 * where every other run's reads land too, so "count >= 1 for this scope" there
 * would pass with the feature reverted.
 */
describe.skipIf(SKIP)('LoreKit memories API — per-scope read attribution (integration)', { timeout: REMOTE_TEST_TIMEOUT }, () => {
  // Its own namespace, so this suite's hook sweeps only this suite's key —
  // the same reasoning as the audit block above.
  const RA_NS = createSmokeNamespace('memories');
  const RA_KEY = RA_NS.name('readscope');
  /**
   * A scope no other run can be reading from. `project::` admits `[\w.-]+` and
   * a minted name is `[a-z0-9-]+`, so the namespace prefix is a valid project
   * scope as-is — and it is swept, because `GET /memories/scopes` reports any
   * scope holding an active row and the orphan sweeper unions that list in.
   */
  const RA_SCOPE = `project::${RA_NS.prefix}-readscope`;
  /** Everything in this block happens after this instant. */
  const startedAt = new Date().toISOString();
  /** Set by the capability probe in beforeAll. */
  let attributionObservable = false;
  let probeRan = false;
  let probeReason = '';

  async function raApi(method: string, path: string, body?: unknown) {
    return api(method, path, body);
  }

  /** Hard-delete this suite's key at ITS scope — the file-level helper is bound to `global`. */
  async function hardDeleteInScope(key: string): Promise<void> {
    const { status, data } = await raApi(
      'DELETE',
      `/?scope=${encodeURIComponent(RA_SCOPE)}&key=${encodeURIComponent(key)}&force=true`,
    );
    if (status !== 204 && status !== 404) {
      throw new Error(`DELETE ${key} @ ${RA_SCOPE} → HTTP ${status}: ${JSON.stringify(data)}`);
    }
  }

  /** Poll `usage_events` for a read attributed to this suite's scope. */
  async function findAttributedRead(attempts = 12): Promise<JsonObj | undefined> {
    for (let i = 0; i < attempts; i++) {
      const { rows } = await pgRest(
        `/usage_events?scope=eq.${encodeURIComponent(RA_SCOPE)}` +
          `&created_at=gte.${startedAt}&order=created_at.desc&limit=5`,
      );
      const read = rows.find((r) => typeof r.tool_name === 'string' && String(r.tool_name).startsWith('memory.list'));
      if (read) return read;
      await new Promise((r) => setTimeout(r, 250));
    }
    return undefined;
  }

  beforeAll(async () => {
    // Write one memory, then READ it back through the scope-filtered list — the
    // call whose usage row should carry the scope. Both go through the public
    // API, so this exercises the real recording site, not a seeded row.
    const created = await raApi('POST', '/', { scope: RA_SCOPE, key: RA_KEY, value: 'read-scope-probe' });
    if (created.status !== 201) {
      probeRan = true;
      probeReason = `create under ${RA_SCOPE} returned HTTP ${created.status}`;
      return;
    }
    const listed = await raApi('GET', `/?scope=${encodeURIComponent(RA_SCOPE)}&limit=10`);
    if (listed.status !== 200) {
      probeRan = true;
      probeReason = `list under ${RA_SCOPE} returned HTTP ${listed.status}`;
      return;
    }

    const row = await findAttributedRead();
    probeRan = true;
    attributionObservable = row !== undefined;
    if (!attributionObservable) {
      probeReason = 'no usage_events row carrying this scope became visible';
      console.warn(
        '\n  ⚠ PER-SCOPE READ ROUND TRIP SKIPPED — no attributed usage event was observable.\n' +
          `    Scope: ${RA_SCOPE}\n` +
          '    Cause: either usage_events is not readable with this credential (an lk_* LoreKit\n' +
          '    token is not a Postgres credential), or the credential is the service-role key,\n' +
          '    for which the router records NO usage event at all (there is no human actor).\n' +
          '    Effect: this run verified the read-activity CONTRACT but NOT the live\n' +
          '    write→read→attribute round trip.\n' +
          '    Fix: run with a non-service lk_rw_* token plus a service-role credential for\n' +
          '    the read-back, as the staging smoke job does.\n',
      );
    }
  }, REMOTE_TEST_TIMEOUT);

  afterAll(async () => {
    await runBestEffortCleanup(
      async () => {
        const report = await sweepSmokeArtefacts(RA_NS.minted(), hardDeleteInScope);
        const warning = describeSweepFailures(report, 'memories REST per-scope read attribution');
        if (warning) console.warn(warning);
      },
      { softTimeoutMs: CLEANUP_SOFT_TIMEOUT, context: 'memories REST per-scope read attribution' },
    );
  }, REMOTE_TEST_TIMEOUT);

  it('the attribution probe ran and reported a definite result', () => {
    // Anti-vacuity: proves beforeAll executed and decided, so a probe that
    // never ran cannot leave the round-trip test permanently "skipped" by
    // accident rather than by the documented reason.
    expect(probeRan, 'the attribution probe never completed').toBe(true);
    if (!attributionObservable) expect(probeReason.length).toBeGreaterThan(0);
  });

  it('GET /memories/read-activity — every bucket carries a (nullable) scope', async () => {
    const { status, data } = await raApi('GET', '/read-activity?bucket=day');
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const buckets = (data as JsonObj).buckets as JsonObj[];
    expect(Array.isArray(buckets)).toBe(true);
    for (const b of buckets) {
      // Present-and-nullable, not merely "sometimes a string": an absent key
      // would mean the handler is still emitting the pre-00058 shape and the
      // grouped rows were collapsed somewhere on the way out.
      expect(Object.prototype.hasOwnProperty.call(b, 'scope'), `bucket missing scope: ${JSON.stringify(b)}`).toBe(true);
      expect(b.scope === null || typeof b.scope === 'string').toBe(true);
      expect(typeof b.count).toBe('number');
    }
  });

  it('GET /memories/read-activity?scope= — an invalid scope is a 400, not an ignored filter', async () => {
    // Fails LOUD, unlike the recording side. Silently dropping a typo'd filter
    // would answer "reads everywhere" under the label the caller asked for.
    for (const bad of ['repo:mthines/x', 'nope::x', 'repo::no-slash']) {
      const { status } = await raApi('GET', `/read-activity?scope=${encodeURIComponent(bad)}`);
      expect(status, `scope=${bad} should be rejected`).toBe(400);
    }
  });

  it('GET /memories/read-activity?scope= — returns only that scope', async () => {
    const { status, data } = await raApi(
      'GET', `/read-activity?bucket=hour&scope=${encodeURIComponent(RA_SCOPE)}`,
    );
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const buckets = (data as JsonObj).buckets as JsonObj[];
    // Exactness holds whether or not any event landed: an empty result is fine,
    // a FOREIGN scope in a filtered result never is.
    for (const b of buckets) {
      expect(b.scope, `filtered result leaked a foreign scope: ${JSON.stringify(b)}`).toBe(RA_SCOPE);
    }
  });

  it('a live read under a minted scope is attributed to it', async ({ skip }) => {
    if (!attributionObservable) skip();
    const { status, data } = await raApi(
      'GET', `/read-activity?bucket=hour&scope=${encodeURIComponent(RA_SCOPE)}`,
    );
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const buckets = (data as JsonObj).buckets as JsonObj[];
    // The metric is additive, so the per-scope headline IS the sum of the
    // filtered buckets — the property that makes a companion total RPC
    // unnecessary. The probe's own list read returned at least the one memory
    // it had just written.
    const total = buckets.reduce((n, b) => n + Number(b.count), 0);
    expect(total, `expected at least 1 attributed record read for ${RA_SCOPE}`).toBeGreaterThanOrEqual(1);
  });
});
