/**
 * LoreKit orgs REST API — integration smoke test
 * -----------------------------------------------
 * Exercises the `orgs` Edge Function end-to-end against a live LoreKit
 * instance. Runs in CI (and locally) when the required environment variables
 * are present; skips gracefully otherwise.
 *
 * Required env vars:
 *   LOREKIT_SMOKE_JWT        Supabase user JWT
 *   LOREKIT_REST_BASE_URL    Base URL, e.g. https://<ref>.supabase.co/functions/v1
 *                            Defaults to http://localhost:54321/functions/v1
 *
 * Optional env vars:
 *   LOREKIT_SMOKE_TOKEN      A lk_* API token. Since the org-actor-override change
 *                            (migration 00041) these routes accept API tokens, so this
 *                            drives a whole second suite: permission gating, the full
 *                            api_key lifecycle, and the tenant-filter assertions.
 *                            Ideally the token belongs to the SAME user as
 *                            LOREKIT_SMOKE_JWT — the cross-credential consistency
 *                            check below relies on that and skips otherwise.
 *   LOREKIT_SMOKE_FOREIGN_SLUG
 *                            Slug of an org the token owner is NOT a member of.
 *                            Turns the tenant-isolation assertion from a proxy into a
 *                            direct one. Skipped when unset.
 *
 * Run standalone:
 *   LOREKIT_SMOKE_JWT=<jwt> LOREKIT_REST_BASE_URL=<url> \
 *     pnpm nx test mcp-server -- --reporter=verbose --testPathPattern=orgs-api.integration
 */

import { describe, it, expect, afterAll } from 'vitest';

const BASE = (process.env['LOREKIT_REST_BASE_URL'] ?? 'http://localhost:54321/functions/v1').replace(/\/$/, '');
const JWT = process.env['LOREKIT_SMOKE_JWT'];
const API_TOKEN = process.env['LOREKIT_SMOKE_TOKEN'];
const FOREIGN_SLUG = process.env['LOREKIT_SMOKE_FOREIGN_SLUG'];
const SKIP = !JWT;

/**
 * A token's permissions are encoded in its prefix (`packages/mcp-core/src/permissions.ts`):
 * `lk_rw_` = read + write, `lk_ro_` = read only, `lk_wo_` = write only. The org routes
 * are gated on exactly these, so the expectations below branch on the prefix rather than
 * assuming a read-write token.
 */
const tokenCanRead = !!API_TOKEN && (API_TOKEN.startsWith('lk_rw_') || API_TOKEN.startsWith('lk_ro_'));
const tokenCanWrite = !!API_TOKEN && (API_TOKEN.startsWith('lk_rw_') || API_TOKEN.startsWith('lk_wo_'));

// Slug must be unique and match ^[a-z0-9][a-z0-9-]*[a-z0-9]$
const TEST_SLUG = `smoke-${Date.now()}-test`;
const TOKEN_SLUG = `smoke-${Date.now()}-tok`;

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

  // 2. auth: lk_* API token → gated by PERMISSION, not by auth tier ──────────
  //
  // CHANGED, deliberately. This assertion used to be `expect(status).toBe(403)`
  // for any lk_* token, matching the old `requires: 'jwt'` route table. That is
  // precisely the behaviour this change removes — a read-capable token must now
  // get a 200. Keeping the old assertion would mean asserting the bug. The
  // 403 case is not dropped, it moves to the write-only token below (and to the
  // read-only-token-cannot-POST case in the api_key suite).
  it('GET /orgs — an lk_* token is accepted or rejected by its read permission', async () => {
    if (!API_TOKEN) {
      console.log('  ⚠ LOREKIT_SMOKE_TOKEN not set — skipping lk_* permission assertion');
      return;
    }
    const { status, data } = await restFetch('GET', '/', undefined, API_TOKEN);
    if (tokenCanRead) {
      expect(status, `read-capable token should be allowed; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    } else {
      expect(status, `write-only token must be denied read; got ${status}`).toBe(403);
    }
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

/**
 * ── api_key tier ───────────────────────────────────────────────────────────
 *
 * Everything below exercises the path opened by
 * `supabase/migrations/00041_org_actor_override.sql` + the tenant filters in
 * `supabase/functions/_shared/api/tenant.ts`. It is a genuinely different code
 * path from the JWT suite above, not a re-run of it:
 *
 *   - the edge function uses a SERVICE-ROLE Supabase client, so RLS is off and
 *     every read is protected only by the filters the handlers apply;
 *   - the RPCs cannot see an `auth.uid()`, so authorization depends entirely on
 *     the `p_actor_user_id` the handlers pass.
 *
 * A regression in either shows up here as a 403 (the actor was lost) or as a
 * result set that is too large (the tenant filter was lost) — and in nothing
 * the JWT suite runs.
 */
describe.skipIf(SKIP || !API_TOKEN)('LoreKit orgs API — api_key tier (integration)', () => {
  afterAll(async () => {
    await restFetch('DELETE', `/${TOKEN_SLUG}`).catch(() => undefined);
  });

  // ── permission gating ─────────────────────────────────────────────────────

  it('POST /orgs — a read-only token is denied write', async () => {
    if (tokenCanWrite) {
      console.log('  ⚠ token has write permission — skipping the read-only denial assertion');
      return;
    }
    const { status } = await restFetch('POST', '/', { slug: TOKEN_SLUG, name: 'Denied' }, API_TOKEN);
    expect(status, `expected 403 for a token without write permission; got ${status}`).toBe(403);
  });

  it('GET /orgs/:slug/members — a write-only token is denied read', async () => {
    if (tokenCanRead) {
      console.log('  ⚠ token has read permission — skipping the write-only denial assertion');
      return;
    }
    const { status } = await restFetch('GET', `/${TEST_SLUG}/members`, undefined, API_TOKEN);
    expect(status, `expected 403 for a token without read permission; got ${status}`).toBe(403);
  });

  // ── the actor override: every mutating route must resolve an actor ────────
  //
  // Before 00041 each of these returned 403 for an API token because
  // `lorekit_org_can(auth.uid() /* NULL */, …)` denied. A 403 here means a
  // handler stopped passing `p_actor_user_id`.

  it('POST /orgs — creates an org owned by the TOKEN OWNER', async () => {
    if (!tokenCanWrite) return;
    const { status, data } = await restFetch('POST', '/', { slug: TOKEN_SLUG, name: 'Token Created Org' }, API_TOKEN);
    expect(
      status,
      `expected 201 — a 403 here means the actor override was lost (see migration 00041); got ${status}: ${JSON.stringify(data)}`,
    ).toBe(201);
  });

  it('GET /orgs — the newly created org is visible to its owner', async () => {
    if (!tokenCanWrite || !tokenCanRead) return;
    const { status, data } = await restFetch('GET', '/', undefined, API_TOKEN);
    expect(status).toBe(200);
    const entries = (data as JsonObj).entries as { slug: string }[] | undefined;
    expect(Array.isArray(entries), `expected an entries array; got ${JSON.stringify(data)}`).toBe(true);
    expect(entries!.some((e) => e.slug === TOKEN_SLUG)).toBe(true);
  });

  it('GET /orgs/:slug — returns the org for a member', async () => {
    if (!tokenCanWrite || !tokenCanRead) return;
    const { status, data } = await restFetch('GET', `/${TOKEN_SLUG}`, undefined, API_TOKEN);
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    expect((data as JsonObj).slug).toBe(TOKEN_SLUG);
  });

  it('GET /orgs/:slug/members — lists the creator as owner', async () => {
    if (!tokenCanWrite || !tokenCanRead) return;
    const { status, data } = await restFetch('GET', `/${TOKEN_SLUG}/members`, undefined, API_TOKEN);
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const entries = (data as JsonObj).entries as { role: string }[] | undefined;
    expect(Array.isArray(entries)).toBe(true);
    // An EMPTY list would mean lorekit_org_members_list saw a NULL actor and
    // returned its fail-closed empty set — the read-side symptom of a lost actor.
    expect(entries!.length, 'members list was empty — the actor was probably not passed to lorekit_org_members_list').toBeGreaterThan(0);
    expect(entries!.some((m) => m.role === 'owner')).toBe(true);
  });

  it('GET /orgs/:slug/invites — returns an invite list', async () => {
    if (!tokenCanWrite || !tokenCanRead) return;
    const { status, data } = await restFetch('GET', `/${TOKEN_SLUG}/invites`, undefined, API_TOKEN);
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    expect(Array.isArray((data as JsonObj).entries)).toBe(true);
  });

  it('POST + DELETE /orgs/:slug/invites — invite then revoke', async () => {
    if (!tokenCanWrite) return;
    const created = await restFetch(
      'POST',
      `/${TOKEN_SLUG}/invites`,
      { email: `smoke-invitee-${Date.now()}@example.invalid`, role: 'member' },
      API_TOKEN,
    );
    expect(
      created.status,
      `expected 201 — a 403 means lorekit_org_invite lost its actor; got ${created.status}: ${JSON.stringify(created.data)}`,
    ).toBe(201);

    const inviteId = (created.data as JsonObj).inviteId as string;
    expect(typeof inviteId).toBe('string');

    const revoked = await restFetch('DELETE', `/${TOKEN_SLUG}/invites/${inviteId}`, undefined, API_TOKEN);
    expect(revoked.status, `expected 204; got ${revoked.status}`).toBe(204);
  });

  it('PATCH /orgs/:slug — renames the org', async () => {
    if (!tokenCanWrite) return;
    const { status, data } = await restFetch('PATCH', `/${TOKEN_SLUG}`, { name: 'Token Created Org (renamed)' }, API_TOKEN);
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    expect((data as JsonObj).name).toBe('Token Created Org (renamed)');
  });

  // ── the tenant filter: reads must NOT return other tenants' rows ──────────

  it('GET /orgs — an api_key list matches the JWT list for the same user', async () => {
    if (!tokenCanRead) return;
    const viaToken = await restFetch('GET', '/', undefined, API_TOKEN);
    const viaJwt = await restFetch('GET', '/', undefined, JWT);
    if (viaToken.status !== 200 || viaJwt.status !== 200) return;

    const tokenSlugs = (((viaToken.data as JsonObj).entries as { slug: string }[]) ?? []).map((e) => e.slug).sort();
    const jwtSlugs = (((viaJwt.data as JsonObj).entries as { slug: string }[]) ?? []).map((e) => e.slug).sort();

    // Only meaningful when both credentials belong to the same user; if they do
    // not, the sets legitimately differ and there is nothing to assert.
    if (tokenSlugs.length !== jwtSlugs.length || !tokenSlugs.every((s, i) => s === jwtSlugs[i])) {
      console.log('  ⚠ token and JWT appear to belong to different users — skipping the equality check');
      return;
    }
    // The failure this catches: with the tenant filter missing, the service-role
    // client returns EVERY org_members row in the database, so the api_key list
    // is a strict superset of the RLS-scoped JWT list.
    expect(tokenSlugs).toEqual(jwtSlugs);
  });

  it('GET /orgs/:slug — an org the token owner is not in is indistinguishable from a missing one', async () => {
    if (!tokenCanRead) return;

    const missing = await restFetch('GET', `/definitely-not-an-org-${Date.now()}`, undefined, API_TOKEN);
    expect(missing.status, 'a non-existent slug must be a 404').toBe(404);

    if (!FOREIGN_SLUG) {
      console.log('  ⚠ LOREKIT_SMOKE_FOREIGN_SLUG not set — skipping the direct cross-tenant assertion');
      return;
    }
    const foreign = await restFetch('GET', `/${FOREIGN_SLUG}`, undefined, API_TOKEN);
    // 200 = the org leaked. 403 = it did not leak, but its EXISTENCE did, which
    // makes the endpoint an oracle over the slug namespace. Only 404 is correct.
    expect(
      foreign.status,
      `an org the caller is not a member of must return 404, not ${foreign.status} — ` +
        '200 leaks the org, 403 leaks its existence',
    ).toBe(404);
    expect(foreign.status).toBe(missing.status);
  });

  it('DELETE /orgs/:slug — deletes the org created by the token', async () => {
    if (!tokenCanWrite) return;
    const { status } = await restFetch('DELETE', `/${TOKEN_SLUG}`, undefined, API_TOKEN);
    expect(status, `expected 204; got ${status}`).toBe(204);

    if (!tokenCanRead) return;
    const after = await restFetch('GET', `/${TOKEN_SLUG}`, undefined, API_TOKEN);
    expect(after.status, 'a soft-deleted org must disappear from reads').toBe(404);
  });
});
