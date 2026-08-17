import { describe, it, expect } from 'vitest';
import { isCanonicalScope } from './scope';
// The DEPLOYED validator, imported directly rather than re-described here.
// It is an import-free, Deno-API-free module, so Node can execute it verbatim —
// which is what makes this an executable agreement instead of a second copy of
// the grammar that is free to drift from the first.
//
// The module-boundary rule is disabled for this ONE line deliberately: its job
// is to stop application code coupling to another project's internals, and a
// test whose entire purpose is to compare two projects' copies of one grammar
// is the case it cannot serve. Nothing shipped to the browser imports this —
// the file is a `.spec.ts`, excluded from the Next.js build. The alternative
// (re-stating the edge grammar here) is precisely the drift being guarded
// against. `packages/mcp-core/src/edge-parity.spec.ts` reaches across the same
// boundary for the same reason, via `readFileSync`.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { validateScope } from '../../../../supabase/functions/_shared/scope.ts';

/**
 * `isCanonicalScope` (client) must agree with `validateScope` (edge) about
 * which scopes are FILTERABLE.
 *
 * The bug this guards against: a scope the client thinks is fine but the edge
 * rejects. Every Explorer endpoint (`GET /memories`, `/activity`, `/facets`,
 * `/read-activity`) now validates `?scope=` and 400s on a bad value, so such a
 * disagreement fails the whole page rather than one card — which makes this
 * parity check load-bearing rather than cosmetic. (Before the
 * scope-filter-validation change only `/read-activity` validated, and the
 * others quietly matched nothing.)
 *
 * The two directions of disagreement are not equally bad, and the tests below
 * are split accordingly:
 *
 * - Client accepts, edge rejects → the 400 comes back. This is the regression.
 * - Client rejects, edge accepts → real data hidden behind a filter the UI
 *   still offers. Quieter, and worse to debug.
 *
 * The one deliberate divergence is normalisation: the edge lowercases and trims
 * before validating, so it accepts `Repo::Owner/Name` and serves it as
 * `repo::owner/name`. The client refuses a value that is not already its own
 * normalised form, so the chip strip and the filter can never describe
 * different scopes. Those cases are asserted separately.
 */

function edgeAccepts(raw: string): boolean {
  try {
    validateScope(raw);
    return true;
  } catch {
    return false;
  }
}

/** Values already in normalised form — client and edge must agree exactly. */
const NORMALISED_CASES = [
  // Accepted by both.
  'global',
  'global::daily-report-lorekit-web',
  'project::lorekit',
  'project::daily-report-lorekit-web',
  'repo::mthines/lorekit',
  'branch::mthines/lorekit::feat/x',
  'repo::a.b/c-d',
  // Rejected by both — the bare scope TYPES are the values seen in production.
  'repo',
  'project',
  'branch',
  'nonsense',
  '',
  '::',
  '::nothing',
  'team::acme',
  'repo:mthines/lorekit',
  'project:lorekit',
  'repo::a,b',
  'repo::a(b)',
  'project::a",value.not.is.null',
];

describe('isCanonicalScope ↔ edge validateScope', () => {
  it.each(NORMALISED_CASES)('agrees on %j', (raw) => {
    expect(isCanonicalScope(raw)).toBe(edgeAccepts(raw));
  });

  it('never lets a client-accepted scope reach the endpoint that would 400 it', () => {
    // The load-bearing direction, stated as its own assertion so a failure
    // names the actual consequence rather than "expected true to be false".
    const wouldFourHundred = NORMALISED_CASES.filter(
      (raw) => isCanonicalScope(raw) && !edgeAccepts(raw),
    );
    expect(wouldFourHundred).toEqual([]);
  });

  it('never hides a scope the API would happily serve', () => {
    const wouldHide = NORMALISED_CASES.filter(
      (raw) => !isCanonicalScope(raw) && edgeAccepts(raw),
    );
    expect(wouldHide).toEqual([]);
  });

  it('refuses an un-normalised value the edge would silently rewrite', () => {
    for (const raw of ['Repo::Mthines/LoreKit', ' global', 'GLOBAL']) {
      expect(edgeAccepts(raw)).toBe(true);
      expect(isCanonicalScope(raw)).toBe(false);
    }
  });
});
