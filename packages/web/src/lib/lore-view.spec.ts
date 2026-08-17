import { describe, expect, it } from 'vitest';
import { DEFAULT_LORE_VIEW, LORE_VIEWS, resolveView, viewParamValue } from './lore-view';

describe('resolveView', () => {
  it.each(LORE_VIEWS)('accepts the %s view', (view) => {
    expect(resolveView(view)).toBe(view);
  });

  it('falls back to the list when the param is absent', () => {
    expect(resolveView(null)).toBe('list');
    expect(resolveView(undefined)).toBe('list');
  });

  it('falls back to the list on a typo rather than erroring', () => {
    // The param arrives from hand-edited URLs and stale bookmarks. A typo
    // should land on the view that can show everything, not on an error.
    expect(resolveView('grpah')).toBe('list');
    expect(resolveView('')).toBe('list');
  });
});

describe('viewParamValue', () => {
  it('keeps the default out of the URL, so a plain /lore link stays canonical', () => {
    expect(viewParamValue(DEFAULT_LORE_VIEW)).toBeNull();
  });

  it('writes a non-default view so the link carries it', () => {
    expect(viewParamValue('map')).toBe('map');
  });

  it('round-trips every view', () => {
    LORE_VIEWS.forEach((view) => {
      expect(resolveView(viewParamValue(view))).toBe(view);
    });
  });
});
