// Default TTLs for memories LoreKit writes on the user's behalf.
//
// `ttl.ts` validates a TTL the CALLER supplied. This module decides the TTL when
// the caller supplied none — the two are deliberately separate: parsing an
// explicit value and choosing a default are different decisions with different
// failure modes (a bad explicit value is a usage error and must be surfaced; a
// bad default is a config error and must be ignored, never propagated).
//
// Today it covers the one server-side ingest path that writes without a human in
// the loop: the GitHub webhook. Those rows are CANDIDATES, not promoted lessons,
// so they decay unless something re-surfaces them.
//
// Why grade them. `signal-filter.ts` already sorts webhook deliveries into tiers
// on the way in — a resolved review thread is an explicit author acknowledgement
// that a finding was real, while a fresh comment is an unproven opinion — but the
// TTL used to be a flat 30 days for all of them, so the grading informed whether
// to store and never how long. These constants close that gap.
//
// Mirrored self-contained into supabase/functions/mcp/ttl-defaults.ts (the edge
// function cannot cross-import this package) and guarded by edge-parity.spec.ts —
// the same pattern as ttl.ts, created-at.ts and limits.ts. Keep the two copies
// behaviourally identical; the vitest suite here is the shared guard.

/** How durable the signal behind a webhook-sourced memory is. */
export type WebhookSignalTier = 'high' | 'medium' | 'low';

/**
 * Default TTL in days per signal tier.
 *
 *   high   — `pull_request_review_thread` resolved. The author acted on the
 *            finding, so it described a real property of the code.
 *   medium — `pull_request_review` submitted. A substantive review body, but
 *            nothing yet says it was right.
 *   low    — a freshly created review/issue comment. Unproven, and the highest
 *            volume of the three.
 *
 * A candidate that keeps mattering gets re-written (same scope+key semantics as
 * every other memory) or promoted by hand with `clear_ttl` — expiry is the
 * default outcome, not a judgement that the row was worthless.
 */
export const WEBHOOK_TTL_DAYS_BY_TIER: Readonly<Record<WebhookSignalTier, number>> = {
  high: 90,
  medium: 30,
  low: 14,
};

/** Bounds a per-repo override must satisfy to be honoured. Mirrors ttl.ts. */
const TTL_MIN_DAYS = 1;
const TTL_MAX_DAYS = 365;

/**
 * Grade a webhook delivery.
 *
 * Only pairs `classifyWebhookAction` would accept are graded meaningfully; any
 * other pair falls through to `low`. That is deliberate rather than a throw:
 * this function is called AFTER the action gate, so an unknown pair here means
 * the two have drifted, and under-retaining an unexpected row is a safer
 * failure than rejecting a delivery GitHub will then redeliver.
 */
export function webhookSignalTier(event: string, action: string): WebhookSignalTier {
  if (event === 'pull_request_review_thread' && action === 'resolved') return 'high';
  if (event === 'pull_request_review' && action === 'submitted') return 'medium';
  return 'low';
}

/**
 * The TTL, in days, for a webhook-sourced memory.
 *
 * `overrideDays` is the seam for a per-repo setting configured in the dashboard:
 * pass the stored value and it wins over the tier default. It is validated here
 * rather than trusted, because it arrives from a database row that a UI wrote —
 * an out-of-range, fractional, or non-numeric value is IGNORED (the tier default
 * applies) instead of throwing. A misconfigured repo must not be able to stop its
 * own webhook ingest; the delivery is the payload, the retention is policy.
 *
 * `null`/`undefined` means "no override configured", not "never expire". There is
 * deliberately no way to spell "permanent" here: a permanent webhook candidate is
 * a promotion decision, made per memory, not a per-repo default.
 */
export function webhookTtlDays(
  event: string,
  action: string,
  overrideDays?: number | null,
): number {
  if (
    typeof overrideDays === 'number' &&
    Number.isInteger(overrideDays) &&
    overrideDays >= TTL_MIN_DAYS &&
    overrideDays <= TTL_MAX_DAYS
  ) {
    return overrideDays;
  }
  return WEBHOOK_TTL_DAYS_BY_TIER[webhookSignalTier(event, action)];
}
