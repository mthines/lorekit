/**
 * PKCE (RFC 7636) primitives for the LoreKit authorization server.
 *
 * Pure except for Web Crypto, which is present in every runtime this file
 * reaches (Node 20 server actions, the Next.js route handlers, and — for the
 * unit tests — vitest's node environment). No Next.js, no Supabase, no React
 * imports, so the whole module is unit-testable and safe to reuse anywhere.
 *
 * S256 ONLY. OAuth 2.1 removes the `plain` challenge method, and every MCP
 * host in the wild sends S256, so accepting `plain` would add a downgrade
 * surface for no compatibility gain. `verifyPkce` rejects it explicitly rather
 * than falling through to a string comparison.
 */

/** The only code-challenge method LoreKit accepts. */
export const CODE_CHALLENGE_METHOD = 'S256' as const;

/** RFC 7636 §4.1 — a code verifier is 43–128 unreserved characters. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Base64url (RFC 4648 §5) with padding stripped — the OAuth wire encoding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 of `text`, base64url-encoded — the S256 challenge transformation. */
export async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return base64UrlEncode(new Uint8Array(digest));
}

/** SHA-256 hex — the at-rest form for authorization codes and tokens. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** True when `value` is a syntactically valid code verifier. */
export function isValidCodeVerifier(value: string | null | undefined): boolean {
  return typeof value === 'string' && VERIFIER_PATTERN.test(value);
}

/**
 * True when `value` is a syntactically valid S256 code challenge.
 *
 * A base64url-encoded SHA-256 digest is always exactly 43 characters, but the
 * length bound is kept at 43–128 to match the RFC's own grammar (and the
 * column CHECK) rather than over-constraining a client that pads.
 */
export function isValidCodeChallenge(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/**
 * Verify a code verifier against the challenge recorded at authorize time.
 *
 * Total function: returns `false` for a malformed verifier, an unsupported
 * method, or a mismatch — it never throws, so a caller can map the single
 * `false` onto one `invalid_grant` response without branching on failure
 * shapes (which is also what keeps the endpoint from becoming an oracle that
 * distinguishes "wrong verifier" from "malformed verifier").
 */
export async function verifyPkce(
  verifier: string | null | undefined,
  challenge: string,
  method: string = CODE_CHALLENGE_METHOD,
): Promise<boolean> {
  if (method !== CODE_CHALLENGE_METHOD) return false;
  if (!isValidCodeVerifier(verifier)) return false;
  const computed = await sha256Base64Url(verifier as string);
  return timingSafeEqual(computed, challenge);
}

/**
 * Length-independent, content-constant-time string comparison.
 *
 * The compared values are digests of attacker-supplied input, so a plain `===`
 * leaks a prefix-match oracle through its early return. Length is compared
 * first and non-secret (both sides are fixed-width digests in practice).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A cryptographically random base64url string of `byteLength` entropy. */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
