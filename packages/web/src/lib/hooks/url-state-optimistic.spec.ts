/**
 * The shared optimistic layer behind `useUrlState`.
 *
 * What these pin: a write is visible to EVERY reader of its key at once (the
 * detail panel's filter shows in the Explorer before the navigation lands),
 * and a pending write can never outlive the reason it existed — the URL
 * catching up, the reader leaving the page, or the last reader unmounting.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UNSET,
  readOptimistic,
  resetOptimisticForTests,
  retainOptimistic,
  settleOptimistic,
  subscribeOptimistic,
  writeOptimistic,
} from './url-state-optimistic';

afterEach(() => resetOptimisticForTests());

describe('url-state-optimistic', () => {
  it('is UNSET until a key is written', () => {
    expect(readOptimistic('filters')).toBe(UNSET);
  });

  it('shares one pending value per key, and tells every subscriber', () => {
    const explorer = vi.fn();
    const panel = vi.fn();
    const unsubscribeExplorer = subscribeOptimistic(explorer);
    const unsubscribePanel = subscribeOptimistic(panel);

    const value = [{ field: 'label', operator: 'nin', values: ['flaky'] }];
    writeOptimistic('filters', value, '/lore');

    expect(readOptimistic('filters')).toBe(value);
    expect(readOptimistic('scope')).toBe(UNSET);
    expect(explorer).toHaveBeenCalledTimes(1);
    expect(panel).toHaveBeenCalledTimes(1);
    unsubscribeExplorer();
    unsubscribePanel();
  });

  it('returns the same reference on every read, as useSyncExternalStore requires', () => {
    writeOptimistic('filters', { a: 1 }, '/lore');
    expect(readOptimistic('filters')).toBe(readOptimistic('filters'));
  });

  it('keeps the value until the URL holds it', () => {
    writeOptimistic('filters', ['b'], '/lore');
    settleOptimistic('filters', { pathname: '/lore', urlMatches: false });
    expect(readOptimistic('filters')).toEqual(['b']);
    settleOptimistic('filters', { pathname: '/lore', urlMatches: true });
    expect(readOptimistic('filters')).toBe(UNSET);
  });

  it('drops the value once the reader is on another page — it can never land there', () => {
    writeOptimistic('filters', ['b'], '/lore');
    settleOptimistic('filters', { pathname: '/insights', urlMatches: false });
    expect(readOptimistic('filters')).toBe(UNSET);
  });

  it('drops the value with the last reader of the key, not before', () => {
    const releaseExplorer = retainOptimistic('filters');
    const releasePanel = retainOptimistic('filters');
    writeOptimistic('filters', ['b'], '/lore');

    releaseExplorer();
    expect(readOptimistic('filters')).toEqual(['b']);
    releasePanel();
    expect(readOptimistic('filters')).toBe(UNSET);
  });

  it('a later write replaces an earlier one — the newest click wins', () => {
    writeOptimistic('filters', ['a'], '/lore');
    writeOptimistic('filters', ['a', 'b'], '/lore');
    expect(readOptimistic('filters')).toEqual(['a', 'b']);
  });
});
