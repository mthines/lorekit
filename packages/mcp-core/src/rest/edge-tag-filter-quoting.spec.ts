import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard: every label (`memories.tags`) filter in the edge MCP tools must
 * reach PostgREST as `pgArrayLiteral(toTagList(...))`.
 *
 * Two distinct defects live in the naive `overlaps('tags', tags)` form, and one
 * of them fired in production:
 *
 *  1. `params` on the MCP surface is raw JSON-RPC, so a client that sends
 *     `tags: "loop::ideate-lessons"` (a bare string, not an array) passes the
 *     `tags?.length` guard and lands on postgrest-js's STRING overload, which
 *     forwards the value verbatim as `ov.loop::ideate-lessons`. Postgres
 *     answers `malformed array literal: "loop::ideate-lessons"` and the caller
 *     gets a 400 for what is a shape mismatch. `toTagList` makes the coercion
 *     total.
 *  2. An ARRAY is serialised by postgrest-js with a bare `value.join(',')`, so
 *     a label containing a comma, brace, quote, or backslash silently becomes
 *     several different labels — `memories.tags` is free text with no CHECK
 *     constraint, so such a label is reachable. `pgArrayLiteral` owns the
 *     Postgres quoting instead (same reasoning, and the same helper, as
 *     `memories/handlers/search.ts`).
 *
 * This scans the edge `tools.ts` source because that file is self-contained
 * Deno with no test harness in this repo — the same posture as
 * `tenant-scope-usage.spec.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsPath = path.resolve(here, '../../../../supabase/functions/mcp/tools.ts');
const source = readFileSync(toolsPath, 'utf8');

const OVERLAPS_TAGS = /\.overlaps\(\s*'tags'\s*,\s*([^)]*)\)/g;

describe('edge MCP tag filters', () => {
  it('routes every tags overlap through pgArrayLiteral', () => {
    const args = [...source.matchAll(OVERLAPS_TAGS)].map((m) => m[1].trim());
    expect(args.length).toBeGreaterThan(0);
    for (const arg of args) {
      expect(arg).toMatch(/^pgArrayLiteral\(/);
    }
  });

  it('coerces the raw JSON-RPC tags param through toTagList', () => {
    expect(source).toContain("import { pgArrayLiteral, resolveKindHost, toTagList } from '../_shared/schemas/tags.ts';");
    // Both read handlers destructure the untrusted value under a `rawTags`
    // alias and normalise it, so no `tags` identifier in a query is unchecked.
    const coercions = [...source.matchAll(/const tags = toTagList\(rawTags\);/g)];
    expect(coercions.length).toBe(2);
  });
});
