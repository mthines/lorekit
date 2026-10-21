/**
 * `memoryListBody` / `memoryPageFromResponse` are the parts of the old
 * `listMemories` server action that were never about transport. These pin the
 * body it used to send, so moving the request into the browser changed where
 * the list is fetched, not what is asked for.
 */

import { describe, expect, it } from 'vitest';
import type { MemoryEntry, MemoryPageResponse } from '@lorekit/schemas/memory';
import { memoryListBody, memoryPageFromResponse } from './memory-list';

describe('memoryListBody', () => {
  it('asks for one page of active memories, newest first, when nothing is filtered', () => {
    expect(memoryListBody()).toEqual({ limit: 50, sort: 'created_at', archived: false });
  });

  it('clamps the page size to the route maximum', () => {
    expect(memoryListBody({ pageSize: 500 }).limit).toBe(100);
    expect(memoryListBody({ pageSize: 0 }).limit).toBe(50);
  });

  it('sends scope, search, archived view, expiry horizon and cursor under their wire names', () => {
    expect(
      memoryListBody({
        scope: 'repo::mthines/lorekit',
        search: 'flaky',
        showArchived: true,
        expiringWithinDays: 7,
        cursor: 'abc',
        sort: 'opened_count',
      }),
    ).toEqual({
      limit: 50,
      sort: 'opened_count',
      archived: true,
      expiring_within_days: 7,
      scope: 'repo::mthines/lorekit',
      q: 'flaky',
      cursor: 'abc',
    });
  });

  it('leaves out empty scope and search rather than sending blanks', () => {
    const body = memoryListBody({ scope: null, search: '' });
    expect(body).not.toHaveProperty('scope');
    expect(body).not.toHaveProperty('q');
  });

  it('turns an inclusive day range into a half-open created_at window', () => {
    expect(memoryListBody({ range: { from: '2026-07-01', to: '2026-07-26' } })).toMatchObject({
      created_since: '2026-07-01',
      created_until: '2026-07-27T00:00:00.000Z',
    });
  });

  it('folds the deprecated tags shorthand into an all-of label filter', () => {
    expect(memoryListBody({ tags: ['ci', 'flaky'] })).toMatchObject({
      tags: ['ci', 'flaky'],
      tags_mode: 'all',
    });
  });

  it('lets an explicit label filter win over the tags shorthand', () => {
    const body = memoryListBody({
      tags: ['ignored'],
      filters: [{ field: 'label', operator: 'in', values: ['kept'] }],
    });
    expect(body).toMatchObject({ tags: ['kept'], tags_mode: 'any' });
  });

  it('carries retention thresholds so the list matches what a policy would catch', () => {
    expect(memoryListBody({ retentionConditions: { minAgeDays: 30, maxReadCount: 0 } })).toMatchObject({
      min_age_days: 30,
      max_read_count: 0,
    });
  });
});

describe('memoryPageFromResponse', () => {
  it('keeps the keyset envelope and the total, and maps every entry to a lesson row', () => {
    const entry = {
      id: '00000000-0000-0000-0000-000000000001',
      scope: 'global',
      key: 'k',
      value: 'v',
      tags: [],
    } as unknown as MemoryEntry;
    const response = {
      entries: [entry],
      hasMore: true,
      nextCursor: 'next',
      total: 7,
    } as unknown as MemoryPageResponse;

    const page = memoryPageFromResponse(response);

    expect(page).toMatchObject({ hasMore: true, nextCursor: 'next', total: 7 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ id: entry.id, scope: 'global', key: 'k' });
  });
});
