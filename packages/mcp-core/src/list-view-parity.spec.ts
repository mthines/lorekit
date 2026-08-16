import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIST_PREVIEW_CHARS as SCHEMA_PREVIEW_CHARS } from '@lorekit/schemas/memory';
import { LIST_PREVIEW_CHARS as CORE_PREVIEW_CHARS } from './tools/list.js';

/**
 * `memory.list`'s `view: "summary"` preview length is declared in FOUR places
 * that cannot import each other:
 *
 *   1. `packages/schemas/src/memory.ts`      — the authoritative declaration.
 *   2. `packages/mcp-core/src/tools/list.ts` — the shared library path.
 *   3. `supabase/functions/mcp/tools.ts`     — self-contained Deno, the
 *      production path. It cannot cross-import a package, the same constraint
 *      that already forces `MAX_VALUE_BYTES` and `PURGE_RETENTION_DAYS_DEFAULT`
 *      to be redeclared locally in that file.
 *   4. `packages/cli/src/mcp-server.mjs`     — the `lorekit mcp` stdio server,
 *      which is zero-dependency by design and cannot import `@lorekit/schemas`.
 *
 * A drift here is silent and asymmetric: the same call against the hosted edge
 * function and against a BYOD deployment would return previews of different
 * lengths, and nothing would fail. Assert all four agree, following the
 * `usage-client-parity.spec.ts` precedent for exactly this shape of problem.
 */

const repoRoot = join(import.meta.dirname, '../../..');
const edgeSource = readFileSync(join(repoRoot, 'supabase/functions/mcp/tools.ts'), 'utf8');
const cliSource = readFileSync(join(repoRoot, 'packages/cli/src/mcp-server.mjs'), 'utf8');
const coreListSource = readFileSync(join(repoRoot, 'packages/mcp-core/src/tools/list.ts'), 'utf8');

/** The numeric literal a source file declares for the preview cap. */
function declaredPreviewChars(source: string, where: string): number {
  const m = /LIST_PREVIEW_CHARS = (\d+);/.exec(source);
  if (!m) throw new Error(`LIST_PREVIEW_CHARS not found in ${where} — has it been renamed?`);
  return Number(m[1]);
}

describe('memory.list summary preview length parity', () => {
  it('mcp-core agrees with the schema declaration', () => {
    expect(CORE_PREVIEW_CHARS).toBe(SCHEMA_PREVIEW_CHARS);
  });

  it('the edge function agrees with the schema declaration', () => {
    expect(declaredPreviewChars(edgeSource, 'supabase/functions/mcp/tools.ts')).toBe(SCHEMA_PREVIEW_CHARS);
  });

  it('the CLI stdio server agrees with the schema declaration', () => {
    expect(declaredPreviewChars(cliSource, 'packages/cli/src/mcp-server.mjs')).toBe(SCHEMA_PREVIEW_CHARS);
  });

  it('the documented cap in the tool catalog matches the implementation', () => {
    const catalog = readFileSync(join(repoRoot, 'packages/schemas/src/tool-catalog.ts'), 'utf8');
    const listBlock = /name: 'memory\.list'[\s\S]*?returns:/.exec(catalog)?.[0] ?? '';
    expect(listBlock).toContain(`${SCHEMA_PREVIEW_CHARS}-character \`preview\``);
  });
});

describe('memory.list summary projection drops the body on every path', () => {
  it('the edge function omits value rather than emptying it', () => {
    // `projectListEntry` must DESTRUCTURE value out. Returning `value: ''`
    // would keep the key on the wire and make a summary entry indistinguishable
    // from a real lesson with an empty body.
    const fn = /function projectListEntry\([\s\S]*?\n}/.exec(edgeSource)?.[0] ?? '';
    expect(fn).toContain('const { value, ...rest } = row;');
    expect(fn).not.toMatch(/value:\s*''/);
  });
});

describe('memory.list summary preview is code-point-safe everywhere', () => {
  // A `.slice(0, N)` on a raw string cuts UTF-16 code units and can emit a lone
  // surrogate. Every implementation must spread to code points first. This is
  // asserted behaviourally in each package's own suite; here we guard the
  // SHAPE across all three implementations, because a future edit to one file
  // is exactly how they drift apart again.
  // Scope the assertion to the projection function itself. Grepping the whole
  // file would pass on a `[...value` anywhere in it — including one in an
  // unrelated helper — which is not evidence the preview is safe.
  const PROJECTION_FN: Record<string, RegExp> = {
    'the edge function': /function projectListEntry\([\s\S]*?\n}/,
    'the CLI stdio server': /export function projectListView\([\s\S]*?\n}/,
    'mcp-core': /function summarizeEntry\([\s\S]*?\n}/,
  };

  it.each([
    ['the edge function', edgeSource],
    ['the CLI stdio server', cliSource],
    ['mcp-core', coreListSource],
  ])('%s spreads before slicing', (name, source) => {
    const fn = (PROJECTION_FN[name] as RegExp).exec(source)?.[0];
    expect(fn, `projection function not found in ${name} — has it been renamed?`).toBeTruthy();
    expect(fn).toMatch(/\[\.\.\.\(?value/);
    // The naive form must not survive inside the projection.
    expect(fn).not.toMatch(/value\s*\?\?\s*''\)\.slice\(0, LIST_PREVIEW_CHARS\)/);
  });
});
