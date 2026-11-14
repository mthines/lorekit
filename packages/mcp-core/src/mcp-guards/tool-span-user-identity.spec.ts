import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Source-scan drift guard: the caller's `auth.user_id` is stamped on the
 * per-operation span, not only on the root request span.
 *
 * Both surfaces already put `auth.user_id` on their ROOT span (`lorekit.mcp`
 * in `mcp/index.ts`, `lorekit.memories` / `lorekit.orgs` in
 * `_shared/api/router.ts`). The facts a per-user view needs are written one
 * level down, on the operation span:
 *
 * - MCP `lorekit.memory.write` — `lorekit.write.inserted`, `lorekit.source_agent`
 * - MCP `lorekit.memory.quota` and REST `lorekit.memories.get/quota` —
 *   `lorekit.memory.count`, `lorekit.memory.limit`
 *
 * Span metrics (Dash0's `dash0.spans`, any spanmetrics connector) group one
 * span's attributes at a time and cannot join a child to its parent, so
 * without the id on the operation span "memories held per user" and "new
 * memories per user" are unanswerable without a trace join.
 *
 * The edge tree has no test job, and the regression is missing telemetry, not
 * a wrong value — nothing else in the suite goes red if a refactor drops it.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src/mcp-guards
const repoRoot = path.resolve(here, '../../../..');
const fnRoot = path.join(repoRoot, 'supabase', 'functions');

/** Executable lines only — mirrors `mcp-handler-plan-reuse.spec.ts`. */
const COMMENT_PREFIXES = ['//', '*', '/*', '*/'];
function executable(relPath: string): string {
  return readFileSync(path.join(fnRoot, relPath), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !COMMENT_PREFIXES.some((prefix) => line.startsWith(prefix)))
    .join('\n');
}

const handler = executable('mcp/mcp-handler.ts');
const router = executable('_shared/api/router.ts');

describe('MCP tool span carries the caller (mcp/mcp-handler.ts)', () => {
  // Anti-vacuity: a rename that made the span or the id unfindable must fail loudly.
  it('still creates the tool span and still resolves analyticsUserId', () => {
    expect(handler).toMatch(/const toolSpan = span\.child\(`lorekit\.\$\{toolName\}`/);
    expect(handler).toMatch(/const analyticsUserId = /);
  });

  it('stamps auth.user_id on the tool span, guarded so it is absent rather than empty', () => {
    expect(handler).toMatch(
      /if \(analyticsUserId\) toolSpan\.setAttributes\(\{ 'auth\.user_id': analyticsUserId \}\);/,
    );
  });
});

describe('REST handler span carries the caller (_shared/api/router.ts)', () => {
  it('still creates the handler span and still passes it to the route handler', () => {
    expect(router).toMatch(/const hs = span\.child\(/);
    expect(router).toContain('route.handler(req, resolved.auth, resolved.db, hs, params, cors)');
  });

  it('stamps auth.user_id on the handler span, guarded so it is absent rather than empty', () => {
    expect(router).toMatch(
      /if \(usageUserId !== null\) hs\.setAttributes\(\{ 'auth\.user_id': usageUserId \}\);/,
    );
  });
});

describe('no placeholder user id on either surface', () => {
  it('never writes an empty or defaulted auth.user_id', () => {
    for (const src of [handler, router]) {
      expect(src).not.toMatch(/'auth\.user_id':\s*''/);
      expect(src).not.toMatch(/'auth\.user_id':\s*[^,}]+\?\?\s*''/);
    }
  });
});
