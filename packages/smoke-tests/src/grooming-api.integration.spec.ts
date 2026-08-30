/**
 * LoreKit retention-policy ("grooming") REST API — integration smoke test
 * -------------------------------------------------------------------------
 * Exercises `/policies`, `/groom/preview`, `/groom/run`, and `/protect` end
 * to end against a live LoreKit instance. Self-skips when the required env
 * vars are absent — the same contract every other suite in this package
 * follows.
 *
 * Required env vars:
 *   LOREKIT_SMOKE_TOKEN      Bearer token (service-role key, lk_* API token, or user JWT)
 *   LOREKIT_REST_BASE_URL    Base URL, e.g. https://<ref>.supabase.co/functions/v1
 *                            Defaults to http://localhost:54321/functions/v1
 *
 * Run standalone:
 *   LOREKIT_SMOKE_TOKEN=<token> LOREKIT_REST_BASE_URL=<url> \
 *     pnpm nx test smoke-tests -- --reporter=verbose --testPathPattern=grooming-api.integration
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  createSmokeNamespace,
  describeSweepFailures,
  runBestEffortCleanup,
  sweepSmokeArtefacts,
} from './smoke-cleanup.js';
import { testRunHeaders } from './smoke-telemetry.js';

const BASE = (process.env['LOREKIT_REST_BASE_URL'] ?? 'http://localhost:54321/functions/v1').replace(/\/$/, '');
const TOKEN = process.env['LOREKIT_SMOKE_TOKEN'];
const SKIP = !TOKEN;

type JsonObj = Record<string, unknown>;

// Reuses the 'memories' label — grooming operates on memories, and the
// closed-set SMOKE_ARTEFACT_PATTERN already admits it, so no new prefix
// needs registering in the pattern or its standalone-sweeper mirror.
const NS = createSmokeNamespace('memories');
// A scope unique to this run, so groom/preview + groom/run never touch a
// memory this suite did not create.
const SCOPE = `project::${NS.prefix.replace(/-$/, '')}`;
const KEY_A = NS.name('groom-a');

const REMOTE_TEST_TIMEOUT = 30_000;
const CLEANUP_SOFT_TIMEOUT = 20_000;

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

async function hardDeleteKey(key: string): Promise<void> {
  const { status, data } = await api('DELETE', `/?scope=${SCOPE}&key=${encodeURIComponent(key)}&force=true`);
  if (status !== 204 && status !== 404) {
    throw new Error(`DELETE ${key} → HTTP ${status}: ${JSON.stringify(data)}`);
  }
}

let createdPolicyId: string | null = null;
async function deletePolicy(): Promise<void> {
  if (!createdPolicyId) return;
  await api('DELETE', `/policies/${createdPolicyId}`);
  createdPolicyId = null;
}

describe.skipIf(SKIP)('LoreKit grooming API — smoke tests (integration)', { timeout: REMOTE_TEST_TIMEOUT }, () => {
  afterAll(async () => {
    await runBestEffortCleanup(
      async () => {
        await deletePolicy();
        const report = await sweepSmokeArtefacts(NS.minted(), hardDeleteKey);
        const warning = describeSweepFailures(report, 'grooming-api.integration afterAll');
        if (warning) console.warn(warning);
      },
      { softTimeoutMs: CLEANUP_SOFT_TIMEOUT, context: 'grooming-api.integration afterAll' },
    );
  });

  it('creates a memory to groom', async () => {
    const { status, data } = await api('POST', '/', { scope: SCOPE, key: KEY_A, value: 'grooming smoke test' });
    expect(status, `create ${KEY_A}: expected 201; got ${status}: ${JSON.stringify(data)}`).toBe(201);
  });

  it('groom/preview finds the memory, unconditionally in-scope', async () => {
    const { status, data } = await api('POST', '/groom/preview', { scope: SCOPE });
    expect(status, `groom/preview: got ${status}: ${JSON.stringify(data)}`).toBe(200);
    const keys = ((data as JsonObj).keys as JsonObj[]).map((k) => k.key);
    expect(keys).toContain(KEY_A);
  });

  it('protect excludes the memory from groom/preview', async () => {
    const protectRes = await api('POST', '/protect', { scope: SCOPE, key: KEY_A, protected: true });
    expect(protectRes.status, `protect: got ${protectRes.status}: ${JSON.stringify(protectRes.data)}`).toBe(200);
    expect((protectRes.data as JsonObj).protected).toBe(true);

    const { status, data } = await api('POST', '/groom/preview', { scope: SCOPE });
    expect(status).toBe(200);
    const keys = ((data as JsonObj).keys as JsonObj[]).map((k) => k.key);
    expect(keys).not.toContain(KEY_A);
  });

  it('unprotect restores it to groom/preview, then groom/run archives it', async () => {
    const unprotectRes = await api('POST', '/protect', { scope: SCOPE, key: KEY_A, protected: false });
    expect(unprotectRes.status).toBe(200);
    expect((unprotectRes.data as JsonObj).protected).toBe(false);

    const preview = await api('POST', '/groom/preview', { scope: SCOPE });
    expect(preview.status).toBe(200);
    expect(((preview.data as JsonObj).keys as JsonObj[]).map((k) => k.key)).toContain(KEY_A);

    const run = await api('POST', '/groom/run', { scope: SCOPE });
    expect(run.status, `groom/run: got ${run.status}: ${JSON.stringify(run.data)}`).toBe(200);
    const archivedKeys = ((run.data as JsonObj).keys as JsonObj[]).map((k) => k.key);
    expect(archivedKeys).toContain(KEY_A);

    const archivedList = await api('GET', `/?scope=${SCOPE}&archived=true&limit=100`);
    expect(archivedList.status).toBe(200);
    expect(((archivedList.data as JsonObj).entries as JsonObj[]).map((e) => e.key)).toContain(KEY_A);
  });

  it('policy CRUD round-trips: create, list, update, delete', async () => {
    const create = await api('POST', '/policies', {
      scope: SCOPE,
      name: `${NS.prefix}policy`,
      mode: 'review',
      min_age_days: 30,
    });
    expect(create.status, `policy create: got ${create.status}: ${JSON.stringify(create.data)}`).toBe(200);
    const policy = create.data as JsonObj;
    expect(policy.scope).toBe(SCOPE);
    createdPolicyId = policy.id as string;

    const list = await api('GET', '/policies');
    expect(list.status).toBe(200);
    const ids = ((list.data as JsonObj).entries as JsonObj[]).map((p) => p.id);
    expect(ids).toContain(createdPolicyId);

    const update = await api('PATCH', `/policies/${createdPolicyId}`, { enabled: true, mode: 'auto' });
    expect(update.status, `policy update: got ${update.status}: ${JSON.stringify(update.data)}`).toBe(200);
    expect((update.data as JsonObj).mode).toBe('auto');
    expect((update.data as JsonObj).enabled).toBe(true);

    const del = await api('DELETE', `/policies/${createdPolicyId}`);
    expect(del.status, `policy delete: got ${del.status}: ${JSON.stringify(del.data)}`).toBe(200);
    createdPolicyId = null;

    const listAfter = await api('GET', '/policies');
    expect(listAfter.status).toBe(200);
    expect(((listAfter.data as JsonObj).entries as JsonObj[]).map((p) => p.id)).not.toContain(policy.id);
  });
});
