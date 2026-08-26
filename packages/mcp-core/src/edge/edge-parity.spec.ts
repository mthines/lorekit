import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard for the self-contained edge-function mirrors.
 *
 * Several pure modules in `packages/mcp-core/src` are duplicated verbatim into
 * the Deno edge tree (`supabase/functions/mcp/` for MCP-only logic,
 * `supabase/functions/_shared/` for logic shared by every edge function)
 * because the Deno edge function cannot cross-import the Node package
 * (Deno / Node.js MCP SDK incompatibility). Each mirror's
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

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src/edge
const repoRoot = path.resolve(here, '../../../..');
const functionsDir = path.join(repoRoot, 'supabase', 'functions');

// The mirror-pair inventory is a plain `.mjs` package outside this project's
// tsconfig (the CLI is zero-dep, no build step), so it is loaded by URL at
// runtime rather than as a typed import — the same cross-runtime pattern
// `lesson-rank-parity.spec.ts` uses for `lessons-pure.mjs`. It is also the
// SAME inventory `lorekit obligations` reads (`packages/cli/src/shared/obligations-map.mjs`),
// so this spec and that command can never disagree about which files mirror
// which.
const mirrorPairsModulePath = path.join(here, '../../../cli/src/shared/mirror-pairs.mjs');
const { mirrorPairs } = (await import(/* @vite-ignore */ `file://${mirrorPairsModulePath}`)) as {
  mirrorPairs: ReadonlyArray<{ core: string; edge: string; driftChecked: boolean }>;
};

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

// The full per-pair rationale (which mirrors are MCP-only vs shared by more
// than one edge function, and why `audit.ts`/`limits.ts` are real partners
// but excluded below) now lives in `mirror-pairs.mjs` itself — this spec only
// derives the subset of the shared inventory it can actually byte-compare.
const driftCheckedPairs = mirrorPairs.filter((pair) => pair.driftChecked);

describe('edge-function mirror parity', () => {
  it.each(driftCheckedPairs)('$core stays behaviourally in sync with its edge mirror ($edge)', ({ core, edge }) => {
    const coreSource = executableSource(path.join(repoRoot, core));
    const edgeSource = executableSource(path.join(repoRoot, edge));
    // Sanity: both files exist and are non-trivial, so an empty-string match
    // can never masquerade as parity.
    expect(coreSource.length).toBeGreaterThan(0);
    expect(edgeSource).toBe(coreSource);
  });
});

describe('cursor mirror parity', () => {
  // `supabase/functions/mcp/cursor.ts` is a self-contained mirror of
  // `supabase/functions/_shared/api/paginate.ts`. It cannot cross-import the
  // REST `_shared/api/` tree (edge-bare-specifier enforces self-containment).
  // This guard ensures the two stay behaviourally identical — same codec, same
  // keyset predicate, same buildPage logic — so MCP paging and REST paging
  // produce compatible cursors a caller can use interchangeably.
  it('mcp/cursor.ts stays behaviourally in sync with _shared/api/paginate.ts', () => {
    const sharedPaginate = executableSource(path.join(functionsDir, '_shared/api/paginate.ts'));
    const mcpCursor = executableSource(path.join(functionsDir, 'mcp/cursor.ts'));
    expect(sharedPaginate.length).toBeGreaterThan(0);
    expect(mcpCursor).toBe(sharedPaginate);
  });
});
