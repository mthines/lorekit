/**
 * LoreKit orgs REST API — integration smoke test
 * -----------------------------------------------
 * Exercises the `orgs` Edge Function end-to-end against a live LoreKit
 * instance. Runs in CI (and locally) when the required environment variables
 * are present; skips gracefully otherwise.
 *
 * Required env vars:
 *   LOREKIT_SMOKE_JWT        Supabase user JWT (org endpoints require JWT — lk_* tokens are rejected)
 *   LOREKIT_REST_BASE_URL    Base URL, e.g. https://<ref>.supabase.co/functions/v1
 *                            Defaults to http://localhost:54321/functions/v1
 *
 * Optional env vars:
 *   LOREKIT_SMOKE_TOKEN      A lk_* API token — used only to assert 403 behaviour
 *
 * Run standalone:
 *   LOREKIT_SMOKE_JWT=<jwt> LOREKIT_REST_BASE_URL=<url> \
 *     pnpm nx test mcp-server -- --reporter=verbose --testPathPattern=orgs-api.integration
 */

import { describe, it, expect, afterAll } from 'vitest';

const BASE = (process.env['LOREKIT_REST_BASE_URL'] ?? 'http://localhost:54321/functions/v1').replace(/\/$/, '');
const JWT = process.env['LOREKIT_SMOKE_JWT'];
const API_TOKEN = process.env['LOREKIT_SMOKE_TOKEN']; // optional — lk_* token for 403 assertion
const SKIP = !JWT;

// Slug must be unique and match ^[a-z0-9][a-z0-9-]*[a-z0-9]$
const TEST_SLUG = `smoke-${Date.now()}-test`;

type JsonObj = Record<string, unknown>;

async function restFetch(
  method: string,
  path: string,
  body?: unknown,
  token: string | undefined = JWT,
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/orgs${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

describe.skipIf(SKIP)('LoreKit orgs API — smoke tests (integration)', () => {
  afterAll(async () => {
    // Best-effort cleanup — delete the test org if it still exists
    await restFetch('DELETE', `/${TEST_SLUG}`).catch(() => undefined);
  });

  // 1. auth: no token → 401/403 ───────────────────────────────────────────────
  it('GET /orgs — returns 401 or 403 when no auth token is provided', async () => {
    const { status } = await restFetch('GET', '/', undefined, undefined);
    expect([401, 403], `expected 401 or 403; got ${status}`).toContain(status);
  });

  // 2. auth: lk_* API token → 403 ────────────────────────────────────────────
  it('GET /orgs — returns 403 when lk_* API token is used (JWT required)', async () => {
    if (!API_TOKEN) {
      console.log('  ⚠ LOREKIT_SMOKE_TOKEN not set — skipping lk_* 403 assertion');
      return;
    }
    const { status } = await restFetch('GET', '/', undefined, API_TOKEN);
    expect(status, `expected 403 for lk_* token; got ${status}`).toBe(403);
  });

  // 3. list — baseline ────────────────────────────────────────────────────────
  it('GET /orgs — returns a list of orgs', async () => {
    const { status, data } = await restFetch('GET', '/');
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const d = data as JsonObj;
    expect(Array.isArray(d.orgs), 'orgs should be an array').toBe(true);
  });

  // 4. create ─────────────────────────────────────────────────────────────────
  it('POST /orgs — creates a test org', async () => {
    const { status, data } = await restFetch('POST', '/', {
      slug: TEST_SLUG,
      name: 'Smoke Test Org',
    });
    expect(status, `expected 201; got ${status}: ${JSON.stringify(data)}`).toBe(201);
    const d = data as JsonObj;
    expect(d.slug).toBe(TEST_SLUG);
    expect(typeof d.name).toBe('string');
  });

  // 5. get ────────────────────────────────────────────────────────────────────
  it('GET /orgs/:slug — returns the created org', async () => {
    const { status, data } = await restFetch('GET', `/${TEST_SLUG}`);
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const d = data as JsonObj;
    expect(d.slug).toBe(TEST_SLUG);
  });

  // 6. rename ─────────────────────────────────────────────────────────────────
  it('PATCH /orgs/:slug — renames the org', async () => {
    const { status, data } = await restFetch('PATCH', `/${TEST_SLUG}`, {
      name: 'Smoke Test Org (renamed)',
    });
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const d = data as JsonObj;
    expect(d.name).toBe('Smoke Test Org (renamed)');
  });

  // 7. list members ───────────────────────────────────────────────────────────
  it('GET /orgs/:slug/members — returns member list', async () => {
    const { status, data } = await restFetch('GET', `/${TEST_SLUG}/members`);
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const d = data as JsonObj;
    expect(Array.isArray(d.members), 'members should be an array').toBe(true);
  });

  // 8. list invites ───────────────────────────────────────────────────────────
  it('GET /orgs/:slug/invites — returns invite list', async () => {
    const { status, data } = await restFetch('GET', `/${TEST_SLUG}/invites`);
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const d = data as JsonObj;
    expect(Array.isArray(d.invites), 'invites should be an array').toBe(true);
  });

  // 9. delete ─────────────────────────────────────────────────────────────────
  it('DELETE /orgs/:slug — deletes the test org (204)', async () => {
    const { status } = await restFetch('DELETE', `/${TEST_SLUG}`);
    expect(status, `expected 204`).toBe(204);
  });

  // 10. get after delete — 404 ────────────────────────────────────────────────
  it('GET /orgs/:slug — returns 404 after deletion', async () => {
    const { status } = await restFetch('GET', `/${TEST_SLUG}`);
    expect(status).toBe(404);
  });

  // 11. invalid body ──────────────────────────────────────────────────────────
  it('POST /orgs — returns 400 for missing required fields', async () => {
    const { status, data } = await restFetch('POST', '/', { name: 'No Slug Provided' });
    expect(status, `expected 400; got ${status}: ${JSON.stringify(data)}`).toBe(400);
    expect((data as JsonObj).error).toBeTruthy();
  });
});
