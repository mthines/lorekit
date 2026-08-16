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

/**
 * Drift guard: the REST WRITE family must apply the key's scope allowlist.
 *
 * `PATCH /memories/:id`, `DELETE /memories` and `POST /memories/restore` are
 * personal-only — they never widen to org rows, so they deliberately do NOT
 * call `applyRestTenantScope`. That is exactly how they shipped without the
 * allowlist half of the boundary: `user_id` alone was the whole filter, so a
 * scoped key could patch or delete a memory outside its allowlist BY ID.
 * `applyKeyScopeFilter` is the narrow helper that adds it, and this pins that
 * every one of them calls it.
 */
const REST_WRITE_HANDLERS = ['update', 'remove', 'restore'] as const;

describe('key-scope usage guard (REST write family)', () => {
  it.each(REST_WRITE_HANDLERS)('%s applies the key scope allowlist', (name) => {
    const src = readFileSync(
      path.resolve(here, `../../../supabase/functions/memories/handlers/${name}.ts`),
      'utf8',
    );
    expect(src).toContain('applyKeyScopeFilter(');
  });
});

/**
 * Drift guard: an account-wide sweep is REFUSED for a scoped key.
 *
 * `memory.purge` / `memory.purge_expired` carry no scope and choose their row
 * set inside the RPC, so there is nothing to narrow — the only available answer
 * is to refuse the call. This shipped documented-but-unimplemented once; the
 * pin is here so the docs table and the dispatcher cannot disagree again.
 */
describe('account-wide tool guard', () => {
  const handler = readFileSync(
    path.resolve(here, '../../../supabase/functions/mcp/mcp-handler.ts'),
    'utf8',
  );

  it('the dispatcher consults isRefusedForScopedKey before dispatching a tool', () => {
    expect(handler).toContain('isRefusedForScopedKey(toolName');
  });

  it('names exactly the two sweeps, in both copies of the pure module', async () => {
    const { ACCOUNT_WIDE_TOOLS, isRefusedForScopedKey } = await import('./permissions.js');
    expect([...ACCOUNT_WIDE_TOOLS].sort()).toEqual(['memory.purge', 'memory.purge_expired']);
    // An unrestricted key is untouched — scoping must not change behaviour for
    // a token nobody scoped.
    expect(isRefusedForScopedKey('memory.purge', false)).toBe(false);
    expect(isRefusedForScopedKey('memory.purge', true)).toBe(true);
    // `memory.scopes` is NARROWED, not refused: it returns a catalog, and an
    // empty catalog is a truthful answer.
    expect(isRefusedForScopedKey('memory.scopes', true)).toBe(false);

    const edge = readFileSync(
      path.resolve(here, '../../../supabase/functions/mcp/permissions.ts'),
      'utf8',
    );
    expect(edge).toContain("'memory.purge',");
    expect(edge).toContain("'memory.purge_expired',");
  });
});
