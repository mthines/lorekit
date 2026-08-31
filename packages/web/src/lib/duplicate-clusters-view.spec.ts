import { describe, expect, it } from 'vitest';
import type { ClustersResponse, DuplicateCluster } from '@lorekit/schemas/memory';
import {
  DEFAULT_CLUSTERS_OPEN,
  clusterId,
  clustersSummary,
  findCluster,
  findMemberIndex,
  memberLabel,
  recurrenceLabel,
  similarityLabel,
  sizeLabel,
  stepMemberIndex,
  windowSaturated,
} from './duplicate-clusters-view';

function member(scope: string, key: string) {
  return { scope, key, hook: `hook for ${key}`, seen_count: 1, updated_at: null, status: null };
}

function cluster(members: ReturnType<typeof member>[], over: Partial<DuplicateCluster> = {}): DuplicateCluster {
  return {
    size: members.length,
    score: 1,
    min_similarity: 0.8,
    max_similarity: 0.9,
    recurrence_class: null,
    members,
    ...over,
  };
}

const A = cluster([member('global', 'a'), member('global', 'b')]);
const B = cluster([member('repo::o/r', 'c'), member('repo::o/r', 'd'), member('global', 'e')]);

describe('memberLabel / clusterId', () => {
  it('addresses a member by its natural key', () => {
    expect(memberLabel(member('repo::o/r', 'x'))).toBe('repo::o/r::x');
  });

  it('is order-independent, so a reordered refetch is the SAME cluster', () => {
    // The regression this exists for: the ranking is free to emit members in a
    // different order between requests, and an order-sensitive id would reset
    // the reader's selection every time it did.
    const forwards = cluster([member('global', 'a'), member('global', 'b')]);
    const backwards = cluster([member('global', 'b'), member('global', 'a')]);
    expect(clusterId(forwards)).toBe(clusterId(backwards));
  });

  it('distinguishes clusters that differ by one member', () => {
    expect(clusterId(A)).not.toBe(clusterId(B));
    expect(clusterId(A)).not.toBe(clusterId(cluster([member('global', 'a'), member('global', 'c')])));
  });

  it('is total — a members-less value yields the empty id rather than throwing', () => {
    expect(clusterId({ members: [] })).toBe('');
    expect(clusterId({ members: undefined as unknown as [] })).toBe('');
  });
});

describe('findCluster', () => {
  it('resolves a held id', () => {
    expect(findCluster([A, B], clusterId(B))).toBe(B);
  });

  it('falls back to the highest-ranked cluster when the held id has dissolved', () => {
    // A lesson edited below the threshold dissolves its cluster. The panel must
    // show something rather than a blank detail pane it cannot explain.
    expect(findCluster([A, B], 'no::such|cluster')).toBe(A);
  });

  it('selects the first cluster when nothing is held yet', () => {
    expect(findCluster([A, B], null)).toBe(A);
  });

  it('returns null for an empty or absent list — the panel\'s empty state', () => {
    expect(findCluster([], clusterId(A))).toBeNull();
    expect(findCluster(undefined, null)).toBeNull();
  });
});

describe('findMemberIndex', () => {
  it('resolves a held member label to its position', () => {
    expect(findMemberIndex(B, 'global::e')).toBe(2);
  });

  it('falls back to the first member when the held one has left the cluster', () => {
    expect(findMemberIndex(B, 'global::gone')).toBe(0);
  });

  it('reports -1 only when there is genuinely nothing to select', () => {
    expect(findMemberIndex(null, 'global::a')).toBe(-1);
    expect(findMemberIndex({ members: [] }, null)).toBe(-1);
  });
});

describe('stepMemberIndex', () => {
  it('steps forwards and backwards', () => {
    expect(stepMemberIndex(0, 3, 1)).toBe(1);
    expect(stepMemberIndex(2, 3, -1)).toBe(1);
  });

  it('CLAMPS at both ends rather than wrapping', () => {
    // Wrapping under a "next" affordance reads as a jump, and the panel shows a
    // visible "3 of 3" that a wrap would contradict.
    expect(stepMemberIndex(2, 3, 1)).toBe(2);
    expect(stepMemberIndex(0, 3, -1)).toBe(0);
  });

  it('clamps an out-of-range starting index too, so a stale index cannot escape', () => {
    expect(stepMemberIndex(9, 3, 1)).toBe(2);
    expect(stepMemberIndex(-4, 3, -1)).toBe(0);
  });

  it('is total on an empty cluster', () => {
    expect(stepMemberIndex(0, 0, 1)).toBe(-1);
    expect(stepMemberIndex(0, -1, 1)).toBe(-1);
  });
});

describe('similarityLabel', () => {
  it('reports a range', () => {
    expect(similarityLabel(0.8, 0.94)).toBe('80–94% alike');
  });

  it('collapses to one figure when the rounded range is a single point', () => {
    expect(similarityLabel(0.8, 0.8)).toBe('80% alike');
    // Rounding, not equality: 0.801 and 0.804 are one figure to a reader.
    expect(similarityLabel(0.801, 0.804)).toBe('80% alike');
  });

  it('handles the identical-vocabulary case', () => {
    expect(similarityLabel(1, 1)).toBe('100% alike');
  });
});

describe('sizeLabel', () => {
  it('pluralises', () => {
    expect(sizeLabel(1)).toBe('1 lesson');
    expect(sizeLabel(2)).toBe('2 lessons');
  });
});

describe('recurrenceLabel', () => {
  it('is null when the cluster resolved to no class', () => {
    expect(recurrenceLabel(A)).toBeNull();
  });

  it('reports a pure match as complete', () => {
    const pure = cluster([member('global', 'a'), member('global', 'b')], {
      recurrence_class: { id: 'edge-mirror', name: 'Edge mirror drift', matched: ['a', 'b'], pure: true },
    });
    expect(recurrenceLabel(pure)).toEqual({ name: 'Edge mirror drift', partial: false, matched: 2 });
  });

  it('flags a PARTIAL match — the obligation the schema states', () => {
    // A class is reported when the majority resolve to it, so the name alone
    // would claim the whole cluster is that known recurrence.
    const mixed = cluster([member('global', 'a'), member('global', 'b'), member('global', 'z')], {
      recurrence_class: { id: 'edge-mirror', name: 'Edge mirror drift', matched: ['a', 'b'], pure: false },
    });
    expect(recurrenceLabel(mixed)).toEqual({ name: 'Edge mirror drift', partial: true, matched: 2 });
  });
});

describe('windowSaturated', () => {
  const res = (candidates: number, candidate_limit: number) => ({ candidates, candidate_limit });

  it('is true when the candidate fetch hit its cap', () => {
    expect(windowSaturated(res(150, 150))).toBe(true);
    // Defensive on `>`: a cap lowered between deploys must still read saturated.
    expect(windowSaturated(res(200, 150))).toBe(true);
  });

  it('is false for a window that saw the whole scope', () => {
    expect(windowSaturated(res(149, 150))).toBe(false);
    expect(windowSaturated(res(0, 150))).toBe(false);
  });

  it('is false while there is no response yet — never a warning about nothing', () => {
    expect(windowSaturated(undefined)).toBe(false);
  });
});

describe('clustersSummary', () => {
  const response = (clusters: DuplicateCluster[]): ClustersResponse => ({
    threshold: 0.8,
    candidates: 20,
    candidate_limit: 150,
    clusters,
  });

  it('counts clusters AND the lessons inside them', () => {
    expect(clustersSummary(response([A, B]))).toBe('2 clusters · 5 lessons');
  });

  it('singularises one cluster', () => {
    expect(clustersSummary(response([A]))).toBe('1 cluster · 2 lessons');
  });

  it('says so when there are none', () => {
    expect(clustersSummary(response([]))).toBe('None found');
  });

  it('says NOTHING before the first fetch resolves', () => {
    // "None found" on an unresolved query would be a claim the panel has not
    // earned — and it is the reassuring direction, which is the worse one to
    // guess at.
    expect(clustersSummary(undefined)).toBeNull();
  });
});

describe('DEFAULT_CLUSTERS_OPEN', () => {
  it('opens collapsed, like the instrument panel', () => {
    expect(DEFAULT_CLUSTERS_OPEN).toBe(false);
  });
});
