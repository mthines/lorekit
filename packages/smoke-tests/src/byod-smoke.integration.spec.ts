/**
 * LoreKit BYOD Smoke Test — Integration
 * --------------------------------------
 * Exercises the full BYOD path: write → read → list → search → delete against a
 * real Supabase project configured as a BYOD database.  Covers all four canonical
 * scope types (global, project, repo, branch) so every routing branch is hit.
 *
 * Skips gracefully when the required environment variables are absent, so the
 * suite never blocks a local dev run or a CI job that hasn't configured the
 * BYOD test project.
 *
 * Required env vars:
 *   LOREKIT_BYOD_URL     Full MCP endpoint URL of the BYOD test project
 *                        e.g. https://<ref>.supabase.co/functions/v1/mcp
 *   LOREKIT_BYOD_TOKEN   lk_rw_* API token for the BYOD project
 *
 * Run standalone:
 *   LOREKIT_BYOD_URL=<url> LOREKIT_BYOD_TOKEN=<token> \
 *     pnpm nx test smoke-tests -- --reporter=verbose --testPathPattern=byod-smoke.integration
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  createSmokeNamespace,
  describeSweepFailures,
  runBestEffortCleanup,
  sweepSmokeArtefacts,
} from './smoke-cleanup.js';
import { testRunHeaders } from './smoke-telemetry.js';

const BASE_URL = (process.env['LOREKIT_BYOD_URL'] ?? '').replace(/\/$/, '');
const TOKEN    = process.env['LOREKIT_BYOD_TOKEN'];

const SKIP = !BASE_URL || !TOKEN;

// Unique run prefix to avoid collisions across concurrent or retried runs.
// Minted through the shared namespace, which throws on a label the orphan
// sweeper would not recognise — a hand-built prefix looks identical today and
// leaks silently the day someone edits it.
const NS = createSmokeNamespace('byod');
const PREFIX = NS.prefix;

// All four canonical scope types.
const SCOPES = {
  global:  'global',
  project: 'project::lorekit-byod-test',
  repo:    'repo::mthines/lorekit',
  branch:  'branch::mthines/lorekit::feat/byod-deno-db-routing',
} as const;

type ScopeName = keyof typeof SCOPES;

// One key per scope — written, then read back, then deleted in afterAll.
const keys: Record<ScopeName, string> = {
  global:  NS.name('global'),
  project: NS.name('project'),
  repo:    NS.name('repo'),
  branch:  NS.name('branch'),
};

// ── MCP JSON-RPC helper (same shape as smoke.integration.spec.ts) ──────────

let _id = 1;

async function mcpCall<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
  const id = _id++;
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      ...testRunHeaders(),
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
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
    error?:  { code: number; message: string };
  };

  if (ct.includes('text/event-stream')) {
    const text     = await res.text();
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

  // Tool-originated failures come back as a SUCCESSFUL result with
  // `isError: true` (MCP spec), not a JSON-RPC error — see mcp-handler.ts.
  // Without this check a rejected tool call (e.g. an invalid scope) resolves
  // with the error text instead of throwing.
  if (envelope.result?.isError) {
    throw new Error(first?.text ?? 'tool call failed');
  }

  if (!first) return null as T;

  try {
    return JSON.parse(first.text) as T;
  } catch {
    return first.text as T;
  }
}

// ── Credential preflight ──────────────────────────────────────────────────────
//
// The BYOD project is NOT deployed by this repository's pipeline — it is a
// third-party Supabase project named only by two secrets, and `deploy.yml`
// documents this suite as OPT-IN coverage whose contract is: an absent
// configuration self-skips, and "only a real BYOD assertion failure fails the
// step". A credential the project no longer accepts is neither: it is the same
// class of condition as the unset secret, and it was failing the step —
// reddening `smoke-preview` and, through the lockstep gate, blocking every
// production deploy on a project outside this pipeline's control.
//
// So probe the credential ONCE before the suite is collected, and turn exactly
// one outcome into an announced skip: JSON-RPC `-32001`. That code is emitted
// in exactly ONE place (`supabase/functions/mcp/index.ts` — missing / invalid /
// rotated token) and `mcp-authz-status.spec.ts` PINS that every authorization
// denial uses `JSONRPC_FORBIDDEN` instead, so `-32001` cannot mean anything but
// "this project does not accept this token". Every other outcome — an HTTP
// error, an unreachable host, a 5xx from the function, a wrong answer — is left
// to fail the suite exactly as it does today, so no functional regression in
// the memory tools can hide behind this.
//
// The skip is LOUD on purpose (console + a GitHub warning annotation): silent
// coverage loss is how a rotated secret stays rotated for weeks.
const READ_PROBE_KEY = NS.name('preflight');

async function credentialRejected(): Promise<string | null> {
  try {
    // A read of a key that was never written: no side effect on the BYOD
    // project, and it exercises the same auth path every test below depends on.
    await mcpCall('memory.read', { scope: SCOPES.global, key: READ_PROBE_KEY });
    return null;
  } catch (err) {
    const message = (err as Error).message;
    // Anything that is not the unauthenticated code is a real failure — hand it
    // back to the suite rather than swallowing it into a skip.
    return message.includes('MCP error -32001') ? message : null;
  }
}

const rejection = SKIP ? null : await credentialRejected();

if (rejection) {
  console.warn(
    '\n  ⚠ BYOD SMOKE SKIPPED — the BYOD project did not accept LOREKIT_BYOD_TOKEN.\n' +
      `    Probe: memory.read against ${BASE_URL} → ${rejection}\n` +
      '    Cause: the token was rotated, revoked, or never created in that project —\n' +
      '    it is a third-party Supabase project this pipeline does not deploy to.\n' +
      '    Effect: this run does NOT verify the BYOD write/read/list/search path.\n' +
      '    Fix: mint a fresh lk_rw_* token in the BYOD project and update the\n' +
      '    LOREKIT_BYOD_TOKEN repository secret (docs/deployment.md).\n',
  );
  if (process.env['GITHUB_ACTIONS']) {
    console.log(
      '::warning title=BYOD smoke skipped::LOREKIT_BYOD_TOKEN was rejected by the BYOD ' +
        'project (MCP -32001). The BYOD path is UNVERIFIED for this deploy — rotate the secret.',
    );
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP || rejection !== null)('LoreKit BYOD smoke tests (integration)', () => {
  // Best-effort cleanup — run regardless of pass/fail so the BYOD project
  // stays tidy across repeated CI runs.
  afterAll(async () => {
    // Keyed by the memory key (what a leak is actually named), with the scope
    // recovered from it, so a reported leftover can be pasted straight into a
    // manual delete.
    const scopeOfKey = new Map<string, string>(
      (Object.keys(SCOPES) as ScopeName[]).map((s) => [keys[s], SCOPES[s]]),
    );
    // The sweep runs with bounded concurrency (see sweepSmokeArtefacts), wrapped
    // in runBestEffortCleanup so a slow teardown against the BYOD endpoint warns
    // and yields instead of failing a green run. `sweeperCovers: false` — the
    // orphan sweeper targets LOREKIT_REST_BASE_URL, and this suite writes to its
    // own project (LOREKIT_BYOD_URL) over MCP, so a leftover must be deleted by
    // hand (named in the warning).
    await runBestEffortCleanup(
      async () => {
        const report = await sweepSmokeArtefacts([...scopeOfKey.keys()], async (key) => {
          await mcpCall('memory.delete', { scope: scopeOfKey.get(key), key, force: true });
        });
        const warning = describeSweepFailures(report, 'BYOD smoke', { sweeperCovers: false });
        if (warning) console.warn(warning);
      },
      { softTimeoutMs: 20_000, context: 'BYOD smoke' },
    );
  }, 30_000);

  // ── 1. Write — all four scope types in parallel ──────────────────────────────
  // Each write uses a scope-specific unique phrase for FTS verification below.

  it('memory.write — global scope', async () => {
    const result = await mcpCall<{ id?: string; created_at?: string }>(
      'memory.write',
      {
        scope: SCOPES.global,
        key:   keys.global,
        value: `BYOD global lesson ${PREFIX} — stored in user-owned Supabase project.`,
        tags:  ['byod', 'smoke', 'global'],
        source_agent: 'byod-smoke-test',
      },
    );
    expect(result).not.toBeNull();
    const hasAck = typeof result?.id === 'string' || typeof result?.created_at === 'string';
    expect(hasAck, `expected id/created_at; got ${JSON.stringify(result)}`).toBe(true);
  });

  it('memory.write — project scope', async () => {
    const result = await mcpCall<{ id?: string; created_at?: string }>(
      'memory.write',
      {
        scope: SCOPES.project,
        key:   keys.project,
        value: `BYOD project lesson ${PREFIX} — project-scoped memory in user's DB.`,
        tags:  ['byod', 'smoke', 'project'],
        source_agent: 'byod-smoke-test',
      },
    );
    expect(result).not.toBeNull();
    const hasAck = typeof result?.id === 'string' || typeof result?.created_at === 'string';
    expect(hasAck, `expected id/created_at; got ${JSON.stringify(result)}`).toBe(true);
  });

  it('memory.write — repo scope', async () => {
    const result = await mcpCall<{ id?: string; created_at?: string }>(
      'memory.write',
      {
        scope: SCOPES.repo,
        key:   keys.repo,
        value: `BYOD repo lesson ${PREFIX} — repo-scoped memory in user's DB.`,
        tags:  ['byod', 'smoke', 'repo'],
        source_agent: 'byod-smoke-test',
      },
    );
    expect(result).not.toBeNull();
    const hasAck = typeof result?.id === 'string' || typeof result?.created_at === 'string';
    expect(hasAck, `expected id/created_at; got ${JSON.stringify(result)}`).toBe(true);
  });

  it('memory.write — branch scope', async () => {
    const result = await mcpCall<{ id?: string; created_at?: string }>(
      'memory.write',
      {
        scope: SCOPES.branch,
        key:   keys.branch,
        value: `BYOD branch lesson ${PREFIX} — branch-scoped memory in user's DB.`,
        tags:  ['byod', 'smoke', 'branch'],
        source_agent: 'byod-smoke-test',
      },
    );
    expect(result).not.toBeNull();
    const hasAck = typeof result?.id === 'string' || typeof result?.created_at === 'string';
    expect(hasAck, `expected id/created_at; got ${JSON.stringify(result)}`).toBe(true);
  });

  // ── 2. Read — verify each scope round-trips correctly ───────────────────────

  it('memory.read — global scope returns written value', async () => {
    const result = await mcpCall<{ value?: string } | string | null>(
      'memory.read',
      { scope: SCOPES.global, key: keys.global },
    );
    const value = typeof result === 'string' ? result : (result as { value?: string })?.value;
    expect(value).toContain(PREFIX);
    expect(value).toContain('global');
  });

  it('memory.read — project scope returns written value', async () => {
    const result = await mcpCall<{ value?: string } | string | null>(
      'memory.read',
      { scope: SCOPES.project, key: keys.project },
    );
    const value = typeof result === 'string' ? result : (result as { value?: string })?.value;
    expect(value).toContain(PREFIX);
    expect(value).toContain('project');
  });

  it('memory.read — repo scope returns written value', async () => {
    const result = await mcpCall<{ value?: string } | string | null>(
      'memory.read',
      { scope: SCOPES.repo, key: keys.repo },
    );
    const value = typeof result === 'string' ? result : (result as { value?: string })?.value;
    expect(value).toContain(PREFIX);
    expect(value).toContain('repo');
  });

  it('memory.read — branch scope returns written value', async () => {
    const result = await mcpCall<{ value?: string } | string | null>(
      'memory.read',
      { scope: SCOPES.branch, key: keys.branch },
    );
    const value = typeof result === 'string' ? result : (result as { value?: string })?.value;
    expect(value).toContain(PREFIX);
    expect(value).toContain('branch');
  });

  // ── 3. Overwrite — confirms upsert semantics work in the BYOD schema ────────

  it('memory.write — overwrites an existing global entry', async () => {
    const updated = `BYOD global lesson ${PREFIX} — UPDATED`;
    await mcpCall('memory.write', {
      scope: SCOPES.global,
      key:   keys.global,
      value: updated,
    });
    const result = await mcpCall<{ value?: string } | string | null>(
      'memory.read',
      { scope: SCOPES.global, key: keys.global },
    );
    const value = typeof result === 'string' ? result : (result as { value?: string })?.value;
    expect(value).toBe(updated);
    // 30s ceiling: unlike every other test here this makes two sequential
    // live round-trips (write + read). A single BYOD write/read has been
    // observed at >3s in CI, so the pair routinely blows the default 5s
    // timeout — matching the sibling smoke suite's 30s ceiling for slow calls.
  }, 30_000);

  // ── 4. List — scope listing returns the written key ────────────────────────

  it('memory.list — global scope includes the written key', async () => {
    const result = await mcpCall<
      { entries?: Array<{ key: string }> } | Array<{ key: string }>
    >('memory.list', { scope: SCOPES.global });
    const entries: Array<{ key: string }> = Array.isArray(result)
      ? result
      : (result as { entries?: Array<{ key: string }> })?.entries ?? [];
    const keys_found = entries.map((e) => e.key);
    expect(keys_found, `expected ${keys.global} in list`).toContain(keys.global);
  });

  it('memory.list — repo scope includes the written key', async () => {
    const result = await mcpCall<
      { entries?: Array<{ key: string }> } | Array<{ key: string }>
    >('memory.list', { scope: SCOPES.repo });
    const entries: Array<{ key: string }> = Array.isArray(result)
      ? result
      : (result as { entries?: Array<{ key: string }> })?.entries ?? [];
    expect(entries.map((e) => e.key)).toContain(keys.repo);
  });

  // ── 5. Search — FTS works in the BYOD schema ────────────────────────────────

  it('memory.search — finds entry by the unique run prefix', async () => {
    const result = await mcpCall<
      { entries?: Array<{ key: string }> } | Array<{ key: string }>
    >('memory.search', { q: PREFIX });
    const entries: Array<{ key: string }> = Array.isArray(result)
      ? result
      : (result as { entries?: Array<{ key: string }> })?.entries ?? [];
    // At minimum the global key written above should surface.
    const found = entries.some((e) => e.key.startsWith(PREFIX));
    expect(found, `expected a key starting with ${PREFIX}; got ${JSON.stringify(entries)}`).toBe(true);
  });

  // ── 6. Delete — soft-archive + read-after-delete ────────────────────────────

  it('memory.delete — soft-archives the global entry', async () => {
    const result = await mcpCall<{ deleted?: boolean; archived?: boolean } | null>(
      'memory.delete',
      { scope: SCOPES.global, key: keys.global },
    );
    const success =
      (result as { archived?: boolean })?.archived === true ||
      (result as { deleted?: boolean })?.deleted === true;
    expect(success, `expected archived/deleted; got ${JSON.stringify(result)}`).toBe(true);
  });

  it('memory.read — archived global entry returns null/absent', async () => {
    const result = await mcpCall<{ value?: unknown } | null>(
      'memory.read',
      { scope: SCOPES.global, key: keys.global },
    );
    const absent =
      result === null ||
      result === undefined ||
      (result as { value?: unknown })?.value === null ||
      (result as { value?: unknown })?.value === undefined;
    expect(absent, `expected null/absent after delete; got ${JSON.stringify(result)}`).toBe(true);
  });

  // ── 7. Invalid scope — BYOD schema enforces the same scope validation ────────

  it('memory.write — rejects an invalid scope format', async () => {
    await expect(
      mcpCall('memory.write', {
        scope: 'not-a-valid-scope',
        key:   'irrelevant',
        value: 'irrelevant',
      }),
    ).rejects.toThrow();
  });
});
