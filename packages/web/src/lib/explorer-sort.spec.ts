import { describe, it, expect } from 'vitest';
import { MemorySortSchema } from '@lorekit/schemas/memory';
import {
  DEFAULT_EXPLORER_SORT,
  EXPLORER_SORTS,
  EXPLORER_SORT_LABELS,
  explorerSortParamValue,
  resolveExplorerSort,
} from './explorer-sort';

describe('resolveExplorerSort', () => {
  it('keeps a known order', () => {
    expect(resolveExplorerSort('opened_count')).toBe('opened_count');
    expect(resolveExplorerSort('created_at')).toBe('created_at');
  });

  it('falls back to Newest for an absent, unknown or non-string value', () => {
    for (const raw of [null, undefined, '', 'read_count', 'updated_at', 42, {}]) {
      expect(resolveExplorerSort(raw)).toBe(DEFAULT_EXPLORER_SORT);
    }
  });
});

describe('explorerSortParamValue', () => {
  it('drops the param for the default and keeps it otherwise', () => {
    expect(explorerSortParamValue('created_at')).toBeNull();
    expect(explorerSortParamValue('opened_count')).toBe('opened_count');
  });
});

describe('EXPLORER_SORTS', () => {
  it('offers only orders the API accepts', () => {
    // An option the list route rejected would be a 400 rendered as "Failed to
    // load memories" the moment a reader picked it.
    for (const sort of EXPLORER_SORTS) {
      expect(MemorySortSchema.safeParse(sort).success, sort).toBe(true);
    }
  });

  it('labels every option', () => {
    for (const sort of EXPLORER_SORTS) expect(EXPLORER_SORT_LABELS[sort].length).toBeGreaterThan(0);
  });
});
