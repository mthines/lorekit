/**
 * LoreKit MCP Smoke Test — Integration
 * -------------------------------------
 * Exercises all five memory tools end-to-end against a live LoreKit MCP
 * endpoint over Streamable HTTP.  Runs in CI (and locally) when the required
 * environment variables are present; skips gracefully otherwise.
 *
 * Required env vars:
 *   LOREKIT_SMOKE_TOKEN   Bearer token (service-role key or user JWT)
 *   LOREKIT_SMOKE_URL     Full MCP endpoint URL
 *                         e.g. https://<ref>.supabase.co/functions/v1/mcp
 *                         Defaults to http://localhost:3000/mcp
 *
 * Run standalone:
 *   LOREKIT_SMOKE_TOKEN=<token> LOREKIT_SMOKE_URL=<url> \
 *     pnpm nx test mcp-server -- --reporter=verbose --testPathPattern=smoke.integration
 */

import { describe, it, expect, afterAll } from 'vitest';

const BASE_URL = (process.env['LOREKIT_SMOKE_URL'] ?? 'http://localhost:3000/mcp').replace(/\/$/, '');
const TOKEN = process.env['LOREKIT_SMOKE_TOKEN'];

const SKIP = !TOKEN;

// Unique prefix so parallel runs (and prior failed runs) don't collide.
const KEY_PREFIX = `smoke-${Date.now()}`;
const SCOPE = 'global';
const KEY_A = `${KEY_PREFIX}-a`;
const KEY_B = `${KEY_PREFIX}-b`;

// ── MCP JSON-RPC helper ──────────────────────────────────────────────────────

let _id = 1;

async function mcpCall<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
  const id = _id++;
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`HTTP ${res.status}: ${body}`);
  }

  const ct = res.headers.get('content-type') ?? '';

  let envelope: {
    result?: { content?: Array<{ type: string; text: string }> };
    error?: { code: number; message: string };
  };

  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) throw new Error('SSE stream contained no data line');
    envelope = JSON.parse(dataLine.slice(5).trim());
  } else {
    envelope = (await res.json()) as typeof envelope;
  }

  if (envelope.error) {
    throw new Error(`MCP error ${envelope.error.code}: ${envelope.error.message}`);
  }

  const first = envelope.result?.content?.[0];
  if (!first) return null as T;

  try {
    return JSON.parse(first.text) as T;
  } catch {
    return first.text as T;
  }
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('LoreKit MCP smoke tests (integration)', () => {
  // Best-effort cleanup — runs regardless of pass/fail.
  afterAll(async () => {
    for (const key of [KEY_A, KEY_B]) {
      await mcpCall('memory.delete', { scope: SCOPE, key }).catch(() => {});
    }
  });

  // 1. write — create ─────────────────────────────────────────────────────────
  it('memory.write — creates a new entry', async () => {
    const result = await mcpCall<{ id?: string; created_at?: string; ok?: boolean }>(
      'memory.write',
      { scope: SCOPE, key: KEY_A, value: 'smoke-alpha' },
    );
    expect(result).not.toBeNull();
    const hasAck =
      typeof result?.id === 'string' ||
      typeof result?.created_at === 'string' ||
      result?.ok === true;
    expect(hasAck, `expected id/created_at/ok; got: ${JSON.stringify(result)}`).toBe(true);
  });

  // 2. write — second key ─────────────────────────────────────────────────────
  it('memory.write — creates a second entry', async () => {
    const result = await mcpCall<{ id?: string; created_at?: string; ok?: boolean }>(
      'memory.write',
      { scope: SCOPE, key: KEY_B, value: `smoke-beta unique-phrase-${KEY_PREFIX}` },
    );
    expect(result).not.toBeNull();
  });

  // 3. write — overwrite ──────────────────────────────────────────────────────
  it('memory.write — overwrites an existing entry', async () => {
    const result = await mcpCall<{ id?: string; created_at?: string; ok?: boolean }>(
      'memory.write',
      { scope: SCOPE, key: KEY_A, value: 'smoke-alpha-updated' },
    );
    expect(result).not.toBeNull();
  });

  // 4. read — verify overwrite ────────────────────────────────────────────────
  it('memory.read — returns the overwritten value', async () => {
    const result = await mcpCall<{ value?: string } | string | null>(
      'memory.read',
      { scope: SCOPE, key: KEY_A },
    );
    expect(result).not.toBeNull();
    const value =
      typeof result === 'string' ? result : (result as { value?: string })?.value;
    expect(value).toBe('smoke-alpha-updated');
  });

  // 5. list — scope listing ───────────────────────────────────────────────────
  it('memory.list — returns entries for the scope including both keys', async () => {
    const result = await mcpCall<
      { entries?: Array<{ key: string }> } | Array<{ key: string }>
    >('memory.list', { scope: SCOPE });
    const entries: Array<{ key: string }> = Array.isArray(result)
      ? result
      : (result as { entries?: Array<{ key: string }> })?.entries ?? [];
    const keys = entries.map((e) => e.key);
    expect(keys, `expected ${KEY_A} in list`).toContain(KEY_A);
    expect(keys, `expected ${KEY_B} in list`).toContain(KEY_B);
  });

  // 6. search — full-text ─────────────────────────────────────────────────────
  it('memory.search — finds the entry by unique phrase', async () => {
    const result = await mcpCall<
      { entries?: Array<{ key: string }> } | Array<{ key: string }>
    >('memory.search', { q: `unique-phrase-${KEY_PREFIX}` });
    const entries: Array<{ key: string }> = Array.isArray(result)
      ? result
      : (result as { entries?: Array<{ key: string }> })?.entries ?? [];
    const found = entries.some((e) => e.key === KEY_B);
    expect(found, `expected ${KEY_B} in results; got: ${JSON.stringify(entries)}`).toBe(true);
  });

  // 7. delete ─────────────────────────────────────────────────────────────────
  it('memory.delete — removes an entry and reports success', async () => {
    const result = await mcpCall<{ deleted?: boolean; ok?: boolean } | boolean | null>(
      'memory.delete',
      { scope: SCOPE, key: KEY_A },
    );
    const deleted =
      result === true ||
      (result as { deleted?: boolean })?.deleted === true ||
      (result as { ok?: boolean })?.ok === true;
    expect(deleted, `expected delete success; got: ${JSON.stringify(result)}`).toBe(true);
  });

  // 8. read after delete ──────────────────────────────────────────────────────
  it('memory.read — deleted key returns null/absent', async () => {
    const result = await mcpCall<{ value?: unknown } | null>(
      'memory.read',
      { scope: SCOPE, key: KEY_A },
    );
    const absent =
      result === null ||
      result === undefined ||
      (result as { value?: unknown })?.value === null ||
      (result as { value?: unknown })?.value === undefined;
    expect(absent, `expected null/absent; got: ${JSON.stringify(result)}`).toBe(true);
  });

  // 9. invalid scope — must error ─────────────────────────────────────────────
  it('memory.write — rejects an unknown scope type', async () => {
    await expect(
      mcpCall('memory.write', {
        scope: 'this-scope-does-not-exist',
        key: 'irrelevant',
        value: 'irrelevant',
      }),
    ).rejects.toThrow();
  });
});
