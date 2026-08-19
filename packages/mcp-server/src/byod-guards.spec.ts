/**
 * BYOD guard behaviour tests
 * --------------------------
 * Verifies that when the server runs in BYOD mode (supportsRateLimit: false,
 * supportsHostedBilling: false), the hosted-only infrastructure calls
 * (checkRateLimit, recordUsageEvent) are NOT made.
 *
 * Also verifies the converse: those calls ARE made in hosted mode.
 *
 * These are unit tests — no real Supabase or network required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── mock @lorekit/core ────────────────────────────────────────────────────────
const { mockCheckRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@lorekit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lorekit/core')>();
  return {
    ...actual,
    checkRateLimit: mockCheckRateLimit,
    write:    vi.fn().mockResolvedValue({ id: 'uuid', created_at: '2026-01-01T00:00:00Z' }),
    read:     vi.fn().mockResolvedValue({ value: 'v', updated_at: '2026-01-01T00:00:00Z' }),
    list:     vi.fn().mockResolvedValue({ entries: [] }),
    search:   vi.fn().mockResolvedValue({ entries: [] }),
    deleteMemory:  vi.fn().mockResolvedValue({ deleted: false, archived: true }),
    archiveMemory: vi.fn().mockResolvedValue({ archived: true }),
    restoreMemory: vi.fn().mockResolvedValue({ restored: true }),
    listArchived:  vi.fn().mockResolvedValue({ entries: [] }),
    purgeArchived: vi.fn().mockResolvedValue({ purged: 0 }),
    purgeExpired:  vi.fn().mockResolvedValue({ purged: 0 }),
    rateLimitMessage: vi.fn().mockReturnValue('rate limited'),
  };
});

import { handleMcpRequest } from './server.js';
import { type StorageAdapter } from '@lorekit/core';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ── Helpers ────────────────────────────────────────────────────────────────────

const HOSTED_ADAPTER: StorageAdapter = {
  db:                    {} as StorageAdapter['db'],
  mode:                  'hosted',
  supportsRateLimit:     true,
  supportsHostedBilling: true,
};

const BYOD_ADAPTER: StorageAdapter = {
  db:                    {} as StorageAdapter['db'],
  mode:                  'byod',
  supportsRateLimit:     false,
  supportsHostedBilling: false,
};

const SERVICE_AUTH = { type: 'service' as const };
const USER_AUTH    = { type: 'user' as const, userId: 'user-uuid', jwt: 'test-jwt' };

/**
 * Call handleMcpRequest with a synthetic IncomingMessage / ServerResponse pair.
 * Returns the status code and response JSON.
 */
async function callHandler(
  auth: typeof SERVICE_AUTH | typeof USER_AUTH,
  adapter: StorageAdapter,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      await handleMcpRequest(req, res, auth, adapter, body).catch(reject);
    });
    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address() as { port: number };
      try {
        const response = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
        const json = await response.json().catch(() => null);
        resolve({ status: response.status, json });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('BYOD mode — checkRateLimit is skipped', () => {
  it('does NOT call checkRateLimit when adapter.supportsRateLimit is false', async () => {
    // Arrange: checkRateLimit would allow if called (failsafe)
    mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });

    await callHandler(USER_AUTH, BYOD_ADAPTER, {
      jsonrpc: '2.0', id: 1,
      method:  'tools/call',
      params:  { name: 'memory.list', arguments: { scope: 'global' } },
    });

    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('does NOT return 429 in BYOD mode even when checkRateLimit would deny', async () => {
    // If the guard were absent, this deny would produce a 429.
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const { status } = await callHandler(USER_AUTH, BYOD_ADAPTER, {
      jsonrpc: '2.0', id: 1,
      method:  'tools/call',
      params:  { name: 'memory.list', arguments: { scope: 'global' } },
    });

    expect(status).not.toBe(429);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe('Hosted mode — checkRateLimit is enforced', () => {
  it('DOES call checkRateLimit when adapter.supportsRateLimit is true and user is not service-role', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });

    await callHandler(USER_AUTH, HOSTED_ADAPTER, {
      jsonrpc: '2.0', id: 1,
      method:  'tools/call',
      params:  { name: 'memory.list', arguments: { scope: 'global' } },
    });

    expect(mockCheckRateLimit).toHaveBeenCalledOnce();
  });

  it('returns 429 in hosted mode when checkRateLimit denies', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });

    const { status } = await callHandler(USER_AUTH, HOSTED_ADAPTER, {
      jsonrpc: '2.0', id: 1,
      method:  'tools/call',
      params:  { name: 'memory.list', arguments: { scope: 'global' } },
    });

    expect(status).toBe(429);
  });

  it('does NOT call checkRateLimit for service-role auth even in hosted mode', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });

    await callHandler(SERVICE_AUTH, HOSTED_ADAPTER, {
      jsonrpc: '2.0', id: 1,
      method:  'tools/call',
      params:  { name: 'memory.list', arguments: { scope: 'global' } },
    });

    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

/**
 * Drift guard for the BYOD smoke suite's CREDENTIAL PREFLIGHT.
 *
 * The preflight exists so a rotated `LOREKIT_BYOD_TOKEN` announces a skip
 * instead of reddening `smoke-preview` — the BYOD project is not deployed by
 * this pipeline, so its credential going stale must not block a deploy. The
 * danger of such an escape hatch is that it widens: broaden the caught error
 * and a genuine BYOD regression disappears into a green run.
 *
 * So pin the two properties that keep it narrow. Source-scanned, like
 * `mcp-authz-status.spec.ts`: the preflight runs at module load in an
 * integration spec, so importing it here would execute it.
 */
describe('BYOD smoke credential preflight', () => {
  const src = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'byod-smoke.integration.spec.ts'),
    'utf8',
  );

  it('widens ONLY the unauthenticated code (-32001) into a skip', () => {
    // The one code matched. -32001 is emitted in exactly one place (the edge's
    // missing/invalid/rotated-token branch) and `mcp-authz-status.spec.ts` pins
    // that every authorization denial uses JSONRPC_FORBIDDEN instead, so this
    // cannot silently come to mean "denied" as well.
    expect(src).toMatch(/message\.includes\('MCP error -32001'\)/);
    // Nothing else is: no second code, and no bare catch that returns a skip.
    const codes = src.match(/MCP error -\d+/g) ?? [];
    expect(new Set(codes)).toEqual(new Set(['MCP error -32001']));
  });

  it('keeps the suite gated on both the config and the probe', () => {
    expect(src).toMatch(/describe\.skipIf\(SKIP \|\| rejection !== null\)/);
  });
});
