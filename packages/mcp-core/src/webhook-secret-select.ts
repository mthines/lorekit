/**
 * Pure webhook-secret selection logic — no I/O.
 *
 * Precedence:
 *   1. Rows whose `repo` matches the delivery's `full_name` exactly
 *      (both lowercased by the caller) → source 'db_repo'.
 *   2. Else, rows with a null `repo` (legacy/global fallback, pre-dating
 *      per-repo secrets) → source 'db_legacy'.
 *   3. Else, the GITHUB_WEBHOOK_SECRET env var, if set → source 'env'.
 *   4. Else → source 'none'.
 *
 * Within a matching tier, all secrets are returned as ordered candidates so
 * the caller can try each in turn (handles the rare case of two LoreKit
 * users registering the same repo).
 *
 * This module is the tested source of truth. It is mirrored
 * (self-contained, no cross-package import) into
 * supabase/functions/mcp/webhook-secret-select.ts for the Deno edge
 * function — the same pattern used for limits.ts. Keep the two in sync
 * when either changes.
 */

export type WebhookSecretSource = 'db_repo' | 'db_legacy' | 'env' | 'none';

export interface WebhookSecretRow {
  secret: string;
  repo: string | null;
}

export interface SecretSelection {
  /** Ordered candidates to try — HMAC verification tries each until one matches. */
  secrets: string[];
  source: WebhookSecretSource;
  /** The repo that matched (lowercased full_name), for OTel — null unless source is 'db_repo'. */
  matchedRepo: string | null;
}

/**
 * Select the candidate HMAC secrets for a webhook delivery.
 *
 * `rows` must already be filtered to active=true by the caller.
 * `fullName` should be lowercased by the caller before calling this function.
 */
export function selectWebhookSecrets(
  rows: WebhookSecretRow[],
  fullName: string | undefined,
  envSecret: string,
): SecretSelection {
  if (fullName) {
    const repoMatches = rows.filter((r) => r.repo === fullName);
    if (repoMatches.length > 0) {
      return {
        secrets: repoMatches.map((r) => r.secret).filter(Boolean),
        source: 'db_repo',
        matchedRepo: fullName,
      };
    }
  }

  const legacyMatches = rows.filter((r) => r.repo === null);
  if (legacyMatches.length > 0) {
    return {
      secrets: legacyMatches.map((r) => r.secret).filter(Boolean),
      source: 'db_legacy',
      matchedRepo: null,
    };
  }

  if (envSecret) {
    return { secrets: [envSecret], source: 'env', matchedRepo: null };
  }

  return { secrets: [], source: 'none', matchedRepo: null };
}
