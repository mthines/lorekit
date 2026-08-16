import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard: every memories READ in the edge api_key path must route
 * through applyTenantScope — the single enforced tenant-visibility
 * predicate (Requirement R2). A read handler that inlines its own
 * `.eq('user_id', userId)` instead bypasses the shared helper and can
 * silently diverge from the RLS-side predicate (plan.md pre-mortem risk #2:
 * predicate drift -> cross-tenant read leak).
 *
 * This scans the edge `tools.ts` source (not mcp-core) — the edge api_key
 * path is where the tenant predicate is hand-applied per handler, because
 * the service-role client bypasses RLS. mcp-core's tools/*.ts handlers take
 * a pre-scoped db and rely on RLS for widening (see plan.md Technical
 * Approach) — no equivalent app-layer predicate exists there to drift.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsPath = path.resolve(here, '../../../supabase/functions/mcp/tools.ts');
const source = readFileSync(toolsPath, 'utf8');

// The four read handlers widened in Phase 1 (plan.md Technical Approach #2).
// Write/delete/archive/restore/purge stay personal-only (Requirement R7) and
// are deliberately excluded from this guard.
//
// `toolScopes` is a FIFTH read handler and is deliberately absent, for a
// different reason than the write family: it has no query to scope. It calls
// the `lorekit_memory_scopes` RPC (migration 00039/00049), which composes
// `lorekit_member_org_ids` inside Postgres exactly as the `memories` RLS read
// policies do, so the tenant predicate is already applied one layer down. An
// `applyTenantScope` call there would be a SECOND predicate over the same
// visibility rule and a place for the two to drift — the same argument
// `supabase/functions/mcp/tools.ts`'s `toolScopes` docblock and
// `memories/handlers/scopes.ts` both make. A future read handler that does
// build a `memories` query belongs in this list.
const READ_HANDLERS = ['toolRead', 'toolList', 'toolSearch', 'toolListArchived'];

function extractFunctionBody(src: string, fnName: string): string {
  const signature = `export async function ${fnName}(`;
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`handler ${fnName} not found in tools.ts`);
  // Depth-count parens from the signature's `(` so nested `)` in a param type
  // (e.g. `ReturnType<typeof createClient>`, default values) doesn't end the
  // param list early — find the `)` that returns depth to 0, then the body `{`.
  const sigOpen = src.indexOf('(', start);
  let depthParen = 0;
  let paramsEnd = -1;
  for (let i = sigOpen; i < src.length; i++) {
    if (src[i] === '(') depthParen++;
    else if (src[i] === ')' && --depthParen === 0) {
      paramsEnd = i;
      break;
    }
  }
  if (paramsEnd === -1) throw new Error(`could not find end of params for ${fnName}`);
  const bodyStart = src.indexOf('{', paramsEnd);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`could not find end of function body for ${fnName}`);
}

describe('tenant-scope usage guard (edge read handlers)', () => {
  it('imports applyTenantScope from the shared tenant-scope module', () => {
    // The mirror moved from `mcp/tenant-scope.ts` to `_shared/tenant-scope.ts`
    // when the REST surface started needing the same module: two edge copies of
    // one predicate is the drift this guard exists to prevent, so there is now
    // one, importable by every function. The import list is matched loosely
    // because it also carries the `KeyRestriction` type.
    expect(source).toMatch(
      /import\s*\{[^}]*\bapplyTenantScope\b[^}]*\}\s*from\s*['"]\.\.\/_shared\/tenant-scope\.(ts|js)['"]/,
    );
  });

  it.each(READ_HANDLERS)('%s routes its memories read through applyTenantScope', (fnName) => {
    const body = extractFunctionBody(source, fnName);
    expect(body).toContain('applyTenantScope(');
    expect(body).not.toMatch(/\.eq\(\s*['"]user_id['"]/);
  });

  it.each(READ_HANDLERS)('%s passes the calling key restriction to applyTenantScope', (fnName) => {
    // The tenant predicate is also where the KEY's scope allowlist and tenancy
    // are applied (00067), because a scoped key must not see an out-of-allowlist
    // row on a read that names no scope at all. A handler that keeps calling the
    // 3-argument form silently opts out of that half of the boundary.
    const body = extractFunctionBody(source, fnName);
    expect(body).toMatch(/applyTenantScope\([\s\S]*?,\s*keyScoping\s*\)/);
  });
});
