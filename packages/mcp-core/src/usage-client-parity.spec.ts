import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { DASHBOARD_CLIENT, USAGE_CLIENTS, parseUsageClient } from './usage-stats.js';

/**
 * Drift guard for the `X-LoreKit-Client` contract across the three places that
 * have to agree on it, none of which can import the others.
 *
 * The failure this exists to catch is SILENT. `parseUsageClient` is fail-safe
 * by design: an unrecognised value records no attribution rather than
 * erroring. So if the dashboard's hard-coded `'dashboard'` string, the header
 * name it sends it under, or the literal inside `lorekit_read_activity` ever
 * drift from the canonical vocabulary, nothing throws, nothing 4xxs, and no
 * test fails — the dashboard's reads simply become unattributed again and the
 * "Memories read" card silently resumes counting itself. That is the exact bug
 * migration 00054 fixes, so it deserves an executable guard rather than a
 * comment asking three files to stay in step.
 *
 * The mcp-core ↔ edge copies of `usage-stats.ts` itself are covered by
 * `edge-parity.spec.ts`; this file covers the two NON-mirror consumers (the web
 * dashboard and the SQL migration).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src
const repoRoot = path.resolve(here, '../../..');

const WEB_REST_CLIENT = path.join(repoRoot, 'packages', 'web', 'src', 'lib', 'api', 'rest.ts');
const READ_ACTIVITY_MIGRATION = path.join(
  repoRoot, 'supabase', 'migrations', '00054_usage_event_client.sql',
);
const ROUTER = path.join(repoRoot, 'supabase', 'functions', '_shared', 'api', 'router.ts');
const CORS = path.join(repoRoot, 'packages', 'mcp-core', 'src', 'cors-origins.ts');

const read = (file: string) => readFileSync(file, 'utf8');

describe('usage client vocabulary', () => {
  it('classifies every member and rejects everything else', () => {
    for (const client of USAGE_CLIENTS) expect(parseUsageClient(client)).toBe(client);
    // Fail-safe, not fail-loud: an unknown surface is unattributed.
    expect(parseUsageClient('dash0')).toBeNull();
    expect(parseUsageClient('')).toBeNull();
    expect(parseUsageClient(null)).toBeNull();
    expect(parseUsageClient(undefined)).toBeNull();
    // Bounded: a caller cannot mint a new value and inflate cardinality.
    expect(parseUsageClient('a'.repeat(500))).toBeNull();
    // Forgiving about shape, strict about membership.
    expect(parseUsageClient('  Dashboard  ')).toBe('dashboard');
  });

  it('names the dashboard with a member of the vocabulary', () => {
    expect(USAGE_CLIENTS).toContain(DASHBOARD_CLIENT);
  });
});

describe('usage client contract parity', () => {
  it('the dashboard sends the canonical client value under the canonical header', () => {
    const source = read(WEB_REST_CLIENT);
    expect(source).toContain(`export const DASHBOARD_USAGE_CLIENT = '${DASHBOARD_CLIENT}';`);
    expect(source).toContain(`export const USAGE_CLIENT_HEADER = 'X-LoreKit-Client';`);
    // …and actually attaches it, rather than merely declaring it.
    expect(source).toContain('[USAGE_CLIENT_HEADER]: DASHBOARD_USAGE_CLIENT,');
  });

  it('the router reads the same header name, lower-cased', () => {
    expect(read(ROUTER)).toContain(`export const CLIENT_HEADER = 'x-lorekit-client';`);
  });

  it('the browser is allowed to send the header (preflight)', () => {
    // A custom request header on a cross-origin fetch is preflighted; omitted
    // from Allow-Headers, every dashboard call fails outright.
    expect(read(CORS)).toContain('X-LoreKit-Client');
  });

  it('the read-activity metric excludes exactly the dashboard client', () => {
    const sql = read(READ_ACTIVITY_MIGRATION);
    expect(sql).toContain(`ue.client is distinct from '${DASHBOARD_CLIENT}'`);
    // `is distinct from`, never `<>`: the column is nullable, and `null <>
    // 'dashboard'` is null, which would drop every unattributed event —
    // including every row written before the column existed.
    expect(sql).not.toMatch(/ue\.client\s*<>/);
  });
});
