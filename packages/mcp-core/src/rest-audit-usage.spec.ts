import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard: every MUTATING REST route must write an audit event.
 *
 * The REST edge functions were built without any audit writer at all, while the
 * MCP tools and the web server actions both had one. As clients migrate off
 * MCP and direct-Supabase onto REST, that gap silently turns the audit trail
 * off — the mutations still happen, they just stop being recorded. Wiring
 * `recordRestAudit` into the handlers closes it today; this suite is what stops
 * the NEXT mutating route from shipping without it, which is the failure mode
 * that actually recurs.
 *
 * The handler set is DERIVED, never hardcoded: the route tables in
 * `memories/index.ts` and `orgs/index.ts` are parsed for `{ method, path,
 * handler }` triples, the POST/PATCH/DELETE ones are kept, and each handler
 * name is resolved back to its source file through that index's own import
 * statements. So a new mutating route is picked up automatically the moment it
 * is registered — there is no list here to forget to update.
 *
 * This checks CALL PRESENCE, not correctness: that a handler file contains a
 * `recordRestAudit(` call. It cannot tell you the action is right, or that the
 * call sits on the success path rather than before an early return. Those are
 * review concerns. What it can guarantee is that a mutating route is never
 * *silently* un-audited.
 *
 * Companion guard: `audit-actions-drift.spec.ts` keeps the action vocabulary in
 * sync between `@lorekit/schemas`, the SQL CHECK, and the dashboard's badge
 * metadata.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src
const repoRoot = path.resolve(here, '../../..');
const functionsDir = path.join(repoRoot, 'supabase', 'functions');

/**
 * A route mutates when its method is one of these AND its declared permission
 * is not `read`.
 *
 * The method alone is not sufficient: `POST /memories/search` is a POST purely
 * because its filter tree is too large for a query string, and it is registered
 * `requires: 'read'`. Auditing it would file a search under `memory.*` and make
 * the trail noisier AND less accurate. Using the route's own declared
 * permission — the same field the router gates access on — keeps that
 * distinction in one place rather than in an exemption list here.
 */
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function isMutating(route: RouteEntry): boolean {
  return MUTATING_METHODS.has(route.method) && route.requires !== 'read';
}

/**
 * Routes that mutate but deliberately write NO audit event.
 *
 * EMPTY BY DESIGN. Every mutating route currently audits. Adding an entry is a
 * deliberate, reviewable act: it must name the `handler#METHOD` and carry a
 * justification that survives the question "why is this state change not worth
 * recording?". "It's noisy" and "it's not implemented yet" are not
 * justifications — the first is a metadata problem, the second is this guard
 * doing its job.
 */
const AUDIT_EXEMPT: Record<string, string> = {};

interface RouteEntry {
  fn: string;
  method: string;
  routePath: string;
  handler: string;
  requires: string;
}

/** `{ method: 'POST', path: '/', handler: handleCreate, requires: 'write' }` */
const ROUTE_PATTERN =
  /\{\s*method:\s*'([A-Z]+)'\s*,\s*path:\s*'([^']*)'\s*,\s*handler:\s*(\w+)\s*,\s*requires:\s*'(\w+)'\s*\}/g;

/** `import { handleCreate } from './handlers/create.ts';` (possibly multi-name) */
const IMPORT_PATTERN = /import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g;

function parseRoutes(fn: string): { routes: RouteEntry[]; handlerFiles: Map<string, string> } {
  const indexPath = path.join(functionsDir, fn, 'index.ts');
  const source = readFileSync(indexPath, 'utf8');

  const routes: RouteEntry[] = [];
  ROUTE_PATTERN.lastIndex = 0;
  for (const m of source.matchAll(ROUTE_PATTERN)) {
    routes.push({ fn, method: m[1]!, routePath: m[2]!, handler: m[3]!, requires: m[4]! });
  }

  // handler identifier -> absolute source path, resolved via the index's imports.
  const handlerFiles = new Map<string, string>();
  for (const m of source.matchAll(IMPORT_PATTERN)) {
    const names = m[1]!
      .split(',')
      .map((n) => n.replace(/\btype\b/, '').split(/\sas\s/).pop()!.trim())
      .filter(Boolean);
    const resolved = path.resolve(path.join(functionsDir, fn), m[2]!);
    for (const name of names) handlerFiles.set(name, resolved);
  }

  return { routes, handlerFiles };
}

const REST_FUNCTIONS = ['memories', 'orgs'];

const parsed = REST_FUNCTIONS.map((fn) => ({ fn, ...parseRoutes(fn) }));
const allRoutes = parsed.flatMap((p) => p.routes);
const mutatingRoutes = allRoutes.filter(isMutating);

/** One entry per distinct handler that serves at least one mutating route. */
const mutatingHandlers = [
  ...new Map(
    mutatingRoutes.map((r) => [
      `${r.fn}:${r.handler}`,
      {
        ...r,
        file: parsed.find((p) => p.fn === r.fn)!.handlerFiles.get(r.handler),
      },
    ]),
  ).values(),
];

describe('REST route tables parse (anti-vacuity)', () => {
  it('found route tables in every REST function', () => {
    for (const p of parsed) {
      expect(p.routes.length, `no routes parsed from supabase/functions/${p.fn}/index.ts`).toBeGreaterThan(0);
    }
  });

  // Without these floors, a ROUTE_PATTERN that stopped matching (a formatting
  // change in index.ts, say) would yield an empty handler set and every
  // per-handler assertion below would vacuously pass — the exact way a drift
  // guard rots into decoration.
  it('derived a non-empty, plausibly-sized mutating-handler set', () => {
    expect(allRoutes.length).toBeGreaterThanOrEqual(20);
    expect(
      mutatingRoutes.length,
      `only ${mutatingRoutes.length} mutating routes parsed — ROUTE_PATTERN is probably stale`,
    ).toBeGreaterThanOrEqual(12);
    expect(mutatingHandlers.length).toBeGreaterThan(0);
  });

  it('resolved every mutating handler to a source file that exists', () => {
    const unresolved = mutatingHandlers
      .filter((h) => !h.file || !existsSync(h.file))
      .map((h) => `${h.fn}:${h.handler}`);
    expect(
      unresolved,
      'these handlers could not be traced back to a file via the index imports — IMPORT_PATTERN may be stale',
    ).toEqual([]);
  });

  it('has no stale entry in AUDIT_EXEMPT', () => {
    const known = new Set(mutatingRoutes.map((r) => `${r.handler}#${r.method}`));
    const stale = Object.keys(AUDIT_EXEMPT).filter((k) => !known.has(k));
    expect(stale, 'AUDIT_EXEMPT names routes that no longer exist — drop them').toEqual([]);
  });
});

describe('every mutating REST handler records an audit event', () => {
  it.each(mutatingHandlers.map((h) => [`${h.fn} ${h.method} ${h.routePath} -> ${h.handler}`, h] as const))(
    '%s calls recordRestAudit',
    (_label, h) => {
      const exemptKey = `${h.handler}#${h.method}`;
      if (exemptKey in AUDIT_EXEMPT) return;

      const source = readFileSync(h.file!, 'utf8');
      // `\b` rather than a bare substring: `includes('recordRestAudit(')` also
      // matches `somethingElse_recordRestAudit(`, so a renamed or shadowed call
      // would slip through. Verified by mutation — the substring form passed
      // when every call site was renamed to `NOPE_recordRestAudit(`.
      expect(
        /\brecordRestAudit\s*\(/.test(source),
        `${path.relative(repoRoot, h.file!)} serves the mutating route ${h.method} ${h.routePath} but never calls recordRestAudit. ` +
          'Audit it after the operation succeeds (see supabase/functions/_shared/audit.ts), or add a justified AUDIT_EXEMPT entry.',
      ).toBe(true);

      // The import has to come from the shared writer. A local re-implementation
      // would satisfy the substring check above while reintroducing exactly the
      // duplication this change removed.
      expect(source).toMatch(/import\s*\{[^}]*\brecordRestAudit\b[^}]*\}\s*from\s*['"][^'"]*_shared\/audit\.ts['"]/);
    },
  );
});
