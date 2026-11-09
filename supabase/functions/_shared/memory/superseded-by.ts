// `superseded_by` for a page of read results (00120) — shared by the MCP tools
// (`mcp/tools.ts`) and the REST read handlers (`memories/handlers/*`).
//
// `superseded_by` is never stored: it is the ids of the records whose
// `supersedes` names this one. It is computed with ONE query per page — an
// `in` over the page's ids, served by `memories_supersedes_idx` (00119) — never
// one query per row.
//
// VISIBILITY. The caller passes `scope`, which applies the SAME tenant filter
// its own read applied (MCP: `applyTenantScope`; REST api_key:
// `applyRestTenantScope`; REST JWT: nothing, because RLS already does it). So a
// successor the caller cannot read is never named, and the lookup cannot be
// used to probe for ids in another tenant. Only live successors count: an
// archived or expired record is not a correction anyone can read.
//
// The grouping and the attach rule are pure and live in the mirrored
// `provenance/record-extensions.ts`; this file is only the query.

import { groupSupersededBy, SUPERSEDED_BY_COLUMNS } from '../provenance/record-extensions.ts';
import type { createTracedClient, TracedQuery } from '../telemetry/otel.ts';

/**
 * A ceiling on successor rows per page, so a pathological record that hundreds
 * of others claim to supersede cannot turn one read into an unbounded fetch.
 * Newest successors are kept.
 */
export const SUPERSEDED_BY_MAX_ROWS = 1000;

/** One successor row: its id and the id it supersedes. */
export interface SuccessorRow {
  id: string;
  supersedes: string | null;
}

/**
 * Fetch `superseded_by` for every id on a page, as a map from a record id to
 * its successors' ids (newest first). Ids with no visible successor are
 * absent. Resolves to an empty map for an empty page without a query.
 *
 * Throws on a query error, like the read it accompanies: a page that cannot
 * say whether its records were corrected must not silently claim they were not.
 */
export async function fetchSupersededBy(
  db: ReturnType<typeof createTracedClient>,
  ids: ReadonlyArray<string | undefined | null>,
  scope: (query: TracedQuery<SuccessorRow>) => TracedQuery<SuccessorRow>,
): Promise<Map<string, string[]>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return new Map();
  const base = db.from<'memories', SuccessorRow>('memories').select(SUPERSEDED_BY_COLUMNS)
    .in('supersedes', unique)
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()');
  const { data, error } = await scope(base)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(SUPERSEDED_BY_MAX_ROWS);
  if (error) throw new Error(error.message);
  return groupSupersededBy(Array.isArray(data) ? data : []);
}
