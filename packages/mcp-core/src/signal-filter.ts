/**
 * Webhook signal-quality filter for LoreKit.
 *
 * Two pure, dependency-free helpers that gate every webhook write:
 *
 *   1. classifyWebhookAction — event/action tier gate. Only 'created' and
 *      high-value terminal actions (resolved threads, submitted reviews) are
 *      worth storing. Edited, deleted, dismissed, synchronize, labeled, etc.
 *      produce noise without durable value.
 *
 *   2. isSignalWorthy — body quality gate. Rejects very short bodies, bot-
 *      noise patterns (CI status lines, Dependabot headers), and bodies that
 *      are entirely a fenced code block with no surrounding prose.
 *
 * Both functions are pure (no I/O, no side-effects) so they are trivially
 * unit-testable and can be inlined verbatim into self-contained environments
 * (e.g. the Supabase Deno edge function) without importing this module.
 *
 * This module is the REFERENCE implementation and the only one with unit
 * tests; the sole RUNTIME consumer is the Deno mirror inlined in
 * supabase/functions/mcp/webhook.ts, which MUST be kept in sync with this file
 * — update both in the same commit. (It lived in the Node MCP server's
 * `webhooks/` directory until that undeployed server was removed; the mirror
 * outlived it, so the reference + its tests moved here rather than dying with
 * it.)
 */

export type WebhookTier = 'WRITE' | 'SKIP';

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
 * All other actions (edited, deleted, dismissed, synchronize, labeled, …)
 * are SKIP — they produce duplicate or ephemeral entries.
 */
export function classifyWebhookAction(event: string, action: string): WebhookTier {
  if (event === 'pull_request_review_thread' && action === 'resolved') return 'WRITE';
  if (event === 'pull_request_review' && action === 'submitted') return 'WRITE';
  if (event === 'pull_request_review_comment' && action === 'created') return 'WRITE';
  if (event === 'issue_comment' && action === 'created') return 'WRITE';
  return 'SKIP';
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
