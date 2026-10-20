/**
 * Filter in / filter out — the polarity half of the filter bar's model.
 *
 * What these pin is the boolean logic: every click must produce the existing
 * bar ANDed with "is / is not this value", expressed in the bar's own shape —
 * OR within a dimension, AND across dimensions, and for the multi-valued tag
 * dimension an include slot and an exclude slot that hold at the same time.
 */

import { describe, it, expect } from 'vitest';
import { ListMemoriesBodySchema, ListMemoriesQuerySchema } from '@lorekit/schemas/memory';
import {
  applyValueFilter,
  filterKey,
  filtersToBody,
  filtersToQueryParams,
  findFilter,
  hasExplorerOnlyFilters,
  normalizeFilters,
  policyExpressibleFilters,
  removeFilter,
  selectedValues,
  setFilterOperator,
  toggleFilterValue,
  valuePolarity,
  type Filter,
} from './filters';

const tagIn = (...values: string[]): Filter => ({ field: 'label', operator: 'all', values });
const tagAny = (...values: string[]): Filter => ({ field: 'label', operator: 'in', values });
const tagOut = (...values: string[]): Filter => ({ field: 'label', operator: 'nin', values });
const hostIs = (...values: string[]): Filter => ({ field: 'host', operator: 'in', values });
const hostNot = (...values: string[]): Filter => ({ field: 'host', operator: 'nin', values });

describe('normalizeFilters — the tag dimension keeps two slots', () => {
  it('keeps a tag include and a tag exclude side by side, include first', () => {
    expect(normalizeFilters([tagOut('flaky'), tagIn('perf')])).toEqual([tagIn('perf'), tagOut('flaky')]);
  });

  it('still merges two conditions of the SAME slot', () => {
    expect(normalizeFilters([tagOut('a'), tagOut('b')])).toEqual([tagOut('a', 'b')]);
    expect(normalizeFilters([tagIn('a'), tagAny('b')])).toEqual([tagIn('a', 'b')]);
  });

  it('keeps one condition per scalar field whatever the polarity', () => {
    expect(normalizeFilters([hostIs('a'), hostNot('b')])).toEqual([hostIs('a', 'b')]);
  });

  it('gives each pill its own key', () => {
    expect(filterKey(tagIn('a'))).not.toBe(filterKey(tagOut('b')));
    expect(filterKey(hostIs('a'))).toBe(filterKey(hostNot('b')));
  });
});

describe('applyValueFilter — tags (independent include and exclude slots)', () => {
  it('filter out on an empty bar excludes the tag', () => {
    expect(applyValueFilter([], 'label', 'flaky', 'exclude')).toEqual([tagOut('flaky')]);
  });

  it('filter in on an empty bar starts an "includes all" condition', () => {
    expect(applyValueFilter([], 'label', 'perf', 'include')).toEqual([tagIn('perf')]);
  });

  it('perf AND NOT flaky: an exclusion composes with an existing include', () => {
    expect(applyValueFilter([tagIn('perf')], 'label', 'flaky', 'exclude')).toEqual([
      tagIn('perf'),
      tagOut('flaky'),
    ]);
  });

  it('an include composes with an existing exclusion instead of joining it', () => {
    // The old single-slot model could only grow the exclusion here.
    expect(applyValueFilter([tagOut('flaky')], 'label', 'perf', 'include')).toEqual([
      tagIn('perf'),
      tagOut('flaky'),
    ]);
  });

  it('several exclusions are NOT a AND NOT b — one "includes none" pill', () => {
    expect(applyValueFilter([tagOut('a')], 'label', 'b', 'exclude')).toEqual([tagOut('a', 'b')]);
  });

  it('a second include follows the include pill: AND under "all", OR under "any"', () => {
    expect(applyValueFilter([tagIn('a')], 'label', 'b', 'include')).toEqual([tagIn('a', 'b')]);
    expect(applyValueFilter([tagAny('a')], 'label', 'b', 'include')).toEqual([tagAny('a', 'b')]);
  });

  it('excluding a required tag MOVES it — never both required and forbidden', () => {
    expect(applyValueFilter([tagIn('a', 'b')], 'label', 'b', 'exclude')).toEqual([tagIn('a'), tagOut('b')]);
    expect(applyValueFilter([tagIn('b')], 'label', 'b', 'exclude')).toEqual([tagOut('b')]);
  });

  it('including an excluded tag moves it back', () => {
    expect(applyValueFilter([tagIn('a'), tagOut('b')], 'label', 'b', 'include')).toEqual([tagIn('a', 'b')]);
  });

  it('pressing the same polarity again takes it off', () => {
    expect(applyValueFilter([tagIn('perf'), tagOut('flaky')], 'label', 'flaky', 'exclude')).toEqual([tagIn('perf')]);
    expect(applyValueFilter([tagIn('perf'), tagOut('flaky')], 'label', 'perf', 'include')).toEqual([tagOut('flaky')]);
  });
});

describe('applyValueFilter — scalar fields (one exact condition)', () => {
  it('filter out on an empty bar: is not X', () => {
    expect(applyValueFilter([], 'host', 'aw', 'exclude')).toEqual([hostNot('aw')]);
  });

  it('is not A, then filter out X: is not A AND is not X = neither of A, X', () => {
    expect(applyValueFilter([hostNot('a')], 'host', 'x', 'exclude')).toEqual([hostNot('a', 'x')]);
  });

  it('is A or X, then filter out X: exactly "is A"', () => {
    expect(applyValueFilter([hostIs('a', 'x')], 'host', 'x', 'exclude')).toEqual([hostIs('a')]);
  });

  it('is X, then filter out X: flips to "is not X" rather than matching nothing', () => {
    expect(applyValueFilter([hostIs('x')], 'host', 'x', 'exclude')).toEqual([hostNot('x')]);
  });

  it('is A, then filter out X: unchanged — "is A" already rules X out', () => {
    expect(applyValueFilter([hostIs('a')], 'host', 'x', 'exclude')).toEqual([hostIs('a')]);
  });

  it('is A, then filter in X: OR within the dimension', () => {
    expect(applyValueFilter([hostIs('a')], 'host', 'x', 'include')).toEqual([hostIs('a', 'x')]);
  });

  it('is not A, then filter in X: exactly "is X"', () => {
    expect(applyValueFilter([hostNot('a')], 'host', 'x', 'include')).toEqual([hostIs('x')]);
    expect(applyValueFilter([hostNot('a', 'x')], 'host', 'x', 'include')).toEqual([hostIs('x')]);
  });

  it('pressing the same polarity again takes it off', () => {
    expect(applyValueFilter([hostIs('a', 'x')], 'host', 'x', 'include')).toEqual([hostIs('a')]);
    expect(applyValueFilter([hostNot('x')], 'host', 'x', 'exclude')).toEqual([]);
  });

  it('leaves every other dimension alone (AND across dimensions)', () => {
    expect(applyValueFilter([tagIn('perf'), hostIs('a')], 'kind', 'bus', 'exclude')).toEqual([
      tagIn('perf'),
      { field: 'kind', operator: 'nin', values: ['bus'] },
      hostIs('a'),
    ]);
  });
});

describe('reading both slots', () => {
  const bar = [tagIn('perf'), tagOut('flaky')];

  it('valuePolarity names the slot holding a value', () => {
    expect(valuePolarity(bar, 'label', 'perf')).toBe('include');
    expect(valuePolarity(bar, 'label', 'flaky')).toBe('exclude');
    expect(valuePolarity(bar, 'label', 'ci')).toBeNull();
    expect(valuePolarity([hostIs('a')], 'host', 'x')).toBeNull();
  });

  it('selectedValues covers both slots, so the menu can uncheck an exclusion', () => {
    expect(selectedValues(bar, 'label')).toEqual(['perf', 'flaky']);
    expect(toggleFilterValue(bar, 'label', 'flaky')).toEqual([tagIn('perf')]);
  });

  it('a menu-checked value joins the include slot when there is one', () => {
    expect(toggleFilterValue(bar, 'label', 'ci')).toEqual([tagIn('perf', 'ci'), tagOut('flaky')]);
  });

  it('an exclude-only tag filter still grows its exclusion from the menu, as before', () => {
    expect(toggleFilterValue([tagOut('flaky')], 'label', 'ci')).toEqual([tagOut('flaky', 'ci')]);
  });
});

describe('setFilterOperator / removeFilter with two tag pills', () => {
  const bar = [tagIn('perf'), tagOut('flaky')];

  it('changes only the pill it is given', () => {
    expect(setFilterOperator(bar, 'label', 'in', 'include')).toEqual([tagAny('perf'), tagOut('flaky')]);
  });

  it('moving a pill onto the other slot merges, and the chosen operator wins', () => {
    expect(setFilterOperator(bar, 'label', 'nin', 'include')).toEqual([tagOut('perf', 'flaky')]);
    expect(setFilterOperator(bar, 'label', 'in', 'exclude')).toEqual([tagAny('flaky', 'perf')]);
  });

  it('removes one pill, or with no polarity every pill of the field', () => {
    expect(removeFilter(bar, 'label', 'exclude')).toEqual([tagIn('perf')]);
    expect(removeFilter(bar, 'label', 'include')).toEqual([tagOut('flaky')]);
    expect(removeFilter(bar, 'label')).toEqual([]);
  });

  it('findFilter reads a slot by polarity', () => {
    expect(findFilter(bar, 'label', 'exclude')).toEqual(tagOut('flaky'));
    expect(findFilter(bar, 'label')).toEqual(tagIn('perf'));
  });
});

describe('the wire: exclude_tags only beside an include', () => {
  it('include + exclude travel as tags + exclude_tags, over both transports', () => {
    const bar = [tagIn('perf'), tagOut('flaky', 'ci')];
    const body = filtersToBody(bar);
    expect(body).toEqual({ tags: ['perf'], tags_mode: 'all', exclude_tags: ['flaky', 'ci'] });
    expect(ListMemoriesBodySchema.safeParse(body).success).toBe(true);

    const query = filtersToQueryParams(bar);
    expect(query).toEqual({ tags: 'perf', tags_mode: 'all', exclude_tags: 'flaky,ci' });
    expect(ListMemoriesQuerySchema.safeParse(query).success).toBe(true);
  });

  it('a lone exclusion keeps its historical encoding', () => {
    expect(filtersToBody([tagOut('flaky')])).toEqual({ tags: ['flaky'], tags_mode: 'none' });
  });

  it('a scalar exclusion is its own *_mode, as always', () => {
    expect(filtersToBody([hostNot('aw')])).toEqual({ host: ['aw'], host_mode: 'nin' });
  });
});

describe('retention policies cannot express include + exclude on tags', () => {
  it('flags the combination, and only the combination', () => {
    expect(hasExplorerOnlyFilters([tagIn('perf'), tagOut('flaky')])).toBe(true);
    expect(hasExplorerOnlyFilters([tagOut('flaky')])).toBe(false);
    expect(hasExplorerOnlyFilters([tagIn('perf'), hostNot('aw')])).toBe(false);
  });

  it('a policy prefill keeps what a policy can match and drops the rest visibly', () => {
    expect(policyExpressibleFilters([tagIn('perf'), tagOut('flaky'), hostNot('aw')])).toEqual([
      tagIn('perf'),
      hostNot('aw'),
    ]);
    expect(policyExpressibleFilters([tagOut('flaky')])).toEqual([tagOut('flaky')]);
  });
});
