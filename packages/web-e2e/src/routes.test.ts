import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTES, visitPath } from './routes';

/**
 * The guard that keeps the page smoke suite complete.
 *
 * It walks packages/web/src/app for `page.tsx` files and compares the routes
 * they define with routes.ts. A new page with no entry fails here — on the PR
 * that adds it, in the `check` job, without a browser — and so does an entry
 * for a page that was deleted or moved.
 */

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src/app');

/** `(dashboard)/settings/api-keys` → `/settings/api-keys`. */
function toRoute(relativeDir: string): string {
  const segments = relativeDir
    .split(path.sep)
    .filter((s) => s !== '' && !/^\(.*\)$/.test(s)); // route groups do not appear in the URL
  return `/${segments.join('/')}`;
}

function appRoutes(dir = APP_DIR, rel = ''): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      // `_private` folders and `@slot` parallel routes are not URL segments of their own.
      if (name.startsWith('_') || name.startsWith('@')) continue;
      found.push(...appRoutes(full, path.join(rel, name)));
    } else if (name === 'page.tsx' || name === 'page.ts' || name === 'page.mdx') {
      found.push(toRoute(rel));
    }
  }
  return found;
}

const pages = appRoutes().sort();
const covered = ROUTES.map((r) => r.route);

describe('web e2e route coverage', () => {
  it('finds the app directory', () => {
    expect(pages.length, `no page.tsx found under ${APP_DIR}`).toBeGreaterThan(0);
  });

  it('has an entry in routes.ts for every page', () => {
    const missing = pages.filter((p) => !covered.includes(p));
    expect(
      missing,
      `These pages have no smoke test. Add an entry for each to packages/web-e2e/src/routes.ts ` +
        `(access + the heading a visitor sees):\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no entry for a page that no longer exists', () => {
    const stale = covered.filter((r) => !pages.includes(r));
    expect(
      stale,
      `routes.ts names routes with no page.tsx behind them — remove or rename:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('lists each route once', () => {
    const dupes = covered.filter((r, i) => covered.indexOf(r) !== i);
    expect(dupes, `duplicate entries in routes.ts: ${dupes.join(', ')}`).toEqual([]);
  });

  it('gives every dynamic route a concrete path to visit', () => {
    const unvisitable = ROUTES.filter((r) => /\[/.test(visitPath(r))).map((r) => r.route);
    expect(unvisitable, `set \`path\` to a real URL for: ${unvisitable.join(', ')}`).toEqual([]);
  });
});
