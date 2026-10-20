import { describe, it, expect } from 'vitest';
import {
  applyMetadataFilterHref,
  filterActionLabel,
  filterAnchorLabel,
  metaValueFilterState,
  metadataFilterTargets,
  nextMetadataFilterState,
  type CurrentExplorerParams,
  type MetadataFilterTarget,
} from './filter-from-metadata';
import type { Filter } from './filters';
import type { LessonEntry } from '@/components/lore/LessonCard';

function lesson(overrides: Partial<LessonEntry> = {}): LessonEntry {
  return {
    key: 'k1',
    value: 'v',
    tags: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    scope: 'project::acme',
    scope_type: 'project',
    ...overrides,
  };
}

const baseParams: CurrentExplorerParams = {
  filters: [],
  scope: null,
  lesson: null,
};

describe('metadataFilterTargets', () => {
  it('produces one filter target per tag', () => {
    const targets = metadataFilterTargets(lesson({ tags: ['perf', 'flaky'] }));
    const labelTargets = targets.filter((t) => t.kind === 'filter' && t.field === 'label');
    expect(labelTargets).toHaveLength(2);
    expect(labelTargets.map((t) => (t as { value: string }).value)).toEqual(['perf', 'flaky']);
  });

  it('maps origin repo/branch/pr to their filter fields', () => {
    const targets = metadataFilterTargets(
      lesson({ origin_repo: 'mthines/lorekit', origin_branch: 'main', origin_pr: 482 }),
    );
    expect(targets).toContainEqual(
      expect.objectContaining({ kind: 'filter', field: 'repo', value: 'mthines/lorekit' }),
    );
    expect(targets).toContainEqual(
      expect.objectContaining({ kind: 'filter', field: 'branch', value: 'main' }),
    );
    expect(targets).toContainEqual(
      expect.objectContaining({ kind: 'filter', field: 'pr', value: '482' }),
    );
  });

  it('maps kind/host/agent/trigger to their filter fields', () => {
    const targets = metadataFilterTargets(
      lesson({ kind: 'lesson', host: 'reviewer', source_agent: 'aw', trigger: 'stuck-loop' }),
    );
    expect(targets).toContainEqual(expect.objectContaining({ kind: 'filter', field: 'kind', value: 'lesson' }));
    expect(targets).toContainEqual(expect.objectContaining({ kind: 'filter', field: 'host', value: 'reviewer' }));
    expect(targets).toContainEqual(expect.objectContaining({ kind: 'filter', field: 'agent', value: 'aw' }));
    expect(targets).toContainEqual(
      expect.objectContaining({ kind: 'filter', field: 'trigger', value: 'stuck-loop' }),
    );
  });

  it('always includes a scope target, for the memory\'s own scope', () => {
    const targets = metadataFilterTargets(lesson({ scope: 'branch::mthines/lorekit::feat/x' }));
    expect(targets).toContainEqual(
      expect.objectContaining({ kind: 'scope', scope: 'branch::mthines/lorekit::feat/x' }),
    );
  });

  it('omits a target for a field with no value', () => {
    const targets = metadataFilterTargets(lesson({ kind: null, host: null }));
    expect(targets.some((t) => t.kind === 'filter' && t.field === 'kind')).toBe(false);
    expect(targets.some((t) => t.kind === 'filter' && t.field === 'host')).toBe(false);
  });

  it('produces no target for recurrence or the lesson key (AC-9)', () => {
    const targets = metadataFilterTargets(lesson({ seen_count: 5, key: 'promote-me' }));
    // No field in the union maps to recurrence or the key — asserted by
    // absence of any target whose value equals the key or the seen_count.
    expect(targets.some((t) => t.kind === 'filter' && (t.value === 'promote-me' || t.value === '5'))).toBe(false);
  });
});

describe('applyMetadataFilterHref', () => {
  it('toggles a filter value into ?filters= and navigates to /lore (AC-6)', () => {
    const href = applyMetadataFilterHref(baseParams, {
      kind: 'filter',
      field: 'label',
      value: 'perf',
      label: 'Filter by label "perf"',
    });
    expect(href.startsWith('/lore?')).toBe(true);
    const params = new URLSearchParams(href.split('?')[1]);
    expect(JSON.parse(params.get('filters') ?? 'null')).toEqual([{ field: 'label', operator: 'all', values: ['perf'] }]);
  });

  it('sets ?scope= (not ?filters=) for a scope target (AC-7)', () => {
    const href = applyMetadataFilterHref(baseParams, {
      kind: 'scope',
      scope: 'repo::mthines/lorekit',
      label: 'Filter by scope repo::mthines/lorekit',
    });
    const params = new URLSearchParams(href.split('?')[1]);
    // `?scope=` is JSON-encoded on the wire (useUrlState's convention), so a
    // bare scope string round-trips through JSON.stringify/parse.
    expect(JSON.parse(params.get('scope') ?? 'null')).toBe('repo::mthines/lorekit');
    expect(params.has('filters')).toBe(false);
  });

  it('preserves an existing ?lesson= across the apply (AC-8/D3)', () => {
    const withLesson: CurrentExplorerParams = { ...baseParams, lesson: '{"scope":"global","key":"k1"}' };
    const href = applyMetadataFilterHref(withLesson, {
      kind: 'filter',
      field: 'host',
      value: 'reviewer',
      label: 'Filter by host reviewer',
    });
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('lesson')).toBe('{"scope":"global","key":"k1"}');
  });

  it('preserves an existing ?memoryId= across the apply', () => {
    const withMemoryId: CurrentExplorerParams = { ...baseParams, memoryId: 'abc-123' };
    const href = applyMetadataFilterHref(withMemoryId, {
      kind: 'scope',
      scope: 'global',
      label: 'Filter by scope global',
    });
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('memoryId')).toBe('abc-123');
  });

  it('preserves the current ?q= search across the apply', () => {
    const withSearch: CurrentExplorerParams = { ...baseParams, q: 'flaky test' };
    const href = applyMetadataFilterHref(withSearch, {
      kind: 'filter',
      field: 'host',
      value: 'reviewer',
      label: 'Filter by host reviewer',
    });
    const params = new URLSearchParams(href.split('?')[1]);
    // JSON-encoded on the wire, same as `?scope=`.
    expect(JSON.parse(params.get('q') ?? 'null')).toBe('flaky test');
  });

  it('omits ?q= when the search box is empty', () => {
    const href = applyMetadataFilterHref({ ...baseParams, q: '' }, {
      kind: 'scope',
      scope: 'global',
      label: 'Filter by scope global',
    });
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.has('q')).toBe(false);
  });

  it('merges with existing filters rather than replacing them', () => {
    const withFilter: CurrentExplorerParams = {
      ...baseParams,
      filters: [{ field: 'kind', operator: 'in', values: ['lesson'] }],
    };
    const href = applyMetadataFilterHref(withFilter, {
      kind: 'filter',
      field: 'host',
      value: 'reviewer',
      label: 'Filter by host reviewer',
    });
    const params = new URLSearchParams(href.split('?')[1]);
    const filters = JSON.parse(params.get('filters') ?? 'null');
    expect(filters).toHaveLength(2);
  });

  it('preserves the current scope when toggling a filter value', () => {
    const withScope: CurrentExplorerParams = { ...baseParams, scope: 'project::acme' };
    const href = applyMetadataFilterHref(withScope, {
      kind: 'filter',
      field: 'agent',
      value: 'aw',
      label: 'Filter by agent aw',
    });
    const params = new URLSearchParams(href.split('?')[1]);
    expect(JSON.parse(params.get('scope') ?? 'null')).toBe('project::acme');
  });
});

describe('applyMetadataFilterHref — filter out', () => {
  const tagTarget = (value: string): MetadataFilterTarget => ({
    kind: 'filter',
    field: 'label',
    value,
    label: `Filter by label "${value}"`,
  });
  const filtersOf = (href: string) =>
    JSON.parse(new URLSearchParams(href.split('?')[1]).get('filters') ?? 'null');

  it('writes a NOT condition for the value', () => {
    expect(filtersOf(applyMetadataFilterHref(baseParams, tagTarget('flaky'), 'exclude'))).toEqual([
      { field: 'label', operator: 'nin', values: ['flaky'] },
    ]);
  });

  it('ANDs the exclusion with a tag already filtered in', () => {
    const current: CurrentExplorerParams = {
      ...baseParams,
      filters: [{ field: 'label', operator: 'all', values: ['perf'] }],
    };
    expect(filtersOf(applyMetadataFilterHref(current, tagTarget('flaky'), 'exclude'))).toEqual([
      { field: 'label', operator: 'all', values: ['perf'] },
      { field: 'label', operator: 'nin', values: ['flaky'] },
    ]);
  });

  it('filter in still defaults when no polarity is given', () => {
    expect(filtersOf(applyMetadataFilterHref(baseParams, tagTarget('perf')))).toEqual([
      { field: 'label', operator: 'all', values: ['perf'] },
    ]);
  });
});

describe('nextMetadataFilterState — the values the panel writes in place on /lore', () => {
  const tag = (value: string): MetadataFilterTarget => ({
    kind: 'filter',
    field: 'label',
    value,
    label: `Filter by label "${value}"`,
  });

  it('a filter target changes ?filters= and carries the scope through', () => {
    const current: CurrentExplorerParams = {
      ...baseParams,
      scope: 'project::acme',
      filters: [{ field: 'label', operator: 'all', values: ['perf'] }],
    };
    expect(nextMetadataFilterState(current, tag('flaky'), 'exclude')).toEqual({
      filters: [
        { field: 'label', operator: 'all', values: ['perf'] },
        { field: 'label', operator: 'nin', values: ['flaky'] },
      ],
      scope: 'project::acme',
    });
  });

  it('a scope target changes ?scope= and leaves the filters as they are', () => {
    const current: CurrentExplorerParams = {
      ...baseParams,
      filters: [{ field: 'host', operator: 'in', values: ['aw'] }],
    };
    expect(
      nextMetadataFilterState(current, { kind: 'scope', scope: 'global', label: 'Filter by scope global' }),
    ).toEqual({ filters: [{ field: 'host', operator: 'in', values: ['aw'] }], scope: 'global' });
  });

  it('removing the last filter drops the param — null, not an empty list', () => {
    const current: CurrentExplorerParams = {
      ...baseParams,
      filters: [{ field: 'label', operator: 'all', values: ['perf'] }],
    };
    expect(nextMetadataFilterState(current, tag('perf'), 'include').filters).toBeNull();
  });

  it('on a legacy ?tags= link, an emptied bar is written explicitly so the old param cannot speak over it', () => {
    // Writing in place keeps every other param — `?tags=` included — so the
    // empty bar has to be a statement, or the legacy fallback resurrects the pill.
    const current: CurrentExplorerParams = {
      ...baseParams,
      filters: [{ field: 'label', operator: 'all', values: ['perf'] }],
      legacyTags: ['perf'],
    };
    expect(nextMetadataFilterState(current, tag('perf'), 'include').filters).toEqual([]);
  });
});

describe('filterActionLabel / filterAnchorLabel', () => {
  it('explains each button, and how to undo a pressed one', () => {
    expect(filterActionLabel('include', 'tag "perf"', null)).toBe('Filter in — show only memories with tag "perf"');
    expect(filterActionLabel('exclude', 'tag "perf"', null)).toBe('Filter out — hide memories with tag "perf"');
    expect(filterActionLabel('include', 'tag "perf"', 'include')).toBe(
      'Filtered in — click to remove tag "perf" from the filter',
    );
    expect(filterActionLabel('exclude', 'tag "perf"', 'exclude')).toBe('Filtered out — click to stop hiding tag "perf"');
    // The OTHER polarity being active does not make this button pressed.
    expect(filterActionLabel('include', 'tag "perf"', 'exclude')).toBe('Filter in — show only memories with tag "perf"');
  });

  it('names the keyboard path on the value itself', () => {
    expect(filterAnchorLabel('host "aw"', true)).toBe('host "aw" — press Enter to filter in, Shift+Enter to filter out');
    expect(filterAnchorLabel('scope "global"', false)).toBe('scope "global" — press Enter to filter in');
  });
});

describe('metaValueFilterState', () => {
  const labelTarget: MetadataFilterTarget = {
    kind: 'filter',
    field: 'label',
    value: 'agent0::incident-memory',
    label: 'Filter by label "agent0::incident-memory"',
  };

  it('matches a label target whose value is selected under `all` (AC-25)', () => {
    const filters: Filter[] = [{ field: 'label', operator: 'all', values: ['agent0::incident-memory'] }];
    expect(metaValueFilterState(labelTarget, filters, null)).toBe('include');
  });

  it('does not match a label target whose value is not selected', () => {
    const filters: Filter[] = [{ field: 'label', operator: 'all', values: ['dataset::default'] }];
    expect(metaValueFilterState(labelTarget, filters, null)).toBeNull();
  });

  it('reads `in` and `all` as filtered in, and `nin` as filtered out', () => {
    for (const operator of ['in', 'all'] as const) {
      const filters: Filter[] = [{ field: 'label', operator, values: ['agent0::incident-memory'] }];
      expect(metaValueFilterState(labelTarget, filters, null)).toBe('include');
    }
    const excluded: Filter[] = [{ field: 'label', operator: 'nin', values: ['agent0::incident-memory'] }];
    expect(metaValueFilterState(labelTarget, excluded, null)).toBe('exclude');
  });

  it('reads each tag slot separately when a tag is included and another excluded', () => {
    const filters: Filter[] = [
      { field: 'label', operator: 'all', values: ['perf'] },
      { field: 'label', operator: 'nin', values: ['agent0::incident-memory'] },
    ];
    expect(metaValueFilterState(labelTarget, filters, null)).toBe('exclude');
    expect(metaValueFilterState({ ...labelTarget, value: 'perf' }, filters, null)).toBe('include');
  });

  it('matches a scope target iff it equals the current ?scope= exactly', () => {
    const target: MetadataFilterTarget = {
      kind: 'scope',
      scope: 'repo::mthines/lorekit',
      label: 'Filter by scope repo::mthines/lorekit',
    };
    expect(metaValueFilterState(target, [], 'repo::mthines/lorekit')).toBe('include');
    expect(metaValueFilterState(target, [], 'repo::other/repo')).toBeNull();
    expect(metaValueFilterState(target, [], null)).toBeNull();
  });

  it('matches repo/branch/pr filter targets the same way as label', () => {
    const repoTarget: MetadataFilterTarget = {
      kind: 'filter',
      field: 'repo',
      value: 'mthines/lorekit',
      label: 'Filter by repository "mthines/lorekit"',
    };
    const branchTarget: MetadataFilterTarget = {
      kind: 'filter',
      field: 'branch',
      value: 'main',
      label: 'Filter by branch "main"',
    };
    const prTarget: MetadataFilterTarget = {
      kind: 'filter',
      field: 'pr',
      value: '482',
      label: 'Filter by pull request "482"',
    };
    const filters: Filter[] = [
      { field: 'repo', operator: 'in', values: ['mthines/lorekit'] },
      { field: 'branch', operator: 'in', values: ['main'] },
      { field: 'pr', operator: 'in', values: ['482'] },
    ];
    expect(metaValueFilterState(repoTarget, filters, null)).toBe('include');
    expect(metaValueFilterState(branchTarget, filters, null)).toBe('include');
    expect(metaValueFilterState(prTarget, filters, null)).toBe('include');
    expect(metaValueFilterState({ ...prTarget, value: '999' }, filters, null)).toBeNull();
  });

  it('matches kind/host/agent/trigger filter targets the same way as label', () => {
    const filters: Filter[] = [
      { field: 'kind', operator: 'in', values: ['lesson'] },
      { field: 'host', operator: 'in', values: ['reviewer'] },
      { field: 'agent', operator: 'in', values: ['aw'] },
      { field: 'trigger', operator: 'in', values: ['stuck-loop'] },
    ];
    const target = (field: 'kind' | 'host' | 'agent' | 'trigger', value: string): MetadataFilterTarget => ({
      kind: 'filter',
      field,
      value,
      label: `Filter by ${field} "${value}"`,
    });
    expect(metaValueFilterState(target('kind', 'lesson'), filters, null)).toBe('include');
    expect(metaValueFilterState(target('host', 'reviewer'), filters, null)).toBe('include');
    expect(metaValueFilterState(target('agent', 'aw'), filters, null)).toBe('include');
    expect(metaValueFilterState(target('trigger', 'stuck-loop'), filters, null)).toBe('include');
    expect(metaValueFilterState(target('kind', 'bus'), filters, null)).toBeNull();
  });

  it('returns false when no filter is applied at all', () => {
    expect(metaValueFilterState(labelTarget, [], null)).toBeNull();
  });
});
