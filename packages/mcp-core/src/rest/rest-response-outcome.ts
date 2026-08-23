// The REST response → `usage_events.outcome` classification.
//
// Extracted from `supabase/functions/_shared/api/router.ts`, where it was a
// Deno-only function vitest could not reach. The mapping decides how every
// REST request is bucketed in usage analytics, so it is worth asserting
// directly rather than inferring from a live smoke run.
//
// THE MAPPING (mirrors the MCP handler's outcome values):
//
//   2xx / 3xx                  → ok
//   403                        → permission_denied
//   429 with body `code`
//       === 'memory_cap'       → cap_exceeded    (the LK001 storage-cap trigger)
//   429 otherwise              → rate_limited    (lorekit_check_rate_limit)
//   any other 4xx / 5xx        → error           (the MCP side likewise records
//                                                 every thrown handler error as
//                                                 `error`, client input faults
//                                                 included)
//
// The 429 split is the ONLY case that needs the body: `translateDbError` maps
// the cap SQLSTATE to a 429 too, so status alone cannot tell a storage cap from
// a request-rate limit.
//
// This module is the SYNC, PURE classification over `(status, bodyCode)`.
// Reading the body is I/O and stays in the router, which clones the response
// on that one rare path and hands the extracted `code` here. A body that is
// absent, not JSON, or carries no `code` arrives as `null`/`undefined` and
// falls through to `rate_limited` — the same fallback the original inline
// `catch` produced.
//
// Pure and import-free so it can be mirrored verbatim into
// `supabase/functions/_shared/rest-response-outcome.ts` (the edge tree cannot
// cross-import this package) and unit-tested in Node — the edge functions have
// no test harness of their own. `edge-parity.spec.ts` guards the two copies.

/**
 * The `usage_events.outcome` domain. Kept as a literal union here rather than
 * imported from the edge `usage.ts` so this module stays import-free; the two
 * are asserted equal by `rest-response-outcome.spec.ts`.
 */
export type RestOutcome = 'ok' | 'cap_exceeded' | 'rate_limited' | 'permission_denied' | 'error';

/**
 * Classify a response status (plus, for 429 only, the body's `code` field)
 * into a `usage_events.outcome`.
 *
 * Total over every integer status: anything below 400 is `ok`, so a 1xx/2xx/3xx
 * response can never be mis-bucketed as an error, and any unrecognised 4xx/5xx
 * degrades to `error` rather than throwing.
 */
export function classifyResponseOutcome(
  status: number,
  bodyCode?: string | null,
): RestOutcome {
  if (status < 400) return 'ok';
  if (status === 403) return 'permission_denied';
  if (status !== 429) return 'error';
  return bodyCode === 'memory_cap' ? 'cap_exceeded' : 'rate_limited';
}
