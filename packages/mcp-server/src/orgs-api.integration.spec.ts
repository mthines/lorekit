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

import { describe, it, expect, afterAll, beforeAll } from 'vitest';

const BASE = (process.env['LOREKIT_REST_BASE_URL'] ?? 'http://localhost:54321/functions/v1').replace(/\/$/, '');
const JWT = process.env['LOREKIT_SMOKE_JWT'];
const API_TOKEN = process.env['LOREKIT_SMOKE_TOKEN']; // optional — lk_* token for 403 assertion
const SKIP = !JWT;

/** PostgREST base — same gateway, different mount point. See the memories suite. */
const PGREST = BASE.replace(/\/functions\/v1$/, '/rest/v1');

// Slug must be unique and match ^[a-z0-9][a-z0-9-]*[a-z0-9]$
const TEST_SLUG = `smoke-${Date.now()}-test`;

type JsonObj = Record<string, unknown>;

/**
 * `token` defaults to the suite's JWT. Pass `null` — NOT `undefined` — to send
 * no credential at all: a JS default parameter is applied whenever the argument
 * is `undefined`, so `restFetch('GET', '/', undefined, undefined)` silently
 * sent the JWT and the "no auth token" case asserted nothing. It only ever
 * looked green because the whole suite was skipped for want of a JWT.
 */
async function restFetch(
  method: string,
  path: string,
  body?: unknown,
  token: string | null | undefined = JWT,
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

// Live-endpoint suite (hosted preview in the deploy pipeline): the org
// lifecycle cases chain several sequential RPC round-trips, which overrun
// vitest's 5s default at hosted latency though each call succeeds. Ceiling per
// test, not an expected duration; sub-ms locally so it never bites there.
const REMOTE_TEST_TIMEOUT = 30_000;

describe.skipIf(SKIP)('LoreKit orgs API — smoke tests (integration)', { timeout: REMOTE_TEST_TIMEOUT }, () => {
  afterAll(async () => {
    // Best-effort cleanup — delete the test org if it still exists.
    // Hooks use hookTimeout (10s default), not the suite `timeout`; give this
    // live-endpoint cleanup the same 30s ceiling.
    await restFetch('DELETE', `/${TEST_SLUG}`).catch(() => undefined);
  }, REMOTE_TEST_TIMEOUT);

  // 1. auth: no token → 401/403 ───────────────────────────────────────────────
  it('GET /orgs — returns 401 or 403 when no auth token is provided', async () => {
    const { status } = await restFetch('GET', '/', undefined, null);
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
    expect(Array.isArray(d.entries), 'the list response is { entries: [...] }').toBe(true);
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
    expect(Array.isArray(d.entries), 'the member list response is { entries: [...] }').toBe(true);
  });

  // 8. list invites ───────────────────────────────────────────────────────────
  it('GET /orgs/:slug/invites — returns invite list', async () => {
    const { status, data } = await restFetch('GET', `/${TEST_SLUG}/invites`);
    expect(status, `expected 200; got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const d = data as JsonObj;
    expect(Array.isArray(d.entries), 'the invite list response is { entries: [...] }').toBe(true);
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
 * Org audit-trail read-back — the end-to-end proof of the `auditUserId` fix
 * -------------------------------------------------------------------------
 * Two things are being verified here that nothing else can verify:
 *
 *  1. The seven mutating `orgs` routes now call `recordAudit` at all. The
 *     structural guard (`packages/mcp-core/src/audit-coverage.spec.ts`) proves
 *     the CALL exists in the source; only a live run proves the ROW lands.
 *
 *  2. That the row lands FOR A JWT CALLER — which is the whole point of the
 *     `auditUserId` change. Every org route is `requires: 'jwt'`, so its db
 *     client is the RLS-scoped one and `rls_audit_log_insert`'s
 *     `with check (user_id = auth.uid())` applies. Under the old rule
 *     (`null` for JWT) EVERY assertion below would fail: the insert would be
 *     refused by the policy and swallowed by the non-throwing `recordAudit`.
 *     These tests therefore fail closed against a regression of that fix.
 *
 * The credential model allows it: a Supabase user JWT can read `audit_log`
 * through PostgREST because `rls_audit_log_select` is `user_id = auth.uid()`
 * and the rows this suite writes are that user's own. Readability is still
 * probed rather than assumed, and a failed probe skips with a loud warning.
 *
 * NOTE: `.github/workflows/ci.yml` does NOT set `LOREKIT_SMOKE_JWT`, so this
 * whole file (pre-existing behaviour, unchanged here) does not run in CI.
 */
describe.skipIf(SKIP)('LoreKit orgs API — audit trail read-back (integration)', { timeout: REMOTE_TEST_TIMEOUT }, () => {
  const AUDIT_SLUG = `smoke-${Date.now()}-audit`;
  const ORG_NAME = 'Audit Read-Back Org';
  const startedAt = new Date().toISOString();
  let auditReadable = false;
  let probeStatus = 0;
  let orgId = '';

  type JsonRow = Record<string, unknown>;

  async function pgRest(pathAndQuery: string): Promise<{ status: number; rows: JsonRow[] }> {
    const res = await fetch(`${PGREST}${pathAndQuery}`, {
      headers: { apikey: JWT ?? '', Authorization: `Bearer ${JWT}`, Accept: 'application/json' },
    });
    const text = await res.text();
    let rows: JsonRow[] = [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) rows = parsed as JsonRow[];
    } catch { /* status is the signal */ }
    return { status: res.status, rows };
  }

  async function findAuditRow(query: string, attempts = 12): Promise<JsonRow | undefined> {
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
  async function requireAuditRow(query: string, what: string): Promise<JsonRow> {
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
        '\n  ⚠ ORG AUDIT READ-BACK SKIPPED — audit_log is NOT readable with this credential.\n' +
          `    Probe: GET ${PGREST}/audit_log → HTTP ${probe.status}.\n` +
          '    Expected LOREKIT_SMOKE_JWT to be a Supabase user JWT, which can read its OWN\n' +
          '    audit rows via rls_audit_log_select (user_id = auth.uid()).\n' +
          '    Effect: this run does NOT verify that the orgs handlers write audit rows,\n' +
          '    nor that auditUserId attributes a JWT caller correctly.\n',
      );
    }
  });

  afterAll(async () => {
    await restFetch('DELETE', `/${AUDIT_SLUG}`).catch(() => undefined);
  }, REMOTE_TEST_TIMEOUT);

  it('the audit_log capability probe ran and reported a definite result', () => {
    expect(probeStatus, 'the probe never issued a request').toBeGreaterThan(0);
    expect(auditReadable).toBe(probeStatus === 200);
  });

  it('POST /orgs writes an org.create audit row attributed to the JWT caller', async ({ skip }) => {
    if (!auditReadable) skip();
    const { status, data } = await restFetch('POST', '/', { slug: AUDIT_SLUG, name: ORG_NAME });
    expect(status, `expected 201; got ${status}: ${JSON.stringify(data)}`).toBe(201);

    const found = await requireAuditRow(`action=eq.org.create&target=eq.${encodeURIComponent(ORG_NAME)}`,
      'org.create (absent means auditUserId may have regressed to null for JWT callers)');
    expect(found.resource_type).toBe('org');
    expect((found.metadata as JsonRow).slug).toBe(AUDIT_SLUG);
    // THE assertion the fix exists for: the row is attributed, not null. A null
    // actor could not have satisfied rls_audit_log_insert in the first place,
    // so reaching this line at all already proves it — this pins it explicitly.
    expect(found.user_id, 'a JWT caller\'s audit row must name that user').not.toBeNull();
    orgId = found.resource_id as string;
    expect(orgId, 'org.create must record the new org id').toBeTruthy();
  });

  it('PATCH /orgs/:slug writes an org.rename audit row', async ({ skip }) => {
    if (!auditReadable) skip();
    const renamed = `${ORG_NAME} (renamed)`;
    const { status } = await restFetch('PATCH', `/${AUDIT_SLUG}`, { name: renamed });
    expect(status).toBe(200);

    const found = await requireAuditRow(`action=eq.org.rename&target=eq.${encodeURIComponent(renamed)}`, 'org.rename');
    expect(found.resource_type).toBe('org');
    expect(found.resource_id, 'rename must reference the same org id as create').toBe(orgId);
  });

  it('POST /orgs/:slug/invites writes a member.invite audit row', async ({ skip }) => {
    if (!auditReadable) skip();
    const invitee = `audit-invitee-${Date.now()}@example.com`;
    const { status, data } = await restFetch('POST', `/${AUDIT_SLUG}/invites`, {
      email: invitee, role: 'member',
    });
    expect(status, `expected 201; got ${status}: ${JSON.stringify(data)}`).toBe(201);
    const inviteId = (data as JsonRow).inviteId as string;

    const found = await requireAuditRow(`action=eq.member.invite&resource_id=eq.${inviteId}`, 'member.invite');
    expect(found.resource_type).toBe('org_invite');
    expect(found.target, 'the invite row targets the org').toBe(orgId);
    expect((found.metadata as JsonRow).invitee).toBe(invitee);
    expect((found.metadata as JsonRow).role).toBe('member');

    // …and revoking it writes member.revoke.
    const del = await restFetch('DELETE', `/${AUDIT_SLUG}/invites/${inviteId}`);
    expect(del.status).toBe(204);
    const revokedRow = await requireAuditRow(`action=eq.member.revoke&resource_id=eq.${inviteId}`, 'member.revoke');
    expect(revokedRow.resource_type).toBe('org_invite');
  });

  it('DELETE /orgs/:slug writes an org.delete audit row', async ({ skip }) => {
    if (!auditReadable) skip();
    const { status } = await restFetch('DELETE', `/${AUDIT_SLUG}`);
    expect(status).toBe(204);

    const found = await requireAuditRow(`action=eq.org.delete&resource_id=eq.${orgId}`, 'org.delete');
    expect(found.resource_type).toBe('org');
  });

  it('the org actions it wrote are all admitted by the audit_log action CHECK', async ({ skip }) => {
    if (!auditReadable) skip();
    // A CHECK-rejected action never reaches the table, so the presence of all
    // four is itself the assertion that the vocabulary admits them.
    const { rows } = await pgRest(`/audit_log?created_at=gte.${startedAt}&select=action&limit=200`);
    const actions = new Set(rows.map((r) => r.action as string));
    for (const expected of ['org.create', 'org.rename', 'member.invite', 'member.revoke', 'org.delete']) {
      expect(actions, `${expected} never landed in audit_log`).toContain(expected);
    }
  });

  /**
   * The POSITIVE `usage_events` assertion — only reachable from this suite.
   *
   * `_shared/api/router.ts` records an event only when `analyticsUserId(auth)`
   * resolves, i.e. for `api_key` and JWT callers and never for service-role.
   * The memories suite runs under the service-role key, so it can only assert
   * the negative (zero rows). This suite runs under a real user JWT, so it is
   * the one place the recording path itself can be proven.
   *
   * Both halves work under RLS without a service-role read: the writer
   * (`lorekit_record_usage_event`, 00034) is SECURITY DEFINER so the insert
   * clears the table's insert-less policy set, and `rls_usage_events_select`
   * is `user_id = auth.uid()` so this caller can read exactly its own rows.
   */
  it('a JWT caller records usage_events for the org routes it called', async ({ skip }) => {
    if (!auditReadable) skip();
    const { status, rows } = await pgRest(
      `/usage_events?created_at=gte.${startedAt}&select=tool_name,auth_type,outcome&limit=200`,
    );
    expect(status, 'usage_events must be readable with this JWT').toBe(200);
    expect(rows.length, 'a JWT caller must record usage events').toBeGreaterThan(0);

    // RLS already scopes these to this caller, so every row is ours.
    for (const r of rows) {
      expect(r.auth_type, 'a JWT caller must be recorded as jwt, not user/api_key/service').toBe('jwt');
    }

    // `restToolName` maps each org route onto the MCP tool it is the
    // equivalent of, so both surfaces aggregate as one series. This suite
    // creates an org, so that mapping must have produced `org.create`.
    const toolNames = new Set(rows.map((r) => r.tool_name as string));
    expect(toolNames, `expected org.create among ${[...toolNames].join(', ')}`).toContain('org.create');

    // A successful call must not be filed as a failure — that would quietly
    // corrupt every error-rate rollup built on this table.
    expect(rows.some((r) => r.outcome === 'ok'), 'no successful call was recorded as ok').toBe(true);
  });
});
