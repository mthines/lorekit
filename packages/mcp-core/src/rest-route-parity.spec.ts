import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-scan drift guard (the `tenant-scope-usage.spec.ts` pattern).
 *
 * The CLI's remote store calls the REST Edge Functions over plain `fetch`, so a
 * request it issues against a route that was never registered fails only at runtime,
 * against a live backend, under a token. That is exactly what happened: `remote.mjs`
 * soft-archived via `DELETE /memories?scope=…&key=…` while `memories/index.ts`
 * registered `DELETE /:id` only — every `lorekit delete` / `archive` got a 405, and no
 * unit test could see it because the two files never meet in a bundle.
 *
 * This asserts every (method, path) the CLI issues exists in the corresponding
 * function's route table, from source alone — no network, no token, no Deno.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..');
const REMOTE_STORE = join(REPO_ROOT, 'packages/cli/src/store/remote.mjs');
const FUNCTIONS_DIR = join(REPO_ROOT, 'supabase/functions');

interface Call {
  method: string;
  /** Function name, e.g. `memories` — the first path segment. */
  fn: string;
  /** Path relative to the function root, with dynamic segments as `:param`. */
  path: string;
}

/** `/memories/${id}?x=1` → `{ fn: 'memories', path: '/:param' }` */
function normalize(raw: string): { fn: string; path: string } {
  const segments = raw.split('?')[0]!.split('/').filter(Boolean);
  const [fn, ...rest] = segments;
  const path = '/' + rest.map((s) => (s.includes('${') ? ':param' : s)).join('/');
  return { fn: fn ?? '', path: path === '/' ? '/' : path.replace(/\/$/, '') };
}

function cliCalls(): Call[] {
  const src = readFileSync(REMOTE_STORE, 'utf8');
  // `this._rest('/path', { method: 'POST', ... })` — the options object never nests.
  const re = /_rest\(\s*[`'"]([^`'"]+)[`'"]\s*(?:,\s*\{([^}]*)\})?/g;
  const calls: Call[] = [];
  for (const m of src.matchAll(re)) {
    const { fn, path } = normalize(m[1]!);
    const method = /method:\s*['"](\w+)['"]/.exec(m[2] ?? '')?.[1] ?? 'GET';
    calls.push({ method: method.toUpperCase(), fn, path });
  }
  return calls;
}

/** Parses the `createRouter([...])` table out of a function's `index.ts`. */
function routeTable(fn: string): Set<string> {
  const src = readFileSync(join(FUNCTIONS_DIR, fn, 'index.ts'), 'utf8');
  const routes = new Set<string>();
  for (const m of src.matchAll(/method:\s*'(\w+)'\s*,\s*path:\s*'([^']+)'/g)) {
    // Any `:name` param matches any concrete value the CLI interpolates.
    routes.add(`${m[1]!.toUpperCase()} ${m[2]!.replace(/:[^/]+/g, ':param')}`);
  }
  return routes;
}

describe('CLI ↔ REST route parity', () => {
  const calls = cliCalls();

  it('finds the CLI REST call sites (guard against the regex silently matching nothing)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls.map((c) => c.fn)).toContain('memories');
  });

  it('every route the CLI calls is registered by its Edge Function', () => {
    const missing: string[] = [];
    for (const call of calls) {
      const routes = routeTable(call.fn);
      const wanted = `${call.method} ${call.path}`;
      if (!routes.has(wanted)) missing.push(`${wanted} (not in supabase/functions/${call.fn}/index.ts)`);
    }
    expect(missing, `CLI calls routes that do not exist:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('registers the natural-key soft-archive the CLI depends on', () => {
    expect(routeTable('memories')).toContain('DELETE /');
  });
});
