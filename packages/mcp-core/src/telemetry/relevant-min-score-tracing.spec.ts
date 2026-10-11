import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Source-scan guard for the `min_score` telemetry on `GET /memories/relevant`
 * (`supabase/functions/memories/handlers/relevant.ts`) — the
 * `rest-auth-tracing.spec.ts` pattern, because the Deno edge tree has no test
 * harness of its own.
 *
 * Migration 00112 graded relevance, which removed the `(1 + 0.5) / 4 = 0.375`
 * floor every matched hit used to sit on. A `min_score` tuned against the old
 * behaviour now drops hits it used to keep, and before these two attributes
 * the span could not show it: `result_count < min(limit, candidate_count)`
 * revealed THAT something was filtered, but neither the threshold nor how many
 * hits it removed.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src/telemetry
const repoRoot = path.resolve(here, '../../../..');
const handlerPath = path.join(repoRoot, 'supabase', 'functions', 'memories', 'handlers', 'relevant.ts');
const source = readFileSync(handlerPath, 'utf8');

/** Executable lines only, so the explanatory comments cannot satisfy an assertion. */
const COMMENT_PREFIXES = ['//', '*', '/*', '*/'];

const executable = source
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .filter((line) => !COMMENT_PREFIXES.some((prefix) => line.startsWith(prefix)))
  .join('\n');

describe('GET /memories/relevant min_score telemetry (supabase/functions/memories/handlers/relevant.ts)', () => {
  // Anti-vacuity: the assertions below describe this handler and this filter.
  it('still exports handleRelevant, filters the ranked set by min_score, and diversifies what survives', () => {
    expect(executable).toContain('export async function handleRelevant(');
    expect(executable).toContain('const filtered = ranked.filter((r) => r.score >= params.min_score);');
    expect(executable).toContain('selectDiverse(filtered, params.limit)');
  });

  it('records min_score from the validated params, unconditionally', () => {
    // A whole-line match: a conditional spread such as
    // `...(params.min_score ? { 'lorekit.min_score': … } : {})` sits on one
    // line with other text and fails it, which is the point — a default of 0
    // must be recorded as 0, not left absent.
    expect(executable).toMatch(/^'lorekit\.min_score':\s*params\.min_score,$/m);
  });

  it('records how many ranked candidates the threshold removed', () => {
    // `ranked`, not `candidates`: the count is what the filter dropped, so it
    // is measured against the set the filter ran over.
    expect(executable).toMatch(/'lorekit\.min_score_filtered_count':\s*ranked\.length\s*-\s*filtered\.length/);
  });

  it('sets the filtered count in the same call as result_count and candidate_count', () => {
    // The three are read together to tell "nothing matched" from "min_score
    // dropped them" from "limit cut the list", so they land on the span at once.
    // Find the call by the filtered count, then check membership: key order
    // inside the object literal carries no meaning, so the test must not pin it.
    const call =
      executable.match(/span\.setAttributes\(\{[^}]*'lorekit\.min_score_filtered_count'[^}]*\}\)/)?.[0] ?? '';
    expect(call).not.toBe('');
    expect(call).toContain("'lorekit.result_count'");
    expect(call).toContain("'lorekit.candidate_count'");
  });
});
