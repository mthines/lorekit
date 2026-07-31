import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { restToolName, REST_TOOL_NAMES } from './rest-tool-name.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const functionsDir = path.join(repoRoot, 'supabase', 'functions');

/** `[method, path]` for every route registered by an edge function's index.ts. */
function routeTable(fn: string): Array<[string, string]> {
  const src = readFileSync(path.join(functionsDir, fn, 'index.ts'), 'utf8');
  return [...src.matchAll(/method:\s*'(\w+)'\s*,\s*path:\s*'([^']+)'/g)]
    .map((m) => [(m[1] ?? '').toUpperCase(), m[2] ?? ''] as [string, string]);
}

describe('restToolName', () => {
  it('maps every memories route to its MCP tool equivalent', () => {
    const cases: Array<[Parameters<typeof restToolName>[0], string]> = [
      [{ fn: 'memories', method: 'POST', path: '/' }, 'memory.write'],
      [{ fn: 'memories', method: 'GET', path: '/' }, 'memory.list'],
      [{ fn: 'memories', method: 'POST', path: '/search' }, 'memory.search'],
      [{ fn: 'memories', method: 'POST', path: '/restore' }, 'memory.restore'],
      [{ fn: 'memories', method: 'POST', path: '/purge' }, 'memory.purge'],
      [{ fn: 'memories', method: 'POST', path: '/purge-expired' }, 'memory.purge_expired'],
      [{ fn: 'memories', method: 'GET', path: '/scopes' }, 'memory.scopes'],
      [{ fn: 'memories', method: 'GET', path: '/:id' }, 'memory.read'],
      [{ fn: 'memories', method: 'PATCH', path: '/:id' }, 'memory.write'],
      [{ fn: 'memories', method: 'POST', path: '/:id/restore' }, 'memory.restore'],
    ];
    for (const [ref, expected] of cases) expect(restToolName(ref), JSON.stringify(ref)).toBe(expected);
  });

  it('discriminates hard delete from soft archive on both DELETE forms', () => {
    for (const p of ['/', '/:id']) {
      expect(restToolName({ fn: 'memories', method: 'DELETE', path: p, force: true })).toBe('memory.delete');
      expect(restToolName({ fn: 'memories', method: 'DELETE', path: p, force: false })).toBe('memory.archive');
      // Absent `force` is the default (soft archive) — not an unmapped route.
      expect(restToolName({ fn: 'memories', method: 'DELETE', path: p })).toBe('memory.archive');
    }
  });

  it('maps the orgs routes onto the org.*/member.* vocabulary', () => {
    expect(restToolName({ fn: 'orgs', method: 'GET', path: '/' })).toBe('org.list');
    expect(restToolName({ fn: 'orgs', method: 'POST', path: '/' })).toBe('org.create');
    expect(restToolName({ fn: 'orgs', method: 'GET', path: '/:slug' })).toBe('org.get');
    expect(restToolName({ fn: 'orgs', method: 'PATCH', path: '/:slug' })).toBe('org.rename');
    expect(restToolName({ fn: 'orgs', method: 'DELETE', path: '/:slug' })).toBe('org.delete');
    expect(restToolName({ fn: 'orgs', method: 'GET', path: '/:slug/members' })).toBe('member.list');
    expect(restToolName({ fn: 'orgs', method: 'PATCH', path: '/:slug/members/:userId' })).toBe('member.role_change');
    expect(restToolName({ fn: 'orgs', method: 'DELETE', path: '/:slug/members/:userId' })).toBe('member.remove');
    expect(restToolName({ fn: 'orgs', method: 'GET', path: '/:slug/invites' })).toBe('member.invite_list');
    expect(restToolName({ fn: 'orgs', method: 'POST', path: '/:slug/invites' })).toBe('member.invite');
    expect(restToolName({ fn: 'orgs', method: 'DELETE', path: '/:slug/invites/:inviteId' })).toBe('member.revoke');
  });

  it('is case-insensitive on the method', () => {
    expect(restToolName({ fn: 'memories', method: 'post', path: '/' })).toBe('memory.write');
    expect(restToolName({ fn: 'memories', method: 'delete', path: '/:id', force: true })).toBe('memory.delete');
  });

  it('is total — an unmapped route gets its own visible bucket, never another route\'s name', () => {
    expect(restToolName({ fn: 'memories', method: 'PUT', path: '/nope' })).toBe('memories.put.unmapped');
    expect(restToolName({ fn: 'widgets', method: 'GET', path: '/' })).toBe('widgets.get.unmapped');
  });

  it('never reuses one name for two different memory operations that must be distinguishable', () => {
    // memory.write is deliberately shared by POST / and PATCH /:id (both are
    // upserts of a memory, as memory.write is on MCP). Everything else is 1:1.
    const names = Object.entries(REST_TOOL_NAMES)
      .filter(([k]) => k.startsWith('memories '))
      .map(([, v]) => v);
    const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
    expect([...new Set(duplicated)].sort()).toEqual(['memory.restore', 'memory.write']);
  });

  // Drift guard: a route added to an index.ts without a mapping here would
  // silently start reporting `*.unmapped` in usage analytics.
  it.each(['memories', 'orgs'])('%s: every registered route has an explicit mapping', (fn) => {
    const unmapped = routeTable(fn)
      .map(([method, p]) => [`${method} ${p}`, restToolName({ fn, method, path: p })] as const)
      .filter(([, name]) => name.endsWith('.unmapped'))
      .map(([route]) => route);
    expect(unmapped, `add these to REST_TOOL_NAMES:\n  ${unmapped.join('\n  ')}`).toEqual([]);
  });

  it('finds routes to check (guards the regex against silently matching nothing)', () => {
    expect(routeTable('memories').length).toBeGreaterThanOrEqual(12);
    expect(routeTable('orgs').length).toBeGreaterThanOrEqual(11);
  });
});
