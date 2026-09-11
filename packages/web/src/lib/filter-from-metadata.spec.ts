import { describe, it, expect } from 'vitest';
import {
  applyMetadataFilterHref,
  isMetaValueActiveFilter,
  metadataFilterTargets,
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

describe('isMetaValueActiveFilter', () => {
  const labelTarget: MetadataFilterTarget = {
    kind: 'filter',
    field: 'label',
    value: 'agent0::incident-memory',
    label: 'Filter by label "agent0::incident-memory"',
  };

  it('matches a label target whose value is selected under `all` (AC-25)', () => {
    const filters: Filter[] = [{ field: 'label', operator: 'all', values: ['agent0::incident-memory'] }];
    expect(isMetaValueActiveFilter(labelTarget, filters, null)).toBe(true);
  });

  it('does not match a label target whose value is not selected', () => {
    const filters: Filter[] = [{ field: 'label', operator: 'all', values: ['dataset::default'] }];
    expect(isMetaValueActiveFilter(labelTarget, filters, null)).toBe(false);
  });

  it('matches regardless of operator — `in`, `nin`, and `all` all count as applied', () => {
    for (const operator of ['in', 'nin', 'all'] as const) {
      const filters: Filter[] = [{ field: 'label', operator, values: ['agent0::incident-memory'] }];
      expect(isMetaValueActiveFilter(labelTarget, filters, null)).toBe(true);
    }
  });

  it('matches a scope target iff it equals the current ?scope= exactly', () => {
    const target: MetadataFilterTarget = {
      kind: 'scope',
      scope: 'repo::mthines/lorekit',
      label: 'Filter by scope repo::mthines/lorekit',
    };
    expect(isMetaValueActiveFilter(target, [], 'repo::mthines/lorekit')).toBe(true);
    expect(isMetaValueActiveFilter(target, [], 'repo::other/repo')).toBe(false);
    expect(isMetaValueActiveFilter(target, [], null)).toBe(false);
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
    expect(isMetaValueActiveFilter(repoTarget, filters, null)).toBe(true);
    expect(isMetaValueActiveFilter(branchTarget, filters, null)).toBe(true);
    expect(isMetaValueActiveFilter(prTarget, filters, null)).toBe(true);
    expect(isMetaValueActiveFilter({ ...prTarget, value: '999' }, filters, null)).toBe(false);
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
    expect(isMetaValueActiveFilter(target('kind', 'lesson'), filters, null)).toBe(true);
    expect(isMetaValueActiveFilter(target('host', 'reviewer'), filters, null)).toBe(true);
    expect(isMetaValueActiveFilter(target('agent', 'aw'), filters, null)).toBe(true);
    expect(isMetaValueActiveFilter(target('trigger', 'stuck-loop'), filters, null)).toBe(true);
    expect(isMetaValueActiveFilter(target('kind', 'bus'), filters, null)).toBe(false);
  });

  it('returns false when no filter is applied at all', () => {
    expect(isMetaValueActiveFilter(labelTarget, [], null)).toBe(false);
  });
});
