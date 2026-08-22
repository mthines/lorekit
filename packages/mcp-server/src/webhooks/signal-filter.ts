/**
 * Webhook signal-quality filter for LoreKit.
 *
 * Two pure, dependency-free helpers that gate every webhook write:
 *
 *   1. classifyWebhookAction — event/action tier gate. Only 'created' and
 *      high-value terminal actions (resolved threads, submitted reviews) are
 *      worth storing. Edited, deleted, dismissed, synchronize, labeled, etc.
 *      produce noise without durable value. A merged pull_request is the one
 *      action that neither writes nor is noise: it retires per-PR state, so it
 *      gets its own PURGE tier.
 *
 *   2. isSignalWorthy — body quality gate. Rejects very short bodies, bot-
 *      noise patterns (CI status lines, Dependabot headers), and bodies that
 *      are entirely a fenced code block with no surrounding prose.
 *
 * Both functions are pure (no I/O, no side-effects) so they are trivially
 * unit-testable and can be inlined verbatim into self-contained environments
 * (e.g. the Supabase Deno edge function) without importing this module.
 *
 * The Deno mirror in supabase/functions/mcp/webhook.ts MUST be kept in sync
 * with this file. Update both in the same commit.
 */

export type WebhookTier = 'WRITE' | 'PURGE' | 'SKIP';

/**
 * Minimum character length for a comment body to be considered signal-worthy.
 * Rejects "LGTM", "+1", "ok", single emoji, etc.
 */
const MIN_BODY_LENGTH = 20;

/**
 * Patterns that indicate bot-generated noise rather than human signal.
 * Applied against the trimmed comment body.
 */
const BOT_NOISE_PATTERNS: readonly RegExp[] = [
  // GitHub Actions / CI status lines
  /^(Build|Deploy|Test|CI|Checks?) (passed|failed|succeeded|completed)/i,
  // Dependabot PR body headers
  /^Bumps \[/,
  // Generic "all checks" summary lines
  /^All \d+ checks? (passed|failed)/i,
  // Auto-merge commit messages that show up as review comments
  /^Auto-merge enabled/i,
];

/**
 * Classify a webhook event+action pair as WRITE (worth storing) or SKIP (noise).
 *
 * Only a narrow set of actions carry durable signal:
 *   - pull_request_review_thread resolved  → author acknowledged the finding
 *   - pull_request_review submitted         → substantive review body
 *   - pull_request_review_comment created  → new inline comment
 *   - issue_comment created                → new issue/PR comment
 *
 * One action is PURGE rather than WRITE or SKIP:
 *   - pull_request closed                   → the PR is over; per-PR state retires
 *
 * PURGE is deliberately not merged into SKIP. A skipped delivery is noise to be
 * dropped; a purge delivery is a real instruction to retire a record, and the
 * caller must be able to tell them apart to know whether doing nothing was
 * correct. Whether the PR was *merged* is not an (event, action) fact — it lives
 * in the payload — so this gate returns PURGE for any close and the caller
 * decides; see prStatePurgeTarget.
 *
 * All other actions (edited, deleted, dismissed, synchronize, labeled, …)
 * are SKIP — they produce duplicate or ephemeral entries.
 */
export function classifyWebhookAction(event: string, action: string): WebhookTier {
  if (event === 'pull_request_review_thread' && action === 'resolved') return 'WRITE';
  if (event === 'pull_request_review' && action === 'submitted') return 'WRITE';
  if (event === 'pull_request_review_comment' && action === 'created') return 'WRITE';
  if (event === 'issue_comment' && action === 'created') return 'WRITE';
  if (event === 'pull_request' && action === 'closed') return 'PURGE';
  return 'SKIP';
}

/**
 * The per-PR state record a merged pull_request retires, or null when this
 * delivery retires nothing.
 *
 * `pr-reviewer` (mthines/agent-skills) keeps one state record per PR — the delta
 * baseline, run-mode history, open threads, and carried findings its next run
 * reads. The record's own 7-day TTL is what collects it, refreshed on every
 * write, so it expires a week after the PR goes quiet and NOTHING here is
 * required for correctness. This purge only makes that immediate, because a
 * merged PR's delta state is dead the moment it merges.
 *
 * Returns null — meaning "leave it to the TTL" — in three cases:
 *
 *   - The PR was closed WITHOUT merging. It can be reopened and reviewed again,
 *     and then the carried findings are still wanted. A merge is terminal; a
 *     close is not.
 *   - The payload is missing the number or the head ref, so no exact key can be
 *     built. Never widen to a prefix or pattern delete to cover this: a webhook
 *     that deletes by pattern is one payload shape away from deleting the wrong
 *     thing.
 *   - The event/action is not a pull_request close at all.
 *
 * The shapes are the contract in agent-skills' `pr-reviewer.md § Step 0.7`:
 * scope `branch::{owner}/{repo}::{head}`, key `ci-state::pr-review-{number}`.
 * They are duplicated here rather than imported because the two repositories do
 * not share code — so a change to either side must land in both, and the
 * round-trip test in github.spec.ts pins the literal shapes this builds.
 */
export function prStatePurgeTarget(
  event: string,
  action: string,
  payload: {
    repository?: { full_name?: string };
    pull_request?: { number?: number; merged?: boolean; head?: { ref?: string } };
  },
): { scope: string; key: string } | null {
  if (classifyWebhookAction(event, action) !== 'PURGE') return null;

  const pr = payload.pull_request;
  if (pr?.merged !== true) return null;

  const repo = payload.repository?.full_name;
  const head = pr.head?.ref;
  const num = pr.number;
  if (!repo || !head || typeof num !== 'number') return null;

  return { scope: `branch::${repo}::${head}`, key: `ci-state::pr-review-${num}` };
}

/**
 * Return true when a comment body is worth storing as a memory candidate.
 *
 * Rejects:
 *   - Bodies shorter than MIN_BODY_LENGTH characters (noise like "LGTM", "+1")
 *   - Bodies matching BOT_NOISE_PATTERNS (CI summaries, Dependabot headers)
 *   - Bodies that are entirely a fenced code block with no surrounding prose
 *     (raw code dumps with no human commentary)
 */
export function isSignalWorthy(body: string): boolean {
  const trimmed = body.trim();

  if (trimmed.length < MIN_BODY_LENGTH) return false;

  // A body that is ONLY a fenced code block (possibly multi-line) carries no
  // prose signal — the surrounding text is what matters for memory.
  if (/^```[\s\S]*```$/.test(trimmed)) return false;

  if (BOT_NOISE_PATTERNS.some((re) => re.test(trimmed))) return false;

  return true;
}
