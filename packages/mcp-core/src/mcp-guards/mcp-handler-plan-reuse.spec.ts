import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Source-scan drift guard: `tools/call` reuses the plan lookup the transport
 * preamble already made, instead of repeating it untraced.
 *
 * `mcp/index.ts` resolves the caller's plan for every authenticated hosted
 * request (see `mcp-preamble-usage.spec.ts`). `mcp/mcp-handler.ts` then needs
 * the same plan inside `tools/call` for the `lorekit.plan` attribute and the
 * usage event. It used to call `getUserPlanName(db, userId)` with no span: a
 * second serial `user_plans` round trip per tool call, invisible inside the
 * `lorekit.<tool>` span (~144 ms of unexplained time before the tool's first
 * query in production).
 *
 * The fix has two halves, one per file, and both are needed:
 * 1. `_shared/telemetry/usage.ts` memoises `getUserPlanName` per request span
 *    (a WeakMap keyed on the span — the db client cannot be the key, since
 *    `getDb` builds a new one per call).
 * 2. `mcp-handler.ts` passes the request span, so the call hits that memo, and
 *    on a miss (BYOD, where the preamble skips the lookup) runs traced.
 *
 * Neither half has a runtime assertion CI can run: the edge tree has no test
 * job (`usage.plan-memo.test.ts` covers the memo's behaviour under Deno, run by
 * hand), and the regression is latency plus missing telemetry, not a wrong
 * value.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src/mcp-guards
const repoRoot = path.resolve(here, '../../../..');
const fnRoot = path.join(repoRoot, 'supabase', 'functions');

/** Executable lines only — mirrors `mcp-preamble-usage.spec.ts`. */
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
const usage = executable('_shared/telemetry/usage.ts');

describe('tools/call reuses the request plan lookup', () => {
  // Anti-vacuity: a rename that made the calls unfindable must fail loudly.
  it('mcp-handler.ts still calls getUserPlanName, and usage.ts still defines it', () => {
    expect(handler).toContain('getUserPlanName(');
    expect(usage).toMatch(/export (async )?function getUserPlanName\(/);
  });

  it('mcp-handler.ts passes the request span as the third argument', () => {
    // `span` is handleMcp's request-span parameter — the same object index.ts
    // passed to its own lookup, and therefore the memo key.
    expect(handler).toMatch(/getUserPlanName\(\s*db,\s*analyticsUserId,\s*span\s*\)/);
    // Every call in the handler is spanned; a two-argument call is the regression.
    expect(handler).not.toMatch(/getUserPlanName\(\s*[^,()]+,\s*[^,()]+\s*\)/);
  });

  it('usage.ts memoises the lookup per span in a WeakMap', () => {
    expect(usage).toMatch(/new WeakMap<Span,/);
  });
});
