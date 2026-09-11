import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  SCOPE_PRECEDENCE as PRECEDENCE_TS,
  scopePrecedenceRank as rankTs,
  compareScopePrecedence as compareTs,
  pickScopeWinner as pickTs,
  shadowedScopes as shadowedTs,
} from './scope-precedence.js';

/**
 * CROSS-LANGUAGE PARITY: `packages/mcp-core/src/scope/scope-precedence.ts` (the
 * server rule, mirrored byte-for-byte into the edge tree) must resolve an
 * unscoped read identically to `packages/cli/src/shared/scope-precedence.mjs`
 * (the CLI's copy).
 *
 * Two implementations exist because the runtimes cannot share a module: the CLI
 * is a zero-dep `.mjs` package with no build step. The TWO TypeScript copies
 * are held together by `edge-parity.spec.ts`'s byte comparison (registered in
 * `mirror-pairs.mjs`); that is unavailable across languages, so this guard is
 * BEHAVIOURAL — run both over the same fixtures and require the same winner.
 *
 * Without it, `lorekit show <key>` and `memory.read { key }` could resolve the
 * same key to DIFFERENT lessons, and nothing would error. That is the whole
 * reason an unscoped read resolves by scope type rather than by the caller's
 * own git context: the edge has no working directory, so type rank is the only
 * definition both sides can compute — and this spec is what keeps them
 * computing it the same way.
 */

// The CLI is a plain `.mjs` package outside this project's tsconfig, so it is
// loaded by URL at runtime rather than as a typed import.
const cliModulePath = join(import.meta.dirname, '../../../cli/src/shared/scope-precedence.mjs');
const cli = await import(/* @vite-ignore */ `file://${cliModulePath}`) as {
  SCOPE_PRECEDENCE: string[];
  scopePrecedenceRank: (scope: unknown) => number;
  compareScopePrecedence: (a: unknown, b: unknown) => number;
  pickScopeWinner: (rows: unknown) => { scope: string } | null;
  shadowedScopes: (rows: unknown, winner: unknown) => string[];
};

/** Every scope shape both copies must agree on, junk included. */
const SCOPES = [
  'global',
  'project::lorekit',
  'repo::mthines/lorekit',
  'branch::mthines/lorekit::feat/x',
  '  Repo::O/R  ',
  'nonsense::x',
  '',
];

/** Candidate lists spanning one scope, several bands, and every tie-break. */
const CANDIDATE_SETS: { scope: string; updated_at?: string }[][] = [
  [],
  [{ scope: 'global', updated_at: '2026-01-01T00:00:00.000Z' }],
  [
    { scope: 'global', updated_at: '2026-09-01T00:00:00.000Z' },
    { scope: 'repo::o/r', updated_at: '2026-01-01T00:00:00.000Z' },
  ],
  [
    { scope: 'repo::o/b', updated_at: '2026-01-01T00:00:00.000Z' },
    { scope: 'repo::o/a', updated_at: '2026-01-01T00:00:00.000Z' },
  ],
  [
    { scope: 'repo::o/old', updated_at: '2026-01-01T00:00:00.000Z' },
    { scope: 'repo::o/new', updated_at: '2026-09-01T00:00:00.000Z' },
  ],
  [{ scope: 'repo::o/a' }, { scope: 'repo::o/b', updated_at: '2020-01-01T00:00:00.000Z' }],
  [
    { scope: 'global' },
    { scope: 'branch::o/r::b' },
    { scope: 'repo::o/r' },
    { scope: 'project::p' },
  ],
  [{ scope: 'nonsense::x' }, { scope: 'global' }],
];

describe('scope-precedence cross-language parity', () => {
  it('exposes the same scope order', () => {
    expect(cli.SCOPE_PRECEDENCE).toEqual([...PRECEDENCE_TS]);
  });

  it('ranks every scope shape identically', () => {
    for (const scope of SCOPES) {
      expect(cli.scopePrecedenceRank(scope), scope).toBe(rankTs(scope));
    }
    // Both copies must survive a non-string rather than one throwing where the
    // other degrades — a read that found something never fails on ordering.
    expect(cli.scopePrecedenceRank(undefined)).toBe(rankTs(undefined as unknown as string));
  });

  it('picks the same winner for every candidate set, in either input order', () => {
    for (const rows of CANDIDATE_SETS) {
      const label = rows.map((r) => r.scope).join(',') || '(empty)';
      expect(cli.pickScopeWinner(rows)?.scope ?? null, label).toBe(pickTs(rows)?.scope ?? null);
      const reversed = [...rows].reverse();
      expect(cli.pickScopeWinner(reversed)?.scope ?? null, `${label} reversed`)
        .toBe(pickTs(reversed)?.scope ?? null);
    }
  });

  it('reports the same shadowed scopes', () => {
    for (const rows of CANDIDATE_SETS) {
      const winner = pickTs(rows);
      expect(cli.shadowedScopes(rows, winner), rows.map((r) => r.scope).join(',') || '(empty)')
        .toEqual(shadowedTs(rows, winner));
    }
  });

  it('sorts identically — the comparator agrees on sign, not just on the winner', () => {
    for (const rows of CANDIDATE_SETS) {
      for (const a of rows) {
        for (const b of rows) {
          expect(Math.sign(cli.compareScopePrecedence(a, b)), `${a.scope} vs ${b.scope}`)
            .toBe(Math.sign(compareTs(a, b)));
        }
      }
    }
  });
});
