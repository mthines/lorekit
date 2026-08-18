import { describe, expect, it } from 'vitest';
import {
  buildLoreGraph,
  keyNamespace,
  memoryNodeId,
  scopeNodeId,
  type GraphMemoryInput,
} from './build';
import type { GraphEdge } from './types';

/** A memory with only the fields under test set; everything else is inert. */
function memory(overrides: Partial<GraphMemoryInput> & Pick<GraphMemoryInput, 'key'>): GraphMemoryInput {
  return {
    scope: 'repo::mthines/lorekit',
    updated_at: '2026-01-01T00:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

/** Edges of one kind, as readable `a→b` strings against the node id list. */
function edgesOfKind(
  graph: { nodes: readonly { id: string }[]; edges: readonly GraphEdge[] },
  kind: GraphEdge['kind'],
): string[] {
  return graph.edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => `${graph.nodes[edge.source].id}→${graph.nodes[edge.target].id}`)
    .sort();
}

describe('keyNamespace', () => {
  it('reads the namespace of a `namespace::slug` key', () => {
    expect(keyNamespace('aw-lessons::worktree-first')).toBe('aw-lessons');
  });

  it('is null for an un-namespaced key, so those are not all siblings', () => {
    expect(keyNamespace('deploy-runbook')).toBeNull();
  });

  it('is null when the separator opens the key (there is no namespace)', () => {
    expect(keyNamespace('::orphan')).toBeNull();
  });
});

describe('buildLoreGraph', () => {
  it('is empty for no memories', () => {
    expect(buildLoreGraph([])).toEqual({ nodes: [], edges: [], truncated: [] });
  });

  it('gives every memory a node and every scope one node, joined by a scope edge', () => {
    const graph = buildLoreGraph([
      memory({ key: 'a' }),
      memory({ key: 'b' }),
      memory({ key: 'c', scope: 'global' }),
    ]);

    expect(graph.nodes.filter((n) => n.kind === 'memory')).toHaveLength(3);
    expect(graph.nodes.filter((n) => n.kind === 'scope').map((n) => n.id).sort()).toEqual(
      [scopeNodeId('repo::mthines/lorekit'), scopeNodeId('global')].sort(),
    );
    expect(graph.edges.filter((e) => e.kind === 'scope')).toHaveLength(3);
  });

  it('identifies a memory node by its natural key, not its list position', () => {
    const [first] = buildLoreGraph([memory({ key: 'a' })]).nodes;
    expect(first.id).toBe(memoryNodeId({ scope: 'repo::mthines/lorekit', key: 'a' }));
  });

  it('orders memory nodes newest-first so the graph is stable across refetches', () => {
    const input = [
      memory({ key: 'old', updated_at: '2026-01-01T00:00:00.000Z' }),
      memory({ key: 'new', updated_at: '2026-03-01T00:00:00.000Z' }),
    ];
    const forward = buildLoreGraph(input).nodes.map((n) => n.label);
    const reversed = buildLoreGraph([...input].reverse()).nodes.map((n) => n.label);

    expect(forward.slice(0, 2)).toEqual(['new', 'old']);
    expect(reversed).toEqual(forward);
  });

  it('connects two memories that share a label', () => {
    const graph = buildLoreGraph([
      memory({ key: 'a', tags: ['ci'] }),
      memory({ key: 'b', tags: ['ci'] }),
      memory({ key: 'c', tags: ['ux'] }),
    ]);

    expect(edgesOfKind(graph, 'label')).toEqual([
      `${memoryNodeId({ scope: 'repo::mthines/lorekit', key: 'a' })}→${memoryNodeId({ scope: 'repo::mthines/lorekit', key: 'b' })}`,
    ]);
  });

  it('scores a pair sharing every label above one sharing a single label of many', () => {
    const graph = buildLoreGraph([
      memory({ key: 'twin-a', tags: ['ci'] }),
      memory({ key: 'twin-b', tags: ['ci'] }),
      memory({ key: 'broad', tags: ['ci', 'ux', 'perf', 'a11y'] }),
    ]);
    const strengths = graph.edges
      .filter((e) => e.kind === 'label')
      .map((e) => e.strength)
      .sort((a, b) => b - a);

    expect(strengths[0]).toBe(1);
    expect(strengths[strengths.length - 1]).toBeLessThan(1);
  });

  it('does not connect a memory to itself when it repeats a label', () => {
    const graph = buildLoreGraph([memory({ key: 'a', tags: ['ci', 'ci'] })]);
    expect(graph.edges.filter((e) => e.kind === 'label')).toHaveLength(0);
  });

  it('drops a hub term rather than drawing its quadratic pair explosion', () => {
    const hubbed = Array.from({ length: 40 }, (_, i) => memory({ key: `m${i}`, tags: ['loop::aw-lessons'] }));

    // 40 memories all carrying one label is 780 pairs — every one of them noise.
    expect(buildLoreGraph(hubbed, { hubSize: 10 }).edges.filter((e) => e.kind === 'label')).toHaveLength(0);
    // Raise the threshold above the posting list and the same term is a relation again.
    expect(
      buildLoreGraph(hubbed, { hubSize: 64, maxDegree: 64 }).edges.filter((e) => e.kind === 'label').length,
    ).toBeGreaterThan(0);
  });

  it('connects siblings in one key namespace and nothing across namespaces', () => {
    const graph = buildLoreGraph([
      memory({ key: 'aw-lessons::one', scope: 'global' }),
      memory({ key: 'aw-lessons::two', scope: 'global' }),
      memory({ key: 'ci-lessons::three', scope: 'global' }),
    ]);
    expect(edgesOfKind(graph, 'key')).toHaveLength(1);
  });

  it('connects memories recorded from the same repository', () => {
    const graph = buildLoreGraph([
      memory({ key: 'a', origin_repo: 'mthines/lorekit' }),
      memory({ key: 'b', origin_repo: 'mthines/lorekit' }),
      memory({ key: 'c', origin_repo: 'mthines/graft' }),
    ]);
    expect(edgesOfKind(graph, 'repo')).toHaveLength(1);
  });

  it('derives only the requested relation kinds', () => {
    const input = [
      memory({ key: 'ns::a', tags: ['ci'], origin_repo: 'r' }),
      memory({ key: 'ns::b', tags: ['ci'], origin_repo: 'r' }),
    ];
    const kinds = new Set(buildLoreGraph(input, { kinds: ['label'] }).edges.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['label', 'scope']);
  });

  it('does not let a suppressed hub term dilute the pair it was excluded from', () => {
    // A hub term is declared "not evidence of a relationship". Leaving it in the
    // Jaccard denominator makes it evidence AGAINST one, which is the opposite:
    // two memories sharing a niche label, each also carrying fifteen hub labels,
    // used to score 0.032 and sink below a pair sharing one of two ordinary
    // labels.
    const hubLabels = Array.from({ length: 15 }, (_, i) => `loop::h${i}`);
    const graph = buildLoreGraph(
      [
        memory({ key: 'a', tags: [...hubLabels, 'niche'] }),
        memory({ key: 'b', tags: [...hubLabels, 'niche'] }),
        ...Array.from({ length: 18 }, (_, i) => memory({ key: `filler${i}`, tags: hubLabels })),
      ],
      { hubSize: 10, kinds: ['label'] },
    );

    const pair = graph.edges.find((edge) => edge.kind === 'label');
    expect(pair?.strength).toBe(1);
  });

  it('still counts a memory’s unshared labels against it', () => {
    // Single-occurrence terms are real, discriminating vocabulary — they just
    // have no partner here — so unlike hub terms they stay in the denominator.
    const graph = buildLoreGraph(
      [
        memory({ key: 'narrow', tags: ['shared'] }),
        memory({ key: 'wide', tags: ['shared', 'mine-alone', 'also-mine'] }),
      ],
      { kinds: ['label'] },
    );

    expect(graph.edges.find((edge) => edge.kind === 'label')?.strength).toBeLessThan(1);
  });

  it('weights a shared repo below a shared key namespace below a shared label', () => {
    // Jaccard alone is not comparable across kinds: `key` and `repo` contribute
    // exactly one term each, so both would score a perfect 1.0 and outrank even
    // a genuine label twin. KIND_WEIGHT is what makes the numbers mean the same
    // thing, and the ordering it produces is the point.
    const strengthOf = (kind: 'label' | 'key' | 'repo') => {
      const graph = buildLoreGraph(
        [
          memory({ key: 'ns::a', tags: ['only'], origin_repo: 'o/r' }),
          memory({ key: 'ns::b', tags: ['only'], origin_repo: 'o/r' }),
        ],
        { kinds: [kind] },
      );
      return graph.edges.find((edge) => edge.kind === kind)?.strength ?? 0;
    };

    expect(strengthOf('label')).toBeGreaterThan(strengthOf('key'));
    expect(strengthOf('key')).toBeGreaterThan(strengthOf('repo'));
  });

  it('ranks a shared label above a shared repo when both connect the same pair', () => {
    const graph = buildLoreGraph([
      memory({ key: 'a', tags: ['ci'], origin_repo: 'o/r' }),
      memory({ key: 'b', tags: ['ci'], origin_repo: 'o/r' }),
    ]);
    const strongest = graph.edges
      .filter((edge) => edge.kind !== 'scope')
      .sort((x, y) => y.strength - x.strength)[0];

    expect(strongest.kind).toBe('label');
  });

  it('draws the same graph whichever order the kinds were requested in', () => {
    // `Array#sort` is stable, so without a kind term in the tie-break the
    // surviving edge under a tight budget would depend on generation order.
    const input = [
      memory({ key: 'ns::a', tags: ['x'], origin_repo: 'o/r' }),
      memory({ key: 'ns::b', tags: ['x'], origin_repo: 'o/r' }),
    ];
    const asKinds = (kinds: ('label' | 'key' | 'repo')[]) =>
      buildLoreGraph(input, { kinds, maxEdges: 1 })
        .edges.filter((edge) => edge.kind !== 'scope')
        .map((edge) => `${edge.kind}:${edge.strength}`);

    expect(asKinds(['repo', 'key', 'label'])).toEqual(asKinds(['label', 'key', 'repo']));
  });

  it('spends the degree budget on distinct neighbours, not on parallel edges', () => {
    // `twin` shares a label, a key namespace AND a repo with `hub` — three edges
    // between one pair. Counting edges would declare the hub full after that
    // single neighbour; counting neighbours leaves room for the second one,
    // which is what the budget is actually protecting.
    const graph = buildLoreGraph(
      [
        memory({ key: 'ns::hub', tags: ['x'], origin_repo: 'o/r' }),
        memory({ key: 'ns::twin', tags: ['x'], origin_repo: 'o/r' }),
        memory({ key: 'other::third', tags: ['x'] }),
      ],
      { maxDegree: 2 },
    );

    const hubIndex = graph.nodes.findIndex((node) => node.label === 'ns::hub');
    const distinct = new Set(
      graph.edges
        .filter((edge) => edge.kind !== 'scope' && (edge.source === hubIndex || edge.target === hubIndex))
        .map((edge) => (edge.source === hubIndex ? edge.target : edge.source)),
    );

    expect(distinct.size).toBe(2);
  });

  it('still refuses a genuinely over-connected node', () => {
    const graph = buildLoreGraph(
      [
        memory({ key: 'hub', tags: ['a', 'b', 'c', 'd', 'e'] }),
        ...['a', 'b', 'c', 'd', 'e'].map((tag) => memory({ key: `n-${tag}`, tags: [tag] })),
      ],
      { maxDegree: 2 },
    );

    const hubIndex = graph.nodes.findIndex((node) => node.label === 'hub');
    const distinct = new Set(
      graph.edges
        .filter((edge) => edge.kind !== 'scope' && (edge.source === hubIndex || edge.target === hubIndex))
        .map((edge) => (edge.source === hubIndex ? edge.target : edge.source)),
    );

    expect(distinct.size).toBe(2);
  });

  it('caps a memory’s relation degree, keeping its strongest neighbours', () => {
    // `twin` overlaps the hub on three of six labels (Jaccard 0.5); each `nX`
    // overlaps on exactly one (0.167). With room for one relation, the cap must
    // keep the twin.
    const graph = buildLoreGraph(
      [
        memory({ key: 'hub', tags: ['t0', 't1', 't2', 't3', 't4', 't5'] }),
        memory({ key: 'twin', tags: ['t0', 't1', 't2'] }),
        ...Array.from({ length: 6 }, (_, i) => memory({ key: `n${i}`, tags: [`t${i}`] })),
      ],
      { maxDegree: 2 },
    );

    const hubId = memoryNodeId({ scope: 'repo::mthines/lorekit', key: 'hub' });
    const hubIndex = graph.nodes.findIndex((n) => n.id === hubId);
    const hubEdges = graph.edges.filter(
      (e) => e.kind !== 'scope' && (e.source === hubIndex || e.target === hubIndex),
    );

    expect(hubEdges).toHaveLength(2);
    const twinId = memoryNodeId({ scope: 'repo::mthines/lorekit', key: 'twin' });
    const neighbours = hubEdges.map((e) => graph.nodes[e.source === hubIndex ? e.target : e.source].id);
    expect(neighbours).toContain(twinId);
  });

  it('keeps the scope skeleton even when every relation edge is capped away', () => {
    const graph = buildLoreGraph(
      [memory({ key: 'a', tags: ['ci'] }), memory({ key: 'b', tags: ['ci'] })],
      { maxEdges: 0 },
    );
    expect(graph.edges.filter((e) => e.kind === 'scope')).toHaveLength(2);
    expect(graph.edges.filter((e) => e.kind === 'label')).toHaveLength(0);
  });

  it('reports what a node budget dropped instead of quietly drawing a subset', () => {
    const graph = buildLoreGraph(
      [
        memory({ key: 'newest', updated_at: '2026-03-01T00:00:00.000Z' }),
        memory({ key: 'oldest', updated_at: '2020-01-01T00:00:00.000Z' }),
      ],
      { maxNodes: 1 },
    );

    expect(graph.nodes.filter((n) => n.kind === 'memory').map((n) => n.label)).toEqual(['newest']);
    expect(graph.truncated).toContainEqual({ of: 'nodes', total: 2, kept: 1 });
  });

  it('reports what an edge budget dropped', () => {
    const graph = buildLoreGraph(
      [
        memory({ key: 'a', tags: ['x'] }),
        memory({ key: 'b', tags: ['x'] }),
        memory({ key: 'c', tags: ['x'] }),
      ],
      { maxEdges: 1 },
    );
    expect(graph.truncated).toContainEqual({ of: 'edges', total: 3, kept: 1 });
  });

  it('says nothing was truncated when nothing was', () => {
    expect(buildLoreGraph([memory({ key: 'a' })]).truncated).toEqual([]);
  });

  it('weights a recurring lesson above a one-off, and a big scope above a small one', () => {
    const graph = buildLoreGraph([
      memory({ key: 'recurring', seen_count: 12 }),
      memory({ key: 'once', seen_count: 1 }),
      memory({ key: 'lonely', scope: 'global' }),
    ]);
    const weightOf = (id: string) => graph.nodes.find((n) => n.id === id)?.weight ?? -1;

    expect(weightOf(memoryNodeId({ scope: 'repo::mthines/lorekit', key: 'recurring' }))).toBeGreaterThan(
      weightOf(memoryNodeId({ scope: 'repo::mthines/lorekit', key: 'once' })),
    );
    expect(weightOf(scopeNodeId('repo::mthines/lorekit'))).toBeGreaterThan(weightOf(scopeNodeId('global')));
  });

  it('draws every memory at the base size when no row carries a seen_count', () => {
    // `seen_count` arrives with migration 00059, so an account can legitimately
    // have none. With no spread there is no signal to encode, and the honest
    // rendering is the BASE size — the earlier `max <= 1 ⇒ 1` guard drew the
    // ENTIRE graph at maximum radius, which is the size channel shouting while
    // meaning nothing.
    const graph = buildLoreGraph([memory({ key: 'a' }), memory({ key: 'b' }), memory({ key: 'c' })]);
    const memories = graph.nodes.filter((node) => node.kind === 'memory');

    expect(memories).toHaveLength(3);
    expect(memories.every((node) => node.weight === 0)).toBe(true);
  });

  it('still separates sizes as soon as one row carries a recurrence', () => {
    const graph = buildLoreGraph([memory({ key: 'once' }), memory({ key: 'often', seen_count: 9 })]);
    const weightOf = (label: string) => graph.nodes.find((node) => node.label === label)?.weight ?? -1;

    expect(weightOf('often')).toBeGreaterThan(weightOf('once'));
  });

  it('dates a scope by its freshest memory', () => {
    const graph = buildLoreGraph([
      memory({ key: 'stale', updated_at: '2020-01-01T00:00:00.000Z' }),
      memory({ key: 'fresh', updated_at: '2026-03-01T00:00:00.000Z' }),
    ]);
    const scope = graph.nodes.find((n) => n.id === scopeNodeId('repo::mthines/lorekit'));
    expect(scope?.updatedAt).toBe(Date.parse('2026-03-01T00:00:00.000Z'));
  });

  it('marks a scope archived only when all of its memories are', () => {
    const partly = buildLoreGraph([
      memory({ key: 'a', archived_at: '2026-01-02T00:00:00.000Z' }),
      memory({ key: 'b' }),
    ]);
    const wholly = buildLoreGraph([
      memory({ key: 'a', archived_at: '2026-01-02T00:00:00.000Z' }),
      memory({ key: 'b', archived_at: '2026-01-02T00:00:00.000Z' }),
    ]);

    expect(partly.nodes.find((n) => n.kind === 'scope')?.archived).toBe(false);
    expect(wholly.nodes.find((n) => n.kind === 'scope')?.archived).toBe(true);
  });

  it('colours a node by its scope type', () => {
    const graph = buildLoreGraph([memory({ key: 'a', scope: 'branch::feat/x' })]);
    expect(graph.nodes[0].scopeType).toBe('branch');
  });

  it('holds its budgets at a plan-ceiling account', () => {
    // 5,000 memories is the free-plan cap (docs/limits.md) — the worst case the
    // dashboard can actually be handed.
    //
    // Deliberately NOT a wall-clock assertion: it would be the one check in the
    // suite that can go red on a noisy CI runner with no code change, and a
    // flaky guard trains everyone to re-run rather than to read. Timing figures
    // for the design doc come from `scripts/bench-lore-graph.mjs`, which gates
    // nothing.
    //
    // The bounded OUTPUT alone would not catch an all-pairs regression either —
    // disable hub suppression and the node, edge and degree caps still clamp
    // everything to the same numbers; only the runtime explodes. What actually
    // separates the two worlds is the CANDIDATE count before capping, which
    // `truncated` reports: ~26k with hub suppression, millions without. That is
    // a deterministic, machine-independent proxy for the work done, so it is
    // what this asserts.
    const many = Array.from({ length: 5_000 }, (_, i) =>
      memory({
        key: `bucket-${i % 40}::lesson-${i}`,
        scope: `repo::owner/repo-${i % 25}`,
        tags: [`t${i % 300}`, `t${i % 97}`],
        updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 3600)).toISOString(),
      }),
    );

    const graph = buildLoreGraph(many);

    expect(graph.nodes).toHaveLength(5_000 + 25);
    expect(graph.edges.length).toBeLessThanOrEqual(5_000 + 15_000);

    // The work bound. Without hub suppression this dataset generates millions of
    // candidate pairs; with it, tens of thousands. The ceiling is generous
    // enough not to be brittle and orders of magnitude below the regression.
    const consideredEdges = graph.truncated.find((entry) => entry.of === 'edges');
    expect(consideredEdges?.total ?? 0).toBeLessThan(200_000);

    // Every node keeps at most `maxDegree` distinct relation neighbours.
    const distinct = new Map<number, Set<number>>();
    for (const edge of graph.edges) {
      if (edge.kind === 'scope') continue;
      (distinct.get(edge.source) ?? distinct.set(edge.source, new Set()).get(edge.source))?.add(edge.target);
      (distinct.get(edge.target) ?? distinct.set(edge.target, new Set()).get(edge.target))?.add(edge.source);
    }
    expect(Math.max(...[...distinct.values()].map((set) => set.size))).toBeLessThanOrEqual(12);
  });
});
