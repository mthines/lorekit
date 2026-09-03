/**
 * `recordCitations` — the one edge writer for `memory.write`'s `cited` array
 * (migration 00107), called by BOTH the MCP tool and the REST route.
 *
 * It sits beside `usage.ts` because it is the same kind of thing: a fail-safe
 * writer invoked after an operation has already succeeded, whose failure must
 * never reach the caller. The difference is only what it measures — `usage.ts`
 * records that a call happened, this records what the call CREDITED.
 *
 * WHY THE SIGNAL EXISTS. `opened_count / read_count` (00104) measures whether a
 * lesson was deliberately fetched, and a lesson injected at SessionStart is
 * already in the agent's context and is applied without ever being fetched. So
 * pull-through under-counts the dominant delivery path by construction, and no
 * amount of read telemetry can fix that — only the agent knows. This is where
 * it says so.
 *
 * EVERY FAILURE IS SILENT, and that is the contract rather than an oversight.
 * The write has already committed by the time this runs; a citation that
 * returned an error would turn a successful write into a failed one over
 * telemetry. Unparseable references are dropped by `parseMemoryRefs`,
 * unresolvable and self-referential ones by the RPC, and a thrown error is
 * swallowed here.
 */

import { parseMemoryRefs } from '../scope/scope.ts';
import { createTracedClient } from './otel.ts';
import type { Span } from './otel.ts';
import type { DbClient } from '../db/db-client.ts';

export interface CitationInput {
  /** The account the citation belongs to. NULL (service-role) records nothing. */
  userId: string | null;
  /** The memory the write just produced — the retrospective doing the citing. */
  citingMemoryId: string;
  /** The raw `cited` array as it arrived on the wire. */
  cited: unknown;
  /** The run this write belongs to, from `X-LoreKit-Correlation-Id`. */
  correlationId: string | null;
}

/**
 * Record the citations carried by a write. Returns how many were NEW (0 on a
 * duplicate run, on a service-role caller, or on any failure).
 *
 * Awaited by both callers rather than backgrounded: unlike the embedding queue
 * this is a single cheap RPC, and its return value is the only thing that can
 * tell a span how many citations actually landed. Backgrounding it would trade
 * an unmeasurable few milliseconds for an unobservable signal.
 */
export async function recordCitations(
  db: DbClient,
  span: Span,
  input: CitationInput,
): Promise<number> {
  const refs = parseMemoryRefs(input.cited);
  // Nothing to record is the common case — most writes cite nothing — so this
  // returns before touching the database at all.
  if (refs.length === 0 || !input.userId) return 0;

  try {
    // Through the traced client, like every other RPC on a request path: the
    // call gets its own child span, which is also what feeds the self-time
    // split (`lorekit.io.wait_ms`) on the root request span.
    const { data, error } = await createTracedClient(db, span).rpc<number>('lorekit_record_memory_citations', {
      p_user_id: input.userId,
      p_citing_memory_id: input.citingMemoryId,
      p_cited_scopes: refs.map((r) => r.scope),
      p_cited_keys: refs.map((r) => r.key),
      p_correlation_id: input.correlationId,
    });
    if (error) return 0;
    const recorded = typeof data === 'number' ? data : 0;
    // BOTH numbers, because their difference is the interesting one: `cited`
    // is what the agent claimed and `recorded` is what resolved to real lore it
    // owns, so a persistent gap means the agent is naming lessons that do not
    // exist — a prompt problem, invisible from the counter alone.
    span.setAttributes({
      'lorekit.cited.count': refs.length,
      'lorekit.cited.recorded': recorded,
    });
    return recorded;
  } catch {
    return 0;
  }
}
