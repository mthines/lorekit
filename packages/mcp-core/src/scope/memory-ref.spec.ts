import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseMemoryRef, parseMemoryRefs, MEMORY_CITED_MAX } from './scope.ts';

// The two other implementations live outside this project's tsconfig, so they
// are loaded by URL at runtime rather than as typed imports — the same
// arrangement `lesson-rank-parity.spec.ts` uses, and the reason is the same:
// `@nx/enforce-module-boundaries` rejects a relative import that crosses a
// project, and it is right to.

// The DEPLOYED copy, imported rather than re-described here. It is an
// import-free, Deno-API-free module, so Node executes it verbatim — which is
// what makes this an executable agreement instead of a second copy of the
// grammar that is free to drift from the first. `edge-parity.spec.ts` cannot
// byte-compare these two files (mcp-core's `scope.ts` imports zod), so this
// spec is what holds the reference grammar's two implementations together.
const edgeModulePath = join(import.meta.dirname, '../../../../supabase/functions/_shared/scope/scope.ts');
const {
  parseMemoryRef: parseMemoryRefEdge,
  parseMemoryRefs: parseMemoryRefsEdge,
  MEMORY_CITED_MAX: MEMORY_CITED_MAX_EDGE,
} = await import(/* @vite-ignore */ `file://${edgeModulePath}`) as {
  parseMemoryRef: (raw: unknown) => { scope: string; key: string } | null;
  parseMemoryRefs: (raw: unknown) => { scope: string; key: string }[];
  MEMORY_CITED_MAX: number;
};

// The THIRD implementation: the CLI's, in dependency-free `.mjs`. It is not a
// copy of the above — it is the ORIGINAL, and `parseMemoryRef` was written to
// match it, because the `scope::key` a citation carries is the one
// `lorekit list`/`show` already print and take. Pairing them behaviourally is
// the `duplicate-clusters` split: three runtimes, one rule, one table.
const cliModulePath = join(import.meta.dirname, '../../../cli/src/shared/lessons-pure.mjs');
const { resolveScopeArg } = await import(/* @vite-ignore */ `file://${cliModulePath}`) as {
  resolveScopeArg: (raw: unknown) => { scope: string | null; key: string | null };
};

/**
 * The reference grammar, stated once as a table and run against all three
 * implementations.
 *
 * Every row is a case where a naive split gets a DIFFERENT answer, which is the
 * only reason this parser exists — `indexOf('::')` breaks on a branch scope and
 * `lastIndexOf('::')` breaks on a namespaced key, so a table of well-behaved
 * `global::x` rows would prove nothing.
 */
const REFERENCE_CASES: ReadonlyArray<{ raw: string; scope: string | null; key: string | null; why: string }> = [
  { raw: 'global::never-run-nx-fanouts', scope: 'global', key: 'never-run-nx-fanouts', why: 'the simple case' },
  {
    raw: 'branch::acme/app::feat/x::use-pnpm',
    scope: 'branch::acme/app::feat/x',
    key: 'use-pnpm',
    why: 'a branch scope CONTAINS `::`, so the first `::` is not the split',
  },
  {
    raw: 'global::loop::promotion::rule',
    scope: 'global',
    key: 'loop::promotion::rule',
    why: 'a key may contain `::` too, so the LAST `::` is not the split either',
  },
  {
    raw: 'repo::acme/app::sql-quoting',
    scope: 'repo::acme/app',
    key: 'sql-quoting',
    why: 'a repo scope takes no third segment, so the second `::` is the split',
  },
  {
    raw: 'project::agent-skills::polish-first',
    scope: 'project::agent-skills',
    key: 'polish-first',
    why: 'a project scope takes no second segment',
  },
  { raw: '  global::padded  ', scope: 'global', key: 'padded', why: 'surrounding whitespace is trimmed' },
  { raw: 'global::', scope: null, key: null, why: 'an empty key is not a reference' },
  { raw: 'global', scope: null, key: null, why: 'a bare scope names no lesson' },
  { raw: 'not-a-scope::key', scope: null, key: null, why: 'the left half must be a legal scope' },
  { raw: 'repo:acme/app::key', scope: null, key: null, why: 'a single colon is the canonical malformed case' },
  { raw: '', scope: null, key: null, why: 'empty' },
];

describe('parseMemoryRef — the reference grammar', () => {
  it.each(REFERENCE_CASES)('$raw → $why', ({ raw, scope, key }) => {
    const expected = scope === null ? null : { scope, key: key as string };
    expect(parseMemoryRef(raw)).toEqual(expected);
  });

  it('returns the scope VERBATIM, never lowercased', () => {
    // `memories.scope` is stored as written on the REST path, so normalising a
    // reference would resolve a mixed-case scope's lesson to nothing — the same
    // trap `parseScopeFilter` exists to avoid on the read side.
    expect(parseMemoryRef('Repo::Acme/App::My-Key')).toEqual({ scope: 'Repo::Acme/App', key: 'My-Key' });
  });

  it('is total over non-strings', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(parseMemoryRef(bad)).toBeNull();
    }
  });
});

describe('the three implementations agree', () => {
  it.each(REFERENCE_CASES)('edge copy: $raw', ({ raw, scope, key }) => {
    const expected = scope === null ? null : { scope, key: key as string };
    expect(parseMemoryRefEdge(raw)).toEqual(expected);
  });

  it('MEMORY_CITED_MAX is the same number on both runtimes', () => {
    expect(MEMORY_CITED_MAX_EDGE).toBe(MEMORY_CITED_MAX);
  });

  it.each(REFERENCE_CASES.filter((c) => c.scope !== null))(
    'the CLI splits $raw the same way',
    ({ raw, scope, key }) => {
      // `resolveScopeArg` is the CLI's positional parser and predates this one.
      // It trims the same way and applies the same first-valid-prefix walk, so
      // a citation typed at the CLI and one written by an agent name the same
      // lesson. It differs only in its NEGATIVE shape — an unparseable input
      // comes back as `{ scope: <the whole string>, key: null }` rather than
      // `null` — which is why only the positive rows are compared here.
      expect(resolveScopeArg(raw)).toEqual({ scope, key });
    },
  );

  it('the CLI also declines the rows this parser declines', () => {
    for (const { raw } of REFERENCE_CASES.filter((c) => c.scope === null)) {
      expect(resolveScopeArg(raw).key).toBeNull();
    }
  });
});

describe('parseMemoryRefs — the `cited` array', () => {
  it('drops unparseable entries instead of rejecting the write', () => {
    // A citation is telemetry attached to a write. The 00044/00054 posture: a
    // dimension must never fail the operation it is measuring.
    expect(parseMemoryRefs(['global::a', 'garbage', 'repo::acme/app::b'])).toEqual([
      { scope: 'global', key: 'a' },
      { scope: 'repo::acme/app', key: 'b' },
    ]);
  });

  it('de-duplicates by the RESOLVED pair, case-insensitively on the scope', () => {
    // The same lesson named twice is one citation, however it was spelled.
    expect(parseMemoryRefs(['global::a', 'Global::a', '  global::a  '])).toEqual([{ scope: 'global', key: 'a' }]);
  });

  it('does NOT fold two keys that differ only in case', () => {
    // Keys are case-sensitive in `memories`, so folding them would credit one
    // lesson for another's citation.
    expect(parseMemoryRefs(['global::a', 'global::A'])).toHaveLength(2);
  });

  it(`truncates at ${MEMORY_CITED_MAX} rather than erroring`, () => {
    const many = Array.from({ length: MEMORY_CITED_MAX + 10 }, (_, i) => `global::k${i}`);
    const parsed = parseMemoryRefs(many);
    expect(parsed).toHaveLength(MEMORY_CITED_MAX);
    // The FIRST N, not an arbitrary N: a model names what mattered most first.
    expect(parsed[0]).toEqual({ scope: 'global', key: 'k0' });
  });

  it('is total over non-arrays', () => {
    for (const bad of [null, undefined, 'global::a', {}, 7]) {
      expect(parseMemoryRefs(bad)).toEqual([]);
    }
  });

  it('the edge copy behaves identically on every case above', () => {
    const inputs: unknown[] = [
      ['global::a', 'garbage', 'repo::acme/app::b'],
      ['global::a', 'Global::a'],
      ['global::a', 'global::A'],
      Array.from({ length: MEMORY_CITED_MAX + 10 }, (_, i) => `global::k${i}`),
      null,
      'global::a',
    ];
    for (const input of inputs) {
      expect(parseMemoryRefsEdge(input)).toEqual(parseMemoryRefs(input));
    }
  });
});
