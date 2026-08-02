/**
 * Redirect-URI validation for the LoreKit authorization server.
 *
 * This is the single most security-sensitive pure function in the OAuth flow:
 * a redirect_uri that is accepted too liberally is an authorization-code
 * exfiltration primitive. It is deliberately NOT `safeNextPath` (lib/auth-
 * redirect.ts) — that one enforces *same-origin paths* for the dashboard's
 * `?next=`, whereas an MCP client's redirect target is legitimately an
 * off-origin loopback URL or a private-use scheme. Two different rules, two
 * different functions, neither reused where it does not belong.
 *
 * WHAT IS ALLOWED (OAuth 2.1 §2.3.1 + RFC 8252 for native apps)
 *   1. Loopback HTTP  — http://127.0.0.1:PORT/path, http://[::1]:PORT/path
 *                       (`localhost` is also accepted: every MCP host in the
 *                       wild registers it, and RFC 8252's objection is
 *                       DNS-resolution ambiguity, not an escalation path.)
 *   2. HTTPS          — any https:// URL, for hosted clients.
 *   3. Private-use    — a custom scheme containing a dot (`com.example.app:/cb`),
 *                       per RFC 8252 §7.1.
 *
 * WHAT IS REJECTED
 *   * Non-loopback plaintext http:// (credential interception).
 *   * Any URL carrying a fragment (RFC 6749 §3.1.2 — the fragment is the
 *     browser's, and appending a query to a fragmented URL is undefined).
 *   * Anything unparseable, and userinfo-bearing URLs (`https://a@b/`), which
 *     render as one host and resolve as another.
 */

/** Hostnames treated as loopback for the plaintext-http exception. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** A private-use scheme must be dotted, per RFC 8252 §7.1. */
const PRIVATE_USE_SCHEME = /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:/i;

export interface RedirectUriCheck {
  ok: boolean;
  /** Machine-readable reason, for the `error_description` on rejection. */
  reason?:
    | 'unparseable'
    | 'fragment_not_allowed'
    | 'userinfo_not_allowed'
    | 'insecure_scheme'
    | 'unsupported_scheme';
}

/** Classify a redirect URI. Total function — never throws. */
export function checkRedirectUri(raw: string | null | undefined): RedirectUriCheck {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) {
    return { ok: false, reason: 'unparseable' };
  }

  // A private-use scheme (com.example.app:/callback) is not always parseable by
  // the WHATWG URL parser in a way that exposes a host, so it is matched on the
  // raw string first — but a fragment is still forbidden.
  if (PRIVATE_USE_SCHEME.test(raw) && !/^https?:/i.test(raw)) {
    return raw.includes('#')
      ? { ok: false, reason: 'fragment_not_allowed' }
      : { ok: true };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  if (url.hash) return { ok: false, reason: 'fragment_not_allowed' };
  if (url.username || url.password) return { ok: false, reason: 'userinfo_not_allowed' };

  if (url.protocol === 'https:') return { ok: true };

  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname)
      ? { ok: true }
      : { ok: false, reason: 'insecure_scheme' };
  }

  return { ok: false, reason: 'unsupported_scheme' };
}

/** Convenience boolean form of {@link checkRedirectUri}. */
export function isAllowedRedirectUri(raw: string | null | undefined): boolean {
  return checkRedirectUri(raw).ok;
}

/**
 * Does `requested` match one of the client's `registered` URIs?
 *
 * Exact string match, with ONE deliberate exception: a loopback URI matches
 * regardless of port. RFC 8252 §7.3 requires this — a native client binds an
 * ephemeral port at runtime and cannot know it at registration time. The
 * exception is narrow on purpose: scheme, host, path and query must still match
 * exactly, so it widens the port and nothing else.
 */
export function redirectUriMatches(requested: string, registered: readonly string[]): boolean {
  if (!isAllowedRedirectUri(requested)) return false;
  if (registered.includes(requested)) return true;

  const req = parseLoopback(requested);
  if (!req) return false;

  return registered.some((candidate) => {
    const reg = parseLoopback(candidate);
    return (
      reg !== null &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
}

/** Parse a loopback http URL into its port-independent parts, or null. */
function parseLoopback(raw: string): { hostname: string; pathname: string; search: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
  return { hostname: url.hostname, pathname: url.pathname, search: url.search };
}

/**
 * Build the redirect back to the client, preserving `state`.
 *
 * Parameters are appended to the query string, never the fragment: the
 * authorization-code flow is a query-response flow, and putting a code in a
 * fragment would hide it from the client's server-side handler.
 */
export function buildRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const separator = redirectUri.includes('?') ? '&' : '?';
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return query ? `${redirectUri}${separator}${query}` : redirectUri;
}
