/**
 * Fixtures and MSW handlers for the memory graph (`GET /memories/:id/neighbours`
 * and `GET /memories/graph`). Deterministic: ids and counts are literals, so a
 * visual baseline never drifts.
 */

import { http, HttpResponse } from 'msw';
import type { MemoryGraphResponse, MemoryNeighbour, NeighboursResponse } from '@lorekit/schemas/memory';
import { FROZEN_NOW } from './memories';

export const graphId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The lesson the neighbourhood fixtures are about. */
export const FOCUS_ID = graphId(1);

const nb = (n: number, kind: MemoryNeighbour['kind'], key: string, weight: number, scope = 'global'): MemoryNeighbour => ({
  kind, id: graphId(n), scope, key, weight, last_at: FROZEN_NOW,
});

export const NEIGHBOURS: NeighboursResponse = {
  id: FOCUS_ID,
  neighbours: [
    nb(2, 'co_cited', 'tool-pitfalls::zsh-echo-equals-separator', 5),
    nb(3, 'co_cited', 'tool-pitfalls::macos-sed-i-dash-E', 2),
    nb(4, 'co_cited', 'aw-lessons::review-loop-merge', 1, 'repo::mthines/lorekit'),
    nb(5, 'cited_by', 'retro::2026-06-14-session', 1),
    nb(6, 'supersedes', 'tool-pitfalls::sed-in-place-v1', 1),
    nb(7, 'duplicate', 'tool-pitfalls::sed-dash-i-macos', 91),
  ],
  runs: [
    { correlation_id: 'session:7c1e9a', session_kind: 'session', last_at: FROZEN_NOW, cited_count: 2 },
    { correlation_id: 'pr:mthines/lorekit#712', session_kind: 'pr', last_at: '2026-06-10T09:00:00.000Z', cited_count: 1 },
  ],
};

export const EMPTY_NEIGHBOURS: NeighboursResponse = { id: FOCUS_ID, neighbours: [], runs: [] };

/** A crowded neighbourhood: enough nodes to force the second ring. */
export function crowdedNeighbours(count = 22): NeighboursResponse {
  return {
    id: FOCUS_ID,
    neighbours: Array.from({ length: count }, (_, i) =>
      nb(10 + i, i % 5 === 0 ? 'cites' : 'co_cited', `topic-${i + 1}::lesson-${i + 1}`, (i % 6) + 1),
    ),
    runs: [],
  };
}

const gn = (n: number, key: string, scope: string, over: Partial<MemoryGraphResponse['nodes'][number]> = {}) => ({
  id: graphId(n), scope, key, read_count: 12, opened_count: 3, cited_count: 2, degree: 0, orphan: false, ...over,
});

export const GRAPH: MemoryGraphResponse = {
  nodes: [
    gn(1, 'tool-pitfalls::zsh-echo', 'global', { degree: 4, cited_count: 9 }),
    gn(2, 'tool-pitfalls::macos-sed', 'global', { degree: 3, cited_count: 6 }),
    gn(3, 'aw-lessons::review-loop', 'repo::mthines/lorekit', { degree: 2, cited_count: 3 }),
    gn(4, 'aw-lessons::merge', 'repo::mthines/lorekit', { degree: 2, cited_count: 2 }),
    gn(5, 'ci::storybook-userevent', 'project::dash0', { degree: 1, cited_count: 1 }),
    gn(6, 'ci::oxlint-limit', 'project::dash0', { degree: 1, cited_count: 1 }),
    gn(7, 'tool-pitfalls::git-checkout-head', 'global', { degree: 1, cited_count: 1 }),
    gn(20, 'old::unused-note-a', 'global', { orphan: true, read_count: 31, opened_count: 0, cited_count: 0 }),
    gn(21, 'old::unused-note-b', 'repo::mthines/lorekit', { orphan: true, read_count: 8, opened_count: 0, cited_count: 0 }),
  ],
  edges: [
    { source: graphId(1), target: graphId(2), weight: 5, last_at: FROZEN_NOW },
    { source: graphId(1), target: graphId(3), weight: 2, last_at: FROZEN_NOW },
    { source: graphId(1), target: graphId(7), weight: 1, last_at: FROZEN_NOW },
    { source: graphId(2), target: graphId(3), weight: 1, last_at: FROZEN_NOW },
    { source: graphId(3), target: graphId(4), weight: 3, last_at: FROZEN_NOW },
    { source: graphId(5), target: graphId(6), weight: 2, last_at: FROZEN_NOW },
    { source: graphId(1), target: graphId(4), weight: 1, last_at: FROZEN_NOW },
  ],
  truncated: false,
};

export const EMPTY_GRAPH: MemoryGraphResponse = { nodes: [], edges: [], truncated: false };

export function neighboursHandler(body: NeighboursResponse = NEIGHBOURS, onCall?: () => void) {
  return http.get('*/functions/v1/memories/:id/neighbours', () => {
    onCall?.();
    return HttpResponse.json(body);
  });
}

export function graphHandler(body: MemoryGraphResponse = GRAPH, onCall?: () => void) {
  return http.get('*/functions/v1/memories/graph', () => {
    onCall?.();
    return HttpResponse.json(body);
  });
}
