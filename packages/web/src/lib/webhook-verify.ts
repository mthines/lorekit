/**
 * Pure helpers for the "Verify webhook" dashboard action.
 *
 * The verify flow sends a synthetic, correctly-signed GitHub `ping` from the
 * server to the live webhook endpoint using the user's stored secret, then
 * reports whether the endpoint accepted it. This confirms LoreKit's half of
 * the setup end-to-end:
 *   - the webhook endpoint is deployed and reachable, and
 *   - the exact secret stored in `webhook_secrets` round-trips through the
 *     deployed HMAC verification (catches a deploy/DB drift).
 *
 * It deliberately does NOT prove GitHub's half — whether the secret the user
 * pasted into GitHub matches — because the dashboard has no access to GitHub's
 * stored secret. The success copy makes that boundary explicit.
 *
 * `ping` is an unsupported event for the handler, so a valid signature returns
 * 200 OK *without* writing a candidate lesson — verification never pollutes the
 * lore. See supabase/functions/mcp/webhook.ts (SUPPORTED_EVENTS).
 *
 * The signing + status-interpretation logic lives here (pure, vitest-tested);
 * the DB read and the outbound fetch live in the `verifyWebhookSecret` server
 * action in lib/webhook-secrets.ts.
 */

/** GitHub event header used for the synthetic delivery — unsupported ⇒ no write. */
export const VERIFY_EVENT = 'ping';

export type VerifyCode =
  | 'reachable_ok' // 200 — endpoint live, stored secret accepted
  | 'signature_rejected' // 401 — deployed endpoint computed a different HMAC
  | 'endpoint_error' // any other status — endpoint reachable but unhappy
  | 'unreachable' // fetch threw, or a pre-flight check failed
  | 'no_secret'; // no active secret stored for this repo

export interface VerifyResult {
  ok: boolean;
  code: VerifyCode;
  /** HTTP status, when a response was received. */
  status?: number;
  /** Human-readable, UI-ready explanation. */
  message: string;
}

/**
 * Build the synthetic GitHub `ping` payload for a repo.
 *
 * `repository.full_name` is the only field the handler reads to resolve the
 * repo-scoped secret; the rest mirrors GitHub's real ping shape so the request
 * is indistinguishable from a genuine one to the endpoint.
 */
export function buildVerifyPayload(repo: string): string {
  return JSON.stringify({
    zen: 'Keep it logically awesome.',
    hook_id: 0,
    repository: { full_name: repo },
    sender: { login: 'lorekit-dashboard' },
  });
}

/**
 * HMAC-SHA256 sign a body with a secret, formatted as GitHub's
 * `x-hub-signature-256` header value (`sha256=<hex>`).
 *
 * Uses the Web Crypto API (global in the Node server-action runtime), matching
 * the edge function's `crypto.subtle` verification byte-for-byte.
 */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

/**
 * Map the webhook endpoint's HTTP status onto a UI-ready result.
 *
 * The response body is intentionally ignored — the status alone is the ground
 * truth (200 = accepted, 401 = signature rejected, everything else = error).
 */
export function interpretVerifyStatus(status: number): VerifyResult {
  if (status === 200) {
    return {
      ok: true,
      code: 'reachable_ok',
      status,
      message:
        'Endpoint is live and accepted your LoreKit secret. If GitHub still shows failed deliveries, the secret pasted into GitHub does not match this one — regenerate it and paste it again.',
    };
  }
  if (status === 401) {
    return {
      ok: false,
      code: 'signature_rejected',
      status,
      message:
        'The endpoint rejected this secret. The deployed server may be reading a different secret — try regenerating it.',
    };
  }
  return {
    ok: false,
    code: 'endpoint_error',
    status,
    message: `The webhook endpoint returned an unexpected status (${status}).`,
  };
}
