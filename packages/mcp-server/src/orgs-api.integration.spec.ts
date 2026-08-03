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

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createSmokeNamespace, runBestEffortCleanup } from './smoke-cleanup.js';

const BASE = (process.env['LOREKIT_REST_BASE_URL'] ?? 'http://localhost:54321/functions/v1').replace(/\/$/, '');
const JWT = process.env['LOREKIT_SMOKE_JWT'];
const API_TOKEN = process.env['LOREKIT_SMOKE_TOKEN'];
const FOREIGN_SLUG = process.env['LOREKIT_SMOKE_FOREIGN_SLUG'];
const SKIP = !JWT;

/** PostgREST base — same gateway, different mount point. See the memories suite. */
const PGREST = BASE.replace(/\/functions\/v1$/, '/rest/v1');

/**
 * A token's permissions are encoded in its prefix (`packages/mcp-core/src/permissions.ts`):
 * `lk_rw_` = read + write, `lk_ro_` = read only, `lk_wo_` = write only. The org routes
 * are gated on exactly these, so the expectations below branch on the prefix rather than
 * assuming a read-write token.
 *
 * `isLkToken` gates that reasoning. `LOREKIT_SMOKE_TOKEN` is NOT necessarily an `lk_*`
 * token — in CI it is the service-role key, which `resolveRestAuth` resolves to
 * `type: 'service'`, an entirely different auth tier with unconditional access. Deriving
 * "can it read?" from a prefix the value does not have would classify it as write-only and
 * then assert 403 on a request that legitimately returns 200.
 */
const tokenPrefix = API_TOKEN ?? '';
const isLkToken = tokenPrefix.startsWith('lk_');
const tokenCanRead = isLkToken && (tokenPrefix.startsWith('lk_rw_') || tokenPrefix.startsWith('lk_ro_'));
const tokenCanWrite = isLkToken && (tokenPrefix.startsWith('lk_rw_') || tokenPrefix.startsWith('lk_wo_'));

// Slug must be unique and match ^[a-z0-9][a-z0-9-]*[a-z0-9]$. Minted through the
// shared namespace so `scripts/smoke-cleanup.mjs` recognises an orphaned org by
// its slug, and so both suites below share one run identifier.
const NS = createSmokeNamespace('smoke');
const TEST_SLUG = NS.name('test');
const TOKEN_SLUG = NS.name('tok');

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
// Best-effort teardown self-bounds below the hook ceiling: a purge against a
// laggy live endpoint warns and yields instead of timing out the hook and
// failing a run whose assertions passed. See runBestEffortCleanup.
const CLEANUP_SOFT_TIMEOUT = 20_000;

/**
 * ── Org cleanup: PURGE, never DELETE ─────────────────────────────────────────
 *
 * `DELETE /orgs/:slug` maps to `lorekit_org_delete`, which since migration
 * 00025 is a SOFT delete — it stamps `deleted_at` and leaves the row, its
 * memberships and its invites in place. Using it as cleanup meant every smoke
 * run added a permanent org to the live project, and worse, an INVISIBLE one:
 * `lorekit_member_org_ids` filters soft-deleted orgs out of every RLS read, so
 * nothing short of a service-role query could ever find them again.
 *
 * `lorekit_org_purge` (same migration, same owner-only `delete_org` gate) is
 * the real cascading delete. It is SQL-only — no REST route exposes it, by
 * design — so cleanup calls it through PostgREST with the suite's own JWT,
 * which owns every org these tests create.
 *
 * The org id is remembered at CREATE time because a purge after the delete test
 * has run cannot look it up: the org is already hidden from reads.
 */
const createdOrgIds = new Map<string, string>();

/** Record the id from a create response so cleanup can purge by id later. */
function rememberOrg(slug: string, data: unknown): void {
  const id = (data as JsonObj | null)?.id;
  if (typeof id === 'string' && id) createdOrgIds.set(slug, id);
}

async function orgIdFor(slug: string, token: string | null | undefined = JWT): Promise<string | null> {
  const remembered = createdOrgIds.get(slug);
  if (remembered) return remembered;
  // Not remembered (the create test threw before its assertion) — the org may
  // still be live, in which case a read gets us the id.
  const { status, data } = await restFetch('GET', `/${slug}`, undefined, token);
  const id = status === 200 ? (data as JsonObj).id : null;
  return typeof id === 'string' ? id : null;
}

/**
 * Remove one org for good. Reports rather than throws: cleanup runs in
 * `afterAll`, where a throw would mask the suite's real result — but a leak
 * that cannot be cleaned must still be visible in the CI log.
 */
async function purgeOrg(slug: string, token: string | null | undefined = JWT): Promise<void> {
  try {
    const id = await orgIdFor(slug, token);
    if (!id) return; // never created, or already purged — nothing to do.

    // The purge RPC authorises via `auth.uid()`, so it needs the user JWT even
    // when the org was created with an API token (same user, per the suite's
    // documented env contract).
    const res = await fetch(`${PGREST}/rpc/lorekit_org_purge`, {
      method: 'POST',
      headers: {
        apikey: JWT ?? '',
        Authorization: `Bearer ${JWT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_org_id: id }),
    });
    if (res.ok) return;

    // Purge refused (no JWT, or a credential that does not own the org). Fall
    // back to the soft delete so the org at least stops being visible, and say
    // so — the row is now only reachable by the service-role sweep in
    // scripts/smoke-cleanup.mjs.
    console.warn(
      `  ⚠ could not purge org ${slug} (HTTP ${res.status}); falling back to a soft delete. ` +
        'Run `node scripts/smoke-cleanup.mjs` with LOREKIT_SWEEP_SERVICE_ROLE_KEY to remove it.',
    );
    await restFetch('DELETE', `/${slug}`, undefined, token);
  } catch (err) {
    console.warn(`  ⚠ org cleanup for ${slug} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

describe.skipIf(SKIP)('LoreKit orgs API — smoke tests (integration)', { timeout: REMOTE_TEST_TIMEOUT }, () => {
  afterAll(async () => {
    // Purge, not delete — see purgeOrg. The old `DELETE` left a soft-deleted org
    // in the live project on every single run, unreachable by any later read.
    // runBestEffortCleanup soft-bounds the purge below the hook ceiling so a
    // laggy live endpoint can't fail a green run on teardown alone.
    await runBestEffortCleanup(() => purgeOrg(TEST_SLUG), {
      softTimeoutMs: CLEANUP_SOFT_TIMEOUT,
      context: 'orgs REST smoke',
    });
  }, REMOTE_TEST_TIMEOUT);

  // 1. auth: no token → 401/403 ───────────────────────────────────────────────
  it('GET /orgs — returns 401 or 403 when no auth token is provided', async () => {
    const { status } = await restFetch('GET', '/', undefined, null);
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
    if (!isLkToken) {
      console.log(
        `  ⚠ LOREKIT_SMOKE_TOKEN is ${API_TOKEN ? 'not an lk_* token (service-role key?)' : 'not set'}` +
          ' — skipping the lk_* permission assertion. It needs a real API token, since a' +
          ' service-role credential is a different auth tier with unconditional access.',
      );
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
    expect(Array.isArray(d.entries), 'the list response is { entries: [...] }').toBe(true);
  });

  // 4. create ─────────────────────────────────────────────────────────────────
  it('POST /orgs — creates a test org', async () => {
    const { status, data } = await restFetch('POST', '/', {
      slug: TEST_SLUG,
      name: 'Smoke Test Org',
    });
    rememberOrg(TEST_SLUG, data);
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
  const AUDIT_SLUG = NS.name('audit');
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
    await runBestEffortCleanup(() => purgeOrg(AUDIT_SLUG), {
      softTimeoutMs: CLEANUP_SOFT_TIMEOUT,
      context: 'orgs REST audit read-back',
    });
  }, REMOTE_TEST_TIMEOUT);

  it('the audit_log capability probe ran and reported a definite result', () => {
    expect(probeStatus, 'the probe never issued a request').toBeGreaterThan(0);
    expect(auditReadable).toBe(probeStatus === 200);
  });

  it('POST /orgs writes an org.create audit row attributed to the JWT caller', async ({ skip }) => {
    if (!auditReadable) skip();
    const { status, data } = await restFetch('POST', '/', { slug: AUDIT_SLUG, name: ORG_NAME });
    rememberOrg(AUDIT_SLUG, data);
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
 *
 * Gated on `isLkToken`, not merely on a token being present. CI supplies the
 * SERVICE-ROLE key as `LOREKIT_SMOKE_TOKEN`, which `resolveRestAuth` resolves to
 * `type: 'service'` — a different tier that bypasses both the permission gate
 * and the tenant filters this suite exists to exercise. Running it with that
 * credential would not test the api_key path at all; it would just assert the
 * service tier's behaviour under an api_key suite's name.
 */
describe.skipIf(SKIP || !isLkToken)('LoreKit orgs API — api_key tier (integration)', () => {
  afterAll(async () => {
    await runBestEffortCleanup(() => purgeOrg(TOKEN_SLUG, API_TOKEN), {
      softTimeoutMs: CLEANUP_SOFT_TIMEOUT,
      context: 'orgs REST api_key tier',
    });
  }, REMOTE_TEST_TIMEOUT);

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
    rememberOrg(TOKEN_SLUG, data);
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
