import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Structural guard: every MUTATING REST route audits.
 *
 * The `orgs` function shipped with ELEVEN routes and ZERO `recordAudit` calls.
 * That was a deliberate decision at the time (a JWT caller's audit row was
 * stamped `user_id = null`, which `rls_audit_log_insert` rejected, so wiring
 * them would have added guaranteed-dead code). Once `auditUserId` returns the
 * JWT caller's own id the rows land, and the exemption evaporates — but
 * nothing in the build would have noticed either the original gap or a new
 * route added tomorrow without auditing.
 *
 * So this derives the mutating-route set FROM THE SOURCE rather than from a
 * list someone must remember to update:
 *
 *   1. parse the `createRouter([...])` table in each function's `index.ts`;
 *   2. resolve each route's handler NAME to a file through THAT index's own
 *      `import { handleX } from './handlers/…'` statements — never by
 *      guessing a filename from the handler name, which would silently
 *      mis-resolve (`handleRemoveMember` lives in `members/remove.ts`, and
 *      `handleRemove`/`handleRestore` are each registered on two routes);
 *   3. assert every file so reached calls `recordAudit`.
 *
 * A new mutating route therefore FAILS this test until it audits.
 *
 * "Mutating" = an unsafe HTTP method whose route does not declare
 * `requires: 'read'`. Both halves matter. Method alone would sweep in
 * `POST /memories/search`, which is a POST only because its filter tree does
 * not fit in a query string — it is registered `requires: 'read'` and must NOT
 * audit (auditing a search would be both noise and a privacy regression).
 * `requires` alone would exclude nothing on `orgs`, where all eleven routes
 * are `requires: 'jwt'`. The exclusion of `POST /memories/search` is asserted
 * explicitly below, so this definition cannot quietly stop working.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const functionsDir = path.join(repoRoot, 'supabase/functions');

/**
 * Routes deliberately allowed to mutate without auditing.
 *
 * EMPTY, and meant to stay that way. It exists so that a future exemption is
 * a visible, reviewable edit to this list with a reason attached — not a
 * quietly missing call in a handler nobody re-read. Format: `"<fn> <METHOD>
 * <route path>"`.
 */
const AUDIT_EXEMPT: ReadonlyArray<string> = [];

/** Methods that can change state. GET/HEAD/OPTIONS cannot. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The REST functions with a `createRouter` route table. */
const ROUTED_FUNCTIONS = ['memories', 'orgs'] as const;

/**
 * A floor on how many routes each function must yield. Anti-vacuity: a parser
 * that silently matched nothing would otherwise make this whole file pass by
 * asserting over an empty set. Deliberately below today's real counts so
 * REMOVING a route is not a spurious failure, but high enough that a broken
 * regex is.
 */
const MIN_ROUTES: Record<string, number> = { memories: 10, orgs: 10 };
const MIN_MUTATING: Record<string, number> = { memories: 7, orgs: 6 };

/** Map lookup that fails loudly instead of asserting non-null. */
function must<K, V>(map: Map<K, V>, key: K, what: string): V {
  const v = map.get(key);
  if (v === undefined) throw new Error(`${what}: no entry for ${String(key)}`);
  return v;
}

/** Regex capture group that fails loudly instead of asserting non-null. */
function group(m: RegExpMatchArray, i: number): string {
  const v = m[i];
  if (v === undefined) throw new Error(`regex group ${i} did not participate in the match`);
  return v;
}

interface ParsedRoute {
  fn: string;
  method: string;
  routePath: string;
  handler: string;
  requires: string;
}

/** Parse the `createRouter([ … ], 'fn')` table out of a function's index.ts. */
function parseRoutes(fn: string): ParsedRoute[] {
  const source = readFileSync(path.join(functionsDir, fn, 'index.ts'), 'utf8');
  const table = /createRouter\(\[([\s\S]*?)\n\]\s*,/.exec(source);
  if (!table) throw new Error(`${fn}/index.ts: could not find the createRouter([...]) table`);

  const entry = /\{\s*method:\s*'([A-Z]+)'\s*,\s*path:\s*'([^']*)'\s*,\s*handler:\s*(\w+)\s*,\s*requires:\s*'(\w+)'\s*\}/g;
  return [...group(table, 1).matchAll(entry)].map((m) => ({
    fn,
    method: group(m, 1),
    routePath: group(m, 2),
    handler: group(m, 3),
    requires: group(m, 4),
  }));
}

/**
 * Map handler identifier → source file, using the index's OWN import
 * statements. Handles both `import { a, b } from '…'` and default-free
 * multi-line forms.
 */
function parseHandlerImports(fn: string): Map<string, string> {
  const indexPath = path.join(functionsDir, fn, 'index.ts');
  const source = readFileSync(indexPath, 'utf8');
  const map = new Map<string, string>();

  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']*)'/g)) {
    const specifier = group(m, 2);
    // Only handler modules; the shared `_shared/*` imports are not handlers.
    const resolved = path.resolve(path.dirname(indexPath), specifier);
    for (const raw of group(m, 1).split(',')) {
      const name = (raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '').trim();
      if (name) map.set(name, resolved);
    }
  }
  return map;
}

const routesByFn = new Map<string, ParsedRoute[]>(
  ROUTED_FUNCTIONS.map((fn) => [fn, parseRoutes(fn)]),
);
const importsByFn = new Map<string, Map<string, string>>(
  ROUTED_FUNCTIONS.map((fn) => [fn, parseHandlerImports(fn)]),
);

const isMutating = (r: ParsedRoute): boolean =>
  UNSAFE_METHODS.has(r.method) && r.requires !== 'read';

const routeKey = (r: ParsedRoute): string => `${r.fn} ${r.method} ${r.routePath}`;

const allRoutes = ROUTED_FUNCTIONS.flatMap((fn) => must(routesByFn, fn, 'routes'));
const mutatingRoutes = allRoutes.filter(isMutating).filter((r) => !AUDIT_EXEMPT.includes(routeKey(r)));

describe('REST audit coverage', () => {
  // ── anti-vacuity ──────────────────────────────────────────────────────────
  it.each(ROUTED_FUNCTIONS)('%s: the route-table parser found a plausible number of routes', (fn) => {
    const routes = must(routesByFn, fn, 'routes');
    expect(routes.length, `parsed ${routes.length} routes from ${fn}/index.ts`).toBeGreaterThanOrEqual(MIN_ROUTES[fn] ?? 0);
    // Every parsed route must be well-formed — a partially-matching regex
    // producing blank fields would otherwise slip through.
    for (const r of routes) {
      expect(r.method).toMatch(/^[A-Z]+$/);
      expect(r.routePath.startsWith('/'), `${fn}: bad path ${r.routePath}`).toBe(true);
      expect(r.handler).toMatch(/^handle\w+$/);
      expect(['read', 'write', 'jwt']).toContain(r.requires);
    }
  });

  it.each(ROUTED_FUNCTIONS)('%s: found a plausible number of MUTATING routes', (fn) => {
    const mutating = must(routesByFn, fn, 'routes').filter(isMutating);
    expect(mutating.length, `${fn}: ${mutating.length} mutating routes`).toBeGreaterThanOrEqual(MIN_MUTATING[fn] ?? 0);
  });

  it.each(ROUTED_FUNCTIONS)('%s: every route handler resolves through the index\'s own imports', (fn) => {
    const imports = must(importsByFn, fn, 'imports');
    for (const r of must(routesByFn, fn, 'routes')) {
      const file = imports.get(r.handler);
      expect(file, `${fn}/index.ts registers ${r.handler} but never imports it`).toBeDefined();
      expect(existsSync(file ?? ''), `${r.handler} → ${file} does not exist`).toBe(true);
    }
  });

  // ── the guard ─────────────────────────────────────────────────────────────
  it('has at least one mutating route to check', () => {
    expect(mutatingRoutes.length).toBeGreaterThanOrEqual(13);
  });

  it.each(mutatingRoutes.map((r) => [routeKey(r), r] as const))(
    '%s calls recordAudit',
    (_key, route) => {
      const file = must(must(importsByFn, route.fn, 'imports'), route.handler, 'handler file');
      const source = readFileSync(file, 'utf8');
      expect(
        /\brecordAudit\s*\(/.test(source),
        `${route.method} ${route.routePath} → ${route.handler} (${path.relative(repoRoot, file)}) ` +
          'is a mutating route but never calls recordAudit. Wire it up, or add it to AUDIT_EXEMPT with a reason.',
      ).toBe(true);
    },
  );

  // ── the read-route exclusion, asserted rather than assumed ────────────────
  it('classifies POST /memories/search as NON-mutating (requires: read)', () => {
    const search = must(routesByFn, 'memories', 'routes').find((r) => r.routePath === '/search' && r.method === 'POST');
    expect(search, 'POST /memories/search is not registered any more — update this assertion').toBeDefined();
    expect(search?.requires, 'search must stay requires: read').toBe('read');
    expect(search ? isMutating(search) : true, 'a read-only search must never be treated as mutating').toBe(false);
    expect(mutatingRoutes.map(routeKey)).not.toContain('memories POST /search');
  });

  it('excludes every GET route', () => {
    const gets = allRoutes.filter((r) => r.method === 'GET');
    expect(gets.length).toBeGreaterThan(0);
    for (const r of gets) expect(isMutating(r), `${routeKey(r)} must not be mutating`).toBe(false);
  });

  it('includes every unsafe-method route that is not requires: read', () => {
    // The positive half of the definition — proves the filter is not simply
    // excluding everything.
    const unsafe = allRoutes.filter((r) => UNSAFE_METHODS.has(r.method));
    const readOnlyUnsafe = unsafe.filter((r) => r.requires === 'read');
    // POST-but-read is a small, deliberate set: a POST here means "the filter
    // does not fit in a URL", never "this writes". `/list`, `/facets` and
    // `/activity` are the body transports of the identically-named GET reads
    // and `/search` has always been one, so none of them audits — an audit
    // entry per page render would drown the trail that exists to record change.
    // A new entry in this list needs the same justification.
    expect(readOnlyUnsafe.map(routeKey)).toEqual([
      'memories POST /list',
      'memories POST /facets',
      'memories POST /activity',
      'memories POST /search',
    ]);
    expect(mutatingRoutes.length).toBe(unsafe.length - readOnlyUnsafe.length - AUDIT_EXEMPT.length);
  });

  // ── the exemption list is visible and empty ───────────────────────────────
  it('exempts nothing today', () => {
    expect(AUDIT_EXEMPT).toEqual([]);
  });

  // ── the org routes specifically ───────────────────────────────────────────
  it('covers all seven mutating orgs routes', () => {
    // Named explicitly because these are the routes this change wires up; if
    // one is dropped from the router the count assertion above still passes,
    // but this does not.
    expect(mutatingRoutes.filter((r) => r.fn === 'orgs').map(routeKey).sort()).toEqual([
      'orgs DELETE /:slug',
      'orgs DELETE /:slug/invites/:inviteId',
      'orgs DELETE /:slug/members/:userId',
      'orgs PATCH /:slug',
      'orgs PATCH /:slug/members/:userId',
      'orgs POST /',
      'orgs POST /:slug/invites',
    ]);
  });
});
