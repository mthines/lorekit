/**
 * LoreKit orgs REST API — integration smoke test
 * -----------------------------------------------
 * Exercises the `orgs` Edge Function end-to-end against a live LoreKit
 * instance. Requires a user JWT (not an API token) because org RPCs use
 * auth.uid() server-side.
 *
 * Required env vars:
 *   LOREKIT_SMOKE_JWT        Supabase user JWT (not an lk_* API token)
 *   LOREKIT_REST_BASE_URL    Base URL, e.g. https://<ref>.supabase.co/functions/v1
 *
 * Run standalone:
 *   LOREKIT_SMOKE_JWT=<jwt> LOREKIT_REST_BASE_URL=<url> \
 *     pnpm nx test mcp-server -- --reporter=verbose --testPathPattern=orgs-api.integration
 */

import { describe, it, expect, afterAll } from 'vitest';

const BASE = (process.env['LOREKIT_REST_BASE_URL'] ?? 'http://localhost:54321/functions/v1').replace(/\/$/, '');
const JWT = process.env['LOREKIT_SMOKE_JWT'];
const SKIP = !JWT;

const SLUG = `smoke-org-${Date.now()}`;
const NAME = 'Smoke Test Org';

type JsonObj = Record<string, unknown>;

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}/orgs${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${JWT}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe.skipIf(SKIP)('orgs REST API smoke', () => {
  let orgSlug = '';

  afterAll(async () => {
    // Best-effort cleanup
    if (orgSlug) await api('DELETE', `/${orgSlug}`);
  });

  it('POST / — creates an org', async () => {
    const res = await api('POST', '/', { slug: SLUG, name: NAME });
    expect(res.status).toBe(201);
    const body = await res.json() as JsonObj;
    expect(body).toHaveProperty('slug', SLUG);
    orgSlug = SLUG;
  });

  it('GET / — lists orgs including the new one', async () => {
    const res = await api('GET', '/');
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: JsonObj[] };
    expect(body.entries.some((e) => e.slug === SLUG)).toBe(true);
  });

  it('GET /:slug — gets the org', async () => {
    const res = await api('GET', `/${orgSlug}`);
    expect(res.status).toBe(200);
    const body = await res.json() as JsonObj;
    expect(body).toHaveProperty('slug', orgSlug);
  });

  it('PATCH /:slug — renames the org', async () => {
    const res = await api('PATCH', `/${orgSlug}`, { name: 'Renamed Org' });
    expect(res.status).toBe(200);
  });

  it('GET /:slug/members — lists members', async () => {
    const res = await api('GET', `/${orgSlug}/members`);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: JsonObj[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('GET /:slug/invites — lists invites (empty)', async () => {
    const res = await api('GET', `/${orgSlug}/invites`);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: JsonObj[] };
    expect(body.entries).toHaveLength(0);
  });

  it('DELETE /:slug — deletes the org', async () => {
    const res = await api('DELETE', `/${orgSlug}`);
    expect(res.status).toBe(204);
    orgSlug = ''; // prevent afterAll double-delete
  });

  it('GET /:slug — returns 404 after deletion', async () => {
    const res = await api('GET', `/${SLUG}`);
    expect(res.status).toBe(404);
  });
});
