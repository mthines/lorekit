import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INSIGHTS_OPEN,
  DEFAULT_INSIGHTS_VIEW,
  INSIGHTS_VIEWS,
  INSIGHTS_VIEW_ARIA_LABELS,
  INSIGHTS_VIEW_ICONS,
  INSIGHTS_VIEW_LABELS,
  isInsightsView,
} from './explorer-insights-view';
import { parseEnumPreference } from './persisted-preference';

/**
 * The point of this module is that the union and its presentation cannot drift.
 * So the assertions are about COVERAGE — every member has a label, an aria label
 * and an icon — rather than about any one string, which is the property that
 * actually breaks when someone adds a third view.
 */
describe('INSIGHTS_VIEWS', () => {
  it('is the panel’s two bodies, in control order', () => {
    expect(INSIGHTS_VIEWS).toEqual(['charts', 'heatmap']);
  });

  it('gives every view a visible label, an accessible name and an icon', () => {
    for (const view of INSIGHTS_VIEWS) {
      expect(INSIGHTS_VIEW_LABELS[view]).toBeTruthy();
      expect(INSIGHTS_VIEW_ARIA_LABELS[view]).toBeTruthy();
      expect(INSIGHTS_VIEW_ICONS[view]).toBeTruthy();
    }
  });

  it('has no map entry for a view that does not exist', () => {
    // Catches the other direction of drift: a view REMOVED from the union but
    // left behind in a map, which would keep rendering a dead segment.
    const views = new Set<string>(INSIGHTS_VIEWS);
    for (const map of [INSIGHTS_VIEW_LABELS, INSIGHTS_VIEW_ARIA_LABELS, INSIGHTS_VIEW_ICONS]) {
      for (const key of Object.keys(map)) expect(views.has(key)).toBe(true);
    }
  });

  it('gives each view a DISTINCT label and accessible name', () => {
    // Two segments reading the same thing is a control a screen-reader user
    // cannot operate.
    expect(new Set(Object.values(INSIGHTS_VIEW_LABELS)).size).toBe(INSIGHTS_VIEWS.length);
    expect(new Set(Object.values(INSIGHTS_VIEW_ARIA_LABELS)).size).toBe(INSIGHTS_VIEWS.length);
  });
});

describe('defaults', () => {
  it('opens on the selection-aware view', () => {
    // The heatmap ignores the scope, filters and range the controls around the
    // panel express, so opening on it would make the panel look unresponsive.
    expect(DEFAULT_INSIGHTS_VIEW).toBe('charts');
    expect(INSIGHTS_VIEWS).toContain(DEFAULT_INSIGHTS_VIEW);
  });

  it('starts expanded', () => {
    expect(DEFAULT_INSIGHTS_OPEN).toBe(true);
  });
});

describe('isInsightsView', () => {
  it('accepts every member of the union', () => {
    for (const view of INSIGHTS_VIEWS) expect(isInsightsView(view)).toBe(true);
  });

  it('rejects anything else, including non-strings', () => {
    for (const value of ['', 'Charts', 'sparklines', null, undefined, 0, {}]) {
      expect(isInsightsView(value)).toBe(false);
    }
  });
});

describe('reading a stored view', () => {
  it('resolves a stored member and defaults everything else', () => {
    // The composition the panel actually performs, pinned here so the two
    // modules are proven to fit rather than assumed to.
    expect(parseEnumPreference('heatmap', INSIGHTS_VIEWS, DEFAULT_INSIGHTS_VIEW)).toBe('heatmap');
    expect(parseEnumPreference('', INSIGHTS_VIEWS, DEFAULT_INSIGHTS_VIEW)).toBe(
      DEFAULT_INSIGHTS_VIEW,
    );
    expect(parseEnumPreference(null, INSIGHTS_VIEWS, DEFAULT_INSIGHTS_VIEW)).toBe(
      DEFAULT_INSIGHTS_VIEW,
    );
    expect(parseEnumPreference('sparklines', INSIGHTS_VIEWS, DEFAULT_INSIGHTS_VIEW)).toBe(
      DEFAULT_INSIGHTS_VIEW,
    );
  });
});
