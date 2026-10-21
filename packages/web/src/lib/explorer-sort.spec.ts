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
    expect(resolveExplorerSort('last_opened_at')).toBe('last_opened_at');
  });

  it('falls back to Newest for an absent, unknown or non-string value', () => {
    for (const raw of [null, undefined, '', 'read_count', 'last_read_at', 'updated_at', 42, {}]) {
      expect(resolveExplorerSort(raw)).toBe(DEFAULT_EXPLORER_SORT);
    }
  });
});

describe('explorerSortParamValue', () => {
  it('drops the param for the default and keeps it otherwise', () => {
    expect(explorerSortParamValue('created_at')).toBeNull();
    expect(explorerSortParamValue('opened_count')).toBe('opened_count');
    expect(explorerSortParamValue('last_opened_at')).toBe('last_opened_at');
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

  it('offers Recent read, ordered by the last DELIBERATE read', () => {
    // `last_opened_at`, not `last_read_at`: a bulk list/search page bumps the
    // latter, and "Recent read" means a lesson an agent reached for.
    expect(EXPLORER_SORTS).toContain('last_opened_at');
    expect(EXPLORER_SORTS).not.toContain('last_read_at');
    expect(EXPLORER_SORT_LABELS.last_opened_at).toBe('Recent read');
  });
});
