import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSpec } from '@lorekit/schemas/openapi/spec';

/**
 * The OpenAPI spec advertises `X-LoreKit-Dry-Run` on the operations that change
 * data; the edge routers decide that with each route's `requires`. A write route
 * without the header hides the rehearsal from `/api-docs` and `/api-docs.md`; a
 * read route with it promises a rehearsal its handler never performs. The Deno
 * routers and the Node spec cannot import each other, so they are held together
 * here, the way `tool-catalog-parity.spec.ts` holds the catalog to the gate.
 */

const repoRoot = join(import.meta.dirname, '../../../..');

const ROUTERS = [
  { fn: 'memories', prefix: '/memories' },
  { fn: 'orgs', prefix: '/orgs' },
] as const;

const ROUTE_ENTRY = /\{\s*method:\s*'(GET|POST|PUT|PATCH|DELETE)',\s*path:\s*'([^']+)',[^}]*?requires:\s*'(read|write)'/g;

interface RouterRoute {
  readonly method: string;
  readonly path: string;
  readonly requires: 'read' | 'write';
}

/** Every `{ method, path, requires }` entry of the routers, in the spec's path spelling. */
function routerRoutes(): RouterRoute[] {
  return ROUTERS.flatMap(({ fn, prefix }) => {
    const source = readFileSync(join(repoRoot, 'supabase/functions', fn, 'index.ts'), 'utf8');
    return [...source.matchAll(ROUTE_ENTRY)].map(([, method, path, requires]) => ({
      method: (method as string).toLowerCase(),
      path: prefix + (path === '/' ? '' : (path as string).replace(/:(\w+)/g, '{$1}')),
      requires: requires as 'read' | 'write',
    }));
  });
}

type SpecOperation = { parameters?: Array<{ name: string }> };
const spec = generateSpec('https://example.test/functions/v1') as {
  paths: Record<string, Record<string, SpecOperation>>;
};

/** The Bearer-authed operations the spec documents — the public `/blog` surface takes no dry-run. */
const documented = Object.entries(spec.paths)
  .filter(([path]) => !path.startsWith('/blog'))
  .flatMap(([path, operations]) =>
    Object.entries(operations).map(([method, operation]) => ({ method, path, operation })),
  );

const routes = routerRoutes();

describe('REST dry-run header ↔ router permission', () => {
  it('reads both route tables', () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it.each(documented.map((op) => [op.method.toUpperCase(), op.path, op] as const))(
    '%s %s is served by a router route',
    (_, __, { method, path }) => {
      expect(routes.some((r) => r.method === method && r.path === path)).toBe(true);
    },
  );

  it.each(documented.map((op) => [op.method.toUpperCase(), op.path, op] as const))(
    '%s %s advertises X-LoreKit-Dry-Run exactly when it requires write',
    (_, __, { method, path, operation }) => {
      const route = routes.find((r) => r.method === method && r.path === path);
      const advertised = (operation.parameters ?? []).some((p) => p.name === 'X-LoreKit-Dry-Run');
      expect(advertised).toBe(route?.requires === 'write');
    },
  );
});
