/**
 * The drift guard that makes the hand-maintained protected-path list safe.
 *
 * Moving the auth gate out of `app/(dashboard)/layout.tsx` traded a structural
 * boundary (the route group) for a list, and a list can fall behind the
 * filesystem. The failure mode is the bad one — a new dashboard page that
 * nobody added here does not error, it just stops requiring a login — so the
 * agreement is executed here rather than trusted to review.
 *
 * Same technique as `rest-route-parity.spec.ts` and `edge-parity.spec.ts`:
 * read the real thing off disk and compare.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTECTED_SEGMENTS, isProtectedPath } from './protected-routes';

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/web/src/lib
const dashboardDir = path.resolve(here, '../app/(dashboard)');

/** The route segments the `(dashboard)` group actually contains, off disk. */
function segmentsOnDisk(): string[] {
  return readdirSync(dashboardDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    // A parenthesised child is another route group, not a URL segment; an
    // underscored one is a private folder Next never routes to.
    .filter((e) => !e.name.startsWith('(') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

describe('PROTECTED_SEGMENTS', () => {
  it('finds the dashboard group on disk (guards the test against silently matching nothing)', () => {
    expect(segmentsOnDisk().length).toBeGreaterThan(0);
  });

  it('matches every route the (dashboard) group contains, and nothing else', () => {
    // If this fails, a page was added to or removed from app/(dashboard)
    // without updating PROTECTED_SEGMENTS. Update the list — do not relax the
    // assertion: an unlisted dashboard route is one that no longer needs a
    // session.
    expect([...PROTECTED_SEGMENTS].sort()).toEqual(segmentsOnDisk());
  });
});

describe('isProtectedPath', () => {
  it('protects a dashboard root and everything under it', () => {
    expect(isProtectedPath('/lore')).toBe(true);
    expect(isProtectedPath('/lore/abc-123')).toBe(true);
    expect(isProtectedPath('/settings/user')).toBe(true);
  });

  it('leaves the public surface alone', () => {
    expect(isProtectedPath('/')).toBe(false);
    expect(isProtectedPath('/login')).toBe(false);
    expect(isProtectedPath('/docs')).toBe(false);
    expect(isProtectedPath('/blog/some-post')).toBe(false);
    expect(isProtectedPath('/learn')).toBe(false);
  });

  it('matches on a segment boundary, so a longer public path is not swallowed', () => {
    // The bug a bare `startsWith` would have shipped.
    expect(isProtectedPath('/lorem-ipsum')).toBe(false);
    expect(isProtectedPath('/overviews')).toBe(false);
  });

  it('does not gate the API surface, which answers with a status and not a redirect', () => {
    expect(isProtectedPath('/api/auth/callback')).toBe(false);
    expect(isProtectedPath('/api-docs')).toBe(false);
  });
});
