/**
 * Pure email utilities for the web package.
 */

/**
 * Normalize an email address for authentication.
 *
 * Strips the `+subaddress` portion (RFC 5233 sub-addressing) so that
 * `user+alias@example.com` resolves to the same account as `user@example.com`.
 * This prevents new phantom accounts being created for plus-addressed variants
 * of an existing email address.
 *
 * Normalization rules:
 *  - Trims surrounding whitespace
 *  - Lowercases the entire address (RFC 5321 §2.4 — domains are case-insensitive;
 *    we apply it to the local part too, following common provider practice)
 *  - Strips everything from the first `+` up to (but not including) `@`
 *
 * The domain is preserved as-is after lowercasing. If the input has no `@`,
 * it is returned lowercased-and-trimmed — Supabase will reject it as invalid.
 *
 * @example
 *   normalizeEmail('madsthines+1@gmail.com') // → 'madsthines@gmail.com'
 *   normalizeEmail('User@Example.COM')        // → 'user@example.com'
 *   normalizeEmail('user+tag+extra@x.io')    // → 'user@x.io'
 */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx === -1) return trimmed; // not a valid email — let Supabase reject it
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  const plusIdx = local.indexOf('+');
  const normalizedLocal = plusIdx === -1 ? local : local.slice(0, plusIdx);
  return `${normalizedLocal}@${domain}`;
}
