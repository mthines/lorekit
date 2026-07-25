import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard for the self-contained edge-function mirrors.
 *
 * Several pure modules in `packages/mcp-core/src` are duplicated verbatim into
 * `supabase/functions/mcp/` because the Deno edge function cannot cross-import
 * the Node package (Deno / Node.js MCP SDK incompatibility). Each mirror's
 * header says "keep the two in sync" and points at this package's vitest suite
 * as "the shared guard" — but nothing actually fails when the copies drift.
 *
 * These mirrors carry security-relevant logic (webhook-secret precedence,
 * created_at future-date rejection): a silent divergence between the tested
 * mcp-core copy and the deployed edge copy is exactly the bug this asserts
 * against. We compare the executable source of each pair with comments and
 * blank lines stripped, so the two are free to document themselves differently
 * (they intentionally do) but must remain behaviourally identical.
 *
 * Only import-free mirrors are covered here. `limits.ts` is also mirrored but
 * pulls in Deno-specific imports on the edge side, so a whole-file source
 * comparison does not apply; its shared pure logic is exercised by
 * `limits.spec.ts` on the mcp-core copy.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src
const repoRoot = path.resolve(here, '../../..');
const edgeDir = path.join(repoRoot, 'supabase', 'functions', 'mcp');

// Reduce a source file to its executable lines: trim each line, drop blanks,
// and drop comment lines (line comments and every line of a block/JSDoc
// comment — see COMMENT_PREFIXES). Neither mirror uses trailing inline
// comments on code lines, so line-level stripping fully isolates the logic; if
// that ever changes, the guard tightens rather than silently passing.
const COMMENT_PREFIXES = ['//', '*', '/*', '*/'];

function executableSource(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !COMMENT_PREFIXES.some((prefix) => line.startsWith(prefix)))
    .join('\n');
}

const MIRRORS = ['created-at.ts', 'webhook-secret-select.ts', 'tenant-scope.ts'];

describe('edge-function mirror parity', () => {
  it.each(MIRRORS)('%s stays behaviourally in sync with its edge mirror', (name) => {
    const core = executableSource(path.join(here, name));
    const edge = executableSource(path.join(edgeDir, name));
    // Sanity: both files exist and are non-trivial, so an empty-string match
    // can never masquerade as parity.
    expect(core.length).toBeGreaterThan(0);
    expect(edge).toBe(core);
  });
});
