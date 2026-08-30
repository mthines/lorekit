import { describe, it, expect } from 'vitest';
import { explorerCountLabel, isExplorerViewFiltered } from './explorer-result-count';

describe('isExplorerViewFiltered', () => {
  const base = {
    scope: null,
    search: '',
    filterCount: 0,
    hasRetentionConditions: false,
    rangeIsNarrowing: false,
    showArchived: false,
  };

  it('is false on the bare "All scopes", unfiltered, active default view', () => {
    expect(isExplorerViewFiltered(base)).toBe(false);
  });

  it('is true when a scope is selected', () => {
    expect(isExplorerViewFiltered({ ...base, scope: 'repo::mthines/lorekit' })).toBe(true);
  });

  it('is true for a non-blank search, ignoring surrounding whitespace', () => {
    expect(isExplorerViewFiltered({ ...base, search: 'timeout' })).toBe(true);
    expect(isExplorerViewFiltered({ ...base, search: '   ' })).toBe(false);
  });

  it('is true when any filter pill is set', () => {
    expect(isExplorerViewFiltered({ ...base, filterCount: 1 })).toBe(true);
  });

  it('is true when a retention condition narrows the list', () => {
    expect(isExplorerViewFiltered({ ...base, hasRetentionConditions: true })).toBe(true);
  });

  it('is true when the date range narrows the list', () => {
    expect(isExplorerViewFiltered({ ...base, rangeIsNarrowing: true })).toBe(true);
  });

  it('is false for the Archived view even with other narrowing set — a different population than the header total', () => {
    expect(
      isExplorerViewFiltered({ ...base, scope: 'global', filterCount: 2, showArchived: true }),
    ).toBe(false);
  });
});

describe('explorerCountLabel', () => {
  it('renders an exact match with no trailing +', () => {
    expect(explorerCountLabel(12, true, 128)).toBe('12 of 128');
  });

  it('renders a floor with a trailing + when more pages remain', () => {
    expect(explorerCountLabel(12, false, 128)).toBe('12+ of 128');
  });

  it('handles a zero match', () => {
    expect(explorerCountLabel(0, true, 128)).toBe('0 of 128');
  });
});
