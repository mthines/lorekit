import { describe, it, expect } from 'vitest';
import { groomPrompt } from './lore-utility-prompt';
import type { UtilityEntry, UtilityResponse } from '@lorekit/schemas/memory';

const THRESHOLDS: UtilityResponse['thresholds'] = {
  min_deliveries: 10,
  min_age_days: 7,
  chosen_pull_through: 0.02,
  broad_reach_deliveries: 100,
};

const COUNTING_SINCE = '2026-08-28T00:00:00.000Z';

function entry(over: Partial<UtilityEntry> = {}): UtilityEntry {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    scope: 'global',
    key: 'legacy-formatting-rule',
    read_count: 1204,
    opened_count: 2,
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('groomPrompt', () => {
  it('names the quadrant it came from, so the same lines cannot be read as the opposite instruction', () => {
    const prune = groomPrompt({
      quadrant: 'noise-tax',
      entries: [entry()],
      thresholds: THRESHOLDS,
      countingSince: COUNTING_SINCE,
    });
    const promote = groomPrompt({
      quadrant: 'load-bearing',
      entries: [entry()],
      thresholds: THRESHOLDS,
      countingSince: COUNTING_SINCE,
    });

    expect(prune).toContain('"Noise tax" quadrant');
    expect(prune).toContain('Archive it.');
    expect(promote).toContain('"Load-bearing" quadrant');
    expect(promote).toContain('Promote it into a durable project rule');
    // The lesson lines are identical; only the instruction differs. That is the
    // whole reason the bare `scope::key` copy was replaced.
    expect(prune).not.toEqual(promote);
  });

  it('explains the grouping with the SERVER-echoed thresholds, not re-derived constants', () => {
    const prompt = groomPrompt({
      quadrant: 'noise-tax',
      entries: [entry()],
      thresholds: { ...THRESHOLDS, broad_reach_deliveries: 250, chosen_pull_through: 0.05 },
      countingSince: COUNTING_SINCE,
    });

    expect(prompt).toContain('at least 250 times');
    expect(prompt).toContain('under 5.0% of those deliveries');
  });

  it('carries every lesson with the three figures its row shows', () => {
    const prompt = groomPrompt({
      quadrant: 'dormant',
      entries: [
        entry({ scope: 'repo::acme/app', key: 'a', read_count: 12, opened_count: 0 }),
        entry({ scope: 'global', key: 'b', read_count: 1204, opened_count: 2 }),
      ],
      thresholds: THRESHOLDS,
      countingSince: COUNTING_SINCE,
    });

    expect(prompt).toContain('repo::acme/app::a — 12 delivered · 0 chosen · 0.0%');
    // `formatPullThrough` keeps two significant figures below 1%, so a real but
    // tiny rate does not round to a flat zero.
    expect(prompt).toContain('global::b — 1,204 delivered · 2 chosen · 0.17%');
  });

  it('omits the rate for a lesson that has never been delivered, rather than dividing by zero', () => {
    const prompt = groomPrompt({
      quadrant: 'dormant',
      entries: [entry({ read_count: 0, opened_count: 0 })],
      thresholds: THRESHOLDS,
      countingSince: COUNTING_SINCE,
    });

    expect(prompt).toContain('global::legacy-formatting-rule — 0 delivered · 0 chosen\n');
    expect(prompt).not.toContain('NaN');
  });

  it('puts the variable input LAST and fences it', () => {
    const prompt = groomPrompt({
      quadrant: 'noise-tax',
      entries: [entry()],
      thresholds: THRESHOLDS,
      countingSince: COUNTING_SINCE,
    });

    expect(prompt.trimEnd().endsWith('</lessons>')).toBe(true);
    // `lastIndexOf`, not `indexOf`: the opening sentence NAMES `<lessons>`
    // ("Groom the LoreKit lessons listed in <lessons>.") before the block
    // itself, so the first occurrence is a reference, not the fence.
    expect(prompt.indexOf('<constraints>')).toBeLessThan(prompt.lastIndexOf('<lessons>'));
    expect(prompt.lastIndexOf('<lessons>')).toBeGreaterThan(prompt.indexOf('</constraints>'));
  });

  it('always requires approval before a destructive action', () => {
    for (const quadrant of ['load-bearing', 'specialist', 'noise-tax', 'dormant', 'unproven'] as const) {
      const prompt = groomPrompt({
        quadrant,
        entries: [entry()],
        thresholds: THRESHOLDS,
        countingSince: COUNTING_SINCE,
      });
      expect(prompt).toContain('wait for my approval before any write, archive, or delete');
      expect(prompt).toContain('Act only on the lessons inside <lessons>');
    }
  });

  it('forbids archiving in the one quadrant whose point is that nothing is known yet', () => {
    const prompt = groomPrompt({
      quadrant: 'unproven',
      entries: [entry()],
      thresholds: THRESHOLDS,
      countingSince: COUNTING_SINCE,
    });

    expect(prompt).toContain('Do not archive or delete anything in this list');
    expect(prompt).not.toContain('Archive it.');
  });

  it('renders counting_since as a bare ISO date, so no locale can reorder it', () => {
    const prompt = groomPrompt({
      quadrant: 'dormant',
      entries: [entry()],
      thresholds: THRESHOLDS,
      countingSince: '2026-08-28T13:45:00.000Z',
    });

    expect(prompt).toContain('all-time since 2026-08-28,');
  });

  it('still produces a usable prompt for an empty quadrant', () => {
    const prompt = groomPrompt({
      quadrant: 'dormant',
      entries: [],
      thresholds: THRESHOLDS,
      countingSince: COUNTING_SINCE,
    });

    expect(prompt).toContain('<lessons>\n</lessons>');
  });
});
