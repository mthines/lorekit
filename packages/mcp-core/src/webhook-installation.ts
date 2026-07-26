/**
 * Pure GitHub App installation reconcile helpers — no I/O.
 *
 * Three exported functions, all side-effect-free:
 *
 *   mapInstallationEvent  — maps a (event, action) pair to a reconcile op.
 *   reconcileInstallation — given a GitHub account id and an optional known
 *                           LoreKit user, returns a discriminated verdict.
 *   buildInstallationTokenClaims — constructs the JWT claim set for a GitHub
 *                                  App installation-token request; clock is
 *                                  injected so the function stays pure and
 *                                  easily testable.
 *
 * This module is the tested source of truth.  It is mirrored
 * (self-contained, no cross-package import) into
 * supabase/functions/mcp/webhook-installation.ts for the Deno edge
 * function — the same pattern used for webhook-secret-select.ts and
 * limits.ts.  Keep the two in sync when either changes.
 *
 * Security posture: these functions are pure and stateless.  They must
 * never perform I/O, make network calls, or read environment variables.
 * The impure shell (DB upsert, token exchange) belongs in the caller.
 */

export type InstallationOp =
  | { kind: 'upsert_installation'; repos: string[] }
  | { kind: 'add_repos'; repos: string[] }
  | { kind: 'remove_repos'; repos: string[] }
  | { kind: 'remove_installation' }
  | { kind: 'ignore'; reason: string };

export type ReconcileVerdict =
  | { kind: 'linked'; userId: string }
  | { kind: 'pending'; githubAccountId: number };

export interface InstallationTokenClaims {
  iat: number;
  exp: number;
  iss: string;
}

/**
 * Map a GitHub webhook (event, action) pair to a reconcile op.
 *
 * Covers the full GitHub App lifecycle documented at:
 *   https://docs.github.com/en/webhooks/webhook-events-and-payloads
 *
 * Events not recognised here return `{ kind: 'ignore' }` so the caller can
 * skip them safely without branching on each variant.
 */
export function mapInstallationEvent(event: string, action: string): InstallationOp {
  switch (event) {
    case 'installation': {
      switch (action) {
        case 'created':
        case 'unsuspend':
        case 'new_permissions_accepted':
          return { kind: 'upsert_installation', repos: [] };
        case 'deleted':
        case 'suspend':
          return { kind: 'remove_installation' };
        default:
          return { kind: 'ignore', reason: `installation.${action} not handled` };
      }
    }
    case 'installation_repositories': {
      switch (action) {
        case 'added':
          return { kind: 'add_repos', repos: [] };
        case 'removed':
          return { kind: 'remove_repos', repos: [] };
        default:
          return { kind: 'ignore', reason: `installation_repositories.${action} not handled` };
      }
    }
    case 'installation_target': {
      return { kind: 'ignore', reason: 'installation_target: no repo changes; caller should re-read installation' };
    }
    case 'github_app_authorization': {
      return { kind: 'ignore', reason: 'github_app_authorization: user-to-server auth flow; not an installation event' };
    }
    case 'membership': {
      return { kind: 'ignore', reason: 'membership: org membership event; not an installation op' };
    }
    default:
      return { kind: 'ignore', reason: `${event}.${action}: not an installation lifecycle event` };
  }
}

/**
 * Compute the reconcile verdict for an installation.
 *
 * If a matching LoreKit user is found (caller resolves this by looking up
 * github_account_id in auth.users raw_app_meta_data / identities), return
 * `{ kind: 'linked', userId }`.  Otherwise return `{ kind: 'pending',
 * githubAccountId }`.
 *
 * The discriminated union makes "dropped installation" unrepresentable: every
 * call path returns either linked or pending — never a null or void.
 */
export function reconcileInstallation(
  githubAccountId: number,
  knownUser: { userId: string } | null,
): ReconcileVerdict {
  if (knownUser !== null) {
    return { kind: 'linked', userId: knownUser.userId };
  }
  return { kind: 'pending', githubAccountId };
}

/**
 * Build the JWT claim set for a GitHub App installation-token request.
 *
 * The caller must sign this with the App's RS256 private key; the network
 * exchange (POST /app/installations/{id}/access_tokens) belongs in the impure
 * shell behind the GITHUB_APP_ENABLED gate.
 *
 * Clock is injected (nowSeconds = Math.floor(Date.now() / 1000)) so the
 * function is deterministic in tests.
 *
 * GitHub requires:
 *   iat — issued-at, at most 60 s in the past (we use nowSeconds exactly)
 *   exp — expiry, at most 10 min (600 s) in the future
 *   iss — the GitHub App id as a string
 */
export function buildInstallationTokenClaims(
  appId: string,
  nowSeconds: number,
): InstallationTokenClaims {
  return {
    iat: nowSeconds,
    exp: nowSeconds + 600,
    iss: appId,
  };
}
