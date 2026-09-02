import { describe, it, expect } from 'vitest';
import {
  base64UrlEncode,
  isValidCodeChallenge,
  isValidCodeVerifier,
  randomToken,
  sha256Base64Url,
  timingSafeEqual,
  verifyPkce,
} from './pkce';

/** The RFC 7636 Appendix B test vector — the canonical S256 pair. */
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('base64UrlEncode', () => {
  it('is URL-safe and unpadded', () => {
    const encoded = base64UrlEncode(new Uint8Array([251, 255, 190, 0]));
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });
});

describe('sha256Base64Url', () => {
  it('reproduces the RFC 7636 Appendix B vector', async () => {
    await expect(sha256Base64Url(RFC_VERIFIER)).resolves.toBe(RFC_CHALLENGE);
  });
});

describe('isValidCodeVerifier', () => {
  it('accepts 43–128 unreserved characters', () => {
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(128))).toBe(true);
    expect(isValidCodeVerifier(RFC_VERIFIER)).toBe(true);
  });

  it('rejects anything shorter, longer, or outside the unreserved set', () => {
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isValidCodeVerifier(`${'a'.repeat(42)}!`)).toBe(false);
    expect(isValidCodeVerifier(null)).toBe(false);
    expect(isValidCodeVerifier(undefined)).toBe(false);
  });
});

describe('isValidCodeChallenge', () => {
  it('accepts a real S256 challenge', () => {
    expect(isValidCodeChallenge(RFC_CHALLENGE)).toBe(true);
  });

  it('rejects an empty or truncated challenge', () => {
    expect(isValidCodeChallenge('')).toBe(false);
    expect(isValidCodeChallenge('short')).toBe(false);
    expect(isValidCodeChallenge(null)).toBe(false);
  });
});

describe('verifyPkce', () => {
  it('accepts the matching verifier', async () => {
    await expect(verifyPkce(RFC_VERIFIER, RFC_CHALLENGE)).resolves.toBe(true);
  });

  it('rejects a non-matching verifier', async () => {
    await expect(verifyPkce('b'.repeat(43), RFC_CHALLENGE)).resolves.toBe(false);
  });

  it('rejects the "plain" method outright — OAuth 2.1 removes it', async () => {
    // The downgrade guard. Without it, a client could send
    // code_challenge=<verifier> and PKCE would be decorative.
    await expect(verifyPkce(RFC_VERIFIER, RFC_VERIFIER, 'plain')).resolves.toBe(false);
  });

  it('rejects a malformed verifier without throwing', async () => {
    // Total function: the token endpoint maps one `false` onto one
    // invalid_grant, so it can never become an oracle that distinguishes
    // "malformed" from "wrong".
    await expect(verifyPkce('too-short', RFC_CHALLENGE)).resolves.toBe(false);
    await expect(verifyPkce(null, RFC_CHALLENGE)).resolves.toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('is true only for identical strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });
});

describe('randomToken', () => {
  it('produces distinct URL-safe values', () => {
    const values = new Set(Array.from({ length: 50 }, () => randomToken(32)));
    expect(values.size).toBe(50);
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
