import { describe, it, expect } from 'vitest';
import {
  scopeTypeAttribute,
  parseScopeTypeAttribute,
  SCOPE_TYPE_ATTRIBUTES,
  type ScopeTypeAttribute,
} from './scope-type-attribute.js';

/**
 * The vocabulary this dimension is allowed to take. Asserted as a SET rather
 * than trusted from the type, because the whole point of the module is that the
 * value reaching an exporter is bounded at RUNTIME — the previous
 * `raw.split('::')[0] as ScopePrefix` also type-checked.
 */
const ALLOWED: ReadonlySet<string> = new Set([
  'global',
  'project',
  'repo',
  'branch',
  'mixed',
  'invalid',
]);

describe('scopeTypeAttribute — a single scope', () => {
  it.each([
    ['global', 'global'],
    ['project::lorekit-web-daily-report', 'project'],
    ['repo::mthines/lorekit', 'repo'],
    ['branch::mthines/lorekit::feat/x', 'branch'],
  ] as const)('maps %s to %s', (scope, expected) => {
    expect(scopeTypeAttribute(scope)).toBe(expected);
  });

  it('lowercases before matching, as validateScope does', () => {
    expect(scopeTypeAttribute('REPO::Mthines/LoreKit')).toBe('repo');
  });

  it('trims surrounding whitespace', () => {
    expect(scopeTypeAttribute('  repo::mthines/lorekit  ')).toBe('repo');
  });

  it('keeps the prefix when only the TAIL is malformed', () => {
    // validateScope rejects this, but the dimension answers "a repo scope was
    // attempted" — reporting `invalid` would disagree with the caller's error.
    expect(scopeTypeAttribute('repo::not-a-valid-path')).toBe('repo');
  });
});

describe('scopeTypeAttribute — ungrammatical input collapses to one bucket', () => {
  it.each([
    // The single-colon mistake validateScope has a dedicated message for.
    'repo:mthines/lorekit',
    // A bare word with no separator at all.
    'nope',
    // A separator with an unknown prefix.
    'workspace::something',
    // The literal placeholder this module exists to stop emitting.
    'unknown',
  ])('maps %s to invalid', (scope) => {
    expect(scopeTypeAttribute(scope)).toBe('invalid');
  });

  it('never echoes the caller-supplied prefix back as the value', () => {
    // The regression this module was written for: an unbounded dimension.
    for (const scope of ['nope', 'repo:mthines/x', 'attacker-controlled::x']) {
      const value = scopeTypeAttribute(scope);
      expect(value).toBe('invalid');
      expect(value).not.toContain(scope);
    }
  });
});

describe('scopeTypeAttribute — absent scope omits the attribute', () => {
  it.each([undefined, null, '', '   ', 42, {}, []])('returns null for %o', (scope) => {
    expect(scopeTypeAttribute(scope)).toBeNull();
  });

  it('returns null when scopes is present but holds nothing usable', () => {
    expect(scopeTypeAttribute(undefined, [])).toBeNull();
    expect(scopeTypeAttribute(undefined, ['', '  '])).toBeNull();
    expect(scopeTypeAttribute(undefined, [null, 7, {}])).toBeNull();
  });
});

describe('scopeTypeAttribute — the scopes array (memory.search)', () => {
  it('reports the shared type when every scope agrees', () => {
    expect(scopeTypeAttribute(undefined, ['repo::mthines/lorekit', 'repo::mthines/other'])).toBe(
      'repo',
    );
  });

  it('reports mixed when the scopes span more than one type', () => {
    expect(scopeTypeAttribute(undefined, ['global', 'repo::mthines/lorekit'])).toBe('mixed');
  });

  it('reports the type for a single-entry array', () => {
    expect(scopeTypeAttribute(undefined, ['project::agent-skills'])).toBe('project');
  });

  it('folds an ungrammatical entry into the type set rather than dropping it', () => {
    // One good + one bad scope is genuinely mixed; silently ignoring the bad one
    // would report a clean `repo` for a request that was partly nonsense.
    expect(scopeTypeAttribute(undefined, ['repo::mthines/lorekit', 'nope'])).toBe('mixed');
    expect(scopeTypeAttribute(undefined, ['nope', 'also-bad'])).toBe('invalid');
  });

  it('ignores non-string and empty entries when deciding', () => {
    expect(scopeTypeAttribute(undefined, ['repo::mthines/lorekit', '', null, 3])).toBe('repo');
  });
});

describe('scopeTypeAttribute — precedence and boundedness', () => {
  it('prefers the singular scope when both arguments are supplied', () => {
    expect(scopeTypeAttribute('global', ['repo::mthines/lorekit'])).toBe('global');
  });

  it('round-trips every value it can produce back through the parser', () => {
    // The wire path a body-carried-scope handler takes: resolve here, write the
    // value to a response header, and have the router read it back. A value this
    // module emits that its own parser rejects would silently drop the dimension
    // for exactly the routes that need the header.
    const produced = [
      scopeTypeAttribute('global'),
      scopeTypeAttribute('project::agent-skills'),
      scopeTypeAttribute('repo::mthines/lorekit'),
      scopeTypeAttribute('branch::mthines/lorekit::feat/x'),
      scopeTypeAttribute(undefined, ['global', 'repo::mthines/lorekit']),
      scopeTypeAttribute('nope'),
    ];
    expect(new Set(produced)).toEqual(ALLOWED);
    for (const value of produced) expect(parseScopeTypeAttribute(value)).toBe(value);
  });
});

describe('parseScopeTypeAttribute — reading a scope type off the wire', () => {
  it.each([...SCOPE_TYPE_ATTRIBUTES])('accepts %s', (value) => {
    expect(parseScopeTypeAttribute(value)).toBe(value);
  });

  it('trims and lowercases, matching what scopeTypeAttribute does to its input', () => {
    expect(parseScopeTypeAttribute('  RePo  ')).toBe('repo');
  });

  it.each([
    // The placeholder the module exists to stop emitting — never revive it by
    // letting it back in through the header.
    'unknown',
    // A caller-shaped prefix, the unbounded-dimension regression itself.
    'attacker-controlled',
    // A scope, rather than a scope TYPE: right idea, wrong vocabulary.
    'repo::mthines/lorekit',
    '',
    '   ',
  ])('records no type for %o', (raw) => {
    expect(parseScopeTypeAttribute(raw)).toBeNull();
  });

  it.each([null, undefined, 42, {}, []])('records no type for the non-string %o', (raw) => {
    // `Headers.get` returns null for an absent header, and the mirrored edge
    // copy is read by untyped call sites, so the guard is a runtime one.
    expect(parseScopeTypeAttribute(raw)).toBeNull();
  });

  it('never returns a value outside the closed vocabulary', () => {
    const inputs: unknown[] = ['global', 'REPO', 'unknown', 'x'.repeat(500), null, 42, ''];
    for (const input of inputs) {
      const value = parseScopeTypeAttribute(input);
      if (value !== null) expect(ALLOWED.has(value)).toBe(true);
    }
  });

  it('exports exactly the vocabulary this file names, in no particular order', () => {
    // ALLOWED stays hand-written on purpose. The exported array is what the
    // router validates a handler's header against, so deriving the assertion
    // from it would test the constant against itself and a seventh value could
    // be added with nothing failing.
    expect(new Set(SCOPE_TYPE_ATTRIBUTES)).toEqual(ALLOWED);
    expect(SCOPE_TYPE_ATTRIBUTES).toHaveLength(ALLOWED.size);
  });

  it('only ever returns a member of the closed vocabulary', () => {
    const inputs: unknown[] = [
      'global',
      'project::x',
      'repo::o/n',
      'branch::o/n::b',
      'nope',
      'repo:o/n',
      '',
      undefined,
      null,
      42,
    ];
    for (const input of inputs) {
      const value: ScopeTypeAttribute | null = scopeTypeAttribute(input);
      if (value !== null) expect(ALLOWED.has(value)).toBe(true);
    }
  });
});
