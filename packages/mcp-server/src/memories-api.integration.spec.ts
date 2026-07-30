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

import { describe, it, expect, afterAll } from 'vitest';

const BASE = (process.env['LOREKIT_REST_BASE_URL'] ?? 'http://localhost:54321/functions/v1').replace(/\/$/, '');
const TOKEN = process.env['LOREKIT_SMOKE_TOKEN'];
const SKIP = !TOKEN;

const KEY_PREFIX = `memories-smoke-${Date.now()}`;
const SCOPE = 'global';
const KEY_A = `${KEY_PREFIX}-a`;
const KEY_B = `${KEY_PREFIX}-b`;

type JsonObj = Record<string, unknown>;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${BASE}/memories${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

describe.skipIf(SKIP)('LoreKit memories API — smoke tests (integration)', () => {
  let createdIdA = '';
  let createdIdB = '';

  afterAll(async () => {
    // Best-effort cleanup
    for (const id of [createdIdA, createdIdB].filter(Boolean)) {
      await api('DELETE', `/${id}`).catch(() => undefined);
    }
  });

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
    createdIdB = d.id as string;
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

  // 10. invalid body ──────────────────────────────────────────────────────────
  it('POST /memories — returns 400 for missing required fields', async () => {
    const { status, data } = await api('POST', '/', { value: 'no-scope-or-key' });
    expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
    expect((data as JsonObj).error).toBeTruthy();
  });
});
