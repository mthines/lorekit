import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Source-scan drift guard for the MCP transport's per-request preamble
 * (`supabase/functions/mcp/index.ts`) — the `tenant-scope-usage.spec.ts`
 * pattern, for the same reason: the Deno edge tree has no test harness, so a
 * property of that source has to be asserted from here or not at all.
 *
 * Two properties, both regressions that were live in production and both
 * invisible to `typecheck` / `test` / `lint`:
 *
 * 1. THE PLAN LOOKUP AND THE RATE-LIMIT CHECK ARE ISSUED CONCURRENTLY.
 *    Both are keyed only on the caller's user id and neither reads the other's
 *    result, so awaiting them in sequence put two serial Supabase round-trips
 *    in front of every MCP message. `_shared/api/router.ts` had already
 *    reached this conclusion for the REST surface ("awaiting it here would put
 *    a serial DB round-trip in front of every single REST request purely for
 *    telemetry") and starts its plan lookup un-awaited; the MCP transport was
 *    the surface that still paid for it serially. The failure mode is pure
 *    latency, so nothing else in the suite goes red when it comes back.
 *
 * 2. THE PLAN LOOKUP IS TRACED.
 *    `getUserPlanName` must be handed the request span so its query emits a
 *    child span like every other edge DB call. Untraced, it was time nobody
 *    could see: `lorekit.mcp` spans reporting 0.885s wall clock with 0.084s
 *    accounted for by children.
 *
 * Neither property has a runtime assertion available to it — a latency
 * regression cannot be asserted deterministically, and a missing span is
 * absent telemetry rather than a wrong value — which is exactly the case this
 * repo already answers with a source scan.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src/mcp-guards
const repoRoot = path.resolve(here, '../../../..');
const indexPath = path.join(repoRoot, 'supabase', 'functions', 'mcp', 'index.ts');
const source = readFileSync(indexPath, 'utf8');

/**
 * Reduce the source to executable lines so a mention inside the explanatory
 * comment above the call site cannot satisfy — or break — any assertion here.
 * Mirrors `edge-parity.spec.ts`'s `executableSource`.
 */
const COMMENT_PREFIXES = ['//', '*', '/*', '*/'];

const executable = source
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .filter((line) => !COMMENT_PREFIXES.some((prefix) => line.startsWith(prefix)))
  .join('\n');

/**
 * The `Promise.all([...])` argument list, or null when there is none. Bracket
 * depth is counted rather than regex-matched so a nested array or call in the
 * argument list cannot end the match early.
 */
function promiseAllArguments(src: string): string | null {
  const marker = 'Promise.all([';
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const open = start + marker.length - 1; // the `[`
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

describe('MCP request preamble (supabase/functions/mcp/index.ts)', () => {
  // Anti-vacuity: every assertion below is about these two calls, so a rename
  // that made them unfindable must fail loudly rather than pass silently.
  it('still calls getUserPlanName and checkRateLimit', () => {
    expect(executable).toContain('getUserPlanName(');
    expect(executable).toContain('checkRateLimit(');
  });

  it('issues the plan lookup and the rate-limit check concurrently', () => {
    const args = promiseAllArguments(executable);
    expect(args, 'the preamble no longer uses Promise.all').not.toBeNull();
    expect(args).toContain('getUserPlanName(');
    expect(args).toContain('checkRateLimit(');
  });

  it('never awaits the plan lookup on its own', () => {
    // `await getUserPlanName(...)` outside a Promise.all is the serial form
    // this guard exists to keep out. Inside Promise.all the call is not
    // preceded by `await`, so this stays specific to the regression.
    expect(executable).not.toMatch(/await\s+getUserPlanName\s*\(/);
  });

  it('never awaits the rate-limit check on its own', () => {
    expect(executable).not.toMatch(/await\s+checkRateLimit\s*\(/);
  });

  it('passes the request span to the plan lookup so the query is traced', () => {
    // Third argument is the parent span; without it the `user_plans` select
    // emits no child span and its latency is unattributable.
    expect(executable).toMatch(/getUserPlanName\(\s*db,\s*auth\.userId,\s*span\s*\)/);
  });
});
