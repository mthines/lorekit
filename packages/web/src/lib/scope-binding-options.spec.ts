import { describe, expect, it } from 'vitest';

import { filterOptions } from '@/components/ui/combobox-logic';
import { validateScopeBindingPattern } from './scope-bindings-validate';
import { bindableScopeOptions, creatableBindingScope } from './scope-binding-options';

/** 600 branch scopes that all sort before `repo::…`, the shape that hid scopes before. */
function largeCatalog(): string[] {
  const catalog = Array.from(
    { length: 599 },
    (_, i) => `branch::acme/agent-marketplace::feat/${String(i).padStart(3, '0')}`,
  );
  catalog.push('repo::zeta/lorekit');
  return catalog;
}

describe('bindableScopeOptions', () => {
  it('offers a scope that sorts last in a 600-scope catalog, and a search finds it', () => {
    const options = bindableScopeOptions(largeCatalog(), []);

    expect(options.map((o) => o.value)).toContain('repo::zeta/lorekit');
    // The combobox's own filter, over label AND hint — the path a typed query takes.
    const matches = filterOptions(options, 'lorekit');
    expect(matches.map((o) => o.value)).toEqual(['repo::zeta/lorekit']);
    // Every catalog entry is offered: nothing is truncated to a prefix.
    expect(options.filter((o) => !o.value.endsWith('*'))).toHaveLength(600);
  });

  it('matches a search on any part of the full scope, not only the short label', () => {
    const options = bindableScopeOptions(['branch::acme/api::feat/login', 'repo::acme/web'], []);

    expect(filterOptions(options, 'acme/api').map((o) => o.value)).toEqual(['branch::acme/api::feat/login']);
    expect(filterOptions(options, 'feat/login').map((o) => o.value)).toEqual(['branch::acme/api::feat/login']);
  });

  it('drops scopes that are already bound to the org', () => {
    const options = bindableScopeOptions(
      ['repo::acme/api', 'repo::acme/web', 'repo::other/tool'],
      ['repo::acme/api', 'repo::acme/*'],
    );

    const values = options.map((o) => o.value);
    expect(values).not.toContain('repo::acme/api');
    expect(values).not.toContain('repo::acme/*');
    expect(values).toEqual(['repo::acme/web', 'repo::other/tool']);
  });

  it('compares already-bound scopes on their stored, lowercased form', () => {
    const options = bindableScopeOptions(['repo::acme/api'], ['  REPO::Acme/API ']);

    expect(options).toEqual([]);
  });

  it('offers owner wildcards first, then exact scopes, each alphabetically', () => {
    const options = bindableScopeOptions(['repo::acme/web', 'repo::acme/api', 'project::solo'], []);

    expect(options.map((o) => o.value)).toEqual([
      'repo::acme/*',
      'project::solo',
      'repo::acme/api',
      'repo::acme/web',
    ]);
  });

  it('labels a scope by its last segment and keeps the full scope searchable in the hint', () => {
    const options = bindableScopeOptions(['repo::acme/api', 'repo::acme/web', 'branch::acme/api::main'], []);

    expect(options).toEqual([
      { value: 'repo::acme/*', label: 'repo::acme/*', hint: 'every repo scope under acme', type: 'repo' },
      { value: 'branch::acme/api::main', label: 'main', hint: 'branch::acme/api::main', type: 'branch' },
      { value: 'repo::acme/api', label: 'acme/api', hint: 'repo::acme/api', type: 'repo' },
      { value: 'repo::acme/web', label: 'acme/web', hint: 'repo::acme/web', type: 'repo' },
    ]);
  });

  it('hints a wildcard with the one scope type its prefix covers', () => {
    // A binding matches by literal prefix (00111), so `repo::acme/*` covers no
    // `branch::acme/…` scope — the hint must not promise "every scope".
    const hints = Object.fromEntries(
      bindableScopeOptions(
        ['repo::acme/api', 'repo::acme/web', 'branch::acme/api::main', 'branch::acme/web::dev', 'project::a', 'project::b'],
        [],
      )
        .filter((o) => o.value.endsWith('*'))
        .map((o) => [o.value, o.hint]),
    );

    expect(hints).toEqual({
      'branch::acme/*': 'every branch scope under acme',
      'project::*': 'every project scope',
      'repo::acme/*': 'every repo scope under acme',
    });
  });

  it('only offers values the bind would accept', () => {
    const options = bindableScopeOptions(
      ['repo::acme/api', 'repo::acme/web', 'branch::acme/api::main', 'branch::acme/web::dev', 'project::a', 'project::b', 'global'],
      [],
    );

    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(validateScopeBindingPattern(option.value)).toEqual({ ok: true, normalized: option.value });
    }
  });

  it('skips a catalog entry the bind would refuse instead of offering it', () => {
    const options = bindableScopeOptions(['repo::acme/api', 'notaprefix::x'], []);

    expect(options.map((o) => o.value)).toEqual(['repo::acme/api']);
  });
});

describe('creatableBindingScope', () => {
  it('creatable: offers a typed wildcard normalised to lowercase', () => {
    expect(creatableBindingScope('  repo::Acme/* ')).toEqual({
      value: 'repo::acme/*',
      label: 'repo::acme/*',
      hint: 'use this scope',
      type: 'repo',
    });
  });

  it('creatable: offers a valid scope that has no memories yet', () => {
    expect(creatableBindingScope('branch::acme/api::release/1.2')?.value).toBe('branch::acme/api::release/1.2');
  });

  it('creatable: offers nothing for a scope the org already has (already bound)', () => {
    expect(creatableBindingScope('repo::acme/api', ['repo::acme/api'])).toBeNull();
    expect(creatableBindingScope('REPO::Acme/*', ['repo::acme/*'])).toBeNull();
    expect(creatableBindingScope('repo::acme/web', ['repo::acme/api'])?.value).toBe('repo::acme/web');
  });

  it('creatable: offers nothing for an empty query or an invalid pattern', () => {
    expect(creatableBindingScope('')).toBeNull();
    expect(creatableBindingScope('   ')).toBeNull();
    expect(creatableBindingScope('repo:acme/api')).toBeNull();
    expect(creatableBindingScope('notaprefix::x')).toBeNull();
  });
});
