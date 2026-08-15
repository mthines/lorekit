import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIST_PREVIEW_CHARS as SCHEMA_PREVIEW_CHARS } from '@lorekit/schemas/memory';
import { LIST_PREVIEW_CHARS as CORE_PREVIEW_CHARS } from './tools/list.js';

/**
 * `memory.list`'s `view: "summary"` preview length is declared in THREE places
 * that cannot import each other:
 *
 *   1. `packages/schemas/src/memory.ts`      — the authoritative declaration.
 *   2. `packages/mcp-core/src/tools/list.ts` — the Node/Fly + CLI stdio path.
 *   3. `supabase/functions/mcp/tools.ts`     — self-contained Deno, the
 *      production path. It cannot cross-import a package, the same constraint
 *      that already forces `MAX_VALUE_BYTES` and `PURGE_RETENTION_DAYS_DEFAULT`
 *      to be redeclared locally in that file.
 *
 * A drift here is silent and asymmetric: the same call against the hosted edge
 * function and against a BYOD Fly deployment would return previews of different
 * lengths, and nothing would fail. Assert the three agree, following the
 * `usage-client-parity.spec.ts` precedent for exactly this shape of problem.
 */

const repoRoot = join(import.meta.dirname, '../../..');
const edgeSource = readFileSync(join(repoRoot, 'supabase/functions/mcp/tools.ts'), 'utf8');

/** The numeric literal the edge function declares for the preview cap. */
function edgePreviewChars(): number {
  const m = /const LIST_PREVIEW_CHARS = (\d+);/.exec(edgeSource);
  if (!m) throw new Error('LIST_PREVIEW_CHARS not found in supabase/functions/mcp/tools.ts — has it been renamed?');
  return Number(m[1]);
}

describe('memory.list summary preview length parity', () => {
  it('mcp-core agrees with the schema declaration', () => {
    expect(CORE_PREVIEW_CHARS).toBe(SCHEMA_PREVIEW_CHARS);
  });

  it('the edge function agrees with the schema declaration', () => {
    expect(edgePreviewChars()).toBe(SCHEMA_PREVIEW_CHARS);
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
