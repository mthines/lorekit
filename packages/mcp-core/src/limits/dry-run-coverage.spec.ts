import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Structural guard: every MUTATING REST route honours the dry-run flag.
 *
 * Dry-run is a safety guarantee — with `X-LoreKit-Dry-Run: true` a create /
 * update / delete must make NO changes. That guarantee only holds if every
 * mutating handler actually checks the flag before it writes. A new mutating
 * route added tomorrow without the check would silently execute for real even
 * in "safe" mode, which is exactly the failure this asserts against.
 *
 * Like `audit-coverage.spec.ts`, the mutating-route set is derived FROM THE
 * SOURCE (parse each `createRouter([...])` table, resolve each handler to a
 * file through the index's own imports) rather than a hand-maintained list, so
 * the guard cannot drift. "Mutating" = an unsafe HTTP method whose route does
 * not declare `requires: 'read'` — the same definition audit-coverage uses,
 * so `POST /memories/search` (a read) is correctly excluded.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const functionsDir = path.join(repoRoot, 'supabase/functions');

/**
 * Routes deliberately allowed to mutate without honouring dry-run. EMPTY, and
 * meant to stay that way — an exemption must be a visible, reviewed edit here.
 */
const DRY_RUN_EXEMPT: ReadonlyArray<string> = [];

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ROUTED_FUNCTIONS = ['memories', 'orgs'] as const;

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

function parseHandlerImports(fn: string): Map<string, string> {
  const indexPath = path.join(functionsDir, fn, 'index.ts');
  const source = readFileSync(indexPath, 'utf8');
  const map = new Map<string, string>();
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']*)'/g)) {
    const resolved = path.resolve(path.dirname(indexPath), group(m, 2));
    for (const raw of group(m, 1).split(',')) {
      const name = (raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '').trim();
      if (name) map.set(name, resolved);
    }
  }
  return map;
}

const importsByFn = new Map(ROUTED_FUNCTIONS.map((fn) => [fn, parseHandlerImports(fn)]));
const isMutating = (r: ParsedRoute): boolean => UNSAFE_METHODS.has(r.method) && r.requires !== 'read';
const routeKey = (r: ParsedRoute): string => `${r.fn} ${r.method} ${r.routePath}`;

const mutatingRoutes = ROUTED_FUNCTIONS.flatMap(parseRoutes)
  .filter(isMutating)
  .filter((r) => !DRY_RUN_EXEMPT.includes(routeKey(r)));

describe('REST dry-run coverage', () => {
  it('has the expected number of mutating routes to check', () => {
    // 13: memories create/remove(×2 routes)/update/restore(×2)/purge/purge-expired
    // + orgs create/rename/delete/member-role/member-remove/invite-create/invite-revoke.
    expect(mutatingRoutes.length).toBeGreaterThanOrEqual(13);
  });

  it.each(mutatingRoutes.map((r) => [routeKey(r), r] as const))(
    '%s honours the dry-run flag',
    (_key, route) => {
      const file = importsByFn.get(route.fn)?.get(route.handler);
      expect(file, `${route.fn}/index.ts registers ${route.handler} but never imports it`).toBeDefined();
      expect(existsSync(file ?? ''), `${route.handler} → ${file} does not exist`).toBe(true);
      const source = readFileSync(file as string, 'utf8');
      expect(
        /\bisDryRunHeader\s*\(/.test(source),
        `${route.method} ${route.routePath} → ${route.handler} (${path.relative(repoRoot, file as string)}) ` +
          'is a mutating route but never calls isDryRunHeader. Add the dry-run short-circuit before the write, ' +
          'or add it to DRY_RUN_EXEMPT with a reason.',
      ).toBe(true);
    },
  );

  it('exempts nothing today', () => {
    expect(DRY_RUN_EXEMPT).toEqual([]);
  });
});
