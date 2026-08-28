/**
 * `usage_events.session_kind` (migration 00082) — WHICH KIND of session a
 * usage event came from: `local` (a person's own machine), `ci` (a scheduled
 * or triggered pipeline run), `pr` (a PR-automation run), or `unknown` (no
 * derivable context). Bounded, closed vocabulary — the `client` pattern from
 * migration 00054: bound in app code, a length CHECK on the column as a
 * backstop only, never a CHECK enumerating members.
 *
 * `correlation_id` (bounded, indexed, filterable since migration 00044)
 * stays the DRILL-DOWN key — one bucket per PR/run/session, unbounded in
 * cardinality. `session_kind` is what every chart groups on; grouping on raw
 * `correlation_id` would be one bucket per run.
 *
 * Derivation itself (reading `GITHUB_ACTIONS`/`GITHUB_REF`/etc.) is CLI-only
 * — the edge never derives, it only validates a header the CLI already
 * computed (same shape as `X-LoreKit-Client`). This file is therefore the
 * VALIDATOR half, import-free so it mirrors verbatim into
 * `supabase/functions/_shared/telemetry/session-kind.ts` and is guarded by
 * `edge-parity.spec.ts`. The CLI's derivation is a separate, dependency-free
 * `.mjs` twin (`packages/cli/src/shared/mcp.mjs`'s `deriveSessionContext`) —
 * a cross-LANGUAGE pair no byte comparison can cover, so it is guarded
 * BEHAVIOURALLY instead (`session-kind-parity.spec.ts`), the same pattern
 * `lesson-rank.ts` / `lessons-pure.mjs` already established.
 */

export const SESSION_KINDS = ['local', 'ci', 'pr', 'unknown'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/**
 * Validate the client-supplied `X-LoreKit-Session-Kind` header against the
 * closed vocabulary above. Total and fail-safe: an absent, empty, or
 * unrecognised value is `null` ("no session-kind attribution"), never an
 * error — a header can never fail the request it is describing.
 * Case/whitespace-insensitive, matching `parseUsageClient`.
 */
export function parseSessionKind(raw: string | null | undefined): SessionKind | null {
  if (raw === null || raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  return (SESSION_KINDS as readonly string[]).includes(normalized)
    ? (normalized as SessionKind)
    : null;
}
