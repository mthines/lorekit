'use client';

/**
 * Data fetches behind the memory graph — the lesson drawer's "Connections"
 * section (`useMemoryNeighbours`) and the Insights "Connections" panel
 * (`useMemoryGraph`).
 *
 * Thin wrappers over `GET /memories/:id/neighbours` and `GET /memories/graph`:
 * the server does every join, so there is nothing to aggregate here (and doing
 * it browser-side would hit the row-cap trap `packages/web/CLAUDE.md` forbids).
 *
 * **`enabled` is the disclosure.** The drawer section opens collapsed and the
 * Insights panel sits below the fold, so a caller passes `enabled: false` until
 * a reader asks. Nothing fetches on a page view that never looks.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { memoryGraphRequest, neighboursRequest } from '@/lib/api/memories';
import { browserAccessToken } from '@/lib/api/session-browser';
import type { MemoryGraphResponse, NeighboursResponse } from '@lorekit/schemas/memory';

const EMPTY_GRAPH: MemoryGraphResponse = { nodes: [], edges: [], truncated: false, orphan_total: 0 };

export function useMemoryNeighbours(id: string | null | undefined, enabled = true) {
  return useQuery<NeighboursResponse>({
    queryKey: ['memory-neighbours', id],
    queryFn: async ({ signal }) => {
      const token = await browserAccessToken();
      // No session: an EMPTY neighbourhood, not a throw — the section then
      // shows its empty state instead of an error for a signed-out preview.
      if (!token || !id) return { id: id ?? '', neighbours: [], runs: [] };
      return neighboursRequest(token, id, {}, signal);
    },
    enabled: enabled && Boolean(id),
    // No placeholderData: the drawer does not remount per lesson, so keeping the
    // previous lesson's data would draw ITS neighbours around the new focus.
    // Citations land at the end of a run, so a neighbourhood does not change
    // minute to minute.
    staleTime: 120_000,
  });
}

export interface MemoryGraphParams {
  /** Restrict to one scope (and its children), or `null` for everything the viewer can see. */
  scope: string | null;
  /** Minimum distinct shared runs for an edge. */
  minWeight?: number;
  limitNodes?: number;
  /** ISO 8601 — only co-usage from this instant on. */
  since?: string;
  enabled?: boolean;
}

export function useMemoryGraph(params: MemoryGraphParams) {
  const { scope, minWeight, limitNodes, since, enabled = true } = params;
  return useQuery<MemoryGraphResponse>({
    queryKey: ['memory-graph', scope, minWeight, limitNodes, since],
    queryFn: async ({ signal }) => {
      const token = await browserAccessToken();
      if (!token) return EMPTY_GRAPH;
      return memoryGraphRequest(
        token,
        {
          ...(scope ? { scope } : {}),
          ...(minWeight === undefined ? {} : { min_weight: minWeight }),
          ...(limitNodes === undefined ? {} : { limit_nodes: limitNodes }),
          ...(since ? { since } : {}),
        },
        signal,
      );
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 300_000,
  });
}
