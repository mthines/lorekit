import { describe, expect, it } from 'vitest';
import { buildLoreGraph, type GraphMemoryInput } from './build';
import { coverageNotice, graphSummary, truncationNotice } from './summary';
import { EMPTY_GRAPH } from './types';

function memory(key: string, scope = 'repo::mthines/lorekit', tags: string[] = []): GraphMemoryInput {
  return { key, scope, tags, updated_at: '2026-01-01T00:00:00.000Z' };
}

describe('graphSummary', () => {
  it('says so plainly when there is nothing to draw', () => {
    expect(graphSummary(EMPTY_GRAPH)).toBe('No memories to map.');
  });

  it('counts memories, scopes and relationships', () => {
    const graph = buildLoreGraph([
      memory('a', 'global', ['x']),
      memory('b', 'global', ['x']),
      memory('c', 'repo::a/b'),
    ]);
    expect(graphSummary(graph)).toBe('Map of 3 memories across 2 scopes, 1 relationship drawn.');
  });

  it('uses singular forms for one of each', () => {
    expect(graphSummary(buildLoreGraph([memory('a')]))).toBe(
      'Map of 1 memory across 1 scope, 0 relationships drawn.',
    );
  });

  it('does not count the scope skeleton as a relationship', () => {
    // Three memories in one scope means three skeleton edges and no relations —
    // announcing "3 relationships drawn" would describe connections the reader
    // cannot act on.
    expect(graphSummary(buildLoreGraph([memory('a'), memory('b'), memory('c')]))).toContain(
      '0 relationships drawn',
    );
  });

  it('names the selection last, where a live-region re-read expects the change', () => {
    const summary = graphSummary(buildLoreGraph([memory('a')]), 'aw-lessons::worktree-first');
    expect(summary.endsWith('aw-lessons::worktree-first selected.')).toBe(true);
  });

  it('omits the selection clause when nothing is selected', () => {
    expect(graphSummary(buildLoreGraph([memory('a')]), null)).not.toContain('selected');
  });

  it('groups thousands so a large account is readable aloud', () => {
    const graph = buildLoreGraph(Array.from({ length: 1_500 }, (_, i) => memory(`m${i}`)));
    expect(graphSummary(graph)).toContain('1,500 memories');
  });
});

describe('truncationNotice', () => {
  it('is null when nothing was clipped', () => {
    expect(truncationNotice(buildLoreGraph([memory('a')]))).toBeNull();
  });

  it('says the real numbers rather than hedging', () => {
    const graph = buildLoreGraph([memory('a'), memory('b'), memory('c')], { maxNodes: 2 });
    expect(truncationNotice(graph)).toBe(
      'This map is capped for legibility — showing the 2 most recently updated of 3 memories.',
    );
  });

  it('reports a clipped relationship budget', () => {
    const graph = buildLoreGraph([memory('a', 'global', ['x']), memory('b', 'global', ['x'])], {
      maxEdges: 0,
    });
    expect(truncationNotice(graph)).toContain('strongest of 1 relationships');
  });

  it('reports both budgets in one sentence when both fired', () => {
    const graph = buildLoreGraph(
      [
        memory('a', 'global', ['x']),
        memory('b', 'global', ['x']),
        memory('c', 'global', ['x']),
      ],
      { maxNodes: 2, maxEdges: 0 },
    );
    const notice = truncationNotice(graph) ?? '';

    expect(notice).toContain('memories');
    expect(notice).toContain('relationships');
    expect(notice.split('.').filter(Boolean)).toHaveLength(1);
  });
});

describe('coverageNotice', () => {
  it('is null when the whole result set is loaded and nothing was clipped', () => {
    expect(coverageNotice(buildLoreGraph([memory('a')]))).toBeNull();
  });

  it('says the map is a prefix when more pages are pending', () => {
    expect(coverageNotice(buildLoreGraph([memory('a')]), { hasMore: true })).toBe(
      'This map draws only the memories loaded so far — scroll the list to load the rest.',
    );
  });

  it('leads with the pagination truth, then the cap', () => {
    const graph = buildLoreGraph([memory('a'), memory('b'), memory('c')], { maxNodes: 2 });
    const notice = coverageNotice(graph, { hasMore: true }) ?? '';

    expect(notice.indexOf('loaded so far')).toBeLessThan(notice.indexOf('capped for legibility'));
  });

  it('still reports a cap on a fully-loaded result set', () => {
    const graph = buildLoreGraph([memory('a'), memory('b'), memory('c')], { maxNodes: 2 });
    expect(coverageNotice(graph)).toBe(truncationNotice(graph));
  });
});
