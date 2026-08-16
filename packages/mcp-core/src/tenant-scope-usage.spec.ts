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
 * Drift guard: the REST READ family must pass the key restriction too.
 *
 * The MCP twin of this guard is above. It is repeated on the REST side because
 * the two helpers are NOT symmetric in their signatures: `key` is the fourth
 * and OPTIONAL parameter of `applyRestTenantScope`, so a handler calling the
 * 3-argument form still type-checks and still applies the tenant half — it just
 * silently opts out of the key's scope allowlist, which is exactly the hole the
 * MCP-side `keyScoping` assertion closes. A `toContain('applyRestTenantScope(')`
 * would stay green through that, so the call is matched with the fourth
 * argument present, the same way the MCP assertion is.
 *
 * A future REST read handler that builds a `memories` query belongs in this
 * list. Handlers with no query to scope (`scopes`, `tags`, `usage`, the two
 * activity series, `facets`) are deliberately absent for the reason their own
 * docblocks give: the tenant predicate is applied one layer down, inside the
 * RPC, and a second copy up here is a place for the two to drift.
 */
const REST_READ_HANDLERS = ['get', 'list', 'relevant', 'search'] as const;

describe('key-scope usage guard (REST read family)', () => {
  const read = (name: string) =>
    readFileSync(path.resolve(here, `../../../supabase/functions/memories/handlers/${name}.ts`), 'utf8');

  it.each(REST_READ_HANDLERS)('%s routes its memories read through applyRestTenantScope', (name) => {
    expect(read(name)).toContain('applyRestTenantScope(');
  });

  it.each(REST_READ_HANDLERS)('%s passes the calling key restriction to applyRestTenantScope', (name) => {
    // The fourth argument, not merely the call. `keyRestriction(auth)` is the
    // only way a handler produces one, so it is matched by name.
    expect(read(name)).toMatch(/applyRestTenantScope\([\s\S]*?,\s*keyRestriction\(auth\)\s*\)/);
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
 *
 * PRESENCE IS NOT ENOUGH, and that is the second half of this guard. A
 * `toContain` on the call site stays green while the hole it pins is open:
 * `remove.ts` held `applyKeyScopeFilter(` and still let a scoped key delete an
 * org-owned memory, because the `?org=` branch returned through
 * `removeOrgOwned` several lines ABOVE the call. So each handler is also
 * checked for REACHABILITY — the gate must sit on the path before the write,
 * and no mutation path may return around it.
 */
const REST_WRITE_HANDLERS = ['update', 'remove', 'restore'] as const;

/** The gates that count as applying the key's allowlist, in either form. */
const KEY_GATE = /applyKeyScopeFilter\(|firstDeniedScope\(/g;

function firstIndexOf(src: string, needle: RegExp | string): number {
  if (typeof needle === 'string') return src.indexOf(needle);
  return src.search(needle);
}

describe('key-scope usage guard (REST write family)', () => {
  const read = (name: string) =>
    readFileSync(path.resolve(here, `../../../supabase/functions/memories/handlers/${name}.ts`), 'utf8');

  it.each(REST_WRITE_HANDLERS)('%s applies the key scope allowlist', (name) => {
    expect(read(name)).toContain('applyKeyScopeFilter(');
  });

  it.each(REST_WRITE_HANDLERS)('%s gates BEFORE it commits the mutation', (name) => {
    // `isDryRunHeader` is the last thing every one of these handlers does before
    // the write goes out, and each file has exactly one. A key gate after it
    // would be a gate the write has already passed.
    const src = read(name);
    const gate = firstIndexOf(src, KEY_GATE);
    const commit = firstIndexOf(src, 'isDryRunHeader(');
    expect(gate).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(commit);
  });

  it('remove gates BEFORE the ?org= branch returns through its own RPC', () => {
    // The concrete reachability failure this guard was rewritten for.
    // `removeOrgOwned` calls `memory_delete`, which chooses its rows inside the
    // RPC — there is no query left to filter — so a gate below the dispatch
    // covers the personal branch only and the org branch has none at all.
    const src = read('remove');
    const gate = src.indexOf('firstDeniedScope(');
    const dispatch = src.indexOf('return await removeOrgOwned(');
    expect(gate).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(dispatch);
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

  // The REST twins of the two MCP sweeps. They shipped ungated while
  // `docs/api-tokens.md` said they were refused, which is the same
  // documented-but-unimplemented shape this whole describe block exists for —
  // one surface down.
  it('both REST purge handlers refuse an account-wide sweep on a scoped key', () => {
    const src = readFileSync(
      path.resolve(here, '../../../supabase/functions/memories/handlers/purge.ts'),
      'utf8',
    );
    expect(src).toContain("refuseAccountWideSweep(auth, 'memory.purge',");
    expect(src).toContain("refuseAccountWideSweep(auth, 'memory.purge_expired',");
    // The decision itself must be IMPORTED, never restated: a third copy of
    // "which operations are account-wide" is how these two drifted apart.
    expect(src).toMatch(
      /import\s*\{[^}]*\bisRefusedForScopedKey\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/_shared\/account-wide-tools\.(ts|js)['"]/,
    );
  });

  it('names exactly the two sweeps, in both copies of the pure module', async () => {
    const { ACCOUNT_WIDE_TOOLS, isRefusedForScopedKey } = await import('./account-wide-tools.js');
    expect([...ACCOUNT_WIDE_TOOLS].sort()).toEqual(['memory.purge', 'memory.purge_expired']);
    // An unrestricted key is untouched — scoping must not change behaviour for
    // a token nobody scoped.
    expect(isRefusedForScopedKey('memory.purge', false)).toBe(false);
    expect(isRefusedForScopedKey('memory.purge', true)).toBe(true);
    // `memory.scopes` is NARROWED, not refused: it returns a catalog, and an
    // empty catalog is a truthful answer.
    expect(isRefusedForScopedKey('memory.scopes', true)).toBe(false);

    const edge = readFileSync(
      path.resolve(here, '../../../supabase/functions/_shared/account-wide-tools.ts'),
      'utf8',
    );
    expect(edge).toContain("'memory.purge',");
    expect(edge).toContain("'memory.purge_expired',");
  });
});
