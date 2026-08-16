import { describe, it, expect } from 'vitest';
import {
  ORG_ACCESS_TIERS,
  UNSCOPED,
  describeScoping,
  isScoped,
  orgBadgeLabel,
  scopeBadgeLabel,
  scopePatternOptions,
  type TokenScoping,
} from './token-scoping';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function scoping(over: Partial<TokenScoping> = {}): TokenScoping {
  return { ...UNSCOPED, ...over };
}

describe('isScoped', () => {
  it('reports the default as unscoped', () => {
    expect(isScoped(UNSCOPED)).toBe(false);
  });

  it('reports either axis alone as scoped', () => {
    expect(isScoped(scoping({ scopes: ['global'] }))).toBe(true);
    expect(isScoped(scoping({ org_access: 'personal' }))).toBe(true);
  });
});

describe('scopeBadgeLabel', () => {
  it('says nothing when the allowlist is empty', () => {
    expect(scopeBadgeLabel([])).toBeNull();
  });

  it('counts, and gets the singular right', () => {
    expect(scopeBadgeLabel(['global'])).toBe('1 scope');
    expect(scopeBadgeLabel(['global', 'repo::a/b'])).toBe('2 scopes');
  });
});

describe('orgBadgeLabel', () => {
  it('says nothing under the unrestricted default', () => {
    // A badge every unscoped key carries is noise; no badge already means
    // unrestricted.
    expect(orgBadgeLabel(UNSCOPED)).toBeNull();
  });

  it('names the personal-only case', () => {
    expect(orgBadgeLabel(scoping({ org_access: 'personal' }))).toBe('personal only');
  });

  it('counts selected orgs', () => {
    expect(orgBadgeLabel(scoping({ org_access: 'selected', org_ids: [ORG_A] }))).toBe('1 org');
    expect(orgBadgeLabel(scoping({ org_access: 'selected', org_ids: [ORG_A, ORG_B] }))).toBe('2 orgs');
  });
});

describe('describeScoping', () => {
  it('states the unrestricted case plainly', () => {
    expect(describeScoping(UNSCOPED)).toBe('Unrestricted — every scope and org you can reach.');
  });

  it('lists the patterns verbatim — the sentence is where there is room to be exact', () => {
    expect(describeScoping(scoping({ scopes: ['global', 'repo::mthines/*'] }))).toBe(
      'Scopes: global, repo::mthines/*.',
    );
  });

  it('says "Any scope" when only the tenancy is narrowed', () => {
    expect(describeScoping(scoping({ org_access: 'personal' }))).toBe(
      'Any scope · personal memories only.',
    );
  });

  it('names the orgs when it can', () => {
    expect(
      describeScoping(scoping({ org_access: 'selected', org_ids: [ORG_A, ORG_B] }), {
        [ORG_A]: 'Acme',
        [ORG_B]: 'Globex',
      }),
    ).toBe('Any scope · orgs: Acme, Globex.');
  });

  it('falls back to a count when a name is missing', () => {
    // Happens when the key points at an org the viewer has since left. Worth
    // showing rather than hiding — the key still carries it, and the RPC will
    // refuse to re-save it.
    expect(
      describeScoping(scoping({ org_access: 'selected', org_ids: [ORG_A, ORG_B] }), {
        [ORG_A]: 'Acme',
      }),
    ).toBe('Any scope · 2 orgs.');
  });

  it('combines both axes', () => {
    expect(
      describeScoping(scoping({ scopes: ['repo::mthines/*'], org_access: 'personal' })),
    ).toBe('Scopes: repo::mthines/* · personal memories only.');
  });
});

describe('scopePatternOptions', () => {
  it('offers an owner wildcard when the owner has MORE THAN ONE scope', () => {
    // The wildcard keeps working when the next repo appears; an exact list does
    // not, which is the whole reason to offer it.
    expect(
      scopePatternOptions(['repo::mthines/lorekit', 'repo::mthines/gw-tools']),
    ).toEqual(['repo::mthines/*', 'repo::mthines/gw-tools', 'repo::mthines/lorekit']);
  });

  it('does NOT offer a wildcard for a lone scope under an owner', () => {
    // `repo::solo/*` beside `repo::solo/only` is two ways to say the same thing
    // today, and only one of them is honest about tomorrow — so offering both
    // is a choice with no information in it.
    expect(scopePatternOptions(['repo::solo/only'])).toEqual(['repo::solo/only']);
  });

  it('puts wildcards first, then exact scopes, each alphabetically', () => {
    // Catalog order is by memory count and therefore moves under the user
    // between visits; a stable order is worth more than a popular one here.
    expect(
      scopePatternOptions([
        'repo::zz/b',
        'repo::aa/b',
        'repo::aa/a',
        'repo::zz/a',
        'global',
      ]),
    ).toEqual([
      'repo::aa/*',
      'repo::zz/*',
      'global',
      'repo::aa/a',
      'repo::aa/b',
      'repo::zz/a',
      'repo::zz/b',
    ]);
  });

  it('groups a project wildcard on the prefix, not on a slash', () => {
    expect(scopePatternOptions(['project::alpha', 'project::beta'])).toEqual([
      'project::*',
      'project::alpha',
      'project::beta',
    ]);
  });

  it('groups a branch scope by its OWNER, matching the repo grouping', () => {
    expect(
      scopePatternOptions(['branch::mthines/lorekit::main', 'branch::mthines/other::main']),
    ).toEqual([
      'branch::mthines/*',
      'branch::mthines/lorekit::main',
      'branch::mthines/other::main',
    ]);
  });

  it('never offers a wildcard over global', () => {
    // It would mean the whole account, which is what NOT scoping already means.
    expect(scopePatternOptions(['global'])).toEqual(['global']);
  });

  it('de-duplicates a catalog that repeats a scope', () => {
    expect(scopePatternOptions(['global', 'global'])).toEqual(['global']);
  });

  it('is empty for an empty catalog', () => {
    expect(scopePatternOptions([])).toEqual([]);
  });
});

describe('ORG_ACCESS_TIERS', () => {
  it('covers every OrgAccess value exactly once', () => {
    // The form renders from this list, so a value missing here is a tenancy the
    // user cannot choose and a badge with no card behind it.
    expect(ORG_ACCESS_TIERS.map((t) => t.value)).toEqual(['all', 'personal', 'selected']);
  });
});
